import { atWordStart, esc, Scanner, span } from "./util";

// ---------- PowerShell の色分け（自作） ----------
// highlight.js の定義は「-d」をパラメーター、「-f」を書式演算子と決め打ちで色付けするので、
// docker などの外部コマンドの行が不自然になる。ここでは PowerShell と同じく
// 「文の先頭の語はコマンド（docker も Get-ChildItem も同じ）」「コマンドの後ろの -x は引数」
// 「式の中の -eq や -f は演算子」と、文の中の位置で決める

const KEYWORDS = new Set(
  (
    "begin break catch class continue data default do dynamicparam else elseif end enum exit filter finally for " +
    "foreach function if in param process return switch throw trap try until using while workflow"
  ).split(" "),
);
/** 後ろにパイプライン（コマンド）が続くキーワード */
const PIPELINE_KEYWORDS = new Set(["return", "throw", "exit"]);
/** 後ろに関数名が続くキーワード */
const NAME_KEYWORDS = new Set(["function", "filter", "workflow", "class", "enum"]);
const OPERATORS = new Set(
  (
    "eq ne gt ge lt le like notlike match notmatch contains notcontains in notin replace split join " +
    "and or xor not band bor bxor bnot shl shr is isnot as f"
  ).split(" "),
);

/** -ceq / -ireplace のような大文字小文字の指定付きも演算子として扱う */
function isOperator(name: string) {
  return OPERATORS.has(name) || (/^[ci]/.test(name) && name.length > 2 && OPERATORS.has(name.slice(1)));
}

const VAR = /`[\s\S]|\$\{[^}]*\}|\$\([^)]*\)|\$(?:[A-Za-z]\w*:(?!:))?\w+/g;

/** ダブルクォートの文字列。中の変数（$name・${x}・$(...)）だけ変数の色にする */
function interpolated(text: string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(VAR)) {
    if (m[0][0] === "`") continue;
    out += esc(text.slice(last, m.index)) + span("variable", m[0]);
    last = m.index + m[0].length;
  }
  return `<span class="hljs-string">${out}${esc(text.slice(last))}</span>`;
}

type Ctx = "block" | "paren" | "hash";

export function highlightPowerShell(code: string): string {
  const s = new Scanner(code);
  let out = "";
  /** 文の先頭（次の語がコマンドになる位置） */
  let start = true;
  /** コマンドの引数を読んでいる（-x は引数、= は文字） */
  let cmd = false;
  /** ハッシュテーブル @{ } のキーの位置 */
  let key = false;
  let ctx: Ctx = "block";
  let expectName = false;
  const stack: { ctx: Ctx; cmd: boolean }[] = [];

  const open = (to: Ctx) => {
    stack.push({ ctx, cmd });
    ctx = to;
    start = true;
    cmd = false;
    key = to === "hash";
  };
  const close = () => {
    const prev = stack.pop();
    if (prev) ({ ctx, cmd } = prev);
    start = false;
    key = false;
  };
  const endStatement = () => {
    start = true;
    cmd = false;
    key = ctx === "hash";
  };
  /** 値（文字列・変数・数値など）を読んだあと */
  const value = (html: string) => {
    out += html;
    start = false;
    key = false;
  };

  while (!s.done) {
    let t: string | null;
    if ((t = s.match(/[ \t]+/y))) {
      out += t;
    } else if ((t = s.match(/\r?\n/y))) {
      out += t;
      endStatement();
    } else if (s.peek() === "<" && s.peek(1) === "#") {
      out += span("comment", s.until("#>"));
    } else if (atWordStart(code, s.pos) && (t = s.match(/#[^\r\n]*/y))) {
      out += span("comment", t);
    } else if ((t = s.match(/@"\r?\n[\s\S]*?(?:\r?\n"@|$(?![\s\S]))/y))) {
      value(interpolated(t));
    } else if ((t = s.match(/@'\r?\n[\s\S]*?(?:\r?\n'@|$(?![\s\S]))/y))) {
      value(span("string", t));
    } else if ((t = s.match(/"(?:[^"`]|`[\s\S]|"")*"?/y))) {
      value(interpolated(t));
    } else if ((t = s.match(/'(?:[^']|'')*'?/y))) {
      value(span("string", t));
    } else if ((t = s.match(/\$(?:true|false|null)\b/iy))) {
      value(span("literal", t));
    } else if ((t = s.match(/\$\{[^}]*\}?|\$(?:[A-Za-z]\w*:(?!:))?\w+|\$[$?^]/y))) {
      value(span("variable", t));
    } else if ((t = s.match(/\$\(|@\(|@\{|[({]/y))) {
      out += esc(t);
      open(t.endsWith("{") ? (t === "@{" ? "hash" : "block") : "paren");
    } else if ((t = s.match(/[)}]/y))) {
      out += t;
      close();
    } else if ((t = s.match(/\|\||&&|[|;]/y))) {
      out += esc(t);
      endStatement();
    } else if (start && (t = s.match(/&|\.(?=\s)/y))) {
      // 呼び出し演算子 & とドットソース . の後ろはコマンド
      out += esc(t);
    } else if ((t = s.match(/`[\s\S]/y))) {
      // 行末のバッククォートは行の継続なので、文の途中のまま
      out += esc(t);
    } else if ((t = s.match(/--?[A-Za-z_][\w-]*:?/y))) {
      const name = t.replace(/^-+/, "").replace(/:$/, "").toLowerCase();
      out += cmd ? span("params", t) : isOperator(name) ? span("operator", t) : esc(t);
      start = false;
    } else if (!cmd && (t = s.match(/[+*/%-]?=(?!=)/y))) {
      // 代入の右辺はパイプライン（$x = docker ps）。ハッシュテーブルでは値の位置
      out += esc(t);
      start = true;
      key = false;
    } else if (!cmd && (t = s.match(/\[[A-Za-z_][\w.]*(?:\[[\w.,\s]*\])?\]/y))) {
      value(span("type", t));
    } else if (!cmd && (t = s.match(/\[[A-Za-z_][\w.]*(?=\()/y))) {
      // [Parameter(Mandatory)] のような属性。( ) の中は式、最後の ] はただの文字
      out += esc("[") + span("type", t.slice(1));
    } else if ((t = s.match(/(?:0x[0-9a-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)(?:kb|mb|gb|tb|pb)?(?![\w.:\\/-])/iy))) {
      value(span("number", t));
    } else if ((t = s.match(/[^\s|;&(){}"'$,=`<>#][^\s|;&(){}"'$,=`<>]*/y))) {
      const lw = t.toLowerCase();
      if (expectName) {
        out += span("title function_", t);
        expectName = false;
        start = false;
      } else if (key) {
        out += span("attr", t);
        key = false;
        start = false;
      } else if (start) {
        if (KEYWORDS.has(lw)) {
          out += span("keyword", t);
          start = PIPELINE_KEYWORDS.has(lw);
          expectName = NAME_KEYWORDS.has(lw);
        } else {
          out += span("built_in", t);
          cmd = true;
          start = false;
        }
      } else {
        out += !cmd && KEYWORDS.has(lw) ? span("keyword", t) : esc(t);
      }
    } else {
      out += esc(s.take());
    }
  }
  return out;
}
