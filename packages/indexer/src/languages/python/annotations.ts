/**
 * Type annotations: which names an annotation mentions (`type-ref` sites) and which single type it declares
 * (`TypeFact.typeName`).
 *
 * tree-sitter-python is inconsistent about the shape of an annotation: it is wrapped in a `type` node, and
 * inside it `list[Job]` is a `generic_type` while `mod.Box[int]` is a `subscript`; `A | None` is a
 * `union_type` or a `binary_operator` depending on its operands. Everything here goes through `unwrapType`
 * and `appOf` so both shapes behave the same.
 */
import type { Node } from "web-tree-sitter";
import { nodeSpan } from "../../ast.js";
import { DOTTED_NAME, dottedName, lastSegment, named, plainString } from "./ast.js";
import type { SiteShape } from "./ast.js";

/** `type` wrapper nodes stripped (they nest: `generic_type > type_parameter > type > ...`). */
export function unwrapType(node: Node | null | undefined): Node | undefined {
  let n = node ?? undefined;
  for (let i = 0; n && n.type === "type" && i < 8; i++) n = named(n)[0];
  return n;
}

/** `Head[args]` in either grammar shape. `args` are raw nodes (`type` wrappers for generic_type). */
function appOf(n: Node): { head: Node; args: Node[] } | undefined {
  if (n.type === "generic_type") {
    const head = n.namedChildren.find((c) => c.type === "identifier");
    const params = n.namedChildren.find((c) => c.type === "type_parameter");
    return head ? { head, args: params ? named(params) : [] } : undefined;
  }
  if (n.type === "subscript") {
    const head = n.childForFieldName("value");
    if (!head) return undefined;
    return { head, args: n.childrenForFieldName("subscript").filter((c) => c.type !== "comment") };
  }
  return undefined;
}

/** A string annotation that is just a (dotted) name: `"Job"`, `"mod.Job"`. Longer expressions are ignored. */
function forwardRef(n: Node): { text: string; content: Node } | undefined {
  const s = plainString(n);
  return s && DOTTED_NAME.test(s.text) ? s : undefined;
}

function isNone(n: Node | undefined): boolean {
  return n === undefined || n.type === "none";
}

/** The operands of a `|` union in either grammar shape, flattened; undefined when `n` is not a union. */
function unionMembers(n: Node, depth = 0): Node[] | undefined {
  if (depth > 12) return undefined;
  if (n.type === "union_type") {
    const out: Node[] = [];
    for (const child of named(n)) {
      const inner = unwrapType(child);
      if (!inner) continue;
      out.push(...(unionMembers(inner, depth + 1) ?? [inner]));
    }
    return out;
  }
  if (n.type === "binary_operator" && n.childForFieldName("operator")?.text === "|") {
    const out: Node[] = [];
    for (const side of [n.childForFieldName("left"), n.childForFieldName("right")]) {
      const inner = unwrapType(side);
      if (!inner) continue;
      out.push(...(unionMembers(inner, depth + 1) ?? [inner]));
    }
    return out;
  }
  return undefined;
}

// ─── The declared type ────────────────────────────────────────────────────────────────────────────

/** Bare special forms that say nothing about the type (`x: Final = 3` has the type of `3`). */
const NO_INFO = new Set([
  "Any",
  "Final",
  "ClassVar",
  "InitVar",
  "TypeAlias",
  "Required",
  "NotRequired",
  "ReadOnly",
  "Unpack",
]);
/** Wrappers whose first argument is the type. */
const TRANSPARENT = new Set([
  "Annotated",
  "ClassVar",
  "Final",
  "InitVar",
  "Required",
  "NotRequired",
  "ReadOnly",
]);
/** Return annotations that wrap the interesting type in their first argument. */
const RETURN_FIRST = new Set([
  "Awaitable",
  "Iterator",
  "AsyncIterator",
  "Iterable",
  "AsyncIterable",
  "Generator",
  "AsyncGenerator",
]);

function simpleName(name: string): string | undefined {
  const last = lastSegment(name);
  if (NO_INFO.has(last)) return undefined;
  return last === "Self" ? "this" : name;
}

/**
 * The base name of the type an annotation declares: generics stripped, `Optional[T]` / `T | None` /
 * `Union[T, None]` reduced to `T`, `Annotated[T, ...]` / `ClassVar[T]` / `Final[T]` unwrapped, `Self` -> "this",
 * dotted names kept (`mod.Job`), forward references (`"Job"`) resolved. With `mode: "return"` also
 * `Awaitable[T]`, `Coroutine[Any, Any, T]`, `Iterator[T]`, `AsyncIterator[T]`, ... -> `T`. Undefined when
 * the annotation names no single type (`A | B`, `Any`, `None`, a callable type).
 */
export function typeNameOf(
  node: Node | null | undefined,
  mode: "value" | "return",
  depth = 0,
): string | undefined {
  const n = unwrapType(node);
  if (!n || depth > 8) return undefined;
  switch (n.type) {
    case "identifier":
    case "attribute": {
      const name = dottedName(n);
      return name === undefined ? undefined : simpleName(name);
    }
    case "string": {
      const ref = forwardRef(n);
      return ref ? simpleName(ref.text) : undefined;
    }
    case "generic_type":
    case "subscript": {
      const app = appOf(n);
      const head = app ? dottedName(app.head) : undefined;
      if (!app || head === undefined) return undefined;
      const base = lastSegment(head);
      if (base === "Optional") return typeNameOf(app.args[0], mode, depth + 1);
      if (base === "Union") return single(app.args.map(unwrapType), mode, depth);
      if (TRANSPARENT.has(base)) return typeNameOf(app.args[0], mode, depth + 1);
      if (mode === "return") {
        if (RETURN_FIRST.has(base)) return typeNameOf(app.args[0], mode, depth + 1);
        if (base === "Coroutine") return typeNameOf(app.args[app.args.length - 1], mode, depth + 1);
      }
      return simpleName(head);
    }
    case "union_type":
    case "binary_operator": {
      const members = unionMembers(n);
      return members ? single(members, mode, depth) : undefined;
    }
    default:
      return undefined;
  }
}

/** The type name of the only non-`None` member, if there is exactly one. */
function single(
  members: readonly (Node | undefined)[],
  mode: "value" | "return",
  depth: number,
): string | undefined {
  const rest = members.filter((m) => !isNone(m));
  return rest.length === 1 ? typeNameOf(rest[0], mode, depth + 1) : undefined;
}

/** Is the annotation exactly `None` (`-> None`)? */
export function isNoneType(node: Node | null | undefined): boolean {
  const n = unwrapType(node);
  return n?.type === "none";
}

// ─── The names an annotation mentions ─────────────────────────────────────────────────────────────

function nameShape(n: Node, lines: readonly string[]): SiteShape | undefined {
  if (n.type === "identifier")
    return { kind: "type-ref", name: n.text, nameNode: n, site: nodeSpan(n, lines) };
  if (n.type === "attribute") {
    const dotted = dottedName(n);
    const attr = n.childForFieldName("attribute");
    if (dotted === undefined || !attr) return undefined;
    return {
      kind: "type-ref",
      name: attr.text,
      nameNode: attr,
      qualifierText: dotted.split(".").slice(0, -1),
      site: nodeSpan(n, lines),
    };
  }
  return undefined;
}

/**
 * The `type-ref` sites inside an annotation (or any type expression, e.g. the arguments of a generic base
 * class): every name in a type position. `Literal[...]` arguments and the metadata of `Annotated[T, ...]`
 * are values, not types, and are skipped; string annotations count when they are a plain (dotted) name.
 */
export function collectTypeRefs(
  node: Node | null | undefined,
  lines: readonly string[],
  out: SiteShape[] = [],
  depth = 0,
): SiteShape[] {
  const n = unwrapType(node);
  if (!n || depth > 12) return out;
  switch (n.type) {
    case "identifier":
    case "attribute": {
      const shape = nameShape(n, lines);
      if (shape) out.push(shape);
      break;
    }
    case "string": {
      const ref = forwardRef(n);
      if (!ref) break;
      const parts = ref.text.split(".");
      out.push({
        kind: "type-ref",
        name: parts[parts.length - 1]!,
        nameNode: ref.content,
        qualifierText: parts.slice(0, -1),
        site: nodeSpan(ref.content, lines),
      });
      break;
    }
    case "generic_type":
    case "subscript": {
      const app = appOf(n);
      if (!app) break;
      const head = nameShape(app.head, lines);
      if (head) out.push(head);
      const base = lastSegment(dottedName(app.head) ?? "");
      if (base === "Literal") break;
      const args = base === "Annotated" ? app.args.slice(0, 1) : app.args;
      for (const arg of args) collectTypeRefs(arg, lines, out, depth + 1);
      break;
    }
    case "union_type":
    case "list":
    case "tuple":
      for (const child of named(n)) collectTypeRefs(child, lines, out, depth + 1);
      break;
    case "binary_operator":
      if (n.childForFieldName("operator")?.text === "|") {
        collectTypeRefs(n.childForFieldName("left"), lines, out, depth + 1);
        collectTypeRefs(n.childForFieldName("right"), lines, out, depth + 1);
      }
      break;
    default:
      break;
  }
  return out;
}

/** Is `type` the annotation of a parameter, return value, variable or type alias (the root of an annotation)? */
export function isAnnotationRoot(type: Node): boolean {
  const parent = type.parent;
  if (!parent) return false;
  switch (parent.type) {
    case "typed_parameter":
    case "typed_default_parameter":
    case "assignment":
      return parent.childForFieldName("type")?.id === type.id;
    case "function_definition":
      return parent.childForFieldName("return_type")?.id === type.id;
    case "type_alias_statement":
      return parent.childForFieldName("right")?.id === type.id;
    default:
      return false;
  }
}

/** The annotation `node` is part of, if any (nearest enclosing annotation root). */
export function annotationRootOf(node: Node): Node | undefined {
  for (let n: Node | null = node; n; n = n.parent) {
    if (n.type === "type" && isAnnotationRoot(n)) return n;
    if (n.type === "block" || n.type === "module") return undefined;
  }
  return undefined;
}
