---
name: test-audit
description: Value bar for tests in xpl. An authoring gate for every new or changed test, and an audit workflow for low-value, duplicated or implementation-coupled tests and the test-only seams they keep alive. Use whenever writing, changing, reviewing or sweeping tests, and before calling any code change finished (strongly recommended).
---

# Test audit

**Before any change is called finished, run the authoring gate on every test it adds or touches, and check
the tests that own the changed code.** AGENTS.md lists this first under "Done means", and the stop hook
reminds you. Report what you found, even "no change needed".

Two modes, one bar. **Authoring**: gate every new or changed test as you write it. **Audit**: sweep a package
for tests that do not earn their upkeep. Optimise for confidence, not for a deletion count.

## Authoring gate

Before adding a test, answer all four. A missing answer means do not add it yet.

1. What observable behaviour, invariant or contract does it protect?
2. What credible regression makes it fail?
3. Why does existing coverage not catch that already? Each contract has one owning test at the strongest seam
   (`tdd` lists them). Extend a table-driven case or an existing `describe` before writing a near-duplicate.
4. Does it need a production seam (an export, a flag, a hook) that no production caller uses? Then test at
   the real boundary instead. (`window.__xpl` is a deliberate, documented exception: the viewer contract.)

Then check it against the junk patterns below. A test that breaks under a behaviour-preserving refactor
asserts implementation; rewrite it at the owning seam.

A regression test must fail on the unfixed code for the intended reason. One regression at the owning seam
covers the bug; do not replay it in core, CLI and e2e.

## Junk patterns

- no assertion, or an assertion that cannot fail (`toBeDefined` on a value that is always defined);
- expected values computed by the code under test, or the same way it computes them;
- a snapshot nobody reads (large `toMatchSnapshot`/inline JSON of a whole index or explainer) where one
  literal field would do;
- copied lists (exports, rule names, flags) that only restate the source;
- the same contract tested in several packages with nothing new at each layer;
- mocks of our own modules, or a mock that implements the behaviour being asserted;
- a test name that promises more than its input exercises;
- negative tests that pass for an unrelated reason (a different validation error than the one named);
- a negative check with nothing positive before it: "shows no toggle" passes on a page that never drew the
  pane; first assert what must be there;
- an assertion that may not run: `if (res) expect(res.status)...` skips silently; assert the condition first
  (`expect(r.ok).toBe(false); if (!r.ok) ...` is fine), or make the outcome certain;
- `some(...)`/`every(...)` booleans, `toContain` or `> 0` where the whole list or count is known: the failure
  says only "expected false to be true", wrong extras slip through, and `every` passes on an empty list;
- e2e: a one-shot read after an action (`expect((await stateOf(page)).x)`, `document.activeElement`) instead
  of a retrying `expect.poll` or web-first assertion (`toBeFocused`, `toHaveText`), or a fixed
  `waitForTimeout` (only to give a "nothing else happens" check time to fail);
- dead production code whose only callers are tests. `packages/cli/test/dead-exports.test.ts` fails on an
  export no production source uses; a deliberate test seam goes in its `TEST_SEAMS` with the reason.

## What to keep

Keep a test that independently guards a contract users rely on: the schema and patch format, CLI output and
exit codes, the bundle format, provenance protection, anchor resolution, `precise`/`heuristic` labelling,
fixture acceptance tests, the self-explainer check, the skill examples check. Keep observable ordering, and
regressions with a credible failure mode. Slow is not a reason to delete; move it behind an opt-in like
`XPL_TEST_SCIP` only when it needs the network.

## Audit mode

1. Pick one package or one area (`packages/indexer/test/python-*`). Read root `AGENTS.md` first.
2. Read-only discovery: for each candidate, read the whole test, the production code it covers, its callers,
   and overlapping tests. Record: the test name and location, what failure it can detect, the stronger test
   that remains, the history (`git log -L` or `git log --follow`), what deletion it unlocks, and the command
   that validates the change. A candidate missing a field is not ready.
3. Edit one coherent batch: delete, merge into a table, or move to the owning seam. Delete test-only exports
   and dead production paths with them.
4. Validate: the touched test files, then `npm test`, `npm run typecheck`, `npm run format:check`,
   `git diff --check`. Report production and test line counts separately (`git diff --numstat`).
5. Report removed categories, what you kept that looked like junk and why, and the proof you ran.

Never edit tests while a vitest watch run is going in the same checkout.

Adapted from OpenClaw's `test-audit` (MIT, © 2026 OpenClaw Foundation); see `../THIRD_PARTY.md`.
