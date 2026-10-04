---
name: docs-sync
description: Keep xpl's docs true to its code in the same change - docs/ARCHITECTURE.md, README.md, the product skill (skill/code-explainer), in-code help text, and xpl's own explainer (.explainer/xpl.explainer.json, checked by self-explainer.test.ts). Use after any behaviour change, when self-explainer.test.ts fails, or when asked to audit the docs.
---

# Docs sync

`docs/ARCHITECTURE.md` was written before the code and is kept true to it: where the two disagree, fix one of
them in the same commit. The same goes for every other place that describes behaviour.

## What describes what

| Changed                                                 | Update                                                                                                                                                                                                                      |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A schema field, an algorithm, a default, a limit        | `docs/ARCHITECTURE.md` (the numbered section; §2 for schema deltas, §9 for known limitations)                                                                                                                               |
| The patch format or a merge rule                        | `packages/core/src/patch.ts` header (authoritative), ARCHITECTURE §2/§4.7, `skill/code-explainer/reference/patch-format.md`                                                                                                 |
| A CLI command, flag, output or exit code                | the command's `--help` text in `packages/cli/src/commands/`, ARCHITECTURE §5, `skill/code-explainer/reference/cli.md` (its samples are real output, trimmed, not edited), README if the quick start or main commands change |
| A lint rule                                             | `packages/cli/src/lint.ts`, `reference/writing.md` and `reference/quick.md`                                                                                                                                                 |
| Viewer behaviour, modes, keys, URL parameters           | ARCHITECTURE §6, README if user-visible                                                                                                                                                                                     |
| Code under an anchor of `.explainer/xpl.explainer.json` | re-anchor it (below)                                                                                                                                                                                                        |
| The workflow of the product skill                       | `skill/code-explainer/SKILL.md`, and the examples (`packages/cli/test/skill-examples.test.ts` checks them)                                                                                                                  |

Do not edit the dated records: `docs/review-*.md`, `docs/review-2026-10-03-real-runs/`, `docs/handoff.md`
(the original brief) and `docs/analysis-*.txt`. Add a new dated review instead.

`docs/` is hand-formatted (prettier skips it): keep lines near 110 columns and the existing terse style
(`writing` skill).

## Find the drift

- `grep -n` the names you changed (functions, fields, flags, messages) across `docs/`, `README.md`, `skill/`
  and `packages/*/src` comments.
- For a CLI change, run the command on a fixture copy and compare with the samples in `cli.md`.
- For an audit, split by area (ARCHITECTURE §0-3 indexer, §4 core, §5 + cli.md CLI, §6-9 viewer and status,
  the product skill) and give each to a subagent with ownership of its sections; verify every concrete claim
  (paths, names, defaults, limits, versions) against the code.

## Re-anchor xpl's own explainer

`packages/cli/test/self-explainer.test.ts` fails when code under one of its anchors changed (docs included:
it anchors `docs/ARCHITECTURE.md`, `skill/code-explainer/SKILL.md` and others). Fix it in the same change:

```sh
npm run build
alias xpl="node $PWD/packages/cli/dist/xpl.mjs"
xpl index                          # precise (~40 s); --precise off is enough for anchors
xpl resolve xpl --write            # moved spans update themselves
xpl status xpl                     # what drifted or went missing
xpl anchors xpl <element-id>       # what a drifted anchor points at now
```

For each drifted element, read the new code and resend it in a patch (outside the repo) with fresh anchors
(`find` or `span` from `xpl show`, never a hash) and a summary that matches the new code;
`skill/code-explainer/reference/patch-format.md` §8 has the shapes (`stepsUpdate` for one step). Then
`xpl lint xpl --patch /tmp/p.json && xpl apply xpl /tmp/p.json`, and `xpl validate xpl`. A missing anchor
(symbol renamed or gone) needs a judgment: retarget it only to the code that now does the same thing.
Commit as `docs(explainer): re-anchor <what> after <change>` and say in the body what moved.

## Check

`npm test` (includes `self-explainer.test.ts` and `skill-examples.test.ts`), `npm run format:check`.
