# 共同編集の中継サーバー

Markdown Preview の共同編集で、ホストと参加者の間で暗号化された変更を受け渡すサーバーです（Cloudflare Worker + Durable Object）。中身は読めず、文書は保存しません。

利用団体が**自分の Cloudflare アカウント**に置いて使います（[ADR 0004](../docs/adr/0004-relay-on-each-organizations-own-cloudflare.md)）。やり取りの形は [collaboration-protocol.md](../docs/collaboration-protocol.md) の ③ を見てください。

> 段階 1 の版です。参加用の鍵による確認はまだ無く、URL を知っていれば誰でも接続できます。利用団体へ配るのは段階 2 からです。

## 置き方

Node.js 22 以降が必要です。`relay` フォルダで実行します。

```powershell
npm install
```

```powershell
npx wrangler login
```

```powershell
npm run deploy
```

表示された `https://markdown-preview-relay.<アカウント名>.workers.dev` を、共同編集プラグインの設定の「中継サーバーの URL」に入れます。

## 費用

Workers の無料プランで動きます。1 日の上限に達すると、翌日 9:00（日本時間）まで接続できません。本格的に使うときは、Workers の有料プラン（月 $5）を勧めます。

## 開発

| コマンド | 内容 |
|---------|------|
| `npm test` | テスト（Workers のランタイム上で動く） |
| `npm run typecheck` | 型の検査（先に `worker-configuration.d.ts` を作り直す。このファイルは git に入れない） |
| `npm run dev` | 手元で動かす（`http://localhost:8787`） |
| `npx wrangler types` | `wrangler.jsonc` を変えたあとに、`worker-configuration.d.ts` を作り直す |

`npm install` が `Cannot read properties of null (reading 'edgesOut')` で失敗する npm 10 の不具合を避けるため、`.npmrc` で `legacy-peer-deps` を有効にしています。
