/**
 * @xpl/indexer: file discovery, tree-sitter language packs, reference resolution (ARCHITECTURE.md §3).
 *
 *   buildIndex(opts)      -> { index, warnings }
 *   writeIndex(root, idx) -> <root>/.explainer/index-<commit>.json
 *
 * Also exported, for the CLI and the SCIP importer: file discovery and commit id rules, the language-pack
 * interface and registry (`classifySite` per language), the innermost-symbol lookup, a reparse helper
 * (`ParserPool` + `parseFile` / `withParsedFile`) and the precise-resolver registry.
 */
export * from "./wasm.js";

export { buildIndex, writeIndex } from "./build.js";
export type { BuildIndexOptions, BuildIndexResult } from "./build.js";

export {
  discoverFiles,
  detectGit,
  isLockfile,
  languageForPath,
  readSource,
  FILE_LANGUAGES,
  MAX_FILE_BYTES,
} from "./files.js";
export type { DiscoveredFile, DiscoverOptions, Discovery, GitInfo } from "./files.js";
export {
  isWorkTreeClean,
  resolveCommitId,
  shortHead,
  validateCommitId,
  workingTreeId,
} from "./commit.js";
export type { CommitIdOptions } from "./commit.js";

export {
  languagePacks,
  packFor,
  packForFile,
  typescriptPack,
  pythonPack,
  goPack,
  yamlPack,
  jsonPack,
  tomlPack,
} from "./languages/index.js";
export type {
  ClassifiedSite,
  ExportFact,
  FileContext,
  FileFacts,
  ImportBinding,
  LanguagePack,
  RepoView,
  SiteDraft,
  SiteKind,
  Span,
  SymbolDraft,
  TypeFact,
} from "./languages/index.js";

export { SymbolLookup, assembleSymbols, moduleScopeId, stripDuplicateSuffix } from "./symbols.js";
export type { AssembledSymbols, SymbolEntry } from "./symbols.js";
export { FileHasher } from "./hash.js";
export { ParserPool, parseFile, withParsedFile } from "./parse.js";
export type { ParsedFile } from "./parse.js";
export { SpanIndex, nodeSpan, pointsToSpan, spanBetween, spanContains } from "./ast.js";

export { registerPreciseResolver, unregisterPreciseResolver, preciseResolvers } from "./precise.js";
export type { PreciseInput, PreciseOutput, PreciseResolver } from "./precise.js";
export { resolveHeuristic } from "./resolve/heuristic.js";
export type { ResolverFile, ResolverInput } from "./resolve/heuristic.js";
