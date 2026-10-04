/**
 * Maps SCIP, Kythe and Joern CPG artifacts of one fixture into xpl provider facts, runs them through
 * normalizeProvider/mergeProvider (via buildIndex), and compares the result with the tree-sitter index.
 *
 *   npx tsx docs/assessment-2026-10-04-graph-formats/assess.mts <fixture-copy> <artifact-dir> [out.json]
 *
 * <artifact-dir> holds what reproduce.sh writes: scip-go.scip, kythe-go.json (entrystream JSON),
 * cpg-go.json (export-cpg.sc). Throwaway assessment code: not a production importer (issue #11).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RELATIONSHIP_CAPABILITIES, splitLines, validateExplainer } from "@xpl/core";
import type { AnalysisCapabilities, AnalysisReport, IndexedSymbol, SymbolIndex } from "@xpl/core";
import { buildIndex, FileHasher } from "@xpl/indexer";
import type {
  IndexProvider,
  ProviderDeclaration,
  ProviderInput,
  ProviderOutput,
  ProviderRange,
  ProviderRelationship,
} from "@xpl/indexer";
import { decodeIndex } from "../../packages/indexer/src/scip/proto.ts";

const [root, artifacts, outFile] = process.argv.slice(2);
if (!root || !artifacts) throw new Error("usage: assess.mts <fixture-copy> <artifact-dir> [out.json]");

const hashOf = (text: string) => new FileHasher(splitLines(text)).hashFile();

/** Byte offset (UTF-8) -> zero-based [line, utf8 column] in `text`. */
function byteToPoint(text: string, offset: number): [number, number] | undefined {
  const bytes = Buffer.from(text, "utf8");
  if (offset < 0 || offset > bytes.length) return undefined;
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < offset; i++)
    if (bytes[i] === 0x0a) {
      line++;
      lineStart = i + 1;
    }
  return [line, offset - lineStart];
}
function byteRange(text: string, start: number, end: number): ProviderRange | undefined {
  const s = byteToPoint(text, start);
  const e = byteToPoint(text, end);
  return s && e ? { start: s, end: e, encoding: "utf8" } : undefined;
}

/** One result per capability group, all files analyzed: what an artifact adapter can honestly claim. */
function report(
  provider: string,
  capabilities: AnalysisCapabilities,
  files: string[],
  limitations: Partial<Record<string, string>>,
  resolution: "precise" | "heuristic",
): AnalysisReport {
  return {
    provider,
    capabilities,
    files,
    results: Object.entries(capabilities).map(([capability, level]) => ({
      capabilities: [capability as keyof AnalysisCapabilities],
      status: level === "supported" ? "supported" : "partial",
      analyzedFiles: files,
      limitations: limitations[capability] ? [limitations[capability]!] : [],
      // Relationship results say how their facts were resolved; structure results carry no resolution.
      ...((RELATIONSHIP_CAPABILITIES as readonly string[]).includes(capability) ? { resolution } : {}),
    })),
  };
}

interface Tally {
  emitted: Record<string, number>;
  dropped: Record<string, number>;
}
const bump = (m: Record<string, number>, k: string, n = 1) => (m[k] = (m[k] ?? 0) + n);

// ─── Kythe ─────────────────────────────────────────────────────────────────────────────────────

interface VName {
  signature?: string;
  corpus?: string;
  root?: string;
  path?: string;
  language?: string;
}
const vkey = (v: VName) => `${v.corpus ?? ""}|${v.root ?? ""}|${v.path ?? ""}|${v.signature ?? ""}`;

function kytheProvider(file: string, tally: Tally): IndexProvider {
  const capabilities: AnalysisCapabilities = {
    symbols: "supported",
    declarationRanges: "partial",
    nesting: "supported",
    call: "supported",
    // Not `import`: Go imports name packages, and an advertised kind without facts erases the pack's hints.
    implements: "partial",
    read: "partial",
    write: "partial",
    "type-ref": "partial",
  };
  return {
    id: "kythe-artifact",
    languages: ["go"],
    capabilities,
    async analyze(input: ProviderInput): Promise<ProviderOutput> {
      const facts = new Map<string, Map<string, string>>();
      const edges: { kind: string; source: VName; target: VName }[] = [];
      const nodes = new Map<string, VName>();
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line) continue;
        const e = JSON.parse(line) as {
          source: VName;
          target?: VName;
          edge_kind?: string;
          fact_name: string;
          fact_value?: string;
        };
        nodes.set(vkey(e.source), e.source);
        if (e.edge_kind) {
          edges.push({ kind: e.edge_kind.replace("/kythe/edge/", ""), source: e.source, target: e.target! });
          nodes.set(vkey(e.target!), e.target!);
          continue;
        }
        const map = facts.get(vkey(e.source)) ?? new Map<string, string>();
        map.set(e.fact_name, e.fact_value ? Buffer.from(e.fact_value, "base64").toString("utf8") : "");
        facts.set(vkey(e.source), map);
      }
      const fact = (v: VName, name: string) => facts.get(vkey(v))?.get(name);
      // Source identity: Kythe file nodes carry the exact text the indexer consumed.
      const texts = new Map<string, string>();
      for (const [k, f] of facts)
        if (f.get("/kythe/node/kind") === "file" && f.has("/kythe/text")) {
          const v = nodes.get(k)!;
          if (v.corpus === "jobrunner") texts.set(v.path!, f.get("/kythe/text")!);
        }
      const sourceHashes: Record<string, string> = {};
      for (const [path, text] of texts) sourceHashes[path] = hashOf(text);
      const anchorRange = (a: VName) => {
        const text = texts.get(a.path ?? "");
        const s = Number(fact(a, "/kythe/loc/start"));
        const e = Number(fact(a, "/kythe/loc/end"));
        return text === undefined || !Number.isFinite(s) ? undefined : byteRange(text, s, e);
      };
      const by = (kind: string) => edges.filter((e) => e.kind === kind);
      const binding = new Map<string, VName>();
      for (const e of by("defines/binding")) binding.set(vkey(e.target), e.source);
      const full = new Map<string, VName>();
      for (const e of by("defines")) if (e.source.path) full.set(vkey(e.target), e.source);
      const childof = new Map<string, VName>();
      for (const e of by("childof")) if (!fact(e.source, "/kythe/loc/start")) childof.set(vkey(e.source), e.target);
      const anchorScope = new Map<string, VName>();
      for (const e of by("childof")) if (fact(e.source, "/kythe/loc/start")) anchorScope.set(vkey(e.source), e.target);

      const declarations: ProviderDeclaration[] = [];
      const declared = new Map<string, ProviderDeclaration>();
      const kindOf = (v: VName): IndexedSymbol["kind"] | undefined => {
        const kind = fact(v, "/kythe/node/kind");
        const sub = fact(v, "/kythe/subkind") ?? "";
        if (kind === "function") return childof.has(vkey(v)) && fact(childof.get(vkey(v))!, "/kythe/node/kind") !== "package" ? "method" : "function";
        if (kind === "record") return "class";
        if (kind === "interface") return "interface";
        if (kind === "talias") return "type";
        if (kind === "variable" && (sub === "field" || sub === "")) return "variable";
        return undefined;
      };
      for (const [k, anchor] of binding) {
        const node = nodes.get(k)!;
        const kind = kindOf(node);
        const nodeKind = fact(node, "/kythe/node/kind") ?? "?";
        if (!kind) {
          bump(tally.dropped, `kythe ${nodeKind}/${fact(node, "/kythe/subkind") ?? ""} (not an xpl symbol)`);
          continue;
        }
        const identifier = anchorRange(anchor);
        const text = texts.get(anchor.path ?? "");
        if (!identifier || !text) continue;
        const [l, c] = identifier.start;
        const name = Buffer.from(splitLines(text)[l]!, "utf8").subarray(c, identifier.end[1]).toString("utf8");
        const fullAnchor = full.get(k);
        const d: ProviderDeclaration = {
          identity: k,
          file: anchor.path!,
          name,
          kind,
          identifier,
          ...(fullAnchor ? { declaration: anchorRange(fullAnchor) } : {}),
        };
        declarations.push(d);
        declared.set(k, d);
        bump(tally.emitted, `declaration ${kind}${fullAnchor ? "" : " (identifier only)"}`);
      }
      // Paths and parents from semantic childof (methods -> receiver type, fields -> struct).
      for (const d of declarations) {
        const parent = childof.get(d.identity);
        const p = parent && declared.get(vkey(parent));
        if (p) {
          d.parent = p.identity;
          d.path = `${p.path ?? p.name}.${d.name}`;
        }
      }
      // Relationships. `from` is the anchor's semantic scope (indexer flag --anchor_scopes).
      const relationships: ProviderRelationship[] = [];
      const fullBytes = new Map<string, { path: string; start: number; end: number }>();
      for (const id of declared.keys()) {
        const a = full.get(id);
        if (a?.path)
          fullBytes.set(id, { path: a.path, start: Number(fact(a, "/kythe/loc/start")), end: Number(fact(a, "/kythe/loc/end")) });
      }
      const fromOf = (anchor: VName) => {
        const scope = anchorScope.get(vkey(anchor));
        if (scope && declared.has(vkey(scope))) return vkey(scope);
        // Closures (`func run$1`) are not xpl symbols and have no childof to their enclosing function:
        // fall back to the innermost declared full range holding the anchor.
        const at = Number(fact(anchor, "/kythe/loc/start"));
        let best: { id: string; size: number } | undefined;
        for (const [id, a] of fullBytes)
          if (a.path === anchor.path && a.start <= at && at < a.end && (!best || a.end - a.start < best.size))
            best = { id, size: a.end - a.start };
        return best?.id ?? `${anchor.path}#`;
      };
      const targetKind = (v: VName) => fact(v, "/kythe/node/kind");
      for (const e of edges) {
        if (!e.source.path || !fact(e.source, "/kythe/loc/start")) continue;
        let kind: string | undefined;
        let to: string | undefined = declared.has(vkey(e.target)) ? vkey(e.target) : undefined;
        if (e.kind === "ref/call") kind = "call";
        else if (e.kind === "ref/writes") kind = "write";
        else if (e.kind === "ref/imports") {
          // A Go package is a directory; xpl imports target one module scope ("<file>#"). Lossy: pick none.
          bump(tally.dropped, "kythe ref/imports (package != file module scope)");
          continue;
        } else if (e.kind === "ref") {
          const tk = targetKind(e.target);
          // Generic ref: never a call. Function values and variables become reads, types type-refs.
          kind = tk === "record" || tk === "interface" || tk === "talias" ? "type-ref" : tk === "function" || tk === "variable" ? "read" : undefined;
        } else continue;
        if (!kind) {
          bump(tally.dropped, `kythe ${e.kind} -> ${targetKind(e.target)}`);
          continue;
        }
        if (!to) {
          bump(tally.dropped, `kythe ${e.kind} -> external or local target`);
          continue;
        }
        const evidence = anchorRange(e.source);
        if (!evidence) continue;
        relationships.push({ from: fromOf(e.source), to, kind, file: e.source.path, evidence, resolution: "precise" });
        bump(tally.emitted, `relationship ${kind} (from ${e.kind})`);
      }
      // satisfies has no anchor: evidence is the implementing type's identifier (stated, not hidden).
      for (const e of by("satisfies")) {
        const from = declared.get(vkey(e.source));
        const to = declared.get(vkey(e.target));
        if (!from || !to || !from.identifier) {
          bump(tally.dropped, "kythe satisfies -> external interface");
          continue;
        }
        relationships.push({ from: from.identity, to: to.identity, kind: "implements", file: from.file, evidence: from.identifier, resolution: "precise" });
        bump(tally.emitted, "relationship implements (from satisfies, evidence = type identifier)");
      }
      for (const kind of ["overrides", "typed", "documents", "ref/init"])
        if (by(kind).length) bump(tally.dropped, `kythe ${kind} (no xpl relationship)`, by(kind).length);
      for (const e of edges) if (/^t?param\.\d+$/.test(e.kind)) bump(tally.dropped, "kythe param.N/tparam.N (type graph)");
      const files = input.sources.filter((s) => s.language === "go" && texts.has(s.path)).map((s) => s.path);
      return {
        provider: "kythe-artifact",
        version: "kythe-v0.0.76",
        configuration: "go_indexer --anchor_scopes",
        tool: "kythe go_indexer@v0.0.76",
        sourceHashes,
        declarations,
        relationships,
        analysis: [
          report("kythe-artifact", capabilities, files, {
            declarationRanges: "Variables and fields have identifier anchors only.",
            implements: "Satisfaction has no source anchor.",
          }, "precise"),
        ],
      };
    },
  };
}

// ─── SCIP (declaration import, as #12 would need it) ────────────────────────────────────────────

const SCIP_KIND: Record<number, IndexedSymbol["kind"]> = {
  17: "function",
  26: "method",
  49: "class",
  21: "interface",
  54: "type",
  15: "variable",
  61: "variable",
  8: "variable",
};

function scipProvider(file: string, tally: Tally): IndexProvider {
  const capabilities: AnalysisCapabilities = {
    symbols: "partial",
    declarationRanges: "partial",
    nesting: "partial",
    implements: "partial",
  };
  return {
    id: "scip-artifact",
    languages: ["go"],
    capabilities,
    async analyze(input: ProviderInput): Promise<ProviderOutput> {
      const index = decodeIndex(readFileSync(file));
      const declarations: ProviderDeclaration[] = [];
      const declared = new Map<string, ProviderDeclaration>();
      const generic: Record<string, number> = {};
      const toRange = (r: number[]): ProviderRange =>
        r.length === 3
          ? { start: [r[0]!, r[1]!], end: [r[0]!, r[2]!], encoding: "utf8" }
          : { start: [r[0]!, r[1]!], end: [r[2]!, r[3]!], encoding: "utf8" };
      for (const doc of index.documents) {
        const info = new Map(doc.symbols.map((s) => [s.symbol, s]));
        for (const o of doc.occurrences) {
          if (!(o.symbolRoles & 1)) {
            bump(generic, o.symbolRoles & 2 ? "import" : "generic occurrence (no call/read distinction)");
            continue;
          }
          if (o.symbol.startsWith("local ")) continue;
          const s = info.get(o.symbol);
          const kind = s && SCIP_KIND[s.kind];
          if (!s || !kind) {
            bump(tally.dropped, `scip definition kind ${s?.kind ?? "?"} (not an xpl symbol)`);
            continue;
          }
          const d: ProviderDeclaration = {
            identity: o.symbol,
            file: doc.relativePath,
            name: s.displayName,
            kind,
            identifier: toRange(o.range),
            ...(o.enclosingRange.length ? { declaration: toRange(o.enclosingRange) } : {}),
          };
          declarations.push(d);
          declared.set(o.symbol, d);
          bump(tally.emitted, `declaration ${kind}${o.enclosingRange.length ? "" : " (identifier only)"}`);
        }
      }
      // Nesting from the symbol descriptor grammar: `.../Type#Method().` -> `.../Type#`.
      for (const d of declarations) {
        const m = /^(.*#)[^#]+$/.exec(d.identity);
        const parent = m && declared.get(m[1]!);
        if (parent && parent !== d) {
          d.parent = parent.identity;
          d.path = `${parent.path ?? parent.name}.${d.name}`;
        }
      }
      const relationships: ProviderRelationship[] = [];
      for (const doc of index.documents)
        for (const s of doc.symbols)
          for (const r of s.relationships)
            if (r.isImplementation) {
              const from = declared.get(s.symbol);
              const to = declared.get(r.symbol);
              if (!from || !to || !from.identifier) {
                bump(tally.dropped, "scip is_implementation -> external");
                continue;
              }
              relationships.push({ from: from.identity, to: to.identity, kind: "implements", file: from.file, evidence: from.identifier, resolution: "precise" });
              bump(tally.emitted, "relationship implements (is_implementation, evidence = type identifier)");
            }
      for (const [k, n] of Object.entries(generic)) bump(tally.dropped, `scip ${k}`, n);
      const files = input.sources.filter((s) => s.language === "go").map((s) => s.path);
      // SCIP documents carry no text: freshness rests on this script having just run the tool on these files.
      const sourceHashes = Object.fromEntries(
        input.sources.filter((s) => files.includes(s.path)).map((s) => [s.path, hashOf(s.text)]),
      );
      return {
        provider: "scip-artifact",
        version: `${index.metadata.toolName}@${index.metadata.toolVersion}`,
        configuration: "declarations",
        tool: `${index.metadata.toolName}@${index.metadata.toolVersion}`,
        sourceHashes,
        declarations,
        relationships,
        analysis: [
          report("scip-artifact", capabilities, files, {
            declarationRanges: "Only functions carry enclosing ranges.",
          }, "precise"),
        ],
      };
    },
  };
}

// ─── Joern CPG (export-cpg.sc JSON) ────────────────────────────────────────────────────────────

interface CpgMethod {
  fullName: string;
  name: string;
  file: string;
  line: number | null;
  col: number | null;
  lineEnd: number | null;
  colEnd: number | null;
  offset: number | null;
  offsetEnd: number | null;
  astParentType: string;
  astParentFullName: string;
}
interface CpgTypeDecl extends Omit<CpgMethod, "lineEnd" | "colEnd"> {
  inherits: string[];
}
interface CpgCall {
  name: string;
  code: string;
  methodFullName: string;
  file: string;
  caller: string;
  line: number | null;
  col: number | null;
  offset: number | null;
  offsetEnd: number | null;
  callees: string[];
}
interface CpgExport {
  files: { name: string; hash: string; content: string }[];
  typeDecls: CpgTypeDecl[];
  methods: CpgMethod[];
  calls: CpgCall[];
}

/** gosrc2cpg: Go token positions, 1-based line and 1-based byte column. */
function cpgProvider(
  file: string,
  log: string,
  tally: Tally,
  resolution: "precise" | "heuristic",
): IndexProvider {
  const capabilities: AnalysisCapabilities = {
    symbols: "partial",
    declarationRanges: "partial",
    nesting: "partial",
    call: "partial",
  };
  return {
    id: "cpg-artifact",
    languages: ["go"],
    capabilities,
    async analyze(input: ProviderInput): Promise<ProviderOutput> {
      const cpg = JSON.parse(readFileSync(file, "utf8")) as CpgExport;
      const sources = new Map(input.sources.map((s) => [s.path, s.text]));
      const synthetic = (name: string) => /^<|^:|<lambda>|<init>|<clinit>|\.go$/.test(name) || name.includes("/");
      const declarations: ProviderDeclaration[] = [];
      const declared = new Map<string, ProviderDeclaration>();
      const point = (line: number, col: number): [number, number] => [line - 1, col - 1];
      for (const t of cpg.typeDecls) {
        if (!sources.has(t.file) || synthetic(t.name)) {
          bump(tally.dropped, "cpg TYPE_DECL synthetic or package-level");
          continue;
        }
        // Go TYPE_DECLs carry only a start position: no identifier extent, no full range.
        const d: ProviderDeclaration = { identity: t.fullName, file: t.file, name: t.name, kind: "class" };
        declarations.push(d);
        declared.set(t.fullName, d);
        bump(tally.emitted, "declaration type (start position only)");
      }
      for (const m of cpg.methods) {
        if (!sources.has(m.file) || synthetic(m.name) || m.line == null || m.lineEnd == null) {
          bump(tally.dropped, "cpg METHOD synthetic (<clinit>, file method, lambda)");
          continue;
        }
        const parent = declared.get(m.astParentFullName);
        const d: ProviderDeclaration = {
          identity: m.fullName,
          file: m.file,
          name: m.name,
          kind: parent ? "method" : "function",
          declaration: { start: point(m.line, m.col!), end: point(m.lineEnd, m.colEnd!), encoding: "utf8" },
          ...(parent ? { parent: parent.identity, path: `${parent.name}.${m.name}` } : {}),
        };
        declarations.push(d);
        declared.set(m.fullName, d);
        bump(tally.emitted, `declaration ${d.kind} (full range, no identifier extent)`);
      }
      const relationships: ProviderRelationship[] = [];
      // gosrc2cpg drops whole statements it cannot read (defer, go, select, ...): no call coverage there.
      const skipped = new Set(
        [...(existsSync(log) ? readFileSync(log, "utf8") : "").matchAll(/found this inside '([^']+)'/g)].map((m) => m[1]!),
      );
      const blind: { file: string; line: number; col: number }[] = [];
      for (const c of cpg.calls) {
        const callee = c.callees.find((x) => declared.has(x));
        const from = declared.get(c.caller);
        if (!callee) {
          // Seen but unresolved (interface dispatch, function values, externals): keep the pack's hint there.
          if (from && c.line != null && c.col != null) blind.push({ file: from.file, line: c.line, col: c.col });
          bump(tally.dropped, "cpg CALL unresolved or external callee (blind)");
          continue;
        }
        if (!from || c.line == null || c.col == null) {
          bump(tally.dropped, "cpg CALL from synthetic method (package init, lambda)");
          continue;
        }
        // No end position: reconstruct from CODE and keep it only where the source spells it exactly.
        const text = sources.get(from.file)!;
        const line = splitLines(text)[c.line - 1] ?? "";
        const start = c.col - 1;
        const bytes = Buffer.from(line, "utf8");
        const code = Buffer.from(c.code, "utf8");
        if (c.code.includes("\n") || !bytes.subarray(start, start + code.length).equals(code)) {
          bump(tally.dropped, "cpg CALL code does not match source at its position");
          continue;
        }
        relationships.push({
          from: from.identity,
          to: callee,
          kind: "call",
          file: from.file,
          evidence: { start: [c.line - 1, start], end: [c.line - 1, start + code.length], encoding: "utf8" },
          resolution,
        });
        bump(tally.emitted, "relationship call (CALL edge, range rebuilt from CODE)");
      }
      const files = input.sources.filter((s) => s.language === "go").map((s) => s.path);
      const callFiles = files.filter((f) => !skipped.has(f));
      bump(tally.dropped, "cpg call coverage withdrawn: file has statements the frontend skipped", files.length - callFiles.length);
      // gosrc2cpg leaves FILE.content and FILE.hash empty: freshness rests on this script having run it.
      const verified = cpg.files.filter((f) => f.hash || (f.content && f.content !== "<empty>")).length;
      if (!verified) bump(tally.dropped, "cpg FILE without content or hash (source identity unverifiable)", 0);
      const sourceHashes = Object.fromEntries(
        input.sources.filter((s) => files.includes(s.path)).map((s) => [s.path, hashOf(s.text)]),
      );
      return {
        provider: "cpg-artifact",
        version: "joern-4.0.646 gosrc2cpg",
        configuration: "default overlays",
        tool: "joern@4.0.646",
        sourceHashes,
        declarations,
        relationships,
        blind,
        analysis: [
          {
            ...report("cpg-artifact", capabilities, files, {
              declarationRanges: "Type declarations have start positions only.",
            }, resolution),
            results: report("cpg-artifact", capabilities, files, {
              declarationRanges: "Type declarations have start positions only.",
            }, resolution).results.map((r) =>
              r.capabilities.includes("call")
                ? { ...r, analyzedFiles: callFiles, limitations: ["Calls in defer, go and select statements are not in the graph."] }
                : r,
            ),
          },
        ],
      };
    },
  };
}

/**
 * What a careful adapter does when a language pack already supplies the file's symbols:
 * - a declaration without a full range is not sent; when the pack has the same canonical ID
 *   (`<file>#<path>`), relationships use that ID as their endpoint, otherwise they are dropped too;
 * - a file that lost any declaration is withdrawn from `symbols`/`nesting` coverage (its full ranges still
 *   update the pack's nodes through range-only coverage), and a file that lost facts of a relationship kind is
 *   withdrawn from that kind's coverage, so the pack's hints survive instead of being erased by an incomplete
 *   replacement.
 */
function adapted(provider: IndexProvider, tally: Tally): IndexProvider {
  return {
    ...provider,
    async analyze(input) {
      const out = await provider.analyze(input);
      const existing = new Set(input.symbols.map((s) => s.id));
      const kept = out.declarations.filter((d) => d.declaration);
      const ids = new Set(kept.map((d) => d.identity));
      const canonical = new Map<string, string>();
      const structureGaps = new Set<string>();
      for (const d of out.declarations) {
        if (d.declaration) continue;
        structureGaps.add(d.file);
        const id = `${d.file}#${d.path ?? d.name}`;
        if (existing.has(id)) canonical.set(d.identity, id);
        bump(tally.dropped, `adapter: declaration without full range${existing.has(id) ? " (endpoint kept as pack ID)" : ""}`);
      }
      const declarations = kept.map((d) => {
        if (d.parent === undefined || ids.has(d.parent)) return d;
        const { parent: _, ...rest } = d;
        return rest;
      });
      // Module scopes are "<file>#" for an indexed file (SCIP type descriptors also end in "#").
      const modules = new Set(input.sources.map((x) => `${x.path}#`));
      const endpoint = (id: string) => (ids.has(id) || modules.has(id) ? id : canonical.get(id));
      const relGaps = new Map<string, Set<string>>();
      const relationships: ProviderRelationship[] = [];
      for (const r of out.relationships) {
        const from = endpoint(r.from);
        const to = endpoint(r.to);
        if (from && to) relationships.push({ ...r, from, to });
        else {
          relGaps.set(r.kind, (relGaps.get(r.kind) ?? new Set()).add(r.file));
          bump(tally.dropped, `adapter: ${r.kind} to an unknown declaration`);
        }
      }
      const analysis = out.analysis.map((report) => ({
        ...report,
        results: report.results.map((result) => {
          const gaps = result.capabilities.some((c) => c === "symbols" || c === "nesting")
            ? structureGaps
            : new Set(result.capabilities.flatMap((c) => [...(relGaps.get(c) ?? [])]));
          if (!gaps.size) return result;
          return {
            ...result,
            analyzedFiles: result.analyzedFiles.filter((f) => !gaps.has(f)),
            limitations: [...result.limitations, "Some facts could not be mapped; the pack's hints remain."],
          };
        }),
      }));
      return { ...out, declarations, relationships, analysis };
    },
  };
}

// ─── Run and compare ───────────────────────────────────────────────────────────────────────────

const explainerPath = join(root, ".explainer/jobrunner.explainer.json");
const explainer = existsSync(explainerPath) ? JSON.parse(readFileSync(explainerPath, "utf8")) : undefined;
const getText = (path: string) => {
  try {
    return readFileSync(join(root, path), "utf8");
  } catch {
    return undefined;
  }
};
const edgeKey = (r: SymbolIndex["refs"][number]) => `${r.from} ${r.kind} ${r.to}`;
const symKey = (s: IndexedSymbol) => `${s.id} ${s.range.startLine}-${s.range.endLine}`;
function summarize(index: SymbolIndex, baseline?: SymbolIndex) {
  const go = (id: string) => id.endsWith(".go") || id.includes(".go#");
  const syms = index.symbols.filter((s) => go(s.file));
  const refs = index.refs.filter((r) => go(r.from));
  const byKind: Record<string, number> = {};
  for (const r of refs) bump(byKind, `${r.kind}/${r.resolution}`);
  const out: Record<string, unknown> = {
    goSymbols: syms.length,
    goRefs: refs.length,
    refsByKind: byKind,
    goLanguageLabel: index.languages.go,
  };
  if (baseline) {
    const bs = new Set(baseline.symbols.filter((s) => go(s.file)).map((s) => s.id));
    const bsr = new Set(baseline.symbols.filter((s) => go(s.file)).map(symKey));
    const ids = new Set(syms.map((s) => s.id));
    out.symbolIdsShared = syms.filter((s) => bs.has(s.id)).length;
    out.symbolIdsSameLines = syms.filter((s) => bsr.has(symKey(s))).length;
    out.symbolIdsOnlyHere = syms.filter((s) => !bs.has(s.id)).map((s) => s.id);
    out.symbolIdsLost = [...bs].filter((id) => !ids.has(id));
    const lostByKind: Record<string, number> = {};
    for (const s of baseline.symbols) if (go(s.file) && !ids.has(s.id)) bump(lostByKind, s.kind);
    out.symbolsLostByKind = lostByKind;
    // Distinct caller -> callee pairs, compared with the heuristic resolver's.
    const pairs = (i: SymbolIndex) =>
      new Set(i.refs.filter((r) => go(r.from) && r.kind === "call").map(edgeKey));
    const mine = pairs(index);
    const theirs = pairs(baseline);
    out.callPairs = mine.size;
    out.callPairsShared = [...mine].filter((e) => theirs.has(e)).length;
    out.callPairsOnlyHere = [...mine].filter((e) => !theirs.has(e));
    out.callPairsOnlyHeuristic = [...theirs].filter((e) => !mine.has(e));
  }
  if (explainer) {
    const issues = validateExplainer(explainer, index, getText, {});
    out.explainerErrors = issues.filter((i) => i.severity === "error").map((i) => `${i.path}: ${i.message}`);
    out.explainerWarnings = issues.filter((i) => i.severity === "warning").length;
    // Which provider supplied each symbol the explainer anchors to (checked against that provider's range).
    const anchors = new Set<string>();
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        if (typeof o.file === "string" && typeof o.symbol === "string") anchors.add(`${o.file}#${o.symbol}`);
        Object.values(o).forEach(walk);
      }
    };
    walk(explainer);
    const served: Record<string, number> = {};
    for (const id of anchors) {
      const s = index.symbols.find((x) => x.id === id);
      bump(served, s ? (index.providers?.[s.provider ?? -1]?.id ?? "?") : "missing");
    }
    out.explainerSymbolAnchorsBy = served;
  }
  return out;
}
function diagnostics(index: SymbolIndex, provider: string) {
  const reports = (index.analysis ?? []).filter((r) => r.provider === provider);
  const reasons: Record<string, number> = {};
  for (const r of reports)
    for (const d of r.diagnostics ?? []) bump(reasons, d.replace(/^.*?: /, "").replace(/`[^`]*`/g, "…"));
  return {
    reasons,
    examples: reports.flatMap((r) => r.diagnostics ?? []).slice(0, 5),
    results: reports.flatMap((r) => r.results.map((x) => `${x.capabilities.join(",")}: ${x.status} (${x.analyzedFiles.length} files)`)),
  };
}

const baseline = (await buildIndex({ root, precise: "off" })).index;
const results: Record<string, unknown> = { baseline: summarize(baseline) };
const runs: [string, (t: Tally) => IndexProvider, string][] = [
  ["scip", (t) => scipProvider(join(artifacts, "scip-go.scip"), t), "scip-go.scip"],
  ["kythe", (t) => kytheProvider(join(artifacts, "kythe-go.json"), t), "kythe-go.json"],
  // gosrc2cpg resolves callees with its own type recovery, not the Go type checker: hints.
  [
    "cpg",
    (t) => cpgProvider(join(artifacts, "cpg-go.json"), join(artifacts, "gosrc2cpg.log"), t, "heuristic"),
    "cpg-go.json",
  ],
  // The same CPG facts with call coverage claimed everywhere, as if the format alone vouched for them.
  ["cpg-claims-all-calls", (t) => cpgProvider(join(artifacts, "cpg-go.json"), "", t, "heuristic"), "cpg-go.json"],
];
for (const [format, make, artifact] of runs) for (const mode of ["raw", "adapted"]) {
  const name = `${format}/${mode}`;
  if (!existsSync(join(artifacts, artifact))) {
    results[name] = { skipped: `${artifact} missing` };
    continue;
  }
  const tally: Tally = { emitted: {}, dropped: {} };
  const provider = mode === "raw" ? make(tally) : adapted(make(tally), tally);
  const { index, warnings } = await buildIndex({ root, precise: "auto", providers: [provider] });
  results[name] = {
    adapter: tally,
    normalize: diagnostics(index, provider.id),
    merged: summarize(index, baseline),
    warnings,
  };
}
// Staleness: the same Kythe artifact against a copy where one file gained a line (reproduce.sh).
const stale = `${root}-stale`;
if (existsSync(stale) && existsSync(join(artifacts, "kythe-go.json"))) {
  const tally: Tally = { emitted: {}, dropped: {} };
  const provider = adapted(kytheProvider(join(artifacts, "kythe-go.json"), tally), tally);
  const { index } = await buildIndex({ root: stale, precise: "auto", providers: [provider] });
  results["kythe/adapted/stale-copy"] = {
    normalize: diagnostics(index, provider.id),
    staleFileSymbolProviders: index.symbols
      .filter((s) => s.file === "internal/queue/queue.go")
      .map((s) => index.providers?.[s.provider ?? -1]?.id ?? "?")
      .reduce<Record<string, number>>((m, id) => (bump(m, id), m), {}),
  };
}
const json = JSON.stringify(results, null, 2);
if (outFile) writeFileSync(outFile, json + "\n");
console.log(json);
