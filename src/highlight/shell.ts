import { atWordStart, esc, Scanner, span } from "./util";

// ---------- bash / sh の色分け（自作） ----------
// PowerShell と同じ考え方で、文の先頭の語をコマンド、その後ろの -x / --name を引数にする

const KEYWORDS = new Set(
  "if then else elif fi for in do done while until case esac function select time coproc".split(" "),
);
/** 後ろにコマンドが続くキーワード */
const COMMAND_FOLLOWS = new Set(["if", "then", "else", "elif", "do", "while", "until", "time", "!"]);
/** 後ろに名前（変数名・関数名）が続くキーワード */
const NAME_FOLLOWS: Record<string, string> = { for: "variable", select: "variable", function: "title function_" };

const VAR = /\\[\s\S]|\$\{[^}]*\}|\$\([^)]*\)|\$(?:\w+|[@*#?$!0-9-])/g;

/** ダブルクォートの文字列。中の $x・${x}・$(...) を変数の色にする */
function interpolated(text: string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(VAR)) {
    if (m[0][0] === "\\") continue;
    out += esc(text.slice(last, m.index)) + span("variable", m[0]);
    last = m.index + m[0].length;
  }
  return `<span class="hljs-string">${out}${esc(text.slice(last))}</span>`;
}

export function highlightShell(code: string): string {
  const s = new Scanner(code);
  let out = "";
  let start = true;
  let cmd = false;
  /** NAME=value の value を読む位置（読んだあとも文の先頭のまま） */
  let assignValue = false;
  let expectName = "";
  /** <<EOF の終わりの印。次の改行から、この行が来るまでがヒアドキュメント */
  const heredocs: string[] = [];
  const stack: boolean[] = [];

  const endStatement = () => {
    start = true;
    cmd = false;
  };
  const value = (html: string) => {
    out += html;
    if (assignValue) assignValue = false;
    else start = false;
  };

  while (!s.done) {
    let t: string | null;
    if ((t = s.match(/[ \t]+/y))) {
      out += t;
      assignValue = false;
    } else if ((t = s.match(/\r?\n/y))) {
      out += t;
      endStatement();
      assignValue = false;
      while (heredocs.length) {
        const end = heredocs.shift()!;
        const name = end.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
        const re = new RegExp(`[\\s\\S]*?^\\t*${name}$(?:\\r?\\n)?|[\\s\\S]*`, "my");
        out += span("string", s.match(re) ?? "");
      }
    } else if ((t = s.match(/\\\r?\n/y))) {
      // 行末の \ は行の継続
      out += t;
    } else if (atWordStart(code, s.pos) && (t = s.match(/#[^\r\n]*/y))) {
      // # は語の先頭のときだけコメント（$PAGE#section や "a"#b の # は文字）
      out += span("comment", t);
    } else if ((t = s.match(/<<-?\s*(['"]?)([\w-]+)\1/y))) {
      heredocs.push(t.replace(/^<<-?\s*['"]?|['"]?$/g, ""));
      out += esc(t);
    } else if ((t = s.match(/\$'(?:[^'\\]|\\[\s\S])*'?|'[^']*'?/y))) {
      value(span("string", t));
    } else if ((t = s.match(/"(?:[^"\\]|\\[\s\S])*"?/y))) {
      value(interpolated(t));
    } else if ((t = s.match(/\$\(\(?/y))) {
      out += esc(t);
      stack.push(cmd);
      endStatement();
    } else if ((t = s.match(/\$\{[^}]*\}?|\$(?:\w+|[@*#?$!0-9-])/y))) {
      value(span("variable", t));
    } else if (stack.length && (t = s.match(/\)\)?|\}/y))) {
      out += t;
      cmd = stack.pop()!;
      start = false;
    } else if ((t = s.match(/\d*[<>]+&?\d*-?|&>>?/y))) {
      // リダイレクト（> file、2>&1 など）
      out += esc(t);
    } else if ((t = s.match(/\|\||&&|;;|[|;&]/y))) {
      out += esc(t);
      endStatement();
    } else if (start && (t = s.match(/[({]/y))) {
      // 文の先頭の ( と { はサブシェルとグループ。それ以外（echo {a,b} など）はただの文字
      out += t;
      stack.push(cmd);
      endStatement();
    } else if (start && !assignValue && (t = s.match(/[A-Za-z_]\w*(?=\+?=)/y))) {
      out += span("variable", t) + esc(s.match(/\+?=/y)!);
      assignValue = true;
    } else if ((t = s.match(/--?[A-Za-z0-9][\w-]*/y))) {
      out += cmd ? span("params", t) : esc(t);
      start = false;
    } else if ((t = s.match(/[^\s|;&()<>"'$`#{}\\][^\s|;&()<>"'$`{}\\]*/y))) {
      if (assignValue) {
        out += esc(t);
        assignValue = false;
      } else if (expectName) {
        out += span(expectName, t);
        expectName = "";
        start = false;
      } else if (start) {
        if (KEYWORDS.has(t) || t === "!") {
          out += span("keyword", t);
          start = COMMAND_FOLLOWS.has(t);
          cmd = false;
          expectName = NAME_FOLLOWS[t] ?? "";
        } else if (s.match(/\(\)/y)) {
          out += span("title function_", t) + "()";
          start = false;
        } else {
          out += span("built_in", t);
          cmd = true;
          start = false;
        }
      } else {
        out += !cmd && KEYWORDS.has(t) ? span("keyword", t) : esc(t);
      }
    } else {
      out += esc(s.take());
      assignValue = false;
    }
  }
  return out;
}

// ---------- console（プロンプト付きの実行例） ----------
// $ / # / > / PS C:\> / user@host:~$ で始まる行はコマンドとして色を付け、それ以外の行（出力）はそのまま

const PROMPT = /^(\s*)((?:PS [^>\r\n]*>)|(?:[\w.-]+@[\w.-]+(?::[^\s$#]*)?[$#])|[$#%>])(\s)(.*)$/;

export function consoleHighlighter(powershell: (code: string) => string) {
  return (code: string) =>
    code
      .split("\n")
      .map((line) => {
        const m = PROMPT.exec(line);
        if (!m) return esc(line);
        const body = m[2].startsWith("PS ") ? powershell(m[4]) : highlightShell(m[4]);
        return `${m[1]}${span("meta", m[2])}${m[3]}${body}`;
      })
      .join("\n");
}

// ---------- .env ----------

export function highlightDotenv(code: string): string {
  return code
    .split("\n")
    .map((line) => {
      if (/^\s*#/.test(line)) return span("comment", line);
      const m = /^(\s*)(export\s+)?([A-Za-z_][\w.-]*)(\s*=\s*)(.*)$/.exec(line);
      if (!m) return esc(line);
      const [, indent, exp, key, eq, rest] = m;
      // 引用符で囲まない値の後ろの「 #...」はコメント
      // 最後の選択肢はどんな値にも一致させる（abc#123 のように空白なしの # は値の一部）
      const c = /^("(?:[^"\\]|\\.)*"|'[^']*'|[\s\S]*?)(\s+#[\s\S]*)?$/.exec(rest)!;
      return (
        indent +
        (exp ? span("keyword", exp.trimEnd()) + exp.slice(exp.trimEnd().length) : "") +
        span("attr", key) +
        esc(eq) +
        (c[1] ? span("string", c[1]) : "") +
        (c[2] ? span("comment", c[2]) : "")
      );
    })
    .join("\n");
}
