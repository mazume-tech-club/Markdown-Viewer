import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { Editor } from "./editor";

// ---------- 選択で自動コピー・右クリックで貼り付け（Tera Term と同じ操作） ----------
// マウスで選んだときだけコピーする。キーボードで選んで Ctrl+V で置き換える操作を邪魔しないため。
// 右クリックはエディタだけ。メニューを出さず、今のカーソル位置（選択中なら選択の終わり）に貼り付ける

export function setupSelectCopy(opts: {
  editor: Editor;
  preview: HTMLElement;
  enabled: () => boolean;
  /** コピー・貼り付けできたとき（ツールバーに一時的に出す文言） */
  notify: (text: string) => void;
  onError: (err: unknown) => void;
}) {
  const { editor, preview } = opts;
  const view = editor.view;

  const copy = (text: string) => {
    if (!text) return;
    writeText(text).then(() => opts.notify("選択をコピーしました"), opts.onError);
  };

  // マウスのボタンを離したときに選ばれていればコピーする。ドラッグがエディタの外で終わることもあるので window で受ける
  let from: "editor" | "preview" | null = null;
  view.dom.addEventListener("mousedown", (e) => {
    if (e.button === 0) from = "editor";
  });
  preview.addEventListener("mousedown", (e) => {
    if (e.button === 0) from = "preview";
  });
  window.addEventListener("mouseup", (e) => {
    const src = from;
    from = null;
    if (e.button !== 0 || !src || !opts.enabled()) return;
    // ダブルクリック・トリプルクリックの選択が確定してから読む
    setTimeout(() => {
      if (src === "editor") {
        const sel = view.state.selection;
        if (sel.ranges.every((r) => r.empty)) return;
        copy(sel.ranges.map((r) => view.state.sliceDoc(r.from, r.to)).join(view.state.lineBreak));
      } else {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !preview.contains(sel.anchorNode)) return;
        copy(sel.toString());
      }
    });
  });

  view.dom.addEventListener("contextmenu", (e) => {
    if (!opts.enabled()) return;
    e.preventDefault();
    if (view.state.readOnly) return;
    readText()
      .then((text) => {
        if (!text) return;
        const pos = view.state.selection.main.to;
        view.dispatch({
          changes: { from: pos, insert: text },
          selection: { anchor: pos + view.state.toText(text).length },
          scrollIntoView: true,
          userEvent: "input.paste",
        });
        view.focus();
      })
      // 文字以外（画像など）しか入っていないときは貼り付けない
      .catch(() => opts.notify("貼り付けられる文字がありません"));
  });
}
