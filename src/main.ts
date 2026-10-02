import { THEME_LABEL, darkQuery, getThemePref, setThemePref, type ThemePref } from "./theme";
import "./styles.css";

import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open as openDialog, save as saveDialog, ask, message } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";

import { renderMarkdown } from "./render";
import { fillCached, renderDiagrams } from "./diagrams";
import { createEditor } from "./editor";
import { findLineElement, setupScrollSync } from "./scrollsync";
import { ACTIVE_LINE_COLOR_KEY, applyActiveLineColor, isActiveLineEnabled } from "./prefs";
import { checkForUpdate, setupUpdater } from "./updater";
import { basename, dirname, hasScheme, isMarkdownPath, resolvePath } from "./paths";

type Mode = "editor" | "split" | "preview";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const main = $("main");
const previewPane = $("preview-pane");
const preview = $("preview");
const banner = $("banner");
const filenameEl = $("filename");
const dropzone = $("dropzone");
const appWindow = getCurrentWindow();


const state = {
  path: null as string | null,
  /** ディスク上の内容（最後に読み込んだ/保存した内容） */
  savedText: "",
  dirty: false,
  mode: (localStorage.getItem("mode") as Mode) || "preview",
  renderGen: 0,
  /** PDF 出力中は図をライトテーマで描く */
  forceLight: false,
};

/** 貼り付けたが未保存の画像。キーは md からの相対パス（本文に書いたもの） */
const pendingImages = new Map<string, { bytes: Uint8Array; url: string }>();

function clearPendingImages() {
  for (const p of pendingImages.values()) URL.revokeObjectURL(p.url);
  pendingImages.clear();
}

// ---------- 描画 ----------

let renderTimer = 0;
function scheduleRender(delay = 150) {
  clearTimeout(renderTimer);
  renderTimer = window.setTimeout(render, delay);
}

/** 入力直後で描画待ちなら、すぐに描画する */
function flushRender() {
  if (!renderTimer) return;
  clearTimeout(renderTimer);
  void render();
}

/** 描画する。戻り値は図の描画が終わるまで待つ Promise */
function render(): Promise<void> {
  renderTimer = 0;
  const gen = ++state.renderGen;
  const dark = darkQuery.matches && !state.forceLight;
  const text = editor.getText();
  const tpl = document.createElement("template");
  tpl.innerHTML = text.trim()
    ? renderMarkdown(text)
    : `<div class="empty-state"><p>Markdown ファイルをドロップするか、<kbd>Ctrl</kbd>+<kbd>O</kbd> で開いてください。</p></div>`;
  rewriteImages(tpl.content);
  fillCached(tpl.content, dark);
  const scroll = previewPane.scrollTop;
  preview.replaceChildren(tpl.content);
  previewPane.scrollTop = scroll;
  return renderDiagrams(preview, dark, () => gen === state.renderGen);
}

/** 相対パスの画像を、開いているファイルの場所を基準に asset URL に変換する */
function rewriteImages(root: ParentNode) {
  const base = state.path ? dirname(state.path) : null;
  for (const img of root.querySelectorAll("img")) {
    const src = img.getAttribute("src");
    if (!src || hasScheme(src) || src.startsWith("//")) continue;
    const pending = pendingImages.get(src);
    if (pending) {
      img.src = pending.url;
      continue;
    }
    if (!base) continue;
    const file = decodeURIComponent(src.split(/[?#]/)[0]);
    img.src = convertFileSrc(resolvePath(base, file));
  }
}

// ---------- エディタ ----------

const IMAGE_DIR = "assets";
const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

/** 貼り付けた画像を保存待ちに登録し、挿入する Markdown を返す */
async function onPasteImage(file: File): Promise<string> {
  const ext = IMAGE_EXT[file.type] ?? "png";
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  let rel = `${IMAGE_DIR}/image-${stamp}.${ext}`;
  for (let i = 2; pendingImages.has(rel); i++) rel = `${IMAGE_DIR}/image-${stamp}-${i}.${ext}`;
  pendingImages.set(rel, { bytes: new Uint8Array(await file.arrayBuffer()), url: URL.createObjectURL(file) });
  return `![](${rel})`;
}

const editor = createEditor(
  $("editor-pane"),
  darkQuery.matches,
  () => {
    setDirty(editor.getText() !== state.savedText);
    scheduleRender();
  },
  onPasteImage,
);
const syncPreviewToEditor = setupScrollSync(editor, previewPane, () => state.mode === "split");

darkQuery.addEventListener("change", () => {
  editor.setDark(darkQuery.matches);
  render();
});

// ---------- 表示モード ----------

function setMode(mode: Mode) {
  const prev = state.mode;
  // 編集モード中はプレビューが幅 0 で位置を保てないので、切替後にカーソル位置へ合わせる
  const cursor =
    prev === "editor" && mode !== "editor"
      ? { line: editor.cursorLine(), offset: editor.cursorOffset() }
      : null;
  state.mode = mode;
  main.dataset.mode = mode;
  localStorage.setItem("mode", mode);
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-mode]")) {
    b.classList.toggle("active", b.dataset.mode === mode);
  }
  clearActiveLine();
  if (mode !== "preview") editor.view.focus();
  if (!cursor) return;
  flushRender();
  requestAnimationFrame(() => {
    if (state.mode !== mode) return;
    if (mode === "split") syncPreviewToEditor();
    else showActiveLine(cursor.line, cursor.offset);
  });
}

/** ソース行 line の要素を、エディタでカーソルがあった高さ（offset）に表示してハイライトする */
function showActiveLine(line: number, offset: number | null) {
  const el = findLineElement(preview, line);
  if (!el) return;
  const paneTop = previewPane.getBoundingClientRect().top;
  const elTop = el.getBoundingClientRect().top - paneTop + previewPane.scrollTop;
  previewPane.scrollTop = elTop - (offset ?? previewPane.clientHeight / 3);
  if (isActiveLineEnabled()) el.classList.add("active-line");
}

function clearActiveLine() {
  for (const el of preview.querySelectorAll(".active-line")) el.classList.remove("active-line");
}

applyActiveLineColor();
window.addEventListener("storage", (e) => {
  if (e.key === ACTIVE_LINE_COLOR_KEY) applyActiveLineColor();
});
for (const b of document.querySelectorAll<HTMLButtonElement>("[data-mode]")) {
  b.addEventListener("click", () => setMode(b.dataset.mode as Mode));
}

// 分割境界のドラッグ
const divider = $("divider");
divider.addEventListener("pointerdown", (e) => {
  divider.setPointerCapture(e.pointerId);
  const rect = main.getBoundingClientRect();
  const move = (ev: PointerEvent) => {
    const ratio = Math.min(0.85, Math.max(0.15, (ev.clientX - rect.left) / rect.width));
    main.style.setProperty("--split", `${ratio * 100}%`);
  };
  const up = () => {
    divider.removeEventListener("pointermove", move);
    localStorage.setItem("split", main.style.getPropertyValue("--split"));
  };
  divider.addEventListener("pointermove", move);
  divider.addEventListener("pointerup", up, { once: true });
});
const savedSplit = localStorage.getItem("split");
if (savedSplit) main.style.setProperty("--split", savedSplit);

// ---------- ズーム ----------
// プレビューとエディタは別々に拡大縮小する（ツールバーは対象外）

type ZoomTarget = "preview" | "editor";
const zoomLabel = $("zoom-label");
const zoom: Record<ZoomTarget, number> = {
  preview: Number(localStorage.getItem("zoom.preview")) || 1,
  editor: Number(localStorage.getItem("zoom.editor")) || 1,
};
let zoomTarget: ZoomTarget = "preview";

function applyZoom() {
  preview.style.zoom = String(zoom.preview);
  $("editor-pane").style.setProperty("--editor-font", `${14 * zoom.editor}px`);
  editor.view.requestMeasure();
  zoomLabel.textContent = `${Math.round(zoom[zoomTarget] * 100)}%`;
  zoomLabel.title = `${zoomTarget === "preview" ? "プレビュー" : "エディタ"}のズーム（Ctrl+ホイール / Ctrl+＋− / クリックで 100%）`;
}

/** delta が null ならリセット */
function changeZoom(target: ZoomTarget, delta: number | null) {
  zoomTarget = target;
  const next = delta === null ? 1 : zoom[target] + delta;
  zoom[target] = Math.round(Math.min(3, Math.max(0.5, next)) * 100) / 100;
  localStorage.setItem(`zoom.${target}`, String(zoom[target]));
  applyZoom();
}

/** キーボード操作の対象: エディタにフォーカスがあればエディタ、なければプレビュー */
const focusedTarget = (): ZoomTarget =>
  state.mode === "editor" || (state.mode === "split" && editor.view.hasFocus) ? "editor" : "preview";

window.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const target: ZoomTarget = $("editor-pane").contains(e.target as Node) ? "editor" : "preview";
    changeZoom(target, e.deltaY < 0 ? 0.1 : -0.1);
  },
  { passive: false },
);
zoomLabel.addEventListener("click", () => changeZoom(zoomTarget, null));
applyZoom();

// ---------- ファイル操作 ----------

function updateTitle() {
  const name = state.path ? basename(state.path) : "無題";
  filenameEl.textContent = `${name}${state.dirty ? " •" : ""}`;
  filenameEl.title = state.path ?? "";
  void appWindow.setTitle(`${name}${state.dirty ? " •" : ""} - Markdown Preview`);
}

function setDirty(dirty: boolean) {
  if (dirty === state.dirty) return;
  state.dirty = dirty;
  updateTitle();
}

async function confirmDiscard(): Promise<boolean> {
  if (!state.dirty) return true;
  return ask("保存されていない変更があります。破棄しますか？", {
    title: "Markdown Preview",
    kind: "warning",
    okLabel: "破棄",
    cancelLabel: "キャンセル",
  });
}

async function showError(err: unknown) {
  await message(String(err), { title: "エラー", kind: "error" });
}

async function openFile(path: string) {
  try {
    const text = await invoke<string>("read_file", { path });
    clearPendingImages();
    state.path = path;
    state.savedText = text;
    state.dirty = false;
    banner.hidden = true;
    editor.setText(text);
    updateTitle();
    // 相対パス画像を読めるよう、描画前に asset スコープを許可しておく（watch_file が行う）
    await invoke("watch_file", { path });
    render();
    previewPane.scrollTop = 0;
  } catch (err) {
    await showError(err);
  }
}

async function openWithPrompt(path?: string) {
  if (!(await confirmDiscard())) return;
  if (!path) {
    const picked = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd", "txt"] }],
    });
    if (typeof picked !== "string") return;
    path = picked;
  }
  await openFile(path);
}

/** 本文で参照されている保存待ち画像を書き出す。書き出した件数を返す */
async function writePendingImages(mdPath: string, text: string): Promise<number> {
  let count = 0;
  for (const [rel, img] of pendingImages) {
    if (!text.includes(`](${rel}`)) continue;
    await invoke("write_asset", img.bytes, {
      headers: { "x-md": encodeURIComponent(mdPath), "x-rel": encodeURIComponent(rel) },
    });
    count++;
  }
  return count;
}

async function saveFile(saveAs = false): Promise<boolean> {
  let path = state.path;
  if (!path || saveAs) {
    const picked = await saveDialog({
      defaultPath: path ?? "untitled.md",
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!picked) return false;
    path = picked;
  }
  const text = editor.getText();
  try {
    // 貼り付けた画像を md と同じ場所の assets/ に書き出す（本文から消したものは捨てる）
    const written = await writePendingImages(path, text);
    await invoke("write_file", { path, content: text });
    const changedPath = path !== state.path;
    state.path = path;
    state.savedText = text;
    state.dirty = false;
    banner.hidden = true;
    updateTitle();
    if (changedPath) await invoke("watch_file", { path });
    if (changedPath || written) {
      // ディスク上のファイルを指すよう描き直してから blob URL を解放する
      const urls = [...pendingImages.values()].map((p) => p.url);
      pendingImages.clear();
      await render();
      urls.forEach((u) => URL.revokeObjectURL(u));
    }
    return true;
  } catch (err) {
    await showError(err);
    return false;
  }
}

async function newFile() {
  if (!(await confirmDiscard())) return;
  clearPendingImages();
  state.path = null;
  state.savedText = "";
  state.dirty = false;
  banner.hidden = true;
  editor.setText("");
  updateTitle();
  render();
  if (state.mode === "preview") setMode("split");
}

/** 外部でファイルが変更されたとき */
async function onExternalChange() {
  if (!state.path) return;
  let disk: string;
  try {
    disk = await invoke<string>("read_file", { path: state.path });
  } catch {
    return; // 保存途中で一時的に読めないことがある
  }
  if (disk === state.savedText) return; // 自分の保存
  if (state.dirty) {
    banner.hidden = false;
    return;
  }
  state.savedText = disk;
  editor.setText(disk);
  render();
}

$("banner-reload").addEventListener("click", () => state.path && openFile(state.path));
$("banner-ignore").addEventListener("click", () => (banner.hidden = true));
$("btn-new").addEventListener("click", () => newFile());
$("btn-open").addEventListener("click", () => openWithPrompt());
$("btn-save").addEventListener("click", () => saveFile());
$("btn-pdf").addEventListener("click", () => previewPdf());
$("btn-help").addEventListener("click", () => openHelp());

/** 書き方ヘルプを別ウィンドウで開く（開いていれば前面に出す） */
async function openHelp() {
  await invoke("open_help").catch(showError);
}

// ---------- テーマ ----------

const themeBtn = $<HTMLButtonElement>("btn-theme");
const THEME_ORDER: ThemePref[] = ["system", "light", "dark"];
function updateThemeButton() {
  const pref = getThemePref();
  themeBtn.textContent = `${pref === "dark" ? "☾" : pref === "light" ? "☀" : "◐"} ${THEME_LABEL[pref]}`;
}
themeBtn.addEventListener("click", async () => {
  const next = THEME_ORDER[(THEME_ORDER.indexOf(getThemePref()) + 1) % THEME_ORDER.length];
  await setThemePref(next);
  updateThemeButton();
});
window.addEventListener("storage", (e) => e.key === "theme" && updateThemeButton());
updateThemeButton();

// ---------- バージョンアップ ----------
// 起動時に自動確認（ヘルプで切り替え可）。ヘルプの「更新を確認」からも呼ばれる
setupUpdater(confirmDiscard);
void listen("check-update", async () => {
  await appWindow.setFocus();
  await checkForUpdate(true);
});

// ヘルプの「エディタに挿入」
void listen<string>("insert-snippet", async (e) => {
  if (state.mode === "preview") setMode("split");
  editor.insert(e.payload);
  await appWindow.setFocus();
});

// ---------- PDF（プレビュー → 保存） ----------

const pdfOverlay = $("pdf-preview");
const pdfFrame = $<HTMLIFrameElement>("pdf-frame");

/** PDF を一時ファイルに作ってプレビュー表示する（ダークモードでも白地・ライト配色） */
async function previewPdf() {
  const btn = $<HTMLButtonElement>("btn-pdf");
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = "作成中…";
  try {
    if (darkQuery.matches) {
      state.forceLight = true;
      await render();
    }
    const tmp = await invoke<string>("preview_pdf");
    pdfFrame.src = convertFileSrc(tmp);
    pdfOverlay.hidden = false;
    $("pdf-save").focus();
  } catch (err) {
    await showError(err);
  } finally {
    btn.disabled = false;
    btn.textContent = "PDF";
    if (state.forceLight) {
      state.forceLight = false;
      void render();
    }
  }
}

function closePdfPreview() {
  pdfOverlay.hidden = true;
  pdfFrame.src = "about:blank";
}

async function savePdf() {
  const base = state.path ? state.path.replace(/\.[^.\\/]+$/, "") : "untitled";
  const path = await saveDialog({
    defaultPath: `${base}.pdf`,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!path) return;
  try {
    await invoke("save_preview_pdf", { path });
    closePdfPreview();
    await revealItemInDir(path).catch(() => undefined);
  } catch (err) {
    await showError(err);
  }
}

$("pdf-save").addEventListener("click", () => savePdf());
$("pdf-close").addEventListener("click", () => closePdfPreview());

// ---------- リンク ----------

preview.addEventListener("click", async (e) => {
  const a = (e.target as Element).closest("a");
  if (!a) return;
  const href = a.getAttribute("href") ?? a.getAttribute("xlink:href");
  e.preventDefault();
  if (!href) return;
  if (href.startsWith("#")) {
    const id = decodeURIComponent(href.slice(1));
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (/^(https?|mailto):/i.test(href)) {
    await openUrl(href);
    return;
  }
  if (hasScheme(href) || !state.path) return;
  const target = resolvePath(dirname(state.path), decodeURIComponent(href.split("#")[0]));
  if (isMarkdownPath(target)) await openWithPrompt(target);
  else await revealItemInDir(target).catch(showError);
});

// ---------- キーボード ----------

window.addEventListener(
  "keydown",
  (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    const run = (fn: () => unknown) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    };
    if (!pdfOverlay.hidden && e.key === "Escape") run(() => closePdfPreview());
    else if (!pdfOverlay.hidden && mod && key === "s") run(() => savePdf());
    else if (mod && key === "s") run(() => saveFile(e.shiftKey));
    else if (mod && key === "o") run(() => openWithPrompt());
    else if (mod && key === "n") run(() => newFile());
    else if (mod && key === "p") run(() => previewPdf());
    else if (e.key === "F1") run(() => openHelp());
    // JIS 配列では「+」が Shift+; なので ; も拡大として扱う
    else if (mod && ["+", "=", ";"].includes(e.key)) run(() => changeZoom(focusedTarget(), 0.1));
    else if (mod && ["-", "_"].includes(e.key)) run(() => changeZoom(focusedTarget(), -0.1));
    else if (mod && e.key === "0") run(() => changeZoom(focusedTarget(), null));
    else if (mod && e.key === "1") run(() => setMode("editor"));
    else if (mod && e.key === "2") run(() => setMode("split"));
    else if (mod && e.key === "3") run(() => setMode("preview"));
    // WebView のリロードで編集内容が消えないよう、F5 はファイルの再読み込みにする
    else if (e.key === "F5" || (mod && key === "r"))
      run(() => (state.path ? openWithPrompt(state.path) : undefined));
  },
  { capture: true },
);

// ---------- 起動・ウィンドウイベント ----------

void getCurrentWebview().onDragDropEvent((e) => {
  const p = e.payload;
  if (p.type === "enter" || p.type === "over") dropzone.hidden = false;
  else if (p.type === "leave") dropzone.hidden = true;
  else if (p.type === "drop") {
    dropzone.hidden = true;
    // Markdown（とテキスト）以外は開かない。画像などをテキストとして開いて文字化けさせないため
    const file = p.paths.find((f) => isMarkdownPath(f) || /\.txt$/i.test(f));
    if (file) void openWithPrompt(file);
    else if (p.paths.length) void message("Markdown ファイル（.md など）をドロップしてください。", { kind: "info" });
  }
});

void listen<string>("file-changed", () => onExternalChange());
void listen<string>("open-file", (e) => openWithPrompt(e.payload));

void appWindow.onCloseRequested(async (e) => {
  if (!(await confirmDiscard())) {
    e.preventDefault();
    return;
  }
  // ヘルプが残るとアプリが終了しないので一緒に閉じる
  await (await WebviewWindow.getByLabel("help"))?.destroy();
});

setMode(state.mode);
updateTitle();
render();
void invoke<string | null>("initial_file").then((p) => {
  if (p) void openFile(p);
});
