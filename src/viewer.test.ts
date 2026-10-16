import { describe, expect, it } from "vitest";
import { MAX_SCALE, MIN_SCALE, fitView, zoomAt } from "./viewer";

describe("fitView", () => {
  it("横長の図は幅に合わせて縮小し、上下の中央に置く", () => {
    const v = fitView({ w: 2048, h: 512 }, { w: 1072, h: 800 });
    expect(v.scale).toBeCloseTo(0.5);
    expect(v.x).toBeCloseTo(24);
    expect(v.y).toBeCloseTo((800 - 256) / 2);
  });

  it("小さな図は全体が収まるところまで拡大する", () => {
    const v = fitView({ w: 100, h: 50 }, { w: 448, h: 1000 });
    expect(v.scale).toBeCloseTo(4);
  });

  it("倍率は上限と下限の間に収める", () => {
    expect(fitView({ w: 1, h: 1 }, { w: 1000, h: 1000 }).scale).toBe(MAX_SCALE);
    expect(fitView({ w: 1e6, h: 1e6 }, { w: 1000, h: 1000 }).scale).toBe(MIN_SCALE);
  });
});

describe("zoomAt", () => {
  it("指定した点の下にある位置は動かない", () => {
    const before = { scale: 0.5, x: 100, y: 40 };
    const after = zoomAt(before, 2, 300, 200);
    // 画面の (300, 200) に映っている中身の座標
    const at = (v: typeof before) => [(300 - v.x) / v.scale, (200 - v.y) / v.scale];
    expect(after.scale).toBeCloseTo(1);
    expect(at(after)[0]).toBeCloseTo(at(before)[0]);
    expect(at(after)[1]).toBeCloseTo(at(before)[1]);
  });

  it("上限を超える拡大は上限で止め、位置もその倍率で計算する", () => {
    const after = zoomAt({ scale: MAX_SCALE, x: 0, y: 0 }, 2, 50, 50);
    expect(after).toEqual({ scale: MAX_SCALE, x: 0, y: 0 });
  });
});
