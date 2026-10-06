// C4 図の書き方（Mermaid / C4-PlantUML 互換のマクロ）を Graphviz の DOT に変換する。
// Mermaid の C4 は線の経路や配置を制御できないので、レイアウトは Graphviz に任せ、
// Rel_R / Lay_D などの方向指定で配置を誘導できるようにする。

interface ElementKind {
  /** 種別の表示（[Container: 技術] の「Container」） */
  type: string;
  bg: string;
  border: string;
  font: string;
  db?: boolean;
  /** 引数が (id, 名前, 技術, 説明) か（false なら (id, 名前, 説明)） */
  techn: boolean;
}

// 色は C4-PlantUML の標準に合わせる
const PERSON = { bg: "#08427b", border: "#073b6f", font: "#ffffff" };
const PERSON_EXT = { bg: "#686868", border: "#4d4d4d", font: "#ffffff" };
const SYSTEM = { bg: "#1168bd", border: "#0b4884", font: "#ffffff" };
const SYSTEM_EXT = { bg: "#999999", border: "#8a8a8a", font: "#ffffff" };
const CONTAINER = { bg: "#438dd5", border: "#3c7fc0", font: "#ffffff" };
const CONTAINER_EXT = { bg: "#b3b3b3", border: "#a6a6a6", font: "#ffffff" };
const COMPONENT = { bg: "#85bbf0", border: "#78a8d8", font: "#000000" };
const COMPONENT_EXT = { bg: "#cccccc", border: "#bfbfbf", font: "#000000" };

const ELEMENTS: Record<string, ElementKind> = {
  Person: { type: "Person", ...PERSON, techn: false },
  Person_Ext: { type: "External Person", ...PERSON_EXT, techn: false },
  System: { type: "Software System", ...SYSTEM, techn: false },
  SystemDb: { type: "Software System", ...SYSTEM, db: true, techn: false },
  System_Ext: { type: "External System", ...SYSTEM_EXT, techn: false },
  SystemDb_Ext: { type: "External System", ...SYSTEM_EXT, db: true, techn: false },
  Container: { type: "Container", ...CONTAINER, techn: true },
  ContainerDb: { type: "Container", ...CONTAINER, db: true, techn: true },
  Container_Ext: { type: "External Container", ...CONTAINER_EXT, techn: true },
  ContainerDb_Ext: { type: "External Container", ...CONTAINER_EXT, db: true, techn: true },
  Component: { type: "Component", ...COMPONENT, techn: true },
  ComponentDb: { type: "Component", ...COMPONENT, db: true, techn: true },
  Component_Ext: { type: "External Component", ...COMPONENT_EXT, techn: true },
  ComponentDb_Ext: { type: "External Component", ...COMPONENT_EXT, db: true, techn: true },
};

/** 囲み → 種別の表示（空なら出さない） */
const BOUNDARIES: Record<string, string> = {
  Boundary: "",
  System_Boundary: "System",
  Container_Boundary: "Container",
  Enterprise_Boundary: "Enterprise",
};

/** 線の方向。null は図全体の向き（LAYOUT_*）に従う */
type Dir = "D" | "U" | "R" | "L" | null;
const RELS: Record<string, { dir: Dir; both?: boolean; invis?: boolean }> = {
  Rel: { dir: null },
  Rel_D: { dir: "D" },
  Rel_Down: { dir: "D" },
  Rel_U: { dir: "U" },
  Rel_Up: { dir: "U" },
  Rel_R: { dir: "R" },
  Rel_Right: { dir: "R" },
  Rel_L: { dir: "L" },
  Rel_Left: { dir: "L" },
  BiRel: { dir: null, both: true },
  BiRel_D: { dir: "D", both: true },
  BiRel_U: { dir: "U", both: true },
  BiRel_R: { dir: "R", both: true },
  BiRel_L: { dir: "L", both: true },
  Lay_D: { dir: "D", invis: true },
  Lay_U: { dir: "U", invis: true },
  Lay_R: { dir: "R", invis: true },
  Lay_L: { dir: "L", invis: true },
};

/** Mermaid / C4-PlantUML から貼り替えても壊れないよう、黙って無視するマクロ */
const IGNORED = new Set([
  "UpdateRelStyle",
  "UpdateLayoutConfig",
  "UpdateBoundaryStyle",
  "SHOW_LEGEND",
  "LAYOUT_WITH_LEGEND",
  "HIDE_STEREOTYPE",
  "SHOW_PERSON_OUTLINE",
]);

const FONT = "Yu Gothic UI,Meiryo,sans-serif";
/** 説明を折り返す幅（半角 1・全角 2 で数える）。Graphviz の文字幅の見積もりが全角で少し狭いので控えめにする */
const WRAP = 26;

interface Args {
  pos: string[];
  named: Record<string, string>;
}

interface Node {
  id: string;
  kind: ElementKind;
  label: string;
  techn: string;
  descr: string;
  style: Record<string, string>;
}

interface Edge {
  from: string;
  to: string;
  label: string;
  techn: string;
  dir: Dir;
  both: boolean;
  invis: boolean;
  line: number;
}

const htmlEsc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** 文字列中の \n で改行し、wrap > 0 なら長い行をその幅で折り返す */
function wrapLines(text: string, wrap = 0): string[] {
  const out: string[] = [];
  for (const part of text.split("\\n")) {
    if (!wrap) {
      out.push(part);
      continue;
    }
    let cur = "";
    let width = 0;
    for (const ch of part) {
      const w = ch.charCodeAt(0) > 0xff ? 2 : 1;
      if (width + w > wrap && cur) {
        out.push(cur);
        cur = "";
        width = 0;
      }
      cur += ch;
      width += w;
    }
    out.push(cur);
  }
  return out;
}

/** HTML ラベル用に、改行を <br/> にしてエスケープする */
const lines = (text: string, wrap = 0) => wrapLines(text, wrap).map(htmlEsc).join("<br/>");

/**
 * 文字列の表示幅（インチ）の見積もり。Graphviz は全角文字の幅を狭く見積もって
 * 箱から文字がはみ出すので、全角は 1 文字 = フォントサイズとして最小幅を自前で決める
 */
function textWidth(text: string, size: number): number {
  let pt = 0;
  for (const ch of text) pt += ch.charCodeAt(0) > 0xff ? size : size * 0.6;
  return pt / 72;
}

/** カンマ区切りの引数を分ける（"…" 内のカンマは区切らない。$key="値" は名前付き） */
function parseArgs(s: string): Args {
  const parts: string[] = [];
  let cur = "";
  let inStr = false;
  for (const ch of s) {
    if (ch === '"') inStr = !inStr;
    if (ch === "," && !inStr) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim() || parts.length) parts.push(cur);
  const unquote = (v: string) => {
    const t = v.trim();
    return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
  };
  const args: Args = { pos: [], named: {} };
  for (const p of parts) {
    const m = /^\s*\$(\w+)\s*=(.*)$/.exec(p);
    if (m) args.named[m[1]] = unquote(m[2]);
    else args.pos.push(unquote(p));
  }
  return args;
}

/** C4 のソースを DOT に変換する。書き方に誤りがあれば「N 行目: …」の Error を投げる */
export function c4ToDot(src: string): string {
  let title = "";
  let rankdir = "TB";
  const raw: string[] = [];
  const nodes = new Map<string, Node>();
  const edges: Edge[] = [];
  const styles: { id: string; style: Record<string, string>; line: number }[] = [];
  // 囲みの入れ子。各段は DOT の本文（ノード宣言・サブグラフ）
  const root: string[] = [];
  const stack: { body: string[]; id: string; first: string | null }[] = [];
  /** 囲みの id → 中の最初の要素（囲みへの線を引くため） */
  const boundaries = new Map<string, { first: string | null }>();
  const body = () => (stack.length ? stack[stack.length - 1].body : root);

  const srcLines = src.replace(/\r\n/g, "\n").split("\n");
  srcLines.forEach((rawLine, i) => {
    const no = i + 1;
    const fail = (msg: string): never => {
      throw new Error(`${no} 行目: ${msg}`);
    };
    const line = rawLine.trim();
    if (!line || line.startsWith("%%") || line.startsWith("'")) return;
    if (/^C4(Context|Container|Component|Dynamic|Deployment)\b/.test(line)) return;
    if (/^@(start|end)uml\b/.test(line) || /^!include/.test(line)) return;

    const t = /^title\s+(.*)$/.exec(line);
    if (t) {
      title = t[1].trim();
      return;
    }
    const d = /^dot:\s*(.*)$/.exec(line);
    if (d) {
      raw.push(d[1]);
      return;
    }
    if (line === "}") {
      const b = stack.pop() ?? fail("対応する { がありません");
      body().push(`subgraph ${quote(`cluster_${b.id}`)} {`, ...b.body.map((l) => `  ${l}`), "}");
      return;
    }

    const m = /^(\w+)\s*(?:\((.*)\))?\s*(\{)?$/.exec(line) ?? fail(`読み取れません: ${line}`);
    const name = m[1];
    const open = m[3] === "{";
    const args = parseArgs(m[2] ?? "");

    if (name === "LAYOUT_TOP_DOWN") {
      rankdir = "TB";
      return;
    }
    if (name === "LAYOUT_LEFT_RIGHT" || name === "LAYOUT_LANDSCAPE") {
      rankdir = "LR";
      return;
    }
    if (IGNORED.has(name)) return;

    const kind = ELEMENTS[name];
    if (kind) {
      const [id, label = id, a3 = "", a4 = ""] = args.pos;
      if (!id) fail(`${name} に id がありません`);
      if (nodes.has(id)) fail(`id「${id}」が重複しています`);
      const techn = args.named.techn ?? (kind.techn ? a3 : "");
      const descr = args.named.descr ?? (kind.techn ? a4 : a3);
      nodes.set(id, { id, kind, label, techn, descr, style: {} });
      body().push(`${quote(id)};`);
      for (const b of stack) b.first ??= id;
      if (open) fail(`${name} は { で囲めません`);
      return;
    }

    if (name in BOUNDARIES) {
      const [id, label = id, type = BOUNDARIES[name]] = args.pos;
      if (!id) fail(`${name} に id がありません`);
      if (!open) fail(`${name} の後ろに { が必要です`);
      const b = { body: [] as string[], id, first: null as string | null };
      boundaries.set(id, b);
      const typeLine = type ? `<br/><font point-size="10">[${htmlEsc(type)}]</font>` : "";
      b.body.push(
        `label=<<b>${lines(label)}</b>${typeLine}>; labeljust=l; fontsize=12; style="dashed,rounded"; color="#444444"; fontcolor="#444444";`,
      );
      stack.push(b);
      return;
    }

    const rel = RELS[name];
    if (rel) {
      const [from, to, label = "", techn = ""] = args.pos;
      if (!from || !to) fail(`${name} には元と先の id が必要です`);
      edges.push({
        from,
        to,
        label: args.named.label ?? label,
        techn: args.named.techn ?? techn,
        ...rel,
        both: !!rel.both,
        invis: !!rel.invis,
        line: no,
      });
      return;
    }

    if (name === "UpdateElementStyle") {
      const [id] = args.pos;
      if (!id) fail("UpdateElementStyle に id がありません");
      styles.push({ id, style: args.named, line: no });
      return;
    }

    fail(`未対応の書き方です: ${name}`);
  });
  if (stack.length) throw new Error(`囲み「${stack[stack.length - 1].id}」の } がありません`);

  for (const s of styles) {
    const n = nodes.get(s.id);
    if (!n) throw new Error(`${s.line} 行目: id「${s.id}」の要素がありません`);
    Object.assign(n.style, s.style);
  }

  const out: string[] = [
    "digraph C4 {",
    `  graph [rankdir=${rankdir}, newrank=true, compound=true, nodesep=0.7, ranksep=0.8, fontname=${quote(FONT)}, pad=0.2];`,
    `  node [fontname=${quote(FONT)}, fontsize=12, margin="0.25,0.12"];`,
    `  edge [fontname=${quote(FONT)}, fontsize=10, color="#707070", fontcolor="#555555", arrowsize=0.8];`,
  ];
  if (title) out.push(`  label=<<b>${lines(title)}</b>>; labelloc=t; fontsize=16;`);
  for (const r of raw) out.push(`  ${r}`);

  for (const n of nodes.values()) {
    const type = n.techn ? `${n.kind.type}: ${n.techn}` : n.kind.type;
    let label = `<b>${lines(n.label)}</b><br/><font point-size="9">[${lines(type)}]</font>`;
    if (n.descr) label += `<br/><br/>${lines(n.descr, WRAP)}`;
    const bg = n.style.bgColor ?? n.kind.bg;
    const border = n.style.borderColor ?? n.kind.border;
    const font = n.style.fontColor ?? n.kind.font;
    const shape = n.kind.db ? `shape=cylinder, style=filled` : `shape=box, style="rounded,filled"`;
    // 最小幅 = 一番長い行 + 左右の余白（margin 0.25 × 2）
    const widths = [
      ...n.label.split("\\n").map((s) => textWidth(s, 12) * 1.1),
      textWidth(`[${type}]`, 9),
      ...wrapLines(n.descr, WRAP).map((s) => textWidth(s, 12)),
    ];
    const width = (Math.max(...widths) + 0.5).toFixed(2);
    out.push(
      `  ${quote(n.id)} [${shape}, width=${width}, fillcolor=${quote(bg)}, color=${quote(border)}, fontcolor=${quote(font)}, label=<${label}>];`,
    );
  }
  out.push(...root.map((l) => `  ${l}`));

  /** 線の端：要素ならその id、囲みなら中の最初の要素（枠で止める） */
  const end = (id: string, line: number): { node: string; cluster?: string } => {
    if (nodes.has(id)) return { node: id };
    const b = boundaries.get(id);
    if (b?.first) return { node: b.first, cluster: `cluster_${id}` };
    throw new Error(`${line} 行目: id「${id}」の要素がありません`);
  };

  // 段（上下）は辺の向きで、同じ段の左右は rank=same で決める。
  // 縦並び（TB）なら D/U が段、横並び（LR）なら R/L が段になる
  const along = (dir: Dir) =>
    dir === null || (rankdir === "TB" ? dir === "D" || dir === "U" : dir === "R" || dir === "L");
  for (const e of edges) {
    const a = end(e.from, e.line);
    const b = end(e.to, e.line);
    // U / L は逆向きの辺にして元を後ろの段（または右・下）に置き、矢印は dir=back で元から先へ向ける
    const reverse = e.dir === "U" || e.dir === "L";
    const [tail, head] = reverse ? [b, a] : [a, b];
    const attrs: string[] = [];
    if (e.invis) attrs.push("style=invis");
    else {
      let label = e.label ? lines(e.label) : "";
      if (e.techn) label += `${label ? "<br/>" : ""}<font point-size="9">[${lines(e.techn)}]</font>`;
      if (label) attrs.push(`label=<${label}>`);
      if (e.both) attrs.push("dir=both");
      else if (reverse) attrs.push("dir=back");
    }
    if (tail.cluster) attrs.push(`ltail=${quote(tail.cluster)}`);
    if (head.cluster) attrs.push(`lhead=${quote(head.cluster)}`);
    out.push(`  ${quote(tail.node)} -> ${quote(head.node)}${attrs.length ? ` [${attrs.join(", ")}]` : ""};`);
    if (!along(e.dir)) out.push(`  { rank=same; ${quote(tail.node)}; ${quote(head.node)}; }`);
  }
  out.push("}");
  return out.join("\n");
}
