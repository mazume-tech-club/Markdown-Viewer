// 自作の色分けで使う小物。出力は highlight.js と同じ hljs-* のクラスにして、同じ配色テーマで色を付ける

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** text を hljs-<cls> の span で包む。cls が空なら包まない */
export const span = (cls: string, text: string) =>
  cls ? `<span class="${cls.split(" ").map((c, i) => (i ? c : `hljs-${c}`)).join(" ")}">${esc(text)}</span>` : esc(text);

/** pos が語の先頭か（行頭・空白・区切りの記号の直後）。# がコメントになるのはこのときだけ */
export const atWordStart = (src: string, pos: number) => pos === 0 || /[\s;|&(){}]/.test(src[pos - 1]);

/** 文字列を先頭から読み進めるための小さな読み手 */
export class Scanner {
  pos = 0;
  constructor(readonly src: string) {}

  get done() {
    return this.pos >= this.src.length;
  }
  peek(n = 0) {
    return this.src[this.pos + n] ?? "";
  }
  /** 今の位置で re（y フラグ付き）に一致したら、その文字列を返して進める */
  match(re: RegExp): string | null {
    re.lastIndex = this.pos;
    const m = re.exec(this.src);
    if (!m) return null;
    this.pos += m[0].length;
    return m[0];
  }
  /** end が見つかるまで（end を含めて）読む。見つからなければ最後まで */
  until(end: string): string {
    const i = this.src.indexOf(end, this.pos);
    const stop = i < 0 ? this.src.length : i + end.length;
    const s = this.src.slice(this.pos, stop);
    this.pos = stop;
    return s;
  }
  take(n = 1) {
    const s = this.src.slice(this.pos, this.pos + n);
    this.pos += s.length;
    return s;
  }
}
