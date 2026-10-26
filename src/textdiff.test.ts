import { describe, expect, it } from "vitest";
import { changedRange, mergeChange } from "./textdiff";

const apply = (old: string, next: string) => {
  const r = changedRange(old, next);
  return r ? old.slice(0, r.start) + next.slice(r.start, r.newEnd) + old.slice(r.oldEnd) : old;
};

describe("changedRange", () => {
  it("covers only the changed middle", () => {
    expect(changedRange("abcdef", "abXYef")).toEqual({ start: 2, oldEnd: 4, newEnd: 4 });
    expect(changedRange("abc", "abc")).toBeNull();
    expect(changedRange("aaa", "aaaa")).toEqual({ start: 3, oldEnd: 3, newEnd: 4 });
  });

  it("does not split surrogate pairs", () => {
    const r = changedRange("x😀y", "x😃y")!;
    expect(r.start).toBe(1);
    expect(apply("x😀y", "x😃y")).toBe("x😃y");
  });
});

describe("mergeChange", () => {
  const merge = (base: string, cur: string, next: string) => {
    const m = mergeChange(base, cur, next);
    return m === null || m === "conflict" ? m : cur.slice(0, m.from) + m.insert + cur.slice(m.to);
  };

  it("applies my change when nobody else edited", () => {
    expect(merge("a\nb\nc\n", "a\nb\nc\n", "a\nB\nc\n")).toBe("a\nB\nc\n");
    expect(merge("a\n", "a\n", "a\n")).toBeNull();
  });

  it("keeps an edit by someone else before or after mine", () => {
    // ほかの人が後ろの行を直した
    expect(merge("a\nb\nc\nd\n", "a\nb\nc\nD!\n", "A\nb\nc\nd\n")).toBe("A\nb\nc\nD!\n");
    // ほかの人が前の行を直した（自分の変更の位置がずれる）
    expect(merge("a\nb\nc\nd\n", "a!!\nb\nc\nd\n", "a\nb\nc\nX\n")).toBe("a!!\nb\nc\nX\n");
  });

  it("does not undo someone else's edit when I changed nothing", () => {
    expect(merge("a\nb\n", "a\nB\n", "a\nb\n")).toBeNull();
  });

  it("reports a conflict when both changed the same place", () => {
    expect(mergeChange("a\nb\nc\n", "a\nX\nc\n", "a\nY\nc\n")).toBe("conflict");
  });
});
