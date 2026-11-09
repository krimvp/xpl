# CLI reference

## Install

Install the CLI and the skill, and set up each agent: [Create a guide](create.md#install).

`<skill dir>/bin/xpl <command> [options]` (below: `xpl`). Run it from the root of the repo you are explaining, or pass `--root <dir>`. Samples come from `fixtures/ts-jobrunner` (a tiny job runner, indexed as `wt-0db7e190f5`) and are trimmed, not edited.

**Global options** (every command)

| Option            | Meaning                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| `--root <dir>`    | repository root (default: current directory)                                                                       |
| `--json`          | machine-readable output (`{"ok": true, ...}`; errors as `{"ok": false, "error": "..."}`)                           |
| `--index <path>`  | symbol index to use (default: the guide's own index, else the index of the current commit id, else the newest one) |
| `-h`, `--help`    | help for the command; `xpl help` lists all                                                                         |
| `-v`, `--version` | print the version                                                                                                  |

**Exit codes:** 0 ok · 1 rejected or failed · 2 usage error. Exit 1 covers a bad id, a rejected patch, `resolve --write` on a stale index, validation errors, `lint` findings and `bundle` with drifted or missing anchors. It also covers a patch that changed nothing because the user owns everything it touches.
**Streams:** results, issue lists and rejections print on stdout (a rejection also exits 1). Fatal errors (`error: ...`: unknown id, no index, bad JSON, unreadable file) and `warning:` lines go to stderr, so use `2>&1` to capture both. With `--json` there is one object on stdout, errors included (`{"ok": false, "error": ...}`).
**Environment:** `XPL_CLI` is the path of an `xpl.mjs` that the launcher runs instead of the installed CLI binding or development build. `XPL_NO_UPDATE_CHECK=1` skips doctor's npm registry request. `XPL_VIEWER_HTML` is the viewer page for `view` and `bundle`. `XPL_SKIP_STALE_CHECK=1` skips the advisory freshness checks; strict validation and export still check. `XPL_SCIP_TIMEOUT_MS` is the time limit of each SCIP indexer (default 10 minutes). `XPL_WASM_DIR` is where the tree-sitter `.wasm` files are. `XPL_DEBUG=1` prints stack traces.

**Ids** are accepted loosely: `sym:src/a.ts#A.b`, `src/a.ts#A.b`, `file:src/a.ts`, `src/a.ts`, `dir:src`. The outputs always print the exact `sym:`/`file:`/`dir:` form: paste those into patches.

**Staleness.** When the working tree changed since the index was built, commands print ``warning: index … does not match the working tree (wt-…): 2 changed (src/queue.ts, src/runner.ts). Line numbers and offsets may be off; run `xpl index`…``. Re-index before anchoring anything.

---

## `xpl completion <bash|zsh|fish>`

Prints shell completion for command names, command and global options, and local guide names at
`<explainer>` arguments. The command and option lists come from the same CLI tables as `--help`.
Guide names are read from `.explainer/*.explainer.json` under `--root`, or the current directory
when `--root` is omitted. Global options may appear before the command.

Add `source <(xpl completion bash)` to `~/.bashrc`, or `source <(xpl completion zsh)` to
`~/.zshrc` after `compinit`. For fish, run
`xpl completion fish > ~/.config/fish/completions/xpl.fish`. Generate the script again after
updating xpl so its command and option lists stay current. `--json` returns the script as
`{ "ok": true, "shell": "...", "script": "..." }`.

---

## `xpl doctor [--agent none|claude|codex|pi|droid|devin] [--skill-dir <folder>]`

Diagnoses installed setup without downloading tools or starting authoring. Node >=22.12, artifact hashes
and grammar loading are mandatory. Skill availability is optional by default; selecting an agent requires
its managed skill. An older installed skill is marked `outdated` and names `xpl skill install` as recovery.
A skill newer than the CLI is marked `mismatch`; update the CLI to the skill's version or newer.
For Claude, Codex, Pi and Droid, diagnosis also checks the local agent command. Devin
checks project skill files; its cloud discovery and authentication cannot be checked locally. Optional
git/npx/Go checks run local version commands. Go uses the installed toolchain, ignores user Go
configuration and disables telemetry without writing settings; Git tracing is disabled. No Python or SCIP
tool launcher runs during diagnosis. Doctor requests the latest `@krimvp/xpl` version from npm with a
1.5-second timeout. It reports a newer version and the update command; failed requests are silent.
`XPL_NO_UPDATE_CHECK=1` skips the request. Other commands do not query npm.
Missing precise prerequisites suggest `xpl index --precise off`; automatic precise mode may
bootstrap tools and dependencies over the network. Presence is not a test of precise analysis,
agent authentication or provider access. Required failures exit 1; JSON includes `ok`, `platform`,
`agent`, `checks` (`id`, `required`, `status`, `detail`, `recovery`) and `network`.

## `xpl skill install [--agent claude|codex|pi|droid|devin] [--dir <path>]`

Copies the bundled code-explainer skill to the selected agent's default skill directory, or the chosen
directory, and binds `bin/xpl` to this installed CLI. `claude` is the default and installs to
`~/.claude/skills/code-explainer`; `codex`, `pi` and `droid` install to `~/.agents/skills/code-explainer`;
`devin` installs to the current project's `.agents/skills/code-explainer`.
Rerun after updating or moving the CLI. Refuses symlinks,
unmanaged directories, added files and locally edited skill files; move them aside first to preserve them.
The launcher prints one warning when its recorded skill version differs from the CLI package it runs.
It recommends skill reinstall for an older skill and a CLI update for a newer skill.
The CLI package bundles the skill and launcher. Install and configure the selected agent separately;
the installer does not verify provider access or live invocation behavior. Invoke the skill as
`$code-explainer` in Codex, `/skill:code-explainer` in Pi, `/code-explainer` in Factory Droid, or
`@skills:code-explainer` in Devin. Devin cloud discovery and authentication are not verified by xpl.
In Devin, run `xpl skill install --agent devin` inside the connected remote environment and target repo
before using the launcher. Install Node >=22.12 and xpl there first. This writes the absolute CLI binding;
there is no PATH fallback. A local install does not provision xpl in Devin's remote environment.
Local reading, `index --precise off`, viewing and HTML export use bundled assets after setup.
Precise tools/dependencies and agent authoring can have separate network requirements.

## `xpl index [--precise auto|off|require] [--commit <c>] [--no-cache] [--scip <artifact|manifest.json>] [--verbose]`

An interactive terminal shows phases and file counts on stderr. Redirected stderr gets one line before each
SCIP tool runs (`index: running scip-go for precise references ...`), and `--json` gets none. Ctrl+C stops
between files or phases and stops SCIP subprocesses, then exits with code 130. Until the new index is
complete, the old one stays (or there is none). A rename that has started may finish; an index is never
half replaced. Extraction cache entries that are done may stay.

Builds `.explainer/index-<commit>.json` (and `.explainer/.gitignore` with `index-*.json` and `cache/`). The commit id is the short HEAD when the repo root is a clean git top-level, else `wt-<hash>` of the files. Files: `git ls-files` (or a walk that skips `node_modules`, `dist`, dot-dirs…), text only, ≤ 1 MB.
The output reports excluded candidates by reason, with up to three root-relative paths per reason (xpl's own `.explainer/` folder is left out of the report).
`--json` returns the same counts in `exclusions`. Git-ignored files are not listed by git; without git,
files inside skipped directories and symlinks are not enumerated. Those files are not counted.

```
$ xpl index
index written: .explainer/index-wt-0db7e190f5.json
commit: wt-0db7e190f5  files: 12  symbols: 160  refs: 314

json        2 files    23 symbols    refs: none
text        1 file     0 symbols     refs: none
typescript  8 files    121 symbols   refs: precise (scip-typescript@0.4.0)
yaml        1 file     16 symbols    refs: none
```

Repeated builds reuse file-local tree-sitter pack, Rust, Ruby and PHP tags facts from `.explainer/cache`. Source discovery,
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

Under the table, one plain line names each language whose references are matched by name
(`typescript: references matched by name; some can be missing.`), whose symbols come from tags (`rust: some
symbols can be missing (partial extraction).`), or that has no symbols (`text: file only; no
symbols or references.`). A failed analysis is always printed. `--verbose` also prints scoped extraction
hits/misses and wall milliseconds, fresh heuristic-resolution time and semantic runs/time. `--json` includes
`extraction` (`enabled`, `scope`, `hits`, `misses`, `writeFailures`, `wallMs`, optional `bypassReason`) and
`work` (`heuristicResolutionMs`, `semanticMs`, `semanticRuns`). The text summary also prints a cache bypass
reason or failed cache writes. Plain text without an extractor counts as neither a hit nor a miss.
Measurements cover analysis stages, not CLI startup or index serialization. They are not saved in the
index or in exported viewers. Removing `.explainer/cache` reclaims old content entries; `--no-cache`
leaves them untouched.

With `--verbose`, the summary is followed by **Analysis coverage** and per-capability outcomes labeled by
analysis provider (`supported`, `partial`, `unsupported`, `failed`) with analyzed file counts and limits.
`--json` includes the same `analysis` reports as the saved index. Abilities are separate from observed coverage:
a described file or empty reference list never proves complete relationships. Exported viewers keep the report even when their
symbol index is pruned. Legacy indexes without reports load with coverage unknown; file anchors remain
available, but symbol and relationship completeness cannot be inferred.
Provider labels separate a file-only fallback's limits from an artifact provider's usable symbols.
Tool commands and diagnostic details are omitted from these summaries.

- The last column says how much you can trust a language's references:
  - `refs: precise (tool)`: SCIP resolved them (TypeScript, Python, Go).
  - `refs: heuristic`: tree-sitter scope-aware guesses, drawn dashed in the viewer; confirm calls with `show`.
  - Java (heuristic): the built-in pack follows calls through locals, parameters and fields of a known type,
    and bare calls to methods of the same or an outer class. Overloads, ambiguous names, inherited fields and
    runtime dispatch can make a target incomplete or wrong.
  - Rust (heuristic): declarations (struct and union fields and enum variants included), lexical nesting, some
    calls (to functions and to methods on a known type) and the `mod` and `use` imports inside the crate.
    Tuple positions and macro-generated members have no symbol. A body with macros or local imports, or a file
    with syntax errors, gives no calls. No macro expansion or cfg evaluation runs.
  - `refs: none`: Ruby, PHP, yaml, json, toml and text with no SCIP file given.
  - Ruby tags give partial named classes, modules, methods and constants, and no relationships. A qualified
    owner needs a class or module declared before it in the same file.
  - PHP tags give partial named namespaces, classes, interfaces, traits, functions, methods and constants with
    lexical nesting, and no relationships.
- `refs: precise 10/11 (scip-go@0.2.7), 1 heuristic`: the tool described only 10 of the 11 files (build-tagged Go files, files a project's own configuration excludes). Those files keep heuristic references, so **their references are hints**; a warning above the summary names them: `warning: scip-go@0.2.7 did not describe 1 file(s) (excluded by build constraints or by the tool's own configuration, or unreadable?); their references stay heuristic: internal/queue/windows_only.go`.
- `--precise auto` (default) falls back to heuristic with a warning, e.g. ``warning: precise resolver "scip-go" failed (scip-go@v0.2.7 could not be started (is `go` installed and on PATH?): spawn go ENOENT); using heuristic references for go``. `off` never runs SCIP (faster); syntax packs, including Java, still run. `require` exits 1 instead of falling back.
- A file with syntax errors is indexed anyway. One warning covers all such files, with the first lines to look at: `warning: 1 file(s) have syntax errors; symbols near these lines may be incomplete: src/broken.ts:2` (at most 5 files and 3 lines each). Errors that cannot have cost a symbol (a TS labeled tuple element such as `[symbol: string]`) are not reported.
- Reference kinds: `call import extends implements type-ref read write request`. A `request` is a web request (`fetch("/api/orders")`, `axios.post(...)`, `requests.get(...)`, `http.Get(...)`) whose method and path match a route the repository defines. The routes come from Express, Koa, Hono, Fastify, Next.js route files and `pages/api`, FastAPI, Flask, net/http, chi, gin and echo. A request points at the route's handler. For an inline handler it points at the symbol around it (the module scope `<file>#` at the top level). Request references are always heuristic: a matching path does not prove which server answers. A `read` is a use of a module- or package-level variable or constant, or of a field whose type is known, that is not a call or an assignment (`this.config.retry`, `LIMIT`). The built-in syntax and tool adapters leave out locals and parameters. Artifact imports can keep role-backed references to checked local declarations. A TS `import type` and a Python `import` under `TYPE_CHECKING` are `type-ref`, not `import`: `import` references are runtime dependencies.
- Symbols beyond declarations: config keys (`kind: key`) of yaml, json and toml files (`config/default.yaml#retry.maxRetries`, `pyproject.toml#project.scripts.flask`). TS test blocks are symbols too: statement-level `describe`/`suite`/`context`/`it`/`test` calls with a string title. Their path is the nested titles (`test/retry.test.ts#fails twice, then succeeds: acked after two requeues`; `.` and `#` in a title become `_`). Test blocks can be anchored and outlined but nothing references them by name.
- Re-run after every code change. Guides bound to an older index print ``hint: 1 guide (jobrunner) is bound to another index; run `xpl resolve <name> --write` to move it to this one.``

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

`--scip` selects the artifact provider instead of automatic SCIP tools. Registered syntax providers,
including Java, still run first. Existing syntax symbol sets survive partial or range-less artifacts; matching
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

Java files are code and appear in `search --code` and repository drafts. The built-in grammar pack provides
symbols and heuristic references; inspect those references against source because overloads, ambiguous names,
and inherited or runtime dispatch can leave targets incomplete or wrong. `--precise off` still runs the Java
pack. xpl does not run a Java SCIP producer automatically. To add compiler-produced facts, generate a
source-checked SCIP manifest with a configured Java build, then pass it with `--scip <manifest.json>`.
Only facts matched to checked source declarations and supported relationships are imported; inspect the
analysis report for omissions.

Rust tags are experimental. They give declarations, heuristic calls in a few forms, and the imports of `mod`
declarations and of `use` paths inside the package (`crate::`, `self::`, `super::` or the crate's own name).
Read the coverage line that `xpl index` prints for Rust before you write graph claims; `--verbose` and About
this guide give the whole report. xpl has no Rust SCIP import: plain `xpl index` needs no flag, and
`--precise require` fails.

Ruby tags also report partial declarations. They capture class, module, method and constant syntax. Qualified
class, module and assignment targets need a preceding same-file owner declaration; unknown owners and
metaprogrammed declarations are omitted. All relationships remain unavailable. `--precise off` still runs them;
`--precise require` fails without a Ruby precise provider. Ruby files appear in `search --code` and repository drafts,
and their source opens as plain text in the viewer.

PHP tags also report partial declarations. Semicolon-style namespaces extend through their following
top-level declarations until the next namespace. Anonymous and generated declarations are omitted, as
are calls, imports, inheritance and dynamic dispatch. `--precise off` still runs the tags;
`--precise require` fails without a PHP precise provider. PHP appears in `search --code` and repository
drafts, and its source opens as plain text in the viewer.

## `xpl outline [--under <id>] [--depth <n>] [--kind <k,...>] [--keys] [--limit <n>]`

One line per element: `<id>  <kind>  <first>-<last line>  in=<fan-in> out=<fan-out>`. `in`/`out` count references into and out of the element's subtree (calls, imports, type uses, reads), so high numbers mark hubs. A symbol's calls of itself stay inside it and do not count. `recursive` after the counts marks a symbol that calls itself (`"recursive": true` in `--json`). `[+n]` = n children below the depth limit. Default depth 2, or deeper until a code file shows (a Maven `src/main/java/<package>`), `--limit 400` lines. A chain of folders that each hold only one folder is one row (`dir:src/main/java/app`) and one level. Config keys (yaml, json, toml) are hidden unless `--keys`. `--kind method,function` lists only symbols of those kinds (`class interface function method type variable enum key other`, and Go's `struct` and `field`; repeat or comma-separate) together with the dirs, files and parent symbols that hold a match, so each keeps its place; with `--kind` and no `--depth` it searches every level. A field of a class, interface, object `type` or Go struct shows as `field`, and a Go struct as `struct`, where the index stores `variable` and `class` (`--json` keeps the stored kind, and `--kind struct,field` works too); a method on `T` or `*T` is `sym:<file>#T.Method`. Ruby modules and PHP namespaces show as `other`; a constant in a class shows as `field`. The `repo` line carries the name `xpl new` records (from `package.json`, `go.mod`, `pyproject.toml`, `Cargo.toml`, `pom.xml`, the git remote), not the directory's.

```
$ xpl outline --depth 1
repo  ts-jobrunner  12 files, 160 symbols
  dir:config  dir  1 file  in=0 out=0  [+1]
  dir:src  dir  7 files  in=41 out=0  [+7]
  dir:test  dir  1 file  in=0 out=41  [+1]
  file:README.md  text  1-45  in=0 out=0
  file:package.json  json  1-15  in=0 out=0  [11 keys hidden]
  file:tsconfig.json  json  1-15  in=0 out=0  [12 keys hidden]

$ xpl outline --under file:src/runner.ts --kind method
file:src/runner.ts  typescript  1-110  in=10 out=35
  sym:src/runner.ts#Runner  class  12-93  in=8 out=30
    sym:src/runner.ts#Runner.constructor  method  22-27  in=0 out=8
    sym:src/runner.ts#Runner.start  method  30-34  in=2 out=4
    sym:src/runner.ts#Runner.stop  method  37-40  in=2 out=2
    sym:src/runner.ts#Runner.dispatch  method  42-88  in=1 out=37
    sym:src/runner.ts#Runner.log  method  90-92  in=3 out=1
  sym:src/runner.ts#RunnerStats  class  96-105  in=4 out=3
    sym:src/runner.ts#RunnerStats.record  method  101-104  in=1 out=6

$ xpl outline --under file:test/retry.test.ts --kind function
file:test/retry.test.ts  typescript  1-90  in=0 out=41
  sym:test/retry.test.ts#runOne  function  38-52  in=2 out=14
  sym:test/retry.test.ts#fails twice, then succeeds: acked after two requeues  function  54-66  in=0 out=4
  sym:test/retry.test.ts#always fails: dead-lettered after maxRetries requeues  function  68-79  in=0 out=10
  ...

$ xpl outline --under file:config/default.yaml --keys
file:config/default.yaml  yaml  1-21  in=0 out=0
  sym:config/default.yaml#queue  key  3-6  in=0 out=0
    sym:config/default.yaml#queue.name  key  4-4  in=0 out=0
    ...
  sym:config/default.yaml#retry  key  13-16  in=0 out=0
    sym:config/default.yaml#retry.maxRetries  key  14-14  in=0 out=0
```

## `xpl show <id> [--refs] [--context <n>] [--lines <a-b>] [--max-lines <n>]` · `xpl show --at base <path> [--lines <a-b>] [--explainer <name>]`

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

## `xpl refs <id> [--in|--out] [--kind <k>] [--depth <n>] [--max-children <n>] [--limit <n>] [--tests]`

The reference list of `show --refs`, as a hierarchy. `--out` (default): what the element uses; `--in`: who uses it. `--kind` (repeatable or comma-separated): `call import extends implements type-ref read write request`. For a file/dir the references that stay inside are left out, and each line names the referencing symbol (`+82 in sym:…`). Heuristic references are hints.

- `--depth n` expands each other end in turn (a call hierarchy). A subtree is printed once: an element expanded above is marked `(expanded above)` and not expanded again. The exception: an element met first on the last levels and later nearer the top is expanded at the higher place instead. An element with nothing below it is never marked. `(cycle)` marks an ancestor.
- `--max-children n` (default 15, `0` = all) lists at most n references under each line of a hierarchy, the subject's own list included (`--depth 2` or more); the rest are counted as `... +8 more (--max-children 0 lists all)`. A plain `refs` (depth 1) is the whole answer: only `--limit` (default 200 lines) cuts it.
- `--kind read` finds who reads a variable, constant or typed field (`refs <field> --in --kind read`: the readers of a config switch); `--kind call` on a function is the call hierarchy without the field accesses.
- `--kind request` on a route handler (`--in`) lists the code that sends it web requests; on a client function (`--out`), the handlers its requests reach.
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
file:src/runner.ts (typescript) src/runner.ts:1-110
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

**Interfaces are transparent.** A call to an interface method ends at a declaration without a body (Go `JobQueue.Requeue`), so `--out` continues with what runs. Under a `call` (or `type-ref`, `read`, `write`) of an interface, or of a method or property of one, it lists the implementations as `impl  <id>  (<file>:<lines>, <resolution>)` lines. They come from the `implements` references of the index: a TS `implements` clause, Go's implicit interface satisfaction, or the member-level references of a precise index. The same-named members of the implementing types join them (a Go method declared in another file of the package is found too). `--depth n` expands an `impl` in place of the declaration (its own calls appear below it) and costs no depth. Implementations in test files (`*_test.go`, `test/`, `*.test.*`, `test_*.py`, …: test doubles) are left out, counted in a closing note, and listed with `--tests` (they are listed anyway under a call that itself sits in a test file). More than 10 under one line are cut (`--limit 0` lists all). The same interface method called twice is listed once (`(expanded above)`).

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

Base classes (TS, JS, Python; not Go, whose embedding does not dispatch) are hopped as `override` lines. Under a call, `--out` lists the subclass methods that override the callee: the call may run any of them. `--in` lists the base method a method overrides, with that method's callers below it (`plus 1 via base class`); constructors are not hopped. Test subclasses are counted, not listed, unless `--tests`. `--json`: `{ok, id, depth, kinds, out|in: [entry...], totals, moreChildren, truncated, hiddenTestImplementations, hiddenTestOverrides}`. An entry is `{kind, id, from, to, file, site, offset, resolution, note?, moreChildren?, children?}` (`note`: `seen` for `(expanded above)`, `cycle`). An `impl` or `override` entry has `kind: "impl"` or `"override"`: `from` is the implementing (overriding) symbol, `to` the implemented one, and `id`/`file`/`site` the symbol the line shows. `hiddenTestImplementations` counts the test doubles left out. `moreChildren` counts the references a `--max-children` cap left out (top level: under the subject).

## `xpl search <pattern> [--regex] [-i] [--limit <n>] [--under <dir|glob>] [--code]`

Line-by-line search of the working-tree text of every indexed file (substring, case-sensitive; `--regex` = JavaScript regex; `-i` ignores case). Hit: `<file>:<line>  <enclosing symbol id> +<offset>  <line text>`; outside every symbol it names the file (offset = line − 1). Code files come first, then config (yaml, json, toml), then docs and other text, so the first hits (`--limit`, default 50) are the code; the total is always counted. `--code` drops everything that is not code; Java (`.java`), Rust (`.rs`) and Ruby (`.rb`) and PHP (`.php`) are included. `--under` keeps the search inside a directory, file or symbol (`dir:src/flask`, `src/flask/`, `file:src/app.py`, `sym:src/app.py#Flask`) or a glob on repo paths (`'tests/**'`, `'src/*.py'`); repeat it or comma-separate for several. The total is counted inside the scope.

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
when there is no recorded view scope. The list does not say whether a guide is ready or up to date: run
`xpl ready` or `xpl status <name>` for that.

`--json`: `{ok, guides: [{id, path, title, audience?, questions[], roots[], kind, commit, indexCommit,
change?: {base, head}}], errors: [{id, error}]}`. A guide with bad metadata is still listed, by its file
(`{id, path, metadataError}`), and reported in `errors`. An empty title stays empty.
Each guide is read from its discovered path, even when its name matches another repository JSON file.
Read or metadata errors exit 1. With no guide, it says how to make one with `xpl start` and exits 0. No
files are written.

## `xpl update <explainer> [--since <rev>] [-o <file>] [--precise auto|off|require]`

After work on the code, brings a map guide (`xpl draft map`) up to date in one run: `xpl index`, `xpl resolve <explainer> --write`, `xpl change <explainer> <rev>..HEAD` when `--since` is given (the work must be committed), then `xpl draft map <explainer>`. The draft holds only what changed (boxes for new files, the removal of boxes whose code is gone, a moved file keeping its text) and, with the change recorded, a tour of the changed files. Nothing is applied: write the TODOs, lint and apply as usual. Without `-o` the draft goes to a new folder outside the repository. A failing step stops the run with its own message; the steps before it stay done. To keep a map current after every session of an AI assistant, run it at the end of the session (for example from the assistant's stop hook) with `--since` set to the commit the session started from.

```
$ xpl update shop --since HEAD~1 -o map.json
index: built; shop moved to it
change: 5c1e0a2 since 9f3b7d4, 1 file
draft: /work/map.json
  1 new box, 1 tour step, 7 TODOs to write
note: 4 code files on 2 maps; 0 files left off (tests, examples, fixtures, docs, benchmarks, playgrounds, templates, demos and sandboxes)
next: write each TODO, then `xpl lint shop --patch /work/map.json` and `xpl apply shop /work/map.json`
```

`--json`: `{ok, resolved: <resolve report>, change: <change result> | null, draft: {out, counts, notes}}`.

## `xpl start <name> --question <question> --audience <reader> [--entry <symbol>] [--precise auto|off|require]`

Creates a first guide in one command. It runs `index`, `new`, `draft` and `apply`, using the same source anchor checks as manual authoring. Without `--entry`, the draft is a repository map, not the path that answers the question. The output says so, and names a function to start that path at, with the `xpl draft path` command to run. The function is a guess from the question's words, ranked by the words in its name and code. With an indexed function or method such as `src/runner.ts#Runner.dispatch`, it is a call sequence from that entry. The applied guide contains TODO text and can be opened with `xpl view <name>`; complete and check the text before sharing. The patch and all draft notes are saved in a temporary directory outside the repository. The text output shows up to three notes and apply warnings; `--json` includes their full lists. The `xpl draft path` command is named once, in the last note. Existing guides are never overwritten.

```
$ xpl start job-retries --question "How does a failed job get retried?" --audience maintainers --precise off
created .explainer/job-retries.explainer.json for maintainers
draft patch: /tmp/xpl-first-guide-…/draft.patch.json
draft notes: /tmp/xpl-first-guide-…/draft-notes.json
note: the draft guesses the kind of project, its users and its entry points from the code and its import lines: check each in the README and the code
note: settings files the code loads (from the index): `config/default.yaml`; check that the code reads each at run time
note: room is left for 2 more steps (9 at most), the main path and its risks
note: drafted an overview of the whole repository, not the path that answers the question (no --entry). To draft that path, run `xpl draft path job-retries sym:src/runner.ts#Runner.dispatch -o <file>` (a guess from the question's words), or pass --entry next time.
next: write the TODOs in /tmp/xpl-first-guide-…/draft.patch.json and run `xpl apply job-retries /tmp/xpl-first-guide-…/draft.patch.json`, then `xpl lint job-retries`. `xpl view job-retries` also edits the step notes (Edit > Edit the tour) and box texts (Edit text), not the titles or the tour summary
```

`--precise off` uses heuristic references; confirm calls against source before completing the explanation. `--json` returns the guide and draft paths, `drafted` (`repo` or `path`), `suggestedEntry` (without `--entry`, when a function matches), notes file, notes and apply warnings.

## `xpl new <name> [--title <title>] [--repo <name>] [--url <url>]`

Creates an empty `.explainer/<name>.explainer.json` bound to the selected index. Refuses to overwrite (`error: … already exists; not overwriting it`). It records a repository name (`repo.name`, the label of the repo box): `--repo`, else the first of these. The `package.json` `name`, the last element of the `go.mod` module (`example.com/acme/jobrunner/v2` gives `jobrunner`), `[project] name` in `pyproject.toml`, `[package] name` in `Cargo.toml`, the project's `artifactId` in `pom.xml`, the base name of the git remote (`origin`, else the first), the directory name. `--url` records where the repository lives; it is never taken from the git remote (which may carry credentials).

```
$ xpl new jobrunner --title "Job runner"
created .explainer/jobrunner.explainer.json (title "Job runner", index .explainer/index-wt-0db7e190f5.json, commit wt-0db7e190f5)
repo: ts-jobrunner (package.json)
next: `xpl draft path|repo|map|data|... jobrunner -o <file>` drafts the structure; write its TODOs, then `xpl apply jobrunner <file>`
```

`--json` adds `repo: {name, source, url?}`.

## `xpl apply <explainer> <patch.json|-> [--actor llm|user] [--dry-run]`

Validates and applies a patch (format: `patch-format.md`; `xpl apply --help` prints a summary of it). Atomic: nothing is written on any error. `-` reads stdin. `--dry-run` checks and lists what would change. Default actor `llm`: never modifies `origin: "user"` elements or `userFields`, and never removes an element that carries `userFields` (skipped with a `protected` warning). Exit 1 = rejected.

**A rejection lists every error of the patch at once**: apply checks anchors, ids and references in one pass, so fix them all before applying again. An element whose anchor failed is still checked for its other problems. Checks that depend on the failed anchor, like the evidence an `llm` edge needs at both ends, wait until it is fixed. Warnings that matter now are listed with them. A span that starts or ends on a blank line is most likely off by one (the message gives the offset where the code starts or ends). An id that names nothing carries `Did you mean: ...`. Results and rejections print on stdout; fatal errors (`error: patch … is not valid JSON`, unknown explainer, unreadable patch file) go to stderr.

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

## `xpl validate [explainer] [--lenient]`

For `validate`, `lint`, `ready`, `bundle`, `status`, `view`, `anchors` and `draft`, omit the name when the
repository has exactly one guide. xpl prints `using <name>` on stderr. If there are several, choose a listed name; if there are none,
create one with `xpl new <name>`. Commands that write an explainer (`apply`, `change`, `new`, `resolve`)
still require an explicit name; their hints print it (`run xpl resolve jobrunner --write`).

`xpl validate` needs an index of the working tree. A stale index is an error, also with
`XPL_SKIP_STALE_CHECK=1`; `--lenient` makes it a warning. Run `xpl index`, resolve against the new index,
and read the text of what changed again. The anchor checks find the code and see if it changed. They do not
check that the text is true.

Strict by default: ids, references, anchors (must resolve `ok` or `moved`), the evidence rule for `llm` edges. `--lenient` turns drifted/missing anchors and vanished ids into warnings (for inspecting after `resolve --write`). Exit 1 on errors.

```
$ xpl validate jobrunner
ok: .explainer/jobrunner.explainer.json is valid (strict, index wt-0db7e190f5); no errors, no warnings
$ xpl validate jobrunner            # after the code changed and `resolve --write`
.explainer/jobrunner.explainer.json (strict, index wt-3fa2f32c4b): 5 errors, 0 warnings
error   concepts[1].anchors[0] [concept:mine]: anchor src/queue.ts#Queue.requeue drifted: text of src/queue.ts#Queue.requeue changed (expected sha256-v2:2313a7a99ec8, now sha256-v2:ba9e3c066ce0). This element is user-authored, so an llm patch cannot change it (it is skipped): tell the user, or fix it with `xpl apply --actor user`.
error   views[1].steps[0].anchors[1] [dispatch:1]: anchor src/queue.ts#Queue.pop is missing: symbol Queue.pop is not in src/queue.ts. Did you mean: sym:src/queue.ts#Queue.take (anchor: file: "src/queue.ts", symbol: "Queue.take")? Re-anchor it to where the code went, or drop it (resend the element without this anchor, or remove the element).
error   views[1].steps[3].anchors[1] [dispatch:4]: anchor src/queue.ts#Queue.requeue drifted: text of src/queue.ts#Queue.requeue changed (expected sha256-v2:2313a7a99ec8, now sha256-v2:ba9e3c066ce0). Re-read the code and rewrite the anchor (and the explanation that depends on it).
...
```

## `xpl anchors [explainer] [<id> ...] [--full] [--max-lines <n>]`

Shows what an explainer's anchors point at, so you can verify spans without reading the JSON. It prints each anchor of every element with stored anchors (node overlays, edges, concepts, sequence steps, the `code` overrides of tour steps). Each anchor shows its role, `file#symbol`, span, status (`ok`, `moved`, `drifted`, `missing`) and resolved lines, then the code at those lines as `<line> <offset>│ code`. The offsets are the ones `xpl show` prints and a `span` uses, so a wrong span is visible at once. Status and lines are resolved now, against the index the explainer is bound to and the working tree; when the explainer file's cached lines differ, a note says so (`run xpl resolve <name> --write`).

A long anchor is cut to 12 lines (`--max-lines n`; `--full` or `--max-lines 0` prints all). It shows its first lines, a `... N lines elided (a-b)` line with the `xpl show … --lines a-b` that reads them, and its **last** lines: the end of a span is where an off-by-one hides.

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

After the code changed, the same command reads the anchors that need attention. A `drifted` span shows the code where the span used to sit (marked approximate: re-read it). A `missing` one shows its reason and no code; when the anchored lines or a same-sized symbol are found elsewhere, the reason says where the code went. A header says `anchors owned by the user` for an element whose anchors the user edited (an llm patch cannot change them).

`--json`: `{ok, path, index, maxLines, anchors: {total, counts}, elements: [{id, type, view?, origin?, userFields?, derived?, focus?, noCode?, anchors: [{path, role, file, symbol?, span?, where, status, stored?, range?, approximate?, reason?, lines?: [{line, offset, text}], moreLines?, elided?: {startLine, endLine}, derived?, from?}]}], withoutAnchors?}`. A tour step has `type: "tour-step"`; `derived: true` marks a step (and its ranges) that comes from `focus`, `from` is the focused element a range comes from.

## `xpl resolve [explainer] [--write] [--allow-stale]`

Re-resolves every anchor (elements, steps, tour code overrides) against the index of the current code (`--index`, else the current commit id, else the newest), ignoring the explainer's own old index. With one guide in the repository, leave out its name. `moved` = same text, new lines (span updated); `drifted` = text changed; `missing` = symbol gone. Prints the counts, the **drifted llm elements** (re-explain those, except `userFields`; a step names its view) and the **missing anchors** (ask the user). A missing anchor's reason says where the code went when it can tell: a span whose text now sits in another symbol, a renamed symbol of the same size, or the same name elsewhere (test files last). `--write` saves the new ranges and the index binding; drifted anchors stay drifted until their element is resent.

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
missing code links (2): fix or remove each one
  dispatch:1  views[1].steps[0].anchors[1]  src/queue.ts#Queue.pop [definition]
    symbol Queue.pop is not in src/queue.ts. Did you mean: sym:src/queue.ts#Queue.take (anchor: file: "src/queue.ts", symbol: "Queue.take")?
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

The skill's to-do list, read-only: per view, the shown nodes, participants, stored edges and steps without a `summary` (and the ids of the static edges without one, which you need to overlay them). A summary that still starts with `TODO` counts as none, and the `to do` total counts each id once. Per graph view, where it stops (its ghosts and stubs); concepts without a summary; the tours, and each tour without a summary; drifted llm elements; missing anchors; **broken references**; stale arrow overlays; requests queued by the viewer. Static edges are optional. `status` reads the explainer through the index it is bound to: after manual `xpl index`, run `xpl resolve <name> --write` first so that it sees the new code. A running watcher supplies the current index without saving the guide.

- The `to do:` line counts drift the user owns apart: `4 changed code links (1 user-owned: ask the user)`. User-owned = an element that is not llm-authored, or an llm element whose anchors (or, for a step, whose view's `steps`) the user edited: an llm patch cannot repair those.
- `outside this map: 2 dashed boxes for 7 arrows (stubs: top 6), most referenced: ghost:file:src/main.ts ×23, ...`: the graph view draws 2 ghost boxes, with 7 stubs (dashed edges) leading to them; `stubs: top 6` is the view's stub policy (the default is `top 8`); `×23` is how many references lead to that ghost. Above 12 ghosts a warning follows the line. `--json` lists every ghost (`views[].ghosts.list[]`: `{id, kind: target|rest|more, label, count, direction, targets: [{id, count}]}`, most referenced first) with all the elements it stands for in `targets` (most referenced first; a `target` ghost has just itself), and every stub id (`views[].ghosts.stubIds`), with `mode`, `max`, `total`, `stubs` and `crowded`.
- Folded ghosts stand for several elements and are named by what they fold:
  - `ghost:more:out ×8` ("+8 more"): the ghosts beyond the cap.
  - `ghost:rest:file:src/main.ts ×1` ("rest of main.ts"): the outside symbols of a file the view shows in part.
  - A folded ghost is not an element (it cannot be `include`d), but its id and the stub ids go in `hidden`.
  - Each folded ghost gets a line under `ghosts:` with the elements it stands for (`ghost:rest:file:src/runner.ts ×6 → sym:src/runner.ts#Runner.log ×3, ...`): up to 3 ids with their reference counts, most referenced first, then `... +N more`. `includeAdd` one of them. A ghost that is one element (`ghost:file:x`) gets no such line.
- `tours (n)`: each tour with its step count, and the steps whose `focus` ids or `view` no longer exist (`1 step points at something that is gone: t2 (focus: sym:src/queue.ts#Queue.pop)`). Fix them with the tour's `stepsUpdate` (that step's `view` and `focus`). If the user edited the tour, make a new one instead.
- `broken references (n)`: ids that no longer exist in the index (lenient validation): the overlay of a deleted symbol, an `include`, `members`, `related` or `participants` entry, a step end, a tour's `focus`. The line `, n broken references` is appended to `to do:` only when there are some.
- `warning: stale arrow overlays (n)`: stored `edge:<kind>:<a>-><b>` text for arrows found in the code that no map draws any more (their ids follow the view's `include`, or the code changed). They are ignored until written again on a current id; hidden arrows do not count.
- `--view <id>`: only that view, and what it draws. A graph view lists each arrow (`edge:calls:...  calls  grp:ky → grp:fetch  ×2  found in the code  "label"  no summary`: id, kind, ends, references, `stored` or `found in the code` (`found in the code (stored text on it)` when you overlaid it), label, whether it has a summary), most references first, then each id in its `hidden` with the arrow it takes out. A hidden id that is no arrow says what it is: a box, a stub, a ghost box, or nothing (remove it). It can also be a stored edge that is part of another arrow between the same boxes on this map: hiding it does nothing, so hide that arrow. A flow lists the links between its steps (`(back to the caller)` for a return without a step); a sequence its messages. `--json`: `{path, view: {...the view's status, edges: {drawn, hidden} | {links}}}`.

```
$ xpl status ky --view view:system
view:system (graph): ky between your app and the web
  boxes: 4
  arrows drawn (3: 3 stored, 0 found in the code), most references first:
    edge:app-ky  calls  grp:your-app → grp:ky  ×1  stored  "ky.get(), ky.post()"
    edge:fetch-http-api  custom  grp:fetch → grp:http-api  ×1  stored  "HTTP requests"
    edge:ky-fetch  calls  grp:ky → grp:fetch  ×1  stored  "hands over requests"
  hidden (2):
    edge:engine-fetch  calls  grp:ky → grp:fetch  ×2  stored  no summary
    edge:timing-fetch  (a stored edge that is no arrow of its own here: on this map it is part of another arrow between the same boxes, or its ends are not on it; hiding it does nothing, hide that arrow instead)
  outside this map: none drawn (stubs: none)
```

```
$ xpl status jobrunner
.explainer/jobrunner.explainer.json: index wt-3fa2f32c4b, 2 views, 3 concepts
to do: 5 with no text, 3 changed code links (1 user-owned: ask the user), 2 missing code links, 2 requests

view:overview (graph): Runner, queue, workers and metrics
  boxes without summary (4 of 6): file:src/config.ts, file:src/metrics.ts, file:src/runner.ts, file:src/worker.ts
  arrows: 3 shown; every stored arrow has text; 1 found in the code without summary (optional): edge:calls:file:src/runner.ts->file:src/queue.ts
  outside this map: 2 dashed boxes for 7 arrows (stubs: top 6), most referenced: ghost:file:src/main.ts ×23, ghost:file:src/bus.ts ×2

view:dispatch (sequence): How a job is dispatched, and what happens when it fails
  participants without summary (1 of 3): sym:src/worker.ts#Worker
  steps: all 5 have text

tours (1):
  tour:retries (4 steps): every focus id resolves

anchors: 24 (ok 19, moved 0, drifted 3, missing 2)
drifted llm elements to re-explain (2):
  dispatch:4  (step in view:dispatch)
    ...
drifted, but not llm-owned (left alone) (1):
  concept:mine  (origin user)  concepts[1].anchors[0]
missing code links (2): fix or remove each one
  dispatch:1  views[1].steps[0].anchors[1]  src/queue.ts#Queue.pop [definition]
    symbol Queue.pop is not in src/queue.ts. Did you mean: sym:src/queue.ts#Queue.take (anchor: file: "src/queue.ts", symbol: "Queue.take")?
  ...

requests queued by the viewer (2; record selected outcomes with xpl feedback --outcomes):
  2026-09-29T12:14:26.518Z  expand file:src/config.ts  (in view:overview)  [config.ts]  "how is the yaml parsed?"
  2026-09-29T12:14:26.535Z  sym:src/queue.ts#Queue
```

A view that stops in too many places (here a file that uses 16 modules, with `"stubs": {"mode": "all"}`):

```
view:main (graph): main
  boxes without summary (1 of 1): file:src/main.ts
  arrows: 0 shown; every stored arrow has text
  outside this map: 16 dashed boxes for 16 arrows (stubs: all), most referenced: ghost:file:src/m1.ts ×1, ghost:file:src/m10.ts ×1, ghost:file:src/m11.ts ×1, ghost:file:src/m12.ts ×1, ghost:file:src/m13.ts ×1, ... +11 more (--json lists all, and the stub ids)
  warning: 16 dashed boxes outside this map: this view stops in too many places to read (more than 12). Set "stubs": {"mode": "top"} (what a view without "stubs" does: the 8 most referenced ghosts, the rest folded), put ghost ids in "hidden" (`status --json`: views[].ghosts.list), or add "excludeFiles"
```

A view with folded ghosts (`"stubs": {"mode": "top", "max": 3}` on a view of `Runner.dispatch` and `Queue.requeue`). The other symbols of `runner.ts` and `queue.ts` fold into one ghost each, and the ghost beyond the third into `ghost:more:in`. Each folded ghost lists what it stands for:

```
view:dispatch-code (graph): Runner.dispatch and its neighbours
  boxes without summary (2 of 2): sym:src/queue.ts#Queue.requeue, sym:src/runner.ts#Runner.dispatch
  arrows: 1 shown; every stored arrow has text; 1 found in the code without summary (optional): edge:calls:sym:src/runner.ts#Runner.dispatch->sym:src/queue.ts#Queue.requeue
  outside this map: 4 dashed boxes for 5 arrows (stubs: top 3), most referenced: ghost:rest:file:src/runner.ts ×6, ghost:file:src/worker.ts ×3, ghost:rest:file:src/queue.ts ×3, ghost:more:in ×1
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
# Then run /code-explainer feedback in your agent.
xpl feedback myguide --outcomes /tmp/outcomes.json
xpl feedback myguide --export /tmp/results.json
```

Exports use `{schema: "code-explainer/feedback@1", requests: [...]}`. Each request has `id`, `elementId`,
`kind: correct|explain|expand`, `at`, a fixed `context: {explainerHash, sourceHash}`, optional `note`,
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

The text output lists each request as `<id>  <status>  <question|correction|more detail> <element>`, then
the reader's note in quotes, then what the author did (not for a pending request). It names an outdated
context only for a request still open (pending or unresolved), and tells you to start the skill only while
one is open. `--import` keeps one of two requests that ask the same thing (same guide, element, kind, note,
code range and snapshot) under different ids, as a reader who clicks Save twice makes.

Inspection reports `contextStatus: current|outdated` and `contextReason` separately from the stored
outcome. A changed explanation/source snapshot or stale source needs explicit reconciliation; it is never
silently rebound to the newer guide. Legacy records lacking a snapshot are unbound and outdated.
Keep feedback exports/outcome input files outside the source tree so they do not stale the index.

## `xpl revise <explainer> --select <id,id> | --run <id>`

See [revise.md](revise.md) for how to act on reader feedback. `--select` keeps the ids and context of the
requests you pick. It checks that the code has not changed and resolves in memory. `--include <id,id>` names
the other ids the revision may change or add. `-o /tmp/review.json` saves the code and the text before and
after, for review. The text output names each selected request with its context and, under it, the
reader's note in quotes.

`--run <id> --proposal /tmp/proposal.json` reviews `[{id, patch}]` using ordinary apply patches as `llm`.
`--decisions /tmp/decisions.json` reviews one `{id, status, reason, reconciliation?, missing?}` per selected
request; only `addressed` patches enter the candidate. Accepted outdated context needs a reconciliation
reason. Missing owners need `missing: [{id, action: "reanchor"|"remove"}]`. Location-only moves use `{}`.
Neither review writes the guide or outcomes. Show the exact decision review before explicit `--accept`.

Before `--accept` writes anything, it checks four things: the guide and code are the ones reviewed, the
working tree has not changed, the picked requests have not changed, and the guide passes `xpl ready`.
`.explainer/revisions/<id>/previous.json` keeps the old guide; `run.json` keeps the reviewed code and what
the commit was meant to do. After an interruption, run the same `--run <id> --accept` again: each change
and each outcome is recorded once. New/unselected feedback survives. A wholly
declined batch records reasons without changing the guide. Historical `--run <id>` inspection works after
source changes. After a killed process, remove only reported locks whose writers have stopped.

`--json` emits `{ok, runId, state, expected, index, previousArtifact, requests, include, resolve, decisions,
changes, source, issues, readiness?}`. `changes` contains `{id, before, after}`; `source` contains
`{file, side, text}` from the review snapshot. States: selected, proposed, reviewed, committing, committed,
done. Readiness blockers remain visible in a review (exit 0), but `--accept` refuses them (exit 1). Rejected
patches, scope/identity/freshness conflicts and malformed input also exit 1. No model is called.

## `xpl lint [explainer] [--patch <file|->] [--warn-only] [--strict]`

Checks the text a reader sees. That is the explainer title, tour titles, tour `summary`, tour step notes, view titles, flow and sequence step labels and summaries, the `summary` and `detail` of nodes, edges and concepts, and the labels of groups and concepts. The index, when there is one, only counts the boxes and arrows of maps. It also checks the order of each tour, and what the viewer will show (a step it must title itself, a crowded map). It applies the rules of `reference/writing.md`. Run it before `xpl bundle`, and fix what it finds with a patch.

**It exits 1 on any finding,** so `xpl lint <name> --patch p.json && xpl apply <name> p.json` stops on one. Fix it; for a finding you keep on purpose, say why in your reply and run with `--warn-only` (exit 0 on warnings; a `todo-left` error still exits 1). `--strict` is the default and is kept for older scripts.

**Before you apply.** `--patch <file|->` lints the explainer as it would be after `xpl apply <explainer> <file>`. The patch is merged in memory the way `apply` merges it (same checks, actor `llm`), and nothing is written. A patch that `apply` would reject prints the same rejection lines and exits 1. The warnings the patch causes in `apply` (such as a step id that does not start with its view's slug) come after the findings and also exit 1: fix them in the patch, because an id never changes once applied. Warnings the guide had before the patch (an old index binding, older drift) come last, under their own line, and do not change the exit code. `-` reads the patch from stdin.

- `todo-left`: A `TODO` in any authored text, including frame/transition labels, audience, technology and view questions. One error per stored field; a tour note includes its heading and body. IDs, paths, anchors and metadata are excluded. Nested text names its field path and nearest element ID. Exit 1 even with `--warn-only`. A text that still holds a `TODO` gets only this finding: the other text rules judge it once it is written.
- `tour-summary`: a tour without a `summary`, or one of fewer than 2 or more than 5 sentences (the answer, then up to four reasons)
- `tour-first-step`: the first step does not show the big picture. It focuses a test (a file the index counts as a test, or a group of them), or only a concept that lights up nothing in its picture. Or it opens on a flow or sequence when the tour has a map. Or its title says "edge case", "corner case", "gotcha" or "open question"
- `tour-covers-map`: a map (graph view) of at most 10 boxes that the tour uses has boxes that never come up. No step focuses the box, something inside it, a group it belongs to, a step or edge that starts or ends there, or a concept related to it. And no note or the summary names it (by its label, symbol or file name, or a method by its own name: `findEdge` for `nodes.findEdge`). Names match by word stems, case-insensitive, with or without backticks: "the web server" names "Web servers". Lists the boxes (`ids` in `--json`). Give each a step, name it in a note in plain words, or take it off the map
- `tour-length`: a tour of more than 12 steps: split it, or merge steps that make the same point
- `tour-ends`: a tour of 5 or more steps that uses a map and ends on another diagram, or ends on the map without saying where next. The last step's title or first sentence must point on: "Where to go next", "Read next", "Read more", "What this tour left out", "Beyond this tour", "not on this tour". "Next" alone counts in the title; in the first sentence it must follow read, open or see ("The next job starts" does not count). End on the map with where next: the boxes the tour did not open, or the next guide. Talks and tours of a change may end elsewhere
- `unused-view`: a view no tour step shows and no box `opens` (checked only when the explainer has a tour): show it on a step, open it from a box, or drop it
- `many-concepts`: more than 5 concepts (the skill asks for 0-3); `ids` in `--json` lists the ones no tour step focuses: merge them, or move a case into a `detail`
- `duplicate-step`: a step note with the same content words (80% or more, both ways) as a note of another tour: say it once, and let the second tour say what it adds
- `note-heading`: a tour note that does not start with a `### Plain title` line (and says so when it starts with a placeholder such as `Fix 1:`)
- `connector-start`: a note whose text under its `### title` starts with "So", "But", "And", "Also" or "Then", which leans on the heading or the step before: state the fact on its own
- `code-title`: a title that looks like code: a call `f(`, an identifier with `_`, a dotted name `a.b`, a `#` in a name, code operators, a code keyword first (`return x`), one camelCase identifier. Code in backticks inside a plain title is fine (``How `Host.matches` reads the header``)
- `placeholder-title`: a title such as `Fix 1`, `Note`, `Step 3`
- `long-title`: a title or note heading of more than 12 words (a draft's `TODO` title waits): keep it near 8 words that state one fact
- `long-sentence`: a sentence over 25 words
- `long-average`: a field whose sentences average over 20 words
- `bare-it`: a sentence that starts with a bare subject: `It` or `This` and a verb (`It calls ...`, `This is ...`), `They`, `These` or `Those` and a verb (`These are ...`), or `There is` / `There are`: name the subject. In the summary of a box, arrow, concept or step, `It` may start sentence 2 or later when sentence 1 names the thing or starts with a verb
- `abstract-subject`: in any text, a sentence whose subject is a noun made of an action, then a verb in -s. The noun is a word and a noun in -tion, -sion, -ment, -ance, -ence or -ing (`Graph derivation combines ...`), or assembly, setup, lookup, dispatch, discovery, derivation and a few more alone (`Discovery uses git ...`). Make the code the subject; a summary may start with the verb (`Combines ...`). A sentence passes when it starts with a label of a box or concept of the guide ("Rate limiting" when a concept has that name). It also passes when it starts with the whole name of a mechanism: rate limiting, load balancing, dependency injection, lazy loading, error handling and a few more. "Job scheduling picks" still counts
- `filler-word`: marketing and filler words (seamless, robust, leverage, elegant, powerful, simply, just, basically, delve, crucial, comprehensive, cutting-edge, ...), each with a replacement. The same for wordy phrases (in order to, prior to, a number of), weak intensifiers (very, really, actually), stale metaphors (heavy lifting, at its core, out of the box) and machine-text tics (ultimately, notably). And for the vague verbs of writing.md section 2b (manages, takes care of, deals with, preserve, retain, explicitly, various) and connectors (additionally, furthermore, moreover). Code verbs (render, dispatch, emit, persist, provide) are left to the writer. Plain uses pass: "in order to" before a or the, "first-class functions", "the test harness", "terminates the child process" (or the old group). Quoted text is the code's words, not the writer's, in four cases. It holds two words or more. It follows prints, logs, says, shows or returns. It is one of a list of quotes (`"a", "b"`). Or it comes before punctuation, the end, or a word such as or, and, as, when (`the mode "robust" when ...`: a value). A one-word quote before the word it modifies (`the pool "manages" its connections`) is still checked
- `passive-voice`: a field with 2 or more passive clauses, or one in the main clause of the first sentence of a box, arrow, concept or step summary, or of a title or note heading (a title that starts with How, Why or What is not judged). A passive clause is a form of "be" or "get" and a past participle: `is written`, `are not shown`, `gets set`, `is being retried`, `is then re-rendered`. Code spans and adjectives such as `based on`, `undefined`, `unused` do not count, and a passive after when, if or whose names a state. Name who does it, or use a plain verb for a state
- `we-voice`: "we", "our", "us" or "let's" outside code spans and any quote (`"us"` may be a region code): name who does it, or write to the reader as "you"
- `dash-chain`: a sentence with two or more dashes (an em dash, or a spaced `-`, `--` or en dash): split it into sentences
- `tool-word`: a word of the tool in lower case. In tours: node, edge (not "edge case"), anchor, evidence, upsert, llm, provenance, stub, ghost, overlay and call-site. In box, arrow and concept text, only the tool's own senses count. These are a stub box or arrow, a ghost box, an authored overlay, anchor evidence, and stub or ghost in a sentence that says "this map", "the diagram", "boxes" or "arrows". The verb "maps" does not count, and neither does "a box" alone, which code may draw. A word passes when the guide names its own code with it: in the label or id of a box or concept, a linked file's path, the guide's title or a view's question. Quoted text passes, and "stub" passes in a text about tests
- `absolute-word`: all, every, everything, everywhere, everyone, anything, never, always, only, consistent(ly), guaranteed: check every case and anchor it, or narrow the claim. The same words get the same verdict in every field. These pass:
  - **Evidence next to the text:** the text of an element with `anchors` (a node, edge, concept or step).
  - A tour note sentence that names a part the step shows: a focused element with anchors, a symbol or a file, or any focused element when the step has `code`.
  - A note's `### title` when its step has `code`: the code links under it are the evidence.
  - In an explainer of a change, a tour summary or note sentence about what changes (`only download progress changes`, `the only change is ...`): the diff is its evidence.
  - `all`, `every` or `only` before a count in digits (`all 22 new cases pass`, `only 4 of the 22`), a measured result.
  - `only when/if/after ...` (a condition), and `only` after a verb or a noun, which narrows a claim (`compares only the host part`).
  - `all` after a list of named cases (``URL, `TrustedHostMiddleware` and `Host.matches` all call ...``), `outside everything` (a position), `not all` and `if every`.
  - Idioms: `not ... at all`, `after all.`, `in all.` (in total), `once and for all`, `all of a sudden` (`at all times` and `in all cases` still count), and words in quotes (a test name, a value).
  - These still count: `only` that opens a clause (`Only the router ...`, `now only URL ...`), `the only`, `only by`; `all three`, `each x and each y all ...`
- `repeats-summary`: a note sentence that repeats the summary of an element the step focuses (the reader sees both)
- `long-note`: a note whose text under its `### title` is over 50 words: keep the one point of the step in 1-3 short sentences
- `long-summary`: the `summary` of a node, edge, concept, flow or sequence step of more than 2 sentences or 45 words. Say what the part is for and move the cases into `detail`. Rewrite it whole when the code changes; never append a sentence
- `long-detail`: a paragraph or list item of a `detail` over 80 words: one point per paragraph, or a list
- `code-heavy`: a text that names more different pieces of code (code spans) than a reader can follow. The limit is 3 in a note, 1 in a note on an architecture map (a map with a box that has a `role`) and 2 in a tour summary. Say what happens in everyday words first. Not counted: example values (numbers such as `503`, `-1`, `1.5`; `null`, `true`, `undefined`, `Infinity`; quoted strings; URLs and route paths such as `/admin/*`, `users/{id}`, `lots/of/:fun`). Nor file names in a sentence that lists what a map leaves off ("`is.ts` and `types.ts` are left off this map"). Text that still holds a `TODO` is not judged
- `flow-label-code`: a flow step label written as code; flows name stages in plain words. Sequence views may keep call text
- `markdown-in-plain`: `**bold**` or `__bold__`, a `# heading` line or a `[text](link)` in a title or a label, which the viewer shows as plain text: the explainer, tour and view titles, and the labels of elements, steps and edges. Code spans and code shapes (`**kwargs`, `__init__`, `xs[0](y)`) do not count
- `markdown-in-summary`: a `# heading` line or a `[text](link)` in the `summary` of a node, edge, concept or step. Inline markdown is fine there (code spans, `**bold**`, `*emphasis*`, as in `**Changed:** ...`): the viewer renders it. A summary is one or two sentences next to the code: put headings and links in the `detail`
- `untitled-step`: a tour step without a note, or whose note has no `### title` and a first sentence over 80 characters (or opens with a list or code): the viewer shows that sentence cut short, or "Step N". Replaces `note-heading` for such a step
- `change-not-shown`: an explainer of a change: changed files whose code no tour step shows (its `code` ranges, what it focuses, their members, ends and anchors; `ids` in `--json`). Naming a code file in a note is not enough: show it on a step (a range in `code`, or a symbol in the focus). Docs (readme, `*.md`, `docs/`), tests, lock files and renames with no edits may instead be named in a tour text (by file name, or by path when two changed files share one); the message says which kind each is
- `far-ranges`: a tour step whose ranges in one file (its `code`, else the anchors of what it focuses) make more than 3 places, ranges over 40 lines apart. Present shows a pane per place, at most 3 per file, so the last pane holds the rest and opens at the first. (Read steps through any number, "1 / 4 in this file".) Keep the places the note is about, or split the step. Two or three far-apart places are fine. Not judged while the note holds a `TODO`
- `many-ranges`: a tour step with no `code` whose focus has no anchors of its own, so it shows the code the box falls back to (a folder's files, a group's members): more than 2 ranges. Give the step `code` with the ranges the note is about, or focus a smaller box. Needs the index; not judged while the note holds a `TODO`.
- `many-diagrams`: a tour that follows a path (it shows a flow or a sequence) and uses more than 1 map or more than 1 flow or sequence, the question budget in SKILL.md. A change, a presentation and a tour on an architecture map (a box with a `role`) are not judged. Keep the diagram that answers the question, or split the tour. A tour with no flow or sequence is not judged.
- `long-talk-note`: in a talk (a tour whose id or title says talk, presentation, demo or slides), a note over 280 characters under its title: Present sets it in its smaller caption type, and it may scroll
- `big-map`: a graph view a tour shows with more than 8 boxes (counted on the index; without one, the `include` entries): a guide picture or a slide of it is too small to read
- `many-participants`: a sequence a tour shows with more than 6 participants: the lifelines get too narrow to read. Fold a helper into the lifeline that calls it, or leave out calls that do not change the answer
- `long-flow`: a flow a tour shows with more than 8 steps: the boxes get too small to read. A flow of a type's states (`xpl draft states`) is not judged. Split the decision into two flows (which cases, then what happens in each), or merge steps that make the same point
- `crowded-map`: a graph view with more than 2 arrows (derived and stored) per box (needs the index). The hint and `ids` in `--json` list the least used drawn edges: put them in the view's `hidden`
- `system-map-no-edges`: an indexed architecture map with at least one non-component role, at least two visible boxes and no visible arrows; check whether arrows the code shows are missing
- `map-box`: a box on a map that draws its summary under the label (`boxText: "summary"`, as `xpl draft map` makes). Its label is over 5 words, or is a file name (`main.ts`, a code mark, the file's own name). Its summary is over 130 characters, or does not start with a verb in the present: it starts with an article, "This", "It", a code mark, the file's own name, the label's first word ("Job queue that …"), a word in -ing or -ed ("Used by …"), a word that does not end in "s" ("Configuration …"), or a vague verb ("Contains", "Handles", "Manages"). The explain map asks for 2-5 plain words and one sentence of about 120 characters that starts with a verb

Markdown fields: a tour `summary`, a step `note` (with its `### title` line) and a `detail` take any markdown; the `summary` of an element or a step takes inline markdown; titles and labels are plain text. Code spans (`` `...` ``) are left out of the word checks and count as one word. Every finding names the element, the field, a short quote and a fix. Exit codes: 0 no findings; 1 any finding (with `--warn-only`: only a `todo-left` error), or a rejected patch; 2 usage error.

```
$ xpl lint jobrunner
.explainer/jobrunner.explainer.json: 17 texts checked

tour:intro (tour)
  summary  tour-summary: no summary: readers see the summary first, under the tour title
    "Intro talk"
    fix: add 2-5 sentences: the answer first, then up to four reasons; for a change: what behaves differently, the risk, the tests
  steps  tour-covers-map: 2 boxes of the map view:overview (3 boxes) never come up: no step focuses them, no note names them
    "worker.ts, metrics.ts"
    fix: give each box a step, name it in a note and say why the tour skips it, or take it off the map. A plain-word name counts ("web server" for "Web servers")

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

A flow step is named with its view (`host-check:1 (step in view:host-check)`). `--json`: `{ok, path, patch?, changed?, protectedIds?, applyIssues?, strict, checked, total, counts: {<rule>: n}, findings: [{rule, severity?, elementId, kind: explainer|tour|tour-step|view|step|node|edge|concept, view?, field, quote, message, hint, ids?}]}`. `applyIssues` lists the warnings `apply` would print, each an issue as `validate` gives it plus `fromPatch` (false for a warning the guide had before the patch). `ok` is false when the exit code is 1: a finding (with `--warn-only`, a `todo-left` error), an apply warning with `fromPatch: true` (not with `--warn-only`), or a rejected patch. A rejected patch gives `{ok: false, path, patch, changed: [], issues, error}`, as `apply` does. `field` is `title`, `summary`, `note`, `note heading`, `label` or `detail`; `steps` for the order checks and `many-diagrams`, `code` for `far-ranges` and `many-ranges`, `change` for `change-not-shown`, and `include` or `hidden` for the map checks. `strict` is false with `--warn-only`. `view` names the map of a `tour-covers-map` finding. `ids` lists the boxes, files or edges a finding is about.

## `xpl health`

A quick check of the indexed files for the classic problems of code nobody read line by line, such as code an AI assistant wrote. Each finding has a file and line, a severity, why it matters and a short fix. It is a quick check, not a security audit: a clean report does not mean the code is safe. Run `xpl index` first; the index's ignore rules apply, so a git-ignored `.env` is never read.

- **Secrets in code** (high): well-known key shapes (`AKIA…`, `sk_live_`, `ghp_`/`github_pat_`, `xox…-`, `AIza…`, `sk-…`, private key headers). Medium: `sk_test_` keys, JSON web tokens assigned to a variable, a password in a connection URL, and a literal assigned to a name like `password`, `secret`, `api_key` or `token`. Such a literal is long and has mixed characters; a placeholder (`changeme`, `<your key>`, `${VAR}`) or an environment lookup does not count.
- **Secrets in browser variables** (high): a `NEXT_PUBLIC_`, `VITE_`, `REACT_APP_` or `PUBLIC_` variable holding a server key or named with `SECRET`, `PRIVATE`, `PASSWORD` or `SERVICE_ROLE`.
- **Committed `.env` files** with values: high when one is named like a secret, else medium. `.env.example` and similar are skipped.
- **Code files over 1,000 lines** (low).
- **Possibly unused code files** (low, a guess): no other file references the file in the index or names it by path (an HTML `<script src>`, a `package.json` `main`, `exports` or script, a worker's `new URL("./worker.js", import.meta.url)`, a config's `entry: "/src/entry-server"`; prose files do not count), and it is not an entry point (`main`, `index`, `cli`, `server`, `app`, …, or a file that declares a program's `main`: Java `static void main`, Python `if __name__ == "__main__":`, Go `func main` in `package main`, Rust `fn main`), a test (`__tests_dts__/` too), a config file (`vite.config.ts`, `vite.config-ssr.js`) or under `scripts/`, `bin/` or `cmd/`. A Go file is judged with its package: when any file of the package is used, none of them is reported. Files reached through a bundler alias, a template-literal import or a glob in HTML still look unused. When the index does not follow a language's imports, xpl cannot tell, so it reports no such file and a note says how many it could not judge (`<language>: the index does not follow imports, so xpl cannot tell whether 2 files are unused.`).

In tests, fixtures, docs and examples, key shapes are reported one severity lower and the other secret checks are skipped: fake values dominate there. **A secret value is never printed**: the hint shows at most its first 4 characters, then `…`. Exit 0 with or without findings (it is a report, not a gate), 1 without an index, 2 on a usage error.

```text
$ xpl health
Health of 4 files: a quick check, not a security audit.
2 high, 0 medium, 1 low

High (2)
  .env:2           Committed .env file with secrets
    Why: .env files hold local settings and secrets, and are meant to stay on one machine. This one is in the project's files, so its values are shared with everyone who gets the code.
    Fix: Add .env files to .gitignore, remove this one from the repository, change the secrets in it, and commit a .env.example with empty values instead.
  src/orphan.ts:2  AWS access key (AKIA…)
    Why: A key written into the code works for anyone who can read the code or its history, and code gets copied, shared and published.
    Fix: Revoke the key and make a new one, then read it from an environment variable or a secret store, never from the code.

Low (1)
  src/orphan.ts:1  Possibly unused file
    Why: Nothing else in the project refers to this file or names its path, so it may be left over. This is a guess from the index: code loaded through an alias, a pattern, a framework or from outside the project is not seen.
    Fix: Check whether anything still uses it, and delete it if nothing does.
```

When you report findings, name the file, the line and what kind of secret it is; never copy a value out of the file. `--json`: `{ok, index, commit, note, findings: [{check: secret|browser-secret|env-file|large-file|unused-file, severity: high|medium|low, file, line, title, explanation, fix, hint?, heuristic?}], counts: {high, medium, low}, files, notes}` (`files`: files read; `notes`: checks that were skipped and why, such as the unused check on an index without references).

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
`auto` and `require` run the optional analysis tools. No developer branch, index, refs or files change.
Inherited Git directory/work-tree/index overrides are removed from the owned Git context, which is passed
through indexing, diff computation and source reads. Checkout bytes must match the raw head blobs before
indexing. A configured smudge, encoding or line-ending conversion that changes content fails preparation
and removes staging; disable that conversion for the PR run before retrying.

JSON output gives `directory`, `repository`, `manifestPath` and `pr` identity. The `input.json` (never changed once written)
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
# Run the returned prompt with the skill's command in the installed agent.
# Author through handoff.json's command prefix, which calls the installed skill launcher safely.
xpl pr finish /absolute/pr-cache/input-XXXXXX --cache-dir /absolute/pr-cache --json
```

`create` uses the same preparation, then verifies the installed skill and bound CLI. Its launcher runs
`new`, `change` with the full API base..head and `draft change`. The `handoff.json` (never changed once written) records the
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
head or base exits 1 with `ok: false`, `status: superseded` and observed commits. The old output
stays; run `xpl pr create` on the PR again to get a new input and guide. API/export failures exit 1,
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
`<base-url>/current/index.html` and `<base-url>/<version>/index.html`. The base URL takes no credentials,
query or fragment. Only a marked comment from an owner, member or collaborator counts as the link; anyone
else's new comment is removed again and the run fails. After writing, `link` checks the PR once more and
marks the comment outdated, exiting 1, if a push landed meanwhile. `--json` returns `{ok, action, pr, current, version}`
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
      # Pin the xpl release you use: this job holds a token that can write PR comments.
      - run: npx --yes @krimvp/xpl pr check-link "$REPOSITORY#$NUMBER"
        env:
          GH_TOKEN: ${{ github.token }}
          REPOSITORY: ${{ github.repository }}
          NUMBER: ${{ github.event.pull_request.number }}
```

The workflow needs an xpl release that has `pr check-link`. It runs when the PR's head changes or its
base branch is switched; new commits on the base branch alone do not trigger it. It does not create the new guide: an author
runs `xpl pr create`, `xpl pr finish`, `xpl stage` and `xpl pr link` for the new head, which edits the
same comment back to current.

## `xpl change [explainer] [<base>..<head>]`

Records the change an explainer is about, from git, and prints what it touches. Run it once, at the start of explaining a PR or MR, on a checkout of the head with the index built (`xpl index`). Nothing is written to the repository. With one guide in the repository, leave out its name: `xpl change main..HEAD`. A lone argument is the guide when a guide has that name, else the range.

- `<base>..<head>` takes any git revisions (`main..HEAD`, `2284ff0^..2284ff0`); `<base>...<head>` starts from their merge base; `<base>` alone ends at the commit of the index. The head must be the commit the index was built from, else it stops: `the head HEAD~1 (85c3b74) is not the commit the index was built from (2284ff0). Check out 85c3b74, run xpl index, then run this again`.
- It stores `change: {base, head, files: [{path, status: added|modified|deleted|renamed, oldPath?, hunks: [{oldStart, oldLines, newStart, newLines}], excluded?}]}` in the explainer (full SHAs; hunks as `git diff -U0` prints them). `excluded` says why `xpl index` leaves the file out: `generated`, `dependency`, `lockfile`, `oversized`, `binary`, `non-file` or `unreadable`. Patches cannot change it.
- It prints the changed files with `+added -removed`, and the **changed symbols**: index symbols that hold an added or edited line (`new` when every line is new; a function nested in a function counts as part of it). For each changed symbol it prints its **direct callers** outside test files, and the indexed tests that reference it (a test function, or a test file for an import). A test also counts in three cases. It calls one of the symbol's direct callers (`through <caller>`: one call between them, as for the call paths). It calls the class of a changed constructor. Or it builds the class of a changed method (`builds its class; a guess`). When none of these finds a test, the output says so. A missing reference does not prove that no test exercises the behavior. Changed test files are listed separately. A method that runs when an instance is called (`__call__`, `handle`) gets `callers via instance`: the code that builds its class. That is a guess, and the output says so. Lines outside any symbol (imports, module-level code) are listed apart.
- For changed functions and methods, **call paths through one intermediate function** show two indexed call sites with each hop labeled precise or heuristic. They show possible reachability, not guaranteed execution. No runtime callback or middleware wiring is inferred. Tests, cycles and instance guesses are not expanded. Each changed symbol has at most 100 paths and 1000 inspected references; a truncation note means the result is incomplete, including in JSON. Draft maps keep their direct callers.
- A **Not checked** section says what was not analyzed, in plain words. Changed files the index leaves out get one line per reason with a count, and the files under it (`8 files over the 1 MB size limit were not analyzed.`); removed files get one line. It also lists report-level partial, unavailable or failed analysis with the number of changed paths that report actually analyzed. A commit mismatch is called out first, so a stale index's limits are not presented as head coverage. No section means no omission was recorded; it does not prove complete semantic coverage. The exported change guide puts the same lines below its summary, the files folded under each, and `--json` includes `omissions: string[]` (the lines; `change.files[].excluded` gives each file's reason).
- `xpl change <explainer>` without a range prints the analysis of the recorded change again.

```
$ xpl change jobrunner HEAD~1..HEAD
change jobrunner: 5774f2c..349730f (1 file, +1 -1), index 349730f
written to .explainer/jobrunner.explainer.json

files (1):
  M  src/runner.ts  +1 -1

Impact limit: two indexed call edges; dynamic callbacks, runtime middleware wiring and instance guesses are not followed. Paths show possible reachability, not guaranteed execution.

changed symbols outside tests (1):
  sym:src/runner.ts#Runner.dispatch  (method, lines 42-88)  changed at 80
    callers outside tests (1):
      sym:src/runner.ts#Runner.start  (src/runner.ts:32)
    tests: no indexed test reference found

No indexed test reference found for 1 changed symbol: sym:src/runner.ts#Runner.dispatch
Direct callers and two-edge call paths come from the index; unindexed dynamic wiring is not inferred. ...
```

The callers and tests come from the index: a call through a variable, a callback or a framework is not seen, and "a test references it" does not mean the test checks the change. Read the tests before you say what they cover. With the change recorded, anchors may point at the code before it (`"at": "base"`, `patch-format.md` section 1), `xpl show --at base` prints that code, `xpl validate` checks it, and `xpl bundle` embeds it.

`--json`: `{ok, path, written, change, omissions: [reader-facing limits], analysis: {base, head, files: [{path, status, oldPath?, added, removed, hunks, test, indexed, outside: [lines]}], totals: {files, added, removed}, symbols: [{id, symbolId, file, kind, range, status: new|changed, lines, callers: [{id, file, lines, kinds, resolution, changed?, via?}], viaInstance: [same], indirectCalls: {paths: [[upstream reference, downstream reference]], truncated: boolean}, tests: [{id, file, refs, kinds, changed?, via?}]}], testSymbols: [{id, symbolId, file, kind, range, status, lines}], untested: [ids]}}`.

## `xpl draft change|repo|path|map|class|states|data [explainer] [<entry id> ...] [--audience <reader>] [--question <question>] [-o <file>]`

Prints a patch skeleton of one draft kind, built from the index (and the change record) with no LLM. It holds the structure the index proves, and `TODO: <what to write>` in every text you must write. `xpl apply` accepts the draft as it is. Start a guide with it, then write the text and check it against the code.

`--audience "New maintainers" --question "How are retries selected?"` focus the draft. The audience goes in the patch's scope, the question in the view scopes and the tour summary TODO.

The same rules hold for every kind:

- A tour step has at most 2 code ranges. Its note is `### TODO: ...` and a body; the last `### Where to go next` step keeps its title and has no code.
- Step counts follow the budget table in `SKILL.md`. The caps below are the draft's own.
- Ids in the guide are not reused (`view:change-map-2`). A new tour numbers its steps after the highest `t<n>` of the guide's tours, so you can copy a step from one tour to another.
- A box the guide already explains gets no new summary.
- The draft is checked as `apply` checks it before it is printed. When the code changed after `xpl index`, it says to run `xpl index` and `xpl resolve <explainer> --write`, then draft again.
- A heuristic reference is a hint: a dashed arrow, and a note. Check each one in the code.

When the index has `request` references, a new map's `edgeKinds` add `requests`, so the code that sends a web request has an arrow to the route that answers it.

Ruby and PHP drafts: classes and methods inside modules or namespaces make a file a part of the inside map. Their index reports `refs: none`, so the draft adds no call arrows between those files. Java references stay heuristic and partial: check the draft's systems and arrows in the code.

`docs/ARCHITECTURE.md` §5 says how each kind finds what it draws.

### `xpl draft change`

Needs the change record: run `xpl change <explainer> <base>..<head>` first.

**Draws**

- One map, "What this change touches" (`stubs: none`; arrows for calls, reads, type uses, `extends` and `implements`, so a changed default value or type has its arrows). It holds the changed symbols, their direct callers outside tests, and one group box for the changed tests.
- Box summaries that start with `New:`, `Changed:` or `Unchanged:`.
- A code link for every changed file, tests too. A deleted file links to the code before the change (`at: "base"`). A file the index leaves out (an exported page over 1 MB, a lockfile, a guide file) gets none, so its old text stays out of the page.

A caller is code that calls. A test, or code that only names a changed type, is not a caller.

**Tour** (at most 12 steps, ids `t10`, `t20`, ... so a step you add fits between two)

- What changes for users, then where the change enters.
- One step per changed piece, in call order, with its old lines before the new ones.
- The other changed files, who else is affected (always a step), tests and gaps, risks.

**Notes it prints**

- Pieces left off the map (at most 8 boxes) and pieces with no step of their own.
- Callers that are a guess, and files with no code link, each with its reason (`site/page.html (over the 1 MB size limit)`).

### `xpl draft repo`

**Draws** two levels.

- A system map (`view:system`, `stubs: none`): the project as one service box, or one per program under `services/`, `apps/` or `cmd/`.
- Who reaches it: a web or command-line framework, or a web server start call (`ListenAndServe`). A program with only a `main` gets an `Operator` box there. A library is the `system` box, and a "Your app" box (`role: external`, `tech: your app`) at the README example calls it.
- What it relies on (databases, queues, APIs), from its imports, and a `Settings file` box.
- Each arrow it adds there gets a label TODO and a summary TODO, so `ready` finds no empty text once the TODOs are written.
- Each service box `opens` a map of its inside: at most 8 parts, and the outside systems each imports. Code that is not the product gets no box: tests, examples, fixtures, docs, benchmarks, playgrounds, project templates (`templates/`, `template-*/`), demos and sandboxes.

**Tour** (at most 7 steps): the system map with the README, what it relies on, the inside, one step per part (at the functions other parts call most), then `### Where to go next`, at the code where the main path starts. Room is left for 2 steps of the main path.

**Notes it prints**

- That the kind of project and its users are a guess.
- The settings files, and whether the code loads them or only names them.
- The `xpl draft path` command that fills the room for the main path. For a library it starts where the request goes, past the builder that returns the client (ky: `Ky.create`, not `createInstance`). In Ruby or PHP, which have no references, the note says to write those steps from `xpl show` instead.
- The outside systems found, the files left off the inside map, and the code files left off because they are not the product, counted by folder.

### `xpl draft path <id> [<id> ...]`

**Draws** a sequence of the entry's calls (depth 1, source order; at most 6 participants and 12 calls), past an entry that only forwards. In Ruby or PHP the index has no references, so there is no call to draw: the draft says so, and you write the steps from `xpl show`.

- Each call links to its call site and to the callee's definition. A method of the entry's own class is a lifeline of its own (`Ky.#run` calls `Ky.#retry`), until the lifelines reach 6: the rest of those methods share one lifeline for the class, and a note names them. A method of another class goes to that class's lifeline; a call through an interface, to its one implementation.
- A callee called twice is drawn at its first call, and again at its first call on the main path when the first was inside a branch (the `delay` of an early exit and the `delay` after it). A one-line check in a branch's condition is not drawn, also when it calls another one-line check.
- Frames from the syntax tree: a `loop` around calls in a loop, an `alt` around a branch with calls in two or more arms (`arms`), an `opt` around a branch with calls in one arm. An `if` that ends in `continue`, `return`, `break`, `raise` or `throw` makes the rest of its block the other arm. Each label is a TODO that quotes the condition.
- When the calls cross files, a map of those files first (`view:<entry>-files`), with a summary TODO per file box.
- A call's label keeps short arguments; long ones are cut to their names and the names of the calls in them (`requeue(job, backoffDelay(…))`).
- An entry that only forwards (one call the index knows, outside loops and branches, in at most 3 lines of code, like cobra's `Command.Execute` calling `Command.ExecuteC`) is followed: its call is step 1, then the calls of the function it forwards to. Each entry that forwards is a lifeline at the start. It follows at most 3 forwards and stops on a cycle.

Several entries give one sequence each and one tour.

**Tour** (at most 8 steps): the file map, the big picture, one step per main call or branch, then `### Where to go next` on the map.

**Notes it prints**: calls drawn once, helpers not drawn, calls left out over the caps (those that reach the least code), calls with no step, where an inherited entry resolves, and which entries only forward (`` `Command.Execute` only forwards to `Command.ExecuteC`; the sequence shows the calls of `Command.ExecuteC` ``), with the command to draft from the next one when it stopped after 3.

### `xpl draft map`

**Draws** a quick map of every code file outside tests, examples, fixtures, docs, benchmarks, playgrounds, templates, demos and sandboxes.

- One graph view per folder (`boxText: "summary"`): `view:map` for the top (below `src/` when it holds all the code), `view:map-<path>` below it. A folder box `opens` its folder's map.
- Every box gets a label and a one-sentence summary to write. A file's TODO holds its header comment, what it defines, and the files it uses and that use it.
- Over 30 boxes, files that use each other become groups (`grp:map-<path>-<n>`) that open a map of their files. Over 12 boxes, a map opens as a dependency matrix.

**Tour** (`tour:map`): the top map at the README, each top-level folder at its most used file, then `### Where to go next:` where a newcomer starts reading (the entry file, at `main`, or Java's `main` method of its class). With a change recorded, `tour:changes-<head>` has a step per changed file.

**Notes it prints**: the files left off and why, the files that are not code (settings, manifests), groups, matrices, moved files, and edited boxes whose code is gone.

Run it again after the code changed (`xpl index`, `xpl resolve <explainer> --write`): new files get boxes, gone files lose theirs, written text stays, and a moved file keeps its text.

### `xpl draft class <id>`

**Draws** the type hierarchy around one class or interface, from the index's `extends` and `implements` references.

- One map (`view:<name>-types`, `edgeKinds: ["extends", "implements"]`, `stubs: none`). It holds the types the entry extends or implements, all the way up (at most 6), the entry, and the types that extend or implement it, two levels down. At most 8 boxes.
- Each box gets a summary TODO with its kind, its links and its methods. In Go, `extends` reads "embeds" and a struct is a "struct".
- Types in test files stay off the map unless the entry is in one.

**Tour** (at most 8 steps): the entry, then each type next to it, then `### Where to go next`. The first step names the boxes no step visits.

**Notes it prints**: types left off (over the cap, or in a test file), and arrows that rest on heuristic references. An entry that is not a class or an interface, or has no hierarchy, is refused.

### `xpl draft states <id>`

**Draws** the states of one status type and the moves between them, as one flow (`view:<name>-states`, `layout: "diagram"`).

- The entry is a TypeScript `enum` or union of string literals, a Python `Enum` class, or a Go type with a `const` block of its values in its own file. Anything else is refused, with a hint.
- A stage per state, linked to its declaration, its first sets and its first tests.
- A stage per transition, where one function tests a state and then sets another under that test. At most 16 states and 16 transitions.
- The viewer draws the states as pills and the moves as flat boxes between them, with no step numbers. Keep the shape (the type as the first participant and entry point, each move inside its own function, leading to one state) and it keeps that look.

**Tour** (at most 11 steps): the type, then each state.

**Notes it prints**: states never set and never tested (an end state looks like that), states a function tests with no move out, uses that are neither a set nor a test, and that transitions come from matching the text. Add the moves it missed by hand: discriminated unions, Java enums and a move split across two functions are not found.

### `xpl draft data [<scope>]`

**Draws** what data the code keeps and how its types relate, as one data map (`view:data`, or `view:<name>-data` for a scope; `boxText: "members"`, `stubs: none`).

- The scope is the repo (the default), a folder (`dir:src`), a file or one type (`sym:src/queue.ts#Job`, then the types at most 2 links from it).
- Each type is a table: its header, then a row per field, in code order. An arrow goes from a field to the type it holds, and from a type to what it extends or implements.
- Only linked types are boxes. At most 6 boxes and 8 rows a box. Two types of one name get their package or file in front (`runner.Config`).
- A summary TODO per box (its kind, fields, what it holds and what holds it). Field rows get none.

**Tour** (at most 6 steps): the first type, the next types in the order they joined, the rest of the map, then `### Where to go next`, which names the types left off.

**Notes it prints**: the types left off and why (with the command that maps a group with no room), boxes with no rows, and heuristic arrows.

```
$ xpl draft path jobrunner sym:src/runner.ts#Runner.dispatch -o path.json
wrote path.json
draft path for jobrunner: a sequence of 9 calls between 6 participants after a map of the 3 files it crosses, 8 summaries, a tour of 8 steps, 29 anchors, 49 TODOs to write
note: called more than once, drawn at the first call (and at the first on the main path): Runner.log (3 calls)
note: not drawn, one-line helpers that call nothing or only other one-liners: backoffDelay
note: calls without a tour step of their own (at most 5 call steps): Runner.log, RunnerStats.record, WorkerPool.release
next: write each TODO, then `xpl lint jobrunner --patch path.json` and `xpl apply jobrunner path.json`
$ xpl draft map jobrunner -o map.json
wrote map.json
draft map for jobrunner: a map of 7 boxes, 7 summaries, a tour of 2 steps (short is right for a small subject: do not pad it), 2 anchors, 22 TODOs to write
note: 7 code files on 1 map; 1 file left off (tests, examples, fixtures, docs, benchmarks, playgrounds, templates, demos and sandboxes); 4 files that are not code have no box: `README.md`, `config/default.yaml`, `package.json` and `tsconfig.json`
next: write each TODO, then `xpl lint jobrunner --patch map.json` and `xpl apply jobrunner map.json`
$ xpl draft change jobrunner
error: .explainer/jobrunner.explainer.json has no change recorded: run `xpl change jobrunner <base>..<head>` first (e.g. main..HEAD), then `xpl draft change jobrunner`
```

A box of that map, as drafted (the TODO says what the index knows about the file):

```json
{
  "id": "file:src/queue.ts",
  "label": "TODO: 2-5 plain words for this file (now: queue.ts)",
  "summary": "TODO: one plain sentence: what this file does for the project (defines `Job`, `DeadJob`, `PushOptions` and `Queue`; used by `runner.ts`, `main.ts` and `worker.ts`)."
}
```

In the viewer (`xpl view`, `xpl bundle --draft`) a draft reads by what the index found: on the diagrams and in the
lists, menus, breadcrumbs and the page title, this box shows as `queue.ts (TODO)`, and a text with no `(now: …)`
name (an arrow's label, a step title) as `TODO`. The whole instruction shows where you write: the details of the
selected element, the edit forms and the draft banner's list.

A step of the path sequence and its tour step:

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

`--json`: `{ok, kind, path, out?, counts: {views, maps, boxes, rows, participants, sequenceSteps, overlays, groups, tourSteps, anchors, todos}, notes: [text], applyWarnings?, patch}`. Exit codes: 0 ok, 1 no change recorded, an entry that is not a symbol, or nothing to draft, 2 usage error.

## `xpl view [explainer] [--port <port>] [--host <host>] [--no-open]`

The visible page polls for resolved explanation, source and index changes. A changed ETag refreshes
the bundle and previously opened files and keeps your place; while you have unsaved edits, it waits.
A newly generated index is followed unless `--index` pins one. Changed source is shown with a stale-index
warning until reindexing. Save as HTML carries the refreshed index, loaded source and any warning.

Serves the viewer with live repo access at `http://127.0.0.1:<port>/` (default 4747, else a free port; `--port 0` = any) and tries to open a browser. The explainer is re-read from disk on every request, and the page checks for changes every 2 seconds: what `xpl apply` writes shows up without a reload. The server saves edits in the viewer as `user` edits: layout, expanded nodes, the stubs control, tour steps, Details text, and checked anchor repairs and removals. It saves "Explain this" clicks to `.explainer/requests.json`, with stable ids, the original snapshot context, and what the user typed above the button as the `note`. The Feedback panel also offers correction/explanation/expansion requests and JSON export; saving starts no generation. Runs until Ctrl+C. It binds to 127.0.0.1; `--host` other than that exposes the source code. The anchors are re-resolved as for `xpl bundle`; drifted or missing anchors do not stop it (it is where you fix them), but it warns, and the page shows the same banner.

```
$ xpl view jobrunner --no-open --port 0
serving .explainer/jobrunner.explainer.json at http://127.0.0.1:34971/  (Ctrl+C to stop)
```

API (for scripts): `GET /api/guides` lists the shared local catalog (`?id=<key>` returns a read-only source snapshot). `GET /api/bundle` returns the page's bundle as JSON. `GET /api/export` returns the current complete export snapshot and the shared readiness report. `GET /api/explainer` returns the explainer with its anchors re-resolved, with an `ETag`; the page polls it. `GET /api/file?path=` returns a file, and `GET /api/base-file?path=` the code before the recorded change of a modified, renamed or deleted file. The writes are `PUT /api/views/<id>`, `PUT /api/tours/<id>`, `PUT /api/review` (a bounded author review user patch) and `GET|POST /api/requests`.

## `xpl service start|pause|resume|stop|status [explainer] [--background] [--port <port>] [--backend none|claude] [--skill-dir <folder>] [--job-timeout <seconds>] [--recover] [--watch] [--precise auto|off|require] [--scip <artifact|manifest.json>]`

Starts the existing viewer server on loopback (`127.0.0.1`) with one owner per canonical repository root.
Foreground is the default; stop it with Ctrl+C or `xpl service stop`. `--background` starts the installed
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
record and keeps the last valid index and guide. A live process it cannot verify is never replaced. Check a
crashed writer's lock and remove it yourself; xpl never takes a lock because it is old.
The viewer shows its connection and configured backend below the header. Configured Claude says
sign-in is checked when a job runs; availability never implies authentication. Repository/guide bookmarks
and API requests refuse another attachment at the same address. Restart reuses saved context and refreshes
the open page's instance while keeping navigation and unsaved edits. After stop, choose **Use loaded snapshot
offline** for manual edits, browser feedback and embedded-snapshot HTML export. **Retry connection** resumes
the original address; **Edit → Retry save** persists queued offline edits. Export and import offline feedback by
hand. Manual iteration and offline HTML work with the service stopped.

The service persists durable lifecycle records in `.explainer/service/jobs.json`. `GET /api/jobs` reports
runner availability and this guide's history; `GET /api/jobs/<UUID>` reads one job. Restart marks running
attempts interrupted, while queued work and completed proposal references survive. Cancellation and
supersession discard results and fence late callbacks. `POST /api/jobs/<UUID>/cancel` and `/supersede`
take `{}`. Retry takes `{expectedAttempt}` from the inspected job, so repeated delivery cannot start
another attempt after a fast failure. A job keeps the revision journal and the ids of the picked
requests. No job route applies a patch or records an outcome. With backend `none`, submission/retry
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
signaled by PID. Service death
closes the attempt launcher's pipe and kills the group too. Before running Claude, the job records the
group ID and Linux boot/start ticks under its attempt lock. Recovery verifies that identity, terminates
the old group and waits before allowing retry; a reused PID is never signaled. Verified execution
requires Linux /proc; other platforms report a job failure and can use manual revision. After source and
ownership rechecks, valid ready proposals enter the existing revision journal as `proposed`. Inspect
`xpl revise <guide> --run <revisionRunId>` before deciding anything. Creation fills a guide made by `xpl new`/draft authoring, with selected creation requests and included new IDs; it does
not create a second proposal format or overwrite a name. Service-owned journals refuse manual
proposal/decision/accept writes from selection onward, including cancellation or supersession before
a proposal arrives. Selection records the job ID; the guarded proposal records its attempt ID. Older
unbound service journals recover ownership from the matching revision job in the repository ledger.
Read-only `revise --run` stays available. In the viewer, **Jobs** lets the
author select feedback, start/cancel/retry and inspect progress or failures. **Review proposal** shows
readable changed text with marks, concise evidence and source before/after. Each selected request needs
a decision and reason. **Review decisions** validates the exact candidate; **Accept reviewed revision**
then uses #30's freshness/readiness, user fields and outcome journal. New feedback is preserved.
After an interrupted acceptance, **Recover acceptance** finishes it without applying the patch twice.
The guarded API is `GET /api/jobs/<id>/review?attemptId=<uuid>`, `POST .../review` with
`{attemptId, decisions?}`, and `POST .../accept` with `{attemptId, reviewToken}`. The token comes from
the inspected review and binds its exact candidate and decisions to the job attempt. Acceptance compares
it under the journal lock, including recovery. Another view's changed decisions return 409 and reload
the review; inspect it again before accepting. Tokens are derived from the saved journal without a
migration. Older clients that omit the token receive 400; manual `revise --accept` is unchanged.
Per-request previews advance through proposals in order; each shows its own changes relative to the
preceding candidate. The chosen combined candidate must still pass readiness. Decisions use the same
statuses, reconciliation and missing-anchor permissions as `xpl revise`. Canceled/superseded/old attempts
and stale candidates cannot apply. Once journaled acceptance begins, recover it before canceling or superseding.
Controlled executables prove adapter/lifecycle failures only; a real installed Claude job proves the
provider integration. `claude --version` does not establish authentication.

Headless answers use `POST /api/answers` with `{id: UUID, requestId}` for a saved `explain` request with
its question in `note`. GET collection/item and POST `/<UUID>/<retry|cancel|supersede>` reuse job guards and
`expectedAttempt`. The worker freezes the guide, identity and guide/question head/base source (5 MB maximum).
Claude writes only `{text, references:[{file, side, fromLine, toLine, quote}]}`; every complete-line quote
must match recorded source exactly. Invalid evidence or a patch field fails the job. Returning an answer
never edits the guide or records a revision outcome. Use ordinary `xpl revise` for optional guide changes.

A finished answer job keeps the code and guide it answered from. When either changes later, it reports
why in `contextReason`. Reload replays the completed receipt into optional `FeedbackRequest.answers`;
feedback export/import unions history by stable answer ID independently of outcome revisions. Conflicting
answer content or invalid imported evidence is refused; an older export cannot erase history. Each answer
ID belongs to one question. Imports or completions exceeding 1,000 answers for a question fail without
changing history or publishing a result receipt; saved answers are never truncated. Without an
answer backend the request stays pending for `/code-explainer feedback`. Submission deduplicates by request
ID under the job ledger lock, even with different supplied job UUIDs or after restart. Existing terminal jobs
are returned; failed/interrupted jobs use explicit retry and canceled questions need a new request.
The viewer derives its job UUID from the request ID without browser storage. The viewer's Feedback panel
uses these routes for **Ask a question**, progress, retry/cancel and answer history. Details and selected
head/base code lines open that panel. JSON import/export preserves answers independently of outcomes.
Questions with saved answers show **Answered**, separately from the revision outcome. **Save for the next
revision pass** saves feedback without starting generation; **Ask a question** starts an answer.
Reference clicks select matching source; changed or unavailable source shows the highlighted recorded
excerpt. An answer never accepts a guide change; optional revisions still require explicit review.

`service start --watch` makes this start poll file metadata and rebuild the whole index on a change. Unchanged polls
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
publication locks prevents superseded/canceled results from publishing. Failed builds retain the last index marked out of
date; source/configuration freshness and anchor drift still block ready export. Builds report every guide;
`xpl status --all` reads the inventory without saving prose. Generated exports and excluded outputs do
not change watched Git cleanliness or generation, including from a clean tree. No generated revision is accepted and no
feedback is removed. Named `.patch.json`/`.explainer.json` files, `.explainer/` output and exported xpl HTML
are excluded from source discovery. Keep other scratch output outside the source root.

`xpl service pause` aborts and drains the watch without stopping jobs or releasing service ownership.
It keeps the last checked index, marked stale; even unchanged paused evidence refuses ready export.
`xpl service resume` starts a fresh input check and full rebuild. Repeated controls are safe. Stop drains
the watch, server and jobs, then returns to manual indexing/revision.

Managed viewer pages share one compact bar with connection, attention and watch-control disclosures.
Only one disclosure opens at a time; attention scrolls without shrinking the diagram or code.
An unreadable attached guide appears as an error item while verified service controls remain available. It lists
all guides, moved/drifted/missing elements and repair instructions. Moved locations keep their prose;
drift needs inspection and revision, and missing evidence must be restored, replaced or removed by you.
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

## `xpl ready [explainer] [--note <reason>] [--require-review]`

Checks strict structure/references, workspace/index freshness, required text (visible summaries and guide
content), source availability and reader lint. Errors block ready export; warnings invite author judgment.
`--note "reason"` records an intentional omission or warning decision, without overriding errors. Pass the
same note to `bundle` to keep it in HTML. This check writes nothing and needs no service; ordinary checks
require no reviewer record.

`--json` emits `{ok, ready, scope: "workspace", identity: {explainerHash, sourceHash}, errors, warnings,
findings: [{severity, code, elementId, field, message, hint}], review: {status, required}, decisionNote?}`. The text
output starts `ready:` or `not ready:` with the counts, then prints one line per finding:
`<severity> <element>, field <field> (<code>): <message>; fix: <hint>` (`the guide` for the guide's own fields). Exit 0 ready (warnings allowed),
1 blockers/failure, 2 usage. Bundle failures include this report as `readiness`. The identity function lives in
core `readiness.ts`; explanation content/provenance/anchors/index metadata change `explainerHash`, while
indexed file path/hash changes or change base/head SHAs change `sourceHash`. HTML, launch mode, server URL,
source embedding and index pruning do not change identity.

Source checks verify locations and freshness, not prose claims or complete runtime coverage. Viewer Save as
HTML uses the same check, fetching current source at the final click under `xpl view`. Offline re-saves check
only embedded source; they cannot detect later repository changes. Findings and author decisions stay in the
saved snapshot's `exportInfo: {status: "ready" | "draft", report}`.

Review state is `unchecked`, `reviewed` or `out-of-date`, whatever the anchors say. `xpl ready` needs no
review. With `--require-review` it needs a current author review with `scope.content: "all"` and the code
scope it names; a review of less, or an old one, adds `review-required`.
Use the same flag with `bundle`. Named omissions remain visible and do not override other errors.

The author records through Edit > Record author review in live or offline pages. Names are self-reported,
not authenticated. The inspected fingerprint is checked again as a user patch; LLM patches cannot record or
remove reviews. Selected IDs cover those stored records and their own anchors, not dependencies. Repository
scope and named whole files widen evidence and are included in exports. The Save as HTML team policy
checkbox is off by default and keeps your choice when you save an offline page again.

## `xpl bundle [explainer] -o <out.html> [--mode explore|present] [--tour <id>] [--files referenced|boundary|all] [--boundary-max <n>] [--embed-index full|pruned] [--include-guides <id,id>] [--draft] [--note <reason>] [--require-review] [--allow-drift]`

Ready output refuses a stale index, including with `--allow-drift` or `XPL_SKIP_STALE_CHECK=1`. Reindex and resolve
first. `--allow-drift` only permits drift against a current index. Generated XPL HTML pages are excluded
from discovery so exports do not feed back into subsequent indexes.

`--include-guides id,id` includes up to eight additional locally discovered guides for offline switching.
Each is loaded from its exact catalog path, checked with the same readiness policy and keeps its own index,
source and export report. Additional unpacked guide JSON is limited to 20 MiB; exceeding the limit or
failing readiness writes no page. Use `--draft` for unfinished included guides.

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
for preview/repair and the summary says `draft preview`. Reader warnings are printed and kept in the page; `--note`
records an author's reason about omissions or warnings without overriding blockers. Pages over 20 MB still
produce a size warning (`--files referenced` embeds fewer files).

```
$ xpl bundle jobrunner -o jobrunner.html
error: .explainer/jobrunner.explainer.json does not match the code: 3 anchors drifted (their code changed) and 2 are missing (their code is gone), so the page would point at the wrong code. To fix it, run `xpl resolve jobrunner --write` and fix what it lists: re-explain the drifted elements, re-anchor or drop the missing anchors, then bundle again; --allow-drift writes the page anyway, with a warning on it
```

`--files referenced` (the **default**) embeds the files the explainer needs. Those are the files of every anchor, of the nodes its graph views include (a directory or group: its files), of a sequence view's participants, and of the sites and definitions behind its derived edges. It also embeds the code behind the dashed stubs of graph views, which the viewer shows when one is clicked. There is none for `"stubs": {"mode": "none"}`, and references from `excludeFiles` do not count. The viewer's file tree lists only the embedded files, with an "N of M files included" footer (under `xpl view` every indexed file is listed and fetched when opened). `--files all` embeds every indexed file. The command says what went in and what `--files all` would add; the output path is printed as given.

`--files boundary` embeds the referenced files plus a safe boundary around what the explainer anchors, so a reader of a PR or a subsystem can check the neighbours. The boundary is the files of the **direct callers** of every anchored symbol (a class counts with its members) and the files it **calls** (depth 1). It also takes the **test files** that reference it: a call, an import or a type use (a test that calls it counts as a test). An anchored constructor or call method (`__init__`, `__call__`, `constructor`, ...) is reached through its class: `URL(scope)` calls `URL.__init__`, and a test that hands `TrustedHostMiddleware` to an app tests its `__call__`. At most 40 files are added (`--boundary-max n`): the ones with the most references first, callers, tests and callees in turn. The summary line says how many of each went in and names the files the cap cut. Use it for PRs: the tests of the changed code and the callers of a changed function come with the page. Only anchors with a `symbol` outside test files count, so anchor the changed symbols, not just their files.

```
$ xpl bundle metrics -o metrics.html --files boundary
wrote metrics.html (2.3 MB): .explainer/metrics.explainer.json, 4 of 12 files embedded (referenced 1, boundary +3: callers 1, callees 1, tests 1; 8.1 KB of source; --files all adds 8 files, 16.9 KB), index 29.9 KB as JSON (7.3 KB packed), pruned from 80.2 KB, mode explore
$ xpl bundle metrics -o metrics.html --files boundary --boundary-max 1
wrote metrics.html (2.2 MB): .explainer/metrics.explainer.json, 2 of 12 files embedded (referenced 1, boundary +1: callers 1, callees 0, tests 0; 2 more cut at --boundary-max 1: test/retry.test.ts, src/bus.ts; 3.7 KB of source; --files all adds 10 files, 21.3 KB), index 15.3 KB as JSON (3.7 KB packed), pruned from 80.2 KB, mode explore
```

(Here `metrics` is an explainer with one concept anchored at `src/metrics.ts#registerMetrics`: `main()` calls it, it calls `EventBus.on` in `src/bus.ts`, and the retry test calls it.)

The symbol index, most of the page for a large repository, is **pruned** with `--files referenced` (and `boundary`, for the files it embeds). Every file entry stays. So do the symbols of the embedded files and of what the explainer names or its graph views show (with their parents). The kept references touch an embedded file (`read` references: both ends), lie on a graph view or make up a derived edge the explainer names. The views, tours and code behave as with the whole index. `--files all` embeds the whole index; `--embed-index full|pruned` overrides either. The page holds the index packed (each symbol id once, every symbol and reference a short array of numbers: about a fifth of the plain JSON; the viewer unpacks it). The summary line says the size as JSON, then packed in the page, and what was saved (`index 72.0 KB as JSON (17.2 KB packed), pruned from 85.8 KB`; no `pruned from` when nothing was dropped) and the embedded index carries `pruned: {files, symbols, refs}`, the counts of the whole one. One limit: a ghost the reader expands into a file whose code is not embedded opens only into the symbols the kept references end in. Edges between two such ghosts are missing. Use `--files all`, or `--embed-index full`, when the reader should explore freely.

After completing the required text in the fixture explainer:

```
$ xpl bundle complete -o complete.html
wrote complete.html (1.2 MB): .explainer/complete.explainer.json, 8 of 12 files embedded (referenced: 18.4 KB of source; --files all adds 4 files, 6.7 KB), index 77.3 KB as JSON (20.9 KB packed), pruned from 92.3 KB, mode explore
$ xpl bundle complete -o talk.html --tour tour:intro
wrote talk.html (1.2 MB): .explainer/complete.explainer.json, 8 of 12 files embedded (referenced: 18.4 KB of source; --files all adds 4 files, 6.7 KB), index 77.3 KB as JSON (20.9 KB packed), pruned from 92.3 KB, mode present, tour tour:intro
$ xpl bundle complete -o all.html --files all
wrote all.html (1.2 MB): .explainer/complete.explainer.json, 12 files embedded (all: 25.1 KB of source), index 92.3 KB as JSON (24.7 KB packed), mode explore
```

**With a change recorded** (`xpl change`), every changed file that exists after the change is embedded, whatever `--files` says, and so is the code before the change of every modified, renamed or deleted file the page can show (`baseFiles` in the page, read from git). A file the index leaves out (`excluded`: an exported page over 1 MB, a lockfile) brings no old text unless a base anchor points into it; the page lists it with its counts and the reason it shows no diff. The summary line adds `change 5774f2c..349730f: 1 changed file in, code before the change of 1 file (3.2 KB)`, and names the changed files the selection had left out (`(2 added to the selection: ...)`).

`--json`: `{ok, readiness, exportStatus: "ready"|"draft", path, absolutePath, bytes, mode, tour?, anchors: {total, drifted, missing}, files: {embedded, choice, referenced?, boundary?: {added: [{file, reason: caller|callee|test, refs}], cut: [same], max, symbols}, embeddedBytes, indexed, indexedBytes}, change?: {base, head, changedFiles, addedToSelection: [paths], baseFiles: [paths], baseBytes, baseMissing?}, index: {path, commit, choice: "full"|"pruned", pruned, bytes, fullBytes, packedBytes, symbols: {embedded, indexed}, refs: {embedded, indexed}}}` (`index.bytes` and `fullBytes`: the embedded and the whole index as compact JSON; `packedBytes`: the embedded one as the page holds it).

## `xpl stage <explainer> --dir <outside-folder> [--preview] [--files referenced|boundary|all] [--note <reason>] [--require-review] [--pr-result <result.json>]`

Stages a ready guide locally, keeping earlier versions. First inspect the included source:

```sh
xpl stage guide --dir /absolute/outside/versions --preview --json
xpl stage guide --dir /absolute/outside/versions
```

`--preview` emits readiness and sorted `includedSource: {head, base}` without creating storage or HTML.
Without `--preview`, `xpl stage` prints these paths before it writes. `--files` reuses bundle selection: referenced by
default, boundary for direct callers/callees/tests, or all. Review evidence and change before/after files
are included as with bundle. There is no draft override; unfinished content, drift and stale source block
staging, also with `XPL_SKIP_STALE_CHECK=1`. Staging needs no review, unless you pass `--require-review`:
then it needs a current author review of all the text. Reviewer names are not checked.

The directory must be outside the source root and its Git checkout, including symlink ancestors.
Each read-only `version-*` folder contains `index.html` and `manifest.json`. The manifest records commits,
artifactIdentity, input/HTML SHA-256 hashes, readiness, included source and review state. Staging rechecks
the guide/index/source immediately before replacing a relative `current` symlink atomically under a lock.
Open `<dir>/current/index.html` or `<dir>/<version>/index.html`. When staging fails, the current page stays
and the new version is removed. A version that was staged is never overwritten.

For a PR guide, keep its prepared checkout and use the ready result from `xpl pr finish`:

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
Opening current resolves to its version folder (never changed once written) before navigation. The page's About this
explanation panel shows its version, included source and captured prior versions with their scope and
author review state. The existing query contract uses `version=<version-folder>`, `tour=<id>&step-id=<id>`,
`view=<id>&focus=<element>` (repeatable), or `file=<path>&range=1:1-1:6&side=head|base`.
The viewer searches source and symbols across contained guide snapshots. Results name the guide and index commit; source links add `guide=<key>&snapshot=<index-commit>&source-hash=<file-hash>`. The hash comes from the supplied file searched, so a changed file is rejected on open or reload even if the index commit stays the same. Navigation updates the hash from the head or Before file shown by the URL side. Current-guide links keep loaded files offline, including lazily fetched source. Save or cancel pending edits first. Reload reports missing source explicitly if the new bundle omits a file loaded only in the previous page. Missing files and pruned symbols stay labeled; catalog-only guides are not searched until opened.
Ranges use 1-based lines and inclusive UTF-16 columns; omitted columns select whole lines.
Column positions allow line length + 1, including column 1 on an empty line. Base paths are change head
keys, including renamed files and deleted files. Links resolve only supplied source.
Mismatched version queries refuse to show another snapshot. About this guide offers a link to the
current reading state and an Open latest version link through the sibling current page. Staging times
use the reader’s local format; earlier versions and technical identifiers sit behind disclosures.
Browser bookmarks retain the reading state. Earlier pages capture only history that existed
at staging. Keep the staged directory tree for sibling links; detached copies remain self-contained but
cannot navigate missing sibling versions. Save as HTML preserves navigation with the same query keys,
without live service attachment. An explicit navigation target overrides saved navigation as a whole.
Each Tour section links to its stable `tour` and `step-id`; a direct link restores the guide and focuses
that section, with an action to continue in Present. Search can select a step on the open Tour tab the same way.
A removed step falls back to the Tour tab with an explanation, even when its tour is gone.
Launch, saved HTML and browser Back/Forward share one restoration function. Applied step, view,
perspective, focus and source cursor are independent; restoring one does not clear another.
An empty `step-id=` records no applied step, including a tour detour. Older compact tour links without
view/focus still apply the requested step. A perspective switch keeps the applied step's source override.
Edited re-saves lose the staged version claim when their artifactIdentity changes.
This command configures no server, remote destination, credentials or upload. To point a PR at a staged
PR folder, use `xpl pr link` below.

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
