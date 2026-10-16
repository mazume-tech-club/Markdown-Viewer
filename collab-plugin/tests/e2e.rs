//! 中継サーバーを相手にした通しのテスト。ホストと参加者のプラグインを 2 つ起動して試す。
//! 中継サーバーを手元で動かしてから実行する：
//!   cd relay; npm run dev
//!   cd collab-plugin; $env:MDP_RELAY_URL="http://localhost:8787"; cargo test -- --ignored

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, channel};
use std::time::Duration;

use serde_json::{Value, json};

const TIMEOUT: Duration = Duration::from_secs(10);

struct Plugin {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<Value>,
    /// 返事を待つ間に届いたイベント
    buffered: VecDeque<Value>,
    next_id: u64,
    _config: tempdir::TempConfig,
}

mod tempdir {
    use std::path::PathBuf;

    /// テストごとの設定ファイル（終わったら消す）
    pub struct TempConfig(pub PathBuf);

    impl TempConfig {
        pub fn new(name: &str) -> Self {
            let p = std::env::temp_dir().join(format!("mdp-collab-e2e-{}-{name}.json", std::process::id()));
            let _ = std::fs::remove_file(&p);
            Self(p)
        }
    }

    impl Drop for TempConfig {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
}

impl Plugin {
    fn spawn(name: &str) -> Self {
        let config = tempdir::TempConfig::new(name);
        let mut child = Command::new(env!("CARGO_BIN_EXE_markdown-preview-collab"))
            .env("MDPREVIEW_COLLAB_CONFIG", &config.0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("プラグインを起動できない");
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                tx.send(serde_json::from_str::<Value>(&line).expect("1 行 1 JSON のはず")).ok();
            }
        });
        Self { child, stdin, lines: rx, buffered: VecDeque::new(), next_id: 1, _config: config }
    }

    /// 依頼を送り、同じ id の返事を待つ。間に届いたイベントは event() で読めるよう残す
    fn call(&mut self, mut req: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        req["id"] = id.into();
        writeln!(self.stdin, "{req}").unwrap();
        loop {
            let msg = self.lines.recv_timeout(TIMEOUT).expect("返事が来ない");
            if msg["id"] == id {
                return msg;
            }
            self.buffered.push_back(msg);
        }
    }

    fn ok(&mut self, req: Value) -> Value {
        let res = self.call(req);
        assert_eq!(res["t"], "ok", "{res}");
        res
    }

    /// 次に届いたイベント（warning は失敗として扱う）
    fn event(&mut self) -> Value {
        let msg = match self.buffered.pop_front() {
            Some(m) => m,
            None => self.lines.recv_timeout(TIMEOUT).expect("イベントが来ない"),
        };
        assert_ne!(msg["t"], "warning", "{msg}");
        msg
    }

    fn event_of(&mut self, t: &str) -> Value {
        let msg = self.event();
        assert_eq!(msg["t"], t, "{msg}");
        msg
    }
}

impl Drop for Plugin {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

fn relay() -> String {
    std::env::var("MDP_RELAY_URL").expect("MDP_RELAY_URL に中継サーバーの URL を入れる")
}

fn b64(s: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(s)
}

#[test]
#[ignore = "中継サーバーが要る"]
fn ホストが始めて参加者が入り両方向にデータが届く() {
    let mut host = Plugin::spawn("host");
    let mut guest = Plugin::spawn("guest");

    let hello = host.ok(json!({"t": "hello", "v": 1}));
    assert_eq!(hello["v"], 1);
    guest.ok(json!({"t": "hello", "v": 1}));

    host.ok(json!({"t": "config-set", "relay": relay()}));
    assert_eq!(host.ok(json!({"t": "config-get"}))["relay"].as_str().unwrap().trim_end_matches('/'), relay().trim_end_matches('/'));

    let started = host.ok(json!({"t": "start", "name": "土屋"}));
    let link = started["invite"].as_str().unwrap().to_string();
    let ready = host.event_of("ready");
    assert_eq!(ready["you"], ready["host"]);
    let host_id = ready["you"].as_u64().unwrap();
    host.event_of("peers");

    // 参加者は中継サーバーを設定していなくても、招待リンクだけで入れる
    guest.ok(json!({"t": "join", "invite": link, "name": "佐藤"}));
    guest.event_of("waiting");
    let req = host.event_of("join-request");
    assert_eq!(req["name"], "佐藤");

    // 承認前は送れない
    let res = guest.call(json!({"t": "send", "to": 0, "data": b64("early")}));
    assert_eq!(res["code"], "not-in-session");

    host.ok(json!({"t": "approve", "peer": req["peer"]}));
    let gready = guest.event_of("ready");
    let guest_id = gready["you"].as_u64().unwrap();
    assert_eq!(gready["host"], host_id);
    assert_eq!(host.event_of("peers")["peers"].as_array().unwrap().len(), 2);
    guest.event_of("peers");

    guest.ok(json!({"t": "send", "to": host_id, "data": b64("こんにちは")}));
    let got = host.event_of("data");
    assert_eq!(got["from"], guest_id);
    assert_eq!(got["data"], b64("こんにちは"));

    host.ok(json!({"t": "send", "to": 0, "data": b64("全員へ")}));
    let got = guest.event_of("data");
    assert_eq!(got["from"], host_id);
    assert_eq!(got["data"], b64("全員へ"));

    // ホストが抜けると、参加者は 4005 で外れる
    host.ok(json!({"t": "leave"}));
    let closed = guest.event_of("closed");
    assert_eq!(closed["code"], 4005);
}

#[test]
#[ignore = "中継サーバーが要る"]
fn 断られた参加者は_4003_で外れる() {
    let mut host = Plugin::spawn("host2");
    let mut guest = Plugin::spawn("guest2");
    host.ok(json!({"t": "config-set", "relay": relay()}));
    let link = host.ok(json!({"t": "start", "name": "土屋"}))["invite"].as_str().unwrap().to_string();
    host.event_of("ready");
    host.event_of("peers");
    guest.ok(json!({"t": "join", "invite": link, "name": "佐藤"}));
    guest.event_of("waiting");
    let req = host.event_of("join-request");
    host.ok(json!({"t": "reject", "peer": req["peer"]}));
    assert_eq!(guest.event_of("closed")["code"], 4003);
}

#[test]
fn 中継サーバーが未設定なら_no_relay() {
    let mut p = Plugin::spawn("norelay");
    let res = p.call(json!({"t": "start", "name": "土屋"}));
    assert_eq!(res["t"], "fail");
    assert_eq!(res["code"], "no-relay");
}

#[test]
fn 形の違う依頼には理由を付けて断る() {
    let mut p = Plugin::spawn("bad");
    assert_eq!(p.call(json!({"t": "hello", "v": 99}))["code"], "plugin-version");
    assert_eq!(p.call(json!({"t": "join", "invite": "nope", "name": "a"}))["code"], "bad-invite");
    assert_eq!(p.call(json!({"t": "config-set", "relay": "http://example.com"}))["code"], "bad-request");
    assert_eq!(p.call(json!({"t": "send", "to": 0, "data": "AA=="}))["code"], "not-in-session");
    assert_eq!(p.call(json!({"t": "unknown"}))["code"], "bad-request");
}
