# Authoring log: itsdangerous, L2 feature question

Request: "/code-explainer explain How is a timed, signed token created by URLSafeTimedSerializer.dumps and verified by loads, including expiry and key rotation?"
Explainer name: `itsdangerous`. Repo: pallets/itsdangerous @ 672971d (Python, src layout).
Wall time: about 5 minutes from reading SKILL.md to bundle (epoch 1791039289 to 1791039574), plus about 2 minutes for this log.
Scope chosen: `explain <question>` (part of a project), with two halves (dumps and loads) plus the expiry decision.

## Commands in order

`X=/home/user/xpl/skill/code-explainer/bin/xpl`, run from the repo root. Patches are in `scratchpad/work-itsd/`.

1. `cat SKILL.md` (read in full), `ls reference`.
2. `X index`. Output: `files: 49 symbols: 477 refs: 349`; `python 15 files 170 symbols refs: precise (scip-python@0.6.6)`, plus json/text/toml/yaml.
3. `X outline --under dir:src --depth 3`. All Python modules, classes and functions are there, with in/out counts.
4. `cat -n url_safe.py timed.py signer.py serializer.py` (plain shell, to read the whole feature quickly; the files are small).
5. `cat reference/writing.md` (in full, as SKILL.md says), then `patch-format.md` sections 1-2, 3.1, 3.3, 3.6, 3.7, 3.8, 3.9, 3.5, 3.2.
6. `X new itsdangerous --title "itsdangerous"`.
7. `X search -i "def dumps" --under dir:src`, `X search -i "def loads" --under dir:src`.
8. `X draft path itsdangerous sym:src/itsdangerous/serializer.py#Serializer.dumps -o dumps.json` (4 calls, 3 participants, 24 TODOs).
9. `X draft path itsdangerous sym:src/itsdangerous/timed.py#TimedSerializer.loads -o loads.json` (4 calls, 4 participants, 24 TODOs).
10. `X show ...Serializer.dumps --refs`, `X show ...TimedSerializer.loads --refs`, `X refs ...TimestampSigner.unsign --out`, `X refs ...URLSafeSerializerMixin.dump_payload --in` (result: `in: none`).
11. `X outline --under sym:...TimedSerializer --depth 2`, `X outline --under sym:...URLSafeSerializerMixin --depth 1`, `X search` for `rotation`, `max_age` and `SignatureExpired` in tests.
12. `X show` on the two tests; `grep` for fallback signers and the URL-safe tests.
13. Ran real code (`PYTHONPATH=src python3 -c ...`): a token signed with `old-key` loads with `['old-key','new-key']`; it fails with `BadTimeSignature` under `new-key` alone; `type(make_signer())` is `TimestampSigner`; a long payload starts with `.`; `max_age=1` after 2 s raises `SignatureExpired: Signature age 2 > 1 seconds`.
14. `X show ...TimestampSigner.unsign` and `...TimedSerializer.loads` to copy offsets.
15. Wrote `feature.json` by hand. It merges both drafts into one tour, re-targets the participants, and adds a map, a flow, 2 `llm` edges and 1 concept.
16. `X lint itsdangerous --patch feature.json`: 21 findings (below), no rejection.
17. Fixed the text with a Python string-replace script, then lint again: 3 findings.
18. Fixed again, then lint: `no findings`.
19. `X apply itsdangerous feature.json`: 20 ids changed.
20. `X validate itsdangerous`: ok. `X status itsdangerous`: `0 unexplained`, but the map showed `19 shown` edges on 6 boxes.
21. `X status itsdangerous --json` to get the edge ids.
22. `hide-edges.json`: hid 8 derived edges into `exc.py` and `encoding.py` (exception constructions and helper calls). Ran lint, then apply. The map now shows 11 edges.
23. `X anchors itsdangerous tour:timed-token`: 18 anchors ok.
24. Accuracy pass by myself, one claim at a time (no subagent). I found 3 claims to narrow (below), wrote `accuracy.json`, then ran lint and apply (5 ids changed).
25. `X validate`, `X lint` (no findings), `X status` (0 unexplained).
26. `X bundle itsdangerous -o out/itsdangerous-feature.html --files boundary`: 1.2 MB, 10 of 49 files embedded, mode explore.

## The note about the first index (Python missing)

The task said an earlier `xpl index` listed only toml/yaml. In my run, `xpl index` listed Python with `refs: precise (scip-python@0.6.6)`. I saw no problem with it: 170 Python symbols, precise refs on every call I checked, and the tests were indexed too.

The only index file is `.explainer/index-672971d.json`. A re-index of the same commit overwrites the old file, so I could not inspect the earlier, bad result. If the first run really dropped Python (for example because scip-python was still installing or timed out), the CLI gave no message that a later run would fix it. The bad index would have looked like a clean result. This is worth a finding: `xpl index` should warn when a language that clearly dominates the repo (`.py` files, `pyproject.toml`) gets no symbols.

## Lint warnings (first pass, 21 findings)

- Tour summary: `long-sentence` (26 words, 28 words), `long-average` (22.0), `absolute-word: "only"`, `code-heavy` (3 code names; the summary takes at most 2).
- `tour-covers-map`: "Base64 helpers, Errors" never come up. This was useful: I named both in t1.
- t1: `long-sentence` (29), `long-average`.
- t6 heading: `absolute-word: "every"` ("Every secret key in the list can verify a token"). The claim is true: `verify_signature` loops over `reversed(self.secret_keys)`, and that line is anchored in the concept. But lint cannot see that the line proves it, so I reworded.
- t7 heading `code-title`: "A token expires only when you pass max_age". I rewrote it as "...only if you ask for an age limit". Lint did not flag the "only" in the new heading, although it flagged "only" in the summary. The absolute-word check looks inconsistent between fields.
- t8 `absolute-word: "never"` and `code-heavy` (4 names). t9 `absolute-word: "every"` and `code-heavy` (5 names).
- `serializer-dumps:3` "all secret keys" and `serializer-dumps:4` "everything before it" (absolute words that are both literally true).
- `expiry-check:4` and `:5` `flow-label-code` ("Was max_age given?", "Older than max_age?").
- file nodes: `long-sentence`; signer.py summary `absolute-word: "every"`.

Second pass (3 findings): `tour-summary: 5 sentences (more than 4)`. My split for `long-sentence` had pushed the summary to 5 sentences, so two rules pulled against each other. Also `repeats-summary` on t3 (the note restated `serializer-dumps:4`) and one more `long-sentence`.

## Accuracy pass corrections (claims I narrowed)

- t4: "Two serializers with different salts produce different signatures". This is true only for the salted key derivations (`derive_key` has a `"none"` mode that ignores the salt). It is now "With the default key derivation, ...".
- t6: "A token signed with an old key stays valid until you remove that key". `max_age` can still reject it. It is now "passes this check".
- `expiry-check:2`: the flow leaves out the "timestamp missing" and "Malformed timestamp" branches. The summary now says so.

## Drafts vs. what I shipped

- The draft's `want_bytes` steps (`serializer-dumps:1`, `timed-serializer-loads:1`) don't matter, so I dropped them. I kept the other step ids and did not renumber them, so the steps run `:2, :3, :4, :5`. That is correct by the rules, but the gap looks odd to a reader of the JSON.
- The draft showed `dump_payload(obj)` as a self-call to `Serializer.dumps`, and `sign(payload)` going to the `Signer` class. The draft already said "Subclasses override it: `URLSafeSerializerMixin.dump_payload`; TODO: say which one runs here". That hint was very helpful. I re-targeted both steps to the classes that actually run (`URLSafeSerializerMixin`, `TimestampSigner`) and added `llm` `calls` edges for the dispatch the index cannot see (`self.dump_payload` resolved by inheritance order, and `default_signer = TimestampSigner`).
- The draft's `load_payload` step went to `Serializer`. I re-targeted it to `URLSafeSerializerMixin.load_payload`.
- There were two drafts with two tours (`tour:serializer-dumps`, `tour:timed-serializer-loads`). SKILL.md wants one primary tour, so I merged them by hand into `tour:timed-token`. No command merges two path drafts. The "two halves" case is named in SKILL.md ("a second process view when the question has two halves") but has no tooling. I discarded both draft tours.
- The draft `scope.question` and the view titles were TODOs. I wrote them.

## Unclear or contradictory docs, and time sinks

- SKILL.md says "keep its ids" for a draft, and also "drop the calls that do not matter". When you drop a step, the step numbers have gaps. The docs never say whether that is fine (rule 5 suggests it is).
- For the question's dumps half, the natural entry point `URLSafeTimedSerializer.dumps` does not exist as a symbol: the method is inherited. I had to know to draft from `Serializer.dumps`. `draft path` could accept the class plus the method name and resolve it through the inheritance order.
- The `absolute-word` rule fires on claims the anchors prove. The fix it suggests ("check every case in the code and anchor it") does not silence it once you have anchored the case. So the only way to a clean lint is to reword a true statement. That is mild pressure toward vaguer text.
- The rules on summary length (`tour-summary` at most 4 sentences, `long-sentence` at most 25 words, `code-heavy` at most 2 names) interact. Fixing one broke another on the second pass.
- The map's derived edges were noisy: 19 edges on 6 boxes, mostly exception "calls" (constructions) and helper calls. `status` printed only "9 static without summary (optional)" and gave no crowding warning. I had to use `--json` to get ids for `hidden`. The skill says a call ref to a type is a construction, but the graph still draws it as a `calls` arrow.
- Reading `patch-format.md` took most of the reading time: about 400 lines across sections 3.6-3.9. The templates are good, but a feature tour needs nearly all of them.
- The `ids changed` count on `accuracy.json` was 5 for 3 text edits. It counts the parent view and the tour as changed too. That is fine but surprising.

## Ids created

- Tour: `tour:timed-token` (9 steps, `t1` to `t9`).
- Views: `view:token-parts` (graph, 6 file boxes), `view:serializer-dumps` (sequence, steps `serializer-dumps:2-5`), `view:timed-serializer-loads` (sequence, steps `timed-serializer-loads:2,3,5,4`, frame `frame:each-unsigner`), `view:expiry-check` (flow, `expiry-check:1-9`).
- Edges: `edge:dumps-url-safe-payload`, `edge:serializer-timestamp-signer` (both `llm`, kind `calls`).
- Concept: `concept:key-rotation`.
- Overlays: 6 file nodes, plus `Serializer.dumps`, `URLSafeSerializerMixin`, `TimestampSigner`, `Signer`, `TimedSerializer.loads` and `TimestampSigner.unsign`.

## Final state

`validate`: ok (strict). `lint`: no findings. `status`: 0 unexplained, 0 drifted, 0 missing. `anchors`: 18 of 18 ok.
Bundle: `out/itsdangerous-feature.html` (1.2 MB, 10 files embedded, including 2 test files).

## Rating: 4 / 5

Why it worked: Python was indexed with precise refs, the path drafts flagged the inheritance overrides, apply had no rejections, and lint found real problems (a map box no step mentioned, a note that repeated a step summary). The loop from lint to apply to status was fast and clear.

Why not 5: I merged two path drafts into one tour by hand. The draft cannot start from an inherited method. The `absolute-word` rule fires on claims the anchors prove, and the length and code-name rules fought each other. The map's derived edges needed manual hiding through `status --json`. And the earlier index that reportedly dropped Python left no trace I could inspect.
