/**
 * Go language pack (ARCHITECTURE.md §3).
 *
 * Symbols (kind; path):
 * - `func` -> `function`; methods -> `method`, path `Recv.Name` with pointer receivers and type parameters
 *   stripped (`func (q *Queue[T]) Pop()` -> `Queue.Pop`). A method is a child of its receiver type only when
 *   that type is declared in the same file; otherwise it is top-level in its file (the path is the same)
 * - `type` declarations: struct -> `class`, interface -> `interface`, anything else (aliases included) -> `type`
 * - struct fields -> `variable`, path `Type.field` (nested anonymous structs `Type.field.sub`); interface
 *   methods -> `method`, path `Iface.Method`. Embedded fields are not symbols but `extends` sites
 * - top-level `var` / `const` specs -> `variable`, one per name (a grouped block gives one symbol per name).
 *   The blank identifier declares nothing; function-local types and closures are not symbols
 * - ranges exclude doc comments; a type symbol's range starts at its name (see ./go/extract.ts)
 *
 * Sites: calls (`f()`, `pkg.F()`, `x.M()`, `r.field.M()`, `f[T]()`, method expressions), composite literals
 * `T{...}` / `&pkg.T{...}` as calls of T, type names in type positions (`type-ref`; including the conversion
 * `(*T)(x)`), embedded struct fields and interface elements (`extends`), and assignments / `++` / `--` to
 * fields and package variables (`write`). The receiver variable of a method is the qualifier root `"this"`.
 * Names of the language itself (`int`, `error`, `len(...)`) are not sites.
 *
 * Reads: a bare name in a value position (not declared, assigned, labelled, used as a key, called or the
 * operand of `++`), and the field of a selector `x.f` that is not called or assigned, are `read` sites; the
 * resolver keeps the ones that resolve to a package variable / constant or to a struct field. Bare names that
 * a local hides at that position (`localScopes`), the receiver variable, the packages of the file's imports and
 * the predeclared names are left out; a local or parameter of known type makes `x.f` resolvable.
 *
 * Facts: field types, parameter / named-result / result types, and the locals of `x := f()`, `x := &T{}`,
 * `var x T`, `v := x.(T)`, `switch v := x.(type)` and friends, each with Go's scope (`visibleIn`); locals of
 * unknown type are facts too, so that they shadow imports and package-level names.
 *
 * Imports: every import spec is a binding (alias, `_` and `.` included; a dot import is also a star export).
 * The binding's name is the alias, or the package name assumed from the import path like goimports does (the
 * `package` clause of the target is not looked up; a last element `vN` yields both readings).
 * `resolveModule` maps import paths through every `go.mod` of the repository (module paths, local `replace`
 * directives) to package directories.
 *
 * `inferRefs` adds `implements` refs for implicit interface satisfaction: method names plus a coarse
 * signature check (./go/implements.ts, ./go/signature.ts).
 *
 * Not handled: type inference beyond the evident (no signature or generics inference, no element types of
 * slices and maps, only the first result of a multi-value call gets a type), receivers that are index
 * expressions, function-local type declarations, cgo, vendor directories, packages whose `package` clause differs from
 * their directory name, and package-level variables (of another file, or `pkg.Var`) as receivers: the resolver
 * looks type facts up per file.
 */
import type { FileLanguage } from "@xpl/core";
import type { GrammarId } from "../wasm-files.js";
import { classifyGoSite } from "./go/classify.js";
import { extractGo } from "./go/extract.js";
import { inferGoImplements } from "./go/implements.js";
import { resolveGoModule } from "./go/modules.js";
import type { LanguagePack } from "./types.js";
import { offByDefault } from "./go/build.js";

export const goPack: LanguagePack = {
  id: "go",
  languages: ["go"],
  grammarFor(_language: FileLanguage): GrammarId {
    return "go";
  },
  packageScope: "directory",
  offByDefault: (path, repo) => offByDefault(path, repo.readText(path)),
  refs: "heuristic",

  extract: extractGo,
  classifySite: classifyGoSite,
  resolveModule: resolveGoModule,
  inferRefs: inferGoImplements,
};
