// 図のビルダー: フォームで図を作り、ライブプレビューを見ながら直して、エディタに挿入する画面。
// 図の種類ごとのフォーム（DiagramForm）を差し替えられる作り。今は C4 だけ（c4form.ts）

import { message } from "@tauri-apps/plugin-dialog";
import { renderDiagrams } from "../diagrams";
import { DIAGRAM_KINDS } from "../render";
import type { CodeBlock, Editor } from "../editor";
import { createC4Form } from "./c4form";

/** 図の種類ごとの入力フォーム */
export interface DiagramForm {
  /** 見出しに出す名前 */
  title: string;
  /** 書き出せる形式（コードブロックの言語名） */
  formats: { value: string; label: string }[];
  /** このフォームで読み込めるコードブロックか */
  accepts(lang: string, body: string): boolean;
  /** 読み込む（null なら新しい図の雛形） */
  load(body: string | null): void;
  /**
   * 画面に組み込む。form に入力欄、side に選択中の項目のパネル、bar にプレビュー上の道具を描く。
   * preview（プレビュー）のクリックやドラッグもフォームが受け持つ。内容が変わったら onChange を呼ぶ
   */
  mount(parts: { form: HTMLElement; side: HTMLElement; bar: HTMLElement; preview: HTMLElement }, onChange: () => void): void;
  setFormat(format: string): void;
  /** 今の内容のソース（コードブロックの中身） */
  code(): string;
  /** プレビューを描いた後（選択の強調など） */
  afterRender?(): void;
}

const FORMAT_KEY = "builder.format";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface Builder {
  open(): void;
  close(): void;
  isOpen(): boolean;
}

export function setupBuilder(opts: {
  editor: Editor;
  isDark: () => boolean;
  /** 編集できる状態か（更新のダウンロード中は false） */
  canEdit: () => boolean;
  /** エディタに挿入・置き換えした後（エディタを見えるようにするなど） */
  onApplied?: () => void;
}): Builder {
  const root = document.createElement("div");
  root.id = "builder";
  root.className = "builder";
  root.hidden = true;
  root.innerHTML = `
    <div class="builder-panel" role="dialog" aria-modal="true" aria-labelledby="builder-title">
      <div class="builder-head">
        <strong id="builder-title"></strong>
        <label>出力 <select class="b-format"></select></label>
        <span class="grow b-target"></span>
        <button class="primary b-apply"></button>
        <button class="b-close" title="閉じる (Esc)">閉じる</button>
      </div>
      <div class="builder-body">
        <div class="builder-form"></div>
        <div class="builder-side">
          <div class="b-preview-bar"></div>
          <div class="builder-preview markdown-body"></div>
          <div class="b-select"></div>
          <details class="b-code">
            <summary>生成されるコード</summary>
            <pre></pre>
          </details>
        </div>
      </div>
    </div>`;
  document.body.append(root);
  const q = <T extends Element>(s: string) => root.querySelector(s) as T;
  const titleEl = q<HTMLElement>("#builder-title");
  const formatSel = q<HTMLSelectElement>(".b-format");
  const targetEl = q<HTMLElement>(".b-target");
  const applyBtn = q<HTMLButtonElement>(".b-apply");
  const formEl = q<HTMLElement>(".builder-form");
  const previewEl = q<HTMLElement>(".builder-preview");
  const selectEl = q<HTMLElement>(".b-select");
  const barEl = q<HTMLElement>(".b-preview-bar");
  const codeEl = q<HTMLElement>(".b-code pre");

  const forms = [createC4Form()];
  let form = forms[0];
  /** 読み込んだコードブロック（置き換え先）。新しく作るときは null */
  let target: CodeBlock | null = null;
  let timer = 0;
  let gen = 0;

  function lang() {
    return formatSel.value;
  }

  /** プレビューと生成コードを描き直す（入力中は間引く） */
  function refresh(delay = 150) {
    clearTimeout(timer);
    timer = window.setTimeout(async () => {
      const code = form.code();
      codeEl.textContent = `\`\`\`${lang()}\n${code}\`\`\``;
      const kind = DIAGRAM_KINDS[lang()];
      const my = ++gen;
      previewEl.innerHTML = `<div class="diagram" data-kind="${kind}"><pre class="diagram-src">${esc(code)}</pre></div>`;
      await renderDiagrams(previewEl, opts.isDark(), () => my === gen && !root.hidden);
      if (my === gen) form.afterRender?.();
    }, delay);
  }

  formatSel.addEventListener("change", () => {
    localStorage.setItem(FORMAT_KEY, lang());
    form.setFormat(lang());
    refresh(0);
  });
  q<HTMLButtonElement>(".b-close").addEventListener("click", () => close());
  applyBtn.addEventListener("click", () => {
    if (!opts.canEdit()) return;
    const text = `\`\`\`${lang()}\n${form.code()}\`\`\``;
    if (target) opts.editor.replaceRange(target.from, target.to, text);
    else opts.editor.insert(text);
    close();
    opts.onApplied?.();
  });

  function open() {
    if (!opts.canEdit()) return;
    const block = opts.editor.blockAtCursor();
    const found = block ? forms.find((f) => f.accepts(block.lang, block.body)) : undefined;
    target = found ? block : null;
    form = found ?? forms[0];
    try {
      form.load(target ? target.body : null);
    } catch (err) {
      // 読めない図は直せないので、新しい図として開く
      target = null;
      form.load(null);
      void message(`カーソル位置の図を読み込めませんでした（新しい図として開きます）。\n${err instanceof Error ? err.message : err}`, {
        title: "図のビルダー",
        kind: "warning",
      });
    }
    titleEl.textContent = `図のビルダー（${form.title}）`;
    formatSel.replaceChildren(...form.formats.map((f) => new Option(f.label, f.value)));
    const saved = localStorage.getItem(FORMAT_KEY);
    formatSel.value = target ? target.lang : form.formats.some((f) => f.value === saved) ? saved! : form.formats[0].value;
    targetEl.textContent = target ? "カーソル位置の図を編集中" : "カーソル位置に新しい図を挿入します";
    applyBtn.textContent = target ? "置き換え" : "挿入";
    form.setFormat(lang());
    form.mount({ form: formEl, side: selectEl, bar: barEl, preview: previewEl }, () => refresh());
    root.hidden = false;
    refresh(0);
  }

  function close() {
    root.hidden = true;
    clearTimeout(timer);
    gen++;
    previewEl.replaceChildren();
    opts.editor.view.focus();
  }

  // 背景（パネルの外）をクリックしても閉じない（入力中の内容を失わないため）
  return { open, close, isOpen: () => !root.hidden };
}
