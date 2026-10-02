# Markdown Preview デモ

![logo](img/logo.svg)

[目次へ](#表と装飾) ・ [外部リンク](https://github.com) ・ [別の Markdown](other.md)

## 表と装飾

| 機能 | 状態 | 備考 |
|---|:---:|---|
| **太字** / *斜体* / ~~取消~~ | ✅ | GFM |
| `インラインコード` | ✅ | |

- [x] タスクリスト
- [ ] 未完了のタスク

脚注の例です[^1]。

[^1]: これは脚注です。

## コードハイライト

```ts
export function greet(name: string): string {
  return `Hello, ${name}!`;
}
```

```rust
fn main() { println!("こんにちは"); }
```

## Mermaid フローチャート

```mermaid
flowchart LR
  A[Markdown] --> B{図?}
  B -- はい --> C[SVG]
  B -- いいえ --> D[HTML]
```

## Mermaid シーケンス図

```mermaid
sequenceDiagram
  User->>App: ファイルを開く
  App->>Rust: read_file
  Rust-->>App: 内容
  App-->>User: プレビュー
```

## C4 コンテキスト図（Mermaid）

```mermaid
C4Context
  title Markdown Preview のシステムコンテキスト
  Person(user, "ユーザー", "Markdown を書く人")
  System_Ext(editor, "外部エディタ", "VS Code など")
  System(app, "Markdown Preview", "Tauri 製デスクトップアプリ")
  Rel(user, editor, "編集する")
  Rel(user, app, "プレビューする")
  Rel(editor, app, "保存を検知", "ファイル監視")
  UpdateRelStyle(user, app, $offsetX="-90", $offsetY="-10")
  UpdateRelStyle(editor, app, $offsetX="10", $offsetY="-20")
  UpdateLayoutConfig($c4ShapeInRow="2", $c4BoundaryInRow="1")
```

## Graphviz

```dot
digraph G {
  rankdir=LR;
  node [shape=box, style=rounded];
  frontend -> tauri -> rust;
  rust -> notify [label="watch"];
}
```

## WaveDrom

```wavedrom
{ signal: [
  { name: "clk",  wave: "p......" },
  { name: "data", wave: "x.345x.", data: ["a", "b", "c"] },
  { name: "req",  wave: "0.1..0." },
]}
```

## エラーになる図

```mermaid
flowchart LR
  A -->
```
