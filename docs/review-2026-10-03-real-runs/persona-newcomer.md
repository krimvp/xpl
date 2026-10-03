# Newcomer review: Priya

## 1. Who I am and what I tried

I'm Priya. I've been a developer for a year and just joined a team that uses ky and itsdangerous. I had never
seen xpl before. I used a 1440×900 laptop in light mode, with no help beyond the pages themselves (Playwright
did the driving, and I looked at every screenshot). Shots are in `reviews/shots/newcomer/`.

| Bundle | Task | Result | Effort | Where I got stuck |
|---|---|---|---|---|
| ky-repo (L1) | "What are the main parts of ky?" | **Success** | ~1 min | Step 1's "Parts" chips plus Map → double-click ky ("Inside ky: its parts and what they use") answered it. |
| ky-repo (L1) | "Where is a request retried? Open the code that decides." | **Success** | ~2 min | TOC step 7 → Show the code opened `Ky.#calculateRetryDelay` at L567, with the retry defaults in `normalize.ts` below it. The guide's picture of the decision flow showed one diamond and some stray lines, so it didn't help (ky-02). |
| ky-repo (L1) | "Who calls that code?" | **Partial** | ~6 min, many dead ends | Clicking the function name in the code does nothing (ky-05). The step's details have no "Called from". Picking the flow diamond gives "From Ky.#calculateRetryDelay To Ky.#calculateRetryDelay" and the raw id `Ky.ts#Ky.#calculateRetryDelay +45..67`. "Called from" exists only for a map box (Request engine → `createInstance`, which is the file's caller, not the function's), and it's inside the folded "Where this is in the code". In the end Ctrl+F → `calculateRetryDelay(` → next took me to L1102 in `#retryFromError` (ky-15). I also found `ky.#retryFromError` as step 7 of the request flow, but nothing links it to the retry decision flow. |
| itsdangerous (L2) | "Token older than max_age: what happens, which exception, which line?" | **Success** | ~1 min | TOC step 7 says it plainly: `SignatureExpired`, after the signature check, and only if you pass max_age. Show the code put `timed.py` L138-153 (`if age > max_age: raise SignatureExpired(...)`) next to `test_max_age` (itsd-02-code). The topic column even says that an age of exactly max_age still passes. |
| itsdangerous (L2) | "How do I rotate keys without logging everyone out?" | **Success** | ~1 min | Step 4 (new tokens use the last key) plus step 6 (`verify_signature` loops `reversed(self.secret_keys)`), with `test_secret_keys` beside it (itsd-03-code). The how-to (append the new key, drop the old one later) is implied, not stated as steps. |
| xpl-self (big) | "Find where `xpl apply` rejects a bad patch." | **Success, but I was misled** | ~3 min | TOC step 9, "rejected: N errors, nothing was applied", was easy to spot. The CLI pane (`apply.ts` L130-137) is right. The core pane labels **`Applier.fail` "defined here" but highlights L389-391, which is the tail of `Applier.error`.** `fail()` is really at L408 (xpl-03, xpl-06). See C1. |
| xpl-self | Load time / slowness | **Fine** | — | 16.9 MB file: **753 / 837 / 788 ms** to `window.__xpl` over 3 cold loads (DOMContentLoaded ~670 ms), against ~210-245 ms for the 2.1 MB ky bundle. After load, nothing felt slow: TOC jump 202 ms, Show the code 333 ms, tab switches 114-172 ms, tree filter 185 ms. |

## 2. Ratings (1-5)

| | L1 ky-repo | L2 itsdangerous | big xpl-self |
|---|---|---|---|
| Comprehension | 4 | 5 | 2 (TOC titles are code signatures: "pack.extract(ctx)", "moved", "drifted") |
| Navigation | 3 (callers are hard to find) | 4 | 3 |
| Code readability | 4 | 5 | 4 |
| Diagram usefulness | 3 (the parts map is good; the retry flow is unreadable) | 3 (pictures crop to one diamond) | 2 (the overview picture's text is ~6 px) |
| Trust | 4 | 5 | **2** (wrong lines labelled "defined here") |
| **Overall** | **3.5** | **4.5** | **2.5** |

## 3. Findings

### Viewer

| id | sev | bundle | What I saw | Evidence | Suggested fix |
|---|---|---|---|---|---|
| V1 | major | ky | There is no way to ask "who calls this function?" from the code or from a guide step. Clicking a symbol in the code does nothing. "Called from" appears only when a map box (file/symbol) is picked, and it's folded inside "Where this is in the code". For a file it lists the file's callers (`createInstance`), not the function's. | ky-05, ky-10/ky-11 (`[data-testid=callers]` count 0 on the step, 1 only on the map box) | Make an identifier in a code pane clickable (or give it a "Callers" gutter action) that opens that symbol's Called-from. Show Called-from unfolded in the topic column whenever the focus is one symbol. |
| V2 | major | ky, itsd | Guide pictures of a flow/decision crop to the step's one diamond, with stray connector stubs and no neighbours, so I can't follow the decision. Step 1's ky picture cuts "Your app" and "Fetch API" in half at the edges. | ky-02, itsd-02-step, ky-01 | For decision flows, frame the step's node plus its in/out neighbours. If that doesn't fit, show a mini overview with the step marked. Don't crop a 3-box context map below its natural width. |
| V3 | major | ky | "Fit all" on the retry flow (10 diamonds) shrinks text to ~5 px, and ~12 edges converge on the two terminal boxes in one bundle of lines. | ky-13 | Route "Give up" and "Wait" as repeated terminal nodes per branch, or keep the readable zoom with a minimap. |
| V4 | minor | all | The pane header's "in X" names the function on the top visible line, which is usually a context line *before* the focus: "in `Ky.#calculateDelay`" over `#calculateRetryDelay`, "in `Signer.sign`" over `verify_signature`, "in `serializer_factory`" over `test_max_age`, "in `Applier.error`". It looks wrong every time. | ky-03, itsd-02-code, itsd-03-code, xpl-03 | Use the first line of the focus range (or the first line below the sticky header that isn't context), or hide the chip while the focus start is visible. |
| V5 | minor | all | The "Related files" card starts with a lone "▼" and then shows "1 file", "Added by the explainer's author", and the path twice. In the itsdangerous bundle "Key: TimedSerializer.default_signer" reads like a *secret key*. On xpl-self step 1 there are 4+ package.json cards that push useful content down. | itsd-01, xpl-01, ky-02 | Put the disclosure triangle in the heading, show the path once, drop the provenance line (or put it in a tooltip), and rename "Key:" to "Via:" or "Field:". Cap at 2 cards with "N more". |
| V6 | minor | ky | Double-clicking "Request engine" on the Map switched to the **Flow** tab without saying so. In the Flow there's no "Key" button (the Map has one), and three boxes are teal with nothing explaining why. | ky-09 | Show a toast or label ("Opened the flow inside Request engine"). Add Key to Flow. |
| V7 | minor | ky | Picking a flow box that is off-screen (keyboard/Enter) selects it but doesn't scroll it into view. | ky-14 (request:7 picked, not visible) | Pan to the picked box. |
| V8 | minor | xpl-self | Tree filter results all truncate to "packages/cli/src…" / "packages/core/s…", so five `apply.ts` matches look identical. | xpl-05 | Show results as `name` + dim parent dir, or truncate from the left. |
| V9 | minor | ky | Inner map edge labels collide ("calls ×5 ━ calls ×15" overlap), and three parallel horizontal lines sit stacked at the same y. | ky-08 | Space labels apart when they collide (as the flow does for loops). |
| V10 | polish | ky | The "See what is inside: One request, from…" button in the topic column overflows the right edge. | ky-11 | Wrap or ellipsize. |
| V11 | polish | ky | Topic details show internal notation: "From Ky.#calculateRetryDelay To Ky.#calculateRetryDelay", "Ky.ts#Ky.#calculateRetryDelay +45..67". | DOM text of "Where this is in the code" on step 7 | Hide From/To when they're equal. Show "Ky.ts, lines 612–634 (in `#calculateRetryDelay`)". |
| V12 | polish | all | The Ctrl+F panel is unstyled CodeMirror (tiny native buttons), and Enter in the field didn't advance to the next match ("next" did). | ky-15 | Style it like the tree filter. Enter = next. |

### Content (what the explainer says)

| id | sev | bundle | What I saw | Suggested fix |
|---|---|---|---|---|
| K1 | major | xpl-self | The step and TOC titles are code (`pack.extract(ctx)`, `mergeExisting(...) / convertFields(...)`, `moved`, `drifted`, `Derived, not stored`). ky and itsdangerous use sentences, which are far easier for a newcomer. | Use sentence titles ("A language pack turns a file into facts"). Keep the call in the step's "This call" chip. |
| K2 | minor | ky | The system map draws two ky→Fetch edges, "hands over requests" and "sends each request", which say the same thing. | Merge them into one. |
| K3 | minor | ky | Every node in the retry flow repeats the subtitle "Ky.#calculateRetryDelay" (10×). It's noise, and it hides that the caller is `#retryFromError`. | Put the owner on the flow title once. Add an entry node "called from #retryFromError". |
| K4 | minor | itsd | Key rotation is explained as mechanism, not as a recipe. | One sentence: "append the new key; keep the old one until max_age has passed; then remove it." |
| K5 | polish | itsd | Step 5's title starts lowercase ("loads tries each signer…"). | Start the title with a capital letter. |

### Authoring tool / bundle

| id | sev | bundle | What I saw | Evidence | Suggested fix |
|---|---|---|---|---|---|
| C1 | **blocker** | xpl-self | Anchors carry stale `resolved.range` with `status:"ok"`. The index in the same bundle has the symbol elsewhere with the **same hash**. Example: `Applier.fail` is resolved at 389-391, but the index says 408-410, so the viewer highlights the end of `Applier.error` as "defined here". **148 of 365 symbol anchors** in xpl-self are off like this (e.g. `hashOf` 312→493, `createReadOnlyEditor` 217→485). ky-repo and itsdangerous have 0. | xpl-03, xpl-06; script comparing anchor `resolved.range` with index symbol ranges | `xpl bundle` (or load in the viewer) should re-resolve each anchor against the bundled index and texts. If the hash matches at a new range, mark it "moved" and use the new range. If it can't be matched, show "drifted" rather than "ok". A test should fail when a symbol anchor's resolved range ≠ the index range with an equal hash. |

## 4. What works (keep it)

- **Guide → Show the code is excellent.** In all three bundles it landed on the exact lines, with a test pane beside them (pink "test" chip, `test_max_age` next to the `raise`). Long lines wrap with a readable indent, and the dimmed context is readable now (the earlier review's fix holds).
- The topic column's one-paragraph answers ("A token exactly max_age seconds old still passes") are the best newcomer content here.
- itsdangerous's step titles read like a story. A newcomer can answer questions from the TOC alone.
- The "Inside ky" parts map is clear and correctly layered. Double-click to go deeper is easy to discover thanks to the zoom glyph on the box.
- Back/Forward and the breadcrumb were reliable. Ctrl+F and the tree filter exist and are fast.
- A 16.9 MB bundle opens in under 0.85 s, and interactions stay under 350 ms.

## 5. How the viewer adapts across levels

- **L1 system (ky):** Map → inner map is good for "what are the parts". The Flow tab suits the request lifecycle, but a 10-way decision tree is too much for the same flow renderer at fit size (V3), and its guide crops are useless (V2).
- **L2 feature (itsdangerous):** the best fit. A small file set, step = one function, and code + test side by side. The diagrams barely matter because the code panes do the work.
- **Big repo (xpl-self):** the viewer copes with the size. The weak points are the authoring (code-signature titles, a sequence picture with ~6 px text in the guide) and the stale anchors, which break the core promise that the highlighted code *is* the thing.
- Across levels, the right column, "Related files" cards, is the same everywhere and rarely helps. It is noisiest on the big repo.
