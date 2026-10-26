// ---------- ガントチャート（```gantt） ----------
// タスクを 1 行ずつ Markdown の表に書き、日付の横棒で予定を描く（オプション機能「ガントチャート」）。
// 表の上に「キー: 値」の設定行（タイトル・休日・表示）を置く。mermaid の gantt とは別物（docs/adr/0005）
//
//   タイトル: 新システム導入
//   休日: 2026-11-03, 2026-12-29〜2027-01-03
//   表示: 週
//
//   | タスク   | 開始       | 終了       | 日数 | 担当 | 進捗 |
//   |----------|------------|------------|------|------|------|
//   | # 設計   |            |            |      |      |      |      ← 先頭が # の行はグループ
//   | 要件定義 | 2026-11-02 |            | 5    | 土屋 | 100% |
//   | 基本設計 |            | 2026-11-20 |      | 佐藤 | 40%  |      ← 開始が空なら前のタスクの翌営業日から
//   | レビュー | 2026-11-24 |            | 0    |      |      |      ← 日数 0 はマイルストーン
//
// 日数は営業日（土日と休日を除く）で数える。終了日と日数が合わなければ終了日を使い、警告を出す。
// parseGantt は書き方（行の形）だけを読み、日付や数の誤りは scheduleGantt が知らせる
// （図のビルダーで、値の誤りがあっても読み込んで直せるように）

export type GanttView = "day" | "week" | "month";

export interface GanttRow {
  /** グループ（続くタスクをまとめる見出し）の行か */
  group: boolean;
  name: string;
  /** 以下は書かれたままの文字（空なら ""） */
  start: string;
  end: string;
  days: string;
  owner: string;
  progress: string;
  note: string;
  /** 1 始まりの行番号（誤りの知らせ用。図のビルダーで作った行には無い） */
  line?: number;
}

export interface GanttModel {
  title: string;
  /** 休日の日付と期間（「2026-12-29〜2027-01-03」）。書かれたままの文字 */
  holidays: string[];
  view: GanttView;
  rows: GanttRow[];
  /** 休日の設定行の行番号（誤りの知らせ用） */
  holidaysLine?: number;
}

export type GanttItem =
  | { type: "group"; name: string; /** rows の位置 */ row: number; /** グループの通し番号 */ index: number }
  | {
      type: "task";
      name: string;
      row: number;
      /** 入っているグループの通し番号（グループより前なら -1） */
      group: number;
      /** 日付は 1970-01-01 からの日数 */
      start: number;
      end: number;
      milestone: boolean;
      progress: number | null;
      owner: string;
      note: string;
      /** 描けるが気をつけてほしいこと（空なら無し） */
      warning: string;
    };

export interface GanttPlan {
  title: string;
  view: GanttView;
  items: GanttItem[];
  /** 土日以外の休日（1970-01-01 からの日数） */
  holidays: Set<number>;
  /** タスクの最初の日と最後の日 */
  from: number;
  to: number;
}

// ---------- 日付 ----------

const DAY_MS = 86_400_000;

/** 2026-11-02 / 2026/11/2 → 1970-01-01 からの日数。読めなければ null */
export function parseDate(s: string): number | null {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return t / DAY_MS;
}

export function formatDate(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** 曜日（0 が日曜）。1970-01-01 は木曜 */
export const weekday = (day: number) => (((day + 4) % 7) + 7) % 7;

export const isWeekend = (day: number) => weekday(day) === 0 || weekday(day) === 6;

/** 休日の期間の区切り */
const RANGE = /\s*[〜~～]\s*/;

// ---------- 読み取り ----------

/** 見出しの文字 → 列の役割 */
const HEADERS = {
  name: ["タスク", "タスク名", "task", "name"],
  start: ["開始", "開始日", "start"],
  end: ["終了", "終了日", "end"],
  days: ["日数", "期間", "days", "duration"],
  owner: ["担当", "担当者", "owner", "assignee"],
  progress: ["進捗", "進捗率", "progress"],
  note: ["メモ", "備考", "note", "memo"],
} as const;
export type GanttColumn = keyof typeof HEADERS;
type Column = GanttColumn;

/** 表の見出しの文字の列の役割（Excel から見出しごと貼り付けたときにも使う）。知らない見出しなら undefined */
export function columnOf(header: string): GanttColumn | undefined {
  const h = header.trim().toLowerCase();
  return (Object.keys(HEADERS) as Column[]).find((col) => (HEADERS[col] as readonly string[]).includes(h));
}

const SETTINGS: Record<string, "title" | "holidays" | "view"> = {
  タイトル: "title",
  title: "title",
  休日: "holidays",
  holidays: "holidays",
  holiday: "holidays",
  表示: "view",
  view: "view",
};

const VIEWS: Record<string, GanttView> = { 日: "day", day: "day", 週: "week", week: "week", 月: "month", month: "month" };
const VIEW_NAMES: Record<GanttView, string> = { day: "日", week: "週", month: "月" };

/** 表の行をセルに分ける（前後の | を外す。\| はセルの中の | として扱う） */
function cells(row: string): string[] {
  const s = row.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

const SEPARATOR = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/;

export function parseGantt(src: string): GanttModel {
  const model: GanttModel = { title: "", holidays: [], view: "day", rows: [] };
  let cols: Partial<Record<Column, number>> | null = null;
  let expectSeparator = false;

  src.split(/\r?\n/).forEach((raw, i) => {
    const n = i + 1;
    const line = raw.trim();
    if (!line) return;
    if (line.startsWith("|")) {
      if (!cols) {
        const found: Partial<Record<Column, number>> = {};
        cells(line).forEach((c, idx) => {
          const col = columnOf(c);
          if (col && found[col] === undefined) found[col] = idx;
        });
        if (found.name === undefined) throw new Error(`${n} 行目: 表の見出しに「タスク」の列がありません`);
        cols = found;
        expectSeparator = true;
        return;
      }
      if (expectSeparator) {
        if (!SEPARATOR.test(line)) throw new Error(`${n} 行目: 表の見出しの次は |---|---| の区切りの行にしてください`);
        expectSeparator = false;
        return;
      }
      const c = cells(line);
      const at = (col: Column) => (cols![col] === undefined ? "" : (c[cols![col]!] ?? ""));
      const name = at("name");
      const rest = (["start", "end", "days", "owner", "progress", "note"] as const).map(at);
      if (!name && rest.every((v) => !v)) return; // 空の行
      if (!name) throw new Error(`${n} 行目: タスク名が空です`);
      const group = name.startsWith("#");
      const [start, end, days, owner, progress, note] = group ? ["", "", "", "", "", ""] : rest;
      model.rows.push({ group, name: group ? name.replace(/^#+\s*/, "") : name, start, end, days, owner, progress, note, line: n });
      return;
    }
    const setting = /^([^:：]+?)\s*[:：]\s*(.*)$/.exec(line);
    if (!setting) throw new Error(`${n} 行目: 未対応の書き方です（「キー: 値」の設定か、表の行を書いてください）`);
    const key = SETTINGS[setting[1].toLowerCase()];
    const value = setting[2].trim();
    if (!key) throw new Error(`${n} 行目: 「${setting[1]}」は使えない設定です（タイトル・休日・表示が使えます）`);
    if (key === "title") model.title = value;
    else if (key === "view") {
      const v = VIEWS[value.toLowerCase()];
      if (!v) throw new Error(`${n} 行目: 表示は 日・週・月 のどれかにしてください`);
      model.view = v;
    } else {
      // 期間の 〜 の前後の空白を詰めてから、カンマか空白で分ける
      model.holidays.push(...value.replace(/\s*([〜~～])\s*/g, "$1").split(/[\s,、，]+/).filter(Boolean));
      model.holidaysLine = n;
    }
  });
  if (!model.rows.some((r) => !r.group)) throw new Error("タスクがありません（「| タスク | 開始 | 日数 |」の表に書いてください）");
  return model;
}

// ---------- 予定の計算 ----------

/** 土日以外の休日の集合。書き方に誤りがあれば知らせる */
function holidaySet(model: GanttModel): Set<number> {
  const holidays = new Set<number>();
  const at = model.holidaysLine ? `${model.holidaysLine} 行目: ` : "";
  for (const h of model.holidays) {
    const [a, b] = h.split(RANGE);
    const from = parseDate(a);
    const to = b === undefined ? from : parseDate(b);
    if (from === null || to === null) throw new Error(`${at}休日「${h}」は 2026-11-03 の形で書いてください（期間は 2026-12-29〜2027-01-03）`);
    for (let d = from; d <= to; d++) holidays.add(d);
  }
  return holidays;
}

/** 営業日（土日と休日を除いた日）の数え方 */
export interface Calendar {
  off(day: number): boolean;
  /** start の次の営業日 */
  next(day: number): number;
  /** start から数えて n 営業日目（start が休みなら次の営業日から数える） */
  add(start: number, n: number): number;
  /** start〜end（両端を含む）の営業日の数 */
  count(start: number, end: number): number;
}

function calendar(holidays: Set<number>): Calendar {
  const off = (d: number) => isWeekend(d) || holidays.has(d);
  const next = (d: number) => {
    d++;
    while (off(d)) d++;
    return d;
  };
  return {
    off,
    next,
    add(start, n) {
      let d = start;
      while (off(d)) d++;
      for (let k = 1; k < n; k++) d = next(d);
      return d;
    },
    count(start, end) {
      let c = 0;
      for (let d = start; d <= end; d++) if (!off(d)) c++;
      return c;
    },
  };
}

/** 図のビルダーでドラッグしたときの日数の数え方。休日の書き方に誤りがあれば土日だけを休みにする */
export function calendarOf(model: GanttModel): Calendar {
  try {
    return calendar(holidaySet(model));
  } catch {
    return calendar(new Set());
  }
}

export function scheduleGantt(model: GanttModel): GanttPlan {
  const holidays = holidaySet(model);
  const cal = calendar(holidays);

  const items: GanttItem[] = [];
  let group = -1;
  let prevEnd: number | null = null;
  model.rows.forEach((r, row) => {
    // 名前の無い行（図のビルダーで足したばかりの行）は書き出さないので、予定にも入れない
    if (!isWrittenRow(r)) return;
    if (r.group) {
      items.push({ type: "group", name: r.name, row, index: ++group });
      return;
    }
    const at = r.line ? `${r.line} 行目: ` : `「${r.name}」: `;
    const date = (s: string, what: string) => {
      const d = parseDate(s);
      if (d === null) throw new Error(`${at}${what}「${s}」は 2026-11-02 の形で書いてください`);
      return d;
    };
    let start: number;
    if (r.start) start = date(r.start, "開始日");
    else if (prevEnd === null) throw new Error(`${at}最初のタスクには開始日を書いてください`);
    else start = cal.next(prevEnd);
    let days: number | null = null;
    if (r.days) {
      const m = /^(\d+)\s*日?$/.exec(r.days);
      if (!m) throw new Error(`${at}日数は 0 以上の整数で書いてください`);
      days = Number(m[1]);
    }
    let end: number;
    let milestone = false;
    let warning = "";
    if (r.end) {
      end = date(r.end, "終了日");
      if (end < start) throw new Error(`${at}終了日が開始日より前です`);
      if (days === 0 && end === start) milestone = true;
      else if (days !== null && cal.count(start, end) !== days) warning = `日数（${days}）と終了日が合いません。終了日を使います`;
    } else if (days === 0) {
      end = start;
      milestone = true;
    } else if (days !== null) end = cal.add(start, days);
    else throw new Error(`${at}終了日か日数を書いてください`);

    let progress: number | null = null;
    if (r.progress) {
      const m = /^(\d+(?:\.\d+)?)\s*[%％]?$/.exec(r.progress);
      if (!m || Number(m[1]) > 100) throw new Error(`${at}進捗は 0〜100% で書いてください`);
      progress = Number(m[1]);
    }
    items.push({ type: "task", name: r.name, row, group, start, end, milestone, progress, owner: r.owner, note: r.note, warning });
    prevEnd = end;
  });

  const tasks = items.filter((i) => i.type === "task");
  return {
    title: model.title,
    view: model.view,
    items,
    holidays,
    from: Math.min(...tasks.map((t) => t.start)),
    to: Math.max(...tasks.map((t) => t.end)),
  };
}

// ---------- 書き出し ----------

/** 書き出す行か（名前の無い行は書き出さない） */
export const isWrittenRow = (r: GanttRow) => r.name.trim() !== "";

/** 読める日付なら 2026-11-02 の形にそろえる */
const normDate = (s: string) => {
  const d = parseDate(s);
  return d === null ? s.trim() : formatDate(d);
};
const normHoliday = (s: string) => s.split(RANGE).map(normDate).join("〜");
const normDays = (s: string) => s.trim().replace(/^(\d+)\s*日$/, "$1");
const normProgress = (s: string) => s.trim().replace(/^(\d+(?:\.\d+)?)\s*[%％]?$/, "$1%");

/** 表示の幅（全角は 2） */
const width = (s: string) => [...s].reduce((w, ch) => w + (/[\u0000-ÿ｡-ﾟ]/.test(ch) ? 1 : 2), 0);
const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - width(s)));

/** 図のビルダーで置き換えるときの書き方。列幅をそろえた表にし、日付は 2026-11-02 の形にする */
export function writeGantt(model: GanttModel): string {
  const out: string[] = [];
  if (model.title.trim()) out.push(`タイトル: ${model.title.trim()}`);
  const holidays = model.holidays.map((h) => h.trim()).filter(Boolean);
  if (holidays.length) out.push(`休日: ${holidays.map(normHoliday).join(", ")}`);
  if (model.view !== "day") out.push(`表示: ${VIEW_NAMES[model.view]}`);
  if (out.length) out.push("");

  const withNote = model.rows.some((r) => !r.group && r.note.trim());
  const head = ["タスク", "開始", "終了", "日数", "担当", "進捗", ...(withNote ? ["メモ"] : [])];
  const esc = (s: string) => s.trim().replace(/\|/g, "\\|");
  const rows = model.rows
    .filter(isWrittenRow)
    .map((r) => {
      if (r.group) return [esc(`# ${r.name.trim()}`), "", "", "", "", "", ...(withNote ? [""] : [])];
      return [
        esc(r.name),
        esc(normDate(r.start)),
        esc(normDate(r.end)),
        esc(normDays(r.days)),
        esc(r.owner),
        esc(normProgress(r.progress)),
        ...(withNote ? [esc(r.note)] : []),
      ];
    });
  const widths = head.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i]))));
  const line = (cs: string[]) => `| ${cs.map((c, i) => pad(c, widths[i])).join(" | ")} |`;
  out.push(line(head), `|${widths.map((w) => "-".repeat(w + 2)).join("|")}|`, ...rows.map(line));
  return out.join("\n") + "\n";
}

// ---------- Mermaid への変換 ----------
// GitHub など、このアプリ以外でも見せたいときのための Mermaid の gantt。日付はこのアプリで計算したものを書く
// （Mermaid の営業日の数え方に任せるとずれるため）。担当はタスク名の後ろに付け、進捗は 100% を done、
// 途中を active にする（％は書けない）。メモは書かない

/** Mermaid の gantt で記号として読まれる文字を全角にする */
const mermaidText = (s: string) => s.replace(/:/g, "：").replace(/;/g, "；").replace(/#/g, "＃").trim();

const MERMAID_AXIS: Record<GanttView, string[]> = {
  day: ["axisFormat %m/%d"],
  week: ["axisFormat %m/%d", "tickInterval 1week"],
  month: ["axisFormat %Y/%m", "tickInterval 1month"],
};

export function ganttToMermaid(model: GanttModel): string {
  const plan = scheduleGantt(model);
  const out = ["gantt"];
  if (plan.title.trim()) out.push(`  title ${mermaidText(plan.title)}`);
  out.push("  dateFormat YYYY-MM-DD", ...MERMAID_AXIS[plan.view].map((l) => `  ${l}`));
  out.push(`  excludes ${["weekends", ...[...plan.holidays].sort((a, b) => a - b).map(formatDate)].join(", ")}`);
  let n = 0;
  for (const it of plan.items) {
    if (it.type === "group") {
      out.push(`  section ${mermaidText(it.name)}`);
      continue;
    }
    const name = mermaidText(it.owner ? `${it.name}（${it.owner}）` : it.name);
    const tag = it.milestone ? "milestone, " : it.progress === 100 ? "done, " : it.progress ? "active, " : "";
    // Mermaid の終了日はその日を含まないので、1 日後を書く
    const span = it.milestone ? `${formatDate(it.start)}, 0d` : `${formatDate(it.start)}, ${formatDate(it.end + 1)}`;
    out.push(`  ${name} :${tag}t${++n}, ${span}`);
  }
  return out.join("\n") + "\n";
}
