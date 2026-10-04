/**
 * Python language pack (ARCHITECTURE.md §3). Files: `.py`, `.pyi` (grammar `python`); references are
 * heuristic (`refs: "heuristic"`) and top-level names are visible per file (`packageScope: "file"`).
 *
 * Symbols (kind; path):
 * - class -> `class`; def / async def -> `function`, or `method` when directly in a class body
 * - simple assignments at module or class level, annotated or not (`x = 1`, `x: int = 1`, `id: str`
 *   as in dataclasses, `Alias = Callable[..., int]`) -> `variable`; one symbol per name of the target (`x`,
 *   or each of `x, y = ...`; not `self.x` or `a[0]`); PEP 695 `type X = ...` -> `type`
 * - defs and classes nested in functions or classes -> `outer.inner`, `Class.Inner.method`
 * - definitions inside `if` / `try` / `with` / `for` / `while` / `match` blocks belong to the scope around
 *   them. Assignments count in `if` / `try` / `with` (not in loops or `match`): the first one of a name, unless
 *   the scope assigns it directly too or the file imports it (`except ImportError: x = None` stands in for
 *   the import). `if __name__ == "__main__":` is skipped as a whole (the script body is not module API), its
 *   calls still count from module scope
 * - `@overload` stubs are skipped when an implementation with the same name is in the same block
 * - `@property def x` plus `@x.setter def x` give two drafts with the same path (the framework numbers the
 *   second `x~2`)
 *
 * A symbol's range starts at its first decorator (the `decorated_definition`) and ends with its last
 * statement; comments before it are not part of it.
 *
 * Sites (`SiteDraft`):
 * - `call`: `f()`, `a.b.f()`, `Class()`, `super().m()` (qualifier ["super"]), bare decorators (`@retry`,
 *   `@app.route`: they apply a function), decorator calls. `super(...)` itself is not a site.
 *   `importlib.import_module("a.b")` / `__import__("a.b")` with a literal name are `import` sites instead
 * - `extends`: every positional class base (`class A(B, mod.C, D[int])`), not `metaclass=`
 * - `type-ref`: names in annotations of parameters, returns, variables and PEP 695 aliases, also inside
 *   `Optional[...]`, `list[...]`, `X | None`, `Callable[[A], B]`; arguments of generic bases; string
 *   annotations that are a plain (dotted) name. `Literal[...]` arguments and `Annotated` metadata are values
 * - `write`: assignments to attribute targets (`self.x = v`, `self.x: T = v`, `stats.n += 1`, also inside
 *   tuple targets) and to module variables: `x = v` / `x += v` in a function that declares `global x`, and
 *   `x += v` at module level (a plain `x = v` at module level is the definition of the symbol `x`)
 * - `read`: a bare name in a value position that is not a callee, an assignment target, a declaration, an import,
 *   an annotation or a class base, and an attribute access `a.b` that is not a callee, target, base or annotation
 *   either - when what they name can be a variable of the repository. A bare name is a candidate when the file
 *   declares or imports it (or star-imports something) and no function, lambda, comprehension or class body
 *   around it binds it (./python/scope.ts: parameters and every name assigned in the body, unless `global`); an
 *   attribute access when its receiver is `self` (spelled "this"), `super()`, a name of the file, or a local or
 *   parameter of known type. The resolver decides the rest
 * - the first parameter of a method (`self`, `cls`, whatever it is called; not for `@staticmethod`) is
 *   spelled "this" in qualifiers, also inside nested functions and lambdas that do not shadow it
 * - a receiver that cannot be spelled (`arr[0].run()`, `f()()`) yields no site
 *
 * Imports (`ImportBinding`): `import a.b as x` -> {x, module a.b}; `import a.b.c` -> {localName "a.b.c",
 * module "a.b.c"} and qualifiers that start with those segments are spelled with that one root segment
 * (`a.b.c.f()` -> qualifier ["a.b.c"], name f), because the resolver cannot walk submodule attributes;
 * `from a.b import c, d as e` -> {c, module a.b, importedName c}, {e, module a.b, importedName d};
 * `from ..pkg import y` -> {y, module "..pkg", importedName y}. A module path of only dots names a package
 * whose members are almost always modules: `from . import x` -> {x, module ".x"} (a namespace binding).
 * `from x import *` is an `ExportFact` {name "*", module x}. `from __future__ import ...` binds nothing.
 * Imports anywhere in the file count (inside functions, `if TYPE_CHECKING:`, `try:`). An import under
 * `if TYPE_CHECKING:` / `if typing.TYPE_CHECKING:` (that branch, also as an `elif`; not the `else`) is typing-only: its
 * bindings are marked `typeOnly`, so the reference the resolver makes for it is a `type-ref`, not an `import`
 * (`classifySite` decides the same by the statement's position). In a package's
 * `__init__.py`, `from .sub import x` also declares `sub` an `ExportFact` {name "sub", module ".sub"}: an
 * imported submodule is an attribute of its package, so `from pkg import *` and `from pkg import sub` see it.
 *
 * Type facts (`TypeFact`): parameter annotations (and evident defaults); `self.x: T = v`, `self.x = T(...)`,
 * `self.x = param` with `param: T` and class-level fields (`x: T`, `x = T()`) as `field` facts of the class
 * (declared types win over inferred ones; any method may contribute, not only `__init__`);
 * return annotations (`Optional[T]`, `T | None`, `Awaitable[T]`, `Coroutine[Any, Any, T]`, `Iterator[T]`,
 * `AsyncIterator[T]`, ... reduce to T; `Self` -> "this"; `-> None` and `__init__` give none) and, without
 * an annotation, the first evident `return <expr>`; locals and module variables `x = T(...)`,
 * `x = await self.pool.lease()` (`initCall`), `x = self.queue` (`initChain`), literals (`str`, `list`, ...),
 * `cls(...)` (the class itself, "this") and the value alternatives of `a or T()` / `T() if c else U()`.
 * A callee whose name is capitalised and whose qualifier is a plain module/class path (`Queue()`,
 * `mod.Queue()`) is an instantiation: the fact is a `typeName` (`Queue`, `mod.Queue`). Every other call
 * is an `initCall` for the resolver to follow to the callee's return type, except builtins called without
 * an import (`list()`, `open()`, ...), which give their builtin type so that `stack = list()` is not taken
 * for the repository's `Stack`. `with ... as f` and loop variables give no facts.
 *
 * `resolveModule` is in ./python/modules.ts (dotted and relative imports, src layout, packages).
 *
 * `submoduleSpec`: `from pkg import name` is tried as the module `pkg.name` when `pkg` does not define `name`.
 *
 * Known gap: instance attributes (`self.x = ...` without a class-level declaration) are not symbols, so
 * writes to them are not linked.
 */
import type { FileLanguage } from "@xpl/core";
import type { GrammarId } from "../wasm-files.js";
import type { ClassifiedSite, FileContext, FileFacts, LanguagePack, RepoView } from "./types.js";
import { classifyPythonSite } from "./python/classify.js";
import { Extractor } from "./python/extract.js";
import { pythonSubmoduleSpec, resolvePythonModule } from "./python/modules.js";

export const pythonPack: LanguagePack = {
  id: "python",
  languages: ["python"],
  grammarFor(_language: FileLanguage): GrammarId {
    return "python";
  },
  packageScope: "file",
  importsReexport: true,
  refs: "heuristic",

  extract(ctx: FileContext): FileFacts {
    return new Extractor(ctx).run();
  },

  classifySite(ctx: FileContext, line: number, col: number): ClassifiedSite | undefined {
    return classifyPythonSite(ctx, line, col);
  },

  resolveModule(spec: string, fromFile: string, repo: RepoView): string[] {
    return resolvePythonModule(spec, fromFile, repo);
  },

  submoduleSpec: pythonSubmoduleSpec,
};
