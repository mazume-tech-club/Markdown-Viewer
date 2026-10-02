import { check, type Update } from "@tauri-apps/plugin-updater";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { message } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";

// GitHub Releases の最新版（latest.json）を見て、新しいバージョンがあれば更新する。
// ネットワークに出るのはこの確認・ダウンロードのときだけ

const RELEASES_URL = "https://github.com/mazume-tech-club/Markdown-Viewer/releases";
const AUTO_KEY = "update.auto";

export const isAutoCheckEnabled = () => localStorage.getItem(AUTO_KEY) !== "0";
export const setAutoCheck = (on: boolean) => localStorage.setItem(AUTO_KEY, on ? "1" : "0");

const $ = (id: string) => document.getElementById(id)!;
let checking = false;
let pending: Update | null = null;

/**
 * 更新を確認する。manual のときは「最新です」やエラーもダイアログで知らせる。
 * 自動確認（起動時）はオフラインなどの失敗を黙って無視する
 */
export async function checkForUpdate(manual: boolean) {
  if (checking) return;
  checking = true;
  try {
    const update = await check({ timeout: 15000 });
    if (!update) {
      if (manual) await message("お使いのバージョンは最新です。", { title: "更新の確認", kind: "info" });
      return;
    }
    showBanner(update);
  } catch (err) {
    if (manual) {
      await message(`更新を確認できませんでした。ネットワーク接続を確認してください。\n\n${err}`, {
        title: "更新の確認",
        kind: "warning",
      });
    }
  } finally {
    checking = false;
  }
}

function showBanner(update: Update) {
  pending = update;
  $("update-text").textContent = `新しいバージョン v${update.version} が利用できます（現在 v${update.currentVersion}）。`;
  $("update-progress").textContent = "";
  $("update-install").textContent = "更新して再起動";
  $("update-manual").hidden = true;
  setBusy(false);
  $("update-banner").hidden = false;
}

function setBusy(busy: boolean) {
  for (const id of ["update-install", "update-notes", "update-later", "update-manual"]) {
    ($(id) as HTMLButtonElement).disabled = busy;
  }
}

const releasePage = () => (pending ? `${RELEASES_URL}/tag/v${pending.version}` : `${RELEASES_URL}/latest`);

/** 更新に失敗したとき: アプリはそのまま使える状態で、再試行か手動ダウンロードを選べるようにする */
function showFailure(err: unknown) {
  setBusy(false);
  $("update-progress").textContent = "";
  $("update-text").textContent = `更新できませんでした。${String(err).replace(/^Error:\s*/, "")}`;
  $("update-install").textContent = "再試行";
  $("update-manual").hidden = false;
}

/**
 * バナーのボタンを配線する。beforeInstall が false を返したら更新を中止する
 * （未保存の編集があるときの確認に使う）
 */
export function setupUpdater(beforeInstall: () => Promise<boolean>) {
  $("update-later").addEventListener("click", () => ($("update-banner").hidden = true));
  $("update-notes").addEventListener("click", () => void openUrl(releasePage()));
  $("update-manual").addEventListener("click", () => void openUrl(releasePage()));

  const progress = $("update-progress");
  void listen<[number, number | null]>("update-progress", (e) => {
    const [done, total] = e.payload;
    progress.textContent = total ? `ダウンロード中… ${Math.round((done / total) * 100)}%` : "ダウンロード中…";
  });

  $("update-install").addEventListener("click", async () => {
    if (!pending || !(await beforeInstall())) return;
    setBusy(true);
    progress.textContent = "ダウンロード中…";
    try {
      // 成功するとインストーラが起動してアプリは終了し、インストール後に再起動される。
      // インストーラの起動を阻まれたなどの失敗はエラーとして返り、アプリはそのまま残る
      await invoke("install_update");
    } catch (err) {
      showFailure(err);
    }
  });

  if (isAutoCheckEnabled()) setTimeout(() => void checkForUpdate(false), 3000);
}
