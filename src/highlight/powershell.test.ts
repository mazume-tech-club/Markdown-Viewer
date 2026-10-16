import { describe, expect, it } from "vitest";
import { highlightPowerShell } from "./powershell";

/** 色付きの部分だけを「クラス:文字」の一覧にする（読みやすく比べるため） */
function tokens(code: string): string[] {
  const html = highlightPowerShell(code);
  return [...html.matchAll(/<span class="hljs-([\w ]+)">(.*?)<\/span>/g)].map((m) => `${m[1]}:${m[2]}`);
}

describe("highlightPowerShell", () => {
  it("外部コマンドは先頭の語をコマンドにし、-d や -f は引数のまま", () => {
    expect(tokens("docker compose up -d; docker compose logs -f sqlserver")).toEqual([
      "built_in:docker",
      "params:-d",
      "built_in:docker",
      "params:-f",
    ]);
  });

  it("コマンドレット・引数・パイプ・変数・演算子・数値", () => {
    expect(tokens("Get-ChildItem -Path C:\\temp -Recurse | Where-Object { $_.Length -gt 1000 }")).toEqual([
      "built_in:Get-ChildItem",
      "params:-Path",
      "params:-Recurse",
      "built_in:Where-Object",
      "variable:$_",
      "operator:-gt",
      "number:1000",
    ]);
  });

  it("式の中の -f は書式演算子", () => {
    expect(tokens('"{0}" -f $name')).toEqual(['string:"{0}"', "operator:-f", "variable:$name"]);
  });

  it("代入の右辺はコマンド", () => {
    expect(tokens("$ids = docker ps -q")).toEqual(["variable:$ids", "built_in:docker", "params:-q"]);
  });

  it("キーワード・型・関数名・リテラル", () => {
    expect(tokens("function Test-It { param([string]$Name) if ($Name -eq $null) { return $false } }")).toEqual([
      "keyword:function",
      "title function_:Test-It",
      "keyword:param",
      "type:[string]",
      "variable:$Name",
      "keyword:if",
      "variable:$Name",
      "operator:-eq",
      "literal:$null",
      "keyword:return",
      "literal:$false",
    ]);
  });

  it("ダブルクォートの中の変数だけ変数の色。シングルクォートはそのまま", () => {
    expect(highlightPowerShell('"Hi $env:USERNAME" \'$x\'')).toBe(
      '<span class="hljs-string">"Hi <span class="hljs-variable">$env:USERNAME</span>"</span> <span class="hljs-string">\'$x\'</span>',
    );
  });

  it("コメントとハッシュテーブルのキー", () => {
    expect(tokens("@{ Name = 'a'; Count = 2 } # memo")).toEqual([
      "attr:Name",
      "string:'a'",
      "attr:Count",
      "number:2",
      "comment:# memo",
    ]);
  });

  it("行末のバッククォートで続く行も同じコマンドの引数", () => {
    expect(tokens("docker run `\n  -d nginx")).toEqual(["built_in:docker", "params:-d"]);
  });

  it("foreach の in と、閉じかっこの後の else", () => {
    expect(tokens("foreach ($f in $files) { $f } else { }")).toEqual([
      "keyword:foreach",
      "variable:$f",
      "keyword:in",
      "variable:$files",
      "variable:$f",
      "keyword:else",
    ]);
  });

  it("語の途中の # はコメントにしない", () => {
    expect(tokens("Start-Process https://x/$Page#sec # memo")).toEqual([
      "built_in:Start-Process",
      "variable:$Page",
      "comment:# memo",
    ]);
  });

  it("HTML の特殊文字はエスケープする", () => {
    expect(highlightPowerShell("echo <a> & b")).not.toContain("<a>");
  });
});
