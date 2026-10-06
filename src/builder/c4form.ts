// 図のビルダー: C4 の入力フォーム（要素・囲み・関係・全体）と、選んだ線の向きを変えるパネル

import {
  BOUNDARY_TYPES,
  ELEMENT_TECHN,
  emptyModel,
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
  }

  function removeRow(row: Row) {
    rows = rows.filter((r) => r !== row);
    rels = rels.filter((r) => r.from !== row.id && r.to !== row.id);
    meta.styles = meta.styles.filter((s) => s.id !== row.id);
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
        el("tr", {}, ...["種類", "id", "名前", "技術", "説明", "入れる囲み", ""].map((h) => el("th", { textContent: h }))),
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
      tr.append(
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
    formEl.querySelector<HTMLInputElement>(`tr[data-key="${row.key}"] td:nth-child(3) input`)?.select();
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

  let previewEl: HTMLElement | null = null;

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
    mount(form, side, onChange) {
      formEl = form;
      selectEl = side;
      changed = onChange;
      renderForm();
      renderSelection();
    },
    setFormat(f) {
      format = f as "c4" | "mermaid";
      renderSelection();
    },
    code: () => writeC4(toModel(), format),
    afterRender(preview) {
      previewEl = preview;
      markPreview();
    },
    onPreviewClick(target) {
      if (format !== "c4") return;
      const edge = target.closest("g.edge");
      const m = edge ? /^c4rel(\d+)$/.exec(edge.id) : null;
      if (m) return select({ type: "rel", index: Number(m[1]) });
      const node = target.closest("g.node, g.cluster");
      const title = node?.querySelector("title")?.textContent?.replace(/^cluster_/, "");
      const row = rows.find((r) => r.id === title);
      if (row) select({ type: "row", key: row.key });
    },
  };
}
