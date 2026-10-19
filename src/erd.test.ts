import { describe, expect, it } from "vitest";
import { erdToDot, parseErd } from "./erd";

const SAMPLE = `title 受注
## users ユーザー
| 列 | 型 | キー | 説明 |
|---|---|---|---|
| id | int | PK | |
| name | text | | 氏名 |

## orders 注文
| 説明 | 列 | キー | 型 |
|---|---|---|---|
| | id | PK | int |
| 注文者 | user_id | FK users.id | int |
| | code | UK | text |
`;

describe("parseErd", () => {
  it("reads tables and finds columns by their headers", () => {
    const m = parseErd(SAMPLE);
    expect(m.title).toBe("受注");
    expect(m.tables.map((t) => [t.name, t.label])).toEqual([
      ["users", "ユーザー"],
      ["orders", "注文"],
    ]);
    const [, userId, code] = m.tables[1].columns;
    expect(userId).toMatchObject({ name: "user_id", type: "int", note: "注文者", pk: false, fk: { table: "users", column: "id" } });
    expect(code).toMatchObject({ uk: true, fk: null });
  });

  it("uses the first column as the name when no header matches", () => {
    const m = parseErd("## t\n| a | b |\n|---|---|\n| x | y |");
    expect(m.tables[0].columns[0]).toMatchObject({ name: "x", type: "" });
  });

  it("accepts FK without a column and decorated names", () => {
    const m = parseErd("## a\n| 列 | キー |\n|---|---|\n| `id` | PK |\n## b\n| 列 | キー |\n|---|---|\n| **a_id** | FK(a) |");
    expect(m.tables[1].columns[0]).toMatchObject({ name: "a_id", fk: { table: "a", column: null } });
  });

  it("reports mistakes with the line number", () => {
    expect(() => parseErd("| a |")).toThrow("1 行目: 表の前に");
    expect(() => parseErd("## a\nfoo")).toThrow("2 行目: 未対応の書き方です");
    expect(() => parseErd("## a\n| 列 |\n| x |")).toThrow("3 行目: 表の見出しの次は");
    expect(() => parseErd("## a\n| 列 | キー |\n|---|---|\n| x | FK nope.id |")).toThrow("4 行目: 参照先のテーブル nope がありません");
    expect(() => parseErd("## a\n| 列 | キー |\n|---|---|\n| x | FK a.zz |")).toThrow("4 行目: テーブル a に列 zz がありません");
    expect(() => parseErd("## a\n\n## a")).toThrow("3 行目: テーブル a が 2 回出てきます");
    expect(() => parseErd("## a")).toThrow("1 行目: テーブル a に列がありません");
    expect(() => parseErd("")).toThrow("テーブルがありません");
  });
});

describe("erdToDot", () => {
  it("draws tables as HTML labels and FK lines from the referenced column", () => {
    const dot = erdToDot(parseErd(SAMPLE));
    expect(dot).toContain("<b>受注</b>");
    expect(dot).toMatch(/port="c0" width="\d+"><b><u>id<\/u><\/b><\/td>/);
    expect(dot).toMatch(/port="c1" width="\d+"><i>user_id<\/i><\/td>/);
    expect(dot).toContain("t0:c0 -> t1:c1;");
  });

  it("produces DOT that Graphviz draws without errors", async () => {
    // 空の <font></font> などは Graphviz の構文エラーになり、そのテーブルだけが黙って消える
    const { instance } = await import("@viz-js/viz");
    const viz = await instance();
    const sparse = "## a\n| 列 | キー |\n|---|---|\n| id | PK |\n| name | |\n## b\n| 列 | 型 | キー | 説明 |\n|---|---|---|---|\n| a_id | | FK a | |";
    for (const src of [SAMPLE, sparse]) {
      const r = viz.render(erdToDot(parseErd(src)), { format: "svg" });
      expect(r.errors.filter((e) => e.level === "error")).toEqual([]);
    }
  });

  it("widens cells for Japanese text", () => {
    expect(erdToDot(parseErd("## t\n| 列 |\n|---|\n| 顧客番号 |"))).toContain('port="c0" width="61"');
  });

  it("escapes HTML in names", () => {
    expect(erdToDot(parseErd("## t\n| 列 |\n|---|\n| a<b |"))).toContain("a&lt;b");
  });
});
