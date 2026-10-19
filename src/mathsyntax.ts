import type MarkdownIt from "markdown-it";

// ---------- 数式の書き方（GitHub と同じ） ----------
// 文中の $ … $ と、行頭の $$ … $$（1 行でも複数行でもよい）を数式のプレースホルダにする。
// ```math の fence は render.ts の fence ルールが扱う。描画は diagrams.ts（KaTeX）。
// オプション機能「数式」がオフのあいだ（enabled() が false）は何もせず、ただの文字として出す

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const DOLLAR = 0x24;
const isSpace = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a;
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;

/**
 * 文中の $ の位置 pos から、閉じる $ の位置を探す。数式でなければ -1。
 * 開く $ の直後と閉じる $ の直前は空白でなく、閉じる $ の直後は数字でないこと
 * （「$100 と $200」のような金額を数式にしないため。pandoc と同じ決まり）。
 * コードの ` はまたがない（金額の $ が後ろのコードの中の $ と組にならないように）
 */
export function findInlineMathEnd(src: string, pos: number): number {
  if (src.charCodeAt(pos) !== DOLLAR || src.charCodeAt(pos + 1) === DOLLAR) return -1;
  const first = src.charCodeAt(pos + 1);
  if (Number.isNaN(first) || isSpace(first)) return -1;
  for (let end = src.indexOf("$", pos + 1); end !== -1; end = src.indexOf("$", end + 1)) {
    if (src.slice(pos, end).includes("`")) return -1;
    if (src[end - 1] === "\\") continue;
    if (!isSpace(src.charCodeAt(end - 1)) && !isDigit(src.charCodeAt(end + 1))) return end;
  }
  return -1;
}

export function mathSyntax(md: InstanceType<typeof MarkdownIt>, enabled: () => boolean) {
  md.inline.ruler.after("escape", "math_inline", (state, silent) => {
    if (!enabled()) return false;
    const end = findInlineMathEnd(state.src, state.pos);
    if (end < 0) return false;
    if (!silent) {
      const t = state.push("math_inline", "", 0);
      t.content = state.src.slice(state.pos + 1, end);
      t.markup = "$";
    }
    state.pos = end + 1;
    return true;
  });

  md.block.ruler.before(
    "fence",
    "math_block",
    (state, startLine, endLine, silent) => {
      if (!enabled() || state.sCount[startLine] - state.blkIndent >= 4) return false;
      const lineText = (n: number) => state.src.slice(state.bMarks[n] + state.tShift[n], state.eMarks[n]);
      const head = lineText(startLine);
      if (!head.startsWith("$$")) return false;
      const rest = head.slice(2).trimEnd();
      let last = startLine;
      let content: string;
      if (rest.endsWith("$$") && rest.length > 2) {
        content = rest.slice(0, -2);
      } else {
        const lines = rest ? [rest] : [];
        for (last = startLine + 1; last < endLine; last++) {
          const s = lineText(last).trimEnd();
          if (s.endsWith("$$")) {
            lines.push(s.slice(0, -2));
            break;
          }
          lines.push(s);
        }
        if (last >= endLine) return false;
        content = lines.join("\n");
      }
      if (!content.trim()) return false;
      if (silent) return true;
      state.line = last + 1;
      const t = state.push("math_block", "math", 0);
      t.block = true;
      t.content = content.trim();
      t.map = [startLine, state.line];
      t.markup = "$$";
      return true;
    },
    { alt: ["paragraph", "reference", "blockquote", "list"] },
  );

  md.renderer.rules.math_inline = (tokens, idx) =>
    `<span class="diagram math-inline" data-kind="math-inline"><code class="diagram-src">${esc(tokens[idx].content)}</code></span>`;
  md.renderer.rules.math_block = (tokens, idx) => {
    const t = tokens[idx];
    const line = t.map ? ` data-line="${t.map[0]}"` : "";
    return `<div class="diagram" data-kind="math"${line}><pre class="diagram-src">${esc(t.content)}</pre></div>\n`;
  };
}
