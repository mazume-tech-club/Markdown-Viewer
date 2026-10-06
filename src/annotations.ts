// ---------- 画像の注釈 ----------
// 画像に矢印・テキスト・枠・番号を重ねる。MD には次の形で書く（docs/adr/0002 参照）:
//
//   ![登録フォーム](form.annotated.png)
//   <!-- annotate {"src":"form.png","size":[1280,720],"items":[...]} -->
//
// 他のビューアでは焼き込み画像（form.annotated.png）が見え、このアプリでは元画像の上に SVG で描き直す。
// 座標・太さ・文字の大きさはすべて元画像のピクセル単位なので、画像と一緒に拡大縮小する

export type Pt = [number, number];

export type Item =
  | { t: "arrow"; from: Pt; to: Pt; color?: string; width?: number }
  /** bg なら白い背景を敷く（写真など込み入った画像の上でも読めるように） */
  | { t: "text"; at: Pt; text: string; size?: number; color?: string; bg?: boolean }
  | { t: "box"; rect: [number, number, number, number]; color?: string; width?: number }
  | { t: "num"; at: Pt; n: number; size?: number; color?: string };

export interface Annotation {
  /** 元画像（MD からの相対パス。MD のリンクと同じ書き方） */
  src: string;
  /** 元画像の大きさ（px） */
  size: Pt;
  items: Item[];
}

export const DEFAULT_COLOR = "#e00000";
const FONT = `"Yu Gothic UI", "Meiryo", "Segoe UI", sans-serif`;
const SVG_NS = "http://www.w3.org/2000/svg";

/** 画像の大きさに比例した既定の寸法（幅 1280px の画像で 1） */
export const unitOf = (size: Pt) => Math.max(0.5, Math.max(size[0], size[1]) / 1280);
export const defaultStroke = (size: Pt) => Math.round(4 * unitOf(size));
export const defaultFont = (size: Pt) => Math.round(28 * unitOf(size));
export const defaultNumSize = (size: Pt) => Math.round(32 * unitOf(size));

// ---- 読み書き ----

const isPt = (v: unknown): v is Pt => Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number");

function validItem(v: unknown): Item | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const color = typeof o.color === "string" ? o.color : undefined;
  const num = (k: string) => (typeof o[k] === "number" ? (o[k] as number) : undefined);
  switch (o.t) {
    case "arrow":
      return isPt(o.from) && isPt(o.to) ? { t: "arrow", from: o.from, to: o.to, color, width: num("width") } : null;
    case "text":
      return isPt(o.at) && typeof o.text === "string"
        ? { t: "text", at: o.at, text: o.text, size: num("size"), color, bg: o.bg === true || undefined }
        : null;
    case "box":
      return Array.isArray(o.rect) && o.rect.length === 4 && o.rect.every((n) => typeof n === "number")
        ? { t: "box", rect: o.rect as [number, number, number, number], color, width: num("width") }
        : null;
    case "num":
      return isPt(o.at) && typeof o.n === "number" ? { t: "num", at: o.at, n: o.n, size: num("size"), color } : null;
  }
  return null;
}

/** コメントの中身（JSON）を読む。読めなければ null */
export function parseAnnotation(json: string): Annotation | null {
  try {
    const o = JSON.parse(json);
    if (!o || typeof o.src !== "string" || !isPt(o.size) || !Array.isArray(o.items)) return null;
    return { src: o.src, size: o.size, items: o.items.map(validItem).filter((i: Item | null): i is Item => !!i) };
  } catch {
    return null;
  }
}

/**
 * コメントに書く JSON にする。座標は整数に丸める。
 * -- はコメントを終わらせ、< > は DOMPurify が data 属性ごと消すことがあるので、\u エスケープにする
 */
export function serializeAnnotation(a: Annotation): string {
  const round = (_k: string, v: unknown) => (typeof v === "number" ? Math.round(v) : v);
  return JSON.stringify(a, round)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/--/g, "-\\u002d");
}

/**
 * 元画像の隣に置く焼き込み画像のパス（form.png → form.annotated.png、k が 2 以上なら form.annotated-2.png）。
 * 同じ元画像を別の箇所・別の MD で注釈しても上書きしないよう、空いている k を選んで使う
 */
export function bakedPathOf(src: string, k = 1): string {
  const slash = Math.max(src.lastIndexOf("/"), src.lastIndexOf("\\"));
  const dot = src.lastIndexOf(".");
  const stem = dot > slash ? src.slice(0, dot) : src;
  return `${stem}.annotated${k > 1 ? `-${k}` : ""}.png`;
}

// ---- 形（SVG と canvas で共通） ----

/** 矢じりの 3 点（先端・左・右） */
function arrowHead(from: Pt, to: Pt, width: number): [Pt, Pt, Pt] {
  const len = Math.max(10, width * 4);
  const ang = Math.atan2(to[1] - from[1], to[0] - from[0]);
  const side = (d: number): Pt => [to[0] - len * Math.cos(ang + d), to[1] - len * Math.sin(ang + d)];
  return [to, side(0.45), side(-0.45)];
}

/** 線の終点を矢じりの根元まで戻す（太い線が矢じりの先からはみ出さないように） */
function shaftEnd(from: Pt, to: Pt, width: number): Pt {
  const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
  if (!len) return to;
  const back = Math.min(len, Math.max(10, width * 4) * 0.8);
  return [to[0] - ((to[0] - from[0]) / len) * back, to[1] - ((to[1] - from[1]) / len) * back];
}

/** テキストの行の高さ（文字の大きさに対する倍率） */
const LINE_HEIGHT = 1.3;

let measureCtx: CanvasRenderingContext2D | null = null;
/**
 * テキストの背景の四角（余白込み）。SVG と canvas で同じ大きさになるよう、canvas の計測で決める
 */
function textBox(item: Extract<Item, { t: "text" }>, size: Pt): [number, number, number, number] {
  const fs = fontOf(item, size);
  measureCtx ??= document.createElement("canvas").getContext("2d");
  const lines = item.text.split("\n");
  let w = fs * 2;
  if (measureCtx) {
    measureCtx.font = `bold ${fs}px ${FONT}`;
    w = Math.max(...lines.map((l) => measureCtx!.measureText(l).width));
  }
  const pad = fs * 0.3;
  const h = fs + (lines.length - 1) * fs * LINE_HEIGHT;
  return [item.at[0] - pad, item.at[1] - pad, w + pad * 2, h + pad * 2];
}

const strokeOf = (i: { width?: number }, size: Pt) => i.width ?? defaultStroke(size);
const fontOf = (i: { size?: number }, size: Pt) => i.size ?? defaultFont(size);
const numSizeOf = (i: { size?: number }, size: Pt) => i.size ?? defaultNumSize(size);

// ---- SVG ----

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/**
 * 1 つの図形の SVG。hit なら、細い線でもつかめるよう透明な太い当たり判定を足す（注釈エディタ用）
 */
export function itemSvg(item: Item, size: Pt, hit = false): SVGGElement {
  const g = el("g", {});
  const color = item.color ?? DEFAULT_COLOR;
  const halo = Math.max(2, unitOf(size) * 3);
  switch (item.t) {
    case "arrow": {
      const w = strokeOf(item, size);
      const end = shaftEnd(item.from, item.to, w);
      const head = arrowHead(item.from, item.to, w);
      if (hit) g.append(el("line", { x1: item.from[0], y1: item.from[1], x2: item.to[0], y2: item.to[1], stroke: "transparent", "stroke-width": w + 16 * unitOf(size) }));
      g.append(
        el("line", { x1: item.from[0], y1: item.from[1], x2: end[0], y2: end[1], stroke: color, "stroke-width": w, "stroke-linecap": "round" }),
        el("polygon", { points: head.map((p) => p.join(",")).join(" "), fill: color }),
      );
      break;
    }
    case "box": {
      const w = strokeOf(item, size);
      const [x, y, bw, bh] = item.rect;
      if (hit) g.append(el("rect", { x, y, width: bw, height: bh, fill: "none", stroke: "transparent", "stroke-width": w + 16 * unitOf(size), "pointer-events": "stroke" }));
      g.append(el("rect", { x, y, width: bw, height: bh, rx: w, fill: "none", stroke: color, "stroke-width": w }));
      break;
    }
    case "text": {
      const fs = fontOf(item, size);
      if (item.bg) {
        const [x, y, w, h] = textBox(item, size);
        g.append(el("rect", { x, y, width: w, height: h, rx: fs * 0.2, fill: "#fff" }));
      }
      const text = el("text", {
        x: item.at[0],
        y: item.at[1],
        fill: color,
        stroke: "#fff",
        "stroke-width": halo,
        "stroke-linejoin": "round",
        "paint-order": "stroke",
        "font-size": fs,
        "font-weight": "bold",
        "font-family": FONT,
        "dominant-baseline": "hanging",
      });
      item.text.split("\n").forEach((line, i) => {
        const span = el("tspan", { x: item.at[0], dy: i ? fs * LINE_HEIGHT : 0 });
        span.textContent = line || " ";
        text.append(span);
      });
      g.append(text);
      break;
    }
    case "num": {
      const r = numSizeOf(item, size) / 2;
      const [cx, cy] = item.at;
      const label = el("text", {
        x: cx,
        y: cy,
        fill: "#fff",
        "font-size": r * 1.2,
        "font-weight": "bold",
        "font-family": FONT,
        "text-anchor": "middle",
        "dominant-baseline": "central",
      });
      label.textContent = String(item.n);
      g.append(el("circle", { cx, cy, r, fill: color, stroke: "#fff", "stroke-width": halo }), label);
      break;
    }
  }
  return g;
}

/** 注釈全体の SVG（viewBox は元画像の大きさ。画像と同じ箱に重ねると一緒に拡大縮小する） */
export function buildOverlay(a: Annotation): SVGSVGElement {
  const svg = el("svg", { viewBox: `0 0 ${a.size[0]} ${a.size[1]}`, preserveAspectRatio: "none", "aria-hidden": "true" });
  for (const item of a.items) svg.append(itemSvg(item, a.size));
  return svg;
}

/**
 * プレビューの img[data-annotate] を、元画像＋注釈の SVG に置き換える（描画前のテンプレートに対して呼ぶ）。
 * 元画像が読めなければ、img の今の src（焼き込み画像）に戻して SVG を外す
 */
export function renderAnnotations(root: ParentNode, resolveSrc: (src: string) => string | null) {
  for (const img of root.querySelectorAll<HTMLImageElement>("img[data-annotate]")) {
    const a = parseAnnotation(img.dataset.annotate ?? "");
    const original = a && resolveSrc(a.src);
    if (!a || !original) continue;
    const baked = img.getAttribute("src") ?? "";
    const wrap = document.createElement("span");
    wrap.className = "annotated";
    const svg = buildOverlay(a);
    img.replaceWith(wrap);
    wrap.append(img, svg);
    img.addEventListener(
      "error",
      () => {
        svg.remove();
        img.src = baked;
      },
      { once: true },
    );
    img.src = original;
  }
}

// ---- 焼き込み（canvas） ----

function drawItem(ctx: CanvasRenderingContext2D, item: Item, size: Pt) {
  const color = item.color ?? DEFAULT_COLOR;
  const halo = Math.max(2, unitOf(size) * 3);
  ctx.save();
  switch (item.t) {
    case "arrow": {
      const w = strokeOf(item, size);
      const end = shaftEnd(item.from, item.to, w);
      ctx.strokeStyle = color;
      ctx.lineWidth = w;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(...item.from);
      ctx.lineTo(...end);
      ctx.stroke();
      const [a, b, c] = arrowHead(item.from, item.to, w);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(...a);
      ctx.lineTo(...b);
      ctx.lineTo(...c);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "box": {
      const w = strokeOf(item, size);
      ctx.strokeStyle = color;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.roundRect(...item.rect, w);
      ctx.stroke();
      break;
    }
    case "text": {
      const fs = fontOf(item, size);
      if (item.bg) {
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.roundRect(...textBox(item, size), fs * 0.2);
        ctx.fill();
      }
      ctx.font = `bold ${fs}px ${FONT}`;
      ctx.textBaseline = "top";
      ctx.lineJoin = "round";
      ctx.lineWidth = halo;
      ctx.strokeStyle = "#fff";
      ctx.fillStyle = color;
      item.text.split("\n").forEach((line, i) => {
        const y = item.at[1] + i * fs * LINE_HEIGHT;
        ctx.strokeText(line, item.at[0], y);
        ctx.fillText(line, item.at[0], y);
      });
      break;
    }
    case "num": {
      const r = numSizeOf(item, size) / 2;
      const [cx, cy] = item.at;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = halo;
      ctx.strokeStyle = "#fff";
      ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.font = `bold ${r * 1.2}px ${FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(item.n), cx, cy);
      break;
    }
  }
  ctx.restore();
}

/** 元画像に注釈を描き込んだ PNG を作る（他のビューア向け） */
export async function bake(image: Blob, a: Annotation): Promise<Uint8Array> {
  const bmp = await createImageBitmap(image);
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  // 元画像の大きさが記録と違っても（差し替えた場合など）、表示と同じく引き伸ばして重ねる
  ctx.scale(canvas.width / a.size[0], canvas.height / a.size[1]);
  for (const item of a.items) drawItem(ctx, item, a.size);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("注釈入りの画像を作れませんでした");
  return new Uint8Array(await blob.arrayBuffer());
}
