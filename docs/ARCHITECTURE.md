# xpl — Code Explainer: architecture contract

This is the build contract. `docs/handoff.md` holds the original design brief (schema draft in Appendix A,
worked example in Appendix B). This file settles its open questions, amends the schema where needed, and
fixes the algorithms and interfaces every package builds against. If code and this file disagree, fix one
of them in the same change.

Target languages for v0: **TypeScript/JavaScript, Python, Go** (plus YAML/JSON config keys).

---

## 0. Decisions (open questions from the handoff)

1. **Indexer: hybrid, not either/or.** tree-sitter (WASM, `web-tree-sitter`) extracts *structure* for every
   language: files, symbols, ranges, hashes, and the syntactic *reference sites* (calls, imports, heritage,
   type positions). *Resolution* of a site to its target symbol comes from SCIP when an indexer is available
   (`scip-typescript`, `scip-python`, `scip-go`), otherwise from a scope-aware heuristic resolver. Every
   `Reference` records `resolution: "precise" | "heuristic"`, so the viewer can draw heuristic edges lighter
   and Claude treats them as hints. Rationale: tree-sitter alone makes "static" edges guesses; SCIP alone
   gives no uniform symbol tree and fails hard when an indexer is missing. The hybrid keeps one symbol model
   and upgrades edge trust where tooling exists.
2. **Symbol-less code.** Config keys become symbols (`kind: "key"`, path = dotted key path, e.g.
   `config/default.yaml#retry.maxRetries`), so YAML/JSON anchors use `symbol` like everything else — no new
   anchor kind. Truly symbol-less text (scripts, Dockerfiles) keeps file-relative spans; the resolver
   re-finds moved spans by content (§4.2), which removes most of their fragility.
3. **Prototype target:** three fixture repos with the same design (job runner) in TS, Python and Go
   (`fixtures/*-jobrunner`). The TS one reproduces the handoff example exactly.
4. **Viewer packaging: both, one build.** The viewer is one static single-file app. `xpl view` serves it
   locally with live repo access (exploration of real repos; persists expand/layout edits).
   `xpl bundle` inlines the data and sources into one self-contained HTML (sharing, presenting, offline).
5. **Editor: CodeMirror 6**, not Monaco. Read-only viewing plus line decorations is exactly CM6's model;
   Monaco's workers and ~5 MB don't fit a single-file bundle.
6. **Layout: elkjs** (layered, compound nodes → containers) plus our own SVG with stable element IDs.
   Sequence diagrams use a small custom layout (lifelines are trivial). No Mermaid, no D2.
7. **Lazy explanations** are realised by the skill: views get summaries for what they show; other nodes
   are explained on `expand`. In `xpl view` mode the viewer can queue "explain this" requests into
   `.explainer/requests.json`; the skill drains the queue.

---

## 1. Repository layout and ownership

```
package.json            npm workspaces root (ESM). Scripts: build, test, typecheck, test:e2e
tsconfig.base.json      strict, ES2022, NodeNext
packages/
  core/     @xpl/core     schema types + pure logic (hash, anchors, derivation, validation, patches).
                          Browser-safe: no node:* imports. Used by indexer, cli and viewer.
  indexer/  @xpl/indexer  file discovery, tree-sitter language packs, heuristic resolver, SCIP import.
  cli/      @xpl/cli      `xpl` command; bundled with esbuild to packages/cli/dist/xpl.mjs
  viewer/   @xpl/viewer   React + CodeMirror 6 + elkjs; vite single-file build → packages/viewer/dist/index.html
skill/code-explainer/   Claude skill: SKILL.md, reference/, bin/xpl (node launcher for the built CLI)
fixtures/{ts,py,go}-jobrunner/   tiny real repos + committed explainers in .explainer/
docs/                   handoff.md, ARCHITECTURE.md
```

Conventions (all packages):

- ESM, TypeScript `strict`. Relative imports use `.js` suffixes (NodeNext style; bundlers accept it).
- Workspace packages export their TS sources (`"exports": { ".": "./src/index.ts" }`); vitest, tsx and vite
  consume sources directly, so there is no build step between packages in dev.
- Tests: vitest, in `packages/<pkg>/test/*.test.ts`. E2E: Playwright `@playwright/test@1.56.1` (matches the
  preinstalled Chromium in `/opt/pw-browsers`), in `packages/viewer/e2e/`.
- Subagents do not commit; the orchestrator commits per phase. Stay inside the paths you own. Do not add
  dependencies unless essential; if you must, `npm install -w packages/<yours> <dep>` and report it.

---

## 2. Schema amendments (delta vs handoff Appendix A)

`packages/core/src/schema.ts` = Appendix A plus:

1. `Range`: lines **and** columns are 1-based and inclusive. Columns count UTF-16 code units.
2. `IndexedSymbol.kind` adds `"key"` (config keys) and `"enum"`.
3. `Reference` adds `resolution: "precise" | "heuristic"`. `from`/`to` may be a *module scope* id
   `"<file>#"` (empty symbol path) for top-level code and whole-module imports.
4. `SymbolIndex` adds `languages: Record<string, LanguageInfo>` where
   `LanguageInfo = { files: number; symbols: number; refs: "precise" | "heuristic" | "none"; tool?: string }`,
   and `root?: string` (informational, never used for resolution).
5. `IndexedFile.language` values: `typescript | tsx | javascript | python | go | yaml | json | text`.
6. `Edge.kind` adds `"references"` (lifted type-refs).
7. `GraphView` adds `edgeKinds?: Edge["kind"][]` — derived edge kinds shown. Default:
   `["calls", "extends", "implements"]`. Stored edges are always shown.
8. `Explainer.index.path` is repo-root-relative (e.g. `.explainer/index-wt-3f1a9c2e4b.json`).
9. Doc comments: symbol ranges exclude leading comments but include decorators, `export` and modifiers.
   `Anchor.span` offsets are relative to that start line (or to file line 1 when `symbol` is absent) and
   must lie inside the symbol.

Patch-side types (not stored) live in `packages/core/src/patch.ts`:

```ts
/** What Claude writes. The CLI turns it into a stored Anchor (hash + resolved filled in). */
interface AnchorInput {
  file: FilePath; symbol?: SymbolPath; role: AnchorRole;
  span?: { from: number; to: number };
  /** Alternative to span: text that occurs exactly once in the symbol (or file); may be multi-line. */
  find?: string;
  /** Optional; if given it must equal the current hash (catches stale drafts). */
  hash?: Hash;
}
/** Elements/views/tours as in the schema, but anchors are AnchorInput and provenance is optional. */
interface ExplainerPatch {
  title?: string;
  nodes?: PatchNode[]; edges?: PatchEdge[]; concepts?: PatchConcept[];
  views?: PatchView[]; tours?: Tour[];
  remove?: string[]; // element / view / tour ids
}
```

---

## 3. Indexer (`@xpl/indexer`)

```ts
buildIndex(opts: { root: string; commit?: string; precise?: "auto" | "off" | "require";
                   languages?: string[] }): Promise<{ index: SymbolIndex; warnings: string[] }>
writeIndex(root: string, index: SymbolIndex): Promise<string> // → <root>/.explainer/index-<commit>.json
```

**Files.** `git ls-files --cached --others --exclude-standard` when `root` is inside a git work tree,
otherwise a walk that skips `.git node_modules dist build out vendor target __pycache__ .venv venv
.explainer` and dot-dirs. Skip binaries (NUL in the first 8 KB), files > 1 MB, and lockfiles
(`*-lock.json`, `*.lock`, `go.sum`). Every remaining text file is an `IndexedFile` (unknown extensions →
`text`) so file-relative anchors work anywhere. Paths are POSIX, repo-root-relative, sorted.

**Commit id.** `--commit` wins. Else, if `root` is the git top-level and the work tree is clean: short
HEAD (7 chars). Else `wt-` + first 10 hex of sha256 over the sorted `path\0hash\n` list — deterministic for
fixtures living inside this monorepo.

**Symbols (tree-sitter).** One language pack per language (`src/languages/<lang>.ts`):

| Language | Symbols (kind) | Path rules |
|---|---|---|
| TS/TSX/JS | class, interface, type alias (`type`), enum, function decl, `const/let/var` declarators (arrow/function initialiser → `function`, else `variable`), class methods incl. constructor/get/set (`method`), class fields (`variable`), interface method/property signatures (`method`/`variable`), function decls nested in functions, methods/arrow props of top-level object literals | `Class.member`, `outer.inner`, `obj.key`; anonymous default export → `default`; overload signatures without body are skipped |
| Python | class, def (`function`; inside class → `method`), module- and class-level simple assignments (`variable`), nested defs/classes | `Class.method`, `outer.inner`; range starts at decorators |
| Go | func (`function`), method (`method`, path `Recv.Name`, pointer receivers stripped, generics stripped), type decls (struct → `class`, interface → `interface`, else `type`), struct fields and interface methods, top-level var/const specs (`variable`) | `parent` only when the parent is in the same file |
| YAML/JSON | mapping keys (`key`), max depth 6 | dotted key path; sequence items use the index (`workers.0.name`) |

Duplicate paths within a file get `~2`, `~3`… in source order. `IndexedSymbol.hash` = `hashText` of the
symbol's full lines. `IndexedFile.hash` = `hashText` of the whole file.

**Reference sites (tree-sitter).** Each pack emits syntactic sites: `{ kind, name, qualifier?, site, fromId }`
for calls (incl. `new X()` / composite literals → `call`), imports, `extends`/`implements` (Python class
bases → `extends`), type positions (`type-ref`), and assignments to fields/module variables (`write`).
`fromId` = innermost enclosing symbol, else module scope `"<file>#"`. Each pack also exposes
`classifySite(tree, line, col)` so SCIP occurrences can be classified the same way.

**Heuristic resolution** (`src/resolve/heuristic.ts`), in order: local/same-file symbol → import binding
(TS relative modules with extension/index probing; Python dotted + relative imports with `src/` layout
detection; Go module path from `go.mod` → package dir, same-package symbols across files) → `this/self/
receiver.m()` → method of the enclosing class → `this.f.m()` / `self.f.m()` / `r.f.m()` via declared field
type (TS field / constructor parameter property, Python `self.f: T` or `self.f = T(...)` or annotated
`__init__` param, Go struct field) → parameter type annotations → qualifier-name match (`queue.pop()` →
`Queue.pop` when a class named like the qualifier has that member). Otherwise unresolved (dropped).
Resolution `"heuristic"`. Self-references (`from === to`) are dropped.

**Precise resolution** (`src/scip/`): run the SCIP indexer for each detected language
(`npx --yes @sourcegraph/scip-typescript@0.4.0 index`, `npx --yes @sourcegraph/scip-python@0.6.6 index`,
`go run github.com/sourcegraph/scip-go/cmd/scip-go@v0.2.7`), decode `index.scip` with a small hand-rolled
protobuf reader (no generated code), then for every non-definition occurrence of a non-`local` symbol whose
definition lies in an indexed file: `from` = innermost symbol at the site, `to` = innermost symbol at the
definition (module scope if none), `kind` = `classifySite`. SCIP `is_implementation` relationships become
`implements` refs. For a language indexed precisely, its heuristic refs are replaced. `precise: "auto"`
falls back to heuristic with a warning; `"require"` fails.

---

## 4. Core (`@xpl/core`)

### 4.1 Text and hashing

- `splitLines(text)` splits on `\r?\n`. `sliceLines(text, range)` returns full lines `startLine..endLine`.
- `normalizeText(text)`: trim every line, drop lines that are empty after trimming, join with `\n`.
- `hashText(text)` = `"sha256:" + hex(sha256(normalizeText(text))).slice(0, 12)` (sync; `@noble/hashes`).

### 4.2 Anchor resolution

`resolveAnchor(anchor, index, getText) → { status, range, span?, hash, reason? }` where `getText(file)`
returns current file text.

1. File not in index → `missing`. `symbol` given but not in index → `missing`.
2. Region = the symbol's range, or the whole file. Base line = region start (or 1 for files).
3. No span: current hash = symbol/file hash. Equal to `anchor.hash` → `ok`, or `moved` if
   `anchor.resolved.range` exists and differs from the region. Different → `drifted` (range = region).
4. Span: expected = `[base+from, base+to]`. Hash of expected lines equal → `ok`/`moved` as above.
   Otherwise search the region for the text: first every window of the same raw length, then windows over
   the non-blank-line sequence (lengths 1..raw length) so blank-line edits don't matter; nearest match to
   the expected position wins → `moved` with the new range and new `span`. No match → `drifted` at the
   expected range, clamped to the region.
5. `missing` keeps the previous range if any, else `{ startLine: 0, endLine: 0 }`; consumers ignore it.

`makeAnchor(input, index, getText)` converts an `AnchorInput`: validates file/symbol, converts `find` to a
span (exactly one occurrence, else error), checks the span is inside the region, computes `hash`, and
sets `resolved` with status `ok`. `reresolveExplainer(explainer, index, getText)` re-resolves every anchor
(elements, steps, tour code overrides), rewrites `resolved`, updates `span` for `moved`, sets
`explainer.index`/`repo.commit`, and returns a report: counts by status, drifted **llm** elements (to be
re-explained, excluding `userFields`), and every missing anchor with its element id.

### 4.3 Element model and IDs

Structural ids: `repo`, `dir:<path>` (every directory containing an indexed file, root excluded),
`file:<path>`, `sym:<file>#<path>`. Parents: symbol → `sym:<parent>` or its file; file → its dir or `repo`;
dir → parent dir or `repo`. Stored ids: `grp:<slug>`, `concept:<slug>`, `edge:<slug>` (stored edges),
`view:<slug>`, `tour:<slug>`, `frame:<slug>`, steps `<view-slug>:<n>` (e.g. `dispatch:3`; never renumbered).
Derived: `edge:<kind>:<fromId>-><toId>`. Render-only: `ghost:<id>`, `stub:<in|out>:<insideId>-><ghostId>`.

`ExplainerModel(explainer, indexModel)` merges derived structural nodes with stored overlays (a stored node
with the same id overrides label/summary/detail/anchors/provenance) and indexes every element, step and
derived id. Default labels: repo name, dir/file basename, symbol's last path segment (methods keep
`Class.method`).

### 4.4 Graph derivation

- `repr(x, include)`: walk `x, parent(x), …, repo`; at each step return the element if included, else the
  first included group whose `members` contain it. Undefined → outside the view.
- A node renders as a **container** when it is included and some included node has it as `repr` of its
  parent chain.
- **Derived edges:** each index ref `(from, to, kind)` maps to `(repr(from), repr(to))`; skip if either is
  outside (→ stub) or both are equal. Kind map: call→calls, import→imports, extends, implements,
  type-ref→references, read→reads, write→writes. Aggregate per `(kind, a, b)` into
  `edge:<kind>:<a>-><b>` with `count`, `resolution` (`precise` if any ref is precise) and derived anchors
  (each site as `call-site`/`usage`, plus each target's definition), capped at 50 sites.
- **Stubs:** refs with exactly one end inside. Ghost target = the highest ancestor of the outside end
  (structural chain, below `repo`) that contains no included node. Aggregate per
  `(direction, insideId, ghostId)`. Only for shown edge kinds.
- `deriveGraph(view, model, { edgeKinds? }) → { nodes, edges, stubs }` with `nodes[i] = { id, label, kind,
  symbolKind?, container: boolean, parent?: containerId }`.
- `expandStub(view, stub)`: include += ghost target. `drillIn(view, id)`: include += children (node becomes
  a container). `collapse(view, id)`: remove its included descendants. `defaultInclude(scope, model)`: nodes
  exactly `depth` levels under `root`, plus shallower leaves (files/symbols with no children).

### 4.5 Code focus and reverse lookup

- `codeFocus(ids, model) → FocusRange[]` (`{ file, range, role, elementId, status }`): the union of each
  element's resolved anchors (missing ones excluded). Fallbacks when an element has no anchors: symbol →
  its range; file → whole file; dir → its files (cap 50); group → its members' focus; derived edge → its
  derived anchors.
- `buildReverseIndex(candidateIds, model)`: interval entries from `codeFocus` of each candidate.
  `lookup(file, line)` returns every element whose entry contains the line with the minimal line span
  (innermost wins; ties return all). Candidates = the active view's elements (included nodes, shown edges,
  or participants + steps) plus all concepts.

### 4.6 Validation (`validateExplainer(explainer, index, getText, { mode: "strict" | "lenient" })`)

Returns `{ severity: "error" | "warning", path, elementId?, message }[]`:

- ids unique (elements and steps share one namespace; views and tours each unique); prefixes as in §4.3;
  stored structural nodes' ids match their `kind` and exist in the index.
- Every referenced id exists or is derivable: `parent`, `members`, edge `from`/`to`, `related`,
  `include`/`hidden`/`participants`/`layout` keys, step `from`/`to`/`edge`, frame steps (same view,
  `fromStep` not after `toStep`), tour `view` and `focus`.
- Anchors: strict → every anchor resolves `ok`/`moved`; lenient (after regeneration) → drifted/missing are
  warnings.
- `llm` edges carry at least one anchor inside `from` and one inside `to` (file → same file; dir → under
  it; symbol → same symbol or a descendant; group → any member).

### 4.7 Patches

`applyPatch(explainer, patch, index, getText, { actor: "llm" | "user" }) → { explainer, issues, changed }`,
atomic (any error → nothing applied):

- Upsert by id. Existing `origin: "user"` elements are never modified or removed by `llm` (skipped with a
  warning). For `llm`, fields listed in `userFields` keep their existing values. For `user` edits of
  non-user elements, changed fields are added to `userFields`.
- New elements get `provenance = { origin: actor, commit: index.commit }` unless given.
- Anchors go through `makeAnchor`. Then `validateExplainer(strict)`; errors reject the whole patch.
- Views merge by id; sequence steps keep their ids.

---

## 5. CLI (`xpl`)

Global: `--root <dir>` (default cwd), `--json` (machine output), `--index <path>` (default: the index for
the current commit id, else the newest `.explainer/index-*.json`). `<id>` arguments accept `sym:…`,
`file:…`, `dir:…`, `src/a.ts#A.b`, `src/a.ts`.

| Command | Does |
|---|---|
| `xpl index [--precise auto\|off\|require] [--commit c]` | build + write index; writes `.explainer/.gitignore` (`index-*.json`); prints per-language summary |
| `xpl outline [--under <id>] [--depth n]` | dir/file/symbol tree with kind, lines, fan-in/fan-out |
| `xpl show <id> [--refs]` | code with 0-based offsets relative to the symbol (the numbers spans use), plus refs |
| `xpl refs <id> [--in\|--out] [--kind k] [--depth n]` | call/ref hierarchy with sites |
| `xpl search <pattern> [--regex]` | text hits with enclosing symbol id and offset |
| `xpl new <name> [--title t]` | create `.explainer/<name>.explainer.json` bound to the index |
| `xpl apply <explainer> <patch.json\|-> [--actor llm\|user] [--dry-run]` | §4.7; prints issues; exit 1 on error |
| `xpl validate <explainer> [--lenient]` | §4.6 |
| `xpl resolve <explainer> [--write]` | §4.2 re-resolve against the index; report drifted llm elements and missing anchors |
| `xpl status <explainer>` | to-do list for the skill: unexplained visible elements, drifted, missing, queued requests |
| `xpl view <explainer> [--port p] [--no-open]` | local server: viewer HTML, `GET /api/bundle`, `GET /api/file?path=`, `PUT /api/views/<id>` (applied as `user`), `POST /api/requests` |
| `xpl bundle <explainer> -o out.html [--mode explore\|present] [--tour id]` | self-contained HTML |

Bundle payload (also `/api/bundle`): `{ explainer, index, files: Record<FilePath, string>, mode, tour? }`,
embedded as `<script id="xpl-data" type="application/json">` (with `<` escaped as `<`). In server mode
`files` may be empty and the viewer fetches `/api/file` lazily.

---

## 6. Viewer (`@xpl/viewer`)

- Layout: header (title, view switcher, Explore/Present toggle, edge-kind toggles); left: diagram with the
  concept list and a details panel; right: file tree (collapsible) + stacked CodeMirror editors, one pane
  per file in the current focus (primary file first). Split is resizable.
- Graph view: elkjs `layered`, `hierarchyHandling: INCLUDE_CHILDREN`, containers for nested includes; heuristic
  edges drawn lighter/dashed-thin; stubs dashed to ghost boxes; click ghost → `expandStub`; double-click node
  → `drillIn`; context action to `collapse`.
- Sequence view: lifelines, arrows (`call` solid, `return` dashed, `async` open head), self-calls as loops,
  frames as labelled rectangles spanning their steps.
- Click any element (node, edge, stub, step, concept) → select → `codeFocus` → editors show focus ranges
  highlighted by role, everything else dimmed (`dimOthers`), scroll to first range; unrelated files greyed
  in the tree. Concepts co-highlight `related` elements.
- Cursor or selection change in an editor → `lookup(file, line)` → matching diagram elements and concepts
  get `is-match`.
- Present mode: tours; ←/→ steps; each step applies view, focus, code override and note (caption);
  file tree hidden; larger code area. URL params `?mode=present&tour=<id>&step=<n>`.
- Anchors with status `drifted`/`missing` are badged in the details panel.

**Test hooks (stable contract for Playwright):**

- Every clickable diagram/list element: `data-element-id="<id>"`; classes `is-selected`, `is-match`,
  `is-related`, `is-dimmed`. Stubs `data-stub-id`, ghosts `data-element-id="ghost:<id>"`.
- Editor panes: `[data-file="<path>"]`. Line decorations: `xpl-hl`, `xpl-hl-<role>`, `xpl-dim`.
- `window.__xpl = { select(ids), selection(), focus(), matches(), setCursor(file, line), setView(id),
  state() }`.

---

## 7. Skill (`skill/code-explainer`)

`SKILL.md` drives three operations through the CLI (`<skill-dir>/bin/xpl`):

- `explain <question | repo>`: ensure index → `outline`/`search`/`show`/`refs` to understand → write a
  patch (groups, labels, summaries, llm edges with evidence at both ends, concepts, a graph view and, for
  questions, a sequence view) → `xpl apply` (fix and retry on rejection) → `xpl view` or `xpl bundle`.
- `expand <node>`: drill a view into a node or a stub target; explain the new nodes.
- `make tour`: turn a view (or several) into a tour with notes.
- Regeneration: `xpl index` → `xpl resolve --write` → re-explain drifted llm elements (skip `userFields`,
  never touch `origin: "user"`) → surface missing anchors to the user.

Hard rules in the skill: never hand-write hashes or line numbers from memory (use `find` or `show`
offsets); every llm edge needs anchors at both ends; keep ids stable; never renumber steps.

---

## 8. Fixtures and acceptance

`fixtures/ts-jobrunner` matches the handoff example **exactly**: `src/runner.ts` with `Runner.dispatch` at
lines 42–88; offsets (relative to line 42) 4 = the `pop()` call, 18–19 = the `run(job)` call, 30–41 = the
retry block, 34–36 = the `requeue(...)` call; `Worker.run` offset 21 = the `job.completed` emit;
`metrics.ts#onJobCompleted`; `config/default.yaml` with the `retry` mapping at lines 13–16;
`test/retry.test.ts`. Python and Go fixtures implement the same design idiomatically (Go: several
packages under `internal/`, `cmd/jobrunner`). Each fixture has runnable tests using only its standard
toolchain (TS: `node --test` with type stripping).

Acceptance (Playwright, TS fixture bundle, `view:dispatch`):

1. Clicking step `dispatch:3` highlights the `requeue` call inside `Runner.dispatch` (runner.ts 76–78) and
   the `Queue.requeue` definition, and dims everything else.
2. Cursor on runner.ts line 77 (offset 35) → `dispatch:3` is the only `is-match`; cursor on line 73
   (offset 31) → `concept:retry-policy`.

Equivalent checks run against the Python and Go fixtures with their own explainers.

---

## 9. Build plan

| Phase | Work (one Sonnet agent each, parallel within a phase) |
|---|---|
| 1 | Scaffold: workspaces, configs, deps, `schema.ts` with §2 amendments, tree-sitter WASM smoke test |
| 2 | Fixtures ×3 · core (§4) · indexer framework + TS/YAML/JSON packs + heuristic resolver |
| 3 | Python pack · Go pack · SCIP precise refs · CLI · viewer (explore mode, stubs) |
| 4 | Example explainers ×3 + Playwright acceptance · skill + dry run on each fixture |
| 5 | Tours + present mode · regeneration flow end-to-end · README |
