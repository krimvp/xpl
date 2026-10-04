# Rust tags experiment

Rust files index through a generic `TagsProvider`, using `tree-sitter-rust@0.24.0` and its compatible WASM
ABI 14 with `web-tree-sitter@0.27.0`. No Cargo or Rust compiler runs. The additional provider's `mode` is
`syntax`, so `xpl index --precise off` still produces named symbols, declaration ranges and lexical nesting.
All three capabilities are partial. Every relationship kind is unavailable. `--precise require` fails for
Rust until a semantic provider supplies precise relationships. CLI and viewer show these limits from the
same saved analysis report, labeled `rust (rust-tags):`. Identical outcomes share one report with combined
file counts; syntax-error
files retain a separate report and limitation. Rust code renders as plain text in the viewer, with selection
and highlights.

`xpl search dispatch --code` searches Rust source, and `xpl draft repo` includes Rust code and labels its
service boxes Rust. Both use the shared code-language classification in core. `--scip` retains Rust tags
alongside the artifact provider. A range-less artifact keeps every tag symbol, including files it describes.
Source-checked definition identifiers can attach supported references to same-file tag symbols; the artifact
cannot supply full ranges or nesting there. Coverage labels `rust-tags` as the symbol provider and leaves
the artifact's structural `analyzedFiles` empty. A standalone range-less import has no checked targets and
reports `refs: none`; `require` rejects it. Checked targets can support explicit precise analysis with zero
relationships. Calls remain unsupported because SCIP roles do not distinguish calls from values.

This is a tags-path experiment for #13, under #7. It adds no Rust scope/module resolver or semantic import.
The standard tagging convention supplies `@name` and `@definition.*`; the generic adapter converts them to
provider facts and ordered lexical containment. xpl's normalizer checks source snapshots and declaration
extents, assigns IDs and duplicate suffixes, and hashes original full lines. Impl methods stay inside their
physical impl block; they are not attached to a struct elsewhere in a file or repository.

## Query corrections and limits

`packages/indexer/src/tags/rust.scm` is a small correction of the grammar's stock `queries/tags.scm`:

- Capture each function once. Stock tags duplicate impl methods as function/method and mark module
  functions as methods. Tagged impl/trait parents classify methods; external function signatures stay functions.
- Add required trait signatures, consts and statics. Keep enum and type-alias kinds rather than classifying
  every type as a class. Structs/unions are `class`, traits `interface`, modules/macros/impls `other`.
- Capture impl declarations with any receiver/trait shape. Stock implementation references omit generic
  and scoped types and supply no parent declaration. Labels include both trait and receiver when present.
- Omit reference captures. Bare calls, receiver calls and macro invocations have no resolved targets; they
  never become graph edges. Implementations are syntax declarations, not `implements` relationships.

Full ranges include visibility and bodies but exclude leading attributes and doc comments. `cfg` is not
interpreted: all parsed branches are included. External `mod queue;` gets its own declaration range but no
link to `queue.rs`. Fields, enum variants, local bindings and macro-generated declarations are absent.
Syntax recovery retains checked declarations where possible and records the incomplete coverage.
Whitespace in multiline impl receivers is collapsed in their path; the full original declaration is hashed.
Impl identity records source syntax, not semantic equivalence between differently written types.

Literal fixture expectations in `packages/indexer/test/rust-tags.test.ts` include:

| Source ID | Full lines | Parent |
|---|---:|---|
| `src/queue.rs#JobQueue` | 21–27 | none |
| `src/queue.rs#JobQueue.pop` | 22 | `src/queue.rs#JobQueue` |
| `src/queue.rs#impl Queue` | 38–68 | none |
| `src/queue.rs#impl JobQueue for Queue.pop` | 71–87 | `src/queue.rs#impl JobQueue for Queue` |
| `src/runner.rs#impl Runner<Q>.dispatch` | 65–101 | `src/runner.rs#impl Runner<Q>` |
| `src/main.rs#demo.echo` | 13–15 | `src/main.rs#demo` |
| `src/worker.rs#demo.handlers.echo` | 106–108 | `src/worker.rs#demo.handlers` |
| `src/runner.rs#counters` | 12–21 | none |
| `src/runner.rs#impl RunnerStats.record` | 25–28 | `src/runner.rs#impl RunnerStats` |

The `counters!(RunnerStats)` invocation at runner.rs:22 produces no `RunnerStats` struct or `$name` symbol.
The named `macro_rules! counters` definition is anchorable as its actual source. The later physical impl and
its `record` method are also anchorable, without inventing the expanded struct or its fields. Inline tests
cover default trait methods, a union, repeated module/function names with `~2` parents, multiline/scoped
impls, extern signatures, Unicode and malformed source. CLI tests exercise outline/show/anchors/apply/
validate/bundle; the browser selects trait and module symbols and checks their highlighted source lines.

## Measured coverage and cost

Measured sequentially on 2026-10-04, Linux x86_64, Node 22.23.1. The real repository is
[bat v0.25.0](https://github.com/sharkdp/bat/tree/25f4f96ea3afb6fe44552f3b38ed8b1540ffa1b3), pinned at
`25f4f96ea3afb6fe44552f3b38ed8b1540ffa1b3`. `buildIndex` uses `precise: "off", languages: ["rust"]`.
The process measurement includes npx/tsx startup, source discovery, parsing, provider normalization,
hashing, commit resolution and writing the JSON artifacts, but excludes installation and cloning.
The build time measures the `buildIndex` call itself. `/usr/bin/time -v` supplies process peak RSS.
One run per corpus is a bounded measurement, not a stable performance benchmark.

| Corpus | Rust files | Physical lines | UTF-8 snapshot bytes | Symbols | Edges | Build ms | Process s | Peak RSS KiB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| rs-jobrunner | 9 | 825 | 24,408 | 82 | 0 | 54.8 | 0.37 | 133,180 |
| bat v0.25.0 | 67 | 13,786 | 484,845 | 968 | 0 | 236.0 | 0.51 | 122,580 |

Coverage below compares corrected query captures with source AST nodes. Every listed construct is captured
once, without the stock query's duplicates. These are diagnostic counts, not independently checked recall
across the whole repository, and they exclude declarations hidden in macro expansion.

| Parsed construct | Fixture captured / AST | bat captured / AST |
|---|---:|---:|
| Functions with bodies (free and methods) | 40 / 40 | 669 / 669 |
| Required signatures | 5 / 5 | 8 / 8 |
| Structs | 12 / 12 | 54 / 54 |
| Enums | 1 / 1 | 33 / 33 |
| Traits | 1 / 1 | 3 / 3 |
| Impl blocks | 7 / 7 | 97 / 97 |
| Modules | 9 / 9 | 61 / 61 |
| macro_rules definitions | 1 / 1 | 2 / 2 |
| Type aliases | 4 / 4 | 12 / 12 |
| Consts and statics | 2 / 2 | 29 / 29 |

The normalized fixture has 20 functions and 25 methods; bat has 386 functions and 291 methods. The literal
union/default-method cases above supplement shapes not present in these corpora. Bat has two files with
syntax errors: `tests/snapshots/sample.modified.rs` (deliberately malformed sample), and
`tests/syntax-tests/highlighted/Rust/output.rs` (ANSI-highlighted output). Both remain in this all-Rust scan.
This does not establish parser failure on compilable Rust. Source snapshots decode UTF-8 like the indexer;
the highlighted sample has invalid bytes, so decoded snapshot bytes differ from raw bytes by 10.

## Repeat the workflow

Build xpl first. Keep patches and outputs outside the indexed repository. Copy the fixture so xpl does not
write into the committed fixture. These commands need Node, npm and git, with no Rust toolchain:

```sh
npm ci --ignore-scripts
npm run build
xpl_cli="$PWD/packages/cli/dist/xpl.mjs"
rust_work="$(mktemp -d /tmp/xpl-rust-tags.XXXXXX)"
cp -a fixtures/rs-jobrunner "$rust_work/fixture"
node "$xpl_cli" index --root "$rust_work/fixture" --precise off
node "$xpl_cli" outline --root "$rust_work/fixture" --under src/runner.rs --depth 3
node "$xpl_cli" show --root "$rust_work/fixture" 'sym:src/runner.rs#impl Runner<Q>.dispatch'
node "$xpl_cli" new rust --root "$rust_work/fixture"
cat > "$rust_work/rust.patch.json" <<'PATCH'
{
  "concepts": [{
    "id": "concept:dispatch", "label": "Dispatch",
    "summary": "Runs queued jobs and retries failed attempts.",
    "anchors": [{"file": "src/runner.rs", "symbol": "impl Runner<Q>.dispatch", "role": "definition"}]
  }],
  "views": [{
    "id": "view:rust", "type": "graph", "title": "Dispatch",
    "include": ["sym:src/runner.rs#impl Runner<Q>.dispatch"]
  }]
}
PATCH
node "$xpl_cli" apply rust "$rust_work/rust.patch.json" --root "$rust_work/fixture"
node "$xpl_cli" anchors rust concept:dispatch --root "$rust_work/fixture"
node "$xpl_cli" validate rust --root "$rust_work/fixture"
node "$xpl_cli" bundle rust --root "$rust_work/fixture" -o "$rust_work/rust.html"
# Open rust.html: select the symbol and expand Analysis coverage.
git clone --branch v0.25.0 --depth 1 https://github.com/sharkdp/bat.git "$rust_work/bat"
git -C "$rust_work/bat" checkout --detach 25f4f96ea3afb6fe44552f3b38ed8b1540ffa1b3
/usr/bin/time -v node "$xpl_cli" index --root "$rust_work/bat" --precise off
node "$xpl_cli" outline --root "$rust_work/bat" --under src/controller.rs --depth 2
node "$xpl_cli" show --root "$rust_work/bat" "sym:src/controller.rs#impl Controller<'b>.run"
```

The CLI indexes all discovered languages; the Rust-only measurement above uses this API driver:

```ts
import { buildIndex } from "@xpl/indexer";
const start = performance.now();
const { index, warnings } = await buildIndex({ root: process.argv[2]!, precise: "off", languages: ["rust"] });
console.log(JSON.stringify({ ms: performance.now() - start, files: index.files.length,
  symbols: index.symbols.length, refs: index.refs.length, warnings }));
```

Run a scratch driver with `npx tsx` and `/usr/bin/time -v`; import the checkout's indexer source by absolute
path if the driver is outside the workspace. Physical line counts include blanks/comments but omit the final
empty split after a trailing newline. Query coverage can be repeated by parsing the same discovered `.rs`
files, counting the named AST nodes in the table and the query's `definition.*` captures.

## Adapter effort and next steps

Rust-specific production code is 22 query lines and 33 profile lines. The generic adapter is 172 lines.
Counts include comments and blank lines. The remaining integration adds the
closed language union, extension/WASM registration, bundled query copy and plain-text viewer case. The tags
adapter is generic; source validation, identity assignment, hashing, anchors, queries, bundles and capability
presentation reuse existing code. No handwritten Rust scope/module resolver was added.

The [language-support decision](assessment-2026-10-04-language-support.md) compares this path with
rust-analyzer SCIP on the same inputs and with Java's artifact import. Its measured xpl version predates
#46: range-less artifact import removes valid tags and can still pass `require` without usable targets.
Use `--precise off` for Rust until composition is fixed and checked. Macro expansion, receiver ownership,
external module links and resolved relationships need semantic evidence; syntax tags remain experimental.
