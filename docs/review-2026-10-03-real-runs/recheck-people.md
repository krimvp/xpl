# Re-check, key `people`: reviewer (Lena) and manager (Dana)

New bundles in `out2/`, at 1440×900 light and on a phone (390×844, isMobile). The content is checked against `git show 0d59458` in `proj/ky-change`.
Screenshots are in `recheck/shots/people/` (15 files) and the driving scripts are in `recheck/tmp-people/*.mjs`.
I skipped xpl-self.html: its mtime is 18:14, before I started at 18:43, as the brief says to do.

## 1. Round-1 findings

### Reviewer (persona-reviewer.md)

| id | status | evidence |
|---|---|---|
| V1 change row hidden in the disclosure | **fixed** | The box detail shows "Added by this change · +22 −0 · Show the change" under the summary, outside "Where this is in the code" (`kc-body-n4.png`, `kc-map-sel.png`). |
| V2 no +/− on "Edited by" | **fixed** | `#readResponseText` "Edited by this change · +6 −2", which matches the diff. `Ky.create` shows +1 −2. |
| V3 "in X" names the wrong symbol | **fixed** | Step 6 shows "in Ky.#readResponseText" and step 3 shows "in Ky.#runAfterResponseHooks". On body.ts no wrong name appears. |
| V4 mini diagrams cropped | **fixed** | The step 5 and 11 flow pictures show the whole diamond and both outcomes (`kc-card5.png`, `kc-card11.png`). One leftover is under §2 N2. |
| V5 Before badge "used here", mismatched counts | **fixed** | The Before header now reads "Before (base 071a9b9) … removed in 7 places", with no role badge (`kc-s6.png`). |
| V6 "Show changes" toggle state | **fixed** | It is now a checkbox ("✓ Show changes", aria-pressed). |
| V7 tree too narrow | **fixed** | The tree is about 230 px wide and every test-d/test name is shown in full. |
| V8 map does not refit when code opens | **not fixed** | After "Show the change", 5 of the 8 boxes are clipped at the split (`kc-map-showchange.png`), and only "Fit all" brings them back. |
| V9 pill widths, test-d not tagged | **fixed** | Every pill is 82 px, the paths line up at x=393, and `test-d/response-size.ts` has a "test" tag. |
| V10 flow step shows only its "from" box | **fixed** | Step 5 "This call: limitResponseSize → Reject the body read → copyResponseMetadata". |
| V11 boundary files unmarked | **partly (not re-tested)** | out2 has no boundary bundle. The code has `BoundaryReason` caller/callee/test and commit 41b461e "context files". |
| C1 size-flow:7 drawn from #readResponseText | **fixed** | Now from `limitResponseSize` to `copyResponseMetadata`. |
| C2 "nothing changes" | **fixed** | The summary says "…stays the same except for download progress, which now reads the response itself instead of a clone". Step 7 says this applies to anyone who sets onDownloadProgress. Both are true to the diff (`streamResponse(response, …)`, cancel removed, the stream.ts test renamed). |
| C3 unmentioned details | **fixed** | Step 6 names the new `.catch` on the timer cleanup (L936). Step 7 says streamResponse wraps the response itself. (My round-1 "isKyError by name" was imprecise: the diff only adds `isResponseSizeError` to the OR chain, so leaving it out is fine.) |
| C4 6 changed files unanchored | **partly** | `types/options.ts` (244-262, the exact JSDoc and type), `index.ts` (77-86) and `hooks.ts` (256) are now anchored. readme, HTTPError.ts and KyError.ts are named but not shown. `type-guards.ts` lost its anchor and is now only named. `test-d/response-size.ts` is never mentioned. |
| C5 10 MiB interaction, sync vs async validation | **fixed** | Step 11 covers the 10 MiB limit, and it is true: `maxErrorResponseBodySize` returns undefined before a cap above 10 MiB fires. Step 12 covers the sync TypeError against the async RangeError, and `Ky.create` lines 190-196 match. |
| C6 "no longer retried" framing | **fixed** | The summary says "not retried, by design", and step 11 says "The readme says this is intended". |
| C7 map islands, Tests "Changed" | **partly** | There is now one "Attach the cap" group, with 8 boxes. Tests, `#readResponseText` and `constructor` are still unconnected islands, and "Tests of this change" is still labelled "Changed" although 2 of its 3 files are new. |
| A1 boundary picks callees nobody names | **partly (not re-tested)** | The selection now records a reason. I made no bundle to check it. |
| A2 code-heavy and absolute-word push vagueness | **partly** | code-heavy now leaves example values out (lint.ts:1257). The author still had to turn four error-class names into prose, and absolute-word still flagged a correct "only" (CONTENT-FIXES §Friction). |
| A3 no warning for an unanchored changed file | **partly** | The `change-not-shown` rule exists, but a bare file name in a note satisfies it, so 5 changed files still appear in no step's code. |

### Manager (persona-manager.md)

| id | status | evidence |
|---|---|---|
| V1 code labels as step titles | **fixed (in code)** | `stepTitle.ts` now falls back to a cut first sentence or "Step N", never a label. Lint has `untitled-step`. I did not look at the xpl-self bundle (see above). |
| V2 Key misses marks | **fixed** | The Key now covers outside boxes, icons (part of it, outside code, program, system, file, group, m, ƒ), open-inside and show-parts buttons, "calls ×3", and the Changed/New pills. Each view has its own Key (`kr-key.png`, `kc-key.png`). |
| V3 no audience cue | **partly** | The viewer shows the line: ky "Overview, for anyone new to ky", ky-change "For reviewers of this change, and anyone who sets maxResponseSize". chi still has none (scope not set), so "is this for me?" still fails there. |
| V4 inside map hidden | **fixed** | An "Inside ky →" link sits under the map title. The select is still truncated ("…what they u"). |
| V5 Flow has no Key, raw calls, stale panel | **partly** | Flow now has a plain Key. Its boxes are still raw signatures (`Ky.create(input, validateAndMerge(defaults, options, {method}))`). The topic panel still says "ky" after switching from the Map (`kr-flow.png`). |
| V6 pinned list on the phone | **fixed** | The list is replaced by "Step 1 of 9: …" and nothing is sticky except the bottom "Where this is in the code" bar. |
| V7 tour picker clipped on the phone | **fixed** | The picker spans x 20-370, and "2 tours" wraps below it. The page has no sideways scroll. |
| V8 guide pictures crop on the phone | **partly** | The ky-repo phone picture now shows all 4 boxes (`ky-repo-phone-fig.png`). The ky-change phone picture still has slivers of two cut-off boxes at its top edge (`ky-change-phone-fig.png`). |
| V9 title truncated | **fixed** | The header shows the full title. The breadcrumb link still cuts it ("…built on fe…") with space to spare. |
| V10 "Related files" wording | **partly** | "Key:" is gone. The per-card "Found in the code" and "Added by the explainer's author" lines remain (RelatedFiles.tsx:59-62). |
| V11 two near-identical "inside" actions | **fixed** | The topic panel no longer shows the duplicate actions. |
| C1 parts disagree | **fixed** | The Step 1 "Parts" chips are the 7 named parts of the "Inside ky" map. |
| C2 "component" subtitles, synonym arrows | **partly** | ky→Fetch is now a single "hands over requests" arrow. Every inside-map box is still subtitled "component" (`kr-inside.png`). |
| C3 risk only in the last step | **partly** | The intro has an explicit "Risk:" sentence. The two risk steps are still 11-12 of 12, though their pictures now render whole. |
| C4 step 1 opens with code | **partly** | It now opens "Before, Ky read any body to the end", but the second sentence is still code. |
| C5 xpl-self untitled steps | **not re-tested** | xpl-self was skipped. |
| A1 lint for an untitled step | **fixed** | `untitled-step` is in lint.ts:66/94, and lint exits 1 on any finding. |
| A2 audience field | **fixed** | `scope.audience` exists. ky, itsdangerous and ky-change set it. |

## 2. New issues (or newly seen)

| # | sev | where | what | evidence | fix |
|---|---|---|---|---|---|
| N1 | minor | viewer | The step list and step picker drop a literal `*` inside a code span. chi step 2 reads "Literal text beats a param, a param beats" (the h3 keeps `<code>*</code>`). This was already in out/, so it is not a regression. | `chi-first.png`; `stepTitle.ts:29` `.replace(/[*\`]/g, "")` | Strip code-span backticks only, and keep the span's content. |
| N2 | minor | viewer | Change-map guide pictures still show stubs of cut-off neighbours: an arrow from an unseen box above "Attach the cap" on desktop, and pill fragments on the phone. | `ky-change-phone-fig.png` | Include the parent box in the frame, or drop edges whose other end is off-frame. |
| N3 | minor | viewer | After "Show the change" from a map box, the map does not refit (this is V8 again, and still bad: 5 of 8 boxes clipped). | `kc-map-showchange.png` | Refit or pan on container resize. |
| N4 | minor | content | `type-guards.ts` lost the anchor it had in round 1, and `test-d` is never mentioned. The CLI accepts this. | change.json t90 | Anchor `isResponseSizeError` in step 8. Make `change-not-shown` require a range, not a name. |
| N5 | polish | content | Step 12 (beforeError, sync throw) reuses step 5's "Reject the body read" flow picture, which illustrates neither point. | step 12 card | Show no picture, or the hooks.ts and Ky.create code first. |
| N6 | polish | viewer/content | The Key says "Something outside this code: your app…", but "Your app" is drawn as a solid "whole system" box. | `kr-key.png` | Change the Key's example, or draw "Your app" as an actor. |
| N7 | polish | viewer | Flow box labels run past the box (`ky.#runAfterResponseHooks(response)`) at about 9-10 px. The edge label "races fetch with a timer" on the inside map is crossed by its own line. Caller rows truncate names ("Ky.#limitResponse…") while space is free. | `kr-flow.png`, `kr-inside.png`, `kc-body-n4.png` | Wrap the labels and let the name column grow. |

No regressions in what Lena and Dana use, apart from the type-guards.ts anchor (N4).

## 3. Ratings (round 1 → round 2)

**Lena (L4 ky-change, default bundle):** Comprehension 4.5→**5**, Navigation 3.5→**4.5**, Code readability 4→**4.5**, Diagram 3→**3.5**, Trust 3.5→**4.5**, **Overall 4→4.5**.

**Dana:**

| | Round 1 | Round 2 |
|---|---|---|
| L1 ky-repo | 3.5 | **4.5** (parts agree, the Key is complete, Inside link) |
| L4 ky-change | 4 | **4.5** |
| L3 chi | 2 | **2** (still no audience line) |
| Phone | 3 | **4** |
| xpl-self | 1.5 | not re-tested |

## 4. Tasks re-run

| Task | Round 1 | Round 2 |
|---|---|---|
| Lena: "is the PR safe to merge" | success, about 5 min | **success**, about 4 min. Steps 11-12 now carry all three of my round-1 asks. |
| Lena: walk every changed file | partial, about 15 min | **success**, about 10 min. Files list → change 1/8, n/p, A/M marks with tooltips, Before panes "removed in N places", change rows and callers unfolded. |
| Lena: claims vs `git show` | success | **success**. Every anchor range (13 checked) and every claim checks out, including the 10 MiB nuance and the sync/async validation. |
| Lena: default vs boundary | success | not re-run (no boundary bundle in out2) |
| Dana: ky-repo in 2 minutes | partial (parts) | **success**, about 2 min |
| Dana: Map and Key | partial | **success** |
| Dana: ky-change user impact | success, about 1 min | **success**, about 1 min. "Stays the same except for download progress" is one more line to parse. |
| Dana: chi "is this for me?" | fail (no cue) | **fail**. The viewer supports the line, but chi's scope is not set. |
| Dana: phone 390×844 | partial | **success** on ky-repo, **partial** on ky-change (picture slivers). |
| Dana: jargon | — | Mostly the same words remain ("explainer's author", "Edit ▾", "removed in 7 places", "calls ×1"). The Key now explains ×N and the pills. |
