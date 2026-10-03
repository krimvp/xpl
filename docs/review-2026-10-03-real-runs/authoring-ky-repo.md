# ky (L1, whole-repo architecture + talk): authoring-UX log

Request: "/code-explainer explain this repo", then "make a tour" (Present-mode talk). Explainer name `ky`.
Repo: sindresorhus/ky @ 0d59458 (TypeScript, 31 source files, ~1,200 symbols, precise refs via scip-typescript).
`X` = `/home/user/xpl/skill/code-explainer/bin/xpl`, run from the repo root. Patches in `scratchpad/work-ky/`.

## Commands, in order

| # | Command | Result |
|---|---------|--------|
| 1 | read `SKILL.md`, `reference/writing.md`, `reference/patch-format.md` (sections 1-3.9, 3.10 by grep) | ~1,000 lines of docs before the first command |
| 2 | `X index` | ok (index already current; re-ran, quick) |
| 3 | `X new ky --title "ky: a tiny HTTP client built on fetch"` | ok |
| 4 | `X outline --depth 2` | ok; tests and `test-d/` dominate the output |
| 5 | `X outline --under dir:source --depth 2`; `head readme.md`; `X outline --keys --under file:package.json` | ok |
| 6 | `X draft repo ky -o work-ky/repo.json` | ok: "2 maps of 9 boxes, 6 summaries, 2 groups, a tour of 8 steps, 24 anchors, 48 TODOs"; one outside system "Outside HTTP API (HTTP)" |
| 7 | `X show file:source/index.ts`; `sed` on the draft's outside-system anchor lines | found the draft's outside-system anchors are wrong (see below) |
| 8 | `X outline --under file:source/core/Ky.ts --depth 2`; `X search "fetch(" --under source --code` | ok |
| 9 | `X show` on `Ky.#fetch`, `Ky.create`, `Ky.constructor`, `Ky.#retryFromError`, `Ky.#calculateRetryDelay`, `Ky.#retry`, `Ky.#runBeforeRequestHooks`, `Ky.#calculateDelay`, `validateAndMerge`, `timeout`, `calculateRetryTimingDelay`, `getRetryTimingHeader`, `Ky.#throwProcessedError`, `Ky.#runAfterResponseHooks`, `normalizeRetryOptions`, `KyError`, `HTTPError`, `streamResponse`, `limitResponseSize` | ok |
| 10 | `grep -n "^#\|bundle" reference/cli.md` | to check `bundle --files` and `draft path` options |
| 11 | `X draft path ky 'sym:source/core/Ky.ts#Ky.create' -o work-ky/path.json` | ok, but not used (see below) |
| 12 | wrote `work-ky/repo.json` by hand (rewrote the draft) | |
| 13 | `X lint ky --patch work-ky/repo.json` | **rejected**, 1 error + 1 warning (below) |
| 14 | python fix; `X lint ky --patch ...` | 13 findings (warnings) |
| 15 | python rewrite of 8 texts; `X lint ky --patch ...` | 1 finding (`absolute-word: "all"`) |
| 16 | `sed` fix; `X lint --patch` → `X apply ky work-ky/repo.json` → `X validate ky` → `X status ky` | lint clean, applied 21 ids, valid, **7 unexplained** (sequence and flow participants) |
| 17 | `X outline --under file:source/types/hooks.ts`; `X search "hooks.beforeRetry"`, `"hooks.afterResponse"` | ok |
| 18 | wrote `work-ky/talk.json` (7 participant overlays, `concept:hooks`, `tour:talk`); `X lint --patch` | 1 finding: `tour-covers-map` "Web servers" |
| 19 | `sed` fix; `X lint --patch`; `X apply`; `X validate`; `X status`; `X anchors ky tour:talk` | clean; 0 unexplained; 8/8 anchors ok |
| 20 | self accuracy pass (no subagent tool in this session) → `work-ky/fix1.json` (`stepsUpdate` on t1, t6, t7, k6); `X lint --patch`; `X apply`; `X validate`; `X lint ky`; `X status`; `X anchors ky tour:overview` | clean; 15/15 anchors ok |
| 21 | `X bundle ky -o out/ky-repo.html` | 2.0 MB, 32 of 103 files, mode explore |
| 22 | `X bundle ky -o out/ky-talk.html --tour tour:talk` | 2.0 MB, mode present |

3 patch files applied (repo.json, talk.json, fix1.json); 1 rejection; 4 lint rounds on the first patch.

## Failures and exact messages

Step 13 (`lint --patch`, first try):

```
rejected: 1 error, nothing was applied to .explainer/ky.explainer.json (patch from ../../work-ky/repo.json)
warning edges[0].anchors[1] [edge:app-ky]: span source/index.ts#createInstance +3..7 starts on a blank line (line 13): probably off by one, the code in it starts at line 14 (offset 4); check the offsets with `xpl show` or `xpl anchors`
error   edges[4].anchors [edge:timing-fetch]: llm edge edge:timing-fetch needs at least one anchor inside its to (grp:fetch): a place in one of the group's members, or in one of its own anchors. Evidence is required at both ends (e.g. the call site and the target's definition).
nothing linted: fix the patch, then run `xpl lint --patch` again
```

- The off-by-one was mine: I read the offset column of `xpl show file:source/index.ts` (file-relative) and used it as a symbol-relative span on `createInstance`. Easy mistake when the same code was printed with file offsets; the warning caught it and gave the right offset.
- The edge error was clear and actionable: I added the `timeout.ts` fetch call to `grp:fetch`'s own anchors.

## Lint warnings (all fixed, none kept)

Round 2 (13 findings): `bare-it` (tour summary sentence 2), `tour-covers-map` ×2 ("Web servers", "Timeouts and waits"), `absolute-word` ×5 ("never", "every" ×2, "only" ×2), `code-heavy` ×4 (t2, t3, t8, t9), `code-title` ("One request, from ky.get() to a response").
Round 3: `absolute-word: "all"` in t9 ("all of them share KyError" was true per `KyError`'s doc comment, but I narrowed it instead of anchoring each subclass).
Talk patch: `tour-covers-map` "Web servers" again.

## Where the draft was wrong

1. **Outside system was a false positive.** `draft repo` reported "Outside HTTP API (HTTP), found: ky" and anchored it at `constants.ts:166`, `ResponseSizeError.ts:9`, `ResponsePromise.ts:29`, `merge.ts:36`, `test-d/fetch-options.ts:2`. Those are `import ky from 'ky'` lines **inside JSDoc `@example` blocks**: the library importing itself in documentation. It also drew five edges (`edge:core-http-api`, `edge:errors-http-api`, ...) from every folder to that box, one from `test-d`. I replaced all of it with a `Fetch API` box (anchored at `globalThis.fetch` and the `fetch(...)` call) and a `Web servers` box.
2. **`test-d/` (type tests) was a member of the service and a box on the inside map**, with a tour step (t8). `excludeFiles` does not cover `test-d/**`. Removed; added `test-d/**` to `excludeFiles`.
3. **Folder boxes, not responsibilities.** `core` (3 files) mixes the 1,300-line request engine with constants and retry-timing parsing; `utils` (10 files) mixes options merging, timeouts, body streaming and error checks. I regrouped into Request engine / Options and defaults / Timeouts and waits / Body streaming / Errors / Public types.
4. **No "your app" box** on the system map: for a library, the caller is the main user; the draft only had the library and the false outside API.
5. **`draft path` on `Ky.create`** produced a 12-call sequence that is mostly self-calls on `Ky.create`, and its cap dropped the two calls that matter (`#runBeforeRequestHooks`, `#retry` → `fetch`). It notes "calls left out ... (at most 12 calls and 6 participants)". I wrote the sequence by hand instead (5 participants, 9 steps) and did not copy anything from path.json.
6. The draft's t1 code anchor was `createInstance` while the note is about the README; fine but redundant.

## Where the docs were unclear or contradicted each other

- **Bundle default.** SKILL.md "Show the result" says `--files boundary` "is the default in remote or cloud sessions"; `cli.md` says `--files referenced` is "the **default**". The brief told me to use the default, so I omitted `--files`; a user following SKILL.md literally would pass `boundary`.
- **"The first step on the inside lists the files left off the map"** (SKILL.md, explain repo, step 2) vs. `code-heavy` lint (max 1 code name on an architecture-map note). Listing `is.ts` and `types.ts` by name tripped `code-heavy`; I ended up writing "Two tiny helper files are left off this map", which is vaguer.
- **Participant summaries.** patch-format 3.2 says sequence/flow participants count as unexplained until they have a summary, "so write overlays for them in the same patch", but nothing in SKILL.md's workflow or the view templates (3.7/3.8) repeats that; I only found out from `status` (7 unexplained) after applying.
- **`tour-covers-map` matches the box label literally** (case-insensitive, it seems). "talks to the web server" did not count for the box "Web servers"; "talks to web servers" did. Not documented; cost one extra lint round in each tour.
- **"make tour" is thin**: "A talk built from existing views ... Default: the newest question's views plus the overview." For a repo explainer the "newest question's views" are the overview itself, so a second tour largely repeats `tour:overview`. Unclear whether the talk should be a new tour or `--tour tour:overview` on the existing one. I made a separate, shorter `tour:talk` with presenter-length notes.
- **"Every graph view a tour uses has `excludeFiles` for tests ... The drafts set both"**, but the draft's list is generic (`**/*_test.go`, `test_*.py`) and misses this repo's `test-d/`.
- **Accuracy pass by subagent** assumes an Agent tool; this session had none, so I did the "second, separate pass yourself". Fine, but it is the step most likely to be skipped silently.
- `apply` of `fix1.json` reported "6 ids changed" for a patch that touches two tours; the count looks like steps + tours, not ids.
- Reading cost: SKILL.md (206 lines) + writing.md + patch-format.md sections 1-3.10 (~700 lines) before writing anything. The templates are good, but 3.7 and 3.8 alone are ~250 lines of JSON.

## Time sinks

1. Investigating the draft's outside-system anchors (they look plausible until you `sed` the lines and see JSDoc examples).
2. Rewriting the draft into a responsibility-based map: effectively hand-writing the whole patch (~600 lines JSON) instead of filling TODOs; maybe 40% of the run.
3. Writing the 10-step retry flow with `next` branches and spans copied from `show` output.
4. Lint round-trips on wording (`code-heavy`, `absolute-word`, label matching): three rounds on the first patch.

## Result

- Explainer: `proj/ky/.explainer/ky.explainer.json` (written into the repo checkout).
- Views: `view:system` (graph, 4 boxes), `view:overview` (graph, 8 boxes), `view:request` (sequence, 5 participants, 9 steps, 2 frames), `view:retry-decision` (flow, 10 steps).
- Groups: `grp:your-app`, `grp:ky`, `grp:fetch`, `grp:http-api`, `grp:options`, `grp:timing`, `grp:errors`. Edges: `edge:app-ky`, `edge:ky-fetch`, `edge:fetch-http-api`, `edge:engine-fetch`, `edge:timing-fetch`. Concept: `concept:hooks`.
- Tours: `tour:overview` (9 steps, t1-t9), `tour:talk` (6 steps, k1-k6).
- Final checks: `validate` ok (strict, no warnings); `status` 0 unexplained / 0 drifted / 0 missing; `lint` 125 texts, no findings; `anchors` 15/15 and 8/8 ok. 8 static edges on the inside map have no summary (status calls them optional); left as is.
- Bundles: `out/ky-repo.html` (explore, default `--files referenced`, 32 of 103 files, 2.0 MB), `out/ky-talk.html` (same, `--tour tour:talk`, present mode).
- Not checked by running code; claims checked only against `show`/`anchors` output. Default-setting claims (limit 2, 0.3 s doubling, 10 s timeout, retry methods and statuses) come from `normalize.ts` and `Ky.constructor`.

## Rating: 3 / 5

Good: precise refs made `show`/`search` fast and trustworthy; the rejection and off-by-one messages were exact and fixable in one edit; lint caught real wording problems; `stepsUpdate` made the accuracy fixes cheap; validate/status/anchors give a clear "done" signal.
Costly: for a library repo the repo draft was mostly wrong (false outside system from doc-comment imports, type tests as a component, folder boxes), and `draft path` dropped the important calls, so the draft saved little over writing from the templates. Docs are long and have a couple of contradictions (bundle default, "list the files left off" vs `code-heavy`), and the participant-summary requirement surfaces only after apply.
