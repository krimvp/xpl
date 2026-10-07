# Bounded Rust direct calls

Rust remains experimental. With `--precise off`, the tags provider now emits heuristic calls between
unambiguous root-level functions in the same file. The call must use a bare identifier. Its evidence is
the exact call expression, with inclusive UTF-16 columns and lines. Provider normalization checks both
declaration identities and source snapshots before the relationship enters the index.

## Limits

The pass does not resolve unknown names, qualified paths or explicit generic calls (`f::<T>()`), calls
inside nested functions or closures, methods, trait dispatch, or calls across modules/files. Local
parameters, patterns (including shorthand struct bindings) and declarations that might shadow a target
suppress that name throughout the caller, deliberately missing some calls outside the binding's actual
scope. Raw identifiers such as `r#target` and `target` use the same lookup spelling; source IDs and ranges
retain the original text. A body containing a macro invocation or local import is skipped. No macro expansion or cfg evaluation runs. Ambiguous
root declarations are not targets. A file with syntax errors keeps its available declarations but its
call analysis is marked failed and produces no calls.

Reports label calls partial and heuristic, including files with no retained calls. Other relationship
kinds remain unsupported. Missing edges do not mean a function has no callers. `--precise require`
still needs a usable precise provider and is not satisfied by this pass. Extraction cache query-v4
stores these file-local relationships; reference evidence and trust survive a warm build.

## Fixture and real repository checks

The existing `fixtures/rs-jobrunner` produces two Rust calls without changing fixture source lines:

| Caller | Target | Evidence |
| --- | --- | --- |
| `src/config.rs#load_config` | `config_from_text` | line 64, columns 5–83 |
| `src/config.rs#config_from_text` | `parse_yaml` | line 68, columns 20–35 |

Both are heuristic. The fixture's trait and method calls remain outside this slice. `xpl refs` displays
the two-hop configuration path with the heuristic label. `cargo test --offline` passes on a copy.

A smoke test on [bat v0.25.0](https://github.com/sharkdp/bat/tree/25f4f96ea3afb6fe44552f3b38ed8b1540ffa1b3)
(pinned commit `25f4f96ea3afb6fe44552f3b38ed8b1540ffa1b3`) retains 968 declarations across 67 Rust files
and produces 49 Rust calls. All 49 ranges were checked against the source: each begins with its target's
bare name and `(`, ends with `)`, stays within the caller's file, and carries `heuristic` resolution.
For example, `src/assets.rs#from_binary` calls `asset_from_contents` at line 322, columns 5–45.
This checks usefulness and evidence, not completeness or semantic precision. No bat compilation was run.

Repeat after `npm run build`, using a checkout or fixture copy outside this repository:

```sh
node packages/cli/dist/xpl.mjs index --root /tmp/bat --precise off --no-cache
node packages/cli/dist/xpl.mjs refs --root /tmp/bat 'sym:src/assets.rs#from_binary' --out
```

The older [tags experiment](rust-tags.md) records the declaration-only baseline. Its zero-reference
measurements describe that earlier version, not the bounded pass documented here.
