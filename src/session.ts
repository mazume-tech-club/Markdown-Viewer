// 前回開いていたタブ（次回の起動時に開き直す）。未保存の変更は閉じるときに確認するので持ち越さない

const SESSION_KEY = "session";

export interface Session {
  /** 開いていたファイル（無題のタブは含めない） */
  paths: string[];
  /** 選んでいたタブの paths 内の位置（無題を選んでいたときは -1） */
  active: number;
}

export function loadSession(): Session {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null");
    if (s && Array.isArray(s.paths)) {
      return { paths: s.paths.filter((p: unknown) => typeof p === "string"), active: Number(s.active) || 0 };
    }
  } catch {
    // 壊れていれば捨てる
  }
  return { paths: [], active: -1 };
}

export function saveSession(session: Session) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // 保存できなくても動作には影響しない
  }
}
