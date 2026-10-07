import { defineConfig } from "vite";

// Tauri から使う前提の設定
export default defineConfig({
  clearScreen: false,
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
