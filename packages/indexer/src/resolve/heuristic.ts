/**
 * The heuristic reference resolver (ARCHITECTURE.md §3, "Heuristic resolution").
 *
 * Language-agnostic: it consumes the facts the language packs extracted (sites, import bindings, type
 * facts, exports) plus the built symbols, and turns every syntactic site into a `Reference` when it can
 * find the target. Sites it cannot resolve are dropped. Every reference has `resolution: "heuristic"`;
 * self-references (`from === to`) are dropped, except a call: recursion (`fact(n - 1)` in `fact`) is a `call`.
 *
 * What is resolved, in order, for a site `qualifier.name`:
 *
 * 1. no qualifier: the lexical scope chain (nested functions, namespaces), then top-level symbols of the
 *    file, then import bindings (via `LanguagePack.resolveModule`, following re-exports), then
 *    `from x import *`-style star exports, then - for `packageScope: "directory"` languages (Go) - top-level
 *    symbols of the other files of the same directory. A name the pack marks `local` (a local, a parameter
 *    or a nested function binds it around the site) only resolves through the scope chain: a callback
 *    parameter `fact` is not the module's `fact`;
 * 2. qualifier `this` (`self`/receiver): a member of the enclosing class, then of its base classes;
 *    `this.f.m()`: the declared type of field `f` (field facts, constructor parameter properties), then
 *    a member of that type; `super.m()`: a member of the base class;
 * 3. qualifier root that is a local or parameter: its declared type (type facts) or, for `const w =
 *    this.pool.lease()`, the declared return type of the callee (`Promise<T>` already unwrapped);
 * 4. qualifier root that is a class, namespace or imported module: static members (`Class.m()`,
 *    `ns.f()`, `mod.Type`); qualified type names resolve through imports; a module-level variable of
 *    another file (`import { bus }`, `pkg.Default`, a package variable of a sibling Go file) has the type
 *    the facts of its own file give it (`bus = new EventBus()`);
 * 5. last resort, only when the receiver's type is completely unknown: a class named like the qualifier
 *    (case-insensitive) that has the member (`queue.pop()` -> `Queue.pop`), preferring the same file, then
 *    a class the file imports, then the same directory (for Go, the same package comes before the imports);
 *    ambiguity drops the site. Calls and writes only.
 *
 * A `read` site resolves the same way (1-4) but only to variables: package-level variables and constants,
 * fields and properties. `import type` / `TYPE_CHECKING` bindings (`ImportBinding.typeOnly`) are `type-ref`
 * references instead of `import`s.
 *
 * Receivers whose type is known but not part of the repository (`Map`, `Array`, `Promise`, a bare npm
 * import) are "opaque": nothing is guessed for them.
 *
 * Not handled: overload resolution, generics/type arguments, union types, control-flow narrowing,
 * reassigned locals with different types, dynamic access, tsconfig path aliases, CommonJS
 * `module.exports` shapes.
 */
import type { FileLanguage, FilePath, IndexedSymbol, Reference, SymbolId } from "@xpl/core";
import type {
  ExportFact,
  ImportBinding,
  LanguagePack,
  RepoView,
  SiteDraft,
  Span,
  TypeFact,
} from "../languages/types.js";
import { spanContains } from "../ast.js";
import { moduleScopeId } from "../symbols.js";
import type { SymbolEntry, SymbolLookup } from "../symbols.js";

/** One file's facts, as the framework hands them to the resolver. */
export interface ResolverFile {
  path: FilePath;
  language: FileLanguage;
  pack: LanguagePack;
  sites: readonly SiteDraft[];
  imports: readonly ImportBinding[];
  typeFacts: readonly TypeFact[];
  exports: readonly ExportFact[];
  /** `FileFacts.data`: for `LanguagePack.inferRefs`, ignored by the resolver. */
  data?: unknown;
}

export interface ResolverInput {
  files: readonly ResolverFile[];
  /** Every symbol of every file, in source order per file. */
  entries: readonly SymbolEntry[];
  /** Innermost-symbol lookup over the same symbols. */
  lookup: SymbolLookup;
  repo: RepoView;
  /** Diagnostics: called whenever the last-resort name-based match (`queue.pop()` -> `Queue.pop`) decides. */
  onNameMatch?: (event: {
    file: FilePath;
    receiver: string;
    member: string;
    target: IndexedSymbol;
  }) => void;
}

// ─── Values ───────────────────────────────────────────────────────────────────────────────────────

/** A name that resolved to something. */
type Entity =
  | { k: "sym"; sym: IndexedSymbol }
  | { k: "module"; files: readonly FilePath[] }
  /** A module that resolves to repository files but does not (visibly) define the imported name. */
  | { k: "missing"; files: readonly FilePath[] }
  /** Known to exist outside the repository (bare import, unknown type name). */
  | { k: "opaque" };

/** What an expression evaluates to, as far as member lookups are concerned. */
type Value =
  /** `next`: for `super()` of a class with several bases, the other bases in order (Python's mixins). */
  | { k: "type"; sym: IndexedSymbol; next?: readonly IndexedSymbol[] }
  | { k: "module"; files: readonly FilePath[] }
  | { k: "opaque" }
  | { k: "unknown" };

const OPAQUE: Value = { k: "opaque" };
const UNKNOWN: Value = { k: "unknown" };

type Want = (symbol: IndexedSymbol) => boolean;

/** Receivers that are the language's own types or globals (by pack id): never guessed as a class of the repository. */
const BUILTIN_RECEIVERS: Record<string, ReadonlySet<string>> = {
  python: new Set(
    "object type super int float complex bool str bytes bytearray list tuple dict set frozenset range slice memoryview property classmethod staticmethod Exception BaseException".split(
      " ",
    ),
  ),
  typescript: new Set(
    "Object Array Promise Math JSON Number String Boolean Symbol BigInt Reflect Proxy Date RegExp Error Map Set WeakMap WeakSet Intl console globalThis window document".split(
      " ",
    ),
  ),
};

const isTypeLike = (s: IndexedSymbol): boolean =>
  s.kind === "class" ||
  s.kind === "interface" ||
  s.kind === "type" ||
  s.kind === "enum" ||
  s.kind === "other";

const WANT: Record<"any" | "call" | "type" | "write" | "read", Want> = {
  any: () => true,
  call: (s) => s.kind !== "interface" && s.kind !== "type" && s.kind !== "key",
  type: isTypeLike,
  write: (s) =>
    s.kind !== "class" &&
    s.kind !== "interface" &&
    s.kind !== "type" &&
    s.kind !== "enum" &&
    s.kind !== "key",
  // Only variables and fields are read: a function used as a value is not a read of it, a class is not either.
  read: (s) => s.kind === "variable",
};

/** Safety bound for chained evaluations (facts are memoised and cycle-safe, so this is rarely reached). */
const MAX_EVAL_DEPTH = 64;
const MAX_BASE_DEPTH = 6;

/** Where a site is: the file, its language pack, the enclosing symbol and that symbol's pack-space path. */
interface Ctx {
  file: FilePath;
  pack: LanguagePack;
  from: IndexedSymbol | undefined;
  /** Pack-space (pre-dedup) path of the enclosing symbol; "" at module level. */
  scope: string;
  /** 1-based position of the site (undefined when evaluating a module-level declaration). */
  line?: number;
  col?: number;
}

interface FileIndex {
  file: ResolverFile;
  dir: string;
  /** Symbols by pack-space path, in source order (duplicates share a key). */
  symbols: Map<string, IndexedSymbol[]>;
  bindings: Map<string, ImportBinding[]>;
  exportsByName: Map<string, ExportFact[]>;
  stars: ExportFact[];
  fields: Map<string, TypeFact[]>;
  vars: Map<string, TypeFact[]>;
  returns: Map<string, TypeFact[]>;
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function lastSegment(path: string): string {
  const i = path.lastIndexOf(".");
  return i < 0 ? path : path.slice(i + 1);
}

function parentPathOf(path: string): string {
  const i = path.lastIndexOf(".");
  return i < 0 ? "" : path.slice(0, i);
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

class Resolver {
  private readonly files = new Map<FilePath, FileIndex>();
  private readonly byDir = new Map<string, FileIndex[]>();
  private readonly classesByLowerName = new Map<string, IndexedSymbol[]>();
  private readonly ownersOfMembers = new Set<SymbolId>();
  private readonly baseSites = new Map<SymbolId, { ctx: Ctx; site: SiteDraft }[]>();
  private readonly basesCache = new Map<SymbolId, readonly IndexedSymbol[]>();
  private readonly moduleCache = new Map<string, readonly FilePath[]>();
  private readonly entityCache = new Map<string, Entity | null>();
  private readonly chainCache = new Map<string, readonly string[]>();
  private readonly factCache = new Map<TypeFact, Value>();
  private readonly varChainCache = new Map<
    string,
    readonly { facts: TypeFact[]; scope: string }[]
  >();
  private readonly factIds = new Map<TypeFact, number>();
  private readonly receiverCache = new Map<string, Value>();
  private readonly refs: Reference[] = [];
  private readonly seenRefs = new Set<string>();

  constructor(private readonly input: ResolverInput) {
    for (const file of input.files) {
      const index: FileIndex = {
        file,
        dir: dirOf(file.path),
        symbols: new Map(),
        bindings: new Map(),
        exportsByName: new Map(),
        stars: [],
        fields: new Map(),
        vars: new Map(),
        returns: new Map(),
      };
      for (const binding of file.imports) pushTo(index.bindings, binding.localName, binding);
      for (const fact of file.exports) {
        if (fact.name === "*") index.stars.push(fact);
        else pushTo(index.exportsByName, fact.name, fact);
      }
      for (const fact of file.typeFacts) {
        if (fact.kind === "field") pushTo(index.fields, `${fact.scopePath}\0${fact.name}`, fact);
        else if (fact.kind === "return") pushTo(index.returns, fact.scopePath, fact);
        else pushTo(index.vars, `${fact.scopePath}\0${fact.name}`, fact);
      }
      this.files.set(file.path, index);
      pushTo(this.byDir, index.dir, index);
    }
    // the files of a default build first: a package's other variants declare the same names
    for (const list of this.byDir.values()) {
      const off = new Set(list.filter((f) => this.isOffByDefault(f.file)));
      if (off.size > 0) list.sort((a, b) => Number(off.has(a)) - Number(off.has(b)));
    }
    for (const entry of input.entries) {
      if (entry.anchorOnly) continue; // a test block: its title is not a name in the code
      const index = this.files.get(entry.symbol.file);
      if (!index) continue;
      pushTo(index.symbols, entry.basePath, entry.symbol);
      if (entry.symbol.parent) this.ownersOfMembers.add(entry.symbol.parent);
      if (entry.symbol.kind === "class" || entry.symbol.kind === "interface") {
        pushTo(this.classesByLowerName, lastSegment(entry.basePath).toLowerCase(), entry.symbol);
      }
    }
    // `extends` sites, by the class they belong to, for base-class lookups.
    for (const file of input.files) {
      for (const site of file.sites) {
        if (site.kind !== "extends") continue;
        const entry = input.lookup.innermostEntry(
          file.path,
          site.site.startLine,
          site.site.startCol,
        );
        if (!entry) continue;
        pushTo(this.baseSites, entry.symbol.id, {
          ctx: {
            file: file.path,
            pack: file.pack,
            from: entry.symbol,
            scope: entry.basePath,
            line: site.site.startLine,
            col: site.site.startCol,
          },
          site,
        });
      }
    }
  }

  // ── entry point ────────────────────────────────────────────────────────────────────────────────

  run(): Reference[] {
    for (const file of this.input.files) {
      for (const binding of file.imports) this.resolveBinding(file, binding);
      for (const fact of file.exports)
        if (fact.module !== undefined && fact.site) this.resolveReexport(file, fact);
      for (const site of file.sites) this.resolveSite(file, site);
    }
    return this.refs;
  }

  private contextAt(file: ResolverFile, span: Span): Ctx {
    const entry = this.input.lookup.innermostEntry(file.path, span.startLine, span.startCol);
    return {
      file: file.path,
      pack: file.pack,
      from: entry?.symbol,
      scope: entry?.basePath ?? "",
      line: span.startLine,
      col: span.startCol,
    };
  }

  private add(ctx: Ctx, to: SymbolId, kind: Reference["kind"], span: Span): void {
    const from = ctx.from?.id ?? moduleScopeId(ctx.file);
    // a symbol naming itself is no reference, unless it calls itself (recursion)
    if (from === to && kind !== "call") return;
    const key = `${from}\0${to}\0${kind}\0${span.startLine}:${span.startCol}-${span.endLine}:${span.endCol}`;
    if (this.seenRefs.has(key)) return;
    this.seenRefs.add(key);
    this.refs.push({
      from,
      to,
      kind,
      site: {
        startLine: span.startLine,
        endLine: span.endLine,
        startCol: span.startCol,
        endCol: span.endCol,
      },
      resolution: "heuristic",
    });
  }

  // ── imports ────────────────────────────────────────────────────────────────────────────────────

  private resolveBinding(file: ResolverFile, binding: ImportBinding): void {
    const ctx = this.contextAt(file, binding.site);
    const entity = this.bindingEntity(file.path, binding);
    const kind = binding.typeOnly ? "type-ref" : "import";
    if (entity?.k === "sym") this.add(ctx, entity.sym.id, kind, binding.site);
    else if (entity?.k === "module" || entity?.k === "missing") {
      this.add(ctx, moduleScopeId(entity.files[0]!), kind, binding.site);
    }
  }

  private resolveReexport(file: ResolverFile, fact: ExportFact): void {
    const site = fact.site!;
    const ctx = this.contextAt(file, site);
    const files = this.modules(file.path, fact.module!);
    if (files.length === 0) return;
    let entity: Entity | undefined;
    if (fact.name === "*" || fact.importedName === undefined) entity = { k: "module", files };
    else
      entity = this.exported(files, fact.importedName, WANT.any, new Set()) ?? {
        k: "missing",
        files,
      };
    const kind = fact.typeOnly ? "type-ref" : "import";
    if (entity.k === "sym") this.add(ctx, entity.sym.id, kind, site);
    else if (entity.k === "module" || entity.k === "missing")
      this.add(ctx, moduleScopeId(entity.files[0]!), kind, site);
  }

  /** Repository files a module specifier used in `file` may name (cached). */
  private modules(file: FilePath, spec: string): readonly FilePath[] {
    const key = `${file}\0${spec}`;
    let files = this.moduleCache.get(key);
    if (!files) {
      files = this.files.get(file)!.file.pack.resolveModule(spec, file, this.input.repo);
      if (files.length > 1) {
        const off = new Set(files.filter((f) => this.isOffByDefault(this.files.get(f)?.file)));
        if (off.size > 0)
          files = [...files].sort((a, b) => Number(off.has(a)) - Number(off.has(b)));
      }
      this.moduleCache.set(key, files);
    }
    return files;
  }

  private readonly offCache = new Map<FilePath, boolean>();

  /** `LanguagePack.offByDefault`, once per file. */
  private isOffByDefault(file: ResolverFile | undefined): boolean {
    if (!file?.pack.offByDefault) return false;
    let off = this.offCache.get(file.path);
    if (off === undefined) {
      off = file.pack.offByDefault(file.path, this.input.repo);
      this.offCache.set(file.path, off);
    }
    return off;
  }

  /**
   * What a binding names. `visited` and `depth` belong to the lookup this is a step of: bindings and star
   * imports can form cycles (`a` imports `X` from `b`, `b` star-imports `a`), which only the shared `visited`
   * set cuts. A lookup that starts here uses fresh ones.
   */
  private bindingEntity(
    file: FilePath,
    binding: ImportBinding,
    want: Want = WANT.any,
    visited: Set<string> = new Set(),
    depth = 0,
  ): Entity {
    const files = this.modules(file, binding.module);
    if (files.length === 0) return { k: "opaque" };
    if (binding.importedName === undefined) return { k: "module", files };
    const found = this.exported(files, binding.importedName, want, visited, depth);
    if (found) return found;
    // `from pkg import name` can import the submodule `pkg.name` (Python): the pack knows how to spell it.
    const pack = this.files.get(file)!.file.pack;
    const spec = pack.submoduleSpec?.(binding.module, binding.importedName);
    const submodule = spec === undefined ? [] : this.modules(file, spec);
    return submodule.length > 0 ? { k: "module", files: submodule } : { k: "missing", files };
  }

  /**
   * The entity `files` export under `name`: a top-level symbol, an explicit export (`export { a as b }`,
   * `export default a`, re-exports), a re-exported import binding, or a star re-export.
   */
  private exported(
    files: readonly FilePath[],
    name: string,
    want: Want,
    visited: Set<string>,
    depth = 0,
  ): Entity | undefined {
    if (depth > 8) return undefined;
    for (const path of files) {
      const key = `${path}\0${name}`;
      if (visited.has(key)) continue;
      visited.add(key);
      const index = this.files.get(path);
      if (!index) continue;
      const direct = this.pick(index.symbols.get(name), want);
      if (direct) return { k: "sym", sym: direct };
      for (const fact of index.exportsByName.get(name) ?? []) {
        if (fact.module !== undefined) {
          const targets = this.modules(path, fact.module);
          if (targets.length === 0) return { k: "opaque" };
          if (fact.importedName === undefined) return { k: "module", files: targets };
          const found = this.exported(targets, fact.importedName, want, visited, depth + 1);
          if (found) return found;
        } else if (fact.localName !== undefined) {
          const local = this.pick(index.symbols.get(fact.localName), want);
          if (local) return { k: "sym", sym: local };
          for (const binding of index.bindings.get(fact.localName) ?? []) {
            const entity = this.bindingEntity(path, binding, WANT.any, visited, depth + 1);
            if (entity.k !== "missing") return entity;
          }
        }
      }
      // a plain import is not an export in TS or Go (`import { tm }` for the file's own use, while an
      // `export *` provides another `tm`); in Python it is
      for (const binding of index.file.pack.importsReexport
        ? (index.bindings.get(name) ?? [])
        : []) {
        const entity = this.bindingEntity(path, binding, WANT.any, visited, depth + 1);
        if (entity.k !== "missing") return entity;
      }
      for (const star of index.stars) {
        const targets = this.modules(path, star.module!);
        const found = this.exported(targets, name, want, visited, depth + 1);
        if (found) return found;
      }
    }
    return undefined;
  }

  private pick(list: readonly IndexedSymbol[] | undefined, want: Want): IndexedSymbol | undefined {
    if (!list) return undefined;
    for (const symbol of list) if (want(symbol)) return symbol;
    return undefined;
  }

  // ── names in scope ─────────────────────────────────────────────────────────────────────────────

  /** Enclosing function/namespace scopes of `scope` (pack-space paths), innermost first. */
  private scopeChain(file: FilePath, scope: string): readonly string[] {
    const key = `${file}\0${scope}`;
    let chain = this.chainCache.get(key);
    if (chain) return chain;
    const out: string[] = [];
    const index = this.files.get(file);
    for (let s = scope; s !== ""; s = parentPathOf(s)) {
      const symbol = index?.symbols.get(s)?.[0];
      if (
        symbol &&
        (symbol.kind === "function" || symbol.kind === "method" || symbol.kind === "other")
      )
        out.push(s);
    }
    chain = out;
    this.chainCache.set(key, chain);
    return chain;
  }

  /** A symbol by pack-space path in `file`, or - for directory-scoped languages - in the same package. */
  private lookupPath(file: FilePath, path: string, want: Want): IndexedSymbol | undefined {
    const index = this.files.get(file);
    if (!index) return undefined;
    const own = this.pick(index.symbols.get(path), want);
    if (own || index.file.pack.packageScope !== "directory") return own;
    for (const other of this.byDir.get(index.dir) ?? []) {
      if (other === index) continue;
      const found = this.pick(other.symbols.get(path), want);
      if (found) return found;
    }
    return undefined;
  }

  /** Resolve a bare name as seen from `scope` in `file`. */
  private lexical(
    file: FilePath,
    name: string,
    scope: string,
    want: Want,
    wantKey: string,
  ): Entity | undefined {
    const key = `${file}\0${scope}\0${name}\0${wantKey}`;
    const cached = this.entityCache.get(key);
    if (cached !== undefined) return cached ?? undefined;
    const result = this.lexicalUncached(file, name, scope, want);
    this.entityCache.set(key, result ?? null);
    return result;
  }

  /** A bare name bound locally (`SiteDraft.local`): only a symbol nested in an enclosing function can be meant. */
  private nested(
    file: FilePath,
    name: string,
    scope: string,
    want: Want,
  ): IndexedSymbol | undefined {
    const index = this.files.get(file);
    if (!index) return undefined;
    for (const s of this.scopeChain(file, scope)) {
      const nested = this.pick(index.symbols.get(`${s}.${name}`), want);
      if (nested) return nested;
    }
    return undefined;
  }

  private lexicalUncached(
    file: FilePath,
    name: string,
    scope: string,
    want: Want,
  ): Entity | undefined {
    const index = this.files.get(file);
    if (!index) return undefined;
    const chain = this.scopeChain(file, scope);
    for (const s of chain) {
      const nested = this.pick(index.symbols.get(`${s}.${name}`), want);
      if (nested) return { k: "sym", sym: nested };
    }
    // an import inside an enclosing function (Python: `def templatize(): from .template import templatize`)
    // binds the name there, over the module's own symbol of that name
    for (const binding of index.bindings.get(name) ?? []) {
      const inside = chain.some((s) => {
        const range = index.symbols.get(s)?.[0]?.range;
        return (
          range &&
          binding.site.startLine >= range.startLine &&
          binding.site.startLine <= range.endLine
        );
      });
      if (inside) return this.bindingEntity(file, binding, want);
    }
    const top = this.pick(index.symbols.get(name), want);
    if (top) return { k: "sym", sym: top };
    for (const binding of index.bindings.get(name) ?? [])
      return this.bindingEntity(file, binding, want);
    for (const star of index.stars) {
      const found = this.exported(this.modules(file, star.module!), name, want, new Set());
      if (found) return found;
    }
    if (index.file.pack.packageScope === "directory") {
      for (const other of this.byDir.get(index.dir) ?? []) {
        if (other === index) continue;
        const found = this.pick(other.symbols.get(name), want);
        if (found) return { k: "sym", sym: found };
      }
    }
    return undefined;
  }

  // ── types, members, bases ──────────────────────────────────────────────────────────────────────

  /** Member `name` of an entity: a child symbol, or an export of a module. */
  private memberOf(entity: Entity, name: string, want: Want): Entity | undefined {
    switch (entity.k) {
      case "sym": {
        const member = this.findMember(entity.sym, name, want);
        return member ? { k: "sym", sym: member } : undefined;
      }
      case "module":
        return this.exported(entity.files, name, want, new Set());
      default:
        return { k: "opaque" };
    }
  }

  /** A (possibly dotted) type name as seen from `scope` in `file`. Undefined: not found in the repository. */
  private typeEntity(typeName: string, file: FilePath, scope: string): Entity | undefined {
    const parts = typeName.split(".");
    let entity = this.lexical(file, parts[0]!, scope, WANT.type, "type");
    for (let i = 1; i < parts.length && entity; i++)
      entity = this.memberOf(entity, parts[i]!, WANT.type);
    return entity;
  }

  private entityValue(entity: Entity | undefined, depth = 0): Value {
    if (!entity) return UNKNOWN;
    switch (entity.k) {
      case "sym": {
        const s = entity.sym;
        if (isTypeLike(s)) return { k: "type", sym: s };
        if (s.kind === "variable") {
          // An object literal / namespace-like variable exposes its members.
          if (this.ownersOfMembers.has(s.id)) return { k: "type", sym: s };
          // A module-level variable has the type its own file's facts give it (`bus = EventBus()`), also
          // when another file uses it (`import { bus }`, `pkg.Default`).
          const facts = this.files.get(s.file)?.vars.get(`\0${this.basePath(s)}`);
          if (facts) return this.firstValue(facts.map((f) => this.factValue(f, s.file, depth)));
        }
        return UNKNOWN;
      }
      case "module":
        return { k: "module", files: entity.files };
      default:
        return OPAQUE;
    }
  }

  /** The value of an expression declared with type `typeName` (relative to `file`/`scope`). */
  private typeValue(typeName: string, file: FilePath, scope: string, ctx: Ctx | undefined): Value {
    if (typeName === "this") return ctx ? this.thisValue(ctx) : UNKNOWN;
    const entity = this.typeEntity(typeName, file, scope);
    if (!entity) return OPAQUE; // named, but not in the repository: known, external
    const value = this.entityValue(entity);
    return value.k === "unknown" ? OPAQUE : value;
  }

  /** Immediate base classes / interfaces of a class-like symbol (cached). */
  private bases(sym: IndexedSymbol): readonly IndexedSymbol[] {
    const cached = this.basesCache.get(sym.id);
    if (cached) return cached;
    this.basesCache.set(sym.id, []); // cycle guard
    const out: IndexedSymbol[] = [];
    for (const { ctx, site } of this.baseSites.get(sym.id) ?? []) {
      const found = this.resolveName(ctx, site.qualifier, site.name, WANT.type, "type", undefined);
      if (found && found.id !== sym.id && !out.includes(found)) out.push(found);
    }
    this.basesCache.set(sym.id, out);
    return out;
  }

  /** Member `name` of a class-like symbol, searching base classes too. */
  private findMember(
    sym: IndexedSymbol,
    name: string,
    want: Want,
    depth = 0,
    seen = new Set<SymbolId>(),
  ): IndexedSymbol | undefined {
    if (seen.has(sym.id) || depth > MAX_BASE_DEPTH) return undefined;
    seen.add(sym.id);
    const own = this.lookupPath(sym.file, `${this.basePath(sym)}.${name}`, want);
    if (own) return own;
    for (const base of this.bases(sym)) {
      const found = this.findMember(base, name, want, depth + 1, seen);
      if (found) return found;
    }
    return undefined;
  }

  /** Pack-space path of a built symbol (without a `~N` duplicate suffix). */
  private basePath(sym: IndexedSymbol): string {
    return this.input.lookup.entry(sym.id)?.basePath ?? sym.path;
  }

  // ── receivers ──────────────────────────────────────────────────────────────────────────────────

  /** The class-like container of the enclosing method (`this` / `self` / the receiver). */
  private thisValue(ctx: Ctx): Value {
    let scope = ctx.scope;
    if (ctx.from && isTypeLike(ctx.from) && ctx.from.kind !== "other")
      return { k: "type", sym: ctx.from };
    while (scope !== "") {
      scope = parentPathOf(scope);
      if (scope === "") break;
      const symbol = this.lookupPath(ctx.file, scope, WANT.any);
      if (!symbol) continue;
      if (symbol.kind === "function" || symbol.kind === "method") continue;
      return { k: "type", sym: symbol };
    }
    return UNKNOWN;
  }

  private superValue(ctx: Ctx): Value {
    const self = this.thisValue(ctx);
    if (self.k !== "type") return self;
    const [base, ...next] = this.bases(self.sym);
    if (!base) return UNKNOWN;
    return next.length > 0 ? { k: "type", sym: base, next } : { k: "type", sym: base };
  }

  /** Facts about a variable `name` in the scopes enclosing `scope`, innermost scope first (cached). */
  private varChain(
    file: FilePath,
    scope: string,
    name: string,
  ): readonly { facts: TypeFact[]; scope: string }[] {
    const key = `${file}\0${scope}\0${name}`;
    let chain = this.varChainCache.get(key);
    if (chain) return chain;
    const found: { facts: TypeFact[]; scope: string }[] = [];
    const index = this.files.get(file);
    if (index) {
      for (let s = scope; ; s = parentPathOf(s)) {
        const facts = index.vars.get(`${s}\0${name}`);
        if (facts) found.push({ facts, scope: s });
        if (s === "") break;
      }
    }
    chain = found;
    this.varChainCache.set(key, chain);
    return chain;
  }

  /**
   * The facts about the variable `name` that are in scope at the site of `ctx`: those of the innermost
   * scope that has any visible one and, among them, the ones with the narrowest `visibleIn`.
   */
  private varFacts(ctx: Ctx, name: string): { facts: TypeFact[]; scope: string } | undefined {
    for (const { facts, scope } of this.varChain(ctx.file, ctx.scope, name)) {
      const visible =
        ctx.line === undefined || ctx.col === undefined
          ? facts
          : facts.filter((f) => !f.visibleIn || spanContains(f.visibleIn, ctx.line!, ctx.col!));
      if (visible.length === 0) continue;
      if (visible.length === 1) return { facts: visible, scope };
      // Prefer the narrowest region (an inner callback's parameter over the enclosing function's).
      let narrowest: TypeFact[] = [];
      let best = Infinity;
      for (const fact of visible) {
        const size = fact.visibleIn ? fact.visibleIn.endLine - fact.visibleIn.startLine : Infinity;
        if (size < best) {
          best = size;
          narrowest = [fact];
        } else if (size === best) {
          narrowest.push(fact);
        }
      }
      return { facts: narrowest, scope };
    }
    return undefined;
  }

  private factId(fact: TypeFact): number {
    let id = this.factIds.get(fact);
    if (id === undefined) {
      id = this.factIds.size;
      this.factIds.set(fact, id);
    }
    return id;
  }

  /** The context of a declaration: its file and the symbol that owns it. */
  private factCtx(file: FilePath, scope: string): Ctx {
    const index = this.files.get(file)!;
    return {
      file,
      pack: index.file.pack,
      from: scope === "" ? undefined : this.lookupPath(file, scope, WANT.any),
      scope,
    };
  }

  /** `factCtx` positioned where a fact's declaration region starts, so its own receivers resolve in scope. */
  private factCtxFor(fact: TypeFact, file: FilePath): Ctx {
    const ctx = this.factCtx(file, fact.scopePath);
    if (fact.visibleIn) {
      ctx.line = fact.visibleIn.startLine;
      ctx.col = fact.visibleIn.startCol;
    }
    return ctx;
  }

  /** What a type fact says a name holds (memoised per fact; a fact that depends on itself is unknown). */
  private factValue(fact: TypeFact, file: FilePath, depth: number): Value {
    const cached = this.factCache.get(fact);
    if (cached) return cached;
    this.factCache.set(fact, UNKNOWN); // cycle guard
    const ctx = this.factCtxFor(fact, file);
    let value: Value = UNKNOWN;
    if (fact.typeName !== undefined)
      value = this.typeValue(fact.typeName, file, fact.scopePath, ctx);
    else if (fact.initCall)
      value = this.callResult(fact.initCall.qualifier, fact.initCall.name, ctx, depth + 1);
    else if (fact.initChain) value = this.qualifiedValue(fact.initChain, ctx, depth + 1);
    this.factCache.set(fact, value);
    return value;
  }

  /** First resolved value among several facts about the same name (locals shadowed in different blocks). */
  private firstValue(values: Value[]): Value {
    return (
      values.find((v) => v.k === "type" || v.k === "module") ??
      values.find((v) => v.k === "opaque") ??
      UNKNOWN
    );
  }

  /** The value of the receiver expression `qualifier` (see types.ts for the segment syntax). */
  private qualifiedValue(qualifier: readonly string[], ctx: Ctx, depth: number): Value {
    if (qualifier.length === 0 || depth > MAX_EVAL_DEPTH) return UNKNOWN;
    // Receivers repeat a lot (`this.queue`, `e`...); evaluate each once per enclosing scope. A local root
    // is identified by the facts in scope at the site, since two callbacks may declare the same name.
    const root = qualifier[0]!;
    const local =
      /^[A-Za-z_$#@][\w$]*$/.test(root) && root !== "this" && root !== "super"
        ? this.varFacts(ctx, root)
        : undefined;
    const rootKey = local ? `#${local.facts.map((f) => this.factId(f)).join(",")}` : root;
    const key = `${ctx.file}\0${ctx.scope}\0${rootKey}\u0001${qualifier.slice(1).join("\u0001")}`;
    const cached = this.receiverCache.get(key);
    if (cached) return cached;
    let value = this.rootValue(root, ctx, depth);
    for (let i = 1; i < qualifier.length && value.k !== "unknown" && value.k !== "opaque"; i++) {
      value = this.step(value, qualifier[i]!, depth);
    }
    this.receiverCache.set(key, value);
    return value;
  }

  private rootValue(segment: string, ctx: Ctx, depth: number): Value {
    if (segment === "this") return this.thisValue(ctx);
    if (segment === "super") return this.superValue(ctx);
    if (segment.startsWith(":")) return this.typeValue(segment.slice(1), ctx.file, ctx.scope, ctx);
    if (segment.endsWith("()")) return this.callResult([], segment.slice(0, -2), ctx, depth + 1);
    const local = this.varFacts(ctx, segment);
    if (local) return this.firstValue(local.facts.map((f) => this.factValue(f, ctx.file, depth)));
    return this.entityValue(this.lexical(ctx.file, segment, ctx.scope, WANT.any, "any"), depth);
  }

  /** One `.segment` step from a value; a segment ending in `()` is a call. */
  private step(value: Value, segment: string, depth: number): Value {
    const isCall = segment.endsWith("()");
    const name = isCall ? segment.slice(0, -2) : segment;
    if (value.k === "type") {
      const member = this.findMember(value.sym, name, WANT.any);
      if (isCall) return member ? this.returnValue(member, value, depth + 1) : UNKNOWN;
      const field = this.fieldValue(value.sym, name, depth);
      if (field) return field;
      if (member) {
        if (isTypeLike(member)) return { k: "type", sym: member };
        const returned = this.returnValue(member, value, depth + 1); // a getter
        return returned;
      }
      return UNKNOWN;
    }
    if (value.k === "module") {
      const entity = this.exported(value.files, name, WANT.any, new Set());
      if (!entity) return UNKNOWN;
      if (isCall && entity.k === "sym") return this.callableValue(entity.sym, undefined, depth + 1);
      return this.entityValue(entity, depth);
    }
    return value;
  }

  /** The declared type of field `name` of `sym` (or of its base classes), if any fact says so. */
  private fieldValue(
    sym: IndexedSymbol,
    name: string,
    depth: number,
    seen = new Set<SymbolId>(),
    level = 0,
  ): Value | undefined {
    if (seen.has(sym.id) || level > MAX_BASE_DEPTH) return undefined;
    seen.add(sym.id);
    const files = [sym.file];
    const packageWide = this.files.get(sym.file)?.file.pack.packageScope === "directory";
    if (packageWide)
      for (const other of this.byDir.get(this.files.get(sym.file)!.dir) ?? [])
        if (other.file.path !== sym.file) files.push(other.file.path);
    const scope = this.basePath(sym);
    for (const path of files) {
      const facts = this.files.get(path)?.fields.get(`${scope}\0${name}`);
      if (facts) {
        return this.firstValue(facts.map((f) => this.factValue(f, path, depth)));
      }
    }
    for (const base of this.bases(sym)) {
      const found = this.fieldValue(base, name, depth, seen, level + 1);
      if (found) return found;
    }
    return undefined;
  }

  /** The value of calling `symbol`: a class gives an instance, functions/methods give their return type. */
  private callableValue(symbol: IndexedSymbol, receiver: Value | undefined, depth: number): Value {
    if (symbol.kind === "class") return { k: "type", sym: symbol };
    return this.returnValue(symbol, receiver, depth);
  }

  private returnValue(symbol: IndexedSymbol, receiver: Value | undefined, depth: number): Value {
    if (depth > MAX_EVAL_DEPTH) return UNKNOWN;
    if (symbol.kind === "class") return { k: "type", sym: symbol };
    const scope = this.basePath(symbol);
    const facts = this.files.get(symbol.file)?.returns.get(scope);
    if (!facts) return UNKNOWN;
    const values = facts.map((fact) => {
      if (fact.typeName === "this") return receiver ?? UNKNOWN;
      return this.factValue(fact, symbol.file, depth);
    });
    return this.firstValue(values);
  }

  /** The value of the call `qualifier.name(...)` evaluated in `ctx`. */
  private callResult(qualifier: readonly string[], name: string, ctx: Ctx, depth: number): Value {
    if (depth > MAX_EVAL_DEPTH) return UNKNOWN;
    if (qualifier.length === 0) {
      const local = this.varFacts(ctx, name);
      if (local) return OPAQUE; // calling a local callable: its result is not tracked
      const entity = this.lexical(ctx.file, name, ctx.scope, WANT.call, "call");
      if (!entity) return UNKNOWN;
      if (entity.k === "sym") return this.callableValue(entity.sym, undefined, depth + 1);
      return OPAQUE;
    }
    const receiver = this.qualifiedValue(qualifier, ctx, depth + 1);
    if (receiver.k === "type") {
      for (const sym of [receiver.sym, ...(receiver.next ?? [])]) {
        const member = this.findMember(sym, name, WANT.call);
        if (member) return this.callableValue(member, receiver, depth + 1);
      }
      return UNKNOWN;
    }
    if (receiver.k === "module") {
      const entity = this.exported(receiver.files, name, WANT.call, new Set());
      return entity?.k === "sym" ? this.callableValue(entity.sym, undefined, depth + 1) : UNKNOWN;
    }
    return receiver;
  }

  // ── sites ──────────────────────────────────────────────────────────────────────────────────────

  private resolveSite(file: ResolverFile, site: SiteDraft): void {
    const ctx = this.contextAt(file, site.site);
    if (site.kind === "import") {
      const files = this.modules(file.path, site.name);
      if (files.length > 0) this.add(ctx, moduleScopeId(files[0]!), "import", site.site);
      return;
    }
    const wantKey =
      site.kind === "call" || site.kind === "write" || site.kind === "read" ? site.kind : "type";
    const want = WANT[wantKey];
    // The name-based fallback only applies to calls and writes: a qualified type name is not guessed, and
    // neither is the receiver of a read (there are far more of those than of calls, and no member to check).
    const guess =
      site.kind === "call" || site.kind === "write"
        ? site.qualifier[site.qualifier.length - 1]
        : undefined;
    let target =
      site.local && site.qualifier.length === 0
        ? this.nested(file.path, site.name, ctx.scope, want)
        : this.resolveName(ctx, site.qualifier, site.name, want, wantKey, guess);
    if (!target && site.kind === "type-ref" && site.qualifier.length > 0) {
      // `Color.Red` in a type position: enum members are not symbols, the enum is the best target.
      const owner = this.qualifiedValue(site.qualifier, ctx, 0);
      if (owner.k === "type" && owner.sym.kind === "enum") target = owner.sym;
    }
    // Re-export chains look names up without regard to their kind (`from .app import Flask as Flask` finds the
    // class): a read only ever points at a variable.
    if (target && site.kind === "read" && target.kind !== "variable") target = undefined;
    if (target) this.add(ctx, target.id, site.kind, site.site);
  }

  /** The symbol `qualifier.name` refers to at `ctx`, if it can be found. */
  private resolveName(
    ctx: Ctx,
    qualifier: readonly string[],
    name: string,
    want: Want,
    wantKey: string,
    guess: string | undefined,
  ): IndexedSymbol | undefined {
    if (qualifier.length === 0) {
      const entity = this.lexical(ctx.file, name, ctx.scope, want, wantKey);
      if (entity?.k === "sym") return entity.sym;
      if (entity?.k === "module" && wantKey === "call")
        return this.moduleAsCallee(entity.files, name);
      return undefined;
    }
    return this.terminal(this.qualifiedValue(qualifier, ctx, 0), name, want, ctx, guess);
  }

  /**
   * A namespace import used directly as a callee (`const Foo = require("./foo"); new Foo()`): the module's
   * export is most plausibly the symbol named like the binding, or its default export.
   */
  private moduleAsCallee(files: readonly FilePath[], localName: string): IndexedSymbol | undefined {
    for (const name of [localName, "default"]) {
      const entity = this.exported(files, name, WANT.call, new Set());
      if (entity?.k === "sym") return entity.sym;
    }
    return undefined;
  }

  /** Member `name` of a receiver value. `lastSegment` enables the name-based fallback for unknown types. */
  private terminal(
    value: Value,
    name: string,
    want: Want,
    ctx: Ctx,
    lastSegment: string | undefined,
  ): IndexedSymbol | undefined {
    switch (value.k) {
      case "type": {
        for (const sym of [value.sym, ...(value.next ?? [])]) {
          if (want !== WANT.read) {
            const member = this.findMember(sym, name, want);
            if (member) return member;
            continue;
          }
          // The nearest member of that name decides: a property that overrides a base class's attribute
          // (`@property def name` over `name: str`) is not a variable, and the attribute below it is out of reach.
          const member = this.findMember(sym, name, WANT.any);
          if (member) return want(member) ? member : undefined;
        }
        return undefined;
      }
      case "module": {
        const entity = this.exported(value.files, name, want, new Set());
        return entity?.k === "sym" ? entity.sym : undefined;
      }
      case "unknown":
        return lastSegment !== undefined ? this.nameMatch(lastSegment, name, want, ctx) : undefined;
      default:
        return undefined;
    }
  }

  /** `queue.pop()` with an untyped `queue`: the class called `Queue` that has a member `pop`. */
  private nameMatch(
    receiver: string,
    member: string,
    want: Want,
    ctx: Ctx,
  ): IndexedSymbol | undefined {
    if (!/^[A-Za-z_$][\w$]*$/.test(receiver) || receiver === "this" || receiver === "super")
      return undefined;
    const site = this.files.get(ctx.file)!;
    // `object.__new__(cls)`, `tuple.__len__(t)`, `Object.keys(x)`: the language's own types, not a class of ours
    if (BUILTIN_RECEIVERS[site.file.pack.id]?.has(receiver)) return undefined;
    const classes = this.classesByLowerName.get(receiver.toLowerCase());
    if (!classes) return undefined;
    const found: { cls: IndexedSymbol; member: IndexedSymbol; rank: number }[] = [];
    for (const cls of classes) {
      if (this.files.get(cls.file)?.file.pack !== site.file.pack) continue; // another language
      const target = this.findMember(cls, member, want);
      if (!target) continue;
      found.push({ cls, member: target, rank: this.rank(cls, ctx) });
    }
    if (found.length === 0) return undefined;
    const best = Math.min(...found.map((f) => f.rank));
    const top = found.filter((f) => f.rank === best);
    if (top.length !== 1) return undefined;
    this.input.onNameMatch?.({ file: ctx.file, receiver, member, target: top[0]!.member });
    return top[0]!.member;
  }

  /**
   * Closeness of a candidate class to the site: same file, imported by the file, same directory, elsewhere. For
   * a language whose package is the directory (Go), the same directory is the file's own package: it comes
   * before what the file imports.
   */
  private rank(cls: IndexedSymbol, ctx: Ctx): number {
    if (cls.file === ctx.file) return 0;
    const index = this.files.get(ctx.file)!;
    const sameDir = dirOf(cls.file) === index.dir;
    const packageDir = index.file.pack.packageScope === "directory";
    if (sameDir && packageDir) return 1;
    for (const bindings of index.bindings.values()) {
      for (const binding of bindings)
        if (this.modules(ctx.file, binding.module).includes(cls.file)) return packageDir ? 2 : 1;
    }
    return sameDir ? 2 : 3;
  }
}

/** Resolve every site of `input.files` with the heuristics described at the top of this file. */
export function resolveHeuristic(input: ResolverInput): Reference[] {
  return new Resolver(input).run();
}
