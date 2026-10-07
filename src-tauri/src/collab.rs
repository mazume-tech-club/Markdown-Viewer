//! 共同編集プラグインとの受け口（docs/collaboration-protocol.md の ① と ②、docs/adr/0003）。
//! プラグインの exe を起動し、WebView からの依頼を標準入出力へ受け渡すだけで、中身は見ない。
//! 本体は通信しない。インターネットとやり取りするのはプラグインだけ

use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use serde_json::{Map, Value, json};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;

const PROTOCOL_VERSION: u64 = 1;
const PLUGIN_EXE: &str = "markdown-preview-collab.exe";
/// 依頼の返事を待つ長さ（start は中継サーバーへの HTTP と WebSocket の接続を含む）
const CALL_TIMEOUT: Duration = Duration::from_secs(40);

/// プラグインからのイベント（id の無い行）の行き先
type OnEvent = Arc<dyn Fn(Value) + Send + Sync>;
type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>;

struct Plugin {
    /// 何番目に起動したプラグインか。終わったプラグインの後始末が、新しいほうを消さないように
    generation: u64,
    child: Child,
    stdin: ChildStdin,
    pending: Pending,
}

/// プラグインのプロセスを 1 つ持ち、依頼と返事を突き合わせる
#[derive(Default)]
struct Host {
    plugin: Mutex<Option<Plugin>>,
    /// 同時に届いた最初の依頼が、プラグインを 2 つ起動しないように
    starting: tokio::sync::Mutex<()>,
    next_id: AtomicU64,
    generation: AtomicU64,
}

#[derive(Default)]
pub struct Collab(Arc<Host>);

/// WebView へ返す失敗（`code` で理由を見分ける）
fn fail(code: &str, message: impl Into<String>) -> Value {
    json!({"code": code, "message": message.into()})
}

/// プラグインの exe の場所。既定は本体の exe と同じフォルダ。
/// 開発中は MDPREVIEW_COLLAB_PLUGIN で collab-plugin/target のものを指せる
fn plugin_path() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("MDPREVIEW_COLLAB_PLUGIN") {
        return Some(PathBuf::from(p));
    }
    Some(std::env::current_exe().ok()?.parent()?.join(PLUGIN_EXE))
}

/// プラグインが入っているか（無ければ共同編集のメニューを出さない）
#[tauri::command]
pub fn collab_available() -> bool {
    plugin_path().is_some_and(|p| p.is_file())
}

/// プロトコル②の依頼をプラグインへ渡し、`ok` の中身を返す。`fail` なら `{code, message}` で失敗する
#[tauri::command]
pub async fn collab_call(app: AppHandle, state: State<'_, Collab>, msg: Value) -> Result<Value, Value> {
    let Value::Object(msg) = msg else {
        return Err(fail("bad-request", "依頼はオブジェクト"));
    };
    let path = plugin_path().filter(|p| p.is_file()).ok_or_else(|| fail("no-plugin", "共同編集プラグインが入っていない"))?;
    let on_event: OnEvent = Arc::new(move |v| {
        let _ = app.emit("collab-event", v);
    });
    state.0.call(&path, on_event, msg).await
}

impl Host {
    /// 依頼を渡して返事を待つ。プラグインが動いていなければ起動して、版を確かめてから渡す
    async fn call(self: &Arc<Self>, path: &Path, on_event: OnEvent, msg: Map<String, Value>) -> Result<Value, Value> {
        {
            let _starting = self.starting.lock().await;
            if !self.running() {
                self.spawn(path, on_event)?;
                let hello = json!({"t": "hello", "v": PROTOCOL_VERSION});
                if let Err(e) = self.request(hello.as_object().unwrap().clone()).await {
                    self.stop();
                    return Err(e);
                }
            }
        }
        self.request(msg).await
    }

    fn running(&self) -> bool {
        self.plugin
            .lock()
            .unwrap()
            .as_mut()
            .is_some_and(|p| p.child.try_wait().is_ok_and(|status| status.is_none()))
    }

    fn spawn(self: &Arc<Self>, path: &Path, on_event: OnEvent) -> Result<(), Value> {
        let mut cmd = Command::new(path);
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(|e| fail("no-plugin", format!("共同編集プラグインを起動できない: {e}")))?;
        let stdin = child.stdin.take().expect("stdin は piped");
        let stdout = child.stdout.take().expect("stdout は piped");
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let pending = Pending::default();
        // 読み始める前に登録する（すぐに終わったプラグインの後始末が、登録より先に走らないように）
        *self.plugin.lock().unwrap() = Some(Plugin { generation, child, stdin, pending: pending.clone() });

        // 返事は待っている依頼へ、イベントは WebView へ。プラグインが終わったら後始末する。
        // 本体が終わると標準入力が閉じ、プラグインも自分で終わる
        let host = self.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let Ok(Value::Object(msg)) = serde_json::from_str::<Value>(&line) else { continue };
                match msg.get("id").and_then(Value::as_u64) {
                    Some(id) => {
                        if let Some(tx) = pending.lock().unwrap().remove(&id) {
                            let _ = tx.send(Value::Object(msg));
                        }
                    }
                    None => on_event(Value::Object(msg)),
                }
            }
            // 待っていた依頼は、送り手が消えたことで失敗になる
            pending.lock().unwrap().clear();
            let mut plugin = host.plugin.lock().unwrap();
            if plugin.as_ref().is_some_and(|p| p.generation == generation) {
                *plugin = None;
                drop(plugin);
                on_event(json!({"t": "closed", "code": 0, "reason": "plugin-exit"}));
            }
        });
        Ok(())
    }

    fn stop(&self) {
        if let Some(mut p) = self.plugin.lock().unwrap().take() {
            let _ = p.child.kill();
        }
    }

    async fn request(&self, mut msg: Map<String, Value>) -> Result<Value, Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        msg.insert("id".into(), id.into());
        let (tx, rx) = oneshot::channel();
        {
            let mut guard = self.plugin.lock().unwrap();
            let p = guard.as_mut().ok_or_else(|| fail("no-plugin", "共同編集プラグインが動いていない"))?;
            p.pending.lock().unwrap().insert(id, tx);
            let line = format!("{}\n", Value::Object(msg));
            if p.stdin.write_all(line.as_bytes()).and_then(|_| p.stdin.flush()).is_err() {
                p.pending.lock().unwrap().remove(&id);
                return Err(fail("no-plugin", "共同編集プラグインに渡せない"));
            }
        }
        let reply = match tokio::time::timeout(CALL_TIMEOUT, rx).await {
            Ok(Ok(reply)) => reply,
            Ok(Err(_)) => return Err(fail("no-plugin", "共同編集プラグインが終わった")),
            Err(_) => {
                if let Some(p) = self.plugin.lock().unwrap().as_ref() {
                    p.pending.lock().unwrap().remove(&id);
                }
                return Err(fail("timeout", "共同編集プラグインから返事が無い"));
            }
        };
        let Value::Object(mut reply) = reply else { unreachable!("Object だけを送っている") };
        reply.remove("id");
        match reply.remove("t").as_ref().and_then(Value::as_str) {
            Some("ok") => Ok(Value::Object(reply)),
            _ => Err(Value::Object(reply)),
        }
    }
}

#[cfg(test)]
mod tests {
    //! 本物のプラグインの exe を使う。先に collab-plugin で `cargo build` しておく
    //! （無ければこのテストは何もせずに通る）
    use super::*;

    fn plugin_exe() -> Option<PathBuf> {
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../collab-plugin/target/debug").join(PLUGIN_EXE);
        if p.is_file() {
            Some(p)
        } else {
            eprintln!("{} が無いので飛ばす", p.display());
            None
        }
    }

    fn obj(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    fn collect() -> (OnEvent, Arc<Mutex<Vec<Value>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        (Arc::new(move |v| sink.lock().unwrap().push(v)), events)
    }

    #[tokio::test]
    async fn 起動して版を確かめ_依頼の返事を返す() {
        let Some(exe) = plugin_exe() else { return };
        let host = Arc::new(Host::default());
        let (on_event, _) = collect();
        // config-get は設定ファイルを読むだけ（中継サーバーへはつながない）
        let res = host.call(&exe, on_event.clone(), obj(json!({"t": "config-get"}))).await.unwrap();
        assert!(res.get("relay").is_some(), "{res}");
        assert!(res.get("id").is_none() && res.get("t").is_none());
        // 2 回目は同じプラグインを使う
        let generation = host.generation.load(Ordering::SeqCst);
        host.call(&exe, on_event, obj(json!({"t": "config-get"}))).await.unwrap();
        assert_eq!(host.generation.load(Ordering::SeqCst), generation);
        host.stop();
    }

    #[tokio::test]
    async fn 失敗は_code_と_message_で返す() {
        let Some(exe) = plugin_exe() else { return };
        let host = Arc::new(Host::default());
        let (on_event, _) = collect();
        let err = host.call(&exe, on_event, obj(json!({"t": "send", "to": 0, "data": "AA=="}))).await.unwrap_err();
        assert_eq!(err["code"], "not-in-session");
        assert!(err["message"].is_string());
        host.stop();
    }

    #[tokio::test]
    async fn 同時に呼んでもプラグインは_1_つだけ起動する() {
        let Some(exe) = plugin_exe() else { return };
        let host = Arc::new(Host::default());
        let (on_event, _) = collect();
        let calls = (0..5).map(|_| {
            let host = host.clone();
            let exe = exe.clone();
            let on_event = on_event.clone();
            tokio::spawn(async move { host.call(&exe, on_event, obj(json!({"t": "config-get"}))).await })
        });
        for c in calls {
            c.await.unwrap().unwrap();
        }
        assert_eq!(host.generation.load(Ordering::SeqCst), 1);
        host.stop();
    }

    #[tokio::test]
    async fn プラグインが終わると_closed_を知らせ_次の依頼で起動し直す() {
        let Some(exe) = plugin_exe() else { return };
        let host = Arc::new(Host::default());
        let (on_event, events) = collect();
        host.call(&exe, on_event.clone(), obj(json!({"t": "config-get"}))).await.unwrap();
        host.plugin.lock().unwrap().as_mut().unwrap().child.kill().unwrap();
        for _ in 0..100 {
            if !events.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(*events.lock().unwrap(), vec![json!({"t": "closed", "code": 0, "reason": "plugin-exit"})]);
        host.call(&exe, on_event, obj(json!({"t": "config-get"}))).await.unwrap();
        assert_eq!(host.generation.load(Ordering::SeqCst), 2);
        host.stop();
    }

    #[tokio::test]
    async fn exe_が無ければ_no_plugin() {
        let host = Arc::new(Host::default());
        let (on_event, _) = collect();
        let err = host.call(Path::new("Z:/no/such/plugin.exe"), on_event, obj(json!({"t": "config-get"}))).await.unwrap_err();
        assert_eq!(err["code"], "no-plugin");
    }
}
