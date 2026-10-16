import { describe, expect, it } from "vitest";
import { planImages, rewriteImageLinks } from "./export";
import { findImageRefs, parseFenceInfo } from "./render";

/** 画像をすべて assets/<名前> にまとめたときの本文 */
function exportText(text: string) {
  const refs = findImageRefs(text);
  const plan = planImages(refs, (f) => f.toLowerCase());
  const to = new Map([...plan].map(([link, img]) => [link, `doc.assets/${img.name}`]));
  return rewriteImageLinks(text, refs, to);
}

describe("findImageRefs", () => {
  it("画像のリンクを見つけ、タイトルやコードブロックの中は含めない", () => {
    const text = [
      '![a](img/a.png "タイトル") と ![b](<my pic.png>)',
      "",
      "```md",
      "![code](code.png)",
      "```",
      "",
      "| 表 | 画像 |",
      "|---|---|",
      "| x | ![t](t.png) |",
    ].join("\n");
    expect(findImageRefs(text).map((r) => [r.kind, r.link, text.slice(r.start, r.end)])).toEqual([
      ["image", "img/a.png", "img/a.png"],
      ["image", "my pic.png", "<my pic.png>"],
      ["image", "t.png", "t.png"],
    ]);
  });

  it("注釈のコメントの src（元画像）も見つける", () => {
    const text = [
      "![フォーム](../img/form.annotated.png)",
      '<!-- annotate {"src":"../img/form.png","size":[10,10],"items":[]} -->',
    ].join("\n");
    expect(findImageRefs(text).map((r) => [r.kind, r.link])).toEqual([
      ["image", "../img/form.annotated.png"],
      ["annotate", "../img/form.png"],
    ]);
  });

  it("括弧を含むリンクも途中で切らない", () => {
    const text = "![x](a(1).png)";
    expect(findImageRefs(text).map((r) => r.link)).toEqual(["a(1).png"]);
  });
});

describe("エクスポートの書き換え", () => {
  it("ローカルの画像を .assets の直下に集め、ネット上の画像はそのまま残す", () => {
    const text = "![a](../img/a.png)\n\n![w](https://example.com/w.png)\n\n![c](C:\\pics\\c.png)";
    expect(exportText(text)).toBe(
      "![a](doc.assets/a.png)\n\n![w](https://example.com/w.png)\n\n![c](doc.assets/c.png)",
    );
  });

  it("名前がぶつかれば番号を付け、同じファイルは 1 つにまとめる", () => {
    const text = "![](x/a.png) ![](y/a.png) ![](x/A.png)";
    expect(exportText(text)).toBe("![](doc.assets/a.png) ![](doc.assets/a-2.png) ![](doc.assets/a.png)");
  });

  it("%xx を戻したファイル名で置き、リンクには空白を %20 で書く", () => {
    const text = "![](<my pic.png>) ![](%E5%9B%B3.png)";
    expect(exportText(text)).toBe("![](doc.assets/my%20pic.png) ![](doc.assets/図.png)");
  });

  it("注釈の焼き込み画像と元画像の両方を書き換える", () => {
    const text = [
      "![f](../img/form.annotated.png)",
      '<!-- annotate {"src":"../img/form.png","size":[10,10],"items":[]} -->',
    ].join("\n");
    expect(exportText(text)).toBe(
      [
        "![f](doc.assets/form.annotated.png)",
        '<!-- annotate {"src":"doc.assets/form.png","size":[10,10],"items":[]} -->',
      ].join("\n"),
    );
  });

  it("to にない画像（見つからなかった画像）のリンクは残す", () => {
    const text = "![a](a.png) ![b](b.png)";
    const refs = findImageRefs(text);
    expect(rewriteImageLinks(text, refs, new Map([["a.png", "doc.assets/a.png"]]))).toBe(
      "![a](doc.assets/a.png) ![b](b.png)",
    );
  });
});

describe("parseFenceInfo", () => {
  it("言語名は書いたとおりラベルにし、色付け用には小文字にする", () => {
    expect(parseFenceInfo("Bash")).toEqual({ lang: "bash", label: "Bash" });
  });

  it("Qiita の 言語:ファイル名 ならファイル名をラベルにする", () => {
    expect(parseFenceInfo("ruby:qiita.rb")).toEqual({ lang: "ruby", label: "qiita.rb" });
    expect(parseFenceInfo("ps1:C:\\tools\\run.ps1")).toEqual({ lang: "ps1", label: "C:\\tools\\run.ps1" });
  });

  it("言語名がなければラベルを出さない", () => {
    expect(parseFenceInfo("")).toEqual({ lang: "", label: "" });
  });
});
