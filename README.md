# xpl — code explainer

[Try the live example](https://krimvp.github.io/xpl/) on the xpl site.

Interactive diagrams linked to code in both directions. Click a box, an arrow, a sequence step or a concept
and the editor highlights exactly the code it is about, across as many files as it touches, everything else
dimmed. Put the cursor in the code and the diagram elements and concepts that cover that line light up.
Claude writes the explanation as data, checked against a static index of your repo so it cannot point at
code that is not there; a fixed viewer renders it, live or as one HTML file you can share or present.
The page opens on a guide: a short summary, then the steps, each with a picture and its code. For a change
(a PR or a branch), it also shows the diff, and claims about the old code are checked against the base commit.

![Explore mode: the step requeue(job, backoff) is selected; its call site in runner.ts and the method it calls in queue.ts are highlighted, the rest of both files is dimmed](docs/images/dispatch-step-selected-light.png)

![Present mode: step 2 of a tour, with the retry policy's code, config and test on the right](docs/images/tour-step-2-light.png)

Install target: [`@krimvp/xpl`](https://www.npmjs.com/package/@krimvp/xpl).

## Quick start

Needs Node 22.12 or newer and npm for installation. The local artifact is exercised on Linux x64
(WSL2, Node 22.23.1). Other platforms have not been verified. `@krimvp/xpl` 0.1.0 is published on npm
under MIT. Install with the command below. You can also build from source
with access to the private [source repository](https://github.com/krimvp/xpl).

XPL helps an author publish a focused explanation of code. Choose a reader and a question before
drafting. Readers can check the linked source and tests; a valid anchor checks a location and
freshness, while the author remains responsible for the explanation's claims and omitted behavior.

```sh
npm install --global @krimvp/xpl
xpl skill install                             # copies the bundled skill and binds its launcher
xpl doctor --agent claude                      # also checks the skill and Claude Code availability
```

Or build from a source checkout:

```sh
npm install && npm run build
npm pack ./packages/cli/dist
npm install -g --ignore-scripts ./krimvp-xpl-0.1.0.tgz
xpl skill install
```

A maintainer's tarball can also be installed offline with
`npm install -g --offline --ignore-scripts /absolute/path/krimvp-xpl-0.1.0.tgz`.
No source checkout or build is needed to install an npm package or tarball. After updating the CLI, rerun `xpl skill install`
to update the skill and its launcher. The launcher records the installed CLI's absolute path; rerun the
installer after moving the CLI. For one project, use `xpl skill install --dir .claude/skills/code-explainer`.
The installer refuses to overwrite a symlink, an unmanaged skill or local edits: move the old directory
aside to preserve it, then retry. Claude Code needs its own installation, authentication and provider
access. In a TypeScript, Python or Go repository, explicitly ask it:

```
/code-explainer explain How does X work? Root: /absolute/path/to/repo. Audience: maintainers. New guide: subsystem-guide.
```

For the three creation scopes and safe retries, see [Create a guide](skill/code-explainer/reference/create.md).
Choose a new guide or name the existing guide to extend; an existing file is never replaced by creation.
The agent writes and checks the JSON patch for you.

GitHub PR input is opt-in: `xpl pr prepare https://github.com/owner/repo/pull/42 --cache-dir /outside/pr-cache`
uses existing `gh` and git access to fetch the returned full base/head commits into a separate detached
repository. It indexes head with `--precise off` by default and saves an immutable `input.json` with
before/after source and analysis labels. The developer checkout stays untouched. This command prepares
input only. `xpl pr create <url> --name pr-guide --audience reviewers --question "What changes?"` also
runs the installed skill launcher to scaffold a guide and returns an explicit agent invocation. After
authoring, `xpl pr finish <input-directory>` checks readiness, exports HTML and rechecks both API commits.
Its immutable result manifest is ready only for matching commits; changed commits are superseded and
remain historical. No model starts automatically and no current link is published. Network access
to GitHub is required. Remove a retained input with `xpl pr cleanup <input-directory> --cache-dir /outside/pr-cache`.
Inherited Git repository overrides cannot redirect PR reads into the developer checkout. Preparation
refuses checkout filters or line-ending conversion that change the head's raw source bytes.

The viewer's **Search** button finds symbols, supplied source, concepts and tour steps offline. Results
open the exact source range or recorded step; copied links work when the page is reopened. The panel
reports the snapshot, embedded files, pruned analysis and unavailable coverage separately from no matches.
Its guide picker shows contained guides in exports and the repository catalog when a service is attached.
Results have separate 16-row pages for symbols, concepts, steps, guides/tours and source, so source
matches cannot hide explanation matches. Each group reports its own count.
Other live guides open as read-only previews with a Back to library link. To edit one, the page shows
how to stop the current repository service before starting the exact selected guide.

`xpl bundle main-guide -o library.html --include-guides retry-guide,operations-guide` adds up to eight
checked snapshots for offline switching, with a 20 MiB limit on additional guide data. Each keeps its own
source and index scope. Unsaved drafts or pending edits must be saved or cancelled before switching.

`xpl stage <guide> --dir /outside/versions --preview` lists the head/base source files that will be
included and checks readiness without writing. Omit `--preview` to stage immutable HTML and a manifest,
then atomically promote `/outside/versions/current/index.html` under a lock. Previous version folders
remain available. The manifest records commits, artifact and input hashes, readiness, source scope and
author review state. Source or guide changes during staging leave the previous current version intact.
For PR guides, pass `--pr-result <result.json>` from `xpl pr finish` and `--root <prepared-repository>`;
staging verifies the result and rechecks GitHub base/head before promotion. This is local storage only.
Configured remote delivery, exact version links and the PR Action are later slices of #34.

`xpl guides` lists locally saved guides by title, recorded questions, audience and source/index commits.
It works without a service or index file. `xpl search <pattern>` searches available indexed working-tree
text; unavailable files produce a warning, and `--json` records searchable paths and analysis scope.
Loadable guides with invalid metadata stay listed by ID/path with a metadata error. Guide metadata is
descriptive; use `xpl ready <name>` to check a guide before exporting it.

Claude indexes the repo, writes `.explainer/<name>.explainer.json` (commit it; the indexes beside it are
git-ignored) and gives you the result. Open it yourself with `xpl bundle <name> -o <name>.html` (one
self-contained file that carries the source files the explainer shows: works offline, easy to share;
`--files boundary` adds the callers, callees and tests around them, `--files all` every file of the repo) or
`xpl view <name>` (a local server with live repo access: your edits are saved and "Explain this" clicks are
saved for the next explicit revision pass). Other things to ask for: `explain this repo`, `explain change main...HEAD` (a PR or a
branch), `expand <node>`, `make a tour` (Present mode: arrow keys step through it). More in
[skill/code-explainer/README.md](skill/code-explainer/README.md).

Reading, `xpl index --precise off`, local viewing and HTML export use bundled assets without hosted xpl
infrastructure after installation. `xpl index` defaults to optional precise tools: npm/Go tool bootstrap,
toolchains and repository dependencies can need network access. Use `--precise off` offline; heuristic
references stay labeled as hints. `--precise require` fails if precise analysis cannot run. Authoring
through Claude Code has separate provider network requirements. `doctor` runs local version checks;
it does not download precise tools or verify agent authentication. No resident generation worker is needed.

In the viewer, Guide tells the story, Map shows relationships, Flow follows steps, and Code opens
source. Present plays a tour with arrow-key navigation. Feedback saves corrections, explanation requests
and expansions against a selected element and source range. `xpl view` saves to disk; a disconnected
saved page keeps requests in browser storage and offers **Export feedback JSON**. Import that file with
`xpl feedback <name> --import /path/to/feedback.json`, then invoke `/code-explainer feedback` in your chosen
agent for the next pass. Saving does not start generation. Stable IDs deduplicate repeated imports;
original snapshot hashes, ranges, outcomes and reasons stay available. Changed snapshots are reported as
outdated and require explicit reconciliation. Export browser feedback before clearing browser data.
Browser storage can be unavailable; the panel reports this and JSON export or Save as HTML keeps the requests. Applied explanations, source changes and
new indexes refresh in a live viewer; a saved HTML page stays at its exported version. Unsaved edits
postpone live refresh. Reindex changed code to restore reliable source locations and references.

The next pass uses `xpl revise`: select request IDs, inspect ordinary per-request patch proposals with
explanation before/after and source, review the author's accepted/rejected subset, then explicitly accept.
Acceptance rechecks live source, snapshot identity and readiness. It preserves user-owned content and the
previous artifact, and records only selected outcomes. Interrupted acceptance resumes without applying or
recording twice. Missing anchors need an explicit re-anchor or removal decision; location-only moves keep
prose unchanged. See the installed skill's [revision workflow](skill/code-explainer/reference/revise.md).

No Claude at hand? The source repository's fixtures ship example explainers (fixtures are not in the tarball):

```sh
cp -r fixtures/ts-jobrunner /tmp/jobrunner && cd /tmp/jobrunner
xpl index && xpl view jobrunner    # http://127.0.0.1:4747
```

## Optional repository service

`xpl service start <guide>` runs the local viewer in the foreground; Ctrl-C stops it. Add `--background`
to detach the installed CLI. `xpl service status` reports its instance, address, canonical repository root,
selected guide and backend label. `xpl service stop` verifies that instance before stopping it.

The service also exposes headless snapshot-bound question jobs at `/api/answers` when the Claude backend
is selected. They validate exact head/base source quotes and retain answers in portable feedback history;
source or guide changes mark the original context outdated. An answer never edits a guide or finalizes a
revision outcome. The question/history UI follows in #40B; current feedback controls keep their offline workflow.
History merges reject reused answer IDs and more than 1,000 answers per question, preserving the stored history.

```sh
xpl service start jobrunner --background        # loopback only; logs in .explainer/service/service.log
xpl service status --json
xpl service stop
xpl service start                               # reuse saved guide, port and backend selection
xpl service status --root /path/to/other/repo    # another repository has its own service
```

One service owns each canonical root, including symlink aliases. Stop it before selecting another guide.
An exited owner is reported as interrupted; inspect the artifacts, then use `xpl service start --recover`.
Recovery archives the old instance record. A live PID whose identity cannot be verified is never signalled
or replaced. Crashed artifact-writer locks need explicit inspection and removal; elapsed time is no proof.

The git-ignored `.explainer/service/` directory keeps local context and ownership records. `--backend claude`
enables the installed Claude Code proposal runner; `none` (default) disables execution. Use
`--skill-dir <folder>` for a non-default managed skill installation and `--job-timeout <seconds>` for a
run deadline (default 300). Both choices persist. Availability means configured, not authenticated;
actual jobs report tooling, login and provider failures. The viewer reports connection and backend
availability below the header, without claiming sign-in. Open **Connection details** for the root and last service instance.
Bookmarks retain the repository and guide; an address serving another guide is refused. Restart with
`xpl service start` and the open page reconnects to that saved guide, keeping your selection and unsaved edits.

After stop, choose **Use loaded snapshot offline** to keep reading, edit manually, capture feedback and
save HTML from the loaded source. The export checks the embedded snapshot; it cannot check later repository
changes. Download edits before closing. **Retry connection** attaches the original address again; use
**Edit → Retry save** to persist offline edits. Offline feedback stays in the browser until exported and
imported with `xpl feedback`. Manual commands and portable HTML work with the service stopped. Local serving
needs no provider network or credentials; Claude jobs use the CLI's existing login and provider access.

Watching is opt-in on each start:

```sh
xpl service start jobrunner --watch --background
xpl service pause             # keep the service and jobs running; retain a stale snapshot
xpl service resume            # check inputs and rebuild
xpl status --all --json                         # every guide: moved, drifted or missing anchors
```

The watcher polls paths and file metadata, capturing source and resolver configuration when inputs
change. It follows ignored config chains regardless of filename, coalesces edits and rebuilds the full index. Superseded builds are discarded; readers see a complete snapshot. Failed or cancelled builds
keep the previous index marked out of date. Moved code keeps its prose; drifted and missing evidence still
block ready export. Watching saves no guide text, accepts no generated revisions and leaves feedback intact.
It defaults to heuristic references (`--precise off`); `--precise auto|require` enables semantic tools and
`--scip <artifact|manifest.json>` observes supplied provider inputs. A watched service cannot pin `--index`.
Generated exports and other excluded outputs do not dirty the watched index, even from a clean Git tree.
Watch options are selected again on restart. Recovery retires the previous watch pointer. The managed
viewer has one compact status bar with separate connection, attention and watch-control disclosures.
Inspect moved, drifted or missing evidence, pause/resume the watch, or stop the service. Attention scrolls
without shrinking the diagram; controls stay available if the attached guide becomes unreadable. Paused snapshots cannot become ready. An offered
revision names `xpl revise` with feedback IDs you choose; inspect and accept its proposal separately.
Plain `xpl view` and saved HTML have no service controls. Stop the service to return to manual indexing.

The service also keeps job history in `.explainer/service/jobs.json` and exposes it at `GET /api/jobs`.
Running attempts become interrupted after restart; completed proposals stay recorded, and cancelled or
superseded results stay fenced. Each Claude attempt records its group and start identity before launch.
Every attempt drains its process group before final state or more work, including normal and error exits.
Cleanup failure stops scheduling. Service death kills that group through the launcher's pipe; recovery verifies the recorded Linux start
time before terminating any remaining group and allowing retry. Reused PIDs are left alone.
Verified execution currently requires Linux /proc; manual revision works on other platforms. With `--backend claude`, submission generates an ordinary proposal,
validates it through `xpl revise` and leaves it awaiting explicit author review. Source is read-only; the
agent can write only its owned output. Job completion does not apply a patch or finalize feedback. Creation proposals
fill an explicitly initialized guide with selected requests and included IDs through the same journal.
Open **Jobs** in the connection bar to select feedback, start a job, inspect progress, cancel or retry.
**Review proposal** shows readable field changes with marked text, evidence as file/lines/role/status,
and source before/after. Raw changes sit behind **Show raw change**. Choose accept, reject or leave
unresolved for each request and give a reason. **Review decisions** checks the exact combined candidate;
only then can **Accept reviewed revision** commit it and finalize those selected outcomes.
If another view changes the decisions, acceptance stops and reloads the review for inspection.
New feedback stays pending. Cancelled, superseded, stale and old-attempt results cannot apply.
After an interrupted acceptance, reopen the review and **Recover acceptance**; it does not apply twice.
Service-owned runs refuse manual proposal/decision/accept writes to preserve these fences;
`xpl revise <guide> --run <id>` still inspects the journal. Offline feedback and manual revisions remain available.

## Using the CLI directly

Run these inside the repository you want to explain (or pass `--root <dir>`); every command takes `--json`.
The ids are those of the TS fixture from the quick start.

```sh
xpl index                                       # symbols and references -> .explainer/index-<commit>.json
xpl outline --depth 2                           # dirs, files, symbols: exact ids, line ranges, fan-in/out
xpl show src/runner.ts#Runner.dispatch --refs   # code with the 0-based offsets anchors use, and its calls
xpl refs src/queue.ts#Queue.requeue --in        # who calls it (hops through interfaces)
xpl new myrepo --title "My repo"                # .explainer/myrepo.explainer.json, bound to the index
xpl draft repo myrepo --audience "New maintainers" --question "How does this project work?" -o /tmp/draft.json
xpl lint myrepo --patch /tmp/draft.json          # write each TODO and check the reader text
xpl apply myrepo /tmp/draft.json                 # check and merge the patch: all or nothing
xpl validate myrepo                             # every id and anchor still resolves?
xpl lint myrepo                                 # plain-language, tour and reader checks (exit 1 on any; --warn-only)
xpl view myrepo                                 # http://127.0.0.1:4747 (falls back to a free port)
xpl ready myrepo                               # check source, required text and reader findings
xpl bundle myrepo -o myrepo.html                # one self-contained HTML file (--files boundary|all; --tour <id>)
```

`xpl search`, `xpl anchors`, `xpl resolve` (after the code changed), `xpl status` (what still needs
explaining), `xpl change` and `xpl draft change|path` (below) complete the set:
[skill/code-explainer/reference/cli.md](skill/code-explainer/reference/cli.md).
The format of `patch.json`: [skill/code-explainer/reference/patch-format.md](skill/code-explainer/reference/patch-format.md).

Drafts are provisional. Import lines suggest dependencies and architecture roles; review the primary
users and entry points. Path drafts select direct call sites in source order and list capped or
collapsed targets. Check conditions, loops and callback execution before describing a runtime flow.
In heuristic indexes, function values and callback registration are `read` references; invocation is a `call`. Reads are
available through `xpl refs` and the Map edge filters without creating recursion or execution steps.

Strict validation and ready export require a current index, even with `XPL_SKIP_STALE_CHECK=1`.
After changing code, run `xpl index`, `xpl resolve myrepo --write`, review the drift, and rebuild
the affected explanations before validating and bundling. `validate --lenient` supports repair work;
`xpl ready myrepo --json` reports source, structural, required-content and reader findings. Ready export
refuses before writing when required text is unfinished or source links are broken. Reader warnings invite
author judgment; `--note "reason"` records intentional omissions or warnings in the report and HTML.
`bundle --draft` writes a labelled preview for repair; `--allow-drift` is a legacy draft flag against a current
index. Edit > Save as HTML uses the same rules, with separate ready and draft actions. Offline re-saves check
only included source, and say they cannot detect later repository changes. Source checks do not verify prose
claims or every runtime path.
Generated XPL HTML pages are excluded from indexing, so exporting inside a repo does not stale its index.

In Explore, select a box, stored arrow or concept and choose **Edit text** in Details. Correct its label,
summary or Markdown detail; concepts also have a related-elements selector. **Save text** retains user
ownership, and **Cancel** drops the draft. Live saves survive reload and reject stale inspected versions.
Drafts survive switching boxes and returning to reading until saved or cancelled. Save/Cancel stay visible.
Edit > **Undo** / **Redo** names the fields and element and saves only changed fields, preserving another author's
unrelated edits and refusing conflicts on the same field. Live history retains up to 50 edits in browser
storage, bound to the canonical repository root and guide. Copied or renamed guides inherit no history;
pages without a live identity keep only in-session undo. Offline edits remain **Unsaved** until exported as HTML or JSON.

**Edit evidence** previews lines selected in the read-only source pane, checked against a symbol or file
(and the base for change guides). Explicitly replace, remove or add anchors, then **Save evidence**.
Repair or remove all invalid anchors on that element; rejected saves keep the draft. Source that differs
from its index requires reindexing and reload. Undo refuses to restore evidence that no longer resolves.
Later LLM revisions preserve your edited fields. Exported HTML includes the edits and source and opens offline.

In Explore, **Edit map** beside the map title groups selected sibling boxes under a named container.
Shift-click boxes to select them together. **Ungroup in this map** shows the members and keeps the stored
group available to other maps, arrows and tour steps. **Hide selected items** hides individual boxes or
arrows; the same menu lists hidden IDs with **Restore** and **Restore all hidden items**.
These actions share text/evidence undo, persist live and travel in HTML/JSON exports. Opening another
level remains navigation. Select a box and drag its move handle to pin it, or use arrow keys on the handle.
**Reset selected placement** or **Reset all placement** returns boxes to automatic layout. Pins are finite
coordinates relative to their container; nested frames and arrows follow them. Pan and zoom do not edit the map.

Edit > Record author review records a self-reported name, inspected content/evidence scope and named
omissions. About this explanation shows **unchecked**, **reviewed** or **out of date** separately from
source checks. A narrow review covers named stored items and their own anchors; unrelated source edits do
not invalidate it. Repository scope covers every indexed file. Broad review evidence travels with HTML;
offline pages cannot detect later repository changes.

Review is optional. `ready --require-review`, `bundle --require-review` and the Save as HTML team policy
checkbox explicitly require a current review of all stored content. The checkbox choice stays in that
exported page for re-saves. Omissions remain author judgment; a name or time does not verify prose truth,
identity or complete runtime coverage.

### Explaining a change

A change explainer describes the head of a PR or a branch, and records the diff from git. Check out the
head first: the index must be built from it.

```sh
xpl index                                       # index the head
xpl new myrepo-pr-42 --title "PR 42: what it does"
xpl change myrepo-pr-42 main...HEAD             # record the diff; print changed symbols, callers, tests
xpl show --at base src/queue.ts --lines 80-95   # the old code, with the offsets a base anchor uses
xpl draft change myrepo-pr-42 -o /tmp/pr-42.json   # map, anchors, a review-order tour; fill in every TODO
xpl lint myrepo-pr-42 --patch /tmp/pr-42.json   # nothing written; fix what it reports
xpl apply myrepo-pr-42 /tmp/pr-42.json
xpl bundle myrepo-pr-42 -o pr-42.html --files boundary   # before and after, callers, callees, tests
```

Keep patch files outside the repo: a new file there makes the index stale. `main...HEAD` starts from the merge
base; `A..B` takes two commits. A "before" claim is anchored in the old code with `"at": "base"` (and `find`,
or a span from line 1 of the base file), so `xpl validate` checks it like any other claim. The viewer shows
added and removed lines, a "Before" pane, New and Changed badges on the map, and the list of changed files.

### Architecture maps

An overview starts at the top, like the C4 model: a system map with your service, who uses it, and what it
relies on (databases, caches, queues, other systems' APIs, each drawn with its own shape), then the inside of
each service (its parts, and which part talks to which outside system), then the code. A box with `opens`
zooms into the next level, or shows that level inside itself on the same map; a trail above the map leads
back up. Every box has an icon for what it is: a person, a service, a component, a database, an outside
system, or a folder, a file, a class or a function. `xpl draft repo` drafts both levels and finds
the outside systems from the import lines. The text follows the same order: what each part is for, in plain
words, before any code name (`xpl lint` flags notes that are long or lean on code names).

![System map: customers send orders to the shop backend, which stores orders in a PostgreSQL database, charges cards with Stripe and sends receipts with SendGrid; the service box has a zoom button](docs/images/architecture-system-map-light.png)

![Inside the shop backend, opened from the system map: Startup, Web API, Order rules, Order storage, Receipts and Payments, each part with an arrow to the outside system it uses; a trail above leads back to the system map](docs/images/architecture-inside-light.png)

## Languages and precision

TypeScript/JavaScript, Python and Go get symbols and references. YAML, JSON and TOML get their keys as
symbols (`config/default.yaml#retry.maxRetries` or `pyproject.toml#project.scripts.flask` can be anchored like
a function). Rust has experimental syntax tags for named declarations and lexical nesting, with no resolved
relationships. Its tags provider runs with `--precise off` and needs no Rust toolchain; see
[the Rust experiment](docs/rust-tags.md) for coverage, measurements and commands. Any other text file is indexed as
plain text. The built-in language packs get symbols from tree-sitter (WASM, nothing to install); generated
SCIP artifacts can supply source-checked symbols too. References (calls, imports, inheritance, type uses, reads of variables and fields) come from a
scope-aware heuristic resolver, or, when the tool can run, from a compiler-grade SCIP indexer. `xpl index`
tries SCIP by default and prints what each language got: `refs: precise (scip-go@0.2.7)` or `refs: heuristic`.
The viewer draws heuristic edges lighter, and Claude treats them as hints.

`xpl index` also reports analysis coverage: file anchors, named symbols, full declaration ranges,
nesting, and each relationship kind independently. Saved indexes and exported viewers retain the
analyzed files, limits, and failures. Open **Analysis coverage** below the viewer's header for details.
Empty relationships do not mean complete analysis. Older indexes still load, with coverage shown as unknown.

| Language         | Precise references need                                                             |
| ---------------- | ----------------------------------------------------------------------------------- |
| TS / JS          | `npx` and, on first use, network access: `scip-typescript` 0.4.0                    |
| Python           | `npx` and, on first use, network access: `scip-python` 0.6.6                        |
| Go               | Go 1.25 or newer, or an older `go` that may download the toolchain: `scip-go` 0.2.7 |
| Rust             | nothing: syntax declarations only; relationships are unavailable                    |
| YAML, JSON, TOML | nothing: keys are symbols, there are no references                                  |

`--precise off` skips SCIP (fast, heuristic), `--precise require` fails instead of falling back;
`XPL_SCIP_TIMEOUT_MS` sets the per-tool timeout (default 10 minutes). Files a tool did not describe (build-tagged
Go files, for one) keep their heuristic references and are named in a warning; the summary then reads
`refs: precise 10/11 (scip-go@0.2.7), 1 heuristic`.

Repeated `xpl index` builds reuse file-local tree-sitter and Rust tags extraction in `.explainer/cache`.
Discovery, source hashes, heuristic resolution and semantic tools still run on every build. The summary
reports extraction hits/misses and wall time separately from fresh resolution and semantic work.
`xpl index --no-cache` reads and writes no cached facts; removing `.explainer/cache` reclaims old entries.
Cache directory aliases into the repository (symlinks or bind mounts) bypass reuse and report why.
See [cache keys, equivalence checks and measurements](docs/extraction-cache.md).

`xpl index --scip <artifact|manifest.json>` imports generated SCIP declarations and supported references,
including sources without a language pack (their language stays `text`). Documents need embedded source text
or an artifact-bound manifest of pre-generation source hashes. Missing full ranges, parents and call
classification remain explicit limits. Partial artifacts keep existing syntax symbol sets; a range-less
artifact can attach supported references to source-checked syntax symbols but cannot create declarations.
Standalone imports without checked targets report `refs: none` and fail under `--precise require`. See the [artifact workflow](skill/code-explainer/reference/cli.md#generated-scip-artifacts).

The built-in TS/JS, Python, Go and configuration paths have maintained language packs and acceptance tests.
Rust tags and the [Java workflow](docs/java-scip.md) are **experimental**, tested on jobrunner fixtures and
pinned bat/Gson repositories. Those bounded checks do not establish production maturity across either
language's build ecosystems. Java requires an explicitly generated artifact and a working JDK/Maven build;
it retains checked declarations and type references, while calls and inheritance remain unsupported.
Java stays plain text: use explicit views and `search` without `--code`.

The [language-support decision](docs/assessment-2026-10-04-language-support.md) compares both producers on
the same Rust sources and records the next slices. Use `--precise off` for Rust today. The pinned
rust-analyzer SCIP producer omits full declaration ranges; importing it can erase valid Rust tags and
still pass `--precise require` with no semantic edges. It is an investigation path, not supported Rust
precision. Its cached offline run needs a build-script override; a cold offline prep run crashed.
Missing semantic tools or failed builds require a fresh successful artifact. Java's `--precise off`
fallback keeps file anchors and config symbols, without Java named symbols or relationships.

Precise is not free on a big repository: on django (2,900 Python files) it took 4 minutes and 4.6 GB, on
sympy and prometheus 9 to 10 minutes and up to 7 GB, where `--precise off` took 15 to 40 seconds. The heuristic
references agree with SCIP on 97 to 99.9% of the calls both find (see
[the stress test](docs/review-2026-10-03-stress.md)), so start a big repository with `--precise off` and index
precisely when the answer depends on generics, untyped parameters or narrowing. Where a SCIP tool is wrong or
blind (a re-export it misnames, generated code with `//line` directives), the heuristic reference is kept.

## Repository layout

| Path                   | What                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------- |
| `packages/core`        | `@xpl/core`: schema types and pure logic (anchors, graph derivation, validation, patches). Browser-safe. |
| `packages/indexer`     | `@xpl/indexer`: file discovery, tree-sitter (WASM) language packs, heuristic resolver, SCIP import.      |
| `packages/cli`         | `@xpl/cli`: the `xpl` command, bundled to `packages/cli/dist/xpl.mjs`.                                   |
| `packages/viewer`      | `@xpl/viewer`: React + CodeMirror 6 + dagre, built to one `index.html`.                                  |
| `skill/code-explainer` | The Claude skill: `SKILL.md`, quick, CLI, patch and writing references, worked examples, launcher.       |
| `fixtures/`            | Tiny real repos (a job runner in TS, Python and Go) with committed explainers.                           |
| `docs/`                | Architecture, the original design brief, dated review reports, images.                                   |
| `.explainer/`          | xpl's own explainer (`xpl.explainer.json`), committed; its indexes are git-ignored.                      |
| `AGENTS.md`            | Guidance for coding agents; project skills in `.claude/skills/`.                                         |
| `scripts/`             | Before/after screenshots for a pull request: `needs-screenshots.sh`, `pr-screenshots.sh`, publishing.    |

## Development

```sh
npm install          # dependency install scripts are disabled on purpose, see .npmrc
npm run typecheck    # tsc --noEmit in every package
npm test             # vitest: unit tests of all packages (packages/*/test)
npm run build        # viewer (Vite single file) first, then the CLI bundle
npm run pack -- --pack-destination /tmp         # build and pack the standalone CLI, viewer, grammars and skill
npm run test:install -- /tmp/xpl-install        # install the tarball offline and exercise its CLI and reader
npm run test:e2e     # builds the viewer, then Playwright on fixture bundles made from dist/index.html
XPL_TEST_SCIP=1 npx vitest run packages/indexer/test/scip-integration.test.ts   # real SCIP indexers
npm run format       # prettier --write . (format:check to verify)
```

Workspace packages export their TypeScript sources; vitest, tsx and vite read them directly, so there is no
build step between packages in development. After `npm run build`, `node packages/cli/dist/xpl.mjs __smoke`
(hidden) loads every tree-sitter grammar from `dist/wasm`.

The workspace packages stay private. The build writes standalone npm metadata in `packages/cli/dist`
as `@krimvp/xpl` 0.1.0 under MIT, with a short README and LICENSE and no install dependencies or scripts. `npm run pack` packs that directory,
not the workspace package. `integrity.json` records SHA-256 hashes for bundled files; `doctor` detects
missing or changed files. These hashes detect damage, not the identity of an artifact's publisher.
The install check copies fixture inputs to scratch, denies CLI checkout reads with Node permissions,
and tests TS/Python/Go indexing, local viewing and disconnected HTML reading with pinned Chromium.
It also checks installed service restart/recovery, watch pause/resume and durable job history with
unavailable-runner submission, alongside the published package name, version, license and file inventory.

- The tree-sitter grammars are the `.wasm` files shipped inside their npm packages (versions pinned exactly:
  the wasm ABI has to match `web-tree-sitter`). Use `initParser()` / `loadLanguage()` from
  `packages/indexer/src/wasm.ts`, never `Parser.init()`. `XPL_WASM_DIR` redirects the wasm files.
- Playwright must match the browsers preinstalled in `PLAYWRIGHT_BROWSERS_PATH` (`/opt/pw-browsers` in the
  sandbox), hence `@playwright/test@1.56.1`. Do not run `playwright install` there. The e2e run rewrites the
  screenshots in `packages/viewer/e2e/screenshots/` (git-ignored); the first two images above are copies of
  `dispatch-step-selected-light.png` and `tour-step-2-light.png` in `docs/images/`. The two architecture map
  images are not made by the e2e run.
- `.npmrc` sets `ignore-scripts=true`, so npm also skips `pre*`/`post*` scripts of our own packages.
- Fixture line numbers are load-bearing (anchors, acceptance tests): prettier ignores `fixtures/`.

## Docs

- [AGENTS.md](AGENTS.md): the guide for coding agents working on this repo (commands, invariants, PR rules),
  with project skills in `.claude/skills/`.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how it is built: schema (change records and base anchors
  included), indexer, anchors and patches, CLI (`change`, `draft`, `lint`) and server API, viewer (Read,
  Explore, Present, the diff view), known limitations.
- [docs/handoff.md](docs/handoff.md): the original design brief (schema draft and worked example).
- [docs/review-2026-10-01.md](docs/review-2026-10-01.md): review of four generated explainers (two PRs,
  a whole repo, a subsystem), what that iteration changed, a validation run on an unseen PR, and the
  roadmap.
- [docs/review-2026-10-03-ui.md](docs/review-2026-10-03-ui.md): a UI review of the viewer on the fixture
  bundles (five personas, screenshots at five widths), what was changed, and a second round on the open items.
- [docs/review-2026-10-03-real-runs.md](docs/review-2026-10-03-real-runs.md): the skill, CLI and viewer on
  three unseen projects (ky, itsdangerous, chi) at four levels (system, feature, algorithm, change), with the
  persona reports and authoring logs in [docs/review-2026-10-03-real-runs/](docs/review-2026-10-03-real-runs/).
- [docs/review-2026-10-03-stress.md](docs/review-2026-10-03-stress.md): a stress test on seven large repositories
  (zod, vue, django, sympy, jinja, prometheus, hcl) and on recursive edge cases: accuracy, speed, what was fixed
  and what is still open.
- [docs/assessment-2026-10-04-graph-formats.md](docs/assessment-2026-10-04-graph-formats.md): SCIP, Kythe and
  Joern CPG artifacts of the Go fixture mapped through the provider contract, what each loses, and why only SCIP
  gets an importer; reproducible with the scripts beside it.
- [docs/analysis-2026-09-30.txt](docs/analysis-2026-09-30.txt): an earlier analysis of the project (plain text).
- [skill/code-explainer/](skill/code-explainer/): what Claude reads: `SKILL.md`, `reference/` (the one-page
  quick reference, the CLI, the patch format, the writing rules, the guide for changes, and two worked example
  patches in `examples/`).
