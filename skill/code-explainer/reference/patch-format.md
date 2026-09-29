# Patch format

Everything you write goes into one JSON **patch**. `xpl apply <name> patch.json` (or `-` for stdin) merges it into `.explainer/<name>.explainer.json`, fills in hashes and resolved ranges, validates the result, and either writes everything or nothing.

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

Every key is optional; any other top-level key is rejected. The authoritative merge rules are in the header of `packages/core/src/patch.ts`; this file is the practical version of them, and every JSON block below marked `patch` is real: applied in order to a fresh explainer on the TypeScript fixture it passes `xpl validate` (a test of the repository does exactly that). `xpl apply --help` prints a compact summary of the format.

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

Forms you will use (all verified against the TS fixture):

| You want to point at              | Write                                                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| a whole function, class or method | `{"file": "src/queue.ts", "symbol": "Queue.requeue", "role": "definition"}`                                     |
| one call inside a function        | `{"file": "src/runner.ts", "symbol": "Runner.dispatch", "find": "await this.queue.pop()", "role": "call-site"}` |
| a block inside a function         | `{"file": "src/runner.ts", "symbol": "Runner.dispatch", "span": {"from": 34, "to": 36}, "role": "call-site"}`   |
| a config key (YAML/JSON key path) | `{"file": "config/default.yaml", "symbol": "retry.maxRetries", "role": "config"}` (`retry` = the whole block)   |
| a whole file (tests, docs)        | `{"file": "test/retry.test.ts", "role": "test"}`                                                                |
| lines of a symbol-less file       | `{"file": "test/retry.test.ts", "span": {"from": 53, "to": 65}, "role": "test"}` (offset = line − 1)            |
| text in a file without symbols    | `{"file": "README.md", "find": "A failed one is requeued", "role": "usage"}`                                    |

`find` anchors exactly the lines its text touches: a one-line `find` on the first line of a three-line call anchors one line. For a whole call or block use `span` (`+34..36` from `show --refs`) or a multi-line `find`. Prefer `find` for one-line call sites (it checks itself) and `span` for blocks (copy the numbers, never compute them). `symbol` can point at any indexed symbol, including class fields and config keys (`xpl outline --keys`).

## 2. Ids

| Form                                                            | What                             | Notes                                                                                                                                              |
| --------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repo`, `dir:<path>`, `file:<path>`, `sym:<file>#<symbol path>` | structural nodes, from the index | paste from `xpl outline`. Used in `include`, `members`, `participants`, step `from`/`to`, `focus`, `related`, edge `from`/`to`, and as overlay ids |
| `grp:<slug>`                                                    | group                            | you choose the slug once                                                                                                                           |
| `concept:<slug>`                                                | concept                          |                                                                                                                                                    |
| `edge:<slug>`                                                   | your `llm` edge                  |                                                                                                                                                    |
| `edge:<kind>:<from>-><to>`                                      | a derived (static) edge          | store one only to label/explain it (3.4). Ends are what the view shows (`xpl status --json` lists the ids)                                         |
| `view:<slug>`, `tour:<slug>`, `frame:<slug>`                    | view, tour, frame                | a view slug must not be a reserved word (`dir file sym grp concept edge view tour frame ghost stub`)                                               |
| `<view-slug>:<n>`                                               | sequence step (`dispatch:3`)     | unique in the whole explainer; **never renumber**; array order is display order                                                                    |
| `t1`, `t2`, …                                                   | tour step                        | any string unique inside the tour                                                                                                                  |
| `scope.entryPoints[]`                                           | `<file>#<symbol path>`           | **no** `sym:` prefix                                                                                                                               |

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
      "summary": "The hot loop: pop a job, lease a worker, run it, then ack, requeue with backoff or dead-letter.",
      "detail": "Runs until `stop()` is called. An empty queue means a short sleep (`idleDelayMs`).\n\nThe retry decision lives in the last third of the loop; see the retry-policy concept."
    },
    {
      "id": "file:src/queue.ts",
      "label": "Queue",
      "summary": "In-memory priority queue with an in-flight set, requeue-with-delay and a dead-letter list."
    }
  ]
}
```

Participants of a sequence view and the boxes of a graph view count as "unexplained" (`xpl status`) until they have a `summary`, so write overlays for them.

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
      "summary": "Worker.run publishes job.completed on the event bus and metrics.ts subscribes to that topic, so the two files never reference each other.",
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

Required: `label`. Anchor the implementing code, the config keys and the tests; `related` lists elements to co-highlight (any element id).

```json patch
{
  "concepts": [
    {
      "id": "concept:retry-policy",
      "label": "Retry policy",
      "summary": "A failed job is requeued with exponential backoff (baseDelayMs * 2^(attempt-1), capped at maxDelayMs) until retry.maxRetries requeues are used, then dead-lettered.",
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

Required: `type: "graph"`, `title`, `include`. `scope` defaults to `{"root": "repo", "depth": 1}`; record the question and depth you used. `include` is the source of truth for what is drawn; a node whose children are also included renders as a container; calls between shown nodes are derived (`edgeKinds` picks which kinds: default `calls`, `extends`, `implements`; also `imports`, `references`, `reads`, `writes`). Edges leaving the view become dashed stubs to ghost boxes. `hidden` removes nodes or derived edges you do not want (`layout` pins positions; leave it to the user). `excludeFiles` (below) drops the references of test files from the derived edges and stubs.

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

`excludeFiles` is a list of globs on repo paths: `**` crosses directories, `*` stays inside one path segment, `?` is one character, and a pattern without a `/` also matches the file name at any depth. Derived edges and stubs are computed without the references that start or end in a matching file, so an edge that exists only through test files disappears (and the others count only their remaining references). Nodes in `include` always show, the edges of a file or symbol you include by name stay, stored (`llm`/`user`) edges are never filtered. Use it on overviews:

```json patch
{
  "views": [
    {
      "id": "view:overview",
      "type": "graph",
      "excludeFiles": ["**/*_test.go", "**/test/**", "**/tests/**", "**/*.test.*", "**/test_*.py"]
    }
  ]
}
```

### 3.7 Sequence view (steps, frames)

Required: `type: "sequence"`, `title`, `participants` (lifelines, left to right), `steps`. Every step needs `id` (`<view-slug>:<n>`), `from`, `to` (both must be participants), `label` (the call text), `kind` (`call` solid arrow, `return` dashed back to the caller, `async` open head), and should have `summary` and anchors: the exact call in the caller (`call-site`) plus the callee's definition. `edge` links a step to the edge it instantiates. A step's `from` may equal `to` (self-call). Frames (`loop`, `alt`, `opt`, `par`) wrap the run `fromStep`..`toStep` (inclusive); nest them or keep them apart (a partial overlap draws a warning).

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
          "summary": "Failures come back as { ok: false, error }, never as exceptions, so the runner decides what to do next.",
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

### 3.8 Tour (presentation)

Required: `title`, `steps`. A tour step: `id`, `view`, `focus` (node, edge, concept or sequence-step ids; a sequence step must belong to that tour step's `view`, else a warning), optional `note` (markdown speaker note), `code` (`AnchorInput[]` that replaces the focus's own code; a group, file or directory focus shows whole files, so give those steps a `code` override: focusing `grp:retry-engine` alone shows runner.go 1-146, queue.go 1-154 and deadletter.go 1-35), `editor` (`primary` file shown first, `dimOthers`, `hideFileTree`). Tours have no provenance and can be re-sent freely.

```json patch
{
  "tours": [
    {
      "id": "tour:retries",
      "title": "How a failed job is retried",
      "steps": [
        {
          "id": "t1",
          "view": "view:overview",
          "focus": ["grp:scheduling"],
          "note": "Start with the big picture: the runner and the queue are one responsibility, scheduling.",
          "code": [
            { "file": "src/runner.ts", "symbol": "Runner.dispatch", "role": "definition" },
            { "file": "src/queue.ts", "symbol": "Queue.pop", "role": "definition" }
          ]
        },
        {
          "id": "t2",
          "view": "view:dispatch",
          "focus": ["dispatch:2"],
          "note": "The runner leases a worker and runs one attempt. Failures come back as values.",
          "editor": { "primary": "src/runner.ts" }
        },
        {
          "id": "t3",
          "view": "view:dispatch",
          "focus": ["dispatch:4", "concept:retry-policy"],
          "note": "A failed attempt is requeued with exponential backoff until the retry budget is spent.",
          "editor": { "primary": "src/runner.ts", "dimOthers": true }
        },
        {
          "id": "t4",
          "view": "view:overview",
          "focus": ["edge:job-completed"],
          "note": "Successes are announced on the event bus, which is why metrics never appear in the call graph.",
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

### 3.9 `title` and `remove`

`"title"` renames the explainer. `"remove"` deletes elements, views, tours and steps by id; an unknown id is a warning, not an error. Removing what something else points at (a step a frame or tour uses, a group a view includes, a concept a tour focuses) is rejected until the same patch fixes the pointer. An `llm` patch cannot remove what the user owns: an element or view with `origin: "user"` or with any `userFields` (they edited part of it), nor a single step of a view whose `steps` they edited; those ids are skipped with a `protected` warning.

## 4. Merge semantics

- **Upsert by id.** New id: create (required fields in 3.x). Existing id: shallow merge.
- **Shallow merge:** fields you send replace, fields you omit keep their value. Send `{"id": "grp:scheduling", "summary": "…"}` and `label` and `members` stay.
- **Arrays and objects replace wholesale:** `members`, `include`, `hidden`, `excludeFiles`, `participants`, `steps`, `frames`, `anchors`, `related`, `scope`, `layout`. To add one member, resend the whole list (read the current one from the explainer JSON, which you may read but never edit). The exception is a graph view's `include`, which also has `includeAdd` / `includeRemove` (3.6): no list to resend.
- **`null` clears** an optional field: `summary`, `detail`, `members`, `related`, `edgeKinds`, `hidden`, `excludeFiles`, `layout`, `frames`. Anything else rejects `null` (`label cannot be null`), and a group without members is invalid anyway.
- **Sequence `steps` are sent whole**, every step with its id. Keep ids; edit a step by resending the list with that step changed; insert with the next free number at the right array position. Dropping a step warns (`steps … were dropped`) and then fails if a frame or tour still points at it.
- **Stored anchors resend verbatim**, but a `hash` in them must still equal the current text: for anchors whose code changed, resend without `hash` (or as `find`/`span`).
- **`kind` of a node and `type` of a view cannot change.**
- **Provenance is managed for you** (section 5): new elements get `{origin: "llm", commit}`; you cannot set `origin: "user"`; user-owned elements and fields are left alone.
- **Atomic.** Any error rejects the whole patch. Errors that already existed in parts of the explainer your patch did not touch are downgraded to one warning.

Real merge results (TS fixture): sending only `summary` on `grp:scheduling` keeps `label` and `members`; `{"id": "sym:src/runner.ts#Runner.dispatch", "detail": null}` removes `detail` and keeps `summary`; `"members": null` on a group is rejected with `group grp:scheduling needs members: an array of node ids`; `{"remove": ["dispatch:5"]}` is rejected with `frame toStep "dispatch:5" is not a step of view:dispatch (steps: dispatch:1, dispatch:2, dispatch:3, dispatch:4)` until the frames are fixed in the same patch.

## 5. Provenance and `userFields`

Every element and view records who made it: `provenance: {origin: "static" | "llm" | "user", userFields?, commit?}`. You never write it: an `llm` patch (the default actor) creates elements with `{origin: "llm", commit: <index commit>}` and refreshes `commit` when it changes one. Passing `provenance.origin: "user"` is rejected (`an llm patch cannot create user-authored elements (origin "user")`).

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

**When everything is protected.** A patch whose every change was skipped because the user owns it is not "applied": `xpl apply` exits 1, names the protected ids and what to do (new view, `includeAdd`, ask the user). A patch with only some parts skipped exits 0 and ends its output with `skipped as protected (<ids>): …`. Both are correct behaviour: never work around them by re-creating the element under another id.

## 6. Reading the result

```
applied to .explainer/demo.explainer.json (actor llm): 1 id changed
changed:
  view:dispatch
```

Warnings, when there are any, follow as `issues (0 errors, 2 warnings):` (see section 5 for two real ones). Each issue line is `severity path [element id]: message`; `path` points into your patch (`views[0].steps[2].anchors[1]`). Exit code 1 = rejected, or nothing applied because the user owns everything the patch touched (section 5), 2 = usage error, 0 = applied (warnings allowed). `--dry-run` checks without writing; `--json` gives `{ok, applied, changed, issues: [{severity, path, elementId, message, code}], protectedIds?, error?}`. `xpl apply --help` prints a summary of this format.

## 7. Rejections and how to fix them

Messages are shortened; all are real.

| Message                                                                                                                                             | Cause                                                    | Fix                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `symbol "src/runner.ts#Runner.dispatch" not found in src/runner.ts. The symbol is the path inside the file…`                                        | id form in `anchor.symbol`                               | use `Runner.dispatch`                                                                                  |
| `symbol "Runner.dispach" not found in src/runner.ts. Did you mean: sym:src/runner.ts#Runner.dispatch (anchor: file: …, symbol: "Runner.dispatch")?` | typo or renamed symbol                                   | copy the anchor fields it prints; the `sym:` id is for `include`, `members`, `from`/`to`               |
| `file "src/runer.ts" is not in the index`                                                                                                           | wrong path                                               | copy from `xpl outline`/`search`; run `xpl index` if the file is new                                   |
| `find text not found in src/runner.ts#Runner.dispatch (tried an exact match and one ignoring whitespace…)`                                          | text differs from the source                             | copy from `xpl show`, without the `<line> <offset>│` prefix                                            |
| `find text occurs 3 times in … (at offsets 15, 40, 44). Extend it with neighbouring text…`                                                          | `find` not unique                                        | add neighbouring text, or use `span` with one of the offsets                                           |
| `span 40..60 lies outside src/runner.ts#Runner.dispatch, which has offsets 0..46`                                                                   | wrong offsets                                            | re-read them from `xpl show` (offsets, not line numbers)                                               |
| `span 9..9 of src/runner.ts#Runner.dispatch covers only blank lines`                                                                                | span on blank lines                                      | move it onto code                                                                                      |
| `anchor has both span and find; give exactly one of them`                                                                                           | both given                                               | keep one                                                                                               |
| `anchor.role must be one of definition, call-site, usage, config, test (got "callsite")`                                                            | bad role                                                 | fix the spelling                                                                                       |
| `stale anchor for …: given hash sha256:… but the current text hashes to sha256:…`                                                                   | you sent a `hash` of older code                          | drop `hash`                                                                                            |
| `llm edge edge:x needs at least one anchor inside its to (file:src/metrics.ts): a place in src/metrics.ts. Evidence…`                               | no anchor at one end                                     | add the missing end (subscription site, handler definition); never delete the claim's evidence to pass |
| `step dispatch:1: file:src/queue.ts is not a participant of view:dispatch; add it to participants…`                                                 | step end not among `participants`                        | add it to `participants` (resend the whole list) or use an existing participant                        |
| `step id "step1" must look like "<view-slug>:<n>", e.g. "t:1"`                                                                                      | free-form step id                                        | `<view-slug>:<n>`                                                                                      |
| `frame toStep "dispatch:9" is not a step of view:dispatch (steps: dispatch:1, …)`                                                                   | frame points at a missing step                           | fix the id, or update `frames` in the same patch when you remove steps                                 |
| `focus: no step with id dispatch:3 in this explainer` / `tour step view "view:nope" is not a view of this explainer`                                | tour points at something absent                          | fix the id, or add the view/step first (same patch is fine)                                            |
| `include: "src/runner.ts" is not an element id; did you mean file:src/runner.ts?`                                                                   | path instead of element id                               | `file:src/runner.ts`                                                                                   |
| `unknown file "src/nope.ts" (not in the index).` at `views[0].includeAdd[1]`                                                                        | an id of `includeAdd` is checked like an `include` entry | copy ids from `xpl outline`; an `includeRemove` id may be one that vanished                            |
| `file:src/queue.ts is in both includeAdd and includeRemove of view:overview; give it to one of them`                                                | contradicting edit                                       | keep it in one list                                                                                    |
| `unknown field "includeAdd" (allowed: id, type, title, …)`                                                                                          | `includeAdd` / `includeRemove` on a sequence view        | they only exist on graph views (sequence views resend `participants` and `steps`)                      |
| `excludeFiles must be an array of glob patterns on repo-relative paths, e.g. ["**/*_test.go", "**/test/**"]`                                        | wrong type                                               | an array of strings                                                                                    |
| warning `glob pattern "/src/**" is matched against repo-relative POSIX paths …`                                                                     | leading `/` or `./`, or a backslash                      | `src/**`, with `/` as the separator                                                                    |
| `member: unknown file "src/quue.ts" (not in the index).`                                                                                            | wrong id                                                 | copy ids from `xpl outline`                                                                            |
| `new node grp:queueing needs "members"` / `new view view:g needs "title"` / `new … needs "include"`                                                 | required field missing on create                         | see the "Required" line of the template                                                                |
| `node id "group:queueing" must be "dir:<path>", "file:<path>", "sym:<file>#<symbol>", "repo" or "grp:<slug>"`                                       | wrong prefix                                             | `grp:`                                                                                                 |
| `group id "grp:Retry Path" has an invalid slug…`                                                                                                    | space or symbol in slug                                  | lowercase kebab-case                                                                                   |
| `view slug "file" is reserved (its step ids would be ambiguous)`                                                                                    | slug collides with an id prefix                          | pick another slug                                                                                      |
| `sym:src/runner.ts#Runner.dispach does not exist in the index; only existing files, directories and symbols can be given a stored overlay`          | overlay on a missing node                                | fix the id                                                                                             |
| `unknown field "description" (allowed: id, kind, label, summary, detail, parent, members, anchors, provenance)`                                     | field not in the schema                                  | use an allowed field (`summary`, `detail`)                                                             |
| `label cannot be null (null clears only: summary, detail, members)`                                                                                 | `null` on a required field                               | send a string, or omit                                                                                 |
| `edge … overlays a derived edge, so its kind, from and to must match the id`                                                                        | contradicting fields                                     | omit `kind`/`from`/`to`, or make them match                                                            |
| `cannot change type of view:overview from "graph" to "sequence"`                                                                                    | reused a view id                                         | new slug                                                                                               |
| `entry point "sym:src/…" is not a symbol id in the index (form: "src/a.ts#Class.method")`                                                           | `sym:` prefix in `scope.entryPoints`                     | drop `sym:`                                                                                            |
| `an llm patch cannot create user-authored elements (origin "user")`                                                                                 | `provenance.origin: "user"`                              | omit `provenance`                                                                                      |
| `id "concept:x" appears twice in the patch (also at concepts[0]); merge the two entries`                                                            | duplicate id                                             | merge                                                                                                  |
| `unknown patch field "node" (allowed: title, nodes, edges, concepts, views, tours, remove)`                                                         | typo in a top-level key                                  | fix                                                                                                    |
| `patch … is not valid JSON: Expected ',' or '}' after property value in JSON at position 49 (line 2 column 1)`                                      | broken JSON                                              | fix the syntax at that position                                                                        |

## 8. Repairing after code changes

`xpl resolve <name> --write` (after `xpl index`) marks every anchor `ok`, `moved` (span updated automatically), `drifted` (text changed) or `missing`. A drifted anchor stays drifted until you resend it: re-read the code (`xpl anchors <name> <id>` shows what the anchor points at now), resend the element with fresh anchors (no `hash`) and a summary that matches the new code. A missing anchor means the symbol is gone or renamed: its message says where the code went when it can tell (`the anchored lines now sit in sym:… (anchor: file: …, symbol: …, span: {from, to})`, or a same-sized symbol as a `did you mean`); report it to the user and ask before re-anchoring or removing (see SKILL.md, "After the code changed"). Ids that vanished from a view (`xpl status`: broken references) are fixed with `includeRemove`, or by resending `members` / `participants` / `steps` without them. Because arrays replace, repairing one step means resending all steps of that view:

1. copy the view's `steps` out of `.explainer/<name>.explainer.json`;
2. delete `hash` and `resolved` from every anchor of the steps you keep unchanged (or leave them if that code did not change);
3. rewrite the broken anchors from `xpl show` output;
4. send `{"views": [{"id": "view:…", "type": "sequence", "steps": [ … ]}]}`.
