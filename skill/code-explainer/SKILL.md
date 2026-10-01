---
name: code-explainer
description: Generate an interactive code explainer, meaning a short guided tour with linked diagrams (box-and-arrow map, process flow, sequence diagram) next to a code viewer, where clicking a box, arrow or step highlights the exact code and selecting code lights up the matching diagram elements. Use when the user wants to understand how code works ("how does X work", "how does a failed job get retried"), get an architecture overview of a repo, understand or review a change (a PR, MR, branch or commit range, read locally), explore an unfamiliar codebase, or prepare a code walkthrough, demo or presentation. Operations - explain <question> (part of a project), explain repo (architecture), explain change <base>..<head> (a diff), expand (grow a view), make tour (a talk).
---

# Code explainer

You turn a question about code, a whole repo, or a change into an **explainer**: data that a fixed viewer renders as a guided tour with diagrams linked both ways to the code. You never write UI. You write JSON **patches**; the `xpl` CLI checks every claim against a static index and rejects what it cannot resolve.

The reader sees, in this order: the tour title and its **summary**, then the tour steps (each a title, a short note, one picture and the code it is about), then the maps and the code on demand. Write for that order: the most important thing first, then one level of detail at a time.

Workflow: `xpl index` → `xpl new <name>` → choose the scope → read the code → patch the structure and text → `xpl apply` → `validate`, `status`, `anchors` → the tour → `xpl lint`, re-read, small fixes → `xpl bundle` → reply.

## What you are making

- **Index** `.explainer/index-<commit>.json`: symbols, ranges, hashes and reference edges from static analysis, built by `xpl index`.
- **Explainer** `.explainer/<name>.explainer.json`: what you add on top. Written only by `xpl apply`; never edit it by hand (reading it is fine).
- **Tour**: the guide. A `summary` and 5-9 steps. Each step shows one view, focuses one main element, and has a note that starts with `### <plain title>`. One primary tour per request.
- **Views** (the pictures a tour step shows): `graph` (a map: `include` = the boxes), `flow` (stages, decisions and labeled branches) and `sequence` (calls between participants). Add a view only when a tour step uses it.
- **Elements** (everything clickable): _nodes_ (repo, dir, file, symbol come from the index; you add **groups** and overlays with a label or summary), _edges_ (calls come from the index; you add `llm` edges only for links static analysis cannot see), _concepts_ (ideas that cross files), _steps_ of flow and sequence views.
- **Anchor** = file + symbol path + optional `span` (0-based line offsets from the symbol's first line) or `find` text. The CLI turns it into a hash-checked pointer, so it can go stale (`ok`/`moved`/`drifted`/`missing`) but never point at code that is not there.

## Setup

1. **Find the CLI.** It is `bin/xpl` in this skill's directory (shown when the skill loads; else `ls -d ~/.claude/skills/code-explainer .claude/skills/code-explainer`). Below, `xpl` means that path: write it out in full in every command. Run from the root of the repo being explained (or pass `--root <dir>`). If it says "the CLI is not built", tell the user to run `npm install && npm run build` in the xpl repo; nothing works before that.
2. **Index:** `xpl index`. Re-run it when the code changed or a command warns `index ... does not match the working tree`. The per-language line says how far you can trust each edge: `refs: precise` calls are real; `heuristic` references are hints, so confirm each call with `show` before you claim it; `refs: none` (yaml, json, toml, text) has config keys but no references. `--precise off` is fast and heuristic, for a big repo.
3. **Name it:** `xpl new <name> --title "..."` unless `.explainer/<name>.explainer.json` exists. One explainer per repo (repo name, kebab-case); new questions add views and a tour to it. A change gets its own explainer, named and titled after it (`xpl new <repo>-pr-42 --title "PR 42: <what it does>"`): the page title is the explainer title. `--repo <name>` sets the name of the repo box when the detected one is wrong.
4. **Patch files:** write patches outside the repo (scratchpad or `$TMPDIR`); `xpl apply <name> -` reads stdin.

## Choose the scope first

Decide which of the three scopes the request is before you read code, and say it in your reply.

| Request                                                    | Scope                                    | Tour answers                                                      |
| ---------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------- |
| "how does X work", a question about one subsystem          | `explain <question>` (part of a project) | the question, from the entry point to the answer                  |
| "explain this repo", "give me an overview", "architecture" | `explain repo` (whole project)           | what the project is, its parts, the main path through them        |
| a PR, an MR, a branch, a commit range, "my changes"        | `explain change <base>..<head>` (a diff) | what changes for users, where, who else is affected, tests, risks |

If the request can mean two materially different things (which service, which layer, which branch to compare with), ask one short question with concrete options. Otherwise proceed and state your assumption in the reply.

## Reading the code

- `xpl outline [--under <id>] [--depth n] [--kind method,function] [--keys]`: dirs, files and symbols with ids, lines and fan-in/out (`in=`/`out=` find the hubs); `--keys` lists config keys.
- `xpl search <text> [--regex] [-i] [--under <dir|glob>] [--code]`: a word, config key, route or error string, code hits first. Each hit shows the enclosing symbol id and `+offset`.
- `xpl show <id> [--refs]`: code as `<line> <offset>│ code`; `--refs` adds outgoing refs and callers, each with `+offset`.
- `xpl refs <id> [--in|--out] [--kind call] [--depth n]`: what this calls, or who calls this. `impl` lines hop through interfaces (`--tests`: test doubles).

Paste ids exactly as printed (`sym:internal/runner/runner.go#Runner.Dispatch`, `file:...`). `+34..36` in the output is a span: `{"from": 34, "to": 36}`. Full options: `reference/cli.md` (look up one command there; do not read it all).

`refs <field> --in --kind read` lists who reads a config switch. TS `describe`/`it`/`test` blocks are symbols named by their titles: anchor a test with `symbol: "<that path>"`, role `test`.

Tracing traps:

- An interface method (a bodiless declaration, e.g. Go `JobQueue.Requeue`) has no outgoing refs: `refs --out` lists its implementations as `impl sym:...` lines. Read and anchor the `impl` that does the work. (Python base classes and TS abstract classes are `extends`: no hop.)
- A `call` ref to a type is a construction (`new X()`), so a derived `calls` edge may stand for "creates", not for a call on the path you explain: check it with `show`, then hide or relabel it. A `call` ref to a variable or field is a call through a function value: anchor the field as `usage`, and the concrete function when it is in the repo (`refs <field> --in`).
- `refs --in` finds no caller for a method reached through a variable or attribute: `await response(scope, receive, send)` calls `__call__`, `handler(job)` calls whatever was stored. Find the callers with `search` for the variable or attribute name, or from where the object is built (`refs <class> --in`); read them, and anchor the calling line as `call-site`.
- A call that resolves to a base-class method with no real body (`raise NotImplementedError`, an abstract method) runs a subclass method at runtime. Read the subclass method that runs, anchor it, and link the two with an `llm` `calls` edge: static analysis cannot see that call.
- Calls into dependencies outside the repo are not indexed: anchor the call site, name the dependency, claim nothing about the library.
- Static analysis misses event buses, DI wiring, callbacks registered elsewhere, HTTP handlers, queues and config keys read by name: `search` for `emit`, `publish`, `on(`, `register` and the topic, route or key strings. Link what you find with an `llm` edge, anchored at both ends.
- Stay at `--depth 1` on a hub: `--depth 2` prints pages of plumbing. Stop when the question is answered.

## explain <question>: part of a project

1. **Entry points.** `search -i` the nouns and verbs of the question (retry, fail, requeue, timeout); `outline --depth 2` for the shape. Pick the function where the flow starts or the decision is made.
2. **Trace.** `show <entry> --refs`, read the body, then follow the callees that matter with `show` and `refs <id> --out --kind call`. Note every guard on the path (`if`, `match`, early `return`, type checks): the prose names the condition of each branch it describes.
3. **Boundary** (what to anchor around the answer): the target code, its direct callers (`refs <id> --in`), the callees that change the answer, and the tests that pin the behaviour (`refs <id> --in` lines in test files, `search --under 'tests/**'`). A reader of the bundle checks claims against these files.
4. **Model** (keep it small):
   - one **map** (graph, 4-8 boxes) of the files or symbols involved; groups only where one box should stand for several files;
   - one process view per part of the question; a question with two halves ("how does a request get in, and how does an error get out") gets two, each used by the tour. A **flow** when the code makes decisions: `shape` and labeled `next` branches, loops and failure paths explicit, never reading order presented as an execution path. A **sequence** when the point is who calls whom: 3-6 participants (entry symbol first), one step per call that matters, `return` steps only where the result drives a branch, frames over loops and branches. More than 6 participants means two views;
   - 0-3 **concepts**, only for ideas that cross files (a retry policy, a lookup order);
   - `llm` edges only for links static analysis cannot see. For files that code loads by name (config, plugins), anchor the config keys and use `loads`, `discovers`, `configures` or `overrides` edges (`patch-format.md` 3.7); a matching file name does not prove that it is loaded, and file names or reading order do not prove precedence;
   - summaries for everything the views show.
5. **Tour** (see "The tour"): summary; the big picture on the map; the main path, step by step; the details that change the outcome; edge cases and open questions last.
6. Write, apply, check and show it (below). The reply answers the question, naming the key functions: the explainer is the evidence, not a replacement for the answer.

## explain repo: the whole project

1. **What it is.** Read the README and the package metadata (`xpl show file:README.md`, `outline --keys` on `pyproject.toml`, `package.json`, `go.mod`): language, kind (web framework, CLI tool, library, service), what it is for. The tour summary starts with this.
2. **Parts.** `outline --depth 1`, then `--depth 2` (`--under dir:<x>` for big trees). Find the packages, layers, entry points (`main`, `cmd/`, servers, CLI dispatch), config, tests, docs.
3. **Overview map** `view:overview`: 4-8 boxes, one per responsibility; use the top-level dirs or packages, or files when the repo is one package (in a `src/<pkg>/` layout start at `dir:src/<pkg>`, not `dir:src`). Use groups (`grp:<slug>` + `members`) where one responsibility spans several files or folders. Give each box a one-line `summary` and nothing deeper. Follow "Maps" below (`excludeFiles`, stubs, hidden edges).
4. **Main path.** If there is an obvious entry point, add one flow or sequence view for the main path (startup or request path), 4-8 steps. No obvious entry point: skip it.
5. **Tour:** summary (what the project is, what it is for, the main path in one sentence); the overview; the main path; then each remaining box of the overview in one step, or one step that lists the boxes it skips and why. Every overview box is visited or named as skipped. Define the project's central term (a plugin, a job, a middleware) in the first step that needs it.
6. Leave deeper nodes unexplained (lazy). Tell the user, and offer the 2-3 most useful expansions.

## explain change <base>..<head>: a PR, an MR or a branch diff

Follow `reference/explain-change.md`. It holds the rules for this scope: what you may run and fetch, checking "before" claims in the base code, who else is affected, tests and gaps, risks, and the review-order tour. The explainer describes the head, the code the index sees.

## The tour

One primary tour per request: `tour:<slug>`, 5-9 steps (up to 12 for a change), read top-down like a zoom (big picture → main path → details → edge cases).

- **`summary`** (2-4 sentences, always): what this is and why it matters; `reference/writing.md` section 4 says what goes in it for each scope.
- **`title`**: plain, about 8 words, the question or the topic ("How a failed job is retried"); for a change, the change ("PR 42: config rejects invalid retry delays").
- **Order:** the first step shows the big picture (the map). Then the main path in execution order. Then the details that change the outcome. Edge cases, gotchas and open questions come last. A whole-repo tour visits every overview box or says which it skips.
- **Each step** `{"id": "t1", "view": "view:...", "focus": [ids], "note": "...", "code": [...]}`:
  - `focus`: one main element (a box, a flow or sequence step, an edge), plus at most one concept that explains it. A flow or sequence step in `focus` must belong to the tour step's `view`.
  - `note`: starts with `### <plain title>`, then 1-4 sentences that say what no summary says (`reference/writing.md` sections 1 and 3).
  - `code`: an override with **at most 2 ranges**, and the range the note talks about first comes first. Give it on every step (a group, file or directory focus otherwise shows whole files). `editor.primary` names the file of that first range.
- **Ids:** step ids `t1`, `t2`... are unique in the tour and never renumbered (insert with the next free number where it belongs). A tour the user edited (`title`, `summary`, `steps`) is theirs: an `llm` patch that resends those fields is skipped (`protected` warning) and the tour cannot be removed. Make a new tour (new slug) or ask.

## Writing

Read `reference/writing.md` before you write prose. It is the one place for the writing rules: which field holds what, which fields are markdown, sentence length, titles and labels, the tour summary, rewrites, and the re-read checklist. `xpl lint` checks the mechanical part.

## Accuracy

The viewer shows every claim next to the code it anchors, so a wrong claim looks checked. Before you apply, re-read every title, label, summary, `detail` and note against the `show` output of its anchors:

- Delete behaviour that is not visible in the anchored code (what a callee does elsewhere, paths you did not read, why the author chose it). What you cannot check, leave out, and say so in the reply.
- **Guard conditions:** when the anchored lines run only under a condition, the text names it ("when `metrics.enabled` is true", "for HTTP requests"). Anchor the condition too. When the same guard matters in a step's summary and its note, the note says what the guard means for the reader instead of repeating it.
- **Absolute words and claims about all sites** (all, every, never, only, "the same everywhere") need proof in the anchored code; "every caller" needs `refs <id> --in` evidence and an anchor for each site. Otherwise name the sites or narrow the claim.
- **Lists** read as complete: check that they are, or write "for example".
- **Code, not folklore:** describe what the code does, not what a spec or the framework's reputation says ("stops waiting after the timeout", not "kills the job", when the code only races a timer).
- **Changes:** "before" claims and test claims follow `reference/explain-change.md` sections 4 and 6.

## Boundary and bundle

The bundle is what the reader can check claims against. Anchor the target code, its direct callers, the callees that matter and the tests.

- `--files boundary` (use it for changes and questions): the referenced files, plus the files of the direct callers and callees of each anchored symbol, plus the test files that reference those symbols. Only anchors with a `symbol` outside test files count: anchor the target symbols, and anchor context code you only show with a file-relative `span` (no `symbol`) so it does not widen the boundary. At most 40 files are added (`--boundary-max`).
- `--files all` when the reader will browse a small repo; `--files referenced` (the CLI default) for only what the explainer references.

## Maps

A map must be readable at a glance:

- 4-8 boxes, one per responsibility; group the rest or leave it out.
- `"stubs": {"mode": "none"}` on every **graph** view a tour uses (flow and sequence views have no `stubs` field); ghosts and stubs are for exploring, not for reading.
- `"excludeFiles": ["**/*_test.go", "**/test/**", "**/tests/**", "**/*.test.*", "**/test_*.py", "**/examples/**", "docs/**", "benchmarks/**"]` on overviews: tests, examples and docs add edges that are not the design. (A change map shows its changed test files on purpose, as one group box when there are several.)
- Check the edges that remain (`refs <dir> --out`, `status --json`) and put noisy or misleading derived edges in `hidden`.
- A view `title` says what the picture shows, in plain words.

## Write, apply, check

1. **First patch: the structure and the text** (overlays, edges, concepts, views, summaries). Write the tour last, once these have settled (see "Change one thing cheaply" for why). Imitate `reference/examples/go-retry.patch.json` (a question) or `reference/examples/py-overview.patch.json` (a repo). In `reference/patch-format.md` read only what the task needs: section 1 (anchors) and 2 (ids) always; 3.6 graph, 3.7 flow or 3.8 sequence for the views you write; 3.9 for the tour; 3.1-3.5 when you add groups, overlays, edges or concepts. Sections 4-8 (merge rules, provenance, output, rejections, repair) are for when a command points you there. Anchoring:
   - A step's anchors are the exact call or condition in the **caller** (`role: "call-site"`) plus the callee's **definition** (`role: "definition"`, whole symbol).
   - `find` (text copied from `show`, unique inside that symbol) anchors exactly the lines it touches and checks itself: use it for one-line calls. For a block or a multi-line call use `span` with the `+a..b` printed by `show --refs`/`refs`, or the offsets from `show`.
   - Concept anchors: the deciding lines, not the whole function; config as `symbol: "<key path>"` (`retry.maxRetries`); tests as a test symbol, a span, or the test file.
   - Summaries: 1-2 sentences, concrete, about this code ("requeues with `baseDelay * 2^attempt`, capped at `maxDelay`"), never generic ("handles retries"). Conditions and long lists go in `detail`.
2. **Apply:** `xpl apply <name> patch.json` (`--dry-run` checks without writing). A rejection writes nothing and lists **every** error at once, with `Did you mean: ...` and ready-to-use anchor fields: fix them all and apply again. Fix a `span ... probably off by one` warning now. Never weaken a claim to get past validation (dropping an `llm` edge's second anchor, anchoring a whole file instead of the call): what you cannot anchor you cannot claim. A `protected` warning means user-owned content was left alone: use a new view, `includeAdd`, or ask the user.
3. **Check:** `xpl validate <name>`; `xpl status <name>` until `to do: 0 unexplained` (the participants of flow and sequence views count too); `xpl anchors <name> tour:<slug>` shows the code each tour step will show, and `xpl anchors <name> <id>` checks a `span` anchor. Expect 1-3 small follow-up patches after `status` and `xpl lint`: send only what changes (see "Change one thing cheaply"). To resend a tour you may read it back from the explainer JSON (reading is fine; never edit the file).

## Final checks before you show it

1. `xpl lint <name>`: the mechanical writing checks (`reference/writing.md`, section 6). Fix every finding, or say in the reply why you kept it.
2. Re-read the tour in order as a newcomer would, with the checklist in `reference/writing.md` section 6.
3. For a change: re-check each before/after claim and each test claim (`reference/explain-change.md`).

## Show the result

- `xpl bundle <name> -o <name>.html --files boundary`: one self-contained HTML file (viewer, index, sources) that works offline. **The default in remote or cloud sessions** and wherever no local browser exists: give the user the path. Attach or publish it only when the user asked for that: it contains their source code. `--mode present --tour tour:<slug>` starts the tour as a presentation.
- `xpl view <name>`: a local live server for a user at the machine who will keep iterating (their edits are saved, "Explain this" clicks are queued). Start it in the background; stop it when they are done.
- **The reply** (the one rule for it): first the answer in 3-6 sentences (for a change: the behaviour change, then the risk). Then short lists, one line per item: the scope and any assumption; for a change, the changed files with `+/-` counts; what you checked by running code; what you left out or could not check; the bundle path, what it embeds and what it does not. Say that `.explainer/` was written into the repo. Do not retell the tour.

## Change one thing cheaply

To change one thing, patch only that element; never regenerate the explainer.

- One element's text: send `{id, summary}` (other fields stay).
- One step of a flow or sequence: `stepsUpdate` with that step alone (`[{"id": "retry:4", "summary": "...", "anchors": [...]}]`); the other steps stay.
- A box on a map: `includeAdd` / `includeRemove` on the graph view.
- A tour: resend that one tour (`id`, and the fields that change). Tours have no `stepsUpdate`: one changed note means resending all its `steps`, which is why the tour comes last.

## expand <node>

`<node>` is an id or name from the user, a ghost or stub they clicked (`ghost:dir:internal/bus` means `dir:internal/bus`, `ghost:file:x` means `file:x`), or an entry of the request queue.

1. Resolve it to an id (`outline`, `search`) and read it: `show <id> --refs`, `outline --under <id> --depth 1` for its children (a group opens into its `members`).
2. **Drill in:** patch the graph view with `"includeAdd": ["<id>", ...the children worth showing]` (appended to `include`). A node whose children are also included renders as a container. `includeAdd` works even when the user curated the view's `include`; `includeRemove` is then skipped (`protected`), so ask the user to take nodes out. A user-authored view (`origin: "user"`) takes no `llm` edit: use a new view (new slug). A folded ghost (`ghost:rest:file:<path>`, `ghost:more:out`) is not an element: `status` names the elements it stands for; `includeAdd` those, or `file:<path>` (`patch-format.md`, "Crowded views").
3. **Explain what became visible:** `status <name>` names the new unexplained nodes; add overlays with a `summary` for those and only those.
4. A step gets a better `summary` with `stepsUpdate`; a concept gets `summary`/`detail`; a derived edge `edge:calls:<a>-><b>` gets an overlay with `label`, `summary` and anchors at both ends. Derived edge ids depend on what the view includes: write the overlay after the `include` edit, with the id from `status --json` (`views[].edges.unexplained`).
5. **Drain the queue:** `status` prints `requests queued by the viewer` ("Explain this" in `xpl view`). Do 1-4 for each, then `rm .explainer/requests.json` and tell the user what you added.

## make tour

For a talk built from views that exist. Use the rules of "The tour": a summary, 5-9 steps top-down, a `### title` on every note, at most 2 code ranges per step, edge cases last. Default views: the newest question's views plus the overview; ask which when there are several. Check with `xpl anchors <name> tour:<slug>` that each step shows the code its note is about, then `xpl bundle <name> -o <file>.html --tour tour:<slug>` (opens as a presentation; arrow keys step through).

## After the code changed

1. `xpl index`, then `xpl resolve <name> --write`: re-resolves every anchor (ok / moved / drifted / missing) and rewrites moved spans.
2. `xpl status <name>` is the to-do list: drifted llm elements, missing anchors, **broken references** (ids that vanished from the index) and stale derived-edge overlays.
3. **Drifted llm elements:** re-read the code (`xpl anchors <name> <id>`), then resend their anchors (without `hash`; for a step, a `stepsUpdate` entry: `reference/patch-format.md` section 8) and any summary or note that depended on them. Never change a field listed in `userFields`; never touch `origin: "user"` elements.
4. **Broken references:** `includeRemove` drops a stale `include` entry; resend `members` / `participants` / `steps` (a tour: its `steps`) without the gone id, or `remove` the overlay.
5. **Missing anchors** (symbol gone or renamed): report each to the user (element, anchor, the `did you mean` hint) and ask: re-anchor or remove. Never drop one silently or retarget it to something merely similar.
6. `xpl validate <name>` (strict) must pass before you finish; `--lenient` is only for inspecting a half-repaired file.

## Hard rules

1. **You cannot invent code.** Every anchor must resolve against the index or `apply` rejects the patch. Never write hashes. Never write line numbers or offsets from memory: copy them from `show`/`refs`/`search` output of this session, or use `find`.
2. **Read before you claim.** Never summarise code you have not `show`n. A ref is a hint until you have seen the call. For a change, never describe old behaviour you have not read in the base code.
3. **Read-only on the user's repo and remotes.** Never post, comment, push or change the user's checkout.
4. **`llm` edges only for what static analysis cannot see** (event buses, DI, calls through a base-class stub), each with anchors at both ends. Calls, imports and inheritance that the index has are derived by the viewer: do not store them again (to label one, use a derived-edge overlay).
5. **Stable ids.** Slugs (`grp:`, `concept:`, `edge:`, `view:`, `tour:`, `frame:`) are chosen once (lowercase kebab-case) and kept. Step ids `<view-slug>:<n>` are never renumbered or reused.
6. **Provenance.** Use the default actor (`llm`). Never overwrite `origin: "user"` elements or `userFields` (views and tours included); `--actor user` only when the user dictates text to be stored as theirs.
7. **One primary tour, few things at the same level.** Views only when a tour step uses them; 0-3 concepts; groups only as map boxes.
8. **Lazy.** Explain what a view shows; leave the rest for `expand`.
9. **Ask, do not guess** when the scope is ambiguous or an anchor cannot be found.

## Gotchas

- An anchor's `symbol` is the path inside the file (`Runner.Dispatch`). Element ids (`from`, `to`, `include`, `participants`, `members`, `focus`) use `sym:<file>#<path>`; `scope.entryPoints` uses `<file>#<path>`.
- Every step's `from`/`to` must be in the view's `participants`. Changing participants means resending the steps.
- `steps`, `participants`, `include`, `members`, `anchors` replace wholesale: always resend the full list, except with `includeAdd` / `includeRemove` (graph views) and `stepsUpdate` (flow and sequence views).
- `dir:`/`file:`/`sym:` overlays need only `id` + `summary`. Ghost and stub ids only go in a view's `hidden`.
- An `llm` edge takes `kind` `calls` (interface/DI/HTTP call), `emits` (event bus, queue), `reads` (config or string-keyed lookup), `loads`, `discovers`, `configures`, `overrides` or `custom`. A derived-edge overlay (`edge:calls:...`) is still an `llm` edge: anchors at both ends and a `label`.

## Reference

- `reference/writing.md`: writing rules, what goes in which field, titles, the tour summary, rewrites, the checklist. Read it before you write prose.
- `reference/explain-change.md`: the PR/MR/branch guide. Read it for `explain change`.
- `reference/patch-format.md`: templates per element (read the sections "Write, apply, check" names), merge rules, provenance, rejection messages, repair. `xpl apply --help` prints a summary.
- `reference/cli.md`: every command and option; look up the one you need.
- `reference/examples/go-retry.patch.json`: a complete patch for a question (map, flow, concept, `llm` edges, tour with a summary); applies to `fixtures/go-jobrunner`.
- `reference/examples/py-overview.patch.json`: an `explain repo` patch (groups, one-line summaries, overview map, event-bus edge, startup sequence, tour); applies to `fixtures/py-jobrunner`.
