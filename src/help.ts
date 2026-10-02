import { darkQuery } from "./theme";
import "./styles.css";
import "./help.css";

import hljs from "highlight.js/lib/common";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";

import helpSource from "./help/help.md?raw";
import { renderMarkdown } from "./render";
import { renderDiagrams } from "./diagrams";
import { isAutoCheckEnabled, isKeepDraftEnabled, setAutoCheck, setKeepDraft } from "./updater";
import { getActiveLineColor, isActiveLineEnabled, setActiveLineColor, setActiveLineEnabled } from "./prefs";

interface Item {
  id: string;
  title: string;
  note: string;
  code: string;
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

const sections = parse(helpSource);
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
                <div class="actions">
                  <button data-act="copy" data-id="${i.id}" title="例をクリップボードにコピー">コピー</button>
                  <button data-act="insert" data-id="${i.id}" title="メインウィンドウのカーソル位置に挿入">エディタに挿入</button>
                </div>
              </header>
              ${i.note ? `<div class="note markdown-body">${renderMarkdown(i.note)}</div>` : ""}
              <div class="pair">
                <pre class="src"><code class="hljs">${hljs.highlight(i.code, { language: "markdown" }).value}</code></pre>
                <div class="result markdown-body">${renderMarkdown(i.code)}</div>
              </div>
            </article>`,
          )
          .join("")}
      </section>`,
    )
    .join("");

  // 図は画面に入ったものから描く（ヘルプを開いた直後に全部描くと重いため）
  const dark = darkQuery.matches;
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        void renderDiagrams(e.target, dark, () => true);
      }
    },
    { root: content, rootMargin: "400px 0px" },
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

// バージョンと更新の確認（確認・更新の画面はメインウィンドウ側で出す）
void getVersion().then((v) => (document.getElementById("app-version")!.textContent = `Markdown Preview v${v}`));
document.getElementById("btn-check-update")!.addEventListener("click", () => void emitTo("main", "check-update"));
const autoUpdate = document.getElementById("auto-update") as HTMLInputElement;
autoUpdate.checked = isAutoCheckEnabled();
autoUpdate.addEventListener("change", () => setAutoCheck(autoUpdate.checked));
const keepDraft = document.getElementById("keep-draft") as HTMLInputElement;
keepDraft.checked = isKeepDraftEnabled();
keepDraft.addEventListener("change", () => setKeepDraft(keepDraft.checked));

// 編集 → プレビュー切替時の編集位置の色付け（メインウィンドウは storage イベントで追従）
const activeLine = document.getElementById("active-line") as HTMLInputElement;
const activeLineColor = document.getElementById("active-line-color") as HTMLInputElement;
activeLine.checked = isActiveLineEnabled();
activeLineColor.value = getActiveLineColor();
activeLine.addEventListener("change", () => setActiveLineEnabled(activeLine.checked));
activeLineColor.addEventListener("input", () => setActiveLineColor(activeLineColor.value));
document.getElementById("active-line-reset")!.addEventListener("click", () => {
  setActiveLineColor(null);
  activeLineColor.value = getActiveLineColor();
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

build();
applyZoom();
if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
search.focus();
