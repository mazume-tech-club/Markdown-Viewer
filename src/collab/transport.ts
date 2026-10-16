// 本体 Rust の受け口との通り道（docs/collaboration-protocol.md の ①）。
// テストでは偽の中継に差し替えられるよう、セッションはこの形だけに頼る
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** プラグインからのイベント（プロトコル②のイベント） */
export type CollabEvent =
  | { t: "waiting" }
  | { t: "ready"; you: number; host: number }
  | { t: "join-request"; peer: number; name: string }
  | { t: "peers"; peers: Peer[] }
  | { t: "data"; from: number; data: string }
  | { t: "closed"; code: number; reason: string }
  | { t: "warning"; message: string };

export interface Peer {
  peer: number;
  name: string;
  host: boolean;
}

/** collab_call の失敗（プロトコル②の fail と、本体 Rust の no-plugin など） */
export interface CollabError {
  code: string;
  message: string;
}

export interface Transport {
  /** 依頼を渡し、ok の中身を返す。fail なら CollabError で失敗する */
  call(msg: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** イベントを受け取る。戻り値で受け取りをやめる */
  onEvent(handler: (e: CollabEvent) => void): () => void;
}

export const isCollabError = (e: unknown): e is CollabError =>
  typeof e === "object" && e !== null && typeof (e as CollabError).code === "string";

export function collabAvailable(): Promise<boolean> {
  return invoke<boolean>("collab_available").catch(() => false);
}

export const tauriTransport: Transport = {
  call: (msg) => invoke<Record<string, unknown>>("collab_call", { msg }),
  onEvent(handler) {
    const un = listen<CollabEvent>("collab-event", (e) => handler(e.payload));
    return () => void un.then((f) => f());
  },
};
