# File-local extraction reuse

`xpl index` caches tree-sitter language-pack facts and Rust tags before provider normalization and merging.
It discovers and reads sources, hashes anchors, rebuilds the whole reference graph, resolves resource paths
and runs semantic providers on every build. `xpl index --no-cache` reads and writes no cached facts.
The [architecture contract](ARCHITECTURE.md#3-indexer-xplindexer) documents the key and revision rules.

Cache entries live in `.explainer/cache/extraction-v1/`, excluded from discovery and snapshot identity.
Before lookup and persistence, device/inode identities of `.explainer`, `cache` and `extraction-v1` are
checked against repository directories, including empty and ignored directories that could change Git's
clean-tree decision. Symlinks, bind mounts and other aliases into that census bypass reads and writes;
`extraction.enabled` is false and `extraction.bypassReason` explains the match. Inspection failures also
bypass reuse. Source at the target stays discoverable; isolated external targets remain usable. No option
or environment variable redirects the cache directory; an indexed root may itself be a symlink.
Old entries remain until that directory is removed. Each entry stores the full source/key input and plain
JSON facts, with an input/payload checksum. Address collisions cannot reuse a different stored input.
Syntax errors and pack warnings from successful extraction are replayed; extraction failures are retried.
Unwritable, missing, corrupt or interrupted entries cannot change the checked index.

The first build includes cache writes. A hit skips parsing, extraction and resource-site collection;
it still regenerates checked declarations, IDs, hashes, parents and reports. Project configuration is
consumed fresh during heuristic resolution and semantic work. For example, changing a `tsconfig` alias or
re-export can change an unchanged caller's target even when its file-local facts hit the cache.
No dependency-aware semantic reuse is implemented; #17 owns that decision.

The key binds exact source (including BOM and line endings), path/language, provider/profile version,
configuration, indexer version, extraction revision and runtime/grammar versions and actual WASM hashes.
Increase `EXTRACTION_REVISION` in `extraction-cache.ts` when extraction, resource collection, tag labels or
diagnostics change without a provider version change. Increase the envelope/directory version for an
incompatible serialization change. A new configuration-consuming extractor must put the consumed content
in its profile configuration key. Existing project-wide options do not affect file-local extraction.
A running process retains loaded WASM; replacing its disk files bypasses reuse until they agree or the
process restarts. This prevents old grammars' facts being persisted under new grammar identities.

## Repeat the comparison and benchmark

From an xpl checkout with dependencies installed, choose scratch directories outside all indexed roots:

```sh
mkdir -p /tmp/xpl-cache-benchmark
curl -L --fail https://codeload.github.com/vitest-dev/vitest/tar.gz/c666d149a4516761bae92ca56ce1336d2fd352c3 \
  -o /tmp/xpl-cache-benchmark/vitest.tar.gz
tar -xzf /tmp/xpl-cache-benchmark/vitest.tar.gz -C /tmp/xpl-cache-benchmark
npx tsx scripts/extraction-cache-benchmark.ts "$PWD" /tmp/xpl-cache-benchmark/xpl
npx tsx scripts/extraction-cache-benchmark.ts \
  /tmp/xpl-cache-benchmark/vitest-c666d149a4516761bae92ca56ce1336d2fd352c3 \
  /tmp/xpl-cache-benchmark/vitest-results
XPL_CACHE_EQUIVALENCE_ROOT=/tmp/xpl-cache-benchmark/vitest-c666d149a4516761bae92ca56ce1336d2fd352c3 \
  npx vitest run packages/indexer/test/extraction-cache.test.ts
```

The script removes only `.explainer/cache/extraction-v1` before each round. Three rounds each run a clean
build (`cache: false`), a cold build and an unchanged warm build, in separate Node processes. Each round
asserts equality of the entire index and warnings, including symbols, references, source hashes,
capabilities, diagnostics, provider provenance, resources and snapshot identity. JSON serialization
normalizes absent versus undefined optional properties. No index fields are excluded from comparison.
The unit test always compares this xpl repository; the environment variable adds the larger pinned root.
No dependencies or semantic toolchains are installed in the pinned repository.

`report.json` and each complete index/warning snapshot go to the supplied output directory. Wall and
user/system CPU time cover `buildIndex` only, excluding process startup and output serialization. Peak RSS
includes startup and is sampled before snapshot serialization; it is the OS process high-water mark.
Disk costs include cache entries (logical bytes and allocated blocks), excluding indexes and benchmark
output. Extraction wall time includes directory eligibility, cache lookup, parsing/extraction and writes;
heuristic and semantic work are reported separately. `precise: off` means these numbers measure extraction reuse with fresh
heuristic resolution, not a speedup of semantic tooling. OS filesystem caches are not flushed.

## Measurements

These measurements predate the directory-identity census; rerun the commands above for current timings.

Measured on Linux x64 with Node v22.23.1, three separate-process rounds per repository. The larger input is
[Vitest v3.2.4](https://github.com/vitest-dev/vitest/tree/c666d149a4516761bae92ca56ce1336d2fd352c3),
a source archive pinned to `c666d149a4516761bae92ca56ce1336d2fd352c3`. xpl is the working implementation
branch for #16 before these measurement numbers were recorded (snapshot `wt-07ac45fed7`). Each cold and warm build matched its whole clean index and warnings.

| Repository | Build | Wall s | User/system CPU s | Peak RSS MiB | Extraction s | Cache MiB logical/allocated |
|---|---|---:|---:|---:|---:|---:|
| xpl #16 working branch | clean | 3.222 | 4.041 / 0.260 | 339.4 | 2.209 | — |
| xpl #16 working branch | cold | 3.770 | 4.425 / 0.377 | 346.5 | 2.798 | 23.73 / 24.58 |
| xpl #16 working branch | warm | 1.244 | 1.547 / 0.253 | 276.9 | 0.269 | 23.73 / 24.58 |
| Vitest v3.2.4 | clean | 3.113 | 3.638 / 0.426 | 294.0 | 1.600 | — |
| Vitest v3.2.4 | cold | 4.411 | 4.288 / 0.995 | 292.0 | 2.899 | 20.63 / 24.36 |
| Vitest v3.2.4 | warm | 1.964 | 1.993 / 0.559 | 272.7 | 0.453 | 20.63 / 24.36 |

The xpl input has 528 files, 11,893 symbols and 41,310 references; 437 files have reusable extraction.
Vitest has 2,241 files, 13,047 symbols and 36,443 references; 1,985 files have reusable extraction.
Warm builds have zero misses and no failed cache writes. Vitest has one aggregate syntax-error warning;
that warning and every capability/diagnostic field are identical to the clean build. Values are medians;
the CPU model is Intel(R) Core(TM) i9-14900K.

These are bounded measurements, not a universal speed claim. Cold writes add overhead, and many small
files cost filesystem operations. Files without a language-pack or tags extractor count as neither hits
nor misses. A fully warm cache still performs repository-wide resolution. Semantic work is verified to
run again by the provider-boundary test; real SCIP tool costs are outside this benchmark.
