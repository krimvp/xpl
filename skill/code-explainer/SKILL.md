---
name: code-explainer
description: Generate an interactive code explainer, meaning a short guided tour with linked diagrams (box-and-arrow map, process flow, sequence diagram) next to a code viewer, where clicking a box, arrow or step highlights the exact code and selecting code lights up the matching diagram elements. Use when the user wants to understand how code works ("how does X work", "how does a failed job get retried"), get an architecture overview of a repo, understand or review a change (a PR, MR, branch or commit range, read locally), explore an unfamiliar codebase, see what every file of a project does (a quick map, for example of code an AI assistant wrote, kept current after each change), or prepare a code walkthrough, demo or presentation. Operations - explain <question> (part of a project), explain repo (architecture), explain map (every file, in plain words), explain change <base>..<head> (a diff), explain live (the architecture and the change in progress, kept current while the code changes, for example while working with an AI assistant), expand (grow a view), feedback (do what the user asked for in the viewer), make tour (a presentation).
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
2. **Read before you claim.** A ref is a lead until you read the call. So is a caller or test that a draft marks as a guess.
3. **Do not change the user's repo or remotes.** Never post, comment, push or change their checkout; `.explainer/` is the only exception.
4. **Keep patches and output files outside the repo**, in the scratchpad or `$TMPDIR`.
5. **The user's edits win.** Never overwrite `origin: "user"` elements or `userFields`; for a view or tour they edited, make a new one or ask.
6. **Rewrite whole, never append.** When the code or the question changes, rewrite each text at its level; never add a sentence to an old summary.
7. **`llm` edges only for what the index cannot see**, anchored at both ends (with `via`: at each hop the index does not show).
8. **Stable ids.** Choose each slug once, in kebab-case, and never renumber or reuse a step id.
9. **Few things at the same level:** one primary tour, the budget's concepts, and only the views a tour step uses or a box `opens`. Explain what a view shows, and leave the rest for `expand`.
10. **Ask, do not guess**, when the scope is ambiguous or you cannot find an anchor.
11. **Never copy a secret value**, not even in part: name the file, the line and the kind of secret.

## Start here

1. **The CLI.** It is `bin/xpl` in this skill's directory; below, `xpl` means that path, written in full. If it does not run, follow `reference/create.md`, "Install".
2. **The target.** List `.explainer/*.explainer.json`. Extend a guide only when the user names it; a name collision is not permission to extend it. Before you extend one, read its views, tours and `userFields`, and use fresh ids.
3. **The purpose.** Before you draft, write three lines: what the code is for, where the answer sits, and the answer. Take the first line from the README, the package metadata or the entry point; if no source says it, ask. The answer is the first sentence of the tour summary (for a repo, the first line is).
4. **The scope.** Choose it with the table below. When the request can mean two things (which service, which branch), ask one short question with options. Otherwise state your assumption.
5. **The diagrams.** Choose each one with `reference/quick.md`, "Choose the diagram for the question".

## Choose the scope

Each scope starts its tour on a map and ends on the step in the last column.

| Request                        | Scope and draft                                        | First step (a map)                       | Last step                                    |
| ------------------------------ | ------------------------------------------------------ | ---------------------------------------- | -------------------------------------------- |
| "how does X work"              | `explain <question>`: `draft path <name> <entry>`      | what this part is for, where it sits     | the failure path, then what the tour skipped |
| "what kinds of X are there"    | `explain <question>`: `draft class <name> <type>`      | what the type is for                     | which one to use when                        |
| "what states can X be in"      | `explain <question>`: `draft states <name> <type>`     | what the thing is, and why it has states | the moves the code never makes               |
| "what data does X keep"        | `explain <question>`: `draft data <name> [<scope>]`    | the main type and what it holds          | the types left off the map                   |
| "explain this repo"            | `explain repo`: `draft repo <name>`                    | the system map: purpose, users, needs    | the parts skipped, and 2-3 expansions        |
| "map every file"               | `explain map`: `draft map <name>`                      | what the project is                      | where a newcomer starts reading              |
| a PR, a branch, a commit range | `explain change <base>..<head>`: `draft change <name>` | what changes for users                   | risks and open questions                     |
| "show me what I am changing"   | `explain live`: `xpl live`, then `reference/live.md`   | the change on the map of the parts       | what to check next                           |

Data map or class map, and states with no enum: `reference/quick.md`, "Choose the diagram for the question".

For a GitHub PR handoff (`handoff.json`), follow `reference/create.md`, "Author through the installed commands".

**Sketch first.** The user may want the big picture before the code ("roughly how would this work"). Then start with a sketch view of 3-7 boxes, and say that it is a sketch (`patch-format.md` 3.12).

**Fast mode** ("quickly", "the gist"): keep the draft's one diagram and write its text. Cut the tour to about 5 steps; for a change, keep the first and the last step. Add no other views, concepts or `llm` edges. The accuracy rules still apply. Offer the full guide in the reply.

## Workflow

1. **Index:** `xpl index`, and again when the code changes or a command says the index `does not match the working tree`. On Rust, read the coverage lines `xpl index` prints before you describe a path: it has heuristic calls in a few forms. Ruby and PHP have no references, so `draft path` stops: write the map and the sequence by hand (`reference/patch-format.md` 3.6, 3.8), and draw each call on the map as an `llm` edge anchored at both ends (3.3).
2. **Name:** `xpl new <name> --title "..."`. A change gets its own guide, titled after it: `xpl new <repo>-pr-42 --title "PR 42: <what it does>"`.
3. **A change only:** `xpl change <name> <base>..<head>` records it and prints its analysis.
4. **Draft:** `xpl draft <kind> <name> [<entry id>] --audience "<reader>" --question "<question>" -o <file>`, outside the repo. Each text of the draft holds `TODO: <what to write>`.
5. **Read and write.** Read the code of each anchor, then write every `TODO`. Every box, flow step and participant a view shows needs a `summary`, and so does every arrow you store. Change the draft's structure only where the code shows it is wrong, such as a guessed caller or a box with two jobs. For what you add (groups, frames, flows, concepts, `llm` edges), read `patch-format.md` sections 1 and 2, then that template. Done when no `TODO` is left and you read every claim.
6. **Lint, then apply:** `xpl lint <name> --patch <file> && xpl apply <name> <file>`. A rejection lists every error, with `Did you mean` and the fields to copy. Fix a `probably off by one` warning at once. Never weaken a claim to pass: what you cannot anchor, you cannot claim. Later, patch only the field that changes (`patch-format.md` section 4).
7. **Check:** `xpl validate <name>`; `xpl status <name>` until `to do: 0 with no text`; `xpl anchors <name> tour:<slug>` shows each step's code. Done when all three are clean.
8. **Accuracy pass and re-read.** Give a fresh subagent, if you can start one, the `xpl` path, the repo, the guide name and any change range. It checks each claim against `xpl anchors <name>` and each "before" claim against the base. It rates each claim correct, imprecise, overstated, unanchored or wrong, quotes the lines, and changes no file. Without a subagent, do a second pass yourself, one claim at a time. Fix each `xpl lint <name>` finding, or say in the reply why you kept it (`--warn-only`). Then re-read the tour as a newcomer, with the checklist in `writing.md` section 7.
9. **Ready and show:** `xpl ready <name>`, then `xpl bundle <name> -o <outside-repo>/<name>.html` (`--files boundary` for a change or a subsystem). Record a justified omission with the same `--note "reason"` on both. Never add or remove an author review in a patch. The bundle holds the user's source: attach or publish it only when asked.

**The reply:** first the answer in 3-6 sentences (for a question, name the key functions; for a change, the behavior change, then the risk). Then one line each: the scope and any assumption; for a change, the changed files with `+/-` counts; what you ran; what you left out; the bundle path. With what you ran, give each language's `refs:` value (precise, heuristic or none). Say that `.explainer/` was written into the repo, and that **Mark as reviewed** in the viewer records a review. Do not retell the tour.

## The tour

Every tour follows this spine. A change and a presentation end on their own point (the risk, or the last slide) instead of part 5. Each step holds one idea, one diagram and at most 2 code ranges.

| Part                  | What it says                                                           | Diagram                                    |
| --------------------- | ---------------------------------------------------------------------- | ------------------------------------------ |
| Purpose (the summary) | the answer in its first sentence, then up to 4 reasons                 | none                                       |
| 1. Big picture        | what the part is for, where it sits, who uses it                       | a map: the system, or where this part sits |
| 2. Parts              | one step per box that matters (repo), or the 2-3 actors (question)     | the same map, with one box in focus        |
| 3. One path in detail | the main path in run order, and the decision that changes the outcome  | one flow or sequence                       |
| 4. Edges and risks    | guards and failure paths; for a change, what still behaves the old way | the flow, or the code                      |
| 5. Where next         | 2-3 boxes or views the tour skipped, and the question each one answers | the map again, with those boxes in focus   |

Length budgets (the other files and the drafts follow this table):

| Scope            | Steps                                  | Note body (aim) | Tour summary  | Diagrams a tour uses           | Boxes per map          | Concepts |
| ---------------- | -------------------------------------- | --------------- | ------------- | ------------------------------ | ---------------------- | -------- |
| question, states | 5-8                                    | 25-40 words     | 2-4 sentences | 1 map, 1 flow or sequence      | 3-6                    | 0-2      |
| class, data      | 5-8                                    | 25-40 words     | 2-4 sentences | 1 map, 1 flow if items move    | 3-6, 8 with a note     | 0-2      |
| repo             | 6-9                                    | 25-40 words     | 3-5 sentences | system map, inside map, 1 path | 3-7 system, 4-8 inside | 0-3      |
| change           | 6-12                                   | 25-45 words     | 3-5 sentences | the change map, 1-2 flows      | 4-8                    | 0-2      |
| live (design)    | 4 + one per changed box, ≤ 12          | 25-45 words     | 3-5 sentences | system, design, parts          | 3-7 on the design map  | 0-2      |
| map              | 1 + top folders + where to start, ≤ 12 | 15-30 words     | 2-3 sentences | the folder maps                | one box per entry      | 0        |
| presentation     | 5-9                                    | ≤ 280 chars     | 2-3 sentences | existing views                 | ≤ 8                    | 0-1      |

This table is the one source of these numbers; the other files point here. Lint checks part of it: `tour-summary` (more than 5 sentences), `many-diagrams` (a question tour's diagrams), `many-ranges` (a step's code) and `long-flow` (a flow's steps). Keep to the rest yourself. A small subject can take fewer steps than the column: do not pad it. A second, in-detail tour of a repo may open one sequence per part, 1-2 steps each. A sequence has 3-6 participants in every scope. A flow has at most 8 steps: split a longer decision into two flows (which cases, then what happens in each). A class map or a data map may hold 8 boxes when each one answers the question; a step then names the types left off. `draft class` stops at 8 boxes, `draft data` at 6 (8 rows a table). Hard limits for every scope: a note body has 50 words at most (`long-note`). A box, concept or step `summary` has 2 sentences and 45 words at most, and says what the thing is for (`long-summary`). A `detail` paragraph has 80 words at most (`long-detail`).

- **One focus.** Each step focuses one main element, plus at most one concept that explains it.
- **Cut to the budget.** A draft can hold more steps than the budget. Merge steps that make the same point. Drop a call that does not change the answer, from the sequence and from the tour. Gaps in step ids are fine (`t1`, `t2`, `t5`).
- **Answer first, concepts before code:** `reference/writing.md` sections 4 and 6. Code ranges and maps: `reference/quick.md`, "What every patch needs".

## Writing

Read `reference/writing.md` before you write text. It has the fields, the rules (Orwell's six and ASD-STE100), the word list and the checklist. In short: plain words, one topic per sentence, active voice, at most 20 words in an instruction and 25 in a description. `xpl lint` checks the mechanical part.

## Reading the code

Read with `xpl outline`, `search`, `show <id> --refs` and `refs <id> --in|--out`; `reference/cli.md` has the options. Paste ids exactly as printed; `+34..36` is the span `{"from": 34, "to": 36}`. A missing arrow proves nothing, and dependencies are not indexed: anchor the call site, and describe nothing inside the library. Name a library as a caller only when a line in the repo shows it. Stay at `--depth 1` on a hub, and stop when the question has its answer.

Some calls do not show in `refs`: through an interface, a variable, a base class, an event or a config key. Before you say that two parts do not talk, read `reference/quick.md`, "When the index shows less than runs".

## explain <question>: part of a project

1. **Entry point:** `search -i` the nouns and verbs of the question, and `outline` (2 levels, or down to the first code file). Pick the function where the flow starts or the decision happens. A question with two halves takes two entries.
2. **A choice inside one function** (which item, which branch): draft from its caller, and add a **flow** of that function (`patch-format.md` 3.7). A sequence shows only calls, so it cannot show a guard or a comparison.
3. **Trace:** `show <entry> --refs`, then the callees that matter. Note every guard on the path (`if`, early `return`, type checks).
4. **Shape:** keep a frame on each loop and branch, and label it; give each `alt` one labeled arm per alternative (`patch-format.md` 3.8). An `if` that ends in `continue`, `return`, `break`, `raise` or `throw` is an `alt`, not an `opt`: the code after it is its `else` arm. Add a flow when the point is a decision. Anchor the target, its direct callers, the callees that change the answer, and the tests that pin it.

## explain repo: the whole project

Three levels, each a zoom (`opens`) into a box of the level above:

1. the system map: each box with a `role` and a `tech`;
2. the inside of one service: its `component`s, and the outside boxes they talk to;
3. the code of the main path: one sequence or flow in the first guide; more on `expand`.

Then:

1. **Draft:** `xpl draft repo` gives the system map, a map of each service's inside, and a tour. Its arrows and outside systems are leads: check each by `patch-format.md` 3.10, "Check the draft".
2. **Main path:** the `draft repo` tour has at most 7 steps, where next included, and leaves room for 2 steps: the main path and its risks. Run `xpl draft path` on the entry point it names (`main`, `cmd/`, a server, or for a library the method each request runs through). Keep 2 of its sequence steps, the answer and its risk, and put them before `### Where to go next`. Leave out its files map and its own tour: copy only the sequence view and those steps. Their ids are new to the guide, so copy them as they are. Set `opens` on the box that holds the entry point to the sequence's view id.
3. **Tour:** the first step on the inside names the files left off the map, in one sentence. Offer 2-3 expansions in the reply.

## explain map: every file, in plain words

A quick map of a project, file by file, often of code an AI assistant wrote. The reader is its owner, who may not read code. Follow `reference/explain-map.md`: `xpl draft map`, then `xpl health`. Each box gets a label of 2-5 plain words and one sentence of at most about 120 characters that starts with a verb; `xpl lint` checks both (`map-box`). The reply lists each high-severity `xpl health` finding with its file, line, kind and fix, and calls it a quick check, not a security audit.

## explain change <base>..<head>: a PR, an MR or a branch diff

Follow `reference/explain-change.md`. It covers the record of the change, its callers and tests, the old code (`xpl show --at base`), "before" claims and the tour order.

## Accuracy

The viewer shows each claim next to its code, so a wrong claim looks checked. Check every title, label, summary, `detail` and note against the `show` output of its anchors.

- **Only what the anchored code shows.** Delete what a callee does elsewhere and paths you did not read. Leave out what you cannot check, and name it in the reply.
- **The why needs a source:** the README, a doc, a code comment or a commit message. Anchor that line, or name the source ("The commit message says ..."). Otherwise state the consequence the code shows ("so a failed payment stops before the order is saved").
- **Guard conditions:** when the lines run only under a condition, name it ("when `metrics.enabled` is true") and anchor it.
- **Absolute words** (all, every, never, only) need proof in the anchored code. "Every caller" needs `refs --in` and an anchor at each site. Otherwise name the sites or narrow the claim.
- **Lists** read as complete: check that they are, or write "for example".
- **Code, not folklore:** "stops waiting after the timeout", not "kills the job", when the code only races a timer.
- **Changes:** "before" claims and test claims follow `reference/explain-change.md` sections 4 and 6.

## explain live: the architecture while the code changes

`xpl live` keeps the guide `live` in step with the working tree: the maps from the system down to the files, and the change since the base. Follow `reference/live.md`: after each task, write the `TODO` box texts and the tour `tour:live`, which says part by part what the change does to the architecture. When the change spans two or more parts, write its design level first: `grp:design-<slug>` boxes on `view:design` for the design concepts it touches, read before any folder or file. With `--backend claude` or `--backend api` a background run does it.

## expand <node>

`<node>` is an id, a name, a box outside the map that the user clicked (`ghost:dir:x` means `dir:x`), or a saved request. Read it (`show <id> --refs`, `outline --under <id> --depth 1`), and add it and the children worth showing with `includeAdd`. A view with `origin: "user"` takes no `llm` edit: make a new view. Explain only what `status <name>` names as newly visible. For saved requests, follow "feedback"; never delete the request store.

## feedback

Readers save requests in the Feedback panel or with "Explain this". Saving a request starts no work. Import an offline file first: `xpl feedback <name> --import <file>`. Then follow `reference/revise.md`: select the request ids, write one patch per request, and show the review. Accept only after the author agrees.

## make tour

Make a presentation from existing views. Follow "The tour" above and its presentation budget. Use the newest question's views and the overview; ask when there are several. Give it a slug with `talk` (`tour:talk-retries`), so `xpl lint` keeps each note short enough for Present. Check with `xpl anchors <name> tour:<slug>`, then `xpl bundle <name> -o talk.html --tour tour:<slug>`.

## After the code changed

Run `xpl index` and `xpl resolve <name> --write`, then work through `xpl status <name>` with `reference/patch-format.md` section 8. Rewrite each drifted text by hard rule 6. For a map, `xpl update` does the bookkeeping (`reference/explain-map.md`). Ask the user before you re-anchor or remove a missing anchor. `xpl validate <name>` must pass before you finish.

## Reference

- `reference/quick.md`: patch needs, diagram choice, index gaps, lint.
- `reference/writing.md`: writing rules and the checklist.
- `reference/create.md`: install, prompts, PR handoff, recovery.
- `reference/explain-change.md`, `reference/explain-map.md`, `reference/live.md`: those three scopes.
- `reference/patch-format.md`: element templates, merge rules, repair.
- `reference/revise.md`: saved feedback.
- `reference/cli.md`: every command and option.
- `reference/examples/`: `go-retry.patch.json` (a question) and `py-overview.patch.json` (a repo). Copy their text and the shape of their tours.
