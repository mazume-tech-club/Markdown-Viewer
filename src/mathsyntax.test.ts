import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import { findInlineMathEnd, mathSyntax } from "./mathsyntax";

const make = (on = true) => {
  const md = new MarkdownIt();
  mathSyntax(md, () => on);
  return md;
};

describe("findInlineMathEnd", () => {
  it("finds the closing dollar", () => {
    expect(findInlineMathEnd("$x^2$ です", 0)).toBe(4);
  });

  it("does not treat prices as math", () => {
    expect(findInlineMathEnd("$100 と $200", 0)).toBe(-1);
    expect(findInlineMathEnd("$ x$", 0)).toBe(-1);
    expect(findInlineMathEnd("$x $", 0)).toBe(-1);
    expect(findInlineMathEnd("$100 は `$` で書く", 0)).toBe(-1);
  });

  it("skips an escaped dollar inside", () => {
    expect(findInlineMathEnd("$a\\$b$", 0)).toBe(5);
  });
});

describe("mathSyntax", () => {
  it("makes inline placeholders", () => {
    expect(make().render("面積は $\\pi r^2$ です")).toContain(
      '<span class="diagram math-inline" data-kind="math-inline"><code class="diagram-src">\\pi r^2</code></span>',
    );
  });

  it("leaves dollars alone when disabled", () => {
    expect(make(false).render("$x$")).toBe("<p>$x$</p>\n");
  });

  it("makes a block from a multi-line $$", () => {
    const html = make().render("前\n\n$$\na < b\n$$\n\n後");
    expect(html).toContain('<div class="diagram" data-kind="math" data-line="2"><pre class="diagram-src">a &lt; b</pre></div>');
    expect(html).toContain("<p>後</p>");
  });

  it("makes a block from a single-line $$", () => {
    expect(make().render("$$E = mc^2$$")).toContain('<pre class="diagram-src">E = mc^2</pre>');
  });

  it("ignores an unclosed $$", () => {
    expect(make().render("$$\nx")).not.toContain("diagram");
  });

  it("does not touch code spans", () => {
    expect(make().render("`$x$`")).toBe("<p><code>$x$</code></p>\n");
  });
});
