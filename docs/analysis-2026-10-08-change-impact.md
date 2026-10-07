# One extra call hop in change impact

## Supported case

`analyzeChange` previously listed only the direct wrapper for a changed function. A core-world fixture
now also returns the indexed path `caller → wrapper → changed`, preserving a precise first call and a
heuristic second call. It excludes an unrelated caller, a third hop, a read of the wrapper, test-file
callers and cycles. The CLI's existing Python fixture exercises real indexed source:
`App.__call__ → App.handle → helper`.

This is a pair of static call references. It does not infer callbacks, framework registration or runtime
middleware wiring, and does not establish that both calls execute on the same runtime path. Each hop
retains its own source range and confidence. Direct callers, direct test coverage and draft diagrams keep
their existing meaning.

## Bounds

For each changed function or method, inspect at most 1000 incoming references and return at most 100
pairs. A stopped scan sets `indirectCalls.truncated`; text and JSON both retain this limit. This is a local
join over the index's incoming-reference lists, with no recursive traversal or new persistent index.

## Local cost measurement

Measured on macOS with Node 22.22.0, using xpl's heuristic index `wt-56acfc7826`: 663 files, 12,123 symbols
and 52,055 references. The workload selects every tenth non-test/non-e2e function from index order,
up to 100, and marks its first line changed. Those 100 edits resolve to 98 changed outer symbols. This is
a synthetic change workload over a real repository, not a claim about wrapper accuracy across projects.

Both implementations receive the same index and change record. Five warmup rounds precede 30 measured
rounds, alternating baseline and new implementation order. Each call uses a fresh `IndexModel`, constructed
before timing. No source text reader is supplied. The baseline is `change.ts` from main at `277593f` (unchanged at `c9a80f0`).

| Analysis | Median | p95 |
| --- | ---: | ---: |
| Direct callers | 3.99 ms | 5.82 ms |
| With one extra hop | 7.80 ms | 9.42 ms |

The median added cost was 3.80 ms. The result contained 763 call-site pairs; one of the 98 changed-symbol
results was truncated. Index construction, indexing and output rendering are excluded from these times.
The bounded scan is small enough for this first slice; broader propagation is not part of this change.
