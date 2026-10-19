import { defineConfig, type Plugin } from "vite";

/**
 * KaTeX の CSS はフォントごとに woff2・woff・ttf を並べるので、3 つとも同梱されてしまう。
 * WebView2 は woff2 を読めるので、woff と ttf を CSS から外してインストーラーを小さくする。
 * Vite が CSS の url() を資産として拾う前に外すため、enforce: "pre" にする
 */
const katexWoff2Only = (): Plugin => ({
  name: "katex-woff2-only",
  enforce: "pre",
  transform(code, id) {
    if (!/[\\/]katex[\\/]dist[\\/][^?]*\.css(\?|$)/.test(id)) return;
    return code.replace(/,\s*url\([^)]*\.woff\)\s*format\("woff"\)\s*,\s*url\([^)]*\.ttf\)\s*format\("truetype"\)/g, "");
  },
});

// Tauri から使う前提の設定
export default defineConfig({
  plugins: [katexWoff2Only()],
  clearScreen: false,
  // svgbob の WASM を ?inline で JS に埋め込むため（CSP で fetch できないので URL では読めない。src/svgbob.ts）
  assetsInclude: ["**/*.wasm"],
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**", "**/collab-plugin/**", "**/relay/**"] },
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 4000,
    rolldownOptions: {
      input: { main: "index.html", help: "help.html" },
    },
  },
});
