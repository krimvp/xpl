# Quick reference

One page to keep open while you work. `SKILL.md` has the workflow and the length budgets; when the two differ, `SKILL.md` wins. `patch-format.md`, `writing.md` and `cli.md` have the details. `xpl` is `bin/xpl` in this skill's directory, written in full.

## What every patch needs

- **A summary for every box and participant** a view shows: overlays (`{id, summary}`) in the same patch as the view. `xpl status` counts the rest as unexplained. A summary has 2 sentences and 45 words at most, and says what the part is for.
- **A tour summary** that gives the answer in its first sentence, then up to four reasons. For a change, it gives the behaviour, the risk and the tests.
- **Notes** that start with `### Plain title`, then 1-3 short sentences (50 words at most; 280 characters in a presentation). A note may hold a small pipe table for a comparison.
- **`code` on every step**: at most 2 ranges, the one the note talks about first. For a before and after, put the base range first. Set `editor.primary` on the file the note is about. Ranges over 40 lines apart are separate places, and a slide shows at most 3 places of one file (`far-ranges`). Code that a step only shows gets a file-relative `span` with no `symbol`, so it does not widen the bundle.
- **Maps** with the box count of SKILL.md, "The tour": at most 8 on a map a tour shows (`big-map`). Keep about 2 arrows per box, and hide the rest with `hidden`. Every graph view a tour uses has `"stubs": {"mode": "none"}`; an overview has `excludeFiles` for tests, examples and docs. The drafts set both. A tour names every box of a small map it shows, or the ones it skips (`tour-covers-map`).
- **`llm` edges** only for what the index cannot see, anchored at both ends. An edge from a box to itself draws as a loop on it; in a flow, show recursion with a `recurse` link. A path through code that is not a box: one edge with `via`; a hop the index shows needs no anchors.

## Choose the diagram for the question

| Reader's question                                                      | View                                                                           | What its arrows mean                                                                                                             |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Who uses this program, and which outside systems or files does it use? | System map: a few services, people and stores. Start a repository guide here.  | A named, source-backed relationship, such as "starts it" or "reads settings".                                                    |
| Which parts own the work inside one service?                           | Component map: 4-8 parts, then open one part for a code-level map when needed. | A call or dependency between shown parts, or an authored relationship anchored at both ends. It does not say which runs first.   |
| Which symbols depend on this method or value?                          | Code map: a few files or symbols around the entry or shared value.             | A checked call, read or use; keep its `precise` or `heuristic` cue. It does not show runtime order.                              |
| Which parts depend on which, and are there cycles? (a dense map)       | Dependency matrix: a code or component map with `"render": "matrix"`.          | A row uses a column; the cell counts the references. A cell below the diagonal goes back up the order: with its mirror, a cycle. |
| What stages and decisions does one input go through?                   | Process flow: stages, branches and their conditions.                           | The next possible stage; label each branch with its condition.                                                                   |
| Who exchanges calls or events, and in what order?                      | Sequence: 3-6 participants and only the steps needed to answer the question.   | One anchored call or event at that point in the path. A call graph alone cannot prove runtime order.                             |
| How do two or three options, or a before and after, differ?            | No new diagram: a small table in the note.                                     | None.                                                                                                                            |
| What does this word mean here?                                         | A concept card, linked from the step that first uses the word.                 | None.                                                                                                                            |

Use one diagram per step, and add a new diagram only when the question changes. Put the question in each view's `scope.question`; the reader sees it with the view title. For a broad repository guide, pair the system or component map with one focused flow or sequence for an important path. In the Python job runner example, the system map answers who starts the program and what settings it reads. Its startup sequence follows the code that connects the parts. In the TypeScript job runner, the overview map names the parts and the dispatch sequence follows a job from queue to worker. Label an event arrow only when source at both ends supports the publish and receive path. A `heuristic` call edge is a lead to inspect, not proof of timing or an event.

## When the index shows less than runs

`xpl index` prints what it could analyse, and a missing arrow proves nothing. Before you say two parts do not talk, check with `search` and `show`. These patterns hide a call from `refs`:

- **An interface method** has no body: `refs --out` lists its implementations as `impl` lines. Anchor the one that does the work.
- **A `call` ref to a type** is a construction. A `call` ref to a field is a call through a stored function: anchor the field and the function (`refs <field> --in`).
- **A method reached through a variable** (`await response(...)` runs `__call__`) has no callers in `refs --in`. `search` for the name, or find where the code builds the object.
- **A base-class method with no body** runs a subclass method: anchor the one that runs, and link the two with an `llm` `calls` edge.
- **Event buses, DI, callbacks, HTTP handlers, queues and config keys** connect by name. `search` for `emit`, `on(` or `register` and the topic, route or key. Then link the two ends with an `llm` edge.
- **A reaches C through B**, and B is not a box: draw one edge from A to C with `via: [B]` (`patch-format.md` 3.3).
- **A recursive function:** in its flow, a `next` link with `kind: "recurse"` goes back to the step where the call starts (`patch-format.md` 3.7).

Java has a built-in pack with heuristic references; a checked SCIP artifact (`xpl index --scip`) makes them precise. Rust, Ruby and PHP have declarations only, and Rust also has heuristic calls in a limited set of forms. Read the coverage lines of `xpl index` before you describe a path in them (`cli.md`, `xpl index`).

## Lint findings, grouped

| Group            | Rules                                                                                                                                                                     | Usual fix                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Not written yet  | `todo-left` (an error)                                                                                                                                                    | write it                                                                                                                                             |
| Tour shape       | `tour-summary`, `tour-first-step`, `tour-covers-map`, `tour-length`, `tour-ends`, `unused-view`, `many-concepts`, `duplicate-step`, `connector-start`                     | start and end on the map; name every box; steps within the SKILL.md budget (5-8 for a question); show each diagram; say it once; a note stands alone |
| Titles           | `note-heading`, `untitled-step`, `code-title`, `placeholder-title`, `long-title`                                                                                          | `### Plain title` that says what happens                                                                                                             |
| Sentences        | `long-sentence`, `long-average`, `bare-it`, `abstract-subject`, `passive-voice`, `we-voice`, `dash-chain`, `tool-word`, `filler-word`, `absolute-word`, `repeats-summary` | one fact per sentence, active voice, the code as the subject; evidence next to the claim                                                             |
| Load             | `long-note`, `long-summary`, `long-detail`, `long-talk-note`, `code-heavy`, `flow-label-code`                                                                             | say the idea in plain words; keep one code name; rewrite a summary whole, never append                                                               |
| Markup           | `markdown-in-plain`, `markdown-in-summary`                                                                                                                                | plain titles; headings and links only in `detail`                                                                                                    |
| What readers see | `change-not-shown`, `far-ranges`, `big-map`, `crowded-map`, `system-map-no-edges`                                                                                         | add a step; split a step; group boxes; hide edges; check for source-backed relationships                                                             |

The hints name the limit a fix could trip: a full tour summary wants a long sentence shortened, not split.
