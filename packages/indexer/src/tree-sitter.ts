import { performance } from "node:perf_hooks";
import { hashText, splitLines } from "@xpl/core";
import type { FileLanguage, FilePath, IndexedFile, Reference } from "@xpl/core";
import pkg from "../package.json" with { type: "json" };
import { nodeSpan } from "./ast.js";
import { FileHasher } from "./hash.js";
import { packForFile } from "./languages/index.js";
import type { FileFacts, LanguagePack, RepoView } from "./languages/types.js";
import { ParserPool, parseFile, withParsedFile } from "./parse.js";
import { resolveHeuristic } from "./resolve/heuristic.js";
import type { ResolverFile } from "./resolve/heuristic.js";
import { SymbolLookup } from "./symbols.js";
import type { SymbolEntry } from "./symbols.js";
import { findSyntaxErrors, significantSyntaxErrors, syntaxErrorWarning } from "./syntax-errors.js";
import type { SyntaxErrorFile } from "./syntax-errors.js";
import { collectResourceSites, type ResourceSite } from "./resources.js";
import {
  extractionReports,
  HEURISTIC_SUPPORT,
  STRUCTURE_SUPPORT,
  type ExtractionOutcome,
} from "./analysis.js";
import { normalizeProvider, providerRange } from "./providers.js";
import type {
  IndexProvider,
  ProviderInput,
  ProviderSource,
  ProviderDeclaration,
  ProviderOutput,
} from "./providers.js";
import { FILE_LANGUAGES } from "./files.js";
import { SourceRepoView } from "./repo.js";
import type { ExtractionCache } from "./extraction-cache.js";
import type { TypeScriptResolutionExperiment } from "./resolve/typescript-experiment.js";

/** Tree-sitter extraction and heuristic resolution keep their internal language-pack seams. */
export class TreeSitterProvider implements IndexProvider {
  constructor(private readonly experiment?: TypeScriptResolutionExperiment) {}
  readonly id = "tree-sitter";
  readonly languages = FILE_LANGUAGES;
  readonly capabilities = { ...STRUCTURE_SUPPORT, ...HEURISTIC_SUPPORT };
  usedPacks: { pack: LanguagePack; language: FileLanguage }[] = [];
  resourceSites: ResourceSite[] = [];
  warnings: string[] = [];
  resolutionMs = 0;
  async analyze(input: ProviderInput): Promise<ProviderOutput> {
    const warnings: string[] = [];
    // 2. Read, hash, parse once, extract facts, free the tree.
    const files: IndexedFile[] = [];
    const declarations: ProviderDeclaration[] = [];
    const resolverFiles: ResolverFile[] = [];
    const usedPacks: { pack: LanguagePack; language: FileLanguage }[] = [];
    const usedPackKeys = new Set<string>();
    const syntaxErrors: SyntaxErrorFile[] = [];
    const resourceSites: ResourceSite[] = [];
    const extractionOutcomes = new Map<FilePath, ExtractionOutcome>();
    const identities = new Map<string, string>();
    const pool = new ParserPool();
    try {
      for (const discovered of input.sources) {
        const indexed = await indexFile(
          discovered,
          pool,
          declarations,
          resolverFiles,
          syntaxErrors,
          warnings,
          resourceSites,
          input.extractionCache,
          this.experiment ? (path, identity) => identities.set(path, identity) : undefined,
        );
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
    const output: ProviderOutput = {
      provider: "tree-sitter",
      version: pkg.dependencies["web-tree-sitter"],
      configuration: "builtin-packs",
      tool: `web-tree-sitter@${pkg.dependencies["web-tree-sitter"]}`,
      sourceHashes: Object.fromEntries(input.sources.map((s) => [s.path, hashText(s.text)])),
      declarations,
      relationships: [],
      analysis,
    };
    const { entries } = normalizeProvider(input, output);
    const lookup = new SymbolLookup(entries);
    const repo = new SourceRepoView(
      input.root,
      files.map((f) => f.path),
      (path) => input.sources.find((s) => s.path === path)?.text ?? input.readText(path),
    );
    const heuristicFiles = resolverFiles.filter((f) => f.pack.refs === "heuristic");
    const resolutionStarted = performance.now();
    const resolverInput = { files: heuristicFiles, entries, lookup, repo };
    let refs = this.experiment
      ? this.experiment.resolve(resolverInput, input.sources, identities)
      : resolveHeuristic(resolverInput);
    refs = refs.concat(inferPackRefs(heuristicFiles, entries, lookup, repo, refs));

    this.resolutionMs = performance.now() - resolutionStarted;
    this.usedPacks = usedPacks;
    this.resourceSites = resourceSites;
    this.warnings = warnings;
    output.relationships = refs.map((ref) => ({
      from: ref.from,
      to: ref.to,
      kind: ref.kind,
      file: ref.from.slice(0, ref.from.indexOf("#")),
      evidence: providerRange(
        ref.site,
        input.sources.find((s) => s.path === ref.from.slice(0, ref.from.indexOf("#")))!.text,
      ),
      resolution: ref.resolution,
    }));
    return output;
  }
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

/** Hash, parse and extract one captured source file. */
async function indexFile(
  discovered: ProviderSource,
  pool: ParserPool,
  declarations: ProviderDeclaration[],
  resolverFiles: ResolverFile[],
  syntaxErrors: SyntaxErrorFile[],
  warnings: string[],
  resourceSites: ResourceSite[],
  cache: ExtractionCache | undefined,
  onIdentity?: (path: string, identity: string) => void,
): Promise<{ file: IndexedFile; pack: LanguagePack | undefined; outcome: ExtractionOutcome }> {
  const text = discovered.text;
  const lines = splitLines(text);
  const hasher = new FileHasher(lines);
  const file: IndexedFile = {
    path: discovered.path,
    language: discovered.language,
    hash: hasher.hashFile(),
    lines: lines.length,
  };
  const pack = packForFile(discovered.path, discovered.language);
  if (!pack) return { file, pack, outcome: { status: "supported", limitations: [] } };
  const extract = () => extractFile(discovered, pool, pack);
  const extracted = cache
    ? await cache.extract(
        discovered,
        {
          provider: `tree-sitter:${pack.id}`,
          version: pkg.version,
          grammar: pack.grammarFor(discovered.language),
          configuration: JSON.stringify({ capabilities: pack.capabilities, refs: pack.refs }),
        },
        extract,
        (value) => value.outcome.status !== "failed",
        onIdentity ? (identity) => onIdentity(discovered.path, identity) : undefined,
      )
    : await extract();
  const { facts, outcome } = extracted;
  resourceSites.push(...extracted.resourceSites);
  if (extracted.syntaxErrors) syntaxErrors.push(extracted.syntaxErrors);
  warnings.push(...extracted.warnings);
  if (!facts) return { file, pack, outcome };
  facts.symbols.forEach((draft, i) =>
    declarations.push({
      identity: `${discovered.path}:${String(i).padStart(8, "0")}`,
      file: discovered.path,
      name: draft.path.split(".").at(-1)!,
      path: draft.path,
      kind: draft.kind,
      declaration: providerRange(draft.range, text),
      parentPath: draft.parentPath,
      anchorOnly: draft.anchorOnly,
    }),
  );
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

interface FileExtraction {
  facts?: FileFacts;
  outcome: ExtractionOutcome;
  resourceSites: ResourceSite[];
  syntaxErrors?: SyntaxErrorFile;
  warnings: string[];
}

/** All output is file-local and JSON data; the tree is deleted before the cache sees it. */
async function extractFile(
  source: ProviderSource,
  pool: ParserPool,
  pack: LanguagePack,
): Promise<FileExtraction> {
  const result: FileExtraction = {
    outcome: { status: "supported", limitations: [] },
    resourceSites: [],
    warnings: [],
  };
  try {
    const parsed = await parseFile(pool, source.path, source.language, source.text);
    if (parsed) {
      try {
        result.facts = pack.extract(parsed.ctx);
        result.resourceSites = collectResourceSites(parsed.ctx);
        const errors = significantSyntaxErrors(
          source.path,
          findSyntaxErrors(parsed.ctx.tree.rootNode, pack),
        );
        if (errors) {
          result.outcome.status = "partial";
          result.outcome.limitations.push(
            "Syntax errors may leave symbols and relationships incomplete.",
          );
        }
        if (errors && !isTestData(source.path)) result.syntaxErrors = errors;
      } finally {
        parsed.dispose();
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.facts = undefined;
    result.outcome.diagnostics = [`${source.path}: ${message}`];
    result.warnings.push(`${source.path}: ${source.language} extraction failed: ${message}`);
  }
  if (!result.facts) {
    result.outcome.status = "failed";
    result.outcome.limitations = ["Source analysis failed; only file anchors are available."];
  } else if (result.facts.warnings?.length) {
    result.outcome.status = "partial";
    result.outcome.limitations.push(...result.facts.warnings);
    result.outcome.diagnostics = result.facts.warnings.map((w) => `${source.path}: ${w}`);
    result.warnings.push(...result.outcome.diagnostics);
  }
  return result;
}

function isTestData(path: string): boolean {
  return /(?:^|\/)(?:testdata|fixtures|__fixtures__)\//.test(path);
}

/** Parsing stays behind the syntax adapter; consumers receive plain classification facts only. */
export function syntaxClassifier(
  pool: ParserPool,
  input: ProviderInput,
): NonNullable<ProviderInput["classify"]> {
  const repo = new SourceRepoView(
    input.root,
    input.sources.map((s) => s.path),
    (path) => input.sources.find((s) => s.path === path)?.text ?? input.readText(path),
  );
  return async (file, candidates) => {
    const source = input.sources.find((s) => s.path === file);
    if (!source) return undefined;
    return withParsedFile(pool, file, source.language, source.text, (ctx, pack) =>
      candidates.map((c) => {
        let site;
        let failed = false;
        try {
          site = pack.classifySite(ctx, c.span.startLine, c.span.startCol);
        } catch {
          failed = true;
        }
        const line = ctx.lines[c.span.startLine - 1]!;
        const token =
          c.span.startLine === c.span.endLine ? line.slice(c.span.startCol - 1, c.span.endCol) : "";
        const quotes = new Set(['"', "'", "`"]);
        const before = line[c.span.startCol - 2];
        const specifier =
          quotes.has(token[0]!) && token.at(-1) === token[0]
            ? token.slice(1, -1)
            : before && quotes.has(before) && line[c.span.endCol] === before
              ? token
              : undefined;
        const moduleFile =
          specifier === undefined
            ? undefined
            : pack.resolveModule(specifier, file, repo).find((f) => c.moduleFiles.includes(f));
        let node = ctx.tree.rootNode.descendantForPosition(
          { row: c.span.startLine - 1, column: c.span.startCol - 1 },
          { row: c.span.startLine - 1, column: c.span.startCol },
        );
        while (node?.parent?.parent) node = node.parent;
        return {
          site,
          failed,
          specifier,
          moduleFile,
          statement: node ? nodeSpan(node, ctx.lines) : undefined,
        };
      }),
    );
  };
}
