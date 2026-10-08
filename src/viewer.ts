// 拡大ビューア: プレビューの図や画像を 1 つだけ、ウィンドウいっぱいに出して拡大縮小・移動しながら見る。
// プレビューの要素を複製して重ねるだけで、文書やプレビューには手を加えない。

export type Size = { w: number; h: number };
/** 表示の状態。中身の左上を (x, y) に置き、scale 倍で描く */
export type View = { scale: number; x: number; y: number };

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 8;
/** 全体表示のとき、ウィンドウの縁との間に空ける幅（px） */
const FIT_MARGIN = 24;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 中身の全体が area に収まる倍率で、中央に置く */
export function fitView(content: Size, area: Size): View {
  const scale = clamp(
    Math.min((area.w - FIT_MARGIN * 2) / content.w, (area.h - FIT_MARGIN * 2) / content.h),
    MIN_SCALE,
    MAX_SCALE,
  );
  return { scale, x: (area.w - content.w * scale) / 2, y: (area.h - content.h * scale) / 2 };
}

/** 画面上の点 (px, py) の下にある中身の位置を動かさずに、倍率を factor 倍する */
export function zoomAt(view: View, factor: number, px: number, py: number): View {
  const scale = clamp(view.scale * factor, MIN_SCALE, MAX_SCALE);
  const k = scale / view.scale;
  return { scale, x: px - (px - view.x) * k, y: py - (py - view.y) * k };
}

/** 拡大して見られる要素（図の SVG・注釈付きの画像・画像）。見られないものなら null */
export function viewableAt(target: EventTarget | null): HTMLElement | SVGSVGElement | null {
  if (!(target instanceof Element)) return null;
  const diagram = target.closest(".diagram.done");
  if (diagram) return diagram.querySelector("svg");
  const img = target.closest("img");
  if (!img) return null;
  return img.closest<HTMLElement>(".annotated") ?? img;
}

/** 長さが % 以外で指定されていれば、その px 値 */
function absLength(len: SVGAnimatedLength): number {
  const l = len.baseVal;
  return l.unitType === SVGLength.SVG_LENGTHTYPE_PERCENTAGE || l.unitType === SVGLength.SVG_LENGTHTYPE_UNKNOWN ? 0 : l.value;
}

/** 図や画像の実寸（100% で表示したときの大きさ）。分からなければ null */
function naturalSize(el: HTMLElement | SVGSVGElement): Size | null {
  if (el instanceof SVGSVGElement) {
    const vb = el.viewBox.baseVal;
    // mermaid は width="100%" と max-width で実寸を表す
    const w = absLength(el.width) || parseFloat(el.style.maxWidth) || vb?.width || 0;
    const h = absLength(el.height) || (vb?.width ? (vb.height * w) / vb.width : 0);
    if (w && h) return { w, h };
    const r = el.getBoundingClientRect();
    return r.width && r.height ? { w: r.width, h: r.height } : null;
  }
  const img = el instanceof HTMLImageElement ? el : el.querySelector("img");
  return img?.naturalWidth ? { w: img.naturalWidth, h: img.naturalHeight } : null;
}

export type Viewer = {
  /** el を拡大ビューアで開く。大きさが分からない（画像の読み込み前など）ときは開かずに false */
  open(el: HTMLElement | SVGSVGElement): boolean;
  close(): void;
  isOpen(): boolean;
  /** 開いている間のキー操作。扱ったら true */
  handleKey(e: KeyboardEvent): boolean;
};

export function setupViewer(): Viewer {
  const overlay = document.getElementById("viewer")!;
  const stage = document.getElementById("viewer-stage")!;
  const label = document.getElementById("viewer-zoom")!;
  document.getElementById("viewer-close")!.addEventListener("click", () => close());

  let content: HTMLElement | SVGElement | null = null;
  let size: Size = { w: 1, h: 1 };
  let view: View = { scale: 1, x: 0, y: 0 };

  const area = (): Size => ({ w: stage.clientWidth, h: stage.clientHeight });

  function apply(next: View) {
    view = next;
    if (content) content.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    label.textContent = `${Math.round(view.scale * 100)}%`;
  }

  function open(el: HTMLElement | SVGSVGElement): boolean {
    const s = naturalSize(el);
    if (!s) return false;
    size = s;
    const clone = el.cloneNode(true) as HTMLElement | SVGSVGElement;
    clone.classList.add("viewer-content");
    // 本文の幅に合わせる指定を外し、実寸の箱にしてから transform で拡大縮小する
    clone.style.width = `${size.w}px`;
    clone.style.height = `${size.h}px`;
    clone.style.maxWidth = "none";
    content = clone;
    stage.replaceChildren(clone);
    overlay.hidden = false;
    apply(fitView(size, area()));
    return true;
  }

  function close() {
    overlay.hidden = true;
    stage.replaceChildren();
    content = null;
  }

  const isOpen = () => !overlay.hidden;

  /** ステージの中央を中心にする倍率の変更（キー操作用） */
  const zoomCenter = (factor: number) => {
    const a = area();
    apply(zoomAt(view, factor, a.w / 2, a.h / 2));
  };

  function handleKey(e: KeyboardEvent): boolean {
    const key = e.key;
    if (key === "Escape") close();
    else if (key === "0") apply(fitView(size, area()));
    else if (key === "1") zoomCenter(1 / view.scale);
    // JIS 配列では「+」が Shift+; なので ; も拡大として扱う
    else if (["+", "=", ";"].includes(key)) zoomCenter(1.25);
    else if (["-", "_"].includes(key)) zoomCenter(1 / 1.25);
    else return false;
    return true;
  }

  stage.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      // 行単位（deltaMode 1）のホイールもピクセルに直してから、なめらかな倍率にする
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      const r = stage.getBoundingClientRect();
      apply(zoomAt(view, Math.exp(-dy / 400), e.clientX - r.left, e.clientY - r.top));
    },
    { passive: false },
  );

  // ドラッグで移動。動かさずに図の外を押して離したときだけ閉じる
  let drag: { id: number; x: number; y: number; moved: boolean } | null = null;
  stage.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    stage.setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
  });
  stage.addEventListener("pointermove", (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    drag.moved = true;
    stage.classList.add("dragging");
    drag.x = e.clientX;
    drag.y = e.clientY;
    apply({ ...view, x: view.x + dx, y: view.y + dy });
  });
  const endDrag = (e: PointerEvent) => {
    if (!drag || drag.id !== e.pointerId) return;
    const clickedOutside = !drag.moved && !content?.contains(document.elementFromPoint(e.clientX, e.clientY));
    drag = null;
    stage.classList.remove("dragging");
    if (e.type === "pointerup" && clickedOutside) close();
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);

  // ウィンドウの大きさが変わったら、中央の位置を保つ
  let last = { w: 0, h: 0 };
  new ResizeObserver(() => {
    const a = area();
    if (isOpen() && last.w && last.h) apply({ ...view, x: view.x + (a.w - last.w) / 2, y: view.y + (a.h - last.h) / 2 });
    last = a;
  }).observe(stage);

  return { open, close, isOpen, handleKey };
}
