import DOMPurify from "dompurify";

// 図ライブラリは重いので、最初に必要になったときに読み込む
type Mermaid = typeof import("mermaid").default;
type Viz = Awaited<ReturnType<typeof import("@viz-js/viz").instance>>;

let mermaidP: Promise<Mermaid> | null = null;
let mermaidTheme = "";
let vizP: Promise<Viz> | null = null;
let seq = 0;

/** 種別・テーマ・ソースをキーにした描画済み SVG のキャッシュ */
const cache = new Map<string, string>();
const CACHE_MAX = 200;

function remember(key: string, svg: string) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, svg);
}

async function getMermaid(dark: boolean): Promise<Mermaid> {
  mermaidP ??= import("mermaid").then((m) => m.default);
  const mermaid = await mermaidP;
  const theme = dark ? "dark" : "default";
  if (theme !== mermaidTheme) {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme });
    mermaidTheme = theme;
  }
  return mermaid;
}

// wavedrom は <use xlink:href="#..."> で波形を組み立てるので use を許可する。
// 参照先は SVG 内のフラグメントに限る
const purifier = DOMPurify();
purifier.addHook("afterSanitizeAttributes", (node) => {
  for (const name of ["href", "xlink:href"]) {
    const v = node.getAttribute(name);
    if (node.nodeName.toLowerCase() === "use" && v && !v.startsWith("#")) node.removeAttribute(name);
  }
});
const sanitizeSvg = (svg: string) =>
  purifier.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ["use"],
    ADD_ATTR: ["xlink:href"],
  });

/** DOT を描画する。post で、サニタイズ前の SVG に手を加えられる */
async function renderDot(src: string, post: (svg: string) => string = (svg) => svg): Promise<string> {
  vizP ??= import("@viz-js/viz").then((m) => m.instance());
  const viz = await vizP;
  return sanitizeSvg(post(viz.renderSVGElement(src).outerHTML));
}

async function renderOne(kind: string, src: string, dark: boolean): Promise<string> {
  switch (kind) {
    case "mermaid": {
      const mermaid = await getMermaid(dark);
      const id = `mmd-${++seq}`;
      try {
        // mermaid は strict モードでラベルを自前でサニタイズする
        return (await mermaid.render(id, src)).svg;
      } finally {
        // 失敗時に body 直下へ残る一時要素を掃除する
        document.getElementById(id)?.remove();
        document.getElementById(`d${id}`)?.remove();
      }
    }
    case "graphviz":
      return renderDot(src);
    case "c4": {
      // C4 の書き方を DOT に変換して Graphviz で描く（線の経路は Graphviz に任せる）
      const { c4ToDot, drawPersonIcons } = await import("./c4dot");
      return renderDot(c4ToDot(src), drawPersonIcons);
    }
    case "wavedrom": {
      const [wd, { default: JSON5 }] = await Promise.all([import("wavedrom"), import("json5")]);
      const jsonml = wd.renderAny(++seq, JSON5.parse(src), wd.waveSkin);
      return sanitizeSvg(wd.onml.stringify(jsonml));
    }
    default:
      throw new Error(`未対応の図: ${kind}`);
  }
}

function showError(el: HTMLElement, kind: string, err: unknown) {
  const box = document.createElement("div");
  box.className = "diagram-error";
  box.textContent = `${kind} の描画に失敗しました: ${err instanceof Error ? err.message : String(err)}`;
  el.replaceChildren(box, el.querySelector(".diagram-src")!.cloneNode(true));
  el.classList.add("failed");
}

/** mermaid の C4 は固定の余白を大きく取るので、実際の描画範囲まで viewBox を詰める */
function tighten(el: HTMLElement) {
  const svg = el.querySelector("svg");
  if (!svg || svg.getAttribute("aria-roledescription") !== "c4") return;
  // タイトルは図形から離れた固定位置に置かれるので、図形のすぐ上へ寄せる
  const title = [...svg.children].reverse().find((c) => c.tagName === "text") as SVGTextElement | undefined;
  const ctm = svg.getScreenCTM();
  if (title && ctm) {
    let top = Infinity;
    for (const c of svg.children) {
      if (c === title || c.tagName !== "g") continue;
      const r = c.getBoundingClientRect();
      if (r.height > 0) top = Math.min(top, r.top);
    }
    const t = title.getBoundingClientRect();
    if (top !== Infinity && top - t.bottom > 24) {
      const dy = (top - 16 - t.bottom) / ctm.d;
      title.setAttribute("transform", `translate(0 ${dy})`);
    }
  }
  const b = svg.getBBox();
  if (!b.width || !b.height) return;
  const pad = 16;
  svg.setAttribute("viewBox", `${b.x - pad} ${b.y - pad} ${b.width + pad * 2} ${b.height + pad * 2}`);
  svg.style.maxWidth = `${b.width + pad * 2}px`;
}

const keyOf =(el: HTMLElement, dark: boolean) =>
  `${el.dataset.kind}\u0000${dark ? 1 : 0}\u0000${el.querySelector(".diagram-src")?.textContent ?? ""}`;

/** キャッシュ済みの図を同期的に埋める（DOM に入れる前のちらつき防止用） */
export function fillCached(root: ParentNode, dark: boolean) {
  for (const el of root.querySelectorAll<HTMLElement>(".diagram")) {
    const svg = cache.get(keyOf(el, dark));
    if (svg !== undefined) {
      el.innerHTML = svg;
      el.classList.add("done");
    }
  }
}

/** 未描画の図を順番に描画する。isCurrent が false になったら中断する */
export async function renderDiagrams(root: ParentNode, dark: boolean, isCurrent: () => boolean) {
  for (const el of root.querySelectorAll<HTMLElement>(".diagram:not(.done):not(.failed)")) {
    if (!isCurrent()) return;
    const kind = el.dataset.kind!;
    const key = keyOf(el, dark);
    const src = el.querySelector(".diagram-src")!.textContent ?? "";
    try {
      const svg = await renderOne(kind, src, dark);
      if (!isCurrent() || !el.isConnected) {
        remember(key, svg);
        return;
      }
      el.innerHTML = svg;
      el.classList.add("done");
      // 余白の調整は DOM 上で寸法を測る必要があるので、挿入後に行ってからキャッシュする
      tighten(el);
      remember(key, el.innerHTML);
    } catch (err) {
      if (!isCurrent() || !el.isConnected) return;
      showError(el, kind, err);
    }
  }
}
