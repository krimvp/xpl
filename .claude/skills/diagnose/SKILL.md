---
name: diagnose
description: Diagnosis loop for hard bugs, wrong references, flaky tests and slowness in xpl - build a tight red-capable feedback loop first, then reproduce, minimise, hypothesise, fix at the root. Use when something is broken, throwing, failing, flaky or slow and the cause is not obvious.
---

# Diagnose

No theory before a loop. A tight pass/fail signal that goes red on this bug finds the cause; staring at code
does not.

## 1. Build the feedback loop

One command, already run once, that is red on this bug, deterministic and fast. Ways that work here, roughly
in order:

1. **A vitest test** at the owning seam (`tdd` skill has the seams and helpers). Run alone:
   `npx vitest run <file> -t "<name>"`.
2. **The CLI on a fixture copy**: copy `fixtures/ts-jobrunner` to a temp dir, then run
   `xpl index --precise off` and the failing command there (`xpl refs src/queue.ts#Queue.requeue --in --json`),
   diffed against the expected output.
3. **The indexer on a snippet**: a temp dir with the 5 lines that trigger it, then `xpl index` and
   `xpl show <id> --refs`. For reference bugs, compare `--precise off` with `--precise require` (the SCIP
   answer is the reference when the tool can run).
4. **A Playwright script** on a bundle: `openBundle` + `window.__xpl` hooks (`selection()`, `focus()`,
   `matches()`, `state()`), asserting on the DOM and on `watchProblems` (console errors).
5. **A real repository** for scale or precision issues (the stress test in `docs/review-2026-10-03-stress.md`
   lists the ones used and how).
6. **A differential loop**: the same input on two commits (`git worktree add`), or heuristic against precise.
7. **Bisection**: `git bisect run <the loop>` when it worked before.

Tighten it: narrower input, `--precise off`, one test file, a fixed seed. A 2-second loop beats a 2-minute one.
If you truly cannot build a loop, say so, list what you tried, and ask for the input that shows the bug.

## 2. Reproduce and minimise

Confirm the loop shows the symptom the user described, not a nearby one. Then cut inputs, files, lines and
options one at a time, re-running after each, until only what is needed for the failure is left.

## 3. Hypothesise and test

Write down 2-3 hypotheses ranked by likelihood, each with the observation that would refute it. Test the
cheapest first: a log line, an assertion, a narrower input. Do not change two things at once.

## 4. Fix at the root

Find the shared function every caller routes through and fix it there. Check the siblings: a bug in the TS
pack's site rules often exists in the Python and Go packs too, a bug in one view type in the others. Keep the
minimised loop as the regression test, at the owning seam; it must fail before the fix.

## 5. Flaky tests

A flake is a bug with a low reproduction rate. Raise the rate (loop the test 50 times, `--repeat-each` in
Playwright, parallel workers), then diagnose like any other bug. Never skip, retry-wrap or loosen an assertion
to make it pass.

## Report

The loop command and its red output, the root cause in one or two sentences, the fix, the green run, and the
siblings you checked.

Adapted from Matt Pocock's `diagnosing-bugs` (MIT, © 2026 Matt Pocock); see `../THIRD_PARTY.md`.
