/** Source-backed provider facts. No parser or language pack is part of this interface. */
import { hashText, splitLines, RELATIONSHIP_CAPABILITIES } from "@xpl/core";
import type {
  AnalysisCapabilities,
  AnalysisCapability,
  AnalysisReport,
  AnalysisResult,
  AnalysisProvenance,
  FileLanguage,
  IndexedFile,
  IndexedSymbol,
  Range,
  Reference,
} from "@xpl/core";
import { pointsToSpan, spanContains } from "./ast.js";
import { FileHasher } from "./hash.js";
import { assembleSymbols, SymbolLookup } from "./symbols.js";
import type { SymbolEntry } from "./symbols.js";
import type { Span, SymbolDraft } from "./languages/types.js";

export type ColumnEncoding = "utf8" | "utf16" | "utf32";
/** Zero-based lines and columns, end exclusive, measured against the supplied source snapshot. */
export interface ProviderRange {
  start: readonly [line: number, column: number];
  end: readonly [line: number, column: number];
  encoding: ColumnEncoding;
}
export interface ProviderSource {
  path: string;
  language: FileLanguage;
  text: string;
}
export interface ProviderInput {
  root: string;
  languages: readonly FileLanguage[];
  files: readonly IndexedFile[];
  lookup: SymbolLookup;
  warn(message: string): void;
  /** Optional syntax evidence; absent classifiers never establish invocation. */
  classify?(
    file: string,
    candidates: readonly ClassificationRequest[],
  ): Promise<readonly ProviderClassification[] | undefined>;
  sources: readonly ProviderSource[];
  /** Existing canonical symbols, with full declaration columns when known. */
  symbols: readonly IndexedSymbol[];
  /** Snapshot of auxiliary configuration/import-resolution files, cached by the caller. */
  readText(path: string): string | undefined;
}
export interface ClassificationRequest {
  span: Span;
  moduleFiles: readonly string[];
}
export interface ProviderClassification {
  site?: { kind: Reference["kind"]; site: Span; bare?: boolean };
  specifier?: string;
  moduleFile?: string;
  statement?: Span;
  failed?: boolean;
}
export interface ProviderDeclaration {
  identity: string;
  file: string;
  name: string;
  /** Pre-dedup dotted path. Omitted: name. Canonical suffixes are assigned by xpl. */
  path?: string;
  kind: IndexedSymbol["kind"];
  parent?: string;
  /** Syntax adapters may name a same-file logical parent before duplicate paths are numbered. */
  parentPath?: string;
  identifier?: ProviderRange;
  declaration?: ProviderRange;
  /** Syntax-only outline entries (e.g. named test blocks), never resolved as targets. */
  anchorOnly?: boolean;
}
export interface ProviderRelationship {
  /** Provider-local declaration identities or existing canonical IDs (including module scopes). */
  from: string;
  to: string;
  /** Unrecognized kinds are diagnosed and dropped, never interpreted as calls. */
  kind: string;
  file: string;
  evidence: ProviderRange;
  resolution: Reference["resolution"];
}
export interface ProviderOutput {
  provider: string;
  version: string;
  configuration: string;
  tool: string;
  /** Hash of each source snapshot actually consumed. Missing or stale hashes cannot replace facts. */
  sourceHashes: Readonly<Record<string, string>>;
  declarations: readonly ProviderDeclaration[];
  relationships: readonly ProviderRelationship[];
  analysis: AnalysisReport[];
  /** Occurrences that were observed but unresolved; the smallest enclosing heuristic hint survives. */
  blind?: readonly { file: string; line: number; col: number }[];
}
export interface IndexProvider {
  /** Syntax providers always run; semantic providers (the default) honor precise mode. */
  readonly mode?: "syntax" | "semantic";
  readonly id: string;
  readonly languages: readonly FileLanguage[];
  readonly capabilities: AnalysisCapabilities;
  analyze(input: ProviderInput): Promise<ProviderOutput>;
}

export function normalizeColumn(
  lines: readonly string[],
  row: number,
  offset: number,
  encoding: ColumnEncoding,
): number | undefined {
  if (!Number.isInteger(row) || !Number.isInteger(offset) || row < 0 || offset < 0)
    return undefined;
  const line = lines[row];
  if (line === undefined) return undefined;
  let units = 0;
  let utf16 = 0;
  for (const character of line) {
    if (units === offset) return utf16;
    units +=
      encoding === "utf8"
        ? Buffer.byteLength(character, "utf8")
        : encoding === "utf32"
          ? 1
          : character.length;
    utf16 += character.length;
  }
  return units === offset ? utf16 : undefined;
}

/** Strict conversion: invalid columns, split Unicode characters and empty ranges are not evidence. */
export function normalizeProviderRange(
  lines: readonly string[],
  range: ProviderRange,
): Span | undefined {
  const [sr, sc] = range.start;
  const [er, ec] = range.end;
  const start = normalizeColumn(lines, sr, sc, range.encoding);
  const end = normalizeColumn(lines, er, ec, range.encoding);
  if (start === undefined || end === undefined || er < sr || (er === sr && end <= start))
    return undefined;
  return pointsToSpan(sr, start, er, end, lines);
}

export function providerRange(range: Range, text: string): ProviderRange {
  const endLine = range.endLine - 1;
  const lines = range.endCol === undefined || range.endCol === 1 ? splitLines(text) : undefined;
  // pointsToSpan widens an empty terminal line to column 1 after consuming its newline.
  const blankTerminalLine =
    range.endLine > range.startLine && range.endCol === 1 && lines?.[endLine] === "";
  return {
    start: [range.startLine - 1, (range.startCol ?? 1) - 1],
    end: blankTerminalLine ? [endLine + 1, 0] : [endLine, range.endCol ?? lines![endLine]!.length],
    encoding: "utf16",
  };
}

export interface NormalizedProvider {
  providers: AnalysisProvenance[];
  entries: SymbolEntry[];
  refs: Reference[];
  identities: Map<string, string>;
  identifiers: Map<string, Span>;
  analysis: AnalysisReport[];
}

/** xpl owns source checks, IDs, hashes and positions, irrespective of the provider's format. */
export function normalizeProvider(
  input: ProviderInput,
  output: ProviderOutput,
): NormalizedProvider {
  const sources = new Map(input.sources.map((s) => [s.path, s.text]));
  const sourceLines = new Map(input.sources.map((s) => [s.path, splitLines(s.text)]));
  const scoped = new Set(
    input.sources.filter((s) => input.languages.includes(s.language)).map((s) => s.path),
  );
  const rejected = new Map<string, string[]>();
  const reject = (file: string, message: string) => {
    const list = rejected.get(file) ?? [];
    list.push(message);
    rejected.set(file, list);
  };
  const checked = new Map<string, string | undefined>();
  const fresh = (file: string): string | undefined => {
    if (checked.has(file)) return checked.get(file);
    const text = sources.get(file);
    if (
      text === undefined ||
      !scoped.has(file) ||
      output.sourceHashes[file] !== new FileHasher(sourceLines.get(file)!).hashFile()
    ) {
      reject(file, `${file}: provider source snapshot is missing or stale`);
      checked.set(file, undefined);
      return undefined;
    }
    checked.set(file, text);
    return text;
  };
  // Empty results must pass the same freshness gate as emitted facts before they can erase old facts.
  for (const report of output.analysis) for (const file of report.files) fresh(file);
  const identities = new Map<string, string>();
  const identifiers = new Map<string, Span>();
  const entries: SymbolEntry[] = [];
  const grouped = new Map<string, { fact: ProviderDeclaration; draft: SymbolDraft }[]>();
  const declarations = new Map(output.declarations.map((d) => [d.identity, d]));
  if (declarations.size !== output.declarations.length)
    throw new Error("duplicate provider declaration identity");
  for (const fact of output.declarations) {
    const text = fresh(fact.file);
    if (text === undefined) continue;
    const identifier =
      fact.identifier && normalizeProviderRange(sourceLines.get(fact.file)!, fact.identifier);
    if (fact.identifier && !identifier) {
      reject(fact.file, `${fact.identity}: invalid identifier range`);
      continue;
    }
    if (identifier) {
      const spelling =
        identifier.startLine === identifier.endLine
          ? sourceLines
              .get(fact.file)!
              [identifier.startLine - 1]!.slice(identifier.startCol - 1, identifier.endCol)
          : undefined;
      if (spelling !== fact.name) {
        reject(fact.file, `${fact.identity}: identifier does not name the declaration`);
        continue;
      }
      identifiers.set(fact.identity, identifier);
    }
    // Identifier ranges never stand in for checked full declarations.
    if (!fact.declaration) {
      reject(fact.file, `${fact.identity}: full declaration range unavailable`);
      continue;
    }
    const span = normalizeProviderRange(sourceLines.get(fact.file)!, fact.declaration);
    if (
      !span ||
      (identifier &&
        (!spanContains(span, identifier.startLine, identifier.startCol) ||
          !spanContains(span, identifier.endLine, identifier.endCol)))
    ) {
      reject(fact.file, `${fact.identity}: invalid full declaration range`);
      continue;
    }
    const path = fact.path ?? fact.name;
    if (!path) {
      reject(fact.file, `${fact.identity}: empty declaration path`);
      continue;
    }
    const parent = fact.parent === undefined ? undefined : declarations.get(fact.parent);
    const draft: SymbolDraft = {
      path,
      kind: fact.kind,
      range: span,
      ...(parent?.file === fact.file
        ? { parentPath: parent.path ?? parent.name }
        : fact.parentPath
          ? { parentPath: fact.parentPath }
          : {}),
      ...(fact.anchorOnly ? { anchorOnly: true } : {}),
    };
    const list = grouped.get(fact.file) ?? [];
    list.push({ fact, draft });
    grouped.set(fact.file, list);
  }
  const factsById = new Map<string, ProviderDeclaration>();
  for (const [file, list] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
    list.sort(
      (a, b) =>
        a.draft.range.startLine - b.draft.range.startLine ||
        a.draft.range.startCol - b.draft.range.startCol ||
        b.draft.range.endLine - a.draft.range.endLine ||
        b.draft.range.endCol - a.draft.range.endCol ||
        a.fact.identity.localeCompare(b.fact.identity),
    );
    const built = assembleSymbols(
      file,
      sourceLines.get(file)!,
      list.map((x) => x.draft),
    ).entries;
    built.forEach((entry, i) => identities.set(list[i]!.fact.identity, entry.symbol.id));
    built.forEach((entry, i) => factsById.set(entry.symbol.id, list[i]!.fact));
    for (const entry of built) entry.symbol.provider = 0;
    entries.push(...built);
  }
  for (const entry of entries) {
    const parent = factsById.get(entry.symbol.id)!.parent;
    if (parent !== undefined) {
      const id = identities.get(parent);
      if (id && id !== entry.symbol.id) entry.symbol.parent = id;
      else {
        delete entry.symbol.parent;
        reject(entry.symbol.file, `${parent}: missing or self parent identity`);
      }
    }
  }
  const known = new Set([
    ...input.symbols.map((s) => s.id),
    ...entries.map((e) => e.symbol.id),
    ...input.sources.map((s) => `${s.path}#`),
  ]);
  const refs: Reference[] = [];
  for (const fact of output.relationships) {
    const text = fresh(fact.file);
    if (text === undefined) continue;
    const from = identities.get(fact.from) ?? fact.from;
    const to = identities.get(fact.to) ?? fact.to;
    const site = normalizeProviderRange(sourceLines.get(fact.file)!, fact.evidence);
    if (
      !(RELATIONSHIP_CAPABILITIES as readonly string[]).includes(fact.kind) ||
      !site ||
      !known.has(from) ||
      !known.has(to) ||
      !from.startsWith(`${fact.file}#`)
    ) {
      reject(
        fact.file,
        `${fact.from}: unknown relationship kind, endpoint or invalid source evidence`,
      );
      continue;
    }
    refs.push({
      provider: 0,
      from,
      to,
      kind: fact.kind as Reference["kind"],
      site,
      resolution: fact.resolution,
    });
  }
  const snapshot = hashText(
    Object.entries(output.sourceHashes)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([file, hash]) => `${file}\0${hash}`)
      .join("\n"),
  );
  const analysis = output.analysis.map((report) => ({
    ...report,
    version: output.version,
    configuration: output.configuration,
    snapshot,
    results: report.results.map((result) => ({
      ...result,
      status:
        result.analyzedFiles.some((f) => rejected.has(f)) && result.status === "supported"
          ? ("partial" as const)
          : result.status,
      analyzedFiles: result.analyzedFiles.filter((f) => !rejected.has(f)),
      limitations: result.analyzedFiles.some((f) => rejected.has(f))
        ? [...result.limitations, "Some facts lacked valid source evidence; previous hints remain."]
        : result.limitations,
    })),
    diagnostics: [
      ...(report.diagnostics ?? []),
      ...report.files.flatMap((f) => rejected.get(f) ?? []),
    ],
  }));
  return {
    providers: [{ id: output.provider, version: output.version }],
    entries,
    refs,
    identities,
    identifiers,
    analysis,
  };
}

/** Only explicitly analyzed capabilities/files replace prior facts; failed/unsupported scopes survive. */
export function mergeProvider(
  previous: {
    entries: readonly SymbolEntry[];
    refs: readonly Reference[];
    providers?: readonly AnalysisProvenance[];
  },
  next: NormalizedProvider,
  keep: ReadonlySet<Reference> = new Set(),
): { entries: SymbolEntry[]; refs: Reference[]; providers: AnalysisProvenance[] } {
  const providers = [...(previous.providers ?? [])];
  const remap = next.providers.map((provider) => {
    let id = providers.findIndex((p) => p.id === provider.id && p.version === provider.version);
    if (id < 0) {
      id = providers.length;
      providers.push(provider);
    }
    return id;
  });
  const nextEntries = next.entries.map((entry) => ({
    ...entry,
    symbol: { ...entry.symbol, provider: remap[entry.symbol.provider!]! },
  }));
  const covers = (capability: AnalysisCapability, file: string) =>
    next.analysis.some(
      (report) =>
        report.capabilities[capability] &&
        report.files.includes(file) &&
        report.results.some(
          (r) =>
            r.capabilities.includes(capability) &&
            (r.status === "supported" || r.status === "partial") &&
            r.analyzedFiles.includes(file),
        ),
    );
  const structure = (file: string) => covers("symbols", file) && covers("declarationRanges", file);
  const entries = [
    ...previous.entries.filter((e) => !structure(e.symbol.file)),
    ...nextEntries.filter((e) => structure(e.symbol.file)),
  ];
  const previousById = new Map(previous.entries.map((e) => [e.symbol.id, e]));
  const nextById = new Map(nextEntries.map((e) => [e.symbol.id, e]));
  const ids = new Set(entries.map((e) => e.symbol.id));
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const replacement = nextById.get(entry.symbol.id);
    const old = previousById.get(entry.symbol.id);
    let updated = { ...entry, symbol: { ...entry.symbol } };
    if (
      !structure(entry.symbol.file) &&
      covers("declarationRanges", entry.symbol.file) &&
      replacement
    ) {
      updated = {
        ...updated,
        span: replacement.span,
        symbol: {
          ...updated.symbol,
          range: replacement.symbol.range,
          hash: replacement.symbol.hash,
          provider: replacement.symbol.provider,
        },
      };
    }
    const parent = covers("nesting", entry.symbol.file)
      ? replacement?.symbol.parent
      : old?.symbol.parent;
    if (parent && ids.has(parent)) updated.symbol.parent = parent;
    else delete updated.symbol.parent;
    entries[i] = updated;
  }
  entries.sort(
    (a, b) =>
      (a.symbol.file < b.symbol.file ? -1 : a.symbol.file > b.symbol.file ? 1 : 0) ||
      a.span.startLine - b.span.startLine ||
      a.span.startCol - b.span.startCol ||
      b.span.endLine - a.span.endLine ||
      b.span.endCol - a.span.endCol,
  );
  const validId = (id: string) => id.endsWith("#") || ids.has(id);
  const refs = [
    ...previous.refs.filter(
      (r) => keep.has(r) || !covers(r.kind, r.from.slice(0, r.from.indexOf("#"))),
    ),
    ...next.refs
      .filter((r) => covers(r.kind, r.from.slice(0, r.from.indexOf("#"))))
      .map((r) => ({ ...r, provider: remap[r.provider!]! })),
  ].filter((r) => validId(r.from) && validId(r.to));
  const unique = new Map(
    refs.map((r) => [
      `${r.from}\0${r.to}\0${r.kind}\0${r.site.startLine}:${r.site.startCol}-${r.site.endLine}:${r.site.endCol}`,
      r,
    ]),
  );
  return { entries, refs: [...unique.values()], providers };
}

/** Plain relationship result shared by the SCIP tool adapters before conversion to provider facts. */
export interface RelationshipResult {
  resolution: Reference["resolution"];
  refs: Reference[];
  coverage?: Partial<Record<Reference["kind"], Omit<AnalysisResult, "capabilities">>>;
  tool: string;
  blind?: ProviderOutput["blind"];
  describedFiles?: Iterable<string>;
}
const registry: IndexProvider[] = [];
export function registerProvider(provider: IndexProvider): void {
  const index = registry.findIndex((p) => p.id === provider.id);
  if (index < 0) registry.push(provider);
  else registry[index] = provider;
}
export function unregisterProvider(id: string): boolean {
  const index = registry.findIndex((p) => p.id === id);
  if (index < 0) return false;
  registry.splice(index, 1);
  return true;
}
export function indexProviders(): readonly IndexProvider[] {
  return registry;
}
