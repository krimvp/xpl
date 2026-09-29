/**
 * Python language pack: STUB. To be replaced by the Python-pack implementation; keep the export name
 * (`pythonPack`) and implement the `LanguagePack` interface from ./types.ts.
 *
 * What the real pack must produce (ARCHITECTURE.md §3):
 *
 * - `extract(ctx).symbols`: class, def (`function`; inside a class `method`), module- and class-level simple
 *   assignments (`variable`), nested defs/classes. Paths `Class.method`, `outer.inner`; the range starts at the
 *   decorators (and excludes leading comments); `parentPath` is the enclosing class/function.
 * - `sites`: calls (`foo()`, `recv.m()`, `Class()`), `extends` for class bases, `type-ref` for annotations,
 *   `write` for assignments to `self.x` / module variables. `self` and `cls` receivers are emitted as the
 *   qualifier root `"this"`.
 * - `imports`: `import a.b as c` (namespace binding, `importedName` undefined), `from .x import y as z`.
 *   `from x import *` -> an `exports` fact `{ name: "*", module: "x" }`.
 * - `typeFacts`: `self.f: T` / `self.f = T(...)` / annotated `__init__` parameters (kind "field", scopePath =
 *   the class), parameter and return annotations, locals initialised by a call (`initCall`).
 * - `classifySite`, `resolveModule` (dotted + relative imports, `src/` layout detection),
 *   `packageScope: "file"`, `refs: "heuristic"`.
 *
 * Shared helpers: `nodeSpan` / `spanBetween` in ../ast.ts; the framework assigns ids, `~2` suffixes,
 * hashes and parents from the drafts.
 */
import type { LanguagePack } from "./types.js";

export const pythonPack: LanguagePack = {
  id: "python",
  languages: ["python"],
  grammarFor: () => "python",
  packageScope: "file",
  // The stub emits nothing, so no references are derived for Python files yet.
  refs: "none",

  extract: () => ({ symbols: [], sites: [], imports: [], typeFacts: [] }),
  classifySite: () => undefined,
  resolveModule: () => [],
};
