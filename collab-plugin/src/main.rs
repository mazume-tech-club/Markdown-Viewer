//! 共同編集プラグイン（docs/adr/0003）。画面を持たず、本体 Rust と標準入出力でやり取りし、
//! 中継サーバーとの WebSocket と暗号化だけを受け持つ。中身（Yjs のデータ）は解釈しない。
//! やり取りの形は docs/collaboration-protocol.md の ② と ③

mod config;
mod crypto;
mod invite;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

use crypto::SessionKey;

const PROTOCOL_VERSION: u64 = 1;
/// 中継サーバーが受け付けるバイナリのフレームの上限（先頭 4 バイトを含む）
const MAX_FRAME: usize = 1024 * 1024;
const MAX_NAME: usize = 50;
/// 何も流れない接続が途中の機器に切られないよう、ping を送る間隔
const PING_INTERVAL: Duration = Duration::from_secs(30);
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Copy, PartialEq)]
enum Role {
    Host,
    Guest,
}

struct Session {
    /// 何番目のセッションか。抜けたあとに古い接続から届いた知らせを捨てるため
    generation: u64,
    role: Role,
    key: Arc<SessionKey>,
    /// ready で受け取った自分の接続 ID（受け取るまでは送れない）
    you: Option<u32>,
    ws: mpsc::UnboundedSender<Message>,
}

#[derive(Clone)]
struct Out(mpsc::UnboundedSender<String>);

impl Out {
    fn emit(&self, v: Value) {
        let _ = self.0.send(v.to_string());
    }
}

struct Fail {
    code: &'static str,
    message: String,
}

fn fail(code: &'static str, message: impl Into<String>) -> Fail {
    Fail { code, message: message.into() }
}

type Reply = Result<Map<String, Value>, Fail>;

struct Plugin {
    out: Out,
    session: Arc<Mutex<Option<Session>>>,
    generation: AtomicU64,
    http: reqwest::Client,
}

#[tokio::main]
async fn main() {
    let _ = rustls::crypto::ring::default_provider().install_default();

    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    // 標準出力に書くのはこのタスクだけ（行が混ざらないように）
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(line) = rx.recv().await {
            if stdout.write_all(line.as_bytes()).await.is_err()
                || stdout.write_all(b"\n").await.is_err()
                || stdout.flush().await.is_err()
            {
                break;
            }
        }
    });

    let plugin = Plugin {
        out: Out(tx),
        session: Arc::default(),
        generation: AtomicU64::new(0),
        http: reqwest::Client::builder().timeout(HTTP_TIMEOUT).build().expect("HTTP クライアントを作れない"),
    };

    // 依頼は届いた順に 1 つずつ扱う（send の順番を守るため）
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        plugin.handle_line(&line).await;
    }

    // 本体が閉じた。共同編集セッションから抜けて終わる
    plugin.leave();
    drop(plugin);
    let _ = writer.await;
}

impl Plugin {
    async fn handle_line(&self, line: &str) {
        let req: Map<String, Value> = match serde_json::from_str(line) {
            Ok(Value::Object(m)) => m,
            _ => return self.out.emit(json!({"t": "warning", "message": "依頼の形が正しくない"})),
        };
        let Some(id) = req.get("id").and_then(Value::as_u64) else {
            return self.out.emit(json!({"t": "warning", "message": "依頼に id が無い"}));
        };
        let reply = match req.get("t").and_then(Value::as_str) {
            Some("hello") => self.hello(&req),
            Some("config-get") => self.config_get(),
            Some("config-set") => self.config_set(&req),
            Some("start") => self.start(&req).await,
            Some("join") => self.join(&req).await,
            Some("send") => self.send(&req),
            Some(t @ ("approve" | "reject")) => self.decide(t, &req),
            Some("leave") => {
                self.leave();
                Ok(Map::new())
            }
            _ => Err(fail("bad-request", "知らない依頼")),
        };
        let mut msg = match reply {
            Ok(fields) => fields,
            Err(f) => {
                let mut m = Map::new();
                m.insert("code".into(), f.code.into());
                m.insert("message".into(), f.message.into());
                m.insert("t".into(), "fail".into());
                m
            }
        };
        msg.entry("t").or_insert("ok".into());
        msg.insert("id".into(), id.into());
        self.out.emit(Value::Object(msg));
    }

    fn hello(&self, req: &Map<String, Value>) -> Reply {
        if req.get("v").and_then(Value::as_u64) != Some(PROTOCOL_VERSION) {
            return Err(fail("plugin-version", "本体とプラグインの版が違う"));
        }
        Ok(fields(json!({"v": PROTOCOL_VERSION, "plugin": env!("CARGO_PKG_VERSION")})))
    }

    fn config_get(&self) -> Reply {
        Ok(fields(json!({"relay": config::load().relay})))
    }

    fn config_set(&self, req: &Map<String, Value>) -> Reply {
        let relay = match req.get("relay") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) if s.trim().is_empty() => None,
            Some(Value::String(s)) => Some(
                invite::relay_url(s)
                    .ok_or_else(|| fail("bad-request", "中継サーバーの URL は https:// で始めてください"))?
                    .to_string(),
            ),
            Some(_) => return Err(fail("bad-request", "relay は文字列")),
        };
        config::save(&config::Config { relay }).map_err(|e| fail("bad-request", format!("設定を保存できない: {e}")))?;
        Ok(Map::new())
    }

    async fn start(&self, req: &Map<String, Value>) -> Reply {
        self.ensure_idle()?;
        let name = name_of(req)?;
        let relay = config::load().relay.ok_or_else(|| fail("no-relay", "中継サーバーが設定されていない"))?;
        let relay = invite::relay_url(&relay).ok_or_else(|| fail("no-relay", "中継サーバーの URL が正しくない"))?;

        let res = self
            .http
            .post(invite::rooms_url(&relay))
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| fail("network", format!("中継サーバーにつながらない: {e}")))?;
        let body: Value = res.json().await.map_err(|e| fail("network", format!("中継サーバーの応答が正しくない: {e}")))?;
        if body["v"].as_u64() != Some(PROTOCOL_VERSION) {
            return Err(fail("network", "中継サーバーとプロトコルの版が違う"));
        }
        let (Some(room), Some(secret)) = (body["room"].as_str(), body["hostSecret"].as_str()) else {
            return Err(fail("network", "中継サーバーの応答が正しくない"));
        };
        if !invite::is_room_id(room) {
            return Err(fail("network", "中継サーバーの応答が正しくない"));
        }

        let key = crypto::new_key();
        let link = invite::format(&relay, room, &key);
        let hello = json!({"t": "hello", "v": PROTOCOL_VERSION, "role": "host", "name": name, "secret": secret});
        self.connect(Role::Host, &invite::ws_url(&relay, room), SessionKey::new(&key, room), hello).await?;
        Ok(fields(json!({"room": room, "invite": link})))
    }

    async fn join(&self, req: &Map<String, Value>) -> Reply {
        self.ensure_idle()?;
        let link = req.get("invite").and_then(Value::as_str).unwrap_or_default();
        let inv = invite::parse(link).ok_or_else(|| fail("bad-invite", "招待リンクの形が正しくない"))?;
        let name = name_of(req)?;
        let hello = json!({"t": "hello", "v": PROTOCOL_VERSION, "role": "guest", "name": name});
        self.connect(Role::Guest, &invite::ws_url(&inv.relay, &inv.room), SessionKey::new(&inv.key, &inv.room), hello)
            .await?;
        Ok(Map::new())
    }

    fn send(&self, req: &Map<String, Value>) -> Reply {
        let to = req.get("to").and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok());
        let data = req.get("data").and_then(Value::as_str).and_then(|s| B64.decode(s).ok());
        let (Some(to), Some(data)) = (to, data) else {
            return Err(fail("bad-request", "to と data（base64）が要る"));
        };
        let guard = self.session.lock().unwrap();
        let s = guard.as_ref().ok_or_else(|| fail("not-in-session", "共同編集セッション中ではない"))?;
        let you = s.you.ok_or_else(|| fail("not-in-session", "まだ承認されていない"))?;
        let mut frame = to.to_be_bytes().to_vec();
        frame.extend(s.key.encrypt(you, &data));
        if frame.len() > MAX_FRAME {
            return Err(fail("too-large", "1 回に送れる大きさ（1 MiB）を超えている"));
        }
        s.ws.send(Message::Binary(frame.into())).map_err(|_| fail("not-in-session", "接続が切れている"))?;
        Ok(Map::new())
    }

    fn decide(&self, t: &str, req: &Map<String, Value>) -> Reply {
        let peer = req.get("peer").and_then(Value::as_u64).ok_or_else(|| fail("bad-request", "peer が要る"))?;
        let guard = self.session.lock().unwrap();
        let s = guard.as_ref().ok_or_else(|| fail("not-in-session", "共同編集セッション中ではない"))?;
        if s.role != Role::Host {
            return Err(fail("bad-request", "承認できるのはホストだけ"));
        }
        let text = json!({"t": t, "peer": peer}).to_string();
        s.ws.send(Message::Text(text.into())).map_err(|_| fail("not-in-session", "接続が切れている"))?;
        Ok(Map::new())
    }

    /// 抜ける。ホストなら中継サーバーが共同編集セッションを終える
    fn leave(&self) {
        if let Some(s) = self.session.lock().unwrap().take() {
            let _ = s.ws.send(Message::Close(Some(CloseFrame { code: CloseCode::Normal, reason: "leave".into() })));
        }
    }

    fn ensure_idle(&self) -> Result<(), Fail> {
        match *self.session.lock().unwrap() {
            Some(_) => Err(fail("busy", "すでに共同編集セッション中")),
            None => Ok(()),
        }
    }

    /// 中継サーバーへつなぎ、hello を送り、受け渡しのタスクを立てる
    async fn connect(&self, role: Role, url: &str, key: SessionKey, hello: Value) -> Result<(), Fail> {
        let (ws, _) = tokio_tungstenite::connect_async(url)
            .await
            .map_err(|e| fail("network", format!("中継サーバーにつながらない: {e}")))?;
        let (mut sink, mut stream) = ws.split();
        sink.send(Message::Text(hello.to_string().into()))
            .await
            .map_err(|e| fail("network", format!("中継サーバーに送れない: {e}")))?;

        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let key = Arc::new(key);
        let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
        *self.session.lock().unwrap() = Some(Session { generation, role, key: key.clone(), you: None, ws: tx });

        // 送る側：依頼された順に送り、合間に ping を送る
        tokio::spawn(async move {
            let mut ping = tokio::time::interval(PING_INTERVAL);
            ping.tick().await;
            loop {
                tokio::select! {
                    msg = rx.recv() => {
                        let Some(msg) = msg else { break };
                        let closing = matches!(msg, Message::Close(_));
                        if sink.send(msg).await.is_err() || closing { break; }
                    }
                    _ = ping.tick() => {
                        if sink.send(Message::Ping(Vec::new().into())).await.is_err() { break; }
                    }
                }
            }
        });

        // 受け取る側：制御用の JSON はそのまま本体へ、暗号文は復号して本体へ
        let out = self.out.clone();
        let session = self.session.clone();
        tokio::spawn(async move {
            let (code, reason) = loop {
                match stream.next().await {
                    Some(Ok(Message::Text(text))) => on_control(&out, &session, generation, &text),
                    Some(Ok(Message::Binary(data))) => on_data(&out, &key, &data),
                    Some(Ok(Message::Close(frame))) => {
                        break frame.map(|f| (u16::from(f.code), f.reason.to_string())).unwrap_or((1005, String::new()));
                    }
                    Some(Ok(_)) => {}
                    Some(Err(e)) => break (1006, e.to_string()),
                    None => break (1006, "connection closed".into()),
                }
            };
            // 自分から抜けたときは知らせない（本体はもう知っている）
            let mut guard = session.lock().unwrap();
            if guard.as_ref().is_some_and(|s| s.generation == generation) {
                *guard = None;
                drop(guard);
                out.emit(json!({"t": "closed", "code": code, "reason": reason}));
            }
        });
        Ok(())
    }
}

fn on_control(out: &Out, session: &Mutex<Option<Session>>, generation: u64, text: &str) {
    let Ok(Value::Object(msg)) = serde_json::from_str::<Value>(text) else {
        return out.emit(json!({"t": "warning", "message": "中継サーバーからの知らせの形が正しくない"}));
    };
    match msg.get("t").and_then(Value::as_str) {
        Some("ready") => {
            let you = msg.get("you").and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok());
            if let Some(s) = session.lock().unwrap().as_mut().filter(|s| s.generation == generation) {
                s.you = you;
            }
        }
        Some("waiting" | "join-request" | "peers") => {}
        _ => return out.emit(json!({"t": "warning", "message": "中継サーバーから知らない知らせが届いた"})),
    }
    out.emit(Value::Object(msg));
}

fn on_data(out: &Out, key: &SessionKey, data: &[u8]) {
    if data.len() < 4 {
        return;
    }
    let from = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);
    match key.decrypt(from, &data[4..]) {
        Some(plain) => out.emit(json!({"t": "data", "from": from, "data": B64.encode(plain)})),
        None => out.emit(json!({"t": "warning", "message": format!("接続 {from} からのデータを復号できなかった")})),
    }
}

fn name_of(req: &Map<String, Value>) -> Result<String, Fail> {
    let name = req.get("name").and_then(Value::as_str).unwrap_or_default().trim();
    if name.is_empty() || name.chars().count() > MAX_NAME {
        return Err(fail("bad-request", "名前は 1〜50 文字"));
    }
    Ok(name.to_string())
}

fn fields(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}
