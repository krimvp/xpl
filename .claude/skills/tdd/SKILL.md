---
name: tdd
description: Test-first development in xpl - red, then green, one vertical slice at a time, at the right seam (core world, indexer source snippet, CLI in-process, viewer e2e). Use when building a feature or fixing a bug test-first, or when asked for "red-green" or regression tests.
---

# Test-driven development

Red, then green, one slice at a time. Tests assert behaviour through a public seam, against literal expected
values, so they survive refactoring.

## Pick the seam

Each behaviour has one owning seam. Test it there, once. Before writing a test, name the seam in one line
(and, for a feature with several, list them and confirm with the user).

| Behaviour                                             | Seam                                              | Helpers                                                                                                                                |
| ----------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Anchors, graph derivation, validation, patches, focus | `@xpl/core` functions over a small world          | `packages/core/test/helpers.ts`: `makeWorld`, `jobrunner()`, `anchor`, `group`, `edge`, `graphView`, `LLM`/`USER` provenance           |
| Symbols, sites, references of a language              | `buildIndex` / `extract` on inline source         | `packages/indexer/test/helpers.ts`: `makeDir`, `makeRepo`, `indexFiles`, `extract`, `refTriples`, `hasRef`, `symbolLines`              |
| A command's output, exit code, files written          | the CLI in-process (`run()`, the same as the bin) | `packages/cli/test/helpers.ts`: `copyFixture`, `indexedFixture`, `xpl`, `xplJson`, `editFile`, `git`                                   |
| What a reader sees and clicks                         | Playwright on a fixture bundle                    | `packages/viewer/e2e/helpers.ts`: `openBundle`, `byId`, `selectionOf`, `focusOf`, `watchProblems`; `window.__xpl` (`src/testHooks.ts`) |
| Precise references                                    | real SCIP tools, opt-in                           | `XPL_TEST_SCIP=1 npx vitest run packages/indexer/test/scip-integration.test.ts`                                                        |

Prefer the lowest seam that shows the behaviour. A rule in `applyPatch` is a core test, not a CLI test; the CLI
test only owns what the CLI adds (messages, exit codes, files).

## The loop

1. **Red.** Write one test for the next small behaviour. Run it alone and watch it fail for the reason you
   expect: `npx vitest run packages/core/test/apply.test.ts -t "keeps user summary"`. A test that never failed
   proves nothing. For a bug, the test reproduces the user's symptom on the unfixed code.
2. **Green.** The least code that passes. No speculative options.
3. **Next slice.** Let what the last cycle taught you pick the next test. Do not write all tests up front.
4. Refactor after green, with the tests as the net, as a separate step.

## Rules

- Expected values are literals or worked examples, never recomputed the way the code does it.
- No mocks of our own modules. Fakes are allowed at real seams: an injected `PreciseResolver`, a
  `GetText`, the `STUB_VIEWER_HTML` page.
- Fixture repos (`fixtures/*-jobrunner`) have load-bearing line numbers: anchors and acceptance tests point
  into them. Add a new file or a new fixture rather than shifting lines; if you must edit one, regenerate its
  committed explainer (see `packages/viewer/e2e/global-setup.ts`) and fix the acceptance tests in the same change.
- A test that drives the CLI copies the fixture to a temp dir (`copyFixture`); never write into `fixtures/`.
- Every new test passes the `test-audit` authoring gate.

## Finish

Run `test-audit` on the tests you wrote (strongly recommended before calling it done), then
`npm run typecheck && npm test`, plus `npm run test:e2e` when the viewer changed. Report the red run you saw,
the green run after, and what the audit changed.

Adapted from Matt Pocock's `tdd` (MIT, © 2026 Matt Pocock); see `../THIRD_PARTY.md`.
