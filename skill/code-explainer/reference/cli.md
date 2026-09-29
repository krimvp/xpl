# CLI reference

`<skill dir>/bin/xpl <command> [options]` (below: `xpl`). Run it from the root of the repo you are explaining, or pass `--root <dir>`. Samples come from `fixtures/ts-jobrunner` (a tiny job runner) and are trimmed, not edited.

**Global options** (every command)

| Option           | Meaning                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------- |
| `--root <dir>`   | repository root (default: current directory)                                             |
| `--json`         | machine-readable output (`{"ok": true, ...}`; errors as `{"ok": false, "error": "..."}`) |
| `--index <path>` | symbol index to use (default: the index of the current commit id, else the newest one)   |
| `-h`, `--help`   | help for the command; `xpl help` lists all                                               |

**Exit codes:** 0 ok · 1 rejected or failed (bad id, rejected patch, validation errors) · 2 usage error.
**Environment:** `XPL_CLI` (launcher: path of an `xpl.mjs` to run instead of the repo's build), `XPL_VIEWER_HTML` (viewer page for `view`/`bundle`), `XPL_SKIP_STALE_CHECK=1` (skip the index-vs-working-tree comparison), `XPL_DEBUG=1` (stack traces).

**Ids** are accepted loosely: `sym:src/a.ts#A.b`, `src/a.ts#A.b`, `file:src/a.ts`, `src/a.ts`, `dir:src`. The outputs always print the exact `sym:`/`file:`/`dir:` form: paste those into patches.

**Staleness.** When the working tree changed since the index was built, commands print ``warning: index … does not match the working tree (wt-…): 2 changed (src/queue.ts, src/runner.ts). Line numbers and offsets may be off; run `xpl index`…``. Re-index before anchoring anything.

---

## `xpl index [--precise auto|off|require] [--commit c]`

Builds `.explainer/index-<commit>.json` (and `.explainer/.gitignore` with `index-*.json`). The commit id is the short HEAD when the repo root is a clean git top-level, else `wt-<hash>` of the files. Files: `git ls-files` (or a walk that skips `node_modules`, `dist`, dot-dirs…), text only, ≤ 1 MB.

```
$ xpl index
index written: .explainer/index-97f70e7.json
commit: 97f70e7  files: 12  symbols: 153  refs: 178

json        2 files    23 symbols    refs: none
text        1 file     0 symbols     refs: none
typescript  8 files    114 symbols   refs: precise (scip-typescript@0.4.0)
yaml        1 file     16 symbols    refs: none
```

- `refs: precise (tool)`: SCIP resolved references (TypeScript, Python, Go). `heuristic`: tree-sitter scope-aware guesses, drawn lighter in the viewer; confirm calls with `show`. `none`: yaml/json/text.
- `--precise auto` (default) falls back to heuristic with a warning, e.g. ``warning: precise resolver "scip-go" failed (scip-go@v0.2.7 could not be started (is `go` installed and on PATH?): spawn go ENOENT); using heuristic references for go``. `off` never runs SCIP (faster). `require` exits 1 instead of falling back.
- Re-run after every code change. Explainers bound to an older index print ``hint: 1 explainer (jobrunner) is bound to another index; run `xpl resolve <name> --write` to move it to this one.``

## `xpl outline [--under <id>] [--depth n] [--keys] [--limit n]`

One line per element: `<id>  <kind>  <first>-<last line>  in=<fan-in> out=<fan-out>`. `in`/`out` count references into/out of the element's subtree (calls, imports, type uses), so high numbers mark hubs. `[+n]` = n children below the depth limit. Default depth 2, `--limit 400` lines. Config keys (yaml/json) are hidden unless `--keys`.

```
$ xpl outline --depth 1
repo  ts  12 files, 153 symbols
  dir:config  dir  1 file  in=0 out=0  [+1]
  dir:src  dir  7 files  in=30 out=0  [+7]
  dir:test  dir  1 file  in=0 out=30  [+1]
  file:README.md  text  1-46  in=0 out=0
  file:package.json  json  1-16  in=0 out=0  [11 keys hidden]

$ xpl outline --under file:src/runner.ts --depth 2
file:src/runner.ts  typescript  1-111  in=10 out=22
  sym:src/runner.ts#Runner  class  12-93  in=8 out=21
    sym:src/runner.ts#Runner.dispatch  method  42-88  in=1 out=14
  sym:src/runner.ts#backoffDelay  function  108-110  in=3 out=1

$ xpl outline --under file:config/default.yaml --keys
  sym:config/default.yaml#retry  key  13-16  in=0 out=0
    sym:config/default.yaml#retry.maxRetries  key  14-14  in=0 out=0
```

## `xpl show <id> [--refs] [--context n] [--lines a-b] [--max-lines n]`

Code with **0-based offsets from the symbol's first line**: the numbers `span` uses (for a file, offset = line − 1). Header: `<id> (<kind>) <file>:<first>-<last> <hash>`. Directories and the repo list their children. `--context n` adds n lines around a symbol (marked `┆`, no offsets). `--lines a-b` selects absolute file lines within the element. Output is cut after 400 lines (`--max-lines 0` = all).

`--refs` appends references grouped by kind, each `<kind>  <other id>  (<file>:<line>, <precise|heuristic>)  +<offset>`, where `+offset` counts from the start of the **referencing** symbol: it is the call-site anchor's span.

```
$ xpl show src/runner.ts#Runner.dispatch --refs
sym:src/runner.ts#Runner.dispatch (method) src/runner.ts:42-88 sha256:c02146e8d847
42  0│   async dispatch(): Promise<void> {
43  1│     while (this.running) {
...
76 34│         await this.queue.requeue(
77 35│           job,
78 36│           backoff);
...
outgoing refs: 14 (call 12, type-ref 1, write 1)
  call  sym:src/queue.ts#Queue.pop  (src/runner.ts:46, precise)  +4
  call  sym:src/worker.ts#Worker.run  (src/runner.ts:60-61, precise)  +18..19
  call  sym:src/queue.ts#Queue.requeue  (src/runner.ts:76-78, precise)  +34..36
  ...
incoming refs: 1 (call 1)
  call  sym:src/runner.ts#Runner.start  (src/runner.ts:32, precise)  +2
```

A config key shows like any symbol: `xpl show config/default.yaml#retry` prints `13 0│ retry:` … `16 3│   maxDelayMs: 30000`.

## `xpl refs <id> [--in|--out] [--kind k] [--depth n] [--limit n]`

The reference list of `show --refs`, as a hierarchy. `--out` (default): what the element uses; `--in`: who uses it. `--kind` (repeatable or comma-separated): `call import extends implements type-ref read write`. `--depth n` expands each other end in turn (a call hierarchy; repeats are marked `(expanded above)`). For a file/dir the references that stay inside are left out, and each line names the referencing symbol (`+82 in sym:…`). Heuristic references are hints.

```
$ xpl refs src/runner.ts#Runner.dispatch --out --depth 3 --kind call
sym:src/runner.ts#Runner.dispatch (method) src/runner.ts:42-88
out (12):
  call  sym:src/queue.ts#Queue.pop  (src/runner.ts:46, precise)  +4
  call  sym:src/worker.ts#Worker.run  (src/runner.ts:60-61, precise)  +18..19
    call  sym:src/worker.ts#withTimeout  (src/worker.ts:41, precise)  +11
    call  sym:src/bus.ts#EventBus.emit  (src/worker.ts:51, precise)  +21
  ...
$ xpl refs src/queue.ts#Queue.requeue --in
in (2):
  call  sym:src/runner.ts#Runner.dispatch  (src/runner.ts:76-78, precise)  +34..36
  call  sym:test/retry.test.ts#RecordingQueue.requeue  (test/retry.test.ts:21, precise)  +2
```

Note `EventBus.emit` appears as a call, but nothing links `emit` to the handler registered with `bus.on(...)` in another file: that is what `llm` edges are for.

## `xpl search <pattern> [--regex] [-i] [--limit n]`

Line-by-line search of the working-tree text of every indexed file (substring, case-sensitive; `--regex` = JavaScript regex; `-i` ignores case). Hit: `<file>:<line>  <enclosing symbol id> +<offset>  <line text>`; outside every symbol it names the file (offset = line − 1). Default 50 hits; the total is always counted.

```
$ xpl search "job.completed"
src/metrics.ts:23  sym:src/metrics.ts#registerMetrics +1  bus.on<JobCompleted>("job.completed", (event) => onJobCompleted(metrics, event));
src/worker.ts:51  sym:src/worker.ts#Worker.run +21  this.bus.emit("job.completed", { jobId: job.id, ... });
$ xpl search retry -i --limit 3
README.md:3  file:README.md +2  A tiny job runner: ... retry with exponential backoff,
... 26 more matches (showing 3 of 29 in 8 files); raise --limit or narrow the pattern
```

## `xpl new <name> [--title t]`

Creates an empty `.explainer/<name>.explainer.json` bound to the selected index. Refuses to overwrite (`error: … already exists; not overwriting it`).

```
$ xpl new jobrunner --title "Job runner"
created .explainer/jobrunner.explainer.json (title "Job runner", index .explainer/index-97f70e7.json, commit 97f70e7)
```

## `xpl apply <explainer> <patch.json|-> [--actor llm|user] [--dry-run]`

Validates and applies a patch (format: `patch-format.md`). Atomic: nothing is written on any error. `-` reads stdin. `--dry-run` checks and lists what would change. Default actor `llm`: never modifies `origin: "user"` elements or `userFields` (skipped with a warning). Exit 1 = rejected.

```
$ xpl apply jobrunner patch.json
applied to .explainer/jobrunner.explainer.json (actor llm): 7 ids changed
changed:
  grp:scheduling
  ...
$ xpl apply jobrunner bad.json
rejected: 1 error, nothing was applied to .explainer/jobrunner.explainer.json (patch from bad.json)
error   concepts[0].anchors[0] [concept:x]: symbol "Runner.dispach" not found in src/runner.ts. Did you mean: src/runner.ts#Runner.dispatch?
```

An anchor's `symbol` wants only the part after `#` (`Runner.dispatch`) even though the suggestion prints the whole id.

## `xpl validate <explainer> [--lenient]`

Strict by default: ids, references, anchors (must resolve `ok` or `moved`), the evidence rule for `llm` edges. `--lenient` turns drifted/missing anchors and vanished ids into warnings (for inspecting after `resolve --write`). Exit 1 on errors.

```
$ xpl validate jobrunner
ok: .explainer/jobrunner.explainer.json is valid (strict, index 97f70e7); no errors, no warnings
$ xpl validate jobrunner            # after the code changed and `resolve --write`
.explainer/jobrunner.explainer.json (strict, index wt-f7e1e886ad): 3 errors, 0 warnings
error   concepts[0].anchors[0] [concept:retry-policy]: anchor src/runner.ts#Runner.dispatch +30..41 drifted: text of … changed and was not found elsewhere in … (expected sha256:adc8374edfff, now sha256:6e03d8d2a4ed). Re-read the code and rewrite the anchor (and the explanation that depends on it).
error   views[1].steps[2].anchors[1] [dispatch:3]: anchor src/queue.ts#Queue.requeue is missing: symbol Queue.requeue is not in src/queue.ts; did you mean test/retry.test.ts#RecordingQueue.requeue?
```

## `xpl resolve <explainer> [--write]`

Re-resolves every anchor (elements, steps, tour code overrides) against the index of the current code (`--index`, else the current commit id, else the newest), ignoring the explainer's own old index. `moved` = same text, new lines (span updated); `drifted` = text changed; `missing` = symbol gone. Prints the counts, the **drifted llm elements** (re-explain those, except `userFields`) and the **missing anchors** (ask the user). `--write` saves the new ranges and the index binding; drifted anchors stay drifted until their element is resent.

```
$ xpl resolve jobrunner --write
resolved .explainer/jobrunner.explainer.json against index wt-f7e1e886ad (.explainer/index-wt-f7e1e886ad.json)
anchors: 12 (ok 6, moved 3, drifted 2, missing 1)
drifted llm elements to re-explain (2):
  sym:src/runner.ts#Runner.dispatch  (node)
    nodes[1].anchors[0]  src/runner.ts#Runner.dispatch [definition]  now at lines 43-89
      text of src/runner.ts#Runner.dispatch changed (expected sha256:c02146e8d847, now sha256:5ec5cf814d55)
  concept:retry-policy  (concept)
    ...
missing anchors (1): fix or drop them explicitly
  dispatch:3  views[1].steps[2].anchors[1]  src/queue.ts#Queue.requeue [definition]
    symbol Queue.requeue is not in src/queue.ts; did you mean test/retry.test.ts#RecordingQueue.requeue?
written: .explainer/jobrunner.explainer.json
```

`--json` gives `counts`, `drifted[]` (`elementId`, `owner`, `userFields`, `anchors[]` with `reason`), `driftedOther[]` (user-owned), `missing[]`.

## `xpl status <explainer>`

The skill's to-do list, read-only: per view, the shown nodes, participants, stored edges and steps without a `summary`; concepts without one; drifted llm elements; missing anchors; requests queued by the viewer. Static edges are optional. Add `--json` to get the ids of unexplained static edges (`views[].edges.unexplained[].id`), which you need to overlay them.

```
$ xpl status demo
.explainer/demo.explainer.json: index 97f70e7, 2 views, 1 concept
to do: 5 unexplained, 0 drifted, 0 missing anchors, 0 requests

view:overview (graph): Runner, queue, workers and metrics
  nodes without summary (4 of 6): file:src/bus.ts, file:src/metrics.ts, file:src/runner.ts, file:src/worker.ts
  edges: 9 shown; every stored edge is explained; 8 static without summary (optional)

view:dispatch (sequence): How a job is dispatched, and what happens when it fails
  participants without summary (1 of 3): sym:src/worker.ts#Worker
  steps: all 5 explained

requests queued by the viewer (2; delete .explainer/requests.json when handled):
  2026-09-29T07:58:54.092Z  expand file:src/config.ts  (in view:overview)  [config.ts]  "how is the yaml parsed?"
  2026-09-29T07:58:54.154Z  sym:src/queue.ts#Queue
```

`.explainer/requests.json` is a JSON array of `{elementId, note?, kind?, view?, label?, at, explainer?}`; the element may be a node, edge, concept, step or ghost id. Delete the file after handling.

## `xpl view <explainer> [--port p] [--host h] [--no-open]`

Serves the viewer with live repo access at `http://127.0.0.1:<port>/` (default 4747, else a free port; `--port 0` = any) and tries to open a browser. The explainer is re-read from disk on every request: after `xpl apply`, reload the page. Edits in the viewer (layout, expanded nodes) are saved as `user` edits; "Explain this" clicks are appended to `.explainer/requests.json`. Runs until Ctrl-C. It binds to 127.0.0.1; `--host` other than that exposes the source code.

```
$ xpl view jobrunner --no-open --port 0
serving .explainer/jobrunner.explainer.json at http://127.0.0.1:34971/  (Ctrl-C to stop)
```

API (for scripts): `GET /api/bundle`, `GET /api/file?path=`, `PUT /api/views/<id>`, `GET|POST /api/requests`.

## `xpl bundle <explainer> -o out.html [--mode explore|present] [--tour id] [--files all|referenced]`

Writes one self-contained HTML file: the viewer, the explainer, the index and the source files inline. Works offline and can be shared. `--tour <id>` (`tour:intro` or `intro`) starts that tour and implies `--mode present`. `--files all` (default below 20 MB of sources) embeds every indexed file; `referenced` only the files the explainer points at.

```
$ xpl bundle jobrunner -o jobrunner.html
wrote /work/jobrunner.html (2.3 MB): .explainer/jobrunner.explainer.json, 12 files embedded (all), mode explore
$ xpl bundle jobrunner -o talk.html --tour tour:intro
wrote /work/talk.html (2.3 MB): .explainer/jobrunner.explainer.json, 12 files embedded (all), mode present, tour tour:intro
```

## `--json` shapes (the ones worth scripting)

- `index`: `{ok, path, commit, files, symbols, refs, languages: {<lang>: {files, symbols, refs: "precise"|"heuristic"|"none", tool?}}}`
- `apply`: `{ok, applied, dryRun, actor, path, changed: [ids], issues: [{severity, path, elementId?, message, code}], error?}`; issue `code`s: `schema duplicate-id bad-id unknown-id anchor-invalid anchor-drifted anchor-missing evidence frame cycle step commit protected`
- `validate`: `{ok, mode, index, errors, warnings, issues[]}`
- `status`: `{ok, todo: {unexplained, drifted, missing, requests}, views: [{id, type, nodes: {total, unexplained[]}, edges: {total, unexplained: [{id, stored}]}, steps: {total, unexplained[]}}], concepts: {unexplained[]}, anchors: {total, counts}, drifted[], missing[], requests[]}`
- `outline`: `{ok, index, commit, depth, tree: {id, type, label, kind, range?, fanIn, fanOut, more?, children[]}}`
