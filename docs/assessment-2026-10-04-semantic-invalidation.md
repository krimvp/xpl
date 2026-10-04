# Dependency invalidation for semantic resolution

Date: 2026-10-04. Decision for [#17](https://github.com/krimvp/xpl/issues/17), under
[#8](https://github.com/krimvp/xpl/issues/8), after #16's extraction cache merged in PR #50.

## Decision

Keep full resolution in the default indexing pipeline. Retain this TypeScript-pack experiment as a runnable
investigation, off by default. Do not broaden it to all providers or persist resolved graphs yet.

The prototype matches every clean snapshot in the mutation harness and the pinned history replay. That is
evidence for this bounded dependency model, not proof that reference edges capture all semantic dependencies.
The conservative model often resolves the entire project. An ordinary `xpl index` invocation also starts a
new process, so it cannot reuse this experiment's in-memory state. Extraction reuse from #16 still applies.

## Scope and interface

`packages/indexer/src/resolve/typescript-experiment.ts` owns the experiment. The caller explicitly creates
one `TypeScriptResolutionExperiment` and passes it as `BuildIndexOptions.experimentalResolution` on each
build. The CLI never supplies that option. No schema, patch, bundle, provider trust label or default index
result changes. No semantic facts are written to `.explainer/cache` or handed to external tools.

The bounded provider is tree-sitter's TypeScript pack, including TypeScript, TSX and JavaScript. Additional
heuristic packs trigger full resolution. Config-format packs, resource resolution, provider normalization,
merging and coverage remain fresh. Go's inference hook remains fresh even when the experiment falls back.

The caller can inspect `experiment.report`: resolved and reused file paths, project fallback reason,
dependency-edge count, dependency-bookkeeping wall time and actual resolver wall time. `work` still measures
the complete heuristic phase, including bookkeeping and pack inference. Reports do not enter `SymbolIndex`.

Two designs were considered:

- Track each semantic lookup, failed lookup and module probe in the resolver. This could invalidate fewer
  sites, but requires instrumentation throughout lexical, export, type, inheritance and candidate lookups.
  A missed negative dependency could publish a stale edge.
- Track a conservative file dependency closure around the existing resolver. This prototype selects that
  smaller design. It rebuilds all lookup tables but visits sites only in invalidated files. It over-invalidates
  on purpose rather than changing the resolver's lookup rules.

## Reuse contract

#16's `ExtractionCache.extract` optionally reports its exact versioned input to the experiment. This is the
same input used for cache addressing and exact collision checks: source string, path/language,
provider/profile/indexer/extraction revisions and actual runtime/grammar WASM identities. The callback is
unavailable when directory-identity eligibility or WASM compatibility fails. No second source-hash scheme
is introduced. Normalized symbol entries are also compared exactly, including IDs, positions and hashes.
`SEMANTIC_REVISION` separately versions resolver/module rules. No grammar or extraction revision bump was
needed because the extracted facts and cache envelope did not change.

Every file depends on its import targets, re-export targets, side-effect/dynamic import sites and all
TypeScript-pack peers in its directory. The directory dependencies cover last-resort class candidates,
including absent methods and ambiguity. Reverse traversal over both previous and current dependencies
invalidates callers transitively. That covers return types, imported variables, fields and inherited members
as they are represented by the existing heuristic. A dirty file replaces its whole reference list, so stale
edges disappear. An unchanged file retains its complete list, including the empty list for unresolved sites.

Project-wide fallback applies when:

- File discovery or language identity changes. New files can satisfy a missing declaration or take priority
  over an existing module probe. Deletions and renames can remove targets or expose an alternative.
- Configuration changes. The guard compares every captured non-TypeScript source and all module-resolution
  text reads. Missing reads are retained and retried; ignored/unindexed configs and relative `extends` are
  included. This also conservatively invalidates on unrelated non-code edits.
- Another heuristic pack is present, or any TypeScript extraction identity is unavailable. Examples include
  `cache: false`, a cache directory alias, missing or incompatible WASM and failed extraction. These cases
  discard retained state. A repository-root change likewise cannot reuse the previous references.

The directory-identity rule stays in #16's cache: device/inode comparison against the repository census,
including empty and ignored directories and directory links. The experiment does not create or redirect a
second cache. A warmed experiment followed by a real source-directory symlink bypass is tested explicitly.

The dependency graph is conservative and can grow quadratically within a directory. It is not a general
compiler dependency graph. Unsupported language features have the same limits as a fresh heuristic build.
Matching clean output does not turn those references into precise ones.

## Correctness harness

`scripts/semantic-invalidation-scenarios.ts` is shared by vitest and the reproduce script. Six sequences
compare 37 complete incremental snapshots with independent `cache: false` builds. Every index field and the
whole warning list are compared: declarations, references, source/anchor hashes, resources, provider
provenance, capabilities, diagnostics and snapshot identity. JSON serialization only normalizes absent
versus undefined optional properties, as in #16. No saved field is excluded or sampled.

Each sequence also checks literal call targets or their disappearance. The cases cover:

- Declaration removal and restoration; named, star and cyclic re-exports.
- Return-type changes, changed bases, inherited method removal and restoration in unchanged callers.
- Ignored extended config edits, deletion and creation; workspace package exports.
- An unresolved caller becoming resolved after file addition; a higher-priority module appearing, removal,
  rename and deletion; stale edges disappearing.
- Same-directory candidates without an import or resolved edge, method addition/removal and ambiguity.
- Unknown Go dependency coverage with changing interface inference, syntax recovery and reused diagnostics.

The focused indexer tests also assert exact invalidation/reuse lists, cache-disabled and directory-alias
fallbacks, and that external semantic providers still run after heuristic references are reused. #16's
whole-repository equivalence test was extended rather than replaced: it compares the full xpl index and a
TypeScript slice, and accepts `XPL_CACHE_EQUIVALENCE_ROOT` for the pinned larger repository.

The initial reuse test failed before implementation. Removing reverse dependency traversal from the
implemented prototype then caused four intended failures: whole-index differences in declaration,
type/inheritance and candidate sequences, plus the exact caller fan-out assertion. Restoring traversal made
the focused tests pass. The test audit found no mocks of the resolver and no new test-only production seam;
the benchmark uses the same experiment interface. Literal target checks guard against a shared error in
incremental and clean resolution. The fan-out test owns partial reuse; the whole-index test owns equivalence.

## Reproduce

From this branch with dependencies installed, put output outside every indexed repository:

```sh
mkdir -p /tmp/xpl-issue-17
curl -L --fail \
  https://codeload.github.com/vitest-dev/vitest/tar.gz/c666d149a4516761bae92ca56ce1336d2fd352c3 \
  -o /tmp/xpl-issue-17/vitest.tar.gz
tar -xzf /tmp/xpl-issue-17/vitest.tar.gz -C /tmp/xpl-issue-17
npx tsx scripts/semantic-invalidation-benchmark.ts "$PWD" /tmp/xpl-issue-17/xpl 3 --history
npx tsx scripts/semantic-invalidation-benchmark.ts \
  /tmp/xpl-issue-17/vitest-c666d149a4516761bae92ca56ce1336d2fd352c3 \
  /tmp/xpl-issue-17/vitest 3
XPL_CACHE_EQUIVALENCE_ROOT=/tmp/xpl-issue-17/vitest-c666d149a4516761bae92ca56ce1336d2fd352c3 \
  npx vitest run packages/indexer/test/extraction-cache.test.ts packages/indexer/test/semantic-invalidation.test.ts
```

The script makes unique source copies and outputs under its supplied scratch directory. It does not edit,
clear caches in, or check out the input repository. `report.json` includes all measurements, mutation fan-out,
history revisions and machine details; complete comparison snapshots live under the reported run directory.
Source copies omit `.git`, `.explainer`, `node_modules` and build outputs. Discovery uses the non-git walk;
the directory census differs from an installed checkout. These totals should not be compared directly with
#16's older timing table. The real-worktree equivalence test separately checks git discovery.
Three rounds compare clean extraction/full resolution, warm extraction/full resolution, and warm extraction
with incremental resolution. Each case runs in a separate process with the same untimed baseline build;
in-memory reuse needs that preparation. Each worker starts with an empty extraction cache in its scratch
copy. The baseline warms it, so full and incremental edit builds both miss extraction for exactly one file;
unchanged builds both have zero misses. The source edit appends a fixed comment to the reported TypeScript
file, then restores the scratch file. It measures conservative source invalidation rather than a compiler
signature-change optimization. The literal mutation harness separately exercises semantic changes.

`scripts/index-benchmark-metrics.ts` shares #16's measurement method with both benchmark scripts. Wall and
user/system CPU time cover `buildIndex` only, excluding process startup, mutation, output serialization and
comparison. Peak RSS is the OS process high-water mark sampled before snapshot serialization. It includes
startup and the untimed preparation. `heapUsedBytes` is also sampled, without forced GC, and is not retained
state size. Disk reports logical and allocated extraction-cache bytes, excluding indexes and benchmark
output. There is no semantic-cache disk cost. OS filesystem caches are not flushed. `precise: off` excludes
external toolchain costs. Run repository benchmarks serially; concurrent exploratory runs are excluded from
the measurements below.

## Measurements

Measured on Linux x64, Node v22.23.1, Intel Core i9-14900K, three rounds per case. Values below are independent
medians. The xpl source copy is the working #17 implementation before the final prose and table edits
(all-language snapshot `wt-f02a8fd602`). Its TypeScript slice has 418 files, 11,512 symbols and 41,540
references; 386 files have resolver sites/facts. All languages have 528 files, 11,985 symbols, 42,235
references and 405 resolver files. Both scopes have zero warnings. The larger source is pinned
[Vitest v3.2.4](https://github.com/vitest-dev/vitest/tree/c666d149a4516761bae92ca56ce1336d2fd352c3).

| Input | Scope/case | Mode | Wall s | User/system CPU s | Peak RSS MiB |
|---|---|---|---:|---:|---:|
| xpl | TS unchanged | clean | 2.906 | 3.186 / 0.177 | 497.4 |
| xpl | TS unchanged | full | 1.048 | 1.140 / 0.216 | 486.4 |
| xpl | TS unchanged | incremental | 0.902 | 0.913 / 0.200 | 498.7 |
| xpl | TS edit | clean | 2.887 | 3.168 / 0.197 | 504.4 |
| xpl | TS edit | full | 1.044 | 1.141 / 0.235 | 493.2 |
| xpl | TS edit | incremental | 0.974 | 1.071 / 0.256 | 527.0 |
| xpl | all unchanged | clean | 3.018 | 3.370 / 0.228 | 568.7 |
| xpl | all unchanged | full | 1.215 | 1.407 / 0.228 | 564.0 |
| xpl | all unchanged | incremental | 1.177 | 1.326 / 0.292 | 582.1 |
| xpl | all edit | clean | 2.928 | 3.264 / 0.216 | 570.6 |
| xpl | all edit | full | 1.207 | 1.369 / 0.293 | 560.9 |
| xpl | all edit | incremental | 1.248 | 1.512 / 0.282 | 572.0 |
| Vitest | TS unchanged | clean | 2.876 | 3.076 / 0.414 | 465.9 |
| Vitest | TS unchanged | full | 5.860 | 4.104 / 1.041 | 399.9 |
| Vitest | TS unchanged | incremental | 2.155 | 1.683 / 0.801 | 466.2 |
| Vitest | TS edit | clean | 3.171 | 3.596 / 0.371 | 415.9 |
| Vitest | TS edit | full | 2.488 | 2.167 / 0.898 | 417.3 |
| Vitest | TS edit | incremental | 2.022 | 1.603 / 0.736 | 371.7 |
| Vitest | all unchanged | clean | 3.084 | 3.500 / 0.423 | 415.4 |
| Vitest | all unchanged | full | 2.234 | 2.013 / 0.760 | 466.3 |
| Vitest | all unchanged | incremental | 2.096 | 1.666 / 0.745 | 490.3 |
| Vitest | all edit | clean | 3.012 | 3.394 / 0.440 | 395.2 |
| Vitest | all edit | full | 2.255 | 2.010 / 0.760 | 465.1 |
| Vitest | all edit | incremental | 2.105 | 1.648 / 0.690 | 489.5 |

`clean` bypasses extraction storage; `full` uses warm extraction with full fresh resolution. The xpl edit is
`packages/indexer/src/ast.ts`. Its TypeScript dependency closure invalidates 193/386 files (50%). The
unchanged TypeScript build reuses all 386 files; the graph has 10,499 dependency edges. The all-language
experiment reuses zero files and resolves all 405, because Python/Go dependency coverage is outside scope.
Small timing differences in that fallback do not establish a semantic speedup.

The net comparison uses the complete heuristic phase in `work`, not resolver work alone. Inner columns
split the experiment; the rest includes existing graph assembly and the pack-inference pass. Independent
medians need not add exactly.

| Input/case | Full heuristic phase ms | Experiment resolver ms | Bookkeeping ms | Complete experiment phase ms | Resolved/total |
|---|---:|---:|---:|---:|---:|
| xpl TS unchanged | 222.5 | 14.8 | 29.3 | 61.8 | 0/386 |
| xpl TS edit | 224.3 | 115.1 | 34.1 | 169.0 | 193/386 |
| Vitest TS unchanged | 461.7 | 17.7 | 80.4 | 116.3 | 0/1854 |
| Vitest TS edit | 257.6 | 17.8 | 70.8 | 103.7 | 2/1854 |
| Vitest all unchanged | 238.0 | 19.1 | 83.0 | 118.4 | 0/1854 |
| Vitest all edit | 256.8 | 19.8 | 81.7 | 118.5 | 2/1854 |

The xpl TypeScript median build saves 146 ms unchanged and 70 ms after the edit (13.9% and 6.7% of the warm
full build). Peak RSS increases by 12.3 MiB unchanged and 33.8 MiB after the edit. Extraction-cache disk cost
is identical between full and incremental: 23.86/24.70 MiB logical/allocated for the TypeScript baseline,
23.89/24.73 MiB after the edit; all-language values are 24.33/25.23 and 24.36/25.26 MiB. Reused references
and dependency state have no disk cost. Sampled heap values vary with GC and are retained in the raw report;
they do not measure retained-state size.

Vitest's TypeScript slice has 1,983 files, 12,973 symbols and 36,381 references. All languages have 2,241
files, 13,047 symbols and 36,443 references. Both have one identical syntax-error warning. No additional
heuristic pack is present, so both scopes reuse the TypeScript pack. The graph has 45,563 dependency edges;
the edit to `docs/pwa-assets.config.ts` invalidates 2/1,854 files (0.11%). Full/incremental disk costs match:
20.62/24.34 MiB logical/allocated for the TypeScript slice and 20.63/24.36 MiB for all languages, rounded
identically before and after this small edit.

Vitest's TypeScript-only full unchanged builds varied from 2.268 to 7.613 s; the full edit builds ranged from
2.010 to 6.942 s. Extraction and resolution timings both varied. These noisy three-round baselines are
reported without removing samples, and do not establish the size of a causal speedup. The all-language
median builds save 138 ms unchanged and 150 ms after the edit (6.2% and 6.7%), with peak RSS increasing
24.0 and 24.4 MiB. That stationary/leaf-edit result does not establish a saving for broad edits or for
external semantic tools. The raw report keeps per-round timing, CPU, heap and phase measurements.

## Real history

The history entry point replays the last 12 first-parent snapshots ending at
`e5acc6dca615d4b0cd0e771038ac8ea63174f5e8` (PR #50), oldest first, into one scratch source root. The input is
archived from git, not synthesized from reference samples. Current indexer code analyzes every historical
source snapshot. Clean, full and incremental modes each have a separate process and compare every entire
index and warning list, for both all languages and the TypeScript/TSX/JavaScript/JSON slice. History setup and
archive extraction are outside timings. Peak RSS accumulates across the process's 12 builds, including prior
snapshot serialization; this is a sequence high-water mark, not per-transition retained memory.

These are recent feature merges, not individual editor saves. They establish an observed fallback rate for
this repository's history and cannot estimate a typical watch-mode edit distribution. Of 11 transitions,
the TypeScript slice falls back on file discovery 10 times. The remaining transition invalidates 178 of 365
resolver files (48.8%). The full mixed-language build falls back on unsupported heuristic packs in all 11
transitions. Detailed revisions, fan-out and costs are in `report.json`.

Across the 11 transitions (excluding the initial build), the TypeScript slice takes 12.295 s with warm
extraction/full resolution and 12.651 s with the experiment. The complete heuristic phase grows from
2.255 s to 2.579 s; experiment resolver work is 1.988 s and bookkeeping is 0.396 s. The model's fallback and
bookkeeping remove the benefit observed for a stationary snapshot. The full mixed-language sequence takes
13.662 s full versus 13.741 s with fallback, with heuristic phases 2.382 s versus 2.393 s. No references are
reused there.

Sequence CPU user/system totals are 13.626/2.150 s full versus 13.264/2.087 s incremental for the TypeScript
slice, and 14.664/2.474 s versus 15.134/2.524 s for all languages. Sequence peak RSS is 666.0 versus 640.1 MiB
for the TypeScript slice and 638.6 versus 745.2 MiB for all languages. Those cumulative peaks and unforced
GC do not identify retained graph size. They establish the observed process memory ceiling for this replay.

## External tools and follow-up scope

The SCIP providers still invoke their existing project/module tool paths and normalize/merge fresh output.
The experiment neither retains a compiler program nor assumes that a tool supports incremental indexing.
SCIP artifact import still requires source verification for the supplied snapshot. Any reuse inside an
external tool remains that tool's responsibility and was not measured here. No claim is made about watch
APIs, external dependency invalidation or precise-tool speedups. Real SCIP integration was not rerun because
no tool runner, importer, normalization or provider execution path changed; provider execution is checked at
the existing provider seam.

Concrete follow-ups, if repeated indexing becomes a measured product bottleneck:

1. Measure a long-lived TypeScript-only watch/session workload. Keep the current whole-index mutation and
   history checks as the acceptance oracle. Include real small edits, config changes and dependency updates.
2. Replace directory-wide candidate closure with recorded candidate/negative-lookup dependencies in that
   one resolver. Measure net bookkeeping cost and peak RSS before proposing a production option.
3. Specify discovery/config dependencies and atomic snapshot publication for that lifetime. Retain unknown
   coverage fallback. Treat persistent semantic storage and each external provider as separate decisions,
   with their own versioned keys and supported reuse contracts.

These follow-ups are conditional investigations, not implementation commitments. The present default stays
cached extraction plus full fresh resolution, with a coherent checked snapshot on every invocation.
