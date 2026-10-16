import { defineConfig } from "vitest/config";

// フロントエンドのテスト。relay/ は Workers のランタイムで動くので、そちらで npm test する
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
