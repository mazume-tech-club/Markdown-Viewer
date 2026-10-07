// 共同編集中のタブに付ける CodeMirror の extension
import { EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";

import type { CollabSession } from "./session";

const readOnly: Extension = [EditorState.readOnly.of(true), EditorView.editable.of(false)];

/**
 * セッションの状態に合わせた extension。
 * - 書ける間は Y.Text と同期し、名前付きカーソルを出す。Ctrl+Z は自分の編集だけを戻す
 *   （CodeMirror の履歴はほかの人の編集も戻してしまうので、Yjs の UndoManager を優先する）
 * - 参加者は、ホストの内容が届くまでと、終わったあとは読み取り専用
 * - ホストは、終わったらふつうのタブに戻る
 */
export function collabExtension(s: CollabSession): Extension {
  if (s.status === "closed") return s.role === "guest" ? readOnly : [];
  if (s.role === "guest" && s.status !== "live") return readOnly;
  return [yCollab(s.text, s.awareness, { undoManager: s.undoManager }), Prec.highest(keymap.of(yUndoManagerKeymap))];
}
