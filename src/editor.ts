import { EditorView, basicSetup } from "codemirror";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { indentLess, insertTab } from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { oneDark } from "@codemirror/theme-one-dark";

export interface Editor {
  view: EditorView;
  getText(): string;
  /** 内容を丸ごと差し替える（onChange は呼ばない） */
  setText(text: string): void;
  setDark(dark: boolean): void;
  /** 編集できないようにする（更新のダウンロード中など） */
  setReadOnly(readOnly: boolean): void;
  /** カーソル位置に挿入する（行の途中なら前後に改行を補う） */
  insert(text: string): void;
  /** 先頭に見えている行（0 始まり） */
  topLine(): number;
  scrollToLine(line: number): void;
  /** カーソルのある行（0 始まり） */
  cursorLine(): number;
  /** カーソルの、表示領域上端からの位置（px）。画面外なら null */
  cursorOffset(): number | null;
  /** タブ用に、この本文の編集状態（Undo 履歴・カーソル込み）を新しく作る */
  createState(text: string): EditorState;
  getState(): EditorState;
  /** タブの切り替え。テーマと読み取り専用は今の設定で掛け直す */
  setState(state: EditorState): void;
  /** カーソルを含むコードブロック（``` / ~~~ で囲まれた範囲。囲みの行も含む）。無ければ null */
  blockAtCursor(): CodeBlock | null;
  /** from〜to を置き換え、置き換えた末尾にカーソルを置く */
  replaceRange(from: number, to: number, text: string): void;
}

export interface CodeBlock {
  from: number;
  to: number;
  /** 言語名（```c4 の c4）。小文字 */
  lang: string;
  /** 囲みの行を除いた中身 */
  body: string;
}

/** 画像の貼り付けを受け取り、挿入する Markdown を返す（null なら何もしない） */
export type PasteImageHandler = (file: File) => Promise<string | null>;

export function createEditor(
  parent: HTMLElement,
  dark: boolean,
  onChange: () => void,
  onPasteImage: PasteImageHandler,
  onCursorMove: () => void = () => {},
): Editor {
  const theme = new Compartment();
  const readOnly = new Compartment();
  let silent = false;
  let isDark = dark;
  let isReadOnly = false;
  const themeExt = () => (isDark ? oneDark : []);
  const readOnlyExt = () => (isReadOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []);

  const createState = (doc: string) =>
    EditorState.create({
      doc,
      extensions: [
        basicSetup,
        markdown({ codeLanguages: languages }),
        EditorView.lineWrapping,
        // Tab でフォーカスがプレビューへ移らないよう、タブ文字を入れる（範囲選択中は行ごと字下げ）。
        // Shift+Tab は字下げを戻す。字下げの単位もタブ文字にそろえる
        indentUnit.of("\t"),
        Prec.high(keymap.of([{ key: "Tab", run: insertTab, shift: indentLess }])),
        theme.of(themeExt()),
        readOnly.of(readOnlyExt()),
        EditorView.domEventHandlers({
          paste(e, view) {
            const item = [...(e.clipboardData?.items ?? [])].find(
              (i) => i.kind === "file" && i.type.startsWith("image/"),
            );
            const file = item?.getAsFile();
            if (!file) return false;
            e.preventDefault();
            void onPasteImage(file).then((text) => {
              if (text) view.dispatch(view.state.replaceSelection(text));
            });
            return true;
          },
        }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && !silent) onChange();
          if (u.selectionSet) onCursorMove();
        }),
      ],
    });

  const view = new EditorView({ parent, state: createState("") });

  return {
    view,
    createState,
    getState: () => view.state,
    setState(state) {
      view.setState(state);
      view.dispatch({ effects: [theme.reconfigure(themeExt()), readOnly.reconfigure(readOnlyExt())] });
    },
    getText: () => view.state.doc.toString(),
    setText(text) {
      silent = true;
      const head = Math.min(view.state.selection.main.head, text.length);
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: head },
      });
      silent = false;
    },
    insert(text) {
      const { from, to } = view.state.selection.main;
      const line = view.state.doc.lineAt(from);
      const before = from > line.from ? "\n\n" : "";
      const after = to < view.state.doc.lineAt(to).to ? "\n\n" : "\n";
      const insert = `${before}${text}${after}`;
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length },
        scrollIntoView: true,
      });
      view.focus();
    },
    setDark(d) {
      isDark = d;
      view.dispatch({ effects: theme.reconfigure(themeExt()) });
    },
    setReadOnly(on) {
      isReadOnly = on;
      view.dispatch({ effects: readOnly.reconfigure(readOnlyExt()) });
    },
    topLine() {
      const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop);
      return view.state.doc.lineAt(block.from).number - 1;
    },
    scrollToLine(line) {
      const n = Math.max(1, Math.min(line + 1, view.state.doc.lines));
      const block = view.lineBlockAt(view.state.doc.line(n).from);
      view.scrollDOM.scrollTop = block.top;
    },
    cursorLine() {
      return view.state.doc.lineAt(view.state.selection.main.head).number - 1;
    },
    blockAtCursor() {
      const doc = view.state.doc;
      const cursor = doc.lineAt(view.state.selection.main.head).number;
      // 先頭から囲みの開始・終了をたどる（中身に ``` を含む ~~~ ブロックなどがあるため）
      let open: { line: number; ch: string; len: number; lang: string } | null = null;
      for (let n = 1; n <= doc.lines; n++) {
        const text = doc.line(n).text;
        if (!open) {
          const m = /^\s{0,3}(`{3,}|~{3,})\s*([\w-]*)/.exec(text);
          if (m) open = { line: n, ch: m[1][0], len: m[1].length, lang: m[2].toLowerCase() };
          if (n > cursor) return null;
          continue;
        }
        const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(text);
        if (!close || close[1][0] !== open.ch || close[1].length < open.len) continue;
        if (cursor >= open.line && cursor <= n) {
          const body = open.line + 1 < n ? doc.sliceString(doc.line(open.line + 1).from, doc.line(n - 1).to) : "";
          return { from: doc.line(open.line).from, to: doc.line(n).to, lang: open.lang, body };
        }
        open = null;
      }
      return null;
    },
    replaceRange(from, to, text) {
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
        scrollIntoView: true,
      });
      view.focus();
    },
    cursorOffset() {
      const coords = view.coordsAtPos(view.state.selection.main.head);
      if (!coords) return null;
      const rect = view.scrollDOM.getBoundingClientRect();
      const y = coords.top - rect.top;
      return y >= 0 && y <= rect.height ? y : null;
    },
  };
}
