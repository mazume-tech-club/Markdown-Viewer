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

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdown|mkd)$/i.test(path);
}
