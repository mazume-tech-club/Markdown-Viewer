import type { Editor } from "./editor";

/** プレビュー内の [data-line] 要素の位置（ペイン上端からのピクセル）を集める */
function anchors(pane: HTMLElement): { line: number; top: number }[] {
  const base = pane.getBoundingClientRect().top - pane.scrollTop;
  const out: { line: number; top: number }[] = [];
  for (const el of pane.querySelectorAll<HTMLElement>("[data-line]")) {
    const line = Number(el.dataset.line);
    const top = el.getBoundingClientRect().top - base;
    // 入れ子要素で行が戻るものは無視して単調増加を保つ
    if (out.length && line <= out[out.length - 1].line) continue;
    out.push({ line, top });
  }
  return out;
}

/** ソース行 line を含むプレビュー要素（行番号が line 以下で最大のもの。同じ行なら内側） */
export function findLineElement(pane: HTMLElement, line: number): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestLine = -1;
  for (const el of pane.querySelectorAll<HTMLElement>("[data-line]")) {
    const l = Number(el.dataset.line);
    if (l <= line && l >= bestLine) {
      best = el;
      bestLine = l;
    }
  }
  return best;
}

/**
 * エディタとプレビューのスクロール位置を、ソース行を介して連動させる。
 * 戻り値はプレビューをエディタの位置に合わせる関数（表示切替時に使う）
 */
export function setupScrollSync(editor: Editor, pane: HTMLElement, enabled: () => boolean) {
  // 片方を動かしたことで発火した、もう片方のスクロールイベントを無視する
  let lockUntil = 0;
  let source: "editor" | "preview" | null = null;
  const lock = (s: typeof source) => {
    source = s;
    lockUntil = performance.now() + 120;
  };
  const locked = (s: typeof source) => source !== s && performance.now() < lockUntil;

  const syncPreview = () => {
    const line = editor.topLine();
    const list = anchors(pane);
    if (!list.length) return;
    let i = list.findIndex((a) => a.line > line);
    if (i === -1) i = list.length;
    const prev = list[i - 1] ?? { line: 0, top: 0 };
    const next = list[i] ?? { line: editor.view.state.doc.lines, top: pane.scrollHeight };
    const ratio = next.line === prev.line ? 0 : (line - prev.line) / (next.line - prev.line);
    pane.scrollTop = prev.top + (next.top - prev.top) * ratio;
  };

  editor.view.scrollDOM.addEventListener("scroll", () => {
    if (!enabled() || locked("editor")) return;
    lock("editor");
    syncPreview();
  });

  pane.addEventListener("scroll", () => {
    if (!enabled() || locked("preview")) return;
    lock("preview");
    const y = pane.scrollTop;
    const list = anchors(pane);
    if (!list.length) return;
    let i = list.findIndex((a) => a.top > y);
    if (i === -1) i = list.length;
    const prev = list[i - 1] ?? { line: 0, top: 0 };
    const next = list[i] ?? { line: editor.view.state.doc.lines, top: pane.scrollHeight };
    const ratio = next.top === prev.top ? 0 : (y - prev.top) / (next.top - prev.top);
    editor.scrollToLine(Math.round(prev.line + (next.line - prev.line) * ratio));
  });

  return () => {
    lock("editor");
    syncPreview();
  };
}
