# Manager review (persona key: `manager`)

## 1. Who I am and what I tried

Dana, product/engineering manager. I wrote code years ago and read none now. Someone dropped these HTML files
in Slack with no instructions. I used a MacBook at 1440×900 in light mode, and a phone at 390×844 for two of them.
Shots are in `reviews/shots/manager/`.

| Task | Result | Effort | Where I got stuck |
|---|---|---|---|
| ky-repo: "In 2 minutes: what is ky, what are its parts, what does it depend on?" | **Success** for "what is it" and "what does it depend on". **Partial** for "parts". | About 2 min for the first two. Another 3 min to find the parts. | The first screen's intro paragraph answers "what" well. Step 1 says "no dependencies", and the map shows it uses only the built-in Fetch API. For the parts, I got **two different answers**. The Step 1 "Parts" chips and the topic panel's "Members" list say *core, errors, Public types, utils, Entry point*. The "Inside ky" map shows *Request engine, Options and defaults, Timeouts and waits, Body streaming, Errors, Public types, Entry point*. That map is hidden behind a dropdown or a tiny magnifier icon on the ky box. |
| ky-repo: the Map and the Key | Partial | 3 min | The top map (Your app → ky → Fetch API → Web servers) is the best thing in the whole set. A non-coder gets it at a glance. The Key doesn't explain what I actually see, though: the grey dashed boxes with a globe, the cube and stack icons, the two small buttons inside the ky box, or why there are two purple arrows from ky to Fetch ("hands over requests" and "sends each request" sound the same). Its first row says a box is "a part of the code", but "Your app" and "Web servers" are not ky's code. |
| ky-repo: where to start | Success | — | Guide opens on the intro and Step 1, and the left column lists 9 readable step titles. That is clear. The Flow tab is pure code (`ky.#runBeforeRequestHooks()`), with no Key and no plain-words layer. I left it. |
| ky-change: "What does this mean for users, and is it risky?" | **Success** | About 1 min | The first paragraph answers both. "Without the option nothing changes, because the default is no cap." "Risk: with a cap set, a failed response whose body is over the cap is no longer retried." It adds that 30+ tests cover it. The last step's title is literally "Risk: …", and step 11 is "Many new tests, one gap". I could go into a release meeting with this. |
| ky-change: past the first paragraph | Partial | — | Steps 2-10 and every diagram are engineer-level, e.g. `ky(url, {maxResponseSize: 3}).text()`, call graphs of `Ky.#limitResponseSize`. That's fine. The risk step's diagram is a cropped teal triangle with "your body read / error body" on it, which looks like a rendering glitch (`ky-change-risk-step.png`). |
| xpl-self: step titles | **Fail** (for me) | 30 s | The left column reads `xpl index: buildIndex({ root, precise, commit })`, `pack.extract(ctx)`, `locateText(lines, find)`, `moved`, `drifted`. These are function signatures and lone words, not sentences. I could not tell what any step is about. The cause: when a step's note has no heading and its first sentence is too long, `stepTitle()` falls back to the label of the focused box (`packages/viewer/src/stepTitle.ts:103`). The author wrote no headings, and the viewer silently showed code labels instead. The step 1 diagram is also shrunk to about 7 px text (`xpl-self-first.png`). |
| chi (L3): where do I get lost? | Expected fail | 1 min | The intro's first sentence loses me at "radix tree". By "regexp params, then plain params, then a catch-all `*`" I'm out. The step 1 diagram is all `node.findRoute`/`method`. Step 2's title, "Literal text beats a param, a param beats *", I half follow: specific routes win. It is fine that an L3 page isn't for me. **But nothing on the page says so**, e.g. "for engineers who know the codebase; for an overview see …". |
| Phone: ky-repo and ky-change at 390×844 | Partial | — | No sideways page scroll on either page, and the text is large and readable. The Map works and Fit all is handy. Problems: (1) The "In this guide" list stays pinned and takes about 180 px. The "Where this is in the code" bar takes another 60 px at the bottom. That leaves about 470 px of 844 for reading (`ky-repo-phone-step1.png`). (2) On ky-repo the tour picker runs past the right edge and is clipped: the select ends at x=446, and "2 tours" at x=489 is invisible (`ky-repo-phone.png`). (3) Guide pictures show a sliver: ky-repo step 1 shows only the ky box with the arrows cut off. The ky-change step 1 picture is mostly empty dots with the boxes at the bottom (`ky-change-phone-step1-diagram.png`). |

## 2. Ratings (1-5, from a non-coding manager)

| Level / bundle | Comprehension | Navigation | Code readability | Diagram usefulness | Trust | Overall |
|---|---|---|---|---|---|---|
| L1 ky-repo | 4 | 4 | n/a (didn't read) | 4 top map, 2 inside map, 1 Flow | 3 (parts disagree) | **3.5** |
| L4 ky-change | 4 (intro), 2 (steps) | 4 | n/a | 2 | 4 (calls out risk and test gap itself) | **4** |
| self xpl-self | 1 | 2 | n/a | 1 (unreadably small) | 2 | **1.5** |
| L3 chi | 1 (expected) | 3 | n/a | 1 | 3 | **2** (OK, since it isn't meant for me, but it should say so) |
| Phone (ky-repo, ky-change) | 4 | 3 | n/a | 2 | — | **3** |

## 3. Findings

### Viewer

| id | sev | bundle | What I saw | Evidence | Suggested fix |
|---|---|---|---|---|---|
| V1 | major | xpl-self (any bundle) | A step with no heading and a long first sentence gets the focused box's label as its title, so the guide lists function signatures (`codeFocus([id], model, { derivedEdges })`, `moved`, `drifted`). | `xpl-self-first.png`; `stepTitle.ts:103-110` | Never fall back to a code label silently. Use a truncated first sentence (about 60 chars plus …) or "Step N". Also make `lint` fail when a step has no title (see A1). |
| V2 | major | ky-repo, ky-change | The Key leaves out marks on screen. It has no row for the dashed grey "outside system" boxes (Fetch API, Web servers, Your app), the icons (globe, cube, stack, `m`/`ƒ`/`C`), the in-box buttons (open-inside grid and magnifier), or the "calls ×N" counts. It says every box is "a part of the code", which is wrong for "Your app". | `ky-repo-map-key.png`, `ky-change-map-key.png`; `Legend.tsx` has no actor/system row | Add a row like "Something outside this code: your app, the browser, a server" for actor and system boxes. Add a row for "double-click or 🔍: see what's inside". Explain "×3 = called from 3 places". |
| V3 | major | all | Pages give no audience or level cue. chi throws "radix tree" at me in line 1 with no hint that this is a deep dive or where the overview is. | `chi-algorithm-first.png` | Show a one-line label under the title from the explainer's scope, e.g. "Deep dive · for engineers working on chi's router". Let authors set it. |
| V4 | minor | ky-repo | The top map's dropdown hides the second map, "Inside ky: its parts and what they use", which is the answer to "what are its parts". The select is also truncated ("…what they u"). The only other way in is a 16 px magnifier on the ky box. | `ky-repo-map.png`, `ky-repo-map-inside.png` | Show sibling views as tabs or chips ("2 maps: Outside · Inside"), or put an "Inside ky →" text button on a box that has children. |
| V5 | minor | ky-repo | The Flow tab has no Key, and its boxes are raw calls (`Ky.create(input, validateAndMerge(defaults, options, {method}))`). Its explanation line helps, but it's the only plain text there. The topic panel still says "Public types" from my last Map click while the Flow is about the request engine. | `ky-repo-flow.png` | Keep the topic panel in step with the view, or clear it on a tab switch. Prefer the authored short name in flow boxes and put the signature in small type below. |
| V6 | minor | phone | Sticky "In this guide" (about 180 px) plus a sticky bottom bar (about 60 px) eat about 30% of an 844 px screen. | `ky-repo-phone-step1.png` | On ≤760 px, collapse the guide list into a "Step 1 of 9 ▾" picker, and don't pin it. |
| V7 | minor | phone, ky-repo | The tour picker overflows to x=446 and "2 tours" to x=489. Both are clipped and invisible. | DOM: `LABEL.tour-picker` right=446 at 390 px; `ky-repo-phone.png` | Let the select shrink (`max-width:100%`) and wrap the count below it. |
| V8 | minor | ky-repo desktop and phone, ky-change phone | Guide pictures crop the end boxes ("app", "Fetch AP|"). On a phone only the middle box shows. The ky-change one is centred in a tall, empty panel. On a phone I read the fade as "broken", not "more". | `ky-repo-first.png`, `ky-repo-phone-step1.png`, `ky-change-phone-step1-diagram.png` | At narrow widths, fit the whole picture (small but whole) and offer "Open in Map" for detail. Size the panel to the drawing. |
| V9 | polish | ky-repo | The title is truncated ("ky: a tiny HTTP client built on fe…") at 1440 px, with plenty of empty header space. | `ky-repo-first.png` | Truncate later, or wrap it. |
| V10 | polish | xpl-self | The right column says "Related files" with cards reading "READS", "ITS SETTINGS ARE IN", "Key: description", "Found in the code", "Added by the explainer's author". "Key:" collides with the map's Key button and means something else (a JSON key). | `xpl-self-first.png` | Use "field `description`". Group by file, and drop the per-card source line or put it in a tooltip. |
| V11 | polish | ky-repo | The topic panel has two near-identical actions: "See what is inside: Inside ky…" and "Show the inside here". | `mgr7` DOM dump | Keep one, or name the difference ("Open as its own map" vs "Expand in place"). |

### Content (what the author wrote)

| id | sev | bundle | What I saw | Evidence | Suggested fix |
|---|---|---|---|---|---|
| C1 | major | ky-repo | The parts disagree. The Step 1 "Parts" chips and "Members" list core / errors / Public types / utils / Entry point (folders). The "Inside ky" map lists 7 different named parts. A manager can't tell which list is the answer. | `ky-repo-first.png` vs `ky-repo-map-inside.png` | Make the members of the `ky` group the same named parts as the inside map, or label the chips "Folders". |
| C2 | minor | ky-repo | Every box in "Inside ky" carries the subtitle "component", which says nothing. Two purple arrows from ky to Fetch carry near-synonyms ("hands over requests", "sends each request"). | `ky-repo-map-inside.png`, `ky-repo-map.png` | Use the subtitle for a role ("the main loop", "error types"), and merge the duplicate arrows. |
| C3 | minor | ky-change | The risk only appears as the last of 12 steps, and its picture is a cropped decision diamond. The intro already states the risk well. | `ky-change-risk-step.png` | Put the risk step second, or give the intro a "Risk" and "User impact" line. Use a map or no picture for the risk step. |
| C4 | minor | ky-change | Step 1 starts with code (`ky(url, {maxResponseSize: 3}).text()` on 🦄). A sentence like "If you set a 3-byte cap, a 4-byte reply fails" would carry it. | `ky-change-step1.png` | Lead with the plain sentence, then the code. |
| C5 | major | xpl-self | The step notes have no headings and long first sentences. Labels like "moved", "drifted", "Derived, not stored" stand alone as titles. | `xpl-self-first.png` | Write a heading per step (A1 would catch this). |

### Authoring tool

| id | sev | What | Fix |
|---|---|---|---|
| A1 | major | xpl-self shipped with titles from code labels. Nothing stopped an untitled tour (there's no authoring log for this bundle, but the result shows it). The ky-repo log shows lint already has a `code-title` rule for headings, but it doesn't fire when there is no heading. | Make lint flag a step whose title would come from the `stepTitle` fallback ("untitled-step"), and run the `code-title` check on the fallback too. |
| A2 | minor | There is no field or prompt for the audience or level (V3). | Add a `scope.audience` line that the viewer shows under the title. |

### Words I did not understand (jargon list)

- **Viewer chrome:** Key rows "Related to the one you picked" (related how?) and "A link the explainer's author added: an event, a setting, a request" (who is the author: Claude? the dev?); "Show source" vs "Read its explanation"; "Edit ▾" (edit what? I'm a viewer); "Fit" vs "Fit all"; "Members"; "Technology"; "defined here"; "L1–1323"; "Show 23 more references"; "Show the inside here"; "Code that calls what changed"; "calls ×28"; "writes ×4"; pills "method", "function", "file", "class", "component"; icons `m`, `ƒ`, `C`; "+801 −25"; "test-d/"; xpl-self's "READS", "ITS SETTINGS ARE IN", "Key: description", "Found in the code", "Added by the explainer's author", "Related files".
- **ky-repo text:** Fetch API, `fetch`, TypeScript, Node.js/Bun/Deno, hooks, instance, class, runtime, "Public types … hold no runtime code", `Ky.#fetch`, `createInstance`, `response.ok`, Retry-After header, 404/429/500/503, search params, `replaceOption`, "resolves", "throws", "aborts".
- **ky-change text:** ResponseSizeError, HTTPError, KyError, "type guard", `isResponseSizeError`, Content-Length, "after decompression", chunk, stream, "cancels the source stream", afterResponse hooks, clone, Chromium body methods, `copyResponseMetadata`, `kyOptionKeys`, "normalized options", `ky.create()`/`.extend()`, `shouldRetry`, "can resolve before the cap is hit", "rejects".
- **xpl-self:** SCIP, heuristic/precise references, "actor llm", applyPatch, "moved", "drifted", "Derived, not stored".
- **chi:** radix tree, node, regexp params, catch-all `*`, "backs up", param, routing context, delimiter, "first byte", URLParams, `Mux.routeHTTP`.

The ky-change intro and the ky-repo intro and top map get by with almost none of this, and that is the point to keep.

## 4. What works (keep it)

- **ky-change's intro paragraph** is a model release note. It covers what changed, the default ("nothing changes"), an explicit "Risk:" sentence and test coverage, and it calls out a test gap itself. It also names its own last step "Risk: …". This is exactly what a manager needs.
- **The ky-repo top map** (Your app → ky → Fetch API → Web servers) is readable without any training.
- Step titles written as sentences in ky-repo, ky-change and chi ("A failed status becomes an error you can catch") make the left column a readable summary on its own.
- "Files in this change", with New/Changed pills, +/- counts and a "test" tag, tells me the scale of the change at a glance.
- The phone layout has no sideways scroll, a readable font size, and a usable Map with Fit all.
- The previous round's jargon fixes held. I didn't meet "inferred relationship" or "configured by".

## 5. How the viewer adapts across levels

The same viewer suits a manager at **L1 and L4, as long as the author writes a plain intro**. Both pages put the answer in the first paragraph. The chrome (Guide first, step list, "Open in Map") is the same everywhere, so I learned it once. It breaks down in two places. First, **pictures are code-level by default**: Flow boxes, change maps and chi's maps all show `method`/`function` signatures. Only an authored system map, like ky's top map, speaks plain language. Second, **the page never says who it's for**, so the L3 chi page and the self-hosted xpl page look just as approachable as ky's, then lose me in line 1. A level or audience line, a Key that covers every mark, and a title fallback that never prints a signature would make the same viewer fit all four levels honestly.
