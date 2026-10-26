import { describe, expect, it } from "vitest";
import { formatDate, parseDate, parseGantt, scheduleGantt, writeGantt, type GanttModel } from "./gantt";
import helpSource from "./help/help.md?raw";
import skillSource from "./help/skill.md?raw";

const SAMPLE = `タイトル: 新システム導入
休日: 2026-11-03, 2026-11-23
表示: 週

| タスク       | 開始       | 終了       | 日数 | 担当 | 進捗 |
|--------------|------------|------------|------|------|------|
| # 設計       |            |            |      |      |      |
| 要件定義     | 2026-11-02 |            | 5    | 土屋 | 100% |
| 基本設計     | 2026-11-09 | 2026-11-20 |      | 佐藤 | 40%  |
| 設計レビュー | 2026-11-24 |            | 0    |      |      |
| # 開発       |            |            |      |      |      |
| 実装         | 2026-11-25 |            | 10   | 土屋 | 0%   |
`;

/** 計画の中のタスク（グループを除く）の名前・開始・終了 */
const tasks = (src: string) =>
  scheduleGantt(parseGantt(src))
    .items.filter((i) => i.type === "task")
    .map((t) => (t.type === "task" ? [t.name, formatDate(t.start), formatDate(t.end)] : []));

const table = (...rows: string[]) => `| タスク | 開始 | 終了 | 日数 |\n|---|---|---|---|\n${rows.join("\n")}`;

describe("parseDate", () => {
  it("reads - and / and rejects impossible dates", () => {
    expect(formatDate(parseDate("2026-11-02")!)).toBe("2026-11-02");
    expect(formatDate(parseDate("2026/1/5")!)).toBe("2026-01-05");
    expect(parseDate("2026-02-30")).toBeNull();
    expect(parseDate("11/2")).toBeNull();
  });
});

describe("parseGantt", () => {
  it("reads settings, groups and tasks", () => {
    const m = parseGantt(SAMPLE);
    expect(m.title).toBe("新システム導入");
    expect(m.holidays).toEqual(["2026-11-03", "2026-11-23"]);
    expect(m.view).toBe("week");
    expect(m.rows.map((r) => (r.group ? `#${r.name}` : r.name))).toEqual(["#設計", "要件定義", "基本設計", "設計レビュー", "#開発", "実装"]);
    expect(m.rows[2]).toMatchObject({ start: "2026-11-09", end: "2026-11-20", days: "", owner: "佐藤", progress: "40%" });
  });

  it("accepts English names, a full-width colon and missing columns", () => {
    const m = parseGantt("title：Plan\nview: month\n\n| task | start | days | owner | note |\n|---|---|---|---|---|\n| A | 2026-11-02 | 3 | me | x \\| y |");
    expect(m.title).toBe("Plan");
    expect(m.view).toBe("month");
    expect(m.rows[0]).toMatchObject({ name: "A", start: "2026-11-02", end: "", days: "3", owner: "me", note: "x | y" });
  });

  it("reports mistakes with the line number", () => {
    expect(() => parseGantt("色: 赤\n" + table("| A | 2026-11-02 | | 1 |"))).toThrow("1 行目: 「色」は使えない設定です");
    expect(() => parseGantt("表示: 年\n" + table("| A | 2026-11-02 | | 1 |"))).toThrow("1 行目: 表示は 日・週・月 のどれかにしてください");
    expect(() => parseGantt("| 開始 | 日数 |\n|---|---|\n| 2026-11-02 | 1 |")).toThrow("1 行目: 表の見出しに「タスク」の列がありません");
    expect(() => parseGantt("| タスク |\n| A |")).toThrow("2 行目: 表の見出しの次は |---|---| の区切りの行にしてください");
    expect(() => parseGantt("メモです")).toThrow("1 行目: 未対応の書き方です");
    expect(() => parseGantt("タイトル: x")).toThrow("タスクがありません");
  });
});

describe("scheduleGantt", () => {
  it("counts business days, skipping weekends and listed holidays", () => {
    const plan = scheduleGantt(parseGantt(SAMPLE));
    expect(tasks(SAMPLE)).toEqual([
      ["要件定義", "2026-11-02", "2026-11-09"], // 11/3 は休日、11/7・8 は土日
      ["基本設計", "2026-11-09", "2026-11-20"],
      ["設計レビュー", "2026-11-24", "2026-11-24"],
      ["実装", "2026-11-25", "2026-12-08"],
    ]);
    const review = plan.items.find((i) => i.type === "task" && i.name === "設計レビュー");
    expect(review).toMatchObject({ milestone: true });
    expect(plan.items[1]).toMatchObject({ group: 0, progress: 100, owner: "土屋" });
    expect(plan.items[5]).toMatchObject({ group: 1, progress: 0 });
    expect(formatDate(plan.from)).toBe("2026-11-02");
    expect(formatDate(plan.to)).toBe("2026-12-08");
  });

  it("starts a task without a start on the business day after the previous task", () => {
    expect(tasks(table("| A | 2026-11-05 | | 2 |", "| B | | | 1 |", "| C | | | 0 |", "| D | | | 1 |"))).toEqual([
      ["A", "2026-11-05", "2026-11-06"],
      ["B", "2026-11-09", "2026-11-09"],
      ["C", "2026-11-10", "2026-11-10"],
      ["D", "2026-11-11", "2026-11-11"],
    ]);
  });

  it("starts counting on the next business day when the start is a holiday", () => {
    expect(tasks(table("| A | 2026-11-07 | | 2 |"))).toEqual([["A", "2026-11-07", "2026-11-10"]]);
  });

  it("prefers the end when it disagrees with the days, and warns", () => {
    const plan = scheduleGantt(parseGantt(table("| A | 2026-11-02 | 2026-11-04 | 5 |", "| B | 2026-11-02 | 2026-11-04 | 3 |")));
    expect(plan.items[0]).toMatchObject({ type: "task", warning: "日数（5）と終了日が合いません。終了日を使います" });
    expect(formatDate((plan.items[0] as { end: number }).end)).toBe("2026-11-04");
    expect(plan.items[1]).toMatchObject({ warning: "" });
  });

  it("expands holiday ranges", () => {
    const src = "休日: 2026-12-29〜2027-01-02\n" + table("| A | 2026-12-28 | | 2 |");
    expect(tasks(src)).toEqual([["A", "2026-12-28", "2027-01-04"]]);
  });

  it("reports values it cannot use", () => {
    expect(() => scheduleGantt(parseGantt(table("| A | | | 1 |")))).toThrow("3 行目: 最初のタスクには開始日を書いてください");
    expect(() => scheduleGantt(parseGantt(table("| A | 11/2 | | 1 |")))).toThrow("3 行目: 開始日「11/2」は 2026-11-02 の形で書いてください");
    expect(() => scheduleGantt(parseGantt(table("| A | 2026-11-02 | | |")))).toThrow("3 行目: 終了日か日数を書いてください");
    expect(() => scheduleGantt(parseGantt(table("| A | 2026-11-05 | 2026-11-02 | |")))).toThrow("3 行目: 終了日が開始日より前です");
    expect(() => scheduleGantt(parseGantt(table("| A | 2026-11-02 | | -1 |")))).toThrow("3 行目: 日数は 0 以上の整数で書いてください");
    expect(() => scheduleGantt(parseGantt("休日: 祝日\n" + table("| A | 2026-11-02 | | 1 |")))).toThrow("1 行目: 休日「祝日」は 2026-11-03 の形で書いてください");
    const p = "| タスク | 開始 | 日数 | 進捗 |\n|---|---|---|---|\n| A | 2026-11-02 | 1 | 120% |";
    expect(() => scheduleGantt(parseGantt(p))).toThrow("3 行目: 進捗は 0〜100% で書いてください");
  });
});

describe("writeGantt", () => {
  it("writes aligned tables with normalized dates", () => {
    const m: GanttModel = {
      title: "計画",
      holidays: ["2026/11/3"],
      view: "day",
      rows: [
        { group: true, name: "設計", start: "", end: "", days: "", owner: "", progress: "", note: "" },
        { group: false, name: "要件定義", start: "2026/11/2", end: "", days: "5", owner: "土屋", progress: "50", note: "" },
        { group: false, name: "a|b", start: "", end: "", days: "1", owner: "", progress: "", note: "" },
      ],
    };
    expect(writeGantt(m)).toBe(
      [
        "タイトル: 計画",
        "休日: 2026-11-03",
        "",
        "| タスク   | 開始       | 終了 | 日数 | 担当 | 進捗 |",
        "|----------|------------|------|------|------|------|",
        "| # 設計   |            |      |      |      |      |",
        "| 要件定義 | 2026-11-02 |      | 5    | 土屋 | 50%  |",
        "| a\\|b     |            |      | 1    |      |      |",
        "",
      ].join("\n"),
    );
  });

  it("round-trips the sample and adds the note column only when used", () => {
    const m = parseGantt(SAMPLE);
    expect(stripLines(parseGantt(writeGantt(m)))).toEqual(stripLines(m));
    m.rows[1].note = "顧客と合意";
    const out = writeGantt(m);
    expect(out).toContain("| メモ       |");
    expect(out).toContain("表示: 週");
    expect(parseGantt(out).rows[1].note).toBe("顧客と合意");
  });
});

describe("documented examples", () => {
  it("help.md and skill.md examples schedule without errors or warnings", () => {
    for (const source of [helpSource, skillSource]) {
      const blocks = [...source.matchAll(/```gantt\r?\n([\s\S]*?)```/g)].map((m) => m[1]);
      expect(blocks.length).toBeGreaterThan(0);
      for (const b of blocks) {
        const plan = scheduleGantt(parseGantt(b));
        expect(plan.items.filter((i) => i.type === "task" && i.warning)).toEqual([]);
      }
    }
  });
});

/** 行番号を除いたモデル（書き直すと行番号が変わるため） */
function stripLines(m: GanttModel): GanttModel {
  const { holidaysLine: _h, ...rest } = m;
  return { ...rest, rows: m.rows.map(({ line: _line, ...r }) => r) };
}
