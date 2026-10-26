import { describe, expect, it } from "vitest";
import { parseDate, parseGantt, scheduleGantt } from "./gantt";
import { ganttToSvg } from "./ganttsvg";

const SRC = `タイトル: 計画 <A&B>
休日: 2026-11-03

| タスク   | 開始       | 終了       | 日数 | 担当 | 進捗 |
|----------|------------|------------|------|------|------|
| # 設計   |            |            |      |      |      |
| 要件定義 | 2026-11-02 |            | 5    | 土屋 | 40%  |
| 確認     | 2026-11-02 | 2026-11-04 | 5    |      |      |
| 合意     |            |            | 0    |      |      |
`;

const svgOf = (src: string, today = parseDate("2026-11-04")!) =>
  ganttToSvg(scheduleGantt(parseGantt(src)), { dark: false, today });

describe("ganttToSvg", () => {
  it("draws bars, a milestone, the title and the today line", () => {
    const svg = svgOf(SRC);
    expect(svg).toMatch(/^<svg [^>]*data-origin="\d+" data-day-width="24"/);
    expect(svg).toContain("計画 &lt;A&amp;B&gt;");
    // グループ・タスクの横棒（data-row は表の行の位置）
    expect(svg.match(/class="gantt-bar"/g)).toHaveLength(3);
    expect(svg).toContain('data-row="1"');
    expect(svg).toContain('data-row="3"');
    expect(svg).toMatch(/<path class="gantt-handle-move" d="M/); // マイルストーンの◆
    expect(svg).toContain("土屋  40%");
    expect(svg).toContain("2026-11-02 〜 2026-11-09");
    expect(svg).toContain("日数（5）と終了日が合いません");
    expect(svg).toContain('stroke="#d03b2f"'); // 今日の線
  });

  it("omits the today line outside the range and labels weeks and months", () => {
    expect(svgOf(SRC, parseDate("2027-05-01")!)).not.toContain('stroke="#d03b2f"');
    const week = svgOf("表示: 週\n| タスク | 開始 | 日数 |\n|---|---|---|\n| A | 2026-11-04 | 3 |");
    expect(week).toContain(">11/2<");
    expect(week).toContain(">2026年11月<");
    const month = svgOf("表示: 月\n| タスク | 開始 | 日数 |\n|---|---|---|\n| A | 2026-12-20 | 30 |");
    expect(month).toContain(">12月<");
    expect(month).toContain(">1月<");
    expect(month).toContain(">2027年<");
  });
});
