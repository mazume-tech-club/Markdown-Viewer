import { darkQuery, getThemePref, setThemePref, type ThemePref } from "./theme";
import "./styles.css";

import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getVersion } from "@tauri-apps/api/app";
import { downloadDir } from "@tauri-apps/api/path";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open as openDialog, save as saveDialog, ask, message } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";

import { findImageRefs, findImageSource, highlighterReady, renderMarkdown } from "./render";
import { planImages, rewriteImageLinks } from "./export";
import { fillCached, renderDiagrams } from "./diagrams";
import { setupViewer, viewableAt } from "./viewer";
import type { EditorState } from "@codemirror/state";
import { createEditor } from "./editor";
import { loadSession, saveSession } from "./session";
import { renderAnnotations } from "./annotations";
import { findLineElement, setupScrollSync } from "./scrollsync";
import {
  applyActiveLineColor,
  getActiveLineColor,
  isActiveLineEnabled,
  isFollowCursorEnabled,
  setFollowCursorEnabled,
  setActiveLineColor,
  setActiveLineEnabled,
} from "./prefs";
import { checkForUpdate, isAutoCheckEnabled, isKeepDraftEnabled, setAutoCheck, setKeepDraft, setupUpdater } from "./updater";
import { basename, dirname, hasScheme, isAbsolute, isMarkdownPath, mdLink, normalizeInputPath, resolvePath, safeDecode } from "./paths";
import { getRecentCount, isFilePanelEnabled, RECENT_COUNT_MAX, setupFilePanel } from "./filepanel";
import { MENU_KEYS, setupMenuBar, type Mode } from "./menubar";
import { findSourcePos, type SourcePos } from "./sourcepos";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const main = $("main");
const previewPane = $("preview-pane");
const preview = $("preview");
const banner = $("banner");
const tabBar = $("tabs");
const dropzone = $("dropzone");
const appWindow = getCurrentWindow();
const toolbarStatus = $("toolbar-status");
const pathDisplay = $("path-display");

const state = {
  mode: (localStorage.getItem("mode") as Mode) || "preview",
  renderGen: 0,
  /** PDF 出力中は図をライトテーマで描く */
  forceLight: false,
  /** 更新のダウンロード中は編集もファイルの切り替えもさせない（退避した内容とずれるため） */
  updating: false,
};

// ---------- メニューバー ----------
// 項目から呼ぶ関数はこのファイルの後ろで定義する（クリックされた時点ではすべて揃っている）

/** エディタを使う操作。プレビューのみの表示なら分割にしてから行う */
const withEditor = (fn: () => void) => {
  if (state.mode === "preview") setMode("split");
  fn();
};

const menuBar = setupMenuBar(
  {
    newFile: () => void newFile(),
    open: () => void openWithPrompt(),
    openPath: () => openPathPrompt(),
    save: () => void saveFile(),
    saveAs: () => void saveFile(true),
    pdf: () => void previewPdf(),
    exportTab: () => void exportTab(),
    copyPath: () => void copyPath(),
    closeTab: () => void closeTab(active),
    quit: () => void appWindow.close(),
    undo: () => withEditor(() => editor.undo()),
    redo: () => withEditor(() => editor.redo()),
    find: () => withEditor(() => editor.openSearch(false)),
    replace: () => withEditor(() => editor.openSearch(true)),
    selectNextMatch: () => withEditor(() => editor.selectNextMatch()),
    selectAllMatches: () => withEditor(() => editor.selectAllMatches()),
    setMode: (mode) => setMode(mode),
    toggleFilePanel: () => filePanel.toggle(),
    zoomIn: () => changeZoom(focusedTarget(), 0.1),
    zoomOut: () => changeZoom(focusedTarget(), -0.1),
    zoomReset: () => changeZoom(focusedTarget(), null),
    setTheme: (pref) => void changeTheme(pref),
    reload: () => void reloadTab(active),
    diagram: () => void openDiagramTool(),
    annotate: () => void annotator.open(),
    settings: () => openSettings(),
    help: () => void openHelp(),
    checkUpdate: () => void checkForUpdate(true),
    about: () => void showAbout(),
  },
  {
    mode: state.mode,
    theme: getThemePref(),
    filePanelOpen: false,
    filePanelEnabled: isFilePanelEnabled(),
    canCopyPath: false,
    modal: false,
  },
);
void menuBar.ready.catch(showError);

/** ツールバーの左に一時的なメッセージを出す（「パスをコピーしました」など）。ms が 0 なら次に呼ぶまで出したまま */
let statusTimer = 0;
function showStatus(text: string, ms = 1500) {
  clearTimeout(statusTimer);
  toolbarStatus.textContent = text;
  if (ms) statusTimer = window.setTimeout(() => (toolbarStatus.textContent = ""), ms);
}

async function showAbout() {
  await message(`Markdown Preview v${await getVersion()}`, { title: "バージョン情報", kind: "info" });
}

/** 保存待ちの画像（貼り付けた画像・注釈の焼き込み画像）。link は MD に書いたリンク（省略時は mdLink(相対パス)） */
type PendingImage = { bytes: Uint8Array; url: string; link?: string };

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
  /** お試しタブ（ファイルパネルのシングルクリックで開いた、使い回すタブ）。編集すると通常タブになる */
  trial: boolean;
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
  addCopyButtons(tpl.content);
  renderAnnotations(tpl.content, resolveImageSrc);
  fillCached(tpl.content, dark);
  const scroll = previewPane.scrollTop;
  preview.replaceChildren(tpl.content);
  previewPane.scrollTop = scroll;
  markCursorLine();
  followCursor();
  // 図が描けると高さが変わるので、もう一度カーソルの位置に合わせる
  return renderDiagrams(preview, dark, () => gen === state.renderGen).then(() => {
    if (gen === state.renderGen) followCursor();
  });
}

/**
 * 画像のパスを表示用の URL にする。相対パスは開いているファイルの場所を基準に asset URL へ、
 * 貼り付けたが未保存の画像は blob URL へ。URL はそのまま。解決できなければ null
 */
function resolveImageSrc(src: string): string | null {
  if (hasScheme(src) || src.startsWith("//")) return src;
  // markdown-it は日本語や空白を %xx にするので、戻してから探す
  const file = safeDecode(src.split(/[?#]/)[0]);
  const pending = active.pendingImages.get(file);
  if (pending) return pending.url;
  return active.path ? convertFileSrc(resolvePath(dirname(active.path), file)) : null;
}

/** 相対パスの画像を、開いているファイルの場所を基準に asset URL に変換する */
function rewriteImages(root: ParentNode) {
  for (const img of root.querySelectorAll("img")) {
    const src = img.getAttribute("src");
    if (!src || hasScheme(src) || src.startsWith("//")) continue;
    const url = resolveImageSrc(src);
    if (url) img.src = url;
  }
}

/** コードブロックの右上にコピーボタンを付ける。pre はスクロールするので、包んだ外側に置く */
function addCopyButtons(root: ParentNode) {
  for (const pre of root.querySelectorAll("pre:not(.diagram-src)")) {
    if (!pre.querySelector("code")) continue;
    const wrap = document.createElement("div");
    wrap.className = "code-wrap";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "code-copy";
    btn.title = "コードをコピー";
    btn.textContent = "コピー";
    pre.replaceWith(wrap);
    wrap.append(pre, btn);
  }
}

// ---------- エディタ ----------

/**
 * 貼り付けた画像を置くフォルダ（md と同じ場所の「md の名前.assets」）。
 * まだ保存していない無題の文書は仮に untitled.assets とし、保存するときに正しい名前へ付け替える
 */
const assetDirOf = (mdPath: string | null) => `${mdPath ? basename(mdPath).replace(/\.[^.]+$/, "") : "untitled"}.assets`;

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
  const dir = assetDirOf(active.path);
  let rel = `${dir}/image-${stamp}.${ext}`;
  for (let i = 2; pendingImages.has(rel); i++) rel = `${dir}/image-${stamp}-${i}.${ext}`;
  pendingImages.set(rel, { bytes: new Uint8Array(await file.arrayBuffer()), url: URL.createObjectURL(file) });
  return `![](${mdLink(rel)})`;
}

const editor = createEditor(
  $("editor-pane"),
  darkQuery.matches,
  () => {
    setDirty(active, editor.getText() !== active.savedText);
    scheduleRender();
  },
  onPasteImage,
  () => {
    markCursorLine();
    followCursor();
  },
);
/** プレビューをクリックしてカーソルを移した直後は、プレビューを動かさない（クリックした箇所がマウスの下から逃げないように） */
let holdPreviewUntil = 0;
const syncPreviewToEditor = setupScrollSync(
  editor,
  previewPane,
  () => state.mode === "split" && performance.now() > holdPreviewUntil,
  isFollowCursorEnabled,
);
/** 分割表示で、プレビューのカーソル行の箇所をエディタのカーソルと同じ高さに表示する（設定でオフにできる） */
function followCursor() {
  if (isFollowCursorEnabled()) syncPreviewToEditor();
}

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
  menuBar.setMode(mode);
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
    // 拡大ビューアを開いている間は、ビューアの中だけを拡大縮小する
    if (!e.ctrlKey || viewer.isOpen()) return;
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
    trial: false,
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
  menuBar.setCanCopyPath(!!active.path);
  filePanel.setActive(active.path);
  // パス表示。右から左に並べて、入りきらないときはドライブ側を「…」で省く。
  // 前後の LRM で、パスの記号が右から左の並びに引きずられないようにする
  pathDisplay.hidden = !active.path;
  pathDisplay.textContent = active.path ? `\u200e${active.path}\u200e` : "";
}
pathDisplay.addEventListener("click", () => copyPath());

/** 表示中のタブのファイルのパスをクリップボードにコピーする */
async function copyPath() {
  if (!active.path) return;
  try {
    await navigator.clipboard.writeText(active.path);
    showStatus("パスをコピーしました");
  } catch (err) {
    await showError(err);
  }
}

function renderTabs() {
  tabBar.replaceChildren(
    ...tabs.map((tab) => {
      const el = document.createElement("div");
      el.className = tab.trial ? "tab trial" : "tab";
      el.setAttribute("role", "tab");
      el.setAttribute("aria-selected", String(tab === active));
      el.dataset.id = String(tab.id);
      el.title = tab.trial ? `${tab.path}（お試し: ダブルクリックで残す）` : (tab.path ?? "無題（未保存）");
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
// お試しタブをダブルクリックしたら通常タブにする
tabBar.addEventListener("dblclick", (e) => {
  const tab = tabOf(e.target as Element);
  if (tab?.trial) pinTab(tab);
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
  // 編集したお試しタブは、別のファイルで置き換わらないよう通常タブにする
  if (dirty) tab.trial = false;
  renderTabs();
}

/** お試しタブを通常タブにする */
function pinTab(tab: Tab) {
  tab.trial = false;
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
 * trial ならお試しタブで開く（お試しタブがあればその中身を置き換える）。trial でなければ通常タブにする。
 * 開けたら true。quiet なら開けなくてもエラーを出さない（前回のタブの復元で、消えたファイルを飛ばすため）
 */
async function openInTab(path: string, quiet = false, trial = false): Promise<boolean> {
  if (state.updating) return false;
  const opened = () => tabs.find((t) => t.path && samePath(t.path, path));
  const showOpened = () => {
    const tab = opened()!;
    activate(tab);
    // お試しタブで開いているファイルをダイアログやダブルクリックで開き直したら、通常タブにする
    if (!trial && tab.trial) pinTab(tab);
    return true;
  };
  if (opened()) return showOpened();
  let text: string;
  try {
    text = await invoke<string>("read_file", { path });
    // 相対パス画像を読めるよう、描画前に asset スコープを許可しておく（watch_file が行う）
    await invoke("watch_file", { path });
  } catch (err) {
    if (!quiet) await showError(err);
    return false;
  }
  if (opened()) return showOpened();
  const reuse = trial ? tabs.find((t) => t.trial) : undefined;
  if (reuse) loadInto(reuse, path, text, trial);
  else if (isBlank(active)) loadInto(active, path, text, trial);
  else {
    const tab = makeTab(path, text);
    tab.trial = trial;
    addTab(tab);
  }
  return true;
}

/** 未編集のタブ（空の無題・お試しタブ）にファイルの中身を読み込んで表示する */
function loadInto(tab: Tab, path: string, text: string, trial: boolean) {
  const oldPath = tab.path;
  tab.path = path;
  tab.savedText = text;
  tab.doc = editor.createState(text);
  tab.trial = trial;
  tab.externalChange = false;
  tab.previewScroll = 0;
  tab.editorScroll = 0;
  clearPendingImages(tab);
  if (oldPath && !tabs.some((t) => t.path && samePath(t.path, oldPath))) {
    void invoke("unwatch_file", { path: oldPath }).catch(() => {});
  }
  if (tab !== active) return activate(tab);
  editor.setState(tab.doc);
  banner.hidden = true;
  renderTabs();
  void render();
  previewPane.scrollTop = 0;
}

// ファイルパネル（右側。作業フォルダの Markdown をツリーで出す）
const filePanel = setupFilePanel({
  // お試しタブで開いても、続けてキーボードで選べるようパネルのフォーカスを保つ
  openTrial: async (path) => {
    const focused = document.activeElement as HTMLElement | null;
    await openInTab(path, false, true);
    focused?.focus();
  },
  openPinned: (path) => openInTab(path),
  // 前回開いたままならタブを作る前に呼ばれるので、まだ active がないことがある
  activePath: () => active?.path ?? null,
  onClose: () => (state.mode === "preview" ? previewPane.focus() : editor.view.focus()),
  onOpenChange: (open) => menuBar.setFilePanel(open, isFilePanelEnabled()),
});

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

// ---------- パスで開く ----------
// パスを入力・貼り付けして開く。フォルダなら作業フォルダにする（ファイルパネルを使うとき）

const openPathOverlay = $("open-path");
const openPathInput = $<HTMLInputElement>("open-path-input");
const openPathError = $("open-path-error");
const OPEN_PATH_KEY = "openPath.last";

/** 直前に入力したパスを全選択で出す（そのまま貼り付けて上書きできる） */
function openPathPrompt() {
  if (state.updating) return;
  openPathInput.value = localStorage.getItem(OPEN_PATH_KEY) ?? "";
  openPathError.hidden = true;
  openPathOverlay.hidden = false;
  openPathInput.focus();
  openPathInput.select();
}

function closeOpenPath() {
  openPathOverlay.hidden = true;
}

/** 開けないときは入力欄を閉じずにエラーを出す（直してもう一度試せるように） */
async function submitOpenPath() {
  const path = normalizeInputPath(openPathInput.value);
  if (!path) return;
  localStorage.setItem(OPEN_PATH_KEY, path);
  const fail = (msg: string) => {
    openPathError.textContent = msg;
    openPathError.hidden = false;
    openPathInput.focus();
  };
  // 相対パスは基準が分かりにくく、別のファイルを開いてしまうので受け付けない
  if (!isAbsolute(path)) {
    return fail("C:\\ や \\\\server\\ から始まるパスを入力してください。");
  }
  if (await invoke<boolean>("is_dir", { path })) {
    if (!isFilePanelEnabled()) return fail("フォルダは開けません（設定で「ファイルパネルを使う」をオンにすると、作業フォルダとして開けます）。");
    closeOpenPath();
    return filePanel.openFolder(path);
  }
  if (!isMarkdownPath(path) && !/\.txt$/i.test(path)) {
    return fail("Markdown ファイル（.md / .markdown / .mdown / .mkd / .txt）のパスを入力してください。");
  }
  if (!(await openInTab(path, true))) return fail(`ファイルを開けませんでした（見つからないか、読み込めません）: ${path}`);
  closeOpenPath();
}

openPathInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) {
    e.preventDefault();
    void submitOpenPath();
  }
});
openPathInput.addEventListener("input", () => (openPathError.hidden = true));
// 入力欄の外（背景）をクリックしたら閉じる
openPathOverlay.addEventListener("click", (e) => e.target === openPathOverlay && closeOpenPath());

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

const linkOfPending = (rel: string, img: PendingImage) => img.link ?? mdLink(rel);

/**
 * 保存待ちの画像が本文から参照されているか。画像のリンクに加えて、注釈のコメントの "src"（元画像）も見る
 * （注釈を付けた元画像は、コメントからしか参照されないため）
 */
const isReferenced = (text: string, rel: string, img: PendingImage) => {
  const link = linkOfPending(rel, img);
  return text.includes(`](${link}`) || text.includes(`"src":${JSON.stringify(link)}`);
};

/** MD のフォルダの下（.. を含まない相対パス）か。外を指す焼き込み画像は write_asset では書けない */
const isUnderMd = (rel: string) => !/^[a-zA-Z]:|^[\\/]/.test(rel) && !rel.split(/[\\/]/).includes("..");

/** 本文で参照されている保存待ち画像を書き出す。書き出した件数を返す */
async function writePendingImages(tab: Tab, mdPath: string, text: string): Promise<number> {
  let count = 0;
  for (const [rel, img] of tab.pendingImages) {
    if (!isReferenced(text, rel, img)) continue;
    if (isUnderMd(rel)) {
      await invoke("write_asset", img.bytes, {
        headers: { "x-md": encodeURIComponent(mdPath), "x-rel": encodeURIComponent(rel) },
      });
    } else {
      // 元画像の隣（../img/form.annotated.png など）に置く焼き込み画像
      await invoke("write_binary", img.bytes, {
        headers: { "x-path": encodeURIComponent(resolvePath(dirname(mdPath), rel)) },
      });
    }
    count++;
  }
  return count;
}

/** 「md の名前.assets」フォルダ直下の画像か（貼り付けた画像と、その焼き込み画像） */
const isInAssetDir = (rel: string) => /^[^/\\]+\.assets\/[^/\\]+$/.test(rel);

/**
 * まだ書き出していない貼り付け画像の置き場所を dir に付け替え、本文のリンクと注釈のコメントの "src" も書き換える。
 * 無題の文書を初めて保存したときや、画像を保存する前に名前を付けて保存したとき用。書き換えた本文を返す。
 * 元画像の隣に置く焼き込み画像（.assets の外）は動かさない
 */
function moveImagesTo(tab: Tab, dir: string): string {
  let text = textOf(tab);
  const moved = new Map<string, PendingImage>();
  let changed = false;
  for (const [rel, img] of tab.pendingImages) {
    const next = isInAssetDir(rel) ? `${dir}/${rel.slice(rel.lastIndexOf("/") + 1)}` : rel;
    if (next !== rel) {
      const from = linkOfPending(rel, img);
      const to = mdLink(next);
      text = text.split(`](${from}`).join(`](${to}`);
      text = text.split(`"src":${JSON.stringify(from)}`).join(`"src":${JSON.stringify(to)}`);
      changed = true;
      moved.set(next, { ...img, link: to });
    } else moved.set(next, img);
  }
  if (changed) {
    tab.pendingImages = moved;
    setTabText(tab, text);
  }
  return text;
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
  const text = moveImagesTo(tab, assetDirOf(path));
  try {
    // 貼り付けた画像を md と同じ場所の「md の名前.assets」に書き出す（本文から消したものは捨てる）
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

/**
 * 図のビルダー・注釈エディタは、初めて開くときに読み込む（起動時に読み込まないで済むように）。
 * 読み込む前は閉じている扱い
 */
function lazyTool(load: () => Promise<{ open(): unknown; close(): void; isOpen(): boolean }>) {
  let tool: Awaited<ReturnType<typeof load>> | null = null;
  let loading: ReturnType<typeof load> | null = null;
  return {
    async open() {
      try {
        loading ??= load().then((t) => (tool = t));
        await (await loading).open();
      } catch (err) {
        loading = null;
        await showError(err);
      }
    },
    close: () => tool?.close(),
    isOpen: () => tool?.isOpen() ?? false,
  };
}

// 図のビルダー（C4 図をフォームで作る・カーソル位置の図を直す）
const builder = lazyTool(async () => (await import("./builder/builder")).setupBuilder({
  editor,
  isDark: () => darkQuery.matches,
  canEdit: () => !state.updating,
  onApplied: () => state.mode === "preview" && setMode("split"),
}));
// 画像の注釈（矢印・テキスト・枠・番号を画像に重ねる）
const annotator = lazyTool(async () => (await import("./annotator/annotator")).setupAnnotator({
  editor,
  canEdit: () => !state.updating,
  mdPath: () => active.path,
  readBinary: async (path) => new Uint8Array(await invoke<ArrayBuffer>("read_binary", { path })),
  exists: (path) => invoke<boolean>("path_exists", { path }),
  pendingBytes: (rel) => active.pendingImages.get(rel)?.bytes ?? null,
  // 焼き込み画像は貼り付け画像と同じく保存待ちにし、MD を保存したときに書き出す（保存前でも blob URL で表示できる）
  addPending: (rel, link, bytes) => {
    const old = active.pendingImages.get(rel);
    if (old) URL.revokeObjectURL(old.url);
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/png" }));
    active.pendingImages.set(rel, { bytes, url, link });
  },
  onApplied: () => state.mode === "preview" && setMode("split"),
}));

/** 「図」: カーソルが画像の行にあれば注釈エディタ、それ以外は図のビルダー */
const openDiagramTool = () => (editor.imageAtCursor() ? annotator.open() : builder.open());

// プレビューの図や画像をクリック、または右クリック →「拡大して見る」で拡大ビューアを開く
const viewer = setupViewer();
function openViewer(el: HTMLElement | SVGSVGElement) {
  if (!viewer.open(el)) void message("画像を読み込めていないため、拡大して見られません。", { title: "拡大ビューア", kind: "warning" });
}
preview.addEventListener("click", (e) => {
  // リンクの付いた画像・図の中のリンクは、リンクを優先する
  if ((e.target as Element).closest("a")) return;
  // 文字を選ぶドラッグが図の上で終わったときは開かない
  if (!window.getSelection()?.isCollapsed) return;
  const el = viewableAt(e.target);
  if (!el) return;
  openViewer(el);
});

// 分割表示でプレビューをクリック → エディタのカーソルをクリックした文字の位置へ。プレビューは動かさず、
// エディタのカーソル行をクリックした高さに出す。リンク・ボタン・図や画像・文字の選択はそれぞれの動作を優先する
preview.addEventListener("click", (e) => {
  if (state.mode !== "split" || e.button !== 0) return;
  const target = e.target as Element;
  if (target.closest("a, button, input") || viewableAt(target)) return;
  if (!window.getSelection()?.isCollapsed) return;
  const block = target.closest<HTMLElement>("[data-line]");
  if (!block) return;
  const pos = sourcePosAt(block, e.clientX, e.clientY);
  holdPreviewUntil = performance.now() + 300;
  editor.placeCursor(pos.line, pos.ch, e.clientY - editor.view.scrollDOM.getBoundingClientRect().top);
});

/** プレビューの (x, y) にある文字の、ソースの位置。文字が見つからなければブロックの先頭行 */
function sourcePosAt(block: HTMLElement, x: number, y: number): SourcePos {
  const from = Number(block.dataset.line);
  const fallback = { line: from, ch: 0 };
  const caret = caretAt(x, y);
  if (!caret || caret.node.nodeType !== Node.TEXT_NODE || !block.contains(caret.node)) return fallback;
  // ブロックの範囲は、次のブロックの先頭行まで
  let to = Infinity;
  for (const el of preview.querySelectorAll<HTMLElement>("[data-line]")) {
    const l = Number(el.dataset.line);
    if (l > from && l < to) to = l;
  }
  const lines = editor.view.state.doc.toJSON();
  const before = document.createRange();
  before.setStart(block, 0);
  before.setEnd(caret.node, 0);
  return findSourcePos(lines, from, Math.min(to, lines.length), caret.node.textContent ?? "", caret.offset, before.toString()) ?? fallback;
}

/** (x, y) にある文字の位置 */
function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const p = document.caretPositionFromPoint?.(x, y);
  if (p) return { node: p.offsetNode, offset: p.offset };
  const r = document.caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, offset: r.startOffset } : null;
}

// プレビューの図や画像を右クリック →「拡大して見る」「注釈を編集」（注釈は画像だけ）
const previewMenu = $("preview-menu");
const annotateItem = previewMenu.querySelector<HTMLButtonElement>('[data-action="annotate"]')!;
let menuTarget: HTMLElement | SVGSVGElement | null = null;
let menuImage: number | null = null;
preview.addEventListener("contextmenu", (e) => {
  menuTarget = viewableAt(e.target);
  if (!menuTarget) return;
  e.preventDefault();
  const img = (e.target as Element).closest<HTMLImageElement>("img[data-img-n]");
  menuImage = img ? Number(img.dataset.imgN) : null;
  annotateItem.hidden = menuImage === null;
  previewMenu.hidden = false;
  const r = previewMenu.getBoundingClientRect();
  previewMenu.style.left = `${Math.min(e.clientX, window.innerWidth - r.width - 4)}px`;
  previewMenu.style.top = `${Math.min(e.clientY, window.innerHeight - r.height - 4)}px`;
});
const closePreviewMenu = () => {
  previewMenu.hidden = true;
  menuTarget = null;
  menuImage = null;
};
window.addEventListener("pointerdown", (e) => !previewMenu.contains(e.target as Node) && closePreviewMenu(), true);
window.addEventListener("blur", closePreviewMenu);
previewMenu.addEventListener("click", async (e) => {
  const action = (e.target as Element).closest<HTMLElement>("[data-action]")?.dataset.action;
  const target = menuTarget;
  const n = menuImage;
  closePreviewMenu();
  if (action === "view" && target) return openViewer(target);
  if (action !== "annotate" || n === null) return;
  // ソースのその画像にカーソルを移してから開く（エディタ側の位置で書き換えるため）
  const pos = findImageSource(editor.getText(), n);
  if (!pos) return void message("この画像の場所を MD の中で見つけられませんでした。", { title: "画像の注釈", kind: "warning" });
  editor.setCursor(pos.line, pos.ch);
  await annotator.open();
});

/** 書き方ヘルプを別ウィンドウで開く（開いていれば前面に出す） */
async function openHelp() {
  await invoke("open_help").catch(showError);
}

// ---------- テーマ ----------

/** テーマを変える。ウィンドウのテーマも変わるので、メニューバーの色もそれに合わせて変わる */
async function changeTheme(pref: ThemePref) {
  await setThemePref(pref);
  menuBar.setTheme(pref);
}
// ヘルプウィンドウで変更されたとき
window.addEventListener("storage", (e) => e.key === "theme" && menuBar.setTheme(getThemePref()));

// ---------- 設定 ----------
// 設定は localStorage に保存する。storage イベントは同じウィンドウでは発火しないので、
// 変更したらここで直接反映する（ヘルプウィンドウはテーマだけ storage イベントで追従）

const settingsOverlay = $("settings");
const setTheme = $<HTMLSelectElement>("set-theme");
const activeLine = $<HTMLInputElement>("active-line");
const followCursorIn = $<HTMLInputElement>("follow-cursor");
const activeLineColor = $<HTMLInputElement>("active-line-color");
const autoUpdate = $<HTMLInputElement>("auto-update");
const keepDraft = $<HTMLInputElement>("keep-draft");
const setFiles = $<HTMLInputElement>("set-files");
const setRecentCount = $<HTMLInputElement>("set-recent-count");

/** 設定画面を開く（開くたびに現在の値を読み直す） */
function openSettings() {
  setTheme.value = getThemePref();
  activeLine.checked = isActiveLineEnabled();
  followCursorIn.checked = isFollowCursorEnabled();
  activeLineColor.value = getActiveLineColor();
  autoUpdate.checked = isAutoCheckEnabled();
  keepDraft.checked = isKeepDraftEnabled();
  setFiles.checked = isFilePanelEnabled();
  setRecentCount.value = String(getRecentCount());
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
setTheme.addEventListener("change", () => changeTheme(setTheme.value as ThemePref));
followCursorIn.addEventListener("change", () => {
  setFollowCursorEnabled(followCursorIn.checked);
  syncPreviewToEditor();
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
setFiles.addEventListener("change", () => {
  filePanel.setEnabled(setFiles.checked);
  menuBar.setFilePanel(filePanel.isOpen(), isFilePanelEnabled());
});
// 入力途中（空欄など）は反映せず、範囲外は上限・下限に丸めて入力欄にも戻す
setRecentCount.addEventListener("change", () => {
  const n = Number(setRecentCount.value);
  if (setRecentCount.value === "" || !Number.isFinite(n)) {
    setRecentCount.value = String(getRecentCount());
    return;
  }
  filePanel.setRecentCount(Math.min(RECENT_COUNT_MAX, Math.max(0, n)));
  setRecentCount.value = String(getRecentCount());
});
autoUpdate.addEventListener("change", () => setAutoCheck(autoUpdate.checked));
keepDraft.addEventListener("change", () => setKeepDraft(keepDraft.checked));

// ---------- バージョンアップ ----------
// 起動時に自動確認（設定で切り替え可）。メニューの ヘルプ →「更新を確認」からも呼ばれる。
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
  return [...tab.pendingImages].some(([rel, img]) => isReferenced(text, rel, img));
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
    showWindow();
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

// ---------- エクスポート（MD と画像を 1 つのフォルダにまとめる。export.ts 参照） ----------

const EXPORT_DIR_KEY = "export.lastDir";

/**
 * 表示中のタブをエクスポートする。保存していない変更（貼り付けたばかりの画像も）を含め、元のファイルは変えない。
 * 入力した名前のフォルダを作り、その中に「名前.md」と「名前.assets」を置く
 */
async function exportTab() {
  const tab = active;
  const stem = tab.path ? basename(tab.path).replace(/\.[^.]+$/, "") : "untitled";
  // 置き場所の初期値は前回のエクスポート先（初回はダウンロード）。元の MD の隣にすると、
  // 同じ名前の MD があるためダイアログが「上書きしますか」と聞いてしまう（実際には上書きしない）
  const where = localStorage.getItem(EXPORT_DIR_KEY) ?? (await downloadDir().catch(() => ""));
  // .md 付きで名前を聞く（拡張子なしだと、同じ名前の既存フォルダを入力したときにダイアログがその中へ移動してしまう）
  const picked = await saveDialog({
    title: "エクスポート（入力した名前のフォルダにまとめる）",
    defaultPath: where ? resolvePath(where, `${stem}.md`) : `${stem}.md`,
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (!picked) return;
  const dir = picked.replace(/\.md$/i, "");
  localStorage.setItem(EXPORT_DIR_KEY, dirname(dir));
  const name = basename(dir);
  const mdPath = `${dir}\\${name}.md`;
  if (
    (await invoke<boolean>("path_exists", { path: dir })) &&
    !(await ask(`「${dir}」はすでにあります。\n中の「${name}.md」と「${name}.assets」を置き換えますか？\nほかのファイルはそのまま残ります。`, {
      title: "エクスポート",
      kind: "warning",
      okLabel: "置き換える",
      cancelLabel: "キャンセル",
    }))
  ) {
    return;
  }

  const text = textOf(tab);
  const refs = findImageRefs(text);
  const base = tab.path ? dirname(tab.path) : null;
  /** 画像の出どころ。保存待ちならそれ、そうでなければディスク上の絶対パス（無題のタブの相対パスは分からない） */
  const sourceOf = (file: string) =>
    tab.pendingImages.get(file) ?? (base || isAbsolute(file) ? resolvePath(base ?? "", file) : null);
  const plan = planImages(refs, (file) => {
    const src = sourceOf(file);
    return typeof src === "string" ? src.toLowerCase() : `${src ? "pending" : "missing"}:${file}`;
  });
  try {
    await invoke("prepare_export", { md: mdPath });
    const to = new Map<string, string>();
    const copied = new Map<string, boolean>();
    const missing = new Set<string>();
    for (const [link, img] of plan) {
      const rel = `${name}.assets/${img.name}`;
      let ok = copied.get(img.name);
      if (ok === undefined) {
        const src = sourceOf(img.file);
        if (!src) ok = false;
        else if (typeof src === "string") ok = await invoke<boolean>("copy_asset", { md: mdPath, rel, from: src });
        else {
          await invoke("write_asset", src.bytes, {
            headers: { "x-md": encodeURIComponent(mdPath), "x-rel": encodeURIComponent(rel) },
          });
          ok = true;
        }
        copied.set(img.name, ok);
      }
      if (ok) to.set(link, rel);
      else missing.add(img.file);
    }
    await invoke("write_file", { path: mdPath, content: rewriteImageLinks(text, refs, to) });
    const msg = [`「${dir}」にエクスポートしました。`];
    if (missing.size) msg.push("", "次の画像は見つからなかったので、リンクをそのまま残しました:", ...[...missing].map((f) => `・${f}`));
    const open = await ask(msg.join("\n"), {
      title: "エクスポート",
      kind: missing.size ? "warning" : "info",
      okLabel: "フォルダを開く",
      cancelLabel: "閉じる",
    });
    if (open) await revealItemInDir(mdPath);
  } catch (err) {
    await showError(err);
  }
}


// ---------- PDF（プレビュー → 保存） ----------

const pdfOverlay = $("pdf-preview");
const pdfFrame = $<HTMLIFrameElement>("pdf-frame");

/** PDF を作成中か（作成中にもう一度呼ばれても作らない） */
let pdfBusy = false;

/** PDF を一時ファイルに作ってプレビュー表示する（ダークモードでも白地・ライト配色） */
async function previewPdf() {
  if (pdfBusy) return;
  pdfBusy = true;
  showStatus("PDF を作成中…", 0);
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
    pdfBusy = false;
    showStatus("");
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

// コードブロックのコピーボタン
preview.addEventListener("click", async (e) => {
  const btn = (e.target as Element).closest<HTMLButtonElement>(".code-copy");
  const code = btn?.parentElement?.querySelector("pre code");
  if (!btn || !code) return;
  try {
    await navigator.clipboard.writeText(code.textContent ?? "");
    btn.textContent = "コピーしました";
    btn.classList.add("copied");
    setTimeout(() => {
      btn.textContent = "コピー";
      btn.classList.remove("copied");
    }, 1500);
  } catch (err) {
    await showError(err);
  }
});

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

// ---------- ダイアログ表示中のメニュー ----------
// 設定・PDF・パスで開く・図のビルダー・画像の注釈・拡大ビューアを開いている間は、メニューバーを丸ごと灰色にする

const isModal = () =>
  !settingsOverlay.hidden || !pdfOverlay.hidden || !openPathOverlay.hidden || annotator.isOpen() || builder.isOpen() || viewer.isOpen();
new MutationObserver(() => menuBar.setModal(isModal())).observe(document.body, {
  subtree: true,
  attributes: true,
  attributeFilter: ["hidden"],
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
    // 拡大ビューアを開いている間は、ビューアの操作だけを受け付ける（下の文書を変えないため）
    if (viewer.isOpen()) {
      return run(() => viewer.handleKey(e));
    }
    // 図のビルダーを開いている間は、入力欄にキーを渡す（Esc で閉じるだけ）
    if (annotator.isOpen()) {
      if (e.key === "Escape") run(() => annotator.close());
      return;
    }
    if (builder.isOpen()) {
      if (e.key === "Escape") run(() => builder.close());
      return;
    }
    // Alt+F などでメニューを開く。エディタにフォーカスがあると Windows に届かないので、ここから開く（docs/adr/0003）
    if (e.altKey && !mod && !e.shiftKey && MENU_KEYS.includes(key)) {
      if (!isModal()) run(() => invoke("open_menu", { key }).catch(showError));
    } else if (!pdfOverlay.hidden && e.key === "Escape") run(() => closePdfPreview());
    else if (mod && e.shiftKey && key === "d") run(() => openDiagramTool());
    else if (mod && e.shiftKey && key === "a") run(() => annotator.open());
    else if (mod && e.shiftKey && key === "c") run(() => copyPath());
    else if (!settingsOverlay.hidden && e.key === "Escape") run(() => closeSettings());
    else if (!openPathOverlay.hidden && e.key === "Escape") run(() => closeOpenPath());
    // Ctrl+O より先に判定する（Shift 付きも key は "o"）
    else if (mod && e.shiftKey && key === "o") run(() => openPathPrompt());
    else if (!pdfOverlay.hidden && mod && key === "s") run(() => savePdf());
    else if (mod && key === "s") run(() => saveFile(e.shiftKey));
    else if (mod && key === "o") run(() => openWithPrompt());
    else if (mod && key === "n") run(() => newFile());
    else if (mod && key === "p") run(() => previewPdf());
    else if (mod && key === "b" && isFilePanelEnabled()) run(() => filePanel.toggle());
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
    void onDrop(p.paths);
  }
});

/** ファイルはタブで開く。フォルダはファイルパネルの作業フォルダにする（ファイルパネルを使うときだけ） */
async function onDrop(paths: string[]) {
  // Markdown（とテキスト）以外は開かない。画像などをテキストとして開いて文字化けさせないため
  const files = paths.filter((f) => isMarkdownPath(f) || /\.txt$/i.test(f));
  if (files.length) return openDropped(files);
  if (!paths.length) return;
  if (isFilePanelEnabled()) {
    for (const p of paths) {
      if (await invoke<boolean>("is_dir", { path: p })) return filePanel.openFolder(p);
    }
    return void message("Markdown ファイル（.md など）かフォルダをドロップしてください。", { kind: "info" });
  }
  void message("Markdown ファイル（.md など）をドロップしてください。", { kind: "info" });
}

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

/**
 * 前回開いていたタブを開き直す。ファイルはまとめて並行に読み、描画は最後に表示するタブだけにする
 * （1 つずつ開くと、タブごとに読み込みを待って描画するので起動が遅くなる）
 */
async function restoreSession() {
  const session = loadSession();
  const files = await Promise.all(
    session.paths.map(async (path) => {
      try {
        const text = await invoke<string>("read_file", { path });
        // 相対パス画像を読めるよう、描画前に asset スコープを許可しておく（watch_file が行う）
        await invoke("watch_file", { path });
        return { path, text };
      } catch {
        return null;
      }
    }),
  );
  const restored: (Tab | null)[] = files.map((f) => {
    if (!f || tabs.some((t) => t.path && samePath(t.path, f.path))) return null;
    const tab = makeTab(f.path, f.text);
    tabs.push(tab);
    return tab;
  });
  const opened = restored.filter((t): t is Tab => !!t);
  if (!opened.length) return;
  // 起動時の空のタブは、開いたタブに置き換える
  if (isBlank(active)) tabs.splice(tabs.indexOf(active), 1);
  activate(restored[session.active] ?? opened[opened.length - 1]);
}

/**
 * 起動時のウィンドウは隠して作り（tauri.conf.json の visible: false）、前回のタブとメニューバーが整ってから出す。
 * 白い画面や、メニューバーが後から付いて表示がずれるのを見せないため。待ちすぎないよう 1.5 秒で必ず出す
 */
let windowShown = false;
function showWindow() {
  if (windowShown) return;
  windowShown = true;
  void appWindow
    .show()
    .then(() => appWindow.setFocus())
    .catch(() => {});
}
setTimeout(showWindow, 1500);

// 起動: 空のタブを 1 つ作り、更新前の退避 → 前回のタブ → 起動引数のファイルの順に開く
active = makeTab(null, "");
tabs.push(active);
editor.setState(active.doc);
setMode(state.mode);
renderTabs();
void render();
// コードの色分けを読み込めたら描き直す
void highlighterReady.then(() => render());
void (async () => {
  const initial = await invoke<string | null>("initial_file");
  if (!(await restoreDraft())) await restoreSession();
  // メニューバーが付いてから出す（後から付くと本文の位置がずれるため）
  await menuBar.ready.catch(() => {});
  requestAnimationFrame(showWindow);
  if (initial) await openInTab(initial);
  sessionReady = true;
  persistSession();
})();
