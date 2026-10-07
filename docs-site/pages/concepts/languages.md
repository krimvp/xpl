# Languages and precision

xpl indexes TypeScript, JavaScript, Python and Go with maintained language packs. YAML, JSON and TOML keys are symbols, so configuration entries can be anchored just like functions. Other text files receive file anchors. Rust has experimental declaration tags, with no resolved relationships; Java remains text unless you provide a generated SCIP artifact.

Tree-sitter WASM extracts symbols without installing language toolchains. References (calls, imports, inheritance, type uses and reads) come from xpl's scope-aware heuristic resolver or, when available, a compiler-grade SCIP indexer. References always keep their source label. The viewer draws heuristic edges lighter; the authoring skill treats them as hints to confirm.

`xpl index` reports analysis coverage separately for file anchors, symbols, declaration ranges, nesting and each relationship type. An empty relationship set does not prove full coverage. Saved indexes and exports retain analyzed files, limits and failures; older indexes load with coverage marked unknown.

## Precise reference tools

| Language                | Tool and requirements                                                |
| ----------------------- | -------------------------------------------------------------------- |
| TypeScript / JavaScript | `scip-typescript` 0.4.0 via `npx`; first use may need network access |
| Python                  | `scip-python` 0.6.6 via `npx`; first use may need network access     |
| Go                      | `scip-go` 0.2.7; Go 1.25 or a `go` that can download the toolchain   |
| Rust                    | Experimental syntax declarations only; no reference relationships    |
| YAML, JSON, TOML        | Keys are symbols; no reference relationships                         |

`xpl index` tries precise tools by default. Use `--precise off` for heuristic results or `--precise require` to fail when a precise tool cannot run. `XPL_SCIP_TIMEOUT_MS` sets the per-tool timeout (default 10 minutes). If a tool omits files, their heuristic references remain and the summary names the gap.

Precise indexing can be expensive on large repositories. In measured runs, Django took four minutes and 4.6 GB; SymPy and Prometheus took 9–10 minutes and up to 7 GB. `--precise off` took 15–40 seconds. Start large repositories with heuristic indexing, then run precise analysis when the answer depends on language semantics the heuristic may miss.

## Supplied SCIP artifacts and experimental languages

Import generated SCIP data with `xpl index --scip <artifact|manifest.json>`. Documents need embedded source or a manifest tied to pre-generation source hashes. Missing ranges, parents and call classification remain explicit limits. Partial artifacts preserve syntax symbols; range-less artifacts cannot add declarations. Without checked targets, a standalone import reports `refs: none` and fails under `--precise require`. See the [CLI reference](../reference/commands.md) for artifact requirements.

Rust tags and Java SCIP have bounded experimental coverage, not production support across build ecosystems. Rust's pinned rust-analyzer producer can omit full ranges, which may prevent imported relationships from attaching to Rust tags; use `--precise off` for Rust today. Java needs an explicitly generated artifact and working JDK/Maven build. Its importer keeps checked declarations and type references; calls and inheritance remain unsupported. Java remains plain text for built-in indexing, so use explicit views and search without `--code`.

See the project notes on [Rust tags](https://github.com/krimvp/xpl/blob/main/docs/rust-tags.md), [Java SCIP](https://github.com/krimvp/xpl/blob/main/docs/java-scip.md), and the [language support assessment](https://github.com/krimvp/xpl/blob/main/docs/assessment-2026-10-04-language-support.md) for measurements and limits.
