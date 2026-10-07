import type * as Y from "yjs";

/**
 * Y.Text の内容を text にする。先頭と末尾の一致する部分は残し、違う部分だけを消して入れ直す
 * （全体を差し替えると、ほかの人がその間に書いた分やカーソルの位置が失われるため）
 */
export function applyText(ytext: Y.Text, text: string, origin?: unknown) {
  const old = ytext.toString();
  if (old === text) return;
  let start = 0;
  const max = Math.min(old.length, text.length);
  while (start < max && old.charCodeAt(start) === text.charCodeAt(start)) start++;
  let end = 0;
  while (end < max - start && old.charCodeAt(old.length - 1 - end) === text.charCodeAt(text.length - 1 - end)) end++;
  // サロゲートペアの途中で切らない
  if (start > 0 && isHighSurrogate(old.charCodeAt(start - 1))) start--;
  if (end > 0 && isLowSurrogate(old.charCodeAt(old.length - end))) end--;
  ytext.doc!.transact(() => {
    const removed = old.length - start - end;
    if (removed > 0) ytext.delete(start, removed);
    const inserted = text.slice(start, text.length - end);
    if (inserted) ytext.insert(start, inserted);
  }, origin);
}

const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** Uint8Array ⇔ base64（プロトコル②はバイナリを base64 で運ぶ） */
export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
