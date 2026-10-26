import { describe, expect, it } from "vitest";
import { changedRange } from "./textdiff";

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
