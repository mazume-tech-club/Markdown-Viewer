import "github-markdown-css/github-markdown.css";
import markdownLight from "github-markdown-css/github-markdown-light.css?inline";
import hljsLight from "highlight.js/styles/github.css?inline";
import hljsDark from "highlight.js/styles/github-dark.css?inline";
import { getCurrentWindow } from "@tauri-apps/api/window";

// ハイライトのテーマは OS のライト/ダークに合わせて切り替える。印刷（PDF）は常にライト
for (const [css, media] of [
  [hljsLight, "print, (prefers-color-scheme: light)"],
  [hljsDark, "screen and (prefers-color-scheme: dark)"],
  [markdownLight, "print"],
]) {
  const style = document.createElement("style");
  style.media = media;
  style.textContent = css;
  document.head.append(style);
}

export const darkQuery = matchMedia("(prefers-color-scheme: dark)");

// ---------- テーマの選択（自動 / ライト / ダーク） ----------
// ウィンドウのテーマを変えると WebView2 の prefers-color-scheme も切り替わるので、
// CSS のメディアクエリと darkQuery の change イベントがそのまま使える

export type ThemePref = "system" | "light" | "dark";
export const THEME_LABEL: Record<ThemePref, string> = { system: "自動", light: "ライト", dark: "ダーク" };

export function getThemePref(): ThemePref {
  const v = localStorage.getItem("theme");
  return v === "light" || v === "dark" ? v : "system";
}

export async function applyTheme(pref: ThemePref = getThemePref()) {
  await getCurrentWindow().setTheme(pref === "system" ? null : pref);
}

export async function setThemePref(pref: ThemePref) {
  localStorage.setItem("theme", pref);
  await applyTheme(pref);
}

// 別ウィンドウ（メイン⇔ヘルプ）で変更されたら追従する
window.addEventListener("storage", (e) => {
  if (e.key === "theme") void applyTheme();
});
void applyTheme();
