/**
 * Site shapes: for every kind of reference site, one function that says what a node contributes
 * (`kind`, `name`, the identifier it sits on, the site span). `extract` runs them over all nodes of a kind;
 * `classifySite` runs them over the ancestors of an identifier and keeps the shape whose `nameNode` is that
 * identifier. Sharing them is what keeps the two in agreement ("the returned `site` equals what `extract`
 * emits for that site").
 */
import type { Node } from "web-tree-sitter";
import { nodeSpan } from "../../ast.js";
import type { ExportFact, ImportBinding } from "../types.js";
import { collectTypeRefs } from "./annotations.js";
import { DOTTED_NAME, callSpan, named, plainString, scopeNodeOf, writeSpan } from "./ast.js";
import type { SiteShape } from "./ast.js";

// ─── Calls ────────────────────────────────────────────────────────────────────────────────────────

/** `f(...)`, `a.b.f(...)`. `super(...)` is not a reference; `f()()` / `x[0]()` have no name. */
export function callShape(call: Node, lines: readonly string[]): SiteShape | undefined {
  const fn = call.childForFieldName("function");
  if (!fn || importCallShape(call, lines)) return undefined;
  if (fn.type === "identifier") {
    if (fn.text === "super") return undefined;
    return { kind: "call", name: fn.text, nameNode: fn, site: callSpan(call, fn, lines) };
  }
  if (fn.type === "attribute") {
    const attr = fn.childForFieldName("attribute");
    const object = fn.childForFieldName("object");
    if (!attr || !object) return undefined;
    return {
      kind: "call",
      name: attr.text,
      nameNode: attr,
      qualifierNode: object,
      site: callSpan(call, fn, lines),
    };
  }
  return undefined;
}

/** `importlib.import_module("a.b")` / `__import__("a.b")` with a literal absolute module name. */
export function importCallShape(call: Node, lines: readonly string[]): SiteShape | undefined {
  const fn = call.childForFieldName("function");
  let nameNode: Node | null | undefined;
  if (fn?.type === "identifier" && fn.text === "__import__") nameNode = fn;
  else if (
    fn?.type === "attribute" &&
    fn.childForFieldName("object")?.text === "importlib" &&
    fn.childForFieldName("attribute")?.text === "import_module"
  )
    nameNode = fn.childForFieldName("attribute");
  if (!nameNode) return undefined;
  const args = call.childForFieldName("arguments");
  const spec = args ? plainString(named(args)[0]) : undefined;
  if (!spec || !DOTTED_NAME.test(spec.text)) return undefined;
  return { kind: "import", name: spec.text, nameNode, site: nodeSpan(call, lines) };
}

/** A bare decorator (`@retry`, `@app.route`) applies the decorator function: a call. `@retry(3)` is a `call` node. */
export function decoratorShape(decorator: Node, lines: readonly string[]): SiteShape | undefined {
  const expr = named(decorator)[0];
  if (expr?.type === "identifier")
    return { kind: "call", name: expr.text, nameNode: expr, site: nodeSpan(expr, lines) };
  if (expr?.type === "attribute") {
    const attr = expr.childForFieldName("attribute");
    const object = expr.childForFieldName("object");
    if (!attr || !object) return undefined;
    return {
      kind: "call",
      name: attr.text,
      nameNode: attr,
      qualifierNode: object,
      site: nodeSpan(expr, lines),
    };
  }
  return undefined;
}

// ─── Heritage ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The bases of a class (`extends`, site = the base name) and the type arguments of generic bases
 * (`Base[Job]` -> `type-ref` Job). Keyword arguments (`metaclass=`) are not bases.
 */
export function heritageShapes(classDef: Node, lines: readonly string[]): SiteShape[] {
  const out: SiteShape[] = [];
  const bases = classDef.childForFieldName("superclasses");
  if (!bases) return out;
  for (const base of named(bases)) {
    let head = base;
    let typeArgs: Node[] = [];
    if (base.type === "subscript") {
      head = base.childForFieldName("value") ?? base;
      typeArgs = base.childrenForFieldName("subscript");
    }
    if (head.type === "identifier") {
      out.push({ kind: "extends", name: head.text, nameNode: head, site: nodeSpan(head, lines) });
    } else if (head.type === "attribute") {
      const attr = head.childForFieldName("attribute");
      const object = head.childForFieldName("object");
      if (!attr || !object) continue;
      out.push({
        kind: "extends",
        name: attr.text,
        nameNode: attr,
        qualifierNode: object,
        site: nodeSpan(head, lines),
      });
    } else {
      continue;
    }
    for (const arg of typeArgs) collectTypeRefs(arg, lines, out);
  }
  return out;
}

// ─── Writes ───────────────────────────────────────────────────────────────────────────────────────

/** The names an assignment target binds or mutates, patterns flattened (`self.a, (b, *c) = ...`). */
function targetsOf(left: Node, out: Node[] = [], depth = 0): Node[] {
  if (depth > 6) return out;
  switch (left.type) {
    case "identifier":
    case "attribute":
      out.push(left);
      break;
    case "pattern_list":
    case "tuple_pattern":
    case "list_pattern":
    case "list_splat_pattern":
    case "parenthesized_expression":
      for (const child of named(left)) targetsOf(child, out, depth + 1);
      break;
    default:
      break; // subscripts (`self.d[k] = v`) and the like
  }
  return out;
}

/** The names a function declares `global` (not counting nested functions). */
export function globalNamesOf(fn: Node): Set<string> {
  const names = new Set<string>();
  for (const stmt of fn.descendantsOfType("global_statement")) {
    if (scopeNodeOf(stmt)?.id !== fn.id) continue;
    for (const id of stmt.namedChildren) if (id.type === "identifier") names.add(id.text);
  }
  return names;
}

/**
 * Is `target` (a plain name) an assignment to a module variable? Inside a function only with a `global`
 * declaration; at module level only augmented assignments (`x += 1`): a plain `x = 1` there is the
 * definition of the variable, which is a symbol of its own.
 */
function isModuleVariableWrite(
  assignment: Node,
  target: Node,
  globalsOf: (fn: Node) => ReadonlySet<string>,
): boolean {
  const scope = scopeNodeOf(assignment);
  if (!scope) return false;
  if (scope.type === "function_definition") return globalsOf(scope).has(target.text);
  return scope.type === "module" && assignment.type === "augmented_assignment";
}

/**
 * `write` sites of an `assignment` / `augmented_assignment`: attribute targets (`self.x = ...`,
 * `stats.count += 1`) and module variables (see `isModuleVariableWrite`).
 */
export function writeShapes(
  assignment: Node,
  lines: readonly string[],
  globalsOf: (fn: Node) => ReadonlySet<string>,
): SiteShape[] {
  const left = assignment.childForFieldName("left");
  if (!left) return [];
  const out: SiteShape[] = [];
  for (const target of targetsOf(left)) {
    if (target.type === "attribute") {
      const attr = target.childForFieldName("attribute");
      const object = target.childForFieldName("object");
      if (!attr || !object) continue;
      out.push({
        kind: "write",
        name: attr.text,
        nameNode: attr,
        qualifierNode: object,
        site: writeSpan(assignment, target, lines),
      });
    } else if (isModuleVariableWrite(assignment, target, globalsOf)) {
      out.push({
        kind: "write",
        name: target.text,
        nameNode: target,
        site: writeSpan(assignment, target, lines),
      });
    }
  }
  return out;
}

// ─── Imports ──────────────────────────────────────────────────────────────────────────────────────

export interface ImportEntry {
  /** The node whose span is the binding's site: the `aliased_import`, else the `dotted_name`. */
  node: Node;
  binding: Omit<ImportBinding, "site">;
}

export interface ImportStatement {
  entries: ImportEntry[];
  /** `from x import *`. */
  star?: Omit<ExportFact, "site">;
}

const compact = (text: string): string => text.replace(/\s+/g, "");

/**
 * The names an import statement brings into scope. `import a.b.c` binds "a.b.c" (the dotted name is how
 * the module is written in the code that uses it), `import a.b as x` binds `x` to the module `a.b`,
 * `from m import c as d` binds `d` to `c` of `m`. `from __future__` binds nothing.
 *
 * `from . import x` / `from .. import x` (a module path of only dots) import a sibling module far more often
 * than a name defined in `__init__.py`, so they bind `x` to the module `.x` / `..x` (a namespace binding).
 * Looked up as a name of the package instead, the resolver cannot see submodules, and a package whose
 * `__init__` star-imports a module that does `from . import x` sends its lookup around in circles.
 */
export function importStatement(stmt: Node): ImportStatement {
  const result: ImportStatement = { entries: [] };
  if (stmt.type === "import_statement") {
    for (const item of stmt.childrenForFieldName("name")) {
      if (item.type === "dotted_name") {
        const name = compact(item.text);
        result.entries.push({ node: item, binding: { localName: name, module: name } });
      } else if (item.type === "aliased_import") {
        const name = item.childForFieldName("name");
        const alias = item.childForFieldName("alias");
        if (name && alias)
          result.entries.push({
            node: item,
            binding: { localName: alias.text, module: compact(name.text) },
          });
      }
    }
  } else if (stmt.type === "import_from_statement") {
    const moduleNode = stmt.childForFieldName("module_name");
    if (!moduleNode) return result;
    const module = compact(moduleNode.text);
    const ofPackage = /^\.+$/.test(module);
    for (const item of stmt.childrenForFieldName("name")) {
      if (item.type === "dotted_name") {
        const name = compact(item.text);
        result.entries.push({
          node: item,
          binding: ofPackage
            ? { localName: name, module: module + name }
            : { localName: name, module, importedName: name },
        });
      } else if (item.type === "aliased_import") {
        const name = item.childForFieldName("name");
        const alias = item.childForFieldName("alias");
        if (name && alias)
          result.entries.push({
            node: item,
            binding: ofPackage
              ? { localName: alias.text, module: module + compact(name.text) }
              : { localName: alias.text, module, importedName: compact(name.text) },
          });
      }
    }
    if (stmt.namedChildren.some((c) => c.type === "wildcard_import"))
      result.star = { name: "*", module };
  }
  return result;
}

/**
 * The binding site node (`ImportEntry.node`) of the imported name `id` is part of: the identifiers of
 * `import a.b`, `from m import c`, `from m import c as d` (name and alias); not those of the module path
 * `from a.b import ...`.
 */
export function importSiteNodeOf(id: Node): Node | undefined {
  let item: Node = id;
  for (let i = 0; i < 3; i++) {
    const parent = item.parent;
    if (!parent) return undefined;
    if (parent.type === "import_statement" || parent.type === "import_from_statement") {
      return parent.childrenForFieldName("name").some((n) => n.id === item.id) ? item : undefined;
    }
    item = parent;
  }
  return undefined;
}
