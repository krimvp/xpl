# CLI reference

`<skill dir>/bin/xpl <command> [options]` (below: `xpl`). Run it from the root of the repo you are explaining, or pass `--root <dir>`. Samples come from `fixtures/ts-jobrunner` (a tiny job runner) and are trimmed, not edited.

**Global options** (every command)

| Option           | Meaning                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------- |
| `--root <dir>`   | repository root (default: current directory)                                             |
| `--json`         | machine-readable output (`{"ok": true, ...}`; errors as `{"ok": false, "error": "..."}`) |
| `--index <path>` | symbol index to use (default: the index of the current commit id, else the newest one)   |
| `-h`, `--help`   | help for the command; `xpl help` lists all                                               |

**Exit codes:** 0 ok · 1 rejected or failed (bad id, rejected patch, a patch that changed nothing because the user owns everything it touches, `resolve --write` on a stale index, validation errors) · 2 usage error.
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

## `xpl refs <id> [--in|--out] [--kind k] [--depth n] [--limit n] [--tests]`

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

**Interfaces are transparent.** A call to an interface method ends at a declaration without a body (Go `JobQueue.Requeue`), so `--out` continues with what runs: under a `call` (or `type-ref`, `read`, `write`) of an interface, or of a method or property of one, it lists the implementations as `impl  <id>  (<file>:<lines>, <resolution>)` lines. They come from the `implements` references of the index (a TS `implements` clause, Go's implicit interface satisfaction, member-level relations of a precise index) plus the same-named members of the implementing types (a Go method declared in another file of the package is found too). `--depth n` expands an `impl` in place of the declaration (its own calls appear below it) and costs no depth. Implementations in test files (`*_test.go`, `test/`, `*.test.*`, `test_*.py`, …: test doubles) are left out, counted in a closing note, and listed with `--tests` (they are listed anyway under a call that itself sits in a test file). More than 10 under one line are cut (`--limit 0` lists all). The same interface method called twice is listed once (`(expanded above)`).

```
$ xpl refs internal/runner/runner.go#Runner.Dispatch --kind call --depth 2
sym:internal/runner/runner.go#Runner.Dispatch (method) internal/runner/runner.go:75-126
out (15):
  call  sym:internal/runner/runner.go#JobQueue.Pop  (internal/runner/runner.go:79, heuristic)  +4
    impl  sym:internal/queue/queue.go#Queue.Pop  (internal/queue/queue.go:86-108, heuristic)
      call  sym:internal/queue/queue.go#runsBefore  (internal/queue/queue.go:96, heuristic)  +10
  ...
  call  sym:internal/runner/runner.go#JobQueue.Requeue  (internal/runner/runner.go:112, heuristic)  +37
    impl  sym:internal/queue/queue.go#Queue.Requeue  (internal/queue/queue.go:112-124, heuristic)
      call  sym:internal/queue/queue.go#Queue.release  (internal/queue/queue.go:116, heuristic)  +4
  ...
(3 implementations in test files left out: test doubles; --tests lists them)
```

The other direction: `--in` of an implementation adds the interface method it implements as a first-level `impl` line, with that method's callers below it (the other implementers are not listed there). The header says how many hops there are.

```
$ xpl refs internal/queue/queue.go#Queue.Requeue --in
in (1, plus 1 via interface):
  call  sym:internal/runner/retry_test.go#recordingQueue.Requeue  (internal/runner/retry_test.go:55, heuristic)  +2
  impl  sym:internal/runner/runner.go#JobQueue.Requeue  (internal/runner/runner.go:19, heuristic)  [the interface member it implements; its callers follow]
    call  sym:internal/runner/runner.go#Runner.Dispatch  (internal/runner/runner.go:112, heuristic)  +37
```

Python base classes and TS abstract classes are `extends` relations, not `implements`: no hop. `--json`: `impl` entries have `kind: "impl"`, `from` = the implementing symbol, `to` = the implemented one, `id`/`file`/`site` = the symbol the line shows, and `children`; `hiddenTestImplementations` counts the test doubles left out.

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

## `xpl new <name> [--title t] [--repo r] [--url u]`

Creates an empty `.explainer/<name>.explainer.json` bound to the selected index. Refuses to overwrite (`error: … already exists; not overwriting it`). The repository name it records (`repo.name`, the label of the repo box) is `--repo`, else the first of: `package.json` `name`, the last element of the `go.mod` module (`example.com/acme/jobrunner/v2` gives `jobrunner`), `[project] name` in `pyproject.toml`, the base name of the git remote (`origin`, else the first), the directory name. `--url` records where the repository lives; it is never taken from the git remote (which may carry credentials).

```
$ xpl new jobrunner --title "Job runner"
created .explainer/jobrunner.explainer.json (title "Job runner", index .explainer/index-97f70e7.json, commit 97f70e7)
repo: ts-jobrunner (package.json)
next: write a patch and run `xpl apply jobrunner patch.json`
```

`--json` adds `repo: {name, source, url?}`.

## `xpl apply <explainer> <patch.json|-> [--actor llm|user] [--dry-run]`

Validates and applies a patch (format: `patch-format.md`; `xpl apply --help` prints a summary of it). Atomic: nothing is written on any error. `-` reads stdin. `--dry-run` checks and lists what would change. Default actor `llm`: never modifies `origin: "user"` elements or `userFields`, and never removes an element that carries `userFields` (skipped with a `protected` warning). Exit 1 = rejected.

```
$ xpl apply jobrunner patch.json
applied to .explainer/jobrunner.explainer.json (actor llm): 7 ids changed
changed:
  grp:scheduling
  ...
$ xpl apply jobrunner bad.json
rejected: 1 error, nothing was applied to .explainer/jobrunner.explainer.json (patch from bad.json)
error   concepts[0].anchors[0] [concept:x]: symbol "Runner.dispach" not found in src/runner.ts. Did you mean: sym:src/runner.ts#Runner.dispatch (anchor: file: "src/runner.ts", symbol: "Runner.dispatch")?
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
ok: .explainer/jobrunner.explainer.json is valid (strict, index 97f70e7); no errors, no warnings
$ xpl validate jobrunner            # after the code changed and `resolve --write`
.explainer/jobrunner.explainer.json (strict, index wt-f7e1e886ad): 3 errors, 0 warnings
error   concepts[0].anchors[0] [concept:retry-policy]: anchor src/runner.ts#Runner.dispatch +30..41 drifted: text of … changed and was not found elsewhere in … (expected sha256:adc8374edfff, now sha256:6e03d8d2a4ed). Re-read the code and rewrite the anchor (and the explanation that depends on it).
error   views[1].steps[2].anchors[1] [dispatch:3]: anchor src/queue.ts#Queue.requeue is missing: symbol Queue.requeue is not in src/queue.ts; did you mean sym:src/queue.ts#Queue.requeueLater (anchor: file: "src/queue.ts", symbol: "Queue.requeueLater"), sym:test/retry.test.ts#RecordingQueue.requeue (anchor: file: "test/retry.test.ts", symbol: "RecordingQueue.requeue")?
```

## `xpl anchors <explainer> [id...] [--full] [--max-lines n]`

Shows what an explainer's anchors point at, so you can verify spans without reading the JSON. For every element with stored anchors (node overlays, edges, concepts, sequence steps, the `code` overrides of tour steps) it prints each anchor: role, `file#symbol`, span, status (`ok`, `moved`, `drifted`, `missing`), the resolved lines, then the code at those lines as `<line> <offset>│ code`. The offsets are the ones `xpl show` prints and a `span` uses, so a wrong span is visible at once. Status and lines are resolved now, against the index the explainer is bound to and the working tree; when the explainer file's cached lines differ, a note says so (`run xpl resolve <name> --write`). Each anchor's code is cut after 12 lines (`--max-lines n`; `--full` or `--max-lines 0` prints all; the cut line shows the `xpl show … --lines` to read the rest).

Ids: element ids as they are (`concept:retry-policy`, `dispatch:3`, `edge:job-completed`, `sym:src/runner.ts#Runner.dispatch`, `tour:intro/t2` for one tour step), a view (`view:dispatch`: its steps), a tour (`tour:intro`: its steps), or the loose forms the other commands take (`src/runner.ts#Runner.dispatch`). No ids: every element with anchors. An element that exists but has no stored anchors is listed as such (the viewer falls back to its symbol, file or members); an unknown id fails with suggestions.

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

concept:retry-policy  (concept, llm)  3 anchors
  1. definition  src/runner.ts#Runner.dispatch +30..41  ok  lines 72-83
     72 30│       // Retry policy: exponential backoff up to maxRetries, then dead-letter.
     ...
  3. test  test/retry.test.ts  ok  lines 1-91
      1  0│ import assert from "node:assert/strict";
     ...
     ... 79 more lines (13-91); --full shows all, or `xpl show test/retry.test.ts --lines 13-91`

5 anchors of 2 elements: ok 5, moved 0, drifted 0, missing 0
```

After the code changed, the same command reads the anchors that need attention: a `drifted` span shows the code where the span used to sit (marked approximate: re-read it), a `missing` one shows its reason (and, when the anchored lines or a same-sized symbol are found elsewhere, where the code went) and no code. A header says `anchors owned by the user` for an element whose anchors the user edited (an llm patch cannot change them).

`--json`: `{ok, path, index, maxLines, anchors: {total, counts}, elements: [{id, type, view?, origin?, userFields?, anchors: [{path, role, file, symbol?, span?, where, status, stored?, range?, approximate?, reason?, lines?: [{line, offset, text}], moreLines?}]}], withoutAnchors?}`.

## `xpl resolve <explainer> [--write] [--allow-stale]`

Re-resolves every anchor (elements, steps, tour code overrides) against the index of the current code (`--index`, else the current commit id, else the newest), ignoring the explainer's own old index. `moved` = same text, new lines (span updated); `drifted` = text changed; `missing` = symbol gone. Prints the counts, the **drifted llm elements** (re-explain those, except `userFields`; a step names its view) and the **missing anchors** (ask the user; the reason says where the code went when it can tell: a span whose text now sits in another symbol, a renamed symbol of the same size, the same name elsewhere, test files last). `--write` saves the new ranges and the index binding; drifted anchors stay drifted until their element is resent.

`--write` **refuses** (exit 1) when the index it would resolve against no longer matches the working tree, because the ranges it saves would already be wrong: run `xpl index` first, then repeat. `--allow-stale` writes anyway (and still warns); `XPL_SKIP_STALE_CHECK=1` skips the comparison, and with it the refusal.

```
$ xpl resolve jobrunner --write
resolved .explainer/jobrunner.explainer.json against index wt-f7e1e886ad (.explainer/index-wt-f7e1e886ad.json)
anchors: 12 (ok 6, moved 3, drifted 2, missing 1)
drifted llm elements to re-explain (2):
  sym:src/runner.ts#Runner.dispatch  (node)
    nodes[1].anchors[0]  src/runner.ts#Runner.dispatch [definition]  now at lines 43-89
      text of src/runner.ts#Runner.dispatch changed (expected sha256:c02146e8d847, now sha256:5ec5cf814d55)
  dispatch:3  (step in view:dispatch)
    ...
missing anchors (1): fix or drop them explicitly
  dispatch:1  views[1].steps[0].anchors[1]  src/queue.ts#Queue.pop [definition]
    symbol Queue.pop is not in src/queue.ts; did you mean sym:src/queue.ts#Queue.take (anchor: file: "src/queue.ts", symbol: "Queue.take")?
written: .explainer/jobrunner.explainer.json
$ xpl resolve jobrunner --write     # the tree changed after `xpl index`
error: refusing to write .explainer/jobrunner.explainer.json: index wt-97f70e7a11 (.explainer/index-wt-97f70e7a11.json) does not match the working tree (wt-f7e1e886ad): 1 changed (src/runner.ts). The ranges it would save are already out of date: run `xpl index` first, then `xpl resolve jobrunner --write` again (--allow-stale saves them against this index anyway).
```

`--json` gives `counts`, `drifted[]` (`elementId`, `owner`, `view?` for a step, `userFields`, `anchors[]` with `reason`), `driftedOther[]` (user-owned), `missing[]` (`view?` too).

## `xpl status <explainer>`

The skill's to-do list, read-only: per view, the shown nodes, participants, stored edges and steps without a `summary` (and the ids of the static edges without one, which you need to overlay them); concepts without one; drifted llm elements; missing anchors; **broken references**; stale edge overlays; requests queued by the viewer. Static edges are optional. `status` reads the explainer through the index it is bound to: after `xpl index`, run `xpl resolve <name> --write` first so that it sees the new code.

- The `to do:` line counts drift the user owns apart: `4 drifted (1 user-owned: ask the user)`. User-owned = an element that is not llm-authored, or an llm element whose anchors (or, for a step, whose view's `steps`) the user edited: an llm patch cannot repair those.
- `broken references (n)`: ids that no longer exist in the index (lenient validation): the overlay of a deleted symbol, an `include`, `members`, `related` or `participants` entry, a step end. The line `, n broken references` is appended to `to do:` only when there are some.
- `warning: stale edge overlays (n)`: stored `edge:<kind>:<a>-><b>` overlays that no graph view derives any more (the ends of a derived id follow the view's `include`, or the code changed). They are ignored until re-created on a current id; hidden edges do not count.

```
$ xpl status demo
.explainer/demo.explainer.json: index 97f70e7, 3 views, 2 concepts
to do: 5 unexplained, 2 drifted (1 user-owned: ask the user), 1 missing anchors, 0 requests, 4 broken references

view:overview (graph): Runner, queue, workers and metrics
  nodes without summary (2 of 6): file:src/metrics.ts, file:src/worker.ts
  edges: 9 shown; every stored edge is explained; 8 static without summary (optional): edge:calls:file:src/runner.ts->file:src/queue.ts, edge:calls:file:src/runner.ts->file:src/worker.ts, ... +6 more (--json lists all)

view:dispatch (sequence): How a job is dispatched, and what happens when it fails
  participants without summary (1 of 3): sym:src/worker.ts#Worker
  steps: all 5 explained

anchors: 12 (ok 8, moved 0, drifted 2, missing 1)
drifted llm elements to re-explain (1):
  dispatch:3  (step in view:dispatch)
    ...
drifted, but not llm-owned (left alone) (1):
  concept:mine  (origin user)  concepts[1].anchors[0]
missing anchors (1): fix or drop them explicitly
  dispatch:1  views[1].steps[0].anchors[1]  src/queue.ts#Queue.pop [definition]
    symbol Queue.pop is not in src/queue.ts; did you mean sym:src/queue.ts#Queue.take (anchor: file: "src/queue.ts", symbol: "Queue.take")?

broken references (4): ids that no longer exist in the index. Repair each with a patch (`includeRemove` drops a stale include entry; resend members, participants or steps without it), or remove the element:
  warning nodes[2].id [sym:src/queue.ts#Queue.pop]: stored node symbol "Queue.pop" not found in src/queue.ts. Did you mean: sym:src/queue.ts#Queue.take?
  ...

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
- `apply`: `{ok, applied, dryRun, actor, path, changed: [ids], issues: [{severity, path, elementId?, message, code}], protectedIds?: [ids], error?}`; issue `code`s: `schema duplicate-id bad-id unknown-id anchor-invalid anchor-drifted anchor-missing evidence frame cycle step commit protected`. `ok: false` with `applied: false` also when everything the patch touched is protected.
- `validate`: `{ok, mode, index, errors, warnings, issues[]}`
- `status`: `{ok, todo: {unexplained, drifted, driftedUserOwned, missing, requests, broken}, views: [{id, type, nodes: {total, unexplained[]}, edges: {total, unexplained: [{id, stored}]}, steps: {total, unexplained[]}}], concepts: {unexplained[]}, anchors: {total, counts}, drifted[], driftedOther[], missing[], broken: [issues], staleOverlays: [ids], requests[]}` (`todo.drifted` counts every drifted element, `driftedUserOwned` those of it the user owns)
- `anchors`: see its section
- `new`: `{ok, path, name, title, repo: {name, source, url?}, index: {path, commit}}`
- `outline`: `{ok, index, commit, depth, tree: {id, type, label, kind, range?, fanIn, fanOut, more?, children[]}}`
