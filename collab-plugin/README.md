# 共同編集プラグイン

Markdown Preview の共同編集のための、画面を持たない exe（`markdown-preview-collab.exe`）です（[ADR 0003](../docs/adr/0003-collaboration-plugin-as-separate-exe.md)）。本体 Rust と標準入出力でやり取りし、中継サーバーとの WebSocket と暗号化だけを受け持ちます。やり取りの形は [collaboration-protocol.md](../docs/collaboration-protocol.md) の ② と ③ を見てください。

| ファイル | 内容 |
|---------|------|
| `src/main.rs` | 依頼の受け付け、中継サーバーとの接続 |
| `src/crypto.rs` | AES-256-GCM の暗号化と復号 |
| `src/invite.rs` | 中継サーバーの URL と招待リンク |
| `src/config.rs` | 設定ファイル（`%APPDATA%\jp.asuzacgroup.markdownpreview\collab-plugin.json`） |
| `tests/e2e.rs` | プラグインを 2 つ起動して、中継サーバー越しに試す |

## ビルド

```powershell
cargo build --release
```

## テスト

単体テストと、中継サーバーが要らないテストは次のとおりです。

```powershell
cargo test
```

中継サーバーを相手にした通しのテストは、別のターミナルで中継サーバーを動かしてから実行します。

```powershell
cd ..\relay; npm run dev -- --port 8787 --ip 127.0.0.1
```

```powershell
$env:MDP_RELAY_URL="http://127.0.0.1:8787"; cargo test -- --include-ignored
```

## 手で試す

起動して、1 行に 1 つの JSON を入力すると返事が出ます。

```powershell
cargo run
```

```json
{"id":1,"t":"hello","v":1}
```
