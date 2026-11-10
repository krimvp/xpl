# live: the architecture and the change, while the code changes

`xpl live` keeps one guide (`live` by default, `.explainer/live.explainer.json`) in step with the working tree. The user leaves it running next to their coding session, often with an AI assistant. After every edit it indexes the code, moves the guide to the new index, records the change from the base to the working tree, and drafts the maps again. Nobody writes text in that loop: you do. The hard rules, the writing rules and the accuracy rules of `SKILL.md` still apply.

## What xpl keeps, and what you write

xpl owns the structure. Do not add, remove or move boxes, views or arrows, and never touch `change`.

| Level             | View                                                       | Boxes                                                    |
| ----------------- | ---------------------------------------------------------- | -------------------------------------------------------- |
| 1. The system     | `view:system`                                              | who uses the project, the project, what it relies on     |
| 2. Its parts      | `view:overview` (`view:<service>-inside` for each program) | the parts (`dir:` or `file:` boxes), the outside systems |
| 3. A part's files | `view:map-<folder>` (`view:map` is the top folder)         | one box per file                                         |
| 4. The code       | the editor                                                 |                                                          |

The service box `opens` level 2, and a part that is a folder `opens` its level 3 map. The change itself is in `change`: `base` (a full SHA), `head` (the index commit id, `wt-…`, with `worktree: true`), and `files`, each `added`, `modified`, `deleted` or `renamed` with its hunks. A deleted file has no box any more: name it in the text of its part. The viewer shows it from the change record.

You write two things:

1. **The box texts.** Every `TODO` label and summary. A part gets a label of 1-3 plain words and one line on what it does for the project. A file gets a label of 2-5 plain words and one sentence of about 120 characters at most that starts with a verb (`explain-map.md` step 2; `xpl lint` checks it as `map-box`). Write the boxes of the changed files and their parts first, then the rest of level 2, then the rest. A text without `TODO` stays as it is, unless its code changed (`xpl status live` lists the drifted ones): then rewrite it whole (hard rule 6).
2. **The tour `tour:live`.** One tour, always this id, rewritten whole after each task. It says what the change does to the architecture, top-down:
   - **Title:** 2-6 plain words for what the change does ("Retries move into the queue").
   - **Summary:** 2-5 sentences. First what the change does to the design: which parts are new, changed or removed, and what now uses what. Then why, in the words of whoever asked, when you know it. Then the risk.
   - **Step `big-picture`**, on `view:system` with the project in focus: what the change does at the top, in one or two sentences (a new outside system, a new way in, or "inside the project only").
   - **Step `parts`**, on level 2 with the changed parts in focus: which parts change, before and now.
   - **One step per changed part**, id `part-<folder slug>` (`part-src-store`), so it keeps its id across runs. On that part's level 3 map with its changed files in focus, or on level 2 when the part is one file. Its note: `### <what changed in this part>`, then "Before: … Now: …" in at most 45 words. Name the deleted files there.
   - **Step `next`**, last, on level 2, its note headed `### Where to go next`: what to check before the change is done (tests that do not cover it, callers that still behave the old way).
   - A focus id must be on the step's view. A step shows the code of its focus, at most 2 ranges: when its focus holds more, give `code` yourself, at most 2 whole-file anchors of changed files (`{"file": "src/store/memory.ts", "role": "definition"}`). Show a deleted file's old code the same way with `"at": "base"`.

Read each changed file before you claim what it does. For "before" claims, read the code before the change (`xpl show --at base <path>`, or the `before/` folder of a background run) and follow `explain-change.md` section 4. When nothing changed (no `change`), write only the box texts: xpl removes `tour:live` itself.

## After each task, with your own agent

With `xpl live` running and no backend (the default), nothing writes the text until you ask. At the end of each task:

1. Wait until `xpl live` printed a line for your last edit, or run `xpl live --once` when it is not running (in a hook, or by hand). The guide is then on the current code.
2. Run `xpl change live` (the files, symbols, callers and tests of the change) and `xpl status live` (what has no text yet, and what drifted).
3. Write one patch with the box texts and `tour:live`, outside the repo, and run `xpl lint live --patch <file>`. Fix every finding on an element your patch changes. The others are the `TODO`s still to write and the maps no tour shows, so `lint` exits 1 until every box is written: do not wait for that. Then `xpl apply live <file>`. The page shows it at once.

## A background run

With `xpl live --backend claude`, xpl runs Claude Code once the code has been quiet for 20 seconds (`--agent-quiet`). That run is you. You cannot run commands: read the guide file, the repository and the `before/` folder that the prompt names. Write exactly one patch, a JSON object, to the output file. Use only ids the guide has. xpl lints it and applies it as actor `llm`. When it does not apply, or lint finds something on an element you changed, you get one more try with the findings. That try is applied unless it is rejected or leaves a `TODO` on what it changed. When the code changes while you write, xpl runs you again on the new code.
