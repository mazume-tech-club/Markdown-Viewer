import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
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
  setBusy(false);
  $("update-banner").hidden = false;
}

function setBusy(busy: boolean) {
  for (const id of ["update-install", "update-notes", "update-later"]) {
    ($(id) as HTMLButtonElement).disabled = busy;
  }
}

/**
 * バナーのボタンを配線する。beforeInstall が false を返したら更新を中止する
 * （未保存の編集があるときの確認に使う）
 */
export function setupUpdater(beforeInstall: () => Promise<boolean>) {
  $("update-later").addEventListener("click", () => ($("update-banner").hidden = true));
  $("update-notes").addEventListener("click", () => {
    void openUrl(pending ? `${RELEASES_URL}/tag/v${pending.version}` : RELEASES_URL);
  });
  $("update-install").addEventListener("click", async () => {
    if (!pending || !(await beforeInstall())) return;
    const progress = $("update-progress");
    setBusy(true);
    let total = 0;
    let done = 0;
    try {
      await pending.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        else if (e.event === "Progress") {
          done += e.data.chunkLength;
          progress.textContent = total ? `ダウンロード中… ${Math.round((done / total) * 100)}%` : "ダウンロード中…";
        } else if (e.event === "Finished") progress.textContent = "インストール中…";
      });
      // Windows ではインストーラの起動と同時にアプリが終了し、インストール後に再起動される。
      // それ以外の環境向けに明示的に再起動する
      await relaunch();
    } catch (err) {
      setBusy(false);
      progress.textContent = "";
      await message(`更新に失敗しました。\n\n${err}`, { title: "更新", kind: "error" });
    }
  });

  if (isAutoCheckEnabled()) setTimeout(() => void checkForUpdate(false), 3000);
}
