# Stress test on large codebases and recursive code, 2026-10-03

Reviewed: `main` at `27531a2`, then fixed on `claude/tool-verification-complex-code-nzaecs`. The indexer, `refs`,
the drafts, the bundle and the viewer, run over:

- **Hand-written edge cases** with known answers, in TS, Python and Go:
  - direct, mutual, three-way, generator, async, static, `#private` and nested recursion;
  - recursion through a visitor, through an interface and through `this` in a callback;
  - shadowing locals;
  - cycles in imports, re-exports and inheritance;
  - very deep nesting, minified code, CRLF, Unicode, broken syntax, binary files and symlink loops.
- **Seven real repositories:** zod and vue core (TS), django, sympy and jinja (Python), prometheus and hcl (Go).
  Each was indexed in both modes, and about 10 hard symbols per repo were checked against grep and the source.
  Heuristic and precise call edges were compared in bulk.

## 1. Summary

**The heuristic resolver is the strong part.**

- **Precision.** About 99.9% on Go outside build-tagged code; in vue, 5,875 of 5,876 shared call sites agree with
  SCIP; jinja and sympy agree 98.5% and 96.8%.
- **Recursion.** Direct and mutual recursion are found almost without exception: 130 of 131 self-calls in
  prometheus, 100 of 100 recursive methods in sympy and every self-call in vue's `src`.
- **Robustness.** No hang on any cycle (`export *` loops, `A extends B extends A`, Python star-import cycles, Go
  import cycles). Symlink loops and binary files are skipped.
- **Recall** is what the documented limits say: untyped parameters, generics, narrowing, element types, method
  values. It came out at about 88–92% of what SCIP finds.

**Precise mode was not uniformly better.** It was 30–40 times slower and up to 7 GB on sympy. Before this branch it:

- turned about 4,500 correct django edges wrong, from a scip-python bug;
- lost every reference in and into `//line`-generated Go;
- lost zod's calls through aliased re-exports, from a scip-typescript bug;
- invented recursion from same-named locals.

All four are fixed here: where the tool is wrong or blind, the heuristic reference is kept.

**The CLI scales:**

- indexing takes 2–40 s in heuristic mode;
- queries take 0.5–4 s, mostly loading the index;
- bundles of 4–51 MB load in Chromium with no console errors.

There was one crash, `refs` on a huge tree, now fixed. A file with a member chain 1,000–2,000 calls deep loses
its references but keeps its symbols, with a warning.

## 2. Numbers

| Repo (files)          | Heuristic index    | Precise index           | Symbols / refs (heuristic) |
| --------------------- | ------------------ | ----------------------- | -------------------------- |
| zod (689)             | 4.5–6.9 s, 310 MB  | 63 s, 2.1 GB            | 9,990 / 40,851             |
| vue core (699)        | 5.6–7.7 s, 312 MB  | 42 s, 0.9 GB            | 10,259 / 40,233            |
| django (2,933 py)     | 27 s, 0.9 GB       | 232 s, 4.6 GB           | 62,197 / 129,764           |
| sympy (1,608 py)      | 40 s, 1.3 GB       | 566 s, 7.2 GB           | 47,848 / 437,260           |
| jinja (60 py)         | 3.9 s, 137 MB      | 34 s, 473 MB            | 2,601 / 4,872              |
| prometheus (736 go)   | 15 s, 642 MB       | 610 s, 3.2 GB           | 35,718 / 137,857           |
| hcl (195 go)          | 2.0 s, 174 MB      | 67 s, 290 MB            | 2,128 / 18,013             |

## 3. Fixed on this branch

Each fix has a regression test that fails without it.

**Wrong edges (heuristic):**

- **Local shadowing (TS, Python).** A call or write of a name bound by a local, a parameter or a lambda went to the
  module's symbol of that name: `const parse = _parse(…)` in zod, `def f(fact): fact(1)`. Sites are now marked
  `local` and only resolve to nested functions. Go already did this.
- **Function-local imports (Python).** `def templatize(): from .template import templatize` produced a fake
  recursion.
- **Builtin types (Python, TS).** The last-resort guess took `object.__new__`, `tuple.__len__` and `set.union` for
  classes of the repository (46 sites in sympy, django and jinja), and once crossed languages (a JS write to a
  Python class). Builtins and other languages are now skipped.
- **Go build variants.** 6,228 prometheus references went to `labels_dedupelabels.go`, which is only built with a
  custom tag. Files a default linux/amd64 build leaves out (`//go:build`, `_GOOS` and `_GOARCH` names) are now
  tried last.
- **Go package rank.** The last-resort guess ranked an imported package above the file's own package.
- **TS barrel imports.** A barrel's plain `import { tm }` counted as an export ahead of its `export *` (vue's
  `ssrVModel.ts:189`).

**Missing edges (heuristic):**

- **Nested function consts (TS).** `const patch = (…) => {}` inside a function was not a symbol, so vue's
  2,150-line `baseCreateRenderer` showed no `patch`, `mountChildren` or `patchKeyedChildren`, and none of the
  renderer's recursion. These consts are now nested symbols.
- **`super()` with mixins (Python).** `super()` looked at the first base only, losing 152 calls in django.

**Precise mode:**

- **Invented recursion.** A same-named local (a Go local `interface { ExprCall() }` inside `ExprCall`) became a
  call of the function to itself: 8 such edges in hcl.
- **scip-python wrong targets.** About 4,500 django calls such as `models.AutoField(` went to `DateTimeField`. A
  Python `x.Name()` whose target is named otherwise is now left to the heuristic resolver; the 237 edges still on
  `DateTimeField` are all real.
- **Duplicate definitions.** scip-python gives a nested `def parse` the symbol of the method `Parser.parse`. Outside
  callers now get the method, and calls inside the function get the nested one.
- **Aliased re-exports (scip-typescript).** `ns.f` through `export { g as f }` comes out as a definition-less local:
  zod lost all 37 `checks.*` calls. The heuristic edge is kept there.
- **`//line` files (Go).** All references in and into hcl's ragel scanner were lost, behind a warning that blamed
  files changing during indexing. These files now keep heuristic references and are named in an accurate warning.

**CLI, maps and drafts:**

- `refs` overflowed the stack on large hierarchies (`sympify --depth 2 --limit 0`).
- `refs` listed a nested function's recursion as a call into or out of its parent (and of a whole file).
- Maps never drew recursion found in the index. A derived self-call is now a loop on its box.
- `draft path` garbled labels of calls nested in a call of the same name (`new Box([new Box([])])` came out as
  `Box([new Box([])])])`). It also said "makes no call the index knows" when it had filtered every call out.
- `draft repo` on a Go library with `cmd/` drafted only the command-line tools. hcl's and prometheus's whole
  library was missing.

## 4. Second round: the open points

Every point the first round left open was worked on. Each fix has a regression test that fails without it.

| Was open                                                                     | Now                                                                                                                                                                                       |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Callers of an abstract method not listed under its overrides                 | `refs` hops through base classes as `override` lines, as it does through interfaces (TS, JS, Python; not Go embedding; not constructors)                                                   |
| Python assignments under `if` / `try`, tuple targets                         | Symbols: sympy's `cacheit` went from 0 to 233 references; `x, y, z = …` gives each name. A fallback assignment still never shadows the import it stands in for                           |
| `@property` reads, classes used as values, `metaclass=`                      | A property read is a `call` of the getter; a class or enum used as a value is a `type-ref`, as in precise mode (django: 13 → 24,985 type-refs; precise has 30,159)                         |
| Last-resort guess from anywhere in the repo                                  | Dropped: 18 of prometheus's 22 such guesses were an outside type with the same name                                                                                                       |
| Go method values, callbacks                                                  | A function or method used as a value is a `call`, in both modes: `bus.Subscribe(m.OnJobCompleted)`, `wrapAgent(api.query)`, the PromQL lexer's `return lexStatements` state machine     |
| Drafts of monorepos                                                          | Workspace globs open into one box per package (vue: 8 real packages); a folder with most of the code is opened (sympy: core, polys, matrices…); benchmarks and fixtures are no part      |
| Precise cost                                                                 | Said in the README, with the advice to start big repositories heuristic                                                                                                                  |
| JSONC and fuzz-corpus syntax warnings                                        | Trailing commas are harmless; testdata and fixtures are not warned about                                                                                                                 |
| `apply` / `validate` accept TODOs; no size warning                           | `bundle` warns about texts that still hold a TODO, and about pages over 20 MB                                                                                                             |
| `outline` hides recursion                                                    | `recursive` after the counts                                                                                                                                                              |
| Named function expressions, `new Self()`                                     | Resolved to the symbol they are declared as                                                                                                                                               |
| `cls.__doc__` written to the class (precise)                                 | Already kept apart by the first round's "first naming definition" rule; now pinned by a test                                                                                            |

What is left is what the README calls known limits: no overload resolution, generics, unions or narrowing in
heuristic mode, dynamic dispatch by name (`getattr(self, "visit_" + …)`), closures that call themselves through a
variable, and element types of slices, maps and ranges in Go.
