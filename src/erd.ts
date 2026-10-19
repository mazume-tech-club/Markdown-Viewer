// ---------- ER 図（```erd） ----------
// テーブル定義の Markdown の表から ER 図を描く（オプション機能「ER 図」）。
// 「## 物理名 論理名」でテーブルを始め、続く表に列を書く。キーの列の「FK 表.列」から参照先へ線を引く。
// c4 と同じく、解析して DOT にし、Graphviz で描く（diagrams.ts）
//
//   ## users ユーザー
//   | 列 | 型 | キー | 説明 |
//   |---|---|---|---|
//   | id | int | PK | |
//   | dept_id | int | FK depts.id | 所属 |

export interface ErdColumn {
  name: string;
  type: string;
  pk: boolean;
  uk: boolean;
  /** 参照先。column が null ならそのテーブルの PK */
  fk: { table: string; column: string | null } | null;
  note: string;
  /** 1 始まりの行番号（誤りの知らせ用） */
  line: number;
}

export interface ErdTable {
  name: string;
  label: string;
  columns: ErdColumn[];
  line: number;
}

export interface ErdModel {
  title: string;
  tables: ErdTable[];
}

/** 見出しの文字 → 列の役割。見つからなければ 1 列目を列名とし、ほかは使わない */
const HEADERS: Record<"name" | "type" | "key" | "note", string[]> = {
  name: ["列", "列名", "カラム", "カラム名", "項目", "項目名", "物理名", "name", "column"],
  type: ["型", "データ型", "type"],
  key: ["キー", "制約", "key"],
  note: ["説明", "備考", "論理名", "内容", "description", "note", "comment"],
};

/** 表の行をセルに分ける（前後の | を外す。\| はセルの中の | として扱う） */
function cells(row: string): string[] {
  const s = row.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  return s.split(/(?<!\\)\|/).map((c) =>
    c
      .trim()
      .replace(/\\\|/g, "|")
      // `id` や **id** のような飾りは外す
      .replace(/^(`|\*\*)(.*)\1$/, "$2"),
  );
}

const SEPARATOR = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/;

export function parseErd(src: string): ErdModel {
  const model: ErdModel = { title: "", tables: [] };
  let table: ErdTable | null = null;
  /** 今の表の、役割 → 列の位置。null なら次の表の行は見出し */
  let cols: Partial<Record<keyof typeof HEADERS, number>> | null = null;
  let expectSeparator = false;

  src.split(/\r?\n/).forEach((raw, i) => {
    const n = i + 1;
    const line = raw.trim();
    if (!line || line.startsWith("%%")) {
      if (!line) cols = null;
      return;
    }
    const title = /^title\s+(.+)$/i.exec(line);
    if (title) {
      model.title = title[1].trim();
      return;
    }
    const head = /^##\s+(\S+)(?:\s+(.+))?$/.exec(line);
    if (head) {
      if (model.tables.some((t) => t.name === head[1])) throw new Error(`${n} 行目: テーブル ${head[1]} が 2 回出てきます`);
      table = { name: head[1], label: head[2]?.trim() ?? "", columns: [], line: n };
      model.tables.push(table);
      cols = null;
      return;
    }
    if (!line.startsWith("|")) throw new Error(`${n} 行目: 未対応の書き方です（「## テーブル名」か表の行を書いてください）`);
    if (!table) throw new Error(`${n} 行目: 表の前に「## テーブル名」を書いてください`);

    if (!cols) {
      const found: Partial<Record<keyof typeof HEADERS, number>> = {};
      cells(line).forEach((c, idx) => {
        const h = c.toLowerCase();
        for (const [role, names] of Object.entries(HEADERS) as [keyof typeof HEADERS, string[]][]) {
          if (found[role] === undefined && names.includes(h)) found[role] = idx;
        }
      });
      found.name ??= 0;
      cols = found;
      expectSeparator = true;
      return;
    }
    if (expectSeparator) {
      if (!SEPARATOR.test(line)) throw new Error(`${n} 行目: 表の見出しの次は |---|---| の区切りの行にしてください`);
      expectSeparator = false;
      return;
    }

    const c = cells(line);
    const at = (role: keyof typeof HEADERS) => (cols![role] === undefined ? "" : (c[cols![role]!] ?? ""));
    const name = at("name");
    if (!name) throw new Error(`${n} 行目: 列名が空です`);
    const key = at("key");
    const fk = /\bFK\b\s*[:：(→>]*\s*([^\s,、()]+)/i.exec(key);
    let ref: ErdColumn["fk"] = null;
    if (fk) {
      const dot = fk[1].lastIndexOf(".");
      ref = dot < 0 ? { table: fk[1], column: null } : { table: fk[1].slice(0, dot), column: fk[1].slice(dot + 1) };
    }
    table.columns.push({
      name,
      type: at("type"),
      pk: /\bPK\b/i.test(key),
      uk: /\b(UK|UQ|UNIQUE)\b/i.test(key),
      fk: ref,
      note: at("note"),
      line: n,
    });
  });

  if (!model.tables.length) throw new Error("テーブルがありません（「## テーブル名」と列の表を書いてください）");
  for (const t of model.tables) {
    if (!t.columns.length) throw new Error(`${t.line} 行目: テーブル ${t.name} に列がありません`);
    for (const col of t.columns) {
      if (!col.fk) continue;
      const target = model.tables.find((x) => x.name === col.fk!.table);
      if (!target) throw new Error(`${col.line} 行目: 参照先のテーブル ${col.fk.table} がありません`);
      if (col.fk.column && !target.columns.some((x) => x.name === col.fk!.column)) {
        throw new Error(`${col.line} 行目: テーブル ${target.name} に列 ${col.fk.column} がありません`);
      }
    }
  }
  return model;
}

const html = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// 書体は c4 と同じ。配色は手書き SVG・設計メモの文書スタイルと同じ
const FONT = "Yu Gothic UI,Meiryo,sans-serif";
const HEAD_BG = "#dceff1";
const LINE = "#c3cbd2";
const MUTED = "#5d6974";

/**
 * セルの最小幅（pt）。Graphviz は日本語の文字幅を知らず半角の幅で見積もるので、
 * 全角は文字の大きさ、半角はその 0.6 倍ほどとして足し、枠からはみ出さないようにする（少し広めに見積もる）
 */
function cellWidth(texts: string[], size: number): number {
  const w = (t: string) => [...t].reduce((sum, ch) => sum + (/[\u0000-\u00ff\uff61-\uff9f]/.test(ch) ? 0.62 : 1.05) * size, 0);
  return Math.ceil(Math.max(0, ...texts.map(w)) + 14);
}

/** 文字に色と大きさを付ける（空の <font></font> は Graphviz の構文エラーになるので、空なら何も出さない） */
const font = (text: string, attrs: string) => (text ? `<font ${attrs}>${text}</font>` : "");

/** 列名の飾り: PK は太字と下線、FK は斜体 */
function decorate(col: ErdColumn): string {
  let s = html(col.name);
  if (col.fk) s = `<i>${s}</i>`;
  if (col.pk) s = `<b><u>${s}</u></b>`;
  return s;
}

export function erdToDot(model: ErdModel): string {
  const index = new Map(model.tables.map((t, i) => [t.name, i]));
  const out = [
    "digraph erd {",
    `  graph [rankdir=LR, nodesep=0.5, ranksep=1.1, pad=0.2, fontname="${FONT}", fontsize=14${
      model.title ? `, labelloc=t, label=<<b>${html(model.title)}</b>>` : ""
    }];`,
    `  node [shape=plain, fontname="${FONT}", fontsize=11];`,
    // 参照される側（1）から参照する側（多）へ引き、参照される側を左に置く
    `  edge [dir=both, arrowtail=tee, arrowhead=crow, color="${MUTED}"];`,
  ];
  model.tables.forEach((t, ti) => {
    const withNote = t.columns.some((c) => c.note);
    const span = withNote ? 4 : 3;
    // テーブル名と論理名は 1 つの文字列にする。書式を分けると Graphviz が別々の文字列として置き、
    // 日本語の書体の幅を狭く見積もった位置に次の文字列を置くので重なる（2 行にしても上下に重なる）
    const head = t.label ? `${t.name}  ${t.label}` : t.name;
    const headW = cellWidth([head], 12); // 太字は 1 割ほど幅が広い
    // 列ごとの幅
    const nameW = cellWidth(t.columns.map((c) => c.name), 11);
    const typeW = cellWidth(t.columns.map((c) => c.type), 11);
    const noteW = cellWidth(t.columns.map((c) => c.note), 11);
    const rows = t.columns.map((c, ci) => {
      const keys = [c.pk && "PK", c.fk && "FK", c.uk && "UK"].filter(Boolean).join(" ");
      const note = withNote ? `<td align="left" width="${noteW}">${font(html(c.note), `color="${MUTED}"`)}</td>` : "";
      return (
        `<tr><td align="left">${font(keys, `color="${MUTED}" point-size="9"`)}</td>` +
        `<td align="left" port="c${ci}" width="${nameW}">${decorate(c)}</td><td align="left" width="${typeW}">${html(c.type)}</td>${note}</tr>`
      );
    });
    out.push(
      `  t${ti} [label=<<table border="1" cellborder="1" cellspacing="0" cellpadding="5" bgcolor="white" color="${LINE}">` +
        `<tr><td colspan="${span}" bgcolor="${HEAD_BG}" width="${headW}"><b>${html(head)}</b></td></tr>${rows.join("")}</table>>];`,
    );
  });
  model.tables.forEach((t, ti) => {
    t.columns.forEach((c, ci) => {
      if (!c.fk) return;
      const target = model.tables[index.get(c.fk.table)!];
      const ref = c.fk.column ?? target.columns.find((x) => x.pk)?.name;
      const port = ref ? target.columns.findIndex((x) => x.name === ref) : -1;
      out.push(`  t${index.get(c.fk.table)}${port >= 0 ? `:c${port}` : ""} -> t${ti}:c${ci};`);
    });
  });
  out.push("}");
  return out.join("\n");
}
