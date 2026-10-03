# Presenter review: Sam, tech lead, 10-minute talk on a projector

**Persona.** I give a 10-minute talk from a laptop on a 1280×720 projector, using only the arrow keys. The audience is in the back row. Before the talk I check the deck on a 1024×768 projector, and at 150% browser zoom on 1280×720 (853×480 CSS px at DPR 1.5), in light and dark.

**Method.** I ran Playwright against the real bundles and pressed ArrowRight through every step of each tour. I took a screenshot of every step at 1280×720 light, and again at 1024×768, at 150% zoom and in dark mode (82 screenshots in all; 20 are kept in `reviews/shots/presenter/`). For each step I measured these from the DOM:
- caption box and font sizes
- the on-screen px of the SVG text (font-size × CTM)
- contrast
- which lines are visible in each code pane, compared with `__xpl.focus()`
- whether the selected box falls inside the diagram frame
- pane-header overlaps

Scripts and raw JSON are in `scratchpad/presenter/`.

## 1. Tasks

| Task | Result | Effort | Where I got stuck |
|---|---|---|---|
| L1 `ky-talk.html`: opens in Present on tour:talk, 6 steps | **Success**, with framing nits | 10 min | Step 5: both sequence participants are cut off at the sides. Step 6 switches to the flow layout: the whole screen re-splits, and the flow text is 11 px. |
| L3 `chi-algorithm.html`: Present on tour:path-matching, 9 steps | **Partial** | 20 min | Steps 2 and 3 never show the code the caption is about: tree.go:90-95 (the node-type order) and 850-868 (`findEdge`'s binary search). Five steps (2, 6, 7 and the two-message step 9) crop a box or message that the step itself selected. |
| L4 `ky-change.html`: Present on tour:change, 12 steps | **Partial** | 20 min | In the 534 px code column (flow steps 6, 7, 12) the file name is drawn on top of the "Changed" / "New file" pill. On step 3 a Before pane shows code that has nothing to do with the step. On step 12 the second pane's focus lines are not visible. |
| Detour: click a box or edge mid-talk, then ← | **Partial** | 5 min | The "Exploring · Back to step 2" pill works, and so does restoring the zoom. But ← after a detour goes to step **N−1**, not back to step N. The previous review promised "one ← away from the step". |
| Esc | **Success** | 2 min | chi and ky-change land on the Guide at the same step, with the slide's code shown. In ky-talk, Esc writes `?mode=explore` and drops tour and step from the URL. |
| Browser Back | **Partial** | 5 min | Back *during* Present leaves the talk (as designed). For chi and ky-change, Back *after* Esc changes the URL to `step=1&view=routing-map` but the screen stays on step 3 in the match view, so the URL and the screen disagree. For ky-talk (which opens in Present), Back after Esc leaves the HTML file. |
| 1024×768 | **Success** | 5 min | This is the best size of the four: the diagram gets 334-409 px of height. |
| 150% zoom at 1280×720 | **Fail** | 5 min | The diagram shrinks to a **10-63 px strip** on every step of all three bundles, and the caption scrolls. In the 350 px flow-step code column, code breaks mid-word ("nds.findEdge(labe / l)", "HasPrefi / x"). The header wraps to two rows. |
| Dark | **Success** | 3 min | Contrast is fine. The dark code highlight is a little muddy but readable. |

## 2. Ratings (1-5)

| | L1 ky-talk (system) | L3 chi (algorithm) | L4 ky-change (diff) |
|---|---|---|---|
| Comprehension | 4 | 3 | 4 |
| Navigation (keys, detour, Esc, Back) | 4 | 3 | 3 |
| Code readability (back row) | 4 | 3 | 3 |
| Diagram usefulness | 3 | 2 | 3 |
| Trust (does the screen match the caption?) | 4 | 2.5 | 3.5 |
| **Overall** | **4** | **2.5** | **3.5** |

At 150% zoom I would give all three a 1.5.

## 3. Findings

### Viewer

| id | sev | level / bundle | What I saw | Evidence | Suggested fix |
|---|---|---|---|---|---|
| V1 | **blocker** (for the zoomed case) | all, 150% zoom (853×480) | The caption's one-height rule takes the tallest caption, capped at `CAPTION_CAP` = 62vh, which is 298 px of 480. That leaves the diagram **10 px** high (chi steps 1, 8, 9), 35 px (ky-change graph steps) or 17 px (ky-talk sequence steps). The caption still scrolls (`capScroll: true` on ky-change steps 1, 2 and 4). The previous fix ("two columns down to 641 px") holds, but the picture has gone. | `14-zoom150-l3-s1-diagram-gone.png`, `16-zoom150-l4-s1-…png`; `z150-*.log` | Make the cap depend on the diagram. For example, the caption gets at most `100vh − header − 220 px`. When the viewport is short, put the caption under the code, or shrink the caption font first. Give the diagram a hard minimum of about 200 px. |
| V2 | **major** | L3 chi steps 2 and 3 (also any step with two ranges far apart in one file) | When a step focuses two ranges in the **same file**, Present shows one pane scrolled to the lead range. Step 2's second range is `tree.go:90-95` (`ntStatic, ntRegexp, ntParam, ntCatchAll`): that is the whole point of "Literal text beats a param, a param beats \*". Step 3's second range is `tree.go:850-868`, the binary search that the caption names. Neither is visible and nothing tells you so. The header shows "defined here" and "called here" chips, but on screen there is only the call site. | `06-l3-s2-…png`, `07-l3-s3-…png`; focus `tree.go:414-428` + `tree.go:90-95`, visible 414-436 | In Present, split a file whose focus ranges are more than about a screen apart into two stacked panes, one per range, as already happens with two files. Or fold the gap between the ranges. At minimum, show "range 1 / 2 ›" in the header, like the "change 2 / 3" control. |
| V3 | **major** | L4 steps 6, 7 and 12; all bundles at 1024 and 150% | In the pane header, `.pane-file` shrinks to 10 px wide while its `<b>` basename overflows visibly. As a result "body.ts" is drawn over the "Changed" pill ("bodyCHanged"), "response-siz…" over "New file", and "hooks.ts" over "Changed". At 1024 and 150% the role chips and ⤢ go past the right edge. | `11-l4-s6-…png`, `13-l4-s12-…png`; DOM `SPAN.pane-file w=10 sw=59` | Give the basename `flex-shrink:0`, so that only `.dir` shrinks. In Present, drop "Show changes" and the hunk stepper, or wrap them onto a second row when the header is narrower than about 600 px. |
| V4 | **major** | L1, L3, L4: every flow step | Flows are drawn at scale 0.85-1 with **11 px** text for stage labels, edge labels and owners. Graph labels are 14 px and sequence labels 16 px. At 11 px nobody past the third row can read "yes: cut the prefix". | `fonts.mjs` output; `04-l1-s6-…png`, `07-…png` | Give Present a minimum on-screen text size for the diagram (about 16 px). Let the first view zoom a flow until its text reaches that size, and frame the selected stage plus its incoming and outgoing edges. |
| V5 | **major** | L3 steps 2, 6, 7 and 9; L1 step 5 | The first view frames the first selected element only. The second one is **cut off**: match:3 (step 2), match:14 (step 6), the 405-answer box match:12 (step 7), and params:8/params:10 (step 9, where the message runs off both edges and participant "Co…" is clipped). In L1 step 5, both lifeline heads are clipped ("y.create", "Ky.#retryFrom"). | `08-…png`, `09-…png`, `03-…png`; `selInfo … CROPPED` | Frame the union of all the selected elements when it fits at about 0.7×. Otherwise frame the first one and add a visible "+1 more →" cue. For sequences, keep the participant heads of the selected messages in frame; that was the previous fix for single messages. |
| V6 | minor | L1, L3, L4: graph↔flow transitions (ky-talk 5→6, chi 1→2 and 7→8, ky-change 4→5, 7→8 and 11→12) | `.present[data-view-type=flow]` re-splits the screen from 505/750 to 720/534. The caption height changes (192→161 px, 306→221 px), the code column narrows by 214 px, and code that fitted starts to wrap (`lineH` 24→49/97). The promise of one caption height across the tour holds only inside one layout. On a projector the whole slide visibly jumps. | `run.mjs` JSON `cap` / `panes` | Pick one split for the whole tour: the widest any of its steps needs, measured the same way as the caption. |
| V7 | minor | L3 chi | The `is-long` caption class switches *within a tour*: steps 1 and 8 have 20.5 px titles and a 16 px note, the others 24 px and 20.5 px. Because the tallest caption sets the height, a 306 px caption box takes the room for every graph and sequence step. The diagram gets 277 px, and steps 9 and 3 leave blank space under their text. | `05-l3-s1-…png`; `noteFs` | Choose the size class once per tour, from the longest note. Better, tell the author (see A1). |
| V8 | minor | after a detour | ← after a detour goes to step N−1, and → goes to N+1. Returning to the interrupted step needs a mouse click on "Back to step N" in the header. The previous review said a stray click is "one ← away from the step". | `detour2.mjs` log: detour at k2, then ←, lands on k1 | After a detour, make the first ← (or Esc) re-apply step N. The step after that goes to N−1. |
| V9 | minor | L3 and L4: Back after Esc | The URL goes back to `step=1&view=routing-map`, but the screen stays on step 3 in the match view. A reload then shows something different from what is on screen. | `detour2.mjs` log "Back after Esc" | Handle popstate in Explore (re-apply the URL), or use `replaceState` for Esc so that Back has no stale entry to return to. |
| V10 | minor | L1 ky-talk (bundle opens in Present) | Esc writes `?mode=explore` without tour or step. Back after Esc, or Back during the talk, leaves the HTML file. Forward then opens an empty Explore with nothing selected. | `detour2.mjs`, `detour.mjs` logs | When the bundle opens in Present, `replaceState` the start and push an entry for Esc. Keep `tour` and `step` in the Explore URL. |
| V11 | polish | all (graph and sequence steps) | The "Fit all" pill sits on diagram content on most slides: "and defaults" in L1 step 2, "node.isLeaf" in L3 step 1, a self-call arrow in L1 step 5, and a message label in L3 step 8. | `01-…png`, `05-…png` | In Present, hide it until the mouse moves, as the zoom toolbar already is, or reserve a strip for it. |
| V12 | polish | L3 step 7 (mux.go:495) | A hanging-indent wrap of a long call produces an empty first visual line, then the code. | `08-…png` | Do not break before the first token of the line. |
| V13 | polish | 150%, flow steps | A 350 px code column with the 15 px floor breaks identifiers mid-word. | `15-zoom150-l3-s3-…png` | Below about 420 px, give the code column priority over the flow, or let the code font drop to 14 px. |

### Content (what the author wrote)

| id | sev | bundle | What I saw | Suggested fix |
|---|---|---|---|---|
| C1 | major | L3 steps 2 and 3 | The proof of each caption sits in a second range of the same file (see V2). The author did focus the right lines; the viewer hides them. Even so, the step reads as "caption claims X, code shows Y". | Until V2 is fixed, focus the definition first (the enum or `findEdge`) and the call site second. |
| C2 | minor | L1 step 6 | "The default wait starts at 0.3 seconds and doubles each time" is not in either shown range. retry-timing.ts:25-49 is `getRetryTimingHeader`, and Ky.ts:612-634 is the status check. | Add the range that holds the backoff formula, or cut the sentence. |
| C3 | minor | L4 step 3 | Half the code area is a Before pane (base 071a9b9) highlighting `totalTimeout` at line 403, for an option that did not exist before. The caption itself says "Before: Ky had no such option." | Do not focus a base range for a pure addition. |
| C4 | minor | L4 step 12 | The 231 px hooks.ts pane shows deleted doc-comment lines, and the focused lines 254-256 are not visible (no numbered line in view). | Use one pane, or focus a range that starts where the change is. |
| C5 | polish | L3 steps 1 and 8 | The notes are long enough (more than `LONG_NOTE`) to shrink every caption and the diagram (V7). | Keep talk notes to about 3 lines. |

### Authoring tool

| id | sev | What | Fix |
|---|---|---|---|
| A1 | minor | Nothing warns the author when a talk step (a) has two ranges in one file more than about 40 lines apart, (b) has a note over `LONG_NOTE`, or (c) selects several elements that will not fit one frame. Each of these breaks a projected slide (V2, V5, V7). | Add a "talk lint" to the authoring check with these three rules. |

## 4. What works (keep it)

- Arrow keys, PageUp/PageDown, Space, Home and End are instant and reliable. A click into the code does not steal → (I checked). The step counter and progress bar are readable from the back.
- Caption type at 1280×720 is good for a projector: titles 24.3 px and notes 20.5 px at 16:1 contrast, in both themes. Code is 15.2 px with a 24 px line height and wraps with a hanging indent. Nothing scrolls the page at any size I tried.
- Two files means two stacked panes with "called here" / "defined here" chips. L1 step 4 (`Ky.#fetch` with `timeout.ts`) and L4 step 8 (Before and inline diff of the same lines) read very well on a projector. The +/− column and red/green fills are visible from far away.
- Detour handling: "Exploring · Back to step 2" is clear, and the zoom comes back exactly. Esc lands on the same step in the Guide with the code shown.
- 1024×768 is the best layout of all: the diagram gets 334-409 px and the code shows 10-20 lines.
- Dark mode: the flow and graph labels have 7-15:1 contrast, and the code highlight stays visible.
- No step was empty and none was blank on load. Every step's lead range was on screen at 1280×720 light.

## 5. How Present adapts across abstraction levels

- **System map (L1): fits best.** Each step is "one box plus one file", which a projector shows well. The talk tour was written for Present (6 short steps with 3-line notes). The weak spot is the zoomed map: it frames the box at 1:1 and crops its neighbours, so the audience loses the "where are we" picture. A short zoom-out before each step would help.
- **Dense algorithm flow (L3): fits worst.** The flow is the right diagram for chi, but in Present each slide shows one 11 px decision diamond with its neighbours cut off. Backtracking (step 6), the move from param to catch-all (5) and the 405 path (7) are all about *edges between* stages, and those are off-frame. On the code side, an algorithm step often needs two places in the same file (a call site plus a helper or enum), and that is exactly the case Present cannot show (V2). For algorithms, Present needs (a) a frame around selection plus neighbours, (b) 16 px flow text and (c) a pane per range.
- **Diff (L4): good when the code column is wide, and breaks when a flow step narrows it.** Inline diffs plus the Before pane work at 748 px. At 534 px (any flow step) the pane headers collide (V3) and diffs wrap to 2-4 visual lines each. The graph↔flow re-split (V6) is most jarring here, because the tour alternates between the change map and the size flow.
- **Overall:** the same viewer suits a talk about a map or a diff at the projector's native resolution. It is not ready for a dense algorithm flow, or for any bundle at 150% zoom.
