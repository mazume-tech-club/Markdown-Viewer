// C4 図の書き方（Mermaid / C4-PlantUML 互換のマクロ）を Graphviz の DOT に変換する。
// Mermaid の C4 は線の経路や配置を制御できないので、レイアウトは Graphviz に任せ、
// Rel_R / Lay_D などの方向指定で配置を誘導できるようにする。解析は c4model.ts。

import { BOUNDARY_TYPES, isFreeLayout, parseC4, walk, type C4Element, type C4Model, type C4Node, type Dir } from "./c4model";


interface ElementKind {
  /** 種別の表示（[Container: 技術] の「Container」） */
  type: string;
  bg: string;
  border: string;
  font: string;
  db?: boolean;
  /** 人のアイコンを付けるか（Person / Person_Ext） */
  person?: boolean;
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
  Person: { type: "Person", ...PERSON, person: true },
  Person_Ext: { type: "External Person", ...PERSON_EXT, person: true },
  System: { type: "Software System", ...SYSTEM },
  SystemDb: { type: "Software System", ...SYSTEM, db: true },
  System_Ext: { type: "External System", ...SYSTEM_EXT },
  SystemDb_Ext: { type: "External System", ...SYSTEM_EXT, db: true },
  Container: { type: "Container", ...CONTAINER },
  ContainerDb: { type: "Container", ...CONTAINER, db: true },
  Container_Ext: { type: "External Container", ...CONTAINER_EXT },
  ContainerDb_Ext: { type: "External Container", ...CONTAINER_EXT, db: true },
  Component: { type: "Component", ...COMPONENT },
  ComponentDb: { type: "Component", ...COMPONENT, db: true },
  Component_Ext: { type: "External Component", ...COMPONENT_EXT },
  ComponentDb_Ext: { type: "External Component", ...COMPONENT_EXT, db: true },
};

const FONT = "Yu Gothic UI,Meiryo,sans-serif";
/** 人のアイコン用に、ラベルの上に空ける行の高さ（pt） */
const PERSON_ICON_SPACE = 22;
// Graphviz は class 名の「-」を &#45; にするので使わない
const PERSON_CLASS = "c4person";
/** 説明を折り返す幅（半角 1・全角 2 で数える）。Graphviz の文字幅の見積もりが全角で少し狭いので控えめにする */
const WRAP = 26;

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

/** 線（Rel / Lay）の SVG 上の id。プレビューで線をクリックしたときに、どの関係かを知るため */
export const relSvgId = (index: number) => `c4rel${index}`;

/** C4 のソースを DOT に変換する。書き方に誤りがあれば「N 行目: …」の Error を投げる */
export function c4ToDot(src: string): string {
  return modelToDot(parseC4(src, true));
}

/** 読み込み済みの C4 の図を DOT に変換する */
export function modelToDot(model: C4Model): string {
  const rankdir = model.layout;
  const elements = new Map<string, C4Element>();
  /** 囲みの id → 中の最初の要素（囲みへの線を引くため） */
  const firstIn = new Map<string, string | null>();
  for (const n of walk(model.nodes)) {
    if (n.type === "element") elements.set(n.id, n);
    else firstIn.set(n.id, [...walk(n.children)].find((c) => c.type === "element")?.id ?? null);
  }
  const styles = new Map<string, Record<string, string>>();
  for (const s of model.styles) {
    if (!elements.has(s.id)) throw new Error(`${s.line} 行目: id「${s.id}」の要素がありません`);
    styles.set(s.id, { ...styles.get(s.id), ...s.props });
  }

  // 自由配置: 位置を固定して neato で線だけ引く（囲みは neato が描かないので drawBoundaries で描き足す）
  const free = isFreeLayout(model);
  const out: string[] = [
    "digraph C4 {",
    free
      ? `  graph [layout=neato, inputscale=72, splines=true, overlap=false, sep="+12", fontname=${quote(FONT)}, pad=0.8];`
      : `  graph [rankdir=${rankdir}, newrank=true, compound=true, nodesep=0.7, ranksep=0.8, fontname=${quote(FONT)}, pad=0.2];`,
    `  node [fontname=${quote(FONT)}, fontsize=12, margin="0.25,0.12"];`,
    `  edge [fontname=${quote(FONT)}, fontsize=10, color="#707070", fontcolor="#555555", arrowsize=0.8];`,
  ];
  if (model.title) out.push(`  label=<<b>${lines(model.title)}</b>>; labelloc=t; fontsize=16;`);
  for (const r of model.dot) out.push(`  ${r}`);

  for (const n of elements.values()) {
    const kind = ELEMENTS[n.macro];
    const style = styles.get(n.id) ?? {};
    const type = n.techn ? `${kind.type}: ${n.techn}` : kind.type;
    let label = `<b>${lines(n.label)}</b><br/><font point-size="9">[${lines(type)}]</font>`;
    if (n.descr) label += `<br/><br/>${lines(n.descr, WRAP)}`;
    // 人は上に空行を入れておき、描画後に drawPersonIcons でそこへアイコンを描く
    if (kind.person) label = `<font point-size="${PERSON_ICON_SPACE}"> </font><br/>${label}`;
    const cls = kind.person ? `, class="${PERSON_CLASS}"` : "";
    const bg = style.bgColor ?? kind.bg;
    const border = style.borderColor ?? kind.border;
    const font = style.fontColor ?? kind.font;
    const shape = kind.db ? `shape=cylinder, style=filled` : `shape=box, style="rounded,filled"`;
    // 最小幅 = 一番長い行 + 左右の余白（margin 0.25 × 2）
    const widths = [
      ...n.label.split("\\n").map((s) => textWidth(s, 12) * 1.1),
      textWidth(`[${type}]`, 9),
      ...wrapLines(n.descr, WRAP).map((s) => textWidth(s, 12)),
    ];
    const width = (Math.max(...widths) + 0.5).toFixed(2);
    const p = free ? model.positions[n.id] : undefined;
    const pos = p ? `, pos="${p.x},${p.y}!"` : "";
    out.push(
      `  ${quote(n.id)} [${shape}${cls}${pos}, width=${width}, fillcolor=${quote(bg)}, color=${quote(border)}, fontcolor=${quote(font)}, label=<${label}>];`,
    );
  }

  // 囲みの入れ子（ノードの参照とサブグラフ）
  const tree = (nodes: C4Node[], indent: string) => {
    for (const n of nodes) {
      if (n.type === "element") {
        out.push(`${indent}${quote(n.id)};`);
        continue;
      }
      const type = n.typeLabel ?? BOUNDARY_TYPES[n.macro];
      const typeLine = type ? `<br/><font point-size="10">[${htmlEsc(type)}]</font>` : "";
      out.push(`${indent}subgraph ${quote(`cluster_${n.id}`)} {`);
      out.push(
        `${indent}  label=<<b>${lines(n.label)}</b>${typeLine}>; labeljust=l; fontsize=12; style="dashed,rounded"; color="#444444"; fontcolor="#444444";`,
      );
      tree(n.children, `${indent}  `);
      out.push(`${indent}}`);
    }
  };
  if (!free) tree(model.nodes, "  ");

  /** 線の端：要素ならその id、囲みなら中の最初の要素（枠で止める） */
  const end = (id: string, line: number): { node: string; cluster?: string } => {
    if (elements.has(id)) return { node: id };
    const first = firstIn.get(id);
    if (first) return { node: first, cluster: `cluster_${id}` };
    throw new Error(`${line} 行目: id「${id}」の要素がありません`);
  };

  // 段（上下）は辺の向きで、同じ段の左右は rank=same で決める。
  // 縦並び（TB）なら D/U が段、横並び（LR）なら R/L が段になる
  const along = (dir: Dir) =>
    dir === null || (rankdir === "TB" ? dir === "D" || dir === "U" : dir === "R" || dir === "L");
  model.rels.forEach((e, i) => {
    const a = end(e.from, e.line);
    const b = end(e.to, e.line);
    // U / L は逆向きの辺にして元を後ろの段（または右・下）に置き、矢印は dir=back で元から先へ向ける
    const reverse = e.dir === "U" || e.dir === "L";
    const [tail, head] = reverse ? [b, a] : [a, b];
    const attrs: string[] = [];
    if (e.lay) attrs.push("style=invis");
    else {
      let label = e.label ? lines(e.label) : "";
      if (e.techn) label += `${label ? "<br/>" : ""}<font point-size="9">[${lines(e.techn)}]</font>`;
      if (label) attrs.push(`label=<${label}>`);
      if (e.both) attrs.push("dir=both");
      else if (reverse) attrs.push("dir=back");
    }
    // 自由配置（neato）では、囲みで止める・段をそろえる指定は効かないので付けない
    if (tail.cluster && !free) attrs.push(`ltail=${quote(tail.cluster)}`);
    if (head.cluster && !free) attrs.push(`lhead=${quote(head.cluster)}`);
    attrs.push(`id="${relSvgId(i)}"`);
    out.push(`  ${quote(tail.node)} -> ${quote(head.node)} [${attrs.join(", ")}];`);
    if (!along(e.dir) && !free) out.push(`  { rank=same; ${quote(tail.node)}; ${quote(head.node)}; }`);
  });
  out.push("}");
  return out.join("\n");
}

/**
 * Graphviz が出力した SVG の人の要素に、頭と肩のアイコンを描き足す。
 * c4ToDot がラベルの上に空けておいた空行（空白だけの text）をアイコンに置き換える
 */
export function drawPersonIcons(svg: string): string {
  const node = new RegExp(`(<g\\b[^>]*class="node ${PERSON_CLASS}"[^>]*>)([\\s\\S]*?)(</g>)`, "g");
  return svg.replace(node, (all, open: string, body: string, close: string) => {
    // 箱の左右の端（path の x 座標の最小・最大）から中心を求める
    const d = /<path\b[^>]*\sd="([^"]+)"/.exec(body)?.[1];
    const space = new RegExp(`<text\\b[^>]*font-size="${PERSON_ICON_SPACE}(?:\\.0+)?"[^>]*>\\s*</text>`).exec(body);
    if (!d || !space) return all;
    const xs = [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => Number(m[1]));
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const y = Number(/\sy="(-?[\d.]+)"/.exec(space[0])?.[1]);
    const fill = /\sfill="([^"]+)"/.exec(space[0])?.[1] ?? "#ffffff";
    if (!Number.isFinite(cx) || !Number.isFinite(y)) return all;
    // y は空行の文字の基準線。基準線の少し下を肩の下端にする
    const f = (n: number) => n.toFixed(2);
    const icon =
      `<circle cx="${f(cx)}" cy="${f(y - 11)}" r="5" fill="${fill}"/>` +
      `<path d="M${f(cx - 9)},${f(y + 3)} A9,8 0 0 1 ${f(cx + 9)},${f(y + 3)} Z" fill="${fill}"/>`;
    return open + body.replace(space[0], icon) + close;
  });
}

interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** SVG の要素（path の d・polygon の points）に出てくる座標の範囲 */
function boxOf(markup: string): Box | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const attr of markup.matchAll(/\s(?:d|points)="([^"]+)"/g)) {
    for (const m of attr[1].matchAll(/(-?[\d.]+),(-?[\d.]+)/g)) {
      xs.push(Number(m[1]));
      ys.push(Number(m[2]));
    }
  }
  if (!xs.length) return null;
  return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
}

/** Graphviz の SVG から、要素（ノード）ごとの範囲を取り出す。座標は SVG のグラフ座標（y は下向き・負） */
export function nodeBoxes(svg: string): Map<string, Box> {
  const boxes = new Map<string, Box>();
  for (const m of svg.matchAll(/<g\b[^>]*class="node[^"]*"[^>]*>\s*<title>([^<]*)<\/title>([\s\S]*?)<\/g>/g)) {
    const box = boxOf(m[2]);
    if (box) boxes.set(decodeEntities(m[1]), box);
  }
  return boxes;
}

const decodeEntities = (s: string) =>
  s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

/**
 * 自由配置（neato）の SVG に囲み（Boundary）を描き足す。neato は囲みを描かないので、
 * 中の要素の範囲を囲む破線の枠と名前を、要素の後ろに入れる。自由配置でなければそのまま返す
 */
export function drawBoundaries(svg: string, model: C4Model): string {
  if (!isFreeLayout(model)) return svg;
  const boxes = nodeBoxes(svg);
  const PAD = 14;
  const LABEL = 30;
  const shapes: string[] = [];
  const f = (n: number) => n.toFixed(2);
  let all: Box | null = null;
  const union = (a: Box | null, b: Box | null): Box | null =>
    !a ? b : !b ? a : { x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1), x2: Math.max(a.x2, b.x2), y2: Math.max(a.y2, b.y2) };

  /** 囲みの範囲を中から順に求め、外側の枠ほど先（後ろ）に描く */
  const visit = (nodes: C4Node[]): Box | null => {
    let range: Box | null = null;
    for (const n of nodes) {
      if (n.type === "element") {
        range = union(range, boxes.get(n.id) ?? null);
        continue;
      }
      const at = shapes.length;
      const inner = visit(n.children);
      if (!inner) continue;
      const b = { x1: inner.x1 - PAD, y1: inner.y1 - PAD - LABEL, x2: inner.x2 + PAD, y2: inner.y2 + PAD };
      const type = n.typeLabel ?? BOUNDARY_TYPES[n.macro];
      const r = 6;
      const path =
        `M${f(b.x1 + r)},${f(b.y1)} L${f(b.x2 - r)},${f(b.y1)} Q${f(b.x2)},${f(b.y1)} ${f(b.x2)},${f(b.y1 + r)} ` +
        `L${f(b.x2)},${f(b.y2 - r)} Q${f(b.x2)},${f(b.y2)} ${f(b.x2 - r)},${f(b.y2)} L${f(b.x1 + r)},${f(b.y2)} ` +
        `Q${f(b.x1)},${f(b.y2)} ${f(b.x1)},${f(b.y2 - r)} L${f(b.x1)},${f(b.y1 + r)} Q${f(b.x1)},${f(b.y1)} ${f(b.x1 + r)},${f(b.y1)} Z`;
      const text = (y: number, size: number, bold: boolean, s: string) =>
        `<text text-anchor="start" x="${f(b.x1 + 8)}" y="${f(y)}" font-family="${FONT}" font-size="${size}"${bold ? ' font-weight="bold"' : ""} fill="#444444">${htmlEsc(s)}</text>`;
      shapes.splice(
        at,
        0,
        `<g class="cluster"><title>cluster_${htmlEsc(n.id)}</title>` +
          `<path fill="none" stroke="#444444" stroke-dasharray="5,2" d="${path}"/>` +
          text(b.y1 + 16, 12, true, n.label) +
          (type ? text(b.y1 + 27, 10, false, `[${type}]`) : "") +
          "</g>",
      );
      range = union(range, b);
    }
    all = union(all, range);
    return range;
  };
  visit(model.nodes);
  if (!shapes.length || !all) return svg;

  // 背景（最初の polygon）の直後、要素より前に入れる
  const bg = /(<g\b[^>]*class="graph"[^>]*>[\s\S]*?<polygon\b[^>]*\/>)/.exec(svg);
  if (!bg) return svg;
  let out = svg.replace(bg[1], bg[1] + shapes.join(""));

  // 枠が図の外にはみ出すときは、表示範囲（viewBox）を広げる
  const tr = /class="graph"[^>]*transform="[^"]*translate\((-?[\d.]+)[ ,](-?[\d.]+)\)/.exec(svg);
  const vb = /viewBox="(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)"/.exec(svg);
  if (tr && vb) {
    const box = all as Box;
    const [tx, ty] = [Number(tr[1]), Number(tr[2])];
    const [vx, vy, vw, vh] = vb.slice(1).map(Number);
    const x1 = Math.min(vx, box.x1 + tx - 4);
    const y1 = Math.min(vy, box.y1 + ty - 4);
    const x2 = Math.max(vx + vw, box.x2 + tx + 4);
    const y2 = Math.max(vy + vh, box.y2 + ty + 4);
    out = out
      .replace(vb[0], `viewBox="${f(x1)} ${f(y1)} ${f(x2 - x1)} ${f(y2 - y1)}"`)
      .replace(/(<svg\b[^>]*?)width="[\d.]+pt"/, `$1width="${f(x2 - x1)}pt"`)
      .replace(/(<svg\b[^>]*?)height="[\d.]+pt"/, `$1height="${f(y2 - y1)}pt"`);
  }
  return out;
}
