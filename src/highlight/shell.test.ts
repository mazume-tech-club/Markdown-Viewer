import { describe, expect, it } from "vitest";
import { consoleHighlighter, highlightDotenv, highlightShell } from "./shell";
import { highlightPowerShell } from "./powershell";

const tokens = (html: string) =>
  [...html.matchAll(/<span class="hljs-([\w ]+)">([\s\S]*?)<\/span>/g)].map((m) => `${m[1]}:${m[2]}`);

describe("highlightShell", () => {
  it("文の先頭の語をコマンド、-x と --name を引数にする", () => {
    expect(tokens(highlightShell("docker compose up -d && npm run build --watch"))).toEqual([
      "built_in:docker",
      "params:-d",
      "built_in:npm",
      "params:--watch",
    ]);
  });

  it("パイプとセミコロンの後ろもコマンド", () => {
    expect(tokens(highlightShell("cat a.txt | grep -v x; echo done"))).toEqual([
      "built_in:cat",
      "built_in:grep",
      "params:-v",
      "built_in:echo",
    ]);
  });

  it("変数・文字列・コメント", () => {
    expect(tokens(highlightShell('echo "home: $HOME" \'$x\' # memo'))).toEqual([
      "built_in:echo",
      'string:"home: <span class="hljs-variable">$HOME',
      "string:'$x'",
      "comment:# memo",
    ]);
  });

  it("代入の後ろもコマンドの位置のまま", () => {
    expect(tokens(highlightShell("NODE_ENV=production node app.js"))).toEqual([
      "variable:NODE_ENV",
      "built_in:node",
    ]);
  });

  it("キーワードと for の変数", () => {
    expect(tokens(highlightShell("for f in *.md; do wc -l $f; done"))).toEqual([
      "keyword:for",
      "variable:f",
      "keyword:in",
      "keyword:do",
      "built_in:wc",
      "params:-l",
      "variable:$f",
      "keyword:done",
    ]);
  });

  it("$( ) の中もコマンド", () => {
    expect(tokens(highlightShell("echo $(date +%F)"))).toEqual(["built_in:echo", "built_in:date"]);
  });

  it("ヒアドキュメントは文字列", () => {
    const html = highlightShell("cat <<EOF\nhello $x\nEOF\nls");
    expect(tokens(html)).toEqual(["built_in:cat", "string:hello $x\nEOF\n", "built_in:ls"]);
  });

  it("語の途中の # はコメントにしない", () => {
    expect(tokens(highlightShell('curl https://x/$PAGE#sec "a"#b # memo'))).toEqual([
      "built_in:curl",
      "variable:$PAGE",
      'string:"a"',
      "comment:# memo",
    ]);
  });

  it("2>&1 はリダイレクトで、後ろがコマンドにならない", () => {
    expect(tokens(highlightShell("make 2>&1 build"))).toEqual(["built_in:make"]);
  });
});

describe("console", () => {
  const hl = consoleHighlighter(highlightPowerShell);
  it("プロンプトの行だけコマンドとして色付けし、出力の行はそのまま", () => {
    expect(tokens(hl("$ ls -la\ntotal 0\nPS C:\\> Get-Date"))).toEqual([
      "meta:$",
      "built_in:ls",
      "params:-la",
      "meta:PS C:\\&gt;",
      "built_in:Get-Date",
    ]);
  });
});

describe("highlightDotenv", () => {
  it("キー・値・コメント", () => {
    expect(tokens(highlightDotenv("# db\nexport DB_HOST=localhost # local\nDB_PASS='x y'"))).toEqual([
      "comment:# db",
      "keyword:export",
      "attr:DB_HOST",
      "string:localhost",
      "comment: # local",
      "attr:DB_PASS",
      "string:'x y'",
    ]);
  });

  it("空白なしの # は値の一部（例外を出さない）", () => {
    expect(tokens(highlightDotenv("PASSWORD=abc#123\nURL=http://x/#frag\nKEY='a'#x\nQ=\"a#b"))).toEqual([
      "attr:PASSWORD",
      "string:abc#123",
      "attr:URL",
      "string:http://x/#frag",
      "attr:KEY",
      "string:'a'#x",
      "attr:Q",
      'string:"a#b',
    ]);
  });
});
