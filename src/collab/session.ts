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
  closed?(c: { code: number; reason: string }): void;
  warning?(message: string): void;
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

  private off: () => void;
  private outbox: Outgoing[] = [];
  private sending = false;
  private awarenessTimer: ReturnType<typeof setTimeout> | undefined;
  private changedClients = new Set<number>();
  /** 接続 ID ごとの awareness の clientID（抜けた人のカーソルを消すため） */
  private clientsOf = new Map<number, Set<number>>();

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
