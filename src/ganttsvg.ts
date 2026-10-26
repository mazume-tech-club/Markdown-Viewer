// ---------- ガントチャートの SVG ----------
// scheduleGantt で日付を決めた計画を、左にタスク名、右に日付の横棒を並べた SVG にする。
// 図のビルダーで横棒をドラッグできるよう、横棒に data-row（表の行）、svg に 1 日の幅と最初の日を持たせる

import { FONT, html, textWidth } from "./dotutil";
import { formatDate, parseDate, weekday, type GanttPlan, type GanttView } from "./gantt";

/** 1 日の幅（px） */
export const DAY_WIDTH: Record<GanttView, number> = { day: 24, week: 10, month: 4 };

const ROW_H = 26;
const BAR_H = 14;
const HEAD_H = 40;
const PAD = 12;
const SIZE = 12;

interface Palette {
  text: string;
  muted: string;
  line: string;
  grid: string;
  off: string;
  band: string;
  today: string;
  warn: string;
  summary: string;
  bars: string[];
}

const LIGHT: Palette = {
  text: "#1c2328",
  muted: "#5d6974",
  line: "#c3cbd2",
  grid: "#e6eaed",
  off: "#f1f3f5",
  band: "#f4f6f7",
  today: "#d03b2f",
  warn: "#a8402c",
  summary: "#3b444c",
  bars: ["#0a6c78", "#3367c4", "#c46a1b", "#7a4fb5", "#3d8b37", "#b8433a", "#8a6d3b", "#5d6974"],
};

const DARK: Palette = {
  text: "#e6edf3",
  muted: "#9aa7b2",
  line: "#4a535c",
  grid: "#2c333a",
  off: "#21272d",
  band: "#1d2329",
  today: "#ff6b5e",
  warn: "#ff8a70",
  summary: "#c9d1d9",
  bars: ["#3fb5c2", "#6f9cf0", "#e8954a", "#a98ae0", "#6cc463", "#e0726a", "#c4a26a", "#9aa7b2"],
};

/** 描く範囲の最初の日。週は月曜、月は 1 日から始める */
function firstDay(from: number, view: GanttView): number {
  if (view === "day") return from - 1;
  if (view === "week") return from - ((weekday(from) + 6) % 7);
  const d = formatDate(from);
  return parseDate(`${d.slice(0, 7)}-01`)!;
}

const ymd = (day: number) => formatDate(day).split("-").map(Number);

export function ganttToSvg(plan: GanttPlan, opts: { dark: boolean; today: number }): string {
  const c = opts.dark ? DARK : LIGHT;
  const dw = DAY_WIDTH[plan.view];
  const titleH = plan.title ? 28 : 0;
  const tasks = plan.items.filter((i) => i.type === "task");
  const indent = plan.items.some((i) => i.type === "group") ? 14 : 0;

  // 左のタスク名の欄の幅
  const nameW = Math.min(
    320,
    Math.max(
      110,
      ...plan.items.map((i) =>
        i.type === "group" ? textWidth(i.name, SIZE) * 1.08 : textWidth(i.name, SIZE) + (i.group >= 0 ? indent : 0) + (i.warning ? 16 : 0),
      ),
    ) + PAD * 2,
  );
  const origin = firstDay(plan.from, plan.view);
  const left = nameW;
  const x = (day: number) => left + (day - origin) * dw;
  /** 横棒の右に出す文字（担当と進捗） */
  const sideText = (t: (typeof tasks)[number]) => [t.owner, t.progress !== null ? `${t.progress}%` : ""].filter(Boolean).join("  ");
  // 右端: 最後の日と、横棒の右の文字が収まるところまで（月・週の区切りまで伸ばす）
  let right = Math.max(...tasks.map((t) => x(t.end + 1) + 8 + textWidth(sideText(t), SIZE - 1)));
  let last = origin + Math.ceil((right - left) / dw);
  if (plan.view === "day") last += 1;
  if (plan.view === "week") last += (7 - ((last - origin) % 7)) % 7;
  if (plan.view === "month") {
    const [y, m] = ymd(last);
    last = parseDate(`${m === 12 ? y + 1 : y}-${String((m % 12) + 1).padStart(2, "0")}-01`)!;
  }
  right = x(last);
  const top = titleH + HEAD_H;
  const height = top + plan.items.length * ROW_H + PAD;
  const width = right + PAD;

  const out: string[] = [];
  const text = (tx: number, ty: number, s: string, attrs = "") =>
    `<text x="${tx}" y="${ty}" font-size="${SIZE}" fill="${c.text}"${attrs ? ` ${attrs}` : ""}>${html(s)}</text>`;

  // 休み（土日と休日）の網掛けと、区切りの縦線
  const bodyTop = top;
  const bodyH = plan.items.length * ROW_H;
  for (let d = origin; d < last; d++) {
    const off = weekday(d) === 0 || weekday(d) === 6 || plan.holidays.has(d);
    if (off && plan.view !== "month") out.push(`<rect x="${x(d)}" y="${titleH + 20}" width="${dw}" height="${HEAD_H - 20 + bodyH}" fill="${c.off}"/>`);
    else if (off && plan.holidays.has(d)) out.push(`<rect x="${x(d)}" y="${bodyTop}" width="${dw}" height="${bodyH}" fill="${c.off}"/>`);
  }
  // グループの帯
  plan.items.forEach((it, i) => {
    if (it.type === "group") out.push(`<rect x="0" y="${top + i * ROW_H}" width="${width}" height="${ROW_H}" fill="${c.band}" opacity="0.8"/>`);
  });

  // 目盛り: 上の段（月・年）と下の段（日・週・月）
  const upper: { day: number; label: string }[] = [];
  const lower: { day: number; label: string; off?: boolean }[] = [];
  for (let d = origin; d < last; d++) {
    const [y, m, dd] = ymd(d);
    if (plan.view === "month") {
      if (dd === 1) {
        lower.push({ day: d, label: `${m}月` });
        if (m === 1 || d === origin) upper.push({ day: d, label: `${y}年` });
      }
      continue;
    }
    if (dd === 1 || d === origin) upper.push({ day: d, label: `${y}年${m}月` });
    if (plan.view === "day") lower.push({ day: d, label: String(dd), off: weekday(d) === 0 || weekday(d) === 6 || plan.holidays.has(d) });
    else if (weekday(d) === 1) lower.push({ day: d, label: `${m}/${dd}` });
  }
  const unit = plan.view === "day" ? 1 : plan.view === "week" ? 7 : 0;
  for (const t of lower) {
    out.push(`<line x1="${x(t.day)}" y1="${titleH + 20}" x2="${x(t.day)}" y2="${top + bodyH}" stroke="${c.grid}"/>`);
    const w = unit ? unit * dw : 0;
    const tx = plan.view === "day" ? x(t.day) + w / 2 : x(t.day) + 4;
    out.push(text(tx, titleH + 34, t.label, `${plan.view === "day" ? 'text-anchor="middle" ' : ""}font-size="${SIZE - 2}" fill="${t.off ? c.muted : c.text}"`));
  }
  for (const t of upper) {
    out.push(`<line x1="${x(t.day)}" y1="${titleH}" x2="${x(t.day)}" y2="${titleH + 20}" stroke="${c.line}"/>`);
    out.push(text(x(t.day) + 4, titleH + 15, t.label, `font-size="${SIZE - 1}" font-weight="bold"`));
  }
  out.push(`<line x1="${left}" y1="${titleH + 20}" x2="${right}" y2="${titleH + 20}" stroke="${c.line}"/>`);
  out.push(`<line x1="0" y1="${top}" x2="${right}" y2="${top}" stroke="${c.line}"/>`);
  out.push(`<line x1="${left}" y1="${titleH}" x2="${left}" y2="${top + bodyH}" stroke="${c.line}"/>`);

  // 行
  plan.items.forEach((it, i) => {
    const y = top + i * ROW_H;
    const mid = y + ROW_H / 2;
    if (it.type === "group") {
      out.push(text(PAD, mid + 4, it.name, 'font-weight="bold"'));
      const members = tasks.filter((t) => t.group === it.index);
      if (members.length) {
        const from = Math.min(...members.map((t) => t.start));
        const to = Math.max(...members.map((t) => t.end));
        out.push(`<rect x="${x(from)}" y="${mid - 3}" width="${x(to + 1) - x(from)}" height="6" fill="${c.summary}"/>`);
      }
      return;
    }
    const nx = PAD + (it.group >= 0 ? indent : 0);
    if (it.warning) {
      out.push(`<text x="${nx}" y="${mid + 4}" font-size="${SIZE}" fill="${c.warn}"><title>${html(it.warning)}</title>⚠</text>`);
    }
    out.push(text(nx + (it.warning ? 16 : 0), mid + 4, it.name));
    const color = c.bars[Math.max(0, it.group) % c.bars.length];
    const span = it.milestone ? formatDate(it.start) : `${formatDate(it.start)} 〜 ${formatDate(it.end)}`;
    const tip = [it.name, span, it.owner && `担当: ${it.owner}`, it.progress !== null && `進捗: ${it.progress}%`, it.note && `メモ: ${it.note}`, it.warning && `⚠ ${it.warning}`]
      .filter(Boolean)
      .join("\n");
    const x0 = x(it.start);
    let shape: string;
    let after: number;
    if (it.milestone) {
      const cx = x0 + dw / 2;
      const r = 7;
      shape = `<path class="gantt-handle-move" d="M${cx} ${mid - r}L${cx + r} ${mid}L${cx} ${mid + r}L${cx - r} ${mid}Z" fill="${color}"/>`;
      after = cx + r + 6;
    } else {
      const w = x(it.end + 1) - x0;
      const by = mid - BAR_H / 2;
      const done = it.progress === null ? 0 : (w * it.progress) / 100;
      shape =
        `<rect class="gantt-handle-move" x="${x0}" y="${by}" width="${w}" height="${BAR_H}" rx="3" fill="${color}" fill-opacity="0.3" stroke="${color}"/>` +
        (done ? `<rect x="${x0}" y="${by}" width="${done}" height="${BAR_H}" rx="3" fill="${color}" pointer-events="none"/>` : "") +
        `<rect class="gantt-handle-end" x="${x0 + w - 5}" y="${by}" width="6" height="${BAR_H}" fill="transparent"/>`;
      after = x0 + w + 6;
    }
    out.push(`<g class="gantt-bar" data-row="${it.row}"><title>${html(tip)}</title>${shape}</g>`);
    const side = sideText(it);
    if (side) out.push(text(after, mid + 4, side, `font-size="${SIZE - 1}" fill="${c.muted}"`));
  });

  // 今日の線
  if (opts.today >= origin && opts.today < last) {
    const tx = x(opts.today) + dw / 2;
    out.push(`<line x1="${tx}" y1="${titleH + 20}" x2="${tx}" y2="${top + bodyH}" stroke="${c.today}" stroke-width="1.5"/>`);
  }
  if (plan.title) out.push(text(PAD, 18, plan.title, `font-size="${SIZE + 3}" font-weight="bold"`));

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" class="gantt" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" ` +
    `data-left="${left}" data-origin="${origin}" data-day-width="${dw}">` +
    `<g font-family="${FONT}">${out.join("")}</g></svg>`
  );
}

/** 今日（手元の時計の日付）を 1970-01-01 からの日数で */
export function todayDay(): number {
  const now = new Date();
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86_400_000;
}
