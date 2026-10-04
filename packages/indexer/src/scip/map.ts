/**
 * SCIP -> `Reference[]` (ARCHITECTURE.md §3, "Precise resolution").
 *
 * Input: one or more decoded SCIP indexes (a Go repository has one per module) and the built symbols of the
 * repository (`PreciseInput`). Output: references with `resolution: "precise"`.
 *
 * For every non-definition occurrence of a symbol whose definition lies in an indexed file:
 *
 *  - `from`  = the innermost symbol at the occurrence, else the file's module scope (`"<file>#"`);
 *  - `to`    = the symbol that *is* the definition (`resolveDefinition`: the innermost symbol at the definition
 *              when the definition identifier is its name, else the symbol at the path the SCIP descriptors
 *              spell), the module scope of the defining file for modules and packages, the class for a
 *              constructor. Definitions nested in something that is not a symbol of ours (a parameter, a local
 *              variable, an instance attribute) have no target and their references are dropped. `local N`
 *              symbols follow the same rules, which keeps calls to functions nested in functions;
 *  - `kind`/`site` = the language pack's `classifySite` at the occurrence (`import` becomes `type-ref` for
 *              type-only imports, by the syntax of the statement; a plain read is a `read` when its target is a
 *              variable of ours, a field or a constant - the indexers do not tell reads from writes, the pack's
 *              syntax does). When the pack does not classify it:
 *              a quoted module specifier -> `import` (of the module scope; redundant, hence dropped, when the
 *              same statement imports names), role Import -> `import`, role WriteAccess -> `write`, a
 *              type-like symbol -> `type-ref`, else the occurrence is dropped (declarations are not references
 *              we keep).
 *
 * `is_implementation` relationships become `implements` references from the implementing symbol's definition
 * to the definition of what it implements (Go interfaces are satisfied implicitly, so this is the only place
 * they show up), unless an occurrence already said `extends`/`implements`, or a member merely overrides one
 * of a base class. Self references are dropped, the result is deduplicated and sorted.
 *
 * Symbols are matched across indexes without their package version, so the indexes of several modules can
 * refer to each other's definitions.
 *
 * Positions: SCIP ranges are 0-based, end exclusive, in the document's position encoding. They are converted
 * to our 1-based, inclusive, UTF-16 columns against the text of the file on disk.
 */
import { moduleScopeId, splitLines } from "@xpl/core";
import type { FileLanguage, FilePath, IndexedSymbol, Reference, SymbolId } from "@xpl/core";
import { nodeSpan, pointsToSpan, spanContains } from "../ast.js";
import type { FileContext, RepoView, Span } from "../languages/types.js";
import type { PreciseInput } from "../precise.js";
import type { SymbolEntry, SymbolLookup } from "../symbols.js";
import { PositionEncoding, SymbolKind, SymbolRole, parseScipRange } from "./proto.js";
import type { ScipDocument, ScipIndex, ScipRange } from "./proto.js";
import {
  isConstructorSymbol,
  isLocalSymbol,
  isModuleSymbol,
  isTypeSymbol,
  parseScipSymbol,
  symbolPath,
  withoutVersion,
} from "./symbol.js";

/** How the `character` offsets of a range count. */
export type ColumnEncoding = "utf8" | "utf16" | "utf32";

/** One decoded SCIP index and where its documents live. */
export interface ScipSource {
  index: ScipIndex;
  /** Directory of the index's project root relative to the indexed root: "" or e.g. `services/api`. */
  pathPrefix: string;
  /**
   * Encoding of documents that do not say (`position_encoding` unspecified). scip-typescript and scip-python
   * count UTF-16 code units, scip-go counts UTF-8 bytes (verified against non-ASCII sources).
   */
  defaultEncoding: ColumnEncoding;
  /**
   * The tool reads files without their byte order mark, so columns on line 1 do not count it (scip-typescript;
   * scip-python and scip-go count it like we do).
   */
  excludesBom?: boolean;
}

export type MapInput = Pick<
  PreciseInput,
  "root" | "languages" | "files" | "lookup" | "readText" | "withFile" | "warn"
> & {
  sources: readonly ScipSource[];
};

export interface MapResult {
  refs: Reference[];
  /**
   * Occurrences the tool could not link: a `local` symbol with no definition in its document (scip-typescript
   * gives `ns.f` that way when `f` is an aliased re-export, `export { g as f }`), or a symbol whose definition
   * does not fit its file (`misplaced`). See `PreciseOutput.blind`.
   */
  blind: { file: FilePath; line: number; col: number }[];
  /** Described files with occurrences outside their text, or malformed (`//line` directives of generated Go code). */
  misplaced: FilePath[];
  /** Indexed files of the covered languages that a SCIP document described (sorted). */
  described: FilePath[];
  /** Indexed files of the covered languages that no SCIP document described (sorted). */
  uncovered: FilePath[];
  stats: MapStats;
}

export interface MapStats {
  /** Documents that describe an indexed file. */
  documents: number;
  /** Documents of files we did not index (or outside the root): ignored. */
  foreignDocuments: number;
  /** Occurrences whose range does not fit the file text (the file changed since it was indexed?). */
  outOfRange: number;
  /** Occurrences with a malformed range. */
  malformed: number;
  /** References dropped because no symbol of ours is the definition (parameters, instance attributes, ...). */
  unresolvedTargets: number;
  /** Occurrences the language pack threw on (they are treated as not classified). */
  classifyErrors: number;
}

/** `SymbolInformation.Kind` values that are types (used when the indexer sets kinds, e.g. scip-go). */
const TYPE_KINDS: ReadonlySet<number> = new Set([
  SymbolKind.Class,
  SymbolKind.Enum,
  SymbolKind.Interface,
  SymbolKind.Protocol,
  SymbolKind.Struct,
  SymbolKind.Trait,
  SymbolKind.Type,
  SymbolKind.TypeAlias,
  SymbolKind.Union,
]);

// ─── Columns ──────────────────────────────────────────────────────────────────────────────────────

const ASCII_ONLY = /^[\x00-\x7f]*$/;

function utf8Length(codePoint: number): number {
  return codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
}

/** Resolve the column encoding of a document. */
function encodingOf(doc: ScipDocument, source: ScipSource): ColumnEncoding {
  switch (doc.positionEncoding) {
    case PositionEncoding.Utf8:
      return "utf8";
    case PositionEncoding.Utf16:
      return "utf16";
    case PositionEncoding.Utf32:
      return "utf32";
    default:
      return source.defaultEncoding;
  }
}

/**
 * 0-based offset in `encoding` units from the start of `line` -> 0-based UTF-16 index into `line`.
 * Offsets past the end of the line clamp to its length; one inside a multi-unit character rounds up to
 * the end of that character.
 */
export function toUtf16Offset(line: string, offset: number, encoding: ColumnEncoding): number {
  if (encoding === "utf16" || ASCII_ONLY.test(line)) return Math.min(offset, line.length);
  let consumed = 0;
  let index = 0;
  while (index < line.length && consumed < offset) {
    const codePoint = line.codePointAt(index)!;
    consumed += encoding === "utf8" ? utf8Length(codePoint) : 1;
    index += codePoint > 0xffff ? 2 : 1;
  }
  return index;
}

/** A SCIP document together with the text of the file it describes. */
class DocumentView {
  /** Columns to add on line 1: 1 when the file starts with a BOM the indexer did not see. */
  private readonly firstLineShift: number;

  constructor(
    readonly path: FilePath,
    readonly doc: ScipDocument,
    readonly encoding: ColumnEncoding,
    readonly lines: readonly string[],
    excludesBom = false,
  ) {
    this.firstLineShift = excludesBom && lines[0]?.charCodeAt(0) === 0xfeff ? 1 : 0;
  }

  /** The range as a `Span` (1-based, inclusive, UTF-16); undefined if it does not fit the text. */
  span(range: ScipRange): Span | undefined {
    const { lines } = this;
    if (range.startLine >= lines.length || range.endLine >= lines.length) return undefined;
    const column = (line: number, offset: number): number =>
      toUtf16Offset(lines[line]!, offset, this.encoding) + (line === 0 ? this.firstLineShift : 0);
    return pointsToSpan(
      range.startLine,
      column(range.startLine, range.startChar),
      range.endLine,
      column(range.endLine, range.endChar),
      lines,
    );
  }

  /** The source text of a single-line span. */
  text(span: Span): string | undefined {
    if (span.startLine !== span.endLine) return undefined;
    return this.lines[span.startLine - 1]?.slice(span.startCol - 1, span.endCol);
  }
}

// ─── Definitions ──────────────────────────────────────────────────────────────────────────────────

interface Definition {
  file: FilePath;
  span: Span;
  /** The identifier text at the definition (single-line definitions only). */
  text: string | undefined;
  /** A zero-width definition: how indexers mark whole-file symbols (TypeScript and Python modules). */
  empty: boolean;
}

interface Resolved {
  id: SymbolId;
  /** The definition occurrence that `id` was derived from (in `id`'s file). */
  definition: Definition;
  typeLike: boolean;
  /** A module or package: `id` is the module scope of the defining file. */
  moduleLike: boolean;
  /** For modules: every file that defines it (a Go package has one definition per file), sorted. */
  moduleFiles: readonly FilePath[];
}

function compareDefinitions(a: Definition, b: Definition): number {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  return a.span.startLine - b.span.startLine || a.span.startCol - b.span.startCol;
}

/** Last segment of a symbol path (`Runner.dispatch` -> `dispatch`). */
function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf(".") + 1);
}

function unquote(name: string): string {
  return name.replace(/^["'`]|["'`]$/g, "");
}

/**
 * Is the identifier at a definition the *name* of `entry`'s symbol? A definition merely nested inside the
 * symbol (a parameter, a Python instance attribute assigned in `__init__`, a TypeScript enum member or
 * constructor parameter property) is not that symbol, and pointing references at the container would be wrong.
 */
function namesSymbol(entry: SymbolEntry, identifier: string | undefined): boolean {
  if (identifier === undefined) return true;
  const name = lastSegment(entry.basePath);
  return name === identifier || name === "default" || unquote(name) === unquote(identifier);
}

// ─── The mapping ──────────────────────────────────────────────────────────────────────────────────

function compareRefs(a: Reference, b: Reference): number {
  const fileA = a.from.slice(0, a.from.indexOf("#"));
  const fileB = b.from.slice(0, b.from.indexOf("#"));
  if (fileA !== fileB) return fileA < fileB ? -1 : 1;
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

/** Repo-relative path of a document, or undefined if it lies outside the indexed root. */
export function documentPath(prefix: string, relativePath: string): FilePath | undefined {
  const raw = (prefix === "" ? relativePath : `${prefix}/${relativePath}`).replace(/\\/g, "/");
  if (relativePath.startsWith("/") || /^[A-Za-z]:\//.test(raw)) return undefined; // absolute
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.length > 0 ? parts.join("/") : undefined;
}

/** `RepoView` over the indexed files, for the packs' module resolution. */
class MapRepoView implements RepoView {
  readonly files: ReadonlySet<FilePath>;
  private readonly dirs = new Map<string, FilePath[]>();

  constructor(
    readonly root: string,
    paths: readonly FilePath[],
    private readonly read: (path: FilePath) => string | undefined,
  ) {
    this.files = new Set(paths);
    for (const path of [...paths].sort()) {
      const slash = path.lastIndexOf("/");
      const dir = slash < 0 ? "" : path.slice(0, slash);
      const list = this.dirs.get(dir);
      if (list) list.push(path);
      else this.dirs.set(dir, [path]);
    }
  }

  filesInDir(dir: string): readonly FilePath[] {
    return this.dirs.get(dir === "." ? "" : dir) ?? [];
  }

  readText(path: FilePath): string | undefined {
    return this.read(path);
  }
}

/**
 * The other spelling of a method-like symbol: `Store#Get().` <-> `Store#Get.`. scip-go names an interface
 * method with a term descriptor where it is declared but as a method where another module refers to it, so
 * a reference without a definition may still be a reference to a symbol defined under the other spelling.
 */
function alternateKey(key: string): string | undefined {
  if (key.endsWith("().")) return `${key.slice(0, -3)}.`;
  if (key.endsWith(".") && !key.endsWith(").")) return `${key.slice(0, -1)}().`;
  return undefined;
}

/** Quote characters that delimit a module specifier (`"./x"`, `'./x'`, `` `./x` ``). */
const QUOTES = new Set(['"', "'", "`"]);

/** The span of the top-level statement (a child of the syntax tree's root) that contains `span`. */
function topLevelSpan(ctx: FileContext, span: Span): Span | undefined {
  let node = ctx.tree.rootNode.descendantForPosition(
    { row: span.startLine - 1, column: span.startCol - 1 },
    { row: span.startLine - 1, column: span.startCol },
  );
  if (!node) return undefined;
  while (node.parent?.parent) node = node.parent;
  return nodeSpan(node, ctx.lines);
}

interface ModuleEntry {
  dotted: string;
  definition: Definition;
}

/** Directory part of a repo path ("" at the root). */
function dirOf(path: FilePath): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** The package and dotted module name (`flask.cli`) of a module symbol; undefined for other symbols. */
function moduleName(symbol: string): { package: string; dotted: string } | undefined {
  if (!symbol.endsWith("/") && !symbol.endsWith("__init__:")) return undefined; // cheap pre-check
  const parsed = parseScipSymbol(symbol);
  if (!parsed || !isModuleSymbol(parsed)) return undefined;
  const dotted = parsed.descriptors
    .filter((d) => d.suffix === "namespace")
    .map((d) => d.name)
    .join(".");
  if (dotted === "") return undefined;
  return { package: `${parsed.scheme}\0${parsed.manager}\0${parsed.packageName}`, dotted };
}

class Mapper {
  private readonly languageOf = new Map<FilePath, FileLanguage>();
  private readonly covered: ReadonlySet<FileLanguage>;
  private readonly lookup: SymbolLookup;
  private readonly docs: DocumentView[] = [];
  private readonly kinds = new Map<string, number>();
  private readonly definitions = new Map<string, Definition[]>();
  private readonly resolved = new Map<string, Resolved | null>();
  private readonly canonicalKeys = new Map<string, string>();
  /** Module symbols by package (`scheme manager name`): dotted module name and where it is defined. */
  private readonly modules = new Map<string, ModuleEntry[]>();
  private readonly refs = new Map<string, Reference>();
  private readonly blind: MapResult["blind"] = [];
  private readonly misplaced = new Set<FilePath>();
  /** Symbols whose definition did not fit its file: their occurrences elsewhere are `blind`. */
  private readonly lostDefinitions = new Set<string>();
  private repo: RepoView | undefined;
  readonly stats: MapStats = {
    documents: 0,
    foreignDocuments: 0,
    outOfRange: 0,
    malformed: 0,
    unresolvedTargets: 0,
    classifyErrors: 0,
  };

  constructor(private readonly input: MapInput) {
    for (const file of input.files) this.languageOf.set(file.path, file.language);
    this.covered = new Set(input.languages);
    this.lookup = input.lookup;
  }

  async run(): Promise<MapResult> {
    this.loadDocuments();
    this.collectDefinitions();
    for (const view of this.docs) await this.mapDocument(view);
    this.mapImplementations();
    const refs = [...this.refs.values()].sort(compareRefs);
    return {
      refs,
      blind: this.blind,
      misplaced: [...this.misplaced].sort(),
      described: this.describedFiles(),
      uncovered: this.uncoveredFiles(),
      stats: this.stats,
    };
  }

  /**
   * Key of a symbol in the definition tables. `local N` symbols are only unique within their document, so
   * they are keyed by document; every other symbol is global, compared without its package version (the
   * indexes of several Go modules name each other's packages with different versions).
   */
  private key(view: DocumentView, symbol: string): string {
    return isLocalSymbol(symbol) ? `${view.path}\0${symbol}` : this.canonical(symbol);
  }

  private canonical(symbol: string): string {
    let key = this.canonicalKeys.get(symbol);
    if (key === undefined) {
      key = withoutVersion(symbol);
      this.canonicalKeys.set(symbol, key);
    }
    return key;
  }

  // ── documents ──────────────────────────────────────────────────────────────────────────────────

  private loadDocuments(): void {
    for (const source of this.input.sources) {
      for (const info of source.index.externalSymbols) {
        if (info.kind !== 0) this.kinds.set(this.canonical(info.symbol), info.kind);
      }
      for (const doc of source.index.documents) {
        const path = documentPath(source.pathPrefix, doc.relativePath);
        const text =
          path === undefined || !this.languageOf.has(path) ? undefined : this.input.readText(path);
        if (path === undefined || text === undefined) {
          this.stats.foreignDocuments++;
          continue;
        }
        this.stats.documents++;
        const view = new DocumentView(
          path,
          doc,
          encodingOf(doc, source),
          splitLines(text),
          source.excludesBom,
        );
        this.docs.push(view);
        for (const info of doc.symbols) {
          if (info.kind !== 0) this.kinds.set(this.key(view, info.symbol), info.kind);
        }
      }
    }
  }

  private collectDefinitions(): void {
    for (const view of this.docs) {
      for (const occ of view.doc.occurrences) {
        if ((occ.symbolRoles & SymbolRole.Definition) === 0 || occ.symbol === "") continue;
        const range = parseScipRange(occ.range);
        const span = range && view.span(range);
        if (!span) {
          if (range) this.stats.outOfRange++;
          else this.stats.malformed++;
          this.misplaced.add(view.path);
          this.lostDefinitions.add(this.key(view, occ.symbol));
          continue;
        }
        const definition: Definition = {
          file: view.path,
          span,
          text: view.text(span),
          empty: range.startLine === range.endLine && range.startChar === range.endChar,
        };
        const key = this.key(view, occ.symbol);
        const list = this.definitions.get(key);
        if (list) list.push(definition);
        else this.definitions.set(key, [definition]);
      }
    }
    for (const [key, list] of this.definitions) {
      list.sort(compareDefinitions);
      const module = moduleName(key);
      if (!module) continue;
      const entry = { dotted: module.dotted, definition: list[0]! };
      const known = this.modules.get(module.package);
      if (known) known.push(entry);
      else this.modules.set(module.package, [entry]);
    }
  }

  /**
   * scip-python names the module in `from . import cli` as `cli/__init__:` where the module itself is defined as
   * `flask.cli/__init__:`, so the two never match. A module symbol nobody defines is taken to be the module of the
   * same package whose dotted name ends with it, if that is unambiguous (preferring a sibling of the importing file).
   */
  private relativeModule(view: DocumentView, symbol: string): Resolved | null {
    const module = moduleName(symbol);
    if (!module) return null;
    const candidates = (this.modules.get(module.package) ?? []).filter(
      (m) => m.dotted === module.dotted || m.dotted.endsWith(`.${module.dotted}`),
    );
    const siblings = candidates.filter((m) => dirOf(m.definition.file) === dirOf(view.path));
    const chosen =
      candidates.length === 1 ? candidates[0] : siblings.length === 1 ? siblings[0] : undefined;
    if (!chosen) return null;
    const file = chosen.definition.file;
    return {
      id: moduleScopeId(file),
      definition: chosen.definition,
      typeLike: false,
      moduleLike: true,
      moduleFiles: [file],
    };
  }

  /** Files of the covered languages that a SCIP document described. */
  private describedFiles(): FilePath[] {
    const described = new Set<FilePath>();
    for (const view of this.docs) {
      if (this.covered.has(this.languageOf.get(view.path)!)) described.add(view.path);
    }
    return [...described].sort();
  }

  /** Files of the covered languages that no SCIP document described. */
  private uncoveredFiles(): FilePath[] {
    const described = new Set<FilePath>(this.docs.map((d) => d.path));
    const out: FilePath[] = [];
    for (const [path, language] of this.languageOf) {
      if (this.covered.has(language) && !described.has(path)) out.push(path);
    }
    return out.sort();
  }

  // ── targets ────────────────────────────────────────────────────────────────────────────────────

  /**
   * The symbol of ours that a SCIP symbol denotes, from the position of its definition:
   *
   *  1. module/package symbols (and zero-width, whole-file definitions): the module scope of the first file
   *     that defines them (Go packages span several files; the alphabetically first one stands for them);
   *  2. the innermost symbol at the definition, if the definition identifier is that symbol's name;
   *  3. else the symbol at the path the SCIP descriptors spell (`Runner#run().` -> `Runner.run`), which
   *     finds TypeScript overload signatures whose implementation is the symbol we indexed;
   *  4. else none: the definition is nested in something we do not model as a symbol (a parameter, a local
   *     variable, a Python instance attribute).
   *
   * `local` symbols go through the same steps: a function declared inside a function is local to SCIP but a
   * symbol of ours (`outer.inner`), and calls to it are references we want.
   *
   * A constructor (`Queue#<constructor>().`) stands for its class, as `new Queue()` does in the heuristic
   * resolver.
   */
  private resolveDefinition(key: string, symbol: string): Resolved | null {
    const memo = this.resolved.get(key);
    if (memo !== undefined) return memo;
    const result = this.computeDefinition(key, symbol);
    this.resolved.set(key, result);
    return result;
  }

  private computeDefinition(key: string, symbol: string): Resolved | null {
    const definitions = this.definitions.get(key) ?? this.definitions.get(alternateKey(key) ?? "");
    if (!definitions || definitions.length === 0) return null;
    const parsed = parseScipSymbol(symbol);
    const typeLike =
      (parsed !== undefined && isTypeSymbol(parsed)) || TYPE_KINDS.has(this.kinds.get(key) ?? 0);
    const first = definitions[0]!;

    if ((parsed !== undefined && isModuleSymbol(parsed)) || definitions.every((d) => d.empty)) {
      return {
        id: moduleScopeId(first.file),
        definition: first,
        typeLike: false,
        moduleLike: true,
        moduleFiles: [...new Set(definitions.map((d) => d.file))],
      };
    }

    const path = parsed ? symbolPath(parsed) : undefined;
    // several definitions of one symbol (scip-python gives a nested `def parse` inside `Parser.parse_tuple` the
    // symbol of the method `Parser.parse`): the one at the path the symbol spells, else the first
    let named: { entry: SymbolEntry; definition: Definition } | undefined;
    for (const definition of definitions) {
      const entry = this.namedEntry(definition);
      if (!entry || this.firstNaming().get(entry.symbol.id) !== definition) continue;
      if (path !== undefined && entry.basePath === path) {
        named = { entry, definition };
        break;
      }
      named ??= { entry, definition };
    }
    if (named) return this.target(parsed, named.entry, named.definition, typeLike);

    if (path !== undefined) {
      for (const definition of definitions) {
        const found = this.lookup.entry(`${definition.file}#${path}`);
        if (found && !found.anchorOnly) return this.target(parsed, found, definition, typeLike);
      }
    }
    return null;
  }

  /**
   * A Python call `x.Name(...)` whose target is named otherwise. scip-python 0.6.6 sends names that a package
   * re-exports through `from .x import *` / `__all__` to a wrong sibling (django: every `models.AutoField(` to
   * `DateTimeField`), so such a site is left to the heuristic resolver. Bare names are not checked: an alias
   * (`from x import A as B; B()`) or `cls()` is spelled otherwise on purpose.
   */
  private misnamed(view: DocumentView, span: Span, target: Resolved): boolean {
    if (target.moduleLike || this.languageOf.get(view.path) !== "python") return false;
    const line = view.lines[span.startLine - 1];
    if (line === undefined || span.startLine !== span.endLine || line[span.startCol - 2] !== ".")
      return false;
    const text = view.text(span);
    const symbol = this.lookup.get(target.id);
    if (!symbol || text === undefined || !/^\w+$/.test(text)) return false;
    return text !== lastSegment(symbol.path).replace(/~\d+$/, "");
  }

  /**
   * Of a symbol defined several times (scip-python: a nested `def parse` in `Parser.parse_tuple` has the symbol
   * of the method `Parser.parse`), the definition nested in a function around the occurrence, if there is one:
   * `parse()` inside `parse_tuple` calls the nested one. Elsewhere `resolveDefinition` decides.
   */
  private nearestDefinition(key: string, file: FilePath, at: Span, target: Resolved): Resolved {
    const definitions = this.definitions.get(key);
    if (!definitions || definitions.length < 2) return target;
    let best: { entry: SymbolEntry; parent: SymbolEntry; definition: Definition } | undefined;
    for (const definition of definitions) {
      if (definition.file !== file) continue;
      const entry = this.namedEntry(definition);
      const parent = entry?.symbol.parent ? this.lookup.entry(entry.symbol.parent) : undefined;
      if (
        !entry ||
        !parent ||
        (parent.symbol.kind !== "function" && parent.symbol.kind !== "method")
      )
        continue;
      if (!spanContains(parent.span, at.startLine, at.startCol)) continue;
      // the innermost function around the occurrence that has such a definition
      if (!best || spanContains(best.parent.span, parent.span.startLine, parent.span.startCol))
        best = { entry, parent, definition };
    }
    if (!best || best.entry.symbol.id === target.id) return target;
    return { ...target, id: best.entry.symbol.id, definition: best.definition };
  }

  /** The innermost symbol at a definition, when the definition's identifier is that symbol's name. */
  private namedEntry(definition: Definition): SymbolEntry | undefined {
    const entry = this.lookup.innermostEntry(
      definition.file,
      definition.span.startLine,
      definition.span.startCol,
    );
    return entry && !entry.anchorOnly && namesSymbol(entry, definition.text) ? entry : undefined;
  }

  private firstNamings: Map<SymbolId, Definition> | undefined;

  /**
   * Per symbol, the first definition that names it. A symbol's own name comes before anything declared in its
   * body, and something declared there can have the same name: a Go function `ExprCall` with a local
   * `interface { ExprCall() }`, a Python parameter named like its function. Those are not the symbol (a call of
   * the local interface's method is no recursion).
   */
  private firstNaming(): Map<SymbolId, Definition> {
    if (this.firstNamings) return this.firstNamings;
    const first = new Map<SymbolId, Definition>();
    for (const list of this.definitions.values()) {
      for (const definition of list) {
        const entry = this.namedEntry(definition);
        if (!entry) continue;
        const known = first.get(entry.symbol.id);
        if (!known || compareDefinitions(definition, known) < 0)
          first.set(entry.symbol.id, definition);
      }
    }
    this.firstNamings = first;
    return first;
  }

  private target(
    parsed: ReturnType<typeof parseScipSymbol>,
    entry: SymbolEntry,
    definition: Definition,
    typeLike: boolean,
  ): Resolved {
    let id = entry.symbol.id;
    const parent = entry.symbol.parent;
    if (parsed && isConstructorSymbol(parsed) && parent !== undefined && this.lookup.get(parent)) {
      id = parent; // `new Queue()` calls the class
    }
    return { id, definition, typeLike, moduleLike: false, moduleFiles: [] };
  }

  // ── occurrences ────────────────────────────────────────────────────────────────────────────────

  private add(ref: Reference): void {
    const key = `${ref.from}\0${ref.to}\0${ref.kind}\0${ref.site.startLine}:${ref.site.startCol}-${ref.site.endLine}:${ref.site.endCol}`;
    if (!this.refs.has(key)) this.refs.set(key, ref);
  }

  /**
   * The text of a quoted module specifier without its quotes: `"./x"` -> `./x`. Go import paths are
   * reported without the quotes, so a span *inside* quotes counts too. Undefined for anything else.
   */
  private quotedText(view: DocumentView, span: Span): string | undefined {
    if (span.startLine !== span.endLine) return undefined;
    const line = view.lines[span.startLine - 1];
    if (line === undefined) return undefined;
    const text = line.slice(span.startCol - 1, span.endCol);
    if (text.length >= 2 && QUOTES.has(text[0]!) && text[text.length - 1] === text[0]) {
      return text.slice(1, -1);
    }
    const before = line[span.startCol - 2];
    return before !== undefined && QUOTES.has(before) && line[span.endCol] === before
      ? text
      : undefined;
  }

  private repoView(): RepoView {
    this.repo ??= new MapRepoView(
      this.input.root,
      this.input.files.map((f) => f.path),
      (path) => this.input.readText(path),
    );
    return this.repo;
  }

  private async mapDocument(view: DocumentView): Promise<void> {
    if (!this.covered.has(this.languageOf.get(view.path)!)) return;

    interface Candidate {
      span: Span;
      from: SymbolId;
      target: Resolved;
      roles: number;
    }
    const candidates: Candidate[] = [];
    for (const occ of view.doc.occurrences) {
      if (occ.symbol === "" || (occ.symbolRoles & SymbolRole.Definition) !== 0) continue;
      const key = this.key(view, occ.symbol);
      let target =
        this.resolveDefinition(key, occ.symbol) ??
        (this.definitions.has(key) ? null : this.relativeModule(view, occ.symbol));
      if (!target) {
        if (this.definitions.has(key)) this.stats.unresolvedTargets++;
        else if (isLocalSymbol(occ.symbol) || this.lostDefinitions.has(key)) {
          const range = parseScipRange(occ.range);
          const span = range && view.span(range);
          // a member (`ns.f`): a local with no definition that is a plain name is a keyword argument or the like
          const member = span && view.lines[span.startLine - 1]?.[span.startCol - 2] === ".";
          if (span && (member || this.lostDefinitions.has(key)))
            this.blind.push({ file: view.path, line: span.startLine, col: span.startCol });
        }
        continue;
      }
      const range = parseScipRange(occ.range);
      if (!range) {
        this.stats.malformed++;
        this.misplaced.add(view.path);
        continue;
      }
      const span = view.span(range);
      if (!span) {
        this.stats.outOfRange++;
        this.misplaced.add(view.path);
        continue;
      }
      if (target) target = this.nearestDefinition(key, view.path, span, target);
      const from = this.lookup.fromId(view.path, span.startLine, span.startCol);
      // an occurrence of a symbol inside itself: only a call counts (recursion), decided once it is classified
      candidates.push({ span, from, target, roles: occ.symbolRoles });
    }
    if (candidates.length === 0) return;

    // The pack classifies each occurrence. For references to modules it also picks the file that stands for
    // the module (its own import resolution, e.g. Go's `queue/queue.go` before `queue/deadletter.go`), and
    // we need the enclosing top-level statement.
    let classified: Awaited<ReturnType<Mapper["classify"]>>;
    try {
      classified = await this.classify(view, candidates);
    } catch (error) {
      // One file the pack cannot handle must not cost the language its precise references.
      const message = error instanceof Error ? error.message : String(error);
      this.input.warn(
        `${view.path}: sites could not be classified (${message}); using fallback kinds`,
      );
      classified = undefined;
    }

    // Imports of a whole module (`import * as ns from "./x"`, `import "./x"`, `export * from "./x"`, Go
    // package imports) have no binding to classify; the quoted module specifier stands for them. They are
    // redundant when the same statement imports names: those are references to the names themselves.
    interface Pending {
      ref: Reference;
      statement: Span | undefined;
      bare: boolean;
    }
    const pending: Pending[] = [];
    candidates.forEach((c, i) => {
      let kind: Reference["kind"];
      let site: Span;
      let bare = false;
      const info = classified?.[i];
      let cls = info?.site;
      if (cls?.kind === "read") {
        // A plain read is a reference only to a variable (a field, a constant): a function passed as a value or
        // a class used as a namespace is not one, and falls through to the rules below like any unclassified
        // occurrence. The indexers do not tell reads from writes (scip-typescript sets no role, the others say
        // "read" for everything), the pack's syntax does; a WriteAccess role, when there is one, wins.
        const target = this.lookup.get(c.target.id);
        const callable =
          (target?.kind === "function" || target?.kind === "method") &&
          (c.roles & SymbolRole.Import) === 0;
        if (
          (target?.kind !== "variable" && !callable) ||
          (target && cls.bare && this.isMember(target))
        )
          cls = undefined;
        else if (callable)
          cls = { kind: "call", site: cls.site }; // a function used as a value runs when called
        else if ((c.roles & SymbolRole.WriteAccess) !== 0) cls = { kind: "write", site: cls.site };
      }
      if (cls) {
        kind = cls.kind;
        site = cls.site;
        // The quoted module of a type-only import (`import type * as ns from "./x"`) is a module reference like
        // any other: redundant when the statement names what it imports.
        bare = kind === "type-ref" && c.target.moduleLike && info?.specifier !== undefined;
      } else if (c.target.moduleLike && info?.specifier !== undefined) {
        kind = "import";
        site = c.span;
        bare = true;
      } else if ((c.roles & SymbolRole.Import) !== 0) {
        kind = "import";
        site = c.span;
      } else if ((c.roles & SymbolRole.WriteAccess) !== 0) {
        kind = "write";
        site = c.span;
      } else if (c.target.typeLike) {
        kind = "type-ref";
        site = c.span;
      } else {
        return;
      }
      if (kind === "call" && this.misnamed(view, c.span, c.target)) {
        this.blind.push({ file: view.path, line: c.span.startLine, col: c.span.startCol });
        return;
      }
      const moduleFile = info?.moduleFile;
      pending.push({
        ref: {
          from: c.from,
          to: moduleFile !== undefined ? moduleScopeId(moduleFile) : c.target.id,
          kind,
          site: {
            startLine: site.startLine,
            endLine: site.endLine,
            startCol: site.startCol,
            endCol: site.endCol,
          },
          resolution: "precise",
        },
        statement: bare ? info?.statement : undefined,
        bare,
      });
    });
    // What a statement names: import specifiers, type-only ones (`type-ref`) included. A type reference cannot
    // lie inside an import statement otherwise.
    const named = pending.filter(
      (p) => (p.ref.kind === "import" || p.ref.kind === "type-ref") && !p.ref.to.endsWith("#"),
    );
    for (const { ref, statement, bare } of pending) {
      if (bare && statement) {
        const namesImports = named.some(
          (n) =>
            n.ref.from === ref.from &&
            spanContains(statement, n.ref.site.startLine, n.ref.site.startCol ?? 1),
        );
        if (namesImports) continue;
      }
      if (ref.from !== ref.to || ref.kind === "call") this.add(ref);
    }
  }

  /** Is this symbol a member of a class, interface, type or enum (a field, a property)? */
  private isMember(symbol: IndexedSymbol): boolean {
    const parent = symbol.parent === undefined ? undefined : this.lookup.get(symbol.parent);
    return (
      parent !== undefined &&
      (parent.kind === "class" ||
        parent.kind === "interface" ||
        parent.kind === "type" ||
        parent.kind === "enum")
    );
  }

  /** Ask the language pack about every candidate (kind and site, and for modules the file and statement). */
  private classify(view: DocumentView, candidates: readonly { span: Span; target: Resolved }[]) {
    return this.input.withFile(view.path, (ctx, pack) =>
      candidates.map((c) => {
        let site: ReturnType<typeof pack.classifySite>;
        try {
          site = pack.classifySite(ctx, c.span.startLine, c.span.startCol);
        } catch {
          this.stats.classifyErrors++;
          site = undefined;
        }
        if (!c.target.moduleLike) return { site };
        const specifier = this.quotedText(view, c.span);
        const moduleFile =
          specifier === undefined
            ? undefined
            : pack
                .resolveModule(specifier, view.path, this.repoView())
                .find((f) => c.target.moduleFiles.includes(f));
        return { site, specifier, moduleFile, statement: topLevelSpan(ctx, c.span) };
      }),
    );
  }

  // ── relationships ──────────────────────────────────────────────────────────────────────────────

  /**
   * `is_implementation` relationships: `X` implements `Y`. Skipped when an occurrence already produced an
   * `extends`/`implements` reference between the two, and for members whose owners are related by `extends`
   * (an override is not an implementation).
   */
  private mapImplementations(): void {
    const heritage = new Set<string>();
    const extendsPairs = new Set<string>();
    for (const ref of this.refs.values()) {
      if (ref.kind === "extends" || ref.kind === "implements")
        heritage.add(`${ref.from}\0${ref.to}`);
      if (ref.kind === "extends") extendsPairs.add(`${ref.from}\0${ref.to}`);
    }
    for (const view of this.docs) {
      if (!this.covered.has(this.languageOf.get(view.path)!)) continue;
      for (const info of view.doc.symbols) {
        if (!info.relationships.some((r) => r.isImplementation)) continue;
        if (isLocalSymbol(info.symbol)) continue;
        const implementer = this.resolveDefinition(this.canonical(info.symbol), info.symbol);
        if (!implementer) continue;
        for (const rel of info.relationships) {
          if (!rel.isImplementation || isLocalSymbol(rel.symbol)) continue;
          const target = this.resolveDefinition(this.canonical(rel.symbol), rel.symbol);
          if (!target || target.id === implementer.id) continue;
          if (heritage.has(`${implementer.id}\0${target.id}`)) continue;
          if (this.isOverride(implementer.id, target.id, extendsPairs)) continue;
          const site = implementer.definition.span;
          this.add({
            from: implementer.id,
            to: target.id,
            kind: "implements",
            site: {
              startLine: site.startLine,
              endLine: site.endLine,
              startCol: site.startCol,
              endCol: site.endCol,
            },
            resolution: "precise",
          });
        }
      }
    }
  }

  private isOverride(from: SymbolId, to: SymbolId, extendsPairs: ReadonlySet<string>): boolean {
    const fromParent = this.lookup.get(from)?.parent;
    const toParent = this.lookup.get(to)?.parent;
    return (
      fromParent !== undefined &&
      toParent !== undefined &&
      extendsPairs.has(`${fromParent}\0${toParent}`)
    );
  }
}

/** Map decoded SCIP indexes to precise references. See the file comment. */
export function mapScip(input: MapInput): Promise<MapResult> {
  return new Mapper(input).run();
}
