import { describe, expect, it } from "vitest";
import { currentIndex, visibleItems } from "./toc";

describe("currentIndex", () => {
  it("picks the last heading above the threshold", () => {
    expect(currentIndex([-500, -10, 40, 300], 80)).toBe(2);
  });

  it("picks the first heading when all are below", () => {
    expect(currentIndex([200, 400], 80)).toBe(0);
  });
});

describe("visibleItems", () => {
  //            0  1  2  3  4  5  6
  const levels = [1, 2, 3, 3, 2, 3, 3];

  it("opens ### only under the section being read", () => {
    expect(visibleItems(levels, 2)).toEqual([0, 1, 2, 3, 4]);
    expect(visibleItems(levels, 4)).toEqual([0, 1, 4, 5, 6]);
  });

  it("keeps every ### closed while reading the title", () => {
    expect(visibleItems(levels, 0)).toEqual([0, 1, 4]);
  });

  it("uses # as the section when there is no ##", () => {
    expect(visibleItems([1, 3, 3, 1, 3], 1)).toEqual([0, 1, 2, 3]);
  });

  it("shows ### before the first heading of level 1-2 only while reading it", () => {
    expect(visibleItems([3, 2, 3], 0)).toEqual([0, 1]);
    expect(visibleItems([3, 2, 3], 2)).toEqual([1, 2]);
  });
});
