/**
 * Parsing helpers on top of wasm.ts: one parser per grammar, reused across files, and a `FileContext`
 * builder. Trees and parsers live in WASM memory and must be freed: `ParserPool.dispose()` frees the
 * parsers, `ParsedFile.dispose()` (or `withParsedFile`) frees a tree.
 */
import { splitLines } from "@xpl/core";
import type { FileLanguage, FilePath } from "@xpl/core";
import type { Parser, Tree } from "web-tree-sitter";
import type { FileContext, LanguagePack } from "./languages/types.js";
import { packFor } from "./languages/index.js";
import { createParser } from "./wasm.js";
import type { GrammarId } from "./wasm-files.js";

/** Reusable parsers, one per grammar. */
export class ParserPool {
  private readonly parsers = new Map<GrammarId, Promise<Parser>>();

  /** Parse `source` with the grammar `id`. The caller owns (and must `delete()`) the tree. */
  async parse(id: GrammarId, source: string): Promise<Tree> {
    let parser = this.parsers.get(id);
    if (!parser) {
      parser = createParser(id);
      this.parsers.set(id, parser);
    }
    const tree = (await parser).parse(source);
    if (!tree) throw new Error(`tree-sitter (${id}) returned no tree`);
    return tree;
  }

  /** Free every parser. The pool must not be used afterwards. */
  async dispose(): Promise<void> {
    const parsers = [...this.parsers.values()];
    this.parsers.clear();
    for (const parser of parsers) {
      try {
        (await parser).delete();
      } catch {
        // a parser that failed to load has nothing to free
      }
    }
  }
}

/** A parsed file with its language pack. Call `dispose()` when done: it frees the syntax tree. */
export interface ParsedFile {
  ctx: FileContext;
  pack: LanguagePack;
  dispose(): void;
}

/**
 * Parse `source` as `language` with the registered pack. Returns undefined when the language has no pack
 * (plain text). This is the "reparse helper" a SCIP importer uses to run `pack.classifySite` on a file.
 */
export async function parseFile(
  pool: ParserPool,
  file: FilePath,
  language: FileLanguage,
  source: string,
): Promise<ParsedFile | undefined> {
  const pack = packFor(language);
  if (!pack) return undefined;
  const tree = await pool.parse(pack.grammarFor(language), source);
  const ctx: FileContext = { file, language, source, lines: splitLines(source), tree };
  return { ctx, pack, dispose: () => tree.delete() };
}

/** `parseFile`, run `fn` on the context, always free the tree. `undefined` if there is no pack. */
export async function withParsedFile<T>(
  pool: ParserPool,
  file: FilePath,
  language: FileLanguage,
  source: string,
  fn: (ctx: FileContext, pack: LanguagePack) => T | Promise<T>,
): Promise<T | undefined> {
  const parsed = await parseFile(pool, file, language, source);
  if (!parsed) return undefined;
  try {
    return await fn(parsed.ctx, parsed.pack);
  } finally {
    parsed.dispose();
  }
}
