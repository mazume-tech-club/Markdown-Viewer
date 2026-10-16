import { describe, expect, it } from "vitest";
import { judgeOf } from "./judge";

describe("judgeOf", () => {
  it("判定の語だけのセルを判定する", () => {
    expect(judgeOf("○")).toBe("good");
    expect(judgeOf("あり")).toBe("good");
    expect(judgeOf("△")).toBe("mid");
    expect(judgeOf("✕")).toBe("bad");
    expect(judgeOf("なし")).toBe("bad");
  });

  it("前後の空白と大文字小文字は無視する", () => {
    expect(judgeOf("  OK ")).toBe("good");
    expect(judgeOf("ok")).toBe("good");
    expect(judgeOf("Ng")).toBe("bad");
  });

  it("文の一部や他の語には付けない", () => {
    expect(judgeOf("なし（対象外）")).toBeNull();
    expect(judgeOf("あり（本番から再取得）")).toBeNull();
    expect(judgeOf("")).toBeNull();
    expect(judgeOf("データ")).toBeNull();
  });
});
