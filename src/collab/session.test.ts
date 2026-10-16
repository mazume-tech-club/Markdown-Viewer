import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { CollabSession, type Status } from "./session";
import { applyText, fromBase64, toBase64 } from "./text";
import type { CollabEvent, Transport } from "./transport";

/**
 * 中継サーバーとプラグインをまとめた偽物（暗号化はしない）。
 * 承認・宛先・抜けたときの扱いは docs/collaboration-protocol.md の ③ と同じにしてある
 */
class FakeRelay {
  private nextPeer = 1;
  readonly conns: FakeConn[] = [];
  host?: FakeConn;

  connect(): FakeConn {
    const c = new FakeConn(this);
    this.conns.push(c);
    return c;
  }

  joined() {
    return this.conns.filter((c) => c.state === "joined");
  }

  peers() {
    return this.joined()
      .sort((a, b) => Number(b === this.host) - Number(a === this.host) || a.peer - b.peer)
      .map((c) => ({ peer: c.peer, name: c.name, host: c === this.host }));
  }

  broadcastPeers() {
    const peers = this.peers();
    for (const c of this.joined()) c.emit({ t: "peers", peers });
  }

  hello(c: FakeConn, name: string, host: boolean) {
    c.peer = this.nextPeer++;
    c.name = name;
    if (host) {
      this.host = c;
      c.state = "joined";
      c.emit({ t: "ready", you: c.peer, host: c.peer });
      this.broadcastPeers();
    } else {
      c.state = "pending";
      c.emit({ t: "waiting" });
      this.host!.emit({ t: "join-request", peer: c.peer, name });
    }
  }

  decide(peer: number, ok: boolean) {
    const c = this.conns.find((x) => x.peer === peer && x.state === "pending");
    if (!c) return;
    if (!ok) return c.drop(4003, "rejected");
    c.state = "joined";
    c.emit({ t: "ready", you: c.peer, host: this.host!.peer });
    this.broadcastPeers();
  }

  forward(from: FakeConn, to: number, data: string) {
    for (const c of this.joined()) {
      if (c === from || (to !== 0 && c.peer !== to)) continue;
      c.emit({ t: "data", from: from.peer, data });
    }
  }

  leave(c: FakeConn) {
    const wasHost = c === this.host;
    c.state = "gone";
    if (wasHost) {
      for (const o of this.conns) if (o.state !== "gone") o.drop(4005, "host left");
    } else {
      this.broadcastPeers();
    }
  }
}

class FakeConn implements Transport {
  state: "none" | "pending" | "joined" | "gone" = "none";
  peer = 0;
  name = "";
  sends = 0;
  /** send の返事を遅らせる（その間に溜まった変更がまとまるかを見るため） */
  sendDelay = 0;
  private handlers: ((e: CollabEvent) => void)[] = [];

  constructor(private readonly relay: FakeRelay) {}

  onEvent(handler: (e: CollabEvent) => void) {
    this.handlers.push(handler);
    return () => (this.handlers = this.handlers.filter((h) => h !== handler));
  }

  /** プラグインからのイベントは、返事とは別に少し遅れて届く */
  emit(e: CollabEvent) {
    setTimeout(() => this.handlers.forEach((h) => h(e)), 0);
  }

  drop(code: number, reason: string) {
    this.state = "gone";
    this.emit({ t: "closed", code, reason });
  }

  async call(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (msg.t) {
      case "start":
        this.relay.hello(this, String(msg.name), true);
        return { room: "room", invite: "https://relay.example/r/room#k=key" };
      case "join":
        this.relay.hello(this, String(msg.name), false);
        return {};
      case "send":
        if (this.state !== "joined") throw { code: "not-in-session", message: "not ready" };
        this.sends++;
        if (this.sendDelay) await new Promise((r) => setTimeout(r, this.sendDelay));
        this.relay.forward(this, Number(msg.to), String(msg.data));
        return {};
      case "approve":
      case "reject":
        this.relay.decide(Number(msg.peer), msg.t === "approve");
        return {};
      case "leave":
        this.relay.leave(this);
        return {};
    }
    throw { code: "bad-request", message: String(msg.t) };
  }
}

async function until(cond: () => boolean, what = "条件") {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`${what}が満たされない`);
}

/** ホストが始め、参加者を承認して、参加者が書けるようになるまで進める */
async function setup(text = "# 議事録\n") {
  const relay = new FakeRelay();
  const requests: { peer: number; name: string }[] = [];
  const host = await CollabSession.start(relay.connect(), { name: "土屋", text, file: "議事録.md" }, {
    joinRequest: (r) => requests.push(r),
  });
  await until(() => host.status === "live", "ホストが live");
  const statuses: Status[] = [];
  const guest = await CollabSession.join(relay.connect(), { name: "佐藤", invite: host.invite }, {
    status: (s) => statuses.push(s),
  });
  await until(() => requests.length === 1, "参加の要求");
  await host.approve(requests[0].peer);
  await until(() => guest.status === "live", "参加者が live");
  return { relay, host, guest, statuses, requests };
}

describe("参加したときの流れ", () => {
  it("承認されると、ホストの内容とファイル名が参加者に届いて書けるようになる", async () => {
    const { host, guest, statuses, requests } = await setup("# 議事録\n- 1 つ目\n");
    expect(requests[0].name).toBe("佐藤");
    expect(statuses).toEqual(["waiting", "syncing", "live"]);
    expect(guest.text.toString()).toBe("# 議事録\n- 1 つ目\n");
    expect(guest.file).toBe("議事録.md");
    expect(guest.peers.map((p) => p.name)).toEqual(["土屋", "佐藤"]);
    expect(host.invite).toContain("#k=");
  });

  it("あとから入った 3 人目にも、それまでの編集を含めた今の内容が届く", async () => {
    const { relay, host, guest } = await setup("a");
    guest.text.insert(1, "b");
    await until(() => host.text.toString() === "ab");
    const requests: number[] = [];
    host["handlers"].joinRequest = (r) => requests.push(r.peer);
    const third = await CollabSession.join(relay.connect(), { name: "鈴木", invite: host.invite });
    await until(() => requests.length === 1);
    await host.approve(requests[0]);
    await until(() => third.status === "live");
    expect(third.text.toString()).toBe("ab");
    third.text.insert(2, "c");
    await until(() => host.text.toString() === "abc" && guest.text.toString() === "abc");
  });

  it("断られた参加者は 4003 で終わる", async () => {
    const relay = new FakeRelay();
    let peer = 0;
    const host = await CollabSession.start(relay.connect(), { name: "土屋", text: "", file: "a.md" }, {
      joinRequest: (r) => (peer = r.peer),
    });
    const closed: number[] = [];
    const guest = await CollabSession.join(relay.connect(), { name: "佐藤", invite: host.invite }, {
      closed: (c) => closed.push(c.code),
    });
    await until(() => peer > 0);
    await host.reject(peer);
    await until(() => guest.status === "closed");
    expect(closed).toEqual([4003]);
  });
});

describe("編集の受け渡し", () => {
  it("両方向の編集が届き、同時に書いても同じ内容にそろう", async () => {
    const { host, guest } = await setup("ABC");
    host.text.insert(0, "1");
    guest.text.insert(3, "2");
    await until(() => host.text.toString() === guest.text.toString() && host.text.length === 5, "内容がそろう");
    expect(host.text.toString()).toBe("1ABC2");
  });

  it("送っている間に溜まった変更は 1 つにまとめて送る", async () => {
    const { relay, host, guest } = await setup("");
    const hostConn = relay.conns[0];
    hostConn.sendDelay = 20;
    const before = hostConn.sends;
    for (const ch of "abcdefghij") host.text.insert(host.text.length, ch);
    await until(() => guest.text.toString() === "abcdefghij", "参加者に全部届く");
    expect(hostConn.sends - before).toBeLessThan(10);
  });

  it("元に戻すのは自分の編集だけ（ほかの人の編集は残る）", async () => {
    const { host, guest } = await setup("");
    const mine = { me: true };
    host.undoManager.addTrackedOrigin(mine);
    host.doc.transact(() => host.text.insert(0, "host "), mine);
    await until(() => guest.text.toString() === "host ");
    guest.text.insert(5, "guest");
    await until(() => host.text.toString() === "host guest");
    host.undoManager.undo();
    expect(host.text.toString()).toBe("guest");
    await until(() => guest.text.toString() === "guest");
  });
});

describe("カーソル（awareness）", () => {
  it("相手の名前と色が届き、抜けた人のカーソルは消える", async () => {
    const { host, guest } = await setup();
    const names = (s: CollabSession) =>
      [...s.awareness.getStates().entries()]
        .filter(([id]) => id !== s.doc.clientID)
        .map(([, st]) => (st as { user: { name: string; color: string } }).user);
    await until(() => names(guest).length === 1 && names(host).length === 1, "カーソルの知らせ");
    expect(names(guest)[0].name).toBe("土屋");
    expect(names(host)[0].name).toBe("佐藤");
    expect(names(host)[0].color).not.toBe(names(guest)[0].color);
    await guest.leave();
    await until(() => names(host).length === 0, "抜けた人のカーソルが消える");
  });
});

describe("終わるとき", () => {
  it("ホストが抜けると参加者は 4005 で終わり、手元の内容は残る", async () => {
    const { host, guest } = await setup("残る内容");
    await host.leave();
    await until(() => guest.status === "closed");
    expect(guest.closeInfo?.code).toBe(4005);
    expect(guest.text.toString()).toBe("残る内容");
    expect(host.status).toBe("closed");
  });
});

describe("applyText", () => {
  it("違う部分だけを入れ替え、ほかの人の編集を消さない", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.on("update", (u: Uint8Array, o: unknown) => o !== "b" && Y.applyUpdate(b, u, "a"));
    b.on("update", (u: Uint8Array, o: unknown) => o !== "a" && Y.applyUpdate(a, u, "b"));
    a.getText("t").insert(0, "line1\nline2\nline3\n");
    // b が末尾に書いたあとで、a は外部での変更（1 行目の書き換え）を取り込む
    b.getText("t").insert(18, "line4\n");
    applyText(a.getText("t"), "LINE1\nline2\nline3\nline4\n");
    expect(a.getText("t").toString()).toBe("LINE1\nline2\nline3\nline4\n");
    expect(b.getText("t").toString()).toBe("LINE1\nline2\nline3\nline4\n");
  });

  it("サロゲートペアの途中で切らない", () => {
    const d = new Y.Doc();
    const t = d.getText("t");
    t.insert(0, "a😀b");
    applyText(t, "a😃b");
    expect(t.toString()).toBe("a😃b");
  });
});

describe("base64", () => {
  it("大きなデータも元に戻る", () => {
    const bytes = new Uint8Array(200_000).map((_, i) => i % 256);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });
});
