---
name: architect
description: Design a change before coding it - types, signatures, module placement - then implement against the sketch. Use for changes that cross a package boundary, add or change a schema or patch field, add a CLI command or language pack, change graph derivation or the levels of a map, or whenever jumping to code would lock in the wrong shape.
---

# Architect

Sketch the shape first. Fill in code against the sketch. Throw the sketch out when the code proves it wrong.

## Vocabulary

Use these words exactly (from Ousterhout and Feathers, via Matt Pocock's `codebase-design`):

- **Module**: anything with an interface and an implementation: a function, a file, a package.
- **Interface**: everything a caller must know: the types, plus invariants, ordering, error modes, cost.
- **Depth**: behaviour per unit of interface. Deep = small interface, a lot behind it. Prefer deep.
- **Seam**: where behaviour can change without editing there; where tests attach.
- **Adapter**: a concrete thing filling a seam (a `LanguagePack`, a `PreciseResolver`, the `TextCache` reader).

xpl's existing seams are the place to look first: `LanguagePack` (one per language), `PreciseResolver` (SCIP
tools), `GetText`/`TextCache` (where file text comes from: disk, git, a bundle), the patch format (what an LLM
may write), `ViewerBundle` (all the viewer knows), `window.__xpl` test hooks.

## 1. Ground

Run the `how` skill on every subsystem the change touches, and read the matching `docs/ARCHITECTURE.md`
section. Note the invariants you must keep: core stays browser-safe and pure; references keep their
`precise`/`heuristic` label; user provenance wins over `llm` patches; one index at the head of a change; the
explainer file is written only by `xpl apply` and `xpl change`.

## 2. Sketch

Write the caller's usage first, then the types it implies:

- Which types in `schema.ts` / `patch.ts` change? Which readers (validation, apply, derive, viewer, lint,
  draft) must learn about them?
- Which package owns the new logic? The lowest one that can: core if it is pure, indexer if it reads source,
  CLI if it needs the filesystem, git or a server, viewer only for presentation.
- What does the patch format allow, and what does `validateExplainer` reject?
- What does the abstraction level look like to a reader? If the change affects what a map shows at a level
  (system, inside a service, code), grouping, `opens`, stubs, lifted edges or derived edge kinds, say what each
  level shows before and after.

Design it twice: at least two structurally different sketches (not two variants of one). Prefer the one with
the smaller interface, the one where a change that looks right from one file is right for the whole repo,
and the one that needs no new escape hatch (`any`, casts, an optional field that is always set).

For a large change, put the sketch in the PR description or in the ARCHITECTURE section it amends, and ask
the user to confirm before implementing. Otherwise proceed.

## 3. Implement against the sketch

Bodies replace sketches. A parameter the sketch did not foresee is a signal: was the sketch wrong, a
requirement missed, or the implementation overreaching? Say which in the PR.

## 4. Scrap when it is wrong

Signs: the same workaround in unrelated places; special cases for every new input; callers that must know the
module's internals; casts to compile. Then re-run `how` on what exists, redesign as if the new constraint had
been there from day one, subtract before adding, sketch again.

## 5. Land it

- Update the `docs/ARCHITECTURE.md` section in the same change (`docs-sync`), and the product skill
  reference if the patch format or a command changed.
- If the change moves the levels of a map or the package boundaries, the PR carries before/after screenshots
  (`pr-screenshots`, with `--self` for xpl's own map).

Adapted from poteto's `architect` (cursor/plugins pstack, MIT, © 2026 Lauren Tan) and Matt Pocock's
`codebase-design` (MIT, © 2026 Matt Pocock); see `../THIRD_PARTY.md`.
