import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Close, MAX_PEERS } from "../src/room";

const ORIGIN = "https://relay.example";

/** 受け取ったメッセージを順に取り出せる、テスト用の接続 */
class Client {
  readonly frames: (string | Blob)[] = [];
  private waiters: (() => void)[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;

  constructor(readonly ws: WebSocket) {
    ws.accept();
    ws.addEventListener("message", (e) => {
      // テスト側の WebSocket では、バイナリのフレームは Blob で届く
      this.frames.push(e.data as string | Blob);
      this.waiters.splice(0).forEach((w) => w());
    });
    this.closed = new Promise((resolve) => {
      ws.addEventListener("close", (e) => {
        resolve({ code: e.code, reason: e.reason });
        this.waiters.splice(0).forEach((w) => w());
      });
    });
  }

  private async next(): Promise<string | Blob> {
    while (!this.frames.length) await new Promise<void>((r) => this.waiters.push(r));
    return this.frames.shift()!;
  }

  /** 次の制御用メッセージ（JSON） */
  async json(): Promise<Record<string, unknown>> {
    const f = await this.next();
    if (typeof f !== "string") throw new Error("expected text frame");
    return JSON.parse(f);
  }

  /** 次のバイナリのフレーム：[送り主][中身] */
  async binary(): Promise<{ from: number; body: string }> {
    const f = await this.next();
    if (typeof f === "string") throw new Error(`expected binary frame, got ${f}`);
    const bytes = new Uint8Array(await f.arrayBuffer());
    return { from: new DataView(bytes.buffer).getUint32(0), body: new TextDecoder().decode(bytes.subarray(4)) };
  }

  send(msg: unknown) {
    this.ws.send(JSON.stringify(msg));
  }

  sendBinary(to: number, body: string) {
    const b = new TextEncoder().encode(body);
    const out = new Uint8Array(4 + b.length);
    new DataView(out.buffer).setUint32(0, to);
    out.set(b, 4);
    this.ws.send(out);
  }

  /** 少し待って、何も届いていないことを確かめる */
  async expectNothing() {
    await new Promise((r) => setTimeout(r, 50));
    expect(this.frames).toEqual([]);
  }
}

async function createRoom(): Promise<{ room: string; hostSecret: string }> {
  const res = await exports.default.fetch(`${ORIGIN}/rooms`, { method: "POST" });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { v: number; room: string; hostSecret: string };
  expect(body.v).toBe(1);
  return body;
}

async function connect(room: string): Promise<Client> {
  const res = await exports.default.fetch(`${ORIGIN}/rooms/${room}`, { headers: { Upgrade: "websocket" } });
  expect(res.status).toBe(101);
  return new Client(res.webSocket!);
}

async function hostOf(room: string, hostSecret: string, name = "ホスト"): Promise<Client> {
  const host = await connect(room);
  host.send({ t: "hello", v: 1, role: "host", name, secret: hostSecret });
  expect(await host.json()).toMatchObject({ t: "ready" });
  expect(await host.json()).toMatchObject({ t: "peers" });
  return host;
}

/** 参加を求め、ホストが承認するところまで進める */
async function joinAs(room: string, host: Client, name: string): Promise<{ guest: Client; peer: number }> {
  const guest = await connect(room);
  guest.send({ t: "hello", v: 1, role: "guest", name });
  expect(await guest.json()).toEqual({ t: "waiting" });
  const req = await host.json();
  expect(req).toMatchObject({ t: "join-request", name });
  host.send({ t: "approve", peer: req.peer });
  expect(await guest.json()).toMatchObject({ t: "ready", you: req.peer });
  return { guest, peer: req.peer as number };
}

function stubOf(room: string) {
  return env.ROOMS.get(env.ROOMS.idFromName(room));
}

describe("HTTP", () => {
  it("POST /rooms は 22 文字のセッション ID とホスト用の合言葉を返す", async () => {
    const { room, hostSecret } = await createRoom();
    expect(room).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(hostSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("無いセッションへの接続は 404", async () => {
    const res = await exports.default.fetch(`${ORIGIN}/rooms/AAAAAAAAAAAAAAAAAAAAAA`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(404);
  });

  it("招待リンクをブラウザで開くと案内のページを返す", async () => {
    const res = await exports.default.fetch(`${ORIGIN}/r/AAAAAAAAAAAAAAAAAAAAAA`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("共同編集に参加");
  });
});

describe("hello", () => {
  it("ホストはすぐ ready を受け取る", async () => {
    const { room, hostSecret } = await createRoom();
    const host = await connect(room);
    host.send({ t: "hello", v: 1, role: "host", name: "土屋", secret: hostSecret });
    const ready = await host.json();
    expect(ready).toMatchObject({ t: "ready" });
    expect(ready.you).toBe(ready.host);
    expect(await host.json()).toEqual({ t: "peers", peers: [{ peer: ready.you, name: "土屋", host: true }] });
  });

  it("ホスト用の合言葉が違えば 4007", async () => {
    const { room } = await createRoom();
    const host = await connect(room);
    host.send({ t: "hello", v: 1, role: "host", name: "土屋", secret: "wrong" });
    expect((await host.closed).code).toBe(Close.hostRefused);
  });

  it("ホストが 2 人目なら 4007", async () => {
    const { room, hostSecret } = await createRoom();
    await hostOf(room, hostSecret);
    const second = await connect(room);
    second.send({ t: "hello", v: 1, role: "host", name: "2 人目", secret: hostSecret });
    expect((await second.closed).code).toBe(Close.hostRefused);
  });

  it("プロトコルの版が違えば 4001", async () => {
    const { room, hostSecret } = await createRoom();
    const host = await connect(room);
    host.send({ t: "hello", v: 2, role: "host", name: "土屋", secret: hostSecret });
    expect((await host.closed).code).toBe(Close.version);
  });

  it("最初が hello でなければ 4000", async () => {
    const { room } = await createRoom();
    const c = await connect(room);
    c.send({ t: "approve", peer: 1 });
    expect((await c.closed).code).toBe(Close.badMessage);
  });

  it("ホストがまだ来ていなければ参加者は 4002", async () => {
    const { room } = await createRoom();
    const guest = await connect(room);
    guest.send({ t: "hello", v: 1, role: "guest", name: "佐藤" });
    expect((await guest.closed).code).toBe(Close.noRoom);
  });
});

describe("参加の承認", () => {
  it("承認されると ready と peers が届く", async () => {
    const { room, hostSecret } = await createRoom();
    const host = await hostOf(room, hostSecret, "土屋");
    const { guest, peer } = await joinAs(room, host, "佐藤");
    const expected = { t: "peers", peers: [{ peer: 1, name: "土屋", host: true }, { peer, name: "佐藤", host: false }] };
    expect(await guest.json()).toEqual(expected);
    expect(await host.json()).toEqual(expected);
  });

  it("断られると 4003", async () => {
    const { room, hostSecret } = await createRoom();
    const host = await hostOf(room, hostSecret);
    const guest = await connect(room);
    guest.send({ t: "hello", v: 1, role: "guest", name: "佐藤" });
    await guest.json();
    const req = await host.json();
    host.send({ t: "reject", peer: req.peer });
    expect((await guest.closed).code).toBe(Close.rejected);
  });

  it("承認前の接続には暗号文を流さず、承認前の接続からの暗号文も捨てる", async () => {
    const { room, hostSecret } = await createRoom();
    const host = await hostOf(room, hostSecret);
    const guest = await connect(room);
    guest.send({ t: "hello", v: 1, role: "guest", name: "佐藤" });
    expect(await guest.json()).toEqual({ t: "waiting" });
    await host.json(); // join-request
    host.sendBinary(0, "secret");
    guest.sendBinary(0, "from pending");
    await guest.expectNothing();
    await host.expectNothing();
  });

  it("ホストを含めて 10 人を超える参加は 4004", async () => {
    const { room, hostSecret } = await createRoom();
    const host = await hostOf(room, hostSecret);
    const guests: Client[] = [];
    for (let i = 1; i < MAX_PEERS; i++) {
      const { guest } = await joinAs(room, host, `参加者${i}`);
      guests.push(guest);
      // 承認のたびに届く peers を読み捨てる
      for (const c of [host, ...guests]) await c.json();
    }
    const extra = await connect(room);
    extra.send({ t: "hello", v: 1, role: "guest", name: "11 人目" });
    expect((await extra.closed).code).toBe(Close.full);
  });
});

describe("暗号文の受け渡し", () => {
  it("宛先 0 は送り主以外の全員へ、送り主の接続 ID に差し替えて届ける", async () => {
    const { room, hostSecret } = await createRoom();
    const host = await hostOf(room, hostSecret);
    const a = await joinAs(room, host, "A");
    await host.json();
    await a.guest.json();
    const b = await joinAs(room, host, "B");
    for (const c of [host, a.guest, b.guest]) await c.json();

    a.guest.sendBinary(0, "hello all");
    expect(await host.binary()).toEqual({ from: a.peer, body: "hello all" });
    expect(await b.guest.binary()).toEqual({ from: a.peer, body: "hello all" });
    await a.guest.expectNothing();
  });

  it("宛先を指定すると、その人だけに届く", async () => {
    const { room, hostSecret } = await createRoom();
    const host = await hostOf(room, hostSecret);
    const a = await joinAs(room, host, "A");
    await host.json();
    await a.guest.json();
    const b = await joinAs(room, host, "B");
    for (const c of [host, a.guest, b.guest]) await c.json();

    host.sendBinary(b.peer, "only B");
    expect(await b.guest.binary()).toEqual({ from: 1, body: "only B" });
    await a.guest.expectNothing();
  });

  it("1 MiB を超えるフレームは 4000", async () => {
    const { room, hostSecret } = await createRoom();
    const host = await hostOf(room, hostSecret);
    host.ws.send(new Uint8Array(1024 * 1024 + 1));
    expect((await host.closed).code).toBe(Close.badMessage);
  });
});

describe("抜けるとき", () => {
  it("参加者が抜けると、残った人に peers が届く", async () => {
    const { room, hostSecret } = await createRoom();
    const host = await hostOf(room, hostSecret, "土屋");
    const { guest } = await joinAs(room, host, "佐藤");
    await host.json();
    guest.ws.close(1000, "bye");
    expect(await host.json()).toEqual({ t: "peers", peers: [{ peer: 1, name: "土屋", host: true }] });
  });

  it("ホストが抜けると参加者は 4005 で閉じられ、セッションは消える", async () => {
    const { room, hostSecret } = await createRoom();
    const host = await hostOf(room, hostSecret);
    const { guest } = await joinAs(room, host, "佐藤");
    host.ws.close(1000, "bye");
    expect((await guest.closed).code).toBe(Close.hostLeft);
    const res = await exports.default.fetch(`${ORIGIN}/rooms/${room}`, { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(404);
  });
});

describe("アラーム", () => {
  it("10 秒以内に hello が無い接続は 4006", async () => {
    const { room } = await createRoom();
    const c = await connect(room);
    await runInDurableObject(stubOf(room), (_instance, state) => {
      for (const ws of state.getWebSockets()) ws.serializeAttachment({ ...ws.deserializeAttachment(), at: 0 });
    });
    await runDurableObjectAlarm(stubOf(room));
    expect((await c.closed).code).toBe(Close.helloTimeout);
  });

  it("10 分以内にホストが来なければセッションを消す", async () => {
    const { room } = await createRoom();
    await runInDurableObject(stubOf(room), async (_instance, state) => {
      const meta = (await state.storage.get<Record<string, unknown>>("meta"))!;
      await state.storage.put("meta", { ...meta, created: 0 });
    });
    expect(await runDurableObjectAlarm(stubOf(room))).toBe(true);
    const res = await exports.default.fetch(`${ORIGIN}/rooms/${room}`, { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(404);
  });
});
