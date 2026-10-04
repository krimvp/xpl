# AGENTS.md

Guidance for coding agents (Claude Code, Codex, Cursor and others) working on this repository. Humans start
with [README.md](README.md).

## What this is

xpl is a **code explainer**. It produces an interactive page where diagrams (a box-and-arrow map, a process
flow, a sequence diagram) are linked both ways to code. Click a box, an arrow or a step and the editor
highlights the exact code. Put the cursor in code and the diagram elements that cover it light up. An LLM
(Claude, through the skill in `skill/code-explainer`) writes the explanation as data. The CLI checks every
claim against a static index of the repository, so **an explainer cannot point at code that is not there**.
That promise is what the whole design protects.

```
source ── xpl index ──→ .explainer/index-<commit>.json ──┐   static analysis; generated, git-ignored
                                                         ├──→ xpl view | xpl bundle ──→ viewer
Claude ── patch.json ── xpl apply ──→ <name>.explainer.json ┘   what Claude and the user add; committed
git ───── xpl change ───────────────↗                          a change (PR): base, head, changed files, hunks
```

Three scopes: a question about part of a project, a whole repository (C4-style levels: system, inside a
service, code), or a change between two commits (with a diff and "before" claims checked against the base).

## Repository map

| Path                            | What                                                                                                                                                                                                                              | Read before changing it                                  |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `packages/core`                 | `@xpl/core`: the schema (`schema.ts`), patch types and merge rules (`patch.ts` header), anchors, graph derivation, stubs, levels, focus, validation, `applyPatch`, bundle format. Pure and browser-safe: **no `node:*` imports**. | ARCHITECTURE §2, §4                                      |
| `packages/indexer`              | `@xpl/indexer`: file discovery, tree-sitter (WASM) language packs for TS/JS, Python, Go, YAML, JSON, TOML; the heuristic resolver; SCIP import for precise references.                                                            | ARCHITECTURE §3                                          |
| `packages/cli`                  | `@xpl/cli`: the `xpl` command (16 subcommands in `src/commands/`), git access, lint, drafts, the local server, bundling. Built with esbuild to `dist/xpl.mjs`.                                                                    | ARCHITECTURE §5, `skill/code-explainer/reference/cli.md` |
| `packages/viewer`               | `@xpl/viewer`: React 19 + CodeMirror 6 + dagre, built by Vite to one self-contained `dist/index.html`. Read, Explore and Present modes.                                                                                           | ARCHITECTURE §6                                          |
| `skill/code-explainer`          | **The product skill** that end users install: how Claude makes an explainer. Not instructions for working on this repo.                                                                                                           | ARCHITECTURE §7                                          |
| `fixtures/{ts,py,go}-jobrunner` | Tiny real repos with committed explainers; acceptance tests point into them by line.                                                                                                                                              | ARCHITECTURE §8                                          |
| `.explainer/xpl.explainer.json` | xpl's own explainer of itself. Checked against the code by a test.                                                                                                                                                                | `docs-sync` skill                                        |
| `docs/`                         | `ARCHITECTURE.md` (the contracts), `handoff.md` (the original brief), dated reviews (historical records).                                                                                                                         |                                                          |
| `.claude/skills/`               | Skills for working on this repo (see below).                                                                                                                                                                                      |                                                          |

Deeper reading, in this order: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §0 (the decisions and why) and
§1 (layout and conventions), then the section of the package you touch. `docs/ARCHITECTURE.md` is long:
`grep -n '^##' docs/ARCHITECTURE.md` and read the section you need. The dated reviews in `docs/review-*.md`
hold the history behind many shapes (what was tried, what failed, measured accuracy and speed).

## Commands

Node 22.12 or newer. From the repo root:

```sh
npm install                    # dependency install scripts are disabled on purpose (.npmrc)
npm run typecheck              # tsc --noEmit, root and every package
npm test                       # vitest: unit tests of all packages (packages/*/test), ~40 s
npx vitest run packages/core/test/apply.test.ts -t "name"     # one file or one test
npm run build                  # viewer first, then the CLI (copies the viewer and wasm next to itself)
npm run test:e2e               # builds the viewer, builds fixture bundles, runs Playwright
npm run format:check           # prettier; `npm run format` to fix
XPL_TEST_SCIP=1 npx vitest run packages/indexer/test/scip-integration.test.ts   # real SCIP tools, needs network
```

After `npm run build`, the CLI is `node packages/cli/dist/xpl.mjs` (alias it `xpl`). Try it on a copy of a
fixture, never in `fixtures/` itself: `cp -r fixtures/ts-jobrunner /tmp/j && cd /tmp/j && xpl index && xpl
validate jobrunner`. You can also run xpl on this repository (`xpl index --precise off && xpl outline`).

CI (`.github/workflows/ci.yml`) runs the same checks on every push and pull request; run them locally first
so a push is green.

## Invariants and gotchas

- **Package boundaries.** Logic goes in the lowest package that can own it. `core` stays pure and
  browser-safe (the viewer imports it). The viewer renders a `ViewerBundle` and nothing else.
- **No build step between packages in development.** Workspace packages export their TypeScript sources
  (`"exports": "./src/index.ts"`); vitest, tsx and vite read them directly. Relative imports use `.js`
  suffixes (NodeNext).
- **Trust labels.** Every reference is `precise` (SCIP) or `heuristic`. Never blur the two.
- **User edits win.** Explainer elements carry provenance; an `llm` patch never overwrites `origin: "user"`
  elements or `userFields`. Changes to `applyPatch` keep this and test it.
- **The explainer file is written only by `xpl apply` and `xpl change`.** Never hand-edit
  `*.explainer.json`; write a patch.
- **Fixture line numbers are load-bearing.** Prettier ignores `fixtures/`. Do not reformat or shift lines
  there; see the `tdd` skill if a fixture must change.
- **`docs/` is hand-formatted.** Prettier ignores it; keep lines near 110 columns.
- **Tree-sitter grammars** are the `.wasm` files inside their npm packages, versions pinned exactly (the wasm
  ABI must match `web-tree-sitter`). Use `initParser()` / `loadLanguage()` from
  `packages/indexer/src/wasm.ts`, never `Parser.init()`.
- **`.npmrc` sets `ignore-scripts=true`**, so npm also skips `pre*`/`post*` scripts of our own packages. Do
  not add any.
- **Playwright is pinned to 1.56.1** to match the preinstalled browsers (`PLAYWRIGHT_BROWSERS_PATH`). Never
  run `playwright install` in a sandbox that has them; only CI installs its own.
- **Keep patch files and scratch output outside the repo.** A new file in the repo changes the index commit id.
- **Docs are part of the change.** Where code and `docs/ARCHITECTURE.md` disagree, fix one of them in the
  same commit. That includes `--help` text, the product skill references, and the self-explainer:
  `packages/cli/test/self-explainer.test.ts` fails when code under one of its anchors changes (docs and the
  skill included). Re-anchor it in the same change (`docs-sync` skill).
- **Dated records are history.** Do not edit `docs/review-*.md`, `docs/handoff.md` or `docs/analysis-*.txt`.

## Design principles

The ones this codebase is built on (ARCHITECTURE §0 has the full reasoning):

1. **Claims are checked, not trusted.** Every anchor resolves against the index and carries a hash; drift is
   detected and reported, never silently patched over.
2. **Hybrid analysis.** tree-sitter gives one symbol model for every language; SCIP upgrades references where
   its tool can run; the heuristic fills in and says so.
3. **Drafts without an LLM.** Structure (boxes, steps, anchors, tour order) comes from the index; the LLM
   writes only text, and `xpl lint` checks that text mechanically.
4. **One index, at the head.** A change explainer reads its base from git, never indexes it.
5. **Few, deep seams.** `LanguagePack`, `PreciseResolver`, `GetText`/`TextCache`, the patch format,
   `ViewerBundle`. Extend through them before adding new ones.
6. **Readers first.** Explainers go top-down (system, then a service, then code) in plain words; the viewer
   is judged by what a reader sees.

## Done means

An agent does not call work finished until each item is done or the reply says why it does not apply:

1. **Run the `test-audit` skill. This is a strong recommendation, not a formality.** Put every test the
   change adds or touches through its authoring gate, and check the tests that own the changed code: does
   each one protect behaviour at its owning seam, and would it fail on the regression it claims to catch? A
   regression test must have failed before the fix. Report what the audit found, even "nothing to change".
2. `npm run typecheck`, `npm test`, `npm run format:check` pass, plus `npm run test:e2e` for viewer changes.
3. Docs, `--help` text, the product skill and `.explainer/xpl.explainer.json` match the code (`docs-sync`).
4. Screenshots are published and in the PR description when `scripts/needs-screenshots.sh` says so.
5. The reply says what changed for a user of xpl, what you ran to prove it, and what you did not check.

## Automation

Do yourself everything a tool can do; ask the user only for decisions, never to run a step.

- **CI** (`.github/workflows/ci.yml`): typecheck, unit tests, format and e2e on every push and PR. On a PR
  that needs screenshots it takes them, pushes them to the `pr-assets` branch and posts or updates one
  comment with Before/After images.
- **Scripts**: `scripts/needs-screenshots.sh` (are screenshots required?), `scripts/pr-screenshots.sh`
  (take them; `--publish` also pushes them and prints the PR section), `scripts/publish-pr-shots.sh` (push a
  compare directory to `pr-assets`). The `pr-assets` branch only holds screenshots; push to it freely.
- **Claude Code hooks** (`.claude/hooks/`, registered in `.claude/settings.json`): `session-start.sh`
  installs dependencies, builds the CLI and viewer and fetches `origin/main` in cloud sessions;
  `format-on-edit.sh` runs prettier on every file an agent edits; `stop-check.sh` stops an agent once per
  state of the change, before it finishes, with the "Done means" list above filled in for its diff (which
  tests changed, whether screenshots are required). Other agents run the same steps by hand.

## Pull requests

- Use `.github/pull_request_template.md`. Lead with what changes for a user of xpl, then the proof you ran.
- **Screenshots are required** in the PR description, Before and After, when a change touches the viewer's
  UI or UX, **or can affect abstraction levels**: what a map shows at the system, service or code level,
  grouping and zoom (`opens`, trails), stubs, lifted or derived edges, `xpl draft repo` levels, or which
  package owns what. `scripts/needs-screenshots.sh` says whether a change needs them.
  `scripts/pr-screenshots.sh origin/main --publish` (the `pr-screenshots` skill) photographs base and head
  the same way, publishes the changed shots side by side and prints the Screenshots section to paste. Do it
  without asking; CI also posts them as a PR comment.
- Commits: conventional, scoped by package (`fix(indexer):`, `feat(viewer):`, `docs(explainer):`), with the
  subject stating the new behaviour in plain words (see recent `git log`).
- Never push to `main` directly, never force-push a shared branch, never skip or loosen a test to get green.

## Skills

Project skills live in `.claude/skills/` (`.agents/skills` links to the same place). Start with
`xpl-engineering`, which routes to the rest:

| Skill                         | Use for                                                                                |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| `xpl-engineering`             | Principles and routing for any change here                                             |
| `how`                         | Explaining a subsystem from the code; grounding before a change                        |
| `architect`                   | Designing changes across packages, schema, patch format, CLI, map levels               |
| `tdd`                         | Test-first work at the right seam (core world, indexer snippet, CLI in-process, e2e)   |
| `diagnose`                    | Hard bugs, wrong references, flaky tests, slowness                                     |
| `test-audit`                  | The bar for adding, keeping or deleting tests                                          |
| `ponytail`, `ponytail-review` | The smallest solution; reviewing a diff for what to cut                                |
| `docs-sync`                   | Keeping ARCHITECTURE, README, help text, the product skill and the self-explainer true |
| `pr-screenshots`              | Before/after images for UI and abstraction-level changes                               |
| `open-pr`                     | The checklist before pushing and opening a PR                                          |
| `writing`                     | Docs, commits, PR bodies, comments                                                     |
| `code-explainer`              | The product skill itself (linked), to explain this repo or a PR of it with xpl         |
