/** SCIP declarations from an artifact bound to the source snapshot consumed by its producer. */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashText, splitLines, RELATIONSHIP_CAPABILITIES } from "@xpl/core";
import type {
  AnalysisCapabilities,
  AnalysisCapability,
  AnalysisResult,
  FileLanguage,
  IndexedSymbol,
  Reference,
} from "@xpl/core";
import { SpanIndex, spanContains } from "../ast.js";
import type { Span } from "../ast.js";
import { FILE_LANGUAGES } from "../files.js";
import { normalizeProviderRange, providerRange } from "../providers.js";
import type {
  ColumnEncoding,
  IndexProvider,
  ProviderDeclaration,
  ProviderInput,
  ProviderOutput,
  ProviderRange,
  ProviderRelationship,
} from "../providers.js";
import { decodeIndex, parseScipRange, PositionEncoding, SymbolRole } from "./proto.js";
import type { ScipSymbolInformation } from "./proto.js";
import { isLocalSymbol, parseScipSymbol, symbolPath } from "./symbol.js";

export interface ScipArtifactManifest {
  /** SHA-256 of the exact protobuf bytes, recorded after a successful producer run. */
  artifactSha256: string;
  /** xpl hashes captured before generation, checked again after generation. Never stamp old artifacts. */
  sourceHashes: Readonly<Record<string, string>>;
  /** Required when the producer omits position_encoding. Not the metadata's text encoding. */
  defaultEncoding?: ColumnEncoding;
}
export interface ScipArtifactOptions {
  artifact: Uint8Array;
  /** JSON from disk is validated before any facts are imported. */
  manifest?: unknown;
  /** Closed xpl language values; an unknown source extension is text. */
  languages?: readonly FileLanguage[];
}

const CAPABILITIES: AnalysisCapabilities = {
  symbols: "partial",
  declarationRanges: "partial",
  nesting: "partial",
  "type-ref": "partial",
  read: "partial",
  write: "partial",
  import: "partial",
};
const KINDS: Readonly<Record<number, IndexedSymbol["kind"]>> = {
  7: "class",
  49: "class",
  11: "enum",
  21: "interface",
  42: "interface",
  53: "interface",
  54: "type",
  55: "type",
  59: "type",
  17: "function",
  9: "method",
  26: "method",
  66: "method",
  67: "method",
  68: "method",
  69: "method",
  70: "method",
  71: "method",
  80: "method",
  8: "variable",
  12: "variable",
  15: "variable",
  37: "variable",
  41: "variable",
  61: "variable",
  79: "variable",
  82: "variable",
};
const TYPE_KINDS = new Set<IndexedSymbol["kind"]>(["class", "interface", "enum", "type"]);
const LIMITS = [
  "Only definitions with producer-supplied full ranges become checked symbols; synthetic and identifier-only definitions are omitted.",
  "Declaration ranges may omit leading documentation. Unspecified symbol kinds remain other.",
  "Overloads use source-ordered suffixes; reordering declarations can change their IDs.",
];
function manifestOf(value: unknown, bytes: Uint8Array): ScipArtifactManifest {
  if (
    !value ||
    typeof value !== "object" ||
    !("artifactSha256" in value) ||
    !("sourceHashes" in value)
  )
    throw new Error("SCIP manifest requires artifactSha256 and pre-generation sourceHashes");
  const { artifactSha256, sourceHashes } = value;
  if (artifactSha256 !== createHash("sha256").update(bytes).digest("hex"))
    throw new Error("SCIP artifact digest does not match its manifest; regenerate both together");
  if (
    !sourceHashes ||
    typeof sourceHashes !== "object" ||
    Array.isArray(sourceHashes) ||
    Object.values(sourceHashes).some(
      (h) => typeof h !== "string" || !/^sha256-v2:[a-f0-9]{12}$/.test(h),
    )
  )
    throw new Error("SCIP manifest sourceHashes must contain xpl source hashes");
  const defaultEncoding = "defaultEncoding" in value ? value.defaultEncoding : undefined;
  if (
    defaultEncoding !== undefined &&
    defaultEncoding !== "utf8" &&
    defaultEncoding !== "utf16" &&
    defaultEncoding !== "utf32"
  )
    throw new Error("SCIP manifest defaultEncoding must be utf8, utf16 or utf32");
  return {
    artifactSha256,
    sourceHashes: sourceHashes as Record<string, string>,
    ...(defaultEncoding ? { defaultEncoding } : {}),
  };
}
function rangeOf(raw: readonly number[], encoding: ColumnEncoding): ProviderRange | undefined {
  const r = parseScipRange(raw);
  return r && { start: [r.startLine, r.startChar], end: [r.endLine, r.endChar], encoding };
}
function contains(a: Span, b: Span): boolean {
  return spanContains(a, b.startLine, b.startCol) && spanContains(a, b.endLine, b.endCol);
}
function descriptorKey(raw: string, parent = false): string | undefined {
  const parsed = parseScipSymbol(raw);
  if (!parsed) return undefined;
  return JSON.stringify([
    parsed.scheme,
    parsed.manager,
    parsed.packageName,
    parsed.version,
    parent ? parsed.descriptors.slice(0, -1) : parsed.descriptors,
  ]);
}
function validPath(path: string): boolean {
  return (
    !!path &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    !/^[A-Za-z]:/.test(path) &&
    path.split("/").every((p) => !!p && p !== "." && p !== "..")
  );
}
interface Definition {
  fact: ProviderDeclaration;
  span: Span;
  info?: ScipSymbolInformation;
  raw: string;
}

/** Independent provider. Existing SCIP tool adapters still upgrade syntax-extracted references. */
export function scipArtifactProvider(options: ScipArtifactOptions): IndexProvider {
  // Copy bytes and manifest: a caller cannot change the attested pair after constructing the provider.
  const bytes = options.artifact.slice();
  const manifest =
    options.manifest === undefined
      ? undefined
      : manifestOf(structuredClone(options.manifest), bytes);
  const index = decodeIndex(bytes);
  return {
    id: "scip-artifact",
    languages: options.languages ?? FILE_LANGUAGES,
    capabilities: CAPABILITIES,
    async analyze(input: ProviderInput): Promise<ProviderOutput> {
      if (index.metadata.projectRoot) {
        if (!index.metadata.projectRoot.startsWith("file:"))
          throw new Error("SCIP project_root must be a file URI");
        if (resolve(fileURLToPath(index.metadata.projectRoot)) !== resolve(input.root))
          throw new Error(
            "SCIP project_root differs from the indexed root; regenerate at this root",
          );
      }
      if (index.metadata.textDocumentEncoding === 2)
        throw new Error("SCIP UTF-16 source files are unsupported; xpl reads UTF-8 source");
      const sources = new Map(
        input.sources
          .filter((s) => input.languages.includes(s.language))
          .map((s) => [s.path, s.text]),
      );
      const diagnostics: string[] = [];
      const definitions = new Map<string, Definition>();
      const existingTargets = new Map<string, IndexedSymbol>();
      const syntaxFiles = new Set(input.symbols.map((s) => s.file));
      const identifierKey = (file: string, span: Span) =>
        `${file}\0${span.startLine}:${span.startCol}-${span.endLine}:${span.endCol}`;
      const existingByIdentifier = new Map<string, IndexedSymbol | undefined>();
      for (const symbol of input.symbols) {
        const entry = input.lookup.entry(symbol.id);
        if (!entry?.identifier || entry.anchorOnly) continue;
        const key = identifierKey(symbol.file, entry.identifier);
        existingByIdentifier.set(key, existingByIdentifier.has(key) ? undefined : symbol);
      }
      const joinedIdentities = new Map<string, string>();
      const ambiguous = new Set<string>();
      const sourceHashes: Record<string, string> = {};
      const documents = new Map<
        string,
        {
          doc: (typeof index.documents)[number];
          text: string;
          lines: string[];
          encoding: ColumnEncoding;
        }
      >();
      const identity = (file: string, symbol: string) =>
        isLocalSymbol(symbol) ? `${file}\0${symbol}` : symbol;
      for (const doc of index.documents) {
        const file = doc.relativePath;
        const text = sources.get(file);
        if (!validPath(file) || text === undefined) {
          diagnostics.push(
            `${file}: document is outside discovered source files; generated/external paths are not imported`,
          );
          continue;
        }
        const sourceHash =
          doc.text !== undefined ? hashText(doc.text) : manifest?.sourceHashes[file];
        if (sourceHash !== hashText(text)) {
          diagnostics.push(
            `${file}: source snapshot missing or stale; regenerate artifact and manifest together`,
          );
          continue;
        }
        if (documents.has(file)) throw new Error(`${file}: duplicate SCIP document`);
        const encoding =
          doc.positionEncoding === PositionEncoding.Utf8
            ? "utf8"
            : doc.positionEncoding === PositionEncoding.Utf16
              ? "utf16"
              : doc.positionEncoding === PositionEncoding.Utf32
                ? "utf32"
                : doc.positionEncoding === 0
                  ? manifest?.defaultEncoding
                  : undefined;
        if (!encoding) {
          diagnostics.push(
            `${file}: position encoding unknown; set manifest.defaultEncoding only after verifying the producer`,
          );
          continue;
        }
        const lines = splitLines(text);
        sourceHashes[file] = sourceHash;
        documents.set(file, { doc, text, lines, encoding });
        const infos = new Map(doc.symbols.map((info) => [info.symbol, info]));
        for (const occ of doc.occurrences) {
          if (!(occ.symbolRoles & SymbolRole.Definition) || !occ.symbol) continue;
          const info = infos.get(occ.symbol);
          const parsed = parseScipSymbol(occ.symbol);
          const path = parsed ? symbolPath(parsed) : undefined;
          const identifier = rangeOf(occ.range, encoding);
          const declaration = rangeOf(occ.enclosingRange, encoding);
          const idSpan = identifier && normalizeProviderRange(lines, identifier);
          const span = declaration && normalizeProviderRange(lines, declaration);
          const key = identity(file, occ.symbol);
          if (definitions.has(key) || existingTargets.has(key)) ambiguous.add(key);
          // Match the actual identifier, never another same-name identifier inside the declaration.
          if (syntaxFiles.has(file)) {
            if (!path || !KINDS[info?.kind ?? 0]) {
              diagnostics.push(
                `${file}: ${occ.symbol}: unsupported descriptor or kind; syntax update omitted`,
              );
              continue;
            }
            const name =
              idSpan && idSpan.startLine === idSpan.endLine
                ? lines[idSpan.startLine - 1]!.slice(idSpan.startCol - 1, idSpan.endCol)
                : undefined;
            const existing = idSpan && existingByIdentifier.get(identifierKey(file, idSpan));
            if (!existing || name !== (info?.displayName || parsed?.descriptors.at(-1)?.name)) {
              diagnostics.push(
                `${file}: ${occ.symbol}: no unique checked identifier match; syntax update omitted`,
              );
              continue;
            }
            const other = joinedIdentities.get(existing.id);
            if (other && other !== key) {
              ambiguous.add(other);
              ambiguous.add(key);
            }
            joinedIdentities.set(existing.id, key);
            existingTargets.set(key, existing);
          }
          if (!idSpan || idSpan.startLine !== idSpan.endLine || !span || !contains(span, idSpan)) {
            diagnostics.push(
              `${file}: ${occ.symbol}: full declaration/identifier range missing or invalid; definition omitted`,
            );
            continue;
          }
          const name = lines[idSpan.startLine - 1]!.slice(idSpan.startCol - 1, idSpan.endCol);
          const expected = info?.displayName || parsed?.descriptors.at(-1)?.name;
          if (
            (!isLocalSymbol(occ.symbol) && !path) ||
            !name ||
            (expected && name !== expected && info?.kind !== 9)
          ) {
            diagnostics.push(
              `${file}: ${occ.symbol}: unsupported descriptor or identifier spelling; definition omitted`,
            );
            continue;
          }
          const declarationPath = path ?? name;
          if (/[#~]/.test(declarationPath)) {
            diagnostics.push(
              `${file}: ${occ.symbol}: descriptor collides with canonical ID punctuation; definition omitted`,
            );
            continue;
          }
          definitions.set(key, {
            raw: occ.symbol,
            info,
            span,
            fact: {
              identity: key,
              file,
              name,
              path: existingTargets.get(key)?.path ?? declarationPath,
              kind: KINDS[info?.kind ?? 0] ?? "other",
              identifier,
              declaration,
            },
          });
          if (!KINDS[info?.kind ?? 0])
            diagnostics.push(`${file}: ${occ.symbol}: kind ${info?.kind ?? 0} mapped to other`);
        }
      }
      for (const key of ambiguous) {
        diagnostics.push(`${key}: multiple definitions for one identity; all omitted`);
        definitions.delete(key);
        existingTargets.delete(key);
      }
      const placedFiles = new Set([...definitions.values()].map((d) => d.fact.file));
      const nestingFiles = new Set([...placedFiles].filter((f) => !syntaxFiles.has(f)));
      const checkedParents = new Set<string>();
      const byDescriptor = new Map(
        [...definitions.values()]
          .filter((d) => !isLocalSymbol(d.raw))
          .map((d) => [descriptorKey(d.raw), d]),
      );
      for (const [key, definition] of definitions) {
        const { fact, info } = definition;
        let parent: Definition | undefined;
        if (info?.enclosingSymbol)
          parent = definitions.get(identity(fact.file, info.enclosingSymbol));
        else {
          const parsed = parseScipSymbol(definition.raw);
          const descriptors = parsed?.descriptors;
          if (descriptors && descriptors.length > 1 && descriptors.at(-2)?.suffix !== "namespace") {
            // Match the entire descriptor prefix, including overload tags; dotted paths lose those tags.
            parent = byDescriptor.get(descriptorKey(definition.raw, true));
            if (!parent) {
              nestingFiles.delete(fact.file);
              diagnostics.push(
                `${fact.file}: ${definition.raw}: descriptor parent unavailable; parent omitted`,
              );
            }
          }
        }
        if (
          parent &&
          parent.fact.identity !== key &&
          parent.fact.file === fact.file &&
          contains(parent.span, definition.span) &&
          JSON.stringify(parent.span) !== JSON.stringify(definition.span)
        ) {
          fact.parent = parent.fact.identity;
          checkedParents.add(fact.file);
        } else if (parent || info?.enclosingSymbol) {
          nestingFiles.delete(fact.file);
          diagnostics.push(
            `${fact.file}: ${definition.raw}: enclosing symbol missing or not containing declaration; parent omitted`,
          );
        } else if (isLocalSymbol(definition.raw)) {
          nestingFiles.delete(fact.file);
          diagnostics.push(
            `${fact.file}: ${definition.raw}: local enclosing symbol missing; parent omitted`,
          );
        }
      }
      for (const file of checkedParents) if (!syntaxFiles.has(file)) nestingFiles.add(file);
      const localPath = (d: Definition): string => {
        if (!isLocalSymbol(d.raw) || !d.fact.parent) return d.fact.path!;
        return `${localPath(definitions.get(d.fact.parent)!)}.${d.fact.name}`;
      };
      for (const d of definitions.values()) d.fact.path = localPath(d);
      const relationships: ProviderRelationship[] = [];
      const blind: NonNullable<ProviderOutput["blind"]>[number][] = [];
      const covered = new Map<AnalysisCapability, Set<string>>();
      for (const [file, { doc, text, lines, encoding }] of documents) {
        const fileDefs = [...definitions.values()].filter((d) => d.fact.file === file);
        const lookup = new SpanIndex(fileDefs.map((d) => ({ span: d.span, value: d })));
        for (const occ of doc.occurrences) {
          if (!occ.symbol || occ.symbolRoles & SymbolRole.Definition) continue;
          const range = rangeOf(occ.range, encoding);
          const site = range && normalizeProviderRange(lines, range);
          if (!site) {
            diagnostics.push(
              `${file}: ${occ.symbol}: invalid occurrence range; occurrence omitted`,
            );
            continue;
          }
          const key = identity(file, occ.symbol);
          const definition = definitions.get(key);
          const existing = existingTargets.get(key);
          const target = existing
            ? { identity: existing.id, kind: existing.kind }
            : definition && !syntaxFiles.has(definition.fact.file)
              ? definition.fact
              : undefined;
          const kinds: Reference["kind"][] = [];
          if (occ.symbolRoles & SymbolRole.Import) kinds.push("import");
          else {
            if (occ.symbolRoles & SymbolRole.ReadAccess) kinds.push("read");
            if (occ.symbolRoles & SymbolRole.WriteAccess) kinds.push("write");
            if (!kinds.length && target && TYPE_KINDS.has(target.kind)) kinds.push("type-ref");
          }
          if (!target || !kinds.length) {
            blind.push({ file, line: site.startLine, col: site.startCol });
            diagnostics.push(
              `${file}:${site.startLine}:${site.startCol}: ${occ.symbol}: ${target ? "occurrence classification unavailable (calls are not encoded in SCIP roles)" : "external, omitted or unresolved target"}`,
            );
            continue;
          }
          const enclosing = lookup.innermost(site.startLine, site.startCol);
          for (const kind of kinds) {
            const set = covered.get(kind) ?? new Set<string>();
            set.add(file);
            covered.set(kind, set);
            relationships.push({
              from: syntaxFiles.has(file)
                ? input.lookup.fromId(file, site.startLine, site.startCol)
                : enclosing && contains(enclosing.span, site)
                  ? enclosing.fact.identity
                  : `${file}#`,
              to: target.identity,
              file,
              kind,
              evidence: providerRange(site, text),
              resolution: "precise",
            });
          }
        }
        // A type mention may be absent in a described file, but its absence does not prove completeness.
        if (
          (!syntaxFiles.has(file) && fileDefs.length) ||
          [...existingTargets.values()].some((s) => s.file === file)
        ) {
          const types = covered.get("type-ref") ?? new Set<string>();
          types.add(file);
          covered.set("type-ref", types);
        }
        if (doc.symbols.some((s) => s.relationships.length))
          diagnostics.push(
            `${file}: SymbolInformation relationships omitted; implementation/override direction and class inheritance are not established by these flags`,
          );
      }
      const files = [...sources.keys()];
      const described = [...documents.keys()];
      const structuralLimits = [
        ...LIMITS,
        ...(described.length < files.length
          ? ["Some source files are absent, stale or have unknown positions."]
          : []),
      ];
      const results: AnalysisResult[] = [
        {
          capabilities: ["symbols"],
          status: "partial",
          analyzedFiles: [...placedFiles].filter((f) => !syntaxFiles.has(f)),
          limitations: [
            ...structuralLimits,
            "Files with syntax symbols keep that provider's symbol set; the artifact supplies only checked matching ranges and relationships.",
          ],
        },
        {
          capabilities: ["declarationRanges"],
          status: "partial",
          analyzedFiles: [...placedFiles],
          limitations: structuralLimits,
        },
        {
          capabilities: ["nesting"],
          status: "partial",
          analyzedFiles: [...nestingFiles],
          limitations: [
            "Parents require explicit enclosing symbols or matching descriptor prefixes and checked containment; missing parents are omitted.",
          ],
        },
      ];
      for (const kind of RELATIONSHIP_CAPABILITIES) {
        const analyzedFiles = [...(covered.get(kind) ?? [])];
        results.push({
          capabilities: [kind],
          status: analyzedFiles.length ? "partial" : "unsupported",
          analyzedFiles,
          resolution: "precise",
          limitations: [
            kind === "call"
              ? "SCIP occurrence roles do not distinguish calls from callable values."
              : "Only role-backed reads, writes and imports, and mentions of known types, are retained. External and unresolved targets are omitted; relationship coverage is incomplete.",
          ],
        });
      }
      return {
        provider: this.id,
        version: "1",
        tool: `${index.metadata.toolName || "scip"}@${index.metadata.toolVersion || "unknown"}`,
        configuration: `artifact-sha256:${createHash("sha256").update(bytes).digest("hex")};defaultEncoding:${manifest?.defaultEncoding ?? "explicit"}`,
        sourceHashes,
        declarations: [...definitions.values()].map((d) => d.fact),
        relationships,
        blind,
        analysis: [{ provider: this.id, capabilities: CAPABILITIES, files, results, diagnostics }],
      };
    },
  };
}
