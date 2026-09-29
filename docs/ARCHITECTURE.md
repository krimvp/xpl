# xpl — Code Explainer: architecture

What was built, and the contracts it was built against. `docs/handoff.md` is the original design brief
(schema draft in Appendix A, worked example in Appendix B). This file settles its open questions, amends
its schema, and fixes the algorithms and interfaces of every package. It was written before the code and
has been corrected to match it; where the two still disagree, fix one of them in the same change.

Target languages: **TypeScript/JavaScript, Python, Go** (plus YAML/JSON config keys).

```
source ── xpl index ──→ .explainer/index-<commit>.json ──┐   static analysis; generated, git-ignored
                                                         ├──→ xpl view | xpl bundle ──→ viewer
Claude ── patch.json ── xpl apply ──→ <name>.explainer.json ┘   what Claude and the user add; committed
```

---

## 0. Decisions (open questions from the handoff)

1. **Indexer: hybrid, not either/or.** tree-sitter (WASM, `web-tree-sitter`) extracts *structure* for every
   language: files, symbols, ranges, hashes and the syntactic *reference sites* (calls, imports, heritage,
   type positions, writes). *Resolution* of a site to its target symbol comes from SCIP when the indexer
   can run (`scip-typescript`, `scip-python`, `scip-go`), otherwise from a scope-aware heuristic resolver.
   Every `Reference` records `resolution: "precise" | "heuristic"`, so the viewer draws heuristic edges
   lighter and Claude treats them as hints. Rationale: tree-sitter alone makes "static" edges guesses; SCIP
   alone gives no uniform symbol tree and fails hard when a tool is missing. The hybrid keeps one symbol
   model and upgrades edge trust where tooling exists: SCIP references replace the heuristic ones file by
   file (§3).
2. **Symbol-less code.** Config keys become symbols (`kind: "key"`, path = dotted key path, e.g.
   `config/default.yaml#retry.maxRetries`), so YAML/JSON anchors use `symbol` like everything else: no new
   anchor kind. Truly symbol-less text (scripts, Dockerfiles, Markdown) keeps file-relative spans; the
   resolver re-finds moved spans by content (§4.2), which removes most of their fragility.
3. **Prototype target:** three fixture repos with the same design (a job runner) in TS, Python and Go
   (`fixtures/*-jobrunner`). The TS one reproduces the handoff example exactly (§8).
4. **Viewer packaging: both, one build.** The viewer is one static single-file app. `xpl view` serves it
   locally with live repo access (exploring real repos; persists view and tour edits as `user` edits;
   queues "explain this" requests). `xpl bundle` inlines the data and sources into one self-contained HTML
   file (sharing, presenting, offline; the default in cloud sessions).
5. **Editor: CodeMirror 6**, not Monaco. Read-only viewing plus line decorations is exactly CM6's model;
   Monaco's workers and ~5 MB don't fit a single-file bundle.
6. **Layout: elkjs** (layered, compound nodes → containers) plus our own SVG with stable element IDs.
   Sequence diagrams use a small custom layout (lifelines are trivial). No Mermaid, no D2.
7. **Lazy explanations** are realised by the skill, and asynchronously: views get summaries for what they
   show; other nodes are explained on `expand`. The viewer cannot generate text itself. Its "Explain this"
   button queues a request in `.explainer/requests.json` (under `xpl view`; otherwise it shows the command
   to run), `xpl status` lists the queue, and the skill drains it.

---

## 1. Repository layout and conventions

```
package.json            npm workspaces root (ESM). Scripts: build, test, typecheck, test:e2e, format
tsconfig.base.json      strict, ES2022, NodeNext
packages/
  core/     @xpl/core     schema types + pure logic (hash, anchors, derivation, validation, patches).
                          Browser-safe: no node:* imports. Used by indexer, cli and viewer.
  indexer/  @xpl/indexer  file discovery, tree-sitter language packs (WASM), heuristic resolver, SCIP importer.
  cli/      @xpl/cli      `xpl` command; esbuild bundle → packages/cli/dist/xpl.mjs, with dist/wasm/ (the
                          tree-sitter .wasm files) and dist/viewer.html (a copy of the built viewer) beside it
  viewer/   @xpl/viewer   React 19 + CodeMirror 6 + elkjs; vite single-file build → packages/viewer/dist/index.html
skill/code-explainer/   Claude skill: SKILL.md, README.md, reference/ (cli.md, patch-format.md, examples/),
                        bin/xpl (a symlink-safe node launcher for the built CLI)
fixtures/{ts,py,go}-jobrunner/   tiny real repos + committed explainers in .explainer/
docs/                   handoff.md, ARCHITECTURE.md, images/
```

Conventions (all packages):

- ESM, TypeScript `strict`. Relative imports use `.js` suffixes (NodeNext style; bundlers accept it).
- Workspace packages export their TS sources (`"exports": { ".": "./src/index.ts" }`; the indexer also
  exports `./wasm` and `./wasm-files`). vitest, tsx and vite consume sources directly, so there is no build
  step between packages in development. Only the CLI (esbuild) and the viewer (vite) are built:
  `npm run build` builds the viewer first, then the CLI, which copies the viewer next to itself.
- Tests: vitest, in `packages/<pkg>/test/*.test.ts`. E2E: Playwright `@playwright/test@1.56.1` (matches the
  preinstalled Chromium in `/opt/pw-browsers`), in `packages/viewer/e2e/`. `XPL_TEST_SCIP=1` turns on the
  SCIP integration test, which downloads and runs the real indexers. Fixtures carry their own runners.
- `.npmrc` sets `ignore-scripts=true`: the grammar packages' install scripts only build native bindings we
  never use. So npm also skips pre/post scripts of our own packages; there are none. Tree-sitter grammar
  versions are pinned exactly (the wasm ABI has to match `web-tree-sitter`).
- Prettier (`printWidth` 100, trailing commas) formats everything except `fixtures/` (their line numbers are
  load-bearing: anchors and acceptance tests), `docs/` (hand-formatted) and the copy of Appendix B under
  `packages/core/test/types/`.

---

## 2. Schema amendments (delta vs handoff Appendix A)

`packages/core/src/schema.ts` = Appendix A plus:

1. `Range`: lines **and** columns are 1-based and inclusive. Columns count UTF-16 code units. Index symbols
   store whole lines only; reference sites carry columns.
2. `IndexedSymbol.kind` adds `"enum"` and `"key"` (config keys). TS namespaces are `"other"`.
3. `Reference` adds `resolution: "precise" | "heuristic"`. `from`/`to` may be a *module scope* id
   `"<file>#"` (empty symbol path) for top-level code and whole-module imports; the index has no symbol
   entry for it. Emitted kinds: `call import extends implements type-ref write`. `read` is in the schema,
   but nothing produces it (§9).
4. `SymbolIndex` adds `languages: Record<string, LanguageInfo>` and `root?: string` (absolute,
   informational, never used for resolution). `LanguageInfo = { files, symbols, refs: "precise" |
   "heuristic" | "none", tool?, heuristicFiles? }`. `tool` names what produced the references
   (`scip-typescript@0.4.0`, `xpl-heuristic@… (tree-sitter-typescript@…)`); `heuristicFiles` counts the files
   of a precise language that keep heuristic references because the tool did not describe them (§3).
5. `IndexedFile.language: FileLanguage` = `typescript | tsx | javascript | python | go | yaml | json | text`.
6. `Edge.kind` adds `"references"` (lifted type-refs).
7. `GraphView` adds `edgeKinds?: Edge["kind"][]`: the derived edge kinds shown. Default
   `DEFAULT_EDGE_KINDS` = `["calls", "extends", "implements"]`. Stored edges are always shown.
8. `GraphView` adds `excludeFiles?: string[]`: globs on repo paths (`packages/core/src/glob.ts`: `**` crosses
   directories, `*` stays inside one segment, `?` is one character, a pattern without `/` also matches the
   file name at any depth). Derived edges and stubs are computed without the references that start or end in
   a matching file, so an overview can ignore test files (`TEST_FILE_GLOBS` is the suggested list). Not
   filtered: nodes in `include`, stored edges, and the references of a file or symbol the view includes by
   name.
9. `Explainer.index.path` is repo-root-relative (e.g. `.explainer/index-wt-3f1a9c2e4b.json`).
10. Symbol ranges exclude leading comments and include decorators, `export` and modifiers. `Anchor.span`
    offsets are relative to that start line (or to file line 1 when `symbol` is absent) and must lie inside
    the symbol.

Patch-side types (never stored) live in `packages/core/src/patch.ts`; its header holds the authoritative
merge rules and `skill/code-explainer/reference/patch-format.md` is the practical guide. What Claude writes:

```ts
/** `applyPatch` turns it into a stored Anchor (hash + resolved filled in). */
interface AnchorInput {
  file: FilePath; symbol?: SymbolPath; role: AnchorRole;
  span?: { from: number; to: number };  // 0-based line offsets from the symbol's first line, inclusive
  find?: string;   // alternative to span: text that occurs exactly once in the symbol (or file); may be multi-line
  hash?: Hash;     // optional; if given it must equal the current hash (catches stale drafts)
}
interface ExplainerPatch {
  title?: string;
  nodes?: PatchNode[]; edges?: PatchEdge[]; concepts?: PatchConcept[];
  views?: PatchView[]; tours?: PatchTour[];
  remove?: string[];  // element / view / tour / step ids
}
```

- **Patch elements are partial.** `id` is the only required field of an existing element, view or tour.
  Absent fields keep their values; `null` clears an optional field (`summary detail members related
  edgeKinds hidden excludeFiles layout frames`); arrays and nested objects (`members include steps scope
  layout …`) replace wholesale. A sequence view's `steps` are sent whole (keep every step id; `remove` deletes
  single steps). Unknown fields are errors. `provenance` is optional: new elements get
  `{ origin: actor, commit }`.
- A new id needs what cannot be inferred. Node: `label` (not for `dir:`/`file:`/`sym:` overlays; `kind` comes
  from the id, `parent` defaults to the structural parent) and, for a group, `members`. Edge: `from`, `to`,
  `kind`, `label` (a derived-edge overlay `edge:<kind>:<a>-><b>` takes the first three from its id and may
  omit `label`, which validation then warns about). Concept: `label`. Graph view: `type`, `title`, `include`
  (or `includeAdd`). Sequence view: `type`, `title`, `participants`, `steps`. Tour: `title`, `steps`.
  `scope` defaults to `{ root: "repo", depth: 1 }`.
- Graph views also take `includeAdd` / `includeRemove` (patch-only, never stored): `include` is edited
  without resending it. They apply after `include` when that is given too: `includeRemove` first, then
  `includeAdd` (appended, duplicates ignored); an id in both is an error; an `includeRemove` id may name
  something gone from the index (that is how a vanished node is dropped). `includeAdd` is how `expand` grows
  a view, and the one edit an `llm` patch may make to a view whose `include` the user curated (§4.7).
- Tours in a patch carry `AnchorInput`s in a step's `code` override (`PatchTourStep`); a stored tour is a
  valid patch too.
- `find` is matched exactly first, then with runs of whitespace collapsed. Zero or several matches are
  errors that say where. `span` and `find` are mutually exclusive.

---

## 3. Indexer (`@xpl/indexer`)

```ts
buildIndex(opts: { root: string; commit?: string; precise?: "auto" | "off" | "require";
                   languages?: string[]; resolvers?: readonly PreciseResolver[] })
  : Promise<{ index: SymbolIndex; warnings: string[] }>
writeIndex(root: string, index: SymbolIndex): Promise<string>
// atomic write of <root>/.explainer/index-<commit>.json; keeps `index-*.json` in .explainer/.gitignore
```

Pipeline: discover files → per file: read, hash, parse once, `pack.extract`, free the tree → assemble symbols
(ids, `~N` suffixes, whole-line ranges, hashes, parents) → heuristic resolution of every site, plus the
packs' `inferRefs` → precise resolvers replace references file by file → commit id → `SymbolIndex`.
`tool` = `xpl-indexer@<v> web-tree-sitter@<v> <grammar>@<v> …`. A file with syntax errors is indexed anyway
(one summary warning: its symbols may be incomplete); an extraction failure is a warning and a file without
symbols. References are sorted by file, position and kind. `resolvers` replaces the registry (tests inject
fakes); `languages` restricts the build to some `FileLanguage`s (the CLI does not expose it).

**Files.** `git ls-files --cached --others --exclude-standard` when `root` is inside a git work tree
(limited to the root's subtree), otherwise a walk that skips `.git node_modules dist build out vendor target
__pycache__ .venv venv .explainer` and dot-directories. In both modes `.explainer/`, `node_modules/` and
`.git/` are never indexed (`.explainer/` would feed our own index back into the working-tree commit id).
Dropped silently: binaries (NUL in the first 8 KB), files over 1 MB, symlinks and submodule directories,
files deleted but still tracked, and lockfiles (`*-lock.json`, `*.lock`, `go.sum`, `pnpm-lock.yaml`,
`npm-shrinkwrap.json`). Every remaining text file is an `IndexedFile` (unknown extensions → `text`), so
file-relative anchors work anywhere. Language by extension: `.ts .mts .cts` typescript, `.tsx` tsx,
`.js .mjs .cjs .jsx` javascript, `.py .pyi` python, `.go` go, `.yaml .yml` yaml, `.json` json. Paths are
POSIX, repo-root-relative, sorted.

**Commit id.** `--commit` wins (letters, digits, `.`, `_`, `-` only: it becomes part of a file name). Else, if
`root` is the git top-level and the work tree is clean (ignoring `.explainer/`): short HEAD (7 chars). Else
`wt-` + first 10 hex of sha256 over the sorted `path\0hash\n` list: deterministic, which is why fixtures
living inside this monorepo get stable ids.

**Language packs** (`src/languages/<lang>.ts`, registry in `languages/index.ts`). A pack turns one parsed
file into plain facts. It never assigns ids, `~N` suffixes, hashes or parents, and never resolves anything:
the framework (`build.ts`, `symbols.ts`) and the language-agnostic heuristic resolver do.

```ts
interface LanguagePack {
  id: string; languages: FileLanguage[]; grammarFor(language): GrammarId;
  packageScope: "file" | "directory";  // how far a top-level name is visible without an import (Go: the package dir)
  refs: "heuristic" | "none";          // does the pack emit sites (references are derived from them)?
  extract(ctx: FileContext): FileFacts;                        // one walk of the syntax tree
  classifySite(ctx, line, col): ClassifiedSite | undefined;    // the same rules as extract, for SCIP occurrences
  resolveModule(spec, fromFile, repo: RepoView): FilePath[];   // import specifier → repository files ([] = external)
  submoduleSpec?(module, name): string | undefined;            // Python: `from pkg import sub` may name module pkg.sub
  inferRefs?(input): InferredRef[];    // references no single site expresses (Go: implicit interfaces)
}
interface FileFacts {
  symbols: SymbolDraft[]; sites: SiteDraft[]; imports: ImportBinding[]; typeFacts: TypeFact[];
  exports?: ExportFact[]; warnings?: string[];
  data?: unknown;  // pack-private input of inferRefs; never stored
}
```

- Positions are `Span`s: 1-based inclusive lines and columns in UTF-16 (`nodeSpan`/`spanBetween` convert
  tree-sitter's points). A pack must not keep tree nodes: the tree is freed right after `extract`.
- `SymbolDraft { path, kind, range, parentPath? }`: dotted, pre-dedup paths.
- `SiteDraft { kind, name, qualifier, site }`: `qualifier` is the receiver chain left to right, with the
  receiver normalised to `"this"` (TS `this`, Python `self`/`cls`, the Go receiver variable; TS `super`
  stays): `this.pool.lease()` → `["this", "pool"]`, `lease`. `x()` in a chain is the result of calling `x`,
  `:T` a value of declared type `T`. A receiver the pack cannot spell (`arr[0].run()`) yields no site.
- `ImportBinding { localName, module, importedName?, site }`.
- `TypeFact { scopePath, name, kind: "field" | "param" | "local" | "return", typeName?, initCall?, initChain?,
  visibleIn? }`: the declared or inferred type of a field, parameter, local or return value (generics
  stripped, `T | undefined` → `T`, `Promise<T>` unwrapped for returns). `initCall`: the value is the result of
  that call (the resolver follows it to the callee's return type). `initChain`: an alias of a receiver chain
  (`const q = this.queue`). `visibleIn` narrows where a name is in scope (a callback's parameters, a
  block-scoped `const`, Go's scoping); the resolver prefers the innermost fact.
- `ExportFact { name, localName?, module?, importedName?, site? }`: what a module exposes beyond its
  top-level symbols (every top-level symbol counts as exported): `export { A as B }`, `export default X`,
  re-exports (`export … from`, which also yield an `import` reference), `export *`, Python `from x import *`
  and the submodule exports of a package's `__init__.py`.

**Symbols.** Duplicate paths within a file get `~2`, `~3`… in source order (assigned by the framework).
`IndexedSymbol.hash` = `hashText` of the symbol's full lines; `IndexedFile.hash` = `hashText` of the whole
file.

| Language | Symbols (kind) | Path rules |
|---|---|---|
| TS/TSX/JS | class (also a class expression bound to a const, an anonymous default export), interface, type alias (`type`), enum (members are not symbols), function and generator declarations, `const/let/var` declarators (arrow/function initialiser → `function`, else `variable`; destructured names too), class members (methods incl. constructor/get/set/abstract → `method`; fields → `variable`, **except fields initialised with an arrow or function, which are `method`**), interface members (method signatures → `method`, property signatures → `variable`), functions nested in functions or methods, methods and function-valued properties of top-level object literals (`method`), namespaces (`other`) | `Class.member` (`#private` keeps its `#`, `[Symbol.iterator]` → `@@iterator`), `outer.inner`, `obj.key`, `NS.name`; anonymous default export → `default`; body-less overload signatures are skipped when an implementation follows, ambient declarations are kept; `declare module` / `declare global` members are listed as top-level |
| Python | class; `def` / `async def` (`function`; directly in a class body → `method`); module- and class-level simple assignments (`variable`; also annotation-only `id: str`; single-name targets only); `type X = …` (`type`) | `Class.method`, `outer.inner`, `Class.Inner.method`; the range starts at the first decorator; definitions inside `if`/`try`/`with`/`for`/`while`/`match` belong to the scope around them; `if __name__ == "__main__":` is skipped; `@overload` stubs are skipped; `@x.setter` gives `x~2` |
| Go | `func` (`function`); methods (`method`, path `Recv.Name`, pointer receivers and type parameters stripped); `type` declarations (struct → `class`, interface → `interface`, anything else, aliases included → `type`); struct fields (`variable`, `Type.field`, nested anonymous structs `Type.field.sub`); interface methods (`method`); top-level `var`/`const` specs (`variable`, one per name, `_` declares nothing) | a method is a child of its receiver type only when that type is declared in the same file; **a type symbol's range starts at its name** (not at `type`); **embedded struct fields and interface elements are not symbols but `extends` sites**; function-local types and closures are not symbols |
| YAML/JSON | mapping keys (`key`) | dotted key path; sequence items by index (`workers.0.name`); at most 6 levels of keys and 2000 keys per file (one warning beyond); a key's range is its whole `key: value` pair; YAML merge (`<<`), empty, complex and alias keys are not symbols |

**Reference sites.** Each pack emits syntactic sites `{ kind, name, qualifier, site }` for calls (including
`new X()`, composite literals, JSX components, Python decorators), imports without a binding (`import "./x"`,
`import("./x")`, `require("./x")`), `extends` / `implements` (Python class bases and Go embedded fields are
`extends`), type positions (`type-ref`) and assignments to fields and module variables (`write`). A call or
assignment spanning more than 10 lines is reported by its callee or target only. `from` is not given by the
pack: the framework takes the innermost symbol containing the site's start (line and column), else the module
scope `"<file>#"`. `classifySite(ctx, line, col)` applies the same rules to one position, so SCIP occurrences
are classified exactly like sites.

**Heuristic resolution** (`src/resolve/heuristic.ts`), for a site `qualifier.name`, in order:

1. no qualifier: the lexical scope chain (nested functions, namespaces), then the file's top-level symbols,
   then import bindings (through `resolveModule`, following re-exports), then star exports, then, for
   `packageScope: "directory"` languages (Go), the top-level symbols of the other files of the directory;
2. `this` (`self`, receiver): a member of the enclosing class, then of its base classes; `this.f.m()` through
   the declared type of field `f` (TS field or constructor parameter property, Python `self.f: T` /
   `self.f = T(...)` / annotated `__init__` parameter, Go struct field); `super.m()`: a base-class member;
3. a local or parameter: its declared type, or, for `const w = this.pool.lease()`, the declared return type
   of the callee;
4. a class, namespace or imported module: static members (`Class.m()`, `ns.f()`, `mod.Type`); qualified
   type names through imports; a module-level variable of another file has the type its own file's facts give
   it (`bus = new EventBus()`);
5. last resort, only when the receiver's type is completely unknown: a class named like the qualifier
   (case-insensitively) that has the member (`queue.pop()` → `Queue.pop`), preferring the same file, then a
   class the file imports, then the same directory. Ambiguity drops the site.

Receivers whose type is known but outside the repository (`Map`, `Promise`, a bare npm import) are opaque:
nothing is guessed. Unresolved sites and self-references are dropped. Module resolution (`resolveModule`):
TS relative specifiers with extension and `index` probing (`.js` → `.ts`), `tsconfig`/`jsconfig` `paths` and
`baseUrl` (with relative `extends`), workspace packages by `package.json` name (entry through `exports`/
`types`/`module`/`main`, build output mapped back to source) and `imports`; Python dotted and relative
imports, `src/` layouts, nested project roots and namespace packages; Go every `go.mod` in the repository
(module path → package directory, local `replace`s), a package's files being one namespace.

Not handled: overload resolution, generics and type arguments, union types, control-flow narrowing, locals
reassigned to another type, dynamic access, CommonJS `module.exports` shapes. Go: inference beyond the
evident (no signatures or generics, no element types of slices and maps, one type for a multi-value call),
method values, function-local types, cgo, build constraints, vendor directories. Python: instance attributes
assigned only in methods are not symbols, so writes to them are not linked.

`inferRefs` (Go) adds `implements` references for implicit interface satisfaction: a type implements an
interface when its method set (own methods across the package's files, plus promoted ones) covers the
interface's, matched by name and a coarse signature check (parameter and result counts and shapes);
unexported names count within one package only; empty interfaces, constraint interfaces and interfaces with
an unresolvable embedded element (`io.Reader`) are skipped.

**Precise resolution** (`src/scip/`). For each language present that a resolver covers, the SCIP indexer runs
with a timeout (10 minutes, `XPL_SCIP_TIMEOUT_MS`), writing to a temp directory that is removed afterwards;
`index.scip` is decoded by a small hand-rolled protobuf reader (no generated code). Commands as run:

| Tool | Command |
|---|---|
| scip-typescript 0.4.0 (typescript, tsx, javascript) | `npx --yes @sourcegraph/scip-typescript@0.4.0 index --cwd <root> --no-progress-bar --output <tmp>/x.scip <projects>`, projects = every directory with a `tsconfig.json` (or the `jsconfig.json` of one without). Never `--infer-tsconfig`: it writes a tsconfig into the repository and then indexes only `.ts`. Files no project includes (all of them without a tsconfig) get a **second pass** with a synthetic tsconfig kept in the temp directory; so do all files when a tsconfig cannot be loaded (its `extends` package is not installed). |
| scip-python 0.6.6 | `npx --yes @sourcegraph/scip-python@0.6.6 index --cwd <root> --project-name <n> --project-version 0.0.0 --environment <tmp>/environment.json --quiet --output <tmp>/index.scip`. The version keeps it from crashing outside git, the empty environment (`[]`) skips its `pip` introspection, and the repository's package roots (`src/`, nested projects) go on `PYTHONPATH` so that `import flask` resolves to `src/flask`. |
| scip-go v0.2.7 | `go run github.com/scip-code/scip-go/cmd/scip-go@v0.2.7 index --output <tmp>/module-N.scip`, once per `go.mod` (the module moved from `github.com/sourcegraph/scip-go`, which stops at v0.1.26). Needs Go ≥ 1.25: an older `go` downloads the toolchain on first use, which needs network access. `GOFLAGS=-mod=mod` unless there is a `go.work` or a `vendor/` directory; `go.mod` and `go.sum` are restored afterwards. |

Mapping (`map.ts`): for every non-definition occurrence of a symbol whose definition lies in an indexed file,
`from` = the innermost symbol at the occurrence (else the module scope) and `to` = the symbol whose name sits
at the definition (a module or package → the module scope of the defining file, the alphabetically first for
a Go package; a constructor → its class). `kind` and `site` come from the pack's `classifySite`. When the
pack does not classify an occurrence: a quoted module specifier → `import` of the module scope (dropped when
the same statement imports names), role Import → `import`, WriteAccess → `write`, a type-like symbol →
`type-ref`; anything else, plain reads and declarations included, is dropped. Also dropped: references to
definitions nested in something that is not one of our symbols (parameters, local variables, instance
attributes), occurrences that do not fit the file text (a warning counts them), self-references. `local N`
symbols follow the same rules, so calls to functions nested in functions stay. SCIP `is_implementation`
relationships become `implements` references (Go interfaces are satisfied implicitly, so this is where
precise Go gets them), unless an occurrence already said `extends`/`implements` or the member merely
overrides a base-class member. SCIP ranges (0-based, end-exclusive, in the document's encoding: UTF-16 for
scip-typescript and scip-python, UTF-8 bytes for scip-go) become 1-based, inclusive UTF-16 against the file on
disk. Symbols are matched across indexes without their package version, so the modules of a Go repository
resolve each other.

**Replacement is per file.** The files a tool *described* (`PreciseOutput.describedFiles`; for SCIP, the
documents of its index) lose their heuristic references to the tool's. Files it did not describe (build-tagged
Go files, files a Python project's pyright configuration excludes, unreadable ones) keep their heuristic
references, are named in a warning, and are counted in `LanguageInfo.heuristicFiles`. A language none of
whose files was described is not precise: that run counts as failed. `precise: "auto"` (the default) turns a
failed or missing tool into a warning and keeps the heuristic references; `"require"` fails instead; `"off"`
never runs SCIP. Other environment: `XPL_WASM_DIR` (where the `.wasm` files come from: `dist/wasm/` next to
the bundled CLI, `node_modules` in development).

---

## 4. Core (`@xpl/core`)

Modules of `packages/core/src`: `schema`, `patch`, `constants`, `text` (hashing), `glob`, `ids`,
`index-model` (`IndexModel`), `implementations`, `anchors`, `model` (`ExplainerModel`), `graph`, `focus`,
`sequence`, `validate`, `apply`, `bundle`.

### 4.1 Text and hashing

- `splitLines(text)` splits on `\r?\n` (a trailing newline yields a final empty line). `sliceLines(text,
  range)` returns full lines `startLine..endLine`.
- `normalizeText(text)`: trim every line, drop lines that are empty after trimming, join with `\n`.
- `hashText(text)` = `"sha256:" + hex(sha256(normalizeText(text))).slice(0, 12)` (sync; `@noble/hashes`).
  The indexer hashes with Node's native sha256 (`FileHasher`), which checks itself against `hashText` on a
  fixed sample and falls back to it, so index values never depend on which path ran.

### 4.2 Anchor resolution (`anchors.ts`)

`resolveAnchor(anchor, index, getText) → { status, range, span?, hash, reason? }` where `getText(file)`
returns the current file text.

1. File not in the index → `missing`. `symbol` given but not in the index → `missing`.
2. Region = the symbol's range, or the whole file. Base line = region start (or 1 for files).
3. No span: current hash = symbol/file hash. Equal to `anchor.hash` → `ok`, or `moved` if `anchor.resolved.range`
   exists and differs from the region. Different → `drifted` (range = region).
4. Span: expected = `[base+from, base+to]`. Hash of the expected lines equal → `ok`/`moved` as above.
   Otherwise search the region for the text: first every window of the same raw length, then windows over the
   non-blank-line sequence (lengths 1..raw length) so blank-line edits do not matter (bounded work); the
   nearest match to the expected position wins → `moved` with the new range and new `span`. No match →
   `drifted` at the expected range, clamped to the region: since a span is only re-found while its text is
   unchanged, that range is where the span *used to* sit, and reports mark it **approximate**.
5. `missing` keeps the previous range if any, else `{ startLine: 0, endLine: 0 }`; consumers ignore it. Its
   reason says where the code may have gone (rename-aware suggestions, below). When `getText` cannot supply
   the file of a span anchor, the cached `anchor.resolved` is kept (or `drifted` if there is none).

`makeAnchor(input, index, getText)` converts an `AnchorInput`: rejects unknown fields (JSON `null` counts as
absent), validates file, symbol and role, converts `find` to a span (exactly one occurrence), checks the span
is inside the region and not blank, computes `hash`, and sets `resolved` with status `ok`. A `hash` on the
input must equal the current one.

`reresolveExplainer(explainer, index, getText, { indexPath? })` re-resolves every anchor (elements, sequence
steps, tour code overrides), rewrites `resolved`, updates `span` for `moved`, sets `explainer.index` and
`repo.commit`, and returns a report: counts by status, `drifted` (elements with origin `llm`, and tours, to
be re-explained: each with its `userFields` and its drifted anchors), `driftedOther` (drifted but `user` or
`static`: left alone), and every `missing` anchor with its element id, whatever its owner. Hashes are left
alone, so a drifted anchor stays drifted until its element is re-explained.

**Rename-aware suggestions** (`IndexModel.suggestSymbols`, used by every "not found" message). Candidates,
best first: a symbol with the very text the missing one had (a move, not a rename); siblings under the same
parent ranked by name similarity and by how close their size is to the old one (a renamed method keeps its
length); same-named symbols elsewhere (same path in another file, same name); paths within two edits. Test
files rank after production code. For a span anchor whose symbol vanished, the symbol whose text now contains
the anchored lines is found by content. Every candidate is spelled twice: as an element id
(`sym:src/a.ts#A.b`) and as the fields an anchor takes (`file: "src/a.ts", symbol: "A.b"`). `xpl` inputs are
normalised loosely by `normalizeElementId` (`src/a.ts#A.b`, `./src/`, …), with the same suggestions.

### 4.3 Element model and IDs (`ids.ts`, `model.ts`)

Structural ids: `repo`, `dir:<path>` (every directory containing an indexed file, root excluded),
`file:<path>`, `sym:<file>#<path>`. Parents: symbol → `sym:<parent>` or its file; file → its dir or `repo`;
dir → parent dir or `repo`. Stored ids: `grp:<slug>`, `concept:<slug>`, `edge:<slug>` (stored edges),
`view:<slug>`, `tour:<slug>`, `frame:<slug>`, steps `<view-slug>:<n>` (e.g. `dispatch:3`; never renumbered;
one namespace with the elements). Slugs: letters, digits, `.`, `_`, `-`, starting with a letter or digit; a
view slug may not be a reserved prefix (`dir file sym grp concept edge view tour frame ghost stub`). Derived:
`edge:<kind>:<fromId>-><toId>`. Render-only: `ghost:<id>`, `stub:<in|out>:<insideId>->ghost:<id>`. A `sym:`
id splits into file and path at the first `#` (the index-aware helpers try every `#`).

`ExplainerModel(explainer, indexModel)` merges derived structural nodes with stored overlays (a stored node
with the same id overrides label/summary/detail/anchors/provenance) and indexes every element, step and
derived id. Default labels: repo name, dir/file basename, a symbol's last path segment (methods keep
`Class.method`). Hand-edited files are tolerated: entries without an id are skipped, the first of a repeated
id wins (validation reports the duplicates).

### 4.4 Graph derivation (`graph.ts`)

- `repr(x, include, model)`: walk `x, parent(x), …, repo`; at each step return the element if it is included,
  else the nearest included group that lists it as a member, directly or through nested groups (**groups nest
  transitively**). Undefined → `x` is outside the view.
- A node renders inside its *render parent*: the first included element met walking up from it, checking at
  each level the groups that contain the element before moving to the structural parent. An included node
  that others render inside is a **container**. Cycles between nested groups are broken.
- **Derived edges:** each index reference `(from, to, kind)` maps to `(repr(from), repr(to))`; skip it if
  either end is outside (→ stub) or both are equal. Kind map: call→calls, import→imports, extends,
  implements, type-ref→references, read→reads, write→writes; only kinds in `edgeKinds` (default
  `DEFAULT_EDGE_KINDS`). Module scopes lift to their file. Aggregate per `(kind, a, b)` into
  `edge:<kind>:<a>-><b>` with `count`, `resolution` (`precise` if any aggregated reference is) and derived
  anchors: each site as `call-site` (calls) or `usage`, plus each target's definition, at most 50 of each,
  never stored.
- **Stored edges** are shown whatever their `kind`, when both ends are represented in the view. One whose id
  equals a derived id overlays that edge (label, summary, anchors) and keeps its derived resolution; the
  others carry `llm`, `user` or `static` after their provenance. Stored edges that leave the view give stubs
  too.
- **Stubs:** references (and stored edges) with exactly one end inside. Ghost target = the highest structural
  ancestor of the outside end, below `repo`, that contains no included node (a group is its own target).
  Aggregate per `(direction, insideId, ghostId)` with the kinds and the count.
- `view.excludeFiles` drops references that start or end in a matching file before anything is aggregated
  (files the view includes by name, directly or as members of included groups, are exempt); stored edges are
  not filtered. `view.hidden` is applied last: hidden nodes go, their children **re-parent** to the nearest
  visible container, and the edges and stubs touching them go; hidden edge, stub and ghost ids are removed.
- `deriveGraph(view, model, { edgeKinds? }) → { nodes, edges, stubs }`, sorted by id. `nodes[i] = { id, label,
  kind, symbolKind?, container, parent? }`; `edges[i]` adds `count`, `stored` and `resolution: "precise" |
  "heuristic" | "llm" | "user" | "static"`.
- Pure view edits: `expandStub(view, stub)`: `include += ghost target`. `drillIn(view, id, model)`: `include +=`
  the node (when missing) and its children (a group opens into its members), so it becomes a container.
  `collapse(view, id, model)`: remove its included descendants (for a group: its members' subtrees).
  `defaultInclude(scope, model)`: nodes exactly `depth` levels under `root`, plus shallower leaves (files and
  symbols without children).

### 4.5 Code focus and reverse lookup (`focus.ts`)

- `codeFocus(ids, model, { derivedEdges? }) → FocusRange[]` (`{ file, range, role, elementId, status }`): the
  union of each element's resolved anchors (`missing` ones excluded). When an element has no usable anchor
  (none, or all missing) it **falls back**: symbol → its range; file → the whole file; dir and repo → their
  files (at most 50); group → its members' focus; derived edge, or a stored overlay of one without anchors →
  the derived anchors (reference sites plus target definitions). Concepts, stored edges and steps without
  usable anchors have no focus. Unknown ids are skipped.
- `mergeFocusByFile(ranges)`: per file (the first focused file first), overlapping ranges merged into
  whole-line runs, keeping every role and source range.
- `buildReverseIndex(candidateIds, model)`: interval entries from `codeFocus` of each candidate.
  `lookup(file, line)` returns every element whose entries contain the line with the minimal line span (an
  element counts with its smallest range around the line; innermost wins; ties return all). Candidates
  (`viewCandidates`) = the active view's elements (included nodes and shown edges, or participants and
  steps) plus all concepts.

### 4.6 Validation (`validate.ts`)

`validateExplainer(explainer, index, getText, { mode: "strict" | "lenient" })` returns `Issue[]`:
`{ severity: "error" | "warning", path, elementId?, message, code?, userLocked? }`, with `path` like
`views[1].steps[2].anchors[0]`. Codes: `schema duplicate-id bad-id unknown-id anchor-invalid anchor-drifted
anchor-missing evidence frame cycle step commit protected`. Messages are written for Claude to fix its patch
from. Rules:

- Shapes and enums; `schema` = `code-explainer@0`; `repo` and `index` present. An `index.commit` other than
  the given index's is a warning (`commit`) that points at `xpl resolve --write`.
- Ids: unique (elements and steps share one namespace; views and tours each unique); prefixes and slugs as in
  §4.3; a stored structural node's id matches its `kind` and exists in the index; a derived-edge overlay
  matches its id's kind, `from` and `to`; steps are `<view-slug>:<n>`; frames `frame:<slug>`.
- Every referenced id exists or is derivable: `parent`, `members`, edge `from`/`to`, `related`, `scope.root`,
  `scope.entryPoints` (symbol ids in the index), `include`, `hidden` (nodes, edges, ghosts, stubs),
  `participants`, `layout` keys, step `from`/`to`/`edge`, tour `view` and `focus` (a focused step that
  belongs to another view is a warning), `editor.primary` (an indexed file).
- Groups: need a parent and members; no self-membership and no cycles, transitively; an empty group is a
  warning.
- Graph views: `edgeKinds` are edge kinds; `excludeFiles` are strings (warnings for an empty pattern, a
  leading `/` or `./`, a backslash); `layout` positions are finite numbers; duplicates are warnings.
- Sequence views: step `from`/`to` must be participants; frames name steps of their own view, `fromStep` not
  after `toStep`; partially overlapping frames are a warning.
- Anchors: `role` and `hash` present; strict → every anchor resolves `ok`/`moved`; lenient (after
  regeneration) → drifted and missing anchors, **and ids of files, directories and symbols that vanished from
  the index**, are warnings. The messages say what to do, and, for an element whose anchors the user owns
  (origin `user`, or `anchors`/`steps` in `userFields`), that only the user can repair them
  (`userLocked: true`).
- `llm` edges carry at least one anchor inside `from` and one inside `to` (file → same file; dir → under it;
  symbol → same symbol or a descendant; group → any member): `containsCode`, code `evidence`.

### 4.7 Patches (`apply.ts`)

`applyPatch(explainer, patch, index, getText, { actor: "llm" | "user" }) → { ok, explainer, issues, changed }`,
atomic: any error → `ok: false` and the input explainer, untouched.

- Upsert by id, shallow-merged as in §2. An id twice in one patch, or upserted and removed by the same patch,
  is an error. `remove` takes elements, views, tours and single steps (an unknown id is a warning); dropping a
  step id by resending a view's `steps` is a warning (`step`: tours may point at it).
- **Ownership.** `actor: "llm"` never modifies (skipped with a `protected` warning) an element or view whose
  origin is `user`, and keeps the fields listed in `userFields`. It cannot create `origin: "user"` elements
  and cannot change `provenance`. It cannot remove an element or view that has `userFields` (or is
  user-authored), nor single steps of a view whose `steps` the user edited. The one edit it may still make to
  a field the user owns is `includeAdd`. `actor: "user"` editing an element of another origin adds the
  changed fields to `userFields`; that is how viewer edits and `xpl apply --actor user` protect themselves
  from regeneration.
- New elements get `provenance = { origin: actor, commit: index.commit }` unless given; a changed `llm`
  element gets `provenance.commit = index.commit`. Tours have no provenance.
- Anchors go through `makeAnchor`, steps and tour `code` overrides likewise, frames are checked.
- **Validation after the merge is strict, but only what the patch introduced or touched can reject it.**
  Errors that were already in the explainer, on elements the patch did not change, become one summary
  warning (otherwise a single drifted anchor on a user-owned concept would block every later patch). One more
  exception: an `llm` patch that changes an element whose anchors the user owns is not rejected for the drift
  of those anchors, which it cannot repair; the problem stays a warning (`userLocked`).
- `changed` lists the ids of elements, views, tours and steps the patch added, changed or removed (upserts
  that change nothing are not listed), plus `"title"`.

### 4.8 Also in core

- `implementations.ts`: `implementationsOf(index, id)` / `implementedBy(index, id)`: who implements an
  interface (or one of its methods) and which interface member a method implements, from type-level
  `implements` references (TS clauses, Go's inferred satisfaction) matched to members by name (a Go method
  may sit in another file of the package), member-level ones from a precise index, and interfaces that extend
  one another. `xpl refs` uses it to hop through interfaces.
- `sequence.ts`: step and participant lookups, frames resolved to step ranges with nesting depth
  (`resolveFrames`), disambiguated lifeline labels. `bundle.ts`: the viewer's data format (§5).
  `glob.ts`, `constants.ts` (`DEFAULT_EDGE_KINDS`, `TEST_FILE_GLOBS`, schema names).

---

## 5. CLI (`xpl`)

Global: `--root <dir>` (default cwd), `--json` (machine output), `--index <path>`, `-h`/`--help` (`xpl help
[command]`), `-v`/`--version`; options may come before or after the command name. `<id>` arguments accept
`sym:…`, `file:…`, `dir:…`, `src/a.ts#A.b`, `src/a.ts`, `./src/`, and come back with "did you mean"
suggestions when wrong. `<explainer>` is a name (`jobrunner`), a file name or a path. Output is compact and
copy-pasteable, for Claude as much as for people: exact ids, `<line> <offset>│ code` with the 0-based offsets
that spans use, `+34..36` for the span of a reference site. `--json` on every command prints `{ "ok": true,
…, "warnings"? }`; errors print `{ "ok": false, "error", … }`. Warnings go to stderr as `warning: …`.

| Command | Does |
|---|---|
| `xpl index [--precise auto\|off\|require] [--commit c]` | build + write the index; writes `.explainer/.gitignore` (`index-*.json`); prints a per-language summary and names explainers bound to another index |
| `xpl outline [--under <id>] [--depth n] [--keys] [--limit n]` | dir/file/symbol tree with kind, lines, fan-in/fan-out (references into/out of the subtree); default depth 2; config keys only with `--keys` |
| `xpl show <id> [--refs] [--context n] [--lines a-b] [--max-lines n]` | code with 0-based offsets relative to the symbol (the numbers spans use); dirs and the repo list children; `--refs` appends outgoing and incoming references with `+offset` |
| `xpl refs <id> [--in\|--out] [--kind k] [--depth n] [--limit n] [--tests]` | call/reference hierarchy with sites; hops through interfaces as `impl` lines; test doubles hidden unless `--tests` |
| `xpl search <pattern> [--regex] [-i] [--limit n]` | text hits over the working tree with enclosing symbol id and offset |
| `xpl new <name> [--title t] [--repo r] [--url u]` | create `.explainer/<name>.explainer.json` bound to the index; never overwrites; repo name from `--repo`, else `package.json`, `go.mod`, `pyproject.toml`, git remote, directory name |
| `xpl apply <explainer> <patch.json\|-> [--actor llm\|user] [--dry-run]` | §4.7; prints issues; atomic; `--help` summarises the patch format |
| `xpl validate <explainer> [--lenient]` | §4.6 |
| `xpl anchors <explainer> [id...] [--full] [--max-lines n]` | each anchor of an element (or of every element) resolved now: role, `file#symbol +span`, status, lines, and the code at them with offsets; verifies spans without reading JSON |
| `xpl resolve <explainer> [--write] [--allow-stale]` | §4.2 re-resolve against the index of the current code; report drifted llm elements, missing anchors; `--write` saves |
| `xpl status <explainer>` | the skill's to-do list, read-only: per view the shown nodes, stored edges and steps without a summary (static edges optional), concepts without one, drift (user-owned drift counted apart), missing anchors, broken references (ids gone from the index), stale derived-edge overlays, queued requests |
| `xpl view <explainer> [--port p] [--host h] [--no-open]` | local server (below) |
| `xpl bundle <explainer> -o out.html [--mode explore\|present] [--tour id] [--files all\|referenced]` | self-contained HTML; `--tour` (`tour:intro` or `intro`) implies present mode |

**Exit codes.** 0 ok (warnings allowed); 1 rejected or failed: unknown id, no index, a rejected patch, a patch
that changed nothing because the user owns everything it touched, validation errors, `resolve --write` on a
stale index, port in use; 2 usage error. **Environment:** `XPL_VIEWER_HTML` (viewer page for `view` and
`bundle`), `XPL_SKIP_STALE_CHECK=1`, `XPL_WASM_DIR`, `XPL_SCIP_TIMEOUT_MS`, `XPL_DEBUG=1` (stack traces),
`XPL_CLI` (the skill launcher: an `xpl.mjs` to run).

**Files in `.explainer/`:** `index-<commit>.json` (generated, git-ignored by `.explainer/.gitignore`),
`<name>.explainer.json` (committed), `requests.json` (the queue below). Writes are atomic (temp file + rename).

**Index selection**, in order: `--index <path>` (relative to the working directory, else to the root); for
explainer commands, the explainer's own `index.path` when that file exists (`xpl resolve` **ignores** it: it
exists to move an explainer to a newer index); otherwise among `.explainer/index-*.json`: the only one, else
the one named for the current commit id, else the newest. None → an error that says to run `xpl index`.

**Stale index.** Whatever was chosen is compared with the working tree (the commit id it would get now, then
per-file hashes). If they differ, commands warn, naming the changed, new and deleted files: `index X … does
not match the working tree (Y): 2 changed (src/queue.ts, src/runner.ts). Line numbers and offsets may be off;
run xpl index`. `XPL_SKIP_STALE_CHECK=1` skips the comparison (about a second per 5000 files). `xpl resolve
--write` refuses (exit 1) on a stale index, because the ranges it would save are already wrong, unless
`--allow-stale`.

**`xpl view`** serves the viewer on `http://127.0.0.1:<port>/`: port 4747, else any free port when that is
taken (`--port 0` = any; an explicit port that is taken is an error). `--host` other than loopback exposes
your source and edit rights, and warns. It opens the browser best-effort (`--no-open`) and fails early when
the viewer is not built or there is no index. The server keeps no explainer state: every request re-reads
the explainer, its index and the working tree, so `xpl apply` while the viewer is open shows up after a
reload (the page does not reload itself), and viewer edits never overwrite it.

| Route | |
|---|---|
| `GET /` | the viewer HTML with the bundle injected (`server: { api: "/api" }`, `mode: "explore"`, `files` = the files the explainer references; others are fetched lazily) |
| `GET /api/bundle` | the same bundle as JSON |
| `GET /api/file?path=` | text of one indexed file (`text/plain`); 400 for a malformed path (absolute, `..`, backslash, NUL), 404 for anything not in the index (with `suggestions`) or unreadable |
| `PUT /api/views/<id>` | a view patch (`{ type, …changed fields }`) applied as actor `user` and written; 200 with the updated view; 400 `{ error, issues }` when rejected |
| `PUT /api/tours/<id>` | the same for a tour (`{ title?, steps? }`, both for a new tour) |
| `GET /api/requests` | `{ requests, pending }` for this explainer |
| `POST /api/requests` | `{ elementId, note? }` (the viewer's `{ kind, id, view?, label? }` is accepted too, `id` = the element) appended to `.explainer/requests.json`; 201 |

Guards against DNS rebinding and cross-site writes: for loopback binds the `Host` header must be a loopback
name with the server's port (403 otherwise); `PUT`/`POST` need `Content-Type: application/json` (415) and,
when an `Origin` header is present, the same origin (403); bodies are capped at 8 MB (413); a wrong method
gets 405 with `Allow`. View, tour and request writes run one at a time. `.explainer/requests.json` is a JSON
array of `{ elementId, note?, kind?, view?, label?, at, explainer? }`; the skill deletes the file once it has
handled the requests.

**Bundle payload** (`ViewerBundle`, also `/api/bundle`): `{ schema: "code-explainer/bundle@0", explainer,
index, files: Record<FilePath, string>, mode?, tour?, server? }`, embedded as
`<script id="xpl-data" type="application/json">` with `<` escaped as `\u003c` (and U+2028/2029 escaped).
Under `xpl view` `files` may be partial and the viewer fetches the rest from `/api/file`. `xpl bundle`
embeds every indexed file when they total under 20 MB, else the referenced ones (`--files` decides): those of
every anchor, plus every file that a view element, concept or tour step can focus. The viewer HTML comes from
`XPL_VIEWER_HTML`, else `dist/viewer.html` next to the running bundle, else `packages/viewer/dist/index.html`.

---

## 6. Viewer (`@xpl/viewer`)

**Data and state.** The viewer reads the bundle from `<script id="xpl-data">` and shows a "no data" page
without one. One external store (`store.ts`) holds the state; `derive.ts` derives, memoised per state, the
graph of the view, the code focus of the selection, the editor panes and the reverse-lookup matches with
`@xpl/core`. The UI and `window.__xpl` go through the same actions. Without `server` (a static bundle) view
and tour edits stay in memory: the header shows "Unsaved" and "Download explainer JSON". Under `xpl view`
they are sent 250 ms after the last change through `PUT /api/views/<id>` / `PUT /api/tours/<id>` ("Saving…",
"Saved", "Retry save" on failure) and recorded as user edits (`userFields`). Markdown (`detail`, tour notes) is
sanitised: raw HTML shows as text, images become their alt text, links keep only http(s), mailto and in-page
targets; summaries are plain text.

**Explore.** Header: title, one tab per view (the tooltip of a sequence view is its question), the Tours
button, the Explore/Present toggle (Present is disabled without tours and says how to get one), save state and
download. Left: the diagram (caption: title, question, and for graph views the derived-edge-kind toggles),
below it the concept list and the details panel. Right: the code, the file tree (collapsible; files outside
the focus are greyed `is-dimmed`, files in it `is-focus`) beside the stack of CodeMirror editors. Both splits
(diagram / panels, diagram / code) are resizable. Below 900 px the halves stack.

- **Graph view:** elkjs `layered`, direction RIGHT, or DOWN when the pane is taller than wide; when the
  result would have to be scaled down to fit, the other direction is tried too (graphs of at most 150
  elements) and kept if it fits at least 8% larger. The direction is on the graph as `data-direction`.
  `hierarchyHandling: INCLUDE_CHILDREN`, containers for nested includes, edges routed inside their lowest
  common container. If ELK throws, a grid layout keeps the diagram usable (`data-fallback`). Edges are styled
  by resolution: precise, heuristic (thinner and lighter), `llm`, `user`; stubs are dashed and lead to ghost
  boxes. Click selects (shift/ctrl/cmd adds, the background clears); clicking a ghost calls `expandStub`;
  double-clicking a node calls `drillIn`; a container has a collapse button. Pan by dragging, zoom with the
  wheel, the buttons or `+`/`-`, "Fit". View edits (expand, drill in, collapse, edge-kind toggles) are stored
  on the view. Selecting a stub focuses the reference sites that cross the boundary there plus the
  definitions on the far side.
- **Sequence view:** lifelines, one row per step (`call` solid, `return` dashed, `async` open head), self-calls
  as loops, frames (`loop`/`alt`/`opt`/`par`) as labelled rectangles around their steps, nested by
  `resolveFrames`. A step's hit area covers its label and arrow.
- **Selection and code focus:** clicking any element (node, edge, stub, step, concept) selects it; the editors
  show the code focus (§4.5), one pane per focused file (a file opened from the tree or an anchor row first,
  then the step's `primary`, then focus order; at most 10 panes, the rest are listed): lines carry `xpl-hl`
  and `xpl-hl-<role>`, all other lines of a focused file `xpl-dim`, and the first range is scrolled into
  view. Selecting a concept co-highlights its `related` elements (`is-related`), including the group or
  container that stands for them in the view.
- **Reverse lookup:** every caret or selection change in an editor is reported as a line range;
  `lookup(file, line)` (§4.5) marks the matching diagram elements and concepts `is-match`.
- **Details:** kind, label, provenance badge (origin, commit, fields you edited), the id, summary and detail,
  facts, related elements and the anchors with their status (`ok`, `moved`, `drifted`, `missing`; clicking one
  opens the file at its lines). Actions: "Explain this" (queues a request under `xpl view`, otherwise shows
  `/code-explainer expand <id>` to copy), "Add … to the view" for a stub, "Open children", "Collapse".

**Tours.** *Explore → tour panel* (Tours button): add the current view and selection as a step to a tour, or
to a new one (`tour:<slug of the title>`); edit each step's note (markdown), reorder, delete with undo.
Render-only ids (stubs, ghosts) are never stored in a step.

**Present.** Plays a tour: each step applies its view, its `focus` as the selection, its `code` override and
its `editor` options (`dimOthers`, `hideFileTree`, `primary`), and shows its `note` as a large caption with the
counter (`n / N`) and a progress bar. Layout: the diagram and the caption on the left (40%, at least 340 px),
the code on the right, no file tree unless a step sets `hideFileTree: false`; diagrams are fitted larger.
The header shows a tour picker instead of the view tabs. The diagram is read-only: no drill-in, expand or
collapse. Keys: `→` `PageDown` `Space` next, `←` `PageUp` `Shift+Space` previous, `Home`/`End` first/last,
`Esc` leaves Present (in Explore, `Esc` clears the selection); they win over the diagram, the editors and
focused buttons, while text fields and menus keep their own keys. **A click during a talk is a detour:** the
selection follows the click, the caption says "Exploring · Back to step n", and the next key applies the next
step again. URL: `?mode=present&tour=<id>&step=<n>` (`n` counts from 1; `tour=intro` finds `tour:intro`;
`?view=<id>` picks the starting view). The address bar follows the tour with `history.replaceState`, so a
reload or a shared link lands on the same slide. A step past the end is clamped; an unknown tour falls back
to the first one when the page opens in Present. `xpl bundle --tour` or `--mode present` sets the bundle's
defaults, which the URL overrides.

**Test hooks (stable contract for Playwright):**

- Every clickable diagram element or list item carries `data-element-id="<id>"` (nodes, edges, steps,
  lifelines, concepts); stubs also `data-stub-id`, ghosts `data-element-id="ghost:<id>"`. State classes:
  `is-selected`, `is-match`, `is-related`; file-tree rows `is-dimmed`, `is-focus`.
- Other attributes: `data-view-id` (view tabs, and the diagram with `data-view-type`), `data-mode` on `.app`,
  `data-direction` / `data-fallback` on the graph, `data-collapse-id`, `data-edge-kind`, `data-frame-id`,
  `data-details-id`, `data-path` (tree rows), `data-status` (anchor rows), `data-zoom` (canvas). Present:
  `[data-testid="present"]` with `data-tour`, `data-step` (1-based) and `data-step-id`.
- `data-testid`: `mode-explore`, `mode-present`, `tours-button`, `tour-panel`, `tour-target`, `tour-new-title`,
  `tour-add`, `tour-step`, `tour-step-note`, `tour-step-up`, `tour-step-down`, `tour-step-delete`,
  `tour-undo`, `tour-present`, `tour-picker`, `tour-prev`, `tour-next`, `tour-counter`, `tour-note`,
  `tour-detour`, `explain-command`, `no-data`.
- Editor panes `[data-file="<path>"]`; every line `.cm-line[data-line="<n>"]`; decorations `xpl-hl`,
  `xpl-hl-<role>`, `xpl-dim`, and `xpl-site` on the exact call or usage expression when the range has
  columns.
- `window.__xpl` (same actions as the UI): `select(ids)`, `selection()`, `focus()` (core `FocusRange`s in pane
  order), `matches()`, `setCursor(file, line)` (opens the file when no pane shows it), `setView(id)`,
  `present(tourId, step = 1)` (false without such a tour), `next()`, `prev()`, `exitPresent()`, `state()`: a
  JSON snapshot (`mode`, `tour`, `step`, `stepCount`, `stepId`, `detour`, `viewId`, `viewType`, `selection`,
  `cursor`, `matches`, `related`, `panes`, `focusFiles`, `openedFile`, `graph { nodes, edges, stubs }`,
  `serverMode`, `dirty`, `include`, `edgeKinds`).

---

## 7. Skill (`skill/code-explainer`)

`SKILL.md` drives three operations, plus regeneration, through the CLI (`<skill-dir>/bin/xpl`). The launcher
finds `packages/cli/dist/xpl.mjs` relative to its own real path, so the skill directory is symlinked, not
copied (`XPL_CLI=<xpl.mjs>` overrides the lookup). Everything Claude writes is a patch; it never edits an
explainer by hand.

Workflow: `xpl index` → `xpl new <name>` → read the code (`outline`, `search`, `show`, `refs`) → write one
patch → `xpl apply` (a rejection writes nothing: fix the patch, apply again) → `xpl validate` and `xpl
status` (until `0 unexplained`) and `xpl anchors` (read what every span landed on) → `xpl bundle` (the
default in cloud sessions) or `xpl view`.

- **`explain <question>`**: ask one short question if the scope is really ambiguous; find entry points
  (`search -i`, `outline`); trace (`show <entry> --refs`, `refs --out --depth 2 --kind call`, hopping through
  interfaces via `impl` lines); look for what static analysis misses (event bus, DI, callbacks, HTTP,
  queues, config keys read by name); decide the model (a sequence view of 3–6 participants and one step per
  call that matters; a graph of the 5–15 files or symbols involved, with groups where a responsibility
  crosses folders; concepts anchored to code, config keys and tests; `llm` edges only for the links just
  found, evidence at both ends; a summary for everything the views show); write ONE patch; apply; check; show
  the result; answer in 3–6 sentences.
- **`explain repo`**: coarse first, lazy after. `outline --depth 1/2`, 4–10 boxes, groups for responsibilities
  that span folders, an overview graph (`scope: { root: "repo", depth: 1 }`, `excludeFiles` for test files,
  `edgeKinds` when package dependencies are the point), `llm` edges, a few concepts at most, one sequence view
  for an obvious entry point. Deeper nodes stay unexplained; offer the 2–3 most useful expansions.
- **`expand <node>`**: an id, a clicked ghost (`ghost:dir:x` means `dir:x`) or a queued request. Read it, patch
  the graph view with `includeAdd` (works on user-curated views), explain only what became visible (`xpl
  status` names it), drain `.explainer/requests.json` and delete it.
- **`make tour`**: 5–12 steps `{ id: "t1", view, focus: [ids], note, editor: { primary } }`, with a `code`
  override when the focus is a group, file or directory; ids `tour:<slug>`, steps `t1`, `t2`…; apply, then
  `xpl bundle -o … --tour tour:<slug>`.
- **Regeneration** (after the code changed): `xpl index` → `xpl resolve <name> --write` → `xpl status` →
  re-read the code and resend the anchors and dependent summaries of drifted `llm` elements, skipping
  `userFields` and never touching `origin: "user"`; repair broken references (`includeRemove`, lists resent
  without the gone id); report missing anchors to the user with the "did you mean" hint, never dropping or
  retargeting them silently → `xpl validate` (strict) must pass.

Hard rules: you cannot invent code (every anchor resolves or `apply` rejects it; never write hashes, and
never line numbers or offsets from memory: copy them from `show`/`refs`/`search` output, or use `find`);
read before you claim (a reference is a hint until you have seen the call); `llm` edges only for what static
analysis cannot see, with anchors at both ends; stable ids (slugs chosen once, step ids never renumbered or
reused); the default actor `llm` (never overwrite `origin: "user"` or `userFields`; `--actor user` only for
text the user dictates); summaries are 1–2 concrete sentences about this code; lazy; ask rather than guess.

`reference/`: `patch-format.md` (a template for every element, merge rules, rejection messages and their
fixes; its `json patch` blocks are applied by a test), `cli.md` (every command with sample output),
`examples/go-retry.patch.json` (a worked question patch for `fixtures/go-jobrunner`) and
`examples/py-overview.patch.json` (a worked repo overview for `fixtures/py-jobrunner`); tests apply and
validate both.

---

## 8. Fixtures and acceptance

Three fixtures implement the same job runner (queue, worker pool, event bus, metrics, a runner with
retry/backoff and dead-lettering, YAML config, tests), each with runnable tests using only its standard
toolchain: TS `node --test` (type stripping), Python `unittest`, Go `go test` (several packages under
`internal/` plus `cmd/jobrunner`; `*queue.Queue` satisfies `runner.JobQueue` without declaring it, which
exercises implicit-interface inference). `config/default.yaml`'s `retry` mapping is lines 13–16 in all three.

`fixtures/ts-jobrunner` matches the handoff example **exactly**: `src/runner.ts` with `Runner.dispatch` at
lines 42–88; offsets (relative to line 42) 4 = the `pop()` call, 18–19 = the `run(job)` call, 30–41 = the
retry block, 34–36 = the `requeue(...)` call; `Worker.run` offset 21 = the `job.completed` emit;
`metrics.ts#onJobCompleted`; `test/retry.test.ts`.

**Example explainers** (Appendix B, once per language). `packages/viewer/scripts/<lang>-example.patch.json`
is applied as actor `llm` (a group, the `Runner.dispatch` overlay, the event-bus edge with evidence at both
ends, the overview and dispatch views, a tour) and `<lang>-example.user.patch.json` afterwards as actor `user`
(the retry-policy concept and the edited dispatch summary). Two patches because an `llm` patch cannot create
user-authored elements and only a `user` patch records `userFields`: that is how Appendix B's provenance (a
concept with `origin: "user"`, a `Runner.dispatch` overlay with `userFields: ["summary"]`) comes about.
`scripts/make-bundle.ts` is the equivalent of `xpl index --precise off`, `xpl new`, both `xpl apply`s and
`xpl bundle` for a fixture; the committed `fixtures/<lang>-jobrunner/.explainer/jobrunner.explainer.json`
files are its output.

Acceptance (Playwright, `packages/viewer/e2e/`, TS fixture bundle, `view:dispatch`):

1. Clicking step `dispatch:3` highlights the `requeue` call inside `Runner.dispatch` (runner.ts 76–78) and the
   `Queue.requeue` definition (queue.ts 87–90), and dims everything else.
2. Cursor on runner.ts line 77 (offset 35) → `dispatch:3` is the only `is-match`; cursor on line 73
   (offset 31) → `concept:retry-policy`.

The same checks run against the Python and Go bundles, with line numbers derived at test time from the index
and text markers (`jobrunner-acceptance.ts`), so editing a fixture cannot silently move the expectations.

Other suites: unit tests per package (properties and scenarios in core, per-language fixtures and SCIP
mapping fed by a hand-built protobuf encoder in the indexer, the CLI in-process); `skill-examples.test.ts`
applies every `json patch` block of `patch-format.md` and both example patches; the regeneration tests take
real git repos through a second commit that moves, re-indents, changes and deletes anchored code, then
`index` → `resolve --write` → `status` → re-explain → `validate`, on TS, Python and Go; the e2e suite covers
explore, tours, `xpl view`'s API from the browser, degraded (malformed) explainers and both colour schemes.

---

## 9. Status

**Exists and tested:** the four packages and the skill as described above; three language packs with
heuristic references, SCIP-precise references for all three, the full CLI, explore and present modes with
tours, and example explainers for the three fixtures.

**Known limitations**

- Nothing produces `read` references, so the viewer's `reads` toggle has nothing to switch (stored `reads`
  edges are always shown).
- `GraphView.layout` (hand-pinned positions) is validated and accepted in patches but the viewer never reads
  it, and `GraphView.hidden` is honoured by derivation but has no UI: hiding an edge or node is a patch
  (`xpl status --json` lists the derived edge ids).
- elkjs runs on the main thread (the bundled build): laying out a very large graph blocks the page, so views
  should stay coarse (whole-repo views start at packages) and are expanded by hand.
- No live reload: `xpl view` re-reads everything per request, but an open page needs a manual reload after
  `xpl apply`.
- Heuristic references are hints, and the limits are in §3: no overloads, generics, unions or narrowing;
  Python instance attributes and Go method values are not linked. A precise index needs the tools: `npx` for
  TypeScript and Python, Go ≥ 1.25 (or the network for the automatic toolchain) for Go, and the first run
  downloads them. Files a tool did not describe stay heuristic (`heuristicFiles`).
- "Explain this" is a queue, not a live call: an explanation appears the next time the skill runs.
- Step ids are "never renumbered" by convention: the code only warns when a resend drops one.
- Tours have no `provenance`, so a tour the user edited in the tour panel is not protected: an `llm` patch that
  resends or removes its id replaces it (the skill's patch reference says tours "can be re-sent freely").
  Everything else the user edits is protected (§4.7), which makes tours the one exception to the handoff's
  rule that user-owned content is never overwritten on regeneration.
- Not published: the packages are private and `xpl` runs from a clone (`npm install && npm run build`), which
  is also what the skill launcher expects. Node ≥ 22.12 is required; only Linux has been exercised.

**Next steps, roughly by value:** live reload for `xpl view` (poll `/api/bundle`, or a server-sent event when
the explainer file changes); a UI for hiding and pinning, or dropping the unused `layout` field; ELK in a Web
Worker; `read` references (SCIP roles already carry them); more language packs (each needs `extract`,
`classifySite`, `resolveModule`, and optionally a SCIP resolver); publishing the CLI and packaging the skill
so that install is one step; a regeneration mode in the skill that walks `xpl status` on its own.
