/**
 * `buildIndex` and `writeIndex` (ARCHITECTURE.md §3).
 *
 * Pipeline: capture source -> TreeSitterProvider extracts declarations and heuristic relationships ->
 * normalize and merge -> optional semantic providers feed the same normalization and coverage merge ->
 * commit id and language summary. xpl owns IDs, hashes, source evidence and canonical positions.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { ExtractionCache, type ExtractionReport } from "./extraction-cache.js";
import type { TypeScriptResolutionExperiment } from "./resolve/typescript-experiment.js";
import { statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { splitLines, INDEX_SCHEMA, RELATIONSHIP_CAPABILITIES } from "@xpl/core";
import type {
  AnalysisReport,
  FileLanguage,
  FilePath,
  IndexedFile,
  LanguageInfo,
  Reference,
  SymbolIndex,
} from "@xpl/core";
import pkg from "../package.json" with { type: "json" };
import { resolveCommitId, validateCommitId } from "./commit.js";
import { FILE_LANGUAGES, detectGit, discoverFiles, readSource } from "./files.js";
import { FileHasher } from "./hash.js";
import { packForFile } from "./languages/index.js";
import type { LanguagePack } from "./languages/types.js";
import { ParserPool } from "./parse.js";
import { indexProviders } from "./providers.js";
import type { IndexProvider } from "./providers.js";
import "./tags/rust.js"; // registers syntax-only Rust tags
import "./scip/index.js"; // registers the SCIP providers (scip-typescript, scip-python, scip-go)
import { SymbolLookup } from "./symbols.js";
import type { SymbolEntry } from "./symbols.js";
import { spanContains } from "./ast.js";
import { GRAMMAR_WASM } from "./wasm-files.js";
import { resolveResources } from "./resources.js";
import { relationshipReport } from "./analysis.js";
import { TreeSitterProvider, syntaxClassifier } from "./tree-sitter.js";
import { SourceRepoView } from "./repo.js";
import { mergeProvider, normalizeProvider } from "./providers.js";
import type { ProviderInput, ProviderSource } from "./providers.js";

/** Options of `buildIndex` (ARCHITECTURE.md §3). */
export interface BuildIndexOptions {
  /** Directory to index; paths in the index are relative to it. */
  root: string;
  /** Reuse file-local extraction in .explainer/cache. false neither reads nor writes the cache. */
  cache?: boolean;
  /** Off-default, in-memory TypeScript heuristic investigation; not used by the CLI. */
  experimentalResolution?: TypeScriptResolutionExperiment;
  /** Commit id override. Default: short HEAD when clean, else `wt-<hash>` (see §3). */
  commit?: string;
  /** Precise (SCIP) references: "auto" falls back to heuristic refs, "require" fails instead, "off" skips. */
  precise?: "auto" | "off" | "require";
  /** Restrict to these languages (`IndexedFile.language` values). Default: all. */
  languages?: string[];
  /** Providers to use instead of the additional provider registry (see providers.ts). */
  providers?: readonly IndexProvider[];
}

export interface BuildIndexResult {
  index: SymbolIndex;
  warnings: string[];
  extraction: ExtractionReport;
  work: { heuristicResolutionMs: number; semanticMs: number; semanticRuns: number };
}

async function resolveRoot(root: string): Promise<string> {
  const abs = resolve(root);
  let info;
  try {
    info = statSync(abs);
  } catch {
    throw new Error(`cannot index "${root}": no such directory`);
  }
  if (!info.isDirectory()) throw new Error(`cannot index "${root}": not a directory`);
  return abs;
}

function parseLanguageFilter(languages: readonly string[] | undefined): FileLanguage[] | undefined {
  if (!languages) return undefined;
  const known = new Set<string>(FILE_LANGUAGES);
  const bad = languages.filter((l) => !known.has(l));
  if (bad.length > 0) {
    throw new Error(
      `unknown language${bad.length > 1 ? "s" : ""} ${bad.map((b) => `"${b}"`).join(", ")} (expected: ${FILE_LANGUAGES.join(", ")})`,
    );
  }
  return languages as FileLanguage[];
}

/** `tree-sitter-x@version` of a grammar package, from this package's pinned dependencies. */
function grammarVersion(name: string): string {
  const deps = pkg.dependencies as Record<string, string>;
  return `${name.replace(/^@[^/]+\//, "")}@${(deps[name] ?? "?").replace(/^[\^~]/, "")}`;
}

/** `grammarVersion` of every grammar package the used packs parse with, sorted. */
function grammarVersions(
  packs: readonly { pack: LanguagePack; language: FileLanguage }[],
): string[] {
  const names = new Set<string>();
  for (const { pack, language } of packs) names.add(GRAMMAR_WASM[pack.grammarFor(language)].pkg);
  return [...names].sort().map(grammarVersion);
}

/**
 * The heuristic references to keep where the precise tool saw an occurrence it could not link
 * (`RelationshipResult.blind`): per position, the reference with the smallest site that holds it.
 */
function keptAtBlind(
  refs: readonly Reference[],
  blind: readonly { file: FilePath; line: number; col: number }[],
  precise: readonly Reference[],
): Set<Reference> {
  const kept = new Set<Reference>();
  if (blind.length === 0) return kept;
  // an edge the tool has at the same line already is not kept twice
  const edge = (r: Reference) => `${r.from}\0${r.to}\0${r.kind}\0${r.site.startLine}`;
  const known = new Set(precise.map(edge));
  const byFile = new Map<FilePath, Reference[]>();
  for (const ref of refs) {
    const file = fileOfId(ref.from);
    const list = byFile.get(file);
    if (list) list.push(ref);
    else byFile.set(file, [ref]);
  }
  const size = (r: Reference) =>
    (r.site.endLine - r.site.startLine) * 100_000 + ((r.site.endCol ?? 0) - (r.site.startCol ?? 0));
  for (const at of blind) {
    let best: Reference | undefined;
    for (const ref of byFile.get(at.file) ?? []) {
      if (ref.kind === "import" || !spanContains(siteSpan(ref), at.line, at.col)) continue;
      if (!best || size(ref) < size(best)) best = ref;
    }
    if (best && !known.has(edge(best))) kept.add(best);
  }
  return kept;
}

function siteSpan(ref: Reference) {
  return {
    startLine: ref.site.startLine,
    startCol: ref.site.startCol ?? 1,
    endLine: ref.site.endLine,
    endCol: ref.site.endCol ?? Number.MAX_SAFE_INTEGER,
  };
}

function fileOfId(id: string): FilePath {
  return id.slice(0, id.indexOf("#"));
}

function compareRefs(a: Reference, b: Reference): number {
  const fromA = fileOfId(a.from);
  const fromB = fileOfId(b.from);
  if (fromA !== fromB) return fromA < fromB ? -1 : 1;
  return (
    a.site.startLine - b.site.startLine ||
    (a.site.startCol ?? 0) - (b.site.startCol ?? 0) ||
    a.site.endLine - b.site.endLine ||
    (a.site.endCol ?? 0) - (b.site.endCol ?? 0) ||
    (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) ||
    (a.from < b.from ? -1 : a.from > b.from ? 1 : 0) ||
    (a.to < b.to ? -1 : a.to > b.to ? 1 : 0)
  );
}

/** Build the symbol index of `opts.root`. */
export async function buildIndex(opts: BuildIndexOptions): Promise<BuildIndexResult> {
  const root = await resolveRoot(opts.root);
  const precise = opts.precise ?? "auto";
  if (precise !== "auto" && precise !== "off" && precise !== "require") {
    throw new Error(`invalid precise mode "${String(precise)}" (expected auto, off or require)`);
  }
  const languageFilter = parseLanguageFilter(opts.languages);
  const warnings: string[] = [];

  // 1. Discover files.
  const git = await detectGit(root);
  const discovery = await discoverFiles(root, { git, languages: languageFilter });
  warnings.push(...discovery.warnings);

  const sources: ProviderSource[] = [];
  for (const file of discovery.files) {
    try {
      sources.push({ path: file.path, language: file.language, text: await readSource(file) });
    } catch {
      /* Deleted or unreadable since discovery. */
    }
  }
  const files: IndexedFile[] = sources.map((s) => ({
    path: s.path,
    language: s.language,
    hash: new FileHasher(splitLines(s.text)).hashFile(),
    lines: splitLines(s.text).length,
  }));
  const repo = new SourceRepoView(
    root,
    files.map((f) => f.path),
  );
  const sourceText = new Map(sources.map((s) => [s.path, s.text]));
  const extractionCache = new ExtractionCache(root, opts.cache !== false);
  const work = { heuristicResolutionMs: 0, semanticMs: 0, semanticRuns: 0 };
  const providerInput: ProviderInput = {
    extractionCache,
    root,
    sources,
    files,
    languages: [...new Set(files.map((f) => f.language))],
    symbols: [],
    lookup: new SymbolLookup([]),
    warn: (m) => warnings.push(m),
    readText: (path) => sourceText.get(path) ?? repo.readText(path),
  };
  const syntax = new TreeSitterProvider(opts.experimentalResolution);
  const syntaxOutput = await syntax.analyze(providerInput);
  work.heuristicResolutionMs = syntax.resolutionMs;
  const normalizedSyntax = normalizeProvider(providerInput, syntaxOutput);
  let { entries, refs, providers } = mergeProvider({ entries: [], refs: [] }, normalizedSyntax);
  const additionalProviders = opts.providers ?? indexProviders();
  const syntaxLanguages = new Set(
    additionalProviders.filter((p) => p.mode === "syntax").flatMap((p) => p.languages),
  );
  const analysis = normalizedSyntax.analysis
    .map((report) =>
      report.provider === "text"
        ? {
            ...report,
            files: report.files.filter(
              (file) => !syntaxLanguages.has(files.find((f) => f.path === file)!.language),
            ),
          }
        : report,
    )
    .filter((report) => report.files.length > 0);
  const usedPacks = syntax.usedPacks;
  const resourceSites = syntax.resourceSites;
  warnings.push(...syntax.warnings);
  const lookup = new SymbolLookup(entries);
  providerInput.lookup = lookup;
  providerInput.symbols = entries.map((e) => ({ ...e.symbol, range: e.span }));
  const heuristicFiles = sources.filter(
    (s) => packForFile(s.path, s.language)?.refs === "heuristic",
  );

  // 4. Precise references replace the heuristic ones of the languages they cover.
  const languageOfFile = new Map<FilePath, FileLanguage>(files.map((f) => [f.path, f.language]));
  const refLanguages = new Set<FileLanguage>(
    sources
      .filter(
        (s) =>
          packForFile(s.path, s.language)?.refs === "heuristic" ||
          additionalProviders.some((p) => p.mode === "syntax" && p.languages.includes(s.language)),
      )
      .map((s) => s.language),
  );
  const preciseTools = new Map<FileLanguage, string>();
  // Last replacement of each file/kind owns its resolution, even when it emitted no references.
  const relationshipAnalysis = new Map<
    string,
    {
      file: FilePath;
      resolution: Reference["resolution"] | undefined;
      tool: string;
    }
  >();
  /** Per language: files that keep heuristic references because the precise tool did not describe them. */
  const keptHeuristicFiles = new Map<FileLanguage, number>();
  {
    const available = additionalProviders.filter((p) => p.mode === "syntax" || precise !== "off");
    if (precise === "require") {
      const uncovered = [...refLanguages].filter(
        (l) =>
          !available.some(
            (r) =>
              r.mode !== "syntax" &&
              r.languages.includes(l) &&
              RELATIONSHIP_CAPABILITIES.some((c) => r.capabilities[c]),
          ),
      );
      if (uncovered.length > 0) {
        throw new Error(
          `precise references are required (precise: "require") but no precise provider is available for: ${uncovered.sort().join(", ")}`,
        );
      }
    }
    const sourcePool = new ParserPool();
    providerInput.classify = syntaxClassifier(sourcePool, providerInput);
    try {
      for (const provider of available) {
        const languages = provider.languages.filter((l) => files.some((f) => f.language === l));
        if (languages.length === 0) continue;
        const reportFiles = files.filter((f) => languages.includes(f.language)).map((f) => f.path);
        const diagnostics: string[] = [];
        let observed: AnalysisReport[] | undefined;
        try {
          const input: ProviderInput = {
            ...providerInput,
            languages,
            symbols: entries.map((e) => ({ ...e.symbol, range: e.span })),
            lookup: new SymbolLookup(entries),
            warn: (message) => {
              warnings.push(message);
              diagnostics.push(message);
            },
          };
          const started = performance.now();
          if (provider.mode !== "syntax") work.semanticRuns++;
          let output;
          try {
            output = await provider.analyze(input);
          } finally {
            if (provider.mode !== "syntax") work.semanticMs += performance.now() - started;
          }
          const normalized = normalizeProvider(input, output);
          observed = normalized.analysis;
          const advertised = Object.keys(provider.capabilities);
          const usable = observed
            .flatMap((report) => report.results)
            .filter(
              (result) =>
                (result.status === "supported" || result.status === "partial") &&
                result.analyzedFiles.length > 0 &&
                result.capabilities.some((c) => advertised.includes(c)),
            );
          if (!usable.length) {
            const allUnavailable =
              advertised.length > 0 &&
              advertised.every((c) =>
                observed!.some((report) =>
                  report.results.some(
                    (r) =>
                      r.capabilities.includes(c as keyof typeof provider.capabilities) &&
                      (r.status === "failed" || r.status === "unsupported"),
                  ),
                ),
              );
            if (allUnavailable)
              throw new Error(
                `all advertised ${provider.mode === "syntax" ? "capabilities" : "relationship kinds"} failed or were unsupported`,
              );
            throw new Error(
              `the tool described none of the ${reportFiles.length} ${languages.join("/")} file(s)`,
            );
          }
          const kept = keptAtBlind(refs, output.blind ?? [], normalized.refs);
          ({ entries, refs, providers } = mergeProvider(
            { entries, refs, providers },
            normalized,
            kept,
          ));
          analysis.push(...observed);
          const heuristicKinds = new Set(
            normalized.refs
              .filter((r) => r.resolution === "heuristic")
              .map((r) => `${fileOfId(r.from)}\0${r.kind}`),
          );
          for (const report of observed) {
            for (const result of report.results) {
              if (!usable.includes(result)) continue;
              for (const kind of RELATIONSHIP_CAPABILITIES) {
                if (
                  !provider.capabilities[kind] ||
                  !report.capabilities[kind] ||
                  !result.capabilities.includes(kind)
                )
                  continue;
                for (const file of result.analyzedFiles) {
                  if (!report.files.includes(file) || !reportFiles.includes(file)) continue;
                  const key = `${file}\0${kind}`;
                  relationshipAnalysis.set(key, {
                    file,
                    resolution: heuristicKinds.has(key) ? "heuristic" : result.resolution,
                    tool: output.tool,
                  });
                }
              }
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          analysis.push(
            ...(observed?.map((report) => ({
              ...report,
              diagnostics: [...(report.diagnostics ?? []), ...diagnostics, message],
            })) ?? [
              relationshipReport(provider, reportFiles, undefined, [...diagnostics, message]),
            ]),
          );
          if (precise === "require")
            throw new Error(
              `${provider.mode === "syntax" ? "syntax" : "precise"} provider "${provider.id}" failed: ${message}`,
            );
          warnings.push(
            provider.mode === "syntax"
              ? `syntax provider "${provider.id}" failed (${message}); previous checked facts remain`
              : `precise provider "${provider.id}" failed (${message}); using heuristic references for ${languages.join(", ")}`,
          );
        }
      }
    } finally {
      await sourcePool.dispose();
    }
    const preciseFiles = new Set<FilePath>();
    for (const { file, resolution, tool } of relationshipAnalysis.values()) {
      if (resolution !== "precise") continue;
      preciseFiles.add(file);
      preciseTools.set(languageOfFile.get(file)!, tool);
    }
    for (const language of preciseTools.keys()) {
      const count = heuristicFiles.filter(
        (f) => f.language === language && !preciseFiles.has(f.path),
      ).length;
      if (count) keptHeuristicFiles.set(language, count);
    }
    if (precise === "require") {
      const missing = [...refLanguages].filter((l) => !preciseTools.has(l));
      if (missing.length)
        throw new Error(
          `precise references are required but no usable precise relationship analysis was produced for: ${missing.sort().join(", ")}`,
        );
    }
  }
  refs.sort(compareRefs);

  // 5. Commit id, language summary, tool string.
  const commit = await resolveCommitId({ commit: opts.commit, git, files, root });
  const languages = summarizeLanguages(files, entries, usedPacks, preciseTools, keptHeuristicFiles);
  const tool =
    `xpl-indexer@${pkg.version} web-tree-sitter@${pkg.dependencies["web-tree-sitter"]} ${grammarVersions(usedPacks).join(" ")}`.trim();

  const resources = resolveResources(
    resourceSites,
    files.map((file) => file.path),
    entries,
  );
  const index: SymbolIndex = {
    schema: INDEX_SCHEMA,
    commit,
    tool,
    languages,
    root,
    files,
    symbols: entries.map((e) => e.symbol),
    refs,
    providers,
    analysis,
    ...(resources.length > 0 ? { resources } : {}),
  };
  return { index, warnings, extraction: extractionCache.report, work };
}

function summarizeLanguages(
  files: readonly IndexedFile[],
  entries: readonly SymbolEntry[],
  usedPacks: readonly { pack: LanguagePack; language: FileLanguage }[],
  preciseTools: ReadonlyMap<FileLanguage, string>,
  keptHeuristicFiles: ReadonlyMap<FileLanguage, number> = new Map(),
): Record<string, LanguageInfo> {
  const languageOf = new Map<FilePath, FileLanguage>(files.map((f) => [f.path, f.language]));
  const packOf = new Map<FileLanguage, LanguagePack>(usedPacks.map((u) => [u.language, u.pack]));
  const counts = new Map<FileLanguage, { files: number; symbols: number }>();
  for (const file of files) {
    const c = counts.get(file.language) ?? { files: 0, symbols: 0 };
    c.files++;
    counts.set(file.language, c);
  }
  for (const entry of entries) {
    const language = languageOf.get(entry.symbol.file);
    if (language !== undefined) counts.get(language)!.symbols++;
  }
  const result: Record<string, LanguageInfo> = {};
  for (const language of [...counts.keys()].sort()) {
    const c = counts.get(language)!;
    const info: LanguageInfo = { files: c.files, symbols: c.symbols, refs: "none" };
    const tool = preciseTools.get(language);
    const pack = packOf.get(language);
    if (tool !== undefined) {
      info.refs = "precise";
      info.tool = tool;
      const kept = keptHeuristicFiles.get(language) ?? 0;
      if (kept > 0) info.heuristicFiles = kept;
    } else if (pack && pack.refs === "heuristic") {
      info.refs = "heuristic";
      info.tool = `xpl-heuristic@${pkg.version} (${grammarVersion(GRAMMAR_WASM[pack.grammarFor(language)].pkg)})`;
    }
    result[language] = info;
  }
  return result;
}

/** Contents `.explainer/.gitignore` must have: the generated indexes are never committed. */
const GITIGNORE_LINES = ["index-*.json", "cache/"];

/**
 * Write `<root>/.explainer/index-<commit>.json` (pretty-printed) and make sure `.explainer/.gitignore`
 * ignores `index-*.json`. Returns the absolute path of the index file.
 */
export async function writeIndex(root: string, index: SymbolIndex): Promise<string> {
  const dir = join(resolve(root), ".explainer");
  const commit = validateCommitId(index.commit);
  await mkdir(dir, { recursive: true });

  const ignorePath = join(dir, ".gitignore");
  let existing: string | undefined;
  try {
    existing = await readFile(ignorePath, "utf8");
  } catch {
    existing = undefined;
  }
  const missing = GITIGNORE_LINES.filter(
    (line) => !(existing ?? "").split(/\r?\n/).some((old) => old.trim() === line),
  );
  if (missing.length) {
    await writeFile(
      ignorePath,
      `${existing ?? ""}${existing && !existing.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`,
    );
  }

  const target = join(dir, `index-${commit}.json`);
  const temp = join(dir, `.index-${commit}.json.${randomUUID()}.tmp`);
  await writeFile(temp, `${JSON.stringify(index, null, 2)}\n`);
  await rename(temp, target);
  return normalize(target);
}
