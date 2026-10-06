import { THEME_LABEL, darkQuery, getThemePref, setThemePref, type ThemePref } from "./theme";
import "./styles.css";

import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getVersion } from "@tauri-apps/api/app";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open as openDialog, save as saveDialog, ask, message } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";

import { renderMarkdown } from "./render";
import { fillCached, renderDiagrams } from "./diagrams";
import type { EditorState } from "@codemirror/state";
import { createEditor } from "./editor";
import { loadSession, saveSession } from "./session";
import { setupBuilder } from "./builder/builder";
import { findLineElement, setupScrollSync } from "./scrollsync";
import {
  applyActiveLineColor,
  getActiveLineColor,
  isActiveLineEnabled,
  setActiveLineColor,
  setActiveLineEnabled,
} from "./prefs";
import { checkForUpdate, isAutoCheckEnabled, isKeepDraftEnabled, setAutoCheck, setKeepDraft, setupUpdater } from "./updater";
import { basename, dirname, hasScheme, isMarkdownPath, resolvePath } from "./paths";

type Mode = "editor" | "split" | "preview";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const main = $("main");
const previewPane = $("preview-pane");
const preview = $("preview");
const banner = $("banner");
const tabBar = $("tabs");
const dropzone = $("dropzone");
const appWindow = getCurrentWindow();

const state = {
  mode: (localStorage.getItem("mode") as Mode) || "preview",
  renderGen: 0,
  /** PDF 出力中は図をライトテーマで描く */
  forceLight: false,
  /** 更新のダウンロード中は編集もファイルの切り替えもさせない（退避した内容とずれるため） */
  updating: false,
};

type PendingImage = { bytes: Uint8Array; url: string };

/** 開いているファイル 1 つ分 */
interface Tab {
  id: number;
  path: string | null;
  /** ディスク上の内容（最後に読み込んだ/保存した内容） */
  savedText: string;
  dirty: boolean;
  /** 裏にいる間の編集状態（Undo 履歴・カーソル込み）。表示中のタブはエディタが持つ */
  doc: EditorState;
  /** 貼り付けたが未保存の画像。キーは md からの相対パス（本文に書いたもの） */
  pendingImages: Map<string, PendingImage>;
  previewScroll: number;
  editorScroll: number;
  /** 編集中に外部でファイルが変更された（表示時にバナーを出す） */
  externalChange: boolean;
}

let nextTabId = 1;
const tabs: Tab[] = [];
/** 表示中のタブ（起動直後に必ず 1 つ作る） */
let active: Tab;

function clearPendingImages(tab: Tab) {
  for (const p of tab.pendingImages.values()) URL.revokeObjectURL(p.url);
  tab.pendingImages.clear();
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
  markCursorLine();
  return renderDiagrams(preview, dark, () => gen === state.renderGen);
}

/** 相対パスの画像を、開いているファイルの場所を基準に asset URL に変換する */
function rewriteImages(root: ParentNode) {
  const base = active.path ? dirname(active.path) : null;
  for (const img of root.querySelectorAll("img")) {
    const src = img.getAttribute("src");
    if (!src || hasScheme(src) || src.startsWith("//")) continue;
    const pending = active.pendingImages.get(src);
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
  const pendingImages = active.pendingImages;
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
    setDirty(active, editor.getText() !== active.savedText);
    scheduleRender();
  },
  onPasteImage,
  () => markCursorLine(),
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
  markCursorLine();
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

/** 分割表示では、エディタのカーソルがある箇所をプレビューで色付けする（それ以外は色付けを消す） */
function markCursorLine() {
  clearActiveLine();
  if (state.mode !== "split" || !isActiveLineEnabled()) return;
  findLineElement(preview, editor.cursorLine())?.classList.add("active-line");
}

applyActiveLineColor();
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

// ---------- タブ ----------

const tabName = (tab: Tab) => (tab.path ? basename(tab.path) : "無題");
/** Windows のパスは大文字小文字と区切り文字の違いを同じとみなす */
const samePath = (a: string, b: string) => a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();
/** タブの本文（表示中のタブはエディタが持っている） */
const textOf = (tab: Tab) => (tab === active ? editor.getText() : tab.doc.doc.toString());
/** 空の「無題」で未編集のタブ（ファイルを開くときに使い回す） */
const isBlank = (tab: Tab) => !tab.path && !tab.dirty && textOf(tab) === "" && !tab.pendingImages.size;

function makeTab(path: string | null, text: string): Tab {
  return {
    id: nextTabId++,
    path,
    savedText: text,
    dirty: false,
    doc: editor.createState(text),
    pendingImages: new Map(),
    previewScroll: 0,
    editorScroll: 0,
    externalChange: false,
  };
}

/** 起動時の復元が終わるまでは、前回のタブの記録を上書きしない */
let sessionReady = false;
function persistSession() {
  if (!sessionReady) return;
  const files = tabs.filter((t) => t.path);
  saveSession({ paths: files.map((t) => t.path!), active: files.indexOf(active) });
}

const newTabButton = document.createElement("button");
newTabButton.className = "tab-new";
newTabButton.textContent = "＋";
newTabButton.title = "新しいタブ (Ctrl+N)";

function updateTitle() {
  void appWindow.setTitle(`${tabName(active)}${active.dirty ? " •" : ""} - Markdown Preview`);
  // 無題（まだ保存していない）ならパスがないのでコピーできない
  copyPathBtn.disabled = !active.path;
}

const copyPathBtn = $<HTMLButtonElement>("btn-copy-path");
/** 表示中のタブのファイルのパスをクリップボードにコピーする */
async function copyPath() {
  if (!active.path) return;
  try {
    await navigator.clipboard.writeText(active.path);
    const label = "パスをコピー";
    copyPathBtn.textContent = "コピーしました";
    setTimeout(() => (copyPathBtn.textContent = label), 1500);
  } catch (err) {
    await showError(err);
  }
}
copyPathBtn.addEventListener("click", () => copyPath());

function renderTabs() {
  tabBar.replaceChildren(
    ...tabs.map((tab) => {
      const el = document.createElement("div");
      el.className = "tab";
      el.setAttribute("role", "tab");
      el.setAttribute("aria-selected", String(tab === active));
      el.dataset.id = String(tab.id);
      el.title = tab.path ?? "無題（未保存）";
      const name = document.createElement("span");
      name.className = "tab-name";
      name.textContent = tabName(tab);
      el.append(name);
      if (tab.dirty) {
        const dot = document.createElement("span");
        dot.className = "tab-dirty";
        dot.textContent = "•";
        dot.title = "未保存";
        el.append(dot);
      }
      const close = document.createElement("button");
      close.className = "tab-close";
      close.textContent = "×";
      close.title = "閉じる (Ctrl+W)";
      close.tabIndex = -1;
      el.append(close);
      return el;
    }),
    newTabButton,
  );
  tabBar.querySelector(".tab[aria-selected='true']")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  updateTitle();
  persistSession();
}

const tabOf = (el: Element) => tabs.find((t) => String(t.id) === el.closest<HTMLElement>(".tab")?.dataset.id);

tabBar.addEventListener("click", (e) => {
  const target = e.target as Element;
  if (target.closest(".tab-new")) return void newFile();
  const tab = tabOf(target);
  if (!tab) return;
  if (target.closest(".tab-close")) void closeTab(tab);
  else activate(tab);
});
// 中クリックで閉じる（自動スクロールが始まらないよう mousedown も止める）
tabBar.addEventListener("mousedown", (e) => e.button === 1 && e.preventDefault());
tabBar.addEventListener("auxclick", (e) => {
  const tab = e.button === 1 ? tabOf(e.target as Element) : undefined;
  if (tab) void closeTab(tab);
});

/** タブを表示する。今のタブの編集状態とスクロール位置を退避してから切り替える */
function activate(tab: Tab) {
  if (tab === active) return;
  if (active && tabs.includes(active)) {
    active.doc = editor.getState();
    active.previewScroll = previewPane.scrollTop;
    active.editorScroll = editor.view.scrollDOM.scrollTop;
  }
  active = tab;
  editor.setState(tab.doc);
  banner.hidden = !tab.externalChange;
  renderTabs();
  void render();
  previewPane.scrollTop = tab.previewScroll;
  editor.view.scrollDOM.scrollTop = tab.editorScroll;
  if (state.mode !== "preview") editor.view.focus();
}

/** 今のタブの右隣に追加して表示する */
function addTab(tab: Tab) {
  const i = tabs.indexOf(active);
  tabs.splice(i < 0 ? tabs.length : i + 1, 0, tab);
  activate(tab);
}

function cycleTab(delta: number) {
  const i = tabs.indexOf(active);
  activate(tabs[(i + delta + tabs.length) % tabs.length]);
}

function setDirty(tab: Tab, dirty: boolean) {
  if (dirty === tab.dirty) return;
  tab.dirty = dirty;
  renderTabs();
}

/** タブの本文を差し替える（Undo で戻せる。変更扱いにはしない） */
function setTabText(tab: Tab, text: string) {
  if (tab === active) editor.setText(text);
  else tab.doc = tab.doc.update({ changes: { from: 0, to: tab.doc.doc.length, insert: text } }).state;
}

async function confirmDiscard(tab: Tab): Promise<boolean> {
  if (!tab.dirty) return true;
  return ask(`「${tabName(tab)}」の保存されていない変更を破棄しますか？`, {
    title: "Markdown Preview",
    kind: "warning",
    okLabel: "破棄",
    cancelLabel: "キャンセル",
  });
}

async function showError(err: unknown) {
  await message(String(err), { title: "エラー", kind: "error" });
}

/**
 * ファイルをタブで開く。開いていればそのタブへ、今のタブが空の無題ならそのタブで、それ以外は新しいタブで開く。
 * 開けたら true。quiet なら開けなくてもエラーを出さない（前回のタブの復元で、消えたファイルを飛ばすため）
 */
async function openInTab(path: string, quiet = false): Promise<boolean> {
  if (state.updating) return false;
  const opened = () => tabs.find((t) => t.path && samePath(t.path, path));
  if (opened()) {
    activate(opened()!);
    return true;
  }
  let text: string;
  try {
    text = await invoke<string>("read_file", { path });
    // 相対パス画像を読めるよう、描画前に asset スコープを許可しておく（watch_file が行う）
    await invoke("watch_file", { path });
  } catch (err) {
    if (!quiet) await showError(err);
    return false;
  }
  if (opened()) {
    activate(opened()!);
    return true;
  }
  if (isBlank(active)) {
    active.path = path;
    active.savedText = text;
    active.doc = editor.createState(text);
    editor.setState(active.doc);
    banner.hidden = true;
    renderTabs();
    void render();
    previewPane.scrollTop = 0;
  } else {
    addTab(makeTab(path, text));
  }
  return true;
}

async function openWithPrompt() {
  if (state.updating) return;
  const picked = await openDialog({
    multiple: true,
    directory: false,
    filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd", "txt"] }],
  });
  if (!picked) return;
  for (const path of Array.isArray(picked) ? picked : [picked]) await openInTab(path);
}

/** ディスクから読み直す。force なら未保存の変更を確認せずに捨てる（バナーの「再読み込み」） */
async function reloadTab(tab: Tab, force = false) {
  if (state.updating || !tab.path || (!force && !(await confirmDiscard(tab)))) return;
  let text: string;
  try {
    text = await invoke<string>("read_file", { path: tab.path });
  } catch (err) {
    await showError(err);
    return;
  }
  clearPendingImages(tab);
  tab.savedText = text;
  tab.dirty = false;
  tab.externalChange = false;
  setTabText(tab, text);
  if (tab === active) {
    banner.hidden = true;
    void render();
  }
  renderTabs();
}

async function closeTab(tab: Tab) {
  if (state.updating || !(await confirmDiscard(tab))) return;
  const i = tabs.indexOf(tab);
  if (i < 0) return;
  tabs.splice(i, 1);
  clearPendingImages(tab);
  if (tab.path && !tabs.some((t) => t.path && samePath(t.path, tab.path!))) {
    void invoke("unwatch_file", { path: tab.path }).catch(() => {});
  }
  // 最後のタブを閉じたら空の無題タブにする
  if (!tabs.length) tabs.push(makeTab(null, ""));
  if (tab === active) activate(tabs[Math.min(i, tabs.length - 1)]);
  else renderTabs();
}

/** 本文で参照されている保存待ち画像を書き出す。書き出した件数を返す */
async function writePendingImages(tab: Tab, mdPath: string, text: string): Promise<number> {
  let count = 0;
  for (const [rel, img] of tab.pendingImages) {
    if (!text.includes(`](${rel}`)) continue;
    await invoke("write_asset", img.bytes, {
      headers: { "x-md": encodeURIComponent(mdPath), "x-rel": encodeURIComponent(rel) },
    });
    count++;
  }
  return count;
}

/** 表示中のタブを保存する */
async function saveFile(saveAs = false): Promise<boolean> {
  const tab = active;
  const oldPath = tab.path;
  let path = oldPath;
  if (!path || saveAs) {
    const picked = await saveDialog({
      defaultPath: path ?? "untitled.md",
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!picked) return false;
    path = picked;
  }
  const text = textOf(tab);
  try {
    // 貼り付けた画像を md と同じ場所の assets/ に書き出す（本文から消したものは捨てる）
    const written = await writePendingImages(tab, path, text);
    await invoke("write_file", { path, content: text });
    const changedPath = !oldPath || !samePath(path, oldPath);
    tab.path = path;
    tab.savedText = text;
    tab.dirty = false;
    tab.externalChange = false;
    if (tab === active) banner.hidden = true;
    renderTabs();
    if (changedPath) {
      await invoke("watch_file", { path });
      if (oldPath && !tabs.some((t) => t.path && samePath(t.path, oldPath))) {
        void invoke("unwatch_file", { path: oldPath }).catch(() => {});
      }
    }
    if (changedPath || written) {
      // ディスク上のファイルを指すよう描き直してから blob URL を解放する
      const urls = [...tab.pendingImages.values()].map((p) => p.url);
      tab.pendingImages.clear();
      if (tab === active) await render();
      urls.forEach((u) => URL.revokeObjectURL(u));
    }
    return true;
  } catch (err) {
    await showError(err);
    return false;
  }
}

/** 空の「無題」タブを開く（今のタブが空の無題ならそれを使う） */
async function newFile() {
  if (state.updating) return;
  if (!isBlank(active)) addTab(makeTab(null, ""));
  if (state.mode === "preview") setMode("split");
  else editor.view.focus();
}

/** 外部でファイルが変更されたとき（そのファイルを開いているタブだけが対象） */
async function onExternalChange(path: string) {
  for (const tab of tabs.filter((t) => t.path && samePath(t.path, path))) {
    let disk: string;
    try {
      disk = await invoke<string>("read_file", { path: tab.path });
    } catch {
      continue; // 保存途中で一時的に読めないことがある
    }
    if (disk === tab.savedText) continue; // 自分の保存
    if (tab.dirty) {
      tab.externalChange = true;
      if (tab === active) banner.hidden = false;
      continue;
    }
    tab.savedText = disk;
    setTabText(tab, disk);
    if (tab === active) void render();
  }
}

$("banner-reload").addEventListener("click", () => reloadTab(active, true));
$("banner-ignore").addEventListener("click", () => {
  active.externalChange = false;
  banner.hidden = true;
});
$("btn-new").addEventListener("click", () => newFile());
$("btn-open").addEventListener("click", () => openWithPrompt());
$("btn-save").addEventListener("click", () => saveFile());
$("btn-pdf").addEventListener("click", () => previewPdf());
$("btn-settings").addEventListener("click", () => openSettings());
$("btn-help").addEventListener("click", () => openHelp());

// 図のビルダー（C4 図をフォームで作る・カーソル位置の図を直す）
const builder = setupBuilder({
  editor,
  isDark: () => darkQuery.matches,
  canEdit: () => !state.updating,
  onApplied: () => state.mode === "preview" && setMode("split"),
});
$("btn-builder").addEventListener("click", () => builder.open());

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

// ---------- 設定 ----------
// 設定は localStorage に保存する。storage イベントは同じウィンドウでは発火しないので、
// 変更したらここで直接反映する（ヘルプウィンドウはテーマだけ storage イベントで追従）

const settingsOverlay = $("settings");
const setTheme = $<HTMLSelectElement>("set-theme");
const activeLine = $<HTMLInputElement>("active-line");
const activeLineColor = $<HTMLInputElement>("active-line-color");
const autoUpdate = $<HTMLInputElement>("auto-update");
const keepDraft = $<HTMLInputElement>("keep-draft");

/** 設定画面を開く（開くたびに現在の値を読み直す） */
function openSettings() {
  setTheme.value = getThemePref();
  activeLine.checked = isActiveLineEnabled();
  activeLineColor.value = getActiveLineColor();
  autoUpdate.checked = isAutoCheckEnabled();
  keepDraft.checked = isKeepDraftEnabled();
  settingsOverlay.hidden = false;
  $("settings-close").focus();
}

function closeSettings() {
  settingsOverlay.hidden = true;
}

void getVersion().then((v) => ($("app-version").textContent = `Markdown Preview v${v}`));
$("settings-close").addEventListener("click", () => closeSettings());
// パネルの外（背景）をクリックしたら閉じる
settingsOverlay.addEventListener("click", (e) => e.target === settingsOverlay && closeSettings());
setTheme.addEventListener("change", async () => {
  await setThemePref(setTheme.value as ThemePref);
  updateThemeButton();
});
activeLine.addEventListener("change", () => {
  setActiveLineEnabled(activeLine.checked);
  markCursorLine();
});
activeLineColor.addEventListener("input", () => {
  setActiveLineColor(activeLineColor.value);
  applyActiveLineColor();
});
$("active-line-reset").addEventListener("click", () => {
  setActiveLineColor(null);
  activeLineColor.value = getActiveLineColor();
  applyActiveLineColor();
});
autoUpdate.addEventListener("change", () => setAutoCheck(autoUpdate.checked));
keepDraft.addEventListener("change", () => setKeepDraft(keepDraft.checked));
// 確認結果のバナーやダイアログが見えるよう、先に設定画面を閉じる
$("btn-check-update").addEventListener("click", () => {
  closeSettings();
  void checkForUpdate(true);
});

// ---------- バージョンアップ ----------
// 起動時に自動確認（設定で切り替え可）。設定の「更新を確認」からも呼ばれる。
// 更新するとアプリは終了してインストール後に再起動されるので、開いていたファイルと
// （設定がオンなら）未保存の変更を退避し、再起動後に復元する

const DRAFT_KEY = "update.draft";

interface DraftTab {
  path: string | null;
  /** 未保存の本文。変更がない、または破棄する設定なら null */
  text: string | null;
}

interface Draft {
  tabs: DraftTab[];
  /** 表示していたタブの tabs 内の位置 */
  active: number;
}

/** 本文で参照されている、保存待ちの貼り付け画像があるか */
const hasUnsavedImages = (tab: Tab) => {
  const text = textOf(tab);
  return [...tab.pendingImages.keys()].some((rel) => text.includes(`](${rel}`));
};

async function beforeUpdate(): Promise<boolean> {
  const dirty = tabs.filter((t) => t.dirty);
  if (!dirty.length) return true;
  if (!isKeepDraftEnabled()) {
    return ask(`未保存のタブが ${dirty.length} 個あります。変更を破棄して更新しますか？`, {
      title: "Markdown Preview",
      kind: "warning",
      okLabel: "破棄して更新",
      cancelLabel: "キャンセル",
    });
  }
  // 貼り付けた画像はメモリにしかなく持ち越せないので、先に保存してもらう
  const withImages = dirty.filter(hasUnsavedImages);
  if (!withImages.length) return true;
  const ok = await ask("貼り付けた画像が保存されていません。保存してから更新しますか？", {
    title: "Markdown Preview",
    kind: "warning",
    okLabel: "保存して更新",
    cancelLabel: "キャンセル",
  });
  if (!ok) return false;
  for (const tab of withImages) {
    activate(tab);
    if (!(await saveFile())) return false;
  }
  return true;
}

function startUpdate() {
  state.updating = true;
  editor.setReadOnly(true);
  const keep = isKeepDraftEnabled();
  // 無題で中身のないタブは持ち越さない
  const saved = tabs
    .map((t) => ({ tab: t, path: t.path, text: t.dirty && keep ? textOf(t) : null }))
    .filter((d) => d.path || d.text != null);
  const draft: Draft = {
    tabs: saved.map(({ path, text }) => ({ path, text })),
    active: saved.findIndex((d) => d.tab === active),
  };
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    throw new Error("未保存の変更を退避できませんでした。保存してから更新してください。");
  }
}

function endUpdate() {
  state.updating = false;
  editor.setReadOnly(false);
  localStorage.removeItem(DRAFT_KEY);
}

/** 退避した内容を読む。v1.1.11 以前の 1 ファイル形式 { path, text } も読む */
function readDraft(): Draft | null {
  const raw = localStorage.getItem(DRAFT_KEY);
  localStorage.removeItem(DRAFT_KEY);
  try {
    const d = raw ? JSON.parse(raw) : null;
    if (d && Array.isArray(d.tabs)) return { tabs: d.tabs, active: Number(d.active) || 0 };
    if (d && "path" in d) return { tabs: [{ path: d.path ?? null, text: d.text ?? null }], active: 0 };
  } catch {
    // 壊れていれば捨てる
  }
  return null;
}

/** 更新前に退避したタブと未保存の変更を戻す。戻したら true */
async function restoreDraft(): Promise<boolean> {
  const draft = readDraft();
  if (!draft?.tabs.length) return false;
  const restored: (Tab | null)[] = [];
  let changed = false;
  for (const d of draft.tabs) {
    // ファイルが消えていて開けなければ、無題の文書として本文だけ戻す
    const ok = d.path ? await openInTab(d.path, true) : false;
    if (!ok) {
      if (d.text == null) {
        restored.push(null);
        continue;
      }
      if (!isBlank(active)) addTab(makeTab(null, ""));
    }
    if (d.text != null) {
      setTabText(active, d.text);
      setDirty(active, d.text !== active.savedText);
      changed ||= active.dirty;
    }
    restored.push(active);
  }
  const target = restored[draft.active];
  if (target) activate(target);
  await render();
  if (changed) {
    await message("更新前の未保存の変更を復元しました（まだ保存されていません）。", {
      title: "Markdown Preview",
      kind: "info",
    });
  }
  return restored.some(Boolean);
}

setupUpdater({ beforeInstall: beforeUpdate, onStart: startUpdate, onEnd: endUpdate });

// ヘルプの「エディタに挿入」
void listen<string>("insert-snippet", async (e) => {
  if (state.updating) return;
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
  const base = active.path ? active.path.replace(/\.[^.\\/]+$/, "") : "untitled";
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
  if (hasScheme(href) || !active.path) return;
  const target = resolvePath(dirname(active.path), decodeURIComponent(href.split("#")[0]));
  if (isMarkdownPath(target)) await openInTab(target);
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
    // 図のビルダーを開いている間は、入力欄にキーを渡す（Esc で閉じるだけ）
    if (builder.isOpen()) {
      if (e.key === "Escape") run(() => builder.close());
      return;
    }
    if (!pdfOverlay.hidden && e.key === "Escape") run(() => closePdfPreview());
    else if (mod && e.shiftKey && key === "d") run(() => builder.open());
    else if (mod && e.shiftKey && key === "c") run(() => copyPath());
    else if (!settingsOverlay.hidden && e.key === "Escape") run(() => closeSettings());
    else if (!pdfOverlay.hidden && mod && key === "s") run(() => savePdf());
    else if (mod && key === "s") run(() => saveFile(e.shiftKey));
    else if (mod && key === "o") run(() => openWithPrompt());
    else if (mod && key === "n") run(() => newFile());
    else if (mod && key === "p") run(() => previewPdf());
    else if (e.key === "F1") run(() => openHelp());
    else if (mod && e.key === ",") run(() => openSettings());
    // JIS 配列では「+」が Shift+; なので ; も拡大として扱う
    else if (mod && ["+", "=", ";"].includes(e.key)) run(() => changeZoom(focusedTarget(), 0.1));
    else if (mod && ["-", "_"].includes(e.key)) run(() => changeZoom(focusedTarget(), -0.1));
    else if (mod && e.key === "0") run(() => changeZoom(focusedTarget(), null));
    else if (mod && e.key === "1") run(() => setMode("editor"));
    else if (mod && e.key === "2") run(() => setMode("split"));
    else if (mod && e.key === "3") run(() => setMode("preview"));
    // WebView のリロードで編集内容が消えないよう、F5 はファイルの再読み込みにする
    else if (e.key === "F5" || (mod && key === "r")) run(() => reloadTab(active));
    // タブ
    else if (mod && key === "w") run(() => closeTab(active));
    else if (mod && e.key === "Tab") run(() => cycleTab(e.shiftKey ? -1 : 1));
    else if (mod && e.key === "PageDown") run(() => cycleTab(1));
    else if (mod && e.key === "PageUp") run(() => cycleTab(-1));
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
    const files = p.paths.filter((f) => isMarkdownPath(f) || /\.txt$/i.test(f));
    if (files.length) void openDropped(files);
    else if (p.paths.length) void message("Markdown ファイル（.md など）をドロップしてください。", { kind: "info" });
  }
});

/** ドロップしたファイルをすべてタブで開き、すぐ編集できるよう分割表示にする */
async function openDropped(files: string[]) {
  let opened = false;
  for (const f of files) opened = (await openInTab(f)) || opened;
  if (opened && state.mode === "preview") setMode("split");
}

void listen<string>("file-changed", (e) => onExternalChange(e.payload));
void listen<string>("open-file", (e) => openInTab(e.payload));

void appWindow.onCloseRequested(async (e) => {
  const dirty = tabs.filter((t) => t.dirty);
  if (dirty.length) {
    const msg =
      dirty.length === 1
        ? `「${tabName(dirty[0])}」の保存されていない変更があります。破棄して閉じますか？`
        : `未保存のタブが ${dirty.length} 個あります。変更を破棄して閉じますか？`;
    const ok = await ask(msg, { title: "Markdown Preview", kind: "warning", okLabel: "破棄して閉じる", cancelLabel: "キャンセル" });
    if (!ok) {
      e.preventDefault();
      return;
    }
  }
  // ヘルプが残るとアプリが終了しないので一緒に閉じる
  await (await WebviewWindow.getByLabel("help"))?.destroy();
});

// 起動: 空のタブを 1 つ作り、更新前の退避 → 前回のタブ → 起動引数のファイルの順に開く
active = makeTab(null, "");
tabs.push(active);
editor.setState(active.doc);
setMode(state.mode);
renderTabs();
void render();
void (async () => {
  const initial = await invoke<string | null>("initial_file");
  if (!(await restoreDraft())) {
    const session = loadSession();
    const opened: (Tab | null)[] = [];
    for (const path of session.paths) opened.push((await openInTab(path, true)) ? active : null);
    const target = opened[session.active];
    if (target) activate(target);
  }
  if (initial) await openInTab(initial);
  sessionReady = true;
  persistSession();
})();
