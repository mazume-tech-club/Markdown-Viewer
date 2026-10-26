// 図のビルダー: ガントチャートの入力フォーム（Excel のような表）と、プレビューの横棒のドラッグ。
// 表のセルは Enter・↑↓ で上下に移り、Ctrl+Enter で行を足し、Ctrl+Delete で行を消す。
// Excel で選んだ範囲（タブ区切り）を貼り付けると、セルに広げる。Ctrl+Z / Ctrl+Y はこの画面の中の編集を戻す

import {
  calendarOf,
  columnOf,
  formatDate,
  ganttToMermaid,
  mermaidCopyNote,
  isWrittenRow,
  parseDate,
  parseGantt,
  scheduleGantt,
  writeGantt,
  type GanttColumn,
  type GanttGroupBy,
  type GanttItem,
  type GanttModel,
  type GanttRow,
  type GanttView,
} from "../gantt";
import { todayDay } from "../ganttsvg";
import type { DiagramForm } from "./builder";

/** 表の列（左から） */
const COLUMNS: { col: GanttColumn; label: string; placeholder: string; className: string }[] = [
  { col: "name", label: "タスク", placeholder: "# で始めるとグループ", className: "g-name" },
  { col: "start", label: "開始", placeholder: "2026-11-02", className: "g-date" },
  { col: "end", label: "終了", placeholder: "", className: "g-date" },
  { col: "days", label: "日数", placeholder: "", className: "g-num" },
  { col: "owner", label: "担当", placeholder: "", className: "g-owner" },
  { col: "progress", label: "進捗", placeholder: "", className: "g-num" },
  { col: "note", label: "メモ", placeholder: "", className: "g-note" },
];

const VIEWS: [GanttView, string][] = [
  ["day", "日"],
  ["week", "週"],
  ["month", "月"],
];

const GROUP_BYS: [GanttGroupBy, string, string][] = [
  ["group", "グループ", "図をグループごとに並べる（表の順）"],
  ["owner", "担当", "図を担当ごとに並べ、その下にグループを小見出しで出す（表は変えない）"],
];

const blankRow = (): GanttRow => ({ group: false, name: "", start: "", end: "", days: "", owner: "", progress: "", note: "" });

/** セルに出す値（グループは # 付きで出す） */
const cellValue = (r: GanttRow, col: GanttColumn) => (col === "name" ? (r.group ? `# ${r.name}` : r.name) : r[col]);

function setCell(r: GanttRow, col: GanttColumn, v: string) {
  if (col !== "name") r[col] = v;
  else if (/^\s*#/.test(v)) {
    r.group = true;
    r.name = v.replace(/^\s*#+\s*/, "");
  } else {
    r.group = false;
    r.name = v;
  }
}

/** ドラッグ中もポインタを受け取り続ける（ポインタが既に離れているなどで失敗しても、ドラッグ自体は続ける） */
function capture(target: Element, pointerId: number, on: boolean) {
  try {
    if (on) target.setPointerCapture(pointerId);
    else target.releasePointerCapture(pointerId);
  } catch {
    // 何もしない
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...children);
  return e;
}

export function createGanttForm(): DiagramForm {
  let model: GanttModel = { title: "", holidays: [], view: "day", groupBy: "group", rows: [] };
  /** 選んでいる行（rows の位置）。無ければ -1 */
  let selected = -1;
  let changed: () => void = () => {};
  let formEl: HTMLElement;
  let selectEl: HTMLElement;
  let barEl: HTMLElement;
  let previewEl: HTMLElement;
  /** 元に戻す履歴（モデルの JSON）と、今の位置 */
  let history: string[] = [];
  let at = -1;
  let typingTimer = 0;

  // ---------- 元に戻す ----------

  const snapshot = () => JSON.stringify({ model, selected });

  /** 今の状態を履歴に積む（直前と同じなら積まない） */
  function commit() {
    clearTimeout(typingTimer);
    const s = snapshot();
    if (history[at] === s) return;
    history = history.slice(0, at + 1);
    history.push(s);
    if (history.length > 200) history.shift();
    at = history.length - 1;
  }

  function restore(delta: number) {
    commit();
    const next = at + delta;
    if (next < 0 || next >= history.length) return;
    at = next;
    // 表を描き直すとフォーカスが外れるので、同じセルに戻す（続けて Ctrl+Z / Ctrl+Y を押せるように）
    const active = document.activeElement as HTMLElement | null;
    const tr = active?.closest?.<HTMLElement>("tr[data-row]");
    const cell = tr ? { row: Number(tr.dataset.row), ci: Number(active!.dataset.ci ?? 0) } : null;
    ({ model, selected } = JSON.parse(history[at]) as { model: GanttModel; selected: number });
    renderAll();
    changed();
    const row = cell && cell.row < model.rows.length ? cell.row : selected;
    if (row >= 0) focusCell(row, cell?.ci ?? 0);
    else formEl.querySelector<HTMLInputElement>("input")?.focus();
  }

  /** フォームのどこにフォーカスがあっても、Ctrl+Z / Ctrl+Y はこの画面の中の編集を戻す */
  function onFormKey(e: KeyboardEvent) {
    if (e.isComposing || !formEl.querySelector(".g-table")) return;
    const key = e.key.toLowerCase();
    if (!(e.ctrlKey || e.metaKey)) return;
    const undo = key === "z" && !e.shiftKey;
    const redo = key === "y" || (key === "z" && e.shiftKey);
    if (!undo && !redo) return;
    e.preventDefault();
    e.stopPropagation();
    restore(undo ? -1 : 1);
  }

  // ---------- 変更の反映 ----------

  /** 文字の入力（フォーカスを保つため表は描き直さない）。入力が止まったら履歴に積む */
  function touch() {
    clearTimeout(typingTimer);
    typingTimer = window.setTimeout(commit, 600);
    updateComputed();
    renderSelection();
    changed();
  }

  /** 行の追加・削除・並べ替え・グループの切り替えなど */
  function rebuild() {
    renderAll();
    commit();
    changed();
  }

  function renderAll() {
    renderForm();
    renderSelection();
    renderBar();
  }

  /** 計算した予定（誤りがあれば null と誤り） */
  function plan(): { items: GanttItem[] | null; error: string } {
    try {
      return { items: scheduleGantt(model).items, error: "" };
    } catch (err) {
      return { items: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  const taskAt = (items: GanttItem[] | null, row: number) => {
    const it = items?.find((i) => i.row === row);
    return it?.type === "task" ? it : null;
  };

  /** 空の開始・終了のセルに、計算した日付を薄く出す（前のタスクに続く日付が分かるように） */
  function updateComputed() {
    if (!formEl) return;
    const { items } = plan();
    for (const tr of formEl.querySelectorAll<HTMLTableRowElement>("tr[data-row]")) {
      const row = Number(tr.dataset.row);
      const r = model.rows[row];
      const t = taskAt(items, row);
      tr.classList.toggle("g-group", !!r?.group);
      const set = (col: GanttColumn, text: string) => {
        const input = tr.querySelector<HTMLInputElement>(`input[data-col="${col}"]`);
        if (input) input.placeholder = text;
      };
      set("start", t ? formatDate(t.start) : r?.group ? "" : row === firstTaskRow() ? "2026-11-02" : "前に続く");
      set("end", t && !t.milestone ? formatDate(t.end) : "");
      set("days", t ? (t.milestone ? "0" : String(calendarOf(model).count(t.start, t.end))) : "");
      for (const input of tr.querySelectorAll<HTMLInputElement>("input[data-col]")) {
        input.disabled = !!r?.group && input.dataset.col !== "name";
      }
    }
  }

  const firstTaskRow = () => model.rows.findIndex((r) => !r.group && isWrittenRow(r));

  /** プレビューの横棒の data-row（書き出した行の位置）→ 表の行。名前の無い行は書き出さないのでずれる */
  const writtenRows = () => model.rows.flatMap((r, i) => (isWrittenRow(r) ? [i] : []));

  // ---------- 表 ----------

  function renderForm() {
    if (!formEl) return;
    const general = el("section", { className: "b-section" }, el("h4", { textContent: "全体" }));
    const title = el("input", { type: "text", value: model.title, placeholder: "（なし）" });
    title.addEventListener("input", () => ((model.title = title.value), touch()));
    const holidays = el("input", {
      type: "text",
      value: model.holidays.join(", "),
      placeholder: "2026-11-03, 2026-12-29〜2027-01-03",
      className: "g-holidays",
    });
    holidays.addEventListener("input", () => {
      model.holidays = holidays.value.replace(/\s*([〜~～])\s*/g, "$1").split(/[\s,、，]+/).filter(Boolean);
      touch();
    });
    general.append(
      el(
        "div",
        { className: "b-grid" },
        el("label", {}, "タイトル", title),
        el("label", { title: "土日のほかに休む日。カンマで区切り、期間は 〜 でつなぐ。祝日は書いた日だけが休みになる" }, "休日", holidays),
      ),
    );

    const tasks = el("section", { className: "b-section" }, el("h4", { textContent: "タスク" }));
    const table = el("table", { className: "b-table g-table" });
    table.append(el("thead", {}, el("tr", {}, el("th"), ...COLUMNS.map((c) => el("th", { textContent: c.label })), el("th"))));
    const tbody = el("tbody");
    model.rows.forEach((r, row) => {
      const tr = el("tr");
      tr.dataset.row = String(row);
      tr.classList.toggle("selected", row === selected);
      tr.addEventListener("focusin", () => select(row, false));
      const grip = el("span", { className: "b-grip", textContent: "⠿", title: "ドラッグで並べ替え" });
      grip.addEventListener("pointerdown", (e) => startRowDrag(e, row, tr));
      tr.append(el("td", {}, grip));
      COLUMNS.forEach((c, ci) => {
        const input = el("input", { type: "text", value: cellValue(r, c.col), placeholder: c.placeholder, className: c.className });
        input.dataset.col = c.col;
        input.dataset.ci = String(ci);
        input.addEventListener("input", () => {
          const wasGroup = r.group;
          setCell(r, c.col, input.value);
          if (wasGroup !== r.group) updateComputed();
          touch();
        });
        input.addEventListener("keydown", (e) => onCellKey(e, row, ci));
        input.addEventListener("paste", (e) => onPaste(e, row, ci));
        tr.append(el("td", {}, input));
      });
      const up = el("button", { type: "button", textContent: "↑", title: "上へ" });
      const down = el("button", { type: "button", textContent: "↓", title: "下へ" });
      const del = el("button", { type: "button", textContent: "✕", title: "行を削除 (Ctrl+Delete)" });
      up.addEventListener("click", () => moveRow(row, row - 1));
      down.addEventListener("click", () => moveRow(row, row + 1));
      del.addEventListener("click", () => removeRow(row));
      tr.append(el("td", { className: "b-actions" }, up, down, del));
      tbody.append(tr);
    });
    table.append(tbody);
    const addTask = el("button", { type: "button", textContent: "＋ タスク" });
    const addGroup = el("button", { type: "button", textContent: "＋ グループ" });
    const addMilestone = el("button", { type: "button", textContent: "＋ マイルストーン" });
    addTask.addEventListener("click", () => insertRow({ ...blankRow(), name: "新しいタスク", days: "1" }));
    addGroup.addEventListener("click", () => insertRow({ ...blankRow(), group: true, name: "グループ" }));
    addMilestone.addEventListener("click", () => insertRow({ ...blankRow(), name: "マイルストーン", days: "0" }));
    tasks.append(
      table,
      el("div", { className: "b-add" }, addTask, addGroup, addMilestone),
      el("p", {
        className: "b-note",
        textContent:
          "開始が空なら前のタスクの翌営業日から始めます。日数は土日と休日を除いて数え、0 はマイルストーン（◆）です。" +
          "Enter・↑↓ で上下に移動、Ctrl+Enter で下に行を追加、Ctrl+Delete で行を削除。Excel の範囲を貼り付けるとセルに広げます（見出しの行ごと貼れば列名で合わせます）。",
      }),
    );
    formEl.replaceChildren(general, tasks);
    updateComputed();
  }

  /** 選んでいる行の下（無ければ末尾）に行を足し、タスク名を選ぶ */
  function insertRow(r: GanttRow) {
    const pos = selected >= 0 ? selected + 1 : model.rows.length;
    model.rows.splice(pos, 0, r);
    selected = pos;
    rebuild();
    focusCell(pos, 0, true);
  }

  function removeRow(row: number) {
    model.rows.splice(row, 1);
    selected = Math.min(row, model.rows.length - 1);
    rebuild();
    if (selected >= 0) focusCell(selected, 0);
  }

  function moveRow(from: number, to: number) {
    if (to < 0 || to >= model.rows.length || from === to) return;
    const [r] = model.rows.splice(from, 1);
    model.rows.splice(to, 0, r);
    selected = to;
    rebuild();
  }

  function focusCell(row: number, ci: number, selectAll = false) {
    const input = formEl.querySelector<HTMLInputElement>(`tr[data-row="${row}"] input[data-ci="${ci}"]`);
    if (!input) return;
    input.focus();
    if (selectAll) input.select();
  }

  function onCellKey(e: KeyboardEvent, row: number, ci: number) {
    if (e.isComposing) return;
    const mod = e.ctrlKey || e.metaKey;
    const run = (fn: () => void) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    };
    if (mod && e.key === "Enter") {
      return run(() => {
        selected = row;
        insertRow(blankRow());
      });
    }
    if (mod && e.key === "Delete") return run(() => removeRow(row));
    if (e.key === "Enter" || e.key === "ArrowDown" || e.key === "ArrowUp") {
      const up = e.key === "ArrowUp" || (e.key === "Enter" && e.shiftKey);
      run(() => {
        commit();
        const next = row + (up ? -1 : 1);
        if (next >= model.rows.length && e.key === "Enter") {
          // 最後の行で Enter を押したら、下に行を足す
          model.rows.push(blankRow());
          selected = next;
          rebuild();
        }
        focusCell(Math.max(0, Math.min(next, model.rows.length - 1)), ci);
      });
    }
  }

  /** Excel などからタブ区切りの範囲を貼り付けたら、選んでいるセルから右下へ広げる */
  function onPaste(e: ClipboardEvent, row: number, ci: number) {
    const text = e.clipboardData?.getData("text/plain") ?? "";
    const body = text.replace(/\r/g, "").replace(/\n+$/, "");
    if (!body.includes("\t") && !body.includes("\n")) return; // 1 つのセルの貼り付けはそのまま
    e.preventDefault();
    const lines = body.split("\n").map((l) => l.split("\t").map((c) => c.trim()));
    // 1 行目が見出し（タスク・開始…）なら、列名で合わせて先頭の列から入れる
    const header = lines[0].map(columnOf);
    const byHeader = header.includes("name");
    const cols: (GanttColumn | undefined)[] = byHeader ? header : lines[0].map((_, j) => COLUMNS[ci + j]?.col);
    const data = byHeader ? lines.slice(1) : lines;
    data.forEach((cells, i) => {
      const r = (model.rows[row + i] ??= blankRow());
      cells.forEach((v, j) => {
        const col = cols[j];
        if (col) setCell(r, col, normalizePasted(col, v));
      });
    });
    selected = row;
    rebuild();
    focusCell(row, ci);
  }

  /** Excel の日付（2026/11/2）・進捗（0.4 や 40%）を表の書き方にそろえる */
  function normalizePasted(col: GanttColumn, v: string): string {
    if (col === "start" || col === "end") {
      const d = parseDate(v);
      return d === null ? v : formatDate(d);
    }
    if (col === "progress" && /^0?\.\d+$|^1(\.0+)?$/.test(v)) return `${Math.round(Number(v) * 100)}%`;
    return v;
  }

  // ---------- 行のドラッグ（並べ替え） ----------

  function startRowDrag(e: PointerEvent, row: number, tr: HTMLTableRowElement) {
    if (e.button !== 0) return;
    e.preventDefault();
    const grip = e.currentTarget as HTMLElement;
    capture(grip, e.pointerId, true);
    tr.classList.add("b-dragging");
    let drop: { row: number; before: boolean; tr: HTMLElement } | null = null;
    const clear = () => drop?.tr.classList.remove("b-drop-before", "b-drop-after");
    const onMove = (ev: PointerEvent) => {
      clear();
      drop = null;
      const area = formEl.getBoundingClientRect();
      if (ev.clientY < area.top + 30) formEl.scrollTop -= 12;
      else if (ev.clientY > area.bottom - 30) formEl.scrollTop += 12;
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("tr[data-row]");
      if (!over || !formEl.contains(over) || over === tr) return;
      const r = over.getBoundingClientRect();
      drop = { row: Number(over.dataset.row), before: ev.clientY < r.top + r.height / 2, tr: over };
      over.classList.add(drop.before ? "b-drop-before" : "b-drop-after");
    };
    const onUp = (ev: PointerEvent) => {
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
      capture(grip, ev.pointerId, false);
      tr.classList.remove("b-dragging");
      clear();
      if (!drop) return;
      let to = drop.before ? drop.row : drop.row + 1;
      if (to > row) to--;
      moveRow(row, to);
    };
    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
  }

  // ---------- 選択 ----------

  function select(row: number, scroll = true) {
    if (selected === row && !scroll) return;
    selected = row;
    for (const tr of formEl.querySelectorAll("tr.selected")) tr.classList.remove("selected");
    const tr = formEl.querySelector(`tr[data-row="${row}"]`);
    tr?.classList.add("selected");
    if (scroll) tr?.scrollIntoView({ block: "nearest" });
    renderSelection();
    markPreview();
  }

  function markPreview() {
    if (!previewEl) return;
    for (const g of previewEl.querySelectorAll(".b-picked")) g.classList.remove("b-picked");
    const pos = writtenRows().indexOf(selected);
    if (pos >= 0) previewEl.querySelector(`g.gantt-bar[data-row="${pos}"]`)?.classList.add("b-picked");
  }

  /** 右側のパネル: 選んでいるタスクの予定（または誤り） */
  function renderSelection() {
    if (!selectEl) return;
    const { items, error } = plan();
    if (error) {
      selectEl.replaceChildren(el("p", { className: "b-note g-error", textContent: error }));
      return;
    }
    const t = taskAt(items, selected);
    if (!t) {
      selectEl.replaceChildren(el("p", { className: "b-note", textContent: "表の行か、プレビューの横棒をクリックすると選べます。" }));
      return;
    }
    const days = t.milestone ? "マイルストーン" : `${calendarOf(model).count(t.start, t.end)} 営業日`;
    const span = t.milestone ? formatDate(t.start) : `${formatDate(t.start)} 〜 ${formatDate(t.end)}`;
    selectEl.replaceChildren(
      el("div", { className: "b-select-title" }, el("strong", { textContent: "選んでいるタスク: " }), t.name, `（${span}、${days}）`),
      ...(t.warning ? [el("p", { className: "b-note g-error", textContent: `⚠ ${t.warning}` })] : []),
    );
  }

  /** プレビューの上の道具（表示の単位とドラッグの説明） */
  function renderBar() {
    if (!barEl) return;
    const seg = el("div", { className: "segmented" });
    for (const [view, label] of VIEWS) {
      const b = el("button", { type: "button", textContent: label, title: `${label}単位で表示` });
      b.classList.toggle("active", model.view === view);
      b.addEventListener("click", () => {
        model.view = view;
        renderBar();
        commit();
        changed();
      });
      seg.append(b);
    }
    const copy = el("button", {
      type: "button",
      textContent: "Mermaid でコピー",
      className: "g-copy",
      title: "GitHub など、ほかのビューアでも描ける Mermaid の gantt にしてコピーする（担当は名前の後ろに。まとめが担当なら見出しに。進捗は done / active に。メモは入らない）",
    });
    copy.addEventListener("click", () => {
      try {
        const text = "```mermaid\n" + ganttToMermaid(model) + "```\n";
        navigator.clipboard.writeText(text).then(
          () => hint(`Mermaid の gantt をコピーしました（${mermaidCopyNote(model.groupBy)}）。`),
          (err) => hint(`コピーできませんでした: ${err}`),
        );
      } catch (err) {
        hint(err instanceof Error ? err.message : String(err));
      }
    });
    const groupSeg = el("div", { className: "segmented" });
    for (const [groupBy, label, title] of GROUP_BYS) {
      const b = el("button", { type: "button", textContent: label, title });
      b.classList.toggle("active", model.groupBy === groupBy);
      b.addEventListener("click", () => {
        model.groupBy = groupBy;
        renderBar();
        commit();
        changed();
      });
      groupSeg.append(b);
    }
    barEl.replaceChildren(
      el("span", { textContent: "表示:" }),
      seg,
      el("span", { textContent: "まとめ:" }),
      groupSeg,
      el("span", { className: "b-hint", textContent: "横棒をドラッグで移動、右端をドラッグで期間を変えます。" }),
      copy,
    );
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

  // ---------- プレビューの横棒のドラッグ ----------
  // 横棒の中ほど: 開始ごと動かす（終了日を書いた行は終了日も同じだけずらす）。
  // 横棒の右端: 終了を動かす（日数で書いた行は日数を、終了日で書いた行は終了日を直す）

  function onPreviewPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const target = e.target as Element;
    const bar = target.closest<SVGGElement>("g.gantt-bar");
    const svg = target.closest<SVGSVGElement>("svg.gantt");
    if (!bar || !svg) return;
    const row = writtenRows()[Number(bar.dataset.row)];
    const ctm = svg.getScreenCTM();
    if (row === undefined) return;
    const dw = Number(svg.dataset.dayWidth);
    if (!ctm || !dw) return;
    e.preventDefault();
    capture(previewEl, e.pointerId, true);
    const resize = target.classList.contains("gantt-handle-end");
    const startX = e.clientX;
    let dragging = false;
    const shapes = [...bar.querySelectorAll<SVGRectElement>("rect")];
    const widths = shapes.map((s) => Number(s.getAttribute("width")));
    const daysOf = (ev: PointerEvent) => Math.round((ev.clientX - startX) / ctm.a / dw);

    const onMove = (ev: PointerEvent) => {
      if (!dragging && Math.abs(ev.clientX - startX) < 4) return;
      dragging = true;
      const d = daysOf(ev) * dw;
      if (!resize) bar.setAttribute("transform", `translate(${d} 0)`);
      else {
        // 枠の横棒と右端のつまみだけを伸び縮みさせる（進捗の塗りはそのまま）
        shapes[0].setAttribute("width", String(Math.max(dw, widths[0] + d)));
        const handle = shapes[shapes.length - 1];
        handle.setAttribute("x", String(Number(shapes[0].getAttribute("x")) + Math.max(dw, widths[0] + d) - 5));
      }
    };
    const onUp = (ev: PointerEvent) => {
      previewEl.removeEventListener("pointermove", onMove);
      previewEl.removeEventListener("pointerup", onUp);
      capture(previewEl, ev.pointerId, false);
      if (!dragging) return select(row);
      const delta = daysOf(ev);
      bar.removeAttribute("transform");
      if (!delta) return changed();
      const { items, error } = plan();
      const t = taskAt(items, row);
      if (!t) {
        hint(error || "このタスクは動かせません。");
        return changed();
      }
      const r = model.rows[row];
      if (resize) {
        const end = Math.max(t.start, t.end + delta);
        if (r.days && !r.end) r.days = String(calendarOf(model).count(t.start, end));
        else {
          r.end = formatDate(end);
          if (r.days) r.days = String(calendarOf(model).count(t.start, end));
        }
      } else {
        r.start = formatDate(t.start + delta);
        if (r.end) r.end = formatDate(t.end + delta);
      }
      selected = row;
      rebuild();
    };
    previewEl.addEventListener("pointermove", onMove);
    previewEl.addEventListener("pointerup", onUp);
  }

  // ---------- DiagramForm ----------

  return {
    title: "ガントチャート",
    formats: [{ value: "gantt", label: "```gantt（表から描くガントチャート）" }],
    accepts: (lang) => lang === "gantt",
    load(body) {
      if (body == null) {
        const today = formatDate(todayDay());
        model = {
          title: "",
          holidays: [],
          view: "day",
          groupBy: "group",
          rows: [
            { ...blankRow(), group: true, name: "準備" },
            { ...blankRow(), name: "タスク 1", start: today, days: "3" },
            { ...blankRow(), name: "タスク 2", days: "2" },
            { ...blankRow(), name: "完了", days: "0" },
          ],
        };
      } else {
        model = parseGantt(body);
        // 行番号は書き直すとずれるので持たない（誤りはプレビューと右のパネルで知らせる）
        delete model.holidaysLine;
        for (const r of model.rows) delete r.line;
      }
      selected = -1;
      history = [];
      at = -1;
      commit();
    },
    mount(parts, onChange) {
      if (formEl !== parts.form) parts.form.addEventListener("keydown", onFormKey);
      formEl = parts.form;
      selectEl = parts.side;
      barEl = parts.bar;
      if (previewEl !== parts.preview) {
        previewEl = parts.preview;
        previewEl.addEventListener("pointerdown", (e) => {
          // C4 のフォームと同じ要素を使うので、ガントチャートを開いているときだけ受け持つ
          if (formEl.querySelector(".g-table")) onPreviewPointerDown(e);
        });
      }
      changed = onChange;
      renderAll();
    },
    setFormat() {},
    code: () => writeGantt(model),
    afterRender() {
      markPreview();
    },
  };
}
