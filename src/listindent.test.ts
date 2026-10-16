import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { indentUnit } from "@codemirror/language";

import { indentListOrTab, isListLine } from "./listindent";

/** 「|」の位置にカーソルを置いて Tab を押し、結果の本文とカーソルの位置（「|」）を返す */
function tab(text: string, select?: { from: number; to: number }) {
  const at = text.indexOf("|");
  const doc = at >= 0 ? text.slice(0, at) + text.slice(at + 1) : text;
  let state = EditorState.create({
    doc,
    selection: select ? EditorSelection.range(select.from, select.to) : EditorSelection.cursor(at),
    extensions: [indentUnit.of("\t")],
  });
  indentListOrTab({ state, dispatch: (tr) => (state = tr.state) });
  const s = state.doc.toString();
  const head = state.selection.main.head;
  return select ? s : s.slice(0, head) + "|" + s.slice(head);
}

describe("箇条書きの行で Tab", () => {
  it("記号ごと行を字下げし、カーソルは同じ文字の前に残る", () => {
    expect(tab("* 項|目")).toBe("\t* 項|目");
    expect(tab("|* 項目")).toBe("\t|* 項目");
  });

  it("- や番号付き、チェックボックス、記号だけの行も字下げする", () => {
    expect(tab("- [ ] や|る")).toBe("\t- [ ] や|る");
    expect(tab("1. 一つ目|")).toBe("\t1. 一つ目|");
    expect(tab("\t+ 二段目|")).toBe("\t\t+ 二段目|");
    expect(tab("* |")).toBe("\t* |");
  });

  it("ふつうの行や **太字** の行では、今までどおりタブ文字を入れる", () => {
    expect(tab("あ|い")).toBe("あ\t|い");
    expect(tab("**太|字**")).toBe("**太\t|字**");
    expect(tab("--|-")).toBe("--\t|-");
  });

  it("範囲を選んでいれば、今までどおり選んだ行を字下げする", () => {
    expect(tab("あ\nい", { from: 0, to: 3 })).toBe("\tあ\n\tい");
  });
});

describe("isListLine", () => {
  it("箇条書きの記号の後ろが空白か行末なら箇条書き", () => {
    expect(["* a", "- a", "+ a", "1. a", "10) a", "  * a", "*"].every(isListLine)).toBe(true);
    expect(["*a", "**a**", "---", "1.5", "a * b", ""].some(isListLine)).toBe(false);
  });
});
