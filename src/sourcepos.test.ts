import { describe, expect, it } from "vitest";
import { findSourcePos } from "./sourcepos";

const src = (text: string) => text.split("\n");

describe("findSourcePos", () => {
  it("見出しの記号の後ろの文字に合わせる", () => {
    const lines = src("# はじめに\n\n本文");
    expect(findSourcePos(lines, 0, 1, "はじめに", 2, "")).toEqual({ line: 0, ch: 4 });
  });

  it("太字の中の文字に合わせる", () => {
    const lines = src("前の文 **大事** 後ろの文");
    expect(findSourcePos(lines, 0, 1, "大事", 1, "前の文 ")).toEqual({ line: 0, ch: 7 });
  });

  it("同じ文字列が何度も出るときは、プレビューと同じ番目を選ぶ", () => {
    const lines = src("abc と **abc** と abc");
    expect(findSourcePos(lines, 0, 1, "abc", 1, "abc と abc と ")).toEqual({ line: 0, ch: 17 });
  });

  it("段落内の改行の後ろの行に合わせる", () => {
    const lines = src("- 1 行目\n  2 行目の文");
    expect(findSourcePos(lines, 0, 2, "1 行目\n2 行目の文", 7, "")).toEqual({ line: 1, ch: 4 });
  });

  it("ブロックの範囲の外は探さない", () => {
    const lines = src("同じ文\n\n同じ文");
    expect(findSourcePos(lines, 2, 3, "同じ文", 1, "")).toEqual({ line: 2, ch: 1 });
  });

  it("見つからなければ null", () => {
    const lines = src("A &amp; B");
    expect(findSourcePos(lines, 0, 1, "A & B", 3, "")).toBeNull();
  });
});
