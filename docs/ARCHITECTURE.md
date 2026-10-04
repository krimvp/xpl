# xpl — Code Explainer: architecture

What was built, and the contracts it was built against. `docs/handoff.md` is the original design brief
(schema draft in Appendix A, worked example in Appendix B). This file settles its open questions, amends
its schema, and fixes the algorithms and interfaces of every package. It was written before the code and
has been corrected to match it; where the two still disagree, fix one of them in the same change.

Target languages: **TypeScript/JavaScript, Python, Go** (plus YAML, JSON and TOML config keys).

```
source ── xpl index ──→ .explainer/index-<commit>.json ──┐   static analysis; generated, git-ignored
                                                         ├──→ xpl view | xpl bundle ──→ viewer
Claude ── patch.json ── xpl apply ──→ <name>.explainer.json ┘   what Claude and the user add; committed
git ───── xpl change ───────────────↗                          a change (PR): base, head, changed files, hunks
```

An explainer answers one of three scopes: a question about part of a project, a whole repo, or a change
between two commits. For a change, `xpl change` records the diff in the explainer and the viewer shows it.
`xpl draft` prints a patch skeleton built from the index (and the change), so Claude writes only the text;
`xpl lint` checks that text before and after it is applied.

---

## 0. Decisions (open questions from the handoff)

1. **Indexer: hybrid, not either/or.** tree-sitter (WASM, `web-tree-sitter`) extracts *structure* for every
   language: files, symbols, ranges, hashes and the syntactic *reference sites* (calls, imports, heritage,
   type positions, reads, writes). *Resolution* of a site to its target symbol comes from SCIP when the indexer
   can run (`scip-typescript`, `scip-python`, `scip-go`), otherwise from a scope-aware heuristic resolver.
   Every `Reference` records `resolution: "precise" | "heuristic"`, so the viewer draws heuristic edges
   lighter and Claude treats them as hints. Rationale: tree-sitter alone makes "static" edges guesses; SCIP
   alone gives no uniform symbol tree and fails hard when a tool is missing. The hybrid keeps one symbol
   model and upgrades edge trust where tooling exists: SCIP references replace the heuristic ones file by
   file (§3).
2. **Symbol-less code.** Config keys become symbols (`kind: "key"`, path = dotted key path, e.g.
   `config/default.yaml#retry.maxRetries`, `pyproject.toml#project.scripts.flask`), so YAML, JSON and TOML
   anchors use `symbol` like everything else: no new anchor kind. Truly symbol-less text (scripts,
   Dockerfiles, Markdown) keeps file-relative spans; the resolver re-finds moved spans by content (§4.2),
   which removes most of their fragility.
3. **Prototype target:** three fixture repos with the same design (a job runner) in TS, Python and Go
   (`fixtures/*-jobrunner`). The TS one reproduces the handoff example exactly (§8).
4. **Viewer packaging: both, one build.** The viewer is one static single-file app. `xpl view` serves it
   locally with live repo access (exploring real repos; persists view and tour edits as `user` edits;
   queues "explain this" requests). `xpl bundle` inlines the data and sources into one self-contained HTML
   file (sharing, presenting, offline; the default in cloud sessions).
5. **Editor: CodeMirror 6**, not Monaco. Read-only viewing plus line decorations is exactly CM6's model;
   Monaco's workers and ~5 MB don't fit a single-file bundle.
6. **Layout: dagre** (`@dagrejs/dagre`, MIT; layered) plus our own SVG with stable element IDs. Containers are
   laid out inside-out: each container's children as a level of their own, then the container as one box of
   the level above; edges get right-angled routes, spread ports and separate tracks (`layout/layered.ts`).
   (elkjs, the first choice, was replaced for its EPL-2.0 licence; dagre is about 40 KB against 1.6 MB.)
   Sequence diagrams use a small custom layout (lifelines are trivial). No Mermaid, no D2.
7. **Lazy explanations** are realised by the skill, and asynchronously: views get summaries for what they
   show; other nodes are explained on `expand`. The viewer cannot generate text itself. Its "Explain this"
   button queues a request in `.explainer/requests.json` (under `xpl view`; otherwise it shows the command
   to run), `xpl status` lists the queue, and the skill drains it.
8. **Changes: one index, at the head.** A change explainer describes the head of the change, the code the
   index was built from. The base is never indexed. Its text is read from git when it is needed
   (`git show <base>:<path>`): for base anchors, `xpl show --at base`, and the "before" side of the viewer.
   So base anchors take `find` or file spans, never symbols (§4.2). A second index would double the cost
   and the ids; the hunks and the base text are enough to check "before" claims and to draw the diff.
9. **Drafts without an LLM.** Most of an explainer is structure: boxes, steps, anchors, tour order.
   `xpl draft` builds that from the index and the change record, with `TODO:` in every text a person writes.
   Claude then writes and checks only the text. `xpl lint` reports each `TODO` left as an error.

---

## 1. Repository layout and conventions

```
package.json            npm workspaces root (ESM). Scripts: build, test, typecheck, test:e2e, format, format:check
tsconfig.base.json      strict, noUncheckedIndexedAccess, noUnusedLocals, ES2022, NodeNext
packages/
  core/     @xpl/core     schema types + pure logic (hash, anchors, derivation, validation, patches).
                          Browser-safe: no node:* imports. Used by indexer, cli and viewer.
  indexer/  @xpl/indexer  file discovery, tree-sitter language packs (WASM), heuristic resolver, SCIP importer.
  cli/      @xpl/cli      `xpl` command; esbuild bundle → packages/cli/dist/xpl.mjs, with dist/wasm/ (the
                          tree-sitter .wasm files) and dist/viewer.html (a copy of the built viewer) beside it
  viewer/   @xpl/viewer   React 19 + CodeMirror 6 + dagre; vite single-file build → packages/viewer/dist/index.html
skill/code-explainer/   Claude skill: SKILL.md, README.md, reference/ (quick.md, cli.md, patch-format.md, writing.md,
                        explain-change.md, examples/), bin/xpl (a symlink-safe node launcher for the built CLI)
fixtures/{ts,py,go}-jobrunner/   tiny real repos + committed explainers in .explainer/
docs/                   handoff.md, ARCHITECTURE.md, analysis-2026-09-30.txt, review-*.md (review notes),
                        review-2026-10-03-real-runs/ (the per-run reports of that review), images/
.explainer/             xpl's own explainer (xpl.explainer.json), checked by packages/cli/test/self-explainer.test.ts
AGENTS.md, CLAUDE.md    guidance for coding agents working on this repo (CLAUDE.md imports AGENTS.md)
.claude/skills/         skills for working on this repo (.agents/skills links here; code-explainer links to skill/)
.claude/hooks/          Claude Code hooks (registered in .claude/settings.json): session-start.sh, format-on-edit.sh,
                        stop-check.sh (AGENTS.md, Automation)
scripts/                pr-screenshots.sh (before/after viewer screenshots; packages/viewer/scripts/pr-shots.ts),
                        needs-screenshots.sh (does a change need them), publish-pr-shots.sh (push to pr-assets)
.github/                pull_request_template.md, workflows/ci.yml (checks, e2e, PR screenshots)
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
  `packages/cli/test/dead-exports.test.ts` fails on a production export that only tests use. On CI,
  Playwright retries a failed spec once for its trace, and a spec that passes on the retry fails the run.
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
   entry for it. All kinds are emitted: `call import extends implements type-ref read write`. A `read` is a
   use of a module- or package-level variable or constant, or of a field whose type is known, that is neither
   a call nor a write. A TS `import type` and a Python import under `TYPE_CHECKING` are `type-ref`, so
   `import` references are the runtime dependencies (§3).
4. `SymbolIndex` adds `languages: Record<string, LanguageInfo>` and `root?: string` (absolute,
   informational, never used for resolution). `LanguageInfo = { files, symbols, refs: "precise" |
   "heuristic" | "none", tool?, heuristicFiles? }`. `tool` names what produced the references
   (`scip-typescript@0.4.0`, `xpl-heuristic@… (tree-sitter-typescript@…)`); `heuristicFiles` counts the files
   of a precise language that keep heuristic references because the tool did not describe them (§3).
   `SymbolIndex.analysis?: AnalysisReport[]` records provider abilities separately from observed coverage
   (§3, Analysis coverage). Its reports describe the original run, including in pruned bundles. Relationship
   results record `resolution?: "precise" | "heuristic"` independently of support and reference counts;
   an absent resolution is unknown.
5. `IndexedFile.language: FileLanguage` = `typescript | tsx | javascript | python | go | rust | yaml | json | toml |
   text`.
6. `Edge.kind` adds `"references"` (lifted type-refs) and, for stored edges to related files, `"loads"`,
   `"discovers"`, `"configures"` and `"overrides"` (`EDGE_KINDS` in `ids.ts`; `related-files.ts` lists them).
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
11. `GraphView` adds `stubs?: { mode?: "top" | "all" | "none"; max?: number }` (`StubPolicy`): how many of
    the places where the view stops are drawn as ghost boxes. Default `top` / 8: the 8 most referenced ghosts,
    the outside symbols of partly shown files folded into one "rest of <file>" ghost, the ghosts beyond the
    8 into "+N more" (§4.4). `all` draws one ghost per outside element, `none` no stubs at all.
12. `Tour` adds optional `provenance` (the handoff's tours have none): new tours get `{ origin: actor, commit }`,
    the viewer's tour panel records `userFields` (`title`, `summary`, `steps`), and `applyPatch` protects a
    tour like any element (§4.7). A tour without one (an older file) counts as `llm`.
13. `SymbolIndex` adds `pruned?: { files, symbols, refs }`: the counts of the full index, set when `xpl bundle`
    embeds a copy with something dropped (§5, Bundle payload). Every file entry is kept, so `files` only repeats
    `files.length`; `symbols.length` and `refs.length` say what is left, and `languages` still describes the
    full index. Absent on a complete index, which is everything `xpl index` writes.
14. `Tour` adds `summary?: string`: 2-4 sentences of markdown, what the tour is about and why it matters (for a
    change: what behaves differently, the risk, the tests). Readers see it first, under the tour title. It is a
    user field like `title` (§4.7), and `null` in a patch clears it.
15. `Explainer` adds `change?: ChangeRecord`: the change the explainer is about (a PR or MR). Only `xpl change`
    writes it (§5); a patch that carries `change` is rejected. It sits right after `index` in the file.

    ```ts
    // base and head are full SHAs; head is the commit the index was built from
    interface ChangeRecord {
      base: string;
      head: string;
      files: ChangedFile[];
    }
    interface ChangedFile {
      path: FilePath; // the path at head; for a deleted file, its path at base
      status: "added" | "modified" | "deleted" | "renamed";
      oldPath?: FilePath; // renamed files only: the path at base
      hunks: ChangeHunk[]; // as `git diff -U0` prints them
    }
    interface ChangeHunk {
      oldStart: number;
      oldLines: number;
      newStart: number;
      newLines: number;
    }
    ```

    Lines are 1-based, as in git. A hunk replaces `oldLines` base lines from `oldStart` with `newLines` head
    lines from `newStart`. A count of 0 is a pure insertion or deletion, and the start is then the line after
    which it happened (0: at the top). Files come in git's order (sorted by path).
16. `Anchor` adds `at?: "base"`: a **base anchor** points at the code before the change, the base commit of
    `Explainer.change`. It has `file` and an optional `span` counted from line 1 of the base file; never a
    `symbol`, because the base is not indexed. `file` is always `ChangedFile.path` (a patch may name a renamed
    file by its old path; it is stored under the new one), so it is also the key into `ViewerBundle.baseFiles`.
    `resolved.commit` is the base SHA and `resolved.range` is in base lines. Only allowed in a changed file
    that has a base version (modified, renamed or deleted) and only when the explainer has a change record.
17. `SequenceView.type` may be `"flow"`: the same fields as a sequence, drawn as stages and decisions. A step
    adds `shape?: "stage" | "decision" | "terminal"` and `next?: { step, label? }[]` (labelled branches to
    steps of the same view; without `next` a step goes on to the next one, a `terminal` ends a path). A
    sequence view can be drawn as a flow too, in reading order (`processFlow`, `projected: true`). A `next`
    link may add `kind: "recurse"` (the steps from an earlier step run again, one level down; a step with only
    recurse links still goes on to the next one) or `kind: "return"` (back up one level, to `step`, or with no `step` to the caller; a
    terminal may have these). `SequenceView.layout?: "code-first" | "diagram"` overrides `codeFirstView`
    (viewer `workspace.ts`: code first when every step's code is in one file). A flow step whose first anchor
    is not inside its `from` gets a warning (a `return` step whose code is in `to` excepted).
    `Edge.via?: ElementId[]`: what an edge passes through without a box; an llm edge's evidence is per hop,
    and a hop the index shows (`hopRefs`) needs no anchors.
18. `SymbolIndex` adds `resources?: ResourceReference[]`: files that code loads or discovers by a literal path
    or glob (`readFile("x.json")`, `glob("plugins/*.py")`, an import of a `.json`), with `kind` (the indexer
    emits `loads` and `discovers`; the type also allows `configures`, `overrides`), the call `site`, the glob
    as `pattern` (`discovers`) and `resolution: "static" | "inferred"`. The viewer lists them as related
    files of the selection; a matching file does not prove it is loaded at run time.
19. `Node` adds three architecture fields, so an overview can read top-down like the C4 model (a system map,
    then the inside of one service, then code):
    - `role?: NodeRole`: `person | system | service | component | database | cache | queue | storage |
      external` (`NODE_ROLES` in `constants.ts`). The viewer draws each role with its own shape and shows the
      role (or `tech`) as the box's badge instead of the kind of code.
    - `tech?: string`: the technology in 1-3 words ("PostgreSQL", "REST API").
    - `opens?: string`: a view id, the next level down. The viewer zooms into it from the box and shows a
      trail back up (`levels.ts`: `opensView`, `parentLevel`, `zoomTrail`; the level above a view is the first
      graph view that includes a box opening it).

    A group with a `role` may have no `members` (a database or an outside API is not code of the repo); it is
    then anchored at the code that talks to it, and `containsCode` counts its own anchors as its code, so an
    `llm` edge to it finds its evidence there. On a view that shows a group instead of the boxes a stored edge
    ends on, stored edges lifted to the same pair of boxes and kind are drawn as one (§4.4).
20. `Explainer` adds `scope?: ExplainerScope` = `{ audience?: string }`: who the page is for and how deep it
    goes, one line (at most `AUDIENCE_MAX` = 120 characters) shown under the title. Not a view's `Scope`. A
    patch's top-level `scope` is merged in; `null` (for it or for `audience`) clears.

Patch-side types (never stored) live in `packages/core/src/patch.ts`; its header holds the authoritative
merge rules and `skill/code-explainer/reference/patch-format.md` is the practical guide. What Claude writes:

```ts
/** `applyPatch` turns it into a stored Anchor (hash + resolved filled in). */
interface AnchorInput {
  file: FilePath; symbol?: SymbolPath; role: AnchorRole;
  span?: { from: number; to: number };  // 0-based line offsets from the symbol's first line, inclusive
  find?: string;   // alternative to span: text that occurs exactly once in the symbol (or file); may be multi-line
  at?: "base";     // the code before the change: find, or a span from line 1 of the base file; no symbol
  hash?: Hash;     // optional; if given it must equal the current hash (catches stale drafts)
}
interface ExplainerPatch {
  title?: string;
  scope?: { audience?: string | null } | null;
  nodes?: PatchNode[]; edges?: PatchEdge[]; concepts?: PatchConcept[];
  views?: PatchView[]; tours?: PatchTour[];
  remove?: string[];  // element / view / tour / step ids
}
```

- **Patch elements are partial.** `id` is the only required field of an existing element, view or tour. Absent
  fields keep their values; `null` clears an optional field (`summary detail members related via edgeKinds
  hidden excludeFiles stubs layout frames`); arrays and nested objects (`members include steps scope layout …`)
  replace wholesale. A sequence view's `steps` are sent whole (keep every step id; `remove` deletes single
  steps), or edited by id with `stepsUpdate` (below). Unknown fields are errors. `provenance` is optional: new
  elements get `{ origin: actor, commit }`.
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
- Sequence views also take `stepsUpdate` (patch-only, never stored): a list of `{ id, …fields }` shallow-merged
  into the existing steps with those ids, so one step's summary or anchors change without resending the rest
  (the other steps, the frames and the tours that point at them are untouched). The fields are a step's;
  `anchors` are `AnchorInput`s and replace that step's anchors wholesale, `null` clears `summary` or `edge`,
  `id` is the key. It applies after `steps` when both are sent and only to an existing view (a new view
  sends `steps`). An id that is not a step of the view is an error that names the view's steps (or the view
  the step belongs to), a step twice in the list is an error, and an `llm` patch skips it (`protected`) when
  the user edited the view's `steps` (§4.7).
- Tours in a patch carry `AnchorInput`s in a step's `code` override (`PatchTourStep`); a stored tour is a
  valid patch too. `summary` is optional on a new tour, and `null` clears it.
- Tours also take `stepsUpdate` (patch-only): `[{ id, …fields }]` merged into the tour's steps with those ids.
  The fields are `view`, `focus`, `note`, `code` (`AnchorInput`s, replacing the step's override) and `editor`;
  `null` clears `note`, `code` or `editor`. The rules are those of a sequence view's `stepsUpdate`: after
  `steps`, only for an existing tour (a new tour sends `steps`), an unknown id is an error that names the
  tour's steps, and an `llm` patch skips it (`protected`) when the user edited the tour's `steps`. `changed`
  names such a step `<tour id>/<step id>`. One note is fixed without resending the tour.
- `find` is matched exactly first, then with runs of whitespace collapsed. Zero or several matches are
  errors that say where. `span` and `find` are mutually exclusive.
- `at: "base"` anchors read the base file instead (§4.2). A `symbol` there is an error that says to use
  `find` or a span (`xpl show --at base <path>` prints the offsets). So is a file the change did not touch or
  added (its code before the change is its current code, or nothing), and a base anchor in an explainer
  without a change record.
- Markdown: a tour `summary`, a step `note` and a `detail` are markdown. The `summary` of an element or a step
  may use inline markdown (code spans, bold, emphasis). Titles and labels are plain text. `xpl lint` checks
  this split (§5).

---

## 3. Indexer (`@xpl/indexer`)

```ts
buildIndex(opts: { root: string; commit?: string; precise?: "auto" | "off" | "require";
                   languages?: string[]; providers?: readonly IndexProvider[] })
  : Promise<{ index: SymbolIndex; warnings: string[] }>
writeIndex(root: string, index: SymbolIndex): Promise<string>
// atomic write of <root>/.explainer/index-<commit>.json; keeps `index-*.json` in .explainer/.gitignore
```

Pipeline: discover files → per file: read, hash, parse once, `pack.extract`, free the tree → assemble symbols
(ids, `~N` suffixes, whole-line ranges, hashes, parents) → heuristic resolution of every site, plus the packs'
`inferRefs` → providers normalize and merge declarations and references by capability and file → commit id → `SymbolIndex`. `tool` =
`xpl-indexer@<v> web-tree-sitter@<v> <grammar>@<v> …`. A file with syntax errors is indexed anyway: one
warning covers them all and names the first lines (`N file(s) have syntax errors; symbols near these lines may
be incomplete: a.ts:12,40`; at most 5 files and 3 lines each), and errors a pack knows cost no symbol are not
reported (`errorInTypePosition`: the TS grammar cannot read a labelled tuple element such as `[symbol:
string]`, and its recovery stays inside the tuple; for the JSON pack, the trailing commas of JSONC). Files under
`testdata/`, `fixtures/` or `__fixtures__/` are never reported. An extraction failure is a warning and a file
without symbols. References are sorted by file, position and kind. The same walk collects resource sites
(`resources.ts`, TS/JS, Python, Go: literal paths and globs passed to file-reading and glob calls, relative
imports of `.json`/`.yaml`/`.toml`), resolved against the indexed files into `SymbolIndex.resources` (§2.18).
`providers` replaces the additional provider registry (syntax and semantic; tests inject fakes).
`languages` restricts the build to some `FileLanguage`s (the CLI does not expose it).

**Files.** `git ls-files --cached --others --exclude-standard` when `root` is inside a git work tree (limited
to the root's subtree), otherwise a walk that skips `.git node_modules dist build out vendor target
__pycache__ .venv venv .explainer` and dot-directories. In both modes `.explainer/`, `node_modules/` and
`.git/` are never indexed (`.explainer/` would feed our own index back into the working-tree commit id).
Dropped silently: binaries (NUL in the first 8 KB), files over 1 MB, symlinks and submodule directories, files
deleted but still tracked, and lockfiles (`*-lock.json`, `*.lock`, `go.sum`, `pnpm-lock.yaml`,
`npm-shrinkwrap.json`). Every remaining text file is an `IndexedFile` (unknown extensions → `text`), so
file-relative anchors work anywhere. Language by extension: `.ts .mts .cts` typescript, `.tsx` tsx, `.js .mjs
.cjs .jsx` javascript, `.py .pyi` python, `.go` go, `.rs` rust, `.yaml .yml` yaml, `.json` json, `.toml` toml.
Paths are POSIX, repo-root-relative, sorted.

**Commit id.** `--commit` wins (letters, digits, `.`, `_`, `-` only: it becomes part of a file name). Else, if
`root` is the git top-level and the work tree is clean (ignoring `.explainer/`): short HEAD (7 chars). Else
`wt-` + first 10 hex of sha256 over the sorted `path\0hash\n` list: deterministic, which is why fixtures
living inside this monorepo get stable ids.

**Language packs** (`src/languages/<lang>.ts`, the larger ones split into `<lang>/`; registry in
`languages/index.ts`). A pack turns one parsed
file into plain facts. It never assigns ids, `~N` suffixes, hashes or parents, and never resolves anything:
the framework (`build.ts`, `symbols.ts`) and the language-agnostic heuristic resolver do.

```ts
interface LanguagePack {
  id: string; languages: FileLanguage[]; grammarFor(language): GrammarId;
  capabilities: AnalysisCapabilities; // advertised abilities; a missing capability key means unsupported
  extensions?: string[];               // `text` files this pack parses too (a format with no FileLanguage of its own; none does now)
  packageScope: "file" | "directory";  // how far a top-level name is visible without an import (Go: the package dir)
  importsReexport?: boolean;           // a module's imports are importable from it (Python `__init__.py`)
  offByDefault?(path, repo): boolean;  // a default build leaves the file out (Go build constraints): tried last
  refs: "heuristic" | "none";          // does the pack emit sites (references are derived from them)?
  extract(ctx: FileContext): FileFacts;                        // one walk of the syntax tree
  classifySite(ctx, line, col): ClassifiedSite | undefined;    // the same rules as extract, for SCIP occurrences
  resolveModule(spec, fromFile, repo: RepoView): FilePath[];   // import specifier → repository files ([] = external)
  submoduleSpec?(module, name): string | undefined;            // Python: `from pkg import sub` may name module pkg.sub
  errorInTypePosition?(error: Node): boolean;  // a syntax error inside a type expression that cost no symbol: not reported
  inferRefs?(input): InferredRef[];    // references no single site expresses (Go: implicit interfaces)
}
interface FileFacts {
  symbols: SymbolDraft[]; sites: SiteDraft[]; imports: ImportBinding[]; typeFacts: TypeFact[];
  exports?: ExportFact[]; warnings?: string[];
  data?: unknown;  // pack-private input of inferRefs; never stored
}
```

- `capabilities` declares each independent ability as `supported` or `partial`. A missing key means
  unsupported; it does not mean an empty result. Per-file extraction outcomes record observed limits separately.
- Positions are `Span`s: 1-based inclusive lines and columns in UTF-16 (`nodeSpan`/`spanBetween` convert
  tree-sitter's points). A pack must not keep tree nodes: the tree is freed right after `extract`.
- `SymbolDraft { path, kind, range, parentPath?, anchorOnly? }`: dotted, pre-dedup paths. `anchorOnly` marks a
  symbol that exists to be anchored and outlined and is never referenced by name (a TS test block: its title
  is not a name in the code): the resolvers leave it out of name lookup, so `describe("Queue")` cannot capture
  `Queue()` from the code under test, and no reference points at it; it still is the `from` of the references
  inside it. Not stored in the index.
- `SiteDraft { kind, name, qualifier, site, local? }` (`kind`: `call import extends implements type-ref write read`):
  `qualifier` is the receiver chain left to right, with the receiver normalised to `"this"` (TS `this`, Python
  `self`/`cls`, the Go receiver variable; TS `super` stays): `this.pool.lease()` → `["this", "pool"]`,
  `lease`. `x()` in a chain is the result of calling `x`, `:T` a value of declared type `T`. A receiver the
  pack cannot spell (`arr[0].run()`) yields no site. `local`: a bare name that something around the site binds
  (a local callable, a callback parameter, a nested function); it resolves only through the scope chain.
- `ImportBinding { localName, module, importedName?, site, typeOnly? }`. `typeOnly`: TS `import type { A }` /
  `import { type A }`, Python imports under `if TYPE_CHECKING:` (that branch, `elif` included): erased at run time,
  so the reference made for it is a `type-ref`, not an `import`.
- `TypeFact { scopePath, name, kind: "field" | "param" | "local" | "return", typeName?, initCall?, initChain?,
  visibleIn? }`: the declared or inferred type of a field, parameter, local or return value (generics
  stripped, `T | undefined` → `T`, `Promise<T>` unwrapped for returns). `initCall`: the value is the result of
  that call (the resolver follows it to the callee's return type). `initChain`: an alias of a receiver chain
  (`const q = this.queue`). `visibleIn` narrows where a name is in scope (a callback's parameters, a
  block-scoped `const`, Go's scoping); the resolver prefers the innermost fact.
- `ExportFact { name, localName?, module?, importedName?, site?, typeOnly? }`: what a module exposes beyond its
  top-level symbols (every top-level symbol counts as exported): `export { A as B }`, `export default X`,
  re-exports (`export … from`, which also yield an `import` reference, or a `type-ref` when `typeOnly`:
  `export type { A } from`), `export *`, Python `from x import *` and the submodule exports of a package's
  `__init__.py`.
- `ClassifiedSite { kind, site, bare? }`: what `classifySite` says about one position. `bare`: a `read` of a bare
  name (`LIMIT`), not of a member (`this.limit`): the name is a variable or constant, never a field (the SCIP
  mapper uses it, below).

**Symbols.** Duplicate paths within a file get `~2`, `~3`… in source order (assigned by the framework).
`IndexedSymbol.hash` = `hashText` of the symbol's full lines; `IndexedFile.hash` = `hashText` of the whole
file.

**Independent providers** (`src/providers.ts`). `IndexProvider` is the external seam for source-backed
facts. `TreeSitterProvider` and the SCIP providers implement it. Providers may parse the supplied text,
consume an artifact, or run a tool. No tree-sitter node or language-pack parser is required by the interface.
Additional syntax providers always run, including with `precise: "off"`; semantic providers honor precise
mode. `require` needs explicit precise relationship coverage for programming languages, including Rust.
The old `PreciseResolver` interface and registry were removed; `providers` is the build option.

```ts
interface IndexProvider {
  id: string; mode?: "syntax" | "semantic";  // omitted = semantic
  languages: readonly FileLanguage[]; capabilities: AnalysisCapabilities;
  analyze(input: ProviderInput): Promise<ProviderOutput>;
}
// Input: root, scoped languages, captured sources {path, language, text}, indexed files,
// existing canonical symbols (full columns when known), SymbolLookup, cached readText, warn,
// and an optional classify(file, candidates) callback returning plain site/module/statement facts.
interface ProviderOutput {
  provider: string; version: string; tool: string; configuration: string;
  sourceHashes: Readonly<Record<FilePath, Hash>>;
  declarations: readonly ProviderDeclaration[];
  relationships: readonly ProviderRelationship[];
  analysis: AnalysisReport[];
  blind?: readonly { file: FilePath; line: number; col: number }[];
}
// Declaration: identity, file, name, optional pre-dedup path and parent identity, kind,
// optional identifier and full declaration ranges. Syntax adapters may use parentPath/anchorOnly.
// Relationship: from/to identities (or existing canonical IDs), file, kind, evidence, resolution.
// ProviderRange: zero-based [line,column] start/end, end exclusive, encoding utf8 | utf16 | utf32.
```

`normalizeProvider` checks consumed-source hashes against the snapshot, converts positions without clamping,
checks identifier spelling and its containment in the declaration, assigns canonical `<file>#<path>` IDs and
source-ordered `~N` suffixes, and hashes the full declaration lines. Provider-local identities map to those
IDs; explicit parents disambiguate duplicate paths. Identifier-only facts never become checked symbol
anchors. No full declaration is inferred from an identifier extent. Unknown kinds, missing endpoints and
invalid evidence are diagnosed and dropped, with the file removed from replacement coverage.
When syntax spans end on an empty line, `providerRange` restores the consumed newline's end-exclusive
position instead of treating the widened inclusive column as a character on that line.

`mergeProvider` replaces relationships only for the advertised kinds and explicitly analyzed files of
supported or partial results. Failed, unsupported and unexamined scopes keep previous hints. Checked node
replacement requires both symbols and declaration ranges; range-only coverage updates existing nodes without
changing their identities. Nesting changes only under explicit nesting coverage. A blind occurrence preserves
the smallest enclosing heuristic hint. Source and resolution provenance remains on each fact; report version,
configuration and snapshot identities remain in the index and bundles. No format alone determines trust:
each relationship explicitly says `heuristic` or `precise`. A generic reference is not converted to a call.
Relationship coverage also records resolution, including empty results. Language summaries and `require`
use the latest successful replacement of each file/kind: only explicitly precise relationship coverage
qualifies, scoped to that file's language. Structural coverage and heuristic facts cannot establish precision;
emitted heuristic facts override a contradictory precise coverage label for their file/kind.

Partial coverage is successful analysis with stated omissions; an empty result says nothing about completeness.
An exception becomes a failed report for every advertised capability in `auto` mode, preserving prior checked
facts. Structural-provider failures record symbols, ranges and nesting as failed too. `require` fails for a
missing provider, an exception or a language without usable explicitly precise relationship analysis.
Reader summaries omit provider commands and diagnostics. Structural and relationship abilities remain independent.

Cost and reuse: the syntax provider parses each source once for extraction; heuristic resolution stays inside
it. SCIP runs per repository/project/module, with the timeout and fallback policy below, and may reparse sources
through the optional plain classifier. The syntax adapter owns that reparsing. Both adapters use the same
normalization and merge functions. The run snapshot covers indexed source and configuration files; configured
external artifacts must report hashes of the source they actually consumed, not stamp current hashes onto old
facts. The built-in SCIP adapters check source/config hashes before and after tool execution, including changes
that leave positions in bounds. They cannot detect a file changed and restored during execution. `configuration`
names the adapter's active profile (`builtin-packs` or `tool-defaults`); snapshot identity covers captured files.
Toolchain/environment dependencies outside that snapshot are not reusable evidence. No cross-run cache is added:
reuse is safe only when source, provider version and relevant configuration/dependency identities agree.

The built-in tool adapters keep SCIP relationship mapping over existing syntax declarations. The separate
`scipArtifactProvider({ artifact, manifest?, languages? })` imports declarations without a language pack.
The CLI selects it with `xpl index --scip <artifact|manifest.json>` instead of automatic semantic tools,
retaining registered syntax-mode providers first. Artifact import can then replace their declarations where
source-verified coverage allows it. In a mixed repository, `require` still needs precise relationships for
Rust; an artifact covering only other source files cannot make Rust satisfy that requirement.
Unknown extensions keep the closed `FileLanguage` value `text`; imported symbols work in outlines, queries,
checked anchors and bundles. `--precise off` skips semantic providers; combining it with `--scip` is an error.

**Artifact evidence and losses** (`src/scip/artifact.ts`). Each document needs source evidence: embedded
`Document.text`, or a manifest's pre-generation xpl source hash. The evidence must match the captured source.
Protobuf string decoding preserves a leading BOM as source content; adding or removing it changes the hash.
A manifest binds the exact artifact bytes with `artifactSha256` and names the artifact for the CLI (relative
to the manifest). Missing or stale evidence excludes that document from every replacement capability.
Absolute, non-canonical, undiscovered and generated paths are excluded, even when a file exists on disk.
A supplied `project_root` must be a file URI for the indexed root; an absent root uses document paths.
The manifest is an author attestation, not proof of successful compilation. Capture source hashes before
generation, check them after a successful run, and use a fresh output path. Never attach current hashes to
an old artifact. Dependency/toolchain changes outside the captured files are not verified by this policy.

Only definition occurrences with full `enclosing_range`, valid positions and identifier evidence become
symbols. Identifier-only/synthetic definitions are filtered before normalization so one omitted definition
does not discard valid coverage. Symbol replacement supplies the file's entire retained set, with partial
coverage and explicit omissions; it does not append to syntax declarations. Kinds map to xpl's coarse kinds;
unknown kinds become `other` with diagnostics. Descriptor paths preserve nesting; overload identities stay
distinct while canonical duplicate paths receive source-ordered `~N` suffixes. Reordering overloads can
change their IDs. Locals are scoped to the document. Explicit parents or exact descriptor prefixes (including
overload tags) require checked same-file containment. Missing parents are omitted and nesting stays partial.
Ambiguous repeated definitions and paths containing canonical ID punctuation are diagnosed and omitted.

Position encoding must be explicit in the document, or verified and recorded as the manifest's
`defaultEncoding` (`utf8`, `utf16`, `utf32`). Source text encoding is separate and cannot establish columns.
Strict conversion rejects offsets inside Unicode characters and outside source, rather than clamping them.
Only role-backed reads, writes and imports, and mentions of known types, become precise relationships.
Other occurrences become `blind` and retain applicable heuristic hints. SCIP roles cannot classify calls;
the importer reports calls as unsupported. `SymbolInformation.relationships` are diagnosed and omitted:
implementation/override flags cannot establish class inheritance or relationship direction by themselves.
External symbols and accessor targets without checked definitions never create local declarations.
Reports remain partial, including empty results. Producer ranges may omit leading documentation; the importer
never substitutes an identifier extent for a full declaration. The CLI reference documents generation and
manifest creation. Java tool orchestration and a Java language identity belong to #14.

Rust's syntax-only `TagsProvider` (`src/tags.ts`, `src/tags/rust.ts`, `rust.scm`) uses the standard
`@name` and `@definition.*` convention through the same provider normalization. Its corrected query captures
each declaration once, adds trait signatures, consts/statics and generic/scoped impl blocks, and preserves
enum/type-alias kinds. Ordered tag containment supplies lexical parents. Functions directly under tagged
traits/impls become methods; module functions remain functions. Impl paths preserve their receiver and trait
(`impl Runner<Q>.dispatch`, `impl JobQueue for Queue.pop`); methods are children of the impl, not the receiver
struct. Repeated paths are numbered in source order with explicit parent identities. Multiline receiver
labels collapse whitespace; those compound names have full declaration evidence but no identifier span.

Rust uses `tree-sitter-rust@0.24.0` (WASM ABI 14). The CLI copies the corrected query beside its grammar in
`dist/wasm`; source runs read it from the adapter directory. Rust reports partial symbols, declaration ranges
and nesting, and unsupported relationship kinds. It does not resolve calls, imports, receiver ownership or
external `mod` links, expand macros, evaluate cfg, or index fields, variants and local bindings. Declaration
ranges exclude leading attributes and doc comments. Syntax recovery adds a limit and a warning. Matching
tags outcomes share one report with combined file counts; syntax-error files keep a separate report.
[The experiment record](rust-tags.md) gives literal cases, measurements, query coverage and repeatable commands.

**Analysis coverage** (`core/src/analysis.ts`, `indexer/src/analysis.ts`). An `AnalysisReport` contains a
stable `provider` id, advertised `capabilities`, scoped `files`, and observed `results`. Capabilities are
independent: `fileAnchors`, `symbols`, `declarationRanges`, `nesting`, and each `Reference.kind`.
Advertised values are `supported` or `partial`; a missing key means unsupported. A result groups
capabilities with the same `status` (`supported | partial | unsupported | failed`), `resolution`,
`analyzedFiles`, and reader-facing `limitations`. Optional `diagnostics` retains author-facing warnings and
failure reasons, which reader summaries do not render. Grouping avoids repeating identical file lists. This is provider-agnostic
data in core; `IndexProvider` in the indexer returns these reports unchanged before source checks.

All indexed files get file anchors. Configuration packs provide key symbols, ranges and nesting without
relationships. Programming packs provide heuristic relationship hints; Python's heuristic pack has no
`implements` analysis (the precise provider can read implementation relationships). Go's declaration ranges
are partial because some type ranges omit leading syntax. Syntax
errors and extraction limits produce partial outcomes; config packs warn when keys exceed depth 6,
structure exceeds nesting depth 64, or the file exceeds 2000 keys. Only affected files become partial.
Extraction failures retain file anchors and record failed source analysis. Precise attempts record failures
even after heuristic fallback.
`IndexProvider.capabilities` declares supported kinds; missing keys are unsupported. Replacement preserves
heuristic references for kinds the provider does not support. `AnalysisReport.results` explicitly records
which kinds and files were examined. The SCIP adapters use `relationshipOutput` to convert their mapped
occurrences and per-kind observations into provider facts and the existing report. Described files and empty
reference lists establish only partial coverage. Explicit unsupported or failed observations retain their
status independently of advertised ability. Explicit success still becomes partial when files are missing,
the ability is partial, or occurrences cannot be linked. The SCIP providers remain conservative:
describing a document is not a completeness claim.

Compatibility: the index schema stays `code-explainer/index@0`. `analysis`, the shared
`providers: { id, version }[]` table and fact `provider` positions into it are optional so older indexes still
load. Reports optionally retain `version`, `configuration` and `snapshot` identities. No abilities or complete
outcomes are inferred from language names, symbols, ranges or reference counts; legacy coverage is unknown. File anchors remain available for their indexed files.
Pruning and packing preserve reports unchanged, so missing bundle edges never alter run coverage.
`describeAnalysis` produces the same reader-facing summary for the CLI and viewer. Each capability result
names its provider id, so a file-only fallback's limits do not describe a separate artifact provider's symbols.
Tool commands and diagnostic details remain author-facing.

| Language | Symbols (kind) | Path rules |
|---|---|---|
| TS/TSX/JS | class (also a class expression bound to a const, an anonymous default export), interface, type alias (`type`), enum (members are not symbols), function and generator declarations, `const/let/var` declarators (arrow/function initialiser → `function`, else `variable`; destructured names too), class members (methods incl. constructor/get/set/abstract → `method`; fields → `variable`, **except fields initialised with an arrow or function, which are `method`**), interface members (method signatures → `method`, property signatures → `variable`), functions nested in functions or methods (declarations, and `const/let/var` with an arrow/function initialiser that are statements of the body), methods and function-valued properties of top-level object literals (`method`), namespaces (`other`) | `Class.member` (`#private` keeps its `#`, `[Symbol.iterator]` → `@@iterator`), `outer.inner`, `obj.key`, `NS.name`; anonymous default export → `default`; body-less overload signatures are skipped when an implementation follows, ambient declarations are kept; `declare module` / `declare global` members are listed as top-level; **test blocks**: statement-level `describe` / `suite` / `context` / `it` / `test` calls with a string title (also `.only`, `.skip`, `.each(table)(…)`) are `function` symbols whose path is the titles nested by `describe`, each with `.` and `#` replaced by `_` (`Queue.pop().returns the oldest job`) and whose range is the whole statement; they are `anchorOnly`, and a block whose path equals a real symbol's is dropped |
| Python | class; `def` / `async def` (`function`; directly in a class body → `method`); module- and class-level simple assignments (`variable`; also annotation-only `id: str`; each name of a tuple target; in `if`/`try`/`with` blocks the first assignment of a name the file does not import); `type X = …` (`type`) | `Class.method`, `outer.inner`, `Class.Inner.method`; the range starts at the first decorator; definitions inside `if`/`try`/`with`/`for`/`while`/`match` belong to the scope around them; `if __name__ == "__main__":` is skipped; `@overload` stubs are skipped; `@x.setter` gives `x~2` |
| Go | `func` (`function`); methods (`method`, path `Recv.Name`, pointer receivers and type parameters stripped); `type` declarations (struct → `class`, interface → `interface`, anything else, aliases included → `type`); struct fields (`variable`, `Type.field`, nested anonymous structs `Type.field.sub`); interface methods (`method`); top-level `var`/`const` specs (`variable`, one per name, `_` declares nothing) | a method is a child of its receiver type only when that type is declared in the same file; **a type symbol's range starts at its name** (not at `type`); **embedded struct fields and interface elements are not symbols but `extends` sites**; function-local types and closures are not symbols |
| YAML/JSON | mapping keys (`key`) | dotted key path; sequence items by index (`workers.0.name`); at most 6 levels of keys and 2000 keys per file (one warning beyond); a key's range is its whole `key: value` pair; YAML merge (`<<`), empty, complex and alias keys are not symbols |
| TOML | tables and pairs (`key`) | dotted key path: `[project.scripts]` + `flask = "…"` → `project.scripts.flask`; a table's range is its header and the pairs up to the next header (a table that is only implied, `a` in `[a.b]`, is not a symbol); a dotted key `x.y = v` is one symbol (the pair); an array of tables addresses its elements by index (`fruits.0.name`); inline tables and arrays as in YAML; quoted keys are unquoted; at most 6 levels of keys and 2000 keys per file |

**Reference sites.** Each pack emits syntactic sites `{ kind, name, qualifier, site }` for calls (including
`new X()`, composite literals, JSX components, Python decorators), imports without a binding (`import "./x"`,
`import("./x")`, `require("./x")`), `extends` / `implements` (Python class bases and Go embedded fields are
`extends`), type positions (`type-ref`), assignments to fields and module variables (`write`) and reads
(`read`): a use of a module- or package-level variable or constant (`LIMIT`, `config.LIMIT`), or of a field of
a value whose type is known (`this.queue`, `job.attempts`), that is not a call, a target or a declaration.
Locals and parameters are not references: the pack leaves out a bare name that a function, block, loop,
`catch`, comprehension or class body around the use binds, and the resolver decides the rest (only variables
and fields count; in both modes a function or method used as a value, such as a callback or Go
method value, remains a `read`, which does not establish invocation or recursion. A class or enum used as a value, such as `x instanceof C`,
`isinstance(x, C)` or `Color.Red`, is a `type-ref`, as in precise mode). A Python `metaclass=M` is a `type-ref`. A call or assignment spanning more than
10 lines is reported by its callee or target only. `from` is not given by the pack: the framework takes the
innermost symbol containing the site's start (line and column), else the module scope `"<file>#"`.
`classifySite(ctx, line, col)` applies the same rules to one position, so SCIP occurrences are classified
exactly like sites.

**Heuristic resolution** (`src/resolve/heuristic.ts`), for a site `qualifier.name`, in order:

1. no qualifier: the lexical scope chain (nested functions, namespaces), then the file's top-level symbols,
   then import bindings (through `resolveModule`, following re-exports), then star exports, then, for
   `packageScope: "directory"` languages (Go), the top-level symbols of the other files of the directory.
   A `local` site resolves through the scope chain only (a callback parameter `fact` is not the module's);
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
   class the file imports, then the same directory (Go: the same package before the imports). Ambiguity
   drops the site. Calls and writes only.

A `read` site resolves by 1–4 to a variable, field or function value; a class or enum becomes a type reference, and the nearest member of that name decides (a property that overrides a base-class attribute is not
a variable, and the attribute below it is out of reach). An import binding marked `typeOnly` yields a
`type-ref` reference instead of an `import`.

Receivers whose type is known but outside the repository (`Map`, `Promise`, a bare npm import) are opaque:
nothing is guessed. Unresolved sites and self-references are dropped, except a call of a symbol from inside itself:
recursion is a `call` reference with `from === to`. Module resolution (`resolveModule`):
TS relative specifiers with extension and `index` probing (`.js` → `.ts`), `tsconfig`/`jsconfig` `paths` and
`baseUrl` (with relative `extends`), workspace packages by `package.json` name (entry through `exports`/
`types`/`module`/`main`, build output mapped back to source) and `imports`; Python dotted and relative
imports, `src/` layouts, nested project roots and namespace packages; Go every `go.mod` in the repository
(module path → package directory, local `replace`s), a package's files being one namespace.

Not handled: overload resolution, generics and type arguments, union types, control-flow narrowing, locals
reassigned to another type, dynamic access, CommonJS `module.exports` shapes. Go: inference beyond the
evident (no signatures or generics, no element types of slices and maps, one type for a multi-value call),
function-local types, cgo, vendor directories (build constraints: a file a default linux/amd64 build leaves out
is tried last). Python: instance attributes
assigned only in methods are not symbols, so writes to them are not linked.

`inferRefs` (Go) adds `implements` references for implicit interface satisfaction: a type implements an
interface when its method set (own methods across the package's files, plus promoted ones) covers the
interface's, matched by name and a coarse signature check (parameter and result counts and shapes);
unexported names count within one package only; empty interfaces, constraint interfaces and interfaces with
an unresolvable embedded element (`io.Reader`) are skipped.

**Precise resolution** (`src/scip/`). For each language present that a provider covers, the SCIP indexer runs
with a timeout (10 minutes, `XPL_SCIP_TIMEOUT_MS`), writing to a temp directory that is removed afterwards;
`index.scip` is decoded by a small hand-rolled protobuf reader (no generated code). Commands as run:

| Tool | Command |
|---|---|
| scip-typescript 0.4.0 (typescript, tsx, javascript) | `npx --yes @sourcegraph/scip-typescript@0.4.0 index --cwd <root> --no-progress-bar --output <tmp>/x.scip <projects>`, projects = every directory with a `tsconfig.json` (or the `jsconfig.json` of one without). Never `--infer-tsconfig`: it writes a tsconfig into the repository and then indexes only `.ts`. Files no project includes (all of them without a tsconfig) get a **second pass** with a synthetic tsconfig kept in the temp directory; so do all files when a tsconfig cannot be loaded (its `extends` package is not installed). |
| scip-python 0.6.6 | `npx --yes @sourcegraph/scip-python@0.6.6 index --cwd <root> --project-name <n> --project-version 0.0.0 --environment <tmp>/environment.json --quiet --output <tmp>/index.scip`. The version keeps it from crashing outside git, the empty environment (`[]`) skips its `pip` introspection, and the repository's package roots (`src/`, nested projects) go on `PYTHONPATH` so that `import flask` resolves to `src/flask`. |
| scip-go v0.2.7 | `go run github.com/scip-code/scip-go/cmd/scip-go@v0.2.7 index --output <tmp>/module-N.scip`, once per `go.mod` (the module moved from `github.com/sourcegraph/scip-go`, which stops at v0.1.26). Needs Go ≥ 1.25: an older `go` downloads the toolchain on first use, which needs network access. `GOFLAGS=-mod=mod` unless there is a `go.work` or a `vendor/` directory; Go runs against a private copy of the root (including workspace members and vendor files). Module and workspace metadata writes are discarded with that copy; concurrent edits to the working tree are never restored over. Workspace members must lie inside the indexed root; otherwise include the workspace in the root or set `GOWORK=off`. |

Mapping (`map.ts`): for every non-definition occurrence of a symbol whose definition lies in an indexed file,
`from` = the innermost symbol at the occurrence (else the module scope) and `to` = the symbol whose name sits
at the definition (a module or package → the module scope of the defining file, the alphabetically first for a
Go package; a constructor → its class; a test block is never a target). `kind` and `site` come through the syntax provider's plain
classifier backed by `classifySite` (an `import` becomes a `type-ref` for a type-only import, by the syntax of the statement). The
indexers do not tell reads from writes (scip-typescript sets no role, the others call everything a read), so
the syntax adapter's plain classifier decides: a `read` is kept for a variable, field, constant,
function or method. Taking a function value is not invocation. A class used as a namespace falls through
to the rules below. A `bare` one
(`ClassifiedSite.bare`: `LIMIT`, not `this.limit`) whose target is a class member is dropped (SCIP reports the
property of an object-literal shorthand `{ retry }`, which reads no field), and a WriteAccess role turns it
into a `write`. When the pack does not classify an occurrence: a quoted module specifier → `import` of the
module scope (dropped when the same statement imports names), role Import → `import`, WriteAccess → `write`, a
type-like symbol → `type-ref`; anything else, declarations included, is dropped. Also dropped: references to
definitions nested in something that is not one of our symbols (parameters, local variables, instance
attributes), occurrences that do not fit the file text (a warning counts them), self-references other than a call or a function-value read
(only a `call` establishes recursion). `local N` symbols follow the same rules, so calls to functions nested in functions
stay. SCIP `is_implementation`
relationships become `implements` references (Go interfaces are satisfied implicitly, so this is where precise
Go gets them), unless an occurrence already said `extends`/`implements` or the member merely overrides a
base-class member. SCIP ranges (0-based, end-exclusive, in the document's encoding: UTF-16 for scip-typescript
and scip-python, UTF-8 bytes for scip-go) become 1-based, inclusive UTF-16 against the captured source snapshot. Invalid columns and split Unicode characters are rejected, never
clamped into evidence. Symbols
are matched across indexes without their package version, so the modules of a Go repository resolve each
other.

**Replacement is per file.** The files a tool *described* (`AnalysisReport.results[].analyzedFiles`; for SCIP, the
documents of its index) replace heuristic references of supported, examined kinds with the tool's.
Unsupported and explicitly failed kinds keep their heuristic hints. Files it did not describe (build-tagged
Go files, files a Python project's pyright configuration excludes, unreadable ones) keep their heuristic
references, are named in a warning, and are counted in `LanguageInfo.heuristicFiles`. A language none of
whose files was described is not precise: that run counts as failed. A run whose advertised relationship
kinds all report failure or unsupported analysis has no usable precise analysis: automatic mode warns
and retains the heuristic label;
required mode rejects it. The observed failure results and limits remain in the report. A file whose
occurrences fall outside its text (`//line` directives of generated Go code) counts as not described. Where the tool saw an occurrence
it could not link (`ProviderOutput.blind`), the innermost heuristic reference holding that position is kept,
unless the tool has the same edge on that line. `precise: "auto"` (the default) turns a
failed or missing tool into a warning and keeps the heuristic references; `"require"` fails instead; `"off"`
never runs SCIP. Other environment: `XPL_WASM_DIR` (where the `.wasm` files come from: `dist/wasm/` next to
the bundled CLI, `node_modules` in development).

---

## 4. Core (`@xpl/core`)

Modules of `packages/core/src`: `schema`, `patch`, `constants`, `text` (hashing), `glob`, `ids`,
`index-model` (`IndexModel`), `implementations`, `anchors`, `change` (change records and their analysis),
`model` (`ExplainerModel`), `stubs`, `graph`, `focus`, `sequence`, `flow`, `related-files`, `validate`, `apply`,
`bundle`, `index-pack`, `prune`, `levels`; all re-exported from `index.ts` except the internal helpers of
`util` (`cmp`, `cloneJson`, `deepEqual`, …).

### 4.1 Text and hashing

- `splitLines(text)` splits on `\r?\n` (a trailing newline yields a final empty line). `sliceLines(text,
  range)` returns full lines `startLine..endLine`.
- `normalizeLines(lines)`: trim every line, drop blank lines, join with `\n`; for text matching only, never source
  hashing.
- `hashText(text)` = `"sha256-v2:" + hex(sha256(splitLines(text).join("\n"))).slice(0, 12)` (sync; `@noble/hashes`).
  Indentation, trailing spaces and blank lines are preserved: they can change Python/YAML structure and string values.
  Only CRLF/LF differences are canonicalized. File freshness compares these source hashes even when commit labels match.
  Legacy `sha256:` indexes must be rebuilt. Legacy anchors report drift until their evidence is reread and reapplied;
  `resolve --write` updates ranges but never silently upgrades or acknowledges a legacy hash.
  The indexer hashes with Node's native sha256 (`FileHasher`), which checks itself against `hashText` on a
  fixed sample and falls back to it, so index values never depend on which path ran.

### 4.2 Anchor resolution (`anchors.ts`)

`resolveAnchor(anchor, index, getText) → { status, range, span?, hash, reason? }` where `getText(file)`
returns the current file text.

1. File not in the index → `missing`. `symbol` given but not in the index → `missing`.
2. Region = the symbol's range, or the whole file. Base line = region start (or 1 for files).
3. No span: hash current source in the symbol range or the whole file. Unavailable text → `drifted`.
   Equal to `anchor.hash` → `ok`, or `moved` if `anchor.resolved.range`
   exists and differs from the region. Different → `drifted` (range = region).
4. Span: expected = `[base+from, base+to]`. Hash of the expected lines equal → `ok`/`moved` as above.
   Otherwise search the region for unchanged text in windows of the same length; the
   nearest match to the expected position wins → `moved` with the new range and new `span`. No match →
   `drifted` at the expected range, clamped to the region: since a span is only re-found while its text is
   unchanged, that range is where the span *used to* sit, and reports mark it **approximate**.
5. `missing` keeps the previous range if any, else `{ startLine: 0, endLine: 0 }`; consumers ignore it. Its
   reason says where the code may have gone (rename-aware suggestions, below). When `getText` cannot supply
   the file of a span anchor, the cached `anchor.resolved` is kept (or `drifted` if there is none).

`makeAnchor(input, index, getText)` converts an `AnchorInput`: rejects unknown fields (JSON `null` counts as
absent), validates file, symbol and role, converts `find` to a span (exactly one occurrence), checks the span
is inside the region and not blank, computes `hash`, and sets `resolved` with status `ok`. A `hash` on the
input must equal the current one. Whole-anchor creation requires source matching the indexed file hash.

`reresolveExplainer(explainer, index, getText, { indexPath? })` re-resolves every anchor (elements, sequence
steps, tour code overrides; base anchors against the base commit, which their `resolved.commit` keeps),
rewrites `resolved`, updates `span` for `moved`, sets `explainer.index` and `repo.commit`, and returns a
report: counts by status, `drifted` (elements with origin `llm`, and tours, to be re-explained: each with its
`userFields` and its drifted anchors), `driftedOther` (drifted but `user` or `static`: left alone), and every
`missing` anchor with its element id, whatever its owner. Hashes are left alone, so a drifted anchor stays
drifted until its element is re-explained.

**Text at a commit.** `TextCache(getText, getTextAt?)` memoises the current text of each file and its line
split. Its optional second reader, `GetTextAt = (commit, path) => string | undefined`, reads a file at a
commit (`textAt`, `linesAt`), memoised per commit and path. The CLI wires `git show <sha>:./<path>` into it
(`gitShowReader` in `packages/cli/src/git.ts`): full SHAs only, root-relative paths without `..`, read-only,
and `undefined` when git cannot read the file. Core itself never runs git. Without a `getTextAt`, base anchors
cannot be checked.

**Base anchors** (`at: "base"`) resolve like a file-relative span anchor, against the base text of their
file: `linesAt(change.base, basePathOf(file))`, where `basePathOf` is the old path of a renamed file.
`resolveAnchor` and `resolveWith` take the change record as an optional last argument. No change record, a
`symbol`, or a file with no base version → `missing` with a reason that says what to do. The base code
itself never changes, but the record can (`xpl change` again with another base): then the span is searched
for by its text, as in step 4, and comes out `moved` or `drifted`. When the base text cannot be read (no
git), the cached resolution is kept if it was made for the same base commit; otherwise the anchor is
`drifted` with the reason. `makeAnchor` converts a base `AnchorInput` the same way (`find` against the base
text, or a span from line 1), with `MakeAnchorOptions.change`. `describeAnchor` prints one as
`<file>@base +a..b`, and `isBaseAnchor` tells them apart. Base anchors count for nothing in the index: they
are left out of code focus, the reverse index, related files and the evidence of `llm` edges (§4.5, §4.6).

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
`edge:<kind>:<fromId>-><toId>`. Render-only: `ghost:<id>` (the element the ghost stands for), the folded ghosts `ghost:rest:file:<path>`
and `ghost:more:in` / `ghost:more:out` (§4.4), `stub:<in|out>:<insideId>->ghost:<key>`. A `sym:`
id splits into file and path at the first `#` (the index-aware helpers try every `#`).

`ExplainerModel(explainer, indexModel)` merges derived structural nodes with stored overlays (a stored node
with the same id overrides label/summary/detail/anchors/provenance and adds members/role/tech/opens) and
indexes every element, step (sequence and flow views) and
derived id. Default labels: repo name, dir/file basename, a symbol's last path segment (methods keep
`Class.method`). Hand-edited files are tolerated: entries without an id are skipped, the first of a repeated
id wins (validation reports the duplicates).

### 4.4 Graph derivation (`graph.ts`, `stubs.ts`)

- `repr(x, include, model)`: walk `x, parent(x), …, repo`; at each step return the element if it is included,
  else the nearest included group that lists it as a member, directly or through nested groups (**groups nest
  transitively**). Undefined → `x` is outside the view.
- A node renders inside its *render parent*: the first included element met walking up from it, checking at
  each level the groups that contain the element before moving to the structural parent. An included node
  that others render inside is a **container**. Cycles between nested groups are broken.
- **Derived edges:** each index reference `(from, to, kind)` maps to `(repr(from), repr(to))`; skip it if
  either end is outside (→ stub), both are equal (except a call of a symbol to itself when the box is that
  symbol: a loop on its box), or one end renders inside the other (in the render tree, at
  any depth: a call from a child of an opened file to a sibling that is not shown lifts to the file, and an
  arrow from a box to its own container says nothing). Kind map: call→calls, import→imports, extends,
  implements, type-ref→references, read→reads, write→writes; only kinds in `edgeKinds` (default
  `DEFAULT_EDGE_KINDS`). Module scopes lift to their file. Aggregate per `(kind, a, b)` into
  `edge:<kind>:<a>-><b>` with `count`, `resolution` (`precise` if any aggregated reference is) and derived
  anchors: each site as `call-site` (calls) or `usage`, plus each target's definition, at most 50 of each,
  never stored.
- **Stored edges** are shown whatever their `kind`, when both ends are represented in the view. One whose id
  equals a derived id overlays that edge (label, summary, anchors) and keeps its derived resolution; the
  others carry `llm`, `user` or `static` after their provenance. Stored edges follow the same nesting rule
  (an edge between a group and one of its members, or from a box to its own group, is not drawn) and give
  stubs when they leave the view; a stored edge that ends on a group is drawn between the boxes that show its
  ends, the group box being its end when the group is included, and leaves through `ghost:grp:<slug>` when
  it is not. Stored edges **lifted** to other boxes than their own ends (the parts of a service, drawn as one
  service box on a system map) merge per `(kind, a, b)`: the first by id keeps its id and gains the others'
  anchors and `count`; its label is dropped when theirs differ, its summary always. A stored edge of an
  element to itself is a loop on its box. A stored edge with `via` (what it passes through without a box of
  its own) and both ends shown absorbs the references from its ends into the `via` elements (no stubs for
  them); it is drawn with `via` labels and, without anchors of its own, takes the references of its hops
  (`viaHops`, `hopRefs`, `viaAnchors`) as its derived anchors.
- **Stubs:** references (and stored edges) with exactly one end inside. Ghost target = the highest structural
  ancestor of the outside end, below `repo`, that contains no included node (a group is its own target); a
  target that holds the inside node itself (a stored edge to one's own file) is dropped. Aggregate per
  `(direction, insideId, target)` with the kinds and the count, then apply the view's **stub policy**
  (`view.stubs`, `stubs.ts`; default `top` / 8) to decide what is drawn:
  - `top`: a target that is a symbol of a file the view shows only in part (the file holds an included node
    but is not itself in the view), or such a file when the whole file is the outside end (a module import),
    folds into **one ghost per file**, `ghost:rest:file:<path>`, labelled "rest of <file>". The ghosts are
    then ranked by the references that lead to them (ties by key) and the first `max` (default 8) stay; the
    others fold into one overflow ghost per direction, `ghost:more:in` / `ghost:more:out` ("+N more", N = the
    elements it stands for). A stub is aggregated per `(direction, inside, ghost key)` after the folding.
  - `all`: no folding and no cap, one plain ghost per target (what an unbounded view looks like).
  - `none`: no stubs and no ghosts.
  A folded ghost stands for several elements: `Ghost.targets` lists them with their kinds and reference
  counts, most referenced first (every folded element, also for the overflow ghost; `Stub.targets` holds the
  ones of one stub). Adding one of them to `include` expands the view; the folded ghost itself is not an
  element and `expandStub` does nothing for it. A `rest` ghost's targets include the file itself when a module
  import ends there: adding the file makes it a container of what is shown, standing for the rest of it.
- `view.excludeFiles` drops references that start or end in a matching file before anything is aggregated
  (files the view includes by name, directly or as members of included groups, are exempt); stored edges are
  not filtered. `view.hidden` is applied last: hidden nodes go, their children **re-parent** to the nearest
  visible container, and the edges and stubs touching them go; hidden edge, stub and ghost ids are removed.
  That includes the folded ones (`ghost:rest:file:<path>`, `ghost:more:out`, `stub:…->ghost:more:in`), and an
  element that is hidden, or whose old plain ghost id (`ghost:sym:…`) is, leaves the ghost it was folded into.
  Hidden ghosts and stubs are dropped before the ranking, so they free their place among the top ghosts.
- `deriveGraph(view, model, { edgeKinds? }) → { nodes, edges, stubs, ghosts }`, sorted by id (the option
  overrides `view.edgeKinds`). `nodes[i] = { id, label, kind, symbolKind?, container, parent?, role?, tech?,
  opens?, expandable? }` (`expandable`: it opens a graph view, see `levels.ts`); `edges[i] = { id, from, to,
  kind, label?, summary?, count, stored, anchors, via?, resolution: "precise" | "heuristic" | "llm" | "user" |
  "static" }`; `ghosts[i] = { id, key, kind: "target" | "rest" | "more", label,
  target?, kinds, count, direction: "in" | "out" | "both", targets }`; `stubs[i] = { id, direction, inside,
  ghost (the key), ghostLabel, targets, kinds, count }`.
- Pure view edits: `expandStub(view, stub)`: `include += ghost target` (nothing for a folded ghost).
  `drillIn(view, id, model)`: `include +=` the node (when missing) and its children (a group opens into its
  members), so it becomes a container. `collapse(view, id, model)`: remove its included descendants (for a
  group: its members' subtrees). `defaultInclude(scope, model)`: nodes exactly `depth` levels under `root`,
  plus shallower leaves (files and symbols without children); a chain of single-child directories (`src/`
  that holds only `src/flask/`, see `singleChildChain`) counts as one level and is shown as its end
  (`dir:src/flask`), the root of the scope included.

### 4.5 Code focus and reverse lookup (`focus.ts`)

- `codeFocus(ids, model, { derivedEdges? }) → FocusRange[]` (`{ file, range, role, elementId, status }`): the
  union of each element's resolved anchors (`missing` ones and base anchors excluded: a base anchor's lines
  are lines of the base commit, not of the code the editor shows). When an element has no usable anchor
  (none, or all missing) it **falls back**: symbol → its range; file → the whole file; dir and repo → their
  files (at most 50); group → its members' focus; derived edge, or a stored overlay of one without anchors →
  the derived anchors (reference sites plus target definitions); stored edge with `via` → the references of
  its hops (`viaAnchors`). Concepts, other stored edges and steps without usable anchors have no focus.
  Unknown ids are skipped.
- `mergeFocusByFile(ranges)`: per file (the first focused file first), overlapping ranges merged into
  whole-line runs, keeping every role and source range.
- `buildReverseIndex(candidateIds, model)`: interval entries from `codeFocus` of each candidate.
  `lookup(file, line)` returns every element whose entries contain the line with the minimal line span (an
  element counts with its smallest range around the line; innermost wins; ties return all). Candidates
  (`viewCandidates`) = the active view's elements (included nodes and shown edges, or participants and
  steps) plus all concepts. The viewer (`viewReverseIndex`) looks the drawn elements and the concepts up
  separately and joins the two answers, so a concept anchored inside a drawn step never hides the step.
- `baseAnchorFocus(anchors, elementId) → FocusRange[]`: the base anchors of a list as ranges of the base file
  (`file` = the key into `baseFiles`; missing and never-resolved ones skipped). This is what the viewer's
  "Before" pane shows (§6).

### 4.6 Validation (`validate.ts`)

`validateExplainer(explainer, index, getText, { mode: "strict" | "lenient" })` returns `Issue[]`:
`{ severity: "error" | "warning", path, elementId?, message, code?, userLocked? }`, with `path` like
`views[1].steps[2].anchors[0]`. Codes: `schema duplicate-id bad-id unknown-id anchor-invalid anchor-drifted
anchor-missing evidence frame cycle step commit change protected`. Messages are written for Claude to fix its
patch from. Rules:

- Shapes and enums; `schema` = `code-explainer@0`; `repo` and `index` present. An `index.commit` other than
  the given index's is a warning (`commit`) that points at `xpl resolve --write`. A tour's `summary` is a string.
  An empty `title` is a warning; the explainer's `scope` is `{ audience? }`, one line of at most `AUDIENCE_MAX`
  (120) characters (longer is a warning). A node's `role` is one of `NODE_ROLES`, its `tech` a string.
- `change` (`changeShapeIssues`): full SHAs, known statuses, `oldPath` only and always on a renamed file, no
  path twice, well-formed hunks; a problem is an error (code `change`, path under `change.`), since only a hand
  edit makes one. A `change.head` that is not the commit of the index in use is a warning that says to check
  out the head and re-index, or to record the change again (skipped for a `wt-` index, which names no commit).
- Ids: unique (elements and steps share one namespace; views and tours each unique); prefixes and slugs as in
  §4.3; a stored structural node's id matches its `kind` and exists in the index; a derived-edge overlay
  matches its id's kind, `from` and `to`; steps are `<view-slug>:<n>`; frames `frame:<slug>`.
- Every referenced id exists or is derivable: `parent`, `members`, edge `from`/`to`, `related`, `scope.root`,
  `scope.entryPoints` (symbol ids in the index), `include`, `hidden` (nodes, edges, ghosts, stubs),
  `participants`, `layout` keys, step `from`/`to`/`edge`, tour `view` and `focus` (a focused step that
  belongs to another view is a warning), `editor.primary` (an indexed file), a node's `opens` (a view of the
  explainer), an edge's `via` (non-empty, nodes that are not an end of the edge, each once; not on a
  derived-edge overlay).
- Groups: need a parent and members; no self-membership and no cycles, transitively; an empty group is a
  warning, unless it has a `role` (a box for an outside system), which then warns only when it has no
  anchors either.
- Graph views: `edgeKinds` are edge kinds; `excludeFiles` are strings (warnings for an empty pattern, a
  leading `/` or `./`, a backslash); `stubs` is `{ mode?, max? }` (unknown fields are warnings); `layout`
  positions are finite numbers; duplicates are warnings.
- Sequence and flow views: step `from`/`to` must be participants; frames name steps of their own view,
  `fromStep` not after `toStep`; partially overlapping frames are a warning; `layout` is `code-first` or
  `diagram`. Flow fields: `shape` (`stage`, `decision`, `terminal`), `next` links to steps of the view (a
  `return` link may leave out its step; `kind` `recurse` or `return`; a `recurse` link to a later step is a
  warning), no outgoing links from a terminal but `return` ones. In a flow view, a step whose first current
  anchor is not inside its `from` is a warning (`step`) that names the participant holding the code.
- Anchors: `role` and `hash` present; strict → every anchor resolves `ok`/`moved`; lenient (after
  regeneration) → drifted and missing anchors, **and ids of files, directories and symbols that vanished from
  the index**, are warnings. The messages say what to do, and, for an element whose anchors the user owns
  (origin `user`, or `anchors`/`steps` in `userFields`), that only the user can repair them
  (`userLocked: true`).
- Base anchors: `at` other than `"base"`, a base anchor with a `symbol`, or one in an explainer without a
  change record are `anchor-invalid` errors in every mode. Otherwise they resolve against the base text
  (§4.2) and count like any other anchor: `ok`/`moved` pass, `drifted`/`missing` follow the mode.
- `llm` edges carry at least one anchor inside `from` and one inside `to` (file → same file; dir → under it;
  symbol → same symbol or a descendant; group → any member, or the group's own anchors; repo → anything):
  `containsCode`, code `evidence`. With `via`, evidence is checked hop by hop: a hop the index shows
  (`hopRefs`) is its own evidence, any other needs an anchor inside each of its ends. Base anchors do not
  count as evidence: the edge is about the current code.

### 4.7 Patches (`apply.ts`)

`applyPatch(explainer, patch, index, getText, { actor: "llm" | "user" }) → { ok, explainer, issues, changed }`,
atomic: any error → `ok: false` and the input explainer, untouched.

- Upsert by id, shallow-merged as in §2. An id twice in one patch, or upserted (or changed by a `stepsUpdate`)
  and removed by the same patch, is an error. Top-level keys: `title scope nodes edges concepts views tours
  remove`; `scope` merges `{ audience }` into the explainer's (`null` clears). `remove` takes elements,
  views, tours and single steps (an unknown id is a warning); dropping a step id by resending a view's
  `steps` is a warning (`step`: tours may point at it).
- **Ownership.** `actor: "llm"` never modifies (skipped with a `protected` warning) an element, view or tour
  whose origin is `user`, and keeps the fields listed in `userFields` (a tour's are `title`, `summary` and
  `steps`). It cannot create `origin: "user"` elements and cannot change `provenance`. It cannot remove an
  element, view or tour that has `userFields` (or is user-authored), nor single steps of a view whose `steps`
  the user edited, and a `stepsUpdate` of such a view or tour is skipped like `steps`. The one edit it may
  still make to a field the user owns is `includeAdd`. A tour without `provenance` counts as `llm`.
  `actor: "user"` editing an element of another origin adds the changed fields to `userFields`; that is how
  viewer edits and `xpl apply --actor user` protect themselves from regeneration.
- New elements, views and tours get `provenance = { origin: actor, commit: index.commit }` unless given; a
  changed `llm` element gets `provenance.commit = index.commit`.
- Anchors go through `makeAnchor`, steps and tour `code` overrides likewise, frames are checked. A patch
  with a `change` key is rejected: the change record comes from git, through `xpl change` (§5).
- **Errors come all at once.** Anchors, references and ids are checked in one pass, so a rejection lists every
  problem of the patch: an element whose anchor failed is still merged (without that anchor) and checked for
  its other problems, an element that cannot be built is assumed to exist so that later references to it stay
  quiet, and the checks that depend on a failed anchor (an `llm` edge's evidence at both ends) wait until it is
  fixed. Ids that name nothing come with `Did you mean: …` (elements, views, tours and steps, in `remove` too),
  symbols with both spellings. A span written in the patch that starts or ends on a blank line is a warning
  (`probably off by one`, with the offset where the code starts or ends): the anchor is kept as written.
- **Validation after the merge is strict, but only what the patch introduced or touched can reject it.**
  Errors that were already in the explainer, on elements the patch did not change, become one summary
  warning (otherwise a single drifted anchor on a user-owned concept would block every later patch). One more
  exception: an `llm` patch that changes an element whose anchors the user owns is not rejected for the drift
  of those anchors, which it cannot repair; the problem stays a warning (`userLocked`).
- `changed` lists the ids of elements, views, tours and steps the patch added, changed or removed (upserts
  that change nothing are not listed), plus `"title"` and `"scope"` when they change; a `stepsUpdate` lists
  the view and each step it changed (a tour's steps as `<tour id>/<step id>`).

### 4.8 Also in core

- `implementations.ts`: `implementationsOf(index, id)` / `implementedBy(index, id)`: who implements an
  interface (or one of its methods) and which interface member a method implements, from type-level
  `implements` references (TS clauses, Go's inferred satisfaction) matched to members by name (a Go method
  may sit in another file of the package), member-level ones from a precise index, and interfaces that extend
  one another. `overridesOf(index, id)` / `overriddenBy(index, id)`: the subclass methods that override a
  method, and the nearest base method a method overrides, through `extends` references (TS, JS and Python only:
  Go embedding does not dispatch; constructors are not overridden). `xpl refs` uses both to hop through
  interfaces and base classes.
- `sequence.ts`: step and participant lookups, frames resolved to step ranges with nesting depth
  (`resolveFrames`), disambiguated lifeline labels. `flow.ts`: `processFlow(view)`, the stages and labelled
  transitions of a flow view (or a sequence read as a flow, `projected`). `related-files.ts`: `relatedFiles`,
  the config, test and `resources` files linked to a selection. `bundle.ts`: the viewer's data format (§5).
  `index-pack.ts`: `packIndex` / `unpackIndex`, the compact index of a bundle (`xpl-index-pack@1`, §5). Optional
  trailing tuple positions refer to the index-level provider/version table; old tuples without provenance still
  unpack. Unknown shapes stay plain objects.
  `prune.ts`: `pruneIndex`, the index cut down to what a bundle's viewer can draw (§5). `levels.ts`: the
  levels of an architecture explainer, a box's `opens` (`opensView`, `parentLevel`, `zoomTrail`), and boxes
  opened in place (`expandInPlace`, `canExpandInPlace`; §6). `glob.ts`, `constants.ts` (`DEFAULT_EDGE_KINDS`,
  `TEST_FILE_GLOBS`, `NODE_ROLES`, `OUTSIDE_ROLES`, schema names).
- `change.ts`: lookups on the change record (`changedFile`, which also finds a renamed file by its old path;
  `baseFileOf`, `basePathOf`, `hasBaseVersion`, `baseVersionFiles`, `headPathsOf`, `describeChange` →
  `85c3b74..2284ff0`), its shape check (`changeShapeIssues`), and the **change analysis** that `xpl change`
  prints. Pure: the CLI runs git and hands the record in.

  `analyzeChange(change, indexModel, getText?) → ChangeAnalysis`, against the index of the head:
  - **Files** with their added and removed line counts, whether they are tests (`isTestFile`) and indexed, and
    the changed lines that lie in no symbol (imports, module-level code).
  - **Changed symbols**: for each added or edited head line, and each place where lines were only removed, the
    innermost index symbol around it. A function nested in a function counts as part of the outer one.
    Blank and comment lines count only inside a function. A symbol wholly covered by pure insertion hunks is `new`; replacements are `changed`,
    even when every line differs. Mixed replacement hunks are classified conservatively.
  - **Callers** of each changed symbol outside tests: direct references (depth 1) of kind `call` from outside
    the symbol and outside test files (for a variable or key: reads and writes; for a type: its uses). A
    constructor (`__init__`, `__new__`, `constructor`) also counts the calls of its class (`via: "class"`). For
    `__call__` and `handle`, which run when an instance is called, the code that builds the class goes to
    `viaInstance` (`via: "instance"`), marked as a guess.
  - **Tests**: test functions (top level, or methods of a test class) with any reference to the symbol, or to
    its class for the two cases above; a test file only for a module-level reference (an import) when none of
    its tests has one. `testSymbols` lists the tests the change adds or edits. `untested` lists the changed
    symbols no test references ("no test found": tests of other code may still run them).

---

## 5. CLI (`xpl`)

Global: `--root <dir>` (default cwd), `--json` (machine output), `--index <path>`, `-h`/`--help` (`xpl help
[command]`), `-v`/`--version`; options may come before or after the command name. `<id>` arguments accept
`sym:…`, `file:…`, `dir:…`, `src/a.ts#A.b`, `src/a.ts`, `./src/`, and come back with "did you mean"
suggestions when wrong. `<explainer>` is a name (`jobrunner`), a file name or a path. Output is compact and
copy-pasteable, for Claude as much as for people: exact ids, `<line> <offset>│ code` with the 0-based offsets
that spans use, `+34..36` for the span of a reference site. `--json` on every command prints `{ "ok": true,
…, "warnings"? }`; errors print `{ "ok": false, "error", … }`. Results, issue lists and patch rejections go to
stdout (a rejection exits 1); fatal errors (`error: …`) and warnings (`warning: …`) go to stderr.

| Command | Does |
|---|---|
| `xpl index [--precise auto\|off\|require] [--commit c] [--scip artifact\|manifest.json]` | build + write the index; `--scip` selects source-verified artifact import instead of automatic tools; writes `.explainer/.gitignore` (`index-*.json`); prints per-language trust, independent coverage and names explainers bound to another index |
| `xpl outline [--under <id>] [--depth n] [--kind k,...] [--keys] [--limit n]` | dir/file/symbol tree with kind, lines, fan-in/fan-out (references into/out of the subtree); default depth 2; config keys only with `--keys`; `--kind method,function` keeps only those symbol kinds, with the dirs, files and parents that hold a match; the repo line carries the name `xpl new` records |
| `xpl show <id> [--refs] [--context n] [--lines a-b] [--max-lines n]` | code with 0-based offsets relative to the symbol (the numbers spans use); dirs and the repo list children; `--refs` appends outgoing and incoming references with `+offset`. `xpl show --at base <path> [--lines a-b] [--explainer name]`: a changed file as it was before the change the explainer records, with the offsets a base anchor's span uses (from line 1) and `-` on the lines the change removes or rewrites; paths only (a symbol id is a usage error); `--explainer` picks the explainer when several record a change |
| `xpl refs <id> [--in\|--out] [--kind k] [--depth n] [--max-children n] [--limit n] [--tests]` | call/reference hierarchy with sites; hops through interfaces as `impl` lines and through base classes (TS, JS, Python) as `override` lines; test doubles and test subclasses hidden unless `--tests`; a subtree is printed once (later occurrences: `(expanded above)`), at most `--max-children` (default 15) references under a line of a hierarchy (`... +8 more`); `--kind read` finds the readers of a variable or field |
| `xpl search <pattern> [--regex] [-i] [--limit n] [--under <dir\|glob>] [--code]` | text hits over the working tree with enclosing symbol id and offset; code files first, then config, then docs (`--code`: code only); `--under` keeps the search in a dir, file, symbol or glob |
| `xpl new <name> [--title t] [--repo r] [--url u]` | create `.explainer/<name>.explainer.json` bound to the index; never overwrites; repo name from `--repo`, else `package.json`, `go.mod`, `pyproject.toml`, git remote, directory name |
| `xpl apply <explainer> <patch.json\|-> [--actor llm\|user] [--dry-run]` | §4.7; prints every issue of a rejected patch at once; atomic; `--help` summarises the patch format |
| `xpl validate <explainer> [--lenient]` | §4.6 |
| `xpl anchors <explainer> [id...] [--full] [--max-lines n]` | each anchor of an element (or of every element) resolved now: role, `file#symbol +span`, status, lines, and the code at them with offsets (a long anchor: its first lines, an elision line, its last lines); a base anchor prints as `<file>@base +a..b … [before the change]` with the base code; `tour:<id>` (or `tour:<id>/<step>`) also shows what a step without `code` derives from its `focus`, marked derived; verifies spans without reading JSON |
| `xpl resolve <explainer> [--write] [--allow-stale]` | §4.2 re-resolve against the index of the current code; report drifted llm elements, missing anchors; `--write` saves |
| `xpl status <explainer> [--view <id>]` | the skill's to-do list, read-only: per view the shown nodes, stored edges and steps without a summary (static edges optional), concepts without one, drift (user-owned drift counted apart), missing anchors, broken references (ids gone from the index), stale derived-edge overlays, queued requests; per graph view the ghosts and stubs it draws (counts, the most referenced ghost ids, and for each folded ghost up to 3 of the elements it stands for with their counts; `--json`: every ghost with its count and all its `targets` (`{id, count}`), and every stub id, in `views[].ghosts`) with a warning above 12 ghosts; the tours (id, step count, steps whose focus ids or view are gone); `--view <id>`: that view only, with what it draws (each arrow: id, kind, ends, references, stored or derived, label; each `hidden` id and what it takes out; a flow's step links) |
| `xpl lint <explainer> [--patch <file\|->] [--warn-only]` | checks the text a reader sees (the index, when there is one, counts the boxes and arrows of maps): rules below; `--patch` lints the explainer as it would be after `xpl apply` of that patch (merged in memory as actor `llm`, nothing written; a patch apply would reject prints the rejection and exits 1); exit 1 with any finding (so `lint --patch && apply` stops on one), 0 with `--warn-only` unless a `todo-left` error |
| `xpl change <explainer> [<base>..<head>]` | records the change from git in the explainer and prints its analysis (§4.8; below); without a range, prints the analysis of the change already recorded |
| `xpl draft change\|repo\|path <explainer> [<entry id> ...] [-o file]` | prints a patch skeleton built from the index (and the change record) with no LLM, `TODO:` in every text to write (below); the summary goes to stderr |
| `xpl view <explainer> [--port p] [--host h] [--no-open]` | local server (below) |
| `xpl bundle <explainer> -o out.html [--mode explore\|present] [--tour id] [--files referenced\|boundary\|all] [--boundary-max n] [--embed-index full\|pruned] [--allow-drift]` | self-contained HTML; anchors are re-resolved first, and drifted or missing ones make it refuse (exit 1) unless `--allow-drift` (the page then says so); `--tour` (`tour:intro` or `intro`) implies present mode; embeds the files the explainer references by default and prints what went in (`8 of 12 files embedded (referenced: 18.4 KB of source; --files all adds 4 files, 6.7 KB)`), `--files boundary` adds the direct callers, callees and tests of anchored symbols (at most `--boundary-max`, default 40), `--files all` every indexed file; with a change recorded, every changed file at head and the base text of the changed files go in too; the symbol index in it is pruned to what the viewer can draw with `--files referenced` or `boundary` and whole with `--files all` (`--embed-index` overrides) and packed (the summary line says `index 0.3 MB (1.3 MB as plain JSON, pruned from 9.0 MB)`) |

**Exit codes.** 0 ok (warnings allowed); 1 rejected or failed: unknown id, no index, a rejected patch, a patch
that changed nothing because the user owns everything it touched, validation errors, `resolve --write` on a
stale index, an explicit `--port` in use, `xpl bundle` with drifted or missing anchors (without `--allow-drift`),
`xpl change` without git or with a head that is not the index commit, `xpl draft change` without a change
record, `xpl lint` with findings; 2 usage error. **Environment:**
`XPL_VIEWER_HTML` (viewer page for `view` and `bundle`), `XPL_SKIP_STALE_CHECK=1`, `XPL_WASM_DIR`,
`XPL_SCIP_TIMEOUT_MS`, `XPL_DEBUG=1` (stack traces), `XPL_CLI` (the skill launcher: an `xpl.mjs` to run).

**Files in `.explainer/`:** `index-<commit>.json` (generated, git-ignored by `.explainer/.gitignore`),
`<name>.explainer.json` (committed), `requests.json` (the queue below). Writes are atomic (temp file + rename).
CLI apply/resolve, creation, viewer edits and request appends also share per-file directory locks across processes.
Read input before locking; read the latest file, merge and check ownership, then write while holding the lock.
Locks are never stolen on a timer. A crashed writer may leave `<file>.lock`: after verifying the writer has terminated,
remove that directory and retry (writers time out after 30 seconds with that instruction).

**Index selection**, in order: `--index <path>` (relative to the working directory, else to the root); for
explainer commands, the explainer's own `index.path` when that file exists (`xpl resolve` **ignores** it: it
exists to move an explainer to a newer index); otherwise among `.explainer/index-*.json`: the only one, else
the one named for the current commit id, else the newest. None → an error that says to run `xpl index`.

**Stale index.** Whatever was chosen is compared with the working tree (the commit id it would get now, then
per-file hashes). If they differ, commands warn, naming the changed, new and deleted files: `index X … does
not match the working tree (Y): 2 changed (src/queue.ts, src/runner.ts). Line numbers and offsets may be off;
run xpl index`. `XPL_SKIP_STALE_CHECK=1` skips advisory comparisons (about a second per 5000 files). Strict
validation and HTML export always check freshness and fail on a stale index; `--allow-drift`
does not bypass this requirement. Reindex before resolving or exporting. `xpl resolve
--write` refuses (exit 1) on a stale index, because the ranges it would save are already wrong, unless
`--allow-stale`.

**`xpl change <explainer> [<base>..<head>]`** records a change and prints what it touches. The range takes any
git revisions (`main..HEAD`, `2284ff0^..2284ff0`); `<base>...<head>` starts from their merge base; `<base>` or
`<base>..` alone ends at the index commit. The head must be the commit the index was built from (full SHA
compare): otherwise it exits 1 and says to check out the head and run `xpl index`. For a `wt-` index (a root
below the git top level) that commit is `HEAD`, when the tree is clean and the index matches it. No git, an
unknown revision, or the same commit twice: exit 1 with a plain message. The files and hunks come from `git
diff -M --name-status -z` and `git diff -U0` (`--relative` to the root, no colour, no external diff, no
textconv); git is only read, never written. The record is written under the explainer's file lock, right after
`index`, and nothing is written when it is unchanged. Base anchors that no longer match the new base are
counted in a warning. Then it prints the analysis (§4.8): the files with `+/-` counts, each changed symbol
outside tests with its lines, callers (at most 8 listed, `--json` has all), callers via an instance (a guess)
and tests, the changed lines outside any symbol, the test files the change touches with their new and changed
tests, and the symbols with no test. Without a range it re-prints the analysis of the stored record. `--json`:
`{ ok, path, written, change, analysis }`.

`core/src/languages.ts` classifies every `FileLanguage` with a code display name or `undefined` for config
and other text. Its derived `CODE_LANGUAGES` set is shared by code search and repo drafts; Rust participates
in both, and its draft service boxes carry `tech: Rust`. Adding a language requires a classification.

**`xpl draft change|repo|path`** prints a patch that `xpl apply` accepts as it is: views, groups, overlays,
participants, steps, anchors and a tour, with `TODO: <what to write>` in every text (tour notes as `### TODO:
…` plus a body). It checks the draft with `applyPatch` before printing it, never reuses an id the explainer
has (`view:change-map-2`), never adds a summary to a node the explainer already explains, gives graph views
`stubs: { mode: "none" }` and each tour step at most 2 code ranges and an `editor.primary`. `-o` writes it to a
file; `--json` adds the counts and what was left out.

- `change` needs the change record and builds on `analyzeChange`: a map of at most 8 boxes (the changed
  symbols, small changes to several methods of one class as one group, files when there are too many; up to
  3 direct callers outside tests, examples and benchmarks; one group for the changed tests, or for the tests
  that use the changed code). Box summaries start with `New:`, `Changed:` or `Unchanged:`. The tour follows
  the review order, at most 12 steps: what changes for users, where it enters, one step per changed piece in
  call order ("Before/Now" TODOs), other changed files, who else is affected, tests and gaps, risks. Anchors
  come from the hunks; every changed file gets one, a deleted file in the base (`at: "base"`).
- `repo`: two levels. A system map (`view:system`): the project as one service group (`role: service`,
  members = the parts), or one `dir:` box per program when `services/`, `apps/` or `cmd/` (at the root or
  under `src`) hold two or more; who reaches it (web and CLI frameworks, `role: person`) and what it relies on
  (database drivers and ORMs, caches, queues, file stores, HTTP clients and SDKs), found from the import lines
  of code files (`outside.ts`: a catalog per language family) and drawn as groups with a role, a `tech` and no
  members, anchored at one import line per part that imports them. Each service box `opens` the map of its
  inside: 4-8 parts (top-level folders with code, a single root folder opened, tests, docs, examples and dot
  folders left out; label and summary TODOs) plus the outside systems they use, with an `llm` edge (`kind:
  custom`, label TODO) from each part to each system it imports, anchored at that import. `excludeFiles` for
  tests and docs on both. The tour: the system map, what it relies on, the inside of the biggest service,
  then one step per part, the main part first. The service and outside boxes keep their ids across drafts.
- `path <entry>`: a sequence of the calls the entry symbol makes (depth 1, source order, at most 6
  participants and 12 calls), and a tour with a big-picture step and one step per main call (at most 8).

A draft gives structure, not understanding: the concepts, flows, `llm` edges and base anchors that explain
why the code is as it is are left to Claude.

**`xpl lint`** reads the explainer (and the index when there is one, for map counts) and checks the text a reader sees, against the skill's writing rules
(`reference/writing.md`). Code spans are left out of the word checks. Each finding names the element, the
field, a short quote and a fix. Rules (thresholds and word lists live in `LINT_LIMITS`, `FILLER_WORDS`,
`ABSOLUTE_WORDS` in `packages/cli/src/lint.ts`):

- `todo-left`: a `TODO` left in reader text or a view's question; the one error-level finding (exit 1 even
  with `--warn-only`; any other finding exits 1 without it).
- Tours: `tour-summary` (missing, or not 2-4 sentences), `tour-first-step` (the first step focuses a test, a
  concept that lights up nothing, or a flow when the tour has a map, or its title says "edge case"),
  `tour-covers-map` (a box of a used map of at most 10 boxes that no step focuses and no note names),
  `tour-length` (more than 12 steps), `note-heading` (a note without a `### title` line).
- Titles: `code-title` (a title that looks like code), `placeholder-title` ("Fix 1", "Note", "Step 3").
- Sentences: `long-sentence` (over 25 words), `long-average` (a field averaging over 20), `bare-it` ("It" or
  "This" and a verb), `filler-word`, `absolute-word` ("all", "never", "only" … that needs evidence; idioms
  such as "at all" and narrowing uses such as "compares only the host part" do not count, nor a claim next to
  its evidence: the text of an element with anchors, a note sentence that names a part the step shows),
  `repeats-summary` (a note sentence that repeats a focused element's summary), `long-note` (a note body over
  60 words), `code-heavy` (more different code spans than 3 in a note, 1 in a note on an architecture map, a
  graph view with a box that has a `role`, or 2 in a tour summary; example values such as `503` or `/admin/*`
  do not count). Neither judges text that still holds a `TODO`. `tour-covers-map` matches names by word stems.
- Form: `flow-label-code` (a flow stage label written as code), `markdown-in-plain` (markdown in a title or
  label), `markdown-in-summary` (a heading or link in a summary; inline markdown is fine there).
- What readers will see: `untitled-step` (no note, or no heading and a first sentence too long for a title),
  `change-not-shown` (changed files whose code no step shows; docs, tests, lock files and renames may be
  named instead), `far-ranges` (a step whose ranges in one file make more than 3 places over 40 lines apart:
  Present's panes per file), `long-talk-note` (a talk note over Present's `LONG_NOTE`), `big-map` (over 8 boxes on
  a map a tour shows), `crowded-map` (over 2 arrows per box, with the edge ids to hide; needs the index).

`--patch <file|->` merges the patch in memory with core `applyPatch`, the call `xpl apply` makes, so the
findings are those of the explainer after apply; nothing is written. `--json`: `{ ok, path, strict, checked,
total, counts, findings, patch?, changed?, protectedIds? }`.

**`xpl view`** serves the viewer on `http://127.0.0.1:<port>/`: port 4747, else any free port when that is
taken (`--port 0` = any; an explicit port that is taken is an error). `--host` other than loopback exposes
your source and edit rights, and warns. It opens the browser best-effort (`--no-open`) and fails early when
the viewer is not built or there is no index. The server keeps no explainer state: every request re-reads
the explainer, its index and the working tree. The page polls `/api/explainer`; its ETag includes the
resolved explanation and source/index file metadata. A change refreshes `/api/bundle` and previously
opened source files while preserving navigation. Unsaved viewer edits postpone adoption without
acknowledging the new ETag. A newly generated index is followed unless `--index` pins a specific one.
Source edits are shown with a stale-index warning until reindexing; viewer edits never overwrite them.
Drifted or missing anchors do not stop it (unlike `xpl bundle`): it warns, and the page says which
parts may be out of date.

| Route | |
|---|---|
| `GET /` | the viewer HTML with the bundle injected (`server: { api: "/api" }`, `mode: "explore"`, `files` = the files the explainer references; others are fetched lazily; `baseFiles` whole, when the explainer has a change: only the changed files, so it is small) |
| `GET /api/bundle` | the same bundle as JSON |
| `GET /api/explainer` | the explainer with its anchors re-resolved (as in the bundle), with an `ETag` of the file; 304 on a matching `If-None-Match` |
| `GET /api/file?path=` | text of one indexed file (`text/plain`); 400 for a malformed path (absolute, `..`, backslash, NUL), 404 for anything not in the index (with `suggestions`) or unreadable |
| `GET /api/base-file?path=` | the code before the change of one changed file (`text/plain`, read with `git show`); `path` is `ChangedFile.path`; 400 for a malformed path; 404 when the explainer has no change, the file is not a modified, renamed or deleted file of it (with the list of those; the old path of a renamed file is not a key), or git cannot read it |
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
index, files: Record<FilePath, string>, baseFiles?, mode?, tour?, server? }`, embedded as `<script
id="xpl-data" type="application/json">` with `<` escaped as `\u003c` (and U+2028/2029 escaped). Under `xpl
view` `files` may be partial and the viewer fetches the rest from `/api/file`. `xpl bundle` embeds the files
the explainer needs (`--files referenced`, the default; `--files all` embeds every indexed file): those of
every anchor and tour `editor.primary`, of what the views draw (the nodes a graph view includes, a directory or
group bringing its files, the sites and definitions behind its derived edges, a sequence view's participants
and steps), of what a tour step can focus, and, one hop out, the code behind the dashed stubs of graph views
(the sites of the references that cross the edge of the view and what they lead to: none for `stubs: none`,
references of `excludeFiles` files do not count; a ghost directory that joins the view when expanded is fetched
on demand under `xpl view` and absent from a static bundle). With a change recorded, every changed file that
exists at head and is indexed is embedded whatever `--files` says; the summary says how many the selection had
left out (`change 85c3b74..2284ff0: 2 changed files in (1 added to the selection: …), code before the change of
2 files (64.6 KB)`). The viewer's file tree lists only the embedded files of a static bundle, with an "N of M
files included" footer. The viewer HTML comes from `XPL_VIEWER_HTML`, else `dist/viewer.html` next to the
running bundle, else `packages/viewer/dist/index.html`.

**Base files.** `baseFiles: Record<FilePath, string>` is the code before the change: the base text of every
modified, renamed and deleted file of `explainer.change`, keyed by `ChangedFile.path` (the new path of a
renamed file). Added files have none, and it is absent without a change record. `xpl bundle` reads it with `git
show` and names any file git could not read (that file then shows no "before"); the viewer fetches a missing
one from `/api/base-file` under `xpl view`.

**Boundary.** `--files boundary` embeds the referenced files plus a safe boundary around what the explainer
anchors, so a reader can check the neighbours of a claim. Around every anchored symbol outside test files (an
anchor with a `symbol` the index knows; a class counts with its members) it adds the files of its direct
callers (call references into it), of its callees (call references out of it, depth 1) and the test files with
any reference to it. An anchored `__init__`, `__new__`, `__call__`, `constructor` or Go `New` is also reached
through its class. Each file gets one reason (test, then caller, then callee), and files are taken from
callers, tests and callees in turn, the ones with the most references first, up to `--boundary-max` (default
40); the summary names the files the cap cut (`boundary +5: callers 1, callees 0, tests 4; …`). An explainer
that anchors only whole files gets `boundary +0`. The boundary is as good as the call references: a call
through a variable, a callback or a framework is not seen. `--json` adds `files.referenced` and
`files.boundary: { added: [{ file, reason, refs }], cut, max, symbols }`, and with a change `change: { base,
head, changedFiles, addedToSelection, baseFiles, baseBytes, baseMissing? }`.

**Pruned index.** The `index` of a bundle is most of the page for a large repository (every symbol and
reference, next to the code of a dozen files), so `xpl bundle` embeds a **pruned** one by default (`--files
referenced` or `boundary`) and the whole one with `--files all`; `--embed-index full|pruned` overrides either
(`pruned` with `--files all` finds nothing to drop). `pruneIndex` (core, `prune.ts`) keeps every file entry;
the references with an end inside a graph view, on a derived edge the explainer names, or in an embedded file
(`read` references only between two embedded files); and the symbols of the embedded files, of what the graph
views hold, of what the explainer names (an anchor, a group member, an edge end, a tour focus) and where the
kept references end, with their parent chains. The viewer derives the same nodes, edges, stubs, ghosts, code
focus and reverse lookup from it as from the whole index, whatever the edge-kind selection and stub mode; the
tests compare the two. `SymbolIndex.pruned` (§2) records what the full index had.

**Packed index.** `xpl bundle` (and the viewer's Save as HTML) writes the index **packed** (core
`index-pack.ts`, `serializeBundle(bundle, { packIndex: true })`): each symbol id once, in `ids`, and every symbol
and reference a short array of numbers (`packing: "xpl-index-pack@1"`), about a fifth of the plain JSON (xpl's
own page: 17.8 MB to 6.1 MB, its index 13.5 MB to 2.3 MB). It is lossless (an entry of an unknown shape stays an
object) and `parseBundle` unpacks it, so the viewer only sees a `SymbolIndex`. `xpl view` and the e2e fixture
pages keep it plain.

The summary line says what was saved, `…, index 0.3 MB (1.3 MB as plain JSON, pruned from 9.0 MB), …` (the size
in the page first; `index 2.1 MB (9.0 MB as plain JSON)` when nothing was dropped). With `--json` the `index` field
is `{ path, commit, choice: "full"|"pruned", pruned, bytes, fullBytes, packedBytes, symbols: { embedded, indexed
}, refs: { embedded, indexed } }` (`bytes` and `fullBytes`: the embedded and the whole index as compact JSON;
`packedBytes`: the embedded one as the page holds it).

**Known limit:** exploring past the embedded code is not exact. A ghost added there, one that leads into a file
whose code is not embedded, opens only into the symbols the kept references end in, not all the symbols of the
file, and edges between two such ghosts are missing. `--files all` (or `--embed-index full`) keeps everything,
and `xpl view` always serves the whole index.

---

## 6. Viewer (`@xpl/viewer`)

**Data and state.** The viewer reads the bundle from `<script id="xpl-data">` and shows a "no data" page
without one. One external store (`store.ts`) holds the state; `derive.ts` derives, memoised per state, the
graph of the view, the code focus of the selection, the editor panes and the reverse-lookup matches with
`@xpl/core`. The UI and `window.__xpl` go through the same actions. Without `server` (a static bundle) view
and tour edits stay in memory: the header shows "Unsaved", and the Edit menu offers "Save as HTML" and
"Download explainer JSON". Under `xpl view`
they are sent 250 ms after the last change through `PUT /api/views/<id>` / `PUT /api/tours/<id>` ("Saving…",
"Saved", "Retry save" on failure) and recorded as user edits (`userFields`). Markdown (the tour `summary`, step
notes, `detail`) is sanitised: raw HTML shows as text, images become their alt text, links keep only http(s),
mailto and in-page targets. Element and step summaries are rendered as inline markdown (`renderInline`: code
spans, bold, emphasis); titles and labels are plain text. The page title is "<tour title> · xpl" while a tour
is open (the Guide, Present), else "<explainer title> · xpl".

**Three modes, one header.** **Read** is the default screen, for readers. **Explore** is the author's
workbench. **Present** plays a tour as slides. The header is one row built the same way in each: the title,
what the mode moves between, the save state (only when there is something to say: "Unsaved", "Saving…", "Not
saved"), the mode's one action, and the **Edit** menu.

Below the header, **Analysis coverage** is a collapsed disclosure in every mode. It names missing or
failed analysis and opens into capabilities, file counts and limits, labeled by analysis provider id.
Tool commands and diagnostic details are omitted.
It describes the original indexed repository, including when only some sources are embedded or the index
is pruned. A legacy index shows coverage unknown. Live refresh and Save as HTML use the current index report.

| Mode    | Moves between                                                              | Action  |
| ------- | -------------------------------------------------------------------------- | ------- |
| Read    | the reading tabs Guide, Map, Flow, Code                                    | Present |
| Explore | one tab per view (a strip that scrolls) and a Views menu                   | Present |
| Present | a tour picker and `‹ n / N ›`, with a progress bar along the header's edge | Exit    |

Present is disabled without tours, and its tooltip says how to get one. Every author tool sits in the Edit
menu: "Explore the diagrams" (from Read) or "Back to reading" (from Explore), "Edit the guide's steps" (the tour
panel), the Stubs control and edge-kind toggles of a graph view (Explore only, under "This view"), "Save as
HTML", "Download explainer JSON", and "Retry save" after a failed save. The menu works with ↑ ↓ Esc and Tab.
At 1280×720 the header fits without cutting a control off.

**Save as HTML** (Edit menu, `saveHtml.ts`) saves the page as it was loaded, with the edited explainer in its
`<script id="xpl-data">`. A copy of the document is kept when the viewer starts, before React renders into it,
so what is saved is the page as loaded, not the rendered one. The saved copy keeps the index and the embedded
files, adds the files and base files fetched since the page opened, and drops `server`: it opens without
`xpl`, with the edits in it. Under `xpl view` the edits are saved by the server already; the HTML file is a copy
to share.

**Read.** The page opens here unless the URL or the bundle asks for another mode. The tabs:

- **Guide** (`Guide.tsx`): the tour as a page. A contents list of the steps on the left. On the right the tour
  title, its `summary` (markdown), then, for a change, **Files in this change** (below), then one section per
  step. A section has its title, the rest of its note, an inline **picture** of the step's view and the
  interaction or parts it focuses ("This call", "inside X: label" for a step within one part, "Parts", "Where
  this applies"), its **Tests**, and "Show the code". The picture (`Snapshot.tsx`) is a still drawing of the
  view framed on the step's focus, with the same shapes as the live diagram and no clicks or ids; "Open in
  Map" or "Open in Flow" opens the live one. A picture is laid out only when its section comes near the screen
  (an IntersectionObserver), and once per view. Tests (`stepTests.ts`) are the test code the step's focus
  points at (`test` anchors, and focused code in test files), one entry per test function, gathered in one
  list. The summaries of the focused elements only stand in for a missing note. A tour picker sits above the
  title when there are several tours. The Guide opens at its top, not scrolled to step 1.
- **Map** and **Flow**: the authored graph view, or flow or sequence view, that best matches the selection
  (`workspace.ts`), with a picker of the others. Without a graph view the Map is generated from the flow's
  participants (else the top level of the repo); without a flow, Flow lists the guide's steps in order. Count
  labels on edges (`calls ×N`, stubs) are quiet: shown on hover or when the edge or an end of it is selected.
  Reader boxes drop the group, directory and symbol badges.
- **Code**: the editors and the file tree. On the other tabs "Show source" opens the code beside them.

Beside the tabs: a breadcrumb (the explainer title, then the open step's title or the selected element), Back
and Forward through what was read, "Read its explanation" (jumps to the guide step that best covers the
selection), and a right rail: the selected element's summary ("Current topic", hidden while a guide section
is the topic), the related files (`relatedFiles`: config, `resources`, tests; hidden when there are none) and,
under "Where this is in the code", the details in reader form: no ids, provenance or author actions, and roles
in plain words ("defined here", "called here", "used here", "setting", "test"). The URL keeps
`?perspective=<tab>&view=<id>&tour=<id>&step=<n>&focus=<id>…` in step, so a link lands on the same place.

**Step titles** (`stepTitle.ts`) are the same everywhere a step is named: the Guide's contents and headings,
the breadcrumb, the Flow tab's step list, the tour panel and the Present caption. A note that starts with a
heading line (`### Plain title`) takes that whole line as its title, and the body is the rest. Otherwise a
first sentence of at most 80 characters is the title (a stop inside code, a number or after "e.g." does not
end it). Otherwise the title is that first sentence cut at a word boundary to about 60 characters and "…",
else (no note, or a note that opens with code) "Step N". Never the label of a focused element: that is often
a code signature. The title is never printed again in the body (a cut title aside: the body keeps the whole
note). `xpl lint` reports such a step (`untitled-step`).

**Explore.** The header holds the view tabs (the tooltip of a tab is its title and question) and the Views
menu. Left: the diagram (caption: title and question), below it the concept list and the details panel. Right:
the code, the file tree (collapsible; files outside the focus are greyed `is-dimmed`, files in it `is-focus`; a
static bundle lists only the files it embeds, with a footer "N of M files included · rebuild with --files all",
`tree-foot`; under `xpl view` every indexed file is listed and loaded when opened) beside the stack of
CodeMirror editors (language modes for TS/TSX/JS, Python, Go, YAML and JSON; Rust, TOML and other text are plain).
Both splits (diagram / panels, diagram / code) are resizable. Below 900 px the halves stack.

- **Graph view:** a layered layout (dagre, `layout/layered.ts`), direction RIGHT, or DOWN when the pane is taller than wide; when the result
  would have to be scaled down to fit, the other direction is tried too (graphs of at most 150 elements) and
  kept if it fits at least 8% larger. The direction is on the graph as `data-direction`. Containers
  for nested includes, laid out inside-out with room for their header; an edge that crosses a container's
  border gets a port there (a node of its own in the container's first or last layer), so the part inside
  is routed around the boxes; edges routed inside their lowest common container, right-angled, with the ends that share a side of a box spread along it and the turns in one gap
  between layers on separate tracks. If the layout throws, a grid layout keeps the diagram usable (`data-fallback`). Edges are styled by resolution: precise,
  heuristic (thinner and lighter), `llm`, `user`; stubs are dashed and lead to ghost boxes (at most 8 by
  default plus one "+N more" per direction, see §4.4; ghosts that stand for several elements have a dotted
  border and a list icon). Click selects (shift/ctrl/cmd adds, the background clears); clicking a ghost for
  one element calls `expandStub`, clicking a folded ghost ("rest of <file>", "+N more") opens a **menu**
  beside it: its elements with kind and reference count, most referenced first (a "rest of" menu starts with
  "The whole file", which adds the file as one box), and picking one adds it to the view (`expandStub` on that
  element); Escape, a click elsewhere or a turn of the wheel over the diagram closes it, the arrow keys move
  in it. Double-clicking a node calls `drillIn`; a container has a collapse button. A box with a `role` is
  drawn as what it is (`RoleBox`: a cylinder for `database`, `cache` and `storage`, a pipe for `queue`, a
  dashed box for `external` and `person`, with a person icon, a heavier border for `service` and `system`) and
  its badge is its `tech` or its role. A box with `opens` has a zoom button ("See what is inside"; a
  double-click does the same, and Details offers it too): `store.zoomInto` shows that view, in the map or flow
  perspective that draws it, as a navigation step (Back returns). Above the diagram, `ZoomTrail` lists the
  levels above the current view (`zoomTrail`), each a link (`store.goToLevel`). A box that opens a graph
  view (`GraphNode.expandable`) also offers "Show the inside here": `store.toggleExpanded` adds it to
  `state.expanded`, and the view is drawn through `expandInPlace` (core `levels.ts`), with the boxes of the
  view it opens added, so the parts of a service sit inside its box and their arrows cross its border; its
  collapse button folds it back. Nothing is stored. Every box has an icon left of its label
  (`components/icons.tsx`): its role, else the kind of code (folder, file, group, a letter per symbol kind).
  Not while presenting. Pan by dragging, zoom with
  the wheel, the buttons or `+`/`-`, "Fit" (or `0`) for all of it. The first view is the fit, unless the
  diagram is too big to read fitted (a fit scale below 0.6, as for seventeen boxes with groups): then it
  starts at zoom 0.75 on the selection, else on the first box of `view.include` that is drawn, and a badge
  (`pz-badge`) says part of it is out of sight and offers "Fit all" (once all of it is in sight: "Readable
  size" to come back). Sequence diagrams pan and zoom the same way, and each tour step starts its diagram over
  on the step's focus, even within one view. View edits (expand, drill in, collapse, edge-kind toggles, the
  Stubs control) are stored on the view. Selecting a stub focuses the reference sites that cross the boundary
  there plus the definitions on the far side (of every element a folded ghost stands for); its details list
  those elements with a button each. Ghosts are pictures in Present: no menu.
- **Sequence view:** lifelines, one row per step (`call` solid, `return` dashed, `async` open head), self-calls
  as loops, frames (`loop`/`alt`/`opt`/`par`) as labelled rectangles around their steps, nested by
  `resolveFrames`. A step's hit area covers its label and arrow. When the view has moved down, a copy of the
  participant names stays at the top of the pane (`sticky-heads`).
- **Flow view:** `processFlow` (§4.8) laid out by the same layered layout, top to bottom: stages as boxes, decisions as diamonds,
  terminals, and the labelled `next` branches. A box shows the step's label large and, under it, the actor:
  the step's `from`, plus "→ B" when a stage hands work to another part and that fits (`stageActor`); a
  decision or a terminal shows the actor alone, and so does a step inside one part (the Guide and the details
  say "inside X", never "X → X"). A sequence view in the Flow tab is drawn the same way, in reading order,
  with a note that says so. A flow never zooms below 11 px text (`FLOW_READABLE_ZOOM`, Read's start and the
  floor of "Fit"). Recurse and return links are dashed and purple, with "one level down" / "up one level"
  after their label; a link of a stage to itself is a loop on its right side; labels are drawn after all
  lines. A code-first view (`codeFirstView`) puts the code in the main pane (Read: the flow is a narrow
  outline column; Explore: the diagram column is narrow) and the outline keeps the caret's step (else the
  selection) near its middle (`PanZoom.revealMargin`).
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
  opens the file at its lines). Actions: "Explain this", or "Send to Claude" with feedback typed above it
  (`feedback`: "What should Claude change?"; queues a request with the feedback as its note under `xpl view`,
  otherwise shows `/code-explainer expand <id>` to copy), "Add … to the view" for a stub, "Open children",
  "Collapse".

**Reading aids.** A "Key" button beside the zoom buttons says what the diagram's marks mean (`Legend.tsx`:
`Legend`, `FlowKey`, `SequenceKey`; rows for marks not on screen are left out). "Called from" (`callers.ts`;
in the details and the topic rail, 6 rows then "Show N more") lists the code that calls the picked file or
symbol, one row per calling symbol, a function's calls to itself as one "itself (recursion)" row; for a
change the details also say what it did to the element ("Added by this change", "+5 −2 in it"), and a Guide
section lists "Code that calls what changed". A name in the code has a hover with "Who calls it"
(Shift+F12) and "Go to definition" (F12, or Ctrl/Cmd+click). A pane header folds the pane or gives it the
whole column, steps through its changes (`pane-hunks`) or its places (`RangeStepper`), and names the function
the code is in ("in X"). The file tree has a filter (matching paths, flat), change marks (A, M, R, D; removed
files are listed) and a "context" tag on files a `--files boundary` bundle carries only for context. When
anchors drifted or went missing (`xpl bundle --allow-drift`, or `xpl view`), a banner under the header counts
them (`DriftBanner.tsx`), drifted lines are striped (`xpl-hl-drifted`) and the pane says "changed since". The
scope's `audience` line shows under the Guide's title. Under `xpl view` the page polls `GET /api/explainer`
every 2 s (ETag, 304 while unchanged) and shows what `xpl apply` wrote without a reload, keeping the view,
step and selection as far as they still exist; not while edits made on the page are unsaved.

**Tours.** Edit → "Edit the guide's steps" opens the tour panel: add the current view and selection as a step
to a tour, or to a new one (`tour:<slug of the title>`); edit each step's note (markdown), reorder, delete with
undo. Render-only ids (stubs, ghosts) are never stored in a step. A tour's `summary` survives these edits.

**Present.** Plays a tour: each step applies its view, its `focus` as the selection, its `code` override and
its `editor` options (`dimOthers`, `hideFileTree`, `primary`), and shows a caption: the step's title (as in the
Guide) and the rest of its note. The counter and the progress bar are in the header. The diagram is
read-only: no drill-in, expand or collapse, and ghosts are pictures. Framing rules:

- Layout: the diagram over the caption on the left (40% of the width, at least 300 px; 52%, at least 340 px,
  for a tour with a flow step, since a flow is tall and branches sideways, narrowed back toward 40% when the
  tour's focused lines need the room, `present/split.ts`: the split is chosen once per tour, so the slide does
  not re-split between steps), the code on the right, no file tree unless a step sets `hideFileTree: false`.
- A diagram never starts below a readable zoom: graphs and sequences at zoom 1 (`PRESENT_READABLE_ZOOM`, so
  the smallest 12-unit text is 12 px or more); a flow with its text at 16 px (`PRESENT_FLOW_MAX_ZOOM`), fitted
  only when that shows all of it. A diagram too big for that starts on the step's focus, and a badge offers "Fit all". A flow is
  never fitted below 11 px text (`FLOW_READABLE_ZOOM`): too tall, it is fitted to its width and the wheel
  scrolls it (`data-fit="width"`; when even the width does not fit, Fit shows all of it anyway).
- The diagram keeps at least 200 px (45% of the left column on a very short screen); the caption gets the
  rest. It has one height and one type size per tour (present/caption.ts): the tallest caption, measured
  off-screen, at the largest of four sizes at which it fits (a tour with a note over 280 characters starts one
  size down). Only at the smallest size does a caption scroll, with a shadow at the bottom. "Fit all" and the
  zoom buttons stay hidden until the mouse moves.
- Two places far apart in one file (more than about a pane apart, present/ranges.ts) get a pane each, the
  step's first one on top, like two files. Read mode shows "‹ range 1 / 2 ›" in the pane header instead.
- The code font grows with the screen (`clamp(15px, 4px + 0.45vw + 0.75vh, 22px)`: about 15 px at 1280×720,
  17 px at 1440×900; 14 px in a code column under 420 px). Long lines wrap with a hanging indent (Present
  only) that keeps the first row of a line from being empty. A pane is as tall as its focus,
  plus the removed lines of a change shown inside it, and scrolls so that removed lines just above the focus
  stay in sight.

Keys: `→` `PageDown` `Space` next, `←` `PageUp` `Shift+Space` previous, `Home`/`End` first/last,
`Esc` leaves Present (in Explore, `Esc` clears the selection); they win over the diagram, the editors and
focused buttons, while text fields and menus keep their own keys. **A click during a talk is a detour:** the
selection follows the click, the caption says "Exploring · Back to step n", the next `→` applies the next
step, and `←` or `Esc` first return to step n. URL: `?mode=present&tour=<id>&step=<n>` (`n` counts from 1; `tour=intro` finds `tour:intro`;
`?view=<id>` picks the starting view). The address bar follows the tour with `history.replaceState`, so a
reload or a shared link lands on the same slide. A talk started on the page pushes one history entry: Back
leaves the talk, and `Esc` goes back over that entry too, so the address always says what is on screen. A
page that opens in a talk pushes an entry when it is left (`?mode=explore&tour=<id>&step=<n>`), so Back
returns to the talk. A step past the end is clamped; an unknown tour falls back
to the first one when the page opens in Present. `xpl bundle --tour` or `--mode present` sets the bundle's
defaults, which the URL overrides. Exit (or `Esc`) goes back to where the talk was started from.

**The change (diff view).** When the explainer has a sound change record (`changeOf`: a record `validate`
would reject is ignored, so the code shows without a diff rather than a wrong one), the viewer shows what the
change did. The pure logic is in `diff.ts`; base text comes from `ViewerBundle.baseFiles`, or under `xpl view`
from `GET /api/base-file` (each file once; an error shows in its pane).

- **Code.** A changed file's pane marks the head lines the change added (`xpl-add`) or rewrote (`xpl-chg`)
  with a green tint and bar, and `+` in a narrow gutter (`xpl-diff-gutter`), so the marks do not rely on colour
  alone. Removed base lines are shown inline, read-only (`xpl-removed`, `−` in the gutter): above the lines
  that replaced them, or below the line they followed for a pure deletion (git's `newStart` rule). A changed
  line inside the focus keeps its focus colour, its gutter cell is tinted instead, and changed lines are
  never dimmed. Without the base text the block says "N lines removed (the code before the change is not
  included in this page)". The pane header says "Changed", "New file", "Renamed from <old path>" or "Removed",
  and has a **Show changes** toggle, on by default, that turns the marks off for every pane
  (`ViewerState.showChanges`).
- **Before pane.** Base anchors (`baseAnchorFocus`, §4.5) get their own pane with `side: "base"`: read-only,
  headed "Before (base 85c3b74)", with the base lines the change removes or rewrites marked (`xpl-gone`).
  Clicks in it look nothing up (its line numbers are the old ones). Panes follow the order of the anchors,
  so a step that names the old lines first shows them first, and a primary file shows both of its sides. A
  file the change removed opens from base in a "Before" pane labelled "Removed"; a renamed file's "Before"
  pane shows its old path. In the details panel a base anchor's row is tagged "before" and opens the base
  pane at its line.
- **Map badges.** A file or symbol box gets a "New" pill for an added file or a range wholly covered by pure
  insertions. Replacement hunks, including complete rewrites, get "Changed" (`changeStatus`; the box's
  `data-change`). Groups and directories get none. Boxes are widened so the pill never covers the label. The
  Guide's pictures show the pills too.
- **Files in this change** (Guide, under the summary): source files first, then tests. Each row has its
  status in words, `+n −m`, a "test" tag, and "from <old path>" for a rename. A row opens the file in the
  Code tab at its first change (a removed file: its code before the change). A file the page does not carry
  is listed but cannot be opened.

**Test hooks (stable contract for Playwright):**

- Every clickable diagram element or list item carries `data-element-id="<id>"` (nodes, edges, steps,
  lifelines, concepts); stubs also `data-stub-id`, ghosts `data-element-id="ghost:<key>"` (`ghost:file:src/a.ts`,
  `ghost:rest:file:src/a.ts`, `ghost:more:out`). State classes:
  `is-selected`, `is-match`, `is-related`; file-tree rows `is-dimmed`, `is-focus`.
- Other attributes: `data-view-id` (view tabs, and the diagram with `data-view-type`), `data-mode` on `.app`
  (`explore` / `present`) and on the header (`read` / `explore` / `present`), `data-perspective` on the Read
  workspace, `data-direction` / `data-fallback` on the graph, `data-change` (`new` / `changed`) on a map box,
  `data-section-id` on a Guide section, `data-side` (`head` / `base`) on an editor pane, `data-fit="width"`
  on a width-fitted diagram, `data-collapse-id`, `data-edge-kind`, `data-frame-id`,
  `data-details-id`, `data-path` (tree rows), `data-status` (anchor rows), `data-zoom` (canvas),
  `data-stub-mode` (the Stubs control's `top` / `all` / `none` buttons, `aria-pressed`), `data-ghost-id` (the
  ghost menu) and `data-ghost-target` (its entries and those in a stub's details: the element a click adds).
  Folded ghosts carry `aria-haspopup="menu"`. Present: `[data-testid="present"]` with `data-tour`,
  `data-step` (1-based) and `data-step-id`.
- `data-testid`: header: `mode-present`, `present-exit`, `perspective-<guide|map|flow|code>`, `views-button`,
  `views-menu`, `edit-button`, `edit-menu`, `edit-explore`, `edit-read`, `edit-tours`, `edit-save-html`,
  `edit-download`, `edit-retry`, `view-strip`, `view-tabs-frame`, `strip-arrow-start`, `strip-arrow-end`;
  tours: `tour-panel`, `tour-target`, `tour-new-title`, `tour-add`,
  `tour-step`, `tour-step-title`, `tour-step-note`, `tour-step-up`, `tour-step-down`, `tour-step-delete`,
  `tour-undo`, `tour-present`, `tour-picker`, `guide-tour-picker`, `tour-prev`, `tour-next`, `tour-counter`,
  `tour-detour`, `tour-caption`, `tour-title`, `tour-note`; Read: `guide`, `tour-summary`, `section-note`,
  `focus-summary`, `guide-snapshot`, `snapshot-open`, `guide-mini-self`, `guide-tests`, `change-files`,
  `change-file` (with `data-path` and `data-status`), `topic-summary`, `breadcrumb-topic`, `process-flow`,
  `audience`, `guide-step-picker` (phone width), `guide-callers`, `snapshot-more`, `caption-owner`,
  `caption-insides`, `step-neighbours`, `switch-notice`, `topic-off-view`, `topic-around-flow`, `topic-facts`,
  `context-close`; code: `pane-before`, `pane-change`, `show-changes`, `pane-fold`, `pane-expand`,
  `pane-hunks`, `pane-ranges`, `pane-inside`, `pane-drifted`, `symbol-actions` (the hover on a name),
  `tree-filter`, `tree-change-mark`, `tree-context`, `tree-foot` (the "N of M files" footer of a static
  bundle); diagrams: `zoom-trail`, `legend-button`, `legend`, `legend-icons`, `pz-more`, `stubs-control`,
  `ghost-menu`, `ghost-targets` (the list in the details panel of a stub to a folded ghost), `pz-badge` (the "Fit all" / "Readable size" badge of a diagram that is too big to read
  fitted), `sticky-heads`; other: `callers`, `element-change`, `feedback`, `explain-command`, `drift-banner`,
  `no-data`, `present`.
- Editor panes `[data-file="<path>"]`; every line `.cm-line[data-line="<n>"]`; decorations `xpl-hl`,
  `xpl-hl-<role>`, `xpl-hl-drifted`, `xpl-dim`, and `xpl-site` on the exact call or usage expression when the range has
  columns; the diff: `xpl-add`, `xpl-chg`, `xpl-gone`, `xpl-removed` (with `data-at="before|after:<line>"`,
  `data-removed-from`, `data-removed-count`) and `xpl-removed-line`.
- `window.__xpl` (same actions as the UI): `select(ids)`, `selection()`, `focus()` (core `FocusRange`s in pane
  order), `matches()`, `setCursor(file, line)` (opens the file when no pane shows it), `setView(id)`,
  `present(tourId, step = 1)` (false without such a tour), `next()`, `prev()`, `exitPresent()`, `state()`: a
  JSON snapshot (`mode`, `perspective`, `canGoBack`, `canGoForward`, `tour`, `step`, `stepCount`, `stepId`,
  `detour`, `viewId`, `viewType`, `selection`,
  `cursor`, `matches`, `related`, `panes`, `focusFiles`, `openedFile`, `graph { nodes, edges, stubs, ghosts }`
  (ids; ghosts as `ghost:<key>`), `serverMode`, `dirty`, `include`, `edgeKinds`, `stubs` (`{ mode, max }`, defaults
  filled in)).

---

## 7. Skill (`skill/code-explainer`)

`SKILL.md` drives the operations below, plus regeneration, through the CLI (`<skill-dir>/bin/xpl`). The
launcher finds `packages/cli/dist/xpl.mjs` relative to its own real path, so the skill directory is symlinked,
not copied (`XPL_CLI=<xpl.mjs>` overrides the lookup). Everything Claude writes is a patch; it never edits an
explainer by hand. SKILL.md and its `reference/` files are the source of truth for the rules; this section
only says how they use the CLI.

Claude first chooses one of three scopes: `explain <question>` (part of a project), `explain repo` (the whole
project) or `explain change <base>..<head>` (a diff). The reader sees the tour title and its `summary` first,
then the steps, then the maps and the code on demand, so the tour is written top-down: the big picture, the
main path, the details, edge cases last. Fast mode ("quickly", "the gist"): the draft's one picture and
about 5 steps, no other views, concepts or `llm` edges; the checks still apply. `reference/quick.md` puts the
workflow, the rules and the lint checks on one page.

Workflow: `xpl index` → `xpl new <name>` → (for a change: `xpl change <name> <base>..<head>`) → optionally
`xpl draft change|repo|path` for the structure → read the code (`outline`, `search`, `show`, `refs`; `show --at
base` for the old code) → write the patch → `xpl lint --patch` → `xpl apply` (a rejection writes nothing and
lists every error at once: fix the patch, apply again) → `xpl validate`, `xpl status` (until `0 unexplained`)
and `xpl anchors` (read what every span landed on) → the tour → the accuracy pass (a fresh subagent or a
second pass: no claim beyond its anchors) → `xpl lint` and small fixes (single elements, `stepsUpdate`), a
newcomer's re-read → `xpl bundle --files boundary` (the default in cloud sessions) or `xpl view`.

- **`explain <question>`**: ask one short question if the scope is really ambiguous; find entry points
  (`search -i`, `outline`); trace (`show <entry> --refs`, `refs --out --kind call` at depth 1 and a targeted
  `show` per callee, since `--depth 2` on a hub is noise; hop through interfaces via `impl` lines; a `call`
  whose target is a variable or field is a call through a function value, so anchor the field as `usage`
  and the concrete function if it is in the repo; calls into dependencies are not indexed, so anchor the call
  site and name the dependency); look for what static analysis misses (event bus, DI, callbacks, HTTP,
  queues, config keys read by name; `refs <field> --in --kind read` for the readers of a typed config
  field); decide the model (a sequence view of 3–6 participants, more than 6 meaning several views, and one
  step per call that matters; a graph of the 5–15 files or symbols involved, with groups where a
  responsibility crosses folders; concepts anchored to code, config keys and tests; `llm` edges only for the
  links just found, evidence at both ends; a summary for everything the views show); write ONE patch; **re-read
  every summary against the `show` output of its anchors**, removing or qualifying absolute words (only,
  never, all, always, nothing but) and any behaviour the anchored code does not show (prose is the main
  quality risk: the viewer displays it next to the code); apply; check; show the result; answer in 3–6
  sentences.
- **`explain change <base>..<head>`** (`reference/explain-change.md`): read-only on the user's repo and
  remotes. `xpl change` records the diff and prints the changed symbols, their direct callers and the tests
  that reference them; Claude checks each "before" claim in the base code and anchors it there
  (`at: "base"`), follows the callers and consumers of a changed result, names the tests and the gaps, and writes
  the tour in review order: what changes for users, where it enters, each changed piece, who else is
  affected, tests, risks. Every changed file is anchored, tests included.
- **`explain repo`**: coarse first, lazy after. `outline --depth 1/2`, 4–10 boxes (in a `src/<pkg>/` layout
  start at `dir:src/<pkg>`), groups for responsibilities that span folders, an overview graph (`scope: { root:
  "repo", depth: 1 }`, `excludeFiles` for tests, examples and docs, `edgeKinds` when package dependencies are
  the point), `llm` edges, a few concepts at most, one sequence view for an obvious entry point. Deeper nodes
  stay unexplained; offer the 2–3 most useful expansions. `xpl status` warns when a view stops in more than 12
  places.
- **`expand <node>`**: an id, a clicked ghost (`ghost:dir:x` means `dir:x`; `ghost:rest:file:p` is what a partly
  shown `file:p` holds outside the view, `ghost:more:in|out` the ghosts beyond `stubs.max`) or a queued
  request. Read it, patch the graph view with `includeAdd` (works on user-curated views), explain only what
  became visible (`xpl status` names it), drain `.explainer/requests.json` and delete it. A folded ghost is
  not an element: `includeAdd` the elements it stands for (`xpl status` prints up to 3 per ghost, `status --json`
  all as `views[].ghosts.list[].targets`; the viewer's menu, `outline --under file:p` and `refs <shown id> --out`
  show them too) or `file:p` for the whole file as one box; `hidden` takes ghost and stub ids
  (`xpl status --json` lists them); `stubs.mode` `all` is for small views only, `none` draws no stubs.
- **`feedback [<id> <what to change>]`**: what the user typed under "Explain this" in `xpl view` (the
  queued requests with a note in `xpl status`). Per request: read the element and its code, make the
  smallest patch that does what the note asks (more to show is `expand`; a claim the code contradicts is
  fixed in the text, never by bending the anchor; a note wrong about the code changes nothing), all in one
  patch, lint, apply, delete `.explainer/requests.json`; the open page picks the change up by itself.
- **`make tour`**: a `summary` and 5–9 steps (up to 12 for a change), each of the form
  `{ id: "t1", view, focus: [ids], note, code, editor: { primary } }`, each note starting with
  `### <plain title>` and each `code` override holding at most 2 ranges; ids `tour:<slug>` (`tour:talk-…`
  for a talk, so `xpl lint` keeps its notes short: `long-talk-note`), steps `t1`, `t2`… (a change draft
  numbers them `t10`, `t20`…, so an inserted step takes a free number between its neighbours); one note is fixed later with the tour's `stepsUpdate`; apply, read `xpl anchors <name> tour:<slug>`
  (what each step will show: its `code`, else the ranges derived from its `focus`), then
  `xpl bundle -o … --tour tour:<slug>`. A tour the user edited in the tour panel is protected: a new tour
  (new slug) takes the changes.
- **Regeneration** (after the code changed): `xpl index` → `xpl resolve <name> --write` → `xpl status` →
  re-read the code and resend the anchors and dependent summaries of drifted `llm` elements (a drifted step:
  a `stepsUpdate` entry with its rebuilt anchors and summary, the other steps stay), skipping `userFields` and
  never touching `origin: "user"`; repair broken references (`includeRemove`, lists resent without the gone
  id); report missing anchors to the user with the "did you mean" hint, never dropping or retargeting them
  silently → `xpl validate` (strict) must pass.

Hard rules: you cannot invent code (every anchor resolves or `apply` rejects it; never write hashes, and
never line numbers or offsets from memory: copy them from `show`/`refs`/`search` output, or use `find`);
read before you claim (a reference is a hint until you have seen the call); `llm` edges only for what static
analysis cannot see, with anchors at both ends; stable ids (slugs chosen once, step ids never renumbered or
reused); the default actor `llm` (never overwrite `origin: "user"` or `userFields`; `--actor user` only for
text the user dictates; views and tours the user edited are theirs too); summaries are 1–2 concrete sentences
about this code, every claim visible in the code their anchors show; for a change, never describe old
behaviour that was not read in the base code; lazy; ask rather than guess.

`reference/`: `quick.md` (the one-page quick reference: the loop, what every patch needs, the lint checks),
`patch-format.md` (a template for every element, merge rules, rejection messages and their
fixes; its `json patch` blocks are applied by a test), `cli.md` (every command with sample output),
`writing.md` (which field holds what, plain-language rules, the tour summary, rewrites; `xpl lint` checks the
mechanical part), `explain-change.md` (the PR, MR and branch guide),
`examples/go-retry.patch.json` (a worked question patch for `fixtures/go-jobrunner`) and
`examples/py-overview.patch.json` (a worked repo overview for `fixtures/py-jobrunner`); tests apply and
validate both.

---

## 8. Fixtures and acceptance

Four fixtures implement the same job runner (queue, worker pool, event bus, metrics, a runner with
retry/backoff and dead-lettering, YAML config, tests), each with runnable tests using only its standard
toolchain: TS `node --test` (type stripping), Python `unittest`, Go `go test` (several packages under
`internal/` plus `cmd/jobrunner`; `*queue.Queue` satisfies `runner.JobQueue` without declaring it, which
exercises implicit-interface inference), and Rust `cargo test --offline` (std only; trait, generic impl,
inline/external modules and a `macro_rules!` declaration). `config/default.yaml`'s `retry` mapping is
lines 13–16 in the original three.

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
files are its output. `--change scripts/ts-change.json` makes a **change explainer** without git for the diff
tests: the TS fixture is the head, and the spec gives the base lines each head edit replaced, so the hunks and
base texts are computed (they match `git diff -U0`). It holds a renamed, a deleted, an added and two modified
files, and its patch is applied as the user with base anchors on a concept and, through `stepsUpdate`, in a
tour step. The e2e setup builds it as `dist/bundles/ts-change.html`.

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
`index` → `resolve --write` → `status` → re-explain → `validate`, on TS, Python and Go. Change tests
(`core/test/change.test.ts`, `cli/test/change.test.ts`) run `xpl change` on a two-commit git repo with
modified, added, deleted and renamed files, and take base anchors through make, resolve, moved, drifted,
apply and validate; `cli/test/draft.test.ts` applies each draft as it is and checks that `validate` and
`anchors` are clean and `lint` reports only `todo-left`; `cli/test/lint.test.ts` covers every rule and
`--patch`. The e2e suite covers Read (the guide, titles said once, the header at 1280×720 and 1440×900, text
of 12 px or more in Present), explore, tours, the diff view (`change.spec.ts`), `xpl view`'s API from the
browser (`/api/base-file` included), degraded (malformed) explainers and both colour schemes; besides,
architecture maps (`architecture.spec.ts`, on the Python fixture with the skill's worked overview), many views
in one header (`header.spec.ts`), big diagrams (`large-graph.spec.ts`), crowded views (`stubs.spec.ts`), the
file tree (`file-tree.spec.ts`), recursion and the code-first layout (`recursion.spec.ts`), and the Key,
keyboard and small screens (`a11y.spec.ts`). `screenshots.spec.ts` (and screenshots in other specs) write to
`packages/viewer/e2e/screenshots/`, which is gitignored.

---

## 9. Status

**Exists and tested:** the four packages and the skill as described above; three language packs with
heuristic references, SCIP-precise references for all three, config keys of YAML, JSON and TOML files, the
full CLI (with `change`, `draft` and `lint`), Read, Explore and Present with tours, feedback from the page
under `xpl view` and its live update, architecture maps (`role`, `opens`), change explainers with
base anchors and a diff view, and example explainers for the original three fixtures. Rust has an
experimental syntax-tags provider and a browser-tested structural bundle; it has no relationship resolver or committed example explainer.

**Known limitations**

- `read` references are conservative (§3): module or package variables and constants, and fields whose type is
  known. A read of a local or parameter, through a receiver of unknown type or by dynamic access is not
  recorded, and `reads` edges are off by default (`DEFAULT_EDGE_KINDS`; the viewer's toggle and `edgeKinds`
  switch them on; stored `reads` edges are always shown).
- `GraphView.layout` (hand-pinned positions) is validated and accepted in patches but the viewer never reads
  it, and `GraphView.hidden` is honoured by derivation but has no UI: hiding an edge or node is a patch
  (`xpl status --json` lists the derived edge ids).
- The layout runs on the main thread: laying out a very large graph blocks the page, so views
  should stay coarse (whole-repo views start at packages) and are expanded by hand.
- Live refresh is polling-based: updates appear on the next poll while the page is visible and has no
  unsaved edits. Source locations and reference edges need reindexing after source changes.
- Heuristic references are hints, and the limits are in §3: no overloads, generics, unions or narrowing;
  Python instance attributes are not linked. A precise index needs the tools: `npx` for
  TypeScript and Python, Go ≥ 1.25 (or the network for the automatic toolchain) for Go, and the first run
  downloads them. Files a tool did not describe stay heuristic (`heuristicFiles`).
- "Explain this" is a queue, not a live call: an explanation appears the next time the skill runs.
- Step ids are "never renumbered" by convention: the code only warns when a resend drops one.
- Tours have `provenance` and are protected like the rest (§4.7); a tour written before that has none and
  counts as `llm`, so an `llm` patch may still replace it.
- The base of a change is not indexed. Base anchors have no symbols (`find` or a file span only), base code
  has no references, and the analysis of `xpl change` sees callers and tests at head only. A base anchor
  needs git to be checked (`git show`); without it the cached resolution is kept.
- The diff marks whole lines: a rewritten line shows as removed, then added, with no word-level diff inside
  it. The details panel tags a base anchor's row but does not show the base lines next to it.
- `xpl change` needs the head checked out and indexed (the head must be the index commit); the change of an
  uncommitted working tree cannot be recorded, since it has no head commit.
- The change analysis is depth 1 and as good as the index: callers through a variable, a callback or a
  framework are not seen, `callers via instance` is a guess, and "no test found" means no test names the
  symbol, not that no test runs it.
- Drafts give structure, not understanding: a map, a sequence, anchors and a tour in the right order. The
  concepts, flows, `llm` edges, base anchors and every sentence are Claude's (a draft covers about one view
  and most of the tour steps of a hand-written explainer, and roughly half its anchors). `xpl draft path` is
  depth 1, so a path whose layers call each other through a variable (`self.app`) is not rebuilt.
- `xpl lint` is mechanical: it catches slogans, absolute words, long sentences, code titles and order
  problems, not wrong claims. `repeats-summary` finds near-verbatim repeats only.
- Not published: the packages are private and `xpl` runs from a clone (`npm install && npm run build`), which
  is also what the skill launcher expects. Node ≥ 22.12 is required; only Linux has been exercised.

**Next steps, roughly by value** (the review in `docs/review-2026-10-01.md` has the roadmap): an independent
accuracy pass for change explainers; a word-level diff in rewritten lines; editable step titles and code in
the viewer; a UI for hiding and pinning, or dropping the unused `layout` field; the layout in a Web Worker; more
language packs (each needs `extract`, `classifySite`, `resolveModule`, and optionally a SCIP resolver);
publishing the CLI and packaging the skill so that install is one step; a regeneration mode in the skill that
walks `xpl status` on its own.
