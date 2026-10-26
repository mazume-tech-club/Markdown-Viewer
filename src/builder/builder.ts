// 図のビルダー: フォームで図を作り、ライブプレビューを見ながら直して、エディタに挿入する画面。
// 図の種類ごとのフォーム（DiagramForm）を差し替えられる作り。C4（c4form.ts）と、
// オプション機能をオンにしたときだけガントチャート（ganttform.ts）

import { ask, message } from "@tauri-apps/plugin-dialog";
import { renderDiagrams } from "../diagrams";
import { diagramKind } from "../render";
import { changedRange, mergeChange } from "../textdiff";
import type { CodeBlock, Editor } from "../editor";
import { createC4Form } from "./c4form";
import { createGanttForm } from "./ganttform";

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
  /**
   * カーソル位置の図を開く（読めるフォームが無ければ新しい図）。form を指定したら、
   * カーソル位置がその種類の図でなければ、その種類の新しい図を開く
   */
  open(form?: "c4" | "gantt"): void;
  close(): void;
  isOpen(): boolean;
}

export function setupBuilder(opts: {
  editor: Editor;
  isDark: () => boolean;
  /** 編集できる状態か（更新のダウンロード中は false） */
  canEdit: () => boolean;
  /** ガントチャートのフォームを使うか（オプション機能がオンか） */
  ganttEnabled: () => boolean;
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

  const c4Form = createC4Form();
  let ganttForm: DiagramForm | null = null;
  /** 今使えるフォーム（先頭が既定） */
  const forms = () => {
    if (!opts.ganttEnabled()) return [c4Form];
    ganttForm ??= createGanttForm();
    return [c4Form, ganttForm];
  };
  let form = c4Form;
  /** 読み込んだコードブロック（置き換え先）。新しく作るときは null */
  let target: CodeBlock | null = null;
  /** 読み込んだときのコードブロックの文字（囲みの行も含む）。置き換えるとき、ほかの人の変更と分けるのに使う */
  let base = "";
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
      const kind = diagramKind(lang());
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
  applyBtn.addEventListener("click", async () => {
    if (!opts.canEdit()) return;
    const text = `\`\`\`${lang()}\n${form.code()}\`\`\``;
    if (target) {
      const blockLang = target.lang;
      // 開いている間に共同編集でほかの人が書いて位置がずれていることがあるので、カーソル位置のブロックを探し直す
      // （カーソルはほかの人の編集に合わせて動く）。見つからなければ、関係のない文を上書きしないよう置き換えない
      const findBlock = () => {
        const now = opts.editor.blockAtCursor();
        if (now && now.lang === blockLang) return { from: now.from, text: opts.editor.view.state.doc.sliceString(now.from, now.to) };
        void message("置き換える図が見つかりません（共同編集でほかの人が消したか、書き換えた可能性があります）。\n「生成されるコード」をコピーして貼り付けてください。", {
          title: "図のビルダー",
          kind: "warning",
        });
        return null;
      };
      let block = findBlock();
      if (!block) return;
      // 開いたときの内容・今の内容・ビルダーの内容を比べ、自分の変更だけを入れる（ほかの人が別の所に書いた分は残す）
      let change = mergeChange(base, block.text, text);
      if (change === "conflict") {
        const overwrite = await ask("開いている間に、ほかの人がこの図の同じ所を書き換えました。\nほかの人の変更を上書きして置き換えますか？", {
          title: "図のビルダー",
          kind: "warning",
        });
        // 確かめている間にも書き換わることがあるので、もう一度探す
        if (!overwrite || root.hidden || !(block = findBlock())) return;
        const r = changedRange(block.text, text);
        change = r && { from: r.start, to: r.oldEnd, insert: text.slice(r.start, r.newEnd) };
      }
      if (change) opts.editor.replaceRange(block.from + change.from, block.from + change.to, change.insert);
    } else {
      // カーソルが別のコードブロックの中なら、ブロックを壊さないようその後ろに入れる
      const inside = opts.editor.blockAtCursor();
      if (inside) opts.editor.view.dispatch({ selection: { anchor: inside.to } });
      opts.editor.insert(text);
    }
    close();
    opts.onApplied?.();
  });

  function open(kind?: "c4" | "gantt") {
    if (!opts.canEdit()) return;
    const list = forms();
    const wanted = kind === "gantt" ? ganttForm : kind === "c4" ? c4Form : null;
    if (kind === "gantt" && !list.includes(ganttForm!)) return;
    const block = opts.editor.blockAtCursor();
    const found = block ? list.find((f) => f.accepts(block.lang, block.body)) : undefined;
    target = found && (!wanted || found === wanted) ? block : null;
    base = target ? opts.editor.view.state.doc.sliceString(target.from, target.to) : "";
    form = (target ? found : wanted) ?? list[0];
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
