/**
 * Bundle the CLI: `tsx build.ts` (run by `npm run build`).
 *
 *   dist/xpl.mjs      esbuild bundle of src/main.ts and its workspace deps (node, ESM)
 *   dist/wasm/        web-tree-sitter.wasm + every grammar .wasm, copied out of node_modules
 *   dist/viewer.html  required copy of packages/viewer/dist/index.html
 *   dist/skill/       bundled authoring skill, installed through `xpl skill install`
 *   dist/package.json standalone npm metadata; no workspace dependencies or install scripts
 *   dist/integrity.json SHA-256 inventory, checked by `xpl doctor`
 */
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { allWasmSources, resolvePackageWasm } from "@xpl/indexer/wasm-files";
import { build } from "esbuild";
import pkg from "./package.json" with { type: "json" };

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
const kb = (bytes: number) => `${(bytes / 1024).toFixed(0)} KB`;
const viewerHtml = join(here, "..", "viewer", "dist", "index.html");
if (!existsSync(viewerHtml)) {
  throw new Error("Build the viewer first: run `npm run build` from the repository root.");
}

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

await copyFile(viewerHtml, join(dist, "viewer.html"));
console.log(`copied viewer to dist/viewer.html (${kb((await stat(viewerHtml)).size)})`);
await cp(join(here, "../../skill/code-explainer"), join(dist, "skill/code-explainer"), {
  recursive: true,
});
await copyFile(join(here, "../../README.md"), join(dist, "README.md"));
await writeFile(
  join(dist, "package.json"),
  JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      description: "Code explainer CLI, viewer, WASM grammars and authoring skill",
      type: "module",
      bin: { xpl: "xpl.mjs" },
      engines: { node: ">=22.12" },
      files: ["xpl.mjs", "viewer.html", "wasm", "skill", "integrity.json"],
    },
    null,
    2,
  ) + "\n",
);
const files: Record<string, string> = {};
for (const path of (await readdir(dist, { recursive: true })).sort()) {
  if (!(await stat(join(dist, path))).isFile()) continue;
  files[path.replaceAll("\\", "/")] = createHash("sha256")
    .update(await readFile(join(dist, path)))
    .digest("hex");
}
await writeFile(
  join(dist, "integrity.json"),
  JSON.stringify({ version: pkg.version, files }, null, 2) + "\n",
);
