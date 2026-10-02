import { EditorView, basicSetup } from "codemirror";
import { Compartment, EditorState } from "@codemirror/state";
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
}

/** 画像の貼り付けを受け取り、挿入する Markdown を返す（null なら何もしない） */
export type PasteImageHandler = (file: File) => Promise<string | null>;

export function createEditor(
  parent: HTMLElement,
  dark: boolean,
  onChange: () => void,
  onPasteImage: PasteImageHandler,
): Editor {
  const theme = new Compartment();
  const readOnly = new Compartment();
  let silent = false;

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: "",
      extensions: [
        basicSetup,
        markdown({ codeLanguages: languages }),
        EditorView.lineWrapping,
        theme.of(dark ? oneDark : []),
        readOnly.of([]),
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
        }),
      ],
    }),
  });

  return {
    view,
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
      view.dispatch({ effects: theme.reconfigure(d ? oneDark : []) });
    },
    setReadOnly(on) {
      view.dispatch({
        effects: readOnly.reconfigure(on ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
      });
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
    cursorOffset() {
      const coords = view.coordsAtPos(view.state.selection.main.head);
      if (!coords) return null;
      const rect = view.scrollDOM.getBoundingClientRect();
      const y = coords.top - rect.top;
      return y >= 0 && y <= rect.height ? y : null;
    },
  };
}
