/**
 * Where the tree-sitter WASM files come from and how they are located.
 *
 * Deliberately free of any `web-tree-sitter` import so build scripts (the CLI bundler) can reuse the
 * file table and the resolution rules without loading the parser runtime.
 *
 * Sourcing: every file ships inside an npm package (the grammars' `.wasm` next to their native
 * bindings, `web-tree-sitter.wasm` inside `web-tree-sitter`), so nothing is vendored. The bundled CLI
 * copies them into `dist/wasm/` and points `setWasmDir()` there.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import type { FileLanguage } from "@xpl/core";

/**
 * Grammars we ship. Every `FileLanguage` with a grammar of its own is one ("javascript" files are parsed with
 * the "typescript" or, for JSX, the "tsx" grammar; "text" files are not parsed).
 */
export type GrammarId = Exclude<FileLanguage, "javascript" | "text">;

/** One `.wasm` file: where to find it in `node_modules`, and its name inside a wasm directory. */
export interface WasmSource {
  /** npm package that ships the file. */
  pkg: string;
  /** File name inside the package and inside a wasm directory (`setWasmDir` / `XPL_WASM_DIR`). */
  file: string;
}

export const GRAMMAR_WASM: Record<GrammarId, WasmSource> = {
  typescript: { pkg: "tree-sitter-typescript", file: "tree-sitter-typescript.wasm" },
  tsx: { pkg: "tree-sitter-typescript", file: "tree-sitter-tsx.wasm" },
  python: { pkg: "tree-sitter-python", file: "tree-sitter-python.wasm" },
  rust: { pkg: "tree-sitter-rust", file: "tree-sitter-rust.wasm" },
  ruby: { pkg: "tree-sitter-ruby", file: "tree-sitter-ruby.wasm" },
  go: { pkg: "tree-sitter-go", file: "tree-sitter-go.wasm" },
  java: { pkg: "tree-sitter-java", file: "tree-sitter-java.wasm" },
  php: { pkg: "tree-sitter-php", file: "tree-sitter-php.wasm" },
  yaml: { pkg: "@tree-sitter-grammars/tree-sitter-yaml", file: "tree-sitter-yaml.wasm" },
  json: { pkg: "tree-sitter-json", file: "tree-sitter-json.wasm" },
  toml: { pkg: "@tree-sitter-grammars/tree-sitter-toml", file: "tree-sitter-toml.wasm" },
};

/** The web-tree-sitter runtime itself (loaded through `Parser.init({ locateFile })`). */
export const RUNTIME_WASM: WasmSource = { pkg: "web-tree-sitter", file: "web-tree-sitter.wasm" };

export const GRAMMAR_IDS = Object.keys(GRAMMAR_WASM) as GrammarId[];

export function isGrammarId(id: string): id is GrammarId {
  return Object.hasOwn(GRAMMAR_WASM, id);
}

/** Every wasm file a bundled CLI must ship: the runtime plus one file per grammar. */
export function allWasmSources(): WasmSource[] {
  return [RUNTIME_WASM, ...GRAMMAR_IDS.map((id) => GRAMMAR_WASM[id])];
}

const require = createRequire(import.meta.url);

/** Absolute path of the file inside its npm package (ignores any wasm-dir override). */
export function resolvePackageWasm(source: WasmSource): string {
  return require.resolve(`${source.pkg}/${source.file}`);
}

let wasmDirOverride: string | undefined;

/**
 * Load every wasm file from `dir/<file>` instead of from `node_modules` (`undefined` clears it).
 * The bundled CLI calls this at startup with `dist/wasm`. Call it before `initParser()`: web-tree-sitter's
 * own `web-tree-sitter.wasm` is read exactly once, at init. Takes precedence over `XPL_WASM_DIR`.
 */
export function setWasmDir(dir: string | undefined): void {
  wasmDirOverride = dir;
}

/** The active override: `setWasmDir()`, else the `XPL_WASM_DIR` environment variable, else undefined. */
export function getWasmDir(): string | undefined {
  return wasmDirOverride ?? (process.env.XPL_WASM_DIR || undefined);
}

/** Path to load `source` from: the wasm directory override if there is one, else `node_modules`. */
export function resolveWasmFile(source: WasmSource): string {
  const dir = getWasmDir();
  return dir ? join(dir, source.file) : resolvePackageWasm(source);
}
