/**
 * Registry of *precise* reference resolvers (SCIP indexers, ARCHITECTURE.md §3 "Precise resolution").
 *
 * `buildIndex` always computes heuristic references first. With `precise: "auto" | "require"` it then runs
 * the registered resolvers that cover a language present in the repository and, for those languages,
 * replaces the heuristic references by the resolver's own (`resolution: "precise"`) - file by file: the
 * heuristic references of a file the tool *described* (`PreciseOutput.describedFiles`) are dropped, the tool saw
 * every site there; files it did not describe (build-tagged Go files, files a Python project's pyright
 * configuration excludes, ...) keep their heuristic references, and `LanguageInfo.heuristicFiles` counts them.
 *
 *  - `"off"`: never runs a resolver.
 *  - `"auto"`: a resolver that throws produces a warning and the language keeps its heuristic references.
 *    Languages without any registered resolver silently keep heuristic references.
 *  - `"require"`: `buildIndex` throws if a language with references has no resolver, or if a resolver throws.
 *
 * The registry is empty until a resolver module calls `registerPreciseResolver` (the SCIP importer does so
 * when it is loaded; wire it up by importing it from `src/build.ts`). `BuildIndexOptions.resolvers` overrides
 * the registry, which is how tests inject fakes.
 *
 * What a SCIP importer needs is all in `PreciseInput`: the built symbols with an innermost-symbol lookup
 * (`from` = `lookup.innermost(file, line, col)`, `to` = the innermost symbol at the definition, else module
 * scope), a way to parse a file with its language pack (`withFile`, then `pack.classifySite(ctx, line, col)`
 * gives the reference kind and site of an occurrence), and `warn` for non-fatal problems.
 */
import type { FileLanguage, FilePath, IndexedFile, IndexedSymbol, Reference } from "@xpl/core";
import type { FileContext, LanguagePack } from "./languages/types.js";
import type { SymbolLookup } from "./symbols.js";

export interface PreciseInput {
  /** Absolute path of the indexed root (run the indexer tool here). */
  root: string;
  /** The languages to resolve: those this resolver covers that occur in the repository. */
  languages: readonly FileLanguage[];
  /** Every indexed file (all languages). */
  files: readonly IndexedFile[];
  /** Every built symbol (all languages). */
  symbols: readonly IndexedSymbol[];
  /** Innermost-symbol lookup over `symbols` (with columns, so several symbols on a line are told apart). */
  lookup: SymbolLookup;
  /** Text of an indexed file (cached). */
  readText(path: FilePath): string | undefined;
  /**
   * Parse an indexed file with its language pack and run `fn` on it; the tree is freed afterwards.
   * Resolves to undefined if the file is unknown or its language has no pack.
   */
  withFile<T>(
    path: FilePath,
    fn: (ctx: FileContext, pack: LanguagePack) => T | Promise<T>,
  ): Promise<T | undefined>;
  /** Report a non-fatal problem (it ends up in `BuildIndexResult.warnings`). */
  warn(message: string): void;
}

export interface PreciseOutput {
  /** References with `resolution: "precise"`, all from files of `PreciseInput.languages`. */
  refs: Reference[];
  /** Tool and version, e.g. "scip-typescript@0.4.0" (goes to `SymbolIndex.languages[lang].tool`). */
  tool: string;
  /**
   * The files of `PreciseInput.languages` the tool described (for SCIP: the documents of its index). Their
   * heuristic references are replaced by `refs`; the heuristic references of the other files are kept. A file
   * that has a reference in `refs` counts as described. Omitted: every file of `languages` is described.
   * A tool that described none of the files (and produced no references) counts as failed.
   */
  describedFiles?: Iterable<FilePath>;
}

export interface PreciseResolver {
  /** Stable id, e.g. "scip-typescript". */
  readonly id: string;
  /** `IndexedFile.language` values this resolver can resolve (typescript, tsx and javascript for scip-typescript). */
  readonly languages: readonly FileLanguage[];
  /** Produce the references of `input.languages`. Throw when the tool is missing or fails. */
  resolve(input: PreciseInput): Promise<PreciseOutput>;
}

const registry: PreciseResolver[] = [];

/** Add a resolver to the registry (replacing one with the same id). */
export function registerPreciseResolver(resolver: PreciseResolver): void {
  const i = registry.findIndex((r) => r.id === resolver.id);
  if (i >= 0) registry[i] = resolver;
  else registry.push(resolver);
}

/** Remove a resolver by id; true if it was registered. */
export function unregisterPreciseResolver(id: string): boolean {
  const i = registry.findIndex((r) => r.id === id);
  if (i < 0) return false;
  registry.splice(i, 1);
  return true;
}

/** The registered resolvers, in registration order. */
export function preciseResolvers(): readonly PreciseResolver[] {
  return registry;
}
