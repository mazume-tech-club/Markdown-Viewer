import MarkdownIt from "markdown-it";
import anchor from "markdown-it-anchor";
import footnote from "markdown-it-footnote";
import taskLists from "markdown-it-task-lists";
import hljs from "highlight.js/lib/common";
import DOMPurify from "dompurify";
import { commentSafe, parseAnnotation } from "./annotations";

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
  return imagePositions(src)[n] ?? null;
}

/** 文書内のすべての画像の ![ の位置（data-img-n の順）。見つからなかった画像は null */
function imagePositions(src: string): ({ line: number; ch: number } | null)[] {
  const out: ({ line: number; ch: number } | null)[] = [];
  const lines = src.split("\n");
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
    if (!images) continue;
    const map = t.map ?? lastMap;
    const found: { line: number; ch: number }[] = [];
    if (map) {
      for (let line = map[0]; line < map[1]; line++) {
        for (const m of lines[line].matchAll(/!\[[^\]]*\]\(/g)) found.push({ line, ch: m.index });
      }
    }
    const skip = t.map ? 0 : before;
    for (let k = 0; k < images; k++) out.push(found[skip + k] ?? null);
    if (!t.map) before += images;
  }
  return out;
}

/**
 * 本文中の画像の参照。image は ![..](ここ) のリンク（<..> で囲んだものは囲みごと）、
 * annotate は注釈のコメントの "src" の値（JSON の文字列。引用符ごと）。start/end は本文の文字位置
 */
export interface ImageRef {
  kind: "image" | "annotate";
  start: number;
  end: number;
  /** 書かれているリンク（<..> や JSON のエスケープを外したもの。%xx はそのまま） */
  link: string;
}

/** 本文から画像の参照（画像のリンクと注釈の元画像）を集める。コードブロックの中は数えない */
export function findImageRefs(src: string): ImageRef[] {
  const lineStart = [0];
  for (let i = src.indexOf("\n"); i >= 0; i = src.indexOf("\n", i + 1)) lineStart.push(i + 1);
  const refs: ImageRef[] = [];
  for (const pos of imagePositions(src)) {
    if (!pos) continue;
    const ref = linkAt(src, src.indexOf("](", lineStart[pos.line] + pos.ch) + 2);
    if (ref) refs.push(ref);
  }
  for (const t of md.parse(src, {})) {
    if (t.type !== "html_block" || !t.map) continue;
    const start = lineStart[t.map[0]];
    const end = t.map[1] < lineStart.length ? lineStart[t.map[1]] : src.length;
    const block = src.slice(start, end);
    const m = ANNOTATE_COMMENT.exec(block);
    const a = m && parseAnnotation(m[1]);
    if (!a) continue;
    // コメントには < > -- を \u エスケープして書くので、どちらの書き方でも探す
    const plain = JSON.stringify(a.src);
    for (const lit of [plain, commentSafe(plain)]) {
      const i = block.indexOf(`"src":${lit}`);
      if (i < 0) continue;
      const s = start + i + 6;
      refs.push({ kind: "annotate", start: s, end: s + lit.length, link: a.src });
      break;
    }
  }
  return refs.sort((x, y) => x.start - y.start);
}

/** ]( の直後の位置 i から、画像のリンクを読む（空白の後のタイトルは含めない） */
function linkAt(src: string, i: number): ImageRef | null {
  if (i < 2) return null;
  while (src[i] === " " || src[i] === "\t" || src[i] === "\n") i++;
  if (src[i] === "<") {
    const end = src.indexOf(">", i);
    return end < 0 ? null : { kind: "image", start: i, end: end + 1, link: src.slice(i + 1, end) };
  }
  let depth = 0;
  let j = i;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") j++;
    else if (c === "(") depth++;
    else if (c === ")" && depth-- === 0) break;
    else if (/\s/.test(c)) break;
  }
  return j > i ? { kind: "image", start: i, end: j, link: src.slice(i, j) } : null;
}

/**
 * fence の info を言語名とコードラベルに分ける。Qiita と同じく ```ruby:qiita.rb ならファイル名を、
 * 言語名だけならその言語名を、書いたとおりにラベルにする。lang は色付け・図の判定用に小文字にする
 */
export function parseFenceInfo(info: string): { lang: string; label: string } {
  const m = /^([^\s:]*)(?::(.*))?/.exec(info.trim())!;
  const file = m[2]?.trim() ?? "";
  return { lang: m[1].toLowerCase(), label: file || m[1] };
}

// fence: 図はプレースホルダに、コードはコードラベル付きの pre に
md.renderer.rules.fence = (tokens, idx, options) => {
  const t = tokens[idx];
  const { lang, label } = parseFenceInfo(t.info);
  const line = t.map ? ` data-line="${t.map[0]}"` : "";
  const kind = DIAGRAM_KINDS[lang];
  if (kind) {
    return `<div class="diagram" data-kind="${kind}"${line}><pre class="diagram-src">${esc(t.content)}</pre></div>\n`;
  }
  const body = options.highlight?.(t.content, lang, "") ?? esc(t.content);
  const cls = lang ? ` class="hljs language-${esc(lang)}"` : ` class="hljs"`;
  if (!label) return `<pre${line}><code${cls}>${body}</code></pre>\n`;
  // ラベルごと編集位置の色付け・スクロール同期の対象にするため、data-line は外側に付ける
  return `<div class="code-block"${line}><span class="code-label">${esc(label)}</span><pre><code${cls}>${body}</code></pre></div>\n`;
};

/** Markdown を安全な HTML 文字列に変換する */
export function renderMarkdown(src: string): string {
  const html = md.render(src);
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ["target"],
    FORBID_TAGS: ["style"],
  });
}
