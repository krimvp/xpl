---
name: ponytail-review
description: Review a diff in xpl only for over-engineering - what to delete, inline, reuse or shrink. One line per finding. Use for "what can we delete", "is this over-engineered", "simplify review", before opening a PR, or on /ponytail-review. Does not hunt bugs and does not apply fixes.
---

# Ponytail review

Find what to cut. The best outcome of a diff review is a shorter diff.

Scope: the diff against the base (`git diff origin/main...HEAD`, or the files named). Read each changed hunk
with enough surrounding code to know what already exists.

## Format

One line per finding: `<file>:L<line>: <tag> <what>. <replacement>.`

- `delete:` dead code, unused option, speculative feature. Replacement: nothing.
- `reuse:` duplicates a helper already in the repo. Name the path and function.
- `native:` hand-rolled thing Node, the browser or TypeScript ships. Name it.
- `dep:` a new dependency for what a few lines do, or one already covered by an installed package.
- `yagni:` an abstraction with one implementation, a config nobody sets, a layer with one caller.
- `shrink:` same logic, fewer lines. Show the shorter form.
- `docs:` prose that repeats the code, or a comment that narrates what the next line does.

Examples:

- `packages/cli/src/commands/foo.ts:L12-30: reuse: hand-written flag parsing. cli/src/args.ts already parses flags.`
- `packages/core/src/graph.ts:L88: yagni: EdgeSorter interface with one implementation. Inline the function.`
- `packages/viewer/src/components/X.tsx:L40-52: shrink: manual loop builds a Map. new Map(items.map(...)).`

End with `net: -<N> lines possible.` If there is nothing to cut: `Lean already. Ship.`

## Out of scope

Correctness, security and performance belong to a normal review (`/code-review`). Never flag the one runnable
check that proves non-trivial logic, input validation at a trust boundary, or the `precise`/`heuristic` labels.

Adapted from ponytail's `ponytail-review` (MIT, © 2026 DietrichGebert); see `../THIRD_PARTY.md`.
