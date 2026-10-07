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
`xpl draft` prints a patch skeleton built from the index (and the change), so the authoring agent writes
only the text;
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
   button saves a request in `.explainer/requests.json` under `xpl view`; offline pages use browser storage
   and JSON export. `xpl feedback` imports, inspects and exports requests and records selected outcomes.
   Saving feedback never starts generation. `xpl revise` handles an explicitly selected batch through
   proposal and decision reviews, then ready acceptance with recoverable selected outcomes.
8. **Changes: one index, at the head.** A change explainer describes the head of the change, the code the
   index was built from. The base is never indexed. Its text is read from git when it is needed
   (`git show <base>:<path>`): for base anchors, `xpl show --at base`, and the "before" side of the viewer.
   So base anchors take `find` or file spans, never symbols (§4.2). A second index would double the cost
   and the ids; the hunks and the base text are enough to check "before" claims and to draw the diff.
9. **Drafts without an LLM.** Most of an explainer is structure: boxes, steps, anchors, tour order.
   `xpl draft` builds that from the index and the change record, with `TODO:` in every text a person writes.
   Claude then writes and checks only the text. `xpl lint` reports each `TODO` left as an error.
10. **Code-graph formats are interchange only.** SCIP, Kythe entries and Joern CPG exports map onto
   `ProviderOutput` (§3) with stated losses; xpl stores only its own `SymbolIndex`, and `normalizeProvider`
   alone decides source checks, IDs and positions. SCIP is the import format (#12). A Kythe or CPG importer is
   not built: Kythe adds little where a SCIP tool exists, and CPG frontends differ in positions, synthetic nodes
   and coverage. Measured on `fixtures/go-jobrunner` in `docs/assessment-2026-10-04-graph-formats.md`.

---

## 1. Repository layout and conventions

```
package.json            npm workspaces root (ESM). Scripts: build, site, test, typecheck, test:e2e, format, format:check
tsconfig.base.json      strict, noUncheckedIndexedAccess, noUnusedLocals, ES2022, NodeNext
packages/
  core/     @xpl/core     schema types + pure logic (hash, anchors, derivation, validation, patches).
                          Browser-safe: no node:* imports. Used by indexer, cli and viewer.
  indexer/  @xpl/indexer  file discovery, tree-sitter language packs (WASM), heuristic resolver, SCIP importer.
  cli/      @xpl/cli      `xpl` command; esbuild bundle → packages/cli/dist/xpl.mjs, with dist/wasm/ (the
                          tree-sitter .wasm files) and dist/viewer.html (a copy of the built viewer) beside it
  viewer/   @xpl/viewer   React 19 + CodeMirror 6 + dagre; vite single-file build → packages/viewer/dist/index.html
skill/code-explainer/   shared skill: SKILL.md, README.md, reference/ (quick.md, cli.md, patch-format.md,
                        writing.md, create.md, explain-change.md, examples/), bin/xpl (CLI launcher)
fixtures/{ts,py,go}-jobrunner/   tiny real repos + committed explainers in .explainer/
docs/                   handoff.md, ARCHITECTURE.md, analysis-2026-09-30.txt, review-*.md (review notes),
                        review-2026-10-03-real-runs/ (the per-run reports of that review), images/,
                        assessment-2026-10-04-graph-formats.md (+ its reproducible scripts)
.explainer/             xpl's own explainer (xpl.explainer.json), checked by packages/cli/test/self-explainer.test.ts
site/                   public landing page: hand-written HTML/CSS, jobrunner screenshots, and pinned
                        Vite/Zod explainer bundles with their MIT licenses in examples/
docs-site/              user docs: zensical.toml, pinned requirements.txt, hand-written pages/ with include lines
AGENTS.md, CLAUDE.md    guidance for coding agents working on this repo (CLAUDE.md imports AGENTS.md)
.claude/skills/         skills for working on this repo (.agents/skills links here; code-explainer links to skill/)
.claude/hooks/          Claude Code hooks (registered in .claude/settings.json): session-start.sh, format-on-edit.sh,
                        stop-check.sh (AGENTS.md, Automation)
scripts/                pr-screenshots.sh (before/after viewer screenshots; packages/viewer/scripts/pr-shots.ts),
                        needs-screenshots.sh (does a change need them), publish-pr-shots.sh (push to pr-assets),
                        build-site.mjs (build xpl, bundle a fixture copy, build the docs, check site links
                        and public example bundles)
.github/                pull_request_template.md, workflows/ci.yml (checks, e2e, PR screenshots),
                        workflows/pages.yml (build on PRs; publish the site on v* release tags)
```

Conventions (all packages):

- `npm run site` writes `_site/` (git-ignored). It copies `site/`, including four pinned, self-contained
  Vite/Zod example bundles and their upstream licenses, and bundles a temporary copy of
  `fixtures/ts-jobrunner` with the built CLI (`index --precise off`, a text-only patch through `apply`,
  then `bundle jobrunner`). The patch fills required summaries missing from the committed fixture. Local page
  and CSS references, the embedded demo payload, and each public bundle's payload, scrubbed source root and
  upstream license notice are checked before success. Pages deploys this output
  at `https://krimvp.github.io/xpl/` when a `v*` release tag is pushed; pull requests build without deploying.
  The public artifact contains the landing page, the fixture and public examples, and the user docs, not
  internal docs or the repository's own explainer.
- The user docs (`docs-site/`) are built with Zensical into `_site/docs/`, under `uv run` with every Python
  package pinned in `docs-site/requirements.txt`. A page line `<!-- include path -->` takes a whole file and
  `<!-- include path "## Heading" -->` the text under one heading. README and skill sections used by includes
  stay single-sourced; standalone workflow pages own their text. Relative links in included text point to the
  page that includes the target, to a copied image, or to the file on GitHub. A link to a file that does not
  exist, or a link form other than `[text](target)`, fails the build. Links into the repository point to GitHub.
  `reference/commands.md` is generated from
  `xpl --help` and each command's `--help`, and the build fails when `cli.md` has no section for a listed
  command. `zensical build --strict` fails on a missing page or anchor, and the local link check above also
  runs over every built docs page. The colours and fonts repeat
  `site/style.css` in `docs-site/pages/stylesheets/xpl.css`.

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
    sequence view can be projected into stages by `processFlow` (`projected: true`); the viewer keeps its
    sequence diagram in Read and Explore. A `next` link may add `kind: "recurse"` (the steps from an earlier
    step run again, one level down; a step with only
    recurse links still goes on to the next one) or `kind: "return"` (back up one level, to `step`, or with no `step` to the caller; a
    terminal may have these). `SequenceView.layout?: "code-first" | "diagram"` overrides `codeFirstView`
    (viewer `workspace.ts`: at least three steps, each with current-code anchors all in one file). Read
    applies this layout only to flow views; Explore also accepts explicit `code-first` on sequences (§6).
    A flow step whose first anchor is not inside its `from` gets a warning (a `return` step whose code is
    in `to` excepted).
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
21. `Explainer.review?: ReviewRecord` records one author inspection: `{ reviewer, reviewedAt, scope,
    omissions, fingerprint, sourceCommit }`. The name is self-reported and the time is a UTC ISO timestamp;
    neither authenticates the reviewer nor verifies prose. Omissions are named descriptions, or `[]` when
    none are named. Missing legacy records mean unchecked. Only user patches record or remove a review.
    Scope is `{ content: "all" | string[], source: "anchored" | "repository", files?: string[] }`;
    the fingerprint is `{ version: "xpl-review@1", contentHash, evidenceHash }` (§4.6).

Patch-side types (never stored) live in `packages/core/src/patch.ts`; its header holds the authoritative
merge rules and `skill/code-explainer/reference/patch-format.md` is the practical guide. The authoring
agent writes:

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
                   languages?: string[]; providers?: readonly IndexProvider[]; cache?: boolean;
                   gitOptions?: GitOptions; snapshot?: IndexInputs; getText?: GetText })
  : Promise<{ index: SymbolIndex; warnings: string[]; exclusions: ExclusionReport;
              extraction: ExtractionReport;
              work: { heuristicResolutionMs: number; semanticMs: number; semanticRuns: number } }>
writeIndex(root: string, index: SymbolIndex): Promise<string>
// atomic write of <root>/.explainer/index-<commit>.json; ignores indexes and cache/ in .explainer/.gitignore
```

Pipeline: discover files → per file: read, hash, reuse extraction or parse/`pack.extract`/free the tree → assemble symbols
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
Excluded from candidate files: binaries (NUL in the first 8 KB), files over 1 MB, symlinks and submodule directories, files
deleted but still tracked, and lockfiles (`*-lock.json`, `*.lock`, `go.sum`, `pnpm-lock.yaml`,
`npm-shrinkwrap.json`). Every remaining text file is an `IndexedFile` (unknown extensions → `text`), so
file-relative anchors work anywhere. Language by extension: `.ts .mts .cts` typescript, `.tsx` tsx, `.js .mjs
.cjs .jsx` javascript, `.py .pyi` python, `.go` go, `.rs` rust, `.yaml .yml` yaml, `.json` json, `.toml` toml.
Named `*.explainer.json` and `*.patch.json` outputs are excluded in both modes. Exported xpl HTML is
also excluded by its embedded bundle marker; ordinary HTML remains source. Paths are POSIX,
repo-root-relative, sorted.

`buildIndex` also returns a run-local `exclusions` report: counts by reason and up to three sorted,
root-relative example paths. `xpl index` prints it, and `--json` includes it. The report counts only
enumerated candidates. Git-ignored files never enter git's list; a non-git walk does not enumerate
files inside skipped directories or symlinks. A supplied snapshot has no discovery report. Exclusions
are not saved in `SymbolIndex`. A `buildIndex({ languages })` report counts candidates of those languages
only.

**Watched input capture** (`src/snapshot.ts`): `captureIndexInputs({root, inputPaths?, gitOptions?, precise?, providers?})`
returns sources, local configuration text, the captured clean HEAD label (when applicable), a
content/discovery/HEAD fingerprint and a revision including
ctime, mtime and inode. `buildIndex({snapshot})` uses that captured source and configuration instead of
reading them again. Snapshot roots must match; language filtering still applies. Semantic tools may read
disk, so the caller must recheck the revision before publishing. A changed-and-restored input supersedes a
build even when its content fingerprint matches. Source reads are checked before and after capture.

Configuration capture runs a syntax-only, cache-free resolver pass with `getText` recording every local
configuration read, including missing paths. The returned text map is frozen for the real build. There is
no filename-extension allowlist: ignored extends chains, package manifests and any other pack reads are
captured through the same `SourceRepoView` reader. Packs and providers share the pure
`ConfigurationReader.readConfiguration(file, repo)` seam. `precise` defaults to `off` for capture;
callers match the real build's mode and provider selection. Enabled semantic providers preload local
inputs through the same recording reader without running tools. Declarations name the pinned tool version
and the source file whose lookup they mirror; recheck them when bumping a tool:

- Python 0.6.6 searches `scip-pyrightconfig.json` before `pyrightconfig.json`, nearest directory first,
  through ancestors. Only without any JSON config does it search `pyproject.toml`; `[tool.scip]` wins
  over `[tool.pyright]`. This version does not load JSON `extends`. The adapter separately reads root
  `[project]` name, then `setup.cfg` metadata. Missing higher-priority paths are observed too.
- TypeScript 0.4.0 loads each selected tsconfig directory or jsconfig file, local `extends` by exact path
  then `.json`, and directory references by `tsconfig.json` (without a sibling `.json` fallback).
  Nearest package manifests supply package identity. The synthetic leftover config is generated.
- Go 0.2.7 reads module metadata and delegates loading to `go/packages`. Process settings override
  persisted `go/env` settings. `GOWORK=off` disables workspace lookup; an explicit workfile wins over
  the nearest `go.work`. Workspace sums and vendor metadata belong beside the workfile; module sums,
  workspace members and local replacements are observed too. `GOFLAGS` alternate module and overlay
  files, including overlay backing files, use the recording reader. The private Go source copy bounds
  implicit workspace lookup to the copied root.

A supplied `SourceRepoView` reader owns its path namespace, so provider capture can record ancestor
configuration. The default filesystem view still confines reads to its root.
TypeScript's pack also reads nearest tsconfig/jsconfig chains for every source file without semantic tools.
Capture also observes local/ancestor ignore rules, Git configuration/exclusions, explicitly supplied SCIP
inputs and the staging/work-tree cleanliness used by `resolveCommitId`. Cleanliness shares discovery's
path and content filters, so exports, patches, guides, dependencies, lockfiles and other excluded files
cannot turn a clean watched snapshot dirty. File eligibility is reused until its metadata changes.
A captured clean HEAD label wins
for snapshot builds; dirty snapshots derive the id from captured files, without reading live staging.

`indexInputsChanged(snapshot)` compares candidate paths and file size/mtime/ctime/inode plus Git state,
without sniffing or reading source/configuration bytes. Unchanged idle polls reuse the captured inputs.
A change triggers full content capture; building and publication still recheck full captured revisions.
External dependencies, tool installation and process-environment changes are outside the watch boundary.
Restart or manually index after changing those inputs.

**Commit id.** `--commit` wins (letters, digits, `.`, `_`, `-` only: it becomes part of a file name). Else, if
`root` is the git top-level and the work tree is clean (ignoring discovery-excluded files): short HEAD
(7 chars). Deleted or unreadable source changes still count as dirty. Else
`wt-` + first 10 hex of sha256 over the sorted `path\0hash\n` list: deterministic, which is why fixtures
living inside this monorepo get stable ids.

**Extraction cache** (`src/extraction-cache.ts`). By default `buildIndex` reuses file-local facts in
`.explainer/cache/extraction-v1/`. `cache: false` (`xpl index --no-cache`) reads and writes no cache entries.
The cached value is `FileFacts` (symbols, sites, imports, types, exports, warnings and pack-private JSON data),
resource sites and syntax diagnostics, or a syntax tags file's declarations/recovery diagnostics. No live
nodes, trees, parsers or final relationships are serialized. Successful syntax recovery is reusable; failed
extraction is retried. JSON-incompatible pack data is used for this build but never persisted.

The address is full SHA-256 of a JSON input containing the exact captured source string (BOM/CRLF included),
repo-relative path, language, provider ID/version/profile configuration, indexer version, format
`xpl-extraction@1`, `EXTRACTION_REVISION`, grammar ID, pinned runtime/grammar package versions and SHA-256
of the actual runtime/grammar WASM bytes. Built-in profiles include pack capabilities and reference mode;
tags profiles include query text, kinds, method parents and limitations. `EXTRACTION_REVISION` must increase
when extraction logic, resource collection, tag labels or diagnostics change without a package/profile
version change. Change `CACHE_FORMAT` and the directory version when the envelope/serialization changes.
No abbreviated anchor hash is used as a cache key. Stored input must equal the full expected input, so an
address collision becomes a miss rather than wrong facts. The payload checksum covers input and payload;
SHA-256 integrity is corruption detection, not authentication of a hostile local writer.

WASM hashes cover bytes passed to the loader. A process retains loaded WASM; if disk replacements disagree
with those resident bytes, cache reads/writes are bypassed. Configure overrides before parser initialization
and restart after a toolchain upgrade. Missing WASM never becomes a cache hit. Checksummed JSON entries are
written through unique temporary files and rename. Missing, corrupt or wrong-input entries fall back to
extraction; cache write failures do not change the index or its diagnostics. Orphaned temporary files are
ignored. Published indexes also use unique temporary names and atomic rename. Old content entries remain
until `.explainer/cache` is removed; no eviction policy is added here. The whole `.explainer/` directory is
excluded from discovery and clean-tree checks. Before lookup and persistence, the cache compares the device
and inode of `.explainer`, `cache` and `extraction-v1` against a per-build repository directory census.
The census includes empty and ignored directories outside root `.explainer` and `.git`: new output could
affect discovery or Git's clean-tree decision. The census follows directory links, including tracked paths
that Git can still list through a symlink. Directory identities use bigint `stat` values; repeated identities
stop census recursion. A match bypasses reads and writes, sets `extraction.enabled` false and
reports `extraction.bypassReason`. Inspection failures also bypass reuse. Symlinks, bind mounts and other
directory aliases share this rule; source at a matched target stays discoverable. Isolated external targets
remain usable. The cache location is fixed: no option or environment variable redirects it. An indexed root
may itself be a symlink. Location eligibility does not change extraction facts or their key revision.

Every build discovers and captures sources again, recomputes source hashes, assigns IDs/hashes/parents,
resolves all heuristic sites (including Go inference), resolves resources, runs selected semantic providers,
and normalizes/merges coverage. Renames/language changes miss because identity is in the key; deletions and
filters simply stop consuming old entries. Repository configuration (`tsconfig` aliases, package exports,
Python/Go module settings) is read fresh during resolution/tooling, so unchanged callers may resolve differently
without re-extraction. It is not an input to the current file-local extractors. Language filters, precise mode
and commit overrides likewise do not affect a retained file's extraction. A future extractor that reads
configuration must include its content in the profile configuration key. The default pipeline retains full
resolution; this cache never treats a source-only key as semantic evidence.

`BuildIndexResult.extraction` and CLI JSON expose enabled/scope/hits/misses/write failures, an optional bypass
reason (also printed in the text summary), and wall milliseconds for cache eligibility/lookup, parsing and
extraction, and cache writes only. Plain text includes that scope. Text files without
an extractor count as neither hits nor misses. `work` reports fresh heuristic-resolution wall time, semantic
provider runs and their wall time (including failed attempts), separately from extraction. Timings never enter
`SymbolIndex`, capability reports or bundles. [extraction-cache.md](extraction-cache.md) gives the repeatable
whole-index equivalence check, pinned benchmark commands, CPU/wall time, peak RSS and disk costs.

**Semantic invalidation experiment** (`src/resolve/typescript-experiment.ts`, #17). An explicit
`BuildIndexOptions.experimentalResolution` instance retains TypeScript-pack heuristic references between
builds in one process. The CLI never supplies it. Exact extraction input (including #16's revision, provider
and WASM identities) and normalized symbol entries identify a file; `SEMANTIC_REVISION` additionally versions
resolution rules. Reuse requires unchanged transitive imports/re-exports and same-directory candidates.
Both old and new reverse dependencies invalidate callers. File discovery and configuration changes resolve
the whole project, including sites with no previous edge. Configuration includes every non-TypeScript source
and module-resolution text reads, including missing and ignored files. Unsupported heuristic packs or
unavailable extraction identity (disabled cache, directory alias, missing/mismatched WASM, failed extraction)
discard retained state and resolve everything. Lookup tables, pack inference, resources and external providers
always run fresh. State is never persisted and reports/timings never enter `SymbolIndex`. The
[dated assessment](assessment-2026-10-04-semantic-invalidation.md) records the whole-index mutation harness,
real-history fallback rate, separate bookkeeping/resolution costs and the decision on broader reuse.

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
  readConfiguration?(file, repo): void; // preload local config through the shared reader
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
  readConfiguration?(file: FilePath, repo: RepoView): void; // pure local reads, shared with packs
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
replacement requires both symbols and declaration ranges and at least one placed declaration. Partial
structural results cannot remove existing IDs: they fall back to range-only updates of matching nodes.
Range-only coverage keeps the existing symbol set. Nesting changes only for matching nodes under explicit
nesting coverage; unmatched nodes keep their parents. A blind occurrence preserves the smallest enclosing
heuristic hint. Source and resolution provenance remains on each fact; report version,
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

Adapter rules (from mapping SCIP, Kythe and CPG artifacts, `docs/assessment-2026-10-04-graph-formats.md` §5.2):
send only facts xpl can check, since one rejected fact removes its file from all of the report's coverage; claim
`symbols` for a file only with its complete symbol set (next to a language pack, claim `declarationRanges` and
use the pack's `<file>#<path>` IDs as endpoints); never advertise a kind the adapter does not map, withdraw
coverage per file and kind where facts were dropped, and report seen-but-unresolved positions as `blind`.
Declare `mode: "syntax"` only for a provider that reads the captured sources itself; artifact and tool adapters
are semantic and stay off under `--precise off`.

Cost and reuse: the syntax provider parses each source once for extraction; heuristic resolution stays inside
it. SCIP runs per repository/project/module, with the timeout and fallback policy below, and may reparse sources
through the optional plain classifier. The syntax adapter owns that reparsing. Both adapters use the same
normalization and merge functions. The run snapshot covers indexed source and configuration files; configured
external artifacts must report hashes of the source they actually consumed, not stamp current hashes onto old
facts. The built-in SCIP adapters check source/config hashes before and after tool execution, including changes
that leave positions in bounds. They cannot detect a file changed and restored during execution. `configuration`
names the adapter's active profile (`builtin-packs` or `tool-defaults`); snapshot identity covers captured files.
Toolchain/environment dependencies outside that snapshot are not reusable semantic evidence. File-local extraction
is reused as described below; repository-wide resolution and semantic providers always run again.

The built-in tool adapters keep SCIP relationship mapping over existing syntax declarations. The separate
`scipArtifactProvider({ artifact, manifest?, languages? })` imports declarations without a language pack.
The CLI selects it with `xpl index --scip <artifact|manifest.json>` instead of automatic semantic tools,
retaining registered syntax-mode providers first. Artifact import keeps existing syntax symbol sets and may update matching
checked declaration ranges. Files without existing symbols can receive the artifact's placed declarations. In a mixed repository, `require` still needs precise relationships for
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
does not discard valid coverage. Structural coverage names only files with placed declarations. The
artifact claims `symbols` only where no existing provider supplied a symbol set; elsewhere it claims checked
ranges and keeps the existing IDs and nesting. Each result's `analyzedFiles` identifies its provider's files,
and each symbol's provenance identifies the provider of its checked range. Empty structure claims cannot
erase previous declarations. Kinds map to xpl's coarse kinds; unknown kinds become `other` with diagnostics. Descriptor paths preserve nesting; overload identities stay
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
Source-checked definition identifiers can link SCIP identities to existing same-file syntax symbols when
the definition occurrence exactly matches a source-checked declaration identifier (file, line and column
range), the descriptor and kind are supported, and the match is unique. Both references and range updates
use that existing canonical ID, including its duplicate suffix. Missing identifier evidence, unsupported
descriptors and ambiguous matches are diagnosed and omitted. Name and declaration start line do not establish
identity. Checked identifier spans stay in the in-memory provider lookup; they add no stored index field.
This creates no declaration from an identifier extent.
External symbols and accessor targets without checked definitions never create local declarations.
Relationship coverage requires retained checked targets, either imported or linked to existing symbols.
A range-less standalone artifact with no targets cannot earn `precise` or satisfy `require`; explicit
analysis with checked targets and zero relationships still can. Reports remain partial, including empty
results. Producer ranges may omit leading documentation; the importer never substitutes an identifier extent
for a full declaration. The CLI reference documents generation and
manifest creation. Java uses this importer without a language pack or new `FileLanguage` value.
`scripts/java-scip.ts` runs the pinned Maven producer workflow, captures source/config hashes before
generation, checks them afterward, and writes a manifest only for a successful run with a fresh artifact.
Missing JDK, Maven or scip-java and build failures exit 1 with a file-anchor fallback instruction. Java
remains `text`, including plain editor range highlighting; code-only search and automatic Java service
classification are not added. [docs/java-scip.md](java-scip.md) records versions, commands, literal fixture
facts, losses and fixture/Gson generation and import costs. Calls and implementation flags remain unsupported.

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
`changeOmissions` intersects the change's paths with the loaded index's observed reports. It names report-level
partial, unsupported or failed outcomes with the count of changed paths actually analyzed, without assigning a
report-level limit to each file. It also names paths absent from the loaded index and removed files whose old
code it cannot inspect. A commit mismatch is called out: those results describe the loaded index, not the
change head. The list is capped at five items with a remaining count; no result or missing legacy report is
treated as proof of complete analysis. Pruned and packed bundles retain the original reports.
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
`bundle`, `index-pack`, `prune`, `levels`, `lint`, `readiness`, `source-files`; all re-exported from `index.ts` except the internal helpers of
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
  `edge:<kind>:<a>-><b>` with `count`, `resolution` (`precise` or `heuristic` when all references agree, otherwise `mixed`) and derived
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
  kind, label?, summary?, count, stored, anchors, via?, resolution: "precise" | "heuristic" | "mixed" | "llm" | "user" |
  "static" }`; `ghosts[i] = { id, key, kind: "target" | "rest" | "more", label,
  target?, kinds, count, direction: "in" | "out" | "both", targets }`; `stubs[i] = { id, direction, inside,
  ghost (the key), ghostLabel, targets, kinds, count }`.
- The viewer also preserves mixed confidence when it combines edge kinds between the same boxes.
  Mixed arrows are subdued like heuristic arrows and labelled "mixed confidence"; their details say
  that some references are hints. Selection details and code focus use the drawn aggregate
  (all kinds, total reference count and their anchors). Individual index references remain `precise` or `heuristic`.
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
anchor-missing evidence frame cycle step commit change review protected`. Messages are written for Claude to fix its
patch from. Rules:

- Shapes and enums; `schema` = `code-explainer@0`; `repo` and `index` present. An `index.commit` other than
  the given index's is a warning (`commit`) that points at `xpl resolve --write`. A tour's `summary` is a string.
  An empty `title` is a warning; the explainer's `scope` is `{ audience? }`, one line of at most `AUDIENCE_MAX`
  (120) characters (longer is a warning). A node's `role` is one of `NODE_ROLES`, its `tech` a string.
- `review`: exact fields and fingerprint version/hashes, non-empty reviewer and omissions, UTC ISO time,
  unique non-empty content IDs, known source policy and repository-relative file paths. Historical records
  remain valid when their content or evidence disappears; `checkReview` reports them out of date separately.
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

**Readiness (`readiness.ts`).** `checkReadiness(explainer, index, texts, { scope, sourceWarning?,
decisionNote?, requireReview? })` combines strict validation, source availability/hashes and the required text
counted by `viewContentStatuses` (also used by `xpl status`), and `lintExplainer` (now in core). Errors block ready
export; reader warnings remain visible for author judgment. Required text includes visible nodes and
participants, stored arrows, flow/sequence steps, concepts, tour summaries and step notes. Hidden deeper
nodes and static arrows do not need summaries. A guide needs a view; a tour needs steps. Cached anchor
resolutions cannot substitute for missing source, including the before-source of a change. `source-files.ts`
selects the same referenced source for readiness and CLI embedding, including source behind stubs.

The report is `{ ready, scope: "workspace" | "embedded-snapshot", identity, errors, warnings, findings,
review: { status: "unchecked" | "reviewed" | "out-of-date", required: boolean }, decisionNote? }`. Each finding
has `{ severity, code, elementId, field, message, hint }`; structural `field` values retain validation's JSON paths. `decisionNote` records an author's reason for warnings or omissions;
it never overrides an error. Workspace discovery stays in the CLI: it compares all indexed/discovered file
hashes, including added/deleted files, and passes any difference as `sourceWarning`. An offline re-save can
check only its embedded snapshot. Source checks establish locations, freshness and required text; they do
not establish prose truth, exhaustive execution coverage or formal reviewer approval.

`requireReview` is an explicit team policy, off by default. It adds one `review-required` error when the
record is absent, out of date, or covers selected content instead of `content: "all"`. It requires the
record's chosen evidence scope, not compulsory whole-repository inspection. Named omissions remain author
judgment and do not bypass other blockers. With the policy off, review state adds no findings or changes to
ordinary readiness. Legacy saved reports may omit `review`; freshly checked reports include it.

`artifactIdentity(explainer, index)` returns `{ explainerHash, sourceHash }` using `hashText` over canonical
JSON (sorted object keys, array order retained, undefined fields omitted). `explainerHash` covers the whole
stored explanation, including provenance, anchors, resolved ranges and index metadata. `sourceHash` covers
the sorted full indexed `{ path, hash }` manifest plus optional change base/head SHAs; the base SHA identifies
the before-source. Explanation edits change the first hash; changed indexed source or change commits change
the second. Source embedding choices, index pruning, launch mode, server URL and HTML do not change identity.
Re-resolving metadata can change `explainerHash`; reindexing identical source leaves `sourceHash` unchanged.
This identity lives in core for export and feedback/revision consumers, independent of reviewer records.
`sourceHash` identifies indexed source: a stale draft/workspace can contain code that differs from it.
Consumers must also check readiness/freshness before accepting a revision or retargeting feedback.

**Scoped review (`review.ts`).** `reviewFingerprint(explainer, index, texts, scope)` hashes a separate
projection; it does not change `artifactIdentity`. `content: "all"` covers stored nodes, edges, concepts,
views and tours plus title, audience, repository name/URL and the change record. A list selects exactly the
named stored node/edge/concept/view/tour records. A view includes its steps; a tour includes its notes and
code overrides. Dependencies are not selected automatically: a view's included nodes and a tour's focused
elements need their own IDs to cover their prose and anchors. Derived boxes/arrows and runtime paths outside
the selected records are outside this inspection. Name them as omissions or explicitly widen the scope.

`source: "anchored"` covers the selected records' attached anchors, including before-source read through
`TextCache.textAt`. `files` adds named whole indexed files. `source: "repository"` also covers the full
indexed path/hash manifest, so any indexed addition, deletion or edit invalidates that broader review.
Source hashes are computed from readable text; missing text and drifted/missing anchors cannot produce a
fingerprint. Discovery/freshness of the working tree remains a separate readiness check. A narrow review
survives unrelated files and edits outside its anchor spans, even in the same file. Exact anchor moves
survive too: the projection excludes span offsets, resolution caches, provenance and current index/repo
commits. Anchor file/symbol/role/side and hashes remain bound. `sourceCommit` records the index used at
inspection time; later commits alone do not invalidate a narrow review.

`checkReview(explainer, index, texts)` returns `{ status: "unchecked" | "reviewed" | "out-of-date" }`.
Changed selected prose, anchor identity/hash, additional whole files, missing content or unavailable
evidence make the record out of date. Review metadata is excluded to avoid hashing the record into itself.
The explainer carries the record through existing live and portable bundle serialization. `reviewSourceFiles`
selects whole files explicitly covered by a review; CLI/live bundles include these alongside referenced
source so the same fingerprint can be checked offline. No record means no additional embedding. Missing
evidence makes the record out of date, never implicitly current.

### 4.7 Patches (`apply.ts`)

`applyPatch(explainer, patch, index, getText, { actor: "llm" | "user" }) → { ok, explainer, issues, changed }`,
atomic: any error → `ok: false` and the input explainer, untouched.

- Upsert by id, shallow-merged as in §2. An id twice in one patch, or upserted (or changed by a `stepsUpdate`)
  and removed by the same patch, is an error. Top-level keys: `title scope nodes edges concepts views tours
  remove review`; `scope` merges `{ audience }` into the explainer's (`null` clears). `remove` takes elements,
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
- **Author review.** A user patch sends a complete `review` input (all record fields except `sourceCommit`)
  with the fingerprint of the content/evidence the author inspected. Apply compares it with the final
  merged scope, so concurrent source changes and relevant edits in the same patch reject the record
  atomically. `sourceCommit` is filled from the index. `review: null` explicitly removes the record.
  Any LLM patch carrying `review` is a `protected` error, including creation, overwrite and removal.
  Generated patches that omit it preserve the record, even when their edits make it out of date.
- New elements, views and tours get `provenance = { origin: actor, commit: index.commit }` unless given; a
  changed `llm` element gets `provenance.commit = index.commit`.
- Anchors go through `makeAnchor`, steps and tour `code` overrides likewise, frames are checked. A patch
  with a `change` key is rejected: the change record comes from git, through `xpl change` (§5).
- The bundled skill includes `reference/patch.schema.json` for editor completion and JSON shape checks.
  It follows the patch-side fields and graph/sequence/flow view discriminators. It cannot check whether
  source text, IDs, review fingerprints or user-owned fields are valid for this repository; `applyPatch`
  remains the authority for those checks. Editors associate the schema externally: `$schema` is not a
  patch key. It rejects simultaneous `span`/`find` and negative offsets; `applyPatch` checks offset order
  and source bounds. Copied stored anchors may carry `resolved`, which apply recomputes.
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
  that change nothing are not listed), plus `"title"`, `"scope"` and `"review"` when they change; a `stepsUpdate` lists
  the view and each step it changed (a tour's steps as `<tour id>/<step id>`).

**Bounded user edits** (`user-edits.ts`) carry a collection (`nodes`, `edges`, `concepts`, `views`,
`groups`), item ID,
and before/after values of the same fields. Only `label`, `summary`, `detail`, `anchors` and a concept's `related`
are accepted on elements. Group nodes also allow `members`; graph views allow only `include`, `hidden` and `layout`.
`groups` is a bounded existence operation: `node` is either null (absent) or a complete group snapshot
without id, kind or provenance. One side must be null. Creating/removing a group uses ordinary node
upsert/removal, not a new stored collection. Snapshots require label, parent, members and anchors; optional
text, role, tech and opens are accepted. At most 32 items per transaction, 64 anchors per item and 10,000
graph IDs per list are accepted; each edit target ID is at most 200 characters. The HTTP body limit also applies.
`applyUserEdits` checks touched fields against the current model, creates an ordinary `user` patch and
returns a conditional inverse. Missing optional fields become `null`. The inverse never contains
provenance or review records; undo keeps user ownership and lets scoped fingerprints follow content.
For a new structural overlay, undo restores the effective default fields rather than deleting a record
that another author may have enriched. Anchor comparisons omit only the `resolved` cache, retaining hashes,
roles, sides and coordinates. Inverse preconditions use the actual normalized, hash-checked saved anchors.
`applyPatch` checks every proposed anchor; a repair must replace or remove all invalid evidence on that item.
An inverse that would restore missing or drifted source is rejected without moving history.

`makeGraphEdits` groups at least two visible sibling boxes from the stored include list, keeping those
boxes included inside the new group. Siblings share an effective parent before hiding is applied; a hidden
container still owns its children. For a nested group, that parent group's direct membership changes
to contain the new group. Structural parents, evidence, stored edge endpoints and tours are untouched.
Ungroup replaces the group in this view's include with its members, retaining the stored group for other
references. Hide/restore changes only `hidden`, including IDs drawn by a transiently opened level. Inverses retain
array order and the absent hidden state.
Undoing creation checks the entire group for enrichment and atomically restores include/membership and
removes it. A later reference to that group makes removal fail rather than leave a dangling reference.
User ownership survives every inverse; LLM refreshes preserve groups and edited membership/visibility.
Pin and reset replace the stored map's bounded `layout` object (finite x/y pairs, node IDs only), marking
that field as user-owned. Their conditional inverses restore its exact previous value, including absence.
Reset may clear selected pins or all pins; a later placement edit conflicts rather than lose another pin.

### 4.8 Also in core

- `query.ts`: `query(index, getTextOrCache, options)` searches retained symbol names, supplied source
  text, guide metadata, concepts, tours and tour/flow/sequence steps. Source results carry the first match
  on each line as a 1-based inclusive UTF-16 range, enclosing element ID and symbol-relative offset.
  A zero-width regex match names the whole line. Symbols carry their indexed declaration range. Guide
  results carry a catalog key and the guide's index commit, with stable element/tour/step/view IDs;
  tour steps also carry their zero-based position and focus IDs. These are navigation targets, not URLs
  or newly verified anchors. `limit` defaults to 50; 0 returns all. Optional `offset` skips matches
  before retaining a page; totals count every match before offset and limit. Both must be non-negative integers.
  Code source comes first, then config, then other text; retained symbols follow, then supplied guide
  context in catalog order. Literal search keeps lower-case substring semantics; regex uses JavaScript.

  Query scope separates the index commit and text origin (`working-tree` or `supplied`), all indexed
  paths, selected paths, searched paths and unavailable text. It records retained/original symbol and
  reference counts plus the original `analysis` reports (absent means unknown). Reports still describe
  the original run after pruning; they do not establish completeness of retained symbols. A failed or
  unsupported symbol provider does not prevent source search. An empty result cannot establish absence
  in unavailable text, missing analysis or pruned symbols. Only indexed paths are read through `GetText`;
  core performs no filesystem, service or network access. Head/supplied text is searched; base text is not.

  `guideCatalog(guides)` projects title, audience, distinct view questions/roots, source/index commits
  and optional change base/head from supplied explainers. A change record marks a change guide; a
  question marks a question guide; otherwise a repo root marks a repository guide, another recorded
  root a subsystem guide, and no recorded view scope is unknown. Filenames never determine scope.
  Local and exported callers supply their own stable keys and available explainers. This contract does
  not change `ViewerBundle`; the viewer search, guide picker and exported navigation follow in #35B.

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
| `xpl index [--precise auto\|off\|require] [--commit c] [--no-cache] [--scip artifact\|manifest.json]` | build + write the index; caches file-local extraction by default, `--no-cache` bypasses reads/writes, resolution and semantic tooling stay fresh; `--scip` selects source-verified artifact import instead of automatic tools; writes `.explainer/.gitignore` (`index-*.json`); prints per-language trust, independent coverage, enumerated exclusions and names explainers bound to another index |
| `xpl outline [--under <id>] [--depth n] [--kind k,...] [--keys] [--limit n]` | dir/file/symbol tree with kind, lines, fan-in/fan-out (references into/out of the subtree); default depth 2; config keys only with `--keys`; `--kind method,function` keeps only those symbol kinds, with the dirs, files and parents that hold a match; the repo line carries the name `xpl new` records |
| `xpl show <id> [--refs] [--context n] [--lines a-b] [--max-lines n]` | code with 0-based offsets relative to the symbol (the numbers spans use); dirs and the repo list children; `--refs` appends outgoing and incoming references with `+offset`. `xpl show --at base <path> [--lines a-b] [--explainer name]`: a changed file as it was before the change the explainer records, with the offsets a base anchor's span uses (from line 1) and `-` on the lines the change removes or rewrites; paths only (a symbol id is a usage error); `--explainer` picks the explainer when several record a change |
| `xpl refs <id> [--in\|--out] [--kind k] [--depth n] [--max-children n] [--limit n] [--tests]` | call/reference hierarchy with sites; hops through interfaces as `impl` lines and through base classes (TS, JS, Python) as `override` lines; test doubles and test subclasses hidden unless `--tests`; a subtree is printed once (later occurrences: `(expanded above)`), at most `--max-children` (default 15) references under a line of a hierarchy (`... +8 more`); `--kind read` finds the readers of a variable or field |
| `xpl search <pattern> [--regex] [-i] [--limit n] [--under <dir\|glob>] [--code]` | text hits over the working tree with enclosing symbol id and offset; code files first, then config, then docs (`--code`: code only); `--under` keeps the search in a dir, file, symbol or glob |
| `xpl guides` | local guide metadata by title, recorded view questions, audience and source/index snapshot; no index or service required; unreadable/invalid/escaping guides are separate errors, exit 1; no guides is exit 0 |
| `xpl new <name> [--title t] [--repo r] [--url u]` | create `.explainer/<name>.explainer.json` bound to the index; never overwrites; repo name from `--repo`, else `package.json`, `go.mod`, `pyproject.toml`, git remote, directory name |
| `xpl apply <explainer> <patch.json\|-> [--actor llm\|user] [--dry-run]` | §4.7; prints every issue of a rejected patch at once; atomic; `--help` summarises the patch format |
| `xpl validate <explainer> [--lenient]` | §4.6 |
| `xpl anchors <explainer> [id...] [--full] [--max-lines n]` | each anchor of an element (or of every element) resolved now: role, `file#symbol +span`, status, lines, and the code at them with offsets (a long anchor: its first lines, an elision line, its last lines); a base anchor prints as `<file>@base +a..b … [before the change]` with the base code; `tour:<id>` (or `tour:<id>/<step>`) also shows what a step without `code` derives from its `focus`, marked derived; verifies spans without reading JSON |
| `xpl resolve <explainer> [--write] [--allow-stale]` | §4.2 re-resolve against the index of the current code; report drifted llm elements, missing anchors; `--write` saves |
| `xpl feedback <explainer> [--import <file> \| --export <file> \| --outcomes <file>]` | durable reader feedback: stable-ID import deduplication, snapshot context inspection, portable export and selected-ID outcome merges; no generation |
| `xpl revise <explainer> --select <id,id> [--include <id,id>] [-o file]` / `--run <id> [--proposal file \| --decisions file \| --accept]` | explicitly selected feedback; bounded ordinary patch proposals, source and explanation diff; author subset/missing-anchor decisions; identity/freshness/readiness before atomic acceptance; prior artifact and retry journal |
| `xpl status [explainer] [--view <id>] [--all]` | `--all` inventories every repository guide against one current index, without saving prose; otherwise the skill's to-do list, read-only: per view the shown nodes, stored edges and steps without a summary (static edges optional), concepts without one, drift (user-owned drift counted apart), missing anchors, broken references (ids gone from the index), stale derived-edge overlays, queued requests; per graph view the ghosts and stubs it draws (counts, the most referenced ghost ids, and for each folded ghost up to 3 of the elements it stands for with their counts; `--json`: every ghost with its count and all its `targets` (`{id, count}`), and every stub id, in `views[].ghosts`) with a warning above 12 ghosts; the tours (id, step count, steps whose focus ids or view are gone); `--view <id>`: that view only, with what it draws (each arrow: id, kind, ends, references, stored or derived, label; each `hidden` id and what it takes out; a flow's step links) |
| `xpl ready <explainer> [--note reason] [--require-review]` | shared readiness report before export; `--json` adds `ok` to the report above; 0 ready (warnings allowed), 1 blockers/failure, 2 usage; writes nothing; a note records intentional warning/omission decisions |
| `xpl lint <explainer> [--patch <file\|->] [--warn-only]` | checks the text a reader sees (the index, when there is one, counts the boxes and arrows of maps): rules below; `--patch` lints the explainer as it would be after `xpl apply` of that patch (merged in memory as actor `llm`, nothing written; a patch apply would reject prints the rejection and exits 1); exit 1 with any finding (so `lint --patch && apply` stops on one), 0 with `--warn-only` unless a `todo-left` error |
| `xpl change <explainer> [<base>..<head>]` | records the change from git in the explainer and prints its analysis (§4.8; below); without a range, prints the analysis of the change already recorded |
| `xpl pr prepare <url\|owner/repo#number\|owner/repo> [number] [--cache-dir dir] [--precise off\|auto\|require]` | resolves GitHub base/head through existing `gh`, fetches an isolated detached head, indexes head only and publishes an immutable input manifest; no agent or ready result |
| `xpl pr cleanup <directory> [--cache-dir dir]` | removes only a marked owned PR input directly under the selected cache; refuses symlinks and developer-tree paths |
| `xpl pr link <staged-dir> --url <base-url> --visibility team\|public` / `xpl pr check-link <PR>` | points one PR comment at the staged current version after a GitHub base/head check; a PR workflow marks it outdated when base/head move (below) |
| `xpl draft change\|repo\|path <explainer> [<entry id> ...] [-o file]` | prints a patch skeleton built from the index (and the change record) with no LLM, `TODO:` in every text to write (below); the summary goes to stderr |
| `xpl view <explainer> [--port p] [--host h] [--no-open]` | local server (below) |
| `xpl service <start\|pause\|resume\|stop\|status> [explainer] [--background] [--port p] [--backend none\|claude] [--skill-dir folder] [--job-timeout seconds] [--recover] [--watch]` | optional repository-scoped lifecycle around the same viewer server; loopback only; persisted context and explicit interrupted-owner recovery |
| `xpl bundle <explainer> -o out.html [--mode explore\|present] [--tour id] [--files referenced\|boundary\|all] [--boundary-max n] [--embed-index full\|pruned] [--draft] [--note reason] [--require-review] [--allow-drift]` | self-contained HTML after the shared readiness check (exit 1 before writing with errors); `--draft` writes a labelled preview with findings; `--allow-drift` is a legacy draft flag that still refuses stale indexes; warnings and optional author notes are retained; `--tour` (`tour:intro` or `intro`) implies present mode; embeds the files the explainer references by default and prints what went in (`8 of 12 files embedded (referenced: 18.4 KB of source; --files all adds 4 files, 6.7 KB)`), `--files boundary` adds the direct callers, callees and tests of anchored symbols (at most `--boundary-max`, default 40), `--files all` every indexed file; with a change recorded, every changed file at head and the base text of the changed files go in too; the symbol index in it is pruned to what the viewer can draw with `--files referenced` or `boundary` and whole with `--files all` (`--embed-index` overrides) and packed (the summary line says `index 0.3 MB (1.3 MB as plain JSON, pruned from 9.0 MB)`) |
| `xpl doctor [--agent none\|claude\|codex\|pi\|droid\|devin] [--skill-dir path]` | local setup report: Node, artifact hashes, grammar loading, installed skill and optional git/npx/Go; selected harness availability; no downloads or authentication probes; required failures exit 1 |
| `xpl stage <explainer> --dir <outside-folder> [--preview] [--files referenced\|boundary\|all] [--note reason] [--require-review] [--pr-result result.json]` | previews included head/base files; stages only ready local HTML and an immutable manifest, rechecks inputs before promoting an atomic current symlink under a lock; retains prior versions; PR guides require a verified ready result and a final GitHub base/head check |
| `xpl skill install [--agent claude\|codex\|pi\|droid\|devin] [--dir path]` | copies the bundled skill and writes its CLI binding; repeat to update; Claude is default; defaults to `~/.claude/skills/code-explainer` for Claude, `~/.agents/skills/code-explainer` for Codex/Pi/Droid, and the current project's `.agents/skills/code-explainer` for Devin; refuses unmanaged directories, symlinks and local edits |

**Installed artifact.** Workspace packages remain private. `npm run build` writes standalone package
metadata in `packages/cli/dist`, with `@xpl/cli`'s version, a `bin` entry, Node >=22.12 and no dependencies
or install scripts. The viewer is required at build time. The directory carries the bundled CLI, viewer,
WASM runtime and grammars, Rust tags query, the skill, a short README, MIT LICENSE and `integrity.json`.
The published name is `publishName` (`@krimvp/xpl`) in the private `@xpl/cli` workspace manifest; its version is
0.2.2. The installed-artifact check retains service restart/recovery and checks watch pause/resume,
durable job history and unavailable-runner submission. It also checks the published name/version, license
and packed file inventory. npm rejected `xpl` as too similar to an existing name; `@krimvp/xpl` is the selected fallback.
`npm run pack -- --pack-destination <outside-repo-dir>` builds and packs that directory. Install its local tarball with
`npm install --global --prefix "$HOME/.local" --offline --ignore-scripts <absolute-tarball-path>`; put
`$HOME/.local/bin` on PATH. No source build is needed at installation. This source tree builds version 0.2.2;
a `v*` tag starts publication. Install the latest published version with
`npm install --global @krimvp/xpl`. Nothing is published by build, pack, diagnosis or skill installation.

The release workflow accepts an owner-created, immutable `v*` tag only when it points to `main`, matches the
package version and names a version absent from npm. On GitHub-hosted Ubuntu it builds, checks the installed
tarball, runs package dry runs, then publishes through npm trusted publishing with provenance and creates a
GitHub Release. npm must trust `.github/workflows/release.yml` for `@krimvp/xpl`; GitHub-hosted Actions must
be available before a tag is created. Pages builds the public site from that same tag.

`doctor` checks SHA-256 hashes from the artifact inventory and loads every grammar. Hashes detect damage,
not publisher identity. Skill availability is optional for reading, required with `--agent claude`.
It checks the managed copy's hashes and executes its launcher with `--version`. Optional tools are checked
only with local version commands; their presence does not prove precise analysis or agent authentication.
The Go probe forces `GOTOOLCHAIN=local`, ignores user Go configuration and disables telemetry without
writing settings. Git tracing is disabled for its probe. No Python or SCIP tool launcher is invoked.
Recovery instructions distinguish reinstalling the artifact, reinstalling the skill, precise fallback and
separate Claude Code setup. `--precise off`, local viewing and HTML export need no hosted xpl service.
Precise tool/toolchain bootstrap and repository dependencies may need network; agent provider access has
separate network requirements. Trust labels remain unchanged. Generation remains explicitly user-invoked.

`npm run test:install -- <scratch-dir>` builds, packs, installs offline and exercises TS/Python/Go fixture
copies, local viewing and offline HTML in pinned Chromium. It checks refusal before writing unfinished
ready output, explicit draft labels and disconnected ready exports. CLI subprocesses have Node filesystem permissions
for scratch only, with a negative checkout-read probe. The harness permits child processes for local git
and version checks; it is a check of CLI file reads, not an OS sandbox for arbitrary child tools.
Only Linux x64 (WSL2, Node 22.23.1) has been exercised against the installed artifact.

**Exit codes.** 0 ok (warnings allowed); 1 rejected or failed: unknown id, no index, a rejected patch, a patch
that changed nothing because the user owns everything it touched, validation errors, `resolve --write` on a
stale index, an explicit `--port` in use, `xpl ready` or ready `xpl bundle` with readiness blockers,
`xpl change` without git or with a head that is not the index commit, `xpl draft change` without a change
record, `xpl lint` with findings; 2 usage error. **Environment:**
`XPL_VIEWER_HTML` (viewer page for `view` and `bundle`), `XPL_SKIP_STALE_CHECK=1`, `XPL_WASM_DIR`,
`XPL_SCIP_TIMEOUT_MS`, `XPL_DEBUG=1` (stack traces), `XPL_CLI` (the skill launcher: an `xpl.mjs` to run).

**Files in `.explainer/`:** `index-<commit>.json` (generated, git-ignored by `.explainer/.gitignore`),
`cache/extraction-v1/` (generated file-local facts, git-ignored), `<name>.explainer.json` (committed),
`requests.json` (the queue below), `revisions/<uuid>/` (generated, git-ignored revision journal and prior
artifact). Writes are atomic (temp file + rename).
CLI apply/resolve/revise, creation, viewer edits and request appends also share per-file directory locks
across processes.
Read input before locking; read the latest file, merge and check ownership, then write while holding the lock.
Locks are never stolen on a timer. A crashed writer may leave `<file>.lock`: after verifying the writer has terminated,
remove that directory and retry (writers time out after 30 seconds with that instruction).

**Index selection**, in order: `--index <path>` (relative to the working directory, else to the root); for
explainer commands, the explainer's own `index.path` when that file exists (`xpl resolve` and `xpl feedback` **ignore** it: resolve
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
`{ ok, path, written, change, analysis, omissions }`.

`xpl search` delegates matching, source ordering, line counts and symbol attribution to core `query`.
CLI `--under` still resolves targets and globs with suggestions; CLI text comes from the working tree.
Its existing hit JSON fields remain unchanged. `--json` adds `scope` from the pure query; unavailable
source paths also produce a warning. Text search does not require successful symbol analysis.

`repo.ts` discovers concrete `.explainer/*.explainer.json` paths. `listExplainerNames` derives keys
from those paths; `loadRepositoryGuides` checks each canonical boundary and reads that exact file,
without resolving keys through the command's name-or-path resolver. Loading requires no index and
does not gate evidence on catalog metadata. `xpl guides` checks metadata and reports descriptors;
loadable files with invalid metadata stay listed by ID/path with `metadataError`, also in `errors`.
Empty string titles stay recorded as empty. Directory read failures remain failures, and per-guide
read/metadata errors are separate from a valid empty library. No readiness/freshness check or write occurs.
`inventory.ts` uses the same loader for `status --all` and watch attention reports, then re-resolves
and validates copies. Its moved, drifted and missing classifications and report fields stay unchanged.
Implicit `show --at base` selection uses this loader too, so a guide name ending in `.json` cannot
select a different repository JSON file. Unreadable guides still fail selection.

`core/src/languages.ts` classifies every `FileLanguage` with a code display name or `undefined` for config
and other text. Its derived `CODE_LANGUAGES` set is shared by code search and repo drafts; Rust participates
in both, and its draft service boxes carry `tech: Rust`. Adding a language requires a classification.

**GitHub PR inputs.** `pr.ts` parses GitHub.com URLs, `owner/repo#number`, or `owner/repo` plus a number.
It calls `gh api --hostname github.com repos/<owner>/<repo>/pulls/<number>` using existing access,
validates the response identity and records the returned full base/head SHAs, repositories and branch names.
Only GitHub reads occur. Existing `gh`/git authentication and network access to GitHub are required;
the command does not log in, prompt for credentials, comment, publish or start a service.

`pr-checkout.ts` creates a separate repository in a fresh `input-*` directory under
`$XDG_CACHE_HOME/xpl/pr` (otherwise `~/.cache/xpl/pr`), or `--cache-dir`. Canonical paths must stay outside
both the developer's root/working directory and their git top level. No developer branch, ref, index or
working file is written. Git hooks and submodule recursion are disabled. The base SHA is fetched first;
head fetch tries its exact SHA in the base repository, the GitHub PR head ref, then the fork's exact SHA
when known. A fetched ref is accepted only when the originally resolved head commit exists locally;
a moved ref never silently substitutes another head. Each fetch has depth one, no tags or submodules.
The head is checked out detached. Index output refuses repository-supplied `.explainer` symlinks, and
head indexing uses fresh extraction with no repository-supplied cache. `--precise off` is the default;
`auto` and `require` explicitly opt into optional analysis tools and their toolchain/network requirements.
One sanitized Git context pins all direct PR Git reads and writes to the owned git directory/work tree.
Shared indexer discovery/commit helpers and CLI diff/source readers accept optional `GitOptions`
(`env`, global `args`); ordinary callers keep their existing environment and discovery behavior.
SCIP adapters receive the sanitized environment through their existing tool options. Before indexing,
every materialized blob is compared with the head tree's raw blob ID, including binary bytes and symlink
text. A smudge, encoding or line-ending conversion that changes bytes refuses preparation and removes
staging. A clean-filter round trip or `git status` is not sufficient proof of raw source identity.

The CLI-only `PrInputManifest` has `schemaVersion: 1`, `kind: "github-pr-input"`, preparation time,
`pr` identity, `change`, `sources`, `index`, head `analysis` and `warnings`. `change` uses the existing
rename-aware `computeChange` over **API base..head**, not a computed merge base. `sources` retains each
changed path, optional old path and before/after states: `text` with exact git text, `absent` for an added
file's before or a deleted file's after, or `unavailable` with a reason (including binary source).
`index` carries its relative path, full head commit, SHA-256 of the saved index, indexed path/hash manifest
and language trust labels. Callers/tests come from head only, with existing precise/heuristic labels;
they do not prove runtime impact or exhaustive test coverage. The input manifest is published atomically
last and made read-only. Each run gets a separate directory; earlier manifests are never replaced.

Failures remove only that run's owned directory and produce no input/ready result. A killed process can
leave `.xpl-pr-owned.json`; explicit `cleanup` checks its canonical cache/directory ownership before removal.
Stop any consumers before cleanup. Inputs are retained until cleanup; no timer removes them. An input
manifest alone must never be promoted as a ready or current version.

`pr-creation.ts` owns the manual creation handoff and local result contract. `xpl pr create` prepares the
input, verifies the installed skill inventory/absolute CLI binding and runs that skill's launcher for
`new`, `change API-base..head` and `draft change`. `--name`, `--audience` and `--question` are required;
`--skill-dir` selects a managed installation. `handoff.json` binds the input digest, guide name and CLI
path/hash. Its prompt tells the author to invoke the installed skill with the selected harness token,
read `create.md`, inspect source and complete the draft. Its reusable `env` prefix strips inherited Git
overrides, pins owned Git paths and the installed CLI, disables hooks/fsmonitor, and passes the exact
root/index. No generation backend, model subprocess or service is started.

`xpl pr finish <input-directory>` serializes finish calls with the existing file lock, revalidates owned
paths/input/index hashes after waiting, and requires the guide's complete change record and index to
match the input. Raw tracked source outside `.explainer/` must still equal head blobs, including
line endings, before and after export. `.explainer/` is excluded only during authoring because it holds
generated outputs; preparation checks every blob. The installed launcher runs ordinary `bundle --files
boundary` with the shared workspace readiness check and optional `--note`/`--require-review` policy.
A source-backed exported snapshot is required; changed authored text/index during export refuses it.
The checked explainer, full original head index and HTML are copied to a unique `result-*` directory.

After export, `gh api` resolves the PR again. Both returned full base and head must match before a result
is marked ready; a base-only target update also supersedes it. `result.json` is published atomically last
and made read-only, as are snapshot files. `PrResultManifest` is CLI-owned, `schemaVersion: 1`,
`kind: "github-pr-result"`, with `status: ready | superseded`, original `pr`, observed `pr`, `checkedAt`,
input path/digest, installed skill/CLI identity, portable readiness report/identity, explainer/index/HTML
relative paths and SHA-256 digests, and sorted included head/base file keys. Renamed base text uses the
head path as its bundle key; input evidence retains `oldPath`. Unsupported source remains labeled in
input evidence and is not falsely claimed as embedded. A superseded result is historical and exits 1;
its common content readiness does not establish current PR eligibility. Access/export failures remove
only the result staging directory, preserving the input/guide for retry; no result manifest is promoted.
Each finish creates a new immutable snapshot, preserving previous results. CLI failures include recovery
instructions, and interrupted locks require explicit removal only after their writer has stopped.

Ready means the API matched at `checkedAt`; GitHub cannot lock an external PR during local export.
`xpl stage` verifies artifact/input hashes and rechecks both commits before its current-pointer promotion;
`xpl pr link` rechecks them again before pointing the PR at it. `finish` starts no publishing workflow,
writes no GitHub state and creates no current pointer. The offline HTML remains readable independently of GitHub or the retained checkout.

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
`ABSOLUTE_WORDS` in `packages/core/src/lint.ts`):

- `todo-left`: a `TODO` in any authored string, including frame/transition labels, audience, technology
  and view questions. A recursive pass checks text by default, excluding IDs, paths, anchors and other
  structural metadata. Each stored field gets one error; a tour note includes its heading and body.
  Nested text names its field path (`next[0].label`) and nearest element ID. Exit 1 even with `--warn-only`;
  any other finding exits 1 without it.
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
parts may be out of date. Every live bundle carries `server.attachment` with the canonical repository root
and repo-relative canonical guide path. Plain `xpl view` and managed services share that identity; only managed
services add process/backend metadata. Offline exports strip `server` and retain in-session undo only.

| Route | |
|---|---|
| `GET /` | the viewer HTML with the bundle injected (`server: { api: "/api", attachment: { root, guide } }`, `mode: "explore"`, `files` = the files the explainer references; others are fetched lazily; `baseFiles` whole, when the explainer has a change: only the changed files, so it is small) |
| `GET /api/bundle` | the same bundle as JSON |
| `GET /api/export` | current export snapshot with all referenced source (including stubs), base source and a forced workspace freshness check; `exportInfo.report` has shared readiness findings; no HTML is written |
| `GET /api/explainer` | the explainer with its anchors re-resolved (as in the bundle), with an `ETag` of the file; 304 on a matching `If-None-Match` |
| `GET /api/file?path=` | text of one indexed file (`text/plain`); 400 for a malformed path (absolute, `..`, backslash, NUL), 404 for anything not in the index (with `suggestions`) or unreadable |
| `GET /api/base-file?path=` | the code before the change of one changed file (`text/plain`, read with `git show`); `path` is `ChangedFile.path`; 400 for a malformed path; 404 when the explainer has no change, the file is not a modified, renamed or deleted file of it (with the list of those; the old path of a renamed file is not a key), or git cannot read it |
| `PUT /api/views/<id>` | a view patch (`{ type, …changed fields }`) applied as actor `user` and written; 200 with the updated view; 400 `{ error, issues }` when rejected |
| `PUT /api/edits` | `{ version: ArtifactIdentity, edits: UserEdit[] }` with required URI-encoded JSON `{ root, guide }` in `X-Xpl-Attachment`; wrong identities reject before any patch/write; under the repository lock; compares the re-resolved artifact identity and touched before values, applies a bounded user patch and atomically saves; 200 `{ explainer, inverse, version }`, 409 for wrong root/guide or stale versions/field conflicts, 400 for missing identity or invalid edits; no artifact replacement |
| `PUT /api/review` | bounded `{ review: record \| null }` applied as actor `user` under the explainer lock; checks the captured fingerprint against current disk/source; 200 current explainer or 400 `{ error, issues }`; no content replacement fields |
| `PUT /api/tours/<id>` | the same for a tour (`{ title?, steps? }`, both for a new tour) |
| `GET /api/requests` | `{ requests, pending }` for this explainer |
| `POST /api/requests` | validated `FeedbackRequest` saved by stable ID; 201 with original context and outcome; legacy element-only bodies remain unbound/outdated |

Guards against DNS rebinding and cross-site writes: for loopback binds the `Host` header must be a loopback
name with the server's port (403 otherwise); `PUT`/`POST` need `Content-Type: application/json` (415) and,
when an `Origin` header is present, the same origin (403); bodies are capped at 8 MB (413); a wrong method
gets 405 with `Allow`. View, tour and request writes run one at a time. `.explainer/requests.json` is a JSON
array of `FeedbackRequest` records. Imports and selected-ID outcomes lock, reread and atomically merge
against the latest store. No operation removes unselected or newly appended requests. Malformed stores
and conflicting original content for one ID are rejected before writing. Imported outcomes advance only
when their revision is greater; equal or older revisions keep the stored result.

**Repository service** (`commands/service.ts`): `start` wraps the same `listen`/`startViewServer` path as
`view`, always on `127.0.0.1`. Foreground is the default. `--background` spawns the installed bundled CLI,
waits for its IPC readiness acknowledgement, then detaches; output appends to `service.log`. The first
start needs a guide; later starts reuse the selected guide, actual port, optional pinned index and backend.
An explicitly occupied port fails; a first start without a port tries 4747, then a free port. Restart keeps
the previous address unless `--port` overrides it. Another repository attaches its own service with `--root`.
An explicit `--index` uses the same resolver as `view`: working-directory path first, repository-root
fallback second. Service checks containment and saves the resolved absolute path.

The canonical `realpath` root owns `.explainer/service/` (private permissions, git-ignored). `context.json`
uses `xpl-service-context@1`: root, repository-relative guide, backend (`none|claude`), port and nullable
pinned index path. `instance.json` uses `xpl-service-instance@1`: root, UUID, PID, secret token, state
(`starting|running|stopped`), nullable URL and start time. `withRepositoryLock` wraps the existing
`withFileLock`: after acquiring the lock, it checks that the target directory and any existing record
resolve inside the canonical root, even when the record is absent. Instance, context and interrupted
archive writes share this fence and publish with `atomicWrite`. The instance is reserved before listening,
preventing concurrent starts.
Guides, pinned indexes and state paths must remain within the root. Managed server requests also check
artifact paths so a guide or requests symlink cannot attach another repository's state.
All feedback writes (imports, appends and outcomes) use the same `withRepositoryLock` fence before the
synchronous read/merge. Both feedback POST paths recheck before unlocked response reads too; a file or
directory symlink swapped while a writer waits cannot import or publish another root's records.

`status` reports `stopped`, `starting`, `running`, `unavailable` or `interrupted`, with actual UUID, PID,
address, root, guide and backend. UUID/root and secret bearer-token replies from `GET /api/service` verify
the instance; `POST /api/service/stop` uses the same token and the existing JSON/origin guards. The token is
never included in CLI output or a viewer bundle. Stop closes the listener and drains queued artifact writes
before marking ownership stopped. No PID is signalled. An alive PID without a matching handshake remains
unavailable; recovery refuses it, including PID reuse. A demonstrably exited owner requires `--recover`,
which archives its record as `interrupted-<UUID>.json` before reserving another instance. Writer locks are
never stolen on a timer: a crashed transaction requires explicit inspection/removal of its lock directory.
An unexpected exit leaves the last valid index/explainer and interrupted instance record intact.

Managed bundles add `server.attachment`: canonical root, repository-relative guide, instance UUID,
backend selection and `backendAvailable` (whether a runner is configured, not an authentication check). Root/guide identify the attachment across restarts;
the UUID identifies a process and participates in the workspace ETag. Every viewer API call sends
`X-Xpl-Attachment` (URI-encoded root/guide JSON). The server rejects a different repository or guide
with 409 before reads or writes, for plain views and managed services alike. The page also preserves
root/guide in its `attachment` URL query, checked
before HTML injection, so a bookmark cannot silently open another guide on a reused port.

Backend `none` disables execution. Explicit `claude` selects the installed print-mode runner, using its
existing login and provider access. Local serving needs no provider network or credentials. Offline HTML and manual CLI commands remain
independent of the service. The installed-artifact check exercises detached processes, saved-context and
same-page/bookmark restart, a real crash and explicit recovery, then manual export and blocked-network
reading of an HTML snapshot saved from a stopped page.

**Opt-in watching** (`watch.ts`): `service start --watch` polls input metadata every 500 ms and
requires a quiet observation for at least 300 ms before a full rebuild. Recursive filesystem events were
not chosen: polling reuses the indexer's discovery rules, observes ignored configuration and works with
Git worktrees and non-Git directories. Watching defaults to `--precise off`; `auto|require` explicitly
enables semantic tools. `--scip` reloads and watches a supplied artifact or manifest/artifact pair.
Watch options are per-start, never saved as an automatic opt-in. A pinned `--index` is rejected; a watched
start clears a previously saved pin. Stop drains the running build and prevents cancelled publication.
Restart and `--recover` reuse the saved guide/backend attachment with a new instance UUID. Passing
`--watch` again publishes for that instance; live bundles retain the guide attachment and follow its
current checked index. Recovery without `--watch` retires the old pointer and returns to manual indexes.
`watch-control.ts` serializes pause/resume independently of service/job ownership. Pause aborts and drains
any build, retains the last checked pointer and marks it `paused` and stale. Resume starts a fresh input
check and full rebuild; repeated pause/resume is idempotent. Jobs continue running while the watch is
paused. Stop cancels/drains both subsystems and retires the pointer. Cancellation is rechecked after all
publication locks, so a build waiting to publish cannot escape pause or stop.

The watcher compares captured revisions after building and again after acquiring all three publication
locks (index, .gitignore and watch pointer), checking cancellation there before promoting the result. Obsolete results are discarded and the latest inputs are retried after quiet. `writeIndex` publishes
by rename under `withRepositoryLock`; its .gitignore is fenced too. The watcher then atomically replaces
`.explainer/service/watch.json` (`xpl-watch@1`): canonical root, instance UUID, state
(`pending|building|current|failed|paused|stopped`), stale flag, publication generation, last index path/commit,
fingerprint, index-content digest, precise mode, nullable SCIP path and error. Source/configuration edits mark the old
pointer stale before building. Failure retains that pointer and retries after another input revision or a
new watched start.
Cancellation keeps its stale mark. Repeated identical capture failures do not flood the log.

While watching, default index selection follows the publication pointer before a guide's old binding.
Freshness checks compare the full observed input fingerprint, including ignored configuration, and refuse
ready export for pending/failed builds and paused snapshots. The index digest also rejects an out-of-band replacement at the
same path, even when the indexed file manifest is unchanged. Explicit `--index` still selects an index for
manual commands.
Freshness uses the watch record's precise mode and supplied artifact selection. Older records without
that selection require a watched restart before readiness can be established.
Every new service owner retires the prior watch record under the ownership lock before serving.
Recovery without watching and stop return default selection and manual index/resolve to the offline path. Each completed
build reports every guide's moved/drifted/missing counts; `status --all` recomputes the inventory on demand,
including user-owned drift, broken references and unreadable guides. Moved anchors receive new locations
in memory; guide files, prose, provenance, review records and pending feedback are untouched. Generated
index/cache/service files, named guides/patches and exported xpl HTML cannot start an output loop.

**Managed attention** (`attention.ts`, core's type-only `WatchAttention`): `GET /api/watch` reports the
current instance's watch state and the read-only guide inventory: guide names/paths/titles, counts,
affected element IDs/files/statuses and load errors. Index/inventory loading is independent of the attached
guide; a missing attachment appears as an inventory error and cannot disable service controls. One CLI
helper constructs each shell-quoted manual command: resolve with `--write`, revise with a feedback-ID placeholder. Offers use the absolute discovered guide path; unreadable guides retain
their expected `.explainer/<name>.explainer.json` path. A name ending in `.json` cannot select an unrelated
repository JSON file, and the calling directory cannot select another guide. This report is outside `ViewerBundle` and the explainer schema.
`POST /api/watch` takes `{action: "pause"|"resume"|"stop", instanceId}`. Browser controls require the
matching attachment header, exact inspected instance UUID, JSON and the existing same-origin/body limits.
Verified CLI bearer control uses the service handshake instead. A start without `--watch` refuses pause
and resume; stop still works if the attached guide disappears. Stop acknowledges before closing the server.
Watch-record metadata participates in managed `/explainer` ETags, so pause/resume refresh stale export state.
The attention report is informative; existing workspace/core readiness checks remain authoritative.

**Durable jobs, lifecycle contract (39A).** `cli/jobs.ts` owns one atomic ledger at
`.explainer/service/jobs.json`: `{schema: "xpl-jobs@1", root, jobs}`. Job metadata stays outside the
explainer and bundle. The service reserves its instance before opening the ledger. All ledger writes use
`withRepositoryLock`; ownership is checked again after waiting. Storage cannot follow symlinks into
source or another repository. A corrupt ledger refuses startup rather than erasing history.

A watched start reserves the new instance and retires the prior watch pointer before opening jobs.
Opening the ledger marks old running attempts interrupted; watching starts after the instance is running.
The watcher owns index and watch records; jobs own the ledger. Stop drains the watcher, server and job
worker before releasing service ownership. Neither subsystem can publish for a replaced instance.

Each job has a caller-supplied UUID `id` (the delivery/idempotency key), revision `scope: {kind: "revision",
guide, include}`, `selectedRequestIds`, and immutable `input: {revisionRunId, expected, index, requests}`.
`guide` and `index` are repository-relative paths, resolved from the canonical repository root for
selection, history, dispatch and retry, even when the service starts from another working directory.
`expected` is the existing `ArtifactIdentity`.
`requests` retain #28's original IDs, context, content and outcome baselines. `revisionRunId` refers to
#30's journal, which retains the previous/resolved guide and source text. Selection calls `selectRevision`;
there is no second proposal format or acceptance implementation. Re-delivery of the same ID and selection
returns the saved job; conflicting reuse of an ID is refused. New feedback is never added to an existing
job or removed from the request queue.

Lifecycle `state` is `queued | running | completed | failed | cancelled | superseded | interrupted`.
Jobs retain `createdAt`, `updatedAt`, numeric `attempt`, nullable `owner: {instanceId, attemptId}`,
bounded progress messages, nullable failure reason and nullable `result: {revisionRunId}`. One runner
per repository claims queued jobs in ledger order; cancelling a running job aborts its signal but does
not start conflicting work until that invocation exits. Progress and completion check both owner IDs
and running state under the ledger lock. Cancelled/superseded results and late old-attempt results are
discarded. Completion records a proposal reference, never applies a patch or finalizes feedback.

Restart marks previously running jobs `interrupted`, retains their input and progress, and requires an
explicit retry. Queued jobs remain queued until a runner is available. Retry keeps the job and selection
IDs, rechecks guide/source/request baselines, clears previous result/error and starts a new attempt.
Only failed/interrupted jobs can start another attempt. Retry supplies `expectedAttempt` from the
inspected job; an older baseline returns the saved receipt, including an already failed/completed retry.
A future baseline is refused. Re-delivery while queued/running also returns the same attempt.
Cancel and supersede also fence completed proposals. No state transition can restore them to completed.
Shutdown marks running work interrupted and aborts it; instance replacement fences any late callbacks.
Configured attempts add optional owner.process: {groupId, startTime}. The groupId names the launcher
and its POSIX process group; startTime is Linux's boot UUID plus the leader's kernel start ticks.
The runner records it under the ledger lock and current attempt fence before Claude can start.
On a new owner, recovery checks the start time and group identity before signalling a recorded group
and waits for every live group member to stop before marking running work interrupted or dispatching queued work.
A missing, exited or reused PID is not signalled. Older/control-only attempts have no process record.
Locks left by a killed transaction still require inspection/removal, never timeout-based theft.

Managed services expose `GET /api/jobs`, `GET /api/jobs/<UUID>` and `POST /api/jobs` with
`{id, selectedRequestIds, include?}`, plus `POST /api/jobs/<UUID>/<cancel|supersede>` with `{}` and
`POST /api/jobs/<UUID>/retry` with `{expectedAttempt}`.
Routes use the existing Host, attachment, JSON, origin and size guards and filter to the attached guide.
Backend `none` reports 503 for submission/retry; history, cancellation and review of completed work
remain usable. Controlled runners prove lifecycle behavior only. Headless answer jobs are described below;
question/history UI uses the Feedback panel (§6).

**Job review and acceptance (39C).** The browser-safe `core/jobs.ts` types describe the existing ledger
and revision packet; no second proposal engine is introduced. `RepositoryJobs.review` holds the ledger's
repository lock, requires a completed job and its exact `owner.attemptId`, and calls `continueRevision`.
`GET /api/jobs/<id>/review?attemptId=<uuid>` reads the review; `POST .../review` takes
`{attemptId, decisions?}` and `POST .../accept` takes `{attemptId, reviewToken}`. Both share the existing
attachment, origin/body and repository guards. Decisions use #30's status/reason/reconciliation/missing
format.
Every selected request needs a decision. Reviewing changes no guide or outcomes.
Service review packets with an inspected candidate return `reviewToken`, a SHA-256 hash of the run ID,
job attempt, exact candidate and decisions. Acceptance compares it under the journal lock before any
publication, including recovery. A stale token returns 409: "The decisions changed in another view;
review again." The viewer reloads the decisions and requires another review before acceptance.
Tokens are derived from the journal, so existing `revision@1` journals need no migration and restart
retains the same token. Clients that omit the token receive 400; manual `xpl revise --accept` is unchanged.

Selection records `serviceJob: {id}` in the journal before returning a service job. Its first guarded
proposal adds `attemptId`; later attempts may replace it through the same guard. The job owns the journal
while queued, running or terminal, even if no proposal arrives. Legacy journals without this field recover
ownership from the matching revision job in the repository ledger when read. Manual proposal, decision and
acceptance writes are refused at every stage; read-only `xpl revise --run` remains available.
The service job journal fence `{id, attemptId}` is required for guarded proposal/decision/accept writes. Retries may
replace a failed attempt's uncommitted proposal only through its new guarded attempt. Ownership is
rechecked after the journal, artifact and selected-outcome lock waits, and before publication. Acceptance
reuses #30's freshness, exact candidate identity, readiness and user-field protection checks. The guide
commits before selected outcomes; later feedback is merged untouched. Committing/committed/done journals
cannot be cancelled or superseded: their remaining outcome publication must recover first. Repeating
acceptance uses the same journal and never republishes the candidate or advances outcomes twice.
`result.accepted` is a display receipt derived only from the matching done journal, not a lifecycle state
or an independent permission. Recovery does not compare the old job input with the already committed guide.

Packets retain source before/after and per-request changes computed by the existing candidate function.
Previews advance through proposals in order and compare each result with its preceding candidate;
a later proposal can depend on a step added earlier. Acceptance validates the chosen combined candidate.
The viewer's Jobs disclosure lists all seven lifecycle states, progress and actionable runner errors;
start/cancel/retry/review flush pending writes and reject unsaved author drafts. Offline history stays
readable. Responses are ignored when the API attachment changes. Submission retries reuse their delivery
UUID. Job polling updates history even while author drafts prevent bundle adoption; bundle feedback merges
by immutable ID and outcome revision. The review modal renders safe Markdown and marked changed phrases,
including the spaces between adjacent changed words, with concise evidence and plain field values.
Source comparison panes have visible Before and After labels at every width.
Raw JSON is behind Show raw change. Each request owns its decision
and reason. Review decisions must succeed before explicit acceptance; changing a choice invalidates the
inspected candidate. Interrupted publication exposes Recover acceptance using the same journal.

**Snapshot-bound answers (40A).** `cli/answers.ts` captures a saved `explain` feedback request with a
non-empty question in `note`. The request keeps its stable feedback ID, element/range and original
`ArtifactIdentity`. Selection follows the live server's current index and re-resolved guide. It also accepts
the stored guide identity for current offline feedback; it never rebinds an older request. Selection refuses
stale or changed context and invalid selected ranges. Under the guide lock it records the guide, current index
path, text/hashes for guide-referenced and question-focused head files, and base files named by change records, base anchors or the selected range. Head text must match the index; base text comes from
its recorded git commit, with rename mapping. A final freshness check rejects capture across a source edit.
Inputs are limited to 5 MB; source arrays to 10,000 files. Selection reuses `referencedFiles` and `codeFocus`.
No revision journal is opened for an answer.

An `AnswerJob` shares the durable job ledger, scheduler, process ownership and attempt fences. Its scope
kind is `answer`; input is `{expected, index, request, guide, sources}`. Revision history APIs keep revision
jobs separate. `POST /api/answers` takes `{id: UUID, requestId}`; GET collection/item and POST
`/<UUID>/<retry|cancel|supersede>` use the same attachment/loopback guards and retry baseline as jobs.
Submission checks the request ID under the ledger lock. A request has at most one answer job;
concurrent submissions with different job UUIDs return the existing job, including terminal jobs and
after restart. Failed/interrupted jobs use explicit retry; cancelled questions need a new request.
Only a configured answer runner accepts new work. Frozen questions can finish or retry after source or
explanation changes; `contextReason` reports the current difference without changing the original input.

Untrusted answer output is exactly `{text, references}`. Each reference is `{file, side, fromLine,
toLine, quote}`: positive inclusive lines and an exact complete-line excerpt from recorded head/base text.
Missing files, out-of-bounds ranges and invented or wrong-side quotes fail the job. Extra output fields,
including patches, are refused. These are source excerpts, not precise/heuristic call-graph facts.
A completed receipt includes the job ID, request ID, original identity, timestamp, text, references and
only the cited source files/text/hashes. Reload revalidates evidence against the job's frozen source too.

`FeedbackRequest.answers` is optional in `code-explainer/feedback@1`. Existing exports remain readable.
Parsing/import rechecks source hashes, exact excerpts, original request identity and duplicate answer IDs.
Merging unions immutable answers by ID independently of outcome revisions; conflicting same-ID answers
are refused, and exports without history never erase saved answers. Returning an answer leaves feedback
pending and never changes the guide, user fields or author outcomes. Optional guide changes use the
existing explicit `xpl revise` review/acceptance path; answer output cannot smuggle a patch into it.

Every request-store write globally merges all requests under the lock, then validates the result with the
reader's parser. Answer IDs belong to one request across the store. A merge exceeding 1,000 answers for a
request fails without changing the store; history is never truncated or ordered by timestamps.

Answer completion validates this prospective store before publishing a result receipt. With the ledger
and request locks held, the completed receipt is written before mirroring history. Overflow or ID ownership
conflicts leave the stored history and result receipt unchanged and fail the job. Startup and answer-history
reads replay missing mirrors, so interruption between writes cannot lose or duplicate
an answer. Concurrent new feedback and newer author outcomes survive this merge. Cancellation or
supersession before completion fences late output; completed answer history is immutable. Disconnected
submission retains ordinary pending feedback for the next explicit offline iteration. The question UI,
progress controls and context warnings use the Feedback panel (§6).

**Configured Claude runner (39B).** `cli/claude-runner.ts` is the single process adapter behind `JobRunner`.
Explicit `service --backend claude` selects it. The saved `--skill-dir` identifies a verified managed
installation (default `~/.claude/skills/code-explainer`); `--job-timeout` bounds each call (300 seconds by
default, 1–3600 seconds). Enabled means configured; only an actual job establishes usable provider access.
The viewer renders backendAvailable from the attachment: configured Claude is labelled without a
sign-in claim; the unavailable state points to manual revision.
Missing tooling/skill, authentication, rate limits and timeout failures leave the job retryable with a
recovery message. No keys, accounts, provider setup or hosted xpl backend are created.

Each invocation uses Claude Code print/JSON mode, `--restricted`, `dontAsk`, no session persistence,
a read/Glob/Grep/Write tool list, empty MCP configuration and disabled inherited hooks. It starts in an
xpl-owned temporary directory containing frozen revision or question input. Source and the installed skill are
additional read directories with explicit Edit deny rules. Only an exact absolute Edit permission for
`proposal.json` (or `answer.json`) permits the Write tool; Claude uses Edit rules for all file modifications. Shell, agents
and MCP tools are unavailable. For revisions, the prompt reads the installed skill and asks for ordinary
per-request patches with one output entry per selected request. For answers, it asks for `{text, references}`
with exact excerpts from frozen head/base source. Neither invocation applies or accepts patches. Output
must be a bounded regular file. A per-attempt Node launcher holds a service pipe: closing the pipe, including
service death, kills the whole group. The launcher starts Claude only after receiving the service's durable-ownership
acknowledgement. It remains alive after Claude exits, reporting the original exit code on that pipe.
From launcher spawn, one `try/finally` owns teardown, including failed identity reads. Normal/error exit,
timeout, cancellation and recovery kill the verified group and scan Linux /proc until no live member
remains. One two-second deadline bounds every identity read, scan, drain delay and launcher-exit wait.
Stream `close` is never a completion signal: inherited pipes can outlive their group. Teardown destroys
streams and releases the child handle after drain or deadline, so shutdown can exit. An unstarted launcher
is killed through its live child handle if identity registration failed; Claude never starts in that case.
Exited zombies cannot execute; the OS reaps them. Terminal state follows drain, including cancellation
and shutdown. On cleanup failure, `JOB_PROCESS_CLEANUP` names the group, whether its recorded identity was
verified and the unfinished stage. The locked ledger writes `failed`, no result, and an optional `cleanup`
barrier containing `{groupId?, startTime?}`. Restart/recovery must verify that group gone before clearing
the barrier. An unverified group is inspected without signalling its PID; unknown ownership blocks recovery.
Recovery verifies the recorded start time as
a second guard if the launcher was paused. No supervisor daemon is installed. Verified process
ownership currently requires Linux /proc; other platforms fail before starting Claude and can use
manual revision. Temporary output is removed after reading or failure.

The adapter returns untrusted proposals. The scheduler rechecks instance/attempt/running state under
`withRepositoryLock`, stages the proposal in its service area, and calls #30's `continueRevision` for
scope, anchor, provenance, source and readiness checks. Ownership is checked again immediately before
the journal write. A completed job references a ready, `proposed` revision run awaiting author review;
the guide and feedback outcomes remain unchanged. The journal records `serviceJob: {id, attemptId}`;
manual `revise --accept` refuses service-owned runs so cancellation/supersession cannot be bypassed.
39C supplies their guarded acceptance path. Invalid or unfinished output becomes a failed job.
Creation proposals fill an explicitly initialized empty/draft guide, selected persisted requests and
explicit included new IDs through this same revision contract. The runner does not create or replace
a guide name. No competing creation/proposal engine or automatic decisions are added.

**Feedback contract** (`core/feedback.ts`): exports are `{schema: "code-explainer/feedback@1", requests}`.
Each request has `id`, `elementId`, `kind` (`correct`, `explain`, `expand`), `at`, optional `note`, `view`,
`label`, `explainer`, optional `range` (`file`, inclusive `fromLine`/`toLine`, `side: head|base`), immutable
`context: {explainerHash, sourceHash}`, and `outcome: {revision, status, reason, at}`. Status is `pending`, `addressed`,
`unresolved`, `rejected` or `outdated`; every result has a reason. Original source freshness warnings are
retained as `sourceWarning`. Context uses #25's `artifactIdentity(explainer, index)`: canonical full
explanation JSON and sorted indexed path/hash manifest plus change base/head. It identifies indexed source;
a stale workspace or original source warning still requires reconciliation even when hashes match.
Legacy requests get deterministic IDs and `context: null` with an outdated result; no snapshot is invented.
Outcome revisions are non-negative safe integers. Capture starts at zero; only locked author outcome
recording increments the latest stored counter. Old exports without a revision read as zero. Timestamps
remain display metadata; no merge orders outcomes by clocks from different machines.
Every merge uses `mergeFeedbackRequests`: a request's held outcome revision never decreases, whatever
the source or arrival order. Lower or equal revisions preserve its status and reason. Equal revisions
keep the first held result: the disk record on import, existing viewer state on refresh, or embedded
feedback on the initial page load.

`xpl feedback` compares against the latest index and reports `contextStatus`/`contextReason` separately
from the stored outcome, preserving an imported terminal result and its reason. Outdated requests are
never silently rebound. `--outcomes` reads an array of `{id, context, status, reason}` with the original
context copied exactly. It updates those IDs and increments their revisions only. Failed writes leave
the prior file and counters intact and retryable.
The selected revision operation below commits reviewed decisions before recording their outcomes.

**Local ready versions (34A/34B).** `cli/stage.ts` reuses workspace readiness, artifactIdentity and bundle
file selection. `xpl stage <guide> --dir <outside-folder> --preview` lists sorted head/base source paths
and readiness without creating storage or reading the viewer HTML. Ordinary staging prints that list
before writing; machine callers use `--preview --json` for a separate inspection step. `--files` selects
referenced (default), boundary or all source through the existing bundle helpers. Review evidence and
changed-file before/after source follow the ordinary export rules. There is no draft override.

Storage resolves existing ancestors and rejects paths inside the source root or its Git checkout,
including symlink aliases. PR preparation shares this guard. Each unique `version-*` directory holds
read-only `index.html` and `manifest.json`; the directory becomes read-only too. Its schemaVersion 1
`xpl-ready-version` manifest records a directory locator, creation time, index/change commits, the
existing artifactIdentity, SHA-256 hashes of input explainer/index bytes and HTML, the readiness report,
included head/base paths, and author review state. The directory locator does not define another content
identity. The HTML has no live server API and retains the existing source scope and review display.

The existing `withFileLock` holds `current.lock` for the complete staging/promotion transaction. After
writing both files and preparing a relative symlink, staging reloads the guide/index/source and reruns
readiness, comparing exact input bytes, identity and bundled content with the preview. The final rename
replaces `current` atomically; readers open `current/index.html` or a retained `version-*/index.html`.
Failures before promotion remove the attempted version and temporary pointer, retaining all previous
version bytes and the old current link. A crashed writer's lock requires explicit removal after checking
the writer stopped; no timer steals it. Storage has one current pointer per configured directory.
If lock release fails after the atomic rename, the command reports successful promotion with a cleanup
warning. It does not report a failed staging run after current has already changed.

PR guides require `--pr-result` from `xpl pr finish` and the retained prepared checkout as `--root`.
Staging verifies the ready result's input/explainer/index/HTML SHA-256 hashes, commits, source list and
artifact identity; prepared or superseded results are refused. It recomputes embedded readiness and
checks the prepared HEAD/raw source plus workspace readiness against that exact result. The version
contains the validated HTML with publication metadata and the full original ready result manifest with
its SHA-256 hash. The original ready HTML hash remains in that result; the staged artifact hash covers
the delivered page. Source, explanation, index, readiness and artifactIdentity remain unchanged.
After writing, GitHub base/head are rechecked under the destination lock, then local readiness/freshness is checked
again before promotion. API failures and superseded commits retain current. `--files` and `--note` cannot
alter a PR result. `--require-review` checks the optional policy without rewriting its original HTML.

**PR preview link (34C).** The destination is a static host the team already runs and controls access
to: it serves a folder staged with `--pr-result` at a base URL, as plain files (or a copy such as
`rsync -a`). xpl uploads nothing and adds no hosting. `cli/pr-link.ts` keeps one PR comment, found by its
first-line marker `<!-- xpl-pr-preview {json} -->` on a comment whose `author_association` is OWNER,
MEMBER or COLLABORATOR; others' markers are ignored. The JSON records head, base, version folder, base URL,
visibility and, once outdated, the newer head/base. `xpl pr link <dir> --url --visibility` reads
`<dir>/current/manifest.json` (a ready version with a PR result), resolves the PR again and refuses when
GitHub base/head differ from the staged commits. It reads `repos/<repo>.private` and refuses
`--visibility public` for a private repository. It then posts the comment or edits it in place (no edit
when its marker already records the same link; text appended below is kept), linking
`<url>/current/index.html` and `<url>/<version>/index.html`.
The base URL must be http(s) without credentials, query or fragment. A new comment whose
`author_association` is not trusted is deleted and the run fails, since it would never count as the link;
if that delete fails, the error names the comment to delete by hand.
After writing, `link` runs the `check-link` comparison once more: a push that landed meanwhile turns the
comment outdated and the run exits 1. A failed GitHub write exits 1 and leaves the earlier comment and
every staged version as they were.
`xpl pr check-link <PR>`, run by a PR workflow on new commits, rewrites that comment as outdated when
base/head moved, keeping only the last version link. It needs no checkout or staged folder. Writes use
`gh api` with the caller's token; two concurrent writers could still post two comments, so the workflow
template serializes runs per PR.

**Version navigation (34B).** `ViewerBundle.publication` carries a current `PublishedVersion` and prior
summaries captured under the staging lock from retained immutable manifests. Each summary reuses locator,
time, index/change commits, artifactIdentity, included head/base files and review state. The viewer never
fetches a manifest/catalog or repository API to read it. Bundle parsing rejects unsafe/duplicate locators,
malformed metadata and a publication combined with a live server. Opening `current/index.html` replaces
the location with the captured `version-*/index.html?version=...` before installing navigation. Generated
links use sibling immutable paths; a version query that disagrees with the embedded page is refused.
Standalone HTML copies preserve the snapshot and saved navigation but do not advertise sibling links.
Old pages retain only history that existed when staged. About this explanation lists prior versions,
exact included source and author review; a state link uses the existing query serializer.
Earlier history is collapsed; local staging times are readable and technical identifiers stay in source
details. Every staged page offers Open latest version through sibling `current/index.html` with no
immutable version query, so old snapshots can lead to newer content without a catalog fetch.

The existing launch query gains `side=head|base` and `version`, retaining `view`, repeated `focus`,
`perspective`, `tour`, numeric `step`, stable `step-id`, `file` and inclusive `range`. Explore selections
and stable Present step IDs are preserved. Present detours retain their view and focus; an explicit
empty `focus=` preserves a cleared selection instead of reapplying the tour step. URL writes track
applied step changes as well as the tour counter, so a step's stable ID cannot lag behind its position.
An empty `step-id=` records that no step is applied. View, focus, perspective and cursor remain
independent of the applied step; a perspective switch does not imply a detour. Older compact tour URLs
without view/focus still apply the requested step. Base ranges validate against embedded
base text using changed-file head keys, including deleted files, without a base index. Column positions
run from 1 through line length + 1, including empty lines and the position after the last character.
Unknown sides and unavailable/invalid ranges never silently select head source.

`ViewerBundle.launch` stores a query string when Save as HTML captures navigation, with no service
attachment. The store restores it only when no explicit navigation was supplied; a new linked target
replaces saved navigation as a whole, avoiding conflicting saved focus/range targets. Re-saves retain
publication metadata only while artifactIdentity matches the staged record; author changes drop it.
`ViewerStore.restoreState(params)` derives navigation without changing the store. Launch, saved HTML
and browser Back/Forward use it. Tour defaults fill absent fields; explicit mode/perspective, view,
focus, applied step and validated head/base cursor fields are restored independently. The history
adapter applies the result once, without replaying Present, selection or range actions. Cursor
restoration keeps the selection, applied step and reading perspective. No saved state changes
explanation provenance, source text, readiness or identity. Access control belongs to the team's
destination; the PR link is above.

**Bundle payload** (`ViewerBundle`, also `/api/bundle`): `{ schema: "code-explainer/bundle@0", explainer,
index, files: Record<FilePath, string>, baseFiles?, mode?, tour?, server?, sourceWarning?, exportInfo?,
feedback?, guideId?, guides?, readOnlyGuide?, publication?, launch? }`, embedded as `<script
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

**Guide library.** `guideId` is an adapter-supplied stable key, not a path resolver. Optional `guides`
contains additional `GuideSnapshot`s: each has its own explainer, index, files, optional base text, feedback,
freshness warning and export report. No nested libraries or server attachment are carried into a snapshot.
`bundle --include-guides id,id` uses exact discovered paths, checks each guide through workspace readiness,
and applies the same explicit `--draft` policy. At most eight additional guides and 20 MiB of additional
unpacked JSON are allowed; failure writes no output. Every index is independently packed and unpacked.
Legacy bundles use the viewer key `current`. Save as HTML preserves the contained library after switching.

`GET /api/guides` reads the same catalog adapter as `xpl guides`. `?id=<key>` returns a bounded checked
snapshot; `/?guide=<key>` renders it without live server metadata. Existing repository/guide attachment
guards still apply. A different guide is explicitly read-only (`readOnlyGuide.command` gives its own
`xpl service start` command and optional `stopCommand` stops that exact repository's service first).
The live preview picker offers a Back to library link to the attached guide's root page, without
fetching a catalog or polling from the preview. The running service's attachment and writes never change guides.

**Export information.** `exportInfo: { status: "ready" | "draft", report: ReadinessReport }` records
identity, checked source scope, findings and the author's optional decision note. CLI ready output checks the
workspace; offline re-saves record `embedded-snapshot`, never a claim about the current repository. Draft
pages show a persistent preview banner. Legacy bundles can still open; saving them runs the same checks.

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

**Explicit revision** (`cli/revision.ts`, `xpl revise`). The installed skill asks the chosen agent for
ordinary `ExplainerPatch` values, grouped by selected request ID. The CLI calls no model. Selection forces
fresh index/source comparison, even under `XPL_SKIP_STALE_CHECK`, and resolves anchors in memory without
writing the guide. Per-request patches are bounded to their selected element and author-listed extra/new IDs
(`--include`). Feedback's optional `view` records reading context and grants no edit scope. A selected step
allows only its `stepsUpdate` through the enclosing view/tour; whole-view changes require that view to be
selected or explicitly included. Title/audience cannot change; core `llm` provenance rules protect user-owned
content. Plain reviews show patch warnings and detailed readiness findings with repair hints, alongside the
explanation before/after and source.

Scope checks compare `(collection, id)` for top-level elements and `(collection, containerId, stepId)`
for steps, encoded as JSON tuples so arbitrary tour-local IDs cannot alias another container's identity.
Selection and `--include` are resolved against the retained artifact. Raw flow/sequence feedback IDs resolve
to their actual owning view; reading context can disambiguate that step, not authorize the whole view.
Explicit step addresses use `<view-id>/<step-id>` or `<tour-id>/<step-id>`. Every patch entry is checked in
its actual collection. Only `stepsUpdate` may use step permission; full arrays, frames, graph include
operations and other container fields require the container itself. Removal IDs resolve against the current
candidate, so a preceding proposal cannot move a local ID and carry its old removal permission with it.
Ordinary patch, stored element and feedback ID formats stay unchanged.

A run lives in `.explainer/revisions/<uuid>/run.json`; `previous.json` retains the previous artifact.
Generated paths are excluded from discovery. Selection and continuation reject generated directory aliases
into source using the indexer's shared device/inode directory census (`repositoryDirectoryIdentities`),
including empty/ignored directories, rather than guessing from path text. The journal retains original
requests/outcome baselines, expected `artifactIdentity`, current index path, resolved candidate, reviewed
source, proposals and decisions. Historical inspection returns the retained source and explanation diff.

`--proposal` reviews `[{id, patch}]`; `--decisions` reviews one `{id, status, reason, reconciliation?,
missing?}` per selected request. Only `addressed` patches enter the exact candidate; others stay stored with
reasons. Accepted outdated context needs explicit reconciliation. Legacy unbound requests remain outdated.
Missing anchors require an explicit `missing: [{id, action: "reanchor"|"remove"}]` decision for their owner.
The patch supplies the repair/removal. Unrepaired missing anchors block ready acceptance. Location-only
moves accept an empty patch and preserve prose. A wholly declined batch records decisions without changing
or rebinding an unfinished artifact.

`--accept` rechecks the current artifact against selection, live source hashes including additions/deletions,
selected immutable request content/outcome baselines, and shared readiness on the exact reviewed candidate.
It uses ordinary apply's `withLockedExplainer` publication seam. Lock order is journal, artifact, feedback.
`recordOutcomes` validates under the feedback lock and calls revision's decision-commit callback before
publishing any outcomes; concurrent feedback is merged against the latest store. Intent is journaled before
atomic artifact publication, then committed state, selected outcomes, and the done receipt. Recovery accepts
either the expected original artifact or already-published candidate; any other artifact refuses overwrite.
Expected outcome revisions make the same result idempotent under the existing monotonic merge, while a
conflicting newer outcome refuses replacement. Failed checks/write attempts keep feedback retryable. Killed
writers require explicit removal of their reported locks after verifying they stopped. No watcher or service
is involved; later #24/#29 integrations can invoke this same operation.

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

**Search and guides** (`components/SearchLibrary.tsx`): one header entry opens an accessible dialog. A
150 ms debounce sends literal, case-insensitive queries to an inline Web Worker; both index construction
and scanning run off the UI thread. The worker calls core's pure `query` using supplied text only. Results
have independent 16-row pages for symbols, concepts, steps, guides/tours and source (80 rows maximum).
Each group reports its visible range and total, with Previous/Next controls; source lines cannot crowd out
explanations or symbol results. Snippets retain at most 400 characters around matches. Stale request IDs
are ignored, and changing the query or supplied snapshot resets all pages. Source and
symbols refer to the active snapshot; prose can refer to any contained guide. Missing source, retained/
total symbols and references, and unavailable analysis remain visible independently of no matches.

Results carry real links: `guide=<key>`, `file=<path>&range=<line>:<col>-<line>:<col>` (1-based inclusive
UTF-16 columns; omitted columns mean a line range), or `tour=<id>&step-id=<stable-id>`. Numeric `step`
links remain compatible. Opening a range validates it against supplied text, selects exact columns in
CodeMirror and enters Code. Tour phrases open the recorded step in Guide. Links survive reloads and use
stable step IDs when reading; malformed or unavailable source ranges do not open another range.

Exported pickers enumerate only contained snapshots. A live picker reads the guarded catalog; other-guide
previews have no API or write identity and author changes are prohibited. Switching requires no unsaved
edits, dirty drafts or in-flight writes. Search uses one header entry. Connection and attention share
the compact status bar below it; the draft marker remains separate.

**Connection** (`components/ConnectionStatus.tsx`): in the shared status bar below the header, managed
service pages report offline, connecting,
connected, disconnected (network failure) or service unavailable (HTTP refusal). Managed pages name their
guide; Connection details shows root, last instance and configured backend availability. Claude Code is
labelled configured; sign-in is checked only when a job runs. An unconfigured service points to manual
`xpl revise`. Existing two-second explainer
polling also checks availability with unsaved edits; requests have a five-second deadline. A stopped or
unavailable managed service keeps retrying the same address, never searches ports or changes roots.
Unmanaged `xpl view` pages keep their existing layout without this strip. An unmanaged old server
without `/explainer` stops polling on 404 for compatibility.

**Use loaded snapshot offline** disables API reads/writes and polling, keeping loaded source, navigation,
edits and browser feedback. Missing source says it is absent from the snapshot. Save as HTML uses embedded
readiness and removes service metadata. **Retry connection** resumes the original scoped API; unsaved edits
remain local until **Retry save**. View edits, tour edits, review additions/removals and bounded author edits share one pending-write queue, including offline
changes. Dirty state follows that queue. Writes stay pending while in flight; success removes only the
write sent, preserving newer edits. Author saves retain drafts on transport failure; Retry save records their
inverse once. Rejected author writes leave the draft and history available for inspection. Static/offline
author actions apply locally and remain unsaved in this page; reconnectable actions retain captured
versions and retry against the original service.
Reconnect does not overwrite unsaved changes with server state. Browser feedback is exported/imported explicitly, never auto-submitted.

**Watch and attention** (`components/AttentionStatus.tsx`) shares one compact bar below the header
with connection status. Connection details, attention and watch controls have separate native disclosures;
opening one closes the others. Content floats in a scrolling panel bounded to 40vh or 320px, so the diagram
and code keep their height when a report lists many guides. Only managed pages with an instance UUID and attention endpoint show it;
plain `xpl view`, old servers and saved HTML retain their layout. A collapsed disclosure shows watch state
and the number of guides with drift, missing evidence or load errors. Expanded rows name each guide and
element, distinguish moved/drifted/missing anchors, and give a repair action. Attached-guide elements can
be selected for inspection. Moved evidence keeps its prose; drift/missing evidence requires explicit repair.
Pause/resume and Stop service use the inspected instance, have a drain deadline, and leave loaded code
readable after stop. Attention polling precedes the pending-write adoption guard, so local edits survive
while reports refresh. A successful attention response for the inspected instance verifies service
availability independently of guide reads; guide errors preserve loaded data and Pause/Stop access.
Using the loaded snapshot offline hides controls and stops these requests.

**Offer revision** shows a manual `xpl revise` command scoped to the guide/root with an explicit selected-
feedback placeholder. The reader creates or chooses feedback, runs the command, inspects the proposal,
and accepts separately. Opening the offer executes nothing: no feedback submission, job, patch acceptance
or request deletion. Agent-backed job submission and proposal review remain the jobs feature's responsibility.

**Three modes, one header.** **Read** is the default screen, for readers. **Explore** is the author's
workbench. **Present** plays a tour as slides. The header is one row built the same way in each: the title,
what the mode moves between, the save state (only when there is something to say: "Unsaved", "Saving…", "Not
saved"), the mode's one action, and the **Edit** menu.

Below the header, **Analysis coverage** is a collapsed disclosure in every mode. It names missing or
failed analysis and opens into capabilities, file counts and limits, labeled by analysis provider id.
Tool commands and diagnostic details are omitted.
It describes the original indexed repository, including when only some sources are embedded or the index
is pruned. A legacy index shows coverage unknown. Live refresh and Save as HTML use the current index report.
In a change guide, a bounded **Not checked** section below the author's summary names observed limits from
the loaded index. It is separate from the authored impact text and also appears in `xpl change` text and JSON.
If no omissions are recorded, the section is absent; that absence says nothing about unobserved runtime effects.

| Mode    | Moves between                                                              | Action  |
| ------- | -------------------------------------------------------------------------- | ------- |
| Read    | the reading tabs Guide, Map, Flow, Code                                    | Present |
| Explore | one tab per view (a strip that scrolls) and a Views menu                   | Present |
| Present | a tour picker and `‹ n / N ›`, with a progress bar along the header's edge | Exit    |

Present is disabled without tours, and its tooltip says how to get one. Most author tools sit in the Edit
menu: "Explore the diagrams" (from Read) or "Back to reading" (from Explore), "Edit the guide's steps" (the tour
panel), the Stubs control and edge-kind toggles of a graph view (Explore only, under "This view"), "Save as
HTML", "Record author review", "Download explainer JSON", and "Retry save" after a failed save. The menu works with ↑ ↓ Esc and Tab.
At 1280×720 the header fits without cutting a control off.

**Author review** (Edit menu, `components/Review.tsx`) captures a snapshot after pending live edits flush.
The author chooses all content or stored item IDs, attached anchors or repository source, additional indexed
files and named omissions. Inspection shows captured content and available head/base source. Scope changes
require a fresh inspection. Recording sends the captured fingerprint; it never silently regenerates approval
at click time. Offline recording uses `applyPatch` as `user`; live recording uses `PUT /api/review` and adopts
fresh disk/source. Later relevant edits render the existing record out of date. User removal is explicit.
No LLM patch, second reviewer record or authenticated identity is introduced.

About this explanation displays unchecked/reviewed/out-of-date separately from anchor checks, with reviewer,
time, content/source scope, source commit and omissions. It recomputes from readable snapshot evidence.
Missing source is out of date; offline pages cannot detect later repository changes. The Save as HTML
checkbox opts into `requireReview`, retains its choice in the exported report and defaults off for legacy
pages. CLI `ready` and `bundle` expose the same optional policy with `--require-review`.

**Save as HTML** (Edit menu, `saveHtml.ts`) opens a readiness inspection dialog with errors, reader warnings
and an optional author decision note. Save ready HTML is disabled with blockers; Save draft preview remains
available and names the output `*.draft.html`. Live saves flush pending edits, request `/api/export` and
refresh the paths loaded in the viewer from the workspace, then recheck at the final click. `/api/export`
refreshes referenced source; `/api/file` refreshes loaded paths outside that selection without cache reuse.
Failed saves/fetches prevent downloads; offline saves
check only embedded source and say so. Both paths use core's `checkReadiness`, and `savedPage` gates ready
serialization too. It saves the page as loaded with the checked explainer in its `<script id="xpl-data">`. A copy of the document is kept when the viewer starts, before React renders into it,
so what is saved is the page as loaded, not the rendered one. The saved copy keeps the index and the embedded
files, adds the files and base files fetched since the page opened, and drops `server`: it opens without
`xpl`, with the edits in it. Under `xpl view` the edits are saved by the server already; the HTML file is a copy
to share. Both ready and draft copies carry current feedback with its original IDs, context and outcomes.
The save refreshes browser records and live disk outcomes before export. Feedback capture works on both
ready pages and draft previews; an export decision never retargets a request to the exported explanation.

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
  Each section shows a source excerpt beside its prose (stacked in narrow sections). `stepSelection`
  reuses the full code view's checked focus, including explicit `step.code` and before-change anchors.
  The first range in source order supplies at most 12 lines; a count explains when more ranges exist.
  "Open full code" opens that complete range and its before/head side. Missing, drifted or unavailable
  source is stated instead of guessed. Source text comes from the bundle or the existing file loader.
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

**Diagram keyboard navigation** (`components/PanZoom.tsx`): focus the canvas and press Enter to
focus its first element. Up/Down cycle through the drawn elements in reading order; Home/End go to the
first/last. Left/Right follow incoming/outgoing relationships: maps and sequences move through an arrow
and its source or target; flows move between connected stages. When there is more than one link, the first
in drawing order is followed; Up/Down reach the other links. Enter/Space select the focused element and
show its checked code through the same path as a click. Focused elements are panned into view. Escape
returns to the canvas without changing selection; Tab and Shift+Tab retain their normal page order.
Canvas arrow keys still pan, and +/- and 0 still zoom and fit. A focus hint announces these keys.

**Graph authoring** (`components/GraphAuthor.tsx`): Explore's stored graph views offer **Edit map** beside
the caption. Shift-click sibling boxes, name the group and explicitly group them. Ungroup removes the
container from this map while retaining the stored group and its references. Hide selected boxes/arrows
and restore individual hidden IDs or all of them in the same disclosure. The controls are absent in Read,
Present and synthetic workspace maps. Transient in-place opens are never copied into stored include.
These actions use the text/evidence author queue and conditional history, including live reload, offline
edits and HTML/JSON export. Successful graph edits and inverses clear selections that the map no longer
shows. Text/evidence editing and source refresh keep their existing source-focus behavior. Evidence draft
status stays in the sticky Save/Cancel bar, including the disabled Save reason.

- **Graph view:** a layered layout (dagre, `layout/layered.ts`), direction RIGHT, or DOWN when the pane is taller than wide; when the result
  would have to be scaled down to fit, the other direction is tried too (graphs of at most 150 elements) and
  kept if it fits at least 8% larger. The direction is on the graph as `data-direction`. Containers
  for nested includes, laid out inside-out with room for their header; an edge that crosses a container's
  border gets a port there (a node of its own in the container's first or last layer), so the part inside
  is routed around the boxes; edges routed inside their lowest common container, right-angled, with the ends that share a side of a box spread along it and the turns in one gap
  between layers on separate tracks. `GraphView.layout` replaces automatic positions at each container
  level before sizing its parent. Pins are finite logical coordinates relative to the rendered container,
  or to the canvas for roots. Negative child coordinates expand the container frame to the left/top
  without translating those children or changing saved pins. Routes reconnect to the moved frames;
  unpinned siblings yield space when a pin occupies their old position. Changed levels discard stale
  dagre tracks and detour around other boxes. Live maps, Reader and Guide
  pictures share those positions and bounds, including offline HTML. Hidden pins stay stored until
  restored; opening a map inside another uses the outer map's pins. Each stored level has its own layout.
  A selected box in Explore has a move handle: drag previews locally, release writes one `editGraph`
  pin through author history; Enter pins here and arrow keys move by 20 px. The focused handle stays
  mounted while a save disables its actions. Escape, pointer cancellation and selection changes discard
  the local preview without an edit.
  **Edit map** resets selected/all placement to automatic layout with the same undo. Pan/zoom remain
  transient navigation. If the layout throws, a grid layout keeps the diagram usable (`data-fallback`). Edges are styled by resolution: precise,
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
  the wheel, the buttons or `+`/`-`, and "Fit" (or `0`). Maps with saved pins keep at least zoom 0.9 on load and
  Fit (14 px labels render at 12.6 px or more); larger pinned maps pan instead of shrinking further.
  Their "Pan to explore" badge returns to the starting focus. Automatic maps offer "Fit all" and start
  framed at zoom 0.75 when fitting below 0.6 would hide their labels. The first frame starts on the
  selection, else on the first drawn box of `view.include`.
  Sequence diagrams pan and zoom the same way, and each tour step starts its diagram over
  on the step's focus, even within one view. View edits (expand, drill in, collapse, edge-kind toggles, the
  Stubs control) are stored on the view. Selecting a stub focuses the reference sites that cross the boundary
  there plus the definitions on the far side (of every element a folded ghost stands for); its details list
  those elements with a button each. Ghosts are pictures in Present: no menu.
- **Sequence view:** lifelines, one row per step (`call` solid, `return` dashed, `async` open head), self-calls
  as loops, frames (`loop`/`alt`/`opt`/`par`) as labelled rectangles around their steps, nested by
  `resolveFrames`. A step's hit area covers its label and arrow. When the view has moved down, a copy of the
  participant names stays at the top of the pane (`sticky-heads`). The Read-mode Flow tab uses this same
  renderer for sequence views, matching the Guide picture and Explore.
- **Flow view:** `processFlow` (§4.8) laid out by the same layered layout, top to bottom: stages as boxes, decisions as diamonds,
  terminals, and the labelled `next` branches. A box shows the step's label large and, under it, the actor:
  the step's `from`, plus "→ B" when a stage hands work to another part and that fits (`stageActor`); a
  decision or a terminal shows the actor alone, and so does a step inside one part (the Guide and the details
  say "inside X", never "X → X"). A flow never zooms below 11 px text (`FLOW_READABLE_ZOOM`, Read's start and the
  floor of "Fit"). Recurse and return links are dashed and purple, with "one level down" / "up one level"
  after their label; a link of a stage to itself is a loop on its right side; labels are drawn after all
  lines. A code-first view (`codeFirstView`) puts the code in the main pane (Read: a flow view gets a narrow
  outline column; Explore: the diagram column is narrow) and the outline keeps the caret's step (else the
  selection) near its middle (`PanZoom.revealMargin`). Read keeps sequence views in the diagram pane,
  regardless of `layout`; "Show source" opens their linked code. Explore narrows a sequence's diagram column
  only for explicit `layout: "code-first"`, keeping its lifelines, arrows and frames without a
  caret-following process outline. One-file sequences otherwise keep Explore's usual diagram layout.
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
  offline saves in browser storage and offers JSON export through Feedback), "Add … to the view" for a stub, "Open children",
  "Collapse".

**Feedback:** a header button in Read, Explore and Present opens a panel for corrections, explanations
and expansions attached to the selected element and cursor lines (or the element's first source range).
Before-source selections retain `side: base` and do not look up head symbols. Offline requests survive
reload in a browser namespace captured once from the page's original artifact/source identity. View edits
and live refresh never change that namespace; each request keeps the context at the time it was captured.
Each request outcome is written under an immutable key containing its stable ID, revision and content hash.
Concurrent tabs and delayed responses cannot overwrite a newer version, even for the same request ID.
Reload reads legacy arrays and per-ID records without rewriting them and keeps the greatest outcome
revision from embedded and browser records. Newer embedded results are persisted too, so reopening an
older page retains them. Equal revisions keep the held result. Live responses use the same merge rule
and preserve browser-only requests. A newer portable result must be imported into the author's disk
store before recording its replacement; an older disk response cannot erase it. Only the locked author
recording increments revisions. Browser versions are retained; quota refusal is reported rather than
pruning feedback. JSON export rereads browser versions, including results observed in another tab.
Conflicting original content for one ID is reported without overwriting storage.
JSON exports and Save as HTML carry
the same validated contract, including outcomes and reasons. Storage refusal is visible; readers must
export JSON or save the page before closing it in that case. Live requests use `POST /api/requests`;
opening the panel reads saved disk outcomes. Current and original source warnings and changed hashes
are shown as outdated context. Instructions say to import feedback and invoke the next pass explicitly.

**Live questions (40B).** Details exposes **Ask a question** to readers and authors. A code pane exposes
**Ask about selected lines**, enabled with a cursor selection; this preserves inclusive head/base lines.
Range-only questions use the file element ID even without a diagram selection. Both actions open Feedback,
whose **Ask a question** requires a non-empty note and captures an `explain` request before contacting the
worker. **Ask a question** is the primary action; **Save for the next revision pass** saves feedback
without starting generation. Revision proposals remain separate.

The panel uses 40A's `/api/answers` API directly. While open, it polls answer history once per second,
with one refresh in flight. Queued/running jobs offer cancellation;
failed/interrupted jobs offer retry with the inspected attempt counter. Completed answers remain immutable.
A name-based UUID is derived from the request ID before POST, without reading or writing browser storage.
Uncertain delivery, reload and separate browser sessions reuse the question's job; the service also
enforces one job per request under its ledger lock. Browser storage refusal cannot prevent live answering.
Existing jobs for a request are inspected instead of starting another answer. Backend/network refusal
retains pending feedback and names export, CLI import and the harness-specific skill invocation for feedback as the next steps.

Completed answers are read through the existing validated feedback store and merge independently of
outcome revisions. JSON import validates the prospective union before mutation, including answer ownership
and the 1,000-answer limit. Live import also sends the original requests/results to the existing request
endpoint. Reload, JSON export and Save as HTML use that same history; no separate answer cache is stored.
Source/explanation hashes and freshness warnings mark outdated context, including changes during a run.
Questions with an answer show **Answered**, including imported history without a live job. Revision status
is separate: pending outcomes show **Revision: not yet reviewed**, without changing the stored outcome.
Answers show text, their original identity, exact references and recorded excerpts. Reference clicks compare
recorded source hashes with loaded source before using existing file/cursor linking, including base panes.
If text changed or is unavailable, the highlighted recorded excerpt stays in Feedback; current lines are
never presented as the old evidence. Answers cannot alter guide content or author outcomes. Optional changes
still need explicit revision review and acceptance through #30/#39C.

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
step and selection as far as they still exist; workspace adoption waits while edits made on the page are
unsaved, but connection status still updates. A poll started before a completed page edit is discarded,
including delayed source-file reads; the next poll retries the workspace.

**Text and concepts.** In Explore, select a node, stored arrow or concept and use **Edit text** in Details.
Label, summary and Markdown detail stay in a form draft until **Save text**; concepts can also select related
elements. Drafts live in the store, keyed by element, until saved or explicitly cancelled; switching boxes or
returning to reading keeps them. Save/Cancel stay visible at the bottom of the editor. Summary-only corrections
do not require fixing an existing empty label. The header names unsaved drafts, saving, saved and rejected edits.
Live saves check the version captured when the editor opened; a stale form must be reopened and inspected.
Source remains read-only. A review record is optional and stays present when content changes.

**Source evidence.** In the same Details panel, **Edit evidence** previews selected source lines with
`makeAnchor`, using the smallest symbol containing the full head selection or file-relative lines. Base panes
use file-relative anchors checked against the change base. Head source must match the index before symbol
coordinates are used; otherwise reindex and reload. Preview includes side, file/symbol, lines and selected text.
**Replace with selected lines**, **Remove evidence** and **Add selected evidence** stage explicit changes.
The editor reuses the resolver's `moved`, `drifted` and `missing` classifications; attention's Inspect element
selection opens this same target, with no separate list. Text and evidence editors share one draft per element;
finish or cancel one before opening the other. Drafts survive navigation. Before **Save evidence**, core checks
the staged array locally; the server repeats the checks against fresh source under the lock, retaining the
previewed hashes. Invalid siblings must all be repaired or removed; rejected saves retain their draft.
Evidence changes use the existing author queue, version check and provenance. Later LLM patches cannot replace
user-edited fields. JSON and HTML exports include saved evidence and source; reopened static HTML works offline.

Edit → **Undo** / **Redo** names the changed fields and element and writes the inverse through the same patch
route. Before a live
undo, the viewer fetches the current bundle, then checks only the touched field values and submits its current
artifact version. Unrelated concurrent edits survive; edits to the same field reject without moving history.
History holds at most 50 operations. Persisted records carry a checked identity as well as a storage key:
all live attachments use canonical repository root and guide path, excluding the process instance. Without
a live attachment there is no history across reloads; only in-session undo remains. Content-derived, legacy or
mismatched records are ignored. Undo requests carry the original root/guide identity, checked by the server
independently of browser storage; touched-field preconditions still protect every save. Storage refusal is visible and does not
undo a successful disk save. Static edits/history live in memory until JSON or HTML is
exported; original-page reload discards them. An open form draft or save blocks HTML export. Undo never
replaces an artifact or restores old provenance/review records. Restoring invalid historical evidence rejects
and leaves the entry available; no hash is discarded to force undo. Existing tour/view edits keep their prior
save paths and tour-step deletion undo.

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

`SKILL.md` drives the operations below, plus regeneration, through the CLI (`<skill-dir>/bin/xpl`).
`xpl skill install` copies the artifact's bundled skill for Claude Code, Codex, Pi, Factory Droid or
Devin; Claude Code is the default. Codex, Pi and Factory Droid install to `~/.agents/skills/code-explainer`;
Devin installs to the current project's `.agents/skills/code-explainer`. The installer accepts `--dir`
for a project destination. The npm package
bundles the CLI and skill; harness installation, authentication and provider access are separate.
`xpl-install.json` records the installed CLI's absolute path, skill version and owned file hashes.
Repeating installation updates the copy and
launcher under a directory lock. It stages a replacement beside the destination and rolls back if the
replacement fails. It refuses symlinks, unmanaged directories, changed owned files and extra files;
move them aside to preserve edits before reinstalling. A moved CLI is repaired by rerunning installation.
`XPL_CLI=<xpl.mjs>` overrides the binding; a source-development skill still finds
`packages/cli/dist/xpl.mjs` relative to its real path. Everything the authoring harness writes is a
patch; it never edits an explainer by hand. SKILL.md and its `reference/` files are the source of truth
for the rules; this section
only says how they use the CLI. Harness installation, authentication and provider access are separate;
the skill never starts a resident generation worker. Live harness invocation has not been verified.

Before indexing, the authoring agent gathers the repository root, audience, question and guide name. It
lists existing guides and uses one only when selected by the user; `new` refuses a collision. The
installed entry and recovery instructions are in `reference/create.md`. Drafts receive `--audience` and
`--question`; scratch
patches and snapshots stay outside the indexed tree. An interrupted authoring run resumes from the stored
guide and outside patch, without deleting the guide or using `--actor user` to bypass protected fields.
Creation finishes with `xpl ready <name>` and a gated offline bundle outside the source root. The author
records justified warning/omission decisions with the same `--note` on both commands, opens the guide
locally or inspects the snapshot, and reports what was checked. A requested `--draft` preview is labelled
as unfinished; it is not the creation workflow's finished result.

The authoring agent chooses among three scopes: `explain <question>` (part of a project), `explain repo`
(the whole project) or `explain change <base>..<head>` (a diff). The reader sees the tour title and its `summary` first,
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
newcomer's re-read → `xpl ready` → `xpl bundle --files boundary` (the default in cloud sessions) or `xpl view`.

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
  that reference them; the authoring agent checks each "before" claim in the base code and anchors it there
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
  became visible (`xpl status` names it), then record only the selected request outcomes with `xpl feedback`. A folded ghost is
  not an element: `includeAdd` the elements it stands for (`xpl status` prints up to 3 per ghost, `status --json`
  all as `views[].ghosts.list[].targets`; the viewer's menu, `outline --under file:p` and `refs <shown id> --out`
  show them too) or `file:p` for the whole file as one box; `hidden` takes ghost and stub ids
  (`xpl status --json` lists them); `stubs.mode` `all` is for small views only, `none` draws no stubs.
- **`feedback [<id> <what to change>]`**: what the user typed under "Explain this" in `xpl view` (the
  queued requests with a note in `xpl status`). Per request: read the element and its code, make the
  smallest patch that does what the note asks (more to show is `expand`; a claim the code contradicts is
  fixed in the text, never by bending the anchor; a note wrong about the code changes nothing), all in one
  patch, lint, apply and record selected outcomes with original IDs/context. Never delete the feedback store;
  new and unselected requests survive. Outdated context needs explicit reconciliation. The open page picks
  the applied explanation change up by itself.
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

`reference/`: `create.md` (installed creation prompts, target choice and recovery), `quick.md` (the one-page
quick reference: the loop, what every patch needs, the lint checks),
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

`fixtures/java-jobrunner` adds a Maven fixture for semantic artifact import, with overloads, both
nested-class forms, interfaces, abstract methods, callbacks and records. It has 13 Java files and a
standard-library `RetryTest` main; `mvn test` does not run that main. The Java acceptance test imports
a recorded scip-java artifact outside the fixture, with checked ranges/nesting and precise type mentions.
The repeatable workflow and checked bundle example are in [docs/java-scip.md](java-scip.md).

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

Java artifact import is also exercised without a language pack: the pinned scip-java/Maven workflow
retains source-checked declarations and type references, with file-anchor fallback and explicit losses
([docs/java-scip.md](java-scip.md)). Java stays `text`; semantic calls and inheritance are unsupported.

The [language-support decision](assessment-2026-10-04-language-support.md) compares syntax tags and
rust-analyzer SCIP on identical Rust inputs, and Java SCIP separately. Both new-language paths remain
experimental. The measured Rust artifact has no full ranges: import removes tags in described files and
`require` can still succeed without retained targets or relationships. Use Rust tags with `--precise off`.
The decision recommends separating examined coverage from replacement authority before joining semantic
identities to syntax ranges. This is a proposed contract revision, not a change to the current §3 contract.

**Known limitations**

- `read` references are conservative (§3): module or package variables and constants, and fields whose type is
  known. A read of a local or parameter, through a receiver of unknown type or by dynamic access is not
  recorded, and `reads` edges are off by default (`DEFAULT_EDGE_KINDS`; the viewer's toggle and `edgeKinds`
  switch them on; stored `reads` edges are always shown).
- The layout runs on the main thread: laying out a very large graph blocks the page, so views
  should stay coarse (whole-repo views start at packages) and are expanded by hand.
- Live refresh is polling-based: updates appear on the next poll while the page is visible and has no
  unsaved edits; connection checks continue with unsaved edits. Source locations and reference edges
  need reindexing after source changes; `service start --watch` supplies it automatically. Paused watches
  retain a stale snapshot; resume to check again. Offered revisions require selected feedback and separate acceptance.
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
  concepts, flows, `llm` edges, base anchors and every sentence are written by the selected authoring agent.
  A draft covers about one view and most of the tour steps of a hand-written explainer, with roughly half
  its anchors. `xpl draft path` is
  depth 1, so a path whose layers call each other through a variable (`self.app`) is not rebuilt.
- `xpl lint` is mechanical: it catches slogans, absolute words, long sentences, code titles and order
  problems, not wrong claims. `repeats-summary` finds near-verbatim repeats only.
- Workspace packages are private; build/pack produce a standalone local npm tarball with
  its viewer, grammars and skill. Install/update and reader/export checks cover Linux x64/WSL2 only.
  Node ≥22.12 is required. This source tree builds `@krimvp/xpl` 0.2.2 under MIT; a `v*` tag starts publication.

**Next steps, roughly by value** (the review in `docs/review-2026-10-01.md` has the roadmap): an independent
accuracy pass for change explainers; a word-level diff in rewritten lines; editable step titles and code in
the viewer; the layout in a Web Worker; more
language packs (each needs `extract`, `classifySite`, `resolveModule`, and optionally a SCIP resolver);
publishing the packaged CLI through a selected release channel; a regeneration mode in the skill that
walks `xpl status` on its own.
