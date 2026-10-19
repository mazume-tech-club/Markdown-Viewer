import { describe, expect, it } from "vitest";
import { mindmapToDot, parseMindmap, type MindNode } from "./mindmap";

/** 木を「名前(子, 子)」の文字列にする（比べやすくするため） */
const show = (n: MindNode): string => (n.children.length ? `${n.text}(${n.children.map(show).join(", ")})` : n.text);

describe("parseMindmap", () => {
  it("nests headings and list items", () => {
    const { root } = parseMindmap("# 旅行\n## 準備\n- 宿\n  - 予約\n- **切符**\n## 当日\n1. 移動");
    expect(show(root)).toBe("旅行(準備(宿(予約), 切符), 当日(移動))");
  });

  it("follows the indentation of list items", () => {
    const { root } = parseMindmap("- A\n    - B\n        - C\n    - D\n- E");
    expect(show(root)).toBe("(A(B(C), D), E)");
  });

  it("puts several top items under the title", () => {
    expect(show(parseMindmap("title 計画\n- A\n- B").root)).toBe("計画(A, B)");
  });

  it("strips inline markup", () => {
    expect(show(parseMindmap("- [リンク](https://example.com) と `code`").root)).toBe("リンク と code");
  });

  it("reports lines that are not headings or items", () => {
    expect(() => parseMindmap("# A\nただの文")).toThrow("2 行目: 見出し（#）か箇条書き（-）で書いてください");
    expect(() => parseMindmap("")).toThrow("見出し（#）か箇条書き（-）を書いてください");
  });
});

describe("mindmapToDot", () => {
  it("colors each branch and draws without Graphviz errors", async () => {
    const dot = mindmapToDot(parseMindmap("# 根\n- A\n  - A1\n- B <x>"));
    expect(dot).toContain("B &lt;x&gt;");
    expect(dot).toMatch(/n0 -> n1 \[color="#0a6c78"/);
    expect(dot).toMatch(/n0 -> n3 \[color="#c4432b"/);
    const { instance } = await import("@viz-js/viz");
    const r = (await instance()).render(dot, { format: "svg" });
    expect(r.errors.filter((e) => e.level === "error")).toEqual([]);
  });
});
