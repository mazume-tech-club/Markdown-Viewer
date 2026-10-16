import { describe, expect, it } from "vitest";
import hljs from "highlight.js/lib/common";
import { highlightCode, onHighlighterLoaded } from "./index";

/** 読み込みを待ってから、もう一度色分けする（アプリでは描き直しに当たる） */
function loadAndHighlight(code: string, lang: string): Promise<string | null> {
  return new Promise((resolve) => {
    onHighlighterLoaded(() => resolve(highlightCode(code, lang, hljs)));
    expect(highlightCode(code, lang, hljs)).toBeNull();
  });
}

describe("highlightCode", () => {
  it("自作の色分けは初回は読み込み中で null、読み込めたら色が付く（別名も同じ）", async () => {
    const html = await loadAndHighlight("docker ps -a", "ps1");
    expect(html).toContain('<span class="hljs-built_in">docker</span>');
    expect(highlightCode("Get-Date", "powershell", hljs)).toContain("hljs-built_in");
  });

  it("common に無い言語も、使うときに highlight.js の定義を読み込む", async () => {
    const html = await loadAndHighlight("FROM node:22", "dockerfile");
    expect(html).toContain("hljs-keyword");
  });

  it("vue は HTML として色を付ける", () => {
    expect(highlightCode("<template><div /></template>", "vue", hljs)).toContain("hljs-tag");
  });

  it("言語名が constructor や __proto__ でも例外を出さない", () => {
    expect(() => highlightCode("x", "constructor", hljs)).not.toThrow();
    expect(() => highlightCode("x", "__proto__", hljs)).not.toThrow();
    expect(() => highlightCode("x", "tostring", hljs)).not.toThrow();
  });

  it("知らない言語と highlight.js の読み込み前は null", () => {
    expect(highlightCode("x", "no-such-lang", hljs)).toBeNull();
    expect(highlightCode("const a = 1", "ts", null)).toBeNull();
  });
});
