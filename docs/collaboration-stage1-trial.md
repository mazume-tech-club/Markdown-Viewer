# 共同編集 段階 1 の試し方（作業 7）

[collaboration-stage1-plan.md](collaboration-stage1-plan.md) の作業 7。中継サーバーを実際の Cloudflare に置き、2 台の PC で試す。

> 段階 1 の中継サーバーは、参加用の鍵による確認がまだ無い。URL を知っていれば、誰でもその Cloudflare アカウントで共同編集セッションを作れてしまう。試し終わったら中継サーバーを消すか、段階 2 を作るまで URL を人に渡さない。

## 1. 中継サーバーを置く

`relay` フォルダで、Cloudflare にログインしてから置く。ログインはブラウザが開く。

```powershell
cd C:\foodsdev\markdown-preview\relay; npx wrangler login
```

```powershell
cd C:\foodsdev\markdown-preview\relay; npm run deploy
```

最後に表示される `https://markdown-preview-relay.<アカウント名>.workers.dev` が、中継サーバーの URL になる。

## 2. 試験版を用意する

`out\collab-test.zip`（作り方は下）を、2 台の PC それぞれで好きなフォルダに展開する。中身は次の 3 つ。

| ファイル | 内容 |
|---------|------|
| `markdown-preview.exe` | 本体（インストール不要の版） |
| `markdown-preview-collab.exe` | 共同編集プラグイン（本体と同じフォルダに置く） |
| `start-collab-test.cmd` | 試験版を起動する。インストール済みの Markdown Preview とは別のアプリとして動く |

試験版は、必ず `start-collab-test.cmd` から起動する。`markdown-preview.exe` を直接開くと、インストール済みの Markdown Preview が起動していた場合に、そちらへ吸収されてしまう。

作り直すときは、リポジトリのルートで次を実行してから、`out\collab-test` を zip にする。

```powershell
npx tauri build --no-bundle; cd collab-plugin; cargo build --release; cd ..
```

```powershell
Copy-Item src-tauri\target\release\markdown-preview.exe, collab-plugin\target\release\markdown-preview-collab.exe out\collab-test\ -Force; Compress-Archive -Path out\collab-test\* -DestinationPath out\collab-test.zip -Force
```

## 3. 試す

両方の PC で、設定（Ctrl+,）の「共同編集」に中継サーバーの URL を入れて保存する。そのあと次の順に試し、結果を記入する。

| # | 操作 | 期待すること | 結果 |
|---|------|------------|------|
| 1 | ホスト：保存済みの .md を開き、「共同編集」→ 名前を入れて「始める」 | 招待リンクが出てクリップボードにコピーされる。タブに「⇄」 | |
| 2 | ホスト：招待リンクをチャットなどで参加者へ送る | — | |
| 3 | 参加者：「共同編集」→ 名前と招待リンクを入れて「参加」 | 「ホストの承認を待っています」。エディタは書けない | |
| 4 | ホスト：バナーの「承認」 | 参加者にホストの内容が出て、タブ名が「〇〇.md（共同編集）」になる | |
| 5 | 2 人で同じ段落を同時に書く | 両方の画面が同じ内容にそろう。相手のカーソルに名前が出る | |
| 6 | 参加者：Ctrl+Z | 自分の入力だけが戻る | |
| 7 | ホスト：Ctrl+S | ホストのファイルに 2 人の編集が入る | |
| 8 | 参加者：Ctrl+S | 「名前を付けて保存」で、手元にコピーを保存できる | |
| 9 | ホスト：「共同編集を終える」 | 参加者に「ホストが共同編集を終えました」が出て、読み取り専用になる | |
| 10 | 在宅の回線と社内の回線の組み合わせで 1〜9 | 同じように動く（社内のプロキシで止められないか） | |

うまくいかないときは、次を控えておく。

- 画面に出た言葉
- 中継サーバーの記録：`relay` フォルダで `npx wrangler tail` を実行すると、届いた接続が流れる

## 4. 片付け

試し終わったら、中継サーバーを消す（段階 2 で参加用の鍵を入れるまで、置いたままにしない）。

```powershell
cd C:\foodsdev\markdown-preview\relay; npx wrangler delete
```
