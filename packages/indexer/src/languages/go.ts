/**
 * Go language pack: STUB. To be replaced by the Go-pack implementation; keep the export name (`goPack`)
 * and implement the `LanguagePack` interface from ./types.ts.
 *
 * What the real pack must produce (ARCHITECTURE.md §3):
 *
 * - `extract(ctx).symbols`: func (`function`), method (`method`, path `Recv.Name`, pointer receivers and
 *   generics stripped), type decls (struct -> `class`, interface -> `interface`, else `type`), struct fields
 *   and interface methods, top-level var/const specs (`variable`). `parentPath` only when the parent type is
 *   declared in the same file (the framework leaves the parent unset if no draft has that path anyway).
 * - `sites`: calls (`f()`, `pkg.F()`, `recv.M()`), composite literals `T{...}` as `call`, `type-ref`,
 *   embedded structs as `extends`, `write`. The receiver variable name is emitted as the qualifier root
 *   `"this"`.
 * - `imports`: one binding per import spec, `localName` = alias or the package name, `importedName`
 *   undefined (a package is a namespace), `module` = the import path.
 * - `typeFacts`: struct fields (kind "field", scopePath = the struct), parameter and result types (pointers
 *   stripped), locals initialised by a call (`initCall`) or a composite literal.
 * - `classifySite`, `resolveModule` (module path from `go.mod` -> package directory: return every `.go` file
 *   of that directory), `packageScope: "directory"`, `refs: "heuristic"`.
 *
 * Shared helpers: `nodeSpan` / `spanBetween` in ../ast.ts; the framework assigns ids, `~2` suffixes,
 * hashes and parents from the drafts, and the resolver handles same-package lookups for
 * `packageScope: "directory"`.
 */
import type { LanguagePack } from "./types.js";

export const goPack: LanguagePack = {
  id: "go",
  languages: ["go"],
  grammarFor: () => "go",
  packageScope: "directory",
  // The stub emits nothing, so no references are derived for Go files yet.
  refs: "none",

  extract: () => ({ symbols: [], sites: [], imports: [], typeFacts: [] }),
  classifySite: () => undefined,
  resolveModule: () => [],
};
