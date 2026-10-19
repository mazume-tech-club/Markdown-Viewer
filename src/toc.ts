// ---------- 目次 ----------
// プレビューモードのとき、プレビューの左に見出し（# 〜 ###）の一覧を出す。
// スクロールしても残り、読んでいる章を色付けする。### は読んでいる ## の下だけ開く（長い索引があっても短く保つ）。
// 見出しが 2 つ未満の文書と、プレビューモード以外では出さない。出す・出さないは localStorage に覚える

export interface TocItem {
  level: number;
  text: string;
  id: string;
}

const VISIBLE_KEY = "toc.visible";

export const isTocEnabled = () => localStorage.getItem(VISIBLE_KEY) !== "0";

/**
 * 読んでいる見出しの番号。上端が threshold より上にある最後の見出し（どれも下なら最初の見出し）。
 * tops は見出しの上端の位置（上から順）
 */
export function currentIndex(tops: number[], threshold: number): number {
  let current = 0;
  tops.forEach((top, i) => {
    if (top <= threshold) current = i;
  });
  return current;
}

/**
 * 目次に出す見出しの番号。# と ## は常に出し、### は読んでいる見出しと同じ ## の下にあるものだけ出す
 * （## が無い文書では # の下）
 */
export function visibleItems(levels: number[], current: number): number[] {
  /** 見出し i が属する章（いちばん近い前の ## か #） */
  const sectionOf = (i: number) => {
    if (levels[i] <= 2) return i;
    for (let k = i - 1; k >= 0; k--) if (levels[k] <= 2) return k;
    return -1;
  };
  const open = sectionOf(current);
  return levels.flatMap((lv, i) => (lv <= 2 || sectionOf(i) === open ? [i] : []));
}

export interface TocOptions {
  preview: HTMLElement;
  pane: HTMLElement;
  nav: HTMLElement;
  isPreviewMode(): boolean;
  /** 出す・出さないが変わったとき（メニューのチェック用） */
  onChange(enabled: boolean): void;
}

export function setupToc(opts: TocOptions) {
  const { preview, pane, nav } = opts;
  let items: TocItem[] = [];
  let headings: HTMLElement[] = [];
  let links: HTMLAnchorElement[] = [];
  let current = -1;

  function show() {
    nav.hidden = !(isTocEnabled() && opts.isPreviewMode() && items.length >= 2);
  }

  /** 読んでいる見出しを決め直し、色付けと ### の開き方を変える */
  function track() {
    if (nav.hidden || !headings.length) return;
    const top = pane.getBoundingClientRect().top;
    const next = currentIndex(
      headings.map((h) => h.getBoundingClientRect().top - top),
      80,
    );
    if (next === current) return;
    current = next;
    const visible = new Set(visibleItems(items.map((it) => it.level), current));
    links.forEach((a, i) => {
      a.hidden = !visible.has(i);
      a.classList.toggle("current", i === current);
    });
    // 目次の側も、色付けした見出しが見える位置までスクロールする
    const a = links[current];
    const r = a.getBoundingClientRect();
    const box = nav.getBoundingClientRect();
    if (r.top < box.top || r.bottom > box.bottom) nav.scrollTop += r.top - box.top - box.height / 3;
  }

  /** プレビューを描き直したあとに、見出しを集め直す */
  function update() {
    headings = [...preview.querySelectorAll<HTMLElement>("h1[id], h2[id], h3[id]")];
    items = headings.map((h) => ({ level: Number(h.tagName[1]), text: h.textContent?.trim() ?? "", id: h.id }));
    links = items.map((it) => {
      const a = document.createElement("a");
      a.className = "toc-item";
      a.dataset.level = String(it.level);
      a.href = `#${encodeURIComponent(it.id)}`;
      a.textContent = it.text;
      a.title = it.text;
      return a;
    });
    nav.replaceChildren(...links);
    current = -1;
    show();
    track();
  }

  let frame = 0;
  pane.addEventListener("scroll", () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(track);
  });

  nav.addEventListener("click", (e) => {
    const a = (e.target as Element).closest<HTMLAnchorElement>("a.toc-item");
    if (!a) return;
    e.preventDefault();
    const i = links.indexOf(a);
    headings[i]?.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  function setEnabled(on: boolean) {
    localStorage.setItem(VISIBLE_KEY, on ? "1" : "0");
    show();
    current = -1;
    track();
    opts.onChange(on);
  }

  return {
    update,
    /** 表示モードが変わったとき */
    refresh() {
      show();
      current = -1;
      track();
    },
    toggle: () => setEnabled(!isTocEnabled()),
  };
}
