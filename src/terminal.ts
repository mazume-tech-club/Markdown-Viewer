import { Channel, invoke } from "@tauri-apps/api/core";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ITheme, Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { darkQuery } from "./theme";

// ---------- 組み込みターミナル ----------
// シェル（PowerShell）を ConPTY で動かし、xterm.js で表示する（Rust 側は src-tauri/src/terminal.rs）。
// 作業フォルダで claude を起動して md を書き換えると、ファイルの監視でプレビューがそのまま更新される。
// パネルは下か右に置ける。閉じてもシェルは動かしたままにし、次に開いたときに続きから使う。
// 開閉・位置・大きさは localStorage に保存し、次回の起動時に戻す

export type TermPosition = "bottom" | "right";

const OPEN_KEY = "term.open";
const POSITION_KEY = "term.position";
const SIZE_KEY = { bottom: "term.height", right: "term.width" } as const;
const DEFAULT_SIZE = { bottom: 260, right: 520 } as const;
const MIN_SIZE = 120;

export const getTermPosition = (): TermPosition => (localStorage.getItem(POSITION_KEY) === "right" ? "right" : "bottom");

type TermEvent = { kind: "data"; data: string } | { kind: "exit"; code: number | null };

// 文字色は GitHub のライト / ダークに合わせる（xterm の既定はダーク向けで、ライトの背景では黄色などが読めない）
const LIGHT: ITheme = {
  background: "#ffffff",
  foreground: "#1f2328",
  cursor: "#1f2328",
  selectionBackground: "#0969da40",
  black: "#24292f",
  red: "#cf222e",
  green: "#116329",
  yellow: "#4d2d00",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#633c01",
  brightBlue: "#218bff",
  brightMagenta: "#a475f9",
  brightCyan: "#3192aa",
  brightWhite: "#8c959f",
};
const DARK: ITheme = {
  background: "#0d1117",
  foreground: "#f0f6fc",
  cursor: "#f0f6fc",
  selectionBackground: "#4493f855",
  black: "#484f58",
  red: "#ff7b72",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#b1bac4",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#ffffff",
};

export interface TerminalOptions {
  /** シェルを起動するフォルダ（作業フォルダ・開いているファイルのフォルダ）。null ならホーム */
  cwd(): string | null;
  /** 選択で自動コピー・右クリックで貼り付け（設定と共通） */
  selectCopy(): boolean;
  notify(text: string): void;
  onError(err: unknown): void;
  /** パネルにフォーカスがあるまま閉じたとき（エディタかプレビューへ戻す） */
  onClose(): void;
  onChange(open: boolean, position: TermPosition): void;
}

export function setupTerminal(opts: TerminalOptions) {
  const $ = (id: string) => document.getElementById(id)!;
  const workspace = $("workspace");
  const panel = $("term");
  const divider = $("term-divider");
  const view = $("term-view");
  const cwdLabel = $("term-cwd");
  const toggleBtn = $("btn-term");
  const positionBtn = $("term-position");

  let position = getTermPosition();
  let term: Terminal | null = null;
  let fit: (() => void) | null = null;
  /** 動いているシェルの番号。終了したら null */
  let session: number | null = null;
  /** シェルが終了して、Enter で起動し直すのを待っている */
  let exited = false;
  let starting: Promise<void> | null = null;

  const isOpen = () => !panel.hidden;
  const notifyChange = () => opts.onChange(isOpen(), position);

  // ---- 位置と大きさ ----

  function applyLayout() {
    workspace.dataset.term = position;
    divider.setAttribute("aria-orientation", position === "bottom" ? "horizontal" : "vertical");
    const size = Number(localStorage.getItem(SIZE_KEY[position])) || DEFAULT_SIZE[position];
    workspace.style.setProperty("--term-size", `${size}px`);
    positionBtn.textContent = position === "bottom" ? "右へ" : "下へ";
    positionBtn.title = position === "bottom" ? "パネルを右に置く" : "パネルを下に置く";
  }

  function setPosition(next: TermPosition) {
    position = next;
    localStorage.setItem(POSITION_KEY, next);
    applyLayout();
    notifyChange();
  }

  divider.addEventListener("pointerdown", (e) => {
    divider.setPointerCapture(e.pointerId);
    const box = workspace.getBoundingClientRect();
    const filesWidth = $("files").hidden ? 0 : $("files").getBoundingClientRect().width + 5;
    let size = panel.getBoundingClientRect()[position === "bottom" ? "height" : "width"];
    const move = (ev: PointerEvent) => {
      const raw = position === "bottom" ? box.bottom - ev.clientY : box.right - filesWidth - ev.clientX;
      const max = (position === "bottom" ? box.height : box.width - filesWidth) - MIN_SIZE;
      size = Math.round(Math.min(max, Math.max(MIN_SIZE, raw)));
      workspace.style.setProperty("--term-size", `${size}px`);
    };
    const up = () => {
      divider.removeEventListener("pointermove", move);
      localStorage.setItem(SIZE_KEY[position], String(size));
    };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", up, { once: true });
  });

  // ---- xterm ----

  const theme = () => (darkQuery.matches ? DARK : LIGHT);
  darkQuery.addEventListener("change", () => {
    if (term) term.options.theme = theme();
  });

  /** 初めて開いたときに xterm を読み込む（使わない人の起動を遅くしないため） */
  async function createTerm(): Promise<Terminal> {
    const [{ Terminal }, { FitAddon }, { Unicode11Addon }, { WebLinksAddon }] = await Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/addon-unicode11"),
      import("@xterm/addon-web-links"),
    ]);
    const t = new Terminal({
      fontFamily: '"Cascadia Mono", Consolas, "BIZ UDGothic", monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      theme: theme(),
    });
    const fitAddon = new FitAddon();
    t.loadAddon(fitAddon);
    t.loadAddon(new Unicode11Addon());
    t.unicode.activeVersion = "11";
    t.loadAddon(new WebLinksAddon((_e, url) => void openUrl(url).catch(opts.onError)));
    t.open(view);

    t.onData((data) => {
      if (exited) {
        if (data === "\r") void restart();
        return;
      }
      if (session !== null) invoke("term_write", { id: session, data }).catch(opts.onError);
    });

    t.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const mod = e.ctrlKey && !e.altKey && !e.metaKey;
      // 選択中の Ctrl+C はコピー（選択がなければ中断としてシェルへ送る）
      if (mod && !e.shiftKey && e.key === "c" && t.hasSelection()) {
        void writeText(t.getSelection()).catch(opts.onError);
        t.clearSelection();
        return false;
      }
      // Ctrl+V はブラウザの貼り付けに任せる（xterm が paste イベントで受け取る）
      if (mod && e.key.toLowerCase() === "v") return false;
      // Shift+Enter は改行の入力（claude の複数行入力。VS Code の /terminal-setup と同じ送り方）
      if (e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.altKey) {
        if (session !== null && !exited) invoke("term_write", { id: session, data: "\x1b\r" }).catch(opts.onError);
        return false;
      }
      return true;
    });

    // 選択で自動コピー・右クリックで貼り付け（エディタと同じ設定に従う）
    view.addEventListener("mouseup", (e) => {
      if (e.button !== 0 || !opts.selectCopy()) return;
      setTimeout(() => {
        if (!t.hasSelection()) return;
        writeText(t.getSelection()).then(() => opts.notify("選択をコピーしました"), opts.onError);
      });
    });
    view.addEventListener("contextmenu", (e) => {
      if (!opts.selectCopy()) return;
      e.preventDefault();
      readText()
        .then((text) => text && t.paste(text))
        .catch(() => opts.notify("貼り付けられる文字がありません"));
    });

    let frame = 0;
    fit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!isOpen() || view.clientWidth === 0 || view.clientHeight === 0) return;
        fitAddon.fit();
        if (session !== null) invoke("term_resize", { id: session, cols: t.cols, rows: t.rows }).catch(() => {});
      });
    };
    new ResizeObserver(() => fit?.()).observe(view);
    return t;
  }

  async function spawn(t: Terminal) {
    const cwd = opts.cwd();
    cwdLabel.textContent = cwd ?? "";
    cwdLabel.title = cwd ?? "";
    const channel = new Channel<TermEvent>();
    let id: number | null = null;
    channel.onmessage = (ev) => {
      if (ev.kind === "data") t.write(ev.data);
      else if (id === session) {
        session = null;
        exited = true;
        const code = ev.code === null ? "" : `（終了コード ${ev.code}）`;
        t.write(`\r\n\x1b[90mシェルが終了しました${code}。Enter で起動し直します\x1b[0m\r\n`);
      }
    };
    exited = false;
    id = await invoke<number>("term_spawn", { cwd, cols: t.cols, rows: t.rows, onEvent: channel });
    session = id;
  }

  /** xterm を用意してシェルを起動する（済んでいれば何もしない） */
  function ensureStarted(): Promise<void> {
    if (term && (session !== null || exited)) return Promise.resolve();
    starting ??= (async () => {
      term ??= await createTerm();
      // 起動する前に大きさを合わせておく（シェルの最初の表示が崩れないように）
      await new Promise(requestAnimationFrame);
      fit?.();
      await new Promise(requestAnimationFrame);
      await spawn(term);
    })().finally(() => (starting = null));
    return starting;
  }

  /** 今のシェルを終わらせ、今の作業フォルダで起動し直す。
   * 起動中（再起動ボタンの連打・開いた直後など）は何もしない（シェルを 2 つ起動しないため） */
  async function restart() {
    const t = term;
    if (!t || starting) return;
    starting = (async () => {
      const old = session;
      session = null;
      exited = false;
      if (old !== null) await invoke("term_kill", { id: old }).catch(() => {});
      t.reset();
      await spawn(t);
    })().finally(() => (starting = null));
    await starting.catch(opts.onError);
    t.focus();
  }

  // ---- 開閉 ----

  async function show(focus: boolean) {
    panel.hidden = false;
    divider.hidden = false;
    toggleBtn.classList.add("active");
    localStorage.setItem(OPEN_KEY, "1");
    notifyChange();
    try {
      await ensureStarted();
    } catch (err) {
      opts.onError(err);
      return;
    }
    fit?.();
    if (focus) term?.focus();
  }

  function hide() {
    const hadFocus = panel.contains(document.activeElement);
    panel.hidden = true;
    divider.hidden = true;
    toggleBtn.classList.remove("active");
    localStorage.setItem(OPEN_KEY, "0");
    notifyChange();
    if (hadFocus) opts.onClose();
  }

  /** 閉じているなら開いてフォーカス。開いていればフォーカスの有無で、移すか閉じるかを決める */
  function toggle() {
    if (!isOpen()) void show(true);
    else if (hasFocus()) hide();
    else term?.focus();
  }

  const hasFocus = () => isOpen() && panel.contains(document.activeElement);

  /** 文字を入力して Enter（「claude」ボタン） */
  async function run(command: string) {
    await show(true);
    if (session !== null) await invoke("term_write", { id: session, data: `${command}\r` }).catch(opts.onError);
  }

  toggleBtn.addEventListener("click", () => (isOpen() ? hide() : void show(true)));
  positionBtn.addEventListener("click", () => {
    setPosition(position === "bottom" ? "right" : "bottom");
    term?.focus();
  });
  $("term-claude").addEventListener("click", () => void run("claude"));
  $("term-restart").addEventListener("click", () => void restart());
  $("term-close").addEventListener("click", hide);

  // ---- 起動 ----

  applyLayout();
  if (localStorage.getItem(OPEN_KEY) === "1") void show(false);

  return {
    toggle,
    isOpen,
    hasFocus,
    position: () => position,
    setPosition,
  };
}
