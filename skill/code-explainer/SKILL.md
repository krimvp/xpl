---
name: code-explainer
description: Generate an interactive code explainer, meaning a short guided tour with linked diagrams (box-and-arrow map, process flow, sequence diagram) next to a code viewer, where clicking a box, arrow or step highlights the exact code and selecting code lights up the matching diagram elements. Use when the user wants to understand how code works ("how does X work", "how does a failed job get retried"), get an architecture overview of a repo, understand or review a change (a PR, MR, branch or commit range, read locally), explore an unfamiliar codebase, see what every file of a project does (a quick map, for example of code an AI assistant wrote, kept current after each change), or prepare a code walkthrough, demo or presentation. Operations - explain <question> (part of a project), explain repo (architecture), explain map (every file, in plain words), explain change <base>..<head> (a diff), expand (grow a view), feedback (do what the user asked for in the viewer), make tour (a presentation).
---

# Code explainer

You make a **guide**: a short tour with diagrams that link both ways to the code. The files and commands call it an explainer (`.explainer/<name>.explainer.json`). `xpl draft` builds the structure from a static index and leaves `TODO` where text belongs. You write the text as JSON **patches**. `xpl apply` rejects every anchor it cannot resolve.

The reader sees the tour title and its summary first, then the steps, then the diagrams and the code. Go down one level at a time: **the system** (services, data stores, outside systems), **inside a service**, then **the code**. Say what each part is for, in everyday words, before you name any code.

Terms used below:

- **Index** (`.explainer/index-<commit>.json`): the symbols, ranges and references that static analysis found.
- **View**: a diagram in the patch. A `graph` view is a map, a `flow` shows decisions, a `sequence` shows calls in order.
- **Element**: a box (node), an arrow (edge), a concept or a step.
- **Anchor**: a file, a symbol path, and a `span` (0-based line offsets from the symbol's first line) or `find` text. A base anchor (`"at": "base"`) points at the code before a recorded change.

## Hard rules

1. **Do not invent code.** Copy each anchor from `show`, `refs` or `search` output of this session, or use `find`; never write a hash.
2. **Read before you claim.** A ref, or a caller or test that a draft marks as a guess, is a lead until you read the call.
3. **Do not change the user's repo or remotes.** Never post, comment, push or change their checkout; `.explainer/` is the only exception.
4. **Keep patches and output files outside the repo**, in the scratchpad or `$TMPDIR`.
5. **The user's edits win.** Never overwrite `origin: "user"` elements or `userFields`; for a view or tour they edited, make a new one or ask.
6. **Rewrite whole, never append.** When the code or the question changes, rewrite each text at its level; never add a sentence to an old summary.
7. **`llm` edges only for what the index cannot see**, anchored at both ends (with `via`: at each hop the index does not show).
8. **Stable ids.** Choose each slug once, in kebab-case, and never renumber or reuse a step id.
9. **Few things at the same level:** one primary tour, 0-3 concepts, and only the views that a tour step uses or a box `opens`.
10. **Lazy.** Explain what a view shows, and leave the rest for `expand`.
11. **Ask, do not guess**, when the scope is ambiguous or you cannot find an anchor.

## Start here

Take these decisions in this order:

1. **The CLI.** It is `bin/xpl` in this skill's directory; below, `xpl` means that path, written in full. If it does not run, follow `reference/create.md`, "Install".
2. **The target.** List `.explainer/*.explainer.json`. Extend a guide only when the user names it; a name collision is not permission to extend it. Before you extend one, read its views, tours and `userFields`, and use fresh ids.
3. **The purpose.** Write the three lines of "Start from the purpose" before you draft.
4. **The scope.** Choose it with the table in "Choose the scope", and state it in the reply.
5. **The diagrams.** Choose each one with `reference/quick.md`, "Choose the diagram for the question".
6. **The workflow.** Follow "Workflow" and the section for your scope.

Ask one short question with concrete options when the request can mean two different things (which service, which branch). Otherwise go on and state your assumption. For a GitHub PR handoff (`handoff.json`), follow `reference/create.md`, "Author through the installed commands".

## Start from the purpose

Before you draft, write three lines in your notes:

1. **What the code is for:** who uses it and what they get, in one sentence. Take it from the README, the package metadata or the entry point. If no source says it, write "The README does not say" and ask.
2. **Where the answer sits:** the system or service, and the part of it that holds the answer.
3. **The answer**, in one sentence.

Line 3 is the first sentence of the tour summary (for a repo, line 1 is). The first tour step shows a map, and its note says lines 1 and 2. Only then does the tour go into the code.

## Choose the scope

| Request                                                          | Scope                                    | Draft                           | The tour answers                                                         |
| ---------------------------------------------------------------- | ---------------------------------------- | ------------------------------- | ------------------------------------------------------------------------ |
| "how does X work", a question about one subsystem                | `explain <question>` (part of a project) | `draft path <name> <entry id>`  | the question, from the entry point to the answer                         |
| "explain this repo", "give me an overview", "architecture"       | `explain repo` (whole project)           | `draft repo <name>`             | what the project is for, its parts, the main path through them           |
| a PR, an MR, a branch, a commit range, "my changes"              | `explain change <base>..<head>`          | `draft change <name>`           | what changes for users, where, who else is affected, tests, risks        |
| "what is in this app", "map every file", "what did the AI build" | `explain map` (every file, quick)        | `draft map <name>`              | what the project is and its parts; after a change, how each change helps |
| "what are the kinds of X", "how do these classes relate"         | `explain <question>` (a type hierarchy)  | `draft class <name> <type id>`  | what the type is for, what the types share, how they differ              |
| "what states can X be in", "what moves an order to shipped"      | `explain <question>` (a state flow)      | `draft states <name> <type id>` | what each state means, what moves the thing, which moves never happen    |

**Sketch first.** The user may want the big picture before the code (a plan, an idea, "roughly how would this work"). Then start with a sketch view (`view:sketch`, 3-7 sketch boxes, labelled arrows), and say in its title and in the reply that it is a sketch. Then read the code, and turn each box you can anchor into a box of code (`patch-format.md` 3.12).

**Fast mode.** When the user asks for a quick answer ("quickly", "the gist"), keep the draft's one diagram and write its text. Cut the tour to about 5 steps; for a change, keep the first and the last step. Add no other views, concepts or `llm` edges. The accuracy rules still apply. Offer the full guide in the reply.

## Workflow

`reference/quick.md` puts this workflow, the rules and the lint checks on one page. When the two differ, this file wins.

1. **Index:** `xpl index`. Run it again when the code changes or a command says the index `does not match the working tree`. Report the mode and the coverage it prints. A language with `refs: heuristic` has leads, not facts: confirm each call with `show`.
2. **Name:** `xpl new <name> --title "..."`. A change gets its own guide, titled after it: `xpl new <repo>-pr-42 --title "PR 42: <what it does>"`. Set `scope.audience` to one short line, such as `"Overview, for anyone new to ky"` (`patch-format.md` 3.11).
3. **A change only:** `xpl change <name> <base>..<head>` records it and prints its analysis.
4. **Draft:** `xpl draft <kind> <name> [<entry id>] --audience "<reader>" --question "<question>" -o <file>`, with the file outside the repo.
5. **Read and write:** read the code of each anchor, then write every `TODO`. Every box, flow step and sequence participant that a view shows needs a `summary` in the same patch. Done when no `TODO` is left and you read every claim.
6. **Lint, then apply:** `xpl lint <name> --patch <file> && xpl apply <name> <file>`. Lint exits 1 on any finding, so a flawed patch does not apply. A rejection lists every error, with `Did you mean` and anchor fields to copy. Fix a `probably off by one` warning at once. Never weaken a claim to pass: what you cannot anchor, you cannot claim.
7. **Check:** `xpl validate <name>`; `xpl status <name>` until `0 unexplained`; `xpl anchors <name> tour:<slug>` shows the code of each step.
8. **Accuracy pass and re-read:** see "Check before you show it". Done when no claim goes past its anchors.
9. **Ready and show:** `xpl ready <name>`, then `xpl bundle <name> -o <outside-repo>/<name>.html`. Done when ready shows no errors and the reply gives the path.

`xpl start <name> --question "..." --audience "..."` runs index, new, draft and apply for a first guide (`--entry <symbol>` adds a call sequence). Its result still holds `TODO`s, so steps 5-9 still apply.

## The tour

Every tour follows the same spine. Each step holds one idea, one diagram and at most 2 code ranges.

| Part                  | What it says                                                           | Diagram                                    |
| --------------------- | ---------------------------------------------------------------------- | ------------------------------------------ |
| Purpose (the summary) | the answer in its first sentence, then up to 4 reasons                 | none                                       |
| 1. Big picture        | what the part is for, where it sits, who uses it                       | a map: the system, or where this part sits |
| 2. Parts              | one step per box that matters (repo), or the 2-3 actors (question)     | the same map, with one box in focus        |
| 3. One path in detail | the main path in run order, and the decision that changes the outcome  | one flow or sequence                       |
| 4. Edges and risks    | guards and failure paths; for a change, what still behaves the old way | the flow, or the code                      |
| 5. Where next         | 2-3 boxes or views the tour skipped, and the question each one answers | the map again, with those boxes in focus   |

What each scope puts on the spine:

| Scope    | First step (a map)                                     | Middle steps                                             | Last step                                    |
| -------- | ------------------------------------------------------ | -------------------------------------------------------- | -------------------------------------------- |
| question | what this part is for and where it sits                | what starts it, then each decision in run order          | the failure path, then what the tour skipped |
| repo     | the system map: what it is for, who uses it, its needs | the inside of the main service, the main path, the parts | the parts skipped, and 2-3 expansions        |
| map      | what the project is                                    | each top folder, in one or two sentences                 | where a newcomer starts reading              |
| class    | what the type is for                                   | what the types share, then how each one differs          | which one to use when                        |
| states   | what the thing is, and why it has states               | each state, then what moves it                           | the moves the code never makes               |
| change   | what changes for users (`explain-change.md` section 7) | where it enters, each changed piece, who else is hit     | risks and open questions                     |

Length budgets:

| Scope        | Steps                 | Note body (aim) | Tour summary  | Diagrams a tour uses           | Boxes per map          | Concepts |
| ------------ | --------------------- | --------------- | ------------- | ------------------------------ | ---------------------- | -------- |
| question     | 5-8                   | 25-40 words     | 2-4 sentences | 1 map, 1 flow or sequence      | 3-6                    | 0-2      |
| repo         | 6-9                   | 25-40 words     | 3-5 sentences | system map, inside map, 1 path | 3-7 system, 4-8 inside | 0-3      |
| change       | 6-12                  | 25-45 words     | 3-5 sentences | the change map, 1-2 flows      | 4-8                    | 0-2      |
| map          | 1 + top folders, ≤ 12 | 15-30 words     | 2-3 sentences | the folder maps                | one box per entry      | 0        |
| presentation | 5-9                   | ≤ 280 chars     | 2-3 sentences | existing views                 | ≤ 8                    | 0-1      |

Hard limits for every scope: a note body has 50 words at most (`long-note`). A box, concept or step `summary` has 2 sentences and 45 words at most, and says what the thing is for (`long-summary`). A `detail` paragraph has 80 words at most (`long-detail`).

- **Answer first.** A reader who stops after the first sentence of the summary still has the answer. The steps show the reasons in the code.
- **Concepts before code.** A step on the system map names no code; a step on the inside of a service names at most one piece (`code-heavy`).
- **One focus.** Each step focuses one main element, plus at most one concept that explains it.
- **Code ranges.** Put the range the note talks about first. For a before and after, put the base range first, then the head range. Set `editor.primary` on the file the note is about.
- **Maps.** Every graph view a tour uses has `"stubs": {"mode": "none"}`; an overview has `excludeFiles` for tests, examples and docs. The drafts set both. A repo tour names every box of its overview map, or the ones it skips (`tour-covers-map`).
- **Comparisons.** A note that compares 2-4 things may hold a small table under its sentences (`writing.md`, section 1).

## Writing

Read `reference/writing.md` before you write text. It has the fields, the rules (Orwell's six and ASD-STE100), the word list and the checklist. In short: plain words, one topic per sentence, active voice, at most 20 words in an instruction and 25 in a description. `xpl lint` checks the mechanical part.

## Reading the code

- `xpl outline [--under <id>] [--depth n] [--kind method,function] [--keys]`: ids, lines, and fan-in and fan-out (`in=`/`out=` find the hubs).
- `xpl search <text> [-i] [--regex] [--under <dir|glob>] [--code]`: hits with the enclosing symbol id and `+offset`.
- `xpl show <id> [--refs]`: code as `<line> <offset>│ code`, and the refs. `xpl show --at base <path> [--lines a-b]`: a file before the change.
- `xpl refs <id> [--in|--out] [--kind call|read] [--depth n]`: what this calls, or who calls or reads it.

Paste ids exactly as printed; `+34..36` is the span `{"from": 34, "to": 36}`. Look up one command at a time in `reference/cli.md`.

The index shows less than runs:

- **A missing arrow proves nothing.** `xpl index` prints what it could analyse. Before you say two parts do not talk, check with `search` and `show`.
- **An interface method** has no body: `refs --out` lists its implementations as `impl` lines. Anchor the one that does the work.
- **A `call` ref to a type** is a construction. A `call` ref to a field is a call through a stored function: anchor the field and the function (`refs <field> --in`).
- **A method reached through a variable** (`await response(...)` runs `__call__`) has no callers in `refs --in`. `search` for the name, or find where the object is built.
- **A base-class method with no body** runs a subclass method: anchor the one that runs, and link them with an `llm` `calls` edge.
- **Event buses, DI, callbacks, HTTP handlers, queues and config keys** connect by name. `search` for `emit`, `on(`, `register` and the topic, route or key, then link with an `llm` edge.
- **A reaches C through B**, and B is not a box: draw one edge from A to C with `via: [B]` (`patch-format.md` 3.3).
- **A recursive function:** in its flow, a `next` link with `kind: "recurse"` goes back to the step where the call starts (`patch-format.md` 3.7).
- **Dependencies are not indexed.** Anchor the call site and describe nothing inside the library. Name a library as a caller only when a line in the repo shows it.
- Stay at `--depth 1` on a hub. Stop when the question has its answer.

## explain <question>: part of a project

1. **Entry point:** `search -i` the nouns and verbs of the question, and `outline --depth 2`. Pick the function where the flow starts or the decision happens.
2. **Draft:** `xpl draft path <name> <entry id> -o q.json` gives a sequence of the entry's direct calls and one tour step per main call. For a question with two halves, give two entries: `xpl draft path <name> <entry> <entry2>`.
3. **Trace:** `show <entry> --refs`, then the callees that matter. Note every guard on the path (`if`, early `return`, type checks).
4. **Shape:** drop the calls that do not matter. When the answer spans files, add a map and start the tour on it, with outside systems as role boxes. Add a flow when the point is a decision.
5. **Boundary:** anchor the target code, its direct callers, the callees that change the answer, and the tests that pin the behaviour.
6. **Reply:** answer the question and name the key functions.

## explain repo: the whole project

Three levels, each a zoom into a box of the level above (`opens`):

| Level          | Shows                                                                     | Boxes                                         |
| -------------- | ------------------------------------------------------------------------- | --------------------------------------------- |
| 1. System map  | the services, who uses them, and the stores, queues and outside APIs used | 3-7, each with a `role` and a `tech`          |
| 2. Inside      | the parts of one service, and the outside boxes each part talks to        | 4-8 `component`s with plain labels, and those |
| 3. Code (lazy) | the main path through a part: a sequence or a flow                        | on `expand`                                   |

1. **What it is:** read the README and package metadata (`xpl show file:README.md`, `outline --keys` on `package.json`, `pyproject.toml` or `go.mod`). Note the language, the kind of program and its purpose.
2. **Draft:** `xpl draft repo <name> -o repo.json` gives the system map (`view:system`), a map of each service's inside, edges to outside systems, and a tour. Treat its relationships as leads, and check each against the source.
3. **Outside systems:** the draft finds them from import lines. Read the code that builds each client, and name the real system ("Orders database", not "SQL database"). Check whether the default run uses it, or only an optional integration. Merge two boxes for one system, drop a library that is only imported, and add what imports miss (`search` for a URL or config key).
4. **Roles:** a box with a `role` (`service`, `database`, `queue`, `external`, `person`, ...) and a `tech` shows what it is. For a library, the library is the `system` box, and the program that uses it is `external` with `tech: "your app"`. A return value is an arrow label, not a box. A database or an outside API is a group with a role and no members, anchored at the code that talks to it (`patch-format.md` 3.10).
5. **Parts:** give each box one job and a label a manager understands ("Payments", not `pay_svc`). Merge folders into a group (`grp:<slug>`) where one job spans several. Each arrow gets a 1-4 word label for what passes ("stores orders").
6. **Main path:** when there is an obvious entry point (`main`, `cmd/`, a server), run `xpl draft path` on it. Let its part `opens` the sequence, and copy the view and the steps you keep into the repo patch.
7. **Tour:** follow the spine. The first step on the inside names the files left off the map, in one sentence. Offer 2-3 expansions in the reply.

## explain map: every file, in plain words

A quick map of what is in a project, file by file, often code an AI assistant wrote. The reader is the owner of the project, who may not read code.

1. **Draft:** `xpl draft map <name> -o map.json` makes one map per folder; a folder box zooms into its files. Each file's `TODO` lists what the index knows. Then run `xpl health`, a quick check for secrets in the code, committed `.env` files, large files and unused files.
2. **Write every box:** a label of 2-5 plain words ("Job queue", not `queue.ts`), and one sentence of about 120 characters at most. The sentence starts with a verb and says what the file does for the project. Use everyday words and no framework names, unless the user asks for a technical map. Write it from the `TODO`'s facts, and open the file (`xpl show file:<path>`) when they say too little. Folders get the same.
3. **Many boxes** (more than about 150): split the patch's `nodes` by map among parallel helpers if you can start them. Each helper keeps the ids, and lints and applies its own patch.
4. **Crowded folders:** the draft groups the files of a folder of more than 30 files that use each other. Name each group by the job its files share, or remove a group that is not one job.
5. **After work on the code:** `xpl update <name> --since <base> -o map.json` (`<base>`: the commit before the work; leave out `--since` while the work is not committed). It indexes, records the change and drafts the map again. The draft keeps the text, adds the new files and removes the boxes of deleted ones. It also adds `tour:changes-<head>`: its summary says what was asked, in the asker's words, and each step says how that file's change serves it. Do not commit for the user unless they ask.
6. **Reply:** the bundle path and the parts of the project in 3-5 lines. List each high-severity `xpl health` finding with its file, line, kind and fix. Never copy a secret value anywhere, not even in part; call it a quick check, not a security audit.

## explain change <base>..<head>: a PR, an MR or a branch diff

Follow `reference/explain-change.md`. It covers how to record the change, find its callers and tests, read the old code (`xpl show --at base`), check "before" claims, and order the tour.

## Working from a draft

A draft applies as it is. Each text holds `TODO: <what to write>`; each note starts `### TODO: ...`.

- **Write every `TODO`** after you read the code it anchors.
- **Fix the structure only where the code shows the draft is wrong.** Examples: a guessed caller that never runs the code, a call that does not matter, a box with two jobs. Otherwise keep its ids, anchors and view settings.
- **Add what the tour needs:** groups, flows, concepts, `llm` edges. `reference/patch-format.md` has a template per element; read sections 1 and 2, then only what you add.
- **Context code** you only show gets a file-relative `span` with no `symbol`, so it does not widen the bundle.

## Accuracy

The viewer shows each claim next to its code, so a wrong claim looks checked. Check every title, label, summary, `detail` and note against the `show` output of its anchors.

- **Only what the anchored code shows.** Delete what a callee does elsewhere and paths you did not read. Leave out what you cannot check, and name it in the reply.
- **The why needs a source.** Give the reason for a design only when the README, a doc, a code comment or a commit message states it. Anchor that line, or name the source ("The commit message says ..."). Otherwise state the consequence the code shows ("so a failed payment stops before the order is saved").
- **Guard conditions:** when the lines run only under a condition, name it ("when `metrics.enabled` is true") and anchor it.
- **Absolute words** (all, every, never, only) need proof in the anchored code. "Every caller" needs `refs --in` and an anchor at each site. Otherwise name the sites or narrow the claim.
- **Lists** read as complete: check that they are, or write "for example".
- **Code, not folklore:** "stops waiting after the timeout", not "kills the job", when the code only races a timer.
- **Changes:** "before" claims and test claims follow `reference/explain-change.md` sections 4 and 6.

## Check before you show it

1. **Accuracy pass.** If you can start a fresh subagent, give it the `xpl` path, the repo, the guide name and, for a change, the range. It checks each claim against its anchors (`xpl anchors <name>`), and each "before" claim against the base. It rates each claim correct, imprecise, overstated, unanchored or wrong, quotes the lines, and changes no file. Without a subagent, do a second, separate pass yourself, one claim at a time.
2. **Lint:** `xpl lint <name>`. `todo-left` must be zero. Fix the other findings, or say in the reply why you kept one (`--warn-only`).
3. **Re-read** the tour in order as a newcomer, with the checklist in `reference/writing.md` section 7.
4. **Ready:** `xpl ready <name>` checks the anchors against the current source, the required text and the reader lint. Fix every error. Record a justified omission with `--note "reason"`, and pass the same note to `bundle`. Never add or remove an author review in a patch.

## Show the result

- **`xpl bundle <name> -o <name>.html`** runs the ready check, then writes one HTML file that works offline. Give its path in remote or cloud sessions. `--tour tour:<slug>` opens a tour as a presentation. Add `--files boundary` for a change or a subsystem, so the callers, callees and tests come along. `--draft` is only for a preview the user asks for; say so in the reply. Attach or publish it only when asked: it holds their source code.
- **`xpl view <name>`** starts a local server for a user at the machine; run it in the background.
- **The reply:** first the answer in 3-6 sentences (for a change: the behaviour change, then the risk). Then one line each: the scope and any assumption; for a change, the changed files with `+/-` counts; what you checked by running code; what you left out; the bundle path. Say that `.explainer/` was written into the repo. Do not retell the tour.

## Change one thing cheaply

Patch only what changes, and lint the patch first.

- One element's text: `{id, summary}`. Rewrite the summary whole (hard rule 6).
- One step of a flow or sequence: the view's `stepsUpdate` with that step.
- One tour step: `{"tours": [{"id": "tour:x", "stepsUpdate": [{"id": "t3", "note": "..."}]}]}`. Send `steps` whole only to add, remove or reorder steps.
- A box on a map: `includeAdd` / `includeRemove`. Other lists (`members`, `participants`, `anchors`) replace whole (`patch-format.md` section 4).
- Use `--actor user` only for text the user dictates.

## expand <node>

`<node>` is an id or name, a box outside the map that the user clicked (`ghost:dir:x` means `dir:x`), or a saved request.

1. Resolve it to an id and read it: `show <id> --refs`, `outline --under <id> --depth 1`.
2. Add it and the children worth showing with `includeAdd` on the graph view. A view with `origin: "user"` takes no `llm` edit: make a new view.
3. `status <name>` names what became visible without a summary. Explain those and only those.
4. For saved requests, follow "feedback". Never delete the request store.

## feedback

Readers save requests in the Feedback panel or with "Explain this". Saving a request starts no work. Import an offline file first: `xpl feedback <name> --import <file>`. Then follow `reference/revise.md`: select the request ids, write one patch per request, and show the review. Accept only after the author agrees.

## make tour

A presentation built from existing views, by the rules of "The tour". By default, use the newest question's views and the overview; ask when there are several. Give it a slug with `talk` (`tour:talk-retries`), so `xpl lint` keeps each note short enough for Present. Check with `xpl anchors <name> tour:<slug>`, then `xpl bundle <name> -o talk.html --tour tour:<slug>`.

## After the code changed

Run `xpl index` and `xpl resolve <name> --write`, then work through `xpl status <name>` with `reference/patch-format.md` section 8. Rewrite each drifted text whole, at its level: the summary still says what the part is for. A new feature gets a step, a concept or a `detail` line, never one more sentence on a summary. For a map, `xpl update` does the bookkeeping ("explain map", step 5). Ask the user before you re-anchor or remove a missing anchor. `xpl validate <name>` must pass before you finish.

## Reference

- `reference/quick.md`: the one-page summary, and the table that picks a diagram for each question.
- `reference/writing.md`: the writing rules, the word list and the checklist.
- `reference/create.md`: install, entry prompts, the PR handoff and recovery.
- `reference/explain-change.md`: the guide for a PR, MR or branch.
- `reference/patch-format.md`: a template per element, merge rules, provenance, rejections and repair.
- `reference/revise.md`: how to work through saved feedback.
- `reference/cli.md`: every command and option.
- `reference/examples/go-retry.patch.json` (a question) and `py-overview.patch.json` (a repo, from the system map down): finished patches for `fixtures/go-jobrunner` and `fixtures/py-jobrunner`. Read them for the text.
