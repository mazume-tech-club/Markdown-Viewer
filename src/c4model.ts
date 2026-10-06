// C4 図のデータと、ソース（```c4 / Mermaid の C4）との読み書き。
// 描画（c4dot.ts）と図のビルダー（builder/）が同じ解釈をするよう、解析はここ 1 か所で行う

/** 要素のマクロ → 引数が (id, 名前, 技術, 説明) か（false なら (id, 名前, 説明)） */
export const ELEMENT_TECHN: Record<string, boolean> = {
  Person: false,
  Person_Ext: false,
  System: false,
  SystemDb: false,
  System_Ext: false,
  SystemDb_Ext: false,
  Container: true,
  ContainerDb: true,
  Container_Ext: true,
  ContainerDb_Ext: true,
  Component: true,
  ComponentDb: true,
  Component_Ext: true,
  ComponentDb_Ext: true,
};

/** 囲みのマクロ → 種別の表示（空なら出さない） */
export const BOUNDARY_TYPES: Record<string, string> = {
  Boundary: "",
  System_Boundary: "System",
  Container_Boundary: "Container",
  Enterprise_Boundary: "Enterprise",
};

/** 線の方向（相手を置く側）。null は図全体の向き（LAYOUT_*）に従う */
export type Dir = "D" | "U" | "R" | "L" | null;

const REL_MACROS: Record<string, { dir: Dir; both?: boolean; lay?: boolean }> = {
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
  Lay_D: { dir: "D", lay: true },
  Lay_U: { dir: "U", lay: true },
  Lay_R: { dir: "R", lay: true },
  Lay_L: { dir: "L", lay: true },
};

/** 描画には使わないが、書いてあっても困らない（Mermaid / C4-PlantUML からの移行用）マクロ */
const PASSIVE = new Set(["UpdateBoundaryStyle", "SHOW_LEGEND", "LAYOUT_WITH_LEGEND", "HIDE_STEREOTYPE", "SHOW_PERSON_OUTLINE"]);

export const C4_HEADERS = ["C4Context", "C4Container", "C4Component", "C4Dynamic", "C4Deployment"] as const;

export interface C4Element {
  type: "element";
  macro: string;
  id: string;
  label: string;
  techn: string;
  descr: string;
  line: number;
}

export interface C4Boundary {
  type: "boundary";
  macro: string;
  id: string;
  label: string;
  /** 3 つ目の引数（種別の表示）を書いたときだけ。null なら既定の表示 */
  typeLabel: string | null;
  children: C4Node[];
  line: number;
}

export type C4Node = C4Element | C4Boundary;

export interface C4Rel {
  from: string;
  to: string;
  label: string;
  techn: string;
  dir: Dir;
  both: boolean;
  /** 線を引かずに配置だけ決める（Lay_*） */
  lay: boolean;
  /** UpdateRelStyle の名前付き引数（$offsetX / $offsetY / $lineColor など。Mermaid 用） */
  style: Record<string, string>;
  line: number;
}

export interface C4Style {
  id: string;
  props: Record<string, string>;
  line: number;
}

export interface C4Model {
  /** Mermaid の図の種類（C4Context など）。書いていなければ null */
  header: string | null;
  title: string;
  layout: "TB" | "LR";
  nodes: C4Node[];
  rels: C4Rel[];
  styles: C4Style[];
  /** ```c4 の `dot:` 行（DOT にそのまま入れる文） */
  dot: string[];
  /** UpdateLayoutConfig の名前付き引数（Mermaid 用） */
  layoutConfig: Record<string, string>;
  /**
   * 自由配置の位置（```c4 の `Pos(id, x, y)`。図のビルダーで箱をドラッグして決める）。
   * 1 つでもあれば、自動の段組みではなく、この位置に置いて線だけ自動で引く。単位は pt、y は上向き
   */
  positions: Record<string, { x: number; y: number }>;
  /** 解釈しない行（コメントや未対応のマクロ）。書き出し時に末尾へそのまま残す */
  extra: string[];
}

export const emptyModel = (): C4Model => ({
  header: null,
  title: "",
  layout: "TB",
  nodes: [],
  rels: [],
  styles: [],
  dot: [],
  layoutConfig: {},
  positions: {},
  extra: [],
});

/** 自由配置（Pos がある）か */
export const isFreeLayout = (model: C4Model) => Object.keys(model.positions).length > 0;

interface Args {
  pos: string[];
  named: Record<string, string>;
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

/** 要素をすべて（囲みの中も、書いた順に）たどる */
export function* walk(nodes: C4Node[]): Generator<C4Node> {
  for (const n of nodes) {
    yield n;
    if (n.type === "boundary") yield* walk(n.children);
  }
}

/**
 * C4 のソースを読む。書き方に誤りがあれば「N 行目: …」の Error を投げる。
 * strict なら未対応のマクロもエラーにする（描画用）。そうでなければ extra に残す（ビルダー用）
 */
export function parseC4(src: string, strict = false): C4Model {
  const model = emptyModel();
  const stack: C4Boundary[] = [];
  const ids = new Set<string>();
  const relStyles: { from: string; to: string; style: Record<string, string>; raw: string }[] = [];
  const body = () => (stack.length ? stack[stack.length - 1].children : model.nodes);

  src
    .replace(/\r\n/g, "\n")
    .split("\n")
    .forEach((rawLine, i) => {
      const no = i + 1;
      const fail = (msg: string): never => {
        throw new Error(`${no} 行目: ${msg}`);
      };
      const line = rawLine.trim();
      if (!line) return;
      if (line.startsWith("%%") || line.startsWith("'")) {
        model.extra.push(line);
        return;
      }
      const header = /^(C4\w+)\s*$/.exec(line);
      if (header && (C4_HEADERS as readonly string[]).includes(header[1])) {
        model.header = header[1];
        return;
      }
      if (/^@(start|end)uml\b/.test(line) || /^!include/.test(line)) return;

      const t = /^title\s+(.*)$/.exec(line);
      if (t) {
        model.title = t[1].trim();
        return;
      }
      const d = /^dot:\s*(.*)$/.exec(line);
      if (d) {
        model.dot.push(d[1]);
        return;
      }
      if (line === "}") {
        stack.pop() ?? fail("対応する { がありません");
        return;
      }

      const m = /^(\w+)\s*(?:\((.*)\))?\s*(\{)?$/.exec(line);
      if (!m) {
        if (strict) fail(`読み取れません: ${line}`);
        model.extra.push(line);
        return;
      }
      const name = m[1];
      const open = m[3] === "{";
      const args = parseArgs(m[2] ?? "");

      if (name === "LAYOUT_TOP_DOWN") {
        model.layout = "TB";
        return;
      }
      if (name === "LAYOUT_LEFT_RIGHT" || name === "LAYOUT_LANDSCAPE") {
        model.layout = "LR";
        return;
      }

      if (name in ELEMENT_TECHN) {
        const techn = ELEMENT_TECHN[name];
        const [id, label = id, a3 = "", a4 = ""] = args.pos;
        if (!id) fail(`${name} に id がありません`);
        if (ids.has(id)) fail(`id「${id}」が重複しています`);
        if (open) fail(`${name} は { で囲めません`);
        ids.add(id);
        body().push({
          type: "element",
          macro: name,
          id,
          label,
          techn: args.named.techn ?? (techn ? a3 : ""),
          descr: args.named.descr ?? (techn ? a4 : a3),
          line: no,
        });
        return;
      }

      if (name in BOUNDARY_TYPES) {
        const [id, label = id, typeLabel] = args.pos;
        if (!id) fail(`${name} に id がありません`);
        if (!open) fail(`${name} の後ろに { が必要です`);
        const b: C4Boundary = { type: "boundary", macro: name, id, label, typeLabel: typeLabel ?? null, children: [], line: no };
        body().push(b);
        stack.push(b);
        return;
      }

      const rel = REL_MACROS[name];
      if (rel) {
        const [from, to, label = "", techn = ""] = args.pos;
        if (!from || !to) fail(`${name} には元と先の id が必要です`);
        model.rels.push({
          from,
          to,
          label: args.named.label ?? label,
          techn: args.named.techn ?? techn,
          dir: rel.dir,
          both: !!rel.both,
          lay: !!rel.lay,
          style: {},
          line: no,
        });
        return;
      }

      if (name === "UpdateElementStyle") {
        const [id] = args.pos;
        if (!id) fail("UpdateElementStyle に id がありません");
        model.styles.push({ id, props: args.named, line: no });
        return;
      }
      if (name === "UpdateRelStyle") {
        const [from, to] = args.pos;
        if (from && to) relStyles.push({ from, to, style: args.named, raw: line });
        return;
      }
      if (name === "UpdateLayoutConfig") {
        Object.assign(model.layoutConfig, args.named);
        return;
      }
      if (name === "Pos") {
        const [id, x, y] = args.pos;
        if (!id || !Number.isFinite(Number(x)) || !Number.isFinite(Number(y)) || x === "" || y === "") {
          fail("Pos は Pos(id, x, y) の形で書きます");
        }
        model.positions[id] = { x: Number(x), y: Number(y) };
        return;
      }
      if (PASSIVE.has(name) || !strict) {
        model.extra.push(line);
        return;
      }
      fail(`未対応の書き方です: ${name}`);
    });
  if (stack.length) throw new Error(`囲み「${stack[stack.length - 1].id}」の } がありません`);

  // UpdateRelStyle は対応する線に付ける（線が見つからなければ行のまま残す）
  for (const s of relStyles) {
    const rel = model.rels.find((r) => r.from === s.from && r.to === s.to);
    if (rel) Object.assign(rel.style, s.style);
    else model.extra.push(s.raw);
  }
  return model;
}

// ---------- 書き出し ----------

/** 文字列の引数。" は書けないので ” に置き換える */
const str = (s: string) => `"${s.replace(/"/g, "”")}"`;
const named = (props: Record<string, string>) =>
  Object.entries(props)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `$${k}=${str(v)}`);
/** 後ろの空の引数を省く */
function call(name: string, args: string[], extra: string[] = []): string {
  const a = [...args];
  while (a.length > 1 && a[a.length - 1] === '""') a.pop();
  return `${name}(${[...a, ...extra].join(", ")})`;
}

function relMacro(r: C4Rel, mermaid: boolean): string {
  const suffix = r.dir ? `_${r.dir}` : "";
  if (r.lay) return `Lay${suffix || "_D"}`;
  // Mermaid の BiRel は向きを指定できない
  if (r.both) return mermaid ? "BiRel" : `BiRel${suffix}`;
  return `Rel${suffix}`;
}

function writeNodes(nodes: C4Node[], indent: string, out: string[]) {
  for (const n of nodes) {
    if (n.type === "element") {
      const args = [n.id, str(n.label)];
      if (ELEMENT_TECHN[n.macro]) args.push(str(n.techn));
      args.push(str(n.descr));
      out.push(indent + call(n.macro, args));
    } else {
      const args = [n.id, str(n.label)];
      if (n.typeLabel !== null) args.push(str(n.typeLabel));
      out.push(`${indent}${call(n.macro, args)} {`);
      writeNodes(n.children, `${indent}  `, out);
      out.push(`${indent}}`);
    }
  }
}

/** Mermaid の図の種類を、要素から決める */
export function inferHeader(model: C4Model): string {
  if (model.header) return model.header;
  const macros = [...walk(model.nodes)].map((n) => n.macro);
  if (macros.some((m) => m.startsWith("Component") || m === "Container_Boundary")) return "C4Component";
  if (macros.some((m) => m.startsWith("Container") || m === "System_Boundary")) return "C4Container";
  return "C4Context";
}

/** ソースに書き出す。format が "mermaid" なら Mermaid の C4（Lay_* / dot: / LAYOUT_LEFT_RIGHT は Mermaid にないので出さない） */
export function writeC4(model: C4Model, format: "c4" | "mermaid"): string {
  const mermaid = format === "mermaid";
  const out: string[] = [];
  const indent = mermaid ? "  " : "";
  if (mermaid) out.push(inferHeader(model));
  else if (model.header) out.push(model.header);
  if (model.title) out.push(`${indent}title ${model.title}`);
  if (!mermaid) {
    if (model.layout === "LR") out.push("LAYOUT_LEFT_RIGHT()");
    for (const d of model.dot) out.push(`dot: ${d}`);
  }
  if (out.length) out.push("");
  writeNodes(model.nodes, indent, out);
  const rels = model.rels.filter((r) => !(mermaid && r.lay));
  if (rels.length) out.push("");
  for (const r of rels) {
    const args = [r.from, r.to];
    if (!r.lay) args.push(str(r.label), str(r.techn));
    out.push(indent + call(relMacro(r, mermaid), args));
  }
  const tail: string[] = [];
  for (const s of model.styles) tail.push(indent + call("UpdateElementStyle", [s.id], named(s.props)));
  for (const r of rels) {
    const props = named(r.style);
    if (props.length && !r.lay) tail.push(indent + call("UpdateRelStyle", [r.from, r.to], props));
  }
  const config = named(model.layoutConfig);
  if (config.length) tail.push(indent + call("UpdateLayoutConfig", [], config));
  // 自由配置の位置は ```c4 だけ（Mermaid には位置を指定する書き方がない）
  if (!mermaid) {
    for (const [id, p] of Object.entries(model.positions)) tail.push(`Pos(${id}, ${Math.round(p.x)}, ${Math.round(p.y)})`);
  }
  for (const e of model.extra) tail.push(indent + e);
  if (tail.length) out.push("", ...tail);
  return `${out.join("\n")}\n`;
}
