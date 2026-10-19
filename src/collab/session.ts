// 共同編集セッション 1 つ分（docs/collaboration-protocol.md の ④）。
// Y.Doc を持ち、Yjs の同期（sync）とカーソル（awareness）を、プラグイン経由で暗号化して受け渡す。
// 中継サーバーは文書を持たないので、後から入った参加者に今の内容を送るのはホスト
import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

import { fromBase64, toBase64 } from "./text";
import { isCollabError, type CollabEvent, type Peer, type Transport } from "./transport";

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MSG_INFO = 100;
const MSG_IMAGE = 101;
const MSG_IMAGE_REQUEST = 102;
/** 求める画像のパスの長さの上限 */
const MAX_REQUEST_PATH = 1000;
/** 画像は 1 枚 10 MB まで（docs/collaboration.md の「画像」） */
export const MAX_IMAGE = 10 * 1024 * 1024;
/** 中継サーバーのフレームは 1 MB までなので、画像は 512 KB ずつに分けて送る */
const IMAGE_CHUNK = 512 * 1024;
/** カーソルの送信は 100 ms に 1 回まで（中継サーバーの無料枠を使い切らないように） */
const AWARENESS_INTERVAL = 100;
/** 宛先 0 は「自分以外の全員」 */
const EVERYONE = 0;

/** 名前付きカーソルの色（接続 ID の順に割り当てる。ホストを含めて最大 10 人） */
const COLORS = ["#e5484d", "#3e63dd", "#30a46c", "#f76b15", "#8e4ec6", "#12a594", "#d6409f", "#ab6400", "#0090ff", "#646464"];

/** 受け取った変更の origin。受け取った変更を送り返さないため */
const REMOTE = Symbol("remote");

export type Role = "host" | "guest";
/** connecting: 接続中 / waiting: ホストの承認待ち / syncing: ホストの内容を待っている / live: 編集できる / closed: 終わった */
export type Status = "connecting" | "waiting" | "syncing" | "live" | "closed";

export interface SessionHandlers {
  status?(status: Status): void;
  peers?(peers: Peer[]): void;
  joinRequest?(req: { peer: number; name: string }): void;
  /** ホストのファイル名が分かった（参加者だけ） */
  info?(info: { file: string }): void;
  /** 画像がそろった。requested は、自分がホストに求めた画像への返事か（参加者だけ） */
  image?(img: SharedImage, meta: { requested: boolean }): void;
  /** 参加者が、ホストのディスクにある画像を求めてきた（ホストだけ） */
  imageRequest?(req: { peer: number; path: string }): void;
  closed?(c: { code: number; reason: string }): void;
  warning?(message: string): void;
}

/** 共有する画像。path は md からの相対パス、link は MD に書いたリンク（相対パスと違うときだけ。注釈の焼き込み画像） */
export interface SharedImage {
  path: string;
  bytes: Uint8Array;
  link?: string;
}

type Outgoing = { to: number; data: Uint8Array } | { to: number; update: Uint8Array };

export class CollabSession {
  readonly doc = new Y.Doc();
  readonly text = this.doc.getText("content");
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  /** 自分の編集だけを戻す（yCollab が自分の編集の origin を登録する） */
  readonly undoManager = new Y.UndoManager(this.text, { trackedOrigins: new Set() });
  status: Status = "connecting";
  /** 自分とホストの接続 ID（ready を受け取るまでは 0） */
  you = 0;
  host = 0;
  peers: Peer[] = [];
  /** ホストのファイル名 */
  file: string;
  /** 招待リンク（ホストだけ） */
  invite = "";
  closeInfo: { code: number; reason: string } | null = null;
  /** 共同編集セッションの中で貼られた画像。キーは md からの相対パス。ホストは後から入った人にも送る */
  readonly images = new Map<string, SharedImage>();
  /** ホストに求めた画像のパス（同じ画像を何度も求めないため。参加者だけ） */
  private requested = new Set<string>();

  private off: () => void;
  private outbox: Outgoing[] = [];
  private sending = false;
  private awarenessTimer: ReturnType<typeof setTimeout> | undefined;
  private changedClients = new Set<number>();
  /** 接続 ID ごとの awareness の clientID（抜けた人のカーソルを消すため） */
  private clientsOf = new Map<number, Set<number>>();
  /** 受け取り途中の画像（キーは `送り手:パス`） */
  private incoming = new Map<string, { size: number; link: string; parts: (Uint8Array | undefined)[] }>();

  private constructor(
    readonly role: Role,
    private readonly transport: Transport,
    readonly name: string,
    file: string,
    private readonly handlers: SessionHandlers,
  ) {
    this.file = file;
    this.awareness.setLocalStateField("user", { name, color: COLORS[0], colorLight: `${COLORS[0]}33` });
    this.off = transport.onEvent((e) => this.onEvent(e));
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== REMOTE) this.enqueue({ to: EVERYONE, update });
    });
    this.awareness.on("update", ({ added, updated, removed }: AwarenessChange, origin: unknown) => {
      const changed = [...added, ...updated, ...removed];
      if (typeof origin === "number") {
        const set = this.clientsOf.get(origin) ?? new Set();
        for (const c of [...added, ...updated]) set.add(c);
        for (const c of removed) set.delete(c);
        this.clientsOf.set(origin, set);
        return;
      }
      if (origin !== "local") return;
      for (const c of changed) this.changedClients.add(c);
      this.scheduleAwareness();
    });
  }

  /** ホストとして始める。text は始めた時点のタブの本文、file はホストのファイル名 */
  static async start(
    transport: Transport,
    opts: { name: string; text: string; file: string },
    handlers: SessionHandlers = {},
  ): Promise<CollabSession> {
    const s = new CollabSession("host", transport, opts.name, opts.file, handlers);
    // 最初の内容はホストだけが入れる。誰もいないので送らず、元に戻す対象にもしない
    s.doc.transact(() => s.text.insert(0, opts.text), REMOTE);
    try {
      const res = await transport.call({ t: "start", name: opts.name });
      s.invite = String(res.invite ?? "");
    } catch (e) {
      s.dispose();
      throw e;
    }
    return s;
  }

  /** 招待リンクで参加を求める */
  static async join(
    transport: Transport,
    opts: { name: string; invite: string },
    handlers: SessionHandlers = {},
  ): Promise<CollabSession> {
    const s = new CollabSession("guest", transport, opts.name, "", handlers);
    try {
      await transport.call({ t: "join", invite: opts.invite, name: opts.name });
    } catch (e) {
      s.dispose();
      throw e;
    }
    return s;
  }

  /** 貼った画像をほかの全員に送る。10 MB を超えるなら送らずに例外を投げる */
  shareImage(img: SharedImage) {
    if (img.bytes.byteLength > MAX_IMAGE) throw new Error("画像が大きすぎて共有できません（1 枚 10 MB まで）");
    this.images.set(img.path, img);
    this.sendImage(EVERYONE, img);
  }

  /** ホストのディスクにある画像を求める（参加者だけ）。返事は image で届く。同じパスは 1 回だけ求める */
  requestImage(path: string) {
    if (this.role !== "guest" || !this.host || this.status === "closed") return;
    if (!path || path.length > MAX_REQUEST_PATH || this.requested.has(path)) return;
    this.requested.add(path);
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_IMAGE_REQUEST);
    encoding.writeVarString(enc, path);
    this.enqueue({ to: this.host, data: encoding.toUint8Array(enc) });
  }

  /** 求められた画像を、求めた人にだけ送る（ホストだけ。後から入った人には配らない） */
  sendImageTo(peer: number, img: SharedImage) {
    if (this.role !== "host" || img.bytes.byteLength > MAX_IMAGE) return;
    this.sendImage(peer, img);
  }

  approve(peer: number) {
    return this.transport.call({ t: "approve", peer });
  }

  reject(peer: number) {
    return this.transport.call({ t: "reject", peer });
  }

  /** 抜ける。ホストなら全員の共同編集セッションが終わる */
  async leave() {
    if (this.status === "closed") return;
    try {
      await this.transport.call({ t: "leave" });
    } catch {
      // プラグインが落ちていても、こちらは終える
    }
    this.close({ code: 1000, reason: "leave" });
  }

  private onEvent(e: CollabEvent) {
    if (this.status === "closed") return;
    switch (e.t) {
      case "waiting":
        return this.setStatus("waiting");
      case "ready": {
        this.you = e.you;
        this.host = e.host;
        const color = COLORS[(e.you - 1) % COLORS.length];
        this.awareness.setLocalStateField("user", { name: this.name, color, colorLight: `${color}33` });
        this.sendAwareness(EVERYONE, [this.doc.clientID]);
        if (this.role === "host") return this.setStatus("live");
        // 参加者は、ホストの内容（sync step 2）を受け取るまで書けない
        this.setStatus("syncing");
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MSG_SYNC);
        syncProtocol.writeSyncStep1(enc, this.doc);
        return this.enqueue({ to: this.host, data: encoding.toUint8Array(enc) });
      }
      case "join-request":
        return this.handlers.joinRequest?.({ peer: e.peer, name: e.name });
      case "peers": {
        this.peers = e.peers;
        // 抜けた人のカーソルを消す
        const present = new Set(e.peers.map((p) => p.peer));
        for (const [peer, clients] of this.clientsOf) {
          if (present.has(peer)) continue;
          awarenessProtocol.removeAwarenessStates(this.awareness, [...clients], "peer-left");
          this.clientsOf.delete(peer);
        }
        return this.handlers.peers?.(e.peers);
      }
      case "data":
        return this.onData(e.from, fromBase64(e.data));
      case "closed":
        return this.close({ code: e.code, reason: e.reason });
      case "warning":
        return this.handlers.warning?.(e.message);
    }
  }

  private onData(from: number, bytes: Uint8Array) {
    const dec = decoding.createDecoder(bytes);
    const kind = decoding.readVarUint(dec);
    if (kind === MSG_SYNC) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      const t = syncProtocol.readSyncMessage(dec, enc, this.doc, REMOTE);
      // step 1 への返事（step 2）は、聞いてきた人だけに返す
      if (encoding.length(enc) > 1) this.enqueue({ to: from, data: encoding.toUint8Array(enc) });
      if (t === syncProtocol.messageYjsSyncStep1 && this.role === "host") {
        // 新しく入った参加者へ、ホストのファイル名・ホストの step 1・今いる人のカーソルを送る
        const step1 = encoding.createEncoder();
        encoding.writeVarUint(step1, MSG_SYNC);
        syncProtocol.writeSyncStep1(step1, this.doc);
        this.enqueue({ to: from, data: encoding.toUint8Array(step1) });
        const info = encoding.createEncoder();
        encoding.writeVarUint(info, MSG_INFO);
        encoding.writeVarString(info, JSON.stringify({ file: this.file }));
        this.enqueue({ to: from, data: encoding.toUint8Array(info) });
        this.sendAwareness(from, [...this.awareness.getStates().keys()]);
        for (const img of this.images.values()) this.sendImage(from, img);
      }
      if (t === syncProtocol.messageYjsSyncStep2 && this.status === "syncing") this.setStatus("live");
    } else if (kind === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), from);
    } else if (kind === MSG_INFO && from === this.host) {
      try {
        const info = JSON.parse(decoding.readVarString(dec)) as { file?: unknown };
        if (typeof info.file === "string") {
          this.file = info.file;
          this.handlers.info?.({ file: info.file });
        }
      } catch {
        this.handlers.warning?.("ホストからの知らせを読めませんでした");
      }
    } else if (kind === MSG_IMAGE) {
      this.onImagePart(from, dec);
    } else if (kind === MSG_IMAGE_REQUEST && this.role === "host") {
      const path = decoding.readVarString(dec);
      if (path && path.length <= MAX_REQUEST_PATH) this.handlers.imageRequest?.({ peer: from, path });
    }
  }

  /** 画像の断片を集め、全部そろったら images に入れて知らせる */
  private onImagePart(from: number, dec: decoding.Decoder) {
    const path = decoding.readVarString(dec);
    const link = decoding.readVarString(dec);
    const size = decoding.readVarUint(dec);
    const index = decoding.readVarUint(dec);
    const count = decoding.readVarUint(dec);
    const part = decoding.readVarUint8Array(dec);
    const key = `${from}:${path}`;
    // 数を確かめてから断片の置き場所を作る（大きな count で場所を取られないように）
    if (!path || size > MAX_IMAGE || count !== Math.max(1, Math.ceil(size / IMAGE_CHUNK)) || index >= count) {
      this.incoming.delete(key);
      return this.handlers.warning?.(`画像を受け取れませんでした: ${path}`);
    }
    let entry = this.incoming.get(key);
    if (!entry || entry.size !== size || entry.link !== link) {
      // 断片の抜けを some で見るので、穴の無い配列にする（some は穴を飛ばす）
      entry = { size, link, parts: new Array<Uint8Array | undefined>(count).fill(undefined) };
      this.incoming.set(key, entry);
    }
    entry.parts[index] = part;
    if (entry.parts.some((p) => !p)) return;
    this.incoming.delete(key);
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const p of entry.parts as Uint8Array[]) {
      if (at + p.byteLength > size) return this.handlers.warning?.(`画像を受け取れませんでした: ${path}`);
      bytes.set(p, at);
      at += p.byteLength;
    }
    if (at !== size) return this.handlers.warning?.(`画像を受け取れませんでした: ${path}`);
    const img: SharedImage = link ? { path, bytes, link } : { path, bytes };
    // 求めた画像への返事は、ホストのディスクの画像。セッションの中で貼られた画像としては持たない
    const requested = from === this.host && this.requested.has(path) && !link;
    if (!requested) this.images.set(path, img);
    this.handlers.image?.(img, { requested });
  }

  private sendImage(to: number, { path, bytes, link }: SharedImage) {
    const count = Math.max(1, Math.ceil(bytes.byteLength / IMAGE_CHUNK));
    for (let i = 0; i < count; i++) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_IMAGE);
      encoding.writeVarString(enc, path);
      encoding.writeVarString(enc, link ?? "");
      encoding.writeVarUint(enc, bytes.byteLength);
      encoding.writeVarUint(enc, i);
      encoding.writeVarUint(enc, count);
      encoding.writeVarUint8Array(enc, bytes.subarray(i * IMAGE_CHUNK, (i + 1) * IMAGE_CHUNK));
      this.enqueue({ to, data: encoding.toUint8Array(enc) });
    }
  }

  private setStatus(status: Status) {
    if (this.status === status) return;
    this.status = status;
    this.handlers.status?.(status);
  }

  private close(info: { code: number; reason: string }) {
    if (this.status === "closed") return;
    this.closeInfo = info;
    this.outbox = [];
    this.setStatus("closed");
    this.dispose();
    this.handlers.closed?.(info);
  }

  /** 受け取りをやめる。本文（this.text）は、コピーとして保存できるよう残す */
  private dispose() {
    this.off();
    clearTimeout(this.awarenessTimer);
    this.awareness.destroy();
  }

  private sendAwareness(to: number, clients: number[]) {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, clients));
    this.enqueue({ to, data: encoding.toUint8Array(enc) });
  }

  private scheduleAwareness() {
    if (this.awarenessTimer) return;
    this.awarenessTimer = setTimeout(() => {
      this.awarenessTimer = undefined;
      const clients = [...this.changedClients];
      this.changedClients.clear();
      if (clients.length) this.sendAwareness(EVERYONE, clients);
    }, AWARENESS_INTERVAL);
  }

  /** ほかに承認済みの人がいるか（一人きりなら全員宛ての送信は省く） */
  private othersPresent() {
    return this.peers.some((p) => p.peer !== this.you);
  }

  /**
   * 送る順番を守るため、1 つずつ送る。待っている間に溜まった全員宛ての変更は 1 つにまとめる
   * （Tauri のコマンドは並行して動くので、まとめて投げると順番が入れ替わることがある）
   */
  private enqueue(item: Outgoing) {
    if (!this.you || this.status === "closed") return;
    if (item.to === EVERYONE && !this.othersPresent()) return;
    const last = this.outbox[this.outbox.length - 1];
    if ("update" in item && last && "update" in last && last.to === item.to) {
      last.update = Y.mergeUpdates([last.update, item.update]);
    } else {
      this.outbox.push(item);
    }
    void this.flush();
  }

  private async flush() {
    if (this.sending) return;
    this.sending = true;
    try {
      for (let item = this.outbox.shift(); item; item = this.outbox.shift()) {
        let data: Uint8Array;
        if ("update" in item) {
          const enc = encoding.createEncoder();
          encoding.writeVarUint(enc, MSG_SYNC);
          syncProtocol.writeUpdate(enc, item.update);
          data = encoding.toUint8Array(enc);
        } else {
          data = item.data;
        }
        try {
          await this.transport.call({ t: "send", to: item.to, data: toBase64(data) });
        } catch (e) {
          if (this.status === "closed") return;
          const why = isCollabError(e) && e.code === "too-large" ? "内容が大きすぎて送れませんでした" : "送れませんでした";
          this.handlers.warning?.(`${why}: ${isCollabError(e) ? e.message : String(e)}`);
        }
      }
    } finally {
      this.sending = false;
    }
  }
}

type AwarenessChange = { added: number[]; updated: number[]; removed: number[] };
