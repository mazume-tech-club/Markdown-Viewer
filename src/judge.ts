// ---------- 表の ○ / △ / ✕ の色付け（オプション機能 judgeColors） ----------
// セルの中身が判定の語「だけ」のときに色を付ける。文中の「なし」などには付けない

export type Judge = "good" | "mid" | "bad";

const WORDS: Record<Judge, string[]> = {
  good: ["○", "◯", "〇", "✓", "✔", "あり", "有", "OK", "可"],
  mid: ["△", "一部"],
  bad: ["✕", "×", "✗", "✘", "なし", "無", "NG", "不可"],
};

const LOOKUP = new Map<string, Judge>();
for (const [judge, words] of Object.entries(WORDS) as [Judge, string[]][]) {
  for (const w of words) LOOKUP.set(w.toUpperCase(), judge);
}

/** セルの文字が判定の語だけなら、その判定。前後の空白と大文字小文字（ok / Ok）は無視する */
export function judgeOf(text: string): Judge | null {
  return LOOKUP.get(text.trim().toUpperCase()) ?? null;
}

/** 表の本文のセル（見出し行は除く）に judge-good / judge-mid / judge-bad を付ける */
export function markJudgeCells(root: ParentNode) {
  for (const td of root.querySelectorAll<HTMLTableCellElement>("table td")) {
    const judge = judgeOf(td.textContent ?? "");
    if (judge) td.classList.add(`judge-${judge}`);
  }
}
