// 図のビルダー: C4 の入力フォーム（要素・囲み・関係・全体）と、選んだ線の向きを変えるパネル

import {
  BOUNDARY_TYPES,
  ELEMENT_TECHN,
  emptyModel,
  isFreeLayout,
  parseC4,
  writeC4,
  type C4Model,
  type C4Node,
  type C4Rel,
  type Dir,
} from "../c4model";
import { relSvgId } from "../c4dot";
import type { DiagramForm } from "./builder";

/** 種類の選択肢（グループ → [マクロ, 表示名]） */
const KINDS: { group: string; items: [string, string][] }[] = [
  { group: "人", items: [["Person", "人"], ["Person_Ext", "人（外部）"]] },
  {
    group: "システム",
    items: [["System", "システム"], ["SystemDb", "システム（DB）"], ["System_Ext", "外部システム"], ["SystemDb_Ext", "外部システム（DB）"]],
  },
  {
    group: "コンテナ",
    items: [["Container", "コンテナ"], ["ContainerDb", "コンテナ（DB）"], ["Container_Ext", "外部コンテナ"], ["ContainerDb_Ext", "外部コンテナ（DB）"]],
  },
  {
    group: "コンポーネント",
    items: [
      ["Component", "コンポーネント"],
      ["ComponentDb", "コンポーネント（DB）"],
      ["Component_Ext", "外部コンポーネント"],
      ["ComponentDb_Ext", "外部コンポーネント（DB）"],
    ],
  },
  {
    group: "囲み",
    items: [["System_Boundary", "囲み（システム）"], ["Container_Boundary", "囲み（コンテナ）"], ["Enterprise_Boundary", "囲み（企業）"], ["Boundary", "囲み"]],
  },
];

const DIRS: { dir: Dir; label: string; title: string }[] = [
  { dir: null, label: "自動", title: "図の向きに任せる（Rel）" },
  { dir: "U", label: "↑", title: "先を上に置く（Rel_U）" },
  { dir: "D", label: "↓", title: "先を下に置く（Rel_D）" },
  { dir: "L", label: "←", title: "先を左に置く（Rel_L）" },
  { dir: "R", label: "→", title: "先を右に置く（Rel_R）" },
];

/** 表の 1 行（囲みの入れ子は parent で表す） */
interface Row {
  key: number;
  macro: string;
  id: string;
  label: string;
  techn: string;
  descr: string;
  typeLabel: string | null;
  /** 入っている囲みの id（なければ ""） */
  parent: string;
}

type Selection = { type: "rel"; index: number } | { type: "row"; key: number } | null;

const isBoundary = (macro: string) => macro in BOUNDARY_TYPES;

/** ドラッグ中もポインタを受け取り続ける（ポインタが既に離れているなどで失敗しても、ドラッグ自体は続ける） */
function capture(target: Element, pointerId: number, on: boolean) {
  try {
    if (on) target.setPointerCapture(pointerId);
    else target.releasePointerCapture(pointerId);
  } catch {
    // 何もしない
  }
}
const ID_RE = /^\w+$/;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...children);
  return e;
}

export function createC4Form(): DiagramForm {
  let rows: Row[] = [];
  let rels: C4Rel[] = [];
  /** 表で扱わない部分（タイトル・向き・dot:・スタイル・残す行など） */
  let meta: C4Model = emptyModel();
  let nextKey = 1;
  let selected: Selection = null;
  let format: "c4" | "mermaid" = "c4";
  let changed: () => void = () => {};
  let formEl: HTMLElement;
  let selectEl: HTMLElement;
  let barEl: HTMLElement;
  let previewEl: HTMLElement;
  /** プレビューでのドラッグの意味: 箱を動かす / 箱から箱へ線を引く */
  let tool: "move" | "line" = "move";

  // ---------- データの変換 ----------

  function fromModel(m: C4Model) {
    meta = m;
    rows = [];
    const add = (nodes: C4Node[], parent: string) => {
      for (const n of nodes) {
        rows.push({
          key: nextKey++,
          macro: n.macro,
          id: n.id,
          label: n.label,
          techn: n.type === "element" ? n.techn : "",
          descr: n.type === "element" ? n.descr : "",
          typeLabel: n.type === "boundary" ? n.typeLabel : null,
          parent,
        });
        if (n.type === "boundary") add(n.children, n.id);
      }
    };
    add(m.nodes, "");
    rels = m.rels;
    selected = null;
  }

  function toModel(): C4Model {
    const byId = new Map<string, C4Node>();
    const nodes: C4Node[] = rows.map((r) =>
      isBoundary(r.macro)
        ? { type: "boundary", macro: r.macro, id: r.id, label: r.label, typeLabel: r.typeLabel, children: [], line: 0 }
        : { type: "element", macro: r.macro, id: r.id, label: r.label, techn: r.techn, descr: r.descr, line: 0 },
    );
    nodes.forEach((n) => byId.set(n.id, n));
    // 親が囲みでない・自分を含む入れ子になる場合は外に出す
    const root: C4Node[] = [];
    rows.forEach((r, i) => {
      let parent = byId.get(r.parent);
      for (let p: string | undefined = r.parent, guard = 0; p && guard < rows.length; guard++) {
        if (p === r.id) parent = undefined;
        p = rows.find((x) => x.id === p)?.parent;
      }
      if (parent?.type === "boundary") parent.children.push(nodes[i]);
      else root.push(nodes[i]);
    });
    return { ...meta, nodes: root, rels };
  }

  const nameOf = (id: string) => rows.find((r) => r.id === id)?.label || id;

  function newId(macro: string) {
    const base = isBoundary(macro) ? "boundary" : macro.replace(/(Db)?(_Ext)?$/, "").toLowerCase();
    for (let i = 1; ; i++) {
      const id = `${base}${i}`;
      if (!rows.some((r) => r.id === id)) return id;
    }
  }

  // ---------- 変更の反映 ----------

  /** 文字の入力など、表の作りが変わらない変更（フォーカスを保つため表は描き直さない） */
  function touch() {
    renderSelection();
    changed();
  }

  /** 行の追加・削除・並べ替え・id の変更など（選択肢が変わるので表を描き直す） */
  function rebuild() {
    renderForm();
    renderSelection();
    renderBar();
    changed();
  }

  /** id の変更を、関係・スタイル・囲みの参照にも反映する */
  function renameId(from: string, to: string) {
    for (const r of rels) {
      if (r.from === from) r.from = to;
      if (r.to === from) r.to = to;
    }
    for (const s of meta.styles) if (s.id === from) s.id = to;
    for (const r of rows) if (r.parent === from) r.parent = to;
    if (meta.positions[from]) {
      meta.positions[to] = meta.positions[from];
      delete meta.positions[from];
    }
  }

  function removeRow(row: Row) {
    rows = rows.filter((r) => r !== row);
    rels = rels.filter((r) => r.from !== row.id && r.to !== row.id);
    meta.styles = meta.styles.filter((s) => s.id !== row.id);
    delete meta.positions[row.id];
    for (const r of rows) if (r.parent === row.id) r.parent = row.parent;
    selected = null;
    rebuild();
  }

  function moveRow(row: Row, delta: number) {
    const i = rows.indexOf(row);
    const j = i + delta;
    if (j < 0 || j >= rows.length) return;
    [rows[i], rows[j]] = [rows[j], rows[i]];
    rebuild();
  }

  // ---------- 入力部品 ----------

  function textInput(value: string, onInput: (v: string) => void, props: Partial<HTMLInputElement> = {}) {
    const input = el("input", { type: "text", value, ...props });
    input.addEventListener("input", () => onInput(input.value));
    return input;
  }

  function idSelect(value: string, onChange: (v: string) => void, withNone = false) {
    const select = el("select");
    if (withNone) select.append(el("option", { value: "", textContent: "（なし）" }));
    for (const r of rows) {
      if (withNone && !isBoundary(r.macro)) continue;
      select.append(el("option", { value: r.id, textContent: `${r.label || r.id}（${r.id}）` }));
    }
    select.value = value;
    select.addEventListener("change", () => onChange(select.value));
    return select;
  }

  function kindSelect(value: string, onChange: (v: string) => void) {
    const select = el("select");
    for (const g of KINDS) {
      const og = el("optgroup", { label: g.group });
      for (const [macro, label] of g.items) og.append(el("option", { value: macro, textContent: label }));
      select.append(og);
    }
    select.value = value;
    select.addEventListener("change", () => onChange(select.value));
    return select;
  }

  function dirButtons(rel: C4Rel, after: () => void) {
    const wrap = el("div", { className: "segmented b-dir" });
    for (const d of DIRS) {
      const b = el("button", { type: "button", textContent: d.label, title: d.title });
      b.classList.toggle("active", rel.dir === d.dir);
      b.addEventListener("click", () => {
        rel.dir = d.dir;
        after();
      });
      wrap.append(b);
    }
    return wrap;
  }

  function relKindSelect(rel: C4Rel, after: () => void) {
    const select = el("select", { title: "線の種類" });
    select.append(
      el("option", { value: "line", textContent: "→ 線" }),
      el("option", { value: "both", textContent: "↔ 双方向" }),
      el("option", { value: "lay", textContent: "配置だけ（線なし）" }),
    );
    select.value = rel.lay ? "lay" : rel.both ? "both" : "line";
    select.addEventListener("change", () => {
      rel.lay = select.value === "lay";
      rel.both = select.value === "both";
      if (rel.lay && !rel.dir) rel.dir = "D";
      after();
    });
    return select;
  }

  /** ラベル位置（Mermaid の UpdateRelStyle の $offsetX / $offsetY） */
  function offsetInput(rel: C4Rel, key: "offsetX" | "offsetY") {
    const input = el("input", { type: "number", step: "10", value: rel.style[key] ?? "", placeholder: "0", className: "b-num" });
    input.title = key === "offsetX" ? "ラベルの横位置（Mermaid のみ）" : "ラベルの縦位置（Mermaid のみ）";
    input.addEventListener("input", () => {
      if (input.value === "" || input.value === "0") delete rel.style[key];
      else rel.style[key] = input.value;
      touch();
    });
    return input;
  }

  // ---------- 表 ----------

  function renderForm() {
    const general = el("section", { className: "b-section" }, el("h4", { textContent: "全体" }));
    const grid = el("div", { className: "b-grid" });
    grid.append(
      el("label", {}, "タイトル", textInput(meta.title, (v) => ((meta.title = v), touch()))),
    );
    const header = el("select");
    header.append(el("option", { value: "", textContent: "自動" }));
    for (const h of ["C4Context", "C4Container", "C4Component"]) header.append(el("option", { value: h, textContent: h }));
    header.value = meta.header ?? "";
    header.addEventListener("change", () => ((meta.header = header.value || null), touch()));
    grid.append(el("label", { title: "Mermaid に書き出すときの図の種類" }, "図の種類", header));
    const layoutSel = el("select");
    layoutSel.append(
      el("option", { value: "auto", textContent: "自動（向きで指定）" }),
      el("option", { value: "free", textContent: "自由（ドラッグした位置）" }),
    );
    layoutSel.value = isFreeLayout(meta) ? "free" : "auto";
    layoutSel.addEventListener("change", () => setFreeLayout(layoutSel.value === "free"));
    grid.append(
      el("label", { title: "自由: プレビューで箱をドラッグした位置に置き、線は自動で引く（```c4 のみ）" }, "配置（c4）", layoutSel),
    );
    const lr = el("input", { type: "checkbox", checked: meta.layout === "LR" });
    lr.addEventListener("change", () => ((meta.layout = lr.checked ? "LR" : "TB"), touch()));
    grid.append(el("label", { className: "b-check", title: "左→右に並べる（```c4 のみ）" }, lr, "横向き（c4）"));
    grid.append(spacingInput("nodesep", "横の間隔（c4）"), spacingInput("ranksep", "縦の間隔（c4）"));
    const perRow = el("input", { type: "number", min: "1", value: meta.layoutConfig.c4ShapeInRow ?? "", placeholder: "4", className: "b-num" });
    perRow.addEventListener("input", () => {
      if (perRow.value) meta.layoutConfig.c4ShapeInRow = perRow.value;
      else delete meta.layoutConfig.c4ShapeInRow;
      touch();
    });
    grid.append(el("label", { title: "1 行に並べる要素の数（Mermaid のみ）" }, "1 行の個数（mermaid）", perRow));
    general.append(grid);

    // 要素
    const elements = el("section", { className: "b-section" }, el("h4", { textContent: "要素・囲み" }));
    const table = el("table", { className: "b-table" });
    table.append(
      el(
        "thead",
        {},
        el("tr", {}, ...["", "種類", "id", "名前", "技術", "説明", "入れる囲み", ""].map((h) => el("th", { textContent: h }))),
      ),
    );
    const tbody = el("tbody");
    for (const row of rows) {
      const tr = el("tr");
      tr.dataset.key = String(row.key);
      tr.classList.toggle("selected", selected?.type === "row" && selected.key === row.key);
      const pickRow = () => tr.isConnected && select({ type: "row", key: row.key }, false);
      tr.addEventListener("focusin", pickRow);
      tr.addEventListener("click", pickRow);
      const boundary = isBoundary(row.macro);
      const id = textInput(row.id, () => {}, { className: "b-id" });
      id.addEventListener("change", () => {
        const v = id.value.trim().replace(/\s+/g, "_");
        if (!ID_RE.test(v) || rows.some((r) => r !== row && r.id === v)) {
          id.value = row.id;
          id.classList.add("b-invalid");
          setTimeout(() => id.classList.remove("b-invalid"), 1200);
          return;
        }
        renameId(row.id, v);
        row.id = v;
        rebuild();
      });
      const techn = textInput(row.techn, (v) => ((row.techn = v), touch()), { disabled: boundary || !ELEMENT_TECHN[row.macro] });
      const descr = textInput(row.descr, (v) => ((row.descr = v), touch()), { disabled: boundary });
      const up = el("button", { type: "button", textContent: "↑", title: "上へ（並び順）" });
      const down = el("button", { type: "button", textContent: "↓", title: "下へ（並び順）" });
      const del = el("button", { type: "button", textContent: "✕", title: "削除（関係も消える）" });
      up.addEventListener("click", () => moveRow(row, -1));
      down.addEventListener("click", () => moveRow(row, 1));
      del.addEventListener("click", () => removeRow(row));
      const grip = el("span", { className: "b-grip", textContent: "⠿", title: "ドラッグで並べ替え（囲みの行の真ん中に落とすと、その囲みに入れる）" });
      grip.addEventListener("pointerdown", (e) => startRowDrag(e, row, tr));
      tr.append(
        el("td", {}, grip),
        el("td", {}, kindSelect(row.macro, (v) => ((row.macro = v), rebuild()))),
        el("td", {}, id),
        el("td", {}, textInput(row.label, (v) => ((row.label = v), touch()))),
        el("td", {}, techn),
        el("td", {}, descr),
        el("td", {}, idSelect(row.parent, (v) => ((row.parent = v), rebuild()), true)),
        el("td", { className: "b-actions" }, up, down, del),
      );
      tbody.append(tr);
    }
    table.append(tbody);
    const addEl = el("button", { type: "button", textContent: "＋ 要素" });
    const addBoundary = el("button", { type: "button", textContent: "＋ 囲み" });
    addEl.addEventListener("click", () => addRow("Container"));
    addBoundary.addEventListener("click", () => addRow("System_Boundary"));
    elements.append(table, el("div", { className: "b-add" }, addEl, addBoundary));

    // 関係
    const relSec = el("section", { className: "b-section" }, el("h4", { textContent: "関係（線）" }));
    const rtable = el("table", { className: "b-table" });
    rtable.append(
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          ...["元", "", "先", "説明", "技術", "先を置く向き", "種類", "ラベル X", "Y", ""].map((h) => el("th", { textContent: h })),
        ),
      ),
    );
    const rbody = el("tbody");
    rels.forEach((rel, i) => {
      const tr = el("tr");
      tr.dataset.rel = String(i);
      tr.classList.toggle("selected", selected?.type === "rel" && selected.index === i);
      // 削除した行のクリックで選び直さないよう、表に残っているときだけ選ぶ
      const pickRel = () => tr.isConnected && select({ type: "rel", index: i }, false);
      tr.addEventListener("focusin", pickRel);
      tr.addEventListener("click", pickRel);
      const del = el("button", { type: "button", textContent: "✕", title: "削除" });
      del.addEventListener("click", () => {
        rels.splice(i, 1);
        selected = null;
        rebuild();
      });
      tr.append(
        el("td", {}, idSelect(rel.from, (v) => ((rel.from = v), rebuild()))),
        el("td", { textContent: "→", className: "b-arrow" }),
        el("td", {}, idSelect(rel.to, (v) => ((rel.to = v), rebuild()))),
        el("td", {}, textInput(rel.label, (v) => ((rel.label = v), touch()), { disabled: rel.lay })),
        el("td", {}, textInput(rel.techn, (v) => ((rel.techn = v), touch()), { disabled: rel.lay })),
        el("td", {}, dirButtons(rel, rebuild)),
        el("td", {}, relKindSelect(rel, rebuild)),
        el("td", {}, offsetInput(rel, "offsetX")),
        el("td", {}, offsetInput(rel, "offsetY")),
        el("td", { className: "b-actions" }, del),
      );
      rbody.append(tr);
    });
    rtable.append(rbody);
    const addRel = el("button", { type: "button", textContent: "＋ 関係" });
    addRel.disabled = rows.filter((r) => !isBoundary(r.macro)).length < 1;
    addRel.addEventListener("click", () => {
      const ids = rows.map((r) => r.id);
      rels.push({ from: ids[0], to: ids[1] ?? ids[0], label: "", techn: "", dir: null, both: false, lay: false, style: {}, line: 0 });
      selected = { type: "rel", index: rels.length - 1 };
      rebuild();
    });
    relSec.append(rtable, el("div", { className: "b-add" }, addRel));

    if (meta.extra.length) {
      relSec.append(
        el("p", { className: "b-note", textContent: `このフォームで扱わない行（${meta.extra.length} 行）は、そのまま末尾に残します。` }),
      );
    }
    formEl.replaceChildren(general, elements, relSec);
  }

  function spacingInput(key: "nodesep" | "ranksep", label: string) {
    const re = new RegExp(`^${key}\\s*=\\s*([\\d.]+)\\s*;?$`);
    const current = meta.dot.map((d) => re.exec(d)?.[1]).find(Boolean) ?? "";
    const input = el("input", { type: "number", step: "0.1", min: "0", value: current, placeholder: key === "nodesep" ? "0.7" : "0.8", className: "b-num" });
    input.addEventListener("input", () => {
      meta.dot = meta.dot.filter((d) => !re.test(d));
      if (input.value) meta.dot.push(`${key}=${input.value}`);
      touch();
    });
    return el("label", { title: "間隔（インチ）。```c4 のみ" }, label, input);
  }

  function addRow(macro: string) {
    const row: Row = { key: nextKey++, macro, id: newId(macro), label: "", techn: "", descr: "", typeLabel: null, parent: "" };
    row.label = isBoundary(macro) ? "囲み" : "新しい要素";
    // 選んでいる行が囲みならその中へ、囲みの中の行ならその囲みへ
    const sel = selected?.type === "row" ? rows.find((r) => r.key === (selected as { key: number }).key) : undefined;
    if (sel) row.parent = isBoundary(sel.macro) ? sel.id : sel.parent;
    const at = sel ? rows.indexOf(sel) + 1 : rows.length;
    rows.splice(at, 0, row);
    selected = { type: "row", key: row.key };
    rebuild();
    formEl.querySelector<HTMLInputElement>(`tr[data-key="${row.key}"] td:nth-child(4) input`)?.select();
  }

  // ---------- 選択（表とプレビュー） ----------

  function select(sel: Selection, scroll = true) {
    selected = sel;
    for (const tr of formEl.querySelectorAll("tr.selected")) tr.classList.remove("selected");
    const tr =
      sel?.type === "rel"
        ? formEl.querySelector(`tr[data-rel="${sel.index}"]`)
        : sel?.type === "row"
          ? formEl.querySelector(`tr[data-key="${sel.key}"]`)
          : null;
    tr?.classList.add("selected");
    if (scroll) tr?.scrollIntoView({ block: "nearest" });
    renderSelection();
    markPreview();
  }

  /** プレビュー上で、選んでいる線・要素を強調する（```c4 のみ） */
  function markPreview() {
    if (!previewEl) return;
    for (const g of previewEl.querySelectorAll(".b-picked")) g.classList.remove("b-picked");
    if (format !== "c4") return;
    if (selected?.type === "rel") previewEl.querySelector(`g#${relSvgId(selected.index)}`)?.classList.add("b-picked");
    if (selected?.type === "row") {
      const id = rows.find((r) => r.key === (selected as { key: number }).key)?.id;
      for (const g of previewEl.querySelectorAll("g.node, g.cluster")) {
        const title = g.querySelector("title")?.textContent;
        if (title === id || title === `cluster_${id}`) g.classList.add("b-picked");
      }
    }
  }

  /** 右側の「選んでいる線」パネル。線の向き・ラベル位置をその場で変えられる */
  function renderSelection() {
    if (!selectEl) return;
    if (selected?.type !== "rel" || !rels[selected.index]) {
      selectEl.replaceChildren(
        el("p", {
          className: "b-note",
          textContent:
            format === "c4"
              ? "プレビューの線か箱をクリックすると選べます。線は向き（↑↓←→）で相手を置く側を変えられます。"
              : "表の関係の行を選ぶと、ここで向きとラベル位置を変えられます（Mermaid ではプレビューのクリックでは選べません）。",
        }),
      );
      return;
    }
    const rel = rels[selected.index];
    const after = () => {
      rebuild();
      select({ type: "rel", index: rels.indexOf(rel) }, false);
    };
    const nudge = (key: "offsetX" | "offsetY", delta: number) => {
      const v = (Number(rel.style[key]) || 0) + delta;
      if (v) rel.style[key] = String(v);
      else delete rel.style[key];
      after();
    };
    const btn = (text: string, title: string, fn: () => void) => {
      const b = el("button", { type: "button", textContent: text, title });
      b.addEventListener("click", fn);
      return b;
    };
    selectEl.replaceChildren(
      el("div", { className: "b-select-title" }, el("strong", { textContent: "選んでいる線: " }), `${nameOf(rel.from)} → ${nameOf(rel.to)}`, rel.label ? `「${rel.label}」` : ""),
      el("div", { className: "b-select-row" }, el("span", { textContent: "先を置く向き" }), dirButtons(rel, after), relKindSelect(rel, after)),
      el(
        "div",
        { className: "b-select-row" },
        el("span", { textContent: `ラベル位置（mermaid）X ${rel.style.offsetX ?? 0} / Y ${rel.style.offsetY ?? 0}` }),
        btn("←", "ラベルを左へ 10", () => nudge("offsetX", -10)),
        btn("→", "ラベルを右へ 10", () => nudge("offsetX", 10)),
        btn("↑", "ラベルを上へ 10", () => nudge("offsetY", -10)),
        btn("↓", "ラベルを下へ 10", () => nudge("offsetY", 10)),
        btn("戻す", "ラベル位置を元に戻す", () => {
          delete rel.style.offsetX;
          delete rel.style.offsetY;
          after();
        }),
      ),
    );
  }

  // ---------- プレビューでのドラッグ（```c4 のみ） ----------
  // 移動: 自動配置なら、別の箱の上下左右に落とすと向き（Rel_* / Lay_*）に変換する。
  //       自由配置なら、落とした位置に固定する（Pos）。囲みを動かすと中の要素も一緒に動く。
  // 線を引く: 箱から箱へドラッグすると関係を追加する。

  /** プレビューの図（Graphviz の SVG）のグラフ部分 */
  const graphOf = () => previewEl.querySelector<SVGGElement>("svg g.graph");

  /** 箱（g.node）の id と、グラフ座標での中心 */
  function nodeCenter(g: SVGGElement) {
    const b = g.getBBox();
    return { id: g.querySelector("title")?.textContent ?? "", x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }

  const nodeById = (id: string) =>
    [...previewEl.querySelectorAll<SVGGElement>("g.node")].find((g) => g.querySelector("title")?.textContent === id);

  /**
   * 今の図での要素の位置（Pos の座標。y は上向き）。位置を決めていない要素は、表示されている位置から求める。
   * neato は図全体をずらして出力することがあるので、位置を決めた要素とのずれで補正する
   */
  function positionOf(id: string): { x: number; y: number } | null {
    if (meta.positions[id]) return { ...meta.positions[id] };
    const g = nodeById(id);
    if (!g) return null;
    const c = nodeCenter(g);
    let dx = 0;
    let dy = 0;
    for (const [pid, p] of Object.entries(meta.positions)) {
      const pg = nodeById(pid);
      if (!pg) continue;
      const pc = nodeCenter(pg);
      dx = pc.x - p.x;
      dy = pc.y + p.y;
      break;
    }
    return { x: c.x - dx, y: -(c.y - dy) };
  }

  /** 自動配置 ⇔ 自由配置。自由にするときは、今の自動配置の位置をそのまま初期位置にする */
  function setFreeLayout(free: boolean) {
    if (!free) meta.positions = {};
    else {
      for (const g of previewEl.querySelectorAll<SVGGElement>("g.node")) {
        const c = nodeCenter(g);
        if (rows.some((r) => r.id === c.id)) meta.positions[c.id] = { x: Math.round(c.x), y: Math.round(-c.y) };
      }
    }
    rebuild();
  }

  /** 囲みの中にある要素の id（入れ子の中も含む） */
  function membersOf(boundaryId: string): string[] {
    const out: string[] = [];
    for (const r of rows) {
      if (r.parent !== boundaryId) continue;
      if (isBoundary(r.macro)) out.push(...membersOf(r.id));
      else out.push(r.id);
    }
    return out;
  }

  /** 画面上の点の下にある箱（dragged は除く） */
  function nodeAt(x: number, y: number, except?: Element): SVGGElement | null {
    for (const e of document.elementsFromPoint(x, y)) {
      const g = e.closest<SVGGElement>("g.node");
      if (g && g !== except && previewEl.contains(g)) return g;
    }
    return null;
  }

  const OPPOSITE: Record<string, Dir> = { U: "D", D: "U", L: "R", R: "L" };

  /**
   * 自動配置: 箱 moved を、箱 target の side 側に置く。
   * 2 つの間に関係があればその向きを変え、なければ配置だけの Lay_* を足す（既にあれば向きを変える）
   */
  function placeBeside(moved: string, target: string, side: Exclude<Dir, null>) {
    const rel = rels.find((r) => !r.lay && ((r.from === target && r.to === moved) || (r.from === moved && r.to === target)));
    if (rel) rel.dir = rel.from === target ? side : OPPOSITE[side];
    else {
      const lay = rels.find((r) => r.lay && ((r.from === target && r.to === moved) || (r.from === moved && r.to === target)));
      if (lay) lay.dir = lay.from === target ? side : OPPOSITE[side];
      else rels.push({ from: target, to: moved, label: "", techn: "", dir: side, both: false, lay: true, style: {}, line: 0 });
    }
    const index = rels.findIndex((r) => (r.from === target && r.to === moved) || (r.from === moved && r.to === target));
    rebuild();
    select({ type: "rel", index }, true);
  }

  /** 少しの間、プレビューの上にお知らせを出す */
  function hint(text: string) {
    const note = barEl.querySelector<HTMLElement>(".b-hint");
    if (!note) return;
    note.textContent = text;
    note.classList.add("b-flash");
    setTimeout(() => {
      note.classList.remove("b-flash");
      renderBar();
    }, 2500);
  }

  function onPreviewPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const target = e.target as Element;
    const edge = target.closest("g.edge");
    const node = target.closest<SVGGElement>("g.node");
    const cluster = target.closest<SVGGElement>("g.cluster");
    // 線はクリックで選ぶだけ
    if (edge || format !== "c4" || (!node && !cluster)) {
      const onUp = () => {
        previewEl.removeEventListener("pointerup", onUp);
        pickInPreview(target);
      };
      previewEl.addEventListener("pointerup", onUp);
      return;
    }
    const graph = graphOf();
    const ctm = graph?.getScreenCTM();
    if (!graph || !ctm) return;
    e.preventDefault();
    capture(previewEl, e.pointerId, true);
    const start = { x: e.clientX, y: e.clientY };
    const free = isFreeLayout(meta);
    const startId = node ? nodeCenter(node).id : "";
    const clusterId = cluster?.querySelector("title")?.textContent?.replace(/^cluster_/, "") ?? "";
    // 動かす SVG の要素（囲みなら中の要素も）
    const moving: SVGGElement[] = node
      ? [node]
      : free && cluster
        ? [cluster, ...membersOf(clusterId).map(nodeById).filter((g): g is SVGGElement => !!g)]
        : [];
    let dragging = false;
    let line: SVGLineElement | null = null;

    const toGraph = (x: number, y: number) => ({ x: (x - start.x) / ctm.a, y: (y - start.y) / ctm.d });

    const onMove = (ev: PointerEvent) => {
      if (!dragging && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
      dragging = true;
      const d = toGraph(ev.clientX, ev.clientY);
      if (tool === "line" && node) {
        const c = nodeCenter(node);
        if (!line) {
          line = document.createElementNS("http://www.w3.org/2000/svg", "line");
          line.setAttribute("class", "b-drawing");
          graph.append(line);
        }
        line.setAttribute("x1", String(c.x));
        line.setAttribute("y1", String(c.y));
        line.setAttribute("x2", String(c.x + d.x));
        line.setAttribute("y2", String(c.y + d.y));
        return;
      }
      for (const g of moving) g.setAttribute("transform", `translate(${d.x} ${d.y})`);
    };

    const onUp = (ev: PointerEvent) => {
      previewEl.removeEventListener("pointermove", onMove);
      previewEl.removeEventListener("pointerup", onUp);
      capture(previewEl, ev.pointerId, false);
      line?.remove();
      if (!dragging) return pickInPreview(target);
      const d = toGraph(ev.clientX, ev.clientY);
      // 線を引く
      if (tool === "line") {
        const to = node ? nodeAt(ev.clientX, ev.clientY, node) : null;
        const toId = to ? nodeCenter(to).id : "";
        if (!node || !toId) return hint("線は、箱から別の箱までドラッグして引きます。");
        rels.push({ from: startId, to: toId, label: "", techn: "", dir: null, both: false, lay: false, style: {}, line: 0 });
        rebuild();
        select({ type: "rel", index: rels.length - 1 }, true);
        formEl.querySelector<HTMLInputElement>(`tr[data-rel="${rels.length - 1}"] td:nth-child(4) input`)?.focus();
        return;
      }
      // 自由配置: 落とした位置に固定する
      if (free) {
        const ids = node ? [startId] : membersOf(clusterId);
        for (const id of ids) {
          const p = positionOf(id);
          if (p) meta.positions[id] = { x: Math.round(p.x + d.x), y: Math.round(p.y - d.y) };
        }
        rebuild();
        return;
      }
      // 自動配置: 別の箱の上下左右に寄せる
      for (const g of moving) g.removeAttribute("transform");
      const to = node ? nodeAt(ev.clientX, ev.clientY, node) : null;
      if (!node || !to) {
        return hint(
          node
            ? "別の箱の上下左右に重ねて落とすと、その側に置きます。好きな位置に置くには「配置」を「自由」にします。"
            : "囲みを動かすには「配置」を「自由」にします。",
        );
      }
      const r = to.getBoundingClientRect();
      const dx = (ev.clientX - (r.left + r.width / 2)) / r.width;
      const dy = (ev.clientY - (r.top + r.height / 2)) / r.height;
      const side: Exclude<Dir, null> = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "R" : "L") : dy > 0 ? "D" : "U";
      placeBeside(startId, nodeCenter(to).id, side);
    };
    previewEl.addEventListener("pointermove", onMove);
    previewEl.addEventListener("pointerup", onUp);
  }

  /** プレビューのクリック: 線・箱・囲みを選ぶ */
  function pickInPreview(target: Element) {
    if (format !== "c4") return;
    const edge = target.closest("g.edge");
    const m = edge ? /^c4rel(\d+)$/.exec(edge.id) : null;
    if (m) return select({ type: "rel", index: Number(m[1]) });
    const node = target.closest("g.node, g.cluster");
    const title = node?.querySelector("title")?.textContent?.replace(/^cluster_/, "");
    const row = rows.find((r) => r.id === title);
    if (row) select({ type: "row", key: row.key });
  }

  /** プレビューの上の道具（ドラッグの意味の切り替えと説明） */
  function renderBar() {
    if (!barEl) return;
    if (format !== "c4") {
      barEl.replaceChildren(
        el("span", { className: "b-hint", textContent: "ドラッグでの配置・線の追加は ```c4 のときだけ使えます（Mermaid は位置を指定できないため）。" }),
      );
      return;
    }
    const seg = el("div", { className: "segmented" });
    for (const [value, label, title] of [
      ["move", "移動", "箱をドラッグして動かす"],
      ["line", "線を引く", "箱から箱へドラッグして関係を追加する"],
    ] as const) {
      const b = el("button", { type: "button", textContent: label, title });
      b.classList.toggle("active", tool === value);
      b.addEventListener("click", () => {
        tool = value;
        renderBar();
      });
      seg.append(b);
    }
    const text =
      tool === "line"
        ? "箱から別の箱へドラッグすると、線（関係）を追加します。"
        : isFreeLayout(meta)
          ? "自由配置: 箱や囲みをドラッグした位置に置きます。線は自動で引きます。"
          : "箱を別の箱の上下左右に重ねて落とすと、その側に置きます（Rel_* / Lay_*）。";
    barEl.replaceChildren(el("span", { textContent: "ドラッグで:" }), seg, el("span", { className: "b-hint", textContent: text }));
  }

  // ---------- 表の行のドラッグ（並べ替え・囲みに入れる） ----------

  function startRowDrag(e: PointerEvent, row: Row, tr: HTMLTableRowElement) {
    if (e.button !== 0) return;
    e.preventDefault();
    const grip = e.currentTarget as HTMLElement;
    capture(grip, e.pointerId, true);
    tr.classList.add("b-dragging");
    let drop: { row: Row; where: "before" | "after" | "into"; tr: HTMLElement } | null = null;
    const clear = () => drop?.tr.classList.remove("b-drop-before", "b-drop-after", "b-drop-into");

    const onMove = (ev: PointerEvent) => {
      clear();
      drop = null;
      // 表の上端・下端に近づいたら、見えていない行へ届くようにスクロールする
      const area = formEl.getBoundingClientRect();
      if (ev.clientY < area.top + 30) formEl.scrollTop -= 12;
      else if (ev.clientY > area.bottom - 30) formEl.scrollTop += 12;
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("tr[data-key]");
      const target = over && rows.find((r) => String(r.key) === over.dataset.key);
      if (!over || !target || target === row || !formEl.contains(over)) return;
      const r = over.getBoundingClientRect();
      const t = (ev.clientY - r.top) / r.height;
      // 囲みの行の真ん中なら中へ（自分の中には入れない）
      const into = isBoundary(target.macro) && t > 0.3 && t < 0.7 && !(isBoundary(row.macro) && membersOfBoundary(row.id).includes(target.id));
      drop = { row: target, where: into ? "into" : t < 0.5 ? "before" : "after", tr: over };
      over.classList.add(`b-drop-${drop.where}`);
    };
    const onUp = (ev: PointerEvent) => {
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
      capture(grip, ev.pointerId, false);
      tr.classList.remove("b-dragging");
      clear();
      if (!drop) return;
      rows.splice(rows.indexOf(row), 1);
      const at = rows.indexOf(drop.row);
      if (drop.where === "into") {
        row.parent = drop.row.id;
        rows.splice(at + 1, 0, row);
      } else {
        row.parent = drop.row.parent;
        rows.splice(drop.where === "before" ? at : at + 1, 0, row);
      }
      selected = { type: "row", key: row.key };
      rebuild();
    };
    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
  }

  /** 囲みの中の行の id（入れ子の囲みも含む） */
  function membersOfBoundary(id: string): string[] {
    return rows.filter((r) => r.parent === id).flatMap((r) => [r.id, ...(isBoundary(r.macro) ? membersOfBoundary(r.id) : [])]);
  }

  // ---------- DiagramForm ----------

  return {
    title: "C4",
    formats: [
      { value: "c4", label: "```c4（Graphviz。線の向きが配置に効く）" },
      { value: "mermaid", label: "```mermaid（Mermaid の C4）" },
    ],
    accepts: (lang, body) => lang === "c4" || (lang === "mermaid" && /^\s*C4\w+/.test(body)),
    load(body) {
      if (body == null) {
        const m = emptyModel();
        m.nodes = [
          { type: "element", macro: "Person", id: "user", label: "利用者", techn: "", descr: "", line: 0 },
          { type: "element", macro: "System", id: "system", label: "システム", techn: "", descr: "", line: 0 },
        ];
        m.rels = [{ from: "user", to: "system", label: "使う", techn: "", dir: null, both: false, lay: false, style: {}, line: 0 }];
        fromModel(m);
      } else fromModel(parseC4(body));
    },
    mount(parts, onChange) {
      formEl = parts.form;
      selectEl = parts.side;
      barEl = parts.bar;
      // プレビューの要素は開くたびに同じものなので、操作は 1 回だけ登録する
      if (previewEl !== parts.preview) {
        previewEl = parts.preview;
        previewEl.addEventListener("pointerdown", onPreviewPointerDown);
      }
      changed = onChange;
      renderForm();
      renderSelection();
      renderBar();
    },
    setFormat(f) {
      format = f as "c4" | "mermaid";
      renderSelection();
      renderBar();
    },
    code: () => writeC4(toModel(), format),
    afterRender() {
      markPreview();
    },
  };
}
