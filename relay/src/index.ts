// 共同編集の中継サーバーの入り口（docs/collaboration-protocol.md の ③）
import { Room, ROOM_ID_RE, PROTOCOL_VERSION } from "./room";
import { randomId, sha256Hex } from "./util";

export { Room };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** 招待リンクをブラウザで開いたときの案内（鍵は # の後ろなのでここには届かない） */
function invitePage(): Response {
  const html = `<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Markdown Preview 共同編集</title>
<style>body{font-family:system-ui,sans-serif;max-width:40em;margin:3em auto;padding:0 1em;line-height:1.7}</style>
</head>
<body>
<h1>Markdown Preview の共同編集への招待です</h1>
<p>このリンク（アドレスバーの URL 全体）をコピーし、Markdown Preview の「共同編集に参加」に貼り付けてください。</p>
<p>共同編集には、共同編集プラグインを入れた Markdown Preview が必要です。</p>
</body>
</html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (request.method === "POST" && parts.length === 1 && parts[0] === "rooms") {
      const room = randomId(16);
      const hostSecret = randomId(32);
      await env.ROOMS.get(env.ROOMS.idFromName(room)).init(await sha256Hex(hostSecret));
      return json(201, { v: PROTOCOL_VERSION, room, hostSecret });
    }

    if (request.method === "GET" && parts.length === 2 && ROOM_ID_RE.test(parts[1])) {
      if (parts[0] === "rooms") return env.ROOMS.get(env.ROOMS.idFromName(parts[1])).fetch(request);
      if (parts[0] === "r") return invitePage();
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
