// ---------- PDF の割り付け（文字の大きさ・表を 1 ページに収める） ----------
//
// 印刷用 CSS（styles.css の @media print）が読む CSS 変数を、PDF を作る直前に入れる。
//   --pdf-scale … プレビュー全体の倍率（.markdown-body の zoom）
//   --pdf-fit   … 表ごとの縮小率（table の zoom）。縮める必要がない表には付けない
// 画面の表示には影響しない（変数を読むのは印刷用 CSS だけ）。

export interface PdfLayout {
  /** 全体の倍率（1 = 100%） */
  scale: number;
  /** はみ出す表を縮小して 1 ページに収めるか */
  fitTables: boolean;
}

export const PDF_SCALES = [1, 0.9, 0.8, 0.7, 0.6];

const SCALE_KEY = "pdf.scale";
const FIT_KEY = "pdf.fitTables";

/** 表をこれより小さくはしない。収まらない表は、幅はこの倍率で折り返し、縦はページをまたぐ */
export const MIN_TABLE_FIT = 0.5;

/** 用紙（A4。src-tauri の print_to_pdf で指定）から @page の余白（上下 15mm・左右 12mm）を引いた、本文が使える大きさ（CSS px） */
const MM = 96 / 25.4;
export const PAGE_AREA = { width: (210 - 2 * 12) * MM, height: (297 - 2 * 15) * MM };

export function loadPdfLayout(): PdfLayout {
  const scale = Number(localStorage.getItem(SCALE_KEY));
  return {
    scale: PDF_SCALES.includes(scale) ? scale : 1,
    fitTables: localStorage.getItem(FIT_KEY) !== "0",
  };
}

export function savePdfLayout(layout: PdfLayout) {
  localStorage.setItem(SCALE_KEY, String(layout.scale));
  localStorage.setItem(FIT_KEY, layout.fitTables ? "1" : "0");
}

/**
 * 表 1 つの縮小率を決める。
 * naturalWidth: 折り返さずに並べたときの幅 / heightAt(t): t 倍にして幅を area に収めたときの高さ（見た目の px）
 * 横は area の幅に収まるまで縮める。そのうえで縦が 1 ページを超え、MIN_TABLE_FIT 以上で収まるなら縦も収める
 */
export function tableFit(
  naturalWidth: number,
  heightAt: (t: number) => number,
  area: { width: number; height: number },
): number {
  let t = Math.min(1, Math.max(MIN_TABLE_FIT, area.width / naturalWidth));
  const h = heightAt(t);
  // 縮めるほど 1 行に入る文字が増えて行数は減るので、t * area.height / h まで縮めれば必ず収まる
  if (h > area.height) {
    const tall = (t * area.height) / h;
    if (tall >= MIN_TABLE_FIT) t = tall;
  }
  return Math.floor(t * 100) / 100;
}

/** PDF を作る直前に呼ぶ。preview は .markdown-body の要素 */
export function applyPdfLayout(preview: HTMLElement, layout: PdfLayout) {
  preview.style.setProperty("--pdf-scale", String(layout.scale));
  const tables = [...preview.querySelectorAll<HTMLTableElement>("table")];
  for (const table of tables) table.style.removeProperty("--pdf-fit");
  if (!layout.fitTables || tables.length === 0) return;

  // 印刷と同じ幅で並べ直して測る（測り終えるまで描画は挟まらないので、画面はちらつかない）
  const area = { width: PAGE_AREA.width / layout.scale, height: PAGE_AREA.height / layout.scale };
  preview.style.setProperty("--pdf-measure-width", `${area.width}px`);
  preview.classList.add("pdf-measure");
  try {
    for (const table of tables) {
      // リストや引用の中の表は、入れ物の幅に収める
      const width = Math.min(area.width, table.parentElement?.clientWidth || area.width);
      const natural = table.offsetWidth;
      const t = tableFit(
        natural,
        (t) => {
          // 印刷では表の幅は「中身の幅か入れ物の幅の狭いほう」。t 倍で入れ物が 1/t 倍に広がったのと同じ
          table.style.width = `${Math.min(natural, width / t)}px`;
          return table.offsetHeight * t;
        },
        { width, height: area.height },
      );
      table.style.width = "";
      if (t < 1) table.style.setProperty("--pdf-fit", String(t));
    }
  } finally {
    preview.classList.remove("pdf-measure");
    preview.style.removeProperty("--pdf-measure-width");
  }
}
