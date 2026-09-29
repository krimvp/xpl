---
name: code-explainer
description: Generate an interactive code explainer, meaning linked diagrams (box-and-arrow graph, sequence diagram) and a concept list next to a code viewer, where clicking a box, arrow, step or concept highlights the exact code and selecting code lights up the matching diagram elements. Use when the user wants to understand how code works ("how does X work", "how does a failed job get retried"), get an architecture overview of a repo, explore an unfamiliar codebase, or prepare a code walkthrough, demo or presentation. Three operations - explain (a question, or the whole repo) creates views, expand (a node or stub) grows a view and explains what became visible, make tour turns views into a presentation.
---

# Code explainer

You turn a question about code, or a whole repo, into an **explainer**: data that a fixed viewer renders as diagrams linked both ways to the code. You never write UI. You write JSON **patches**; the `xpl` CLI checks every claim against a static index and rejects what it cannot resolve.

Workflow at a glance: `xpl index` → `xpl new <name>` → read the code (`outline`, `search`, `show`, `refs`) → write one patch → `xpl apply` (fix and repeat until clean) → `xpl validate` + `xpl status` → `xpl bundle` or `xpl view`.

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
   - `refs: heuristic`: scope-aware guesses (a warning says why SCIP was unavailable). Treat refs as hints: confirm each call with `show` before you claim it.
   - `refs: none`: yaml/json/text. They have symbols (config keys) but no references.
   - `--precise require` fails instead of falling back (use it when the user needs the exact call graph); `--precise off` skips SCIP for a fast, heuristic index on a big repo.
3. **Name it:** `xpl new <name> --title "..."` unless `.explainer/<name>.explainer.json` exists. One explainer per repo (repo name, kebab-case); new questions add views to it.
4. **Patch files:** write patches outside the repo (scratchpad or `$TMPDIR`) so you can fix and re-apply; `xpl apply <name> -` reads stdin.

## Reading the code

| Command                                                 | Use it to                                                                                                   |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `xpl outline [--under <id>] [--depth n] [--keys]`       | see dirs/files/symbols with ids, lines, fan-in/out (`in=`/`out=` find the hubs); `--keys` lists config keys |
| `xpl search <text> [--regex] [-i]`                      | find a word, config key, topic, route or error string; each hit shows the enclosing symbol id and `+offset` |
| `xpl show <id> [--refs]`                                | read code as `<line> <offset>│ code`; `--refs` adds outgoing calls and callers, each with `+offset`         |
| `xpl refs <id> [--in\|--out] [--kind call] [--depth n]` | call hierarchy: what this calls / who calls this                                                            |

Paste ids exactly as printed (`sym:internal/runner/runner.go#Runner.Dispatch`, `file:...`, `dir:...`). `+34..36` in the output is a span: `{"from": 34, "to": 36}`. Full options and sample output: `reference/cli.md`.

## explain <question>

1. **Scope.** If the question can mean two materially different things (which service, which layer, retry of what), ask one short question with concrete options. Otherwise proceed and state your assumption in the reply.
2. **Entry points.** `search -i` the nouns and verbs of the question (retry, fail, requeue, timeout); `outline --depth 2` for the shape. Pick the function where the flow starts or the decision is made.
3. **Trace.** `show <entry> --refs`, read the body, then follow the callees that matter with `show` and `refs <id> --out --depth 2 --kind call`. Stop when the question is answered; skip logging, metrics and plumbing that do not change the answer. Two traps:
   - A callee that is an interface or abstract method (a declaration without a body, e.g. Go `JobQueue.Requeue`) has no outgoing refs. `refs <it> --in` lists its implementers (`implements`): read the one that does the work (not a test double) and anchor the step's definition there.
   - A `call` ref to a type is a construction (`Result{...}`, `new X()`), not a function call.
4. **Find what static analysis misses:** event bus, DI and interface wiring (who passes the concrete class in), callbacks registered in another file, HTTP handlers, queues, topics, config keys read by name (`search` for `emit`, `publish`, `subscribe`, `on(`, `Handle`, `register`, topic/route/key strings; `outline --under file:config/x.yaml --keys`). Tests that pin the behaviour (`refs <id> --in`, `search`).
5. **Decide the model** before writing:
   - _sequence view_: 3-6 participants (entry symbol first, then the types/files it talks to; a class or file as the lifeline, the method as the definition anchor); one step per call that matters, in execution order; `return` steps only where the result drives a branch; frames (`loop`, `alt`, `opt`, `par`) over the steps inside a loop or branch, one `alt` frame per arm.
   - _graph view_: the 5-15 files/symbols involved; clusters that cross folders become **groups**.
   - _concepts_: the cross-cutting ideas (retry policy, delayed redelivery) anchored to the implementing code, the config keys and the tests.
   - _llm edges_: only for the links found in step 4, each with anchors at both ends.
   - _summaries_ for everything the views show (every participant, step, box, group, concept): 1-2 sentences, concrete, about this code ("requeues with `baseDelay * 2^attempt`, capped at `maxDelay`"), never generic ("handles retries").
6. **Write ONE patch** with all of it. Read `reference/patch-format.md` first (a template for every element) and imitate `reference/examples/go-retry.patch.json`. Key rules:
   - A step's anchors are the exact call in the **caller** (`role: "call-site"`) plus the callee's **definition** (`role: "definition"`, whole symbol).
   - `find` (text copied from `show`, unique inside that symbol) anchors exactly the lines the text touches and checks itself: use it for one-line calls. For a block or a multi-line call use `span` with the `+a..b` printed by `show --refs`/`refs` or the offsets from `show`.
   - Concept anchors: span/find the deciding lines, not the whole function; config as `symbol: "<key path>"` (`retry.maxRetries`); tests as a test symbol, a span, or the test file.
   - Step `label` = call text (`Requeue(job, backoff)`); `summary` = what happens and why.
7. **Apply:** `xpl apply <name> patch.json`. A rejection writes nothing: read every error (path, message, suggestion), fix the **patch**, apply again. Never weaken a claim to get past validation (dropping an llm edge's second anchor, anchoring a whole file instead of the call, deleting a step). What you cannot anchor you cannot claim: leave it out and tell the user. Read the result too: `changed:` must list what you meant to change; `no changes` or a `protected` warning means user-owned content was left untouched.
8. **Check:** `xpl validate <name>`, then `xpl status <name>`: it lists what the views show without a summary; fill any that remain with a second patch until `to do: 0 unexplained`. For every `span` anchor confirm it resolved to the code you meant: take `resolved.range` from `.explainer/<name>.explainer.json` and `xpl show <file> --lines a-b`.
9. **Show it** (below), and answer the question in your reply in 3-6 sentences naming the key functions. The explainer is the evidence, not a replacement for the answer.

## explain repo

Coarse first, lazy after.

1. `outline --depth 1`, then `--depth 2` (`--under dir:<x>` for big trees). Find the packages/services/layers, entry points (`main`, `cmd/`, servers, CLI dispatch), config, tests, docs.
2. Choose 4-10 boxes: top-level dirs/packages; when the repo is one package (depth 1 gives fewer than 4 boxes) use its files. Cluster with **groups** (`grp:<slug>` + `members`) where one responsibility spans several files or folders.
3. One patch (imitate `reference/examples/py-overview.patch.json`): the groups; overlays (`dir:`/`file:`/`grp:`) with a one-line `summary` for **each box the view shows and nothing deeper**; a graph view `view:overview` with `scope: {root: "repo", depth: 1}` (or 2) and `include` = those boxes and their group ids (add `"edgeKinds": ["imports", "calls"]` when package dependencies are the point); `llm` edges for links static analysis cannot see (event bus, DI); 1-3 concepts only if an idea is central to the design.
   Test files add edges to their package (`internal/runner -> bus` exists only through `retry_test.go`): check surprising edges with `refs <dir> --out` and put the misleading derived edge ids (from `status --json`) in the view's `hidden`.
4. If there is an obvious entry point, add one sequence view for the main flow (startup or request path), 4-8 steps, anchored as above, participants explained. No obvious entry point: skip it.
5. Leave deeper nodes unexplained (lazy). Tell the user, and offer the 2-3 most useful expansions.

## expand <node>

`<node>` is an id or name from the user, a ghost/stub they clicked (`ghost:dir:internal/bus` means `dir:internal/bus`), or an entry of the request queue.

1. Resolve it to an id (`outline`, `search`) and read it: `show <id> --refs`, `outline --under <id> --depth 1` for its children (a group opens into its `members`).
2. **Drill in:** patch the graph view with `include` = the old list + `<id>` + the children worth showing. Arrays replace, so resend the whole list (read the current one from `.explainer/<name>.explainer.json`). A node whose children are also included renders as a container. A stub's ghost target is appended the same way. If `apply` answers `no changes` with `include of view:x was edited by the user and is kept as it is`, the user owns that view's `include`: put the nodes in a new graph view (new slug) and say so.
3. **Explain what became visible:** `status <name>` names the new unexplained nodes; add overlays with a `summary` for those and only those.
4. If the target is a step, edge or concept: a step gets a better `summary` (resend all steps; steps have no `detail`, put the longer answer in your reply); a concept gets `summary`/`detail`; a derived edge `edge:calls:<a>-><b>` gets an overlay with `label`, `summary` and anchors at both ends. Derived edge ids depend on what the view includes (drilling into a file changes `...->file:x.go` into `...->sym:x.go#Type`): do this after the `include` edit and take the current id from `status --json` (`views[].edges.unexplained`).
5. **Drain the queue:** `status` prints `requests queued by the viewer` (from `.explainer/requests.json`, filled by "Explain this" in `xpl view`). Do 1-4 for each, then `rm .explainer/requests.json` and tell the user what you added.

## make tour

1. Choose the views (ask which if several; default: the newest question view plus the overview). Order the story: overview, main flow step by step, concepts, edge cases.
2. One tour step per idea, 5-12 in all: `{"id": "t1", "view": "view:...", "focus": [ids], "note": "...", "editor": {"primary": "<file shown first>"}}`.
   - `focus`: node, edge, concept or sequence-step ids (a step must belong to that tour step's `view`); usually one sequence step, plus the concept that explains it.
   - `note`: speaker note, markdown, 1-3 sentences: what to say and why it matters, not a paraphrase of the code.
   - `code` (anchor overrides): give it whenever `focus` is a group, file or directory (their focus is the whole files) or the focused anchors are not what the audience should read: 1-3 anchors of the lines to look at.
3. Tour ids are `tour:<slug>`; step ids `t1`, `t2`... are unique in the tour and never renumbered (insert with the next free number where it belongs in the array).
4. `apply`, then `xpl bundle <name> -o <file>.html --tour tour:<slug>` (opens in present mode, arrow keys step through).

## After the code changed

1. `xpl index`, then `xpl resolve <name> --write`: re-resolves every anchor (ok / moved / drifted / missing), rewrites moved spans, and reports.
2. **Drifted llm elements:** re-read the code, then resend their anchors (without `hash`; for a step, resend the view's steps, see `reference/patch-format.md` section 8) and any summary that depended on them. Never change a field listed in `userFields`; never touch `origin: "user"` elements (`apply` skips them with a warning). Resent anchors are re-hashed, which clears the drift.
3. **Missing anchors** (symbol gone or renamed): report each to the user (element, anchor, the `did you mean` hint) and ask: re-anchor or remove. Never drop one silently or retarget it to something merely similar.
4. `xpl validate <name>` (strict) must pass before you finish; `--lenient` is only for inspecting a half-repaired file.

## Show the result

- `xpl bundle <name> -o <name>.html`: one self-contained HTML file (viewer, index, sources), works offline and can be shared. **The default in remote/cloud sessions** and wherever no local browser exists: give the user the path (publish or attach it if your environment can). `--mode present --tour tour:<slug>` starts a tour.
- `xpl view <name>`: local server (`http://127.0.0.1:4747`), live: reload after each `apply`; the user's layout edits are saved and "Explain this" clicks are queued. Start it in the background, stop it when the user is done. Use it when the user is at the machine and will keep iterating.

## Hard rules

1. **You cannot invent code.** Every anchor must resolve against the index or `apply` rejects the patch. Never write hashes. Never write line numbers or offsets from memory: copy them from `show`/`refs`/`search` output of this session, or use `find`.
2. **Read before you claim.** Never summarise code you have not `show`n. A ref is a hint until you have seen the call.
3. **`llm` edges only for what static analysis cannot see**, each with anchors at both ends. Calls, imports and inheritance are derived by the viewer: do not store them.
4. **Stable ids.** Slugs (`grp:`, `concept:`, `edge:`, `view:`, `tour:`, `frame:`) are chosen once (lowercase kebab-case) and kept. Step ids `<view-slug>:<n>` are never renumbered or reused.
5. **Provenance.** Use the default actor (`llm`). Never overwrite `origin: "user"` elements or `userFields`; `--actor user` only when the user dictates text to be stored as theirs.
6. **Summaries** are 1-2 sentences, concrete, about this code. Use `detail` (markdown) only when it earns its place.
7. **Lazy.** Explain what a view shows; leave the rest for `expand`.
8. **Ask, do not guess** when the scope is ambiguous or an anchor cannot be found.

## Gotchas

- An anchor's `symbol` is the path inside the file (`Runner.Dispatch`). Element ids (`from`, `to`, `include`, `participants`, `members`, `focus`) use `sym:<file>#<path>`. `scope.entryPoints` uses `<file>#<path>` without `sym:`.
- Every step's `from`/`to` must be in the view's `participants`. Changing participants means resending the steps.
- `steps`, `participants`, `include`, `members`, `anchors` replace wholesale: always resend the full list.
- `dir:`/`file:`/`sym:` overlays need only `id` + `summary` (label and anchors default from the index).
- An `llm` edge takes `kind` `calls` (interface/DI/HTTP call), `emits` (event bus, queue), `reads` (config or string-keyed lookup) or `custom`.
- A derived-edge overlay (`edge:calls:...`) is still an `llm` edge: it needs anchors at both ends, and a `label` (else a warning).
- A `warning: index ... does not match the working tree` means offsets may be off: run `xpl index` before anchoring.

## Reference

- `reference/patch-format.md`: every element type as a copy-pasteable template, `AnchorInput`, id rules, merge semantics, rejection messages and their fixes.
- `reference/cli.md`: every command, option and output shape.
- `reference/examples/go-retry.patch.json`: a complete worked patch for a question (sequence + graph views, groups, llm edges, concepts, tour); applies to `fixtures/go-jobrunner`.
- `reference/examples/py-overview.patch.json`: a worked `explain repo` patch (groups, one-line summaries, overview graph, event-bus llm edge, startup sequence); applies to `fixtures/py-jobrunner`.
