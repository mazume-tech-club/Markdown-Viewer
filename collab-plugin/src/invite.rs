//! 中継サーバーの URL と招待リンク（docs/collaboration-protocol.md の「招待リンク」）。
//! 招待リンク = <中継サーバー>/r/<セッション ID>#k=<暗号の鍵（base64url）>

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use url::Url;

use crate::crypto::KEY_LEN;

pub struct Invite {
    pub relay: Url,
    pub room: String,
    pub key: [u8; KEY_LEN],
}

/// 中継サーバーの URL を確かめ、末尾の / を除いた形にそろえる。
/// https だけを許す。http は開発用に localhost だけ許す
pub fn relay_url(text: &str) -> Option<Url> {
    let url = Url::parse(text.trim()).ok()?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    let ok_scheme = url.scheme() == "https" || (url.scheme() == "http" && local);
    if !ok_scheme || url.host_str().is_none() || url.query().is_some() || url.fragment().is_some() {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let mut url = url;
    let path = url.path().trim_end_matches('/').to_string();
    url.set_path(&path);
    Some(url)
}

fn join(relay: &Url, rest: &str) -> String {
    format!("{}{}", relay.as_str().trim_end_matches('/'), rest)
}

pub fn rooms_url(relay: &Url) -> String {
    join(relay, "/rooms")
}

/// WebSocket の接続先（https → wss、http → ws）
pub fn ws_url(relay: &Url, room: &str) -> String {
    let http = join(relay, &format!("/rooms/{room}"));
    match http.strip_prefix("https://") {
        Some(rest) => format!("wss://{rest}"),
        None => format!("ws://{}", http.trim_start_matches("http://")),
    }
}

pub fn is_room_id(room: &str) -> bool {
    room.len() == 22 && room.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn format(relay: &Url, room: &str, key: &[u8; KEY_LEN]) -> String {
    join(relay, &format!("/r/{room}#k={}", URL_SAFE_NO_PAD.encode(key)))
}

pub fn parse(text: &str) -> Option<Invite> {
    let url = Url::parse(text.trim()).ok()?;
    let key = url.fragment()?.strip_prefix("k=")?;
    let key: [u8; KEY_LEN] = URL_SAFE_NO_PAD.decode(key).ok()?.try_into().ok()?;
    let path = url.path();
    let (base, room) = path.rsplit_once("/r/")?;
    if !is_room_id(room) {
        return None;
    }
    let mut relay = url.clone();
    relay.set_fragment(None);
    relay.set_path(base);
    let relay = relay_url(relay.as_str())?;
    Some(Invite { relay, room: room.to_string(), key })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOM: &str = "3q2-7wEeAAAAAAAAAAAAAA";

    #[test]
    fn 招待リンクを作って読み取ると元に戻る() {
        let relay = relay_url("https://relay.example.workers.dev/").unwrap();
        let key = [7u8; KEY_LEN];
        let link = format(&relay, ROOM, &key);
        assert!(link.starts_with("https://relay.example.workers.dev/r/3q2-7wEeAAAAAAAAAAAAAA#k="));
        let inv = parse(&link).unwrap();
        assert_eq!(inv.relay.as_str(), "https://relay.example.workers.dev/");
        assert_eq!(inv.room, ROOM);
        assert_eq!(inv.key, key);
    }

    #[test]
    fn 中継サーバーがパスの下にあっても読み取れる() {
        let relay = relay_url("https://example.com/collab").unwrap();
        let inv = parse(&format(&relay, ROOM, &[1u8; KEY_LEN])).unwrap();
        assert_eq!(inv.relay.as_str(), "https://example.com/collab");
        assert_eq!(ws_url(&inv.relay, ROOM), format!("wss://example.com/collab/rooms/{ROOM}"));
    }

    #[test]
    fn 形の違う招待リンクは読み取らない() {
        let key = URL_SAFE_NO_PAD.encode([1u8; KEY_LEN]);
        assert!(parse("not a url").is_none());
        assert!(parse(&format!("https://e.com/r/{ROOM}")).is_none(), "鍵が無い");
        assert!(parse(&format!("https://e.com/r/{ROOM}#k=short")).is_none(), "鍵が短い");
        assert!(parse(&format!("https://e.com/r/abc#k={key}")).is_none(), "セッション ID が短い");
        assert!(parse(&format!("http://e.com/r/{ROOM}#k={key}")).is_none(), "http は localhost だけ");
        assert!(parse(&format!("http://localhost:8787/r/{ROOM}#k={key}")).is_some());
    }

    #[test]
    fn 中継サーバーの_url_を確かめる() {
        assert!(relay_url("https://relay.example.workers.dev").is_some());
        assert!(relay_url("http://localhost:8787/").is_some());
        assert!(relay_url("http://relay.example.workers.dev").is_none());
        assert!(relay_url("ftp://example.com").is_none());
        assert!(relay_url("https://user:pass@example.com").is_none());
        assert!(relay_url("https://example.com/?a=1").is_none());
        assert_eq!(
            ws_url(&relay_url("http://localhost:8787").unwrap(), ROOM),
            format!("ws://localhost:8787/rooms/{ROOM}")
        );
        assert_eq!(rooms_url(&relay_url("https://e.com/").unwrap()), "https://e.com/rooms");
    }
}
