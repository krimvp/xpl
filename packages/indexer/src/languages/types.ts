/**
 * The language-pack interface (ARCHITECTURE.md §3).
 *
 * A pack turns one parsed file into plain facts. It never assigns symbol ids, `~2` duplicate suffixes,
 * hashes or parents, and it never resolves anything: the framework (src/build.ts, src/symbols.ts) does
 * that, and the language-agnostic heuristic resolver (src/resolve/heuristic.ts) consumes the facts of all
 * files to produce `Reference`s. Every top-level symbol counts as exported (importable by its path).
 *
 * Conventions every pack follows:
 *
 * - All positions are `Span`s: 1-based, inclusive lines AND columns, columns counted in UTF-16 code units
 *   (JS string indices). Build them with `nodeSpan` / `spanBetween` from `../ast.js`; they turn
 *   tree-sitter's 0-based, end-exclusive points into this convention.
 * - Paths (`SymbolDraft.path`, `TypeFact.scopePath`, ...) are dot-separated and *pre-dedup*: the pack never
 *   appends `~2`. If two drafts have the same path the framework numbers them in source order, and the
 *   resolver strips `~N` again before comparing against pack-space paths.
 * - A pack must not keep `web-tree-sitter` nodes in its output: the tree is freed right after `extract`.
 * - The receiver of a member access is normalised to `"this"` (TS `this`; Python `self`/`cls`; Go receiver
 *   variable names) so the resolver has one rule for it. TS `super` stays `"super"` (base-class members).
 *
 * Qualifier segments (`SiteDraft.qualifier`, `TypeFact.initCall.qualifier`) describe the receiver
 * expression of a member access or call, left to right:
 *
 *   `this.pool.lease()`        -> qualifier ["this", "pool"], name "lease"
 *   `worker.run(job)`          -> qualifier ["worker"],       name "run"
 *   `Queue.create()`           -> qualifier ["Queue"],        name "create"
 *   `a.b().c()`                -> qualifier ["a", "b()"],     name "c"     (`x()` = result of calling x)
 *   `new Foo().bar()`          -> qualifier ["Foo()"],        name "bar"   (calling a class = an instance)
 *   `(x as Foo).bar()`         -> qualifier [":Foo"],         name "bar"   (":T" = a value of declared type T)
 *
 * A pack that cannot express a receiver (`arr[0].run()`) should not emit the site at all.
 */
import type { Node, Tree } from "web-tree-sitter";
import type {
  FileLanguage,
  FilePath,
  IndexedSymbol,
  Range,
  Reference,
  SymbolPath,
} from "@xpl/core";
import type { ResolverFile } from "../resolve/heuristic.js";
import type { SymbolEntry, SymbolLookup } from "../symbols.js";
import type { GrammarId } from "../wasm-files.js";

/** 1-based, inclusive lines and columns (UTF-16 code units): a `Range` whose columns are always present. */
export type Span = Range & { startCol: number; endCol: number };

/** A parsed file, as handed to `LanguagePack.extract` / `classifySite`. The tree is only valid during the call. */
export interface FileContext {
  /** Repo-root-relative POSIX path. */
  file: FilePath;
  language: FileLanguage;
  /** Full text, exactly as read from disk (may contain `\r\n` and a BOM). */
  source: string;
  /** `splitLines(source)`: line `n` (1-based) is `lines[n - 1]`. */
  lines: readonly string[];
  tree: Tree;
}

/**
 * Read-only view of the indexed repository, for `resolveModule` (and anything else a pack needs to look at
 * across files, e.g. `go.mod` or `pyproject.toml`).
 */
export interface RepoView {
  /** Absolute path of the indexed root. */
  readonly root: string;
  /** Every indexed file path (repo-root-relative POSIX). */
  readonly files: ReadonlySet<FilePath>;
  /** Indexed files that live directly in `dir` (`""` = the root), sorted. */
  filesInDir(dir: string): readonly FilePath[];
  /** Text of any file under the root, indexed or not (cached); undefined when missing or unreadable. */
  readText(path: FilePath): string | undefined;
}

// ─── Facts ────────────────────────────────────────────────────────────────────────────────────────

/**
 * A symbol the pack found. Order does not matter (the framework sorts by position).
 *
 * `range` is the full extent of the declaration *including* decorators, `export`/modifiers and (TS) the
 * `declare` keyword, but *excluding* leading comments (ARCHITECTURE.md §2.9). The index stores whole lines
 * only; the columns are kept internally for innermost-symbol lookups.
 */
export interface SymbolDraft {
  /** Dotted path, e.g. `Runner.dispatch`, `outer.inner`, `retry.maxRetries`. Never empty. */
  path: SymbolPath;
  kind: IndexedSymbol["kind"];
  range: Span;
  /**
   * Path of the logical parent (usually the path minus its last segment). The framework resolves it to
   * the draft with that path (the one containing this draft if several were numbered `~N`). If no draft
   * has that path (e.g. a Go method whose receiver type lives in another file) the symbol has no parent.
   */
  parentPath?: SymbolPath;
  /**
   * The symbol exists to be anchored and outlined and is never referenced by name: a test block (TS
   * `describe("Queue", ...)`), whose title is not a name in the code. The resolvers leave it out when they look
   * names up, so it cannot capture `Queue()` from the code under test, and no reference points at it; it still
   * is the `from` of the references inside it. Not stored in the index.
   */
  anchorOnly?: boolean;
}

export type SiteKind = "call" | "import" | "extends" | "implements" | "type-ref" | "write" | "read";

/**
 * A syntactic reference site: something in the code that mentions a name.
 *
 * - `call`: `name(...)`, `recv.name(...)`, `new Name(...)`, composite literals (Go), JSX components.
 *   `site` is the whole call expression, or only the callee if the call spans more than 10 lines.
 * - `import`: a module-level import that has no `ImportBinding` (`import "./x"`, dynamic `import("./x")`,
 *   `require("./x")` outside a declaration). `name` is the module specifier, `qualifier` is empty.
 * - `extends` / `implements`: heritage clauses; Python class bases are `extends`. `site` is the base name.
 * - `type-ref`: a name in a type position. `site` is the type name (qualified names included).
 * - `write`: assignment (`=`, `+=`, `++`) to a field or module variable. `site` is the assignment
 *   expression, or only its target if it spans more than 10 lines.
 * - `read`: a use of a module- or package-level variable or constant (`LIMIT`, `config.LIMIT`), or of a field
 *   of a value whose type is known (`this.queue`, `job.attempts`), that is not a call and not a write. `name`
 *   and `qualifier` as for a call (`this.pool.size` -> ["this", "pool"], `size`); `site` is the identifier or
 *   member expression (only the member's name if it spans more than 10 lines). Locals and parameters are not
 *   references: the pack leaves out bare names that are bound around the use. What the name resolves to
 *   decides: variables and fields are reads; a function or method used as a value is a `call` (it runs when
 *   the value is called), and a class or enum used as a value is a `type-ref`. A bare name bound around the
 *   use is only a candidate when it is a nested function (then `local`).
 *
 * The "from" symbol of a site is *not* given: the framework finds the innermost symbol containing
 * `site.startLine/startCol`, or the module scope (`"<file>#"`). That also attributes sites correctly when
 * several symbols share a path (`~2`), which a pack-space path cannot.
 */
export interface SiteDraft {
  kind: SiteKind;
  /** The referenced name: last segment of the callee / type / module specifier. */
  name: string;
  /** Receiver chain (see the file comment). Empty for plain names. */
  qualifier: string[];
  site: Span;
  /** Optional and ignored: the pack-space path of the enclosing symbol, if a pack happens to know it. */
  fromPath?: SymbolPath;
  /**
   * A bare name (no qualifier) that a function, block, loop or parameter around the site binds: a local
   * callable (`const f = () => 1; f()`, a callback parameter) or a nested function. The resolver then only
   * looks among the symbols nested in the enclosing functions, never at a module-level symbol or an import
   * of the same name.
   */
  local?: boolean;
}

/** A name a file brings into scope from another module. */
export interface ImportBinding {
  /** The name as used in this file (the alias if there is one). */
  localName: string;
  /** Module specifier exactly as written (`./queue.ts`, `jobrunner.queue`, `github.com/x/y/internal/queue`). */
  module: string;
  /** Name in the target module; `undefined` = the module itself (namespace / `import x as y` / Go package). */
  importedName?: string;
  /** The specifier (or the whole statement when there is no finer node). */
  site: Span;
  /**
   * The binding only exists for types: TS `import type { A }` / `import { type A }`, Python imports under
   * `if TYPE_CHECKING:`. Its reference is a `type-ref`, not an `import`: erased at run time, not a dependency.
   */
  typeOnly?: boolean;
}

export interface TypeFact {
  /**
   * The symbol path that owns the declaration:
   * - `field`: the class / interface / struct (`Runner`); `name` is the field name.
   * - `param`, `local`: the enclosing function or method (`Runner.dispatch`); `""` for module-level variables.
   * - `return`: the function or method itself (`WorkerPool.lease`); `name` is its last path segment.
   */
  scopePath: SymbolPath;
  name: string;
  kind: "field" | "param" | "local" | "return";
  /**
   * The declared or inferred type name, base name only: generics stripped, `T | undefined` reduced to `T`,
   * `Promise<T>` unwrapped for `return`, pointers stripped. May be qualified (`mod.Type`), resolved through
   * imports. Omit it when only `initCall` / `initChain` is known. `"this"` (return facts) means "the
   * receiver's own type" (fluent methods).
   */
  typeName?: string;
  /**
   * The value is the result of this call (`const worker = await this.pool.lease()`): the resolver looks the
   * callee up and uses its declared return type. Same shape as a `SiteDraft` callee.
   */
  initCall?: { qualifier: string[]; name: string };
  /**
   * The value is the value of this receiver chain, in the syntax of `SiteDraft.qualifier`: an alias such as
   * `const index = model.index` (["model", "index"]) or `const q = this.queue` (["this", "queue"]).
   */
  initChain?: string[];
  /**
   * Where the name is in scope, when that is narrower than everything inside `scopePath`: a callback's
   * parameters, a `const` declared in a nested block. The resolver only uses the fact for sites inside this
   * span and prefers the innermost one, so two callbacks that both declare `q` do not mix their types. Omit
   * it for names visible in the whole `scopePath` (Python/Go function scope, module-level variables).
   */
  visibleIn?: Span;
}

/**
 * What a module exposes beyond its top-level symbols (all top-level symbols are considered exported).
 *
 * - `{ name: "default", localName: "Foo" }`: `export default Foo` / `export { Foo as default }`.
 * - `{ name: "Bar", localName: "Foo" }`: `export { Foo as Bar }`.
 * - `{ name: "Bar", module: "./x", importedName: "Foo", site }`: `export { Foo as Bar } from "./x"`.
 * - `{ name: "ns", module: "./x", site }`: `export * as ns from "./x"` (no `importedName`).
 * - `{ name: "*", module: "./x", site }`: `export * from "./x"`, or Python `from x import *` (the resolver
 *   also consults it for names used in the same file).
 *
 * Re-exports with a `module` also yield an `import` reference from the file to the target.
 */
export interface ExportFact {
  name: string;
  localName?: string;
  module?: string;
  importedName?: string;
  site?: Span;
  /** A type-only re-export (`export type { A } from "./a"`, `export type * from`): its reference is a `type-ref`. */
  typeOnly?: boolean;
}

/** Everything `extract` returns for one file. */
export interface FileFacts {
  symbols: SymbolDraft[];
  sites: SiteDraft[];
  imports: ImportBinding[];
  typeFacts: TypeFact[];
  exports?: ExportFact[];
  /** Human-readable problems; the framework prefixes them with the file path. */
  warnings?: string[];
  /**
   * Pack-private data for `LanguagePack.inferRefs` (it comes back as `ResolverFile.data`). The framework does
   * not look at it, and it is never stored in the index.
   */
  data?: unknown;
}

export interface ClassifiedSite {
  kind: SiteKind;
  /** Same convention as `SiteDraft.site`. */
  site: Span;
  /**
   * A `read` of a bare name (`LIMIT`), not of a member (`this.limit`): what it names is a variable or constant,
   * never a field. An indexer that reports the field of an object literal there (`{ retry }` with a contextual
   * type: the property `retry`, not the variable) is not describing a read of that field, and the SCIP mapper
   * drops it.
   */
  bare?: boolean;
}

/** A reference a pack infers after resolution (`LanguagePack.inferRefs`); the framework adds `resolution: "heuristic"`. */
export type InferredRef = Pick<Reference, "from" | "to" | "kind" | "site">;

/** What `LanguagePack.inferRefs` is given. Everything is read-only. */
export interface InferRefsInput {
  /** The files of the languages this pack handles (in build order) with the facts `extract` returned for them. */
  files: readonly ResolverFile[];
  /** Every symbol of every file, in source order per file. */
  entries: readonly SymbolEntry[];
  /** Innermost-symbol lookup over the same symbols. */
  lookup: SymbolLookup;
  repo: RepoView;
  /** Every reference the heuristic resolver produced, for all packs. */
  refs: readonly Reference[];
}

// ─── The pack ─────────────────────────────────────────────────────────────────────────────────────

export interface LanguagePack {
  /** Pack id, e.g. "typescript" (one pack may serve several file languages). */
  readonly id: string;
  /** The `IndexedFile.language` values this pack handles. */
  readonly languages: readonly FileLanguage[];
  /**
   * Extensions (lowercase, with the dot) of `text` files this pack handles too: a format `FileLanguage` has no
   * name for. Such files are `text` in the index but are parsed and extracted by this pack. No pack uses it
   * at the moment (TOML has its own language now).
   */
  readonly extensions?: readonly string[];
  /** Grammar used to parse a file of `language` (e.g. javascript -> "tsx"; `text` for `extensions`). */
  grammarFor(language: FileLanguage): GrammarId;
  /**
   * How far a top-level name is visible without an import: `"file"` (TS, Python) or `"directory"` (Go:
   * every file of a package directory shares one namespace).
   */
  readonly packageScope: "file" | "directory";
  /**
   * Optional. A module's imports are names other modules can import from it (Python: `from .a import x` in
   * `__init__.py` makes `pkg.x`). Without it (TS, Go), only what the module exports is, `export { x } from`.
   */
  readonly importsReexport?: boolean;
  /**
   * Optional. The file is left out of a default build (Go: a `//go:build` line or a `_GOOS` / `_GOARCH` file
   * name that a linux/amd64 build without custom tags does not match). When several files of a package declare
   * a name, the resolver tries these last.
   */
  offByDefault?(path: FilePath, repo: RepoView): boolean;
  /** `"heuristic"` if `extract` produces sites (refs are derived), `"none"` for config formats and stubs. */
  readonly refs: "heuristic" | "none";
  /** Extract symbols, sites, bindings and type facts from a parsed file. Must not throw on syntax errors. */
  extract(ctx: FileContext): FileFacts;
  /**
   * Classify the identifier at 1-based (`line`, `col`) with the same rules `extract` uses for its sites
   * (used later to classify SCIP occurrences). `undefined` means "not one of the site kinds", i.e. a plain
   * read, a declaration or something else. The returned `site` equals what `extract` emits for that site.
   */
  classifySite(ctx: FileContext, line: number, col: number): ClassifiedSite | undefined;
  /**
   * Candidate repository files (in priority order) for a module specifier used in `fromFile`. Only files
   * present in `repo.files` may be returned. External modules (bare specifiers, stdlib) return `[]`. A
   * package that spans several files (Go) returns all of them.
   */
  resolveModule(spec: string, fromFile: FilePath, repo: RepoView): FilePath[];
  /**
   * Optional. For languages where `from module import name` can import a module: the specifier of the
   * submodule `name` of `module` (Python: `pkg` + `sub` -> `pkg.sub`, `.` + `x` -> `.x`). The resolver tries
   * it through `resolveModule` when `module` does not define `name`. Leave it out when `name` cannot be one.
   */
  submoduleSpec?(module: string, name: string): string | undefined;
  /**
   * Optional. Is this syntax-error node (`ERROR` or a MISSING token) inside a type expression, where the parser
   * recovered without disturbing anything a pack extracts (TypeScript: `[symbol: string]`, a valid labelled tuple
   * element the grammar cannot read, makes an `ERROR` inside the tuple only)? A file whose errors are all of
   * that kind is not reported as having syntax errors. Leave it out when no such errors are known. (JSON uses it
   * for the trailing commas of JSONC, `tsconfig.json`: the keys are all read.)
   */
  errorInTypePosition?(error: Node): boolean;
  /**
   * Optional post-resolution pass for references that no single site expresses (Go: a type implements an
   * interface by having its methods, so `implements` refs are inferred from the symbols). Called once per
   * build, after the heuristic resolver, for packs whose files were resolved heuristically. The result must be
   * deterministic. The framework marks the refs `resolution: "heuristic"`, drops self-references and
   * duplicates of existing refs, and - like every heuristic ref - replaces them by precise refs where a
   * precise resolver covers the language.
   */
  inferRefs?(input: InferRefsInput): InferredRef[];
}
