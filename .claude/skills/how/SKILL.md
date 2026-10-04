---
name: how
description: Explain how a part of the xpl codebase works (a subsystem, a flow, a design decision) at the level of a senior engineer's onboarding notes, by reading the code, not guessing. Use for "how does X work", "walk me through Y", "why is Z built this way", and as grounding before a nontrivial change.
---

# How

Answer "how does X work in xpl?" well enough that the reader could start changing it. Read the code; never
infer behaviour from file names.

## 1. Frame the question

Say in one line what you take the question to mean, then explore. Do not ask for clarification unless two
readings lead to different subsystems. Classify it:

- **Simple**: one module or function (`how does find matching work in anchors.ts`). Explore and answer yourself.
- **Complex**: a flow across packages (`what happens between xpl apply and the viewer showing a box`). Split
  it into 2-4 slices and give each to a read-only `Explore` subagent in one message, then reconcile.

Good slices follow the package boundaries: indexer (files → `SymbolIndex`), core (anchors, graph
derivation, validation, patches), CLI (commands, git, server, bundle), viewer (store, derive, layout,
components).

## 2. Start from the contracts

1. `docs/ARCHITECTURE.md`: find the section first (`grep -n '^##' docs/ARCHITECTURE.md`). It states the
   algorithms and invariants; the code is the truth where they disagree (then tell the user, and see
   `docs-sync`).
2. `packages/core/src/schema.ts` and `patch.ts` for the data shapes.
3. Then the code, following calls.

## 3. Use xpl on itself

The repo has its own explainer and xpl reads TypeScript. From the repo root, after `npm run build`:

```sh
alias xpl="node $PWD/packages/cli/dist/xpl.mjs"
xpl index --precise off                       # a few seconds; precise takes ~40 s
xpl outline --under packages/core/src --depth 2
xpl search applyPatch --code
xpl show packages/core/src/apply.ts#applyPatch --refs
xpl refs packages/core/src/anchors.ts#resolveAnchor --in --depth 2
```

`refs` with `heuristic` resolution are hints: confirm a call with `show` before you state it. The committed
explainer `.explainer/xpl.explainer.json` (`xpl view xpl`) already explains the main flows; its summaries are a
fast map, but check them against the code.

## 4. Write the answer

Adapt this shape to the question; skip sections that add nothing.

- **Overview**: 1-2 paragraphs. What it is, what it does, why it exists.
- **Key concepts**: the types and terms needed for the rest (index, explainer, anchor, base anchor, view,
  overlay, stub, provenance, bundle...). Brief.
- **How it works**: the flow from trigger to effect, with the decision points. Prose, with `file:line`
  references. A small diagram only when the flow has more than three actors.
- **Where things live**: the few files someone would open first.
- **Gotchas**: what a newcomer would get wrong, and history that explains odd shapes (the dated reviews in
  `docs/review-*.md` often hold the why).

Write it per the `writing` skill. Every claim about behaviour comes from code you read in this session.

## Critique mode

When asked what is wrong with a design, explain first, then give the explanation and file list to 2-3
independent subagents asking each for architectural problems (deep vs shallow modules, leaks across the
package boundaries, duplicated rules, places where docs and code disagree). Judge their findings yourself:
act on, consider, noted, dismissed, each with a reason.

Adapted from poteto/how (MIT, © 2026 Lauren Tan); see `../THIRD_PARTY.md`.
