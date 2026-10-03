# Reviewer persona: Lena, ky maintainer, reviewing PR 0d59458 "Add maxResponseSize option"

Viewports: 1440×900 and 1280×720, light. Bundles: `out/ky-change.html` (default) and `out/ky-change-boundary.html`
(`--files boundary`). I checked everything against `git show 0d59458` in `proj/ky-change`.
Screenshots: `reviews/shots/reviewer/` (19 files).

## 1. Tasks

| # | Task | Result | Effort | Where I got stuck |
|---|---|---|---|---|
| 1 | "Is this PR safe to merge? What changes for users, risks, tests?" from the explainer alone | **Success** | ~5 min to read 12 steps | Nowhere. The summary plus step 12 "Risk" gave me a merge view faster than GitHub would. The diff check (task 3) shows the summary is a little too reassuring. |
| 2 | Walk every changed file with Files in this change, tree marks, n/p, Before panes, inline removed lines, callers, map box details | **Partial** | ~15 min | The file walk itself is good. "Added by / Edited by this change" + "Show the change" is hidden inside the collapsed "Where this is in the code" disclosure, so a reader never sees it without being told. 6 of 15 changed files are never anchored by a tour step: `types/options.ts` (the public option type and JSDoc), readme, `index.ts`, `HTTPError.ts`, `KyError.ts`, `test-d`. |
| 3 | Is anything missing or misrepresented? Are the "before" claims right? | **Success** (as a check) | ~15 min with git | All five base-anchor claims (t30, t40, t60, t70, t80) are correct and their Before panes show the right old lines. I found one wrong flow attribution, one claim that is too broad, and three diff details the explainer skips (below). |
| 4 | Default vs `--files boundary` | **Success** | ~3 min | The boundary bundle adds 5 unchanged files (`errors/ForceRetryError.ts`, `errors/TimeoutError.ts`, `utils/merge.ts`, `utils/normalize.ts`, `utils/options.ts`). No step, link or caller row points to them, so you only reach them through the tree. `utils/options.ts` (`findUnknownOptions`) and `utils/merge.ts` would have let me check steps 10 and 11, but nothing tells me so. The gain is marginal. |

### Verdict I reached as Lena
Mergeable. The design is sound and the tests are thorough (about 45 test cases, 2 browser tests), with these asks:
- No test covers an invalid cap on `ky.create()`/`.extend()`. The explainer flags this gap, and it is correct.
- A bad cap fails with a sync `TypeError` from the constructor. A bad `timeout` fails with an async `RangeError` inside `function_`. That inconsistency is worth a comment. The explainer does not mention it.
- The 10 MiB `error.data` cap interacts with the new option. The "retries stop" risk only applies when the cap is below the bytes read for the error body. The explainer does not mention this.

## 2. Ratings (L4 change/PR level only)

| | Default bundle | Boundary bundle |
|---|---|---|
| Comprehension | 4.5 | 4.5 |
| Navigation | 3.5 | 3.5 |
| Code readability | 4 | 4 |
| Diagram usefulness | 3 | 3 |
| Trust | 3.5 | 3.5 |
| **Overall** | **4** | **4** (no gain over the default) |

Compared with GitHub's diff view: xpl is **better for understanding and deciding** (narrative order, a named risk, a test-gap callout, before and after side by side for the claims that matter, A/M tree, Files list with +/−). It is **worse for exhaustive line-by-line review**:
- There is no "all files, one scroll" unified view. You go file by file.
- There is no word-level (intra-line) highlight. `} catch {` → `} catch (error) {` shows as a whole removed line plus a whole added line.
- There is no line commenting.

I would use xpl first, then GitHub to leave comments.

## 3. Findings

### VIEWER

| id | sev | bundle | What I saw | Evidence | Suggested fix |
|---|---|---|---|---|---|
| V1 | major | both | "Added by this change"/"Edited by this change" + "Show the change" lives only inside the collapsed `<details>` "Where this is in the code" in the right panel. Clicking a New/Changed box shows only the summary, so the fix from the last round is effectively invisible in Read mode. | def-map-limitResponseSize.png (closed), def-map-details-open.png (opened by hand). `Workspace.tsx:238` wraps `<Details reader>` in a closed `<details>`. | In a change explainer, put the ChangeOfElement row ("Added by this change · +24 −0 · Show the change") under the topic summary, outside the disclosure. |
| V2 | minor | both | "Edited by this change" has no +/− count. Only New elements get counts. A reviewer wants "+5 −1 in it" for `#readResponseText`. | def-map-details-open.png | Show the per-element hunk counts that `callers.ts` already computes for changed elements. |
| V3 | minor | both | The pane header "in X" names the symbol at the top line of the viewport, not the one in focus. While the focus is `copyResponseMetadata` (changes 4/8, step 6), it says "in withProgress". | def-body-n3.png, def-step6-before.png | Use the symbol that holds the focused or first visible change hunk, or the symbol at about 1/3 viewport height where the jump lands. |
| V4 | minor | both | The mini diagrams in guide steps are cropped. In step 4 the map boxes are cut at the left ("y.constructor", "ethod") and top. In steps 6 and 12 the flow decision diamond is cut in half. | def-step4-guide.png, def-step6-guide.png, def-1280-step12.png | Fit the mini view to the step's focus plus its neighbours, with padding, or fit the whole view when it is small (9 boxes here). |
| V5 | minor | both | The Before pane badge says "used here", which is meaningless on base code. The Before header says "7 changes" while the head header says "12 changes" for the same file. Both look like errors. | def-step8-before.png, def1280-step7-before.png | Label the base anchor "before" (or no role). Explain the count ("7 places with removed lines") or hide it on the base pane. |
| V6 | minor | both | The "Show changes" toggle is labelled the same when on and off (the pressed state is only a green fill). It reads as an action that has not been done yet. | def-body-open.png | Use "Changes: shown / hidden", or a checkbox style. |
| V7 | minor | both | The tree is 160 px wide at 1440, so `test-d/response-siz…` and `test/response-siz…` are indistinguishable. `ResponseS…` is truncated too. The tooltip helps (`source/core/Ky.ts: changed, +27 −7`). | def-body-open.png | Allow drag-resize, or widen to the longest changed name when the file count is small. |
| V8 | minor | both | When code opens beside the map, the map does not refit, so boxes are clipped at the split. | def-map-showchange.png | Refit on container resize. |
| V9 | polish | both | In "Files in this change", the New and Changed pills differ in width, so the path column zig-zags. `test-d/response-size.ts` has no "test" tag. | 01-open-1440.png | Fixed-width status column. Treat `test-d/` (and `*.test-d.ts`) as tests. |
| V10 | polish | both | A flow step drawn from A to B shows only A as the box subtitle. For a terminal step whose code is in B, this misattributes it (see C1). | def-step6-guide.png | Show the participant that owns the step's anchor, or "A → B". |
| V11 | minor | boundary | Boundary files are listed without any marker. No step, caller row or link reaches them. The footer "20 of 103 files" is the only hint that they exist. | bnd-codetab.png, bnd-merge.png | Mark them "context: callee of Ky.create" in the tree, and make symbol names in code clickable (go to definition) when the target is embedded. |

### CONTENT (what Claude wrote)

| id | sev | What I saw | Evidence | Suggested fix |
|---|---|---|---|---|
| C1 | major | Flow step `size-flow:7` "Reject the body read" is drawn `from Ky.#readResponseText`. Step 6 says "This call: Ky.#readResponseText → Reject the body read → copyResponseMetadata". This is wrong: the user's own `text()`/`json()` never pass through `#readResponseText`, which only fills `HTTPError.data`. The diagram tells the reviewer the two failure paths share code when they don't. | def-step6-guide.png; `change.json` size-flow:7 `"from": "sym:…Ky.#readResponseText"` | From `limitResponseSize` (stream error) to `copyResponseMetadata` (body-method wrapper). |
| C2 | minor | The summary says "Without the option nothing changes". But the `onDownloadProgress` path changed for every user: no more `response.clone()` + cancel, and `streamResponse` now wraps the original. A test was renamed from "cancels original response body" to "consumes original response body". Step 8 describes this, but only as a cap feature. | `git show 0d59458 -- source/core/Ky.ts test/stream.ts` | Say it: "Without the option, only the download-progress path changes: it no longer clones." |
| C3 | minor | These details are not mentioned: `readAll.finally(...).catch(() => undefined)`, which is new because `readAll` can now reject, and an unhandled-rejection guard a reviewer must notice. `streamResponse` now uses `new Response(body, response)` as its init. `isKyError` is now also checked by name (it is not just inherited through `extends KyError`). | Ky.ts L936, body.ts streamResponse | One sentence each in steps 7, 8 and 9. |
| C4 | minor | 6 of 15 changed files are never anchored by any step. The most important is `source/types/options.ts`, the public type and the JSDoc users read. Step 9 talks about the HTTPError, KyError and hooks docs, but its code shows only ResponseSizeError.ts and type-guards.ts. | `change.json` anchors cover 9 files | Anchor `types/options.ts` in step 3 and `hooks.ts` in step 12. |
| C5 | minor | The risk misses two things: the retry stop only happens when the cap is below the 10 MiB `error.data` read limit, and bad-cap validation is sync while `timeout` validation is async. | `Ky.ts` L189–195 vs L413 | Add both to step 12. |
| C6 | polish | The summary frames the risk as "no longer retried". Retries never applied before, because the option is new. It is a deliberate design (the readme says "without automatically retrying"), not a regression. | step 12 / summary | "is not retried (by design)". |
| C7 | polish | The map has 3 islands (Tests, `#readResponseText`, `constructor`), and the Tests group is marked "Changed" although 2 of its 3 files are new. | def-map.png | The author's log already flags the missing "A reaches C through B" edges. A group pill could say "New + Changed". |

All other claims check out against the diff:
- the 🦄 4-byte example and the Content-Length test
- validation values and the sync throw before fetch
- capping before the first hook clone, and on hook-returned responses
- `>` vs `==` at the edge
- the Chromium TypeError comment
- the size error rethrown before `#retryFromError` (test: `fetchCount === 1`)
- `kyOptionKeys`, and `#getNormalizedOptions` dropping the option
- "more than 30 tests", and the `ky.create()` test gap

### AUTHORING TOOL

| id | sev | What | Evidence |
|---|---|---|---|
| A1 | minor | `--files boundary` picked 5 callee files that the explainer never names. It added no test helpers and no caller files. `index.ts` is the only caller, and it is already a changed file. The selection is not driven by what the steps discuss. | ky-change-authoring.md, bnd-codetab.png |
| A2 | minor | The `code-heavy` and `absolute-word` lint rules made the author remove backticks from concrete values ("a 503", "a negative number, a fraction or null"). For a reviewer, the concrete inputs are the most useful part. | authoring log §Lint |
| A3 | minor | Nothing warns when a changed file has no anchor in any step. That is how C4 slipped through. | — |

## 4. What works (keep it)
- The guide's top block (summary with risk and test count, then "Files in this change" with +/− and test tags) is a better PR header than GitHub's.
- The tree's A/M marks, the per-directory dots and the tooltip ("changed, +27 −7").
- Jumping from a file row opens the file at change 1, and `n`/`p` step through "change k / 8" reliably.
- Inline removed lines (red, unnumbered) between the new numbered lines read like a unified diff.
- The Before pane is folded by default, and when opened it shows the exact old lines that the "Before:" sentence talks about. All five base claims are correct.
- The "risk" and "one gap" steps are exactly what a maintainer wants, and the gap they name is real.
- "Show the change" from a box detail lands on the right hunk ("change 7 / 12").

## 5. Fit across abstraction levels (for a diff)
The same viewer suits a PR better than I expected. The guide (narrative), the Before/head panes and the change marks carry it. The map adds the least: at symbol level it fragments into islands, and it repeats what the file list says. The flow view helps for the byte-count branch, but the diagram model (steps "from" one participant) invites misattribution (C1). What a diff still needs that a system map doesn't:
- a one-scroll unified view of all changed files
- intra-line highlights
- per-element +/− counts visible without opening a disclosure
