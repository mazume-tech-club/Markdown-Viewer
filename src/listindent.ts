// Tab の字下げ。箇条書きの行では、記号ごと行を字下げする（入れ子の箇条書きを作るため）
import type { EditorState, Transaction } from "@codemirror/state";
import { indentMore, insertTab } from "@codemirror/commands";

/** 箇条書きの行か（*・-・+・1.・1) の後ろが空白か行末。**太字** や --- は当てはまらない） */
export const isListLine = (text: string) => /^\s*(?:[-*+]|\d+[.)])(?:\s|$)/.test(text);

type Target = { state: EditorState; dispatch: (tr: Transaction) => void };

/**
 * 範囲を選んでおらず、カーソルが全部箇条書きの行にあれば、カーソルの位置に関係なく行ごと字下げする。
 * それ以外は insertTab（範囲を選んでいれば行ごと字下げ、ふつうの行ならタブ文字）
 */
export function indentListOrTab(target: Target): boolean {
  const { state } = target;
  const ranges = state.selection.ranges;
  if (ranges.every((r) => r.empty && isListLine(state.doc.lineAt(r.head).text))) return indentMore(target);
  return insertTab(target);
}
