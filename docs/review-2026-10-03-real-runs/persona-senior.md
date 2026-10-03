# Senior review: Marcus, staff engineer

I read code fast and I don't trust a diagram until I've checked it against the source. Setup: 1920×1080 in dark mode, with checks at 1440×900. Main bundle: `chi-algorithm.html` (L3). Second bundle: `itsdangerous-feature.html` (L2). I checked claims against `proj/chi/tree.go` @167e1e3 and `proj/itsdangerous/src`.
Screenshots are in `reviews/shots/senior/`. DOM facts come from `window.__xpl` (`focus()`, `matches()`, `state()`).

## 1. Tasks

| Task | Result | Effort | Where I got stuck |
|---|---|---|---|
| chi: in what order does findRoute try static/param/regexp/catch-all, and when does it backtrack? Prove it from the highlighted code | **Success (content). Partial (viewer).** | ~25 min | The answer is correct and every flow step highlights exactly the right lines. Getting there was slow. The 17-step flow never fits at 1080 px. With source open, the selected step is often off-canvas. Recursion appears only as text. |
| chi: where are URL param keys/values pushed and popped? | **Partial** | ~10 min | Pushes at 467 and 508 and the key append at 522 are anchored. The push at 504 (`""`) and the pops at 500 and 550 are only in the flow (match:7, 8, 14). The params sequence has no pop step. The duplicate key append at 474 is never anchored on its own. Putting the caret on the pop line (500) lights **nothing** in the flow. |
| itsdangerous: spot-check 3 claims | **Success**: 3/3 correct, plus 1 misleading framing | ~10 min | See C4. |
| Judge viewer for L3 (density, Explore, Code tab, Ctrl+F, "in <fn>", fold/expand) | Done | ~15 min | See section 5. |

### Proof of the chi answer (what the viewer let me establish)
- **Order.** `children [ntCatchAll + 1]nodes` (tree.go:112) is indexed by `nodeTyp`, an iota: Static=0, Regexp=1, Param=2, CatchAll=3 (tree.go:90-95). `for t, nds := range nn.children` (414) therefore walks static → regexp → param → catch-all. concept:match-priority anchors exactly these three spans, which is correct.
- **Inside a group.** Static uses a binary search by first byte (`findEdge`, 850-868), so there is at most one candidate. Regexp and param try each node in slice order. `tailSort` moves one `/`-tail node to the end (841-848).
- **Backtracking, two levels:**
  - (a) Inside a param/regexp group, a failed recursion (494) truncates Values to `prevlen` and restores `xsearch` (500-501), then tries the next node (match:7).
  - (b) After any group's child subtree fails (542), the code pops one value if `xn.typ > ntStatic` (548-552) and moves on to the next *type group* (match:14). A static dead end ("article/neard" → "near" + "d") therefore falls through to the param group. The test anchor tree_test.go:98 shows exactly this.
- **Quirk the author got right (match:8).** Once the param loop is exhausted, `xn` is still the *last* node, because the loop assigns the outer variable, and `xsearch == search`. The code pushes `""` (504) and recurses again with the unconsumed path. Most humans would miss this. Good catch by the author.
- **Method mismatch.** A leaf without a handler for the method doesn't stop the search. It sets `methodNotAllowed` and keeps going (match:12, 526-537). Correct.

Every flow-step click put the highlight on the right lines (`focus()` for match:1-17 checked one by one; e.g. match:7 → 499-501, match:14 → 547-552, match:8 → 504). I found **no factual error in the chi explainer**.

## 2. Ratings (1-5)

| | Comprehension | Navigation | Code readability | Diagram usefulness | Trust | Overall |
|---|---|---|---|---|---|---|
| L3 chi | 4 | 2.5 | 4 | 2.5 | 4 (content) / 3 (viewer cues) | **3.5** |
| L2 itsdangerous (spot-checked) | 4 | 3.5 | 4 | 3.5 | 4 | **4** |

## 3. Findings

### Viewer

| id | sev | level | What I saw | Evidence | Suggested fix |
|---|---|---|---|---|---|
| V1 | **major** | L3 flow | A 17-step flow never fits at 1920×1080. "Fit" and "Fit all" both stop at a readable-zoom floor, so only 5 of 17 boxes show and the backtrack arrows leave the screen. Zooming out (−) shrinks around the top and leaves ~250 px of empty canvas above. The whole graph only fit in a 3200 px-tall viewport. | `chi-flow-1920.png`, `chi-flow-fit-1920.png`, `chi-flow-zoomout-1920.png`, `chi-flow-tall.png` | Let "Fit all" really fit. Add a minimap or overview. Anchor zoom on the cursor or the selection, not the top. |
| V2 | **major** | L3 flow + source | With "Show source" on, the flow canvas narrows to ~660 px and **doesn't pan to the selected step**. I selected match:13 and then match:7, and the canvas still showed "Which kind of child?" or the top of the diagram. The breadcrumb names a box you can't see. | `chi-flow-m13-source-1920.png`, `chi-codeclick-pop500.png` | Keep the selection in view when the canvas resizes or the selection changes (the graph view's `startView` logic already does this). |
| V3 | **major** | L3 code→diagram | Code→diagram uses "innermost range wins", and that is applied across concepts *and* view elements. Caret on tree.go:500 (the pop) gives `matches = [concept:param-stack]`, so **nothing lights in the flow**, even though match:7 is 499-501. The same happens on 467: the concept wins over match:6, and the push lights nothing. This hits the two lines that matter most for "where are params popped". | `__xpl.matches()` at 467/500; `chi-codeclick-pop500.png` (no `is-matched` element) | Compute innermost separately for elements drawn in the current view, and add concepts on top. Or always include the innermost *drawn* element. |
| V4 | major | L3 flow | When the subject is one recursive function, every box is `is-related` (all are `node.findRoute`), so the whole flow is teal and the highlight carries no information. | `chi-flow-1920.png` (all boxes filled) | Don't mark flow steps as related just because they share the selected symbol. Or skip "related" in a single-participant flow. |
| V5 | minor | L3 guide | A guide picture crops to the *first* focus only. In t6 ("A dead end sends the search back") the guide crop and the Present view show "Search the child's subtree" but not **"Pop this level's value"** (match:14), which is the point of the step. The crop is also full of edge stubs ("found", "match", "d below") with no ends. | `chi-guide-t6-1440.png`, `chi-present-t6-1440.png` | Frame the union of all focused steps, as the sequence fix (startView `core`) already does for both arrow ends. |
| V6 | minor | L3 guide | t6 renders two separate "This step" cards, each with one chip ("inside node.findRoute: …"). | `chi-guide-t6-1440.png` | Use one card that lists both steps. |
| V7 | minor | L3 code | The role chip "called here" sits on 30-line algorithm stages (466-497, 541-552). For a flow-step anchor the role `call-site` is meaningless. | `chi-flow-m6-source-1920.png` | For flow steps show "this step" or nothing, or let the author pick a role such as `logic`. |
| V8 | minor | L3 code | When one pane has two focused ranges in the same file (t8: 466-467 and 521-523), only the first one is scrolled to, and nothing says there is a second. | `chi-present-t8-1440.png` | Reuse the change n/p UI: "range 1 / 2" with ‹ ›. |
| V9 | minor | all | Ctrl+F works (3 hits for `routeParams.Values` in view), but the panel is stock CodeMirror. It has a white input and tiny native buttons in dark mode, and no "n of N" count. | `chi-ctrlf-1440.png` | Style it with the theme tokens and show a match count. |
| V10 | polish | L2 code | A step label that is a code expression becomes the Current Topic H2: `unsign(s, max_age=max_age, return_timestamp=True)`, wrapped over 4 lines. | `itsd-t5-code-1920.png` | Use a monospace style at a smaller size for code-like titles. |
| V11 | polish | L3 present | At 1440 the t8 sequence crops the left participants (routeHTTP, FindRoute). A dashed return line and the `URLParams` append start off-screen. | `chi-present-t8-1440.png` | The same framing fix as V5. |

### Content (what Claude wrote)

| id | sev | level | Finding | Evidence |
|---|---|---|---|---|
| C1 | minor | L3 | The push/pop answer is spread out. The sequence (the "params" view) has push and key-append steps but **no pop step**. The pops (500, 550) and the `""` push (504) live only in the flow, and the concept anchors 500 but not 550. The param branch's own key append (474) is never anchored, and match:15 points at the common-tail copy (522) even when you arrive from match:6. | data.json `view:params`, `concept:param-stack` |
| C2 | minor | L3 | The diagram doesn't show that regexp is tried before param, because match:3 merges them into "regexp or param". Only the concept and the tour summary say it. | `chi-flow-tall.png` |
| C3 | minor | L3 | "a more specific route wins" (t2) overstates it. Priority is greedy per level, depth-first, and the first complete match wins. A static-first route with `*` below beats a param-first route that is literal below. | tree.go:414-554 |
| C4 | minor | L2 | t9's title "A tampered token raises BadTimeSignature" isn't always true. A token with no `.` raises plain `BadSignature` (signer.py:248, re-raised at timed.py:103-104). The advice "Catch BadSignature … in one place" also sits right after t8's `BadPayload`, which is **not** a `BadSignature` subclass (exc.py:92, `BadPayload(BadData)`). | exc.py, timed.py:96-130 |
| C5 | polish | L3 | "The test on the right" (t5, t6) depends on layout. In the Guide the test is below the text. | `chi-guide-t6-1440.png` |

These itsdangerous claims check out: t6 (signer tries keys newest first, `reversed(self.secret_keys)`, signer.py:236); t7 (`max_age` only when given, and a future date also raises `SignatureExpired`, timed.py:138-153); t5 (`SignatureExpired` re-raised at once, `BadSignature` → next signer, timed.py:202-220). Also t3 (timestamp inside the signed value) and t4 (salt changes the key under `django-concat`).

### Authoring tool (from the log, confirmed by what I saw)

| id | sev | Finding |
|---|---|---|
| A1 | major | There is no recursion construct in the flow and no drawn self-loop on the map. `edge:findroute-recurses` validates but isn't drawn (log §21). The "found below" arrows run straight from a level-N stage to the root `FindRoute` terminal, which mixes stack levels. Needed: a "recurse → back to step X, one level down" edge style, and an "unwind" notation. |
| A2 | minor | Lint `code-heavy` treats example inputs (`/admin/*`, `neard`) as code names, which pushed the author to un-backtick literal paths. In t6, "the leftover d finds nothing" reads worse than "the leftover `d`". |

## 4. What works — keep it
- Flow step → code is **exact**. 17/17 steps highlight precisely the anchored span, and the side panel gives a one-paragraph summary that matches the code. That's what convinced me.
- The "in `node.findRoute`" / "in `TimedSerializer.loads`" pane header is correct and useful in a 150-line function.
- In Explore and the Code tab, long Go lines stay unwrapped and readable at 1920. Dimmed code (0.6) is still easy to read in dark mode.
- Present at 1440: the code font is large enough for a room, the wrapped-line hanging indent works, and the "6 / 9" counter and progress bar are clear.
- Fold, "whole column" and the file filter are there and work (`Fold tree.go`, `Give tree.go the whole column`).
- The test row anchor (tree_test.go:98 highlighted pink) is a great way to "prove" a backtracking claim.

## 5. Does the viewer fit L3?
The viewer handles **code** well at every level, but **diagrams** only up to L2. The map and sequence suit L1/L2: a few boxes, and edges that are real calls. At L3 the question lives inside one function. The map then has 6 boxes with the key edge (recursion) missing. The flow gets 17 nodes in one tall diagram that never fits, everything highlights because everything is "findRoute", and the code→diagram link drops the most important lines (V3). The density is right in the Code tab and wrong on the canvas. For L3 I'd want three things:
1. A **code-first layout**: the source as the main pane, and the flow as a narrow, auto-panning outline beside it (fix V2).
2. **Recursion and unwind notation**: A1.
3. Highlighting by drawn element (V3, V4).

Ctrl+F, fold and the "in <fn>" header are enough for one-file reading. The search panel needs theming.
