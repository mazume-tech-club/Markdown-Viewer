// ---------- アプリが組み立てる DOT の共通部品（erd・flow・screen・マインドマップ） ----------

/** 書体は c4 と同じ */
export const FONT = "Yu Gothic UI,Meiryo,sans-serif";

/** 配色は手書き SVG・設計メモの文書スタイルと同じ */
export const COLOR = {
  surface: "#ffffff",
  ground: "#f4f6f7",
  text: "#1c2328",
  muted: "#5d6974",
  line: "#c3cbd2",
  accent: "#0a6c78",
  accentSoft: "#dceff1",
  warn: "#a8402c",
} as const;

/** DOT の HTML ラベルに入れる文字のエスケープ */
export const html = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * 文字列の幅（pt）の見積もり。Graphviz は日本語の文字幅を知らず半角の幅で見積もり、枠からはみ出すので、
 * 全角は文字の大きさ、半角はその 0.6 倍ほどとして足す（少し広めに見積もる）
 */
export function textWidth(text: string, size: number): number {
  return [...text].reduce((sum, ch) => sum + (/[\u0000-ÿ｡-ﾟ]/.test(ch) ? 0.62 : 1.05) * size, 0);
}
