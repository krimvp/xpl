# Languages and precision

xpl indexes TypeScript, JavaScript, Python, Go and Java with language packs. YAML, JSON and TOML keys are symbols, so configuration entries can be anchored just like functions. Other text files receive file anchors. Rust has experimental declaration tags and bounded heuristic calls between root-level functions in one file.

Tree-sitter WASM extracts symbols without installing language toolchains. References (calls, imports, inheritance, type uses and reads) come from xpl's scope-aware heuristic resolver or, when available, a compiler-grade SCIP indexer. References always keep their source label. The viewer draws heuristic edges lighter; the authoring skill treats them as hints to confirm.

`xpl index` reports analysis coverage separately for file anchors, symbols, declaration ranges, nesting and each relationship type. An empty relationship set does not prove full coverage. Saved indexes and exports retain analyzed files, limits and failures; older indexes load with coverage marked unknown.

## Precise reference tools and artifacts

| Language                | Tool and requirements                                                        |
| ----------------------- | ---------------------------------------------------------------------------- |
| TypeScript / JavaScript | `scip-typescript` 0.4.0 via `npx`; first use may need network access         |
| Python                  | `scip-python` 0.6.6 via `npx`; first use may need network access             |
| Go                      | `scip-go` 0.2.7; Go 1.25 or a `go` that can download the toolchain           |
| Java                    | `--scip` with a separately generated, source-checked artifact                |
| Rust                    | Experimental declarations and bare same-file root-function calls (heuristic) |
| YAML, JSON, TOML        | Keys are symbols; no reference relationships                                 |

`xpl index` tries precise tools by default. Use `--precise off` for heuristic results or `--precise require` to fail when a precise tool cannot run. `XPL_SCIP_TIMEOUT_MS` sets the per-tool timeout (default 10 minutes). If a tool omits files, their heuristic references remain and the summary names the gap.

Java has no automatic SCIP resolver. Run a Java producer and its build separately, then pass the
source-checked artifact manifest with `--scip`. The importer uses only source-matched facts it supports;
the analysis report records omissions.

Precise indexing can be expensive on large repositories. In measured runs, Django took four minutes and 4.6 GB; SymPy and Prometheus took 9–10 minutes and up to 7 GB. `--precise off` took 15–40 seconds. Start large repositories with heuristic indexing, then run precise analysis when the answer depends on language semantics the heuristic may miss.

## Supplied SCIP artifacts and experimental languages

Import generated SCIP data with `xpl index --scip <artifact|manifest.json>`. Documents need embedded source or a manifest tied to pre-generation source hashes. Missing ranges, parents and call classification remain explicit limits. Partial artifacts preserve syntax symbols; range-less artifacts cannot add declarations. Without checked targets, a standalone import reports `refs: none` and fails under `--precise require`. See the [CLI reference](../reference/commands.md) for artifact requirements.

Rust call analysis omits unknown or shadowed names, qualified/generic calls, nested functions, closures, methods, trait dispatch and cross-module targets. Bodies with macros or local imports, and files with syntax errors, do not produce calls. Call coverage stays partial; no macro expansion or cfg evaluation runs.

Java's built-in pack parses source with its grammar and resolves references heuristically. Those references are partial: overloads, ambiguous names and inherited or runtime dispatch can make a guessed target incomplete or wrong. Inspect the code and analysis coverage before describing a relationship as certain. For compiler-produced facts, xpl can import a separately generated, source-checked SCIP artifact; it does not run a Java producer automatically. Only facts that match checked source declarations and supported relationships are used, and the coverage report records omissions. This optional path needs a working Java build (the documented producer workflow uses JDK and Maven).

Rust tags have bounded experimental coverage. The pinned rust-analyzer producer can omit full ranges, which may prevent imported relationships from attaching to Rust tags; use `--precise off` for Rust today.

See the [Rust tags notes](https://github.com/krimvp/xpl/blob/main/docs/rust-tags.md) and the language support assessment for measured limits. The dated [Java SCIP experiment](https://github.com/krimvp/xpl/blob/main/docs/java-scip.md) predates the built-in Java pack and records the optional artifact-import workflow.
