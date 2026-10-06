// ---------- ファイルパネル ----------
// 作業フォルダ以下の Markdown を右側にツリーで出す。シングルクリックでお試しタブ、ダブルクリックで通常タブに開く。
// 作業フォルダ・開閉・幅は localStorage に保存し、次回の起動時に戻す

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { message, open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { basename, dirname } from "./paths";

const ENABLED_KEY = "files.enabled";
const OPEN_KEY = "files.open";
const WIDTH_KEY = "files.width";
const ROOT_KEY = "files.root";
const RECENT_KEY = "files.recentFolders";
const RECENT_COUNT_KEY = "files.recentCount";
const DEFAULT_WIDTH = 240;
/** 最近使ったフォルダの表示件数の上限と既定値（設定画面で変えられる） */
export const RECENT_COUNT_MAX = 20;
const RECENT_COUNT_DEFAULT = 5;

/** 設定「ファイルパネルを使う」（既定はオン） */
export const isFilePanelEnabled = () => localStorage.getItem(ENABLED_KEY) !== "0";

/** 設定「最近使ったフォルダの表示件数」（0 なら一覧を出さない） */
export function getRecentCount(): number {
  const n = Number(localStorage.getItem(RECENT_COUNT_KEY) ?? RECENT_COUNT_DEFAULT);
  return Number.isInteger(n) ? Math.min(RECENT_COUNT_MAX, Math.max(0, n)) : RECENT_COUNT_DEFAULT;
}

interface Entry {
  name: string;
  path: string;
  dir: boolean;
}

export interface FilePanelOptions {
  /** シングルクリック・Space（お試しタブで開く） */
  openTrial: (path: string) => unknown;
  /** ダブルクリック・Enter（通常タブで開く） */
  openPinned: (path: string) => unknown;
  /** 初めて開いたときの作業フォルダの候補（アクティブなタブのファイル） */
  activePath: () => string | null;
  /** パネルを閉じたときにフォーカスを返す先 */
  onClose: () => void;
}

/** Windows のパスは大文字小文字と区切り文字の違いを同じとみなす */
const keyOf = (path: string) => path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
const isUnder = (path: string, dir: string) => keyOf(path).startsWith(keyOf(dir) + "\\");

function loadRecent(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    if (Array.isArray(list)) return list.filter((p): p is string => typeof p === "string");
  } catch {
    // 壊れていれば捨てる
  }
  return [];
}

export function setupFilePanel(opts: FilePanelOptions) {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const workspace = $("workspace");
  const panel = $("files");
  const divider = $("files-divider");
  const tree = $("files-tree");
  const status = $("files-status");
  const rootLabel = $("files-root");
  const toggleBtn = $<HTMLButtonElement>("btn-files");
  const menu = $("files-menu");
  const recentSection = $("files-recent");
  const recentList = $("files-recent-list");

  let root: string | null = localStorage.getItem(ROOT_KEY);
  /** 読み込んだフォルダの中身。キーは keyOf(フォルダのパス) */
  const children = new Map<string, Entry[]>();
  const expanded = new Set<string>();
  /** キーボード操作で選んでいる行（パス） */
  let cursor: string | null = null;
  /** アクティブなタブのファイル */
  let activeFile: string | null = null;
  /** 作業フォルダを読めなかった（削除・移動・ドライブ切断） */
  let missing = false;
  let menuTarget: Entry | null = null;
  /** 最近使ったフォルダ（新しい順。今の作業フォルダも含めて記録する） */
  let recent = loadRecent();

  const isOpen = () => !panel.hidden;

  // ---- 読み込み ----

  async function load(dir: string): Promise<boolean> {
    try {
      children.set(keyOf(dir), await invoke<Entry[]>("list_dir", { path: dir }));
      return true;
    } catch {
      children.delete(keyOf(dir));
      return false;
    }
  }

  /** 作業フォルダと開いているフォルダを読み直す */
  async function reload() {
    if (!root) return render();
    missing = !(await load(root));
    // 開いていないフォルダの古い中身は捨てる（開いたときに読み直す）
    for (const k of [...children.keys()]) if (k !== keyOf(root) && !expanded.has(k)) children.delete(k);
    // 開いているフォルダは親から順に開いたはずなので、その順に読み直す
    for (const k of expanded) {
      const p = pathOfKey(k);
      if (p) await load(p);
    }
    render();
  }

  /** 読み込み済みのエントリーから、キーに対応する元のパス（大文字小文字そのまま）を探す */
  function pathOfKey(key: string): string | null {
    for (const list of children.values()) for (const e of list) if (keyOf(e.path) === key) return e.path;
    return null;
  }

  async function startWatch() {
    if (!root || missing) return;
    await invoke("watch_folder", { path: root }).catch(() => undefined);
  }

  const stopWatch = () => invoke("unwatch_folder").catch(() => undefined);

  // ---- 描画 ----

  /** 見えている行（開いているフォルダの中身を順に並べたもの） */
  function visibleRows(): { entry: Entry; depth: number }[] {
    const rows: { entry: Entry; depth: number }[] = [];
    const walk = (dir: string, depth: number) => {
      for (const entry of children.get(keyOf(dir)) ?? []) {
        rows.push({ entry, depth });
        if (entry.dir && expanded.has(keyOf(entry.path))) walk(entry.path, depth + 1);
      }
    };
    if (root) walk(root, 0);
    return rows;
  }

  function render() {
    rootLabel.textContent = root ? basename(root) || root : "";
    rootLabel.title = root ?? "";
    status.replaceChildren();
    status.hidden = true;
    if (!root || missing) {
      tree.replaceChildren();
      status.hidden = false;
      const p = document.createElement("p");
      if (!root) {
        p.textContent = "作業フォルダが選ばれていません。フォルダを選ぶか、ウィンドウにドロップしてください。";
        status.append(p, button("フォルダを選ぶ…", pickFolder));
      } else {
        p.textContent = `作業フォルダが見つかりません: ${root}`;
        status.append(p, button("フォルダを選ぶ…", pickFolder), button("再試行", () => void retry()));
      }
      return;
    }
    const rows = visibleRows();
    if (!rows.length) {
      status.hidden = false;
      const p = document.createElement("p");
      p.textContent = "Markdown ファイルがありません。";
      status.append(p);
    }
    tree.replaceChildren(
      ...rows.map(({ entry, depth }) => {
        const el = document.createElement("div");
        el.className = "files-row";
        el.setAttribute("role", "treeitem");
        el.setAttribute("aria-level", String(depth + 1));
        el.dataset.path = entry.path;
        el.title = entry.path;
        el.style.paddingLeft = `${8 + depth * 14}px`;
        const open = entry.dir && expanded.has(keyOf(entry.path));
        if (entry.dir) el.setAttribute("aria-expanded", String(open));
        if (cursor && keyOf(cursor) === keyOf(entry.path)) el.classList.add("cursor");
        if (!entry.dir && activeFile && keyOf(activeFile) === keyOf(entry.path)) {
          el.classList.add("active");
          el.setAttribute("aria-selected", "true");
        }
        const twisty = document.createElement("span");
        twisty.className = "files-twisty";
        twisty.textContent = entry.dir ? (open ? "▾" : "▸") : "";
        const icon = document.createElement("span");
        icon.className = "files-icon";
        icon.textContent = entry.dir ? "📁" : "📄";
        const name = document.createElement("span");
        name.className = "files-name";
        name.textContent = entry.name;
        el.append(twisty, icon, name);
        return el;
      }),
    );
  }

  function button(label: string, onClick: () => unknown) {
    const b = document.createElement("button");
    b.textContent = label;
    b.addEventListener("click", () => onClick());
    return b;
  }

  function scrollToCursor() {
    tree.querySelector(".files-row.cursor")?.scrollIntoView({ block: "nearest" });
  }

  // ---- 作業フォルダ ----

  /** 作業フォルダを切り替える（ツリーは空にするだけ。読み込みは呼び出し側） */
  function useRoot(dir: string) {
    root = dir;
    localStorage.setItem(ROOT_KEY, dir);
    addRecent(dir);
    children.clear();
    expanded.clear();
    cursor = null;
  }

  async function setRoot(dir: string) {
    useRoot(dir);
    await stopWatch();
    if (!isOpen()) return;
    await reload();
    await startWatch();
    if (activeFile) await reveal(activeFile);
  }

  async function pickFolder() {
    const picked = await openDialog({ directory: true, multiple: false, defaultPath: root ?? undefined });
    if (typeof picked === "string") await setRoot(picked);
  }

  async function retry() {
    await reload();
    await startWatch();
    if (activeFile) await reveal(activeFile);
  }

  /** ファイルが作業フォルダ内にあれば、途中のフォルダを開いて見えるようにする */
  async function reveal(path: string) {
    if (!root || missing || !isUnder(path, root)) return;
    const chain: string[] = [];
    for (let d = dirname(path); isUnder(d, root); d = dirname(d)) chain.unshift(d);
    for (const d of chain) {
      expanded.add(keyOf(d));
      if (!children.has(keyOf(d))) await load(d);
    }
    cursor = path;
    render();
    tree.querySelector(".files-row.active")?.scrollIntoView({ block: "nearest" });
  }

  // ---- 開閉と幅 ----

  function applyWidth(px: number) {
    workspace.style.setProperty("--files-width", `${px}px`);
  }

  async function show(focus: boolean) {
    panel.hidden = false;
    divider.hidden = false;
    toggleBtn.classList.add("active");
    localStorage.setItem(OPEN_KEY, "1");
    // 初めて開いたときは、アクティブなタブのファイルのフォルダを作業フォルダにする
    if (!root) {
      const p = opts.activePath();
      if (p) useRoot(dirname(p));
    }
    await reload();
    await startWatch();
    if (activeFile) await reveal(activeFile);
    if (focus) tree.focus();
  }

  function hide() {
    const hadFocus = panel.contains(document.activeElement);
    panel.hidden = true;
    divider.hidden = true;
    toggleBtn.classList.remove("active");
    localStorage.setItem(OPEN_KEY, "0");
    closeMenu();
    void stopWatch();
    if (hadFocus) opts.onClose();
  }

  function toggle() {
    if (!isFilePanelEnabled()) return;
    if (isOpen()) hide();
    else void show(true);
  }

  /** 設定「ファイルパネルを使う」を切り替える。オフにするとボタンも消える */
  function setEnabled(on: boolean) {
    localStorage.setItem(ENABLED_KEY, on ? "1" : "0");
    toggleBtn.hidden = !on;
    if (!on && isOpen()) {
      hide();
      // 使わないあいだも、再びオンにしたときの開閉は前回どおりにする
      localStorage.setItem(OPEN_KEY, "1");
    } else if (on && localStorage.getItem(OPEN_KEY) === "1") void show(false);
  }

  divider.addEventListener("pointerdown", (e) => {
    divider.setPointerCapture(e.pointerId);
    const right = workspace.getBoundingClientRect().right;
    let width = panel.getBoundingClientRect().width;
    const move = (ev: PointerEvent) => {
      width = Math.round(Math.min(600, Math.max(160, right - ev.clientX)));
      applyWidth(width);
    };
    const up = () => {
      divider.removeEventListener("pointermove", move);
      localStorage.setItem(WIDTH_KEY, String(width));
    };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", up, { once: true });
  });

  // ---- マウス ----

  const entryOf = (target: EventTarget | null): Entry | null => {
    const path = (target as Element | null)?.closest<HTMLElement>(".files-row")?.dataset.path;
    if (!path) return null;
    for (const list of children.values()) for (const e of list) if (e.path === path) return e;
    return null;
  };

  async function toggleDir(entry: Entry, open = !expanded.has(keyOf(entry.path))) {
    if (open) {
      expanded.add(keyOf(entry.path));
      if (!children.has(keyOf(entry.path))) await load(entry.path);
    } else expanded.delete(keyOf(entry.path));
    render();
  }

  tree.addEventListener("click", (e) => {
    const entry = entryOf(e.target);
    if (!entry) return;
    cursor = entry.path;
    if (entry.dir) void toggleDir(entry);
    else {
      render();
      void opts.openTrial(entry.path);
    }
  });
  tree.addEventListener("dblclick", (e) => {
    const entry = entryOf(e.target);
    if (entry && !entry.dir) void opts.openPinned(entry.path);
  });

  // 右クリックメニュー（パスをコピー・エクスプローラーで表示）
  tree.addEventListener("contextmenu", (e) => {
    const entry = entryOf(e.target);
    e.preventDefault();
    if (!entry) return;
    cursor = entry.path;
    render();
    showMenu(entry, e);
  });
  function showMenu(entry: Entry, e: MouseEvent) {
    menuTarget = entry;
    menu.hidden = false;
    const { innerWidth, innerHeight } = window;
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(e.clientX, innerWidth - r.width - 4)}px`;
    menu.style.top = `${Math.min(e.clientY, innerHeight - r.height - 4)}px`;
  }
  function closeMenu() {
    menu.hidden = true;
    menuTarget = null;
  }
  menu.addEventListener("click", async (e) => {
    const action = (e.target as Element).closest<HTMLElement>("[data-action]")?.dataset.action;
    const target = menuTarget;
    closeMenu();
    if (!target) return;
    if (action === "copy") await navigator.clipboard.writeText(target.path).catch(() => undefined);
    else if (action === "reveal") await revealItemInDir(target.path).catch(() => undefined);
  });
  window.addEventListener("pointerdown", (e) => !menu.contains(e.target as Node) && closeMenu(), true);
  window.addEventListener("blur", closeMenu);

  // ---- キーボード ----

  tree.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (!menu.hidden && e.key === "Escape") return void closeMenu();
    const rows = visibleRows();
    if (!rows.length) return;
    let i = cursor ? rows.findIndex((r) => keyOf(r.entry.path) === keyOf(cursor!)) : -1;
    const cur = i >= 0 ? rows[i] : null;
    const move = (j: number) => {
      i = Math.max(0, Math.min(rows.length - 1, j));
      cursor = rows[i].entry.path;
      render();
      scrollToCursor();
    };
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    switch (e.key) {
      case "ArrowDown":
        handled();
        move(cur ? i + 1 : 0);
        break;
      case "ArrowUp":
        handled();
        move(cur ? i - 1 : 0);
        break;
      case "Home":
        handled();
        move(0);
        break;
      case "End":
        handled();
        move(rows.length - 1);
        break;
      case "ArrowRight":
        handled();
        if (!cur?.entry.dir) break;
        if (!expanded.has(keyOf(cur.entry.path))) void toggleDir(cur.entry, true);
        else if (rows[i + 1]?.depth > cur.depth) move(i + 1);
        break;
      case "ArrowLeft": {
        handled();
        if (!cur) break;
        if (cur.entry.dir && expanded.has(keyOf(cur.entry.path))) {
          void toggleDir(cur.entry, false);
          break;
        }
        // 親フォルダへ
        for (let j = i - 1; j >= 0; j--) if (rows[j].depth < cur.depth) return move(j);
        break;
      }
      case "Enter":
        handled();
        if (!cur) break;
        if (cur.entry.dir) void toggleDir(cur.entry);
        else void opts.openPinned(cur.entry.path);
        break;
      case " ":
        handled();
        if (!cur) break;
        if (cur.entry.dir) void toggleDir(cur.entry);
        else void opts.openTrial(cur.entry.path);
        break;
    }
  });
  // フォーカスが来たら、まだ選んでいなければアクティブなファイル（なければ先頭）を選ぶ
  tree.addEventListener("focus", () => {
    if (cursor) return;
    const rows = visibleRows();
    const hit = activeFile && rows.find((r) => keyOf(r.entry.path) === keyOf(activeFile!));
    cursor = hit ? hit.entry.path : (rows[0]?.entry.path ?? null);
    render();
  });

  // ---- 最近使ったフォルダ ----

  function saveRecent() {
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    } catch {
      // 保存できなくても動作には影響しない
    }
  }

  function addRecent(dir: string) {
    // 後から件数を増やしても出せるよう、上限まで記録しておく（今の作業フォルダの分 1 件多く）
    recent = [dir, ...recent.filter((p) => keyOf(p) !== keyOf(dir))].slice(0, RECENT_COUNT_MAX + 1);
    saveRecent();
    renderRecent();
  }

  function removeRecent(dir: string) {
    recent = recent.filter((p) => keyOf(p) !== keyOf(dir));
    saveRecent();
    renderRecent();
  }

  /** 今の作業フォルダを除いて、新しい順に出す */
  function renderRecent() {
    const shown = recent.filter((p) => !root || keyOf(p) !== keyOf(root)).slice(0, getRecentCount());
    recentSection.hidden = !shown.length;
    recentList.replaceChildren(
      ...shown.map((path) => {
        const el = document.createElement("div");
        el.className = "files-row";
        el.setAttribute("role", "listitem");
        el.dataset.path = path;
        el.title = path;
        const icon = document.createElement("span");
        icon.className = "files-icon";
        icon.textContent = "📁";
        const name = document.createElement("span");
        name.className = "files-name";
        // ドライブ直下（C:\ など）は名前がないのでパスをそのまま出す
        name.textContent = basename(path) || path;
        const parent = document.createElement("span");
        parent.className = "files-dir";
        parent.textContent = dirname(path);
        el.append(icon, name, parent);
        return el;
      }),
    );
  }

  const recentOf = (target: EventTarget | null) =>
    (target as Element | null)?.closest<HTMLElement>(".files-row")?.dataset.path ?? null;

  /** 作業フォルダにする。見つからなくなったフォルダは一覧から外す */
  async function openRecent(dir: string) {
    if (await invoke<boolean>("is_dir", { path: dir })) return setRoot(dir);
    removeRecent(dir);
    await message(`フォルダが見つかりません。一覧から外しました。\n${dir}`, { title: "Markdown Preview", kind: "warning" });
  }

  recentList.addEventListener("click", (e) => {
    const path = recentOf(e.target);
    if (path) void openRecent(path);
  });
  recentList.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const path = recentOf(e.target);
    if (path) showMenu({ name: basename(path), path, dir: true }, e);
  });

  // ---- ボタン・外部の変化 ----

  toggleBtn.addEventListener("click", () => toggle());
  $("files-pick").addEventListener("click", () => void pickFolder());
  $("files-refresh").addEventListener("click", () => void retry());

  void listen<string[]>("folder-changed", async (e) => {
    if (!isOpen() || !root) return;
    let changed = false;
    for (const dir of e.payload) {
      const k = keyOf(dir);
      if (k !== keyOf(root) && !expanded.has(k)) continue;
      if (!(await load(dir)) && k === keyOf(root)) missing = true;
      changed = true;
    }
    if (changed) render();
  });

  // ---- 起動 ----

  applyWidth(Number(localStorage.getItem(WIDTH_KEY)) || DEFAULT_WIDTH);
  // 試作版の「最近使ったファイル」の記録は使わなくなったので消す
  localStorage.removeItem("files.recent");
  // 最近使ったフォルダを作る前から作業フォルダを使っていた人の分も記録する
  if (root) addRecent(root);
  else renderRecent();
  toggleBtn.hidden = !isFilePanelEnabled();
  // 初回は閉じた状態（アップデート直後に画面が急に狭くならないように）
  if (isFilePanelEnabled() && localStorage.getItem(OPEN_KEY) === "1") void show(false);

  return {
    toggle,
    setEnabled,
    /** 設定「最近使ったフォルダの表示件数」を変える */
    setRecentCount(n: number) {
      localStorage.setItem(RECENT_COUNT_KEY, String(Math.min(RECENT_COUNT_MAX, Math.max(0, Math.round(n)))));
      renderRecent();
    },
    /** フォルダを作業フォルダにしてパネルを開く（フォルダのドロップ） */
    async openFolder(dir: string) {
      if (!isFilePanelEnabled()) return;
      if (!isOpen()) {
        useRoot(dir);
        await show(false);
      } else await setRoot(dir);
    },
    /** アクティブなタブが変わったら呼ぶ。作業フォルダ内なら強調してフォルダを開く */
    setActive(path: string | null) {
      if (path === activeFile) return;
      activeFile = path;
      if (!isOpen()) return;
      if (path) void reveal(path);
      else render();
    },
  };
}
