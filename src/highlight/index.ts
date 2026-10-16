import type { HLJSApi, LanguageFn } from "highlight.js";

// ---------- コードの色分けの振り分け ----------
// 自作の色分け（PowerShell・bash・console・.env）と、highlight.js の common に無い言語は、
// その言語のコードブロックが初めて出てきたときに読み込む。読み込むまでは色なしで出し、
// 読み込めたら onHighlighterLoaded に登録した関数で描き直してもらう

type Highlighter = (code: string) => string;

/** 言語名の別名 → このファイルで使う名前 */
const ALIASES: Record<string, string> = {
  ps1: "powershell",
  ps: "powershell",
  pwsh: "powershell",
  bash: "shell",
  sh: "shell",
  zsh: "shell",
  "shell-session": "console",
  terminal: "console",
  env: "dotenv",
  docker: "dockerfile",
  bat: "dos",
  cmd: "dos",
  batch: "dos",
};

/** highlight.js の common にある近い言語で色を付ける */
const HLJS_ALIASES: Record<string, string> = {
  // Vue の単一ファイルコンポーネントは HTML として（<script> は JS、<style> は CSS になる）
  vue: "html",
  // Blade は HTML に PHP が混ざったものとして
  blade: "php-template",
};

const OWN: Record<string, () => Promise<Highlighter>> = {
  powershell: () => import("./powershell").then((m) => m.highlightPowerShell),
  shell: () => import("./shell").then((m) => m.highlightShell),
  console: () =>
    Promise.all([import("./shell"), import("./powershell")]).then(([s, p]) =>
      s.consoleHighlighter(p.highlightPowerShell),
    ),
  dotenv: () => import("./shell").then((m) => m.highlightDotenv),
};

const HLJS_EXTRA: Record<string, () => Promise<LanguageFn>> = {
  dockerfile: () => import("highlight.js/lib/languages/dockerfile").then((m) => m.default),
  dos: () => import("highlight.js/lib/languages/dos").then((m) => m.default),
};

const own = new Map<string, Highlighter>();
const loading = new Set<string>();
const listeners: (() => void)[] = [];

/** 言語を読み込み終えたときに呼ぶ関数を登録する（描き直すため） */
export function onHighlighterLoaded(fn: () => void) {
  listeners.push(fn);
}

function load(name: string, task: () => Promise<void>) {
  if (loading.has(name)) return;
  loading.add(name);
  task().then(
    () => listeners.forEach((fn) => fn()),
    (err) => console.error("highlight", name, err),
  );
}

/** 表の自分のキーだけを引く（言語名が constructor や __proto__ でも Object.prototype の値を拾わない） */
const pick = <T>(table: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined;

/**
 * コードを色分けした HTML。色分けできない（未対応・読み込み中）なら null。
 * hljs は highlight.js の本体（まだ読み込めていなければ null）
 */
export function highlightCode(code: string, lang: string, hljs: HLJSApi | null): string | null {
  const name = pick(ALIASES, lang) ?? lang;
  const ownLoader = pick(OWN, name);
  if (ownLoader) {
    const fn = own.get(name);
    if (fn) return fn(code);
    load(name, () => ownLoader().then((f) => void own.set(name, f)));
    return null;
  }
  if (!hljs) return null;
  const extra = pick(HLJS_EXTRA, name);
  if (extra && !hljs.getLanguage(name)) {
    load(name, () => extra().then((def) => hljs.registerLanguage(name, def)));
    return null;
  }
  const language = pick(HLJS_ALIASES, name) ?? name;
  if (!hljs.getLanguage(language)) return null;
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}
