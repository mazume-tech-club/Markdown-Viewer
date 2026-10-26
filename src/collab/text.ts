import type * as Y from "yjs";
import { changedRange } from "../textdiff";

/**
 * Y.Text の内容を text にする。先頭と末尾の一致する部分は残し、違う部分だけを消して入れ直す
 * （全体を差し替えると、ほかの人がその間に書いた分やカーソルの位置が失われるため）
 */
export function applyText(ytext: Y.Text, text: string, origin?: unknown) {
  const r = changedRange(ytext.toString(), text);
  if (!r) return;
  ytext.doc!.transact(() => {
    if (r.oldEnd > r.start) ytext.delete(r.start, r.oldEnd - r.start);
    const inserted = text.slice(r.start, r.newEnd);
    if (inserted) ytext.insert(r.start, inserted);
  }, origin);
}

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
