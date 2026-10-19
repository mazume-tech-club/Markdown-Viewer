// ---------- マインドマップ（```markmap / ```mindmap-md） ----------
// 普通の Markdown の見出しと箇条書きを、左から右へ枝分かれするマインドマップにする（オプション機能）。
// markmap と同じ書き方。markmap 本体は節を foreignObject（SVG の中の HTML）で描き、無害化すると消えるので、
// ここで木に直して DOT にし、Graphviz で描く（diagrams.ts）

import { COLOR, FONT, html, textWidth } from "./dotutil";

export interface MindNode {
  text: string;
  children: MindNode[];
}

/** 文字の飾り（**太字**・`コード`・[リンク](url)）を外す */
const plain = (s: string) =>
  s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(\*|_)(.+?)\1/g, "$2")
    .replace(/`([^`]*)`/g, "$1")
    .trim();

const width = (s: string) => s.replace(/\t/g, "    ").length;

/** 見出しと箇条書きを木にする。いちばん上が 1 つならそれを根に、複数なら title（無ければ空）の根の下に並べる */
export function parseMindmap(src: string): { title: string; root: MindNode } {
  let title = "";
  const top: MindNode[] = [];
  /** 今開いている節（深さの順）。見出しは深さ = レベル、箇条書きはその下に字下げで入れ子 */
  const stack: { node: MindNode; depth: number; indent: number }[] = [];
  let headingDepth = 0;

  const add = (node: MindNode, depth: number, indent: number) => {
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    (stack.length ? stack[stack.length - 1].node.children : top).push(node);
    stack.push({ node, depth, indent });
  };

  src.split(/\r?\n/).forEach((raw, i) => {
    const n = i + 1;
    if (!raw.trim() || raw.trim().startsWith("%%")) return;
    const t = /^title\s+(.+)$/i.exec(raw.trim());
    if (t) {
      title = plain(t[1]);
      return;
    }
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw);
    if (h) {
      headingDepth = h[1].length;
      add({ text: plain(h[2]), children: [] }, headingDepth, -1);
      return;
    }
    const li = /^(\s*)(?:[-*+]|\d+[.)])\s+(.+)$/.exec(raw);
    if (!li) throw new Error(`${n} 行目: 見出し（#）か箇条書き（-）で書いてください`);
    const indent = width(li[1]);
    // 字下げが前の箇条書きより深ければその子、同じなら兄弟、浅ければ同じ字下げの所まで戻る
    let depth = headingDepth + 1;
    for (let k = stack.length - 1; k >= 0; k--) {
      const s = stack[k];
      if (s.indent < 0) break;
      if (indent > s.indent) {
        depth = s.depth + 1;
        break;
      }
      depth = s.depth;
    }
    add({ text: plain(li[2]), children: [] }, depth, indent);
  });

  if (!top.length) throw new Error("見出し（#）か箇条書き（-）を書いてください");
  const root = top.length === 1 && !title ? top[0] : { text: title, children: top };
  return { title, root };
}

/** 枝ごとの色（白地で読める濃さ） */
const COLORS = [COLOR.accent, "#c4432b", "#5b3fa8", "#2f7d32", "#b5651d", "#1f5fae", "#a8326e", COLOR.muted];

/** 節の幅（インチ）。Graphviz は日本語を狭く見積もるので、文字幅から決める */
const nodeWidth = (text: string, size: number, pad: number) => ((textWidth(text, size) + pad) / 72).toFixed(2);

export function mindmapToDot(map: { root: MindNode }): string {
  const out = [
    "digraph mindmap {",
    `  graph [rankdir=LR, nodesep=0.15, ranksep=0.45, pad=0.2, fontname="${FONT}"];`,
    `  node [shape=underline, fontname="${FONT}", fontsize=12, margin="0.08,0.03", height=0.3];`,
    "  edge [arrowhead=none, penwidth=1.6];",
  ];
  let seq = 0;
  const walk = (node: MindNode, depth: number, color: string): string => {
    const id = `n${seq++}`;
    if (depth === 0) {
      out.push(
        node.text
          ? `  ${id} [label=<<b>${html(node.text)}</b>>, shape=box, style="rounded,filled", fillcolor="${COLOR.ground}", color="${COLOR.muted}", fontsize=15, margin="0.2,0.1", width=${nodeWidth(node.text, 16.5, 30)}];`
          : `  ${id} [label="", shape=point, width=0.12, color="${COLOR.muted}"];`,
      );
    } else {
      const size = Math.max(11, 14 - depth);
      out.push(`  ${id} [label=<${html(node.text)}>, color="${color}", fontsize=${size}, width=${nodeWidth(node.text, size, 12)}];`);
    }
    node.children.forEach((c, i) => {
      const cc = depth === 0 ? COLORS[i % COLORS.length] : color;
      const cid = walk(c, depth + 1, cc);
      out.push(`  ${id} -> ${cid} [color="${cc}", penwidth=${Math.max(1, 3 - depth * 0.6).toFixed(1)}];`);
    });
    return id;
  };
  walk(map.root, 0, COLORS[0]);
  out.push("}");
  return out.join("\n");
}
