// Windows/POSIX どちらの区切りでも扱える最小限のパス操作

export function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i < 0 ? "" : path.slice(0, i);
}

export function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return path.slice(i + 1);
}

export function isAbsolute(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\") || path.startsWith("/");
}

/** base ディレクトリを基準に相対パスを解決し、. と .. を畳む */
export function resolvePath(base: string, rel: string): string {
  const full = isAbsolute(rel) && !rel.startsWith("/") ? rel : base + "\\" + rel;
  const parts: string[] = [];
  for (const seg of full.split(/[\\/]+/)) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  const unc = full.startsWith("\\\\") ? "\\\\" : "";
  return unc + parts.join("\\");
}

/** URL らしきもの（スキーム付き）か */
export function hasScheme(href: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href) && !/^[a-zA-Z]:[\\/]/.test(href);
}

/** Markdown のリンクに書くパス（空白と括弧があるとリンクが途切れるので %xx にする） */
export const mdLink = (rel: string) => rel.replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");

/** %xx を戻す（markdown-it は日本語や空白を %xx にする）。戻せなければそのまま */
export const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * 共同編集で参加者がホストに求めてよい画像のパスか。md のフォルダの中の画像（SVG を除く）だけ。
 * よければ . と .. を畳んだ / 区切りのパスを、だめなら null を返す（参加者にほかのファイルを読ませないため）
 */
export function requestableImage(path: string): string | null {
  if (!path || path.length > 1000 || /[\x00-\x1f]/.test(path)) return null;
  if (hasScheme(path) || isAbsolute(path) || path.startsWith("\\")) return null;
  const parts: string[] = [];
  for (const seg of path.split(/[\\/]+/)) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else if (seg.includes(":")) {
      return null;
    } else {
      parts.push(seg);
    }
  }
  const rel = parts.join("/");
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(rel) ? rel : null;
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdown|mkd)$/i.test(path);
}

/**
 * 入力・貼り付けされたパスを整える。前後の空白と引用符（エクスプローラーの「パスのコピー」が付ける）を外し、
 * / 区切りを \ にする
 */
export function normalizeInputPath(input: string): string {
  let s = input.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1).trim();
  return s.replace(/\//g, "\\");
}
