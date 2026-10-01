# CLI reference

`<skill dir>/bin/xpl <command> [options]` (below: `xpl`). Run it from the root of the repo you are explaining, or pass `--root <dir>`. Samples come from `fixtures/ts-jobrunner` (a tiny job runner, indexed as `wt-6dd745d736`) and are trimmed, not edited.

**Global options** (every command)

| Option           | Meaning                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------- |
| `--root <dir>`   | repository root (default: current directory)                                             |
| `--json`         | machine-readable output (`{"ok": true, ...}`; errors as `{"ok": false, "error": "..."}`) |
| `--index <path>` | symbol index to use (default: the index of the current commit id, else the newest one)   |
| `-h`, `--help`   | help for the command; `xpl help` lists all                                               |

**Exit codes:** 0 ok · 1 rejected or failed (bad id, rejected patch, a patch that changed nothing because the user owns everything it touches, `resolve --write` on a stale index, validation errors) · 2 usage error.
**Streams:** results, issue lists and rejections print on stdout (a rejection also exits 1); fatal errors (`error: ...`: unknown id, no index, bad JSON, unreadable file) and `warning:` lines go to stderr, so use `2>&1` to capture both. With `--json` there is one object on stdout, errors included (`{"ok": false, "error": ...}`).
**Environment:** `XPL_CLI` (launcher: path of an `xpl.mjs` to run instead of the repo's build), `XPL_VIEWER_HTML` (viewer page for `view`/`bundle`), `XPL_SKIP_STALE_CHECK=1` (skip the index-vs-working-tree comparison), `XPL_SCIP_TIMEOUT_MS` (time limit of each SCIP indexer, default 10 minutes), `XPL_WASM_DIR` (where the tree-sitter `.wasm` files are), `XPL_DEBUG=1` (stack traces).

**Ids** are accepted loosely: `sym:src/a.ts#A.b`, `src/a.ts#A.b`, `file:src/a.ts`, `src/a.ts`, `dir:src`. The outputs always print the exact `sym:`/`file:`/`dir:` form: paste those into patches.

**Staleness.** When the working tree changed since the index was built, commands print ``warning: index … does not match the working tree (wt-…): 2 changed (src/queue.ts, src/runner.ts). Line numbers and offsets may be off; run `xpl index`…``. Re-index before anchoring anything.

---

## `xpl index [--precise auto|off|require] [--commit c]`

Builds `.explainer/index-<commit>.json` (and `.explainer/.gitignore` with `index-*.json`). The commit id is the short HEAD when the repo root is a clean git top-level, else `wt-<hash>` of the files. Files: `git ls-files` (or a walk that skips `node_modules`, `dist`, dot-dirs…), text only, ≤ 1 MB.

```
$ xpl index
index written: .explainer/index-wt-6dd745d736.json
commit: wt-6dd745d736  files: 12  symbols: 157  refs: 301

json        2 files    23 symbols    refs: none
text        1 file     0 symbols     refs: none
typescript  8 files    118 symbols   refs: precise (scip-typescript@0.4.0)
yaml        1 file     16 symbols    refs: none
```

- The last column is how far a language's references can be trusted. `refs: precise (tool)`: SCIP resolved them (TypeScript, Python, Go). `refs: heuristic`: tree-sitter scope-aware guesses, drawn lighter in the viewer; confirm calls with `show`. `refs: none`: yaml, json, toml, text.
- `refs: precise 10/11 (scip-go@0.2.7), 1 heuristic`: the tool described only 10 of the 11 files (build-tagged Go files, files a project's own configuration excludes). Those files keep heuristic references, so **their references are hints**; a warning above the summary names them: `warning: scip-go@0.2.7 did not describe 1 file(s) (excluded by build constraints or by the tool's own configuration, or unreadable?); their references stay heuristic: internal/queue/windows_only.go`.
- `--precise auto` (default) falls back to heuristic with a warning, e.g. ``warning: precise resolver "scip-go" failed (scip-go@v0.2.7 could not be started (is `go` installed and on PATH?): spawn go ENOENT); using heuristic references for go``. `off` never runs SCIP (faster). `require` exits 1 instead of falling back.
- A file with syntax errors is indexed anyway. One warning covers all such files, with the first lines to look at: `warning: 1 file(s) have syntax errors; symbols near these lines may be incomplete: src/broken.ts:2` (at most 5 files and 3 lines each). Errors that cannot have cost a symbol (a TS labelled tuple element such as `[symbol: string]`) are not reported.
- Reference kinds: `call import extends implements type-ref read write`. A `read` is a use of a module- or package-level variable or constant, or of a field whose type is known, that is not a call or an assignment (`this.config.retry`, `LIMIT`); locals and parameters are not references. A TS `import type` and a Python `import` under `TYPE_CHECKING` are `type-ref`, not `import`: `import` references are runtime dependencies.
- Symbols beyond declarations: config keys (`kind: key`) of yaml, json and toml files (`config/default.yaml#retry.maxRetries`, `pyproject.toml#project.scripts.flask`); TS test blocks (statement-level `describe`/`suite`/`context`/`it`/`test` calls with a string title), whose path is the nested titles (`test/retry.test.ts#fails twice, then succeeds: acked after two requeues`; `.` and `#` in a title become `_`). Test blocks can be anchored and outlined but nothing references them by name.
- Re-run after every code change. Explainers bound to an older index print ``hint: 1 explainer (jobrunner) is bound to another index; run `xpl resolve <name> --write` to move it to this one.``

## `xpl outline [--under <id>] [--depth n] [--kind k,...] [--keys] [--limit n]`

One line per element: `<id>  <kind>  <first>-<last line>  in=<fan-in> out=<fan-out>`. `in`/`out` count references into/out of the element's subtree (calls, imports, type uses, reads), so high numbers mark hubs. `[+n]` = n children below the depth limit. Default depth 2, `--limit 400` lines. Config keys (yaml, json, toml) are hidden unless `--keys`. `--kind method,function` lists only symbols of those kinds (`class interface function method type variable enum key other`; repeat or comma-separate) together with the dirs, files and parent symbols that hold a match, so each keeps its place. The `repo` line carries the name `xpl new` records (from `package.json`, `go.mod`, `pyproject.toml`, the git remote), not the directory's.

```
$ xpl outline --depth 1
repo  ts-jobrunner  12 files, 157 symbols
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

## `xpl show <id> [--refs] [--context n] [--lines a-b] [--max-lines n]`

Code with **0-based offsets from the symbol's first line**: the numbers `span` uses (for a file, offset = line − 1). Header: `<id> (<kind>) <file>:<first>-<last> <hash>`. Directories and the repo list their children. `--context n` adds n lines around a symbol (marked `┆`, no offsets). `--lines a-b` selects absolute file lines within the element. Output is cut after 400 lines (`--max-lines 0` = all).

`--refs` appends references grouped by kind (calls first, then type uses, reads, writes), each `<kind>  <other id>  (<file>:<line>, <precise|heuristic>)  +<offset>`, where `+offset` counts from the start of the **referencing** symbol: it is the call-site anchor's span. The `read` lines are many; `refs --kind call` (below) is the shorter list for tracing a flow.

```
$ xpl show src/runner.ts#Runner.dispatch --refs
sym:src/runner.ts#Runner.dispatch (method) src/runner.ts:42-88 sha256-v2:c02146e8d847
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

Python base classes and TS abstract classes are `extends` relations, not `implements`: no hop. `--json`: `{ok, id, depth, kinds, out|in: [entry...], totals, moreChildren, truncated, hiddenTestImplementations}`; an entry is `{kind, id, from, to, file, site, offset, resolution, note?, moreChildren?, children?}` (`note`: `seen` for `(expanded above)`, `cycle`); `impl` entries have `kind: "impl"`, `from` = the implementing symbol, `to` = the implemented one, `id`/`file`/`site` = the symbol the line shows; `hiddenTestImplementations` counts the test doubles left out, `moreChildren` the references a `--max-children` cap left out (top level: under the subject).

## `xpl search <pattern> [--regex] [-i] [--limit n] [--under <dir|glob>] [--code]`

Line-by-line search of the working-tree text of every indexed file (substring, case-sensitive; `--regex` = JavaScript regex; `-i` ignores case). Hit: `<file>:<line>  <enclosing symbol id> +<offset>  <line text>`; outside every symbol it names the file (offset = line − 1). Code files come first, then config (yaml, json, toml), then docs and other text, so the first hits (`--limit`, default 50) are the code; the total is always counted. `--code` drops everything that is not code. `--under` keeps the search inside a directory, file or symbol (`dir:src/flask`, `src/flask/`, `file:src/app.py`, `sym:src/app.py#Flask`) or a glob on repo paths (`'tests/**'`, `'src/*.py'`); repeat it or comma-separate for several. The total is counted inside the scope.

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

## `xpl new <name> [--title t] [--repo r] [--url u]`

Creates an empty `.explainer/<name>.explainer.json` bound to the selected index. Refuses to overwrite (`error: … already exists; not overwriting it`). The repository name it records (`repo.name`, the label of the repo box) is `--repo`, else the first of: `package.json` `name`, the last element of the `go.mod` module (`example.com/acme/jobrunner/v2` gives `jobrunner`), `[project] name` in `pyproject.toml`, the base name of the git remote (`origin`, else the first), the directory name. `--url` records where the repository lives; it is never taken from the git remote (which may carry credentials).

```
$ xpl new jobrunner --title "Job runner"
created .explainer/jobrunner.explainer.json (title "Job runner", index .explainer/index-wt-6dd745d736.json, commit wt-6dd745d736)
repo: ts-jobrunner (package.json)
next: write a patch and run `xpl apply jobrunner patch.json`
```

`--json` adds `repo: {name, source, url?}`.

## `xpl apply <explainer> <patch.json|-> [--actor llm|user] [--dry-run]`

Validates and applies a patch (format: `patch-format.md`; `xpl apply --help` prints a summary of it). Atomic: nothing is written on any error. `-` reads stdin. `--dry-run` checks and lists what would change. Default actor `llm`: never modifies `origin: "user"` elements or `userFields`, and never removes an element that carries `userFields` (skipped with a `protected` warning). Exit 1 = rejected.

**A rejection lists every error of the patch at once**: anchors, ids and references are checked in one pass (an element whose anchor failed is still checked for its other problems; checks that depend on the failed anchor, like the evidence an `llm` edge needs at both ends, wait until it is fixed), so fix them all before applying again. Warnings that matter now are listed with them: a span that starts or ends on a blank line is most likely off by one (the message gives the offset where the code starts or ends), an id that names nothing carries `Did you mean: ...`. Results and rejections print on stdout; fatal errors (`error: patch … is not valid JSON`, unknown explainer, unreadable patch file) go to stderr.

`changed:` lists every id the patch added, changed or removed. A `stepsUpdate` names the view and each step it updated; an upsert that changes nothing is not listed (`no changes: the patch matches …`).

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

Strict by default: ids, references, anchors (must resolve `ok` or `moved`), the evidence rule for `llm` edges. `--lenient` turns drifted/missing anchors and vanished ids into warnings (for inspecting after `resolve --write`). Exit 1 on errors.

```
$ xpl validate jobrunner
ok: .explainer/jobrunner.explainer.json is valid (strict, index wt-6dd745d736); no errors, no warnings
$ xpl validate jobrunner            # after the code changed and `resolve --write`
.explainer/jobrunner.explainer.json (strict, index wt-3fa2f32c4b): 5 errors, 0 warnings
error   concepts[1].anchors[0] [concept:mine]: anchor src/queue.ts#Queue.requeue drifted: text of src/queue.ts#Queue.requeue changed (expected sha256-v2:9abf2fb62272, now sha256-v2:ba9e3c066ce0). This element is user-authored, so an llm patch cannot change it (it is skipped): tell the user, or fix it with `xpl apply --actor user`.
error   views[1].steps[0].anchors[1] [dispatch:1]: anchor src/queue.ts#Queue.pop is missing: symbol Queue.pop is not in src/queue.ts; did you mean sym:src/queue.ts#Queue.take (anchor: file: "src/queue.ts", symbol: "Queue.take")? Re-anchor it to where the code went, or drop it (resend the element without this anchor, or remove the element).
error   views[1].steps[3].anchors[1] [dispatch:4]: anchor src/queue.ts#Queue.requeue drifted: text of src/queue.ts#Queue.requeue changed (expected sha256-v2:9abf2fb62272, now sha256-v2:ba9e3c066ce0). Re-read the code and rewrite the anchor (and the explanation that depends on it).
...
```

## `xpl anchors <explainer> [id...] [--full] [--max-lines n]`

Shows what an explainer's anchors point at, so you can verify spans without reading the JSON. For every element with stored anchors (node overlays, edges, concepts, sequence steps, the `code` overrides of tour steps) it prints each anchor: role, `file#symbol`, span, status (`ok`, `moved`, `drifted`, `missing`), the resolved lines, then the code at those lines as `<line> <offset>│ code`. The offsets are the ones `xpl show` prints and a `span` uses, so a wrong span is visible at once. Status and lines are resolved now, against the index the explainer is bound to and the working tree; when the explainer file's cached lines differ, a note says so (`run xpl resolve <name> --write`).

A long anchor is cut to 12 lines (`--max-lines n`; `--full` or `--max-lines 0` prints all): its first lines, a `... N lines elided (a-b)` line with the `xpl show … --lines a-b` that reads them, and its **last** lines, because the end of a span is where an off-by-one hides.

Ids: element ids as they are (`concept:retry-policy`, `dispatch:3`, `edge:job-completed`, `sym:src/runner.ts#Runner.dispatch`, `tour:intro/t2` for one tour step), a view (`view:dispatch`: its steps), a tour (`tour:intro`: every step), or the loose forms the other commands take (`src/runner.ts#Runner.dispatch`). No ids: every element with anchors. An element that exists but has no stored anchors is listed as such (the viewer falls back to its symbol, file or members); an unknown id fails with suggestions.

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
      text of src/queue.ts#Queue.requeue changed (expected sha256-v2:9abf2fb62272, now sha256-v2:ba9e3c066ce0)
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

## `xpl status <explainer>`

The skill's to-do list, read-only: per view, the shown nodes, participants, stored edges and steps without a `summary` (and the ids of the static edges without one, which you need to overlay them); per graph view, where it stops (its ghosts and stubs); concepts without a summary; the tours; drifted llm elements; missing anchors; **broken references**; stale edge overlays; requests queued by the viewer. Static edges are optional. `status` reads the explainer through the index it is bound to: after `xpl index`, run `xpl resolve <name> --write` first so that it sees the new code.

- The `to do:` line counts drift the user owns apart: `4 drifted (1 user-owned: ask the user)`. User-owned = an element that is not llm-authored, or an llm element whose anchors (or, for a step, whose view's `steps`) the user edited: an llm patch cannot repair those.
- `ghosts: 2 (7 stubs; stubs: top 6), most referenced: ghost:file:src/main.ts ×23, ...`: the graph view draws 2 ghost boxes, with 7 stubs (dashed edges) leading to them; `stubs: top 6` is the view's stub policy (the default is `top 8`); `×23` is how many references lead to that ghost. A folded ghost stands for several elements and is named by what it folds: `ghost:more:out ×8` ("+8 more", the ghosts beyond the cap), `ghost:rest:file:src/main.ts ×1` ("rest of main.ts", the outside symbols of a file the view shows in part). Folded ghosts are not elements (they cannot be `include`d), but their ids and the stub ids go in `hidden`. Each folded ghost also gets a line under `ghosts:` with the elements it stands for (`ghost:rest:file:src/runner.ts ×6 → sym:src/runner.ts#Runner.log ×3, ...`): up to 3 ids with their reference counts, most referenced first, then `... +N more`. `includeAdd` one of them; a ghost that is one element (`ghost:file:x`) gets no such line. `--json` lists every ghost (`views[].ghosts.list[]`: `{id, kind: target|rest|more, label, count, direction, targets: [{id, count}]}`, most referenced first) with all the elements it stands for in `targets` (most referenced first; a `target` ghost has just itself), and every stub id (`views[].ghosts.stubIds`), with `mode`, `max`, `total`, `stubs` and `crowded`. Above 12 ghosts a warning follows the line.
- `tours (n)`: each tour with its step count, and the steps whose `focus` ids or `view` no longer exist (`1 step points at something that is gone: t2 (focus: sym:src/queue.ts#Queue.pop)`); a tour has no `stepsUpdate`: resend its `steps` with the ids fixed, unless the user edited the tour (then make a new one).
- `broken references (n)`: ids that no longer exist in the index (lenient validation): the overlay of a deleted symbol, an `include`, `members`, `related` or `participants` entry, a step end, a tour's `focus`. The line `, n broken references` is appended to `to do:` only when there are some.
- `warning: stale edge overlays (n)`: stored `edge:<kind>:<a>-><b>` overlays that no graph view derives any more (the ends of a derived id follow the view's `include`, or the code changed). They are ignored until re-created on a current id; hidden edges do not count.

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

requests queued by the viewer (2; delete .explainer/requests.json when handled):
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

`.explainer/requests.json` is a JSON array of `{elementId, note?, kind?, view?, label?, at, explainer?}`; the element may be a node, edge, concept, step or ghost id. Delete the file after handling.

## `xpl view <explainer> [--port p] [--host h] [--no-open]`

Serves the viewer with live repo access at `http://127.0.0.1:<port>/` (default 4747, else a free port; `--port 0` = any) and tries to open a browser. The explainer is re-read from disk on every request: after `xpl apply`, reload the page. Edits in the viewer (layout, expanded nodes, the stubs control, tour steps) are saved as `user` edits; "Explain this" clicks are appended to `.explainer/requests.json`. Runs until Ctrl-C. It binds to 127.0.0.1; `--host` other than that exposes the source code.

```
$ xpl view jobrunner --no-open --port 0
serving .explainer/jobrunner.explainer.json at http://127.0.0.1:34971/  (Ctrl-C to stop)
```

API (for scripts): `GET /api/bundle`, `GET /api/file?path=`, `PUT /api/views/<id>`, `PUT /api/tours/<id>`, `GET|POST /api/requests`.

## `xpl bundle <explainer> -o out.html [--mode explore|present] [--tour id] [--files referenced|all] [--embed-index full|pruned]`

Writes one self-contained HTML file: the viewer, the explainer, the index and source files inline. Works offline and can be shared. `--tour <id>` (`tour:intro` or `intro`) starts that tour and implies `--mode present`.

`--files referenced` (the **default**) embeds the files the explainer needs: those of every anchor, of the nodes its graph views include (a directory or group: its files), of a sequence view's participants, of the sites and definitions behind its derived edges, and the code behind the dashed stubs of graph views (what the viewer shows when one is clicked; none for `"stubs": {"mode": "none"}`, and references from `excludeFiles` do not count). The viewer's file tree lists only the embedded files, with an "N of M files included" footer (under `xpl view` every indexed file is listed and fetched when opened). `--files all` embeds every indexed file. The command says what went in and what `--files all` would add; the output path is printed as given.

The symbol index, most of the page for a large repository, is **pruned** with `--files referenced`: every file entry stays, and so do the symbols of the embedded files and of what the explainer names or its graph views show (with their parents), and the references that touch an embedded file (`read` references: both ends), lie on a graph view or make up a derived edge the explainer names. The views, tours and code behave as with the whole index. `--files all` embeds the whole index; `--embed-index full|pruned` overrides either. The summary line says what was saved (`index 71.1 KB (pruned from 82.2 KB)`; just `index 82.2 KB` when nothing was dropped) and the embedded index carries `pruned: {files, symbols, refs}`, the counts of the whole one. One limit: a ghost the reader expands into a file whose code is not embedded opens only into the symbols the kept references end in, and edges between two such ghosts are missing (use `--files all`, or `--embed-index full`, when the reader should explore freely).

```
$ xpl bundle jobrunner -o jobrunner.html
wrote jobrunner.html (2.3 MB): .explainer/jobrunner.explainer.json, 8 of 12 files embedded (referenced: 18.4 KB of source; --files all adds 4 files, 6.7 KB), index 71.1 KB (pruned from 82.2 KB), mode explore
$ xpl bundle jobrunner -o talk.html --tour tour:intro
wrote talk.html (2.3 MB): .explainer/jobrunner.explainer.json, 8 of 12 files embedded (referenced: 18.4 KB of source; --files all adds 4 files, 6.7 KB), index 71.1 KB (pruned from 82.2 KB), mode present, tour tour:intro
$ xpl bundle jobrunner -o all.html --files all
wrote all.html (2.3 MB): .explainer/jobrunner.explainer.json, 12 files embedded (all: 25.1 KB of source), index 82.2 KB, mode explore
```

`--json`: `{ok, path, absolutePath, bytes, mode, tour?, files: {embedded, choice, embeddedBytes, indexed, indexedBytes}, index: {path, commit, choice: "full"|"pruned", pruned, bytes, fullBytes, symbols: {embedded, indexed}, refs: {embedded, indexed}}}` (`index.bytes` and `fullBytes`: the embedded and the whole index as compact JSON).

## `--json` shapes (the ones worth scripting)

- `index`: `{ok, path, commit, files, symbols, refs, languages: {<lang>: {files, symbols, refs: "precise"|"heuristic"|"none", tool?, heuristicFiles?}}}` (`heuristicFiles`: files of a precise language whose references stayed heuristic)
- `apply`: `{ok, applied, dryRun, actor, path, changed: [ids], issues: [{severity, path, elementId?, message, code}], protectedIds?: [ids], error?}`; issue `code`s: `schema duplicate-id bad-id unknown-id anchor-invalid anchor-drifted anchor-missing evidence frame cycle step commit protected`. `ok: false` with `applied: false` also when everything the patch touched is protected.
- `validate`: `{ok, mode, index, errors, warnings, issues[]}`
- `status`: `{ok, todo: {unexplained, drifted, driftedUserOwned, missing, requests, broken}, views: [{id, type, nodes: {total, unexplained[]}, edges: {total, unexplained: [{id, stored}]}, ghosts?: {mode, max, total, stubs, crowded, list: [{id, kind, label, count, direction, targets: [{id, count}]}], stubIds[]}, steps: {total, unexplained[]}}], concepts: {unexplained[]}, tours: [{id, title, steps, unresolved: [{step, focus[], missingView?}]}], anchors: {total, counts}, drifted[], driftedOther[], missing[], broken: [issues], staleOverlays: [ids], requests[]}` (`ghosts` on graph views only) (`todo.drifted` counts every drifted element, `driftedUserOwned` those of it the user owns)
- `anchors`: see its section
- `new`: `{ok, path, name, title, repo: {name, source, url?}, index: {path, commit}}`
- `outline`: `{ok, index, commit, depth, tree: {id, type, label, kind, range?, fanIn, fanOut, more?, children[]}}`
