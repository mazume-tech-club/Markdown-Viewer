// ---------- AA の図（```bob / ```svgbob） ----------
// 罫線や記号で描いた図（ASCII アート）を svgbob で SVG にする（オプション機能「AA を図に」）。
// svgbob-wasm は WASM を ESM として import する作りで Vite がそのまま読めないので、
// WASM は JS に埋め込んで読み込み、グルー（文字列の受け渡し）はここで書く。
// CSP の connect-src で fetch できないため、URL ではなく埋め込みにしている。
// WASM は外から関数を受け取らない（imports が空）ので、これだけで動く

import wasmDataUrl from "svgbob-wasm/svgbob_wasm_bg.wasm?inline";

interface BobExports {
  memory: WebAssembly.Memory;
  render(retptr: number, ptr: number, len: number): void;
  __wbindgen_add_to_stack_pointer(delta: number): number;
  __wbindgen_malloc(size: number): number;
  __wbindgen_free(ptr: number, size: number): void;
}

let exportsP: Promise<BobExports> | null = null;

function load(): Promise<BobExports> {
  exportsP ??= (async () => {
    const base64 = wasmDataUrl.slice(wasmDataUrl.indexOf(",") + 1);
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return instance.exports as unknown as BobExports;
  })();
  return exportsP;
}

let seq = 0;

/**
 * svgbob の <style> の代わり。元の <style> は `line { … }` のようにページ全体に効くので、図の id に限る。
 * 線と文字は文字色にして、ダークテーマでも PDF（白地）でも読めるようにする。
 * 拡大ビューアは SVG を複製して出すので、外の CSS ではなく SVG の中に持たせる
 */
function scopedStyle(id: string): string {
  const s = `#${id}`;
  const markers = ["arrow", "diamond", "circle", "open_circle", "big_open_circle"]
    .flatMap((m) => [
      `${s} .end_marked_${m}{marker-end:url(#${m})}`,
      `${s} .start_marked_${m}{marker-start:url(#${m})}`,
    ])
    .join("");
  return (
    `<style>` +
    `${s} :is(line,path,circle,rect,polygon){stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:miter}` +
    `${s} :is(line,path){fill:none}` +
    `${s} :is(polygon,.filled){fill:currentColor}` +
    `${s} :is(.nofill,.bg_filled){fill:transparent}` +
    `${s} rect.backdrop{stroke:none;fill:transparent}` +
    `${s} .broken{stroke-dasharray:8}` +
    `${s} text{fill:currentColor;font-family:"Cascadia Mono",Consolas,"BIZ UDGothic",monospace;font-size:14px}` +
    markers +
    `</style>`
  );
}

/** AA を svgbob の SVG にする（中の <style> は図の中だけに効くものに差し替える） */
export async function renderBob(src: string): Promise<string> {
  const w = await load();
  const input = new TextEncoder().encode(src);
  const ptr = w.__wbindgen_malloc(input.length);
  new Uint8Array(w.memory.buffer, ptr, input.length).set(input);
  const ret = w.__wbindgen_add_to_stack_pointer(-16);
  try {
    w.render(ret, ptr, input.length);
    const [outPtr, outLen] = new Int32Array(w.memory.buffer, ret, 2);
    const svg = new TextDecoder().decode(new Uint8Array(w.memory.buffer, outPtr, outLen));
    w.__wbindgen_free(outPtr, outLen);
    const id = `bob-${++seq}`;
    return svg.replace(/<svg /, `<svg id="${id}" `).replace(/<style>[\s\S]*?<\/style>/, scopedStyle(id));
  } finally {
    w.__wbindgen_add_to_stack_pointer(16);
  }
}
