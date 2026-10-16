// ---------- 編集位置のハイライト（編集 → プレビュー切替時） ----------
// 設定はメインウィンドウの設定画面で変更する

const ENABLED_KEY = "activeLine.enabled";
export const ACTIVE_LINE_COLOR_KEY = "activeLine.color";
export const DEFAULT_ACTIVE_LINE_COLOR = "#ffd33d";

export const isActiveLineEnabled = () => localStorage.getItem(ENABLED_KEY) !== "0";
export const setActiveLineEnabled = (on: boolean) => localStorage.setItem(ENABLED_KEY, on ? "1" : "0");

// 分割表示で、プレビューをエディタのカーソルの位置（同じ高さ）に合わせる
const FOLLOW_KEY = "followCursor";
export const isFollowCursorEnabled = () => localStorage.getItem(FOLLOW_KEY) !== "0";
export const setFollowCursorEnabled = (on: boolean) => localStorage.setItem(FOLLOW_KEY, on ? "1" : "0");

// 選択したら自動でコピー・右クリックで貼り付け（Tera Term と同じ操作）
const SELECT_COPY_KEY = "selectCopy";
export const isSelectCopyEnabled = () => localStorage.getItem(SELECT_COPY_KEY) !== "0";
export const setSelectCopyEnabled = (on: boolean) => localStorage.setItem(SELECT_COPY_KEY, on ? "1" : "0");

export const getActiveLineColor = () => localStorage.getItem(ACTIVE_LINE_COLOR_KEY) || DEFAULT_ACTIVE_LINE_COLOR;

export function setActiveLineColor(color: string | null) {
  if (color) localStorage.setItem(ACTIVE_LINE_COLOR_KEY, color);
  else localStorage.removeItem(ACTIVE_LINE_COLOR_KEY);
}

/** CSS 変数 --active-line に現在の色を反映する */
export function applyActiveLineColor() {
  document.documentElement.style.setProperty("--active-line", getActiveLineColor());
}
