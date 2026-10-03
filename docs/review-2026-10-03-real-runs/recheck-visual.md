# Re-check, key `visual`: presenter (Sam) and designer (Noor), round 2

Bundles: `out2/` (built 18:42; xpl-self rebuilt 18:50, after this run started at 18:43, so it is included).
Scripts are the round-1 ones, pointed at out2, in `recheck/vw/`; raw JSON and logs are in `recheck/vw/raw` and `recheck/vw/*.log`. The 15 kept screenshots are in `recheck/shots/visual/`.
New scripts: `wrap.mjs` (wrapped and mid-word-broken code lines), `dim.mjs` (contrast per syntax token), `detour3.mjs`, `focusring.mjs`, `more.mjs`, `codet.mjs` and `prof.mjs`.

## 1. Round-1 findings

### Presenter (persona-presenter.md)

| id | status | evidence |
|---|---|---|
| V1 150% diagram gone | **fixed** (mostly) | At 853×480 the diagram is now 176-188 px tall on every step (it was 10-35 px). Only chi step 8 still scrolls its caption. In flow steps, though, the selected box (369×185) is larger than the 433×176 frame (shot 07). |
| V2 second range, same file | **fixed** | chi steps 2 and 3 get two panes, "range 1 / 2" and "range 2 / 2". tree.go 90-95 and 850-868 are on screen at 1280 (shots 02, 10). |
| V3 pane-file over pill | **fixed** | "Show changes" and the stepper moved to a second header row. No overlap at 1280, 1024 or 150% (shots 05, 09). At 150% the ⤢ button wraps onto its own line (shot 08). |
| V4 11 px flow text | **fixed** (overshoots) | Flow text is now 19 px. But a frame now shows one box and nothing around it (shots 03, 07). |
| V5 second selection cropped | **partly** | chi steps 2, 6, 7 and 9 are still CROPPED. A "+1 more" pill now appears; clicking it frames both at scale 1.06, which still meets the 16 px rule (shot 12). So the union would have fitted, and only the mouse reaches it. ky-talk step 5: participant heads are fixed. chi step 9's sequence is still cut on both sides (shot 04). |
| V6 graph↔flow re-split | **fixed** | One split for the whole tour: 655 px diagram, 597 px code, one caption height per tour. |
| V7 is-long switching | **fixed** | One size class per tour (chi: 20.5/16 px on every step). |
| V8 ← after detour | **fixed** | Both ← and Esc after a detour return to step N. The next ← goes to N−1. |
| V9 Back after Esc, URL ≠ screen | **fixed** | Esc keeps the URL in step with the screen. Back then leaves the step's state consistently. |
| V10 ky-talk Esc drops tour/step | **fixed** | Esc writes `?mode=explore&tour=tour:talk&step=3`, and Back returns to Present at step 3. |
| V11 Fit all over labels | **fixed** | In Present it is hidden until the mouse moves. |
| V12 empty first wrap line | **fixed** | mux.go:495 wraps normally (shot 03). |
| V13 150% mid-word breaks | **not fixed** | 150%: 6-13 mid-word breaks per tour (round 1: 8-11). The code column is 392 px, and deep diff lines break to about one token per line (shot 08). |
| C1 chi definition first | **fixed** (via V2) | Both ranges are visible. |
| C2 0.3 s doubling not shown | **partly** | normalize.ts 18-32 now holds the formula, but it is on line 32. The 296 px pane shows lines 18-25, so it is off-screen at 1280. |
| C3 unrelated Before pane | **fixed** | Step 2 now shows options.ts and the constructor, with no Before pane. |
| C4 step 12 focus not visible | **fixed** | hooks.ts:256 is visible (shot 05). |
| C5 long notes | **fixed** | chi has one caption size; there is no shrink mid-tour. |
| A1 talk lint | not re-checked (tool) | — |

### Designer (persona-designer.md)

| id | status | evidence |
|---|---|---|
| V1 dimmed code contrast | **fixed** | Per token, light: every dimmed token is ≥ 4.61, and dimmed gutter numbers are 5.53 (were 1.95-2.9). Dark is ≥ 4.61. Tokens on the focus tint are ≥ 5.34. axe reports no color-contrast failures. |
| V2 tall-map pictures (xpl-self) | **partly** | Guide picture text is 8.8 px (was 6.5), but it now cuts off the named "viewer" box at the top (shot 14). The Map at Fit is still a narrow column at 8.8 px and scale 0.67. |
| V3 guide pictures crop | **fixed** | ky, itsdangerous and chi pictures have 0 clipped texts, and the whole picture is fitted (min 9.2-10 px). xpl-self is the exception (V2). |
| V4 lines through labels | **fixed** (mostly) | No overlaps measured. The itsdangerous map labels are clear. |
| V5 crowded derived edges | **fixed** | Edges are merged as "calls ×2 · extends ×2". The itsdangerous map is readable. |
| V6 focus = selection | **fixed** | A separate solid offset `focus-ring` (2.5 px accent) next to a dashed selection (shot 11). |
| V7 tab order / names | **fixed** | Your app → ky → Fetch API → Web servers; names read "Fetch API, built-in fetch". |
| V8 nested-interactive | **fixed** | The corner buttons are sibling `g`s; axe is clean. |
| V9 focus lost on mode change | **fixed** | Enter goes to MAIN "…step 1 of 9", and Esc returns focus to the Present button. One small gap: when Tab is on a toolbar button, → drops focus to BODY. |
| V10 Present scrollers unfocusable | **fixed** in Present, but see N4 | axe on Present is clean. |
| V11 small-text contrast | **mostly fixed** | Only diff "+" and "−" counts fail now: 4.26 light and 4.01 dark at 12 px. Disabled controls are exempt. |
| V12 200% map | **partly** | The header is one row and the canvas is no longer cut off. But the map gets only 158 of 450 px, and the Fit all pill sits on a box label (shot 13). |
| V13 phone | **fixed** (mostly) | The tour picker fits, steps use a "Step 1 of 9 ▾" picker, and the bottom sheet is one row. In Code, panes still show about 3 lines each. |
| V14 tablet Edit wraps | **fixed** | The header is 48 px. |
| V15 related-files card | **partly** | The ▼ is now inline and the path appears once. The text is still 10-11 px. |
| V16 ky-change header | **partly** | No overlap. But the header still has two steppers ("‹ 12 changes ›" and "‹ range 1/2 ›") plus a truncated path. The map still doesn't refit after Show source: boxes are clipped on both sides (shot 15). |
| V17 target size / names / landmarks | **fixed** | No target-size or landmark-unique findings. Buttons read "Open in Map, step 1: …". |
| V18 Fit all in Present | **fixed** | Hidden until the mouse moves. |
| V19 two "current" things | **fixed** | The inspector is labelled "Picked". |
| C1 xpl-self code titles | **fixed** | Sentence titles ("Four packages and a skill make up xpl"). |
| C2 itsdangerous derived edges | **fixed** | See V5. |
| A1 picture-size lint | not re-checked (tool) | — |

**Counts (39 checked ids; A1 ×2 were not checked):** 28 fixed (several "mostly"), 9 partly (presenter V5, C2; designer V2, V12, V15, V16, plus V4, V11 and V13 "mostly" counted as fixed), 1 not fixed (presenter V13), 0 regressed. Strictly: fixed 29, partly 8, not fixed 1, regressed 0.

## 2. New issues introduced by the fixes

| # | sev | where | evidence | fix |
|---|---|---|---|---|
| N1 | **major** | viewer: Present, one split per tour | The code column is now 597 px at 1280 on every step (graph steps used to get 748). Wrapped lines went from 21% to 32% (ky-talk) and 18% to 28% (ky-change). Visible lines dropped from 124 to 107 and from 239 to 190. Mid-word breaks went from 2 to 7 (ky-talk), e.g. "(cu / rrentResponse", "(progressRespons / e)" (shots 01, 06). | Never break inside an identifier: use `overflow-wrap: normal` and break at punctuation/space. Or size the one split from the code's longest focus line. |
| N2 | **major** | viewer: Present, flow framing | The 16 px floor zooms each flow step to a single box. Nothing around it is visible: there are no arrows to the next stage, so backtracking and the 405 path don't read (shots 03, 07). At 150% the box is larger than the frame. It also overrides union framing even when the union meets 16 px (step 7 union at 1.06 gives about 16.4 px). | Frame the selection plus its neighbours at the smallest zoom that keeps text ≥ 16 px. Use the union before applying the floor, and cap the zoom at the frame size. |
| N3 | minor | viewer: sequence framing | chi step 9: the selected message starts off the left edge, the third participant is cut ("U…"), and a faded label overlaps the participant row (shot 04). | Keep both participant heads and the message in frame (as already done for ky-talk step 5). |
| N4 | minor | viewer: read mode | axe `scrollable-region-focusable` now fires in Explore code panes: ky-repo ×1 and ky-change ×3 (test/*.ts panes). Round 1 had it only in Present. | Give `.cm-scroller` `tabindex=0` wherever it has no focusable content. |
| N5 | minor | viewer: perf | xpl-self Code tab: 1438 ms (round 1: 341 ms; ky-change is unchanged at 318→389 ms). The profile is dominated by `ancestors`/`parent`/`hasDirectory`/`symbol` (about 0.8 s), which looks like a quadratic tree or ancestor walk. | Memoize ancestors per path, or precompute the directory set once. |
| N6 | minor | viewer: guide picture | xpl-self step 1's picture cuts off the "viewer" box at the top, which the step names, while text is still 8.8 px (shot 14). | Same rule as M1: never cut a named box. Use a different layout direction for tall maps. |
| N7 | polish | viewer: header | A Read-mode pane can now show two steppers side by side ("‹ 12 changes ›  ‹ range 1/2 ›"), which compete with each other (shot 15). | Merge them into one stepper, or put range on its own row. |

Content: ky-change step 12 ("Risk: two quieter edges") repeats step 5's diagram frame ("Reject the body read"). That is acceptable, but the picture doesn't show either "edge" the caption is about. Tool: none observed.

## 3. Ratings (round 1 → round 2)

Presenter at 1280×720:

| | L1 ky-talk | L3 chi | L4 ky-change |
|---|---|---|---|
| Comprehension | 4 → 4 | 3 → 4 | 4 → 4 |
| Navigation | 4 → 4.5 | 3 → 4 | 3 → 4 |
| Code readability (back row) | 4 → 3.5 | 3 → 3.5 | 3 → 3.5 |
| Diagram usefulness | 3 → 3 | 2 → 2.5 | 3 → 3 |
| Trust | 4 → 4 | 2.5 → 3.5 | 3.5 → 4 |
| **Overall** | **4 → 4** | **2.5 → 3.5** | **3.5 → 4** |

At 150% zoom: 1.5 → **2.5** for all three. The diagram is back, but code is cramped and flows overflow the frame.

Designer:

| | L1 ky-repo | L2 itsdangerous | L3 chi | L4 ky-change | xpl-self |
|---|---|---|---|---|---|
| Overall | 3.5 → 4 | 3.5 → 4 | 3.5 → 4 | 4 → 4 | 3 → 3 |

Accessibility: 3 → **4**. Visual polish: 3.5 → **3.5**. Pictures are better, but Present code wrapping and flow framing cost points.

## 4. Tasks re-run

| Task | Round 1 → round 2 | Effort |
|---|---|---|
| ky-talk in Present, 6 steps | success → success | 10 → 8 min. Participants are framed. The step-6 formula is off-screen. |
| chi path-matching, 9 steps | partial → **success with nits** | 20 → 12 min. Both ranges are visible. "+1 more" needs the mouse. |
| ky-change, 12 steps | partial → **success** | 20 → 10 min. No header collisions, no stray Before pane. |
| Detour + ← / Esc | partial → **success** | |
| Esc | success → success | Tour and step are kept for ky-talk too. |
| Browser Back | partial → **success** | |
| 1024×768 | success → success | The diagram is 431-485 px. The code column is 474 px and wraps more. |
| 150% zoom | **fail → partial** | |
| Dark | success → success | |
| Contrast per token | partial → **pass** | |
| axe | 5 rule types → 1 (N4) | |
| Keyboard pass | partial → **pass** | |
| 200% / phone / tablet | partial → partial / pass / pass | |
| Guide pictures and map fit | partial → partial | Good except xpl-self. |
| Timings | pass → pass, except xpl-self Code tab (N5) | ready in 255-380 ms; xpl-self in about 1.0 s; Present step 85-123 ms |
