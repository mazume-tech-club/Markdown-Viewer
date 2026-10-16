import "./docstyle.css";

// ---------- 文書スタイル（プレビューと PDF の文書の装い） ----------
// テーマ（明暗）とは別に選ぶ。:root の data-doc-style で docstyle.css の規則を効かせる。
// ヘルプウィンドウは読み込まないので、いつも GitHub のまま

export type DocStyle = "github" | "memo";
export const DOC_STYLES: [DocStyle, string][] = [
  ["github", "GitHub"],
  ["memo", "設計メモ"],
];

const KEY = "docStyle";

export function getDocStyle(): DocStyle {
  return localStorage.getItem(KEY) === "memo" ? "memo" : "github";
}

export function applyDocStyle(style: DocStyle = getDocStyle()) {
  if (style === "github") delete document.documentElement.dataset.docStyle;
  else document.documentElement.dataset.docStyle = style;
}

export function setDocStyle(style: DocStyle) {
  localStorage.setItem(KEY, style);
  applyDocStyle(style);
}

applyDocStyle();
