/**
 * Bundle the CLI: `tsx build.ts` (run by `npm run build`).
 *
 *   dist/xpl.mjs      esbuild bundle of src/main.ts and its workspace deps (node, ESM)
 *   dist/wasm/        web-tree-sitter.wasm + every grammar .wasm, copied out of node_modules
 *   dist/viewer.html  copy of packages/viewer/dist/index.html (skipped, with a warning, if not built)
 */
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { allWasmSources, resolvePackageWasm } from "@xpl/indexer/wasm-files";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
const kb = (bytes: number) => `${(bytes / 1024).toFixed(0)} KB`;

await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, "wasm"), { recursive: true });

await build({
  entryPoints: [join(here, "src/main.ts")],
  outfile: join(dist, "xpl.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: {
    // Shebang for `bin`, and a `require` so CommonJS code inside the bundle keeps working.
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __xplCreateRequire } from "node:module";',
      "const require = __xplCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "info",
});
await chmod(join(dist, "xpl.mjs"), 0o755);

for (const source of allWasmSources()) {
  await copyFile(resolvePackageWasm(source), join(dist, "wasm", source.file));
}
await copyFile(join(here, "../indexer/src/tags/rust.scm"), join(dist, "wasm/rust-tags.scm"));
console.log(`copied ${allWasmSources().length} wasm files to dist/wasm/`);

const viewerHtml = join(here, "..", "viewer", "dist", "index.html");
if (existsSync(viewerHtml)) {
  await copyFile(viewerHtml, join(dist, "viewer.html"));
  console.log(`copied viewer to dist/viewer.html (${kb((await stat(viewerHtml)).size)})`);
} else {
  console.warn(
    "warning: packages/viewer/dist/index.html not found, dist/viewer.html not written " +
      "(run `npm run build`, which builds the viewer first)",
  );
}
