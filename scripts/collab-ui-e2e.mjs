// 共同編集の画面の通しの確認。ホストと参加者のアプリを起動し、WebView2 のデバッグポート（CDP）で画面を操作する。
// 先に次を動かしておく：relay で `npm run dev -- --port 8787 --ip 127.0.0.1`、ルートで `npm run dev`、
// src-tauri と collab-plugin で `cargo build`。実行は `node scripts/collab-ui-e2e.mjs`
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
const TMP = `${tmpdir()}/mdp-collab-ui-e2e`;
// CARGO_TARGET_DIR を決めていれば、ビルドはそこに出る
const TARGET = process.env.CARGO_TARGET_DIR?.replace(/\\/g, "/");
const EXE = `${TARGET ?? `${ROOT}/src-tauri/target`}/debug/markdown-preview.exe`;
const PLUGIN = `${TARGET ?? `${ROOT}/collab-plugin/target`}/debug/markdown-preview-collab.exe`;
const RELAY = "http://127.0.0.1:8787";

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const md = `${TMP}/議事録.md`;
// ホストのディスクにもともとある画像（参加者には、求めるとホストから届く）
mkdirSync(`${TMP}/img`, { recursive: true });
writeFileSync(`${TMP}/img/図 1.png`, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
writeFileSync(md, "# 議事録\n\n- 最初の行\n\n![](img/図%201.png)\n");

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

/** Ctrl+キーを押す（メニューはネイティブなので、ショートカットで操作する） */
async function ctrlKey(app, key, code, vk) {
  await app.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk, modifiers: 2 });
  await app.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, modifiers: 2 });
}

/** 共同編集の画面を出す（「ツール → 共同編集…」はネイティブのメニューで CDP から押せないため、直接開く） */
const openCollab = `(() => { document.getElementById("collab").hidden = false; return true })()`;

/** 1×1 の PNG をクリップボードから貼り付けたことにする */
const pastePng = `(() => {
  const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], "image.png", { type: "image/png" }));
  const el = document.querySelector(".cm-content");
  el.focus();
  el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  return true;
})()`;

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
    await until(app, `document.querySelector(".cm-content") !== null`, "画面が出る");
    await app.evaluate(click(`[data-mode="split"]`));
  }

  // 中継サーバーを設定する（設定画面。プラグインがあるときだけ「共同編集」の欄が出る）
  for (const app of [host, guest]) {
    await ctrlKey(app, ",", "Comma", 188);
    await until(app, `!document.getElementById("settings-collab").hidden`, "設定に共同編集の欄");
    await app.evaluate(setValue("set-relay", RELAY));
    await app.evaluate(click("#set-relay-save"));
    await until(app, `document.getElementById("set-relay-status").textContent.includes("保存しました")`, "中継サーバーを保存");
    await app.evaluate(click("#settings-close"));
  }
  check("プラグインがあると設定に共同編集の欄が出る", true);
  check("設定で中継サーバーの URL を保存できる", true, readFileSync(`${TMP}/host-collab.json`, "utf8").replace(/\s+/g, " "));

  // ホストが始める
  await until(host, `${editorText}.includes("最初の行")`, "ホストがファイルを開いている");
  await host.evaluate(openCollab);
  await host.evaluate(setValue("collab-name", "土屋"));
  await host.evaluate(click("#collab-start"));
  const invite = await until(host, `document.getElementById("collab-invite-out").value`, "招待リンクが出る");
  check("ホストが始めると招待リンクが出る", /^http:\/\/127\.0\.0\.1:8787\/r\/[A-Za-z0-9_-]{22}#k=/.test(invite), invite.replace(/#k=.*/, "#k=…"));
  check("ホストのタブに共同編集の印", Boolean(await until(host, `document.querySelector(".tab .tab-collab") !== null`, "タブの印")));

  // 参加者が参加を求める
  await guest.evaluate(openCollab);
  await guest.evaluate(setValue("collab-name", "佐藤"));
  await guest.evaluate(setValue("collab-invite-in", invite));
  await guest.evaluate(click("#collab-join"));
  await until(guest, `document.getElementById("collab-state").textContent.includes("承認を待って")`, "参加者が承認待ち");
  check("参加者は承認待ちになり、書けない", (await guest.evaluate(`document.querySelector(".cm-content").contentEditable`)) === "false");

  // ホストが承認する
  const req = await until(host, `document.querySelector(".collab-request span")?.textContent`, "参加の要求のモーダル");
  check("ホストに参加の要求が出る", req.includes("佐藤"), req);
  await host.evaluate(click(".collab-request button.primary"));
  await until(guest, `${editorText}.includes("最初の行")`, "参加者にホストの内容が届く");
  check("承認されると参加者にホストの内容が届く", true);
  check("参加者のタブ名はホストのファイル名（共同編集）", (await until(guest, `document.querySelector(".tab[aria-selected='true'] .tab-name").textContent`, "タブ名")).includes("議事録.md（共同編集）"));
  const diskImg = await until(guest, `[...document.querySelectorAll("#preview img")].find((i) => i.src.startsWith("blob:") && i.naturalWidth === 1)?.src`, "参加者のプレビューにホストのディスクの画像");
  check("ホストのディスクにある画像が参加者のプレビューに出る", Boolean(diskImg));
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

  // 参加者が画像を貼り付ける
  await guest.evaluate(`document.getElementById("collab").hidden = true, true`);
  await typeAtEnd(guest, "\n");
  await guest.evaluate(pastePng);
  const link = await until(guest, `(${editorText}.match(/!\\[\\]\\(([^)]*image-[^)]*-p\\d+\\.png)\\)/) ?? [])[1]`, "参加者のエディタに画像のリンク");
  check("参加者が画像を貼り付けられる", true, link);
  const hostImg = await until(host, `[...document.querySelectorAll("#preview img")].find((i) => i.src.startsWith("blob:") && i.naturalWidth === 1)?.src`, "ホストのプレビューに画像");
  check("参加者が貼った画像がホストのプレビューに出る", Boolean(hostImg));

  // ホストが保存する
  await host.evaluate(`document.querySelector(".cm-content").focus(), true`);
  await ctrlKey(host, "s", "KeyS", 83);
  await sleep(800);
  const saved = readFileSync(md, "utf8");
  check("ホストが保存するとファイルに両方の編集が入る", saved.includes("参加者が書いた行") && saved.includes("ホストが書いた行"), JSON.stringify(saved));
  const assets = `${TMP}/議事録.assets`;
  const written = existsSync(assets) ? readdirSync(assets) : [];
  check("参加者が貼った画像がホストの .assets に書き出される", written.some((f) => /-p\d+\.png$/.test(f)), written.join(", "));

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
