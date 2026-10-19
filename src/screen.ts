// ---------- 画面遷移図（```screen） ----------
// 「画面A -> 画面B : 操作」を書くと、画面をウィンドウの形の箱にした画面遷移図を描く（オプション機能）。
// 解析して DOT にし、Graphviz で描く（diagrams.ts）
//
//   ログイン -> メニュー : ログイン
//   メニュー <-> 設定 : 開く / 戻る      ← <-> は行き来
//   設定 : 通知・テーマを変える          ← 矢印なしの行は画面の説明

import { COLOR, FONT, html, textWidth } from "./dotutil";

export interface Screen {
  name: string;
  note: string;
}

export interface Transition {
  from: string;
  to: string;
  label: string;
  both: boolean;
}

export interface ScreenModel {
  title: string;
  direction: "LR" | "TB";
  screens: Screen[];
  transitions: Transition[];
}

export function parseScreens(src: string): ScreenModel {
  const model: ScreenModel = { title: "", direction: "LR", screens: [], transitions: [] };
  const screen = (name: string) => {
    let s = model.screens.find((x) => x.name === name);
    if (!s) {
      s = { name, note: "" };
      model.screens.push(s);
    }
    return s;
  };

  src.split(/\r?\n/).forEach((raw, i) => {
    const n = i + 1;
    const line = raw.trim();
    if (!line || line.startsWith("%%")) return;
    const title = /^title\s+(.+)$/i.exec(line);
    if (title) {
      model.title = title[1].trim();
      return;
    }
    const dir = /^direction\s+(LR|TB)$/i.exec(line);
    if (dir) {
      model.direction = dir[1].toUpperCase() as "LR" | "TB";
      return;
    }
    const arrow = /^(.+?)\s*(<->|->)\s*(.+?)(?:\s*[:：]\s*(.*))?$/.exec(line);
    if (arrow) {
      const [, from, kind, to, label] = arrow;
      if (!from || !to) throw new Error(`${n} 行目: 矢印の両側に画面の名前を書いてください`);
      screen(from);
      screen(to);
      model.transitions.push({ from, to, label: label?.trim() ?? "", both: kind === "<->" });
      return;
    }
    const decl = /^(.+?)\s*[:：]\s*(.+)$/.exec(line);
    if (decl) {
      screen(decl[1]).note = decl[2].trim();
      return;
    }
    // 名前だけの行は、つながりの無い画面として置く
    if (/[<>-]/.test(line)) throw new Error(`${n} 行目: 矢印は「画面A -> 画面B : 操作」の形で書いてください`);
    screen(line);
  });

  if (!model.screens.length) throw new Error("画面がありません（「画面A -> 画面B : 操作」を書いてください）");
  return model;
}

/** 画面の箱: 上にウィンドウのタイトルバー、その下に名前と説明 */
function screenLabel(s: Screen): string {
  const w = Math.ceil(Math.max(textWidth(s.name, 13), textWidth(s.note, 10), 60) + 24);
  const note = s.note ? `<tr><td align="center" width="${w}"><font point-size="10" color="${COLOR.muted}">${html(s.note)}</font></td></tr>` : "";
  return (
    `<<table border="1" cellborder="0" cellspacing="0" cellpadding="6" bgcolor="${COLOR.surface}" color="${COLOR.muted}">` +
    `<tr><td bgcolor="${COLOR.accentSoft}" align="left" height="10" width="${w}"><font point-size="7" color="${COLOR.accent}">● ● ●</font></td></tr>` +
    `<tr><td align="center" width="${w}"><b>${html(s.name)}</b></td></tr>${note}</table>>`
  );
}

export function screensToDot(model: ScreenModel): string {
  const index = new Map(model.screens.map((s, i) => [s.name, i]));
  const out = [
    "digraph screens {",
    `  graph [rankdir=${model.direction}, nodesep=0.4, ranksep=0.6, pad=0.2, fontname="${FONT}", fontsize=14${
      model.title ? `, labelloc=t, label=<<b>${html(model.title)}</b>>` : ""
    }];`,
    `  node [shape=plain, fontname="${FONT}", fontsize=13];`,
    `  edge [fontname="${FONT}", fontsize=10, color="${COLOR.accent}", fontcolor="${COLOR.text}", arrowsize=0.8];`,
  ];
  model.screens.forEach((s, i) => out.push(`  p${i} [label=${screenLabel(s)}];`));
  for (const t of model.transitions) {
    const attrs = [t.label && `label=<${html(t.label)}>`, t.both && "dir=both"].filter(Boolean).join(", ");
    out.push(`  p${index.get(t.from)} -> p${index.get(t.to)}${attrs ? ` [${attrs}]` : ""};`);
  }
  out.push("}");
  return out.join("\n");
}
