---
name: writing
description: Prose rules for xpl - docs, commit messages, PR descriptions, code comments, help text and the reader-facing text of explainers. Plain words, short sentences, mechanisms and numbers instead of adjectives. Use whenever writing or editing any prose in this repo.
---

# Writing

xpl's own product is plain-language explanation, and its docs are written the same way. Match them.

## The house style

Look at `docs/ARCHITECTURE.md`, the README and recent commit messages before writing. They:

- state what a thing does, in the present tense, with the mechanism or the number: "`--precise off` took 15
  to 40 seconds", "a bundle refuses while anchors are drifted";
- use short declarative sentences, one idea each, with articles and verbs (no telegraph style);
- name the code exactly (`applyPatch`, `xpl resolve --write`, `GraphView.excludeFiles`) in code spans;
- say the limit next to the claim: what is not handled, where a heuristic can be wrong;
- use sentence-case headings and no emojis.

## Commit messages

Conventional commits with the package as scope: `feat(viewer):`, `fix(indexer,cli):`, `perf(core):`,
`test(indexer):`, `docs:`, `docs(explainer):` (re-anchoring `.explainer/xpl.explainer.json`). The subject is
a plain statement of the new behaviour, not of the edit:

- good: `fix(indexer): a function or class expression's own name means its declared symbol`
- good: `feat(cli): outline marks recursive symbols; README says what precise mode costs`
- bad: `fix: update heuristic.ts`, `feat: improve outline`

The body says why, what a user notices, and what moved (for re-anchoring: which spans and why). Wrap near 72.

## PR descriptions

Follow `.github/pull_request_template.md`. Lead with what changes for a user of xpl (someone reading an
explainer, someone running the CLI, Claude using the skill), then how it works, then the proof you ran. Include
the Screenshots section whenever `pr-screenshots` applies.

## Comments

Keep a comment only for a non-obvious why, a contract, or a known ceiling. Module headers in this repo
describe the module's contract and are kept up to date (they are often what the self-explainer anchors).
No comments that narrate the next line.

## Cut these

- filler: "in order to" (to), "due to the fact that" (because), "it is important to note that" (delete);
- inflated words: leverage, utilize, robust, seamless, crucial, delve, enhance, showcase, comprehensive;
- "serves as", "stands as", "boasts" (is, has);
- hedging stacks ("could potentially"), generic conclusions, rule-of-three padding;
- long dashes used as connectors: end the sentence or use a comma;
- feelings instead of facts ("powerful", "fast"): give the mechanism or the measurement;
- claims without evidence: say measured, inferred or guessed, and link only what you read or produced.

## Reader-facing text of explainers

Text that ends up in an explainer (summaries, tour notes, titles) follows the product's own rules in
`skill/code-explainer/reference/writing.md`, which `xpl lint` checks mechanically.

Adapted in part from poteto's `unslop` and `technical-writing` (cursor/plugins pstack, MIT, © 2026 Lauren
Tan); see `../THIRD_PARTY.md`.
