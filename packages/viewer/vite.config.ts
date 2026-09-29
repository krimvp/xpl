import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// One self-contained dist/index.html: JS and CSS are inlined by vite-plugin-singlefile, so the
// file works from file://, from the `xpl view` server and inside `xpl bundle` output.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  base: "./",
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
  },
});
