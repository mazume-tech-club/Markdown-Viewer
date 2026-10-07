// 1 つの共同編集セッションを受け持つ Durable Object（docs/collaboration-protocol.md の ③）。
// 承認済みの接続どうしで暗号文を受け渡すだけで、文書は持たない。
// 待機中に時間課金されないよう、WebSocket は Hibernation API で受ける（setTimeout は使わない）
import { DurableObject } from "cloudflare:workers";
import { sha256Hex } from "./util";

export const PROTOCOL_VERSION = 1;
export const ROOM_ID_RE = /^[A-Za-z0-9_-]{22}$/;

/** ホストを含めた人数の上限 */
export const MAX_PEERS = 10;
/** 承認待ちの人数の上限（参加の要求でホストの画面が埋まらないように） */
export const MAX_PENDING = 10;
/** バイナリのフレームの上限（先頭 4 バイトの接続 ID を含む） */
export const MAX_FRAME = 1024 * 1024;
/** 接続してから hello までの猶予 */
export const HELLO_TIMEOUT_MS = 10_000;
/** 共同編集セッションを作ってから、ホストが接続するまでの猶予 */
export const HOST_TIMEOUT_MS = 10 * 60_000;
const MAX_NAME = 50;

export const Close = {
  normal: 1000,
  badMessage: 4000,
  version: 4001,
  noRoom: 4002,
  rejected: 4003,
  full: 4004,
  hostLeft: 4005,
  helloTimeout: 4006,
  hostRefused: 4007,
} as const;

/** ストレージに置くもの（文書は置かない） */
interface Meta {
  hostHash: string;
  created: number;
  hostJoined: boolean;
  nextPeer: number;
}

/** 接続ごとの状態。休止から戻っても失われないよう serializeAttachment に持つ */
interface Attachment {
  peer: number;
  /** new: hello 待ち / pending: 承認待ち / host・member: 承認済み */
  state: "new" | "pending" | "host" | "member";
  name: string;
  at: number;
}

type Hello = { t: "hello"; v: unknown; role: unknown; name: unknown; secret?: unknown };

export class Room extends DurableObject<Env> {
  /** POST /rooms から呼ぶ。ホスト用の合言葉の SHA-256 だけを覚える */
  async init(hostHash: string): Promise<void> {
    if (await this.meta()) throw new Error("room already exists");
    const now = Date.now();
    await this.ctx.storage.put<Meta>("meta", { hostHash, created: now, hostJoined: false, nextPeer: 1 });
    await this.scheduleAlarm(now + HOST_TIMEOUT_MS);
  }

  async fetch(request: Request): Promise<Response> {
    const meta = await this.meta();
    if (!meta) return new Response("Not Found", { status: 404 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    const now = Date.now();
    const att: Attachment = { peer: meta.nextPeer, state: "new", name: "", at: now };
    server.serializeAttachment(att);
    await this.ctx.storage.put<Meta>("meta", { ...meta, nextPeer: meta.nextPeer + 1 });
    await this.scheduleAlarm(now + HELLO_TIMEOUT_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = attachment(ws);
    if (typeof message !== "string") return this.relay(ws, att, message);

    let msg: { t?: unknown; [k: string]: unknown };
    try {
      msg = JSON.parse(message);
    } catch {
      return close(ws, Close.badMessage, "invalid json");
    }
    if (typeof msg !== "object" || msg === null) return close(ws, Close.badMessage, "invalid message");

    if (att.state === "new") {
      if (msg.t !== "hello") return close(ws, Close.badMessage, "hello expected");
      return this.hello(ws, att, msg as Hello);
    }
    if (att.state === "host" && (msg.t === "approve" || msg.t === "reject")) {
      if (typeof msg.peer !== "number") return close(ws, Close.badMessage, "peer expected");
      return this.decide(msg.t, msg.peer);
    }
    return close(ws, Close.badMessage, `unexpected ${String(msg.t)}`);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    close(ws, code === 1005 ? Close.normal : code, reason);
    await this.left(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.left(ws);
  }

  async alarm(): Promise<void> {
    const meta = await this.meta();
    if (!meta) return;
    const now = Date.now();
    if (!meta.hostJoined && now >= meta.created + HOST_TIMEOUT_MS) {
      for (const ws of this.ctx.getWebSockets()) close(ws, Close.noRoom, "host did not join");
      await this.destroy();
      return;
    }
    let next = meta.hostJoined ? Infinity : meta.created + HOST_TIMEOUT_MS;
    for (const ws of this.ctx.getWebSockets()) {
      const att = attachment(ws);
      if (att.state !== "new") continue;
      if (now >= att.at + HELLO_TIMEOUT_MS) close(ws, Close.helloTimeout, "hello timeout");
      else next = Math.min(next, att.at + HELLO_TIMEOUT_MS);
    }
    if (next !== Infinity) await this.ctx.storage.setAlarm(next);
  }

  private async hello(ws: WebSocket, att: Attachment, msg: Hello): Promise<void> {
    if (msg.v !== PROTOCOL_VERSION) return close(ws, Close.version, "protocol version mismatch");
    const name = typeof msg.name === "string" ? msg.name.trim() : "";
    if (!name || [...name].length > MAX_NAME) return close(ws, Close.badMessage, "invalid name");
    const meta = (await this.meta())!;

    if (msg.role === "host") {
      const ok = typeof msg.secret === "string" && (await sha256Hex(msg.secret)) === meta.hostHash;
      if (!ok || meta.hostJoined) return close(ws, Close.hostRefused, "host refused");
      await this.ctx.storage.put<Meta>("meta", { ...meta, hostJoined: true });
      save(ws, { ...att, state: "host", name });
      send(ws, { t: "ready", you: att.peer, host: att.peer });
      this.sendPeers();
      return;
    }
    if (msg.role !== "guest") return close(ws, Close.badMessage, "invalid role");

    const host = this.host();
    if (!host) return close(ws, Close.noRoom, "host is not here");
    if (this.joined().length >= MAX_PEERS) return close(ws, Close.full, "room is full");
    if (this.sockets("pending").length >= MAX_PENDING) return close(ws, Close.full, "too many pending");
    save(ws, { ...att, state: "pending", name });
    send(ws, { t: "waiting" });
    send(host, { t: "join-request", peer: att.peer, name });
  }

  private decide(t: "approve" | "reject", peer: number): void {
    // 承認する前に抜けた人への返事は無視する
    const ws = this.sockets("pending").find((w) => attachment(w).peer === peer);
    if (!ws) return;
    if (t === "reject") return close(ws, Close.rejected, "rejected");
    if (this.joined().length >= MAX_PEERS) return close(ws, Close.full, "room is full");
    const att = attachment(ws);
    save(ws, { ...att, state: "member" });
    send(ws, { t: "ready", you: peer, host: attachment(this.host()!).peer });
    this.sendPeers();
  }

  /** 暗号文を受け渡す。先頭 4 バイトを宛先から送り主に差し替えるだけで、中身には触れない */
  private relay(ws: WebSocket, att: Attachment, data: ArrayBuffer): void {
    if (att.state !== "host" && att.state !== "member") return;
    if (data.byteLength < 4 || data.byteLength > MAX_FRAME) return close(ws, Close.badMessage, "invalid frame size");
    const out = new Uint8Array(data.slice(0));
    const view = new DataView(out.buffer);
    const to = view.getUint32(0);
    view.setUint32(0, att.peer);
    for (const other of this.joined()) {
      if (other === ws) continue;
      if (to === 0 || attachment(other).peer === to) sendRaw(other, out);
    }
  }

  private async left(ws: WebSocket): Promise<void> {
    const att = attachment(ws);
    if (att.state === "host") {
      for (const other of this.ctx.getWebSockets()) if (other !== ws) close(other, Close.hostLeft, "host left");
      await this.destroy();
    } else if (att.state === "member") {
      this.sendPeers(ws);
    }
  }

  private sendPeers(leaving?: WebSocket): void {
    const joined = this.joined().filter((w) => w !== leaving);
    const peers = joined
      .map((w) => attachment(w))
      .sort((a, b) => Number(b.state === "host") - Number(a.state === "host") || a.peer - b.peer)
      .map((a) => ({ peer: a.peer, name: a.name, host: a.state === "host" }));
    for (const w of joined) send(w, { t: "peers", peers });
  }

  private sockets(state: Attachment["state"]): WebSocket[] {
    return this.ctx.getWebSockets().filter((w) => w.readyState === WebSocket.OPEN && attachment(w).state === state);
  }

  private joined(): WebSocket[] {
    return [...this.sockets("host"), ...this.sockets("member")];
  }

  private host(): WebSocket | undefined {
    return this.sockets("host")[0];
  }

  private async meta(): Promise<Meta | undefined> {
    return this.ctx.storage.get<Meta>("meta");
  }

  private async scheduleAlarm(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || at < current) await this.ctx.storage.setAlarm(at);
  }

  private async destroy(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

function attachment(ws: WebSocket): Attachment {
  return ws.deserializeAttachment() as Attachment;
}

function save(ws: WebSocket, att: Attachment): void {
  ws.serializeAttachment(att);
}

function send(ws: WebSocket, msg: unknown): void {
  sendRaw(ws, JSON.stringify(msg));
}

function sendRaw(ws: WebSocket, data: string | Uint8Array): void {
  try {
    ws.send(data);
  } catch {
    // 閉じかけの接続には送れない。閉じたことは webSocketClose で扱う
  }
}

function close(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // すでに閉じている
  }
}
