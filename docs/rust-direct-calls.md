# Bounded Rust calls

Rust remains experimental. With `--precise off`, the tags provider emits two kinds of heuristic calls.
The file-local pass resolves an unshadowed bare name to one root function in the same file. The project
pass resolves a method call when source syntax gives its receiver a single type and the target method is
unique. Both use the exact call expression as evidence. Provider normalization checks the source snapshot,
caller, target declaration and range before the reference enters the index.

## Receiver cases

- `self.method()` uses the enclosing impl's concrete type and one inherent method.
- `self.field.method()` uses the field's declared type. A generic field such as `queue: Q` with one
  `Q: JobQueue` bound points to the trait method, never to a guessed concrete implementation.
- A local with an explicit type can be a receiver. A local assigned from `self.field.method()` can use that
  method's declared return type when the method is unique. This covers `worker` returned by
  `self.pool.lease()` in the fixture.
- A root-level `use crate::module::Type` or `use crate::module::{Type, Other}` maps that type to
  `<crate root>/module.rs`. The root must be identified by an indexed `src/lib.rs` or `src/main.rs`, and the
  target must be an indexed declaration there. Without a known root, the imported receiver stays unresolved.
  Standalone `src/bin` crates and custom crate-root paths are not resolved. No external module graph is inferred.

All references remain `heuristic`. A unique syntax match does not prove Rust method dispatch. Calls inside
nested functions, closures or macro invocations are omitted. Unknown receivers, competing impl methods,
multiple generic bounds, qualified receiver types, unrecognized imports, complex return types and syntax-error files produce no
receiver edges. The bare pass also skips a body containing any macro invocation or local import. No macro
expansion or cfg evaluation runs. Missing edges do not mean a method has no callers.

Reports label Rust calls partial and heuristic. Other relationship kinds remain unsupported.
`--precise require` still needs a usable precise provider. The extraction cache stores file-local tags and bare calls;
the receiver pass reruns against current project declarations on both cold and warm builds.

## Fixture and real repository checks

`fixtures/rs-jobrunner` has 140 Rust symbols and 14 Rust call references: 2 bare calls and 12 receiver calls.
All 14 are heuristic. `Runner<Q>.dispatch` has 10 outgoing calls. In particular, `self.queue.pop()` at
`src/runner.rs:67` targets `src/queue.rs#JobQueue.pop`, `worker.run(...)` at line 78 targets
`src/worker.rs#impl Worker.run`, and `self.queue.requeue(...)` at line 87 targets
`src/queue.rs#JobQueue.requeue`. The queue calls end at trait methods because `Q` is generic.
`xpl refs` shows these targets and source lines; repository/path views derive arrows from the same index.

A no-cache smoke check on [bat v0.25.0](https://github.com/sharkdp/bat/tree/25f4f96ea3afb6fe44552f3b38ed8b1540ffa1b3)
at commit `25f4f96ea3afb6fe44552f3b38ed8b1540ffa1b3` found 133 Rust calls across 67 Rust files:
49 bare calls and 84 receiver calls, including 4 cross-file calls. Every retained call range was compared
with the checked-out source text and contained the named bare or receiver invocation. These checks establish
range evidence, not target correctness by themselves. For the four cross-file bat calls,
`src/printer.rs` imports `AnsiStyle` from `vscreen`, its `InteractivePrinter.ansi_style` field declares
`AnsiStyle`, and `src/vscreen.rs` declares `impl AnsiStyle.update` at lines 17–25. The same file also
declares `Attributes.update`; the field type rules it out for those four calls. This checks those targets
against source, but not semantic precision or completeness. Bat was not compiled.

Repeat after `npm run build` with a checkout or fixture copy outside this repository:

```sh
node packages/cli/dist/xpl.mjs index --root /tmp/bat --precise off --no-cache
node packages/cli/dist/xpl.mjs refs --root /tmp/bat 'sym:src/assets.rs#from_binary' --out
```

The older [tags experiment](rust-tags.md) records declaration-only coverage. Its zero-reference
measurements describe that earlier version.
