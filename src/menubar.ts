import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ThemePref } from "./theme";
import { DOC_STYLES, type DocStyle } from "./docstyle";
import type { TermPosition } from "./terminal";

// ---------- メニューバー（Windows 標準のメニュー） ----------
// ショートカットキーの処理は main.ts の keydown に一本化し、メニューには "\tCtrl+S" のように
// 表示だけ付ける。Tauri のアクセラレータは WebView2 にフォーカスがあると効かないため（docs/adr/0003）

export type Mode = "editor" | "split" | "preview";

export interface MenuActions {
  newFile(): void;
  open(): void;
  openPath(): void;
  save(): void;
  saveAs(): void;
  pdf(): void;
  exportTab(): void;
  copyPath(): void;
  closeTab(): void;
  quit(): void;
  undo(): void;
  redo(): void;
  find(): void;
  replace(): void;
  selectNextMatch(): void;
  selectAllMatches(): void;
  setMode(mode: Mode): void;
  toggleFilePanel(): void;
  toggleTerminal(): void;
  setTerminalPosition(position: TermPosition): void;
  zoomIn(): void;
  zoomOut(): void;
  zoomReset(): void;
  setTheme(pref: ThemePref): void;
  setDocStyle(style: DocStyle): void;
  reload(): void;
  diagram(): void;
  annotate(): void;
  settings(): void;
  collab(): void;
  help(): void;
  checkUpdate(): void;
  about(): void;
}

/** メニューに映す状態。ダイアログ（設定・PDF・注釈など）を開いている間は modal */
interface MenuState {
  mode: Mode;
  theme: ThemePref;
  docStyle: DocStyle;
  filePanelOpen: boolean;
  filePanelEnabled: boolean;
  terminalOpen: boolean;
  terminalPosition: TermPosition;
  canCopyPath: boolean;
  modal: boolean;
}

/** メニューを開くアクセスキー（ファイル(F) の F など）。Alt+キーを main.ts で拾って開く */
export const MENU_KEYS = ["f", "e", "v", "i", "t", "h"];

const MODES: [Mode, string, string][] = [
  ["editor", "エディタのみ", "Ctrl+1"],
  ["split", "分割", "Ctrl+2"],
  ["preview", "プレビューのみ", "Ctrl+3"],
];
const THEMES: [ThemePref, string][] = [
  ["system", "自動"],
  ["light", "ライト"],
  ["dark", "ダーク"],
];

const TERM_POSITIONS: [TermPosition, string][] = [
  ["bottom", "下"],
  ["right", "右"],
];

/** top の中の「ツール」の位置 */
const TOOLS = 4;

const label = (text: string, keys?: string) => (keys ? `${text}\t${keys}` : text);

export function setupMenuBar(actions: MenuActions, initial: MenuState) {
  const state = { ...initial };

  const item = (text: string, keys: string | undefined, action: () => void) =>
    MenuItem.new({ text: label(text, keys), action: () => action() });
  const sep = () => PredefinedMenuItem.new({ item: "Separator" });
  /** チェック項目はクリックで勝手に反転するので、実行したあと state に合わせて付け直す */
  const checked = (action: () => void) => {
    action();
    update({});
  };

  type Entry = MenuItem | PredefinedMenuItem | CheckMenuItem | Submenu;
  /** サブメニュー。項目の作成（1 つずつ Rust を呼ぶ）を順に待たず、まとめて並行に作る */
  const sub = async (text: string, items: (Entry | Promise<Entry | Entry[]>)[]) =>
    Submenu.new({ text, items: (await Promise.all(items)).flat() });

  const ready = (async () => {
    const copyPath = item("パスをコピー", "Ctrl+Shift+C", actions.copyPath);
    const modeItems = Promise.all(
      MODES.map(([mode, text, keys]) =>
        CheckMenuItem.new({ text: label(text, keys), checked: mode === state.mode, action: () => checked(() => actions.setMode(mode)) }),
      ),
    );
    const themeItems = Promise.all(
      THEMES.map(([pref, text]) =>
        CheckMenuItem.new({ text, checked: pref === state.theme, action: () => checked(() => actions.setTheme(pref)) }),
      ),
    );
    const docStyleItems = Promise.all(
      DOC_STYLES.map(([style, text]) =>
        CheckMenuItem.new({ text, checked: style === state.docStyle, action: () => checked(() => actions.setDocStyle(style)) }),
      ),
    );
    const filePanel = CheckMenuItem.new({
      text: label("ファイルパネル", "Ctrl+B"),
      checked: state.filePanelOpen,
      enabled: state.filePanelEnabled,
      action: () => checked(actions.toggleFilePanel),
    });
    const terminal = CheckMenuItem.new({
      text: label("ターミナル", "Ctrl+@"),
      checked: state.terminalOpen,
      action: () => checked(actions.toggleTerminal),
    });
    const termPositionItems = Promise.all(
      TERM_POSITIONS.map(([pos, text]) =>
        CheckMenuItem.new({ text, checked: pos === state.terminalPosition, action: () => checked(() => actions.setTerminalPosition(pos)) }),
      ),
    );

    const top = await Promise.all([
      sub("ファイル(&F)", [
        item("新規", "Ctrl+N", actions.newFile),
        item("開く…", "Ctrl+O", actions.open),
        item("パスで開く…", "Ctrl+Shift+O", actions.openPath),
        sep(),
        item("保存", "Ctrl+S", actions.save),
        item("名前を付けて保存…", "Ctrl+Shift+S", actions.saveAs),
        sep(),
        item("PDF に出力…", "Ctrl+P", actions.pdf),
        item("エクスポート…", undefined, actions.exportTab),
        sep(),
        copyPath,
        sep(),
        item("タブを閉じる", "Ctrl+W", actions.closeTab),
        item("終了", "Alt+F4", actions.quit),
      ]),
      sub("編集(&E)", [
        item("元に戻す", "Ctrl+Z", actions.undo),
        item("やり直し", "Ctrl+Y", actions.redo),
        sep(),
        // 切り取り・コピー・貼り付けは、フォーカスのある所（エディタ・プレビュー・入力欄）にキーを送る既定の項目
        PredefinedMenuItem.new({ item: "Cut", text: "切り取り" }),
        PredefinedMenuItem.new({ item: "Copy", text: "コピー" }),
        PredefinedMenuItem.new({ item: "Paste", text: "貼り付け" }),
        PredefinedMenuItem.new({ item: "SelectAll", text: "すべて選択" }),
        sep(),
        item("検索", "Ctrl+F", actions.find),
        item("置換", "Ctrl+H", actions.replace),
        sep(),
        item("次の一致を選択に追加", "Ctrl+D", actions.selectNextMatch),
        item("すべての一致を選択", "Ctrl+Shift+L", actions.selectAllMatches),
      ]),
      sub("表示(&V)", [
        modeItems,
        sep(),
        filePanel,
        terminal,
        sub("ターミナルの位置", [termPositionItems]),
        sep(),
        item("拡大", "Ctrl++", actions.zoomIn),
        item("縮小", "Ctrl+-", actions.zoomOut),
        item("100% に戻す", "Ctrl+0", actions.zoomReset),
        sep(),
        sub("テーマ", [themeItems]),
        sub("文書スタイル", [docStyleItems]),
        sep(),
        item("再読み込み", "F5", actions.reload),
      ]),
      sub("挿入(&I)", [
        item("図…", "Ctrl+Shift+D", actions.diagram),
        item("画像の注釈…", "Ctrl+Shift+A", actions.annotate),
      ]),
      sub("ツール(&T)", [item("設定…", "Ctrl+,", actions.settings)]),
      sub("ヘルプ(&H)", [
        item("書き方ヘルプ", "F1", actions.help),
        sep(),
        item("更新を確認", undefined, actions.checkUpdate),
        item("バージョン情報", undefined, actions.about),
      ]),
    ]);
    const menu = await Menu.new({ items: top });
    await menu.setAsWindowMenu(getCurrentWindow());
    return { top, copyPath: await copyPath, modeItems: await modeItems, themeItems: await themeItems, docStyleItems: await docStyleItems, filePanel: await filePanel, terminal: await terminal, termPositionItems: await termPositionItems };
  })();

  /** 今の state をメニューに映す（チェックは毎回すべて付け直す） */
  const apply = async () => {
    const m = await ready;
    await Promise.all([
      ...m.top.map((s) => s.setEnabled(!state.modal)),
      m.copyPath.setEnabled(state.canCopyPath),
      ...m.modeItems.map((it, i) => it.setChecked(MODES[i][0] === state.mode)),
      ...m.themeItems.map((it, i) => it.setChecked(THEMES[i][0] === state.theme)),
      ...m.docStyleItems.map((it, i) => it.setChecked(DOC_STYLES[i][0] === state.docStyle)),
      m.filePanel.setChecked(state.filePanelOpen),
      m.filePanel.setEnabled(state.filePanelEnabled),
      m.terminal.setChecked(state.terminalOpen),
      ...m.termPositionItems.map((it, i) => it.setChecked(TERM_POSITIONS[i][0] === state.terminalPosition)),
    ]);
  };
  let collab: Promise<MenuItem | null> = Promise.resolve(null);
  // 連続して呼ばれても順番に映す（古い状態で上書きしないよう、最後に最新の state を映す）
  let queue = Promise.resolve();
  const update = (patch: Partial<MenuState>) => {
    Object.assign(state, patch);
    queue = queue.then(apply).catch((err) => console.error("menu", err));
  };

  return {
    ready,
    setMode: (mode: Mode) => update({ mode }),
    setTheme: (theme: ThemePref) => update({ theme }),
    setDocStyle: (docStyle: DocStyle) => update({ docStyle }),
    setFilePanel: (filePanelOpen: boolean, filePanelEnabled: boolean) => update({ filePanelOpen, filePanelEnabled }),
    setTerminal: (terminalOpen: boolean, terminalPosition: TermPosition) => update({ terminalOpen, terminalPosition }),
    setCanCopyPath: (canCopyPath: boolean) => update({ canCopyPath }),
    setModal: (modal: boolean) => modal !== state.modal && update({ modal }),
    /** 「ツール」の先頭に「共同編集」を出す（共同編集プラグインがあるときだけ）。label は人数入りの表示名 */
    setCollab: (text: string) => {
      collab = collab.then(async (it) => {
        if (it) {
          await it.setText(text);
          return it;
        }
        const m = await ready;
        const created = await MenuItem.new({ text, action: () => actions.collab() });
        await m.top[TOOLS].insert([created, await sep()], 0);
        return created;
      });
      collab.catch((err) => console.error("menu", err));
    },
  };
}
