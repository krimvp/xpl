/**
 * @xpl/indexer: file discovery, tree-sitter language packs, reference resolution (ARCHITECTURE.md §3).
 *
 *   buildIndex(opts)      -> { index, warnings, extraction, work }
 *   writeIndex(root, idx) -> <root>/.explainer/index-<commit>.json
 *
 * Also exported, for the CLI and the SCIP importer: file discovery and commit id rules, the language-pack
 * interface and registry (`classifySite` per language), the innermost-symbol lookup, a reparse helper
 * (`ParserPool` + `parseFile` / `withParsedFile`) and the independent provider registry.
 */
export * from "./wasm.js";

export { buildIndex, writeIndex } from "./build.js";
export type { ExtractionReport } from "./extraction-cache.js";
export { repositoryDirectoryIdentities } from "./extraction-cache.js";
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
export type {
  DiscoveredFile,
  DiscoverOptions,
  Discovery,
  ExclusionReport,
  GitInfo,
  GitOptions,
} from "./files.js";
export { createScipProviders } from "./scip/resolvers.js";
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

export { SymbolLookup, assembleSymbols } from "./symbols.js";
export type { AssembledSymbols, SymbolEntry } from "./symbols.js";
export { FileHasher } from "./hash.js";
export { ParserPool, parseFile, withParsedFile } from "./parse.js";
export type { ParsedFile } from "./parse.js";
export { SpanIndex, nodeSpan, pointsToSpan, spanBetween, spanContains } from "./ast.js";

export { registerProvider, unregisterProvider, indexProviders } from "./providers.js";
export { normalizeProvider, mergeProvider, providerRange } from "./providers.js";
export type {
  ProviderInput,
  ProviderOutput,
  ProviderDeclaration,
  ProviderRelationship,
  ProviderSource,
  ProviderRange,
  IndexProvider,
} from "./providers.js";
export { TreeSitterProvider } from "./tree-sitter.js";
export { scipArtifactProvider } from "./scip/artifact.js";
export type { ScipArtifactManifest, ScipArtifactOptions } from "./scip/artifact.js";
export { resolveHeuristic } from "./resolve/heuristic.js";
export type { ResolverFile, ResolverInput } from "./resolve/heuristic.js";

export { captureIndexInputs, indexInputsChanged } from "./snapshot.js";
export type { IndexInputs } from "./snapshot.js";

export type { IndexProgress } from "./progress.js";
