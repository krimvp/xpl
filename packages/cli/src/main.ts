import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setWasmDir } from "@xpl/indexer";
import { run } from "./cli.js";

// The esbuild bundle (dist/xpl.mjs) ships the tree-sitter wasm files in dist/wasm/, next to itself.
// Running from source (`tsx src/main.ts`) there is no such directory, so the indexer falls back to
// node_modules. XPL_WASM_DIR, when set, wins over the bundled directory.
const bundledWasm = join(dirname(fileURLToPath(import.meta.url)), "wasm");
if (!process.env.XPL_WASM_DIR && existsSync(bundledWasm)) setWasmDir(bundledWasm);

// `xpl ... | head` closes the pipe early: that is not an error.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(process.exitCode ?? 0);
  throw error;
});

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (error) {
  console.error(`xpl: ${error instanceof Error ? error.message : String(error)}`);
  if (process.env.XPL_DEBUG && error instanceof Error) console.error(error.stack);
  process.exitCode = 1;
}
