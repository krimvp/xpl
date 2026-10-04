/**
 * `buildIndex` and `writeIndex` (ARCHITECTURE.md §3).
 *
 * Pipeline: discover files -> for each file: read, hash, parse once, let the language pack extract facts
 * from the tree, free the tree -> assemble symbols (ids, `~N` suffixes, ranges, hashes, parents) ->
 * heuristic resolution of all sites -> optional precise resolvers replace the references of the files they
 * describe (the other files of their languages keep the heuristic ones) -> commit id -> `SymbolIndex`.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, posix, resolve } from "node:path";
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
import type { DiscoveredFile } from "./files.js";
import { packForFile } from "./languages/index.js";
import type { FileFacts, LanguagePack, RepoView } from "./languages/types.js";
import { ParserPool, parseFile, withParsedFile } from "./parse.js";
import { preciseResolvers } from "./precise.js";
import type { PreciseResolver } from "./precise.js";
import "./scip/index.js"; // registers the SCIP resolvers (scip-typescript, scip-python, scip-go)
import { resolveHeuristic } from "./resolve/heuristic.js";
import type { ResolverFile } from "./resolve/heuristic.js";
import { SymbolLookup, assembleSymbols } from "./symbols.js";
import type { SymbolEntry } from "./symbols.js";
import { spanContains } from "./ast.js";
import { findSyntaxErrors, significantSyntaxErrors, syntaxErrorWarning } from "./syntax-errors.js";
import type { SyntaxErrorFile } from "./syntax-errors.js";
import { GRAMMAR_WASM } from "./wasm-files.js";
import { collectResourceSites, resolveResources, type ResourceSite } from "./resources.js";
import { extractionReports, preciseReport, type ExtractionOutcome } from "./analysis.js";

/** Options of `buildIndex` (ARCHITECTURE.md §3). */
export interface BuildIndexOptions {
  /** Directory to index; paths in the index are relative to it. */
  root: string;
  /** Commit id override. Default: short HEAD when clean, else `wt-<hash>` (see §3). */
  commit?: string;
  /** Precise (SCIP) references: "auto" falls back to heuristic refs, "require" fails instead, "off" skips. */
  precise?: "auto" | "off" | "require";
  /** Restrict to these languages (`IndexedFile.language` values). Default: all. */
  languages?: string[];
  /** Precise resolvers to use instead of the registry (see precise.ts). */
  resolvers?: readonly PreciseResolver[];
}

export interface BuildIndexResult {
  index: SymbolIndex;
  warnings: string[];
}

/** `RepoView` over the indexed files of a build. */
class BuildRepoView implements RepoView {
  readonly files: ReadonlySet<FilePath>;
  private readonly dirs = new Map<string, FilePath[]>();
  private readonly texts = new Map<FilePath, string | undefined>();

  constructor(
    readonly root: string,
    paths: readonly FilePath[],
  ) {
    this.files = new Set(paths);
    for (const path of paths) {
      const dir = posix.dirname(path) === "." ? "" : posix.dirname(path);
      const list = this.dirs.get(dir);
      if (list) list.push(path);
      else this.dirs.set(dir, [path]);
    }
    for (const list of this.dirs.values()) list.sort();
  }

  filesInDir(dir: string): readonly FilePath[] {
    return this.dirs.get(dir === "." ? "" : dir) ?? [];
  }

  readText(path: FilePath): string | undefined {
    if (this.texts.has(path)) return this.texts.get(path);
    let text: string | undefined;
    const normalized = posix.normalize(path);
    if (!normalized.startsWith("../") && !isAbsolute(normalized)) {
      try {
        text = readFileSync(join(this.root, ...normalized.split("/")), "utf8");
      } catch {
        text = undefined;
      }
    }
    this.texts.set(path, text);
    return text;
  }
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

/** File a reference belongs to: the file part of its `from` id. */
/**
 * The heuristic references to keep where the precise tool saw an occurrence it could not link
 * (`PreciseOutput.blind`): per position, the reference with the smallest site that holds it.
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

function isTestData(path: FilePath): boolean {
  return /(?:^|\/)(?:testdata|fixtures|__fixtures__)\//.test(path);
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

/** `from -> to (kind)` at a site: what makes two references the same one. */
function refKey(ref: Reference): string {
  const s = ref.site;
  return `${ref.from}\0${ref.to}\0${ref.kind}\0${s.startLine}:${s.startCol ?? 0}-${s.endLine}:${s.endCol ?? 0}`;
}

/**
 * References the packs infer from all their files at once (`LanguagePack.inferRefs`, e.g. Go's implicit
 * interfaces). Runs once per pack that declares the hook and has heuristic files; returns only refs that are
 * new, marked heuristic.
 */
function inferPackRefs(
  files: readonly ResolverFile[],
  entries: readonly SymbolEntry[],
  lookup: SymbolLookup,
  repo: RepoView,
  refs: readonly Reference[],
): Reference[] {
  const seen = new Set(refs.map(refKey));
  const out: Reference[] = [];
  for (const pack of new Set(files.map((f) => f.pack))) {
    if (!pack.inferRefs) continue;
    const inferred = pack.inferRefs({
      files: files.filter((f) => f.pack === pack),
      entries,
      lookup,
      repo,
      refs,
    });
    for (const { from, to, kind, site } of inferred) {
      if (from === to) continue;
      const ref: Reference = { from, to, kind, site: { ...site }, resolution: "heuristic" };
      const key = refKey(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ref);
    }
  }
  return out;
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

  // 2. Read, hash, parse once, extract facts, free the tree.
  const files: IndexedFile[] = [];
  const entries: SymbolEntry[] = [];
  const resolverFiles: ResolverFile[] = [];
  const usedPacks: { pack: LanguagePack; language: FileLanguage }[] = [];
  const usedPackKeys = new Set<string>();
  const syntaxErrors: SyntaxErrorFile[] = [];
  const resourceSites: ResourceSite[] = [];
  const extractionOutcomes = new Map<FilePath, ExtractionOutcome>();
  const pool = new ParserPool();
  try {
    for (const discovered of discovery.files) {
      const indexed = await indexFile(
        discovered,
        pool,
        entries,
        resolverFiles,
        syntaxErrors,
        warnings,
        resourceSites,
      );
      if (!indexed) continue;
      files.push(indexed.file);
      extractionOutcomes.set(indexed.file.path, indexed.outcome);
      if (indexed.pack) {
        const key = `${indexed.pack.id}\0${indexed.file.language}`;
        if (!usedPackKeys.has(key)) {
          usedPackKeys.add(key);
          usedPacks.push({ pack: indexed.pack, language: indexed.file.language });
        }
      }
    }
  } finally {
    await pool.dispose();
  }
  if (syntaxErrors.length > 0) warnings.push(syntaxErrorWarning(syntaxErrors));
  const analysis = extractionReports(files, usedPacks, extractionOutcomes);

  // 3. Heuristic references for every language whose pack derives them.
  const lookup = new SymbolLookup(entries);
  const repo = new BuildRepoView(
    root,
    files.map((f) => f.path),
  );
  const heuristicFiles = resolverFiles.filter((f) => f.pack.refs === "heuristic");
  let refs = resolveHeuristic({ files: heuristicFiles, entries, lookup, repo });
  refs = refs.concat(inferPackRefs(heuristicFiles, entries, lookup, repo, refs));

  // 4. Precise references replace the heuristic ones of the languages they cover.
  const languageOfFile = new Map<FilePath, FileLanguage>(files.map((f) => [f.path, f.language]));
  const refLanguages = new Set<FileLanguage>(heuristicFiles.map((f) => f.language));
  const preciseTools = new Map<FileLanguage, string>();
  /** Per language: files that keep heuristic references because the precise tool did not describe them. */
  const keptHeuristicFiles = new Map<FileLanguage, number>();
  if (precise !== "off") {
    const available = opts.resolvers ?? preciseResolvers();
    if (precise === "require") {
      const uncovered = [...refLanguages].filter(
        (l) => !available.some((r) => r.languages.includes(l)),
      );
      if (uncovered.length > 0) {
        throw new Error(
          `precise references are required (precise: "require") but no precise resolver is available for: ${uncovered.sort().join(", ")}`,
        );
      }
    }
    const symbols = entries.map((e) => e.symbol);
    const sourcePool = new ParserPool();
    try {
      for (const resolver of available) {
        const languages = resolver.languages.filter(
          (l) => refLanguages.has(l) && !preciseTools.has(l),
        );
        if (languages.length === 0) continue;
        const reportFiles = files.filter((f) => languages.includes(f.language)).map((f) => f.path);
        const diagnostics: string[] = [];
        let failedReport: AnalysisReport | undefined;
        try {
          const output = await resolver.resolve({
            root,
            languages,
            files,
            symbols,
            lookup,
            readText: (path) => repo.readText(path),
            withFile: async (path, fn) => {
              const language = languageOfFile.get(path);
              const text = repo.readText(path);
              if (language === undefined || text === undefined) return undefined;
              return withParsedFile(sourcePool, path, language, text, fn);
            },
            warn: (message) => {
              warnings.push(message);
              diagnostics.push(message);
            },
          });
          const advertisedKinds = RELATIONSHIP_CAPABILITIES.filter(
            (kind) => !resolver.capabilities || resolver.capabilities[kind],
          );
          if (
            advertisedKinds.length > 0 &&
            advertisedKinds.every((kind) => {
              const status = output.coverage?.[kind]?.status;
              return status === "failed" || status === "unsupported";
            })
          ) {
            failedReport = preciseReport(resolver, reportFiles, output, diagnostics);
            throw new Error("all advertised relationship kinds failed or were unsupported");
          }
          const covered = new Set<FileLanguage>(languages);
          const replacesKind = (kind: Reference["kind"], file: FilePath): boolean => {
            if (resolver.capabilities && !resolver.capabilities[kind]) return false;
            const observation = output.coverage?.[kind];
            return (
              !observation ||
              (observation.status !== "failed" &&
                observation.status !== "unsupported" &&
                observation.analyzedFiles.includes(file))
            );
          };
          const preciseRefs = output.refs.filter((ref) => {
            const file = fileOfId(ref.from);
            const language = languageOfFile.get(file);
            return language !== undefined && covered.has(language) && replacesKind(ref.kind, file);
          });
          // Replace supported kinds in described files; unexamined, unsupported or failed kinds keep heuristic hints.
          // Describing a file controls replacement, not the completeness recorded in its analysis report.
          // Materialize once: describedFiles may be a single-use iterable.
          const described = new Set<FilePath>(output.describedFiles ?? []);
          for (const ref of preciseRefs) described.add(fileOfId(ref.from));
          const replaces = (file: FilePath): boolean =>
            output.describedFiles === undefined || described.has(file);
          const describedIn = new Set<FileLanguage>();
          for (const file of described) {
            const language = languageOfFile.get(file);
            if (language !== undefined && covered.has(language)) describedIn.add(language);
          }
          // A language none of whose files was described is not precise, whatever else the tool covered.
          const preciseLanguages =
            output.describedFiles === undefined
              ? languages
              : languages.filter((l) => describedIn.has(l));
          if (preciseLanguages.length === 0) {
            const total = heuristicFiles.filter((f) => covered.has(f.language)).length;
            throw new Error(
              `the tool described none of the ${total} ${languages.join("/")} file(s)`,
            );
          }
          const kept = keptAtBlind(refs, output.blind ?? [], preciseRefs);
          analysis.push(
            preciseReport(
              resolver,
              reportFiles,
              { ...output, describedFiles: described },
              diagnostics,
            ),
          );
          refs = refs.filter((ref) => {
            const file = fileOfId(ref.from);
            return (
              kept.has(ref) ||
              !(
                covered.has(languageOfFile.get(file)!) &&
                replaces(file) &&
                replacesKind(ref.kind, file)
              )
            );
          });
          for (const ref of preciseRefs) refs.push(ref);
          for (const language of preciseLanguages) preciseTools.set(language, output.tool);
          for (const file of heuristicFiles) {
            if (preciseLanguages.includes(file.language) && !replaces(file.path)) {
              keptHeuristicFiles.set(
                file.language,
                (keptHeuristicFiles.get(file.language) ?? 0) + 1,
              );
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          analysis.push(
            failedReport
              ? { ...failedReport, diagnostics: [...diagnostics, message] }
              : preciseReport(resolver, reportFiles, undefined, [...diagnostics, message]),
          );
          if (precise === "require")
            throw new Error(`precise resolver "${resolver.id}" failed: ${message}`);
          warnings.push(
            `precise resolver "${resolver.id}" failed (${message}); using heuristic references for ${languages.join(", ")}`,
          );
        }
      }
    } finally {
      await sourcePool.dispose();
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
    analysis,
    ...(resources.length > 0 ? { resources } : {}),
  };
  return { index, warnings };
}

/** Read, hash, parse and extract one file. Undefined if the file vanished. */
async function indexFile(
  discovered: DiscoveredFile,
  pool: ParserPool,
  entries: SymbolEntry[],
  resolverFiles: ResolverFile[],
  syntaxErrors: SyntaxErrorFile[],
  warnings: string[],
  resourceSites: ResourceSite[],
): Promise<
  { file: IndexedFile; pack: LanguagePack | undefined; outcome: ExtractionOutcome } | undefined
> {
  let text: string;
  try {
    text = await readSource(discovered);
  } catch {
    return undefined; // deleted or unreadable since discovery
  }
  const lines = splitLines(text);
  const hasher = new FileHasher(lines);
  const file: IndexedFile = {
    path: discovered.path,
    language: discovered.language,
    hash: hasher.hashFile(),
    lines: lines.length,
  };
  const pack = packForFile(discovered.path, discovered.language);
  const outcome: ExtractionOutcome = { status: "supported", limitations: [] };
  if (!pack) return { file, pack, outcome };

  let facts: FileFacts | undefined;
  try {
    const parsed = await parseFile(pool, discovered.path, discovered.language, text);
    if (parsed) {
      try {
        facts = pack.extract(parsed.ctx);
        resourceSites.push(...collectResourceSites(parsed.ctx));
        const errors = significantSyntaxErrors(
          discovered.path,
          findSyntaxErrors(parsed.ctx.tree.rootNode, pack),
        );
        if (errors) {
          outcome.status = "partial";
          outcome.limitations.push("Syntax errors may leave symbols and relationships incomplete.");
        }
        // test data is odd on purpose (Go fuzz corpora named `.json`, broken files a parser test reads)
        if (errors && !isTestData(discovered.path)) syntaxErrors.push(errors);
      } finally {
        parsed.dispose();
      }
    }
  } catch (error) {
    outcome.diagnostics = [
      `${discovered.path}: ${error instanceof Error ? error.message : String(error)}`,
    ];
    warnings.push(
      `${discovered.path}: ${discovered.language} extraction failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!facts)
    return {
      file,
      pack,
      outcome: {
        diagnostics: outcome.diagnostics,
        status: "failed",
        limitations: ["Source analysis failed; only file anchors are available."],
      },
    };
  if (facts.warnings?.length) {
    outcome.status = "partial";
    outcome.limitations.push(...facts.warnings);
    outcome.diagnostics = facts.warnings.map((w) => `${discovered.path}: ${w}`);
  }
  for (const warning of facts.warnings ?? []) warnings.push(`${discovered.path}: ${warning}`);
  for (const entry of assembleSymbols(discovered.path, lines, facts.symbols, hasher).entries)
    entries.push(entry);
  resolverFiles.push({
    path: discovered.path,
    language: discovered.language,
    pack,
    sites: facts.sites,
    imports: facts.imports,
    typeFacts: facts.typeFacts,
    exports: facts.exports ?? [],
    ...(facts.data !== undefined ? { data: facts.data } : {}),
  });
  return { file, pack, outcome };
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
const GITIGNORE_LINE = "index-*.json";

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
  if (existing === undefined) {
    await writeFile(ignorePath, `${GITIGNORE_LINE}\n`);
  } else if (!existing.split(/\r?\n/).some((line) => line.trim() === GITIGNORE_LINE)) {
    await writeFile(
      ignorePath,
      `${existing}${existing === "" || existing.endsWith("\n") ? "" : "\n"}${GITIGNORE_LINE}\n`,
    );
  }

  const target = join(dir, `index-${commit}.json`);
  const temp = join(dir, `.index-${commit}.json.${process.pid}.tmp`);
  await writeFile(temp, `${JSON.stringify(index, null, 2)}\n`);
  await rename(temp, target);
  return normalize(target);
}
