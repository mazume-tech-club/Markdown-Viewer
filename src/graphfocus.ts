// ---------- Graphviz の図の関連の強調（docs/diagram-link-and-highlight-requirements.md の要件 B） ----------
// ノードをクリックすると、そのノードを端に持つ線と線の反対側のノードを強調し、ほかを薄くする。
// 対象は Graphviz が描いた SVG（ルートに <g class="graph"> がある）すべて。dot・c4 のほか、
// アプリが DOT にして描く erd・flow・screen・markmap でも効く。Mermaid は構造が違うので対象外。
// 強調は CSS クラスの付け外しだけで行い、SVG の属性は変えない（再描画・PDF 出力では元の図に戻る）。
// プレビューの図と、拡大ビューアの複製のどちらでも同じ関数で動く（状態は SVG ごとに別々）

/** ノードの識別子（DOT のノード id = g.node の title）ごとの、つながっている線の番号と相手のノード */
export type Adjacency = Map<string, { edges: number[]; neighbors: Set<string> }>;

/**
 * 線の title（「tail->head」、無向なら「a--b」）を両端のノード id に分ける。
 * ノード id に - や -> が入っていても割れるよう、両側が実在するノードになる区切りを探す。
 * ポート付き（t0:c1->t1:c0）のときは「:ポート」を外して探す
 */
export function splitEdgeTitle(title: string, nodes: ReadonlySet<string>): [string, string] | null {
  const resolve = (side: string): string | null => {
    for (let s = side; ; s = s.slice(0, s.lastIndexOf(":"))) {
      if (nodes.has(s)) return s;
      if (!s.includes(":")) return null;
    }
  };
  for (const sep of ["->", "--"]) {
    for (let i = title.indexOf(sep); i >= 0; i = title.indexOf(sep, i + 1)) {
      const a = resolve(title.slice(0, i));
      const b = resolve(title.slice(i + sep.length));
      if (a !== null && b !== null) return [a, b];
    }
  }
  return null;
}

/** ノードと線の title から、ノードごとのつながりを作る。向きは問わない（入る線も出る線も数える） */
export function buildAdjacency(nodeTitles: string[], edgeTitles: string[]): Adjacency {
  const nodes = new Set(nodeTitles);
  const adj: Adjacency = new Map(nodeTitles.map((n) => [n, { edges: [], neighbors: new Set() }]));
  edgeTitles.forEach((title, i) => {
    const ends = splitEdgeTitle(title, nodes);
    if (!ends) return;
    const [a, b] = ends;
    for (const [self, other] of [
      [a, b],
      [b, a],
    ]) {
      const entry = adj.get(self)!;
      if (!entry.edges.includes(i)) entry.edges.push(i);
      if (other !== self) entry.neighbors.add(other);
    }
  });
  return adj;
}

const decode = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

/** SVG の文字列から、つながりを作る（テスト・DOM の無い所用。DOM では graphOf が title を直接読む） */
export function adjacencyFromSvg(svg: string): Adjacency {
  const titles = (cls: string) =>
    [...svg.matchAll(new RegExp(`<g\\b[^>]*class="${cls}"[^>]*>\\s*<title>([\\s\\S]*?)</title>`, "g"))].map((m) => decode(m[1]));
  return buildAdjacency(titles("node"), titles("edge"));
}

// ---------- DOM ----------

interface Graph {
  nodes: Map<string, Element>;
  edges: Element[];
  adj: Adjacency;
}

const graphs = new WeakMap<SVGSVGElement, Graph>();

const titleOf = (g: Element) => g.querySelector(":scope > title")?.textContent ?? "";

/**
 * 強調の起点のノード id。状態は DOM のクラス（gf-origin）だけに持つ。
 * 強調中の図を拡大ビューアで開くと複製にもクラスが写るので、複製でもそのまま続きを操作できる
 */
const originOf = (svg: SVGSVGElement): string | null => {
  const el = svg.querySelector("g.node.gf-origin");
  return el ? titleOf(el) : null;
};

/** Graphviz が描いた SVG か */
export const isGraphvizSvg = (svg: Element | null): svg is SVGSVGElement =>
  svg instanceof SVGSVGElement && svg.querySelector(":scope > g.graph") !== null;

/** SVG のノードと線を集める（最初のクリックのときに 1 回だけ） */
function graphOf(svg: SVGSVGElement): Graph {
  let g = graphs.get(svg);
  if (!g) {
    const nodeEls = [...svg.querySelectorAll("g.node")];
    const edges = [...svg.querySelectorAll("g.edge")];
    g = {
      nodes: new Map(nodeEls.map((el) => [titleOf(el), el])),
      edges,
      adj: buildAdjacency(nodeEls.map(titleOf), edges.map(titleOf)),
    };
    graphs.set(svg, g);
  }
  return g;
}

function clear(svg: SVGSVGElement) {
  svg.classList.remove("gf-active");
  for (const el of svg.querySelectorAll(".gf-on, .gf-origin")) el.classList.remove("gf-on", "gf-origin");
}

function focus(svg: SVGSVGElement, id: string) {
  clear(svg);
  const g = graphOf(svg);
  const entry = g.adj.get(id);
  svg.classList.add("gf-active");
  g.nodes.get(id)?.classList.add("gf-on", "gf-origin");
  for (const n of entry?.neighbors ?? []) g.nodes.get(n)?.classList.add("gf-on");
  for (const i of entry?.edges ?? []) g.edges[i].classList.add("gf-on");
}

export type TapResult = { action: "focus" | "clear" } | { action: "link"; a: Element } | null;

/**
 * 図の上をクリックしたときの強調の処理。null なら強調とは関係ない（拡大ビューアを開く・リンクを踏むなど、いつもの動作へ）。
 * - ノード: 強調する（強調中の別のノード・相手のノードなら、そちらに切り替える）
 * - 強調の起点をもう一度: リンクがあれば link（踏むのは呼び出し側）、無ければ強調を解除
 * - 強調中に余白・クラスタ・線: 強調を解除
 */
export function tapGraph(target: Element): TapResult {
  const svg = target.closest("svg");
  if (!isGraphvizSvg(svg)) return null;
  const node = target.closest("g.node");
  if (node && svg.contains(node)) {
    const id = titleOf(node);
    if (originOf(svg) === id) {
      const a = target.closest("a") ?? node.querySelector("a");
      if (a) return { action: "link", a };
      clear(svg);
      return { action: "clear" };
    }
    focus(svg, id);
    return { action: "focus" };
  }
  if (svg.classList.contains("gf-active")) {
    clear(svg);
    return { action: "clear" };
  }
  return null;
}

/** root の中の強調をすべて解除する。解除したものがあれば true（Esc 用） */
export function clearGraphFocus(root: ParentNode): boolean {
  let any = false;
  for (const svg of root.querySelectorAll<SVGSVGElement>("svg.gf-active")) {
    clear(svg);
    any = true;
  }
  return any;
}
