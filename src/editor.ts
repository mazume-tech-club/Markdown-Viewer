import { EditorView, basicSetup } from "codemirror";
import { Compartment, EditorSelection, EditorState, Prec, type SelectionRange } from "@codemirror/state";
import { keymap, type Command } from "@codemirror/view";
import { indentLess, insertTab, redo, undo } from "@codemirror/commands";
import { openSearchPanel, selectNextOccurrence, selectSelectionMatches } from "@codemirror/search";
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
  /** カーソル行の画像（![alt](src)）と、次の行の注釈のコメント。無ければ null */
  imageAtCursor(): ImageRef | null;
  /** 0 始まりの行・列にカーソルを置く */
  setCursor(line: number, ch: number): void;
  /** 検索パネルを開く。replace なら置換の入力欄にフォーカスする */
  openSearch(replace: boolean): void;
  /** 選択中の文字列の次の一致を選択に加える（Ctrl+D） */
  selectNextMatch(): void;
  /** 選択中の文字列（選択がなければカーソル位置の単語）の一致をすべて選択する（Ctrl+Shift+L） */
  selectAllMatches(): void;
  undo(): void;
  redo(): void;
}

/** 画像の Markdown の位置（注釈の編集用） */
export interface ImageRef {
  /** ![ の位置 */
  from: number;
  /** ) の直後 */
  to: number;
  /** 画像の行の末尾 */
  lineEnd: number;
  /** 注釈のコメントの行の末尾（コメントが無ければ lineEnd） */
  end: number;
  alt: string;
  /** リンクに書かれたままのパス（%20 などはそのまま） */
  src: string;
  /** 注釈のコメントの中身（JSON）。無ければ null */
  annotate: string | null;
  /** 同じ行で、この画像より後ろにも画像がある（注釈は段落の最後の画像に付くので編集できない） */
  laterImage: boolean;
}

const IMAGE_RE = /!\[([^\]]*)\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+"[^"]*")?\s*\)/g;
const ANNOTATE_LINE = /^\s*<!--\s*annotate\s+(.*?)\s*-->\s*$/;

export interface CodeBlock {
  from: number;
  to: number;
  /** 言語名（```c4 の c4）。小文字 */
  lang: string;
  /** 囲みの行を除いた中身 */
  body: string;
}

/** 検索パネルなどの文言（CodeMirror の phrase）を日本語にする */
const PHRASES_JA: Record<string, string> = {
  Find: "検索",
  Replace: "置換",
  next: "次へ",
  previous: "前へ",
  all: "すべて選択",
  "match case": "大文字と小文字を区別",
  regexp: "正規表現",
  "by word": "単語単位",
  replace: "置換",
  "replace all": "すべて置換",
  close: "閉じる",
  "current match": "現在の一致",
  "replaced $ matches": "$ 件を置換しました",
  "replaced match on line $": "$ 行目を置換しました",
  "on line": "行目",
  "Go to line": "行へ移動",
  go: "移動",
};

/** 検索パネルを開き、置換の入力欄にフォーカスする（VS Code の Ctrl+H） */
const openReplacePanel: Command = (view) => {
  openSearchPanel(view);
  const input = view.dom.querySelector<HTMLInputElement>(".cm-search input[name=replace]");
  input?.focus();
  input?.select();
  return true;
};

/** 一致をすべて選択する。選択がなければ、先にカーソル位置の単語を選ぶ（VS Code の Ctrl+Shift+L / Ctrl+F2） */
const selectAllMatchesCmd: Command = (view) => {
  if (view.state.selection.main.empty) selectNextOccurrence(view);
  return selectSelectionMatches(view);
};

/** 選択した各行の末尾にカーソルを置く（VS Code の Shift+Alt+I） */
const cursorsAtLineEnds: Command = ({ state, dispatch }) => {
  const ranges: SelectionRange[] = [];
  for (const r of state.selection.ranges) {
    const last = state.doc.lineAt(r.to).number;
    // 次の行の先頭までの選択は、その行を含めない
    const end = r.to > r.from && state.doc.lineAt(r.to).from === r.to ? last - 1 : last;
    for (let n = state.doc.lineAt(r.from).number; n <= end; n++) ranges.push(EditorSelection.cursor(state.doc.line(n).to));
  }
  if (ranges.length < 2) return false;
  dispatch(state.update({ selection: EditorSelection.create(ranges), scrollIntoView: true, userEvent: "select" }));
  return true;
};

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
        // VS Code と同じキー（Ctrl+D・Ctrl+Alt+↑↓・Ctrl+U は basicSetup にある）
        Prec.high(
          keymap.of([
            { key: "Mod-h", run: openReplacePanel, preventDefault: true },
            { key: "Mod-Shift-l", run: selectAllMatchesCmd, preventDefault: true },
            { key: "Mod-F2", run: selectAllMatchesCmd, preventDefault: true },
            { key: "Shift-Alt-i", run: cursorsAtLineEnds, preventDefault: true },
          ]),
        ),
        EditorState.phrases.of(PHRASES_JA),
        theme.of(themeExt()),
        readOnly.of(readOnlyExt()),
        EditorView.domEventHandlers({
          // Alt+クリックでカーソルを足す（VS Code と同じ）。矩形選択は Shift+Alt+ドラッグ
          mousedown(e, view) {
            if (!e.altKey || e.shiftKey || e.ctrlKey || e.button !== 0) return false;
            const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
            if (pos == null) return false;
            e.preventDefault();
            view.focus();
            view.dispatch({ selection: view.state.selection.addRange(EditorSelection.cursor(pos)), userEvent: "select.pointer" });
            return true;
          },
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
    imageAtCursor() {
      const doc = view.state.doc;
      const head = view.state.selection.main.head;
      const line = doc.lineAt(head);
      const found = [...line.text.matchAll(IMAGE_RE)];
      if (!found.length) return null;
      // カーソルが画像の上にあればその画像、なければ行の最初の画像
      const i = Math.max(0, found.findIndex((m) => head >= line.from + m.index && head <= line.from + m.index + m[0].length));
      const m = found[i];
      const from = line.from + m.index;
      const next = line.number < doc.lines ? doc.line(line.number + 1) : null;
      const comment = next ? ANNOTATE_LINE.exec(next.text) : null;
      const laterImage = i < found.length - 1;
      return {
        from,
        to: from + m[0].length,
        lineEnd: line.to,
        end: comment && !laterImage ? next!.to : line.to,
        alt: m[1],
        src: m[2].replace(/^<(.*)>$/, "$1"),
        annotate: comment && !laterImage ? comment[1] : null,
        laterImage,
      };
    },
    setCursor(line, ch) {
      const doc = view.state.doc;
      const l = doc.line(Math.max(1, Math.min(line + 1, doc.lines)));
      view.dispatch({ selection: { anchor: Math.min(l.from + ch, l.to) }, scrollIntoView: true });
    },
    openSearch(replace) {
      view.focus();
      if (replace) openReplacePanel(view);
      else openSearchPanel(view);
    },
    selectNextMatch() {
      view.focus();
      selectNextOccurrence(view);
    },
    selectAllMatches() {
      view.focus();
      selectAllMatchesCmd(view);
    },
    undo() {
      view.focus();
      undo(view);
    },
    redo() {
      view.focus();
      redo(view);
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
