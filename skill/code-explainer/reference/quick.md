# Quick reference

One page to keep open while you work. `SKILL.md` says why; `patch-format.md`, `writing.md` and `cli.md` have the details. `xpl` is `bin/xpl` in this skill's directory, written in full.

## The loop

| Step              | Command                                                                      | Done when                                     |
| ----------------- | ---------------------------------------------------------------------------- | --------------------------------------------- |
| Index, name       | `xpl index`, `xpl new <name> --title "..."`                                  | the index matches the working tree            |
| A change only     | `xpl change <name> <base>..<head>`                                           | the analysis is printed                       |
| Draft             | `xpl draft path\|repo\|change <name> [<entry id>] -o <file>` (outside repo)  | the file has the structure and `TODO`s        |
| Read, write       | `outline`, `search`, `show <id> --refs`, `refs <id> --in\|--out`             | every `TODO` written, every claim read        |
| Lint, then apply  | `xpl lint <name> --patch <file> && xpl apply <name> <file>`                  | lint exits 0 (it exits 1 on any finding)      |
| Check             | `xpl validate <name>`, `xpl status <name>`, `xpl anchors <name> tour:<slug>` | valid, `0 unexplained`, each step's code fits |
| Accuracy, re-read | a fresh subagent or a second pass; `xpl lint <name>`                         | no claim beyond its anchors; `todo-left` 0    |
| Show              | `xpl bundle <name> -o <name>.html` (`--files boundary` for a change)         | the path is in the reply                      |

Keep a finding on purpose: `xpl lint ... --warn-only` (a `todo-left` error still exits 1), and say why in the reply.

## What every patch needs

- **A summary for every box and participant** a view shows: overlays (`{id, summary}`) in the same patch as the view. `xpl status` counts the rest as unexplained.
- **A tour summary** of 2-4 sentences (5 for a change): what it is, why it matters; for a change, the behaviour, the risk, the tests.
- **Notes** that start with `### Plain title`, then 1-3 short sentences (60 words at most; 280 characters in a talk).
- **`code` on every step**: at most 2 ranges, the one the note talks about first, close together in one file (a slide shows one range; 40 lines apart is too far).
- **Maps** of 4-8 boxes (3-7 on a system map), `"stubs": {"mode": "none"}`, at most about 2 arrows per box (hide the rest with `hidden`).
- **`llm` edges** only for what the index cannot see, anchored at both ends, between two different boxes (a map does not draw an edge from a box to itself; show recursion in a flow or sequence step).

## Writing in one breath

Plain words first, code names second: a note names at most 3 pieces of code (1 on an architecture map, 2 in a tour summary). Example values in backticks (`503`, `-1`, `null`, `/admin/*`) are fine and do not count. Sentences of 15-20 words, never over 25, each naming its subject (not a bare "It"). No marketing words. An absolute word (all, every, never, only) needs its evidence next to it: on an element with anchors, or in a note sentence that names the part the step shows. Lists read as complete, so check them or write "for example". Name each map box in some note, by its label in plain words ("the web server" counts for "Web servers").

## Lint findings, grouped

| Group            | Rules                                                                                         | Usual fix                                         |
| ---------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Not written yet  | `todo-left` (an error)                                                                        | write it                                          |
| Tour shape       | `tour-summary`, `tour-first-step`, `tour-covers-map`, `tour-length`                           | start on the map; name every box; 5-9 steps       |
| Titles           | `note-heading`, `untitled-step`, `code-title`, `placeholder-title`                            | `### Plain title` that says what happens          |
| Sentences        | `long-sentence`, `long-average`, `bare-it`, `filler-word`, `absolute-word`, `repeats-summary` | one fact per sentence; evidence next to the claim |
| Load             | `long-note`, `long-talk-note`, `code-heavy`, `flow-label-code`                                | say the idea in plain words; keep one code name   |
| Markup           | `markdown-in-plain`, `markdown-in-summary`                                                    | plain titles; headings and links only in `detail` |
| What readers see | `change-not-shown`, `far-ranges`, `big-map`, `crowded-map`                                    | add a step; split a step; group boxes; hide edges |

The hints name the limit a fix could trip: a full tour summary wants a long sentence shortened, not split.
