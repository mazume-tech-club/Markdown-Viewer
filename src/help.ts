import { darkQuery } from "./theme";
import "./styles.css";
import "./help.css";

import hljs from "highlight.js/lib/common";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";

import helpSource from "./help/help.md?raw";
import releasesSource from "./help/releases.md?raw";
import skillSource from "./help/skill.md?raw";
import { enableAllOptions, highlighterReady, onHighlighterLoaded, renderMarkdown } from "./render";
import { renderDiagrams } from "./diagrams";
import { markJudgeCells } from "./judge";

interface Item {
  id: string;
  title: string;
  note: string;
  code: string;
  /** 例を描画せず、ソースだけを全幅で出す（SKILL.md のように長い文書） */
  raw?: boolean;
}
interface Section {
  id: string;
  title: string;
  items: Item[];
}

/**
 * help.md の書式:
 *   # セクション名 {#id}
 *   ## 項目名
 *   説明（Markdown、複数行可）
 *   ~~~~example
 *   例（そのまま Markdown として描画する）
 *   ~~~~
 */
function parse(src: string): Section[] {
  const sections: Section[] = [];
  let item: Item | null = null;
  let code: string[] | null = null;
  for (const line of src.replace(/\r\n/g, "\n").split("\n")) {
    if (code) {
      if (line === "~~~~") {
        item!.code = code.join("\n");
        code = null;
      } else code.push(line);
      continue;
    }
    const sec = /^# (.+?)\s*\{#([\w-]+)\}\s*$/.exec(line);
    if (sec) {
      sections.push({ id: sec[2], title: sec[1], items: [] });
      continue;
    }
    if (line.startsWith("## ")) {
      const s = sections[sections.length - 1];
      item = { id: `${s.id}-${s.items.length + 1}`, title: line.slice(3).trim(), note: "", code: "" };
      s.items.push(item);
    } else if (line === "~~~~example" && item) {
      code = [];
    } else if (line.trim() && item) {
      item.note += (item.note ? "\n" : "") + line;
    }
  }
  return sections;
}

// Claude Code のスキル（help/skill.md）。そのまま保存して使えるよう、描画せずソースで出す
const skillSection: Section = {
  id: "skill",
  title: "Claude に教える（スキル）",
  items: [
    {
      id: "skill-1",
      title: "スキルを入れる",
      note: [
        "Claude Code に、このアプリで描ける書き方（図の記法・使えない記法など）を教えるファイル。入れておくと、Claude が md を書くときに描画されない記法を避け、図に合った書き方を選ぶ。",
        "",
        "1. 下の「SKILL.md」の **新しいタブで開く** を押す（**コピー** してほかのエディタに貼ってもよい）",
        "2. `C:\\Users\\<ユーザー名>\\.claude\\skills\\markdown-preview\\SKILL.md` という名前で保存する（フォルダが無ければ作る）。1 つのプロジェクトだけで使うなら、そのプロジェクトの `.claude\\skills\\markdown-preview\\SKILL.md`",
        "3. Claude Code を起動し直すと読み込まれる。md を書く依頼をすると自動で使われる（`/markdown-preview` で明示的にも呼べる）",
        "",
        "アプリを更新して書ける図が増えたら、ここから入れ直す。",
      ].join("\n"),
      code: "",
    },
    { id: "skill-2", title: "SKILL.md", note: "", code: skillSource.replace(/\r\n/g, "\n").trimEnd(), raw: true },
  ],
};

// オプション機能の図（数式・ER 図など）も、設定にかかわらず例を描いて見せる
enableAllOptions();

// リリースノートは書き方の例と同じ形で書き、ヘルプの最後の節として出す
const sections = [...parse(helpSource), skillSection, ...parse(releasesSource)];
const content = document.getElementById("content")!;
const toc = document.getElementById("toc")!;
const search = document.getElementById("search") as HTMLInputElement;
const byId = new Map(sections.flatMap((s) => s.items).map((i) => [i.id, i]));

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function build() {
  toc.innerHTML = sections
    .map(
      (s) => `<div class="toc-section" data-section="${s.id}">
        <a href="#${s.id}" class="toc-title">${esc(s.title)}</a>
        ${s.items.map((i) => `<a href="#${i.id}" class="toc-item" data-item="${i.id}">${esc(i.title)}</a>`).join("")}
      </div>`,
    )
    .join("");

  content.innerHTML = sections
    .map(
      (s) => `<section class="help-section" id="${s.id}" data-section="${s.id}">
        <h2>${esc(s.title)}</h2>
        ${s.items
          .map(
            (i) => `<article class="card" id="${i.id}" data-item="${i.id}"
                data-search="${esc(`${i.title}\n${i.note}\n${i.code}`.toLowerCase())}">
              <header>
                <h3>${esc(i.title)}</h3>
                ${
                  i.code
                    ? `<div class="actions">
                  <button data-act="copy" data-id="${i.id}" title="例をクリップボードにコピー">コピー</button>
                  ${
                    i.raw
                      ? `<button data-act="open" data-id="${i.id}" title="メインウィンドウの新しいタブに開く（Ctrl+S で保存先を選ぶ）">新しいタブで開く</button>`
                      : `<button data-act="insert" data-id="${i.id}" title="メインウィンドウのカーソル位置に挿入">エディタに挿入</button>`
                  }
                </div>`
                    : ""
                }
              </header>
              ${i.note ? `<div class="note markdown-body">${renderMarkdown(i.note)}</div>` : ""}
              ${
                i.raw
                  ? `<pre class="src raw"><code class="hljs">${hljs.highlight(i.code, { language: "markdown" }).value}</code></pre>`
                  : i.code
                  ? `<div class="pair">
                <pre class="src"><code class="hljs">${hljs.highlight(i.code, { language: "markdown" }).value}</code></pre>
                <div class="result markdown-body">${renderMarkdown(i.code)}</div>
              </div>`
                  : ""
              }
            </article>`,
          )
          .join("")}
      </section>`,
    )
    .join("");

  // オプション機能の例がどう見えるかを示すため、ヘルプでは設定にかかわらず判定の色付けをする
  markJudgeCells(content);

  // 図は画面に近づいたものから描く（ヘルプを開いた直後に全部描くと重いため）。
  // 画面に入ってから描くと、ソース表示から図に変わって高さが変わるのが見えてちらつくので、早めに描き始める
  const dark = darkQuery.matches;
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        void renderDiagrams(e.target, dark, () => true);
      }
    },
    { root: content, rootMargin: "1500px 0px" },
  );
  for (const r of content.querySelectorAll(".result")) {
    if (r.querySelector(".diagram")) io.observe(r);
  }
}

function filter() {
  const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  for (const card of content.querySelectorAll<HTMLElement>(".card")) {
    const hit = words.every((w) => card.dataset.search!.includes(w));
    card.hidden = !hit;
    toc.querySelector<HTMLElement>(`[data-item="${card.dataset.item}"]`)!.hidden = !hit;
  }
  for (const sec of content.querySelectorAll<HTMLElement>(".help-section")) {
    const empty = !sec.querySelector(".card:not([hidden])");
    sec.hidden = empty;
    toc.querySelector<HTMLElement>(`.toc-section[data-section="${sec.dataset.section}"]`)!.hidden = empty;
  }
}

function flash(btn: HTMLButtonElement, text: string) {
  const original = btn.dataset.label ?? btn.textContent!;
  btn.dataset.label = original;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = original), 1500);
}

document.addEventListener("click", async (e) => {
  const target = e.target as Element;
  const btn = target.closest<HTMLButtonElement>("button[data-act]");
  if (btn) {
    const item = byId.get(btn.dataset.id!)!;
    if (btn.dataset.act === "copy") {
      await navigator.clipboard.writeText(item.code);
      flash(btn, "コピーしました");
    } else if (btn.dataset.act === "open") {
      await emitTo("main", "open-snippet", item.code);
      flash(btn, "開きました");
    } else {
      await emitTo("main", "insert-snippet", item.code);
      flash(btn, "挿入しました");
    }
    return;
  }
  const a = target.closest("a");
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute("href") ?? "";
  if (href.startsWith("#")) {
    document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView({ block: "start" });
  } else if (/^https?:/i.test(href)) {
    await openUrl(href);
  }
});

search.addEventListener("input", filter);

// バージョン（設定や更新の確認はメインウィンドウの「設定」で行う）
// クリックするとリリースノートへ移る
const versionLink = document.getElementById("app-version")!;
void getVersion().then((v) => (versionLink.textContent = `Markdown Preview v${v}`));
versionLink.addEventListener("click", () => {
  if (search.value) {
    search.value = "";
    filter();
  }
  document.getElementById("releases")?.scrollIntoView({ block: "start" });
});

// ズーム（本文のみ）
let zoom = Number(localStorage.getItem("zoom.help")) || 1;
const applyZoom = () => {
  content.style.zoom = String(zoom);
  localStorage.setItem("zoom.help", String(zoom));
};
window.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    zoom = Math.round(Math.min(3, Math.max(0.5, zoom + (e.deltaY < 0 ? 0.1 : -0.1))) * 100) / 100;
    applyZoom();
  },
  { passive: false },
);

window.addEventListener(
  "keydown",
  (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if ((mod && e.key.toLowerCase() === "f") || e.key === "F1") {
      e.preventDefault();
      search.focus();
      search.select();
    } else if (e.key === "Escape") {
      if (search.value) {
        search.value = "";
        filter();
      } else void getCurrentWindow().close();
    } else if (mod && e.key === "0") {
      zoom = 1;
      applyZoom();
    } else if (e.key === "F5" || (mod && e.key.toLowerCase() === "r")) {
      e.preventDefault();
    }
  },
  { capture: true },
);

darkQuery.addEventListener("change", () => {
  build();
  filter();
});

// 例の色分けが出るよう、highlight.js を読み込んでから組み立てる
onHighlighterLoaded(() => {
  build();
  filter();
});
void highlighterReady.then(() => {
  build();
  applyZoom();
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
});
search.focus();
