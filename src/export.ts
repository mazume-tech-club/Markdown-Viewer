// ---------- エクスポート ----------
// タブの今の内容と、参照するローカルの画像を 1 つのフォルダにまとめる:
//
//   <名前>/<名前>.md
//   <名前>/<名前>.assets/<画像>
//
// 画像は MD の外や絶対パスにあるものも含めて .assets の直下に集め、本文のリンクと注釈の "src" をそこへ書き換える。
// ネット上の画像と、見つからなかった画像のリンクはそのまま残す

import { commentSafe } from "./annotations";
import { basename, hasScheme, mdLink, safeDecode } from "./paths";
import type { ImageRef } from "./render";

/** ローカルのファイルを指すリンクか（http などの URL・data URI・// で始まるもの・ページ内リンクは除く） */
export const isLocalLink = (link: string) =>
  !!link && !hasScheme(link) && !link.startsWith("//") && !link.startsWith("#");

/** リンクをファイルのパスにする（%xx を戻し、? と # 以降を外す） */
export const linkToFile = (link: string) => safeDecode(link.split(/[?#]/)[0]);

export interface ExportImage {
  /** リンクをファイルのパスにしたもの（MD からの相対パスか絶対パス） */
  file: string;
  /** .assets の中での名前 */
  name: string;
}

/**
 * エクスポートする画像を決める。リンク → 画像 の対応を返す。
 * key が同じ画像（同じファイルを別の書き方で参照したものなど）は 1 つにまとめ、名前がぶつかれば -2, -3 … を付ける
 */
export function planImages(refs: ImageRef[], key: (file: string) => string): Map<string, ExportImage> {
  const nameOfKey = new Map<string, string>();
  const used = new Set<string>();
  const plan = new Map<string, ExportImage>();
  for (const { link } of refs) {
    if (plan.has(link) || !isLocalLink(link)) continue;
    const file = linkToFile(link);
    if (!basename(file)) continue;
    const k = key(file);
    let name = nameOfKey.get(k);
    if (!name) {
      name = uniqueName(basename(file), used);
      used.add(name.toLowerCase());
      nameOfKey.set(k, name);
    }
    plan.set(link, { file, name });
  }
  return plan;
}

/** used（小文字）にない名前にする（a.png → a-2.png → a-3.png …） */
function uniqueName(name: string, used: Set<string>): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let next = name;
  for (let i = 2; used.has(next.toLowerCase()); i++) next = `${stem}-${i}${ext}`;
  return next;
}

/** 本文の画像の参照を書き換える。to はリンク → 新しい相対パス。to にないリンクはそのまま */
export function rewriteImageLinks(text: string, refs: ImageRef[], to: Map<string, string>): string {
  let out = "";
  let pos = 0;
  for (const r of refs) {
    const next = to.get(r.link);
    if (next === undefined) continue;
    out += text.slice(pos, r.start) + (r.kind === "image" ? mdLink(next) : commentSafe(JSON.stringify(mdLink(next))));
    pos = r.end;
  }
  return out + text.slice(pos);
}
