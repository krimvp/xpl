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

## 4. Still open, by value

1. **Abstract and base-class dispatch.** Callers of an abstract method are not listed under its overrides in
   either mode (`Leaf.visit` shows none). Interfaces get "via interface"; `extends` is not hopped, by design.
   Hopping overridden methods the way interface members are hopped would cover visitors and template methods.
2. **Python symbols that are not symbols:**
   - assignments under `if` / `try` (sympy's `cacheit`: 178 decorator uses with no edge);
   - tuple unpacking (`sympy/abc.py`: 1,005 imports land on the module);
   - `@property` reads, which are never references;
   - `metaclass=X`, and classes used as values (`isinstance(x, C)`), which heuristic mode does not record.
3. **The "anywhere in the repo" rank** of the last-resort guess. ARCHITECTURE promises the same file, then
   imports, then the same directory. Rank 3 also guesses across packages: about 65 wrong edges in prometheus that
   look like any other heuristic edge. Consider dropping it, or marking those edges.
4. **Go method and function values** (`wrapAgent(api.query)`, `return lexStatements`) are references SCIP has. The
   mapper drops them, so PromQL's lexer state machine has no edges even in precise mode.
5. **Draft quality on monorepos.**
   - vue's 12 packages come out as one `packages` box next to two rollup configs.
   - sympy comes out as one `sympy` box.
   - zod's draft takes a test fixture (`drizzle-zod`) for an SQL database.
   - `pnpm-workspace.yaml` is not read.
6. **Precise cost.** 9–10 minutes and up to 7 GB on sympy and prometheus. Worth saying in the README; heuristic
   mode is the better default for a first look at a big repository.
7. **Small:**
   - valid JSONC `tsconfig.json` and fuzz-corpus `.json` files are reported as syntax errors;
   - `apply` and `validate` accept a draft full of TODOs (only `lint` fails it);
   - a 27–51 MB `--files all` bundle gets no size warning;
   - `outline` `in=` leaves out self-calls;
   - a named function expression's self-call (`const f = function inner() { inner() }`) and `new Self()` inside a
     class expression are not linked;
   - precise mode maps `cls.__doc__` to the class.
