# CLI reference

## Install

Install from npm (Node 22.12 or newer):

```sh
npm install --global @krimvp/xpl
xpl skill install
xpl doctor --agent claude
```

Alternatively, with access to the private [source repository](https://github.com/krimvp/xpl),
run `npm install && npm run build`, then `npm pack ./packages/cli/dist` and
`npm install -g --ignore-scripts ./krimvp-xpl-0.1.0.tgz`. Install a maintainer's tarball offline with
`npm install -g --offline --ignore-scripts <tarball>`, then run `xpl skill install`.
Claude Code needs separate installation, authentication and provider access.

`<skill dir>/bin/xpl <command> [options]` (below: `xpl`). Run it from the root of the repo you are explaining, or pass `--root <dir>`. Samples come from `fixtures/ts-jobrunner` (a tiny job runner, indexed as `wt-0db7e190f5`) and are trimmed, not edited.

**Global options** (every command)

| Option            | Meaning                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `--root <dir>`    | repository root (default: current directory)                                             |
| `--json`          | machine-readable output (`{"ok": true, ...}`; errors as `{"ok": false, "error": "..."}`) |
| `--index <path>`  | symbol index to use (default: the index of the current commit id, else the newest one)   |
| `-h`, `--help`    | help for the command; `xpl help` lists all                                               |
| `-v`, `--version` | print the version                                                                        |

**Exit codes:** 0 ok · 1 rejected or failed (bad id, rejected patch, a patch that changed nothing because the user owns everything it touches, `resolve --write` on a stale index, validation errors, `lint` findings, `bundle` with drifted or missing anchors) · 2 usage error.
**Streams:** results, issue lists and rejections print on stdout (a rejection also exits 1); fatal errors (`error: ...`: unknown id, no index, bad JSON, unreadable file) and `warning:` lines go to stderr, so use `2>&1` to capture both. With `--json` there is one object on stdout, errors included (`{"ok": false, "error": ...}`).
**Environment:** `XPL_CLI` (launcher: path of an `xpl.mjs` overriding the installed CLI binding or development build), `XPL_VIEWER_HTML` (viewer page for `view`/`bundle`), `XPL_SKIP_STALE_CHECK=1` (skip advisory freshness checks; strict validation and export still check), `XPL_SCIP_TIMEOUT_MS` (time limit of each SCIP indexer, default 10 minutes), `XPL_WASM_DIR` (where the tree-sitter `.wasm` files are), `XPL_DEBUG=1` (stack traces).

**Ids** are accepted loosely: `sym:src/a.ts#A.b`, `src/a.ts#A.b`, `file:src/a.ts`, `src/a.ts`, `dir:src`. The outputs always print the exact `sym:`/`file:`/`dir:` form: paste those into patches.

**Staleness.** When the working tree changed since the index was built, commands print ``warning: index … does not match the working tree (wt-…): 2 changed (src/queue.ts, src/runner.ts). Line numbers and offsets may be off; run `xpl index`…``. Re-index before anchoring anything.

---

## `xpl doctor [--agent none|claude] [--skill-dir <path>]`

Diagnoses installed setup without downloading tools or starting authoring. Node >=22.12, artifact hashes
and grammar loading are mandatory. Skill availability is optional by default; `--agent claude` makes
the managed skill and Claude Code availability required. Optional git/npx/Go checks run local version
commands. Go uses the installed toolchain, ignores user Go configuration and disables telemetry without
writing settings; Git tracing is disabled. No Python or SCIP tool launcher runs during diagnosis.
Missing precise prerequisites suggest `xpl index --precise off`; automatic precise mode may
bootstrap tools and dependencies over the network. Presence is not a test of precise analysis,
agent authentication or provider access. Required failures exit 1; JSON includes `ok`, `platform`,
`agent`, `checks` (`id`, `required`, `status`, `detail`, `recovery`) and `network`.

## `xpl skill install [--dir <path>]`

Copies the bundled code-explainer skill to `~/.claude/skills/code-explainer`, or the chosen directory,
and binds `bin/xpl` to this installed CLI. Rerun after updating or moving the CLI. Refuses symlinks,
unmanaged directories, added files and locally edited skill files; move them aside first to preserve them.
The current agent integration is Claude Code. Install/authenticate it separately and invoke the skill
explicitly. Other agents can read the instructions, but their integration is unverified.
Local reading, `index --precise off`, viewing and HTML export use bundled assets after setup.
Precise tools/dependencies and agent authoring can have separate network requirements.

## `xpl index [--precise auto|off|require] [--commit c] [--no-cache] [--scip artifact|manifest.json]`

Builds `.explainer/index-<commit>.json` (and `.explainer/.gitignore` with `index-*.json` and `cache/`). The commit id is the short HEAD when the repo root is a clean git top-level, else `wt-<hash>` of the files. Files: `git ls-files` (or a walk that skips `node_modules`, `dist`, dot-dirs…), text only, ≤ 1 MB.

```
$ xpl index
index written: .explainer/index-wt-0db7e190f5.json
commit: wt-0db7e190f5  files: 12  symbols: 160  refs: 314

json        2 files    23 symbols    refs: none
text        1 file     0 symbols     refs: none
typescript  8 files    121 symbols   refs: precise (scip-typescript@0.4.0)
yaml        1 file     16 symbols    refs: none
```

Repeated builds reuse file-local tree-sitter and Rust tags facts from `.explainer/cache`. Source discovery,
hashes, heuristic resolution, resource resolution and semantic providers still run in full. `--no-cache`
reads and writes no cached facts. Changed paths/languages, exact source content, provider/profile revisions,
options and actual grammar/runtime bytes change the key. Syntax recovery diagnostics are reused; failed
extraction is retried. Repository configuration is read fresh by resolution/tools, so a cached caller can
resolve differently after a declaration, re-export or alias change. Missing/corrupt entries fall back safely.
Keep scratch files and artifacts outside the indexed repository; `.explainer/cache` is excluded automatically.
Device/inode identities detect whether `.explainer`, `cache` or `extraction-v1` aliases a repository
directory, including an empty target. Such aliases bypass cache reads and writes, whether created by a
symlink, bind mount or another mechanism. Isolated external targets remain usable. The cache directory is
fixed; no option or environment variable redirects it.

The summary also prints scoped extraction hits/misses and wall milliseconds, plus fresh heuristic-resolution
time and semantic runs/time. `--json` includes `extraction` (`enabled`, `scope`, `hits`, `misses`,
`writeFailures`, `wallMs`, optional `bypassReason`) and `work` (`heuristicResolutionMs`, `semanticMs`,
`semanticRuns`). The text summary also prints the bypass reason. Plain text
without an extractor counts as neither a hit nor a miss. Measurements cover analysis stages, not CLI startup
or index serialization. These incidental measurements are outside the saved index and exported viewers.
Removing `.explainer/cache` reclaims old content entries; `--no-cache` leaves them untouched.

The summary is followed by **Analysis coverage** and per-capability outcomes labeled by analysis provider
(`supported`, `partial`, `unsupported`, `failed`) with analyzed file counts and limits.
`--json` includes the same `analysis` reports as the saved index. Abilities are separate from observed coverage:
a described file or empty reference list never proves complete relationships. Exported viewers keep the report even when their
symbol index is pruned. Legacy indexes without reports load with coverage unknown; file anchors remain
available, but symbol and relationship completeness cannot be inferred.
Provider labels separate a file-only fallback's limits from an artifact provider's usable symbols.
Tool commands and diagnostic details are omitted from these summaries.

- The last column is how far a language's references can be trusted. `refs: precise (tool)`: SCIP resolved them (TypeScript, Python, Go). `refs: heuristic`: tree-sitter scope-aware guesses, drawn lighter in the viewer; confirm calls with `show`. `refs: none`: usually rust, yaml, json, toml and text without an artifact provider. Rust tags provide partial named declarations and lexical nesting, without resolved relationships or macro expansion.
- `refs: precise 10/11 (scip-go@0.2.7), 1 heuristic`: the tool described only 10 of the 11 files (build-tagged Go files, files a project's own configuration excludes). Those files keep heuristic references, so **their references are hints**; a warning above the summary names them: `warning: scip-go@0.2.7 did not describe 1 file(s) (excluded by build constraints or by the tool's own configuration, or unreadable?); their references stay heuristic: internal/queue/windows_only.go`.
- `--precise auto` (default) falls back to heuristic with a warning, e.g. ``warning: precise resolver "scip-go" failed (scip-go@v0.2.7 could not be started (is `go` installed and on PATH?): spawn go ENOENT); using heuristic references for go``. `off` never runs SCIP (faster); syntax-only providers such as Rust tags still run. `require` exits 1 instead of falling back.
- A file with syntax errors is indexed anyway. One warning covers all such files, with the first lines to look at: `warning: 1 file(s) have syntax errors; symbols near these lines may be incomplete: src/broken.ts:2` (at most 5 files and 3 lines each). Errors that cannot have cost a symbol (a TS labelled tuple element such as `[symbol: string]`) are not reported.
- Reference kinds: `call import extends implements type-ref read write`. A `read` is a use of a module- or package-level variable or constant, or of a field whose type is known, that is not a call or an assignment (`this.config.retry`, `LIMIT`); the built-in syntax/tool adapters omit locals and parameters, while artifact imports can retain role-backed references to checked local declarations. A TS `import type` and a Python `import` under `TYPE_CHECKING` are `type-ref`, not `import`: `import` references are runtime dependencies.
- Symbols beyond declarations: config keys (`kind: key`) of yaml, json and toml files (`config/default.yaml#retry.maxRetries`, `pyproject.toml#project.scripts.flask`); TS test blocks (statement-level `describe`/`suite`/`context`/`it`/`test` calls with a string title), whose path is the nested titles (`test/retry.test.ts#fails twice, then succeeds: acked after two requeues`; `.` and `#` in a title become `_`). Test blocks can be anchored and outlined but nothing references them by name.
- Re-run after every code change. Explainers bound to an older index print ``hint: 1 explainer (jobrunner) is bound to another index; run `xpl resolve <name> --write` to move it to this one.``

### Generated SCIP artifacts

`xpl index --scip /tmp/run/index.scip` imports an artifact whose documents carry matching source text and
explicit position encodings. For textless documents, pass a JSON manifest instead. Its `artifact` path is
relative to the manifest; `artifactSha256` is the full SHA-256 of the protobuf bytes, and `sourceHashes` maps
repository-relative source paths to xpl's versioned hashes. Add `defaultEncoding` only after verifying how
the producer counts columns when it omits `position_encoding` (`utf8`, `utf16` or `utf32`). Metadata's source
encoding does not establish position encoding.

Keep artifacts and manifests outside the indexed repository. Capture the source index **before** generation
and preserve it before another indexing run can overwrite it:

```sh
mkdir -p /tmp/xpl-scip-run
xpl index --precise off --json > /tmp/xpl-scip-run/before.json
node --input-type=module -e '
  import { readFileSync, copyFileSync } from "node:fs";
  const result = JSON.parse(readFileSync("/tmp/xpl-scip-run/before.json", "utf8"));
  copyFileSync(result.absolutePath, "/tmp/xpl-scip-run/sources.json");
'
```

Run your pinned producer successfully with a **fresh output path** `/tmp/xpl-scip-run/index.scip`. Its build
configuration must describe the intended source files. Then check that the source snapshot did not change
and bind that snapshot to the artifact:

```sh
xpl index --precise off --json > /tmp/xpl-scip-run/after.json
node --input-type=module -e '
  import { readFileSync, writeFileSync } from "node:fs";
  import { createHash } from "node:crypto";
  const dir = "/tmp/xpl-scip-run/";
  const before = JSON.parse(readFileSync(dir + "sources.json", "utf8"));
  const result = JSON.parse(readFileSync(dir + "after.json", "utf8"));
  const after = JSON.parse(readFileSync(result.absolutePath, "utf8"));
  const hashes = index => Object.fromEntries(index.files.map(f => [f.path, f.hash]));
  const sourceHashes = hashes(before);
  if (JSON.stringify(sourceHashes) !== JSON.stringify(hashes(after)))
    throw new Error("Sources changed during generation; regenerate in a stable tree");
  const artifactSha256 = createHash("sha256").update(readFileSync(dir + "index.scip")).digest("hex");
  writeFileSync(dir + "manifest.json", JSON.stringify({ artifact: "index.scip", artifactSha256, sourceHashes }));
'
xpl index --scip /tmp/xpl-scip-run/manifest.json --precise require
```

The manifest attests to a successful run against that snapshot. Hashes cannot prove compilation success or
detect a file changed and restored during generation. Never stamp current hashes onto an old artifact.
Embedded source takes precedence for documents that supply it. A leading BOM is preserved as source content;
adding or removing it changes the snapshot identity. Stale or unverified documents supply no
checked symbols or relationships. Documents must belong to discovered sources; generated build outputs
and external symbols are not turned into local declarations. A supplied project-root URI must match `--root`.

`--scip` selects the artifact provider instead of automatic SCIP tools. Registered syntax providers such as
Rust tags still run first. Existing syntax symbol sets survive partial or range-less artifacts; matching
checked ranges can update their provenance. Coverage names each provider and its analyzed files; a
range-less artifact claims no structural files. References and range updates attach only when a definition
occurrence exactly matches one source-checked syntax identifier in the same file, including its line and
column range, and the descriptor and kind are supported. The existing canonical ID is retained. Missing
identifier evidence, unsupported descriptors and ambiguous matches are reported and omitted. A standalone range-less artifact
with no checked targets reports `refs: none` and cannot satisfy `require`. An explicit precise analysis with
checked targets can still have zero relationships. `auto` reports failures and keeps available syntax declarations and hints;
`require` rejects unusable imports and programming languages without usable precise relationship coverage. `--precise off` cannot be combined with `--scip`.
Unknown extensions remain `text`, but imported symbols work with `outline`, `show`, `apply`, `validate` and
`bundle`. Only definitions with full producer ranges become checked symbols. Missing ranges, parents and
unclassified occurrences remain limits in `analysis`; diagnostics identify omitted facts. Only role-backed
reads/writes/imports and mentions of known types become precise references. Calls and ambiguous inheritance
flags are unsupported. Overloads receive source-ordered `~N` suffixes; reordering can change IDs.

For Java, the checkout helper `scripts/java-scip.ts ROOT FRESH_OUTPUT_DIR [-- MAVEN_ARGS...]` runs the
pinned scip-java/Maven workflow and writes a source-bound manifest only after successful generation and
stable before/after hashes. Java stays `text`; use explicit views and `search` without `--code`. The
[Java workflow](../../../docs/java-scip.md) records the producer/JDK/Maven pins, fixture and Gson commands,
literal ranges, failure fallback, losses and measured costs. It includes a checked overload bundle example.

Rust tags and Java artifact import are experimental paths, checked on bounded fixtures and pinned bat/Gson
inputs. They do not promise the maturity of the maintained TS/JS, Python, Go and config packs. Read the
saved capability results before writing graph claims; a precise type mention does not establish a call,
inheritance or an implementation edge. Java needs a successful configured JDK/Maven build. When generation
fails, use `--precise off` for file anchors and config symbols, then regenerate into a fresh output directory.

Use `--precise off` for Rust. The measured rust-analyzer 0.3.2308 artifact supplies no full declaration
ranges. Importing it currently removes tags in described files, produces no semantic edges, and can still
exit successfully with `--precise require`. A cached offline producer run needs the build-script override
recorded in the report; a cold offline prep run crashed. Do not recommend this as Rust precise support.
The [comparison and decision](../../../docs/assessment-2026-10-04-language-support.md) includes runnable
measurements, manually checked source facts, mapping losses and the proposed provider-contract revision.

## `xpl outline [--under <id>] [--depth n] [--kind k,...] [--keys] [--limit n]`

One line per element: `<id>  <kind>  <first>-<last line>  in=<fan-in> out=<fan-out>`. `in`/`out` count references into/out of the element's subtree (calls, imports, type uses, reads), so high numbers mark hubs; a symbol's calls of itself stay inside it and are not counted, and `recursive` after the counts marks a symbol that calls itself (`"recursive": true` in `--json`). `[+n]` = n children below the depth limit. Default depth 2, `--limit 400` lines. Config keys (yaml, json, toml) are hidden unless `--keys`. `--kind method,function` lists only symbols of those kinds (`class interface function method type variable enum key other`; repeat or comma-separate) together with the dirs, files and parent symbols that hold a match, so each keeps its place. The `repo` line carries the name `xpl new` records (from `package.json`, `go.mod`, `pyproject.toml`, the git remote), not the directory's.

```
$ xpl outline --depth 1
repo  ts-jobrunner  12 files, 160 symbols
  dir:config  dir  1 file  in=0 out=0  [+1]
  dir:src  dir  7 files  in=41 out=0  [+7]
  dir:test  dir  1 file  in=0 out=41  [+1]
  file:README.md  text  1-46  in=0 out=0
  file:package.json  json  1-16  in=0 out=0  [11 keys hidden]
  file:tsconfig.json  json  1-16  in=0 out=0  [12 keys hidden]

$ xpl outline --under file:src/runner.ts --kind method
file:src/runner.ts  typescript  1-111  in=10 out=35
  sym:src/runner.ts#Runner  class  12-93  in=8 out=30
    sym:src/runner.ts#Runner.constructor  method  22-27  in=0 out=8
    sym:src/runner.ts#Runner.start  method  30-34  in=2 out=4
    sym:src/runner.ts#Runner.stop  method  37-40  in=2 out=2
    sym:src/runner.ts#Runner.dispatch  method  42-88  in=1 out=37
    sym:src/runner.ts#Runner.log  method  90-92  in=3 out=1
  sym:src/runner.ts#RunnerStats  class  96-105  in=4 out=3
    sym:src/runner.ts#RunnerStats.record  method  101-104  in=1 out=6

$ xpl outline --under file:test/retry.test.ts --kind function
file:test/retry.test.ts  typescript  1-91  in=0 out=41
  sym:test/retry.test.ts#runOne  function  38-52  in=2 out=14
  sym:test/retry.test.ts#fails twice, then succeeds: acked after two requeues  function  54-66  in=0 out=4
  sym:test/retry.test.ts#always fails: dead-lettered after maxRetries requeues  function  68-79  in=0 out=10
  ...

$ xpl outline --under file:config/default.yaml --keys
file:config/default.yaml  yaml  1-22  in=0 out=0
  sym:config/default.yaml#queue  key  3-6  in=0 out=0
    sym:config/default.yaml#queue.name  key  4-4  in=0 out=0
    ...
  sym:config/default.yaml#retry  key  13-16  in=0 out=0
    sym:config/default.yaml#retry.maxRetries  key  14-14  in=0 out=0
```

## `xpl show <id> [--refs] [--context n] [--lines a-b] [--max-lines n]` · `xpl show --at base <path> [--lines a-b]`

Code with **0-based offsets from the symbol's first line**: the numbers `span` uses (for a file, offset = line − 1). Header: `<id> (<kind>) <file>:<first>-<last> <hash>`. Directories and the repo list their children. `--context n` adds n lines around a symbol (marked `┆`, no offsets). `--lines a-b` selects absolute file lines within the element. Output is cut after 400 lines (`--max-lines 0` = all).

`--refs` appends references grouped by kind (calls first, then type uses, reads, writes), each `<kind>  <other id>  (<file>:<line>, <precise|heuristic>)  +<offset>`, where `+offset` counts from the start of the **referencing** symbol: it is the call-site anchor's span. The `read` lines are many; `refs --kind call` (below) is the shorter list for tracing a flow.

```
$ xpl show src/runner.ts#Runner.dispatch --refs
sym:src/runner.ts#Runner.dispatch (method) src/runner.ts:42-88 sha256-v2:e6c9c06f4779
42  0│   async dispatch(): Promise<void> {
43  1│     while (this.running) {
...
76 34│         await this.queue.requeue(
77 35│           job,
78 36│           backoff);
...
outgoing refs: 37 (call 12, type-ref 1, read 23, write 1)
  call  sym:src/queue.ts#Queue.pop  (src/runner.ts:46, precise)  +4
  call  sym:src/worker.ts#Worker.run  (src/runner.ts:60-61, precise)  +18..19
  call  sym:src/queue.ts#Queue.requeue  (src/runner.ts:76-78, precise)  +34..36
  ...
  read  sym:src/config.ts#RunnerConfig.retry  (src/runner.ts:75, precise)  +33
  ...
incoming refs: 1 (call 1)
  call  sym:src/runner.ts#Runner.start  (src/runner.ts:32, precise)  +2
```

A config key shows like any symbol: `xpl show config/default.yaml#retry` prints `13 0│ retry:` … `16 3│   maxDelayMs: 30000`.

`--at base <path>` prints a changed file as it was **before** the change the explainer records (`xpl change`, below). The offsets count from line 1 of the old file: they are what a base anchor's `span` uses. `-` marks the lines the change removes or rewrites. Paths only (the old code is not indexed). A renamed file takes its old or new path. With several explainers that record a change, pick one with `--explainer <name>`.
Automatic selection reads the discovered `.explainer/*.explainer.json` files directly, even when a
guide name such as `retry.json` matches a different repository JSON file. Unreadable guides fail selection.

```
$ xpl show --at base src/runner.ts --lines 80-82
src/runner.ts before the change 5774f2c..349730f (modified, base 5774f2c): lines 1-110; spans count from line 1
80 79│-        await this.queue.deadLetter(job, result.error);
81 80│         this.stats.deadLettered += 1;
82 81│         this.log(`dead-lettered ${job.id} after ${attempts} attempts`);
(- marks lines the change removes or rewrites)
```

## `xpl refs <id> [--in|--out] [--kind k] [--depth n] [--max-children n] [--limit n] [--tests]`

The reference list of `show --refs`, as a hierarchy. `--out` (default): what the element uses; `--in`: who uses it. `--kind` (repeatable or comma-separated): `call import extends implements type-ref read write`. For a file/dir the references that stay inside are left out, and each line names the referencing symbol (`+82 in sym:…`). Heuristic references are hints.

- `--depth n` expands each other end in turn (a call hierarchy). A subtree is printed once: an element expanded above is marked `(expanded above)` and not expanded again (unless it was only met on the last levels before and is now met nearer the top, when the deeper expansion is printed instead); an element with nothing below it is never marked; `(cycle)` marks an ancestor.
- `--max-children n` (default 15, `0` = all) lists at most n references under each line of a hierarchy, the subject's own list included (`--depth 2` or more); the rest are counted as `... +8 more (--max-children 0 lists all)`. A plain `refs` (depth 1) is the whole answer: only `--limit` (default 200 lines) cuts it.
- `--kind read` finds who reads a variable, constant or typed field (`refs <field> --in --kind read`: the readers of a config switch); `--kind call` on a function is the call hierarchy without the field accesses.
- A `call` whose target is a variable or field (`call  sym:src/runner.ts#Runner.logger`) is a call through a function value (a callback or hook stored in a field): the concrete function is whatever is assigned to that field.

```
$ xpl refs src/runner.ts#Runner.dispatch --out --depth 2 --kind call --max-children 4
sym:src/runner.ts#Runner.dispatch (method) src/runner.ts:42-88
out (12):
  call  sym:src/queue.ts#Queue.pop  (src/runner.ts:46, precise)  +4
  call  sym:src/worker.ts#WorkerPool.lease  (src/runner.ts:53, precise)  +11
  call  sym:src/runner.ts#Runner.log  (src/runner.ts:57, precise)  +15
    call  sym:src/runner.ts#Runner.logger  (src/runner.ts:91, precise)  +1
  call  sym:src/worker.ts#Worker.run  (src/runner.ts:60-61, precise)  +18..19
    call  sym:src/worker.ts#withTimeout  (src/worker.ts:41, precise)  +11
    call  sym:src/bus.ts#EventBus.emit  (src/worker.ts:51, precise)  +21
  ... +8 more (--max-children 0 lists all)
$ xpl refs src/queue.ts#Queue.requeue --in
sym:src/queue.ts#Queue.requeue (method) src/queue.ts:87-90
in (2):
  call  sym:src/runner.ts#Runner.dispatch  (src/runner.ts:76-78, precise)  +34..36
  call  sym:test/retry.test.ts#RecordingQueue.requeue  (test/retry.test.ts:21, precise)  +2
$ xpl refs src/config.ts#RunnerConfig.retry --in --kind read
sym:src/config.ts#RunnerConfig.retry (variable) src/config.ts:20-20
in (2):
  read  sym:src/runner.ts#Runner.dispatch  (src/runner.ts:74, precise)  +32
  read  sym:src/runner.ts#Runner.dispatch  (src/runner.ts:75, precise)  +33
$ xpl refs file:src/runner.ts --in --depth 3 --kind call
file:src/runner.ts (typescript) src/runner.ts:1-111
in (7):
  call  sym:src/main.ts#main  (src/main.ts:53, precise)  +14
    call  file:src/main.ts  (src/main.ts:70, precise)  +69
  call  sym:src/main.ts#main  (src/main.ts:62, precise)  +23  (expanded above)
  ...
  call  sym:test/retry.test.ts#runOne  (test/retry.test.ts:45, precise)  +7
    call  sym:test/retry.test.ts#fails twice, then succeeds: acked after two requeues  (test/retry.test.ts:56-60, precise)  +2..6
  ...
```

Note `EventBus.emit` appears as a call, but nothing links `emit` to the handler registered with `bus.on(...)` in another file: that is what `llm` edges are for.

**Interfaces are transparent.** A call to an interface method ends at a declaration without a body (Go `JobQueue.Requeue`), so `--out` continues with what runs: under a `call` (or `type-ref`, `read`, `write`) of an interface, or of a method or property of one, it lists the implementations as `impl  <id>  (<file>:<lines>, <resolution>)` lines. They come from the `implements` references of the index (a TS `implements` clause, Go's implicit interface satisfaction, member-level relations of a precise index) plus the same-named members of the implementing types (a Go method declared in another file of the package is found too). `--depth n` expands an `impl` in place of the declaration (its own calls appear below it) and costs no depth. Implementations in test files (`*_test.go`, `test/`, `*.test.*`, `test_*.py`, …: test doubles) are left out, counted in a closing note, and listed with `--tests` (they are listed anyway under a call that itself sits in a test file). More than 10 under one line are cut (`--limit 0` lists all). The same interface method called twice is listed once (`(expanded above)`).

```
$ xpl refs internal/runner/runner.go#Runner.Dispatch --kind call --depth 2
sym:internal/runner/runner.go#Runner.Dispatch (method) internal/runner/runner.go:75-126
out (15):
  call  sym:internal/runner/runner.go#JobQueue.Pop  (internal/runner/runner.go:79, precise)  +4
    impl  sym:internal/queue/queue.go#Queue.Pop  (internal/queue/queue.go:86-108, precise)
      call  sym:internal/queue/queue.go#runsBefore  (internal/queue/queue.go:96, precise)  +10
  ...
  call  sym:internal/runner/runner.go#JobQueue.Requeue  (internal/runner/runner.go:112, precise)  +37
    impl  sym:internal/queue/queue.go#Queue.Requeue  (internal/queue/queue.go:112-124, precise)
      call  sym:internal/queue/queue.go#Queue.release  (internal/queue/queue.go:116, precise)  +4
  ...
(3 implementations in test files left out: test doubles; --tests lists them)
```

The other direction: `--in` of an implementation adds the interface method it implements as a first-level `impl` line, with that method's callers below it (the other implementers are not listed there). The header says how many hops there are.

```
$ xpl refs internal/queue/queue.go#Queue.Requeue --in
in (1, plus 1 via interface):
  call  sym:internal/runner/retry_test.go#recordingQueue.Requeue  (internal/runner/retry_test.go:55, precise)  +2
  impl  sym:internal/runner/runner.go#JobQueue.Requeue  (internal/runner/runner.go:19, precise)  [the interface member it implements; its callers follow]
    call  sym:internal/runner/runner.go#Runner.Dispatch  (internal/runner/runner.go:112, precise)  +37
```

Base classes (TS, JS, Python; not Go, whose embedding does not dispatch) are hopped as `override` lines. Under a call, `--out` lists the subclass methods that override the callee: the call may run any of them. `--in` lists the base method a method overrides, with that method's callers below it (`plus 1 via base class`); constructors are not hopped. Test subclasses are counted, not listed, unless `--tests`. `--json`: `{ok, id, depth, kinds, out|in: [entry...], totals, moreChildren, truncated, hiddenTestImplementations, hiddenTestOverrides}`; an entry is `{kind, id, from, to, file, site, offset, resolution, note?, moreChildren?, children?}` (`note`: `seen` for `(expanded above)`, `cycle`); `impl` and `override` entries have `kind: "impl"` or `"override"`, `from` = the implementing (overriding) symbol, `to` = the implemented one, `id`/`file`/`site` = the symbol the line shows; `hiddenTestImplementations` counts the test doubles left out, `moreChildren` the references a `--max-children` cap left out (top level: under the subject).

## `xpl search <pattern> [--regex] [-i] [--limit n] [--under <dir|glob>] [--code]`

Line-by-line search of the working-tree text of every indexed file (substring, case-sensitive; `--regex` = JavaScript regex; `-i` ignores case). Hit: `<file>:<line>  <enclosing symbol id> +<offset>  <line text>`; outside every symbol it names the file (offset = line − 1). Code files come first, then config (yaml, json, toml), then docs and other text, so the first hits (`--limit`, default 50) are the code; the total is always counted. `--code` drops everything that is not code; Rust (`.rs`) is included. `--under` keeps the search inside a directory, file or symbol (`dir:src/flask`, `src/flask/`, `file:src/app.py`, `sym:src/app.py#Flask`) or a glob on repo paths (`'tests/**'`, `'src/*.py'`); repeat it or comma-separate for several. The total is counted inside the scope.

```
$ xpl search "job.completed"
src/bus.ts:1  file:src/bus.ts +0  /** Payload of the "job.completed" topic, published by Worker.run. */
src/metrics.ts:23  sym:src/metrics.ts#registerMetrics +1  bus.on<JobCompleted>("job.completed", (event) => onJobCompleted(metrics, event));
src/worker.ts:51  sym:src/worker.ts#Worker.run +21  this.bus.emit("job.completed", { jobId: job.id, ... });
...
README.md:27  file:README.md +26  When a job succeeds, `Worker.run` publishes `job.completed` on the event bus. The metrics module
$ xpl search retry -i --code --under src/ --limit 3
src/config.ts:3  sym:src/config.ts#RetryConfig +0  export interface RetryConfig {
src/config.ts:12  sym:src/config.ts#Config.retry +0  retry: RetryConfig;
src/config.ts:20  sym:src/config.ts#RunnerConfig.retry +0  retry: RetryConfig;
... 14 more matches (showing 3 of 17 in 4 files); raise --limit or narrow the pattern
```

Unavailable source produces a warning rather than silently disappearing from the search. `--json`
adds `scope`: index commit, text origin (`working-tree`), indexed/selected/searched/unavailable paths,
retained/original symbol and reference counts and original analysis reports. Absent analysis is unknown;
failed or unsupported symbol analysis does not disable text search. No matches refers only to searched text.

## `xpl guides`

Lists `.explainer/*.explainer.json` by stored title, audience, distinct view questions/roots and source/index
commits. No symbol index or service is required. The filename is a stable key and path, not the guide's
reader-facing identity. Scope is recorded metadata: change, question, repository, subsystem, or unknown
when there is no recorded view scope. This is not a readiness or freshness check. Use `ready <name>` for
export checks; `status <name>` inspects evidence after indexing.

`--json`: `{ok, guides: [{id, path, title, audience?, questions[], roots[], kind, commit, indexCommit,
change?: {base, head}}], errors: [{id, error}]}`. Loadable guides with invalid metadata stay in `guides`
as `{id, path, metadataError}`, also reported in `errors`. Empty string titles stay recorded as empty.
Each guide is read from its discovered path, even when its name matches another repository JSON file.
Read or metadata errors exit 1; no local guides is a valid empty library and exits 0. No files are written.

## `xpl stage <explainer> --dir <outside-folder> [--preview] [--files referenced|boundary|all] [--note reason] [--require-review] [--pr-result result.json]`

Stages a ready guide locally, keeping earlier versions. First inspect the included source:

```sh
xpl stage guide --dir /absolute/outside/versions --preview --json
xpl stage guide --dir /absolute/outside/versions
```

`--preview` emits readiness and sorted `includedSource: {head, base}` without creating storage or HTML.
Ordinary staging prints these paths before writing. `--files` reuses bundle selection: referenced by
default, boundary for direct callers/callees/tests, or all. Review evidence and change before/after files
are included as with bundle. There is no draft override; unfinished content, drift and stale source block
staging even with `XPL_SKIP_STALE_CHECK=1`. Ordinary staging needs no review; `--require-review` explicitly
requires a current all-content author record. Names are self-reported.

The directory must be outside the source root and its Git checkout, including symlink ancestors.
Each read-only `version-*` folder contains `index.html` and `manifest.json`. The manifest records commits,
artifactIdentity, input/HTML SHA-256 hashes, readiness, included source and review state. Staging rechecks
the guide/index/source immediately before replacing a relative `current` symlink atomically under a lock.
Open `<dir>/current/index.html` or `<dir>/<version>/index.html`. Failures retain the previous current page
and remove the attempted version; previous successful versions are never overwritten.

For a PR guide, retain its prepared checkout and use the ready result from `xpl pr finish`:

```sh
xpl stage pr-guide --root /absolute/pr-cache/input-XXXX/repository \
  --pr-result /absolute/pr-cache/input-XXXX/result-YYYY/result.json --dir /absolute/outside/pr-versions
```

Staging verifies every recorded input/artifact hash and recomputes readiness against the prepared source.
It adds version metadata to the validated ready HTML and includes the original ready result manifest.
The original HTML hash stays in that result; the staged manifest hashes the delivered page. It rechecks
GitHub base/head after writing and local freshness after that API call, before promotion. Superseded results, changed artifacts
or API failures cannot replace current. PR results keep their recorded file selection and decision note;
do not pass `--files` or `--note` with `--pr-result`.

`--json` returns `{ok, directory, current, version, manifest, includedSource}` for staging, or
`{ok, preview: true, destination, readiness, includedSource}` for preview. Exit 0 succeeds, 1 refuses or
fails, 2 reports usage. A crashed writer's `current.lock` needs explicit removal after verifying it stopped.
If lock cleanup fails after successful promotion, the command succeeds with a cleanup warning; the
new current version remains usable.
Opening current resolves to its immutable version folder before navigation. The page's About this
explanation panel shows its version, included source and captured prior versions with their scope and
author review state. The existing query contract uses `version=<version-folder>`, `tour=<id>&step-id=<id>`,
`view=<id>&focus=<element>` (repeatable), or `file=<path>&range=1:1-1:6&side=head|base`.
Ranges use 1-based lines and inclusive UTF-16 columns; omitted columns select whole lines.
Column positions allow line length + 1, including column 1 on an empty line. Base paths are change head
keys, including renamed files and deleted files. Links resolve only supplied source.
Mismatched version queries refuse to show another snapshot. About this explanation offers a link to the
current reading state and an Open latest version link through the sibling current page. Staging times
use the reader’s local format; earlier versions and technical identifiers sit behind disclosures.
Browser bookmarks retain the reading state. Earlier pages capture only history that existed
at staging. Keep the staged directory tree for sibling links; detached copies remain self-contained but
cannot navigate missing sibling versions. Save as HTML preserves navigation with the same query keys,
without live service attachment. An explicit navigation target overrides saved navigation as a whole.
Launch, saved HTML and browser Back/Forward share one restoration function. Applied step, view,
perspective, focus and source cursor are independent; restoring one does not clear another.
An empty `step-id=` records no applied step, including a tour detour. Older compact tour links without
view/focus still apply the requested step. A perspective switch keeps the applied step's source override.
Edited re-saves lose the staged version claim when their artifactIdentity changes.
This command configures no server, remote destination, credentials or upload. To point a PR at a staged
PR folder, use `xpl pr link` below.

## `xpl new <name> [--title t] [--repo r] [--url u]`

Creates an empty `.explainer/<name>.explainer.json` bound to the selected index. Refuses to overwrite (`error: … already exists; not overwriting it`). The repository name it records (`repo.name`, the label of the repo box) is `--repo`, else the first of: `package.json` `name`, the last element of the `go.mod` module (`example.com/acme/jobrunner/v2` gives `jobrunner`), `[project] name` in `pyproject.toml`, the base name of the git remote (`origin`, else the first), the directory name. `--url` records where the repository lives; it is never taken from the git remote (which may carry credentials).

```
$ xpl new jobrunner --title "Job runner"
created .explainer/jobrunner.explainer.json (title "Job runner", index .explainer/index-wt-0db7e190f5.json, commit wt-0db7e190f5)
repo: ts-jobrunner (package.json)
next: write a patch and run `xpl apply jobrunner patch.json`
```

`--json` adds `repo: {name, source, url?}`.

## `xpl apply <explainer> <patch.json|-> [--actor llm|user] [--dry-run]`

Validates and applies a patch (format: `patch-format.md`; `xpl apply --help` prints a summary of it). Atomic: nothing is written on any error. `-` reads stdin. `--dry-run` checks and lists what would change. Default actor `llm`: never modifies `origin: "user"` elements or `userFields`, and never removes an element that carries `userFields` (skipped with a `protected` warning). Exit 1 = rejected.

**A rejection lists every error of the patch at once**: anchors, ids and references are checked in one pass (an element whose anchor failed is still checked for its other problems; checks that depend on the failed anchor, like the evidence an `llm` edge needs at both ends, wait until it is fixed), so fix them all before applying again. Warnings that matter now are listed with them: a span that starts or ends on a blank line is most likely off by one (the message gives the offset where the code starts or ends), an id that names nothing carries `Did you mean: ...`. Results and rejections print on stdout; fatal errors (`error: patch … is not valid JSON`, unknown explainer, unreadable patch file) go to stderr.

`changed:` lists every id the patch added, changed or removed. A `stepsUpdate` names the view and each step it updated (for a tour: the tour and `<tour id>/<step id>`); an upsert that changes nothing is not listed (`no changes: the patch matches …`).

```
$ xpl apply jobrunner steps.json
applied to .explainer/jobrunner.explainer.json (actor llm): 2 ids changed
changed:
  view:dispatch
  dispatch:3
$ xpl apply jobrunner bad.json
rejected: 2 errors, nothing was applied to .explainer/jobrunner.explainer.json (patch from bad.json)
error   concepts[0].anchors[0] [concept:ack-path]: symbol "Runner.dispach" not found in src/runner.ts. Did you mean: sym:src/runner.ts#Runner.dispatch (anchor: file: "src/runner.ts", symbol: "Runner.dispatch")?
warning concepts[0].anchors[1] [concept:ack-path]: span src/runner.ts#Runner.dispatch +24..28 starts on a blank line (line 66): probably off by one, the code in it starts at line 67 (offset 25); check the offsets with `xpl show` or `xpl anchors`
error   views[0].stepsUpdate[0].id [view:dispatch]: step dispatch:9 is not a step of view:dispatch (its steps: dispatch:1, dispatch:2, dispatch:3)
```

The suggestion prints both spellings: the element id (for `include`, `members`, `from`/`to`, …) and the fields an anchor takes (an anchor's `symbol` is only the part after `#`).

**When the user owns what the patch touches.** Partial success stays exit 0 and ends with a summary of what was skipped, after the issue list:

```
applied to .explainer/jobrunner.explainer.json (actor llm): 2 ids changed
changed:
  sym:src/runner.ts#Runner.dispatch
  concept:new
issues (0 errors, 1 warning):
warning nodes[0].summary [sym:src/runner.ts#Runner.dispatch]: summary of sym:src/runner.ts#Runner.dispatch was edited by the user and is kept as it is
skipped as protected (sym:src/runner.ts#Runner.dispatch): the user owns those parts, so they stay as the user left them. That is not an error and not something to work around: put new content in a new view (new slug) or new elements, grow a user-curated view with includeAdd, or ask the user.
```

Views and tours are protected the same way. A tour the user edited in the tour panel is theirs (`warning tours[0].steps [tour:retries]: steps of tour:retries was edited by the user and is kept as it is`; a `remove` of it is skipped too), and a `stepsUpdate` on a view whose `steps` the user edited is skipped (`stepsUpdate of view:dispatch was skipped: its steps were edited by the user and are kept as they are`). Put the change in a new view or tour (new slug), or ask.

A patch that changes **nothing** because everything it touches is protected is not "applied": exit 1, the ids named, and what to do.

```
$ xpl apply jobrunner rewrite.json ; echo $?
nothing was applied to .explainer/jobrunner.explainer.json (patch from rewrite.json): everything this patch would change is owned by the user (skipped as protected): sym:src/runner.ts#Runner.dispatch, view:overview
warning nodes[0].summary [sym:src/runner.ts#Runner.dispatch]: summary of sym:src/runner.ts#Runner.dispatch was edited by the user and is kept as it is
warning views[0].include [view:overview]: include of view:overview was edited by the user and is kept as it is
what to do: the user's edits win over Claude's.
  - new nodes for a view the user curated: put them in a NEW view (new slug), or add them with `includeAdd` (allowed even when the user owns `include`; a whole `include` and `includeRemove` are not),
  - a summary or anchors the user rewrote: leave them, or ask the user (`--actor user` only for a change the user dictates),
  - never re-create an element under another id to replace theirs.
1
```

`--json` then has `ok: false`, `applied: false`, `protectedIds: [...]` and an `error` string (and `protectedIds` is also present on a partial success).

## `xpl validate <explainer> [--lenient]`

Strict validation requires an index matching the working tree. A stale index is an error even with
`XPL_SKIP_STALE_CHECK=1`; `--lenient` makes it a repair warning. Run `xpl index`, resolve against the
new index, and review changed explanations. Anchor checks verify locations and freshness, not prose truth.

Strict by default: ids, references, anchors (must resolve `ok` or `moved`), the evidence rule for `llm` edges. `--lenient` turns drifted/missing anchors and vanished ids into warnings (for inspecting after `resolve --write`). Exit 1 on errors.

```
$ xpl validate jobrunner
ok: .explainer/jobrunner.explainer.json is valid (strict, index wt-0db7e190f5); no errors, no warnings
$ xpl validate jobrunner            # after the code changed and `resolve --write`
.explainer/jobrunner.explainer.json (strict, index wt-3fa2f32c4b): 5 errors, 0 warnings
error   concepts[1].anchors[0] [concept:mine]: anchor src/queue.ts#Queue.requeue drifted: text of src/queue.ts#Queue.requeue changed (expected sha256-v2:2313a7a99ec8, now sha256-v2:ba9e3c066ce0). This element is user-authored, so an llm patch cannot change it (it is skipped): tell the user, or fix it with `xpl apply --actor user`.
error   views[1].steps[0].anchors[1] [dispatch:1]: anchor src/queue.ts#Queue.pop is missing: symbol Queue.pop is not in src/queue.ts; did you mean sym:src/queue.ts#Queue.take (anchor: file: "src/queue.ts", symbol: "Queue.take")? Re-anchor it to where the code went, or drop it (resend the element without this anchor, or remove the element).
error   views[1].steps[3].anchors[1] [dispatch:4]: anchor src/queue.ts#Queue.requeue drifted: text of src/queue.ts#Queue.requeue changed (expected sha256-v2:2313a7a99ec8, now sha256-v2:ba9e3c066ce0). Re-read the code and rewrite the anchor (and the explanation that depends on it).
...
```

## `xpl anchors <explainer> [id...] [--full] [--max-lines n]`

Shows what an explainer's anchors point at, so you can verify spans without reading the JSON. For every element with stored anchors (node overlays, edges, concepts, sequence steps, the `code` overrides of tour steps) it prints each anchor: role, `file#symbol`, span, status (`ok`, `moved`, `drifted`, `missing`), the resolved lines, then the code at those lines as `<line> <offset>│ code`. The offsets are the ones `xpl show` prints and a `span` uses, so a wrong span is visible at once. Status and lines are resolved now, against the index the explainer is bound to and the working tree; when the explainer file's cached lines differ, a note says so (`run xpl resolve <name> --write`).

A long anchor is cut to 12 lines (`--max-lines n`; `--full` or `--max-lines 0` prints all): its first lines, a `... N lines elided (a-b)` line with the `xpl show … --lines a-b` that reads them, and its **last** lines, because the end of a span is where an off-by-one hides.

Ids: element ids as they are (`concept:retry-policy`, `dispatch:3`, `edge:job-completed`, `sym:src/runner.ts#Runner.dispatch`, `tour:intro/t2` for one tour step), a view (`view:dispatch`: its steps), a tour (`tour:intro`: every step), or the loose forms the other commands take (`src/runner.ts#Runner.dispatch`). No ids: every element with anchors. An element that exists but has no stored anchors is listed as such (the viewer falls back to its symbol, file or members); an unknown id fails with suggestions.

A base anchor (`at: "base"`, an anchor in the code before the change) prints as `<file>@base +a..b`, marked `[before the change]`, with the old code and its offsets from line 1:

```
$ xpl anchors jobrunner concept:dead-letter-reason
concept:dead-letter-reason  (concept, llm)  2 anchors
  1. usage  src/runner.ts@base +79..79  ok  lines 80-80  [before the change]
     80 79│         await this.queue.deadLetter(job, result.error);
  2. usage  src/runner.ts#Runner.dispatch +38..38  ok  lines 80-80
     80 38│         await this.queue.deadLetter(job, `${result.error} (after ${attempts} attempts)`);
```

A tour step with a `code` override shows its stored anchors. One without shows what the viewer will derive from its `focus`: the code of the focused elements, each range marked `[derived from <element>]` (`no code for <id>` when a focused element has none to show). A group, file or directory focus derives to whole files: that is the sign a step needs a `code` override. Derived ranges are not stored anchors and are counted apart.

```
$ xpl anchors jobrunner dispatch:3 concept:retry-policy
dispatch:3  (step in view:dispatch, llm)  2 anchors
  1. call-site  src/runner.ts#Runner.dispatch +34..36  ok  lines 76-78
     76 34│         await this.queue.requeue(
     77 35│           job,
     78 36│           backoff);
  2. definition  src/queue.ts#Queue.requeue  ok  lines 87-90
     87 0│   async requeue(job: Job, delayMs: number): Promise<void> {
     88 1│     this.inflight.delete(job.id);
     89 2│     this.ready.push({ ...job, attempts: job.attempts + 1, availableAt: Date.now() + delayMs });
     90 3│   }

concept:retry-policy  (concept, user)  3 anchors
  1. definition  src/runner.ts#Runner.dispatch +30..41  ok  lines 72-83
     72 30│       // Retry policy: exponential backoff up to maxRetries, then dead-letter.
     ...
  3. test  test/retry.test.ts  ok  lines 1-91
      1  0│ import assert from "node:assert/strict";
     ...
      8  7│ import { backoffDelay, Runner } from "../src/runner.ts";
     ... 79 lines elided (9-87); --full shows all, or `xpl show test/retry.test.ts --lines 9-87`
     88 87│   const config = loadConfig(new URL("../config/default.yaml", import.meta.url));
     89 88│   assert.deepEqual(config.retry, { maxRetries: 3, baseDelayMs: 500, maxDelayMs: 30000 });
     90 89│ });
     91 90│

5 anchors of 2 elements: ok 5, moved 0, drifted 0, missing 0

$ xpl anchors jobrunner tour:intro/t2
tour:intro/t2  (tour step in view:dispatch, no code override: what its focus shows, derived, steps owned by the user)  5 ranges
  1. call-site  src/runner.ts#Runner.dispatch +34..36  ok  lines 76-78  [derived from dispatch:3]
     ...
  3. definition  src/runner.ts#Runner.dispatch +30..41  ok  lines 72-83  [derived from concept:retry-policy]
     ...

5 derived ranges of 1 tour step without a code override (not stored anchors)
```

After the code changed, the same command reads the anchors that need attention: a `drifted` span shows the code where the span used to sit (marked approximate: re-read it), a `missing` one shows its reason (and, when the anchored lines or a same-sized symbol are found elsewhere, where the code went) and no code. A header says `anchors owned by the user` for an element whose anchors the user edited (an llm patch cannot change them).

`--json`: `{ok, path, index, maxLines, anchors: {total, counts}, elements: [{id, type, view?, origin?, userFields?, derived?, focus?, noCode?, anchors: [{path, role, file, symbol?, span?, where, status, stored?, range?, approximate?, reason?, lines?: [{line, offset, text}], moreLines?, elided?: {startLine, endLine}, derived?, from?}]}], withoutAnchors?}`. A tour step has `type: "tour-step"`; `derived: true` marks a step (and its ranges) that comes from `focus`, `from` is the focused element a range comes from.

## `xpl resolve <explainer> [--write] [--allow-stale]`

Re-resolves every anchor (elements, steps, tour code overrides) against the index of the current code (`--index`, else the current commit id, else the newest), ignoring the explainer's own old index. `moved` = same text, new lines (span updated); `drifted` = text changed; `missing` = symbol gone. Prints the counts, the **drifted llm elements** (re-explain those, except `userFields`; a step names its view) and the **missing anchors** (ask the user; the reason says where the code went when it can tell: a span whose text now sits in another symbol, a renamed symbol of the same size, the same name elsewhere, test files last). `--write` saves the new ranges and the index binding; drifted anchors stay drifted until their element is resent.

`--write` **refuses** (exit 1) when the index it would resolve against no longer matches the working tree, because the ranges it saves would already be wrong: run `xpl index` first, then repeat. `--allow-stale` writes anyway (and still warns); `XPL_SKIP_STALE_CHECK=1` skips the comparison, and with it the refusal.

```
$ xpl resolve jobrunner --write
resolved .explainer/jobrunner.explainer.json against index wt-3fa2f32c4b (.explainer/index-wt-3fa2f32c4b.json)
anchors: 24 (ok 10, moved 9, drifted 3, missing 2)
drifted llm elements to re-explain (2):
  dispatch:4  (step in view:dispatch)
    views[1].steps[3].anchors[1]  src/queue.ts#Queue.requeue [definition]  now at lines 87-90
      text of src/queue.ts#Queue.requeue changed (expected sha256-v2:2313a7a99ec8, now sha256-v2:ba9e3c066ce0)
  dispatch:5  (step in view:dispatch)
    ...
drifted, but not llm-owned (left alone) (1):
  concept:mine  (origin user)  concepts[1].anchors[0]
missing anchors (2): fix or drop them explicitly
  dispatch:1  views[1].steps[0].anchors[1]  src/queue.ts#Queue.pop [definition]
    symbol Queue.pop is not in src/queue.ts; did you mean sym:src/queue.ts#Queue.take (anchor: file: "src/queue.ts", symbol: "Queue.take")?
  tour:retries/t1  tours[0].steps[0].code[1]  src/queue.ts#Queue.pop [definition]
    ...
written: .explainer/jobrunner.explainer.json
$ xpl resolve jobrunner --write     # the tree changed after `xpl index`
error: refusing to write .explainer/jobrunner.explainer.json: index wt-3fa2f32c4b (.explainer/index-wt-3fa2f32c4b.json) does not match the working tree (wt-2ca5d1e0d0): 1 changed (src/runner.ts). The ranges it would save are already out of date: run `xpl index` first, then `xpl resolve jobrunner --write` again (--allow-stale saves them against this index anyway).
```

`--json` gives `counts`, `drifted[]` (`elementId`, `owner`, `view?` for a step, `userFields`, `anchors[]` with `reason`), `driftedOther[]` (user-owned), `missing[]` (`view?` too).

## `xpl status [explainer] [--view <id>] [--all]`

`--all` lists every `.explainer/*.explainer.json` guide against the current index. It reports moved,
drifted and missing anchors, user-owned drift, broken references and unreadable guides. Moved anchors get
current locations in memory; no guide is saved. `--json` adds `{index, stale, watch, guides}`; each guide has
`name`, `path`, `title`, `attention`, anchor counts/affected locations, drift/missing reports and validation
errors, or an unreadable-guide error. `attention` means evidence or structure needs repair; it does not
claim that all required prose is finished. Catalog metadata checks do not gate these evidence reports;
an empty title is a warning, so it does not replace the report or trigger attention.
Do not combine `--all` with a guide or `--view`.

The skill's to-do list, read-only: per view, the shown nodes, participants, stored edges and steps without a `summary` (and the ids of the static edges without one, which you need to overlay them); per graph view, where it stops (its ghosts and stubs); concepts without a summary; the tours; drifted llm elements; missing anchors; **broken references**; stale edge overlays; requests queued by the viewer. Static edges are optional. `status` reads the explainer through the index it is bound to: after manual `xpl index`, run `xpl resolve <name> --write` first so that it sees the new code. A running watcher supplies the current index without saving the guide.

- The `to do:` line counts drift the user owns apart: `4 drifted (1 user-owned: ask the user)`. User-owned = an element that is not llm-authored, or an llm element whose anchors (or, for a step, whose view's `steps`) the user edited: an llm patch cannot repair those.
- `ghosts: 2 (7 stubs; stubs: top 6), most referenced: ghost:file:src/main.ts ×23, ...`: the graph view draws 2 ghost boxes, with 7 stubs (dashed edges) leading to them; `stubs: top 6` is the view's stub policy (the default is `top 8`); `×23` is how many references lead to that ghost. A folded ghost stands for several elements and is named by what it folds: `ghost:more:out ×8` ("+8 more", the ghosts beyond the cap), `ghost:rest:file:src/main.ts ×1` ("rest of main.ts", the outside symbols of a file the view shows in part). Folded ghosts are not elements (they cannot be `include`d), but their ids and the stub ids go in `hidden`. Each folded ghost also gets a line under `ghosts:` with the elements it stands for (`ghost:rest:file:src/runner.ts ×6 → sym:src/runner.ts#Runner.log ×3, ...`): up to 3 ids with their reference counts, most referenced first, then `... +N more`. `includeAdd` one of them; a ghost that is one element (`ghost:file:x`) gets no such line. `--json` lists every ghost (`views[].ghosts.list[]`: `{id, kind: target|rest|more, label, count, direction, targets: [{id, count}]}`, most referenced first) with all the elements it stands for in `targets` (most referenced first; a `target` ghost has just itself), and every stub id (`views[].ghosts.stubIds`), with `mode`, `max`, `total`, `stubs` and `crowded`. Above 12 ghosts a warning follows the line.
- `tours (n)`: each tour with its step count, and the steps whose `focus` ids or `view` no longer exist (`1 step points at something that is gone: t2 (focus: sym:src/queue.ts#Queue.pop)`): fix them with the tour's `stepsUpdate` (that step's `view` and `focus`), unless the user edited the tour (then make a new one).
- `broken references (n)`: ids that no longer exist in the index (lenient validation): the overlay of a deleted symbol, an `include`, `members`, `related` or `participants` entry, a step end, a tour's `focus`. The line `, n broken references` is appended to `to do:` only when there are some.
- `warning: stale edge overlays (n)`: stored `edge:<kind>:<a>-><b>` overlays that no graph view derives any more (the ends of a derived id follow the view's `include`, or the code changed). They are ignored until re-created on a current id; hidden edges do not count.
- `--view <id>`: only that view, and what it draws. A graph view lists each arrow (`edge:calls:...  calls  grp:ky → grp:fetch  ×2  derived  "label"  no summary`: id, kind, ends, references, `stored` or `derived` (`derived (stored overlay)` when you overlaid it), label, whether it has a summary), most references first, then each id in its `hidden` with the arrow it takes out. A hidden id that is no arrow says what it is: a box, a stub, a ghost box, a stored edge that on this map is part of another arrow between the same boxes (hiding it does nothing: hide that arrow), or nothing (remove it). A flow lists the links between its steps (`(back to the caller)` for a return without a step); a sequence its messages. `--json`: `{path, view: {...the view's status, edges: {drawn, hidden} | {links}}}`.

```
$ xpl status ky --view view:system
view:system (graph): ky between your app and the web
  boxes: 4
  edges drawn (3: 3 stored, 0 derived), most references first:
    edge:app-ky  calls  grp:your-app → grp:ky  ×1  stored  "ky.get(), ky.post()"
    edge:fetch-http-api  custom  grp:fetch → grp:http-api  ×1  stored  "HTTP requests"
    edge:ky-fetch  calls  grp:ky → grp:fetch  ×1  stored  "hands over requests"
  hidden (2):
    edge:engine-fetch  calls  grp:ky → grp:fetch  ×2  stored  no summary
    edge:timing-fetch  (a stored edge that is no arrow of its own here: on this map it is part of another arrow between the same boxes, or its ends are not on it; hiding it does nothing, hide that arrow instead)
  ghosts: none drawn (stubs: none)
```

```
$ xpl status jobrunner
.explainer/jobrunner.explainer.json: index wt-3fa2f32c4b, 2 views, 3 concepts
to do: 5 unexplained, 3 drifted (1 user-owned: ask the user), 2 missing anchors, 2 requests

view:overview (graph): Runner, queue, workers and metrics
  nodes without summary (4 of 6): file:src/config.ts, file:src/metrics.ts, file:src/runner.ts, file:src/worker.ts
  edges: 3 shown; every stored edge is explained; 1 static without summary (optional): edge:calls:file:src/runner.ts->file:src/queue.ts
  ghosts: 2 (7 stubs; stubs: top 6), most referenced: ghost:file:src/main.ts ×23, ghost:file:src/bus.ts ×2

view:dispatch (sequence): How a job is dispatched, and what happens when it fails
  participants without summary (1 of 3): sym:src/worker.ts#Worker
  steps: all 5 explained

tours (1):
  tour:retries (4 steps): every focus id resolves

anchors: 24 (ok 19, moved 0, drifted 3, missing 2)
drifted llm elements to re-explain (2):
  dispatch:4  (step in view:dispatch)
    ...
drifted, but not llm-owned (left alone) (1):
  concept:mine  (origin user)  concepts[1].anchors[0]
missing anchors (2): fix or drop them explicitly
  dispatch:1  views[1].steps[0].anchors[1]  src/queue.ts#Queue.pop [definition]
    symbol Queue.pop is not in src/queue.ts; did you mean sym:src/queue.ts#Queue.take (anchor: file: "src/queue.ts", symbol: "Queue.take")?
  ...

requests queued by the viewer (2; record selected outcomes with xpl feedback --outcomes):
  2026-09-29T12:14:26.518Z  expand file:src/config.ts  (in view:overview)  [config.ts]  "how is the yaml parsed?"
  2026-09-29T12:14:26.535Z  sym:src/queue.ts#Queue
```

A view that stops in too many places (here a file that uses 16 modules, with `"stubs": {"mode": "all"}`):

```
view:main (graph): main
  nodes without summary (1 of 1): file:src/main.ts
  edges: 0 shown; every stored edge is explained
  ghosts: 16 (16 stubs; stubs: all), most referenced: ghost:file:src/m1.ts ×1, ghost:file:src/m10.ts ×1, ghost:file:src/m11.ts ×1, ghost:file:src/m12.ts ×1, ghost:file:src/m13.ts ×1, ... +11 more (--json lists all, and the stub ids)
  warning: 16 ghosts: this view stops in too many places to read (more than 12). Set "stubs": {"mode": "top"} (what a view without "stubs" does: the 8 most referenced ghosts, the rest folded), put ghost ids in "hidden" (`status --json`: views[].ghosts.list), or add "excludeFiles"
```

A view with folded ghosts (`"stubs": {"mode": "top", "max": 3}` on a view of `Runner.dispatch` and `Queue.requeue`): the other symbols of `runner.ts` and `queue.ts` fold into one ghost each, the ghost beyond the third into `ghost:more:in`, and each folded ghost lists what it stands for:

```
view:dispatch-code (graph): Runner.dispatch and its neighbours
  nodes without summary (2 of 2): sym:src/queue.ts#Queue.requeue, sym:src/runner.ts#Runner.dispatch
  edges: 1 shown; every stored edge is explained; 1 static without summary (optional): edge:calls:sym:src/runner.ts#Runner.dispatch->sym:src/queue.ts#Queue.requeue
  ghosts: 4 (5 stubs; stubs: top 3), most referenced: ghost:rest:file:src/runner.ts ×6, ghost:file:src/worker.ts ×3, ghost:rest:file:src/queue.ts ×3, ghost:more:in ×1
    ghost:rest:file:src/runner.ts ×6 → sym:src/runner.ts#Runner.log ×3, sym:src/runner.ts#Runner.start ×1, sym:src/runner.ts#RunnerStats ×1, ... +1 more
    ghost:rest:file:src/queue.ts ×3 → sym:src/queue.ts#Queue.ack ×1, sym:src/queue.ts#Queue.deadLetter ×1, sym:src/queue.ts#Queue.pop ×1
    ghost:more:in ×1 → dir:test ×1
```

`.explainer/requests.json` keeps durable request records with stable IDs, original snapshot hashes,
optional inclusive source ranges, and explicit outcome reasons. Never delete the file after a batch.
Use `xpl feedback` to inspect context and update only selected IDs.

## `xpl feedback <explainer> [--import <file> | --export <file> | --outcomes <file>]`

Offline readers select an element and source lines, open **Feedback**, save a correction, explanation
request or expansion, and export `feedback.json`. Saving starts no generation. Import it locally:

```sh
xpl feedback myguide --import /tmp/feedback.json
xpl feedback myguide --json
# Explicitly invoke /code-explainer feedback in your chosen agent.
xpl feedback myguide --outcomes /tmp/outcomes.json
xpl feedback myguide --export /tmp/results.json
```

Exports use `{schema: "code-explainer/feedback@1", requests: [...]}`. Each request has `id`, `elementId`,
`kind: correct|explain|expand`, `at`, immutable `context: {explainerHash, sourceHash}`, optional `note`,
`view`, `label`, `explainer`, `sourceWarning` and `range: {file, fromLine, toLine, side: head|base}`, and
`outcome: {revision, status, reason, at}`. Status is `pending`, `addressed`, `unresolved`, `rejected` or `outdated`.
Outcomes are separate from author notes. Capture starts at revision zero. Imports deduplicate by ID and
take greater outcome revisions; equal or older revisions keep local results. Old exports without a
revision read as zero. Timestamps are display metadata, never an ordering across machines;
conflicting original content is rejected before any write. `--outcomes` reads an array of
`{id, context, status, reason}`; copy the selected IDs and their original context exactly. It never removes
requests collected after selection or left unselected. Only author outcome recording increments the
selected requests' revisions under the store lock. Failed writes leave the old store and counters intact.
The outcome revision never decreases in the disk store, browser or portable exports. Delayed live
responses and older pages cannot erase a newer result. Equal revisions keep the held result; import a
newer portable result into the author's store before recording its replacement.

Inspection reports `contextStatus: current|outdated` and `contextReason` separately from the stored
outcome. A changed explanation/source snapshot or stale source needs explicit reconciliation; it is never
silently rebound to the newer guide. Legacy records lacking a snapshot are unbound and outdated.
Keep feedback exports/outcome input files outside the source tree so they do not stale the index.

## `xpl revise <explainer> --select <id,id> | --run <id>`

See [revise.md](revise.md) for the installed feedback revision workflow. Selection retains original request
IDs/context, checks actual source freshness and resolves in memory. `--include <id,id>` explicitly bounds
extra/new explanation IDs; `-o /tmp/review.json` saves a source and explanation before/after packet.

`--run <id> --proposal /tmp/proposal.json` reviews `[{id, patch}]` using ordinary apply patches as `llm`.
`--decisions /tmp/decisions.json` reviews one `{id, status, reason, reconciliation?, missing?}` per selected
request; only `addressed` patches enter the candidate. Accepted outdated context needs a reconciliation
reason. Missing owners need `missing: [{id, action: "reanchor"|"remove"}]`. Location-only moves use `{}`.
Neither review writes the guide or outcomes. Show the exact decision review before explicit `--accept`.

Acceptance checks expected artifact/source identity, actual working-tree freshness, selected outcome
baselines and shared readiness before publication. `.explainer/revisions/<id>/previous.json` preserves the
old artifact; `run.json` retains the reviewed source and commit intent. Retry the same `--run <id> --accept`
after interruption: changes and outcome increments occur once. New/unselected feedback survives. A wholly
declined batch records reasons without changing the guide. Historical `--run <id>` inspection works after
source changes. After a killed process, remove only reported locks whose writers have stopped.

`--json` emits `{ok, runId, state, expected, index, previousArtifact, requests, include, resolve, decisions,
changes, source, issues, readiness?}`. `changes` contains `{id, before, after}`; `source` contains
`{file, side, text}` from the review snapshot. States: selected, proposed, reviewed, committing, committed,
done. Readiness blockers remain visible in a review (exit 0), but `--accept` refuses them (exit 1). Rejected
patches, scope/identity/freshness conflicts and malformed input also exit 1. No model is called.

## `xpl lint <explainer> [--patch <file|->] [--warn-only]`

Checks the text a reader sees (the index, when there is one, only counts the boxes and arrows of maps): the explainer title, tour titles, tour `summary`, tour step notes, view titles, flow and sequence step labels and summaries, the `summary` and `detail` of nodes, edges and concepts, and the labels of groups and concepts. It also checks the order of each tour, and what the viewer will show (a step it must title itself, a crowded map). It applies the rules of `reference/writing.md`. Run it before `xpl bundle`, and fix what it finds with a patch.

**It exits 1 on any finding,** so `xpl lint <name> --patch p.json && xpl apply <name> p.json` stops on one. Fix it; for a finding you keep on purpose, say why in your reply and run with `--warn-only` (exit 0 on warnings; a `todo-left` error still exits 1). `--strict` is the default and is kept for older scripts.

**Before you apply.** `--patch <file|->` lints the explainer as it would be after `xpl apply <explainer> <file>`. The patch is merged in memory the way `apply` merges it (same checks, actor `llm`), and nothing is written. A patch that `apply` would reject prints the same rejection lines and exits 1. `-` reads the patch from stdin.

| Rule                  | Finds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `todo-left`           | A `TODO` in any authored text, including frame/transition labels, audience, technology and view questions. One error per stored field; a tour note includes its heading and body. IDs, paths, anchors and metadata are excluded. Nested text names its field path and nearest element ID. Exit 1 even with `--warn-only`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `tour-summary`        | a tour without a `summary`, or one of fewer than 2 or more than 4 sentences (5 when the explainer has a `change`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `tour-first-step`     | the first step does not show the big picture: it focuses a test (a file the index counts as a test, or a group of them), or only a concept that lights up nothing in its picture; it opens on a flow or sequence when the tour has a map; or its title says "edge case", "corner case", "gotcha" or "open question"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `tour-covers-map`     | a map (graph view) of at most 10 boxes that the tour uses has boxes that never come up: no step focuses the box, something inside it, a group it belongs to, a step or edge that starts or ends there, or a concept related to it, and no note or the summary names it (by its label, symbol or file name, or a method by its own name: `findEdge` for `nodes.findEdge`). Names match by word stems, case-insensitive, with or without backticks: "the web server" names "Web servers". Lists the boxes (`ids` in `--json`). Give each a step, name it in a note in plain words, or take it off the map                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `tour-length`         | a tour of more than 12 steps: split it, or merge steps that make the same point                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `note-heading`        | a tour note that does not start with a `### Plain title` line (and says so when it starts with a placeholder such as `Fix 1:`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `code-title`          | a title that looks like code: a call `f(`, an identifier with `_`, a dotted name `a.b`, a `#` in a name, code operators, a code keyword first (`return x`), one camelCase identifier. Code in backticks inside a plain title is fine (``How `Host.matches` reads the header``)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `placeholder-title`   | a title such as `Fix 1`, `Note`, `Step 3`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `long-sentence`       | a sentence over 25 words                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `long-average`        | a field whose sentences average over 20 words                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `bare-it`             | a sentence that starts with `It` or `This` and a verb (`It calls ...`, `This is ...`): name the subject                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `filler-word`         | marketing and filler words (seamless, robust, leverage, elegant, powerful, simply, just, basically, delve, crucial, comprehensive, cutting-edge, ...), each with a replacement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `absolute-word`       | all, every, everything, everywhere, everyone, anything, never, always, only, consistent(ly), guaranteed: check every case and anchor it, or narrow the claim. **Evidence next to the text passes:** the text of an element with `anchors` (a node, edge, concept or step), and a tour note sentence that names a part the step shows (a focused element with anchors, a symbol or a file; any focused element when the step has `code`). In an explainer of a change, a tour summary or note sentence about what changes (`only download progress changes`, `the only change is ...`) passes too: the diff is its evidence. The same words get the same verdict in every field. Not counted: `all`, `every` or `only` before a count in digits (`all 22 new cases pass`, `only 4 of the 22`), a measured result; `only when/if/after ...` (a condition); `only` after a verb or a noun, which narrows a claim (`compares only the host part`); `all` after a list of named cases (``URL, `TrustedHostMiddleware` and `Host.matches` all call ...``); `outside everything` (a position); `not all`, `if every`; and idioms (`not ... at all`, `after all.`, `once and for all`, `all of a sudden`; `at all times` still counts). Still counted: `only` that opens a clause (`Only the router ...`, `now only URL ...`), `the only`, `only by`; `all three`, `each x and each y all ...` |
| `repeats-summary`     | a note sentence that repeats the summary of an element the step focuses (the reader sees both)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `long-note`           | a note whose text under its `### title` is over 60 words: keep the one point of the step in 1-3 short sentences                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `code-heavy`          | a text that names more different pieces of code (code spans) than a reader can follow: over 3 in a note, over 1 in a note on an architecture map (a map with a box that has a `role`), over 2 in a tour summary. Say what happens in everyday words first. Not counted: example values (numbers such as `503`, `-1`, `1.5`; `null`, `true`, `undefined`, `Infinity`; quoted strings; URLs and route paths such as `/admin/*`, `users/{id}`, `lots/of/:fun`), and file names in a sentence that lists what a map leaves off ("`is.ts` and `types.ts` are left off this map"). Text that still holds a `TODO` is not judged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `flow-label-code`     | a flow step label written as code; flows name stages in plain words. Sequence views may keep call text                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `markdown-in-plain`   | `**bold**`, `__bold text__`, a `# heading` line or a `[text](link)` in a title or a label, which the viewer shows as plain text: the explainer, tour and view titles, and the labels of elements, steps and edges. Code spans and code shapes (`**kwargs`, `__init__`, `xs[0](y)`) do not count                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `markdown-in-summary` | a `# heading` line or a `[text](link)` in the `summary` of a node, edge, concept or step. Inline markdown is fine there (code spans, `**bold**`, `*emphasis*`, as in `**Changed:** ...`): the viewer renders it. A summary is one or two sentences next to the code: put headings and links in the `detail`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `untitled-step`       | a tour step without a note, or whose note has no `### title` and a first sentence over 80 characters (or opens with a list or code): the viewer shows that sentence cut short, or "Step N". Replaces `note-heading` for such a step                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `change-not-shown`    | an explainer of a change: changed files whose code no tour step shows (its `code` ranges, what it focuses, their members, ends and anchors; `ids` in `--json`). Naming a code file in a note is not enough: show it on a step (a range in `code`, or a symbol in the focus). Docs (readme, `*.md`, `docs/`), tests, lock files and renames with no edits may instead be named in a tour text (by file name, or by path when two changed files share one); the message says which kind each is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `far-ranges`          | a tour step whose ranges in one file (its `code`, else the anchors of what it focuses) make more than 3 places, ranges over 40 lines apart: Present shows a pane per place, at most 3 per file, so the last pane holds the rest and opens at the first (Read steps through any number, "range 1 / 4"). Keep the places the note is about, or split the step. Two or three far-apart places are fine. Not judged while the note holds a `TODO`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `long-talk-note`      | in a talk (a tour whose id or title says talk, presentation, demo or slides), a note over 280 characters under its title: Present sets it in its smaller caption type, and it may scroll                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `big-map`             | a graph view a tour shows with more than 8 boxes (counted on the index; without one, the `include` entries): a guide picture or a slide of it is too small to read                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `crowded-map`         | a graph view with more than 2 arrows (derived and stored) per box (needs the index). The hint and `ids` in `--json` list the least used drawn edges: put them in the view's `hidden`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Markdown fields: a tour `summary`, a step `note` (with its `### title` line) and a `detail` take any markdown; the `summary` of an element or a step takes inline markdown; titles and labels are plain text. Code spans (`` `...` ``) are left out of the word checks and count as one word. Every finding names the element, the field, a short quote and a fix. Exit codes: 0 no findings; 1 any finding (with `--warn-only`: only a `todo-left` error), or a rejected patch; 2 usage error.

```
$ xpl lint jobrunner
.explainer/jobrunner.explainer.json: 17 texts checked

tour:intro (tour)
  summary  tour-summary: no summary: readers see the summary first, under the tour title
    "Intro talk"
    fix: add 2-4 sentences: what this is and why it matters; for a change: what behaves differently, the risk, the tests
  steps  tour-covers-map: 2 boxes of the map view:overview (3 boxes) never come up: no step focuses them, no note names them
    "worker.ts, metrics.ts"
    fix: give each a step, or name it in a note by its label in plain words ("web server" counts for "Web servers"; no backticks needed, and code names count toward code-heavy) and say why the tour skips it, or take it off the map

tour:intro/t1 (tour step)
  note  note-heading: no "### title" line: the viewer has to make a title from the text
    "Big picture first: scheduling is two files."
    fix: start the note with "### <plain title>", a short phrase that says what happens here

tour:intro/t2 (tour step)
  note  note-heading: no "### title" line: the viewer has to make a title from the text
    "Where failures go: requeue with backoff."
    fix: start the note with "### <plain title>", a short phrase that says what happens here

4 findings in 3 elements (tour-summary 1, tour-covers-map 1, note-heading 2); fix them, or keep one on purpose (say why) and run with --warn-only

$ xpl lint jobrunner --patch fix.json
.explainer/jobrunner.explainer.json with patch fix.json (1 id changed, nothing written): 18 texts checked
...
3 findings in 3 elements (tour-covers-map 1, note-heading 2); fix them, or keep one on purpose (say why) and run with --warn-only

$ xpl lint jobrunner --patch bad.json
rejected: 1 error, nothing was applied to .explainer/jobrunner.explainer.json (patch from bad.json)
error   tours[0].sumary [tour:intro]: unknown field "sumary" (allowed: id, title, summary, steps, stepsUpdate, provenance)
nothing linted: fix the patch, then run `xpl lint --patch` again
```

A flow step is named with its view (`host-check:1 (step in view:host-check)`). `--json`: `{ok, path, patch?, changed?, protectedIds?, strict, checked, total, counts: {<rule>: n}, findings: [{rule, severity?, elementId, kind: explainer|tour|tour-step|view|step|node|edge|concept, view?, field, quote, message, hint, ids?}]}` (`ok` is false when the exit code is 1: a finding (with `--warn-only`, a `todo-left` error), or a rejected patch, which gives `{ok: false, path, patch, changed: [], issues, error}` as `apply` does; `field` is `title`, `summary`, `note`, `note heading`, `label`, `detail`, `steps` for the order checks, `code` for `far-ranges`, `change` for `change-not-shown`, `include` or `hidden` for the map checks; `strict` is false with `--warn-only`; `view` names the map of a `tour-covers-map` finding; `ids` lists the boxes, files or edges a finding is about).

## `xpl pr prepare <url|owner/repo#number|owner/repo> [number]`

Prepare GitHub.com PR input with existing `gh` and git access:

```sh
xpl pr prepare https://github.com/owner/repo/pull/42 --cache-dir /absolute/pr-cache --json
xpl pr prepare owner/repo 42 --cache-dir /absolute/pr-cache --precise off
xpl pr cleanup /absolute/pr-cache/input-XXXXXX --cache-dir /absolute/pr-cache
```

Storage defaults to `$XDG_CACHE_HOME/xpl/pr` or `~/.cache/xpl/pr`, outside the developer checkout.
Each run resolves the API base/head full SHAs and fetches a separate detached head. The base repository's
PR ref can supply an inaccessible/deleted fork, but the resolved exact head must exist after fetch;
a ref that moved to another commit is not substituted. Only head is indexed. `--precise off` is the default;
`auto`/`require` explicitly opt into optional analysis tools. No developer branch, index, refs or files change.
Inherited Git directory/work-tree/index overrides are removed from the owned Git context, which is passed
through indexing, diff computation and source reads. Checkout bytes must match the raw head blobs before
indexing. A configured smudge, encoding or line-ending conversion that changes content fails preparation
and removes staging; disable that conversion for the PR run before retrying.

JSON output gives `directory`, `repository`, `manifestPath` and `pr` identity. The immutable `input.json`
records `schemaVersion: 1`, `kind: "github-pr-input"`, preparation time, PR identity, the rename-aware
API base..head change, changed-file before/after source, head analysis and warnings. Text is read from
the exact git commits; added-before and deleted-after sides are absent, and binary/unreadable sides have
an explicit unavailable reason. Index metadata carries the full head, relative index path, SHA-256,
file hashes and trust labels. Callers and tests describe head analysis only.

The `prepare` action writes input only. Use `create` and `finish` below for installed authoring and the
local result check. Preparation invokes no agent and makes no freshness or ready claim. Keep old inputs as historical snapshots. Failures remove
the failed staging directory; a killed process can leave a marked input for explicit cleanup. Cleanup
refuses unowned paths and symlinks; stop consumers first. GitHub access/fetch/index failures exit 1;
bad arguments exit 2. No credentials are created and nothing is written to GitHub.

## `xpl pr create <PR>` and `xpl pr finish <input-directory>`

```sh
xpl pr create owner/repo 42 --name pr-42 --audience reviewers --question "What changes for callers?" --skill-dir /absolute/installed-skill --cache-dir /absolute/pr-cache --json
# Explicitly invoke the returned /code-explainer prompt in the installed agent.
# Author through handoff.json's command prefix, which calls the installed skill launcher safely.
xpl pr finish /absolute/pr-cache/input-XXXXXX --cache-dir /absolute/pr-cache --json
```

`create` uses the same preparation, then verifies the installed skill and bound CLI. Its launcher runs
`new`, `change` with the full API base..head and `draft change`. The immutable `handoff.json` records the
input digest, name, installed paths/CLI hash, commands and explicit skill invocation. The output adds
`handoffPath` and `invocation`. It starts no model: invoke the prompt yourself in the installed agent.
Use the supplied `command` prefix for every authoring command; it excludes inherited Git overrides and
pins owned root/index/Git paths and the installed CLI. Patch files belong outside the repository.

`finish` requires that handoff, unchanged input/index identity, exact guide change record and raw head
source bytes outside generated `.explainer/` outputs. It uses the installed `bundle --files boundary`
with the common readiness check. `--note` records warning/omission decisions; `--require-review` opts
into all-content author review policy. Neither option permits unfinished or stale content. Creation
and local export need installed assets, not a live model or hosted xpl service.

The final API check compares both full commits. Matching results exit 0 with `status: ready`; a changed
head or base exits 1 with `ok: false`, `status: superseded` and observed commits. Historical output is
retained; explicitly create the updated PR to obtain a new input/guide. API/export failures exit 1,
remove only result staging and preserve the input and guide. If authoring failed, read the existing
stored guide and draft before resuming the same explicit skill prompt; never recreate it with `new`.

Each finish returns a separate `result-*` directory and `manifestPath`. Its read-only `result.json` is
`schemaVersion: 1`, `kind: github-pr-result`, with original `pr`, `observed`, `checkedAt`, `status`, input
path/SHA-256, installed skill paths/CLI hash, common readiness report/portable identity, artifact paths
and SHA-256 digests, and included head/base source keys. It carries checked explainer, full head index
and offline HTML snapshots. Rename before-text is keyed by the head path; consult `input.json` for
`oldPath` and unavailable source. Previous results are never overwritten.

Ready is an observation at the check timestamp. A version-sharing consumer must check artifact hashes
and re-resolve both commits before publishing current. This command creates no current pointer and
publishes nothing. Keep inputs while finishing or while a consumer needs the referenced input evidence.

## `xpl pr link <staged-dir> --url <base-url> --visibility team|public` and `xpl pr check-link <PR>`

Shares a staged PR preview through a static host the team already runs. Stage the ready result into the
folder that host serves (or copy it there, for example with `rsync -a`), then link it:

```sh
xpl stage pr-42 --root /absolute/pr-cache/input-XXXX/repository \
  --pr-result /absolute/pr-cache/input-XXXX/result-YYYY/result.json --dir /srv/previews/pr-42
xpl pr link /srv/previews/pr-42 --url https://previews.example/pr-42 --visibility team --json
```

`link` reads `<dir>/current/manifest.json`, which must be a ready version staged with `--pr-result`. It
resolves the PR again and refuses, with no GitHub write, when base or head moved since staging. It
refuses `--visibility public` for a private repository; `team` means the host limits who can read it,
which xpl does not check. It then posts one comment, or edits its earlier one in place, linking
`<base-url>/current/index.html` and `<base-url>/<version>/index.html`. Only a marked comment from an
owner, member or collaborator counts as the link. `--json` returns `{ok, action, pr, current, version}`
with `action` `created`, `updated` or `unchanged`. A failed write exits 1; the earlier comment and all
staged versions stay as they were. The caller's `gh` token needs permission to comment.

`check-link` keeps that comment honest when the PR moves. When the PR's base or head differs from the
linked version, it rewrites the comment as outdated with only the last version's link; otherwise it
leaves it alone. `--json` returns `{ok, action, pr}` with `action` `none`, `current`, `outdated` or
`unchanged`. Run it from a workflow in the repository, for example `.github/workflows/xpl-preview.yml`:

```yaml
name: xpl preview link
on:
  pull_request_target: # runs no PR code; the token can comment on PRs from forks too
    types: [synchronize, reopened, edited]
permissions:
  pull-requests: write
concurrency: xpl-preview-${{ github.event.pull_request.number }}
jobs:
  check-link:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx --yes @krimvp/xpl pr check-link "$REPOSITORY#$NUMBER"
        env:
          GH_TOKEN: ${{ github.token }}
          REPOSITORY: ${{ github.repository }}
          NUMBER: ${{ github.event.pull_request.number }}
```

The workflow needs an xpl release that has `pr check-link`. It does not create the new guide: an author
runs `xpl pr create`, `xpl pr finish`, `xpl stage` and `xpl pr link` for the new head, which edits the
same comment back to current.

## `xpl change <explainer> [<base>..<head>]`

Records the change an explainer is about, from git, and prints what it touches. Run it once, at the start of explaining a PR or MR, on a checkout of the head with the index built (`xpl index`). Nothing is written to the repository.

- `<base>..<head>` takes any git revisions (`main..HEAD`, `2284ff0^..2284ff0`); `<base>...<head>` starts from their merge base; `<base>` alone ends at the commit of the index. The head must be the commit the index was built from, else it stops: `the head HEAD~1 (85c3b74) is not the commit the index was built from (2284ff0). Check out 85c3b74, run xpl index, then run this again`.
- It stores `change: {base, head, files: [{path, status: added|modified|deleted|renamed, oldPath?, hunks: [{oldStart, oldLines, newStart, newLines}]}]}` in the explainer (full SHAs; hunks as `git diff -U0` prints them). Patches cannot change it.
- It prints the changed files with `+added -removed`; the **changed symbols** (index symbols that hold an added or edited line; `new` when every line is new; a function nested in a function counts as part of it); for each, its **direct callers** outside test files and the **tests** that reference it (a test function, or a test file for an import), or `no test found`. A method that runs when an instance is called (`__call__`, `handle`) gets `callers via instance`: the code that builds its class. That is a guess, and the output says so. Lines outside any symbol (imports, module-level code) are listed apart, and so are the test files the change touches with their new and changed tests.
- `xpl change <explainer>` without a range prints the analysis of the recorded change again.

```
$ xpl change jobrunner HEAD~1..HEAD
change jobrunner: 5774f2c..349730f (1 file, +1 -1), index 349730f
written to .explainer/jobrunner.explainer.json

files (1):
  M  src/runner.ts  +1 -1

changed symbols outside tests (1):
  sym:src/runner.ts#Runner.dispatch  (method, lines 42-88)  changed at 80
    callers outside tests (1):
      sym:src/runner.ts#Runner.start  (src/runner.ts:32)
    tests: no test found (no test references it by name; tests of other code may still run it)

no test found for 1 changed symbol: sym:src/runner.ts#Runner.dispatch
Callers are direct (depth 1) and come from the index: ...
```

The callers and tests come from the index: a call through a variable, a callback or a framework is not seen, and "a test references it" does not mean the test checks the change. Read the tests before you say what they cover. With the change recorded, anchors may point at the code before it (`"at": "base"`, `patch-format.md` section 1), `xpl show --at base` prints that code, `xpl validate` checks it, and `xpl bundle` embeds it.

`--json`: `{ok, path, written, change, analysis: {base, head, files: [{path, status, oldPath?, added, removed, hunks, test, indexed, outside: [lines]}], totals: {files, added, removed}, symbols: [{id, symbolId, file, kind, range, status: new|changed, lines, callers: [{id, file, lines, kinds, resolution, changed?, via?}], viaInstance: [same], tests: [{id, file, refs, kinds, changed?, via?}]}], testSymbols: [{id, symbolId, file, kind, range, status, lines}], untested: [ids]}}`.

## `xpl draft change|repo|path <explainer> [<entry id> ...] [-o <file>]`

Add `--audience "New maintainers" --question "How are retries selected?"` to focus the draft.
The audience is saved in the patch's scope and the question in view scopes and tour summary placeholders.
Architecture is provisional: verify primary users, entry points and outside systems. Path drafts list
selected call sites in source order; review conditions, loops and omissions before treating them as an
execution story. Repeated and capped targets are also named in the first tour step. In heuristic indexes, function values are
`read` references, not calls or recursion.

Prints a patch skeleton for one of the three scopes, built from the index (and the change record) with no LLM: the structure the index proves, with `TODO: <what to write>` in every text you must write. `xpl apply` accepts the draft as it is. Use it to start an explainer, then write the text and check it against the code.

| Draft                   | Structure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `change <explainer>`    | Needs the change record (`xpl change <explainer> <base>..<head>` first). A map "What this change touches" (`stubs: none`): the changed symbols (small changes to methods of one class share a group box; their files when there are many), their direct callers outside tests, and one group box for the changed tests. Box summaries start with `New:`, `Changed:` or `Unchanged:`. A caller is code that calls: a test (type tests in `test-d/` and `*.test-d.ts` too) or code that only names a changed type (`import type`, an annotation) is not one. A tour in review order: what changes for users, where the change enters (a caller; with none outside tests, the changed public function closest to callers), one step per changed piece in call order, the other changed files, who else is affected, tests and gaps (the symbols with no test found are named), risks. At most 12 steps, with ids `t10`, `t20`, ... so a step you insert fits between two (`t15`). Every changed file is anchored, test files too; a deleted file is anchored in the code before the change (`at: "base"`).                                                                                                                                            |
| `repo <explainer>`      | Two levels. A system map (`view:system`, `stubs: none`): the project as one service box (one per program when `services/`, `apps/` or `cmd/` hold several), who reaches it (a web or CLI framework) and what it relies on (databases, caches, queues, file stores, other APIs), found from the import lines and anchored there (hints: check each; imports in comments, JSDoc examples and docstrings, and imports of the project itself, do not count). A library (package metadata, but no `bin` or `start` script, no scripts in `pyproject.toml`, no `__main__.py`, no Go `package main`) gets a "Your app" box anchored at the README example that imports it, with an arrow to the service. Each service box `opens` a map of its inside: the top-level folders, or the files of a one-package project (below `src` in a `src/` layout), at most 8 boxes with label and summary TODOs, plus the outside systems they use with an arrow from each part that imports one. A tour from the top: the system map (its first step shows the README), what it relies on, the inside, then every part. When files are left off the inside map, its first step lists them with the box each shares the most references with: a start for your groups. |
| `path <explainer> <id>` | A sequence of the calls the entry symbol makes (depth 1, in source order; at most 6 participants and 12 calls), each with the call site and the callee's definition as anchors. A method goes to the lifeline of its class (the entry's own class too), a function to its own; only recursion is a call of the entry to itself. A call through an interface goes to its one implementation. Left out, and listed in the notes: one-line helpers of the entry's own class or file that call nothing, conversions to a type and data built from a class with no constructor (Go's `nodeTyp(t)`), and, over the caps, the calls that reach the least code. A tour: the big picture, then one step per main call (at most 8). A summary names the subclasses that override a called method. No flow view: decide the stages yourself. Several entries (`path <explainer> <id> <id2>`): one sequence each and one tour through them, for a question with two halves. A method a class inherits (`sym:src/url_safe.py#URLSafeTimedSerializer.dumps`) starts at the base that defines it (a note says which), and its calls to methods of the class and its bases go where the class's method order finds them (a mixin's override).                      |

Every tour step has at most 2 code ranges, and the note is `### TODO: ...` plus the body. Ids already in the explainer are not reused (`view:change-map-2`), and a box the explainer already explains gets no new summary. The draft is checked the way `apply` checks it before it is printed, and for ids that exist nowhere (named in a text or a note) and focus ids that are not on their step's view.

```
$ xpl draft path jobrunner sym:src/runner.ts#Runner.dispatch -o path.json
wrote path.json
draft path for jobrunner: a sequence of 9 calls between 6 participants, 5 summaries, a tour of 9 steps, 35 anchors, 38 TODOs to write
note: called more than once, drawn once at the first call: sym:src/runner.ts#Runner.log (3 calls)
note: not drawn, one-line helpers that call nothing: backoffDelay
note: calls without a tour step of their own (at most 8): sym:src/runner.ts#RunnerStats.record
next: write each TODO, then `xpl lint jobrunner --patch path.json` and `xpl apply jobrunner path.json`
$ xpl draft change jobrunner
error: .explainer/jobrunner.explainer.json has no change recorded: run `xpl change jobrunner <base>..<head>` first (e.g. main..HEAD), then `xpl draft change jobrunner`
```

A step of that sequence and its tour step:

```json
{
  "id": "runner-dispatch:1",
  "from": "sym:src/runner.ts#Runner.dispatch",
  "to": "sym:src/queue.ts#Queue",
  "label": "pop()",
  "kind": "call",
  "summary": "TODO: what happens at this call, with its condition.",
  "anchors": [
    {
      "file": "src/runner.ts",
      "symbol": "Runner.dispatch",
      "span": { "from": 4, "to": 4 },
      "role": "call-site"
    },
    { "file": "src/queue.ts", "symbol": "Queue.pop", "role": "definition" }
  ]
}
```

What the draft cannot know, you write: every title, summary and note; the groups of a repo map (one box per responsibility); which caller matters and why; "before" claims (read the base with `xpl show --at base`); what the tests check; the risk. The draft names what it left out (`note:` lines). Write the patch outside the repo, then `xpl lint <explainer> --patch <file>`: `todo-left` lists each placeholder still there (an error-level finding: lint exits 1 until every one is written). Without `-o` the patch goes to stdout and the summary to stderr.

`--json`: `{ok, kind, path, out?, counts: {views, boxes, participants, sequenceSteps, overlays, groups, tourSteps, anchors, todos}, notes: [text], applyWarnings?, patch}`. Exit codes: 0 ok, 1 no change recorded, an entry that is not a symbol, or nothing to draft, 2 usage error.

## `xpl view <explainer> [--port p] [--host h] [--no-open]`

The visible page polls for resolved explanation, source and index changes. A changed ETag refreshes
the bundle and previously opened files while preserving navigation; unsaved edits postpone adoption.
A newly generated index is followed unless `--index` pins one. Changed source is shown with a stale-index
warning until reindexing. Save as HTML carries the refreshed index, loaded source and any warning.

Serves the viewer with live repo access at `http://127.0.0.1:<port>/` (default 4747, else a free port; `--port 0` = any) and tries to open a browser. The explainer is re-read from disk on every request, and the page checks for changes every 2 seconds: what `xpl apply` writes shows up without a reload. Edits in the viewer (layout, expanded nodes, the stubs control, tour steps, Details text and explicit checked anchor repairs/removals) are saved as `user` edits; "Explain this" clicks, with what the user typed above the button as the `note`, are saved with stable IDs and original snapshot context to `.explainer/requests.json`. The Feedback panel also offers correction/explanation/expansion requests and JSON export; saving starts no generation. Runs until Ctrl-C. It binds to 127.0.0.1; `--host` other than that exposes the source code. The anchors are re-resolved as for `xpl bundle`; drifted or missing anchors do not stop it (it is where you fix them), but it warns, and the page shows the same banner.

```
$ xpl view jobrunner --no-open --port 0
serving .explainer/jobrunner.explainer.json at http://127.0.0.1:34971/  (Ctrl-C to stop)
```

API (for scripts): `GET /api/guides` (shared local catalog; `?id=<key>` returns a read-only source snapshot), `GET /api/bundle`, `GET /api/export` (current complete export snapshot and shared readiness report), `GET /api/explainer` (the explainer with its anchors re-resolved, with an `ETag`; what the page polls), `GET /api/file?path=`, `GET /api/base-file?path=` (the code before the recorded change of a modified, renamed or deleted file), `PUT /api/views/<id>`, `PUT /api/tours/<id>`, `PUT /api/review` (bounded author review user patch), `GET|POST /api/requests`.

## `xpl service <start|pause|resume|stop|status> [explainer] [--background] [--port p] [--backend none|claude] [--skill-dir folder] [--job-timeout seconds] [--recover] [--watch]`

Starts the existing viewer server on loopback (`127.0.0.1`) with one owner per canonical repository root.
Foreground is the default; stop it with Ctrl-C or `xpl service stop`. `--background` starts the installed
CLI as a detached process and logs to `.explainer/service/service.log`. It opens no browser automatically.
The first start needs a guide. Later starts reuse the saved guide, port, pinned index and backend label:

`--index` resolves from the working directory first, then the repository root, as for `view`. The service
checks that the resolved index stays inside its repository and saves that absolute path for restart.

```sh
xpl service start jobrunner --background --port 0
xpl service status --json
xpl service stop
xpl service start
```

`status --json` reports `{ok, state, root, guide, backend, instanceId, pid, url, ownershipLock, watch, recovery?}`.
States are `stopped`, `starting`, `running`, `unavailable` (live owner whose identity cannot be verified)
and `interrupted` (recorded owner exited unexpectedly). Status reports these states with exit 0;
failed start/stop exits 1 and usage errors exit 2. Ownership tokens stay in private local records and are
never printed. Stop verifies UUID, root and token through loopback; it never signals a PID.

Duplicate starts are refused. Stop before changing guides. Use `--root` to attach another repository's
separate service; guides and state paths must stay inside that canonical root. An explicit busy port fails
with a `--port` hint. Without a saved/explicit port, start tries 4747 and falls back to a free port.
Record writes recheck the directory after acquiring the filesystem lock, including first startup with
no saved records. A service-directory symlink swapped during that wait is refused before publishing state.
`--backend none` (default) disables execution; `claude` selects the installed Claude Code print-mode
proposal runner, using its existing login and provider access. `--skill-dir <folder>` selects a managed
installed code-explainer skill (default `~/.claude/skills/code-explainer`); `--job-timeout <seconds>` bounds
each invocation (default 300, range 1–3600). Both settings persist. Availability means configured, not
authenticated: missing tooling/skill, login, rate limits and timeouts become actionable job failures.
Local serving and manual commands need no provider network or authentication.

After a crash, inspect artifacts and use `xpl service start --recover`. It archives the interrupted owner
record and preserves the last valid index/explanation. A live unverified PID is never replaced, and a
crashed writer lock must be inspected and removed explicitly; no lock is stolen because it is old.
The viewer shows its connection and configured backend below the header. Configured Claude says
sign-in is checked when a job runs; availability never implies authentication. Repository/guide bookmarks
and API requests refuse another attachment at the same address. Restart reuses saved context and refreshes
the open page's instance while keeping navigation and unsaved edits. After stop, choose **Use loaded snapshot
offline** for manual edits, browser feedback and embedded-snapshot HTML export. **Retry connection** resumes
the original address; **Edit → Retry save** persists queued offline edits. Export/import offline feedback
explicitly. Manual iteration and offline HTML work with the service stopped.

The service persists durable lifecycle records in `.explainer/service/jobs.json`. `GET /api/jobs` reports
runner availability and this guide's history; `GET /api/jobs/<UUID>` reads one job. Restart marks running
attempts interrupted, while queued work and completed proposal references survive. Cancellation and
supersession discard results and fence late callbacks. `POST /api/jobs/<UUID>/cancel` and `/supersede`
take `{}`. Retry takes `{expectedAttempt}` from the inspected job, so repeated delivery cannot start
another attempt after a fast failure. Job input retains the existing revision journal and original selected
feedback IDs; no job route applies a patch or finalizes an outcome. With backend `none`, submission/retry
reports 503. With `claude`, `POST /api/jobs` takes `{id: UUID, selectedRequestIds, include?}` and runs one
non-interactive process at a time. Source and the installed skill are read-only; only the attempt-owned
proposal file is writable. Commands, subagents, MCP and inherited hooks are disabled. Cancellation,
supersession and timeout kill the child process group and discard unpublished output. Normal and error
exits use the same teardown in one post-spawn finally, including failed identity reads; the launcher reports
the original CLI exit code without exiting first. One two-second deadline bounds identity checks, group
drain and launcher exit. Inherited stream close cannot delay completion; teardown destroys pipes and
releases the child handle after drain or deadline, so shutdown can exit. Cleanup failure writes a failed
job with `JOB_PROCESS_CLEANUP`, its group/verification details and a durable scheduling barrier.
Restart/recovery clears that barrier only after verifying the old group gone; an unverified group is never
signalled by PID. Service death
closes the attempt launcher's pipe and kills the group too. Before running Claude, the job records the
group ID and Linux boot/start ticks under its attempt lock. Recovery verifies that identity, terminates
the old group and waits before allowing retry; a reused PID is never signalled. Verified execution
requires Linux /proc; other platforms report a job failure and can use manual revision. After source and
ownership rechecks, valid ready proposals enter the existing revision journal as `proposed`. Inspect
`xpl revise <guide> --run <revisionRunId>` before deciding anything. Creation fills a guide explicitly
initialized by `xpl new`/draft authoring, with selected creation requests and included new IDs; it does
not create a second proposal format or overwrite a name. Service-owned journals refuse manual
proposal/decision/accept writes from selection onward, including cancellation or supersession before
a proposal arrives. Selection records the job ID; the guarded proposal records its attempt ID. Older
unbound service journals recover ownership from the matching revision job in the repository ledger.
Read-only `revise --run` stays available. In the viewer, **Jobs** lets the
author select feedback, start/cancel/retry and inspect progress or failures. **Review proposal** shows
readable changed text with marks, concise evidence and source before/after. Each selected request needs
a decision and reason. **Review decisions** validates the exact candidate; **Accept reviewed revision**
then uses #30's freshness/readiness, user fields and outcome journal. New feedback is preserved.
Interrupted acceptance exposes **Recover acceptance** without publishing the patch twice.
The guarded API is `GET /api/jobs/<id>/review?attemptId=<uuid>`, `POST .../review` with
`{attemptId, decisions?}`, and `POST .../accept` with `{attemptId, reviewToken}`. The token comes from
the inspected review and binds its exact candidate and decisions to the job attempt. Acceptance compares
it under the journal lock, including recovery. Another view's changed decisions return 409 and reload
the review; inspect it again before accepting. Tokens are derived from the saved journal without a
migration. Older clients that omit the token receive 400; manual `revise --accept` is unchanged.
Per-request previews advance through proposals in order; each shows its own changes relative to the
preceding candidate. The chosen combined candidate must still pass readiness. Decisions use the same
statuses, reconciliation and missing-anchor permissions as `xpl revise`. Cancelled/superseded/old attempts
and stale candidates cannot apply. Once journaled acceptance begins, recover it before cancelling or superseding.
Controlled executables prove adapter/lifecycle failures only; a real installed Claude job proves the
provider integration. `claude --version` does not establish authentication.

Headless answers use `POST /api/answers` with `{id: UUID, requestId}` for a saved `explain` request with
its question in `note`. GET collection/item and POST `/<UUID>/<retry|cancel|supersede>` reuse job guards and
`expectedAttempt`. The worker freezes the guide, identity and guide/question head/base source (5 MB maximum).
Claude writes only `{text, references:[{file, side, fromLine, toLine, quote}]}`; every complete-line quote
must match recorded source exactly. Invalid evidence or a patch field fails the job. Returning an answer
never edits the guide or records a revision outcome. Use ordinary `xpl revise` for optional guide changes.

Completed answer jobs retain the original source/explanation identity and report `contextReason` after
source or guide changes. Reload replays the completed receipt into optional `FeedbackRequest.answers`;
feedback export/import unions history by stable answer ID independently of outcome revisions. Conflicting
answer content or invalid imported evidence is refused; an older export cannot erase history. Each answer
ID belongs to one question. Imports or completions exceeding 1,000 answers for a question fail without
changing history or publishing a result receipt; saved answers are never truncated. Without an
answer backend the request stays pending for `/code-explainer feedback`. Submission deduplicates by request
ID under the job ledger lock, even with different supplied job UUIDs or after restart. Existing terminal jobs
are returned; failed/interrupted jobs use explicit retry and cancelled questions need a new request.
The viewer derives its job UUID from the request ID without browser storage. The viewer's Feedback panel
uses these routes for **Ask a question**, progress, retry/cancel and answer history. Details and selected
head/base code lines open that panel. JSON import/export preserves answers independently of outcomes.
Questions with saved answers show **Answered**, separately from the revision outcome. **Save for the next
revision pass** saves feedback without starting generation; **Ask a question** starts answering explicitly.
Reference clicks select matching source; changed or unavailable source shows the highlighted recorded
excerpt. An answer never accepts a guide change; optional revisions still require explicit review.

`service start --watch` opts this start into metadata polling and coherent full rebuilds. Unchanged polls
read no source/configuration content. Changed inputs trigger full capture, including ignored configuration
chains read by the resolver regardless of filename, local configuration declared by enabled semantic
providers, and Git staging/cleanliness changes. Capture reads that configuration without starting tools.
Python's pinned tool checks `scip-pyrightconfig.json` before `pyrightconfig.json`, nearest directory first,
then TOML if neither JSON config exists. Missing higher-priority paths are observed, including ancestor
configurations, so creating one later triggers a rebuild. Provider declarations record the tool version
and lookup source to recheck on upgrades.
It defaults to `--precise off`; `--precise auto|require` enables semantic tools, and `--scip` observes a
supplied artifact or manifest/artifact pair. `--watch` rejects an explicit `--index` and clears a saved pin.
Repeat watch options on restart. Recovery retires the previous watch pointer. Freshness checks reuse the
saved precise/artifact selection; older records without it need a watched restart. Validation after all
publication locks prevents superseded/cancelled results from publishing. Failed builds retain the last index marked out of
date; source/configuration freshness and anchor drift still block ready export. Builds report every guide;
`xpl status --all` reads the inventory without saving prose. Generated exports and excluded outputs do
not change watched Git cleanliness or generation, including from a clean tree. No generated revision is accepted and no
feedback is removed. Named `.patch.json`/`.explainer.json` files, `.explainer/` output and exported xpl HTML
are excluded from source discovery. Keep other scratch output outside the source root.

`xpl service pause` aborts and drains the watch without stopping jobs or releasing service ownership.
It retains the last checked index marked stale; even unchanged paused evidence refuses ready export.
`xpl service resume` starts a fresh input check and full rebuild. Repeated controls are safe. Stop drains
the watch, server and jobs, then returns to manual indexing/revision.

Managed viewer pages share one compact bar with connection, attention and watch-control disclosures.
Only one disclosure opens at a time; attention scrolls without shrinking the diagram or code.
An unreadable attached guide appears as an error item while verified service controls remain available. It lists
all guides, moved/drifted/missing elements and repair instructions. Moved locations keep their prose;
drift needs inspection and revision, and missing evidence must be restored or explicitly replaced/removed.
Attention refresh continues with unsaved edits without replacing them. Pause/resume and Stop service
require the inspected service instance and repository/guide attachment. Plain `xpl view`, older servers
without this report and saved HTML keep their existing layout.

**Offer revision** gives `xpl revise --root '<root>' '<guide-path>' --select '<request-id>'`.
All offered guide commands use one helper for shell-quoted absolute guide paths and `--root`, avoiding
repository JSON collisions and dependence on the calling directory. Moved evidence offers
`xpl resolve --root '<root>' '<guide-path>' --write`; drifted/missing evidence requires explicit repair. Create or select
feedback, replace the placeholder with chosen IDs, and inspect the proposal's diff and decisions before
explicit acceptance. No control submits feedback, runs an agent, accepts a proposal or erases requests.
Local configuration and supplied SCIP files are watched; external dependency or tool/environment changes
need a restart or manual indexing. See ARCHITECTURE §3 and §5 for the boundary.

## `xpl ready <explainer> [--note reason] [--require-review]`

Checks strict structure/references, workspace/index freshness, required text (visible summaries and guide
content), source availability and reader lint. Errors block ready export; warnings invite author judgment.
`--note "reason"` records an intentional omission or warning decision, without overriding errors. Pass the
same note to `bundle` to keep it in HTML. This check writes nothing and needs no service; ordinary checks
require no reviewer record.

`--json` emits `{ok, ready, scope: "workspace", identity: {explainerHash, sourceHash}, errors, warnings,
findings: [{severity, code, elementId, field, message, hint}], review: {status, required}, decisionNote?}`. Exit 0 ready (warnings allowed),
1 blockers/failure, 2 usage. Bundle failures include this report as `readiness`. The identity function lives in
core `readiness.ts`; explanation content/provenance/anchors/index metadata change `explainerHash`, while
indexed file path/hash changes or change base/head SHAs change `sourceHash`. HTML, launch mode, server URL,
source embedding and index pruning do not change identity.

Source checks verify locations and freshness, not prose claims or complete runtime coverage. Viewer Save as
HTML uses the same check, fetching current source at the final click under `xpl view`. Offline re-saves check
only embedded source; they cannot detect later repository changes. Findings and author decisions stay in the
saved snapshot's `exportInfo: {status: "ready" | "draft", report}`.

Review state is `unchecked`, `reviewed` or `out-of-date`, independently of anchor status. Ordinary readiness
has no reviewer requirement. `--require-review` explicitly requires a current author record with
`scope.content: "all"` and its chosen evidence scope; a narrow or outdated record adds `review-required`.
Use the same flag with `bundle`. Named omissions remain visible and do not override other errors.

The author records through Edit > Record author review in live or offline pages. Names are self-reported,
not authenticated. The inspected fingerprint is checked again as a user patch; LLM patches cannot record or
remove reviews. Selected IDs cover those stored records and their own anchors, not dependencies. Repository
scope and named whole files widen evidence and are included in exports. The Save as HTML team policy
checkbox is off by default and retains its explicit choice for offline re-saves.

## `xpl bundle <explainer> -o out.html [--mode explore|present] [--tour id] [--files referenced|boundary|all] [--boundary-max n] [--embed-index full|pruned] [--include-guides id,id] [--draft] [--note reason] [--require-review] [--allow-drift]`

Ready output refuses a stale index, including with `--allow-drift` or `XPL_SKIP_STALE_CHECK=1`. Reindex and resolve
first. `--allow-drift` only permits drift against a current index. Generated XPL HTML pages are excluded
from discovery so exports do not feed back into subsequent indexes.

`--include-guides id,id` includes up to eight additional locally discovered guides for offline switching.
Each is loaded from its exact catalog path, checked with the same readiness policy and keeps its own index,
source and export report. Additional unpacked guide JSON is limited to 20 MiB; exceeding the limit or
failing readiness writes no page. Use `--draft` explicitly for unfinished included guides.

The viewer's Search panel works on supplied bundle text offline. Typed source/symbol results open exact
inclusive ranges, and guide phrases open recorded tour steps. The panel lists only contained guides in
exported HTML; a live page reads `GET /api/guides` and opens other guides as read-only previews, without
changing its service attachment. Results have separate 16-row pages and counts for symbols, concepts,
steps, guides/tours and source; source matches cannot hide explanations. Preview pages offer Back to library.
To edit another live guide, stop the current repository service, then run the exact start command shown.
Missing source, pruning and unavailable analysis are distinct from no matches.

Writes one self-contained HTML file: the viewer, the explainer, the index and source files inline. Works offline and can be shared. `--tour <id>` (`tour:intro` or `intro`) starts that tour and implies `--mode present`.

Every anchor is **re-resolved** first, against the index and the code that go into the page, so an anchor whose code moved is highlighted at its new lines (`moved`), whatever the explainer file's cached `resolved` says; nothing is written back. When anchors **drifted** (their code changed) or are **missing** (their code is gone), bundle **refuses** (exit 1): the page would point at the wrong code. Run `xpl resolve <explainer> --write` and fix what it lists, then bundle again. `--draft` writes an explicit preview with its report and a persistent draft banner; the drifted code is marked on its pane. `--allow-drift` is a legacy draft flag that still refuses stale indexes.

The shared ready check runs before writing. TODO placeholders, empty required story text, broken references,
missing source and drifted anchors block ready output (exit 1, no output written). `--draft` permits these
for preview/repair and the summary says `draft preview`. Reader warnings are printed and retained; `--note`
records an author's reason about omissions or warnings without overriding blockers. Pages over 20 MB still
produce a size warning (`--files referenced` embeds fewer files).

```
$ xpl bundle jobrunner -o jobrunner.html
error: .explainer/jobrunner.explainer.json does not match the code: 3 anchors drifted (their code changed) and 2 are missing (their code is gone), so the page would point at the wrong code. To fix it, run `xpl resolve jobrunner --write` and fix what it lists: re-explain the drifted elements, re-anchor or drop the missing anchors, then bundle again; --allow-drift writes the page anyway, with a warning on it
```

`--files referenced` (the **default**) embeds the files the explainer needs: those of every anchor, of the nodes its graph views include (a directory or group: its files), of a sequence view's participants, of the sites and definitions behind its derived edges, and the code behind the dashed stubs of graph views (what the viewer shows when one is clicked; none for `"stubs": {"mode": "none"}`, and references from `excludeFiles` do not count). The viewer's file tree lists only the embedded files, with an "N of M files included" footer (under `xpl view` every indexed file is listed and fetched when opened). `--files all` embeds every indexed file. The command says what went in and what `--files all` would add; the output path is printed as given.

`--files boundary` embeds the referenced files plus a safe boundary around what the explainer anchors, so a reader of a PR or a subsystem can check the neighbours: the files of the **direct callers** of every anchored symbol (a class counts with its members), the files it **calls** (depth 1), and the **test files** that reference it (a call, an import or a type use; a test that calls it counts as a test). An anchored constructor or call method (`__init__`, `__call__`, `constructor`, ...) is reached through its class: `URL(scope)` calls `URL.__init__`, and a test that hands `TrustedHostMiddleware` to an app tests its `__call__`. At most 40 files are added (`--boundary-max n`): the ones with the most references first, callers, tests and callees in turn. The summary line says how many of each went in and names the files the cap cut. Use it for PRs: the tests of the changed code and the callers of a changed function come with the page. Only anchors with a `symbol` outside test files count, so anchor the changed symbols, not just their files.

```
$ xpl bundle metrics -o metrics.html --files boundary
wrote metrics.html (2.3 MB): .explainer/metrics.explainer.json, 4 of 12 files embedded (referenced 1, boundary +3: callers 1, callees 1, tests 1; 8.1 KB of source; --files all adds 8 files, 16.9 KB), index 7.3 KB (29.9 KB as plain JSON, pruned from 80.2 KB), mode explore
$ xpl bundle metrics -o metrics.html --files boundary --boundary-max 1
wrote metrics.html (2.2 MB): .explainer/metrics.explainer.json, 2 of 12 files embedded (referenced 1, boundary +1: callers 1, callees 0, tests 0; 2 more cut at --boundary-max 1: test/retry.test.ts, src/bus.ts; 3.7 KB of source; --files all adds 10 files, 21.3 KB), index 3.7 KB (15.3 KB as plain JSON, pruned from 80.2 KB), mode explore
```

(Here `metrics` is an explainer with one concept anchored at `src/metrics.ts#registerMetrics`: `main()` calls it, it calls `EventBus.on` in `src/bus.ts`, and the retry test calls it.)

The symbol index, most of the page for a large repository, is **pruned** with `--files referenced` (and `boundary`, for the files it embeds): every file entry stays, and so do the symbols of the embedded files and of what the explainer names or its graph views show (with their parents), and the references that touch an embedded file (`read` references: both ends), lie on a graph view or make up a derived edge the explainer names. The views, tours and code behave as with the whole index. `--files all` embeds the whole index; `--embed-index full|pruned` overrides either. The page holds the index packed (each symbol id once, every symbol and reference a short array of numbers: about a fifth of the plain JSON; the viewer unpacks it). The summary line says the size in the page, then as plain JSON and what was saved (`index 17.2 KB (72.0 KB as plain JSON, pruned from 85.8 KB)`; no `pruned from` when nothing was dropped) and the embedded index carries `pruned: {files, symbols, refs}`, the counts of the whole one. One limit: a ghost the reader expands into a file whose code is not embedded opens only into the symbols the kept references end in, and edges between two such ghosts are missing (use `--files all`, or `--embed-index full`, when the reader should explore freely).

After completing the required text in the fixture explainer:

```
$ xpl bundle complete -o complete.html
wrote complete.html (1.2 MB): .explainer/complete.explainer.json, 8 of 12 files embedded (referenced: 18.4 KB of source; --files all adds 4 files, 6.7 KB), index 20.9 KB (77.3 KB as plain JSON, pruned from 92.3 KB), mode explore
$ xpl bundle complete -o talk.html --tour tour:intro
wrote talk.html (1.2 MB): .explainer/complete.explainer.json, 8 of 12 files embedded (referenced: 18.4 KB of source; --files all adds 4 files, 6.7 KB), index 20.9 KB (77.3 KB as plain JSON, pruned from 92.3 KB), mode present, tour tour:intro
$ xpl bundle complete -o all.html --files all
wrote all.html (1.2 MB): .explainer/complete.explainer.json, 12 files embedded (all: 25.1 KB of source), index 24.7 KB (92.3 KB as plain JSON), mode explore
```

**With a change recorded** (`xpl change`), every changed file that exists after the change is embedded, whatever `--files` says, and so is the code before the change of every modified, renamed or deleted file (`baseFiles` in the page, read from git). The summary line adds `change 5774f2c..349730f: 1 changed file in, code before the change of 1 file (3.2 KB)`, and names the changed files the selection had left out (`(2 added to the selection: ...)`).

`--json`: `{ok, readiness, exportStatus: "ready"|"draft", path, absolutePath, bytes, mode, tour?, anchors: {total, drifted, missing}, files: {embedded, choice, referenced?, boundary?: {added: [{file, reason: caller|callee|test, refs}], cut: [same], max, symbols}, embeddedBytes, indexed, indexedBytes}, change?: {base, head, changedFiles, addedToSelection: [paths], baseFiles: [paths], baseBytes, baseMissing?}, index: {path, commit, choice: "full"|"pruned", pruned, bytes, fullBytes, packedBytes, symbols: {embedded, indexed}, refs: {embedded, indexed}}}` (`index.bytes` and `fullBytes`: the embedded and the whole index as compact JSON; `packedBytes`: the embedded one as the page holds it).

## `--json` shapes (the ones worth scripting)

- `index`: `{ok, path, commit, files, symbols, refs, languages: {<lang>: {files, symbols, refs: "precise"|"heuristic"|"none", tool?, heuristicFiles?}}}` (`heuristicFiles`: files of a precise language whose references stayed heuristic)
- `apply`: `{ok, applied, dryRun, actor, path, changed: [ids], issues: [{severity, path, elementId?, message, code}], protectedIds?: [ids], error?}`; issue `code`s: `schema duplicate-id bad-id unknown-id anchor-invalid anchor-drifted anchor-missing evidence frame cycle step commit change protected` (`change`: the change record is malformed, or its head is not the index commit). A tour step changed by `stepsUpdate` is listed as `<tour id>/<step id>`. `ok: false` with `applied: false` also when everything the patch touched is protected.
- `validate`: `{ok, mode, index, errors, warnings, issues[]}`
- `lint`: see its section
- `change`: see its section
- `status`: `{ok, todo: {unexplained, drifted, driftedUserOwned, missing, requests, broken}, views: [{id, type, nodes: {total, unexplained[]}, edges: {total, unexplained: [{id, stored}]}, ghosts?: {mode, max, total, stubs, crowded, list: [{id, kind, label, count, direction, targets: [{id, count}]}], stubIds[]}, steps: {total, unexplained[]}}], concepts: {unexplained[]}, tours: [{id, title, steps, unresolved: [{step, focus[], missingView?}]}], anchors: {total, counts}, drifted[], driftedOther[], missing[], broken: [issues], staleOverlays: [ids], requests[]}` (`ghosts` on graph views only) (`todo.drifted` counts every drifted element, `driftedUserOwned` those of it the user owns)
- `anchors`: see its section
- `new`: `{ok, path, name, title, repo: {name, source, url?}, index: {path, commit}}`
- `outline`: `{ok, index, commit, depth, tree: {id, type, label, kind, range?, fanIn, fanOut, more?, children[]}}`
