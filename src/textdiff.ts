/**
 * old を next にするために置き換える範囲。先頭と末尾の一致する部分を除いた、old の [start, oldEnd) を
 * next の [start, newEnd) にすればよい。同じなら null。サロゲートペアの途中では切らない
 * （全体を差し替えると、共同編集でほかの人がその間に書いた分やカーソルの位置が失われるため、違う部分だけを入れ直す）
 */
export function changedRange(old: string, next: string): { start: number; oldEnd: number; newEnd: number } | null {
  if (old === next) return null;
  let start = 0;
  const max = Math.min(old.length, next.length);
  while (start < max && old.charCodeAt(start) === next.charCodeAt(start)) start++;
  let end = 0;
  while (end < max - start && old.charCodeAt(old.length - 1 - end) === next.charCodeAt(next.length - 1 - end)) end++;
  if (start > 0 && isHighSurrogate(old.charCodeAt(start - 1))) start--;
  if (end > 0 && isLowSurrogate(old.charCodeAt(old.length - end))) end--;
  return { start, oldEnd: old.length - end, newEnd: next.length - end };
}

/**
 * 開いたときの内容 base を、自分は next に、ほかの人は cur に変えたとき、cur に入れる自分の変更（cur の中の位置）。
 * 自分の変更とほかの人の変更が重ならなければ、ほかの人の変更を残したまま自分の変更だけを入れられる。
 * 重なるなら "conflict"、自分が何も変えていなければ null
 */
export function mergeChange(base: string, cur: string, next: string): { from: number; to: number; insert: string } | "conflict" | null {
  const mine = changedRange(base, next);
  if (!mine) return null;
  const insert = next.slice(mine.start, mine.newEnd);
  const theirs = changedRange(base, cur);
  // ほかの人の変更が無いか、自分の変更より後ろ: 位置はそのまま
  if (!theirs || mine.oldEnd <= theirs.start) return { from: mine.start, to: mine.oldEnd, insert };
  // ほかの人の変更が自分の変更より前: 増えた・減った文字の分だけずらす
  if (theirs.oldEnd <= mine.start) {
    const shift = cur.length - base.length;
    return { from: mine.start + shift, to: mine.oldEnd + shift, insert };
  }
  return "conflict";
}

const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;
