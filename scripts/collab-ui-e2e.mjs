// 共同編集の画面の通しの確認。ホストと参加者のアプリを起動し、WebView2 のデバッグポート（CDP）で画面を操作する。
// 先に次を動かしておく：relay で `npm run dev -- --port 8787 --ip 127.0.0.1`、ルートで `npm run dev`、
// src-tauri と collab-plugin で `cargo build`。実行は `node scripts/collab-ui-e2e.mjs`
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
const TMP = `${tmpdir()}/mdp-collab-ui-e2e`;
const EXE = `${ROOT}/src-tauri/target/debug/markdown-preview.exe`;
const PLUGIN = `${ROOT}/collab-plugin/target/debug/markdown-preview-collab.exe`;
const RELAY = "http://127.0.0.1:8787";

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const md = `${TMP}/議事録.md`;
writeFileSync(md, "# 議事録\n\n- 最初の行\n");

const procs = [];
function launch(name, port, args = []) {
  const p = spawn(EXE, args, {
    env: {
      ...process.env,
      MDPREVIEW_DEV_INSTANCE: `e2e-${name}`,
      MDPREVIEW_COLLAB_PLUGIN: PLUGIN,
      MDPREVIEW_COLLAB_CONFIG: `${TMP}/${name}-collab.json`,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: "ignore",
  });
  procs.push(p);
  return p;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(port) {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420") && !t.url.includes("help"));
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
        let id = 0;
        const waiting = new Map();
        ws.onmessage = (e) => {
          const m = JSON.parse(e.data);
          if (m.id && waiting.has(m.id)) {
            waiting.get(m.id)(m);
            waiting.delete(m.id);
          }
        };
        const send = (method, params = {}) =>
          new Promise((r) => {
            const n = ++id;
            waiting.set(n, r);
            ws.send(JSON.stringify({ id: n, method, params }));
          });
        const evaluate = async (expr) => {
          const res = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
          if (res.result?.exceptionDetails) throw new Error(`${expr}\n${JSON.stringify(res.result.exceptionDetails)}`);
          return res.result?.result?.value;
        };
        return { send, evaluate, ws };
      }
    } catch {}
    await sleep(300);
  }
  throw new Error(`port ${port} に繋がらない`);
}

async function until(app, expr, what, ms = 15000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await app.evaluate(expr).catch((e) => String(e));
    if (last) return last;
    await sleep(200);
  }
  throw new Error(`${what} にならない（最後の値: ${JSON.stringify(last)}）`);
}

/** 入力欄に値を入れて input イベントを出す */
const setValue = (id, v) =>
  `(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event("input")); return true })()`;
const click = (sel) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el || el.disabled) return false; el.click(); return true })()`;
const editorText = `[...document.querySelectorAll(".cm-content .cm-line")].map((l) => l.textContent).join("\\n")`;

/** エディタの末尾に文字を打つ（本物のキー入力として） */
async function typeAtEnd(app, text) {
  await app.evaluate(`document.querySelector(".cm-content").focus(), true`);
  await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "End", code: "End", windowsVirtualKeyCode: 35, modifiers: 2 });
  await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "End", code: "End", windowsVirtualKeyCode: 35, modifiers: 2 });
  await app.send("Input.insertText", { text });
}

const results = [];
const check = (name, ok, note = "") => {
  results.push({ name, ok, note });
  console.log(`${ok ? "OK " : "NG "} ${name}${note ? ` (${note})` : ""}`);
};

try {
  launch("host", 9301, [md]);
  launch("guest", 9302);
  const host = await connect(9301);
  const guest = await connect(9302);
  for (const app of [host, guest]) {
    await until(app, `!document.getElementById("btn-collab").hidden`, "共同編集ボタンが出る");
    await app.evaluate(click(`[data-mode="split"]`));
  }
  check("プラグインがあると共同編集ボタンが出る", true);

  // 中継サーバーを設定する（設定画面）
  for (const app of [host, guest]) {
    await app.evaluate(click("#btn-settings"));
    await until(app, `!document.getElementById("settings-collab").hidden`, "設定に共同編集の欄");
    await app.evaluate(setValue("set-relay", RELAY));
    await app.evaluate(click("#set-relay-save"));
    await until(app, `document.getElementById("set-relay-status").textContent.includes("保存しました")`, "中継サーバーを保存");
    await app.evaluate(click("#settings-close"));
  }
  check("設定で中継サーバーの URL を保存できる", true, readFileSync(`${TMP}/host-collab.json`, "utf8").replace(/\s+/g, " "));

  // ホストが始める
  await until(host, `${editorText}.includes("最初の行")`, "ホストがファイルを開いている");
  await host.evaluate(click("#btn-collab"));
  await host.evaluate(setValue("collab-name", "土屋"));
  await host.evaluate(click("#collab-start"));
  const invite = await until(host, `document.getElementById("collab-invite-out").value`, "招待リンクが出る");
  check("ホストが始めると招待リンクが出る", /^http:\/\/127\.0\.0\.1:8787\/r\/[A-Za-z0-9_-]{22}#k=/.test(invite), invite.replace(/#k=.*/, "#k=…"));
  check("ホストのタブに共同編集の印", Boolean(await until(host, `document.querySelector(".tab .tab-collab") !== null`, "タブの印")));

  // 参加者が参加を求める
  await guest.evaluate(click("#btn-collab"));
  await guest.evaluate(setValue("collab-name", "佐藤"));
  await guest.evaluate(setValue("collab-invite-in", invite));
  await guest.evaluate(click("#collab-join"));
  await until(guest, `document.getElementById("collab-state").textContent.includes("承認を待って")`, "参加者が承認待ち");
  check("参加者は承認待ちになり、書けない", (await guest.evaluate(`document.querySelector(".cm-content").contentEditable`)) === "false");

  // ホストが承認する
  const req = await until(host, `document.querySelector(".collab-request span")?.textContent`, "参加の要求のバナー");
  check("ホストに参加の要求が出る", req.includes("佐藤"), req);
  await host.evaluate(click(".collab-request button.primary"));
  await until(guest, `${editorText}.includes("最初の行")`, "参加者にホストの内容が届く");
  check("承認されると参加者にホストの内容が届く", true);
  check("参加者のタブ名はホストのファイル名（共同編集）", (await until(guest, `document.querySelector(".tab[aria-selected='true'] .tab-name").textContent`, "タブ名")).includes("議事録.md（共同編集）"));
  check("参加者は書ける", (await guest.evaluate(`document.querySelector(".cm-content").contentEditable`)) === "true");
  const peers = await until(host, `document.getElementById("collab-peers").children.length === 2 && document.getElementById("collab-peers").textContent`, "参加者の一覧");
  check("ホストの参加者の一覧に 2 人", true, peers);

  // 両方向の編集
  await typeAtEnd(guest, "\n- 参加者が書いた行");
  await until(host, `${editorText}.includes("参加者が書いた行")`, "参加者の編集がホストに届く");
  check("参加者の編集がホストに届く", true);
  await typeAtEnd(host, "\n- ホストが書いた行");
  await until(guest, `${editorText}.includes("ホストが書いた行")`, "ホストの編集が参加者に届く");
  check("ホストの編集が参加者に届く", true);
  check("ホストのタブは未保存の印", Boolean(await until(host, `document.querySelector(".tab[aria-selected='true'] .tab-dirty") !== null`, "未保存の印")));

  // 名前付きカーソル
  const cursor = await until(host, `document.querySelector(".cm-ySelectionInfo")?.textContent`, "相手の名前付きカーソル", 8000).catch((e) => String(e));
  check("ホストの画面に参加者の名前付きカーソル", cursor === "佐藤", cursor);

  // ホストが保存する
  await host.evaluate(click("#btn-save"));
  await sleep(800);
  const saved = readFileSync(md, "utf8");
  check("ホストが保存するとファイルに両方の編集が入る", saved.includes("参加者が書いた行") && saved.includes("ホストが書いた行"), JSON.stringify(saved));

  // ホストのアプリが落ちたら、参加者は読み取り専用になる
  procs[0].kill();
  await until(guest, `document.querySelector(".cm-content").contentEditable === "false"`, "参加者が読み取り専用", 20000);
  check("ホストがいなくなると参加者は読み取り専用になり、内容は残る", (await guest.evaluate(editorText)).includes("ホストが書いた行"));
} catch (e) {
  check("途中で失敗", false, String(e.message ?? e));
} finally {
  for (const p of procs) p.kill();
  const ng = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - ng} / ${results.length} OK`);
  process.exit(ng ? 1 : 0);
}
