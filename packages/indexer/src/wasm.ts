/**
 * web-tree-sitter bootstrap: one-time runtime init and cached grammar loading.
 *
 * Usage (this is the pattern every language pack and test should follow):
 *
 *   import { Parser } from "web-tree-sitter";
 *   import { initParser, loadLanguage } from "./wasm.js";
 *
 *   await initParser();                                   // once per process; idempotent
 *   const parser = new Parser();
 *   parser.setLanguage(await loadLanguage("typescript")); // cached per grammar
 *   const tree = parser.parse(sourceText);                // Tree | null
 *   // ... walk tree.rootNode ...
 *   tree?.delete();                                       // trees and parsers live in WASM memory:
 *   parser.delete();                                      // free them (or reuse one parser per language)
 *
 * Never call `Parser.init()` yourself: initialising twice creates a second WASM instance and leaves
 * previously loaded languages pointing into the first one.
 *
 * Node positions (`startIndex`, `startPosition.column`, ...) are UTF-16 code unit offsets into the
 * string passed to `parse()`, i.e. plain JS string indices, matching the schema's column convention.
 *
 * File locations: `node_modules` by default; `setWasmDir(dir)` or the `XPL_WASM_DIR` environment
 * variable redirect every wasm file (see wasm-files.ts).
 */
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Language, Parser } from "web-tree-sitter";
import {
  GRAMMAR_IDS,
  GRAMMAR_WASM,
  RUNTIME_WASM,
  getWasmDir,
  isGrammarId,
  resolveWasmFile,
  type GrammarId,
  type WasmSource,
} from "./wasm-files.js";

export * from "./wasm-files.js";

/** Resolve `source` and fail with a readable message when it is not there. */
function existingWasmFile(source: WasmSource): string {
  const path = resolveWasmFile(source);
  if (!existsSync(path)) {
    const dir = getWasmDir();
    throw new Error(
      `wasm file not found: ${path}` +
        (dir ? ` (wasm dir "${dir}" comes from setWasmDir() or XPL_WASM_DIR)` : ""),
    );
  }
  return path;
}

let initPromise: Promise<void> | undefined;
const loadedWasmHashes = new Map<string, string>();

/** A process keeps loaded WASM forever. Disk replacements must never label old extraction as new. */
export function loadedWasmMatches(file: string, sha256: string): boolean {
  const loaded = loadedWasmHashes.get(file);
  return loaded === undefined || loaded === sha256;
}

function recordWasm(source: WasmSource, bytes: Buffer): void {
  loadedWasmHashes.set(source.file, createHash("sha256").update(bytes).digest("hex"));
}

/**
 * Initialise the web-tree-sitter runtime. Safe to call from anywhere, any number of times: the
 * runtime is initialised once per process. A failed init is not cached, so it can be retried
 * (e.g. after `setWasmDir()`).
 */
export function initParser(): Promise<void> {
  if (!initPromise) {
    const attempt = (async () => {
      const bytes = readFileSync(existingWasmFile(RUNTIME_WASM));
      await Parser.init({ wasmBinary: bytes });
      recordWasm(RUNTIME_WASM, bytes);
    })();
    initPromise = attempt;
    attempt.catch(() => {
      if (initPromise === attempt) initPromise = undefined;
    });
  }
  return initPromise;
}

const languageCache = new Map<GrammarId, Promise<Language>>();

/**
 * Load (once) and return the grammar for `id`. Initialises the runtime if needed. `Language`
 * objects are immutable and shared, so never delete them.
 */
export function loadLanguage(id: GrammarId): Promise<Language> {
  if (!isGrammarId(id)) {
    return Promise.reject(
      new Error(`unknown grammar "${String(id)}" (expected one of ${GRAMMAR_IDS.join(", ")})`),
    );
  }
  let language = languageCache.get(id);
  if (!language) {
    const attempt = initParser().then(async () => {
      const source = GRAMMAR_WASM[id];
      const bytes = readFileSync(existingWasmFile(source));
      const language = await Language.load(bytes);
      recordWasm(source, bytes);
      return language;
    });
    language = attempt;
    languageCache.set(id, attempt);
    attempt.catch(() => {
      if (languageCache.get(id) === attempt) languageCache.delete(id);
    });
  }
  return language;
}

/** A new parser with the grammar for `id` already set. The caller owns it: call `.delete()`. */
export async function createParser(id: GrammarId): Promise<Parser> {
  const language = await loadLanguage(id); // also guarantees the runtime is initialised
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}
