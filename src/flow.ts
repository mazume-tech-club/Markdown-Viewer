// ---------- 業務フロー（```flow） ----------
// 「担当: 処理」を上から順に書くと、担当ごとのレーン（縦の帯）に分けた業務フロー図を描く（オプション機能）。
// 解析して DOT にし、Graphviz で描く（diagrams.ts）
//
//   顧客: 開始
//   顧客: 注文する
//   営業: 在庫はある?          ← 末尾が ? なら判断（ひし形）
//     はい -> @出荷            ← 字下げした「ラベル -> @名前」で分かれ道。先を空にすると次の行へ
//     いいえ ->
//   営業: 欠品を連絡する
//   顧客: 終了
//   倉庫: 出荷する @出荷        ← 末尾の @名前 で、分かれ道の行き先にする

import { COLOR, FONT, html, textWidth } from "./dotutil";

export type StepKind = "process" | "decision" | "start" | "end";

export interface FlowStep {
  lane: string;
  text: string;
  kind: StepKind;
  /** @名前（無ければ null） */
  name: string | null;
  /** 字下げした行で書いた行き先。to が null なら次の手順 */
  branches: { label: string; to: string | null; line: number }[];
  line: number;
}

export interface FlowModel {
  title: string;
  lanes: string[];
  steps: FlowStep[];
}

const START = ["開始", "スタート", "start"];
const END = ["終了", "終わり", "end"];

export function parseFlow(src: string): FlowModel {
  const model: FlowModel = { title: "", lanes: [], steps: [] };
  const names = new Map<string, number>();

  src.split(/\r?\n/).forEach((raw, i) => {
    const n = i + 1;
    const line = raw.trim();
    if (!line || line.startsWith("%%")) return;
    const title = /^title\s+(.+)$/i.exec(line);
    if (title) {
      model.title = title[1].trim();
      return;
    }
    const lanes = /^(?:lanes|レーン)\s*[:：]\s*(.+)$/i.exec(line);
    if (lanes) {
      for (const l of lanes[1].split(/[,、]/).map((s) => s.trim()).filter(Boolean)) {
        if (!model.lanes.includes(l)) model.lanes.push(l);
      }
      return;
    }
    // 字下げした行は、直前の手順からの行き先
    if (/^\s/.test(raw)) {
      const branch = /^(.*?)\s*->\s*(?:@?(\S+))?$/.exec(line);
      if (!branch) throw new Error(`${n} 行目: 字下げした行は「ラベル -> @行き先」で書いてください`);
      const prev = model.steps[model.steps.length - 1];
      if (!prev) throw new Error(`${n} 行目: 行き先の前に「担当: 処理」を書いてください`);
      prev.branches.push({ label: branch[1], to: branch[2] ?? null, line: n });
      return;
    }
    const step = /^([^:：]+?)\s*[:：]\s*(.+)$/.exec(line);
    if (!step) throw new Error(`${n} 行目: 「担当: 処理」の形で書いてください`);
    let text = step[2];
    let name: string | null = null;
    const at = /\s@(\S+)$/.exec(text);
    if (at) {
      name = at[1];
      text = text.slice(0, at.index).trim();
    }
    if (name !== null) {
      if (names.has(name)) throw new Error(`${n} 行目: @${name} が 2 回出てきます`);
      names.set(name, model.steps.length);
    }
    const lower = text.toLowerCase();
    const kind: StepKind = START.includes(lower)
      ? "start"
      : END.includes(lower)
        ? "end"
        : /[?？]$/.test(text)
          ? "decision"
          : "process";
    if (!model.lanes.includes(step[1])) model.lanes.push(step[1]);
    model.steps.push({ lane: step[1], text, kind, name, branches: [], line: n });
  });

  if (!model.steps.length) throw new Error("手順がありません（「担当: 処理」を 1 行ずつ書いてください）");
  for (const s of model.steps) {
    for (const b of s.branches) {
      if (b.to !== null && !names.has(b.to)) throw new Error(`${b.line} 行目: 行き先 @${b.to} が見つかりません`);
    }
  }
  return model;
}

/** 手順の線: [元, 先, ラベル]。分かれ道が無ければ次の手順へ（終了の後と最後の手順からは引かない） */
export function flowEdges(model: FlowModel): [number, number, string][] {
  const names = new Map(model.steps.flatMap((s, i) => (s.name ? [[s.name, i] as const] : [])));
  const edges: [number, number, string][] = [];
  model.steps.forEach((s, i) => {
    const next = i + 1 < model.steps.length ? i + 1 : -1;
    if (s.branches.length) {
      for (const b of s.branches) {
        const to = b.to === null ? next : names.get(b.to)!;
        if (to >= 0) edges.push([i, to, b.label]);
      }
    } else if (s.kind !== "end" && next >= 0) {
      edges.push([i, next, ""]);
    }
  });
  return edges;
}

/** 手順の箱の大きさ（インチ）。日本語は Graphviz が狭く見積もるので文字幅から決める */
function size(step: FlowStep): string {
  const lines = step.text.split("\\n");
  const w = Math.max(...lines.map((l) => textWidth(l, 12)));
  const h = lines.length * 16;
  if (step.kind === "decision") return `width=${((w * 1.5 + 30) / 72).toFixed(2)}, height=${((h * 1.6 + 26) / 72).toFixed(2)}`;
  return `width=${((w + 30) / 72).toFixed(2)}, height=${((h + 16) / 72).toFixed(2)}`;
}

const STYLE: Record<StepKind, string> = {
  process: `shape=box, style="rounded,filled", fillcolor="${COLOR.surface}", color="${COLOR.muted}"`,
  decision: `shape=diamond, style=filled, fillcolor="${COLOR.accentSoft}", color="${COLOR.accent}"`,
  start: `shape=box, style="rounded,filled", fillcolor="${COLOR.muted}", color="${COLOR.muted}", fontcolor="white"`,
  end: `shape=box, style="rounded,filled", fillcolor="${COLOR.muted}", color="${COLOR.muted}", fontcolor="white"`,
};

export function flowToDot(model: FlowModel): string {
  const out = [
    "digraph flow {",
    `  graph [rankdir=TB, newrank=true, nodesep=0.35, ranksep=0.4, pad=0.2, fontname="${FONT}", fontsize=14${
      model.title ? `, labelloc=t, label=<<b>${html(model.title)}</b>>` : ""
    }];`,
    `  node [fontname="${FONT}", fontsize=12, fixedsize=false, margin="0.1,0.05"];`,
    `  edge [fontname="${FONT}", fontsize=10, color="${COLOR.muted}", fontcolor="${COLOR.muted}", arrowsize=0.8];`,
  ];
  // レーンは縦の帯（クラスタ）。見えない先頭の点を左から順に並べて、帯の順番を決める
  model.lanes.forEach((lane, li) => {
    out.push(
      `  subgraph cluster_${li} {`,
      `    label=<<b>${html(lane)}</b>>; labelloc=t; style=filled; fillcolor="${COLOR.ground}"; color="${COLOR.line}";`,
      `    h${li} [shape=point, style=invis, width=0.01];`,
    );
    model.steps.forEach((s, si) => {
      if (s.lane !== lane) return;
      const label = s.text.split("\\n").map(html).join("<br/>");
      out.push(`    s${si} [label=<${label}>, ${STYLE[s.kind]}, ${size(s)}];`);
    });
    out.push("  }");
  });
  if (model.lanes.length > 1) {
    out.push(`  { rank=same; ${model.lanes.map((_, li) => `h${li}`).join("; ")}; }`);
    out.push(`  ${model.lanes.map((_, li) => `h${li}`).join(" -> ")} [style=invis];`);
  }
  // 先頭の点から各レーンの最初の手順へ見えない線を引き、点を帯の上端に置く
  model.lanes.forEach((lane, li) => {
    const first = model.steps.findIndex((s) => s.lane === lane);
    if (first >= 0) out.push(`  h${li} -> s${first} [style=invis];`);
  });
  for (const [from, to, label] of flowEdges(model)) {
    out.push(`  s${from} -> s${to}${label ? ` [xlabel=<${html(label)}>]` : ""};`);
  }
  out.push("}");
  return out.join("\n");
}
