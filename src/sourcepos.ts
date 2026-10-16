// プレビューでクリックした文字から、ソースの位置（行・列）を探す。
// プレビューの文字列はソースから記号（**、` など）を除いたものなので、クリックしたテキストノードの文字列を
// そのままソースから探す。同じ文字列が何度も出るときは、プレビューで何番目かを数えて同じ番目を選ぶ

export interface SourcePos {
  /** 0 始まりの行 */
  line: number;
  /** 0 始まりの列 */
  ch: number;
}

/** s の中に word が（重ならずに）いくつあるか */
function countOf(s: string, word: string): number {
  let n = 0;
  for (let i = s.indexOf(word); i !== -1; i = s.indexOf(word, i + word.length)) n++;
  return n;
}

/**
 * lines の from 行〜to 行（to は含まない）の中から、クリックした位置を探す。
 * text はクリックしたテキストノードの文字列、offset はその中のクリック位置。
 * before は同じブロックで text より前にあるプレビューの文字列（何番目の一致かを数えるため）。
 * 見つからなければ null
 */
export function findSourcePos(
  lines: string[],
  from: number,
  to: number,
  text: string,
  offset: number,
  before: string,
): SourcePos | null {
  // テキストノードの改行はソースの改行（段落内の改行）に当たる。行ごとに字下げなどが違うので、クリックした行の部分だけを探す
  const parts = text.split("\n");
  let i = 0;
  let off = offset;
  while (i < parts.length - 1 && off > parts[i].length) {
    off -= parts[i].length + 1;
    i++;
  }
  const seg = parts[i];
  if (!seg.trim()) return null;
  const k = countOf(before + parts.slice(0, i).map((p) => `${p}\n`).join(""), seg);

  const block = lines.slice(from, to).join("\n");
  let found = -1;
  for (let n = 0, at = block.indexOf(seg); at !== -1; n++, at = block.indexOf(seg, at + seg.length)) {
    found = at;
    if (n === k) break;
  }
  if (found === -1) return null;

  const head = block.slice(0, found + off).split("\n");
  return { line: from + head.length - 1, ch: head[head.length - 1].length };
}
