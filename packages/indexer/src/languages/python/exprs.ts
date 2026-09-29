/**
 * Expressions as receivers and initialisers: the qualifier chain of `a.b().c` (types.ts: "Qualifier segments")
 * and what an initialiser evidently is (`x = Queue()`, `x = await self.pool.lease()`, `x = self.queue`).
 */
import type { Node } from "web-tree-sitter";
import { named } from "./ast.js";

/** What the expression helpers need to know about the file around a node. */
export interface Env {
  /** The name of the receiver (`self`/`cls`, whatever it is called) in effect at `node`, if any. */
  receiverAt(node: Node): string | undefined;
  /** Dotted names bound by `import a.b.c` (no alias): `a.b.c.f()` is spelled with the root segment "a.b.c". */
  readonly dotted: ReadonlySet<string>;
}

export interface NameParts {
  name: string;
  qualifier: string[];
}

export interface Inferred {
  typeName?: string;
  initCall?: { qualifier: string[]; name: string };
  initChain?: string[];
}

/**
 * Merge the leading plain segments of `chain` into the longest dotted name bound by an `import a.b.c`
 * statement (`["a", "b", "f()"]` -> `["a.b", "f()"]`). The resolver binds `import a.b.c` under the name
 * "a.b.c" (see the pack's header) and cannot walk submodule attributes.
 */
export function collapseDotted(chain: string[], env: Env): string[] {
  if (env.dotted.size === 0 || chain.length < 2 || chain[0] === "this" || chain[0] === "super")
    return chain;
  let best = 0;
  let joined = "";
  for (let i = 0; i < chain.length; i++) {
    const segment = chain[i]!;
    if (segment.endsWith("()")) break;
    joined = i === 0 ? segment : `${joined}.${segment}`;
    if (i >= 1 && env.dotted.has(joined)) best = i + 1;
  }
  return best < 2 ? chain : [chain.slice(0, best).join("."), ...chain.slice(best)];
}

/** Qualifier segments of a receiver expression, or undefined when it cannot be spelled (`arr[0].run()`). */
export function chainOf(node: Node | null | undefined, env: Env, depth = 0): string[] | undefined {
  if (!node || depth > 16) return undefined;
  switch (node.type) {
    case "identifier":
      return [node.text === env.receiverAt(node) ? "this" : node.text];
    case "attribute": {
      const object = chainOf(node.childForFieldName("object"), env, depth + 1);
      const attr = node.childForFieldName("attribute");
      if (!object || !attr) return undefined;
      return collapseDotted([...object, attr.text], env);
    }
    case "call": {
      const fn = node.childForFieldName("function");
      if (fn?.type === "identifier" && fn.text === "super") return ["super"];
      const parts = calleeParts(fn, env, depth + 1);
      return parts ? [...parts.qualifier, `${parts.name}()`] : undefined;
    }
    case "await":
    case "parenthesized_expression":
      return chainOf(named(node)[0], env, depth + 1);
    default:
      return undefined;
  }
}

/** `name` and `qualifier` of a callee expression (`f`, `a.b.f`). */
export function calleeParts(
  node: Node | null | undefined,
  env: Env,
  depth = 0,
): NameParts | undefined {
  if (!node || depth > 16) return undefined;
  if (node.type === "identifier") return { name: node.text, qualifier: [] };
  if (node.type === "attribute") {
    const attr = node.childForFieldName("attribute");
    const qualifier = chainOf(node.childForFieldName("object"), env, depth + 1);
    return attr && qualifier ? { name: attr.text, qualifier } : undefined;
  }
  return undefined;
}

/**
 * Builtins that are called without an import and whose result is a builtin object: `items = list()` says
 * that `items` is not the repository's `Items` class, which the resolver's name-based guess would pick.
 */
const BUILTIN_RESULTS: Readonly<Record<string, string>> = {
  list: "list",
  dict: "dict",
  set: "set",
  frozenset: "frozenset",
  tuple: "tuple",
  str: "str",
  bytes: "bytes",
  bytearray: "bytearray",
  int: "int",
  float: "float",
  bool: "bool",
  complex: "complex",
  object: "object",
  range: "range",
  sorted: "list",
  enumerate: "enumerate",
  zip: "zip",
  map: "map",
  filter: "filter",
  reversed: "reversed",
  open: "TextIOWrapper",
};

/** A qualifier segment that is a plain name: not `this`/`super`, not a call result, not a dotted import root. */
function isModuleOrClassName(segment: string): boolean {
  return segment !== "this" && segment !== "super" && /^[\p{L}_][\p{L}\p{N}_]*$/u.test(segment);
}

function unwrapValue(expr: Node | null | undefined): Node | null {
  let n = expr ?? null;
  for (let i = 0; n && i < 8 && (n.type === "await" || n.type === "parenthesized_expression"); i++)
    n = named(n)[0] ?? null;
  return n;
}

/**
 * The values an expression may evaluate to: `a or b` -> a, b; `x if c else y` -> x, y (the defaulting
 * idioms `self.queue = queue or Queue()`); anything else is itself. Parentheses and `await` are looked through.
 */
export function alternatives(expr: Node | null | undefined, depth = 0): Node[] {
  const n = unwrapValue(expr);
  if (!n) return [];
  if (
    depth < 4 &&
    n.type === "boolean_operator" &&
    n.childForFieldName("operator")?.text === "or"
  ) {
    return [
      ...alternatives(n.childForFieldName("left"), depth + 1),
      ...alternatives(n.childForFieldName("right"), depth + 1),
    ];
  }
  if (depth < 4 && n.type === "conditional_expression") {
    const parts = named(n); // consequence, condition, alternative
    if (parts.length === 3)
      return [...alternatives(parts[0], depth + 1), ...alternatives(parts[2], depth + 1)];
  }
  return [n];
}

/**
 * The type of an initialiser expression, when it is evident: a call, an alias, a literal, `cls(...)`. Of
 * several alternatives (`a or Queue()`) the first with an evident type (not a plain alias) counts; which
 * of two aliases a value is cannot be told.
 */
export function inferFromInit(expr: Node | null | undefined, env: Env): Inferred | undefined {
  const alternative = alternatives(expr);
  if (alternative.length === 1) return inferValue(alternative[0]!, env);
  for (const each of alternative) {
    const inferred = inferValue(each, env);
    if (inferred && (inferred.typeName !== undefined || inferred.initCall)) return inferred;
  }
  return undefined;
}

function inferValue(n: Node, env: Env): Inferred | undefined {
  switch (n.type) {
    case "call": {
      const fn = n.childForFieldName("function");
      if (fn?.type === "identifier") {
        if (fn.text === "super") return undefined;
        // `cls(...)` in a classmethod (or `__new__`) builds an instance of the class itself.
        if (fn.text === env.receiverAt(fn)) return { typeName: "this" };
      }
      const parts = calleeParts(fn, env);
      if (!parts) return undefined;
      if (parts.qualifier.length === 0 && Object.hasOwn(BUILTIN_RESULTS, parts.name))
        return { typeName: BUILTIN_RESULTS[parts.name] };
      // `Queue()` / `mod.Queue()`: by convention an instantiation, so the type is the class named. Anything
      // else is a call whose result the resolver works out from the callee's return type.
      if (/^[A-Z]/.test(parts.name) && parts.qualifier.every(isModuleOrClassName))
        return { typeName: [...parts.qualifier, parts.name].join(".") };
      return { initCall: { qualifier: parts.qualifier, name: parts.name } };
    }
    case "identifier":
      return n.text === env.receiverAt(n) ? { typeName: "this" } : { initChain: [n.text] };
    case "attribute": {
      const chain = chainOf(n, env);
      return chain && chain.length <= 6 ? { initChain: chain } : undefined;
    }
    case "string":
    case "concatenated_string":
      return { typeName: "str" };
    case "integer":
      return { typeName: "int" };
    case "float":
      return { typeName: "float" };
    case "true":
    case "false":
      return { typeName: "bool" };
    case "list":
    case "list_comprehension":
      return { typeName: "list" };
    case "dictionary":
    case "dictionary_comprehension":
      return { typeName: "dict" };
    case "set":
    case "set_comprehension":
      return { typeName: "set" };
    case "tuple":
      return { typeName: "tuple" };
    default:
      return undefined;
  }
}
