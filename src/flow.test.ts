import { describe, expect, it } from "vitest";
import { flowEdges, flowToDot, parseFlow } from "./flow";

const SAMPLE = `title 受注
顧客: 開始
顧客: 注文する
営業: 在庫はある?
  はい -> @出荷
  いいえ ->
営業: 欠品を連絡する
顧客: 終了
倉庫: 出荷する @出荷
顧客: 受け取る
`;

describe("parseFlow", () => {
  it("reads steps, lanes in order of appearance and kinds", () => {
    const m = parseFlow(SAMPLE);
    expect(m.title).toBe("受注");
    expect(m.lanes).toEqual(["顧客", "営業", "倉庫"]);
    expect(m.steps.map((s) => s.kind)).toEqual(["start", "process", "decision", "process", "end", "process", "process"]);
    expect(m.steps[5]).toMatchObject({ lane: "倉庫", text: "出荷する", name: "出荷" });
    expect(m.steps[2].branches).toEqual([
      { label: "はい", to: "出荷", line: 5 },
      { label: "いいえ", to: null, line: 6 },
    ]);
  });

  it("uses the lanes line for the order", () => {
    expect(parseFlow("lanes: 倉庫, 顧客\n顧客: A\n倉庫: B").lanes).toEqual(["倉庫", "顧客"]);
  });

  it("reports mistakes with the line number", () => {
    expect(() => parseFlow("ただの文")).toThrow("1 行目: 「担当: 処理」の形で書いてください");
    expect(() => parseFlow("  -> @a")).toThrow("1 行目: 行き先の前に");
    expect(() => parseFlow("A: x\n  そのまま")).toThrow("2 行目: 字下げした行は");
    expect(() => parseFlow("A: x?\n  はい -> @nope")).toThrow("2 行目: 行き先 @nope が見つかりません");
    expect(() => parseFlow("A: x @a\nB: y @a")).toThrow("2 行目: @a が 2 回出てきます");
    expect(() => parseFlow("title だけ")).toThrow("手順がありません");
  });
});

describe("flowEdges", () => {
  it("connects steps in order, follows branches and stops after the end", () => {
    expect(flowEdges(parseFlow(SAMPLE))).toEqual([
      [0, 1, ""],
      [1, 2, ""],
      [2, 5, "はい"],
      [2, 3, "いいえ"],
      [3, 4, ""],
      [5, 6, ""],
    ]);
  });
});

describe("flowToDot", () => {
  it("draws lanes as clusters without Graphviz errors", async () => {
    const dot = flowToDot(parseFlow(SAMPLE));
    expect(dot).toContain("subgraph cluster_1");
    expect(dot).toContain("s2 -> s5 [xlabel=<はい>]");
    expect(dot).toContain("shape=diamond");
    const { instance } = await import("@viz-js/viz");
    const r = (await instance()).render(dot, { format: "svg" });
    expect(r.errors.filter((e) => e.level === "error")).toEqual([]);
  });

  it("breaks lines at \\n", () => {
    expect(flowToDot(parseFlow("A: 一行目\\n二行目"))).toContain("一行目<br/>二行目");
  });
});
