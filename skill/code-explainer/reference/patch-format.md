# Patch format

Everything you write goes into a JSON **patch**. `xpl apply <name> patch.json` (or `-` for stdin) merges it into `.explainer/<name>.explainer.json`, fills in hashes and resolved ranges, validates the result, and either writes everything or nothing.

A draft (`xpl draft`) is a patch in this format: start from it, and use these templates for what you add. **Read only what the task needs.** Always: section 1 (anchors) and 2 (ids). Then the template of each element you write: 3.1 groups, 3.2 overlays (summaries of files and symbols), 3.3-3.4 edges, 3.5 concepts, 3.6 graph views, 3.7 flow views, 3.8 sequence views, 3.9 tours. The rest is for when a command points you there: 4 merge rules (what a resend replaces), 5 provenance (a `protected` warning), 6 the apply output, 7 rejection messages, 8 repair after the code changed.

```json
{
  "title": "…",
  "nodes": [],
  "edges": [],
  "concepts": [],
  "views": [],
  "tours": [],
  "remove": ["id", "…"]
}
```

Every key is optional; any other top-level key is rejected. The authoritative merge rules are in the header of `packages/core/src/patch.ts`; this file is the practical version of them, and every JSON block below marked `patch` is real: applied in order to a fresh explainer on the TypeScript fixture it passes `xpl validate` (a test of the repository does exactly that). `xpl apply --help` prints a compact summary of the format. What to write in the text fields (titles, summaries, notes) is in `writing.md`.

## 1. Anchors (`AnchorInput`)

An anchor says "this element is about that code". You give a place; the CLI checks it exists and stores the hash and the resolved line range. **Never write `hash` or line numbers you did not copy from tool output.**

```json
{
  "file": "src/runner.ts",
  "symbol": "Runner.dispatch",
  "find": "await this.queue.pop()",
  "role": "call-site"
}
```

| Field    | Meaning                                                                                                                                                                                                                 |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file`   | repo-relative POSIX path, must be in the index                                                                                                                                                                          |
| `symbol` | the symbol's path **inside the file** (`Runner.dispatch`, `retry.maxRetries`), not the id `sym:src/runner.ts#Runner.dispatch`. Omit for a whole file or a file-relative span                                            |
| `span`   | `{from, to}`: 0-based line offsets, inclusive, relative to the symbol's first line (file line 1 when there is no `symbol`). Copy them from `xpl show` (`<line> <offset>│`) or `+a..b` in `refs`/`show --refs`/`search`  |
| `find`   | alternative to `span` (give one): text that occurs **exactly once** in the symbol (or file). May be multi-line; matched exactly, then ignoring whitespace differences. It is stored as the span of the lines it touches |
| `role`   | `definition` where it lives · `call-site` where it is invoked (the caller side of an arrow) · `usage` other notable references · `config` config that shapes behaviour · `test` tests that exercise it                  |
| `hash`   | optional; if given it must equal the current hash, else the anchor is rejected as stale. Leave it out                                                                                                                   |
| `at`     | `"base"`: the code **before** the change the explainer records (`xpl change`), not the current code. Only with `find` or a file-relative `span`, never `symbol`; see "Anchors in the code before the change" below      |

Forms you will use (all verified against the TS fixture):

| You want to point at              | Write                                                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| a whole function, class or method | `{"file": "src/queue.ts", "symbol": "Queue.requeue", "role": "definition"}`                                     |
| one call inside a function        | `{"file": "src/runner.ts", "symbol": "Runner.dispatch", "find": "await this.queue.pop()", "role": "call-site"}` |
| a block inside a function         | `{"file": "src/runner.ts", "symbol": "Runner.dispatch", "span": {"from": 34, "to": 36}, "role": "call-site"}`   |
| a config key (YAML/JSON/TOML)     | `{"file": "config/default.yaml", "symbol": "retry.maxRetries", "role": "config"}` (`retry` = the whole block)   |
| a whole file (tests, docs)        | `{"file": "test/retry.test.ts", "role": "test"}`                                                                |
| lines of a symbol-less file       | `{"file": "test/retry.test.ts", "span": {"from": 53, "to": 65}, "role": "test"}` (offset = line − 1)            |
| text in a file without symbols    | `{"file": "README.md", "find": "A failed one is requeued", "role": "usage"}`                                    |

`find` anchors exactly the lines its text touches: a one-line `find` on the first line of a three-line call anchors one line. For a whole call or block use `span` (`+34..36` from `show --refs`) or a multi-line `find`. Prefer `find` for one-line call sites (it checks itself) and `span` for blocks (copy the numbers, never compute them). `symbol` can point at any indexed symbol, including class fields and config keys (`xpl outline --keys`).

### Anchors in the code before the change (`at: "base"`)

For a change, a claim about the old code ("before this PR, the file was sent at once") needs an anchor in the old code. Run `xpl change <name> <base>..<head>` first: it records the change. Then:

```json base
{
  "file": "starlette/responses.py",
  "at": "base",
  "find": "await self._handle_simple(send, send_header_only, send_pathsend)\n        else:",
  "role": "usage"
}
```

- The file must be changed by the change and have an old version: modified, renamed or deleted. An added file has no old version, and an unchanged file's old code is its current code (anchor it without `at`). A renamed file may be named by its old or new path; it is stored under the new one.
- No `symbol`: only the current code is indexed. Use `find` (text that occurs once in the old file) or a `span` counted from line 1 of the old file. `xpl show --at base <path> [--lines a-b]` prints the old file with those offsets.
- `xpl validate` checks base anchors against the recorded change; `xpl anchors` prints them as `<file>@base +a..b` with the old code.
- Base anchors do not count as evidence for an `llm` edge, and the code view of the current code does not highlight them.

## 2. Ids

| Form                                                            | What                             | Notes                                                                                                                                                         |
| --------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repo`, `dir:<path>`, `file:<path>`, `sym:<file>#<symbol path>` | structural nodes, from the index | paste from `xpl outline`. Used in `include`, `members`, `participants`, step `from`/`to`, `focus`, `related`, edge `from`/`to`, and as overlay ids            |
| `grp:<slug>`                                                    | group                            | you choose the slug once                                                                                                                                      |
| `concept:<slug>`                                                | concept                          |                                                                                                                                                               |
| `edge:<slug>`                                                   | your `llm` edge                  |                                                                                                                                                               |
| `edge:<kind>:<from>-><to>`                                      | a derived (static) edge          | store one only to label/explain it (3.4). Ends are what the view shows (`xpl status --json` lists the ids)                                                    |
| `ghost:<key>`, `stub:<in\|out>:<inside>->ghost:<key>`           | a ghost box, a stub              | only for `hidden`, never `include`; `xpl status --json` lists them (`views[].ghosts`); keys: `file:x`, `dir:x`, `sym:…`, `rest:file:x`, `more:in`, `more:out` |
| `view:<slug>`, `tour:<slug>`, `frame:<slug>`                    | view, tour, frame                | a view slug must not be a reserved word (`dir file sym grp concept edge view tour frame ghost stub`)                                                          |
| `<view-slug>:<n>`                                               | sequence step (`dispatch:3`)     | unique in the whole explainer; **never renumber**; array order is display order                                                                               |
| `t1`, `t2`, …                                                   | tour step                        | any string unique inside the tour                                                                                                                             |
| `scope.entryPoints[]`                                           | `<file>#<symbol path>`           | **no** `sym:` prefix                                                                                                                                          |

Slugs: letters, digits, `.`, `_`, `-`; must start with a letter or digit; use lowercase kebab-case.

## 3. Element templates

Each block is a complete patch. Save, apply, and adapt.

### 3.1 Group node (a cluster that crosses folders)

Required for a new group: `label`, `members`. `kind` and `parent` (default `repo`) are inferred.

```json patch
{
  "nodes": [
    {
      "id": "grp:scheduling",
      "label": "Scheduling",
      "summary": "Decides which job runs next (priority, then age) and hands it to a free worker.",
      "members": ["file:src/runner.ts", "file:src/queue.ts"]
    }
  ]
}
```

In a graph view, include the group **and** its members to draw it as a container around them; include only the group to draw one box that stands for all of them.

### 3.2 Overlay on a structural node (label, summary, detail)

`dir:`, `file:` and `sym:` nodes exist already. Store an overlay only to attach text: `id` plus the fields you set (default label = basename or last symbol segment; `anchors` default to `[]`, and the viewer falls back to the symbol's range, the file, or the directory's files). `detail` is markdown and optional.

```json patch
{
  "nodes": [
    {
      "id": "sym:src/runner.ts#Runner.dispatch",
      "summary": "The dispatch loop: pop a job, lease a worker and run the job. Then ack it, requeue it with a delay, or dead-letter it.",
      "detail": "Runs until `stop()` is called. When the queue has no job that is due, the loop sleeps for `idleDelayMs`.\n\nThe retry decision is in the last third of the loop; see the retry-policy concept."
    },
    {
      "id": "file:src/queue.ts",
      "label": "Queue",
      "summary": "In-memory priority queue with an in-flight set, requeue-with-delay and a dead-letter list."
    }
  ]
}
```

The participants of a sequence or flow view and the boxes of a graph view count as "unexplained" (`xpl status`) until they have a `summary`, so write overlays for them in the same patch. What a summary says, how long it is and which markdown it takes: `writing.md`, section 1.

### 3.3 `llm` edge (only for links static analysis cannot see)

Event bus, DI, HTTP, queues, config keys read by name. Required: `from`, `to`, `kind`, `label`. Pick the `kind` that reads best: `emits` (event bus, queue publish), `calls` (a call through an interface, DI or HTTP), `reads` (config or other string-keyed lookups), `custom`. **Anchors at both ends**: at least one inside `from` (the emit/publish/call site) and one inside `to` (the subscription or the handler), else the patch is rejected. More anchors (the subscription site, the place where the concrete class is wired in) make a stronger case. `examples/go-retry.patch.json` has a DI edge (`calls`) and a config edge (`reads`).

```json patch
{
  "edges": [
    {
      "id": "edge:job-completed",
      "from": "file:src/worker.ts",
      "to": "file:src/metrics.ts",
      "kind": "emits",
      "label": "job.completed",
      "summary": "`Worker.run` publishes `job.completed` on the event bus, and `registerMetrics` subscribes to that topic. No call links `worker.ts` and `metrics.ts`.",
      "anchors": [
        {
          "file": "src/worker.ts",
          "symbol": "Worker.run",
          "find": "this.bus.emit(\"job.completed\"",
          "role": "call-site"
        },
        {
          "file": "src/metrics.ts",
          "symbol": "registerMetrics",
          "find": "bus.on<JobCompleted>(\"job.completed\"",
          "role": "call-site"
        },
        { "file": "src/metrics.ts", "symbol": "onJobCompleted", "role": "definition" }
      ]
    }
  ]
}
```

"Inside" means: file → same file; dir → under it; symbol → that symbol or a descendant; group → any member.

### 3.4 Overlay on a derived (static) edge

Calls, imports and inheritance appear in graph views on their own. To label or explain one, store an edge whose id is the derived id; `kind`, `from`, `to` come from the id and must not contradict it. It is still an `llm` edge, so it needs anchors at both ends, and give it a `label` (an empty one warns). The ends of a derived id are what the view shows, so they change when the view's `include` changes: after adding `sym:internal/worker/worker.go#Worker` to the `include` of the go-jobrunner view, the call to `Worker.Run` is `edge:calls:file:internal/runner/runner.go->sym:internal/worker/worker.go#Worker`, and an overlay left on the old `...->file:internal/worker/worker.go` id now sits on an edge that stands for other references. Write these overlays after the `include` list is final and copy the id from `xpl status <name> --json` (`views[].edges.unexplained[].id`).

```json patch
{
  "edges": [
    {
      "id": "edge:calls:file:src/runner.ts->file:src/worker.ts",
      "label": "run(job)",
      "summary": "Runner.dispatch leases a worker and runs each popped job on it.",
      "anchors": [
        {
          "file": "src/runner.ts",
          "symbol": "Runner.dispatch",
          "span": { "from": 18, "to": 19 },
          "role": "call-site"
        },
        { "file": "src/worker.ts", "symbol": "Worker.run", "role": "definition" }
      ]
    }
  ]
}
```

### 3.5 Concept (a cross-cutting idea)

Required: `label`. Anchor the lines that decide (not the whole function), the config keys and the tests; `related` lists elements to co-highlight (any element id).

```json patch
{
  "concepts": [
    {
      "id": "concept:retry-policy",
      "label": "Retry policy",
      "summary": "The runner requeues a failed job while `attempts <= retry.maxRetries`, with a delay of `baseDelayMs * 2^(attempts-1)` capped at `maxDelayMs`. After that, it dead-letters the job.",
      "anchors": [
        {
          "file": "src/runner.ts",
          "symbol": "Runner.dispatch",
          "find": "if (attempts <= this.config.retry.maxRetries) {\n        const backoff = backoffDelay(attempts, this.config.retry);",
          "role": "definition"
        },
        { "file": "src/runner.ts", "symbol": "backoffDelay", "role": "definition" },
        { "file": "config/default.yaml", "symbol": "retry", "role": "config" },
        { "file": "test/retry.test.ts", "span": { "from": 53, "to": 65 }, "role": "test" }
      ],
      "related": ["sym:src/runner.ts#Runner.dispatch", "file:src/queue.ts"]
    }
  ]
}
```

### 3.6 Graph view

Required: `type: "graph"`, `title`, `include`. `scope` defaults to `{"root": "repo", "depth": 1}`; record the question and depth you used. `include` is the source of truth for what is drawn; a node whose children are also included renders as a container; calls between shown nodes are derived. `edgeKinds` picks which kinds: default `calls`, `extends`, `implements`; also `imports` (runtime dependencies: a TS `import type` or a Python `TYPE_CHECKING` import is a type use, so it shows as `references`), `references` (type dependencies), `writes` and `reads` (uses of a variable, constant or field: many, so keep `reads` for a small view about one config switch or shared field). Edges leaving the view become dashed stubs to ghost boxes (see "Crowded views" below). `hidden` removes nodes, derived edges, ghosts or stubs you do not want (`layout` pins positions; leave it to the user). `excludeFiles` (below) drops the references of test files from the derived edges and stubs.

```json patch
{
  "views": [
    {
      "id": "view:overview",
      "type": "graph",
      "title": "Runner, queue, workers and metrics",
      "scope": {
        "root": "repo",
        "depth": 2,
        "question": "How does a job get from the queue to a worker?"
      },
      "include": [
        "grp:scheduling",
        "file:src/runner.ts",
        "file:src/queue.ts",
        "file:src/worker.ts",
        "file:src/bus.ts",
        "file:src/metrics.ts"
      ],
      "edgeKinds": ["calls", "imports"],
      "hidden": ["edge:imports:file:src/worker.ts->file:src/queue.ts"]
    }
  ]
}
```

Edit `include` without resending it with `includeAdd` (ids to append; those already included are ignored) and `includeRemove` (ids to take out). Both are patch-only fields (never stored) and apply after `include` when that is sent too; an id in both lists is an error; a new view may use `includeAdd` instead of `include`. This is how `expand` grows a view. `includeAdd` is also the one edit an `llm` patch may make to a view whose `include` the user curated (section 5): it only adds. `includeRemove` may name an id that vanished from the index (that is how a stale entry is dropped); one that is not in the list is a warning.

```json patch
{
  "views": [
    {
      "id": "view:overview",
      "type": "graph",
      "includeAdd": ["file:src/config.ts"],
      "includeRemove": ["file:src/bus.ts"]
    }
  ]
}
```

`excludeFiles` is a list of globs on repo paths: `**` crosses directories, `*` stays inside one path segment, `?` is one character, and a pattern without a `/` also matches the file name at any depth. Derived edges and stubs are computed without the references that start or end in a matching file, so an edge that exists only through test files disappears (and the others count only their remaining references). Nodes in `include` always show, the edges of a file or symbol you include by name stay, stored (`llm`/`user`) edges are never filtered. On an overview, tests, examples and docs add edges and ghosts that are not the design; `xpl draft repo` sets a list like this one:

```json patch
{
  "views": [
    {
      "id": "view:overview",
      "type": "graph",
      "excludeFiles": [
        "**/*_test.go",
        "**/test/**",
        "**/tests/**",
        "**/*.test.*",
        "**/test_*.py",
        "**/examples/**",
        "docs/**"
      ]
    }
  ]
}
```

**Crowded views (stubs).** A graph view that a tour shows uses `"stubs": {"mode": "none"}` (SKILL.md, "The tour"). The rest of this section is for views used to explore. Edges that leave a graph view are dashed stubs to ghost boxes. By default (`"stubs": {"mode": "top", "max": 8}`) a view draws only the 8 ghosts that the most references lead to. The outside symbols of a file the view shows in part fold into one `ghost:rest:file:<path>` ("rest of <file>"), and the ghosts beyond the 8 into `ghost:more:in` / `ghost:more:out` ("+N more"). A folded ghost is not an element and cannot go in `include`: `xpl status` prints up to 3 of the elements each one stands for (`ghost:rest:file:src/runner.ts ×6 → sym:src/runner.ts#Runner.log ×3, ...`), `xpl status --json` (`views[].ghosts.list[].targets`) lists all of them with their reference counts, the viewer's menu (click the ghost) lists them too, and `xpl refs <shown id> --out` prints what leaves a box. To expand, `includeAdd` one of those elements, or `file:<path>` for the whole file as one box (`ghost:file:x` and `ghost:dir:x`, the names the viewer gives plain ghosts, still mean `file:x` and `dir:x`).

Keep a graph view readable: `"none"` for no stubs at all (every graph view a tour shows), `"mode": "all"` (one ghost per outside element) only for small views, `{"mode": "top", "max": 6}` for another cap, and `hidden` for the ghost and stub ids you do not need (`status --json` lists both: `views[].ghosts.list[].id` and `views[].ghosts.stubIds`). `xpl status` prints each view's ghosts and stubs and warns above 12. An arrow from a box to its own container is never drawn. In a src layout start the overview at `dir:src/<pkg>`, not `dir:src` (that is one box for the whole tree).

```json patch
{
  "views": [{ "id": "view:overview", "type": "graph", "stubs": { "mode": "none" } }]
}
```

### 3.7 Flow view (stages, decisions, branches)

Use `type: "flow"` when the point is what the code decides: stages, conditions, and where each path ends. It takes the same fields as a sequence view (3.8): `title`, `participants`, `steps`, `scope`, anchors. Each step may add `shape` (`"stage"`, `"decision"` or `"terminal"`) and `next: [{"step": "<id>", "label": "<when>"}]`. Without `next`, a step goes on to the next step in the list, unless it is a `terminal`; `next: []` ends a path. Every `next` target must be a step of the same view. Model each branch and loop explicitly, and anchor the condition that decides it. A stage or decision inside one function uses that function's participant as both `from` and `to`, with `kind: "call"`; the box shows the label, not the two ends. `shape` and `next` are also accepted by `stepsUpdate` (`null` clears them).

The box shows the `label` in large type, so a flow label names a stage (`writing.md`, section 3), and the call goes in the anchors. A `decision` label is a short question ("Did the attempt succeed?"), and each `next` label says when that branch is taken ("yes", "attempts left").

```json patch
{
  "views": [
    {
      "id": "view:failure-path",
      "type": "flow",
      "title": "What happens after a job runs",
      "scope": {
        "root": "repo",
        "depth": 3,
        "question": "What does the runner do with a finished attempt?",
        "entryPoints": ["src/runner.ts#Runner.dispatch"]
      },
      "participants": ["sym:src/runner.ts#Runner.dispatch", "file:src/queue.ts"],
      "steps": [
        {
          "id": "failure-path:1",
          "from": "sym:src/runner.ts#Runner.dispatch",
          "to": "sym:src/runner.ts#Runner.dispatch",
          "label": "Did the attempt succeed?",
          "kind": "call",
          "shape": "decision",
          "summary": "`Runner.dispatch` checks `result.ok` after each attempt.",
          "next": [
            { "step": "failure-path:2", "label": "yes" },
            { "step": "failure-path:3", "label": "no" }
          ],
          "anchors": [
            {
              "file": "src/runner.ts",
              "symbol": "Runner.dispatch",
              "find": "if (result.ok) {",
              "role": "call-site"
            }
          ]
        },
        {
          "id": "failure-path:2",
          "from": "sym:src/runner.ts#Runner.dispatch",
          "to": "file:src/queue.ts",
          "label": "Mark the job done",
          "kind": "call",
          "shape": "terminal",
          "summary": "`Queue.ack` removes the job from the in-flight set and counts it.",
          "anchors": [
            {
              "file": "src/runner.ts",
              "symbol": "Runner.dispatch",
              "find": "await this.queue.ack(job);",
              "role": "call-site"
            },
            { "file": "src/queue.ts", "symbol": "Queue.ack", "role": "definition" }
          ]
        },
        {
          "id": "failure-path:3",
          "from": "sym:src/runner.ts#Runner.dispatch",
          "to": "sym:src/runner.ts#Runner.dispatch",
          "label": "Attempts left?",
          "kind": "call",
          "shape": "decision",
          "summary": "An attempt is left while `attempts` is at most `retry.maxRetries`.",
          "next": [
            { "step": "failure-path:4", "label": "yes" },
            { "step": "failure-path:5", "label": "no" }
          ],
          "anchors": [
            {
              "file": "src/runner.ts",
              "symbol": "Runner.dispatch",
              "find": "if (attempts <= this.config.retry.maxRetries) {",
              "role": "call-site"
            }
          ]
        },
        {
          "id": "failure-path:4",
          "from": "sym:src/runner.ts#Runner.dispatch",
          "to": "file:src/queue.ts",
          "label": "Requeue with a delay",
          "kind": "call",
          "shape": "terminal",
          "summary": "`Queue.requeue` puts a copy of the job back, due after `backoffDelay(attempts)` milliseconds.",
          "anchors": [
            {
              "file": "src/runner.ts",
              "symbol": "Runner.dispatch",
              "span": { "from": 33, "to": 36 },
              "role": "call-site"
            },
            { "file": "src/queue.ts", "symbol": "Queue.requeue", "role": "definition" }
          ]
        },
        {
          "id": "failure-path:5",
          "from": "sym:src/runner.ts#Runner.dispatch",
          "to": "file:src/queue.ts",
          "label": "Park it in the dead-letter list",
          "kind": "call",
          "shape": "terminal",
          "summary": "`Queue.deadLetter` keeps the job with the error of its last attempt.",
          "anchors": [
            {
              "file": "src/runner.ts",
              "symbol": "Runner.dispatch",
              "find": "await this.queue.deadLetter(job, result.error);",
              "role": "call-site"
            },
            { "file": "src/queue.ts", "symbol": "Queue.deadLetter", "role": "definition" }
          ]
        }
      ]
    }
  ]
}
```

A sequence view also appears in the reader's Process flow tab, as an ordered list of its calls; that list is not a model of the decisions. Write a flow view when the decisions are the point.

**Supporting files.** For configuration and files that code loads by name, use configuration-key anchors (`role: "config"`) and edges with `kind: "loads"`, `"discovers"`, `"configures"` or `"overrides"`, anchored at both ends. A loader points to the loaded file or plugin directory (or group); configuration points to the code that reads it; an overriding file points to the file it overrides. Say the conditions and the order of precedence in the edge summary, as the code shows them: file names and reading order do not prove precedence. Index `resources` records resolve literal paths and supported globs, with `static` or `inferred` labels; a matching file does not prove that it is loaded at runtime.

### 3.8 Sequence view (steps, frames)

Required: `type: "sequence"`, `title`, `participants` (lifelines, left to right), `steps`. Every step needs `id` (`<view-slug>:<n>`), `from`, `to` (both must be participants), `label` (the call text, as written in the code), `kind` (`call` solid arrow, `return` dashed back to the caller, `async` open head), and should have `summary` and anchors: the exact call in the caller (`call-site`) plus the callee's definition. `edge` links a step to the edge it instantiates. A step's `from` may equal `to` (self-call). Frames (`loop`, `alt`, `opt`, `par`) wrap the run `fromStep`..`toStep` (inclusive); nest them or keep them apart (a partial overlap draws a warning). Keep a sequence view to 6 participants at most: a flow with more is two or three views (one per phase or per collaborator group), each readable on its own.

```json patch
{
  "views": [
    {
      "id": "view:dispatch",
      "type": "sequence",
      "title": "How a job is dispatched, and what happens when it fails",
      "scope": {
        "root": "repo",
        "depth": 3,
        "question": "How does a job get from the queue to a worker, and what happens when it fails?",
        "entryPoints": ["src/runner.ts#Runner.dispatch"]
      },
      "participants": [
        "sym:src/runner.ts#Runner.dispatch",
        "file:src/queue.ts",
        "sym:src/worker.ts#Worker"
      ],
      "steps": [
        {
          "id": "dispatch:1",
          "from": "sym:src/runner.ts#Runner.dispatch",
          "to": "file:src/queue.ts",
          "label": "pop()",
          "kind": "call",
          "summary": "Takes the highest-priority, oldest job that is due; an empty queue makes the loop sleep and retry.",
          "anchors": [
            {
              "file": "src/runner.ts",
              "symbol": "Runner.dispatch",
              "find": "await this.queue.pop()",
              "role": "call-site"
            },
            { "file": "src/queue.ts", "symbol": "Queue.pop", "role": "definition" }
          ]
        },
        {
          "id": "dispatch:2",
          "from": "sym:src/runner.ts#Runner.dispatch",
          "to": "sym:src/worker.ts#Worker",
          "label": "run(job)",
          "kind": "call",
          "summary": "Runs one attempt on the leased worker, with the configured timeout.",
          "anchors": [
            {
              "file": "src/runner.ts",
              "symbol": "Runner.dispatch",
              "span": { "from": 18, "to": 19 },
              "role": "call-site"
            },
            { "file": "src/worker.ts", "symbol": "Worker.run", "role": "definition" }
          ]
        },
        {
          "id": "dispatch:3",
          "from": "sym:src/worker.ts#Worker",
          "to": "sym:src/runner.ts#Runner.dispatch",
          "label": "RunResult",
          "kind": "return",
          "summary": "`Worker.run` returns a failure as `{ ok: false, error }` instead of throwing, so the runner decides what to do next.",
          "anchors": [
            {
              "file": "src/worker.ts",
              "symbol": "Worker.run",
              "find": "return { ok: true, value, durationMs };",
              "role": "definition"
            },
            {
              "file": "src/runner.ts",
              "symbol": "Runner.dispatch",
              "find": "if (result.ok) {",
              "role": "call-site"
            }
          ]
        },
        {
          "id": "dispatch:4",
          "from": "sym:src/runner.ts#Runner.dispatch",
          "to": "file:src/queue.ts",
          "label": "requeue(job, backoff)",
          "kind": "call",
          "summary": "While attempts are left, the job goes back on the queue, delayed by backoffDelay(attempts).",
          "anchors": [
            {
              "file": "src/runner.ts",
              "symbol": "Runner.dispatch",
              "span": { "from": 34, "to": 36 },
              "role": "call-site"
            },
            { "file": "src/queue.ts", "symbol": "Queue.requeue", "role": "definition" }
          ]
        },
        {
          "id": "dispatch:5",
          "from": "sym:src/runner.ts#Runner.dispatch",
          "to": "file:src/queue.ts",
          "label": "deadLetter(job, error)",
          "kind": "call",
          "summary": "Once retry.maxRetries requeues are used up, the job is parked in the dead-letter list with its last error.",
          "anchors": [
            {
              "file": "src/runner.ts",
              "symbol": "Runner.dispatch",
              "find": "await this.queue.deadLetter(job, result.error);",
              "role": "call-site"
            },
            { "file": "src/queue.ts", "symbol": "Queue.deadLetter", "role": "definition" }
          ]
        }
      ],
      "frames": [
        {
          "id": "frame:dispatch-loop",
          "kind": "loop",
          "label": "while the runner is running",
          "fromStep": "dispatch:1",
          "toStep": "dispatch:5"
        },
        {
          "id": "frame:failed-attempt",
          "kind": "alt",
          "label": "result.ok is false: retry, or give up",
          "fromStep": "dispatch:4",
          "toStep": "dispatch:5"
        }
      ]
    }
  ]
}
```

**Editing one step** (sequence and flow views). To fix a step's summary or anchors, do not resend all the steps: `stepsUpdate` is a list of `{id, ...fields}` merged into the existing steps with those ids. The fields are those of a step (`from`, `to`, `label`, `kind`, `summary`, `anchors`, `edge`, and for a flow `shape`, `next`): `anchors` replace that step's anchors wholesale, `null` clears `summary` or `edge`. The other steps, the frames and the tours that point at them stay as they are, and `changed` lists the view and the ids of the steps it updated. It applies after `steps` when both are sent, only to a view that exists (a new view sends `steps`), and an unknown step id is an error that names the view's steps. Like `steps`, it is skipped with a `protected` warning when the user edited the view's steps.

```json patch
{
  "views": [
    {
      "id": "view:dispatch",
      "type": "sequence",
      "stepsUpdate": [
        {
          "id": "dispatch:4",
          "summary": "While attempts <= retry.maxRetries, the job goes back on the queue, delayed by backoffDelay(attempts, retry).",
          "anchors": [
            {
              "file": "src/runner.ts",
              "symbol": "Runner.dispatch",
              "span": { "from": 32, "to": 36 },
              "role": "call-site"
            },
            { "file": "src/queue.ts", "symbol": "Queue.requeue", "role": "definition" }
          ]
        }
      ]
    }
  ]
}
```

### 3.9 Tour (the guide)

The tour is what the reader sees first: its `title`, its `summary`, then its steps in order. Required: `title`, `steps`. Optional: `summary` (markdown; `null` clears it). Write one on every tour (`writing.md`, section 4).

A tour step has:

- `id` (`t1`, `t2`, ...; unique in the tour, never renumbered) and `view` (the picture the step shows);
- `focus`: element ids to highlight. A flow or sequence step id must belong to that tour step's `view`, else a warning;
- `note` (markdown): the first line is `### <plain title>`, which the viewer shows as the step title and does not repeat; then the body (`writing.md`, sections 1 and 3);
- `code`: `AnchorInput[]` that replaces the code the focus would show (base anchors too). Without it, a group, file or directory focus shows whole files (focusing `grp:retry-engine` alone shows runner.go 1-146, queue.go 1-154 and deadletter.go 1-35);
- `editor`: `primary` (the file shown first), `dimOthers`, `hideFileTree`.

How many steps, in which order, and how many code ranges: SKILL.md, "The tour".

```json patch
{
  "tours": [
    {
      "id": "tour:retries",
      "title": "How a failed job is retried",
      "summary": "The runner takes jobs from an in-memory queue and runs each one on a worker. When an attempt fails, the runner puts the job back with a growing delay. After `retry.maxRetries` retries it parks the job in a dead-letter list. This tour follows one failed job and leaves out metrics.",
      "steps": [
        {
          "id": "t1",
          "view": "view:overview",
          "focus": ["grp:scheduling"],
          "note": "### The runner decides, the queue stores\n\nTwo files do the retry work. `runner.ts` decides what happens to a finished attempt; `queue.ts` keeps the jobs and their due times.",
          "code": [
            {
              "file": "src/runner.ts",
              "symbol": "Runner.dispatch",
              "span": { "from": 25, "to": 41 },
              "role": "definition"
            },
            { "file": "src/queue.ts", "symbol": "Queue.requeue", "role": "definition" }
          ],
          "editor": { "primary": "src/runner.ts" }
        },
        {
          "id": "t2",
          "view": "view:dispatch",
          "focus": ["dispatch:2"],
          "note": "### Each pass runs one attempt\n\nThe loop leases a free worker and runs the job once, with the configured timeout.",
          "code": [
            {
              "file": "src/runner.ts",
              "symbol": "Runner.dispatch",
              "span": { "from": 18, "to": 19 },
              "role": "call-site"
            },
            { "file": "src/worker.ts", "symbol": "Worker.run", "role": "definition" }
          ],
          "editor": { "primary": "src/runner.ts" }
        },
        {
          "id": "t3",
          "view": "view:failure-path",
          "focus": ["failure-path:3", "concept:retry-policy"],
          "note": "### A failed job waits longer each time\n\nThe delay doubles with each failed attempt, up to `maxDelayMs`. The three numbers come from `config/default.yaml`.",
          "code": [
            {
              "file": "src/runner.ts",
              "symbol": "Runner.dispatch",
              "span": { "from": 31, "to": 36 },
              "role": "call-site"
            },
            { "file": "src/runner.ts", "symbol": "backoffDelay", "role": "definition" }
          ],
          "editor": { "primary": "src/runner.ts" }
        },
        {
          "id": "t4",
          "view": "view:overview",
          "focus": ["edge:job-completed"],
          "note": "### Metrics hear about jobs through the bus\n\nWhen metrics are enabled, `registerMetrics` subscribes to `job.completed`. No call links the worker and the metrics code, so this link is not in the call graph.",
          "code": [
            {
              "file": "src/worker.ts",
              "symbol": "Worker.run",
              "find": "this.bus.emit(\"job.completed\"",
              "role": "call-site"
            },
            { "file": "src/metrics.ts", "symbol": "registerMetrics", "role": "definition" }
          ],
          "editor": { "primary": "src/worker.ts" }
        }
      ]
    }
  ]
}
```

To change some steps of a tour, send `stepsUpdate` instead of the whole `steps`: `[{id, ...fields}]` is merged into the steps with those ids. The fields are a step's (`view`, `focus`, `note`, `code`, `editor`); `code` takes `AnchorInput`s and replaces that step's code; `null` clears `note`, `code` or `editor`. An id that is not a step of the tour is an error that names its steps. To add or remove a step, send `steps` whole. A new tour sends `steps`.

```json patch
{
  "tours": [
    {
      "id": "tour:retries",
      "stepsUpdate": [
        {
          "id": "t2",
          "note": "### Each pass runs one attempt\n\nThe loop leases a free worker and runs the job once. The timeout comes from the runner's config."
        }
      ]
    }
  ]
}
```

A tour has provenance like an element: what the user edits in the tour panel (`title`, `summary`, `steps`) becomes theirs (section 5), and an `llm` patch can then neither change those fields nor remove the tour. A `stepsUpdate` of a tour whose steps the user edited is skipped with a `protected` warning, like `steps`.

### 3.10 Architecture maps (system map, inside a service)

An overview reads top-down, like the C4 model: first a **system map** (the service, who uses it, what it relies on: databases, queues, other systems' APIs), then the **inside** of each service (its parts, and the outside systems each part talks to), then code. Three node fields make that work:

- `role`: what the box is. `person`, `system`, `service`, `component`, `database`, `cache`, `queue`, `storage` or `external`. The viewer gives each its own shape (a cylinder for a database, a dashed box for something outside the repo) and names the role or the `tech` on the box instead of the kind of code.
- `tech`: the technology in 1-3 words ("PostgreSQL", "REST API", "Go service").
- `opens`: the view that shows what is inside the box. The reader zooms in with the button on the box (or a double-click), and a trail above the map leads back up.

A box for something outside the repo is a group with a `role` and **no `members`**: it is not code of the repo. Anchor it at the code that talks to it (where its client is built, where its address is configured). An `llm` edge to it counts that code as the evidence at its end, so one anchor can be the evidence at both ends. `role`, `tech` and `opens` also go on overlays (`dir:`, `file:`): `{"id": "dir:services/api", "role": "service", "opens": "view:api-inside"}`. `null` clears each.

`xpl draft repo` builds both levels: it finds outside systems from the import lines (database drivers, caches, queues, HTTP clients, SDKs, web and CLI frameworks) and anchors each at its import. Those are hints: check each in the code, name the real system when the code says, and merge or drop boxes.

```json patch
{
  "nodes": [
    {
      "id": "grp:operator",
      "label": "Operator",
      "role": "person",
      "tech": "command line",
      "summary": "Starts the job runner, and may pass the path of a config file.",
      "anchors": [
        { "file": "src/main.ts", "symbol": "main", "find": "process.argv[2]", "role": "usage" }
      ]
    },
    {
      "id": "grp:jobrunner",
      "label": "Job runner",
      "role": "service",
      "tech": "Node.js",
      "opens": "view:inside",
      "summary": "Runs background jobs from an in-memory queue and retries the ones that fail.",
      "members": [
        "file:src/main.ts",
        "file:src/runner.ts",
        "file:src/queue.ts",
        "file:src/worker.ts",
        "file:src/bus.ts",
        "file:src/metrics.ts",
        "file:src/config.ts"
      ]
    },
    {
      "id": "grp:config-file",
      "label": "Config file",
      "role": "storage",
      "tech": "YAML",
      "summary": "Holds the settings: queue size, worker count, retry delays and metrics.",
      "anchors": [{ "file": "config/default.yaml", "role": "config" }]
    }
  ],
  "edges": [
    {
      "id": "edge:operator-starts",
      "from": "grp:operator",
      "to": "file:src/main.ts",
      "kind": "custom",
      "label": "starts it",
      "anchors": [
        { "file": "src/main.ts", "symbol": "main", "find": "process.argv[2]", "role": "usage" }
      ]
    },
    {
      "id": "edge:reads-config",
      "from": "file:src/config.ts",
      "to": "grp:config-file",
      "kind": "custom",
      "label": "reads settings",
      "anchors": [
        { "file": "src/config.ts", "symbol": "loadConfig", "role": "definition" },
        { "file": "config/default.yaml", "role": "config" }
      ]
    }
  ],
  "views": [
    {
      "id": "view:system",
      "type": "graph",
      "title": "The job runner, who starts it and what it reads",
      "include": ["grp:operator", "grp:jobrunner", "grp:config-file"],
      "stubs": { "mode": "none" }
    },
    {
      "id": "view:inside",
      "type": "graph",
      "title": "Inside the job runner",
      "include": [
        "grp:operator",
        "file:src/main.ts",
        "file:src/runner.ts",
        "file:src/queue.ts",
        "file:src/worker.ts",
        "file:src/bus.ts",
        "file:src/metrics.ts",
        "file:src/config.ts",
        "grp:config-file"
      ],
      "excludeFiles": ["**/test/**"],
      "stubs": { "mode": "none" }
    }
  ]
}
```

On the system map the service is one box, so the arrows of its parts are drawn there as one arrow per outside box (with the anchors of all; when their labels differ the arrow shows none). Write a tour that goes down a level at a time: a step on the system map, then the inside, then the code (SKILL.md, "explain repo"). Keep 3-7 boxes on a system map. A part with one job is a `component` only when the reader gains from the word; most boxes of code need no role.

### 3.11 `title` and `remove`

`"title"` renames the explainer. `"remove"` deletes elements, views, tours and steps by id; an unknown id is a warning, not an error. Removing what something else points at (a step a frame or tour uses, a group a view includes, a concept a tour focuses) is rejected until the same patch fixes the pointer. An `llm` patch cannot remove what the user owns: an element, view or tour with `origin: "user"` or with any `userFields` (they edited part of it), nor a single step of a view whose `steps` they edited; those ids are skipped with a `protected` warning.

## 4. Merge semantics

- **Upsert by id.** New id: create (required fields in 3.x). Existing id: shallow merge.
- **Shallow merge:** fields you send replace, fields you omit keep their value. Send `{"id": "grp:scheduling", "summary": "…"}` and `label` and `members` stay.
- **Arrays and objects replace wholesale:** `members`, `include`, `hidden`, `excludeFiles`, `participants`, `steps`, `frames`, `anchors`, `related`, `scope`, `layout`. To add one member, resend the whole list (read the current one from the explainer JSON, which you may read but never edit). The exception is a graph view's `include`, which also has `includeAdd` / `includeRemove` (3.6): no list to resend.
- **`null` clears** an optional field: `summary` (of an element or a tour), `detail`, `members`, `related`, `edgeKinds`, `hidden`, `excludeFiles`, `stubs`, `layout`, `frames` (in a `stepsUpdate` entry: a step's `summary` and `edge`). Anything else rejects `null` (`label cannot be null`), and a group without members is invalid anyway.
- **Sequence and flow `steps` are sent whole**, every step with its id. Keep ids; insert with the next free number at the right array position. Dropping a step warns (`steps … were dropped`) and then fails if a frame or tour still points at it. To change one step, use `stepsUpdate` (3.8) instead of resending the list: `[{id, ...fields}]` is merged into the steps with those ids (`anchors` replace that step's anchors, `null` clears `summary` or `edge`), after `steps` when both are sent; an id that is not a step of the view is an error; the user's edits of the view's `steps` protect it as they protect `steps`.
- **Tour `steps` are sent whole too**, or edited by id with the tour's `stepsUpdate` (3.9): `note`, `code` and `editor` take `null`.
- **The change record (`change`) is not part of a patch:** `xpl change` writes it from git.
- **Stored anchors resend verbatim**, but a `hash` in them must still equal the current text: for anchors whose code changed, resend without `hash` (or as `find`/`span`).
- **`kind` of a node and `type` of a view cannot change.**
- **Provenance is managed for you** (section 5): new elements, views and tours get `{origin: "llm", commit}`; you cannot set `origin: "user"`; user-owned elements, fields and tours are left alone.
- **Atomic.** Any error rejects the whole patch. Errors that already existed in parts of the explainer your patch did not touch are downgraded to one warning.

Real merge results (TS fixture): sending only `summary` on `grp:scheduling` keeps `label` and `members`; `{"id": "sym:src/runner.ts#Runner.dispatch", "detail": null}` removes `detail` and keeps `summary`; `"members": null` on a group is rejected with `group grp:scheduling needs members: an array of node ids`; `{"remove": ["dispatch:5"]}` is rejected with `frame toStep "dispatch:5" is not a step of view:dispatch (steps: dispatch:1, dispatch:2, dispatch:3, dispatch:4)` until the frames are fixed in the same patch.

## 5. Provenance and `userFields`

Every element, view and tour records who made it: `provenance: {origin: "static" | "llm" | "user", userFields?, commit?}`. You never write it: an `llm` patch (the default actor) creates elements with `{origin: "llm", commit: <index commit>}` and refreshes `commit` when it changes one. Passing `provenance.origin: "user"` is rejected (`an llm patch cannot create user-authored elements (origin "user")`).

The user's edits win. Real sequence on the TypeScript fixture, where the user (through the viewer, or `xpl apply --actor user`) rewrote a summary and added a concept:

```
$ xpl apply jobrunner user-edit.json --actor user
applied to .explainer/jobrunner.explainer.json (actor user): 2 ids changed
```

The stored provenance is now `{"origin": "llm", "commit": "97f70e7", "userFields": ["summary"]}` on `sym:src/runner.ts#Runner.dispatch` (a field the user edited on an llm element is listed in `userFields`) and `{"origin": "user"}` on `concept:mine`. A later `llm` patch that touches both:

```
$ xpl apply jobrunner claude.json
applied to .explainer/jobrunner.explainer.json (actor llm): 1 id changed
changed:
  sym:src/runner.ts#Runner.dispatch
issues (0 errors, 2 warnings):
warning nodes[0].summary [sym:src/runner.ts#Runner.dispatch]: summary of sym:src/runner.ts#Runner.dispatch was edited by the user and is kept as it is
warning concepts[0] [concept:mine]: concept:mine is user-authored; an llm patch cannot modify it (skipped)
```

The `detail` sent in the same node patch was applied, the `summary` kept the user's words, and the user's concept was skipped whole (`remove` of a user-authored element is skipped the same way). These warnings are correct behaviour, not failures: do not work around them (for example by re-creating the element under another id to replace the user's text). On regeneration, re-explain only `llm` elements, and never the fields in their `userFields`.

Edits made in the viewer count as the user's too. After the user drilled into a node or dragged a box under `xpl view`, the view's provenance is `{"origin": "llm", "commit": "928ad45", "userFields": ["include", "layout"]}`. An `llm` patch that resends its `include` (or sends `includeRemove`) gets `warning views[0].include [view:retry-code]: include of view:retry-code was edited by the user and is kept as it is`, and when that was all the patch did, `apply` exits 1 (see below). `includeAdd` is the way in: it only adds, so `{"views": [{"id": "view:retry-code", "type": "graph", "includeAdd": ["file:src/bus.ts"]}]}` grows the user's view and leaves their curation alone. What you cannot do to such a view, take nodes out, you tell the user; a view with `origin: "user"` takes no `llm` edit at all: put the nodes in a new graph view.

Tours follow the same rules. A tour you create gets `{origin: "llm", commit}`; once the user edits it in the tour panel its provenance lists what they touched, e.g. `{"origin": "llm", "commit": "97f70e7", "userFields": ["steps"]}` (or `title`). An `llm` patch that resends those fields gets `warning tours[0].steps [tour:retries]: steps of tour:retries was edited by the user and is kept as it is`; a `remove` of the tour is skipped (`tour:retries has fields edited by the user (steps); an llm patch cannot remove it (skipped)`); and when that was all the patch did, `apply` exits 1. A tour without provenance (an older file) counts as `llm`. To add to a talk the user has reworked, make a new tour (new slug) or ask.

**When everything is protected.** A patch whose every change was skipped because the user owns it is not "applied": `xpl apply` exits 1, names the protected ids and what to do (new view, `includeAdd`, ask the user). A patch with only some parts skipped exits 0 and ends its output with `skipped as protected (<ids>): …`. Both are correct behaviour: never work around them by re-creating the element under another id.

## 6. Reading the result

```
applied to .explainer/demo.explainer.json (actor llm): 2 ids changed
changed:
  view:dispatch
  dispatch:4
```

`changed:` must list what you meant to change: a `stepsUpdate` names the view and each step it updated (above), resending `steps` names only the view, an upsert that changes nothing is not listed (`no changes: the patch matches …`). Warnings, when there are any, follow as `issues (0 errors, 2 warnings):` (see section 5 for two real ones). Each issue line is `severity path [element id]: message`; `path` points into your patch (`views[0].steps[2].anchors[1]`). Exit code 1 = rejected, or nothing applied because the user owns everything the patch touched (section 5), 2 = usage error, 0 = applied (warnings allowed). The result, the issue list and a rejection are printed on stdout; only fatal errors (`error: patch … is not valid JSON`, no such explainer, unreadable patch file) and `warning:` lines go to stderr, so capture with `2>&1`. `--dry-run` checks without writing; `--json` gives `{ok, applied, changed, issues: [{severity, path, elementId, message, code}], protectedIds?, error?}`. `xpl apply --help` prints a summary of this format.

## 7. Rejections and how to fix them

A rejection lists **every** error of the patch at once (anchors, ids and references together), so fix them all before applying again. Messages are shortened; all are real.

| Message                                                                                                                                               | Cause                                                    | Fix                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `symbol "src/runner.ts#Runner.dispatch" not found in src/runner.ts. The symbol is the path inside the file…`                                          | id form in `anchor.symbol`                               | use `Runner.dispatch`                                                                                  |
| `symbol "Runner.dispach" not found in src/runner.ts. Did you mean: sym:src/runner.ts#Runner.dispatch (anchor: file: …, symbol: "Runner.dispatch")?`   | typo or renamed symbol                                   | copy the anchor fields it prints; the `sym:` id is for `include`, `members`, `from`/`to`               |
| `file "src/runer.ts" is not in the index`                                                                                                             | wrong path                                               | copy from `xpl outline`/`search`; run `xpl index` if the file is new                                   |
| `find text not found in src/runner.ts#Runner.dispatch (tried an exact match and one ignoring whitespace…)`                                            | text differs from the source                             | copy from `xpl show`, without the `<line> <offset>│` prefix                                            |
| `find text occurs 3 times in … (at offsets 15, 40, 44). Extend it with neighbouring text…`                                                            | `find` not unique                                        | add neighbouring text, or use `span` with one of the offsets                                           |
| `span 40..60 lies outside src/runner.ts#Runner.dispatch, which has offsets 0..46`                                                                     | wrong offsets                                            | re-read them from `xpl show` (offsets, not line numbers)                                               |
| `span 9..9 of src/runner.ts#Runner.dispatch covers only blank lines`                                                                                  | span on blank lines                                      | move it onto code                                                                                      |
| warning `span … +24..28 starts on a blank line (line 66): probably off by one, the code in it starts at line 67 (offset 25)…`                         | span edge on a blank line (or `ends on`)                 | applied as written, likely one line off: read `xpl show` / `xpl anchors`, resend the anchor            |
| `anchor has both span and find; give exactly one of them`                                                                                             | both given                                               | keep one                                                                                               |
| `anchor.role must be one of definition, call-site, usage, config, test (got "callsite")`                                                              | bad role                                                 | fix the spelling                                                                                       |
| `stale anchor for …: given hash sha256-v2:… but the current text hashes to sha256-v2:…`                                                               | you sent a `hash` of older code                          | drop `hash`                                                                                            |
| `llm edge edge:x needs at least one anchor inside its to (file:src/metrics.ts): a place in src/metrics.ts. Evidence…`                                 | no anchor at one end                                     | add the missing end (subscription site, handler definition); never delete the claim's evidence to pass |
| `step dispatch:1: file:src/queue.ts is not a participant of view:dispatch; add it to participants…`                                                   | step end not among `participants`                        | add it to `participants` (resend the whole list) or use an existing participant                        |
| `step id "step1" must look like "<view-slug>:<n>", e.g. "t:1"`                                                                                        | free-form step id                                        | `<view-slug>:<n>`                                                                                      |
| `step dispatch:9 is not a step of view:dispatch (its steps: dispatch:1, …)` at `views[0].stepsUpdate[0].id`                                           | `stepsUpdate` names a step the view lacks                | copy an id from the message (a step of another view says so); a new step goes in `steps`, sent whole   |
| `stepsUpdate changes steps that exist already, and view:x is a new view…`                                                                             | `stepsUpdate` on a view the patch creates                | send `steps` whole                                                                                     |
| `step "dispatch:2" appears twice in stepsUpdate (also at stepsUpdate[0]); merge the two entries`                                                      | two entries for one step                                 | one entry per step, with its `id`; in `stepsUpdate` only `summary` and `edge` take `null`              |
| warning `stepsUpdate of view:dispatch was skipped: its steps were edited by the user…`                                                                | the user owns the view's `steps`                         | not an error: tell the user, or put the change in a new view                                           |
| `frame toStep "dispatch:9" is not a step of view:dispatch (steps: dispatch:1, …)`                                                                     | frame points at a missing step                           | fix the id, or update `frames` in the same patch when you remove steps                                 |
| `focus: no step dispatch:9 in view:dispatch (its steps: …)` / `tour step view "view:x" is not a view of this explainer. Did you mean: view:dispatch?` | tour points at something absent                          | fix the id (the message names close ones), or add the view/step first (same patch is fine)             |
| `include: "src/runner.ts" is not an element id; did you mean file:src/runner.ts?`                                                                     | path instead of element id                               | `file:src/runner.ts`                                                                                   |
| `unknown file "src/nope.ts" (not in the index).` at `views[0].includeAdd[1]`                                                                          | an id of `includeAdd` is checked like an `include` entry | copy ids from `xpl outline`; an `includeRemove` id may be one that vanished                            |
| `file:src/queue.ts is in both includeAdd and includeRemove of view:overview; give it to one of them`                                                  | contradicting edit                                       | keep it in one list                                                                                    |
| `include: ghost:rest:file:src/main.ts is not a node (expected repo, dir:, file:, sym: or grp:)`                                                       | a ghost id in `include` / `includeAdd`                   | add what it stands for, or `file:src/main.ts` (the whole file); ghost ids only go in `hidden`          |
| `unknown field "includeAdd" (allowed: id, type, title, …)`                                                                                            | `includeAdd` / `includeRemove` on a sequence view        | they only exist on graph views (sequence views resend `participants` and `steps`)                      |
| `stubs.mode must be one of "top", "all", "none"` / `stubs.max must be a whole number, 0 or more`                                                      | bad stub policy                                          | `{"mode": "top", "max": 8}` is the default                                                             |
| `excludeFiles must be an array of glob patterns on repo-relative paths, e.g. ["**/*_test.go", "**/test/**"]`                                          | wrong type                                               | an array of strings                                                                                    |
| warning `glob pattern "/src/**" is matched against repo-relative POSIX paths …`                                                                       | leading `/` or `./`, or a backslash                      | `src/**`, with `/` as the separator                                                                    |
| `member: unknown file "src/quue.ts" (not in the index).`                                                                                              | wrong id                                                 | copy ids from `xpl outline`                                                                            |
| `new node grp:queueing needs "members"` / `new view view:g needs "title"` / `new … needs "include"`                                                   | required field missing on create                         | see the "Required" line of the template                                                                |
| `node id "group:queueing" must be "dir:<path>", "file:<path>", "sym:<file>#<symbol>", "repo" or "grp:<slug>"`                                         | wrong prefix                                             | `grp:`                                                                                                 |
| `group id "grp:Retry Path" has an invalid slug…`                                                                                                      | space or symbol in slug                                  | lowercase kebab-case                                                                                   |
| `view slug "file" is reserved (its step ids would be ambiguous)`                                                                                      | slug collides with an id prefix                          | pick another slug                                                                                      |
| `sym:src/runner.ts#Runner.dispach does not exist in the index; only existing files, directories and symbols can be given a stored overlay`            | overlay on a missing node                                | fix the id                                                                                             |
| `unknown field "description" (allowed: id, kind, label, summary, detail, parent, members, anchors, provenance)`                                       | field not in the schema                                  | use an allowed field (`summary`, `detail`)                                                             |
| `label cannot be null (null clears only: summary, detail, members)`                                                                                   | `null` on a required field                               | send a string, or omit                                                                                 |
| `edge … overlays a derived edge, so its kind, from and to must match the id`                                                                          | contradicting fields                                     | omit `kind`/`from`/`to`, or make them match                                                            |
| `cannot change type of view:overview from "graph" to "sequence"`                                                                                      | reused a view id                                         | new slug                                                                                               |
| `entry point "sym:src/…" is not a symbol id in the index (form: "src/a.ts#Class.method")`                                                             | `sym:` prefix in `scope.entryPoints`                     | drop `sym:`                                                                                            |
| `an llm patch cannot create user-authored elements (origin "user")`                                                                                   | `provenance.origin: "user"`                              | omit `provenance`                                                                                      |
| `id "concept:x" appears twice in the patch (also at concepts[0]); merge the two entries`                                                              | duplicate id                                             | merge                                                                                                  |
| `unknown patch field "node" (allowed: title, nodes, edges, concepts, views, tours, remove)`                                                           | typo in a top-level key                                  | fix                                                                                                    |
| warning `nothing to remove: no element, view, tour or step has the id concept:retry-polcy. Did you mean: concept:retry-policy?`                       | `remove` of an id that does not exist                    | fix the id: it is only a warning, and `changed:` will not list it                                      |
| warning `tours[0].steps [tour:retries]: steps of tour:retries was edited by the user and is kept as it is`                                            | the user edited the tour                                 | not an error: make a new tour (new slug) or ask; a `remove` of it is skipped too                       |
| `error: patch … is not valid JSON: Expected ',' or '}' after property value in JSON at position 49 (line 2 column 1)`                                 | broken JSON (fatal, on stderr)                           | fix the syntax at that position                                                                        |

## 8. Repairing after code changes

`xpl resolve <name> --write` (after `xpl index`) marks every anchor `ok`, `moved` (span updated automatically), `drifted` (text changed) or `missing`. A drifted anchor stays drifted until you resend it: re-read the code (`xpl anchors <name> <id>` shows what the anchor points at now), resend the element with fresh anchors (no `hash`) and a summary that matches the new code. A missing anchor means the symbol is gone or renamed: its message says where the code went when it can tell (`the anchored lines now sit in sym:… (anchor: file: …, symbol: …, span: {from, to})`, or a same-sized symbol as a `did you mean`); report it to the user and ask before re-anchoring or removing; never drop one silently or retarget it to something merely similar. Never change a field listed in `userFields`, and never touch `origin: "user"` elements: `xpl status` counts their drift apart, for the user. Ids that vanished from a view (`xpl status`: broken references) are fixed with `includeRemove`, or by resending `members` / `participants` / `steps` without them. To repair **one step**, use `stepsUpdate` (3.8): the other steps stay as they are.

1. `xpl anchors <name> dispatch:4` shows what the step's anchors point at now (`xpl status` names the drifted steps);
2. rewrite the drifted or missing anchors from `xpl show` output (`find` or `span`, no `hash`), and the summary if the new code says something else;
3. send `{"views": [{"id": "view:…", "type": "sequence", "stepsUpdate": [{"id": "dispatch:4", "summary": "…", "anchors": [ … ]}]}]}`. The `anchors` replace the step's, so list every one you keep, the unchanged ones too (without `hash`, or as `find`/`span`).

Resend a view's `steps` whole only when the list itself changes (a step added, removed or reordered).
