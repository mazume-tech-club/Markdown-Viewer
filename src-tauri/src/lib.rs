use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

use notify_debouncer_mini::{
    DebounceEventResult, Debouncer, new_debouncer,
    notify::{RecommendedWatcher, RecursiveMode},
};
use tauri::{AppHandle, Emitter, Manager, State};

/// 起動引数で渡されたファイル（フロントエンドが準備できたら一度だけ取り出す）
#[derive(Default)]
struct LaunchFile(Mutex<Option<String>>);

/// 監視中のファイル（タブごと）。キーはフロントエンドが渡したパス
#[derive(Default)]
struct WatchState(Mutex<HashMap<String, Debouncer<RecommendedWatcher>>>);

/// 直近に作った PDF プレビューの一時ファイル
#[derive(Default)]
struct PdfPreview(Mutex<Option<PathBuf>>);

/// 引数列から最初のファイルパスを取り出し、cwd 基準の絶対パスにする
fn file_arg(args: &[String], cwd: &Path) -> Option<String> {
    args.iter().skip(1).find(|a| !a.starts_with('-')).map(|a| {
        let p = PathBuf::from(a);
        let p = if p.is_absolute() { p } else { cwd.join(p) };
        p.to_string_lossy().into_owned()
    })
}

/// UTF-8（BOM 付き含む）として読み、失敗したら Shift_JIS とみなして読む
fn decode(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_owned(),
        Err(_) => encoding_rs::SHIFT_JIS.decode(bytes).0.into_owned(),
    }
}

fn same_path(a: &Path, b: &Path) -> bool {
    // Windows のパスは大文字小文字を区別しない
    a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read(&path)
        .map(|b| decode(&b))
        .map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| format!("{path}: {e}"))
}

fn header(request: &tauri::ipc::Request, name: &str) -> Result<String, String> {
    let raw = request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| format!("{name} ヘッダがありません"))?;
    Ok(percent_encoding::percent_decode_str(raw)
        .decode_utf8_lossy()
        .into_owned())
}

/// md ファイルからの相対パスを検証し、書き出し先の絶対パスを返す（md のフォルダの外には出さない）
fn asset_target(md: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel);
    let ok = !rel.is_empty()
        && rel_path
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)));
    if !ok {
        return Err(format!("不正なパス: {rel}"));
    }
    let dir = md.parent().ok_or("md の親ディレクトリがありません")?;
    Ok(dir.join(rel_path))
}

/// 貼り付けた画像などを md の隣に書き出す。本文はバイナリのまま受け取る。
/// ヘッダ: x-md = md ファイルの絶対パス、x-rel = md からの相対パス（いずれも URL エンコード）
#[tauri::command]
fn write_asset(request: tauri::ipc::Request) -> Result<(), String> {
    let md = header(&request, "x-md")?;
    let rel = header(&request, "x-rel")?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("画像データがありません".into());
    };
    let target = asset_target(Path::new(&md), &rel)?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&target, bytes).map_err(|e| format!("{}: {e}", target.display()))
}

/// PDF を一時フォルダに作り、そのパスを返す（プレビュー表示用）。前回のプレビューは削除する
#[tauri::command]
async fn preview_pdf(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, PdfPreview>,
) -> Result<String, String> {
    let dir = std::env::temp_dir().join("markdown-preview");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.asset_protocol_scope()
        .allow_directory(&dir, false)
        .map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    // ファイル名を毎回変えて、iframe が古い PDF をキャッシュ表示しないようにする
    let path = dir.join(format!("preview-{stamp}.pdf"));
    print_to_pdf(window, path.to_string_lossy().into_owned()).await?;
    if let Some(old) = state.0.lock().unwrap().replace(path.clone()) {
        let _ = std::fs::remove_file(old);
    }
    Ok(path.to_string_lossy().into_owned())
}

/// 直近のプレビュー PDF を指定先に保存する
#[tauri::command]
fn save_preview_pdf(state: State<PdfPreview>, path: String) -> Result<(), String> {
    let src = state
        .0
        .lock()
        .unwrap()
        .clone()
        .ok_or("プレビューがありません")?;
    std::fs::copy(&src, &path)
        .map(|_| ())
        .map_err(|e| format!("{path}: {e}"))
}

/// 表示中のページを WebView2 の PrintToPdf で PDF にする（印刷用 CSS が適用される）
#[cfg(windows)]
async fn print_to_pdf(window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::{ICoreWebView2_7, ICoreWebView2Environment6},
        PrintToPdfCompletedHandler,
    };
    use windows::core::{HSTRING, Interface};

    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    window
        .with_webview(move |wv| {
            let start = || -> windows::core::Result<()> {
                unsafe {
                    let core = wv.controller().CoreWebView2()?.cast::<ICoreWebView2_7>()?;
                    let env = wv.environment().cast::<ICoreWebView2Environment6>()?;
                    let settings = env.CreatePrintSettings()?;
                    settings.SetShouldPrintBackgrounds(true)?;
                    settings.SetShouldPrintHeaderAndFooter(false)?;
                    let tx2 = tx.clone();
                    let handler = PrintToPdfCompletedHandler::create(Box::new(move |res, ok| {
                        let _ = tx2.send(match (res, ok) {
                            (Ok(()), true) => Ok(()),
                            (Err(e), _) => Err(e.to_string()),
                            _ => Err("PDF の出力に失敗しました".into()),
                        });
                        Ok(())
                    }));
                    core.PrintToPdf(&HSTRING::from(path), &settings, &handler)
                }
            };
            if let Err(e) = start() {
                let _ = tx.send(Err(e.to_string()));
            }
        })
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?
}

#[cfg(not(windows))]
async fn print_to_pdf(_window: tauri::WebviewWindow, _path: String) -> Result<(), String> {
    Err("PDF 出力は Windows のみ対応しています".into())
}

/// 更新をダウンロードしてインストーラを起動する。
///
/// プラグイン標準の `downloadAndInstall` は、インストーラを起動する前にウィンドウを片付けてしまうため、
/// セキュリティソフトに起動を阻まれると「画面のないプロセス」が残り、以降アプリが起動できなくなる。
/// ここではインストーラが起動したことを確かめてからアプリを終了し、失敗したらエラーを返して
/// アプリをそのまま使えるようにする（フロントエンドで再試行・手動ダウンロードを案内する）。
#[cfg(windows)]
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;

    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| format!("更新の確認に失敗しました: {e}"))?
        .ok_or("新しいバージョンが見つかりませんでした")?;

    // ダウンロードと署名の検証（検証に失敗したらここでエラーになる）
    let emitter = app.clone();
    let mut done: u64 = 0;
    let bytes = update
        .download(
            move |chunk, total| {
                done += chunk as u64;
                let _ = emitter.emit("update-progress", (done, total));
            },
            || {},
        )
        .await
        .map_err(|e| format!("ダウンロードに失敗しました: {e}"))?;

    let version = update.version.clone();
    tauri::async_runtime::spawn_blocking(move || launch_installer(&bytes, &version))
        .await
        .map_err(|e| e.to_string())??;

    // インストーラが動き出したので終了してファイルを明け渡す（インストール後に /R で再起動される）
    app.exit(0);
    Ok(())
}

/// インストーラを一時フォルダに保存して起動し、すぐに止められていないことを確かめる
#[cfg(windows)]
fn launch_installer(bytes: &[u8], version: &str) -> Result<(), String> {
    use std::time::{Duration, Instant};

    const BLOCKED: &str = "セキュリティソフトにブロックされた可能性があります";
    let dir = std::env::temp_dir().join("markdown-preview-update");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("Markdown-Preview_{version}_x64-setup.exe"));
    std::fs::write(&path, bytes)
        .map_err(|e| format!("更新ファイルを保存できませんでした。{BLOCKED}。({e})"))?;

    // 保存した直後に隔離・削除されていないか
    std::thread::sleep(Duration::from_millis(500));
    if !path.exists() {
        return Err(format!("ダウンロードした更新ファイルが削除されました。{BLOCKED}。"));
    }

    // Tauri の updater と同じ引数（passive・更新モード・インストール後に再起動）
    let mut child = std::process::Command::new(&path)
        .args(["/P", "/UPDATE", "/R"])
        .spawn()
        .map_err(|e| format!("インストーラを起動できませんでした。{BLOCKED}。({e})"))?;

    // 起動直後に止められていないか、しばらく様子を見る
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(3) {
        match child.try_wait() {
            Ok(Some(status)) if !status.success() => {
                return Err(format!(
                    "インストーラが途中で終了しました（終了コード {}）。{BLOCKED}。",
                    status.code().map_or("不明".into(), |c| c.to_string())
                ));
            }
            Ok(Some(_)) => break,
            Ok(None) => std::thread::sleep(Duration::from_millis(250)),
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}

#[cfg(not(windows))]
#[tauri::command]
async fn install_update() -> Result<(), String> {
    Err("この OS では自動更新に対応していません".into())
}

/// ヘルプウィンドウを開く（開いていれば前面に出す）。
/// tauri.conf.json の定義から作るので、メインと同じ WebView2 起動引数になる
/// （引数が食い違うと WebView2 が 0x8007139F で作成に失敗する）
#[tauri::command]
async fn open_help(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("help") {
        let _ = win.unminimize();
        return win.set_focus().map_err(|e| e.to_string());
    }
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "help")
        .ok_or("help ウィンドウの設定がありません")?
        .clone();
    tauri::WebviewWindowBuilder::from_config(&app, &config)
        .and_then(|b| b.build())
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn initial_file(state: State<LaunchFile>) -> Option<String> {
    state.0.lock().unwrap().take()
}

/// ファイルの親ディレクトリを監視し、対象ファイルが変わったら `file-changed` を通知する。
/// あわせて、相対パス画像を表示できるよう親ディレクトリを asset スコープに追加する。
#[tauri::command]
fn watch_file(app: AppHandle, state: State<WatchState>, path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let dir = target
        .parent()
        .ok_or_else(|| format!("{path}: 親ディレクトリがありません"))?
        .to_path_buf();

    app.asset_protocol_scope()
        .allow_directory(&dir, true)
        .map_err(|e| e.to_string())?;

    let emitter = app.clone();
    let watched = target.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(200),
        move |res: DebounceEventResult| {
            if let Ok(events) = res
                && events.iter().any(|e| same_path(&e.path, &watched))
            {
                let _ = emitter.emit("file-changed", watched.to_string_lossy().to_string());
            }
        },
    )
    .map_err(|e| e.to_string())?;
    debouncer
        .watcher()
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    // 同じパスの古い Debouncer は drop されて監視が止まる
    state.0.lock().unwrap().insert(path, debouncer);
    Ok(())
}

/// ファイルの監視をやめる（タブを閉じたとき）
#[tauri::command]
fn unwatch_file(state: State<WatchState>, path: String) {
    state.0.lock().unwrap().remove(&path);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let cwd = std::env::current_dir().unwrap_or_default();
    let args: Vec<String> = std::env::args().collect();

    tauri::Builder::default()
        // 2つ目の起動は既存ウィンドウにファイルを渡して終了する
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
            if let Some(path) = file_arg(&args, Path::new(&cwd)) {
                let _ = app.emit("open-file", path);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(LaunchFile(Mutex::new(file_arg(&args, &cwd))))
        .manage(WatchState::default())
        .manage(PdfPreview::default())
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            initial_file,
            watch_file,
            unwatch_file,
            write_asset,
            preview_pdf,
            save_preview_pdf,
            open_help,
            install_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_strips_bom_and_falls_back_to_sjis() {
        assert_eq!(decode(b"\xEF\xBB\xBF# hi"), "# hi");
        // "日本" in Shift_JIS
        assert_eq!(decode(b"\x93\xfa\x96\x7b"), "日本");
    }

    #[test]
    fn asset_target_rejects_escaping_paths() {
        let md = Path::new(r"C:\docs\a.md");
        assert_eq!(
            asset_target(md, "assets/x.png").unwrap(),
            Path::new(r"C:\docs\assets\x.png")
        );
        // 貼り付け画像は「md の名前.assets」に置く（空白・日本語を含んでもよい）
        assert_eq!(
            asset_target(Path::new(r"C:\docs\設計 書.md"), "設計 書.assets/image-1.png").unwrap(),
            Path::new(r"C:\docs\設計 書.assets\image-1.png")
        );
        assert!(asset_target(md, "../x.png").is_err());
        assert!(asset_target(md, r"C:\x.png").is_err());
        assert!(asset_target(md, "").is_err());
    }

    #[test]
    fn file_arg_resolves_relative_and_skips_flags() {
        let cwd = Path::new(r"C:\work");
        let args = vec!["app.exe".into(), "--flag".into(), r"docs\a.md".into()];
        assert_eq!(file_arg(&args, cwd).unwrap(), r"C:\work\docs\a.md");
        assert_eq!(file_arg(&["app.exe".into()], cwd), None);
    }
}
