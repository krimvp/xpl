/**
 * Which names are bound locally in TypeScript / JavaScript code (parameters, `let` / `const` / `var`, function
 * and class declarations in a function or block, `catch` parameters, `for` variables): a bare `queue` that is
 * bound around the place it is used is not the module-level variable of the same name, so it is not a `read`
 * of it. The question the pack asks for every candidate identifier, hence the caches: what each scope binds is
 * computed once, and so is the answer for a name around each scope (`node.parent` is a walk down from the root
 * of the tree, so a question climbs only as far as the nearest scope that has been asked before).
 *
 * Module scope is not local: a name declared at the top of the file is a symbol (or an import binding) and the
 * resolver looks it up. Two kinds of blocks look local but are not, because the pack lists their declarations
 * as module-level symbols: the body of a namespace, and the body of an immediately-invoked function
 * expression (legacy JS, UMD).
 */
import type { Node } from "web-tree-sitter";

const FUNCTION_LIKE = new Set([
  "function_declaration",
  "generator_function_declaration",
  "function_expression",
  "function",
  "generator_function",
  "arrow_function",
  "method_definition",
]);

/** The nodes that can bind names for the code inside them (besides the module itself). */
const SCOPES = new Set([
  ...FUNCTION_LIKE,
  "statement_block",
  "class_static_block",
  "for_statement",
  "for_in_statement",
  "catch_clause",
  "switch_body",
]);

/** Names bound by a destructuring pattern (`{ a, b: c }`, `[x, y]`, defaults and rest included). */
export function patternNames(pattern: Node, out: string[] = [], depth = 0): string[] {
  if (depth > 8) return out;
  switch (pattern.type) {
    case "identifier":
    case "shorthand_property_identifier_pattern":
      out.push(pattern.text);
      break;
    case "pair_pattern": {
      const value = pattern.childForFieldName("value");
      if (value) patternNames(value, out, depth + 1);
      break;
    }
    case "assignment_pattern":
    case "object_assignment_pattern": {
      const left = pattern.childForFieldName("left");
      if (left) patternNames(left, out, depth + 1);
      break;
    }
    default:
      for (const child of pattern.namedChildren) patternNames(child, out, depth + 1);
  }
  return out;
}

/** The names a declaration statement (`const a = 1, { b } = c;`, `var x;`) binds. */
function declaredNames(declaration: Node, out: Set<string>): void {
  for (const declarator of declaration.namedChildren) {
    if (declarator.type !== "variable_declarator") continue;
    const name = declarator.childForFieldName("name");
    if (name) for (const n of patternNames(name)) out.add(n);
  }
}

/** The names the parameters of a function-like node bind. */
function parameterNames(fn: Node, out: Set<string>): void {
  const single = fn.childForFieldName("parameter"); // `x => x + 1`
  if (single) for (const n of patternNames(single)) out.add(n);
  const list = fn.childForFieldName("parameters");
  if (!list) return;
  for (const parameter of list.namedChildren) {
    if (parameter.type === "comment") continue;
    const pattern =
      parameter.type === "required_parameter" || parameter.type === "optional_parameter"
        ? (parameter.childForFieldName("pattern") ?? parameter.childForFieldName("name"))
        : parameter;
    if (pattern) for (const n of patternNames(pattern)) out.add(n);
  }
}

/** The nearest function-like ancestor of `node`, if any. */
function enclosingFunction(node: Node): Node | undefined {
  for (let n = node.parent; n; n = n.parent) if (FUNCTION_LIKE.has(n.type)) return n;
  return undefined;
}

export class LocalScopes {
  private readonly functions = new Map<number, ReadonlySet<string>>();
  private readonly blocks = new Map<number, ReadonlySet<string>>();
  /** Function-like nodes whose own declarations are module-level symbols (IIFEs): only their parameters are local. */
  private readonly symbolFunctions = new Set<number>();
  /** The `var` names each function hoists, for the whole file (built when first needed). */
  private hoisted: Map<number, Set<string>> | undefined;
  /** Per scope node: whether a name is bound there or around it (answers already found). */
  private readonly around = new Map<number, Map<string, boolean>>();

  /** The function `fn` is an immediately-invoked function whose declarations the pack lists as module-level. */
  markSymbolScope(fn: Node): void {
    this.symbolFunctions.add(fn.id);
  }

  /** Is `name` bound in a function, block, loop or `catch` around `node` (not at module level)? */
  isBound(node: Node, name: string): boolean {
    const unbound: number[] = []; // scopes passed on the way up that do not bind the name themselves
    let answer = false;
    for (let n = node.parent; n; n = n.parent) {
      if (n.type === "program") break;
      if (!SCOPES.has(n.type)) continue;
      const known = this.around.get(n.id)?.get(name);
      if (known !== undefined) {
        answer = known;
        break;
      }
      if (this.binds(n, name)) {
        answer = true;
        this.remember(n.id, name, true);
        break;
      }
      unbound.push(n.id);
    }
    // the scopes passed have the answer of the scope that decided it (or of the module: not bound)
    for (const id of unbound) this.remember(id, name, answer);
    return answer;
  }

  private remember(scope: number, name: string, bound: boolean): void {
    let names = this.around.get(scope);
    if (!names) {
      names = new Map();
      this.around.set(scope, names);
    }
    names.set(name, bound);
  }

  /** Does the scope node `n` itself bind `name` for the code inside it? */
  private binds(n: Node, name: string): boolean {
    switch (n.type) {
      case "statement_block":
      case "class_static_block":
        return !this.isSymbolBlock(n) && this.blockNames(n).has(name);
      case "for_statement": {
        const init = n.childForFieldName("initializer");
        if (init && (init.type === "lexical_declaration" || init.type === "variable_declaration")) {
          const names = new Set<string>();
          declaredNames(init, names);
          return names.has(name);
        }
        return false;
      }
      case "for_in_statement": {
        const left = n.childForFieldName("left");
        return !!left && !!n.childForFieldName("kind") && patternNames(left).includes(name);
      }
      case "catch_clause": {
        const parameter = n.childForFieldName("parameter");
        return !!parameter && patternNames(parameter).includes(name);
      }
      case "switch_body":
        return this.blockNames(n).has(name);
      default:
        return FUNCTION_LIKE.has(n.type) && this.functionNames(n).has(name);
    }
  }

  /** The body of a namespace, or of an IIFE that is module scope for the pack. */
  private isSymbolBlock(block: Node): boolean {
    const parent = block.parent;
    if (!parent) return false;
    if (parent.type === "internal_module" || parent.type === "module") return true;
    return FUNCTION_LIKE.has(parent.type) && this.symbolFunctions.has(parent.id);
  }

  /** Parameters, the function's own name (a function expression sees itself) and hoisted `var`s. */
  private functionNames(fn: Node): ReadonlySet<string> {
    let names = this.functions.get(fn.id);
    if (names) return names;
    const found = new Set<string>();
    parameterNames(fn, found);
    if (fn.type === "function_expression" || fn.type === "generator_function") {
      const name = fn.childForFieldName("name");
      if (name) found.add(name.text);
    }
    if (!this.symbolFunctions.has(fn.id)) {
      for (const hoisted of this.hoistedBy(fn) ?? []) found.add(hoisted);
    }
    names = found;
    this.functions.set(fn.id, names);
    return names;
  }

  /** The `var` names declared in `fn`'s body, not counting the functions inside it. */
  private hoistedBy(fn: Node): ReadonlySet<string> | undefined {
    if (!this.hoisted) {
      const byFunction = new Map<number, Set<string>>();
      for (const declaration of fn.tree.rootNode.descendantsOfType("variable_declaration")) {
        const owner = enclosingFunction(declaration);
        if (!owner) continue;
        let names = byFunction.get(owner.id);
        if (!names) {
          names = new Set();
          byFunction.set(owner.id, names);
        }
        declaredNames(declaration, names);
      }
      this.hoisted = byFunction;
    }
    return this.hoisted.get(fn.id);
  }

  /** `let` / `const` / `var`, function, class and enum declarations that are statements of the block. */
  private blockNames(block: Node): ReadonlySet<string> {
    let names = this.blocks.get(block.id);
    if (names) return names;
    const found = new Set<string>();
    const statements =
      block.type === "switch_body"
        ? block.namedChildren.flatMap((c) => c.namedChildren)
        : block.namedChildren;
    for (const stmt of statements) {
      switch (stmt.type) {
        case "lexical_declaration":
        case "variable_declaration":
          declaredNames(stmt, found);
          break;
        case "function_declaration":
        case "generator_function_declaration":
        case "class_declaration":
        case "abstract_class_declaration":
        case "enum_declaration": {
          const name = stmt.childForFieldName("name");
          if (name) found.add(name.text);
          break;
        }
        default:
          break;
      }
    }
    names = found;
    this.blocks.set(block.id, names);
    return names;
  }
}
