import MarkdownIt from "markdown-it";
import anchor from "markdown-it-anchor";
import footnote from "markdown-it-footnote";
import taskLists from "markdown-it-task-lists";
import hljs from "highlight.js/lib/common";
import DOMPurify from "dompurify";

/** 図として描画する fence の言語名 → 種別 */
export const DIAGRAM_KINDS: Record<string, string> = {
  mermaid: "mermaid",
  dot: "graphviz",
  graphviz: "graphviz",
  wavedrom: "wavedrom",
};

/** GitHub 風の見出しスラッグ（日本語はそのまま残す） */
export function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}\-_]/gu, "");
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const md = new MarkdownIt({
  html: true,
  linkify: true,
  highlight(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      } catch {
        /* fall through */
      }
    }
    return esc(code);
  },
})
  .use(anchor, { slugify })
  .use(footnote)
  .use(taskLists, { label: true });

// スクロール同期用に、ブロック要素へソースの行番号を付ける
md.core.ruler.push("source_line", (state) => {
  for (const t of state.tokens) {
    if (t.map && t.block && t.nesting !== -1) t.attrSet("data-line", String(t.map[0]));
  }
});

// fence: 図はプレースホルダに、コードは行番号付きの pre に
md.renderer.rules.fence = (tokens, idx, options) => {
  const t = tokens[idx];
  const lang = t.info.trim().split(/\s+/)[0].toLowerCase();
  const line = t.map ? ` data-line="${t.map[0]}"` : "";
  const kind = DIAGRAM_KINDS[lang];
  if (kind) {
    return `<div class="diagram" data-kind="${kind}"${line}><pre class="diagram-src">${esc(t.content)}</pre></div>\n`;
  }
  const body = options.highlight?.(t.content, lang, "") ?? esc(t.content);
  const cls = lang ? ` class="hljs language-${esc(lang)}"` : ` class="hljs"`;
  return `<pre${line}><code${cls}>${body}</code></pre>\n`;
};

/** Markdown を安全な HTML 文字列に変換する */
export function renderMarkdown(src: string): string {
  const html = md.render(src);
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ["target"],
    FORBID_TAGS: ["style"],
  });
}
