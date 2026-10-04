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

/** Tree-sitter extraction and heuristic resolution keep their internal language-pack seams. */
export class TreeSitterProvider implements IndexProvider {
  readonly id = "tree-sitter";
  readonly languages = FILE_LANGUAGES;
  readonly capabilities = { ...STRUCTURE_SUPPORT, ...HEURISTIC_SUPPORT };
  usedPacks: { pack: LanguagePack; language: FileLanguage }[] = [];
  resourceSites: ResourceSite[] = [];
  warnings: string[] = [];
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
    let refs = resolveHeuristic({ files: heuristicFiles, entries, lookup, repo });
    refs = refs.concat(inferPackRefs(heuristicFiles, entries, lookup, repo, refs));

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
