---
name: code-explainer
description: Generate an interactive code explainer, meaning linked diagrams (box-and-arrow graph, sequence diagram) and a concept list next to a code viewer, where clicking a box, arrow, step or concept highlights the exact code and selecting code lights up the matching diagram elements. Use when the user wants to understand how code works ("how does X work", "how does a failed job get retried"), get an architecture overview of a repo, explore an unfamiliar codebase, or prepare a code walkthrough, demo or presentation. Three operations - explain (a question, or the whole repo) creates views, expand (a node or stub) grows a view and explains what became visible, make tour turns views into a presentation.
---

# Code explainer

You turn a question about code, or a whole repo, into an **explainer**: data that a fixed viewer renders as diagrams linked both ways to the code. You never write UI. You write JSON **patches**; the `xpl` CLI checks every claim against a static index and rejects what it cannot resolve.

Workflow at a glance: `xpl index` → `xpl new <name>` → read the code (`outline`, `search`, `show`, `refs`) → write one patch → `xpl apply` (fix and repeat until clean) → `xpl validate` + `xpl status` + `xpl anchors` → `xpl bundle` or `xpl view`.

## What you are making

- **Index** `.explainer/index-<commit>.json`: symbols, ranges, hashes and reference edges from static analysis. Built by `xpl index`.
- **Explainer** `.explainer/<name>.explainer.json`: what you add on top. Written only by `xpl apply`; never edit it by hand (reading it is fine).
- **Elements** (everything clickable): _nodes_ (repo, dir, file, symbol come from the index; you add **groups** and overlays that attach a label or summary), _edges_ (calls come from the index; you add `llm` edges only for links static analysis cannot see), _concepts_ (cross-cutting ideas), _sequence steps_.
- **Views**: `graph` (`include` = the nodes shown) and `sequence` (participants, steps, frames). **Tours**: ordered focus states for presenting.
- **Anchor** = file + symbol path + optional `span` (0-based line offsets from the symbol's first line) or `find` text. The CLI turns it into a hash-checked pointer, so it can go stale (`ok`/`moved`/`drifted`/`missing`) but never point at code that is not there.
- **Viewer**: click any element and the editor shows its anchored code (the rest dimmed); select code and the elements covering it light up.

## Setup

1. **Find the CLI.** It is `bin/xpl` in this skill's directory (shown when the skill loads; else `ls -d ~/.claude/skills/code-explainer .claude/skills/code-explainer`). Below, `xpl` means that path: write it out in full in every command, shell variables may not survive between commands. Run from the root of the repo being explained (or pass `--root <dir>`). If it says "the CLI is not built", tell the user to run `npm install && npm run build` in the xpl repo (the message names the path); nothing works before that.
2. **Index:** `xpl index` (`--precise auto` is the default). Re-run it whenever the code changed or a command warns `index ... does not match the working tree`. The per-language line is the trust level of every edge you will use:
   - `refs: precise (scip-...)`: a compiler-grade indexer resolved the references. Listed calls are real; you still choose which ones answer the question.
   - `refs: precise 64/82 (scip-python@0.6.6), 18 heuristic`: the tool described only 64 of the 82 files (build constraints, its own exclusions; a warning names them). The references of those 18 files are hints: confirm them with `show`.
   - `refs: heuristic`: scope-aware guesses (a warning says why SCIP was unavailable). Treat refs as hints: confirm each call with `show` before you claim it.
   - `refs: none`: yaml/json/toml/text. They have symbols (config keys, e.g. `pyproject.toml#project.scripts.flask`) but no references.
   - A `warning: N file(s) have syntax errors; symbols near these lines may be incomplete: a.ts:12,40` names the lines: read the code there yourself before you rely on the outline.
   - `--precise require` fails instead of falling back (use it when the user needs the exact call graph); `--precise off` skips SCIP for a fast, heuristic index on a big repo.
3. **Name it:** `xpl new <name> --title "..."` unless `.explainer/<name>.explainer.json` exists. One explainer per repo (repo name, kebab-case); new questions add views to it. The repository name it records (the label of the repo box) is detected from `package.json`, `go.mod`, `pyproject.toml`, the git remote or the directory; pass `--repo <name>` (and `--url <url>`) to set it.
4. **Patch files:** write patches outside the repo (scratchpad or `$TMPDIR`) so you can fix and re-apply; `xpl apply <name> -` reads stdin.

## Reading the code

- `xpl outline [--under <id>] [--depth n] [--kind method,function] [--keys]`: dirs, files and symbols with ids, lines and fan-in/out (`in=`/`out=` find the hubs). `--kind` keeps only those symbol kinds (and what holds them); `--keys` lists config keys (yaml, json, toml).
- `xpl search <text> [--regex] [-i] [--under <dir|glob>] [--code]`: a word, config key, topic, route or error string. Code hits come first, then config, then docs; `--under src/x/` or `--under 'tests/**'` scopes it, `--code` drops docs and config. Each hit shows the enclosing symbol id and `+offset`.
- `xpl show <id> [--refs]`: code as `<line> <offset>│ code`; `--refs` adds outgoing refs and callers, each with `+offset`.
- `xpl refs <id> [--in|--out] [--kind call] [--depth n] [--max-children n]`: call hierarchy, what this calls / who calls this. `impl` lines hop through interfaces (`--tests`: test doubles). In a hierarchy (`--depth 2` or more) at most `--max-children` (15) lines are listed under each line (`... +9 more`), and a subtree already printed is marked `(expanded above)`.

Paste ids exactly as printed (`sym:internal/runner/runner.go#Runner.Dispatch`, `file:...`, `dir:...`). `+34..36` in the output is a span: `{"from": 34, "to": 36}`. Full options and sample output: `reference/cli.md`. Once an explainer exists, `xpl anchors <name> [ids]` prints what its anchors resolved to (below, "Check").

What the index knows besides calls: `read` refs (a variable, constant or typed field used but not called: `refs <field> --in --kind read` lists who reads a config switch; `show --refs` lists reads after the calls; graph views hide `reads` edges by default), `write` refs, and type uses. `imports` are runtime dependencies: a TS `import type` or a Python `TYPE_CHECKING` import is a `type-ref`, so type-level dependencies show as `references`. TS `describe`/`it`/`test` blocks are symbols named by their titles (`Queue.pop().returns the oldest job`: anchor a test with `symbol: "<that path>"`, role `test`).

## explain <question>

1. **Scope.** If the question can mean two materially different things (which service, which layer, retry of what), ask one short question with concrete options. Otherwise proceed and state your assumption in the reply.
2. **Entry points.** `search -i` the nouns and verbs of the question (retry, fail, requeue, timeout); `outline --depth 2` for the shape. Pick the function where the flow starts or the decision is made.
3. **Trace.** `show <entry> --refs`, read the body, then follow the callees that matter with `show` and `refs <id> --out --kind call`. Stay at depth 1 and read each callee you need with `show`: `--depth 2` on a hub (something many others call, a big dispatcher) prints pages of plumbing. Stop when the question is answered; skip logging, metrics and plumbing that do not change the answer. Traps:
   - A callee that is an interface method (a bodiless declaration, e.g. Go `JobQueue.Requeue`) has no outgoing refs, so `refs --out` hops through it: under the call it lists the implementations as `impl  sym:...` lines (test doubles are hidden and counted, `--tests` shows them; `--depth 2` expands the implementation itself). Read the `impl` that does the work and anchor the step's definition there. `refs <implementation> --in` goes the other way: the interface method it implements, with that method's callers. (Python base classes and TS abstract classes are `extends`, not `implements`: no hop.)
   - A `call` ref to a type is a construction (`Result{...}`, `new X()`), not a function call.
   - A `call` ref whose target is a variable or field (`call  sym:src/runner.ts#Runner.logger`) is a call through a function value: a callback, hook or handler held in a field. Anchor the field as `usage`, and the concrete implementation too when it is in the repo (who assigns the field: `refs <field> --in`, `search`); when it is not, say in the summary who supplies the function.
   - Calls into dependencies (packages outside the repo) are not indexed. Anchor the call site only and name the dependency in the summary; claim nothing about what the library does beyond what the call site shows.
4. **Find what static analysis misses:** event bus, DI and interface wiring (who passes the concrete class in), callbacks registered in another file, HTTP handlers, queues, topics, config keys read by name (`search` for `emit`, `publish`, `subscribe`, `on(`, `Handle`, `register`, topic/route/key strings; `outline --under file:config/x.yaml --keys`; a typed config field has readers: `refs <field> --in --kind read`, while the yaml/toml key itself has no references). Tests that pin the behaviour (`refs <id> --in`, `search --under 'test/**'`).
5. **Decide the model** before writing:
   - _sequence view_: 3-6 participants (entry symbol first, then the types/files it talks to; a class or file as the lifeline, the method as the definition anchor); more than 6 participants means several views, one per phase or group of collaborators; one step per call that matters, in execution order; `return` steps only where the result drives a branch; frames (`loop`, `alt`, `opt`, `par`) over the steps inside a loop or branch, one `alt` frame per arm.
   - _graph view_: the 5-15 files/symbols involved; clusters that cross folders become **groups**.
   - _concepts_: the cross-cutting ideas (retry policy, delayed redelivery) anchored to the implementing code, the config keys and the tests.
   - _llm edges_: only for the links found in step 4, each with anchors at both ends.
   - _summaries_ for everything the views show (every participant, step, box, group, concept): 1-2 sentences, concrete, about this code ("requeues with `baseDelay * 2^attempt`, capped at `maxDelay`"), never generic ("handles retries").
6. **Write ONE patch** with all of it. Read `reference/patch-format.md` first (a template for every element) and imitate `reference/examples/go-retry.patch.json`. Key rules:
   - A step's anchors are the exact call in the **caller** (`role: "call-site"`) plus the callee's **definition** (`role: "definition"`, whole symbol).
   - `find` (text copied from `show`, unique inside that symbol) anchors exactly the lines the text touches and checks itself: use it for one-line calls. For a block or a multi-line call use `span` with the `+a..b` printed by `show --refs`/`refs` or the offsets from `show`.
   - Concept anchors: span/find the deciding lines, not the whole function; config as `symbol: "<key path>"` (`retry.maxRetries`); tests as a test symbol, a span, or the test file.
   - Step `label` = call text (`Requeue(job, backoff)`); `summary` = what happens and why.
7. **Re-read your prose against the code (mandatory, before you apply).** Wrong prose is the main quality risk: the viewer shows every summary next to the code it anchors, so a claim the code does not back is on display. For each summary, `detail` and tour note (steps, boxes, groups, concepts, edges) open the `show` output of its anchors and check every sentence against it. Remove or qualify absolute words (only, never, all, always, every, nothing but, exactly) unless that code alone proves them, and delete any behaviour that is not visible in the anchored code (what a callee does elsewhere, what happens on paths you did not read, why the author chose it). Prefer "when X, it does Y" to general statements.
8. **Apply:** `xpl apply <name> patch.json`. A rejection writes nothing and lists **every** error of the patch at once (path, message, `Did you mean: ...` for ids, ready-to-use anchor fields for symbols): fix the **patch** for all of them, apply again. A warning `span ... starts on a blank line: probably off by one` names the offset where the code starts: fix that anchor now. Results and rejections print on stdout; fatal errors (`error: ...`: bad JSON, unknown explainer) and `warning:` lines go to stderr. Never weaken a claim to get past validation (dropping an llm edge's second anchor, anchoring a whole file instead of the call, deleting a step). What you cannot anchor you cannot claim: leave it out and tell the user. Read the result too: `changed:` must list what you meant to change (after a `stepsUpdate` it names the view and each updated step). A `protected` warning means user-owned content was left untouched: when that is _all_ the patch did, `apply` exits 1 and names the protected ids (use a new view, `includeAdd`, or ask the user); when only part of it was skipped the exit code stays 0 and the last line of the output lists what was skipped.
9. **Check:** `xpl validate <name>`, then `xpl status <name>`: it lists what the views show without a summary (with the ids of the unexplained edges), where each graph view stops (`ghosts:`) and the tours; fill any summaries that remain with a second patch until `to do: 0 unexplained`. Then `xpl anchors <name> [ids]` (no ids: every element with anchors): for each anchor it prints role, `file#symbol`, span, status, the resolved lines and the code at them as `<line> <offset>│ code` (a long anchor shows its first lines, a `... N lines elided` line and its last lines, so the end of a span can be checked too). Read it for every `span` anchor and confirm it landed on the code you meant; anything wrong is fixed with a patch that resends the anchor (`find` or the offsets shown). Do not read the explainer JSON for this.
10. **Show it** (below), and answer the question in your reply in 3-6 sentences naming the key functions. The explainer is the evidence, not a replacement for the answer.

## explain repo

Coarse first, lazy after.

1. `outline --depth 1`, then `--depth 2` (`--under dir:<x>` for big trees). Find the packages/services/layers, entry points (`main`, `cmd/`, servers, CLI dispatch), config, tests, docs.
2. Choose 4-10 boxes: top-level dirs/packages; when the repo is one package (depth 1 gives fewer than 4 boxes) use its files. In a `src/<pkg>/` layout start at `dir:src/<pkg>`, not `dir:src` (that is one box for everything). Cluster with **groups** (`grp:<slug>` + `members`) where one responsibility spans several files or folders.
3. One patch (imitate `reference/examples/py-overview.patch.json`): the groups; overlays (`dir:`/`file:`/`grp:`) with a one-line `summary` for **each box the view shows and nothing deeper**; a graph view `view:overview` with `scope: {root: "repo", depth: 1}` (or 2) and `include` = those boxes and their group ids (add `"edgeKinds": ["imports", "calls"]` when package dependencies are the point); `llm` edges for links static analysis cannot see (event bus, DI); 1-3 concepts only if an idea is central to the design.
   Tests, examples and docs add edges to their package (`internal/runner -> bus` exists only through `retry_test.go`) and ghosts that are not the design: give every overview `"excludeFiles": ["**/*_test.go", "**/test/**", "**/tests/**", "**/*.test.*", "**/test_*.py", "**/examples/**", "docs/**"]` (globs on repo paths; derived edges and stubs then ignore every reference that starts or ends in such a file; nodes you include stay). Check the edges that remain with `refs <dir> --out` and put any still-misleading derived edge ids (from `status --json`) in the view's `hidden`. `status` also prints each view's ghosts and stubs and warns above 12: a view that stops in that many places is unreadable (see `expand`).
4. If there is an obvious entry point, add one sequence view for the main flow (startup or request path), 4-8 steps, anchored as above, participants explained. No obvious entry point: skip it.
5. Leave deeper nodes unexplained (lazy). Tell the user, and offer the 2-3 most useful expansions.

## expand <node>

`<node>` is an id or name from the user, a ghost/stub they clicked (`ghost:dir:internal/bus` means `dir:internal/bus`, `ghost:file:x` means `file:x`; folded ghosts: see step 2), or an entry of the request queue.

1. Resolve it to an id (`outline`, `search`) and read it: `show <id> --refs`, `outline --under <id> --depth 1` for its children (a group opens into its `members`).
2. **Drill in:** patch the graph view with `"includeAdd": ["<id>", ...the children worth showing]`: the ids are appended to the view's `include` (already-included ones are ignored), so there is no list to resend. A node whose children are also included renders as a container. A stub's ghost target is added the same way. `includeAdd` also works when the user curated the view's `include` (it only adds); `includeRemove` (and a whole `include`) is skipped there with a `protected` warning, so to take nodes out of such a view tell the user. Only a user-authored view (`origin: "user"`) rejects every edit: put the nodes in a new graph view (new slug) and say so.
   - **Folded ghosts (crowded views).** By default (`"stubs": {"mode": "top", "max": 8}`) a graph view draws only the 8 ghosts most references lead to: the outside symbols of a file the view shows in part fold into `ghost:rest:file:<path>` ("rest of <file>"), the ghosts beyond 8 into `ghost:more:in` / `ghost:more:out` ("+N more"). A folded ghost is not an element, so it cannot be `includeAdd`ed: `status` prints what each one stands for under its `ghosts:` line, up to 3 element ids with their reference counts (`ghost:rest:file:command.go ×27 → sym:command.go#Command.Flags ×9, ...`), and `status --json` (`views[].ghosts.list[].targets`) lists them all. The viewer's menu and `outline --under file:<path>` / `refs <shown id> --out` show the same from elsewhere. Add the elements worth showing with `includeAdd`, or `file:<path>` for the whole file as one box. `"mode": "all"` only for a small view, `"none"` for no stubs, `hidden` for ghost and stub ids you do not need (`status --json`: `ghosts.list[].id`, `ghosts.stubIds`); `status` prints each view's ghosts and stubs and warns above 12. An arrow from a box to its own container is never drawn.
3. **Explain what became visible:** `status <name>` names the new unexplained nodes; add overlays with a `summary` for those and only those.
4. If the target is a step, edge or concept: a step gets a better `summary` (`stepsUpdate` with that step alone, the other steps stay; steps have no `detail`, put the longer answer in your reply); a concept gets `summary`/`detail`; a derived edge `edge:calls:<a>-><b>` gets an overlay with `label`, `summary` and anchors at both ends. Derived edge ids depend on what the view includes (drilling into a file changes `...->file:x.go` into `...->sym:x.go#Type`): do this after the `include` edit and take the current id from `status --json` (`views[].edges.unexplained`).
5. **Drain the queue:** `status` prints `requests queued by the viewer` (from `.explainer/requests.json`, filled by "Explain this" in `xpl view`). Do 1-4 for each, then `rm .explainer/requests.json` and tell the user what you added.

## make tour

1. Choose the views (ask which if several; default: the newest question view plus the overview). Order the story: overview, main flow step by step, concepts, edge cases.
2. One tour step per idea, 5-12 in all: `{"id": "t1", "view": "view:...", "focus": [ids], "note": "...", "editor": {"primary": "<file shown first>"}}`.
   - `focus`: node, edge, concept or sequence-step ids (a step must belong to that tour step's `view`); usually one sequence step, plus the concept that explains it.
   - `note`: speaker note, markdown, 1-3 sentences: what to say and why it matters, not a paraphrase of the code.
   - `code` (anchor overrides): give it whenever `focus` is a group, file or directory (their focus is the whole files) or the focused anchors are not what the audience should read: 1-3 anchors of the lines to look at.
3. Tour ids are `tour:<slug>`; step ids `t1`, `t2`... are unique in the tour and never renumbered (insert with the next free number where it belongs in the array). A tour the user edited in the tour panel (`title`, `steps`) is theirs: an `llm` patch that resends those fields is skipped (`protected` warning, exit 1 when that was all it did) and the tour cannot be removed. To change such a talk make a new tour under a new slug, or ask.
4. `apply`, then `xpl anchors <name> tour:<slug>`: every step prints the code the viewer will show, from its `code` override or, without one, derived from its `focus` (`[derived from dispatch:2]`). Where that is not what the audience should read, resend the tour's `steps` (tours have no `stepsUpdate`) with a `code` override on that step.
5. `xpl bundle <name> -o <file>.html --tour tour:<slug>` (opens in present mode, arrow keys step through).

## After the code changed

1. `xpl index`, then `xpl resolve <name> --write`: re-resolves every anchor (ok / moved / drifted / missing), rewrites moved spans, and reports. (`--write` refuses while the index does not match the working tree: run `xpl index` first.)
2. `xpl status <name>` is the to-do list: drifted llm elements (drifted steps name their view), `N drifted (K user-owned: ask the user)`, missing anchors, **broken references** (ids that vanished from the index: an overlay of a deleted symbol, an `include` / `members` / `related` / `participants` entry, a step end, a tour step's `focus`; `tours (n)` names the steps that point at something gone) and stale derived-edge overlays (an `edge:<kind>:<a>-><b>` overlay that no view derives any more).
3. **Drifted llm elements:** re-read the code (`xpl anchors <name> <id>` shows what the anchors point at now), then resend their anchors (without `hash`; for a step, a `stepsUpdate` entry with that step's anchors and summary, the other steps stay: see `reference/patch-format.md` section 8) and any summary that depended on them. Never change a field listed in `userFields`; never touch `origin: "user"` elements or remove anything that carries `userFields` (`apply` skips them with a warning). Resent anchors are re-hashed, which clears the drift.
4. **Broken references:** fix them in a patch: `includeRemove` drops a stale `include` entry, resend `members` / `participants` / `steps` without the gone id (a tour: resend its `steps` with the focus fixed), or `remove` the overlay; re-create a stale edge overlay on the id `status --json` lists now.
5. **Missing anchors** (symbol gone or renamed): report each to the user (element, anchor, the `did you mean` hint: it names where the code went when it can tell, as an id and as ready-to-use anchor fields) and ask: re-anchor or remove. Never drop one silently or retarget it to something merely similar.
6. `xpl validate <name>` (strict) must pass before you finish; `--lenient` is only for inspecting a half-repaired file.

## Show the result

- `xpl bundle <name> -o <name>.html`: one self-contained HTML file (viewer, index, sources), works offline and can be shared. **The default in remote/cloud sessions** and wherever no local browser exists: give the user the path (publish or attach it if your environment can). `--mode present --tour tour:<slug>` starts a tour. By default it embeds only the files the explainer references and says so (`9 of 12 files embedded (referenced: 22.1 KB of source; --files all adds 3 files, 3.0 KB)`): the viewer's file tree lists only those files ("8 of 12 files included"). Add `--files all` when the reader will browse the rest of the repo.
- `xpl view <name>`: local server (`http://127.0.0.1:4747`), live: reload after each `apply`; the user's layout edits are saved and "Explain this" clicks are queued. Start it in the background, stop it when the user is done. Use it when the user is at the machine and will keep iterating.

## Hard rules

1. **You cannot invent code.** Every anchor must resolve against the index or `apply` rejects the patch. Never write hashes. Never write line numbers or offsets from memory: copy them from `show`/`refs`/`search` output of this session, or use `find`.
2. **Read before you claim.** Never summarise code you have not `show`n. A ref is a hint until you have seen the call.
3. **`llm` edges only for what static analysis cannot see**, each with anchors at both ends. Calls, imports and inheritance are derived by the viewer: do not store them.
4. **Stable ids.** Slugs (`grp:`, `concept:`, `edge:`, `view:`, `tour:`, `frame:`) are chosen once (lowercase kebab-case) and kept. Step ids `<view-slug>:<n>` are never renumbered or reused.
5. **Provenance.** Use the default actor (`llm`). Never overwrite `origin: "user"` elements or `userFields` (views and tours included: `apply` skips them with a `protected` warning); `--actor user` only when the user dictates text to be stored as theirs.
6. **Summaries** are 1-2 sentences, concrete, about this code, and every claim in them is visible in the code their anchors show (step 7 of `explain`: re-read them against `show` before applying). Use `detail` (markdown) only when it earns its place.
7. **Lazy.** Explain what a view shows; leave the rest for `expand`.
8. **Ask, do not guess** when the scope is ambiguous or an anchor cannot be found.

## Gotchas

- An anchor's `symbol` is the path inside the file (`Runner.Dispatch`). Element ids (`from`, `to`, `include`, `participants`, `members`, `focus`) use `sym:<file>#<path>`. `scope.entryPoints` uses `<file>#<path>` without `sym:`. A "did you mean" for an anchor prints both (`sym:src/a.ts#A.b (anchor: file: "src/a.ts", symbol: "A.b")`): copy the fields into the anchor, the id everywhere else.
- Every step's `from`/`to` must be in the view's `participants`. Changing participants means resending the steps.
- `steps`, `participants`, `include`, `members`, `anchors` replace wholesale: always resend the full list. Two exceptions: a graph view's `include` also takes `includeAdd` / `includeRemove` (see `expand`), and a sequence view's steps can be changed one by one with `stepsUpdate` (`[{"id": "dispatch:4", "summary": "...", "anchors": [...]}]`: an entry replaces only the fields it names, its `anchors` replace that step's anchors, `null` clears `summary`/`edge`; an unknown step id is an error).
- `dir:`/`file:`/`sym:` overlays need only `id` + `summary` (label and anchors default from the index).
- Ghost ids (`ghost:file:x`, `ghost:rest:file:x`, `ghost:more:out`, `stub:...`) are render-only: they go in a view's `hidden`, never in `include`, `includeAdd`, `members` or `focus`.
- An `llm` edge takes `kind` `calls` (interface/DI/HTTP call), `emits` (event bus, queue), `reads` (config or string-keyed lookup) or `custom`.
- A derived-edge overlay (`edge:calls:...`) is still an `llm` edge: it needs anchors at both ends, and a `label` (else a warning).
- A `warning: index ... does not match the working tree` means offsets may be off: run `xpl index` before anchoring.

## Reference

- `reference/patch-format.md`: every element type as a copy-pasteable template, `AnchorInput`, id rules, merge semantics (`includeAdd`, `excludeFiles`), rejection messages and their fixes. `xpl apply --help` prints a summary of it.
- `reference/cli.md`: every command, option and output shape.
- `reference/examples/go-retry.patch.json`: a complete worked patch for a question (sequence + graph views, groups, llm edges, concepts, tour); applies to `fixtures/go-jobrunner`.
- `reference/examples/py-overview.patch.json`: a worked `explain repo` patch (groups, one-line summaries, overview graph, event-bus llm edge, startup sequence); applies to `fixtures/py-jobrunner`.
