import { describe, expect, it } from "vitest";

import { requestableImage } from "./paths";

describe("requestableImage", () => {
  it("md のフォルダの中の画像は、畳んだ / 区切りのパスになる", () => {
    expect(requestableImage("img/a.png")).toBe("img/a.png");
    expect(requestableImage("./img\\b.JPG")).toBe("img/b.JPG");
    expect(requestableImage("img/../c.webp")).toBe("c.webp");
    expect(requestableImage("議事録.assets/image-1.png")).toBe("議事録.assets/image-1.png");
  });

  it("md のフォルダの外・絶対パス・URL は求めさせない", () => {
    expect(requestableImage("../a.png")).toBeNull();
    expect(requestableImage("img/../../a.png")).toBeNull();
    expect(requestableImage("C:\\Users\\a.png")).toBeNull();
    expect(requestableImage("C:a.png")).toBeNull();
    expect(requestableImage("\\\\server\\share\\a.png")).toBeNull();
    expect(requestableImage("/etc/a.png")).toBeNull();
    expect(requestableImage("https://example.com/a.png")).toBeNull();
    expect(requestableImage("a.png:stream")).toBeNull();
  });

  it("画像でないもの・SVG・空・制御文字入りは求めさせない", () => {
    expect(requestableImage("a.md")).toBeNull();
    expect(requestableImage("a.svg")).toBeNull();
    expect(requestableImage("")).toBeNull();
    expect(requestableImage(".")).toBeNull();
    expect(requestableImage("a\n.png")).toBeNull();
  });
});
