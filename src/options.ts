// ---------- オプション機能 ----------
// 必要な人だけが設定でオンにする機能。既定はオフで、オフのあいだは何もしない。
// 設定画面の「オプション機能」欄は、この一覧から作る。
// 図の機能（kinds があるもの）は、オンにした人だけその fence を図として描く。
// ライブラリは描くときにだけ読み込むので、同梱していてもオフの人の起動・動作は重くならない

export interface OptionFeature {
  id: string;
  label: string;
  /** 設定画面でマウスを乗せたときの説明 */
  title: string;
  /** 設定画面の見出し */
  group: "diagram" | "other";
  /** 図の機能: fence の言語名 → 図の種別（diagrams.ts の renderOne） */
  kinds?: Readonly<Record<string, string>>;
}

export const OPTION_GROUPS = { diagram: "図", other: "その他" } as const;

export const OPTION_FEATURES = [
  {
    id: "math",
    label: "数式（KaTeX）",
    title: "```math のブロック、$$ … $$、文中の $ … $ を数式として描画します（GitHub と同じ書き方）",
    group: "diagram",
    kinds: { math: "math" },
  },
  {
    id: "erd",
    label: "ER 図（テーブル定義の表から）",
    title: "```erd に書いたテーブル定義の表から ER 図を描きます。FK の列から参照先のテーブルへ線を引きます",
    group: "diagram",
    kinds: { erd: "erd" },
  },
  {
    id: "judgeColors",
    label: "表の ○ / △ / ✕ を色付け",
    title: "表のセルが ○・あり・OK などだけなら緑、△・一部なら黄、✕・なし・NG などなら赤の太字にします",
    group: "other",
  },
] as const satisfies readonly OptionFeature[];

export type OptionId = (typeof OPTION_FEATURES)[number]["id"];

const key = (id: OptionId) => `option.${id}`;

// localStorage の無い所（render.ts を読み込む Node のテスト）ではすべてオフとして扱う
export const isOptionEnabled = (id: OptionId) => globalThis.localStorage?.getItem(key(id)) === "1";

export function setOptionEnabled(id: OptionId, on: boolean) {
  if (on) localStorage.setItem(key(id), "1");
  else localStorage.removeItem(key(id));
}
