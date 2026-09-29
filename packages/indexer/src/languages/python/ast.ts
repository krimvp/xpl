/**
 * tree-sitter-python node helpers shared by the extractor and `classifySite`: pure functions over nodes, no
 * per-file state. Comments are "extras" in the grammar and can show up between any two children, so every
 * traversal of `namedChildren` goes through `named()`.
 */
import type { Node } from "web-tree-sitter";
import { nodeSpan, spanLineCount } from "../../ast.js";
import type { SiteKind, Span } from "../types.js";

/** A call/assignment spanning more lines than this is reported by its callee/target only. */
export const SITE_MAX_LINES = 10;

/**
 * A syntactic reference site before its qualifier is spelled: what `extract` turns into a `SiteDraft` and
 * `classifySite` matches an identifier against. `nameNode` is the identifier (or string content of a
 * forward reference) a SCIP occurrence would sit on.
 */
export interface SiteShape {
  kind: SiteKind;
  /** The referenced name: last segment of the callee / type / module. */
  name: string;
  nameNode: Node;
  /** The receiver expression (`a.b` of `a.b.f()`): spelled with `chainOf`, which needs scope information. */
  qualifierNode?: Node;
  /** A receiver that is already known as text segments (dotted type names, forward references). */
  qualifierText?: string[];
  site: Span;
}

/** `a.b.c` / `a` (no whitespace, no calls). */
export const DOTTED_NAME = /^[\p{L}_][\p{L}\p{N}_]*(\.[\p{L}_][\p{L}\p{N}_]*)*$/u;

/** Named children without comments. */
export function named(node: Node): Node[] {
  return node.namedChildren.filter((c) => c.type !== "comment");
}

export function lastSegment(path: string): string {
  const i = path.lastIndexOf(".");
  return i < 0 ? path : path.slice(i + 1);
}

/** `a.b.c` text of an identifier / attribute chain; undefined for anything else (calls, subscripts, ...). */
export function dottedName(node: Node | null | undefined, depth = 0): string | undefined {
  if (!node || depth > 16) return undefined;
  if (node.type === "identifier") return node.text;
  if (node.type === "attribute") {
    const object = dottedName(node.childForFieldName("object"), depth + 1);
    const attr = node.childForFieldName("attribute");
    return object !== undefined && attr ? `${object}.${attr.text}` : undefined;
  }
  return undefined;
}

// ─── Site spans (shared by extract and classifySite) ──────────────────────────────────────────────

/** Whole call expression, or only the callee when the call spans more than 10 lines. */
export function callSpan(call: Node, callee: Node, lines: readonly string[]): Span {
  const whole = nodeSpan(call, lines);
  if (spanLineCount(whole) <= SITE_MAX_LINES) return whole;
  const calleeSpan = nodeSpan(callee, lines);
  if (spanLineCount(calleeSpan) <= SITE_MAX_LINES) return calleeSpan;
  const attr = callee.type === "attribute" ? callee.childForFieldName("attribute") : null;
  return nodeSpan(attr ?? callee, lines);
}

/** Whole assignment, or only its target when the assignment spans more than 10 lines. */
export function writeSpan(assignment: Node, target: Node, lines: readonly string[]): Span {
  const whole = nodeSpan(assignment, lines);
  return spanLineCount(whole) <= SITE_MAX_LINES ? whole : nodeSpan(target, lines);
}

// ─── Strings ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The text and content node of a plain string literal (`"x"`, `'x'`, `r"x"`, triple-quoted): no f-string
 * interpolation, no bytes, a single content piece. Undefined for anything else.
 */
export function plainString(
  node: Node | null | undefined,
): { text: string; content: Node } | undefined {
  if (!node || node.type !== "string") return undefined;
  const start = node.child(0);
  if (!start || start.type !== "string_start" || !/^[rRuU]?("""|'''|"|')$/.test(start.text))
    return undefined;
  let content: Node | undefined;
  for (const child of node.namedChildren) {
    if (child.type === "string_content") {
      if (content) return undefined;
      content = child;
    } else if (child.type === "interpolation") {
      return undefined;
    }
  }
  return content ? { text: content.text, content } : undefined;
}

// ─── Definitions and decorators ───────────────────────────────────────────────────────────────────

/** `@a.b(...)`-style decorator expressions of a `decorated_definition`. */
function decoratorExpressions(decorated: Node): Node[] {
  const out: Node[] = [];
  for (const child of decorated.namedChildren) {
    if (child.type !== "decorator") continue;
    const expr = named(child)[0];
    if (expr) out.push(expr);
  }
  return out;
}

/** Last segment of every decorator's name (`@a.b.c(1)` -> `c`), in source order. */
export function decoratorNames(def: Node): string[] {
  const decorated = def.parent;
  if (decorated?.type !== "decorated_definition") return [];
  const names: string[] = [];
  for (let expr of decoratorExpressions(decorated)) {
    if (expr.type === "call") expr = expr.childForFieldName("function") ?? expr;
    const name = dottedName(expr);
    if (name !== undefined) names.push(lastSegment(name));
  }
  return names;
}

export function isStaticMethod(def: Node): boolean {
  return decoratorNames(def).some((n) => n === "staticmethod" || n === "abstractstaticmethod");
}

export function isOverload(def: Node): boolean {
  return decoratorNames(def).includes("overload");
}

/** `if __name__ == "__main__":` (either operand order). */
export function isMainGuard(stmt: Node): boolean {
  if (stmt.type !== "if_statement") return false;
  const cond = stmt.childForFieldName("condition");
  if (cond?.type !== "comparison_operator") return false;
  if (!cond.children.some((c) => c.type === "==")) return false;
  const operands = named(cond);
  if (operands.length !== 2) return false;
  const isName = (n: Node): boolean => n.type === "identifier" && n.text === "__name__";
  const isMain = (n: Node): boolean => plainString(n)?.text === "__main__";
  return (
    (isName(operands[0]!) && isMain(operands[1]!)) || (isMain(operands[0]!) && isName(operands[1]!))
  );
}

const CLAUSES = new Set([
  "elif_clause",
  "else_clause",
  "except_clause",
  "except_group_clause",
  "finally_clause",
  "case_clause",
]);
const COMPOUND = new Set([
  "if_statement",
  "try_statement",
  "with_statement",
  "for_statement",
  "while_statement",
  "match_statement",
  ...CLAUSES,
]);

/**
 * The statements nested one level down in a compound statement (`if`/`try`/`with`/`for`/`while`/`match`,
 * with their `elif`/`else`/`except`/`finally`/`case` clauses), flattened; empty for anything else. They
 * live in the same scope as the statement itself, so definitions in them are members of that scope.
 */
export function nestedStatements(stmt: Node): Node[] {
  if (!COMPOUND.has(stmt.type)) return [];
  const out: Node[] = [];
  for (const child of named(stmt)) {
    if (child.type === "block") out.push(...named(child));
    else if (CLAUSES.has(child.type)) out.push(child);
  }
  return out;
}

// ─── Parameters ───────────────────────────────────────────────────────────────────────────────────

export interface Param {
  name: string;
  node: Node;
  /** The `type` node of an annotation. */
  type?: Node;
  /** The default value. */
  value?: Node;
  /** `*args` / `**kwargs`. */
  splat: boolean;
}

/** The named parameters of a `function_definition` or `lambda`, in order (separators and patterns skipped). */
export function paramsOf(fn: Node): Param[] {
  const list = fn.childForFieldName("parameters");
  if (!list) return [];
  const out: Param[] = [];
  for (const p of named(list)) {
    switch (p.type) {
      case "identifier":
        out.push({ name: p.text, node: p, splat: false });
        break;
      case "typed_parameter": {
        const inner = named(p).find((c) => c.type !== "type");
        if (inner?.type === "identifier")
          out.push({
            name: inner.text,
            node: p,
            type: p.childForFieldName("type") ?? undefined,
            splat: false,
          });
        else if (inner) {
          const id = named(inner).find((c) => c.type === "identifier");
          if (id) out.push({ name: id.text, node: p, splat: true });
        }
        break;
      }
      case "default_parameter":
      case "typed_default_parameter": {
        const name = p.childForFieldName("name");
        if (name?.type !== "identifier") break;
        out.push({
          name: name.text,
          node: p,
          type: p.childForFieldName("type") ?? undefined,
          value: p.childForFieldName("value") ?? undefined,
          splat: false,
        });
        break;
      }
      case "list_splat_pattern":
      case "dictionary_splat_pattern": {
        const id = named(p).find((c) => c.type === "identifier");
        if (id) out.push({ name: id.text, node: p, splat: true });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** The nearest enclosing `function_definition` / `lambda` / `class_definition` / `module` above `node`. */
export function scopeNodeOf(node: Node): Node | undefined {
  for (let n = node.parent; n; n = n.parent) {
    if (
      n.type === "function_definition" ||
      n.type === "lambda" ||
      n.type === "class_definition" ||
      n.type === "module"
    )
      return n;
  }
  return undefined;
}
