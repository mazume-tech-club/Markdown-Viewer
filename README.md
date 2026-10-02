# Markdown Preview

Windows 向けの軽量な Markdown プレビューアプリ（Tauri v2 + WebView2）。図はすべてアプリ内で描画し、外部と通信しません。

## 機能

| 機能 | 内容 |
|---|---|
| Markdown | GFM（表・タスクリスト・取り消し線・自動リンク）、脚注、見出しアンカー |
| コード | highlight.js によるシンタックスハイライト |
| 図 | ```` ```mermaid ````（C4 構文含む）、```` ```dot ```` / ```` ```graphviz ````、```` ```wavedrom ```` |
| 自動更新 | 外部エディタで保存するとプレビューを自動で更新。編集中に外部変更があればバナーで確認 |
| 編集 | CodeMirror エディタ。編集 / 分割 / プレビュー を切替え、分割時はスクロール同期 |
| 起動 | D&D、`.md` の関連付け、コマンド引数（`markdown-preview.exe file.md`）。2つ目の起動は既存ウィンドウで開く |
| 画像貼り付け | エディタで Ctrl+V するとクリップボードの画像を `![](assets/image-日時.png)` として挿入。保存時に md と同じフォルダの `assets/` へ書き出す |
| PDF 出力 | ツールバーの「PDF」か Ctrl+P で PDF プレビューを表示し、確認してから保存。ダークモードでも白地で出力（WebView2 PrintToPdf） |
| ヘルプ | F1 で Markdown / Mermaid / C4 / Graphviz / WaveDrom の書き方集を別ウィンドウで表示。例と描画結果を並べて表示し、コピー・エディタへの挿入ができる（オフライン） |
| テーマ | ツールバーで 自動（OS に追従）/ ライト / ダーク を切替え。設定は保存される |
| ズーム | Ctrl+ホイールでマウス下のペインを拡大縮小。Ctrl+＋/−/0 はフォーカス中のペイン |

## ショートカット

| キー | 動作 |
|---|---|
| Ctrl+N / Ctrl+O | 新規 / 開く |
| Ctrl+S / Ctrl+Shift+S | 保存 / 名前を付けて保存 |
| Ctrl+P | PDF プレビュー（Ctrl+S で保存、Esc で閉じる） |
| F1 | ヘルプ |
| Ctrl+V（エディタ） | 画像の貼り付け |
| Ctrl+1 / 2 / 3 | 編集 / 分割 / プレビュー |
| Ctrl+＋ / Ctrl+− / Ctrl+0 | 拡大 / 縮小 / 100% |
| F5 | ファイルを再読み込み |

## 開発

```powershell
npm install
npm run tauri dev      # 開発起動
npm run tauri build    # src-tauri/target/release/bundle/nsis にインストーラを出力
cd src-tauri; cargo test
```

ヘルプの内容は `src/help/help.md` を編集すれば追加・変更できる（`# セクション {#id}` / `## 項目` / 説明 / `~~~~example` ブロック）。

## 注意

- 文字コードは UTF-8（BOM 可）を想定。UTF-8 として読めないファイルは Shift_JIS として読み込み、保存時は UTF-8 で書き出す。
- 外部への通信をしないため、`http(s)://` の画像は表示されない（CSP で遮断）。
- 「名前を付けて保存」で別フォルダに保存しても、保存済みの `assets/` 内の画像はコピーしない（未保存の貼り付け画像は新しい場所に書き出す）。
- Mermaid の C4 図は自動レイアウトしないので、線が重なるときは `UpdateLayoutConfig($c4ShapeInRow="2")` や `UpdateRelStyle(...)` で配置を調整する（`samples/demo.md` 参照）。
