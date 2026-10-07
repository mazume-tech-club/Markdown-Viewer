//! プラグインの設定ファイル（秘密でない設定だけを置く。参加用の鍵は段階 2 で資格情報マネージャーへ）

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Default, Serialize, Deserialize)]
pub struct Config {
    /// 中継サーバーの URL
    #[serde(default)]
    pub relay: Option<String>,
}

/// 既定は %APPDATA%\jp.asuzacgroup.markdownpreview\collab-plugin.json（本体のアプリのデータと同じ場所）。
/// テストのときは MDPREVIEW_COLLAB_CONFIG で置き場所を変える
fn path() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("MDPREVIEW_COLLAB_CONFIG") {
        return Some(PathBuf::from(p));
    }
    let appdata = std::env::var_os("APPDATA")?;
    Some(PathBuf::from(appdata).join("jp.asuzacgroup.markdownpreview").join("collab-plugin.json"))
}

pub fn load() -> Config {
    path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(config: &Config) -> std::io::Result<()> {
    let p = path().ok_or_else(|| std::io::Error::other("APPDATA が無い"))?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(p, serde_json::to_string_pretty(config)?)
}
