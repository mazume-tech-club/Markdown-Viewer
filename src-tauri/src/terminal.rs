//! 組み込みターミナル。ConPTY（portable-pty）でシェルを起動し、入出力をフロントエンドの xterm.js とつなぐ。
//!
//! 出力は起動時に受け取った Channel へ `data` で流し、シェルが終わったら `exit` を送る。
//! ConPTY はシェルが終わっても出力のパイプを閉じないので、終了は別スレッドで wait して検知し、
//! PTY を閉じて読み取りスレッドを終わらせる（読み残しを送ってから `exit` が届く）。

use std::{
    collections::HashMap,
    io::{Read, Write},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU32, Ordering},
    },
};

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tauri::{AppHandle, Manager, State, ipc::Channel};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

/// 動いているターミナル。キーは term_spawn が返す番号
#[derive(Default)]
pub struct Terminals {
    sessions: Mutex<HashMap<u32, Session>>,
    next_id: AtomicU32,
}

impl Terminals {
    /// すべてのシェルを終わらせる（アプリの終了時）
    pub fn kill_all(&self) {
        for s in self.sessions.lock().unwrap().values_mut() {
            let _ = s.killer.kill();
        }
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TermEvent {
    Data { data: String },
    Exit { code: Option<u32> },
}

/// PATH から実行ファイルを探す
fn find_in_path(exe: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| dir.join(exe))
        .find(|p| p.is_file())
}

/// 起動するシェル。PowerShell 7 があればそれを、なければ Windows PowerShell を使う
fn shell() -> CommandBuilder {
    if cfg!(windows) {
        let exe = find_in_path("pwsh.exe").unwrap_or_else(|| PathBuf::from("powershell.exe"));
        let mut cmd = CommandBuilder::new(exe);
        cmd.arg("-NoLogo");
        cmd
    } else {
        CommandBuilder::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()))
    }
}

/// 読んだバイト列のうち UTF-8 として読める所までを文字列にして返す。
/// 末尾の途中で切れた文字は pending に残して次の読み取りとつなぐ。壊れたバイトは U+FFFD にする
fn take_utf8(pending: &mut Vec<u8>) -> String {
    let mut out = String::new();
    loop {
        match std::str::from_utf8(pending) {
            Ok(s) => {
                out.push_str(s);
                pending.clear();
                return out;
            }
            Err(e) => {
                let valid = e.valid_up_to();
                out.push_str(std::str::from_utf8(&pending[..valid]).unwrap());
                match e.error_len() {
                    None => {
                        pending.drain(..valid);
                        return out;
                    }
                    Some(n) => {
                        out.push('\u{FFFD}');
                        pending.drain(..valid + n);
                    }
                }
            }
        }
    }
}

/// シェルを起動して番号を返す。cwd がフォルダでなければホームで起動する
#[tauri::command]
pub fn term_spawn(
    app: AppHandle,
    state: State<Terminals>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    on_event: Channel<TermEvent>,
) -> Result<u32, String> {
    let size = PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 };
    let pair = native_pty_system().openpty(size).map_err(|e| e.to_string())?;

    let mut cmd = shell();
    let home = || std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from);
    if let Some(dir) = cwd.map(PathBuf::from).filter(|p| p.is_dir()).or_else(home) {
        cmd.cwd(dir);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| format!("シェルを起動できませんでした: {e}"))?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let killer = child.clone_killer();

    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    state.sessions.lock().unwrap().insert(id, Session { master: pair.master, writer, killer });

    let code = Arc::new(Mutex::new(None));

    // シェルが終わったら PTY を閉じる（読み取りスレッドが読み終えて exit を送る）
    let exit_code = code.clone();
    std::thread::spawn(move || {
        let status = child.wait();
        *exit_code.lock().unwrap() = status.ok().map(|s| s.exit_code());
        let session = app.state::<Terminals>().sessions.lock().unwrap().remove(&id);
        drop(session);
    });

    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let data = take_utf8(&mut pending);
                    if !data.is_empty() && on_event.send(TermEvent::Data { data }).is_err() {
                        break;
                    }
                }
            }
        }
        let code = *code.lock().unwrap();
        let _ = on_event.send(TermEvent::Exit { code });
    });

    Ok(id)
}

/// キー入力・貼り付けをシェルへ送る
#[tauri::command]
pub fn term_write(state: State<Terminals>, id: u32, data: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    let s = sessions.get_mut(&id).ok_or("ターミナルは終了しています")?;
    s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    s.writer.flush().map_err(|e| e.to_string())
}

/// 表示の大きさ（文字数）が変わったことをシェルに伝える
#[tauri::command]
pub fn term_resize(state: State<Terminals>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let Some(s) = sessions.get(&id) else { return Ok(()) };
    s.master
        .resize(PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

/// シェルを終わらせる（パネルの「再起動」・閉じたとき）
#[tauri::command]
pub fn term_kill(state: State<Terminals>, id: u32) {
    if let Some(s) = state.sessions.lock().unwrap().get_mut(&id) {
        let _ = s.killer.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn take_utf8_keeps_split_characters() {
        // 「あ」= E3 81 82 が 2 回の読み取りに分かれて届く
        let mut pending = b"ok \xE3\x81".to_vec();
        assert_eq!(take_utf8(&mut pending), "ok ");
        assert_eq!(pending, b"\xE3\x81");
        pending.extend_from_slice(b"\x82!");
        assert_eq!(take_utf8(&mut pending), "あ!");
        assert!(pending.is_empty());
    }

    #[test]
    fn take_utf8_replaces_broken_bytes() {
        let mut pending = b"a\xFFb".to_vec();
        assert_eq!(take_utf8(&mut pending), "a\u{FFFD}b");
        assert!(pending.is_empty());
    }
}
