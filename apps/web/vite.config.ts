import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  build: { outDir: "dist", chunkSizeWarningLimit: 1600, rolldownOptions: { output: { manualChunks: (id) => id.includes("elkjs") ? "layout" : id.includes("@xyflow") ? "graph" : undefined } } },
});
