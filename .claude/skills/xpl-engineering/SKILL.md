---
name: xpl-engineering
description: How to work on the xpl codebase. Principles and routing for any code change here (feature, fix, refactor, test, doc). Use at the start of any nontrivial task in this repo, or when unsure which skill applies.
---

# Working on xpl

xpl turns code into explainers: a static index (`@xpl/indexer`), pure logic over a JSON schema (`@xpl/core`), a
CLI (`@xpl/cli`) and a single-file viewer (`@xpl/viewer`). Its promise to users is that **an explainer cannot
point at code that is not there**. Every change here keeps that promise, keeps the docs true, and proves itself
on the real artifact.

Read `AGENTS.md` first. This skill adds the working method.

## Route the task

| Task                                                                                                                          | Skill                                        |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| "How does X work?", or you need a model of a subsystem before changing it                                                     | `how`                                        |
| A change that crosses a package boundary, adds or changes a schema field, a patch rule, a CLI command, or the levels of a map | `architect`                                  |
| New behaviour or a bug fix with a clear seam                                                                                  | `tdd`                                        |
| Something is broken, flaky or slow and the cause is unknown                                                                   | `diagnose`                                   |
| Writing, changing or reviewing tests, and before calling any change finished                                                  | `test-audit`                                 |
| Any code you are about to write                                                                                               | `ponytail` (the ladder)                      |
| Reviewing a diff for things to delete                                                                                         | `ponytail-review`                            |
| The change touches behaviour that docs, the product skill or `.explainer/xpl.explainer.json` describe                         | `docs-sync`                                  |
| The change is visible in the viewer, or changes what a map shows at a level                                                   | `pr-screenshots`                             |
| Committing, pushing, opening a PR                                                                                             | `open-pr`                                    |
| Any prose: docs, commit messages, PR bodies, comments, reader text                                                            | `writing`                                    |
| Explaining this repo or a PR of it with xpl itself                                                                            | `code-explainer` (the product skill, linked) |

## Principles

Each one names when it applies and what it changes.

1. **Read fully, then be lazy.** Trace the real flow before you pick a fix. Then take the smallest change that
   solves the problem at its root: one guard in the shared function, not one per caller (`ponytail`).
2. **Name the data shape first.** Most of xpl is types in `packages/core/src/schema.ts` and `patch.ts` and pure
   functions over them. Before code, say which types change and who reads them (index, explainer, bundle,
   viewer state). A new field touches the schema, validation, the patch rules, the docs and often the viewer.
3. **Respect the package boundaries.** `core` is browser-safe (no `node:*`), deterministic and pure. The
   indexer turns files into a `SymbolIndex`. The CLI owns the filesystem, git and the server. The viewer only
   renders a `ViewerBundle`. Put logic in the lowest package that can own it, and test it there.
4. **Trust labels, not guesses.** Every reference says `precise` or `heuristic`. Never let a heuristic result
   pass as precise, and never drop the label to make a feature simpler.
5. **The user's edits win.** Provenance (`origin`, `userFields`) is a contract: an `llm` patch never
   overwrites user text. Any change to `applyPatch` keeps that true and has a test for it.
6. **Fix the root cause.** Reproduce first. A failing test is never a flake until a re-run on the same commit
   passes, and even then find why.
7. **Test behaviour at the owning boundary.** Assert what a user of the function, CLI or page sees, against a
   literal. Fixture line numbers are load-bearing; never reformat `fixtures/`.
8. **Prove it on the real artifact.** Typecheck and unit tests are the floor. A CLI change is run on a
   fixture copy (`xpl index && xpl validate`). A viewer change is looked at (screenshots) and covered by e2e.
   A precision change is checked on a real repository when it can be.
9. **Encode lessons in structure.** When you catch yourself writing the same rule twice, make it a lint, a
   validation error, a test or a script instead of more prose. `xpl lint`, `validateExplainer` and
   `self-explainer.test.ts` exist for this reason.
10. **Docs are part of the change.** `docs/ARCHITECTURE.md` was written before the code and is kept true to it.
    Where they disagree, fix one of them in the same commit (`docs-sync`).

## Autonomy

Do everything a tool can do yourself, without asking: edits, tests, builds, scripts, screenshots, pushing
your own branch and the `pr-assets` branch, re-anchoring the self-explainer. Ask the user only for decisions:
a product or design choice no experiment settles, or anything irreversible on shared state (pushing to
`main`, force-pushes, deleting branches someone else uses). When the request has two
materially different readings, ask one short question with concrete options; otherwise state your assumption
and go.

## Done means

The list in `AGENTS.md` ("Done means"); the stop hook (`.claude/hooks/stop-check.sh`) hands it back to you
filled in for your diff. In short:

- **Run `test-audit` before you call it finished. Strongly recommended, every time code or tests changed.**
  Gate each new or changed test, check the tests that own the changed code, and say what the audit found.
- `npm run typecheck`, `npm test`, `npm run format:check` pass (and `npm run test:e2e` for viewer changes).
- Docs, the product skill and the self-explainer agree with the code (`docs-sync`).
- Screenshots are published when `scripts/needs-screenshots.sh` says so (`pr-screenshots`).
- The reply says what changed for a user of xpl, what you ran to prove it, and what you did not check.

Adapted from poteto's `poteto-mode` (cursor/plugins pstack, MIT, © 2026 Lauren Tan); see `../THIRD_PARTY.md`.
