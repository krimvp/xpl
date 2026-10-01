# xpl — code explainer

Interactive diagrams linked to code in both directions. Click a box, an arrow, a sequence step or a concept
and the editor highlights exactly the code it is about, across as many files as it touches, everything else
dimmed. Put the cursor in the code and the diagram elements and concepts that cover that line light up.
Claude writes the explanation as data, checked against a static index of your repo so it cannot point at
code that is not there; a fixed viewer renders it, live or as one HTML file you can share or present.

![Explore mode: the step requeue(job, backoff) is selected; its call site in runner.ts and the method it calls in queue.ts are highlighted, the rest of both files is dimmed](docs/images/dispatch-step-selected-light.png)

![Present mode: step 2 of a tour, with the retry policy's code, config and test on the right](docs/images/tour-step-2-light.png)

## Quick start

Needs Node 22.12 or newer.

```sh
npm install && npm run build
mkdir -p ~/.claude/skills && ln -s "$PWD/skill/code-explainer" ~/.claude/skills/code-explainer
alias xpl="$HOME/.claude/skills/code-explainer/bin/xpl"   # the CLI, for your own use
```

Link it, do not copy it: the skill's launcher finds the built CLI relative to its real path. Then, in any
TypeScript, Python or Go repository, ask Claude Code:

```
/code-explainer explain How does X work?
```

Claude indexes the repo, writes `.explainer/<name>.explainer.json` (commit it; the indexes beside it are
git-ignored) and gives you the result. Open it yourself with `xpl bundle <name> -o <name>.html` (one
self-contained file that carries the source files the explainer shows: works offline, easy to share;
`--files all` embeds every file of the repo) or `xpl view <name>` (a local server with live repo access:
your edits are saved and "Explain this" clicks are queued for Claude). Other things to ask for: `explain this
repo`, `expand <node>`, `make a tour` (Present mode: arrow keys step through it). More in
[skill/code-explainer/README.md](skill/code-explainer/README.md).

No Claude at hand? Every fixture ships an explainer:

```sh
cp -r fixtures/ts-jobrunner /tmp/jobrunner && cd /tmp/jobrunner
xpl index && xpl view jobrunner    # http://127.0.0.1:4747
```

## Using the CLI directly

Run these inside the repository you want to explain (or pass `--root <dir>`); every command takes `--json`.
The ids are those of the TS fixture from the quick start.

```sh
xpl index                                       # symbols and references -> .explainer/index-<commit>.json
xpl outline --depth 2                           # dirs, files, symbols: exact ids, line ranges, fan-in/out
xpl show src/runner.ts#Runner.dispatch --refs   # code with the 0-based offsets anchors use, and its calls
xpl refs src/queue.ts#Queue.requeue --in        # who calls it (hops through interfaces)
xpl new myrepo --title "My repo"                # .explainer/myrepo.explainer.json, bound to the index
xpl apply myrepo patch.json                     # check a patch against the index, then merge it: all or nothing
xpl validate myrepo                             # every id and anchor still resolves?
xpl view myrepo                                 # http://127.0.0.1:4747 (falls back to a free port)
xpl bundle myrepo -o myrepo.html                # one self-contained HTML file (--files all: every file; --tour <id>: a tour)
```

`xpl search`, `xpl anchors`, `xpl resolve` (after the code changed) and `xpl status` (what still needs
explaining) complete the set: [skill/code-explainer/reference/cli.md](skill/code-explainer/reference/cli.md).
The format of `patch.json`: [skill/code-explainer/reference/patch-format.md](skill/code-explainer/reference/patch-format.md).

## Languages and precision

TypeScript/JavaScript, Python and Go get symbols and references. YAML, JSON and TOML get their keys as
symbols (`config/default.yaml#retry.maxRetries` or `pyproject.toml#project.scripts.flask` can be anchored like
a function); any other text file is indexed as plain text. Symbols always come from tree-sitter (WASM, nothing
to install). References (calls, imports, inheritance, type uses, reads of variables and fields) come from a
scope-aware heuristic resolver, or, when the tool can run, from a compiler-grade SCIP indexer. `xpl index`
tries SCIP by default and prints what each language got: `refs: precise (scip-go@0.2.7)` or `refs: heuristic`.
The viewer draws heuristic edges lighter, and Claude treats them as hints.

| Language         | Precise references need                                                             |
| ---------------- | ----------------------------------------------------------------------------------- |
| TS / JS          | `npx` and, on first use, network access: `scip-typescript` 0.4.0                    |
| Python           | `npx` and, on first use, network access: `scip-python` 0.6.6                        |
| Go               | Go 1.25 or newer, or an older `go` that may download the toolchain: `scip-go` 0.2.7 |
| YAML, JSON, TOML | nothing: keys are symbols, there are no references                                  |

`--precise off` skips SCIP (fast, heuristic), `--precise require` fails instead of falling back;
`XPL_SCIP_TIMEOUT_MS` sets the per-tool timeout (default 10 minutes). Files a tool did not describe (build-tagged
Go files, for one) keep their heuristic references and are named in a warning; the summary then reads
`refs: precise 10/11 (scip-go@0.2.7), 1 heuristic`.

## Repository layout

| Path                   | What                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------- |
| `packages/core`        | `@xpl/core`: schema types and pure logic (anchors, graph derivation, validation, patches). Browser-safe. |
| `packages/indexer`     | `@xpl/indexer`: file discovery, tree-sitter (WASM) language packs, heuristic resolver, SCIP import.      |
| `packages/cli`         | `@xpl/cli`: the `xpl` command, bundled to `packages/cli/dist/xpl.mjs`.                                   |
| `packages/viewer`      | `@xpl/viewer`: React + CodeMirror 6 + elkjs, built to one `index.html`.                                  |
| `skill/code-explainer` | The Claude skill: `SKILL.md`, CLI and patch references, worked examples, launcher.                       |
| `fixtures/`            | Tiny real repos (a job runner in TS, Python and Go) with committed explainers.                           |
| `docs/`                | Architecture, the original design brief, images.                                                         |

## Development

```sh
npm install          # dependency install scripts are disabled on purpose, see .npmrc
npm run typecheck    # tsc --noEmit in every package
npm test             # vitest: unit tests of all packages (packages/*/test)
npm run build        # viewer (Vite single file) first, then the CLI bundle
npm run test:e2e     # builds the viewer, then Playwright against dist/index.html
XPL_TEST_SCIP=1 npx vitest run packages/indexer/test/scip-integration.test.ts   # real SCIP indexers
npm run format       # prettier --write . (format:check to verify)
```

Workspace packages export their TypeScript sources; vitest, tsx and vite read them directly, so there is no
build step between packages in development. After `npm run build`, `node packages/cli/dist/xpl.mjs __smoke`
(hidden) loads every tree-sitter grammar from `dist/wasm`.

- The tree-sitter grammars are the `.wasm` files shipped inside their npm packages (versions pinned exactly:
  the wasm ABI has to match `web-tree-sitter`). Use `initParser()` / `loadLanguage()` from
  `packages/indexer/src/wasm.ts`, never `Parser.init()`. `XPL_WASM_DIR` redirects the wasm files.
- Playwright must match the browsers preinstalled in `PLAYWRIGHT_BROWSERS_PATH` (`/opt/pw-browsers` in the
  sandbox), hence `@playwright/test@1.56.1`. Do not run `playwright install` there. The e2e run rewrites the
  screenshots in `packages/viewer/e2e/screenshots/`; the two above are copies in `docs/images/`.
- `.npmrc` sets `ignore-scripts=true`, so npm also skips `pre*`/`post*` scripts of our own packages.
- Fixture line numbers are load-bearing (anchors, acceptance tests): prettier ignores `fixtures/`.

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how it is built: schema, indexer, anchors and patches, CLI and
  server API, viewer, known limitations.
- [docs/handoff.md](docs/handoff.md): the original design brief (schema draft and worked example).
- [docs/review-2026-10-01.md](docs/review-2026-10-01.md): review of four generated explainers (two PRs,
  a whole repo, a subsystem), what that iteration changed, a validation run on an unseen PR, and the
  roadmap.
- [skill/code-explainer/](skill/code-explainer/): what Claude reads: `SKILL.md`, `reference/`.
