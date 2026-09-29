import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const root = fileURLToPath(new URL(".", import.meta.url));

/**
 * Dev server only: injects a viewer bundle (the JSON written by scripts/make-bundle.ts) as
 * `<script id="xpl-data">`, like `xpl bundle` / `xpl view` do for the built file.
 * `XPL_DEV_DATA=<path>` picks another file; without a file the viewer shows its "no data" screen.
 */
function devData(): Plugin {
  return {
    name: "xpl-dev-data",
    apply: "serve",
    transformIndexHtml() {
      const file = resolve(
        root,
        process.env.XPL_DEV_DATA ?? "dist/bundles/ts-jobrunner.bundle.json",
      );
      if (!existsSync(file)) return [];
      const json = readFileSync(file, "utf8").replace(/</g, "\\u003c");
      return [
        {
          tag: "script",
          attrs: { id: "xpl-data", type: "application/json" },
          children: json,
          injectTo: "head-prepend",
        },
      ];
    },
  };
}

// One self-contained dist/index.html: JS and CSS are inlined by vite-plugin-singlefile, so the
// file works from file://, from the `xpl view` server and inside `xpl bundle` output.
// `emptyOutDir` is off so the generated bundles in dist/bundles/ survive a rebuild; the single-file
// build only ever writes dist/index.html.
export default defineConfig({
  plugins: [react(), viteSingleFile(), devData()],
  base: "./",
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: false,
  },
});
