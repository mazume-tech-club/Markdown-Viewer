// ---------- オプション機能 ----------
// 必要な人だけが設定でオンにする機能。既定はオフで、オフのあいだは何もしない。
// 設定画面の「オプション機能」欄は、この一覧から作る

export interface OptionFeature {
  id: string;
  label: string;
  /** 設定画面でマウスを乗せたときの説明 */
  title: string;
}

export const OPTION_FEATURES = [
  {
    id: "judgeColors",
    label: "表の ○ / △ / ✕ を色付け",
    title: "表のセルが ○・あり・OK などだけなら緑、△・一部なら黄、✕・なし・NG などなら赤の太字にします",
  },
] as const satisfies readonly OptionFeature[];

export type OptionId = (typeof OPTION_FEATURES)[number]["id"];

const key = (id: OptionId) => `option.${id}`;

export const isOptionEnabled = (id: OptionId) => localStorage.getItem(key(id)) === "1";

export function setOptionEnabled(id: OptionId, on: boolean) {
  if (on) localStorage.setItem(key(id), "1");
  else localStorage.removeItem(key(id));
}
