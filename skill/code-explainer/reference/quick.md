# Quick reference

One page to keep open while you work. `SKILL.md` says why; `patch-format.md`, `writing.md` and `cli.md` have the details. `xpl` is `bin/xpl` in this skill's directory, written in full.

## The loop

Choose the root, audience, question and guide name first. List existing guides; extend one only when it is the intended target. Use `reference/create.md` for installed entry examples and recovery. Pass `--audience` and `--question` to the draft. Patches and output snapshots go outside the indexed tree.

| Step              | Command                                                                      | Done when                                     |
| ----------------- | ---------------------------------------------------------------------------- | --------------------------------------------- |
| Index, name       | `xpl index`, `xpl new <name> --title "..."`                                  | the index matches the working tree            |
| A change only     | `xpl change <name> <base>..<head>`                                           | the analysis is printed                       |
| Draft             | `xpl draft path\|repo\|change <name> [<entry id>] -o <file>` (outside repo)  | the file has the structure and `TODO`s        |
| Read, write       | `outline`, `search`, `show <id> --refs`, `refs <id> --in\|--out`             | every `TODO` written, every claim read        |
| Lint, then apply  | `xpl lint <name> --patch <file> && xpl apply <name> <file>`                  | lint exits 0 (it exits 1 on any finding)      |
| Check             | `xpl validate <name>`, `xpl status <name>`, `xpl anchors <name> tour:<slug>` | valid, `0 unexplained`, each step's code fits |
| Accuracy, re-read | a fresh subagent or a second pass; `xpl lint <name>`                         | no claim beyond its anchors; `todo-left` 0    |
| Ready             | `xpl ready <name>` (`--note "reason"` for intentional omissions)             | no blockers; warning decisions recorded       |
| Show              | `xpl bundle <name> -o <name>.html` (`--files boundary` for a change)         | the path is in the reply                      |

Ready export checks the current source and required content before writing. Pass the same `--note` to `bundle`; a note never overrides an error. `--draft` is an explicitly labelled repair preview, not a finished guide. Inspect the offline HTML or open `xpl view <name>` locally before replying.

Keep a finding on purpose: `xpl lint ... --warn-only` (a `todo-left` error still exits 1), and say why in the reply.

Rust tags and Java artifact import are experimental. Rust uses `--precise off` for checked syntax
declarations and bounded heuristic calls between root-level functions in the same file. Other Rust
relationships remain unsupported; inspect the reported call limits before describing a path. Java needs a successful configured SCIP build; file anchors remain
available with `--precise off` when generation fails. Use `search` without `--code` and explicit Java views.
Do not treat a precise type mention as a call or inheritance edge. The measured rust-analyzer artifact
has no full ranges and currently erases tags on import, even when `--precise require` succeeds. See the
[language-support decision](../../../docs/assessment-2026-10-04-language-support.md) before choosing a path.

## What every patch needs

- **A summary for every box and participant** a view shows: overlays (`{id, summary}`) in the same patch as the view. `xpl status` counts the rest as unexplained.
- **A tour summary** of 2-4 sentences (5 for a change): what it is, why it matters; for a change, the behaviour, the risk, the tests.
- **Notes** that start with `### Plain title`, then 1-3 short sentences (60 words at most; 280 characters in a talk).
- **`code` on every step**: at most 2 ranges, the one the note talks about first. Ranges over 40 lines apart are separate places, and a slide shows at most 3 places of one file (`far-ranges`).
- **Maps** of 4-8 boxes (3-7 on a system map), `"stubs": {"mode": "none"}`, at most about 2 arrows per box (hide the rest with `hidden`).
- **`llm` edges** only for what the index cannot see, anchored at both ends (an edge from a box to itself draws as a loop on it; in a flow, show recursion with a `recurse` link). A path through code that is not a box: one edge with `via`; a hop the index shows needs no anchors.

## Choose the picture for the question

| Reader's question                                                      | View                                                                           | What its arrows mean                                                                                                           |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Who uses this program, and which outside systems or files does it use? | System map: a few services, people and stores. Start a repository guide here.  | A named, source-backed relationship, such as "starts it" or "reads settings".                                                  |
| Which parts own the work inside one service?                           | Component map: 4-8 parts, then open one part for a code-level map when needed. | A call or dependency between shown parts, or an authored relationship anchored at both ends. It does not say which runs first. |
| Which symbols depend on this method or value?                          | Code map: a few files or symbols around the entry or shared value.             | A checked call, read or use; keep its `precise` or `heuristic` cue. It does not show runtime order.                            |
| What stages and decisions handle one input?                            | Process flow: stages, branches and their conditions.                           | The next possible stage; label each branch with its condition.                                                                 |
| Who exchanges calls or events, and in what order?                      | Sequence: 3-6 participants and only the steps needed to answer the question.   | One anchored call or event at that point in the path. A call graph alone cannot prove runtime order.                           |

Put the question in each view's `scope.question`; the reader sees it with the view title. For a broad repository guide, pair the system or component map with one focused flow or sequence for an important path. In the Python job runner example, the system map answers who starts the program and what settings it reads; its startup sequence follows the code that connects the parts. In the TypeScript job runner, the overview map names the parts and the dispatch sequence follows a job from queue to worker. Label an event arrow only when source at both ends supports the publish and receive path. A `heuristic` call edge is a lead to inspect, not proof of timing or an event.

## Writing in one breath

Plain words first, code names second: a note names at most 3 pieces of code (1 on an architecture map, 2 in a tour summary). Example values in backticks (`503`, `-1`, `null`, `/admin/*`) are fine and do not count. Sentences of 15-20 words, never over 25, each naming its subject (not a bare "It"). No marketing words. An absolute word (all, every, never, only) needs its evidence next to it: on an element with anchors, or in a note sentence that names the part the step shows. Lists read as complete, so check them or write "for example". Name each map box in some note, by its label in plain words ("the web server" counts for "Web servers").

## Lint findings, grouped

| Group            | Rules                                                                                         | Usual fix                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Not written yet  | `todo-left` (an error)                                                                        | write it                                                                                 |
| Tour shape       | `tour-summary`, `tour-first-step`, `tour-covers-map`, `tour-length`                           | start on the map; name every box; 5-9 steps                                              |
| Titles           | `note-heading`, `untitled-step`, `code-title`, `placeholder-title`                            | `### Plain title` that says what happens                                                 |
| Sentences        | `long-sentence`, `long-average`, `bare-it`, `filler-word`, `absolute-word`, `repeats-summary` | one fact per sentence; evidence next to the claim                                        |
| Load             | `long-note`, `long-talk-note`, `code-heavy`, `flow-label-code`                                | say the idea in plain words; keep one code name                                          |
| Markup           | `markdown-in-plain`, `markdown-in-summary`                                                    | plain titles; headings and links only in `detail`                                        |
| What readers see | `change-not-shown`, `far-ranges`, `big-map`, `crowded-map`, `system-map-no-edges`             | add a step; split a step; group boxes; hide edges; check for source-backed relationships |

The hints name the limit a fix could trip: a full tour summary wants a long sentence shortened, not split.
