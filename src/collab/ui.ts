// 共同編集の画面（docs/collaboration-stage1-plan.md の作業 6）。
// プラグインがあるときだけ、メニューの「ツール → 共同編集」・参加の要求のモーダル・設定の「中継サーバー」を出す
import { ask } from "@tauri-apps/plugin-dialog";

import type { CollabSession, SessionHandlers } from "./session";
import { collabAvailable, isCollabError, tauriTransport } from "./transport";

export interface CollabUiDeps {
  /** 表示中のタブでホストとして始める。招待リンクを返す（失敗したら null） */
  start(name: string, handlers: SessionHandlers): Promise<string | null>;
  join(invite: string, name: string, handlers: SessionHandlers): Promise<boolean>;
  /** 今の共同編集セッション（終わったものは除く） */
  session(): CollabSession | undefined;
  /** 表示中のタブで始められないなら、その理由 */
  cannotStart(): string | null;
  /** タブの印や名前を描き直す */
  changed(): void;
  /** メニューの「共同編集」を出す・表示名を変える（プラグインがあるときだけ呼ぶ） */
  setEntry(label: string): void;
}

const NAME_KEY = "collab.name";
/** 参加に使った招待リンク（クリアするまで残す） */
const INVITE_KEY = "collab.invite";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const STATE_LABEL: Record<string, string> = {
  connecting: "接続しています…",
  waiting: "ホストの承認を待っています…",
  syncing: "ホストの内容を受け取っています…",
  live: "共同編集中",
};

export function setupCollabUi(deps: CollabUiDeps) {
  const overlay = $("collab");
  const nameIn = $<HTMLInputElement>("collab-name");
  const idle = $("collab-idle");
  const activeView = $("collab-active");
  const startBtn = $<HTMLButtonElement>("collab-start");
  const startNote = $("collab-start-note");
  const inviteIn = $<HTMLInputElement>("collab-invite-in");
  const inviteClear = $<HTMLButtonElement>("collab-invite-clear");
  const joinBtn = $<HTMLButtonElement>("collab-join");
  const stateLabel = $("collab-state");
  const inviteRow = $("collab-invite-row");
  const inviteOut = $<HTMLInputElement>("collab-invite-out");
  const copyBtn = $<HTMLButtonElement>("collab-copy");
  const peersList = $("collab-peers");
  const leaveBtn = $<HTMLButtonElement>("collab-leave");
  const errorEl = $("collab-error");
  const requestsModal = $("collab-requests");
  const requestsList = $("collab-requests-list");
  const relaySection = $("settings-collab");
  const relayIn = $<HTMLInputElement>("set-relay");
  const relaySave = $<HTMLButtonElement>("set-relay-save");
  const relayStatus = $("set-relay-status");

  /** 承認待ちの参加の要求（ホストだけ） */
  let requests: { peer: number; name: string }[] = [];
  let busy = false;
  /** 共同編集プラグインが入っているか */
  let available = false;

  const showError = (msg: string | null) => {
    errorEl.textContent = msg ?? "";
    errorEl.hidden = !msg;
  };

  const handlers: SessionHandlers = {
    joinRequest(r) {
      requests = [...requests.filter((x) => x.peer !== r.peer), r];
      refresh();
    },
    peers() {
      // 承認する前に抜けた人の要求は残るが、承認しても中継サーバーが無視する
      refresh();
    },
    status() {
      refresh();
    },
    closed() {
      requests = [];
      refresh();
    },
  };

  function renderRequests(s: CollabSession | undefined) {
    if (!s || s.role !== "host" || !requests.length) {
      requestsModal.hidden = true;
      requestsList.replaceChildren();
      return;
    }
    const wasOpen = !requestsModal.hidden;
    requestsModal.hidden = false;
    requestsList.replaceChildren(
      ...requests.map((r) => {
        const row = document.createElement("div");
        row.className = "collab-request";
        const text = document.createElement("span");
        text.textContent = `${r.name} さんが共同編集への参加を求めています。`;
        const ok = document.createElement("button");
        ok.className = "primary";
        ok.textContent = "承認";
        ok.addEventListener("click", () => decide(r.peer, true));
        const no = document.createElement("button");
        no.textContent = "断る";
        no.addEventListener("click", () => decide(r.peer, false));
        row.append(text, ok, no);
        return row;
      }),
    );
    // 下の文書に打ち込み続けないよう、先頭の要求の「承認」にフォーカスを移す
    if (!wasOpen || !requestsModal.contains(document.activeElement)) requestsList.querySelector<HTMLButtonElement>("button.primary")?.focus();
  }

  async function decide(peer: number, approve: boolean) {
    const s = deps.session();
    requests = requests.filter((r) => r.peer !== peer);
    refresh();
    if (!s) return;
    try {
      await (approve ? s.approve(peer) : s.reject(peer));
    } catch (err) {
      showError(`参加の${approve ? "承認" : "お断り"}を伝えられませんでした: ${isCollabError(err) ? err.message : String(err)}`);
    }
  }

  function refresh() {
    const s = deps.session();
    const live = s && s.status !== "closed";
    const others = live ? s.peers.length : 0;
    if (available) deps.setEntry(live ? `共同編集中${others ? `（${others}人）` : ""}…` : "共同編集…");
    renderRequests(live ? s : undefined);

    idle.hidden = Boolean(live);
    activeView.hidden = !live;
    nameIn.disabled = Boolean(live) || busy;
    const why = deps.cannotStart();
    startNote.textContent = why ?? "表示中のタブのファイルを、招待した人と一緒に編集します。保存するのはあなた（ホスト）です。";
    startNote.classList.toggle("collab-warn", Boolean(why));
    startBtn.disabled = busy || Boolean(why);
    joinBtn.disabled = busy;
    inviteClear.disabled = busy;
    if (live) {
      const host = s.role === "host";
      stateLabel.textContent = host && s.status === "live" ? "共同編集中（あなたがホスト）" : STATE_LABEL[s.status];
      inviteRow.hidden = !host;
      inviteOut.value = s.invite;
      leaveBtn.textContent = host ? "共同編集を終える" : "共同編集から抜ける";
      peersList.replaceChildren(
        ...s.peers.map((p) => {
          const li = document.createElement("li");
          const marks = [p.host ? "ホスト" : "", p.peer === s.you ? "あなた" : ""].filter(Boolean);
          li.textContent = marks.length ? `${p.name}（${marks.join("・")}）` : p.name;
          return li;
        }),
      );
    }
    deps.changed();
  }

  const readName = () => {
    const name = nameIn.value.trim();
    if (!name) {
      showError("表示する名前を入力してください（ほかの人のカーソルの横に出ます）。");
      nameIn.focus();
      return null;
    }
    localStorage.setItem(NAME_KEY, name);
    return name;
  };

  async function run(fn: () => Promise<void>) {
    busy = true;
    refresh();
    try {
      await fn();
    } finally {
      busy = false;
      refresh();
    }
  }

  startBtn.addEventListener("click", () => {
    showError(null);
    const name = readName();
    if (!name) return;
    void run(async () => {
      const invite = await deps.start(name, handlers);
      if (invite) await copyInvite(invite);
    });
  });

  joinBtn.addEventListener("click", () => {
    showError(null);
    const name = readName();
    if (!name) return;
    const invite = inviteIn.value.trim();
    if (!invite) {
      showError("ホストから受け取った招待リンクを貼り付けてください。");
      inviteIn.focus();
      return;
    }
    localStorage.setItem(INVITE_KEY, invite);
    void run(async () => {
      await deps.join(invite, name, handlers);
    });
  });

  inviteClear.addEventListener("click", () => {
    inviteIn.value = "";
    localStorage.removeItem(INVITE_KEY);
    inviteIn.focus();
  });

  async function copyInvite(invite: string) {
    try {
      await navigator.clipboard.writeText(invite);
      copyBtn.textContent = "コピーしました";
      setTimeout(() => (copyBtn.textContent = "コピー"), 1500);
    } catch {
      inviteOut.select();
    }
  }
  copyBtn.addEventListener("click", () => void copyInvite(inviteOut.value));

  leaveBtn.addEventListener("click", async () => {
    const s = deps.session();
    if (!s) return;
    const host = s.role === "host";
    const ok = await ask(host ? "共同編集を終えますか？参加者全員の共同編集も終わります。" : "共同編集から抜けますか？", {
      title: "Markdown Preview",
      kind: "warning",
      okLabel: host ? "終える" : "抜ける",
      cancelLabel: "キャンセル",
    });
    if (ok) await s.leave();
    refresh();
  });

  function open() {
    showError(null);
    nameIn.value = localStorage.getItem(NAME_KEY) ?? "";
    inviteIn.value = localStorage.getItem(INVITE_KEY) ?? "";
    refresh();
    overlay.hidden = false;
    const focus = deps.session() ? $("collab-close") : !nameIn.value ? nameIn : startBtn.disabled ? inviteIn : startBtn;
    focus.focus();
  }

  function close() {
    overlay.hidden = true;
  }

  $("collab-close").addEventListener("click", () => close());
  overlay.addEventListener("click", (e) => e.target === overlay && close());

  // ---------- 設定の「中継サーバー」 ----------

  async function loadRelay() {
    relayStatus.textContent = "";
    try {
      const res = await tauriTransport.call({ t: "config-get" });
      relayIn.value = typeof res.relay === "string" ? res.relay : "";
    } catch (err) {
      relayStatus.textContent = `読み込めませんでした: ${isCollabError(err) ? err.message : String(err)}`;
    }
  }

  relaySave.addEventListener("click", async () => {
    try {
      await tauriTransport.call({ t: "config-set", relay: relayIn.value.trim() || null });
      relayStatus.textContent = "保存しました。";
      await loadRelay();
      relayStatus.textContent = "保存しました。";
    } catch (err) {
      relayStatus.textContent = isCollabError(err) ? err.message : String(err);
    }
  });

  void collabAvailable().then((ok) => {
    available = ok;
    if (ok) deps.setEntry("共同編集…");
    relaySection.hidden = !ok;
  });

  return {
    open,
    close,
    isOpen: () => !overlay.hidden,
    /** 参加の要求のモーダルを出しているか */
    isRequestOpen: () => !requestsModal.hidden,
    refresh,
    /** 設定画面を開いたとき（中継サーバーの URL を読み直す） */
    onSettingsOpen() {
      if (available) void loadRelay();
    },
  };
}
