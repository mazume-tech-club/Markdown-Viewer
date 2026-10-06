// 注釈エディタ: カーソル位置の画像に、矢印・テキスト・枠・番号をドラッグで描く画面。
// 適用すると、注釈を焼き込んだ PNG を元画像の隣に書き出し、MD の画像を
// 「![alt](焼き込み画像)」＋「<!-- annotate {...} -->」に置き換える（annotations.ts 参照）

import { message } from "@tauri-apps/plugin-dialog";
import type { Editor, ImageRef } from "../editor";
import {
  type Annotation,
  type Item,
  type Pt,
  DEFAULT_COLOR,
  bake,
  bakedPathOf,
  defaultFont,
  defaultNumSize,
  defaultStroke,
  itemSvg,
  parseAnnotation,
  serializeAnnotation,
  unitOf,
} from "../annotations";
import { dirname, hasScheme, resolvePath } from "../paths";

type Tool = "select" | "arrow" | "text" | "box" | "num";

const TOOL_HINT: Record<Tool, string> = {
  select: "図形をクリックで選択、ドラッグで移動。矢印の端・枠の角の ● で形を変えます。",
  arrow: "矢印の根元から先端へドラッグします。",
  text: "文字を置く位置をクリックし、右の欄に入力します。",
  box: "囲む範囲をドラッグします。",
  num: "クリックした位置に番号を置きます（続けて置くと 1, 2, 3…）。",
};
const TOOL_KEYS: Record<string, Tool> = { v: "select", a: "arrow", t: "text", r: "box", n: "num" };
const COLOR_KEY = "annotate.color";

export interface AnnotatorOptions {
  editor: Editor;
  /** 編集できる状態か（更新のダウンロード中は false） */
  canEdit: () => boolean;
  /** 表示中の MD のパス（未保存なら null） */
  mdPath: () => string | null;
  readBinary: (path: string) => Promise<Uint8Array>;
  /** ファイルがあるか（焼き込み画像の空いている名前を探すため） */
  exists: (path: string) => Promise<boolean>;
  /** 保存待ちの画像（貼り付けた画像・焼き込み画像）のバイト列。rel は MD からの相対パスで %xx は戻したもの */
  pendingBytes: (rel: string) => Uint8Array | null;
  /** 焼き込み画像を保存待ちに登録する（MD を保存したときに書き出す）。link は MD に書くリンク */
  addPending: (rel: string, link: string, bytes: Uint8Array) => void;
  /** MD を書き換えた後（エディタを見えるようにするなど） */
  onApplied?: () => void;
}

export interface Annotator {
  open(): Promise<void>;
  close(): void;
  isOpen(): boolean;
}

const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
/** リンクに書かれたパス → MD からの相対パス（?# 以降を除き、%xx を戻す。保存待ちの画像のキーと同じ形） */
const relOf = (link: string) => safeDecode(link.split(/[?#]/)[0]);
/** リンクに書くパス（空白を含むなら <> で囲む） */
const linkOf = (s: string) => (/\s/.test(s) ? `<${s}>` : s);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

export function setupAnnotator(opts: AnnotatorOptions): Annotator {
  const root = document.createElement("div");
  root.id = "annotator";
  root.className = "builder annotator";
  root.hidden = true;
  root.innerHTML = `
    <div class="builder-panel" role="dialog" aria-modal="true" aria-labelledby="annot-title">
      <div class="builder-head">
        <strong id="annot-title">画像の注釈</strong>
        <span class="grow a-file"></span>
        <button class="primary a-apply" title="注釈入りの画像を書き出し、MD を書き換えます">適用</button>
        <button class="a-close" title="閉じる (Esc)">閉じる</button>
      </div>
      <div class="annotator-body">
        <div class="a-stage">
          <div class="a-canvas">
            <img class="a-img" alt="" draggable="false" />
            <svg class="a-svg"></svg>
          </div>
        </div>
        <div class="a-side">
          <div class="segmented a-tools" role="group" aria-label="道具">
            <button data-tool="select" title="選択・移動 (V)">選択</button>
            <button data-tool="arrow" title="矢印 (A)">矢印</button>
            <button data-tool="text" title="テキスト (T)">テキスト</button>
            <button data-tool="box" title="四角の枠 (R)">枠</button>
            <button data-tool="num" title="番号 (N)">番号</button>
          </div>
          <p class="b-note a-hint"></p>
          <div class="a-props">
            <label class="a-row">色 <input type="color" class="a-color" /></label>
            <label class="a-row a-size-row"><span class="a-size-label">大きさ</span> <input type="number" class="a-size" min="1" max="999" /></label>
            <label class="a-col a-text-row">テキスト（改行可）<textarea class="a-text" rows="3"></textarea></label>
            <label class="a-row a-bg-row"><input type="checkbox" class="a-bg" /> 背景を白で塗る</label>
            <label class="a-row a-num-row">番号 <input type="number" class="a-num" min="0" max="999" /></label>
            <button class="a-delete" title="選んでいる図形を削除 (Delete)">削除</button>
          </div>
          <h4>図形</h4>
          <ol class="a-list"></ol>
          <p class="b-note">Ctrl+Z で元に戻す。矢印キーで 1px（Shift で 10px）動かせます。</p>
        </div>
      </div>
    </div>`;
  document.body.append(root);
  const q = <T extends Element>(s: string) => root.querySelector(s) as T;
  const fileEl = q<HTMLElement>(".a-file");
  const applyBtn = q<HTMLButtonElement>(".a-apply");
  const img = q<HTMLImageElement>(".a-img");
  const svg = q<SVGSVGElement>(".a-svg");
  const hint = q<HTMLElement>(".a-hint");
  const props = q<HTMLElement>(".a-props");
  const colorIn = q<HTMLInputElement>(".a-color");
  const sizeRow = q<HTMLElement>(".a-size-row");
  const sizeLabel = q<HTMLElement>(".a-size-label");
  const sizeIn = q<HTMLInputElement>(".a-size");
  const textRow = q<HTMLElement>(".a-text-row");
  const textIn = q<HTMLTextAreaElement>(".a-text");
  const bgRow = q<HTMLElement>(".a-bg-row");
  const bgIn = q<HTMLInputElement>(".a-bg");
  const numRow = q<HTMLElement>(".a-num-row");
  const numIn = q<HTMLInputElement>(".a-num");
  const list = q<HTMLOListElement>(".a-list");

  /** 編集中の画像（MD 上の位置）と、開いたときのその部分の文字列（書き換え前の確認用） */
  let ref: ImageRef | null = null;
  let refText = "";
  /** 既存の注釈の焼き込み画像（MD のリンクのまま）。新しく注釈するときは null（適用時に空いている名前を探す） */
  let bakedLink: string | null = null;
  let annot: Annotation = { src: "", size: [1, 1], items: [] };
  let original: Blob | null = null;
  let objectUrl = "";
  let selected: number | null = null;
  let tool: Tool = "select";
  /** 元に戻す用の履歴（変更前の items） */
  let history: string[] = [];
  let color = localStorage.getItem(COLOR_KEY) || DEFAULT_COLOR;

  const size = () => annot.size;
  const sel = (): Item | null => (selected === null ? null : (annot.items[selected] ?? null));
  const pushHistory = () => {
    history.push(JSON.stringify(annot.items));
    if (history.length > 100) history.shift();
  };

  // ---- 描画 ----

  /** 画面上の 1px が画像の何 px か（つまみの大きさを画面上で一定にするため） */
  const pxPerScreen = () => {
    const ctm = svg.getScreenCTM();
    return ctm && ctm.a ? 1 / ctm.a : 1;
  };

  function handle(p: Pt, name: string) {
    const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    c.setAttribute("cx", String(p[0]));
    c.setAttribute("cy", String(p[1]));
    c.setAttribute("r", String(6 * pxPerScreen()));
    c.setAttribute("class", "a-handle");
    c.dataset.h = name;
    return c;
  }

  function render() {
    svg.setAttribute("viewBox", `0 0 ${size()[0]} ${size()[1]}`);
    svg.setAttribute("preserveAspectRatio", "none");
    const groups = annot.items.map((item, i) => {
      const g = itemSvg(item, size(), true);
      g.dataset.i = String(i);
      g.classList.add("a-item");
      return g;
    });
    svg.replaceChildren(...groups);
    const item = sel();
    if (item && selected !== null) {
      const g = groups[selected];
      if (item.t === "arrow") svg.append(handle(item.from, "from"), handle(item.to, "to"));
      else if (item.t === "box") {
        const [x, y, w, h] = item.rect;
        svg.append(handle([x, y], "nw"), handle([x + w, y], "ne"), handle([x, y + h], "sw"), handle([x + w, y + h], "se"));
      } else {
        // テキスト・番号は選択枠だけ（移動のみ）
        const b = g.getBBox();
        const pad = 4 * pxPerScreen();
        const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        r.setAttribute("x", String(b.x - pad));
        r.setAttribute("y", String(b.y - pad));
        r.setAttribute("width", String(b.width + pad * 2));
        r.setAttribute("height", String(b.height + pad * 2));
        r.setAttribute("class", "a-sel-box");
        r.setAttribute("stroke-width", String(1.5 * pxPerScreen()));
        svg.append(r);
      }
    }
    renderSide();
  }

  const LABEL: Record<Item["t"], string> = { arrow: "矢印", text: "テキスト", box: "枠", num: "番号" };

  function renderSide() {
    for (const b of root.querySelectorAll<HTMLButtonElement>("[data-tool]")) b.classList.toggle("active", b.dataset.tool === tool);
    hint.textContent = TOOL_HINT[tool];
    svg.classList.toggle("a-drawing", tool !== "select");
    const item = sel();
    colorIn.value = item?.color ?? color;
    sizeRow.hidden = textRow.hidden = bgRow.hidden = numRow.hidden = true;
    q<HTMLButtonElement>(".a-delete").hidden = !item;
    if (item) {
      sizeRow.hidden = false;
      if (item.t === "arrow" || item.t === "box") {
        sizeLabel.textContent = "線の太さ";
        sizeIn.value = String(item.width ?? defaultStroke(size()));
      } else if (item.t === "text") {
        sizeLabel.textContent = "文字の大きさ";
        sizeIn.value = String(item.size ?? defaultFont(size()));
        textRow.hidden = bgRow.hidden = false;
        if (document.activeElement !== textIn) textIn.value = item.text;
        bgIn.checked = !!item.bg;
      } else {
        sizeLabel.textContent = "丸の大きさ";
        sizeIn.value = String(item.size ?? defaultNumSize(size()));
        numRow.hidden = false;
        numIn.value = String(item.n);
      }
    }
    props.classList.toggle("a-none", !item);
    list.replaceChildren(
      ...annot.items.map((it, i) => {
        const li = document.createElement("li");
        li.dataset.i = String(i);
        li.classList.toggle("selected", i === selected);
        const detail = it.t === "text" ? `: ${it.text.split("\n")[0]}` : it.t === "num" ? ` ${it.n}` : "";
        li.textContent = `${LABEL[it.t]}${detail}`;
        const x = document.createElement("button");
        x.textContent = "×";
        x.title = "削除";
        x.className = "a-list-del";
        li.append(x);
        return li;
      }),
    );
  }

  // ---- 編集 ----

  /** 画面の座標 → 画像の座標（画像の外は端にそろえる） */
  function toImage(e: { clientX: number; clientY: number }): Pt {
    const ctm = svg.getScreenCTM();
    if (!ctm) return [0, 0];
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return [Math.min(size()[0], Math.max(0, p.x)), Math.min(size()[1], Math.max(0, p.y))];
  }

  function moveItem(item: Item, dx: number, dy: number) {
    const add = (p: Pt): Pt => [p[0] + dx, p[1] + dy];
    if (item.t === "arrow") {
      item.from = add(item.from);
      item.to = add(item.to);
    } else if (item.t === "box") {
      item.rect = [item.rect[0] + dx, item.rect[1] + dy, item.rect[2], item.rect[3]];
    } else item.at = add(item.at);
  }

  const rectFrom = (a: Pt, b: Pt): [number, number, number, number] => [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.abs(a[0] - b[0]),
    Math.abs(a[1] - b[1]),
  ];

  function select(i: number | null) {
    selected = i;
    render();
  }

  function setTool(t: Tool) {
    tool = t;
    renderSide();
  }

  function remove(i: number) {
    pushHistory();
    annot.items.splice(i, 1);
    selected = null;
    render();
  }

  function undo() {
    const prev = history.pop();
    if (!prev) return;
    annot.items = JSON.parse(prev);
    selected = null;
    render();
  }

  const nextNum = () => annot.items.reduce((n, it) => (it.t === "num" ? Math.max(n, it.n) : n), 0) + 1;

  /** ドラッグを始める。onMove は押した位置からの移動量と今の位置を受け取る */
  function drag(e: PointerEvent, onMove: (p: Pt, start: Pt) => void, onEnd?: (moved: boolean) => void) {
    const start = toImage(e);
    let moved = false;
    svg.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const p = toImage(ev);
      // 4px（画面上）までの揺れはクリックとみなす
      if (!moved && Math.hypot(p[0] - start[0], p[1] - start[1]) < 4 * pxPerScreen()) return;
      moved = true;
      onMove(p, start);
      render();
    };
    const up = () => {
      svg.removeEventListener("pointermove", move);
      svg.removeEventListener("pointerup", up);
      svg.removeEventListener("pointercancel", up);
      onEnd?.(moved);
      render();
    };
    svg.addEventListener("pointermove", move);
    svg.addEventListener("pointerup", up);
    svg.addEventListener("pointercancel", up);
  }

  svg.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const target = e.target as Element;
    const p = toImage(e);
    const u = unitOf(size());
    if (tool === "select") {
      const h = target.closest<SVGElement>("[data-h]")?.dataset.h;
      const item = sel();
      if (h && item) {
        pushHistory();
        if (item.t === "arrow") drag(e, (q) => (h === "from" ? (item.from = q) : (item.to = q)));
        else if (item.t === "box") {
          const [x, y, w, bh] = item.rect;
          // 動かす角の反対側を固定する
          const fixed: Pt = [h.includes("w") ? x + w : x, h.includes("n") ? y + bh : y];
          drag(e, (q) => (item.rect = rectFrom(fixed, q)));
        }
        return;
      }
      const g = target.closest<SVGElement>("[data-i]");
      if (!g) return select(null);
      select(Number(g.dataset.i));
      const it = sel()!;
      let last = p;
      let saved = false;
      drag(e, (q) => {
        if (!saved) {
          pushHistory();
          saved = true;
        }
        moveItem(it, q[0] - last[0], q[1] - last[1]);
        last = q;
      });
      return;
    }
    pushHistory();
    if (tool === "arrow" || tool === "box") {
      const item: Item =
        tool === "arrow"
          ? { t: "arrow", from: p, to: p, color, width: defaultStroke(size()) }
          : { t: "box", rect: [p[0], p[1], 0, 0], color, width: defaultStroke(size()) };
      annot.items.push(item);
      selected = annot.items.length - 1;
      drag(
        e,
        (q, start) => {
          if (item.t === "arrow") item.to = q;
          else if (item.t === "box") item.rect = rectFrom(start, q);
        },
        (moved) => {
          // ドラッグしなかった（クリックだけ）なら作らない
          if (!moved || (item.t === "box" && (item.rect[2] < 4 * u || item.rect[3] < 4 * u))) {
            annot.items.pop();
            history.pop();
            selected = null;
          } else tool = "select";
        },
      );
    } else if (tool === "text") {
      annot.items.push({ t: "text", at: p, text: "コメント", size: defaultFont(size()), color });
      selected = annot.items.length - 1;
      tool = "select";
      render();
      textIn.focus();
      textIn.select();
    } else if (tool === "num") {
      annot.items.push({ t: "num", at: p, n: nextNum(), size: defaultNumSize(size()), color });
      selected = annot.items.length - 1;
      render();
    }
  });

  // ---- 右側の欄 ----

  for (const b of root.querySelectorAll<HTMLButtonElement>("[data-tool]")) {
    b.addEventListener("click", () => setTool(b.dataset.tool as Tool));
  }

  /** 入力欄で変更するときは、最初の 1 回だけ履歴に積む（1 文字ごとに戻らないように） */
  let editing = false;
  for (const input of [colorIn, sizeIn, textIn, numIn]) {
    input.addEventListener("focus", () => (editing = false));
  }
  const edit = (fn: (item: Item) => void) => {
    const item = sel();
    if (!item) return;
    if (!editing) {
      pushHistory();
      editing = true;
    }
    fn(item);
    render();
  };

  colorIn.addEventListener("input", () => {
    color = colorIn.value;
    localStorage.setItem(COLOR_KEY, color);
    edit((item) => (item.color = color));
  });
  sizeIn.addEventListener("input", () => {
    const v = Number(sizeIn.value);
    if (!(v > 0)) return;
    edit((item) => {
      if (item.t === "arrow" || item.t === "box") item.width = v;
      else item.size = v;
    });
  });
  textIn.addEventListener("input", () => edit((item) => item.t === "text" && (item.text = textIn.value)));
  bgIn.addEventListener("change", () => {
    editing = false;
    edit((item) => {
      if (item.t === "text") item.bg = bgIn.checked || undefined;
    });
  });
  numIn.addEventListener("input", () => {
    const v = Number(numIn.value);
    if (Number.isInteger(v)) edit((item) => item.t === "num" && (item.n = v));
  });
  q<HTMLButtonElement>(".a-delete").addEventListener("click", () => selected !== null && remove(selected));
  list.addEventListener("click", (e) => {
    const li = (e.target as Element).closest<HTMLElement>("li");
    if (!li) return;
    const i = Number(li.dataset.i);
    if ((e.target as Element).closest(".a-list-del")) remove(i);
    else select(i);
  });

  // キー操作（入力欄の中では、その欄の操作を優先する。Esc はメイン画面の keydown が閉じる）
  root.addEventListener("keydown", (e) => {
    const typing = (e.target as Element).closest("input, textarea, select");
    if (typing) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      return undo();
    }
    if (mod || e.altKey) return;
    const item = sel();
    if ((e.key === "Delete" || e.key === "Backspace") && selected !== null) {
      e.preventDefault();
      return remove(selected);
    }
    const step = e.shiftKey ? 10 : 1;
    const nudge: Record<string, Pt> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (item && nudge[e.key]) {
      e.preventDefault();
      pushHistory();
      moveItem(item, ...nudge[e.key]);
      return render();
    }
    const t = TOOL_KEYS[e.key.toLowerCase()];
    if (t) {
      e.preventDefault();
      setTool(t);
    }
  });

  // ---- 開く・適用・閉じる ----

  const warn = (msg: string) => message(msg, { title: "画像の注釈", kind: "warning" });

  async function open() {
    if (!opts.canEdit()) return;
    const r = opts.editor.imageAtCursor();
    if (!r) return void (await warn("カーソルを画像（![説明](画像のパス)）の行に置いてから開いてください。"));
    if (r.laterImage) return void (await warn("注釈は、行の最後の画像にだけ付けられます。画像を別々の行に分けてください。"));
    const existing = r.annotate ? parseAnnotation(r.annotate) : null;
    if (r.annotate && !existing) return void (await warn("この画像の注釈（<!-- annotate ... -->）を読み込めませんでした。書き方を確認してください。"));
    const src = existing?.src ?? r.src;
    if (hasScheme(src) || src.startsWith("//")) return void (await warn("URL の画像には注釈を付けられません。画像をダウンロードして、相対パスで参照してください。"));
    // 貼り付けたばかりの画像は、保存前でもメモリにあるものを使う（Excel のように、保存せずに注釈できる）
    let bytes = opts.pendingBytes(relOf(src));
    if (!bytes) {
      const md = opts.mdPath();
      if (!md) {
        return void (await warn("この画像は MD からの相対パスで探すため、先に MD を保存してください（貼り付けた画像なら、保存前でも注釈できます）。"));
      }
      try {
        bytes = await opts.readBinary(resolvePath(dirname(md), relOf(src)));
      } catch (err) {
        return void (await warn(`画像を読み込めませんでした。\n${err}`));
      }
    }
    original = new Blob([bytes as BlobPart]);
    let imgSize: Pt;
    try {
      const bmp = await createImageBitmap(original);
      imgSize = [bmp.width, bmp.height];
      bmp.close();
    } catch {
      return void (await warn("画像として読み込めませんでした（PNG・JPEG・GIF・WebP などに対応しています）。"));
    }
    ref = r;
    refText = opts.editor.view.state.doc.sliceString(r.from, r.end);
    // 注釈を直すときは、MD に書かれている焼き込み画像の名前を使い続ける
    // （手で書いたなどで、リンクが元画像そのものや PNG 以外を指していたら、元画像を壊さないよう新しい名前にする）
    bakedLink = existing && r.src !== existing.src && /\.png$/i.test(r.src.split(/[?#]/)[0]) ? r.src : null;
    // 元画像を差し替えて大きさが変わっていたら、注釈も同じ割合で引き伸ばす
    const items = existing ? clone(existing.items) : [];
    if (existing && (existing.size[0] !== imgSize[0] || existing.size[1] !== imgSize[1])) {
      const sx = imgSize[0] / existing.size[0];
      const sy = imgSize[1] / existing.size[1];
      for (const it of items) {
        if (it.t === "arrow") {
          it.from = [it.from[0] * sx, it.from[1] * sy];
          it.to = [it.to[0] * sx, it.to[1] * sy];
        } else if (it.t === "box") it.rect = [it.rect[0] * sx, it.rect[1] * sy, it.rect[2] * sx, it.rect[3] * sy];
        else it.at = [it.at[0] * sx, it.at[1] * sy];
      }
    }
    annot = { src, size: imgSize, items };
    selected = null;
    history = [];
    tool = items.length ? "select" : "arrow";
    fileEl.textContent = safeDecode(src);
    URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(original);
    img.src = objectUrl;
    root.hidden = false;
    await img.decode().catch(() => undefined);
    render();
    root.focus();
  }

  async function apply() {
    if (!ref || !original || !opts.canEdit()) return;
    const md = opts.mdPath();
    const doc = opts.editor.view.state.doc;
    // 開いている間に MD が書き換わった（外部での変更の再読み込みなど）なら、位置がずれているので書かない
    if (ref.end > doc.length || doc.sliceString(ref.from, ref.end) !== refText) {
      await warn("注釈エディタを開いている間に MD が変更されたため、適用できませんでした。閉じてからもう一度開いてください。");
      return;
    }
    applyBtn.disabled = true;
    try {
      const rest = doc.sliceString(ref.to, ref.lineEnd);
      let text: string;
      if (!annot.items.length) {
        // 注釈を全部消したら、元画像の参照に戻す（焼き込み画像のファイルは残す）
        text = `![${ref.alt}](${linkOf(annot.src)})${rest}`;
      } else {
        let baked = bakedLink;
        // 初めての適用: 保存待ちにもディスクにもない名前を選ぶ（残っている焼き込み画像は、どこかで使われているかもしれないので上書きしない）
        const taken = async (link: string) =>
          !!opts.pendingBytes(relOf(link)) || (!!md && (await opts.exists(resolvePath(dirname(md), relOf(link)))));
        for (let k = 1; !baked; k++) {
          const candidate = bakedPathOf(annot.src, k);
          if (!(await taken(candidate))) baked = candidate;
          if (k >= 999) throw new Error("焼き込み画像の空いている名前が見つかりませんでした");
        }
        // ディスクにはまだ書かない（貼り付け画像と同じく、MD を保存したときに書き出す）
        opts.addPending(relOf(baked), baked, await bake(original, annot));
        text = `![${ref.alt}](${linkOf(baked)})${rest}\n<!-- annotate ${serializeAnnotation(annot)} -->`;
      }
      opts.editor.replaceRange(ref.from, ref.end, text);
      close();
      opts.onApplied?.();
    } catch (err) {
      await warn(`適用できませんでした。\n${err instanceof Error ? err.message : err}`);
    } finally {
      applyBtn.disabled = false;
    }
  }

  function close() {
    root.hidden = true;
    URL.revokeObjectURL(objectUrl);
    objectUrl = "";
    img.removeAttribute("src");
    original = null;
    ref = null;
    opts.editor.view.focus();
  }

  root.tabIndex = -1;
  applyBtn.addEventListener("click", () => void apply());
  q<HTMLButtonElement>(".a-close").addEventListener("click", () => close());
  // 背景（パネルの外）をクリックしても閉じない（描いた内容を失わないため）
  return { open, close, isOpen: () => !root.hidden };
}
