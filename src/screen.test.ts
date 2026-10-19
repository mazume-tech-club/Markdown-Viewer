import { describe, expect, it } from "vitest";
import { parseScreens, screensToDot } from "./screen";

const SAMPLE = `title 会員登録
ログイン -> 会員登録 : 新規登録
会員登録 -> 確認 : 確認する
確認 -> 会員登録 : 戻る
確認 -> 完了 : 登録する
完了 <-> マイページ : 開く / 戻る
確認 : 入力内容を表示
ヘルプ
`;

describe("parseScreens", () => {
  it("reads screens, transitions and notes", () => {
    const m = parseScreens(SAMPLE);
    expect(m.title).toBe("会員登録");
    expect(m.screens.map((s) => s.name)).toEqual(["ログイン", "会員登録", "確認", "完了", "マイページ", "ヘルプ"]);
    expect(m.screens[2].note).toBe("入力内容を表示");
    expect(m.transitions[0]).toEqual({ from: "ログイン", to: "会員登録", label: "新規登録", both: false });
    expect(m.transitions[4]).toMatchObject({ from: "完了", to: "マイページ", both: true });
  });

  it("accepts arrows without a label and the direction line", () => {
    const m = parseScreens("direction TB\nA -> B");
    expect(m.direction).toBe("TB");
    expect(m.transitions[0].label).toBe("");
  });

  it("reports mistakes", () => {
    expect(() => parseScreens("A => B")).toThrow("1 行目: 矢印は「画面A -> 画面B : 操作」の形で書いてください");
    expect(() => parseScreens("")).toThrow("画面がありません");
  });
});

describe("screensToDot", () => {
  it("draws screens as windows without Graphviz errors", async () => {
    const dot = screensToDot(parseScreens(SAMPLE));
    expect(dot).toContain("<b>会員登録</b>");
    expect(dot).toContain("p0 -> p1 [label=<新規登録>]");
    expect(dot).toContain("p3 -> p4 [label=<開く / 戻る>, dir=both]");
    const { instance } = await import("@viz-js/viz");
    const r = (await instance()).render(dot, { format: "svg" });
    expect(r.errors.filter((e) => e.level === "error")).toEqual([]);
  });
});
