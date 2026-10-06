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
  c4: "c4",
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

/** 画像の段落の直後に置く注釈のコメント（中身は JSON。annotations.ts 参照） */
export const ANNOTATE_COMMENT = /^\s*<!--\s*annotate\s+([\s\S]*?)\s*-->\s*$/;

// 画像に文書内の通し番号（data-img-n。プレビューからソースの位置を探すため）を付ける。
// 画像の段落の直後が注釈のコメントなら、その段落の最後の画像に data-annotate として移す
// （コメントは DOMPurify に消されるため）
md.core.ruler.push("image_annotations", (state) => {
  const tokens = state.tokens;
  let n = 0;
  tokens.forEach((t, i) => {
    if (t.type !== "inline" || !t.children) return;
    let last = null;
    for (const c of t.children) {
      if (c.type !== "image") continue;
      c.attrSet("data-img-n", String(n++));
      last = c;
    }
    const next = tokens[i + 2];
    if (!last || tokens[i + 1]?.type !== "paragraph_close" || next?.type !== "html_block") return;
    const m = ANNOTATE_COMMENT.exec(next.content);
    if (!m) return;
    last.attrSet("data-annotate", m[1]);
    next.content = "";
  });
});

/**
 * n 番目の画像（data-img-n）がソースのどこにあるか（0 始まりの行と列）。
 * 段落の行範囲を markdown-it で求め、その中で ![..](..) を数える（コードブロック内の ![..] を数えないため）
 */
export function findImageSource(src: string, n: number): { line: number; ch: number } | null {
  let seen = 0;
  /** 直前に行範囲が分かったブロック（表のセルの inline には行範囲がないので、行の範囲で代用する） */
  let lastMap: [number, number] | null = null;
  /** lastMap の範囲で、前のセルまでにあった画像の数 */
  let before = 0;
  for (const t of md.parse(src, {})) {
    if (t.map && t.type !== "inline") {
      lastMap = t.map;
      before = 0;
    }
    if (t.type !== "inline" || !t.children) continue;
    const images = t.children.filter((c) => c.type === "image").length;
    if (n >= seen + images) {
      seen += images;
      if (!t.map) before += images;
      continue;
    }
    const map = t.map ?? lastMap;
    if (!map) return null;
    const lines = src.split("\n");
    const re = /!\[[^\]]*\]\(/g;
    let k = n - seen + (t.map ? 0 : before);
    for (let line = map[0]; line < map[1]; line++) {
      for (const m of lines[line].matchAll(re)) {
        if (k-- === 0) return { line, ch: m.index };
      }
    }
    return null;
  }
  return null;
}

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
