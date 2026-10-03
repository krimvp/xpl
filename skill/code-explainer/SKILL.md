---
name: code-explainer
description: Generate an interactive code explainer, meaning a short guided tour with linked diagrams (box-and-arrow map, process flow, sequence diagram) next to a code viewer, where clicking a box, arrow or step highlights the exact code and selecting code lights up the matching diagram elements. Use when the user wants to understand how code works ("how does X work", "how does a failed job get retried"), get an architecture overview of a repo, understand or review a change (a PR, MR, branch or commit range, read locally), explore an unfamiliar codebase, or prepare a code walkthrough, demo or presentation. Operations - explain <question> (part of a project), explain repo (architecture), explain change <base>..<head> (a diff), expand (grow a view), feedback (do what the user asked for in the viewer), make tour (a talk).
---

# Code explainer

You turn a question about code, a whole repo, or a change into an **explainer**: a guided tour with diagrams linked both ways to the code, rendered by a fixed viewer. `xpl draft` builds the structure from a static index, with `TODO` where text belongs. You write the text as JSON **patches** and check every claim; `xpl` rejects anchors it cannot resolve.

The reader sees the tour title and its **summary** first, then the steps (a title, a short note, one picture and its code), then the maps and the code on demand. Put the most important thing first, then go down one level at a time: **the system** (services, data stores, outside systems), **inside a service** (its parts and what each talks to), then **the code**. Explain each part by what it is for, in everyday words, before you name any code.

## Workflow

`reference/quick.md` is this workflow, the rules and the lint checks on one page.

1. `xpl index`, `xpl new <name>` (Setup).
2. Choose the scope, and say it in the reply.
3. A change only: `xpl change <name> <base>..<head>` records it and prints its analysis.
4. `xpl draft change|repo|path <name> [<entry id>] -o <file>`.
5. Read the code. Write every `TODO`, fix the structure where the code shows the draft is wrong, add what the tour needs. Every flow and sequence participant needs a `summary` (an overlay in the same patch).
6. `xpl lint <name> --patch <file> && xpl apply <name> <file>`: lint exits 1 on any finding, so a flawed patch is not applied.
7. `xpl validate`, `xpl status`, `xpl anchors <name> tour:<slug>`.
8. The accuracy pass, `xpl lint`, a newcomer's re-read.
9. `xpl bundle`, then the reply.

## What you are making

- **Index** `.explainer/index-<commit>.json`: symbols, ranges and references from static analysis.
- **Explainer** `.explainer/<name>.explainer.json`: written only by `xpl apply` and `xpl change`; never edit it.
- **Tour**: a `summary` and a few steps. **Views**: `graph` (a map), `flow` (decisions and branches), `sequence` (calls between participants). **Elements**: boxes, edges, concepts and steps.
- **Architecture boxes**: a box with a `role` (`service`, `database`, `queue`, `external`, `person`, ...) and a `tech` is drawn as what it is; a box with `opens` zooms into the view that shows its inside. A database or an outside API is a group with a role and no members, anchored at the code that talks to it (`patch-format.md` 3.10).
- **Anchor**: a file, a symbol path, and a `span` (0-based line offsets from the symbol's first line) or `find` text, stored with a hash. A **base anchor** (`"at": "base"`) points at the code before a recorded change.

## Setup

1. **The CLI** is `bin/xpl` in this skill's directory (else `ls -d ~/.claude/skills/code-explainer .claude/skills/code-explainer`). Below, `xpl` means that path, written in full. Run it from the repo root, or pass `--root <dir>`. If it says "the CLI is not built", tell the user to run `npm install && npm run build` in the xpl repo.
2. **Index:** `xpl index`. Run it again when the code changed or a command warns that the index `does not match the working tree`. A language with `refs: heuristic` has hints, not facts: confirm each call with `show`. `--precise off` is fast, for a big repo.
3. **Name it:** `xpl new <name> --title "..."` unless the explainer exists. One explainer per repo (the repo name, kebab-case); a new question adds views and a tour to it. A change gets its own explainer, titled after it: `xpl new <repo>-pr-42 --title "PR 42: <what it does>"`. Say who the page is for, fit to its level, in one short line: `"scope": {"audience": "Overview, for anyone new to ky"}` (a repo), `"Deep dive, for engineers working on the router"` (an algorithm), `"For reviewers of this change, and anyone who uses the option"` (a change); the viewer shows it under the title (patch-format.md 3.11).
4. **Patch files** go outside the repo (the scratchpad or `$TMPDIR`).

## Choose the scope

| Request                                                    | Scope                                    | Draft                          | Tour answers                                                      |
| ---------------------------------------------------------- | ---------------------------------------- | ------------------------------ | ----------------------------------------------------------------- |
| "how does X work", a question about one subsystem          | `explain <question>` (part of a project) | `draft path <name> <entry id>` | the question, from the entry point to the answer                  |
| "explain this repo", "give me an overview", "architecture" | `explain repo` (whole project)           | `draft repo <name>`            | what the project is, its parts, the main path through them        |
| a PR, an MR, a branch, a commit range, "my changes"        | `explain change <base>..<head>` (a diff) | `draft change <name>`          | what changes for users, where, who else is affected, tests, risks |

If the request can mean two materially different things (which service, which branch to compare with), ask one short question with concrete options. Otherwise proceed and state your assumption.

**Fast mode.** When the user asks for a quick answer ("quickly", "the gist"), keep the draft's one picture (its map, or a path draft's sequence) and write its text. Cut the tour to about 5 steps; for a change, keep the first and the last. Add no other views, concepts or `llm` edges. The accuracy rules and checks still apply. Offer the full explainer in the reply.

## Reading the code

- `xpl outline [--under <id>] [--depth n] [--kind method,function] [--keys]`: ids, lines, fan-in and fan-out (`in=`/`out=` find the hubs).
- `xpl search <text> [-i] [--regex] [--under <dir|glob>] [--code]`: hits with the enclosing symbol id and `+offset`.
- `xpl show <id> [--refs]`: code as `<line> <offset>│ code`, and the refs with `+offset`. `xpl show --at base <path> [--lines a-b] [--explainer <name>]`: a changed file before the change.
- `xpl refs <id> [--in|--out] [--kind call|read] [--depth n]`: what this calls, or who calls or reads it.

Paste ids exactly as printed; `+34..36` is the span `{"from": 34, "to": 36}`. Options: `reference/cli.md` (look up one command; do not read it all).

Where the index shows less than runs:

- An interface method has no body: `refs --out` lists its implementations as `impl` lines. Anchor the one that does the work.
- A `call` ref to a type is a construction, not a call on your path. A `call` ref to a field is a call through a stored function: anchor the field (`usage`) and the function (`refs <field> --in`).
- A method reached through a variable (`await response(...)` runs `__call__`) has no callers in `refs --in`: `search` for the name, or find where the object is built (`refs <class> --in`).
- A call to a base-class method with no body runs a subclass method: anchor the one that runs, and link them with an `llm` `calls` edge.
- Event buses, DI, callbacks, HTTP handlers, queues and config keys read by name: `search` for `emit`, `on(`, `register` and the topic, route or key, then link with an `llm` edge.
- Calls into dependencies are not indexed: anchor the call site and describe nothing inside the library. You may name a library as the caller of your code when a line in the repo shows it (a class passed as `httpx.Client(transport=...)`): anchor that line.
- Stay at `--depth 1` on a hub. Stop when the question is answered.

## explain <question>: part of a project

1. **Entry point:** `search -i` the nouns and verbs of the question; `outline --depth 2`. Pick the function where the flow starts or the decision is made.
2. **Draft:** `xpl draft path <name> <entry id> -o q.json`: a sequence of the entry's direct calls in source order, and one tour step per main call. A question with two halves (make a token, then check it): give both entries, `xpl draft path <name> <entry> <entry2>`, for one tour through two sequences. A method the class inherits works too (`sym:a.py#Child.run`).
3. **Trace:** `show <entry> --refs`, then the callees that matter. Note every guard on the path (`if`, early `return`, type checks).
4. **Shape:** the draft sees one level of calls. Drop the calls that do not matter. Add a map when the answer spans several files, and start the tour on it: the parts involved as plain boxes, with the outside systems they touch (a database, an API) as role boxes, so the reader sees where the answer sits before the calls. Add a flow when the point is a decision, a second process view when the question has two halves, concepts for ideas that cross files.
5. **Boundary:** anchor the target code, its direct callers, the callees that change the answer, and the tests that pin the behaviour.
6. **Reply:** answer the question and name the key functions.

## explain repo: the whole project

Three levels, each a zoom into a box of the one above (`opens`):

| Level          | Shows                                                                              | Boxes                                                |
| -------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 1. System map  | the service(s), who uses them, and the databases, queues and outside APIs they use | 3-7, each with a `role` and a `tech`                 |
| 2. Inside      | the parts of one service, and the outside boxes each part talks to                 | 4-8 `component`s with plain labels, plus those boxes |
| 3. Code (lazy) | the main path through a part: a sequence or a flow                                 | on `expand`                                          |

1. **What it is:** the README and package metadata (`xpl show file:README.md`, `outline --keys` on `pyproject.toml`, `package.json`, `go.mod`): language, kind, purpose.
2. **Draft:** `xpl draft repo <name> -o repo.json`: the system map (`view:system`), a map of the inside of each service, edges from each part to the outside systems it imports, and a tour from the top. The first step on the inside lists the files left off the map, by name, in one sentence.
3. **Outside systems:** the draft finds them from import lines; each is a hint. Read the code that builds the client or reads its address: name the real system ("Orders database", not "SQL database"), merge two boxes for one system, drop a library that is only imported, and add what the imports miss (a service called through plain HTTP: `search` for its URL or config key). Each arrow gets a 1-4 word label: what passes ("stores orders", "charges cards").
4. **Parts:** make each box one responsibility, with a label a manager understands ("Payments", not `pay_svc`). Merge folders into a group (`grp:<slug>` with `members`) where one responsibility spans several; split a box that holds two. Each box gets a one-line summary of what it is for.
5. **Main path:** when there is an obvious entry point (`main`, `cmd/`, a server), run `xpl draft path` on it, and let its part `opens` the sequence. Copy its view, its nodes and the tour steps you keep into the repo patch, with the next free step ids.
6. **Tour:** the system map (what it is, who uses it), what it relies on, the inside, the main path, then each remaining part, or one step that names the parts it skips.
7. **Lazy:** leave deeper nodes unexplained; offer 2-3 expansions in the reply.

## explain change <base>..<head>: a PR, an MR or a branch diff

Follow `reference/explain-change.md`: recording the change, its callers and tests (use `xpl change` instead of finding them by hand), the old code (`xpl show --at base`), "before" claims, and the tour order.

## Working from a draft

A draft applies as it is. Each text holds `TODO: <what to write>`; each note starts `### TODO: ...`. Edit the file:

- **Write every `TODO`** after you have read the code it anchors.
- **Fix the structure only where the code shows the draft is wrong:** a caller marked "a guess" that never runs the changed code, a call that does not matter, a box with two responsibilities. Otherwise keep its ids, anchors and view settings.
- **Add what the tour needs:** groups, flows, concepts, `llm` edges. `reference/patch-format.md` has a template per element: read sections 1 and 2, then only what you add. `reference/examples/` shows finished text.
- **New anchors** follow `patch-format.md` section 1 (a tour step: 3.9). Anchor context code you only show with a file-relative `span` (no `symbol`), so it does not widen the bundle's boundary.

## The tour

- 5-9 steps, up to 12 for a change.
- Top-down: the first step shows the big picture (the map). Then the main path in execution order, then the details that change the outcome. Edge cases and open questions come last. A repo tour visits every overview box or names the ones it skips.
- Concepts before code: a step on the system map or the inside of a service names at most one piece of code; it says what the part is for and what it relies on. Code names belong to the steps about code (`xpl lint`: `code-heavy`, `long-note`).
- Each step focuses one main element, plus at most one concept that explains it.
- `code` on every step: at most 2 ranges, and `editor.primary` on the file the note is about. **Range order:** the range the note talks about first; when the note is about a before and after, the before range (a base anchor), then the after range.
- 4-8 boxes on a map (3-7 on a system map). Every graph view a tour uses has `"stubs": {"mode": "none"}`; an overview has `excludeFiles` for tests, examples and docs. The drafts set both.

## Writing

Read `reference/writing.md` before you write text: which field holds what, which fields take markdown, titles, the tour summary, rewrites and the checklist. `xpl lint` checks the mechanical part.

## Accuracy

The viewer shows each claim next to its code, so a wrong claim looks checked. Check every title, label, summary, `detail` and note against the `show` output of its anchors:

- **Only what the anchored code shows.** Delete what a callee does elsewhere, paths you did not read, and why the author chose it. What you cannot check, leave out and name in the reply.
- **Guard conditions:** when the anchored lines run only under a condition, name it ("when `metrics.enabled` is true") and anchor it.
- **Absolute words** (all, every, never, only, "the same everywhere") need proof in the anchored code. "Every caller" needs `refs --in` and an anchor for each site. Otherwise name the sites or narrow the claim. Say a proved claim next to its evidence: on the element whose anchors show it, or in a note sentence that names the part the step shows.
- **Lists** read as complete: check that they are, or write "for example".
- **Code, not folklore:** "stops waiting after the timeout", not "kills the job", when the code only races a timer.
- **Changes:** "before" claims and test claims follow `reference/explain-change.md` sections 4 and 6.

## Apply and check

1. `xpl lint <name> --patch <file>` lints the explainer as it would be after the patch and writes nothing; a patch that `apply` would reject prints the rejection. It exits 1 on any finding: fix the patch, then apply it once. To keep a finding on purpose, run it with `--warn-only` and say why in the reply.
2. `xpl apply <name> <file>`. A rejection writes nothing and lists every error, with `Did you mean` and ready-to-use anchor fields. Fix a `probably off by one` warning now. Never weaken a claim to pass: what you cannot anchor you cannot claim. A `protected` warning means the user's edits were kept (`patch-format.md` section 5).
3. `xpl validate <name>`; `xpl status <name>` until `0 unexplained`; `xpl anchors <name> tour:<slug>` shows the code of each step.

## Check before you show it

1. **Accuracy pass** (a change): if you can start a fresh subagent, give it the `xpl` path, the repo, the explainer name and path, and the range. Ask it to check each title, summary, note and detail against its anchors (`xpl anchors <name>`), each "before" claim against the base (`xpl show --at base <path>`, `git show <base>:<path>`), and what each cited test asserts. It rates each claim correct, imprecise, overstated, unanchored or wrong, quotes the lines, and changes no file. Without a subagent, do a second, separate pass yourself, one claim at a time. Fix what the pass finds.
2. `xpl lint <name>`: `todo-left` must be zero before you bundle. Fix the other findings, including what the reader will see (`untitled-step`, `far-ranges`, `big-map`, `crowded-map`, `self-loop`), or say in the reply why you kept one.
3. Re-read the tour in order as a newcomer, with the checklist in `reference/writing.md` section 7.

## Show the result

- `xpl bundle <name> -o <name>.html`: one self-contained HTML file that works offline; for a change it shows the diff, the code before, New and Changed badges and the file list. It embeds the files the explainer refers to (`--files referenced`, the default); add `--files boundary` for a change or a subsystem, so the callers, callees and tests come along. A bundle is **what you give the user in remote or cloud sessions**: give them the path. Attach or publish it only when asked: it holds their source code. `--tour tour:<slug>` opens the tour as a presentation.
- `xpl view <name>`: a local server for a user at the machine who keeps iterating; run it in the background.
- **The reply:** first the answer in 3-6 sentences (for a change: the behaviour change, then the risk). Then one line each: the scope and any assumption; for a change, the changed files with `+/-` counts; what you checked by running code; what you left out or could not check; the bundle path and what it embeds. Say that `.explainer/` was written into the repo. Do not retell the tour.

## Change one thing cheaply

Patch only what changes, and lint the patch first.

- One element's text: `{id, summary}`.
- One step of a flow or sequence: the view's `stepsUpdate` with that step.
- One tour step: `{"tours": [{"id": "tour:x", "stepsUpdate": [{"id": "t3", "note": "..."}]}]}`. Send `steps` whole only to add, remove or reorder steps.
- A box on a map: `includeAdd` / `includeRemove`.
- Other lists (`members`, `participants`, `anchors`) replace wholesale (`patch-format.md` section 4).

## expand <node>

`<node>` is an id or name, a ghost the user clicked (`ghost:dir:x` means `dir:x`), or a queued request.

1. Resolve it to an id and read it: `show <id> --refs`, `outline --under <id> --depth 1`.
2. Add it and the children worth showing with `includeAdd` on the graph view. A view with `origin: "user"` takes no `llm` edit: use a new view.
3. `status <name>` names what became visible and has no summary: explain those and only those.
4. `status` also lists `requests queued by the viewer`: do 1-3 for each (one with a note: `feedback`), then `rm .explainer/requests.json`.

## feedback [<id> <what to change>]

What the user typed under "Explain this" in `xpl view`: the queued requests with a note in `xpl status <name>` (or the one `<id>` given). The note says what to change about that element, in their words: "too long", "wrong, it retries 3 times", "show the caller".

1. For each request: read the element and its code (`show <id> --refs`), then make the smallest patch that does what the note asks, by the rules of `writing.md`. More to show is `expand`; a claim the code contradicts is fixed in the text, never by bending the anchor. If the note is wrong about the code, change nothing and say why.
2. Put all of them in one patch: `xpl lint <name> --patch <file>`, then `xpl apply`. A request without a note is an `expand`.
3. `rm .explainer/requests.json`, then reply with one line per request: what changed, or why not. The open page shows the change by itself within a few seconds.

## make tour

A talk built from existing views, by the rules of "The tour". Default: the newest question's views plus the overview; ask when there are several. Use a slug with `talk` (`tour:talk-retries`), so `xpl lint` keeps each note short enough for Present (`long-talk-note`). Check with `xpl anchors <name> tour:<slug>`, then `xpl bundle <name> -o talk.html --tour tour:<slug>`.

## After the code changed

`xpl index`, `xpl resolve <name> --write`, then work through `xpl status <name>` with `reference/patch-format.md` section 8. Ask the user before you re-anchor or remove a missing anchor. `xpl validate <name>` must pass before you finish.

## Hard rules

1. **You cannot invent code.** Every anchor must resolve. Never write hashes. Copy offsets from `show`, `refs` or `search` output of this session, or use `find`.
2. **Read before you claim.** A ref, or a caller or test that `xpl change` or a draft marks as a guess, is a hint until you have seen the call.
3. **Read-only on the user's repo and remotes.** Never post, comment, push or change their checkout (`.explainer/` aside).
4. **`llm` edges only for what the index cannot see**, anchored at both ends.
5. **Stable ids.** Slugs are chosen once, in kebab-case. Step ids are never renumbered or reused. A change draft numbers its tour steps `t10`, `t20`, ...: a step you insert takes a free number between its neighbours (`t15`).
6. **The user's edits win.** Never overwrite `origin: "user"` elements or `userFields`; for a view or tour they edited, make a new one or ask. `--actor user` only for text the user dictates.
7. **Few things at the same level.** One primary tour; views only when a tour step uses them or a box `opens` them; 0-3 concepts; groups only as map boxes.
8. **Lazy.** Explain what a view shows; leave the rest for `expand`.
9. **Ask, do not guess** when the scope is ambiguous or an anchor cannot be found.

## Reference

- `reference/quick.md`: the one-page quick reference.
- `reference/writing.md`: the writing rules and the checklist.
- `reference/explain-change.md`: the guide for a PR, MR or branch.
- `reference/patch-format.md`: a template per element, merge rules, provenance, rejections, repair.
- `reference/cli.md`: every command and option.
- `reference/examples/go-retry.patch.json` (a question) and `py-overview.patch.json` (a repo, with a system map and the inside of the service): finished patches for `fixtures/go-jobrunner` and `fixtures/py-jobrunner`. Read them for the text.
