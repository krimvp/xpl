/**
 * Which names are local in Python code: a bare `limit` that is a parameter, is assigned in the function, or is
 * a comprehension or class-body name around the use is not the module-level variable of the same name, so it is
 * not a `read` of it. Python's rules, as far as they matter here:
 *
 * - a function's locals are its parameters and every name assigned anywhere in its body (`=`, `+=`, `x: int`,
 *   `for`, `with ... as`, `except ... as`, `:=`, nested `def` / `class`), unless declared `global`;
 * - a lambda's are its parameters; a comprehension's are its `for` targets;
 * - a class body's names are visible in the body itself but not in the functions inside it;
 * - default values, decorators and annotations of a function are evaluated outside it;
 * - `import` inside a function is not counted: the resolver binds imports file-wide and knows better;
 * - module scope is not local: its names are symbols or import bindings.
 */
import type { Node } from "web-tree-sitter";
import { named, paramsOf, scopeNodeOf } from "./ast.js";

const COMPREHENSIONS = new Set([
  "list_comprehension",
  "set_comprehension",
  "dictionary_comprehension",
  "generator_expression",
]);

/** Wrappers of an assignment target that hold several targets. */
const TARGET_WRAPPERS = new Set([
  "pattern_list",
  "tuple_pattern",
  "list_pattern",
  "list_splat_pattern",
  "tuple",
  "list",
  "parenthesized_expression",
  "as_pattern_target",
]);

/** The names an assignment target binds: `x`, `(a, b)`, `[c, *d]`; attribute and subscript targets bind none. */
function targetNames(target: Node | null | undefined, out: Set<string>, depth = 0): void {
  if (!target || depth > 6) return;
  if (target.type === "identifier") out.add(target.text);
  else if (TARGET_WRAPPERS.has(target.type))
    for (const child of named(target)) targetNames(child, out, depth + 1);
}

/** Binding statements below `scope` that belong to it (not to a def, class or lambda nested in it). */
const BINDING_NODES = [
  "assignment",
  "augmented_assignment",
  "for_statement",
  "as_pattern",
  "named_expression",
  "function_definition",
  "class_definition",
];

export class PyScopes {
  private readonly functions = new Map<number, ReadonlySet<string>>();
  private readonly classes = new Map<number, ReadonlySet<string>>();

  constructor(private readonly globalsOf: (fn: Node) => ReadonlySet<string>) {}

  /**
   * The function, lambda, comprehension or class node that binds `name` around `id`, or undefined when the
   * name is not local there (module level, a builtin, `global`).
   */
  bindingScope(id: Node, name: string): Node | undefined {
    let crossedFunction = false;
    let child: Node = id;
    for (let n = id.parent; n; child = n, n = n.parent) {
      switch (n.type) {
        case "module":
          return undefined;
        case "function_definition":
          // Defaults, annotations and decorators run in the scope around the function.
          if (n.childForFieldName("body")?.id !== child.id) break;
          if (this.globalsOf(n).has(name)) return undefined;
          if (this.functionNames(n).has(name)) return n;
          crossedFunction = true;
          break;
        case "lambda":
          if (n.childForFieldName("body")?.id !== child.id) break;
          if (paramsOf(n).some((p) => p.name === name)) return n;
          crossedFunction = true;
          break;
        case "class_definition":
          // A class body's names are not visible inside the functions defined in it.
          if (!crossedFunction && n.childForFieldName("body")?.id === child.id) {
            if (this.classNames(n).has(name)) return n;
          }
          break;
        default:
          if (COMPREHENSIONS.has(n.type)) {
            for (const clause of n.namedChildren) {
              if (clause.type !== "for_in_clause") continue;
              const names = new Set<string>();
              targetNames(clause.childForFieldName("left"), names);
              if (names.has(name)) return n;
            }
            crossedFunction = true;
          }
          break;
      }
    }
    return undefined;
  }

  /** Parameters and the names bound in the body. */
  private functionNames(fn: Node): ReadonlySet<string> {
    let names = this.functions.get(fn.id);
    if (names) return names;
    const found = new Set<string>();
    for (const p of paramsOf(fn)) found.add(p.name);
    this.bodyNames(fn, found);
    names = found;
    this.functions.set(fn.id, names);
    return names;
  }

  private classNames(cls: Node): ReadonlySet<string> {
    let names = this.classes.get(cls.id);
    if (names) return names;
    const found = new Set<string>();
    this.bodyNames(cls, found);
    names = found;
    this.classes.set(cls.id, names);
    return names;
  }

  /** What the statements of `owner`'s body bind (see `BINDING_NODES`), minus what nested scopes bind. */
  private bodyNames(owner: Node, out: Set<string>): void {
    const body = owner.childForFieldName("body");
    if (!body) return;
    for (const node of body.descendantsOfType(BINDING_NODES)) {
      if (scopeNodeOf(node)?.id !== owner.id) continue;
      switch (node.type) {
        case "assignment":
        case "augmented_assignment":
        case "for_statement":
          targetNames(node.childForFieldName("left"), out);
          break;
        case "as_pattern":
          targetNames(node.childForFieldName("alias"), out);
          break;
        case "named_expression": {
          const name = node.childForFieldName("name");
          if (name) out.add(name.text);
          break;
        }
        default: {
          // a nested def or class binds its name here (its own body is another scope)
          const name = node.childForFieldName("name");
          if (name) out.add(name.text);
        }
      }
    }
  }
}
