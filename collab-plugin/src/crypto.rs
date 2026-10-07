//! エンドツーエンド暗号化（docs/collaboration-protocol.md の「暗号文の形」）。
//! 暗号文 = [ノンス 12 バイト][AES-256-GCM の出力]、AAD = "mdp-collab/1" || セッション ID || 送り主の接続 ID

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};

pub const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;
const AAD_PREFIX: &[u8] = b"mdp-collab/1";

/// 新しい暗号の鍵（256 ビットの乱数）
pub fn new_key() -> [u8; KEY_LEN] {
    let mut key = [0u8; KEY_LEN];
    getrandom::fill(&mut key).expect("OS の乱数を取れない");
    key
}

pub struct SessionKey {
    cipher: Aes256Gcm,
    room: String,
}

impl SessionKey {
    pub fn new(key: &[u8; KEY_LEN], room: &str) -> Self {
        Self {
            cipher: Aes256Gcm::new_from_slice(key).expect("鍵の長さは 32 バイト"),
            room: room.to_string(),
        }
    }

    fn aad(&self, sender: u32) -> Vec<u8> {
        let mut aad = Vec::with_capacity(AAD_PREFIX.len() + self.room.len() + 4);
        aad.extend_from_slice(AAD_PREFIX);
        aad.extend_from_slice(self.room.as_bytes());
        aad.extend_from_slice(&sender.to_be_bytes());
        aad
    }

    /// `sender` は自分の接続 ID（ready で受け取ったもの）
    pub fn encrypt(&self, sender: u32, plaintext: &[u8]) -> Vec<u8> {
        let mut nonce = [0u8; NONCE_LEN];
        getrandom::fill(&mut nonce).expect("OS の乱数を取れない");
        let aad = self.aad(sender);
        let sealed = self
            .cipher
            .encrypt(&Nonce::from(nonce), Payload { msg: plaintext, aad: &aad })
            .expect("AES-GCM の暗号化は失敗しない");
        let mut out = Vec::with_capacity(NONCE_LEN + sealed.len());
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&sealed);
        out
    }

    /// `sender` はフレームの先頭にあった送り主の接続 ID。鍵・送り主・中身のどれかが違えば None
    pub fn decrypt(&self, sender: u32, data: &[u8]) -> Option<Vec<u8>> {
        if data.len() < NONCE_LEN {
            return None;
        }
        let (nonce, sealed) = data.split_at(NONCE_LEN);
        let nonce: [u8; NONCE_LEN] = nonce.try_into().ok()?;
        let aad = self.aad(sender);
        self.cipher
            .decrypt(&Nonce::from(nonce), Payload { msg: sealed, aad: &aad })
            .ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOM: &str = "3q2-7wEeAAAAAAAAAAAAAA";

    #[test]
    fn 暗号化して復号すると元に戻る() {
        let key = SessionKey::new(&new_key(), ROOM);
        let sealed = key.encrypt(2, "こんにちは".as_bytes());
        assert_eq!(key.decrypt(2, &sealed).unwrap(), "こんにちは".as_bytes());
    }

    #[test]
    fn 同じ中身でも毎回違う暗号文になる() {
        let key = SessionKey::new(&new_key(), ROOM);
        assert_ne!(key.encrypt(1, b"same"), key.encrypt(1, b"same"));
    }

    #[test]
    fn 別の鍵では復号できない() {
        let sealed = SessionKey::new(&new_key(), ROOM).encrypt(1, b"secret");
        assert!(SessionKey::new(&new_key(), ROOM).decrypt(1, &sealed).is_none());
    }

    #[test]
    fn 送り主を差し替えると復号できない() {
        let key = SessionKey::new(&new_key(), ROOM);
        let sealed = key.encrypt(1, b"secret");
        assert!(key.decrypt(2, &sealed).is_none());
    }

    #[test]
    fn 別のセッションの暗号文は復号できない() {
        let k = new_key();
        let sealed = SessionKey::new(&k, ROOM).encrypt(1, b"secret");
        assert!(SessionKey::new(&k, "BBBBBBBBBBBBBBBBBBBBBB").decrypt(1, &sealed).is_none());
    }

    #[test]
    fn 改ざんされた暗号文は復号できない() {
        let key = SessionKey::new(&new_key(), ROOM);
        let mut sealed = key.encrypt(1, b"secret");
        *sealed.last_mut().unwrap() ^= 1;
        assert!(key.decrypt(1, &sealed).is_none());
        assert!(key.decrypt(1, &sealed[..5]).is_none());
    }
}
