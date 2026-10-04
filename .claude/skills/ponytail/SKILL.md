---
name: ponytail
description: The laziest solution that works, in xpl - question whether code needs to exist, reuse what the repo already has, then the platform, then the fewest lines. Use on any coding task (writing, fixing, refactoring, choosing a dependency), and when the user says "ponytail", "be lazy", "simplest solution", "yagni" or complains about bloat.
---

# Ponytail

Lazy means efficient, not careless. The best code is the code never written. Read fully, then be lazy.

## The ladder

Understand the problem and trace the real flow first. Then stop at the first rung that holds:

1. **Does this need to exist?** Speculative need: skip it and say so in one line.
2. **Is it already in the repo?** xpl has a lot of shared machinery. Look before writing:
   - text and hashing: `core/src/text.ts` (`splitLines`, `sliceLines`, `hashText`);
   - ids, slugs, element kinds: `core/src/ids.ts`, `constants.ts`;
   - anchors and file text: `core/src/anchors.ts` (`TextCache`, `resolveAnchor`, `makeAnchor`);
   - globs: `core/src/glob.ts`; index lookups: `core/src/index-model.ts` (`IndexModel`);
   - graph derivation, stubs, levels, focus: `core/src/graph.ts`, `stubs.ts`, `levels.ts`, `focus.ts`;
   - CLI arguments, errors, output, git: `cli/src/args.ts`, `errors.ts`, `format.ts`, `git.ts`, `fsutil.ts`;
   - tree-sitter helpers: `indexer/src/ast.ts`, `parse.ts`, `wasm.ts` (`initParser`, `loadLanguage`).
     `xpl search <name> --code` and `xpl outline --under <dir>` on this repo find them fast.
3. **Does Node or the browser do it?** `node:util` `parseArgs`, `node:fs`, `structuredClone`, `Intl`,
   CSS over JS in the viewer.
4. **Does an installed dependency do it?** Never add a dependency for what a few lines do. Every new one
   needs a reason in the PR: the single-file viewer and the CLI bundle carry its weight, and install scripts
   are disabled repo-wide (`.npmrc`).
5. **Can it be one line?** One line.
6. **Only then** the minimum code that works.

**A bug fix is a root-cause fix.** Before editing, find every caller of the function (`xpl refs <id> --in`).
One guard in the shared function is a smaller diff than one per caller, and fixes the siblings too.

## Rules

- No unrequested abstraction: no interface with one implementation, no option nobody sets, no layer with one
  caller. The seams xpl has (`LanguagePack`, `PreciseResolver`, `GetText`) earned theirs with several
  implementations.
- No scaffolding "for later". Deletion over addition. Boring over clever.
- Fewest files. The shortest diff wins, once you know it is in the right place.
- A deliberate shortcut with a known ceiling gets a comment naming it and the upgrade path:
  `// Linear scan: fine below ~10k symbols; index by name if outlines get slow.`

## Never lazy about

Validation at trust boundaries (patches from an LLM, files from disk, bundle JSON, HTTP input to `xpl view`),
anything that could make an anchor point at the wrong code, provenance protection, accessibility in the
viewer, and the one runnable check that proves non-trivial logic works.

## Output

Code first. Then at most three short lines: what you skipped and when to add it.

Adapted from ponytail (MIT, © 2026 DietrichGebert); see `../THIRD_PARTY.md`.
