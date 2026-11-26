import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    // The API checks Host and Origin: `pnpm dev` allows this dev origin on the server side.
    proxy: { "/api": { target: "http://127.0.0.1:4317", changeOrigin: true } },
  },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
});
