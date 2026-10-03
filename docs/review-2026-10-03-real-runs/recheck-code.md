# Re-check, key `code`: Marcus (staff engineer) + Priya (newcomer)

Bundles: `out2/` (chi, itsdangerous, ky-repo at 18:42; xpl-self rebuilt at 18:50, after this run started at 18:43, so it was checked).
Driving: Playwright via `recheck/c*.mjs`, `i*.mjs`, `k*.mjs`, `x1.mjs`. Marcus used 1920×1080 and 1440×900 in dark mode; Priya used 1440×900 in light mode.
Screenshots (15) are in `recheck/shots/code/`. Source was checked in `proj/chi/tree.go`, `proj/itsdangerous/src`, `proj/ky/source/core/Ky.ts`, and the bundled `apply.ts` text.

## 1. Round-1 findings → status

### Marcus (persona-senior.md)

| id | status | evidence |
|---|---|---|
| V1 17-step flow never fits | **fixed** (as asked), but Fit all is a thumbnail in practice | "Fit all" now fits all 17 boxes. In the 420 px code-first column, though, the stage text renders at 13px×~0.5, about 3-5 px, so it works as a minimap only. A "Readable size" toggle brings the text back (`06-chi-fitall-1920`). |
| V2 canvas doesn't pan to selection | **fixed** | Picking match:1…17 one by one leaves the picked box inside the canvas every time, at both 1920 and 1440 (`03-chi-m14-1920`, `05-chi-m14-1440`). |
| V3 caret on 467/500 lights nothing | **fixed** | The caret now lights the drawn step: 467 → `[concept:param-stack, match:6]`, 500 → match:7, 504 → match:8, 508 → match:9, 522 → match:15, 550 → match:14. Each lit box is in view (`04-chi-caret500-1920`). |
| V4 every flow box "related" | **partly** | With a step picked, 0 boxes are `is-related`. On first entry to Flow, though, the guide's `node.findRoute` selection carries over and marks 15 of 17 boxes `is-related` (all teal). |
| V5 guide/present frames only first focus | **partly** | The Guide t6 picture now frames both "Search the child's subtree" and "Pop this level's value" (`09`). Present t6 at 1440 still shows only the first box, plus a "+1 more" pill (`10`). |
| V6 two "This step" cards on t6 | **not fixed** | The DOM still has two cards for t6, one chip each. |
| V7 "called here" on 30-line flow stages | **not fixed** | All flow-step anchors still carry role `call-site`, and the pane chip reads "called here" over 466-497 and 547-552 (`03`, `08`). |
| V8 second range in one file invisible | **fixed** | Present t8 has two panes, labelled "range 1 / 2" and "range 2 / 2" (`11`). Read mode has a ‹ › stepper (`27`). |
| V9 Ctrl+F stock panel | **fixed** | The panel is themed, shows "4 of 16", and Enter moves to the next match. |
| V10 code expression as Topic H2 | **not fixed** | `super().unsign(signed_value)` is still an 18px H2 in the proportional font. |
| V11 t8 sequence crops left participants | **partly** | Both focused messages are visible. routeHTTP and FindRoute are still off the left edge, and "UR…" is cut on the right (`11`). |
| C1 push/pop answer spread out | **partly** | The viewer now leads from each push/pop line to its step (V3), so the answer can be found from the code. The content is unchanged: `view:params` has no pop step, `concept:param-stack` anchors 499-500 but not 550, and 474 is anchored only inside the 466-497 block. |
| C2 regexp-before-param not drawn | **not fixed** | match:3 still has the edge "regexp or param". |
| C3 "a more specific route wins" overstated | **not fixed** | The t2 text is unchanged. The chi content was not edited. |
| C4 t9 BadTimeSignature / BadPayload framing | **fixed** | t9 now covers the plain `BadSignature` case when there is no timestamp, and says to catch `BadData`. Both match exc.py:7-92 and timed.py:102-130. |
| C5 "the test on the right" | **not fixed** | t5 and t6 still say it. In the Guide the test is below the text. |
| A1 no recursion/unwind notation | **fixed, with a residual** | The flow now draws 2 dashed `recurse` links (to "Child groups left to try?", "one level down") and 3 `return` links, each with a tooltip. The sequence draws `xn.findRoute` as a self-loop. Residual: every `return` targets match:17 in `node.FindRoute`, and the tooltip says "its caller goes on at 'Copy the params…'". That is true only for the outermost level. |
| A2 code-heavy pushes literals out of backticks | **not fixed** | t6 still reads "the leftover d". CONTENT-FIXES says `code-heavy` still counts names. |

### Priya (persona-newcomer.md)

| id | status | evidence |
|---|---|---|
| V1 no "who calls this" from code | **fixed** (see N1 for 1440 Guide) | Hovering a name shows "Who calls it" and "Go to definition". F12, Shift+F12 and Ctrl+click also work. A flow step's topic now shows the owner's "Called from (who calls Ky.#calculateRetryDelay) → Ky.#retryFromError L1102", unfolded. |
| V2 guide flow pictures crop to one diamond | **fixed** | itsd t7 shows "Is there an age limit?" → Too old? → both outcomes (`13`). The ky step-1 map shows all 3 boxes, not cut (`24`). |
| V3 retry flow Fit all 5 px, edges bundle | **not fixed** | Labels are 5.0 px at Fit all, and ~12 edges still converge on "Give up" and "Wait the backoff delay" (`25`). A "Readable size" button now exists. |
| V4 pane header "in X" wrong | **fixed, with a regression** | itsd t7 reads "in TimestampSigner.unsign", which is right. The test pane and signer.py no longer show a wrong name. Regression: after a jump from a caller row, the header names the function on the top line ("in Ky.#runAfterResponseHooks" while the caret is at 1102 in `#retryFromError`, `21`). |
| V5 Related files card noise | **partly** | "Key:" and "Added by the explainer's author" are gone, and ky has no card. itsdangerous still shows a "Related files" card. |
| V6 dbl-click switches to Flow silently; no Key in Flow | **partly** | Flow now has a Key button and an "Inside Request engine →" link. A double-click still switches tabs with no toast or label. |
| V7 off-screen keyboard pick not panned | **fixed** | request:9 picked with Enter is in view. |
| V8 tree filter results identical | **fixed** | Results show the name with a dim parent folder ("apply.ts · packages/cli/src/commands"). |
| V9 inner-map label collisions | **fixed** | The "calls ×N" labels are gone, and labels no longer overlap. One short stacked segment remains under Request engine. |
| V10 button overflows right edge | **fixed** | No button runs past the viewport. |
| V11 "From X To X", raw ids | **fixed** | Details now read "Ky.ts, lines 612–634 in Ky.#calculateRetryDelay". |
| V12 Ctrl+F unstyled, Enter ≠ next | **fixed** | Same as Marcus V9. |
| K1 xpl-self code-signature titles | **fixed** | All 16+6 titles are sentences ("A rejected patch leaves the explainer untouched"). |
| K2 duplicate ky→Fetch edges | **fixed** | `view:system` draws 3 edges, with a single ky→Fetch arrow ("hands over requests"). |
| K3 owner repeated 10×, caller hidden | **partly** | The subtitle still repeats on every node. The caller is now one hover away (Called from #retryFromError). |
| K4 rotation as recipe | **fixed** | t6: "To rotate, append the new key, then drop the old one once its tokens have expired." |
| K5 lowercase "loads tries…" title | **not fixed** | The TOC still starts with lowercase "loads". |
| C1 (blocker) stale anchor ranges | **fixed** | xpl-self: 1033 anchors, all `ok`. 550 symbol anchors, **0** differ from the bundled index. `Applier.fail` → 410-412, which matches `private fail()` in the bundled text (`27`). |

**Counts (36 ids): fixed 20 (Marcus 7, Priya 13), partly 7 (4, 3), not fixed 9 (7, 2), regressed 0.** One fix brought a sub-regression (Priya V4 after a jump).

## 2. New issues introduced by the fixes

| # | sev | where | issue | evidence | suggested fix |
|---|---|---|---|---|---|
| N1 | **major** | viewer | "Who calls it" does nothing visible in Guide + Show source at 1440. The topic column is hidden in that layout, so the selection changes but the callers list has `offsetParent=null` (0×0). It works at 1920 and in the Code tab at 1440. | `k3.mjs 1440 900 guide`; `18-ky-whocalls-1440` (tooltip, no list) | When the topic column is hidden, show callers in a popover from the tooltip, or open the column. |
| N2 | major | viewer (code-first) | The code-first flow column is fixed at 420 px (360 px at 1440), with no splitter. At readable size it shows 2-3 boxes, with labels cut at the edge ("andler here", "Push the valu"). Recurse and return links run off-screen, so the shape of the backtracking can't be seen while reading code. Fit all turns it into 3 px text. | `05`, `08`, `06`; `[role=separator]` count 0 | Add a draggable splitter, or a "diagram-first" toggle per view. Draw the step's neighbours (one hop) at readable size. |
| N3 | minor | viewer | After a jump (caller row or go-to), the target line lands as the last visible line, and the header names the top-line function (Priya V4). The "defined here" chip stays while the focused range is off-screen. | `21-ky-caller-landed-guide-1920` | Center the jump target, and name the symbol at the caret after a jump. |
| N4 | minor | tool/index | "Called from (who calls node.findRoute)" lists only FindRoute L390. The recursive self-calls at 494 and 542 are dropped, which is odd in a recursion explainer. | `03-chi-m14-1920` | List self-calls as "itself (recursion), L494, L542". |
| N5 | minor | content/tool | A `return` link must name one step. The chi author points all three returns at FindRoute's match:17, and the generated tooltip "its caller goes on at…" is wrong for inner levels. | data.json `view:match` | Allow a generic "back to the caller" target, or word the tooltip "the result goes up, level by level, to …". |
| N6 | minor | viewer | Entering Flow from the guide keeps the `node.findRoute` symbol selected, so 15/17 boxes are teal (the V4 symptom on first view). The code then shows FindRoute 383-406 "defined here" while the topic says "Picked node.findRoute". | `c2.mjs` output | Clear the selection or select the step's own flow element on a tab switch. |
| N7 | polish | bundle | xpl-self.html is now 17.8 MB, over the 16 MB artifact limit (16.9 MB in round 1). It loads in 992 ms. | `ls out2` | Prune `files` (105 of 424 files in page) or compress. |
| N8 | polish | viewer | The "Where this is in the code" details call a flow view "Sequence" ("Sequence · Which failures ky retries…"). | k7 output | Use the view's type name. |

## 3. Ratings (round 1 → round 2)

Marcus

| | Compr. | Nav. | Code read. | Diagram | Trust | Overall |
|---|---|---|---|---|---|---|
| L3 chi | 4 → 4 | 2.5 → **3.5** | 4 → 4.5 | 2.5 → **3** | 4/3 → 4/4 | 3.5 → **4** |
| L2 itsdangerous | 4 → 4.5 | 3.5 → 4 | 4 → 4.5 | 3.5 → 4 | 4 → 4.5 | 4 → **4.5** |

Priya

| | L1 ky | L2 itsd | big xpl-self |
|---|---|---|---|
| Comprehension | 4 → 4 | 5 → 5 | 2 → **4** |
| Navigation | 3 → **4** | 4 → 4.5 | 3 → 4 |
| Code readability | 4 → 4 | 5 → 5 | 4 → 4 |
| Diagram usefulness | 3 → 3 | 3 → 4 | 2 → 3 |
| Trust | 4 → 4.5 | 5 → 5 | 2 → **4.5** |
| **Overall** | 3.5 → **4** | 4.5 → **4.5** | 2.5 → **4** |

## 4. Tasks re-run

| task | result | effort vs round 1 |
|---|---|---|
| chi: match order and backtracking, proved from highlighted code | **success** | About 10 min, down from ~25. Every step highlights the exact span. The order (iota at 90-95, range at 414), the in-group backtrack (match:7 at 499-501), the group-level pop (match:14 at 547-552) and the `""` push (match:8 at 504) all check out against tree.go. The dashed recurse links make the recursion visible. |
| chi: push/pop with caret → diagram | **success** | About 2 min, down from ~10 (partial). The caret on 467, 500, 504, 508, 522 and 550 lights the right step in view. The sequence still has no pop step (content). |
| chi: 17-step flow at 1920 and 1440, code-first: does it help? | **partial** | **Code-first helps the code-proof task.** The code gets ~1050 px, the picked step stays in view, and code ↔ step works both ways. **It hurts the diagram:** a 420/360 px keyhole with no splitter, where the recursion and backtrack shape is off-screen (N2). I read the algorithm from code plus step summaries, not from the picture. Present (diagram-left) is still the better way to see the flow. |
| itsdangerous spot-checks (t5, t6, t7, t9) | **success** | 4/4 correct. C4 is fixed. |
| ky: where is retry decided / who calls it | **success** | About 1 min at 1920 or in the Code tab, down from ~6 min. Path: TOC 7 → Show source → hover `#calculateRetryDelay` → Who calls it → `#retryFromError` L1102 (4 actions). At 1440 in Guide + source, Who calls it shows nothing (N1). The flow-step topic already lists the caller unfolded. |
| itsdangerous: max_age | **success** | Under 1 min, the same as round 1. The picture now shows the neighbours. |
| itsdangerous: key rotation | **success** | Under 1 min. There is now a one-line recipe. |
| xpl-self: where does `xpl apply` reject a bad patch | **success, trusted** | About 1 min. t9 → the core pane highlights `private fail()` at 410-412 (correct), and the CLI pane shows 135-142 in `applyCommand.run`. Round 1 got a misleading range here. |
