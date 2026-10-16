import { describe, expect, it } from "vitest";
import { MIN_TABLE_FIT, tableFit } from "./pdflayout";

const area = { width: 700, height: 900 };

describe("tableFit", () => {
  it("収まる表は縮めない", () => {
    expect(tableFit(500, () => 300, area)).toBe(1);
  });

  it("幅がはみ出す表はページ幅まで縮める", () => {
    expect(tableFit(1000, () => 300, area)).toBe(0.7);
  });

  it("幅の縮小は MIN_TABLE_FIT で止め、残りは折り返しに任せる", () => {
    expect(tableFit(5000, () => 300, area)).toBe(MIN_TABLE_FIT);
  });

  it("縦が 1 ページを超える表は高さも収める", () => {
    // 縮めないと 1200px（見た目）。900 / 1200 = 0.75
    expect(tableFit(500, (t) => 1200 * t, area)).toBe(0.75);
  });

  it("縦を収めると MIN_TABLE_FIT を下回る長い表は、ページをまたがせる", () => {
    expect(tableFit(1000, (t) => 5000 * t, area)).toBe(0.7);
  });

  it("小数は切り捨てて、はみ出さないほうに丸める", () => {
    expect(tableFit(1001, () => 300, area)).toBe(0.69);
  });
});
