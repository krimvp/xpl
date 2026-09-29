/**
 * TypeScript / TSX / JavaScript language pack (ARCHITECTURE.md §3).
 *
 * Files: `.ts .mts .cts` (typescript grammar), `.tsx` (tsx grammar) and `.js .mjs .cjs .jsx` (javascript,
 * parsed with the tsx grammar so JSX and TS-ish syntax both work).
 *
 * Symbols (kind; path):
 * - class / abstract class / class expression bound to a const / anonymous default export -> `class`
 * - interface -> `interface`; type alias -> `type`; enum -> `enum` (members are not symbols)
 * - function and generator declarations, `const/let/var` with an arrow/function initialiser -> `function`;
 *   other `const/let/var` declarators (and destructured names) -> `variable`
 * - class members: methods incl. constructor/get/set/abstract -> `method`; fields -> `variable`, except
 *   fields initialised with an arrow/function, which are methods in every way that matters -> `method`;
 *   path `Class.member`; `#private` names keep their `#`
 * - interface members: method signatures -> `method`, property signatures -> `variable`
 * - function declarations nested in functions/methods -> `function`, path `outer.inner`
 * - methods and function-valued properties of top-level object literals -> `method`, path `obj.key`
 * - namespaces -> `other`, members are `NS.name`; the declarations of `declare module "x" { }` and
 *   `declare global { }` are listed as if they were top-level (those blocks have no addressable name)
 * - anonymous default exports (`export default class {}`, `export default () => {}`, `export default {...}`,
 *   `export default call()`) -> path `default`; `export default foo` adds no symbol (see `ExportFact`)
 * - body-less overload signatures are skipped when an implementation with the same name follows; ambient
 *   declarations (`declare function f(): void`, `.d.ts` files) have no implementation and are kept
 *
 * A symbol's range runs from the first decorator / `export` / `declare` / modifier to the end of the
 * declaration; leading comments are not part of it.
 *
 * Sites: calls (`f()`, `a.b.c()`, `new X()`, `super.m()`, JSX components), imports without bindings
 * (`import "./x"`, `import("./x")`, `require("./x")`), `extends` / `implements`, `type-ref`, `write`.
 */
import { posix } from "node:path";
import type { Node } from "web-tree-sitter";
import { SpanIndex, nodeSpan, spanBetween, spanLineCount } from "../ast.js";
import { probeModule, repoPath, resolveBareSpecifier } from "./ts-modules.js";
import type {
  ClassifiedSite,
  ExportFact,
  FileContext,
  FileFacts,
  ImportBinding,
  LanguagePack,
  RepoView,
  SiteDraft,
  Span,
  SymbolDraft,
  TypeFact,
} from "./types.js";
import type { FileLanguage } from "@xpl/core";
import type { GrammarId } from "../wasm-files.js";

/** A call/assignment spanning more lines than this is reported by its callee/target only. */
const SITE_MAX_LINES = 10;
const FUNCTION_VALUE = new Set([
  "arrow_function",
  "function_expression",
  "function",
  "generator_function",
]);
const PROMISE_LIKE = new Set(["Promise", "PromiseLike", "Awaited"]);
const HERITAGE_CLAUSES = new Set(["extends_clause", "implements_clause", "extends_type_clause"]);
const DECLARATION_PARENTS = new Set([
  "class_declaration",
  "abstract_class_declaration",
  "class",
  "interface_declaration",
  "type_alias_declaration",
  "type_parameter",
  "mapped_type_clause",
  "infer_type",
  "enum_declaration",
]);
const IDENTIFIER_TYPES = new Set([
  "identifier",
  "property_identifier",
  "type_identifier",
  "private_property_identifier",
  "shorthand_property_identifier",
  "super", // `super(...)` is a call of the base constructor
]);
/** Node types the flat scan looks at (descendantsOfType is a single native call). */
const SCAN_TYPES = [
  "variable_declarator",
  "call_expression",
  "new_expression",
  "assignment_expression",
  "augmented_assignment_expression",
  "update_expression",
  "extends_clause",
  "implements_clause",
  "extends_type_clause",
  "type_identifier",
  "nested_type_identifier",
  "jsx_opening_element",
  "jsx_self_closing_element",
  "required_parameter",
  "optional_parameter",
];

// ─── Small node helpers ───────────────────────────────────────────────────────────────────────────

function isFunctionValue(node: Node | null | undefined): boolean {
  return !!node && FUNCTION_VALUE.has(node.type);
}

/** `require("./x")` with a single string literal argument (a CommonJS import, not a definition). */
function isRequireCall(node: Node | null | undefined): boolean {
  const call = unwrapValue(node);
  if (call?.type !== "call_expression") return false;
  const fn = call.childForFieldName("function");
  const args = call.childForFieldName("arguments");
  return (
    fn?.type === "identifier" &&
    fn.text === "require" &&
    args?.namedChildCount === 1 &&
    args.namedChild(0)?.type === "string"
  );
}

/** The function node an initialiser evaluates to (arrow / function expression, possibly cast or parenthesised). */
function functionValue(node: Node | null | undefined): Node | undefined {
  const value = unwrapValue(node);
  return value && FUNCTION_VALUE.has(value.type) ? value : undefined;
}

/** Strip parentheses, casts (`as`, `satisfies`, `<T>`), and non-null assertions. */
function unwrapValue(node: Node | null | undefined): Node | null {
  let n = node ?? null;
  for (let i = 0; n && i < 8; i++) {
    if (
      n.type === "parenthesized_expression" ||
      n.type === "non_null_expression" ||
      n.type === "as_expression" ||
      n.type === "satisfies_expression"
    ) {
      n = n.namedChild(0);
    } else if (n.type === "type_assertion") {
      n = n.lastNamedChild;
    } else {
      break;
    }
  }
  return n;
}

/** Content of a string literal node (between the quotes). */
function stringContent(node: Node): string {
  const text = node.text;
  return text.length >= 2 ? text.slice(1, -1) : text;
}

/** The name of a class member / object property, or undefined for computed names we cannot spell. */
function memberName(nameNode: Node | null): string | undefined {
  if (!nameNode) return undefined;
  switch (nameNode.type) {
    case "property_identifier":
    case "private_property_identifier":
    case "identifier":
    case "type_identifier":
    case "number":
      return nameNode.text;
    case "string":
      return stringContent(nameNode);
    case "computed_property_name": {
      // `[Symbol.iterator]` -> "@@iterator"; other computed names are not addressable.
      const inner = nameNode.namedChild(0);
      if (
        inner?.type === "member_expression" &&
        inner.childForFieldName("object")?.text === "Symbol"
      ) {
        const prop = inner.childForFieldName("property");
        return prop ? `@@${prop.text}` : undefined;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

function lastSegment(path: string): string {
  const i = path.lastIndexOf(".");
  return i < 0 ? path : path.slice(i + 1);
}

/** Names bound by a destructuring pattern (`{ a, b: c }`, `[x, y]`, defaults and rest included). */
function patternNames(pattern: Node, out: string[] = [], depth = 0): string[] {
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

// ─── Types and qualifiers ─────────────────────────────────────────────────────────────────────────

const OPAQUE_PREDEFINED = new Set(["any", "unknown", "never"]);
/** Nodes that open a block scope for `const`/`let`. */
const BLOCK_SCOPES = new Set([
  "statement_block",
  "class_static_block",
  "for_statement",
  "for_in_statement",
  "switch_body",
]);
/** Nodes that open a function scope (for `var`). */
const FUNCTION_SCOPES = new Set([
  "function_declaration",
  "generator_function_declaration",
  "function_expression",
  "function",
  "generator_function",
  "arrow_function",
  "method_definition",
]);

/** Owners that are only scopes when they were emitted as symbols (anonymous functions always are). */
const DECLARED_OWNERS = new Set([
  "function_declaration",
  "generator_function_declaration",
  "method_definition",
  "function_signature",
  "method_signature",
  "abstract_method_signature",
]);
/** Node types whose parameters are real function scopes (function *types* and call signatures are not). */
const PARAMETER_OWNERS = new Set([
  "function_declaration",
  "generator_function_declaration",
  "function_expression",
  "function",
  "generator_function",
  "arrow_function",
  "method_definition",
  "function_signature",
  "method_signature",
  "abstract_method_signature",
]);

/** Base name of a type node: generics stripped, `T | undefined` -> `T`, `Promise<T>` -> `T` if asked. */
function typeNameOf(
  node: Node | null | undefined,
  unwrapPromise: boolean,
  depth = 0,
): string | undefined {
  if (!node || depth > 8) return undefined;
  switch (node.type) {
    case "type_annotation":
    case "parenthesized_type":
    case "readonly_type":
      return typeNameOf(node.namedChild(0), unwrapPromise, depth + 1);
    case "type_identifier":
      return node.text;
    case "nested_type_identifier":
      return node.text.replace(/\s+/g, "");
    case "generic_type": {
      const base = typeNameOf(node.childForFieldName("name"), false, depth + 1);
      if (!base) return undefined;
      if (unwrapPromise && PROMISE_LIKE.has(base)) {
        const first = node.childForFieldName("type_arguments")?.namedChild(0);
        return first ? typeNameOf(first, true, depth + 1) : undefined;
      }
      return base;
    }
    case "predefined_type":
      return OPAQUE_PREDEFINED.has(node.text) || !/^[a-z]+$/.test(node.text)
        ? undefined
        : node.text;
    case "array_type":
    case "tuple_type":
      return "Array";
    case "this_type":
      return "this";
    case "union_type": {
      const parts = node.namedChildren.filter(
        (c) => !(c.type === "literal_type" && (c.text === "null" || c.text === "undefined")),
      );
      return parts.length === 1 ? typeNameOf(parts[0], unwrapPromise, depth + 1) : undefined;
    }
    default:
      return undefined;
  }
}

/** Qualifier segments of a receiver expression (see types.ts), or undefined when it cannot be spelled. */
function chainOf(node: Node | null | undefined, depth = 0): string[] | undefined {
  if (!node || depth > 16) return undefined;
  switch (node.type) {
    case "this":
      return ["this"];
    case "super":
      return ["super"];
    case "identifier":
      return [node.text];
    case "parenthesized_expression":
    case "non_null_expression":
    case "await_expression":
      return chainOf(node.namedChild(0), depth + 1);
    case "as_expression":
    case "satisfies_expression": {
      const type = typeNameOf(node.namedChild(1), false);
      return type ? [`:${type}`] : chainOf(node.namedChild(0), depth + 1);
    }
    case "member_expression": {
      const object = chainOf(node.childForFieldName("object"), depth + 1);
      const property = node.childForFieldName("property");
      if (!object || !property) return undefined;
      return [...object, property.text];
    }
    case "call_expression": {
      const parts = calleeParts(node.childForFieldName("function"), depth + 1);
      return parts ? [...parts.qualifier, `${parts.name}()`] : undefined;
    }
    case "new_expression": {
      const parts = calleeParts(node.childForFieldName("constructor"), depth + 1);
      return parts ? [...parts.qualifier, `${parts.name}()`] : undefined;
    }
    default:
      return undefined;
  }
}

interface NameParts {
  name: string;
  qualifier: string[];
}

/** `name` and `qualifier` of a callee / constructor / assignment target expression. */
function calleeParts(node: Node | null | undefined, depth = 0): NameParts | undefined {
  if (!node || depth > 16) return undefined;
  switch (node.type) {
    case "identifier":
      return { name: node.text, qualifier: [] };
    case "super":
      return { name: "constructor", qualifier: ["super"] };
    case "non_null_expression":
    case "parenthesized_expression":
      return calleeParts(node.namedChild(0), depth + 1);
    case "member_expression": {
      const property = node.childForFieldName("property");
      const qualifier = chainOf(node.childForFieldName("object"), depth + 1);
      if (!property || !qualifier) return undefined;
      return { name: property.text, qualifier };
    }
    default:
      return undefined;
  }
}

/** `name` and `qualifier` of a type reference / heritage expression, and the node the site covers. */
function typeRefParts(node: Node | null | undefined): (NameParts & { siteNode: Node }) | undefined {
  if (!node) return undefined;
  switch (node.type) {
    case "type_identifier":
    case "identifier":
      return { name: node.text, qualifier: [], siteNode: node };
    case "nested_type_identifier": {
      const module = node.childForFieldName("module");
      const name = node.childForFieldName("name");
      if (!module || !name) return undefined;
      return {
        name: name.text,
        qualifier: module.text.replace(/\s+/g, "").split("."),
        siteNode: node,
      };
    }
    case "generic_type":
      return typeRefParts(node.childForFieldName("name"));
    case "member_expression": {
      const parts = calleeParts(node);
      return parts ? { ...parts, siteNode: node } : undefined;
    }
    default:
      return undefined;
  }
}

interface Inferred {
  typeName?: string;
  initCall?: { qualifier: string[]; name: string };
  initChain?: string[];
}

/**
 * A type fact from what a declaration says (`declared`, wins) or what its initialiser shows (`inferred`).
 * Undefined when neither tells anything.
 */
function makeFact(
  base: Pick<TypeFact, "scopePath" | "name" | "kind">,
  declared: string | undefined,
  inferred: Inferred | undefined,
): TypeFact | undefined {
  const fact: TypeFact = { ...base };
  if (declared !== undefined) fact.typeName = declared;
  else if (inferred?.typeName) fact.typeName = inferred.typeName;
  else if (inferred?.initCall) fact.initCall = inferred.initCall;
  else if (inferred?.initChain) fact.initChain = inferred.initChain;
  else return undefined;
  return fact;
}

/** The type of an initialiser expression, when it is evident: `new X()`, a call, a literal, `x as T`. */
function inferFromInit(expr: Node | null | undefined, depth = 0): Inferred | undefined {
  let n = expr ?? null;
  for (let i = 0; n && i < 8; i++) {
    if (
      n.type === "await_expression" ||
      n.type === "parenthesized_expression" ||
      n.type === "non_null_expression"
    ) {
      n = n.namedChild(0);
    } else if (n.type === "satisfies_expression") {
      n = n.namedChild(0);
    } else if (n.type === "as_expression") {
      const cast = typeNameOf(n.namedChild(1), false);
      if (cast) return { typeName: cast };
      n = n.namedChild(0);
    } else if (n.type === "type_assertion") {
      const cast = typeNameOf(n.namedChild(0), false);
      if (cast) return { typeName: cast };
      n = n.lastNamedChild;
    } else {
      break;
    }
  }
  if (!n || depth > 4) return undefined;
  switch (n.type) {
    case "new_expression": {
      const parts = calleeParts(n.childForFieldName("constructor"));
      return parts ? { typeName: [...parts.qualifier, parts.name].join(".") } : undefined;
    }
    case "call_expression": {
      const parts = calleeParts(n.childForFieldName("function"));
      return parts ? { initCall: { qualifier: parts.qualifier, name: parts.name } } : undefined;
    }
    case "member_expression":
    case "identifier":
    case "this": {
      // An alias: `const index = model.index`, `const queue = this.queue`, `const self = this`.
      const chain = chainOf(n);
      return chain && chain.length <= 6 ? { initChain: chain } : undefined;
    }
    case "string":
    case "template_string":
      return { typeName: "string" };
    case "number":
      return { typeName: "number" };
    case "true":
    case "false":
      return { typeName: "boolean" };
    case "regex":
      return { typeName: "RegExp" };
    case "array":
      return { typeName: "Array" };
    default:
      return undefined;
  }
}

/** Longest function body (in lines) whose `return` statements are inspected. */
const RETURN_SCAN_MAX_LINES = 400;

/** What the first `return <expr>` of `fn` (not of a nested function) evidently returns. */
function inferReturn(fn: Node, body: Node): Inferred | undefined {
  if (body.endPosition.row - body.startPosition.row > RETURN_SCAN_MAX_LINES) return undefined;
  let inspected = 0;
  for (const statement of body.descendantsOfType("return_statement")) {
    let owner = statement.parent;
    while (owner && !FUNCTION_SCOPES.has(owner.type)) owner = owner.parent;
    if (owner?.id !== fn.id) continue; // a `return` of a nested function
    if (++inspected > 6) break;
    const inferred = inferFromInit(statement.namedChild(0));
    if (inferred) return inferred;
  }
  return undefined;
}

// ─── Site spans (shared by extract and classifySite) ─────────────────────────────────────────────

/** Whole call expression, or only the callee when the call spans more than 10 lines. */
function callSpan(call: Node, callee: Node, lines: readonly string[]): Span {
  const whole = nodeSpan(call, lines);
  if (spanLineCount(whole) <= SITE_MAX_LINES) return whole;
  const calleeSpan = nodeSpan(callee, lines);
  if (spanLineCount(calleeSpan) <= SITE_MAX_LINES) return calleeSpan;
  const property =
    callee.type === "member_expression" ? callee.childForFieldName("property") : null;
  return nodeSpan(property ?? callee, lines);
}

/** Whole assignment/update expression, or only its target when it spans more than 10 lines. */
function writeSpan(expr: Node, target: Node, lines: readonly string[]): Span {
  const whole = nodeSpan(expr, lines);
  return spanLineCount(whole) <= SITE_MAX_LINES ? whole : nodeSpan(target, lines);
}

/** Is this `type_identifier`/nested node the name part of a heritage clause (extends/implements)? */
function heritageKind(node: Node): "extends" | "implements" | undefined {
  let top = node;
  for (;;) {
    const parent = top.parent;
    if (!parent) return undefined;
    if (
      parent.type === "nested_type_identifier" ||
      (parent.type === "generic_type" && parent.childForFieldName("name")?.id === top.id)
    ) {
      top = parent;
      continue;
    }
    if (!HERITAGE_CLAUSES.has(parent.type)) return undefined;
    return parent.type === "implements_clause" ? "implements" : "extends";
  }
}

/** Is this `type_identifier` a use of a type parameter (`T` inside `class C<T>`, `<T>(x: T) => …`)? */
function isTypeParameterRef(node: Node, name: string = node.text): boolean {
  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
    const parameters = ancestor.childForFieldName("type_parameters");
    if (
      parameters?.namedChildren.some(
        (p) => p.type === "type_parameter" && p.childForFieldName("name")?.text === name,
      )
    ) {
      return true;
    }
  }
  return false;
}

function isDeclarationName(node: Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === "infer_type") return true;
  return DECLARATION_PARENTS.has(parent.type) && parent.childForFieldName("name")?.id === node.id;
}

/** JSX tag name -> a callee, for components (capitalised names and member expressions). */
function jsxComponent(element: Node): NameParts | undefined {
  const name = element.childForFieldName("name");
  if (!name) return undefined;
  if (name.type === "identifier")
    return /^[A-Z]/.test(name.text) ? { name: name.text, qualifier: [] } : undefined;
  if (name.type === "member_expression") return calleeParts(name);
  return undefined;
}

// ─── The extractor ────────────────────────────────────────────────────────────────────────────────

interface Scope {
  /** Prefix for member paths: `""` at module level, `"NS."` inside a namespace. */
  prefix: string;
  parentPath?: string;
}

interface Unwrapped {
  node?: Node;
  isDefault: boolean;
}

/** `export`/`declare`/namespace wrappers stripped: the declaration node inside a statement. */
function unwrapStatement(stmt: Node): Unwrapped {
  let node: Node | null = stmt;
  let isDefault = false;
  for (let i = 0; i < 4 && node; i++) {
    if (node.type === "export_statement") {
      isDefault = node.children.some((c) => c.type === "default");
      const declaration = node.childForFieldName("declaration");
      if (declaration) {
        node = declaration;
        continue;
      }
      const value = node.childForFieldName("value");
      return value ? { node: value, isDefault: true } : { isDefault };
    }
    if (node.type === "ambient_declaration") {
      node = node.namedChildren.find((c) => c.type !== "comment") ?? null;
      continue;
    }
    if (node.type === "expression_statement") {
      const inner = node.namedChild(0);
      if (inner && (inner.type === "internal_module" || inner.type === "module")) {
        node = inner;
        continue;
      }
      return { isDefault };
    }
    break;
  }
  return node ? { node, isDefault } : { isDefault };
}

/** The body of an immediately-invoked function expression statement: `(function () {...})()`, `!(() => {...})()`. */
function iifeBody(stmt: Node): Node | undefined {
  if (stmt.type !== "expression_statement") return undefined;
  let expr = stmt.namedChild(0);
  if (expr?.type === "unary_expression") expr = expr.childForFieldName("argument");
  if (expr?.type === "await_expression") expr = expr.namedChild(0);
  while (expr?.type === "parenthesized_expression") expr = expr.namedChild(0);
  if (expr?.type !== "call_expression") return undefined;
  let fn = expr.childForFieldName("function");
  while (fn?.type === "parenthesized_expression") fn = fn.namedChild(0);
  if (!fn || !FUNCTION_VALUE.has(fn.type)) return undefined;
  const body = fn.childForFieldName("body");
  return body?.type === "statement_block" ? body : undefined;
}

class Extractor {
  private readonly drafts: SymbolDraft[] = [];
  private readonly sites: SiteDraft[] = [];
  private readonly imports: ImportBinding[] = [];
  private readonly typeFacts: TypeFact[] = [];
  private readonly exports: ExportFact[] = [];
  private readonly lines: readonly string[];
  private draftIndex: SpanIndex<SymbolDraft> = new SpanIndex([]);
  private readonly draftByPath = new Map<string, SymbolDraft>();
  /** Declarator node id -> the symbol declared by it (so its initialiser's locals get the right scope). */
  private readonly ownDeclarators = new Map<number, SymbolDraft>();
  /** Call nodes already consumed as `const x = require(...)` bindings. */
  private readonly handled = new Set<number>();
  /** Function-like nodes that own a symbol (their parameters are scoped to it). */
  private readonly functionNodes = new Set<number>();
  private readonly fieldFacts = new Set<string>();
  private readonly paramFacts = new Map<string, TypeFact>();

  constructor(private readonly ctx: FileContext) {
    this.lines = ctx.lines;
  }

  run(): FileFacts {
    const root = this.ctx.tree.rootNode;
    this.visitStatements(root.namedChildren, { prefix: "" });
    this.draftIndex = new SpanIndex(this.drafts.map((d) => ({ span: d.range, value: d })));
    for (const draft of this.drafts)
      if (!this.draftByPath.has(draft.path)) this.draftByPath.set(draft.path, draft);
    this.scan(root);
    return {
      symbols: this.drafts,
      sites: this.sites,
      imports: this.imports,
      typeFacts: this.typeFacts,
      exports: this.exports,
    };
  }

  // ── symbols ────────────────────────────────────────────────────────────────────────────────────

  private emit(
    path: string,
    kind: SymbolDraft["kind"],
    first: Node,
    last: Node,
    parentPath?: string,
  ): SymbolDraft {
    const draft: SymbolDraft = { path, kind, range: spanBetween(first, last, this.lines) };
    if (parentPath !== undefined) draft.parentPath = parentPath;
    this.drafts.push(draft);
    return draft;
  }

  private visitStatements(stmts: readonly Node[], scope: Scope): void {
    // Names that have an implementation, to recognise overload signatures.
    const implemented = new Set<string>();
    for (const stmt of stmts) {
      const { node } = unwrapStatement(stmt);
      if (
        node &&
        (node.type === "function_declaration" || node.type === "generator_function_declaration")
      ) {
        const name = node.childForFieldName("name");
        if (name) implemented.add(name.text);
      }
    }
    for (const stmt of stmts) this.visitStatement(stmt, scope, implemented);
  }

  private visitStatement(stmt: Node, scope: Scope, implemented: ReadonlySet<string>): void {
    if (stmt.type === "import_statement") {
      this.importStatement(stmt);
      return;
    }
    if (stmt.type === "comment") return;
    // `(function () { ... })();` and friends: the definitions inside are the module's (legacy JS, UMD).
    const iife = iifeBody(stmt);
    if (iife) {
      this.visitStatements(iife.namedChildren, scope);
      return;
    }
    const unwrapped = unwrapStatement(stmt);
    if (stmt.type === "export_statement") this.exportStatement(stmt, unwrapped);
    const node = unwrapped.node;
    if (!node) return;
    const prefix = scope.prefix;
    const parent = scope.parentPath;

    switch (node.type) {
      case "class_declaration":
      case "abstract_class_declaration": {
        const name = node.childForFieldName("name");
        if (name) this.classSymbol(stmt, node, prefix + name.text, parent);
        break;
      }
      case "class":
        if (unwrapped.isDefault) this.classSymbol(stmt, node, prefix + "default", parent);
        break;
      case "interface_declaration": {
        const name = node.childForFieldName("name");
        if (!name) break;
        const path = prefix + name.text;
        this.emit(path, "interface", stmt, stmt, parent);
        const body = node.childForFieldName("body");
        if (body) this.interfaceBody(body, path);
        break;
      }
      case "type_alias_declaration": {
        const name = node.childForFieldName("name");
        if (name) this.emit(prefix + name.text, "type", stmt, stmt, parent);
        break;
      }
      case "enum_declaration": {
        const name = node.childForFieldName("name");
        if (name) this.emit(prefix + name.text, "enum", stmt, stmt, parent);
        break;
      }
      case "function_declaration":
      case "generator_function_declaration": {
        const name = node.childForFieldName("name");
        if (!name) break;
        const path = prefix + name.text;
        this.emit(path, "function", stmt, stmt, parent);
        this.functionLike(node, path);
        break;
      }
      case "function_signature": {
        const name = node.childForFieldName("name");
        if (!name || implemented.has(name.text)) break; // an overload of a function implemented below
        const path = prefix + name.text;
        this.emit(path, "function", stmt, stmt, parent);
        this.functionLike(node, path);
        break;
      }
      case "lexical_declaration":
      case "variable_declaration":
        this.declarators(stmt, node, scope);
        break;
      case "internal_module":
      case "module":
        this.namespaceSymbol(stmt, node, scope);
        break;
      case "statement_block":
        // `declare global { ... }`: its declarations are the globals of this scope.
        if (stmt.type === "ambient_declaration") this.visitStatements(node.namedChildren, scope);
        break;
      default:
        if (unwrapped.isDefault) this.defaultValue(stmt, node, scope);
        break;
    }
  }

  private classSymbol(outer: Node, cls: Node, path: string, parentPath: string | undefined): void {
    this.emit(path, "class", outer, outer, parentPath);
    const body = cls.childForFieldName("body");
    if (body) this.classBody(body, path);
  }

  private classBody(body: Node, classPath: string): void {
    const implemented = new Set<string>();
    for (const member of body.namedChildren) {
      if (member.type !== "method_definition") continue;
      const name = memberName(member.childForFieldName("name"));
      if (name !== undefined) implemented.add(name);
    }
    // In the TypeScript grammar the decorators of a method are siblings that precede it.
    let firstDecorator: Node | undefined;
    for (const member of body.namedChildren) {
      if (member.type === "decorator") {
        firstDecorator ??= member;
        continue;
      }
      if (member.type === "comment") continue;
      const first = firstDecorator ?? member;
      firstDecorator = undefined;
      switch (member.type) {
        case "method_definition":
        case "abstract_method_signature":
        case "method_signature": {
          const name = memberName(member.childForFieldName("name"));
          if (name === undefined) break;
          if (member.type === "method_signature" && implemented.has(name)) break; // overload signature
          const path = `${classPath}.${name}`;
          this.emit(path, "method", first, member, classPath);
          this.functionLike(member, path);
          break;
        }
        case "public_field_definition": {
          const name = memberName(member.childForFieldName("name"));
          if (name === undefined) break;
          const path = `${classPath}.${name}`;
          const fn = functionValue(member.childForFieldName("value"));
          if (fn) {
            this.emit(path, "method", first, member, classPath);
            this.functionLike(fn, path);
          } else {
            this.emit(path, "variable", first, member, classPath);
            this.declaredFieldFact(
              classPath,
              name,
              member.childForFieldName("type"),
              member.childForFieldName("value"),
            );
          }
          break;
        }
        default:
          break; // static blocks, index signatures
      }
    }
  }

  private interfaceBody(body: Node, path: string): void {
    for (const member of body.namedChildren) {
      if (member.type !== "method_signature" && member.type !== "property_signature") continue;
      const name = memberName(member.childForFieldName("name"));
      if (name === undefined) continue;
      const memberPath = `${path}.${name}`;
      if (member.type === "method_signature") {
        this.emit(memberPath, "method", member, member, path);
        this.functionLike(member, memberPath);
      } else {
        this.emit(memberPath, "variable", member, member, path);
        this.declaredFieldFact(path, name, member.childForFieldName("type"), null);
      }
    }
  }

  private namespaceSymbol(outer: Node, mod: Node, scope: Scope): void {
    const nameNode = mod.childForFieldName("name");
    if (!nameNode) return;
    if (nameNode.type === "string") {
      // `declare module "x" { ... }`: an ambient module has no addressable name (it is a file path), so its
      // declarations are listed as this scope's own.
      const ambient = mod.childForFieldName("body");
      if (ambient) this.visitStatements(ambient.namedChildren, scope);
      return;
    }
    const path = scope.prefix + nameNode.text.replace(/\s+/g, "");
    this.emit(path, "other", outer, outer, scope.parentPath);
    const body = mod.childForFieldName("body");
    if (body) this.visitStatements(body.namedChildren, { prefix: `${path}.`, parentPath: path });
  }

  /** `const/let/var` declarators (one symbol each; the statement's range is split between them). */
  private declarators(outer: Node, declaration: Node, scope: Scope): void {
    const list = declaration.namedChildren.filter((c) => c.type === "variable_declarator");
    list.forEach((declarator, i) => {
      // `const x = require("./x")` binds an import; it is not a definition of x.
      if (isRequireCall(declarator.childForFieldName("value"))) return;
      const first = i === 0 ? outer : declarator;
      const last = i === list.length - 1 ? outer : declarator;
      const nameNode = declarator.childForFieldName("name");
      if (!nameNode) return;
      if (nameNode.type !== "identifier") {
        for (const name of patternNames(nameNode))
          this.emit(scope.prefix + name, "variable", first, last, scope.parentPath);
        return;
      }
      const path = scope.prefix + nameNode.text;
      const value = unwrapValue(declarator.childForFieldName("value"));
      const fn = functionValue(value);
      if (fn) {
        this.ownDeclarators.set(
          declarator.id,
          this.emit(path, "function", first, last, scope.parentPath),
        );
        this.functionLike(fn, path);
      } else if (value?.type === "class") {
        this.ownDeclarators.set(
          declarator.id,
          this.emit(path, "class", first, last, scope.parentPath),
        );
        const body = value.childForFieldName("body");
        if (body) this.classBody(body, path);
      } else {
        this.ownDeclarators.set(
          declarator.id,
          this.emit(path, "variable", first, last, scope.parentPath),
        );
        if (value?.type === "object") this.objectMembers(value, path);
      }
    });
  }

  /** Methods and function-valued properties of an object literal that initialises a top-level const. */
  private objectMembers(object: Node, path: string): void {
    for (const member of object.namedChildren) {
      if (member.type === "method_definition") {
        const name = memberName(member.childForFieldName("name"));
        if (name === undefined) continue;
        const memberPath = `${path}.${name}`;
        this.emit(memberPath, "method", member, member, path);
        this.functionLike(member, memberPath);
      } else if (member.type === "pair") {
        const name = memberName(member.childForFieldName("key"));
        const fn = functionValue(member.childForFieldName("value"));
        if (name === undefined || !fn) continue;
        const memberPath = `${path}.${name}`;
        this.emit(memberPath, "method", member, member, path);
        this.functionLike(fn, memberPath);
      }
    }
  }

  /** `export default <expression>` of something that is not a named declaration. */
  private defaultValue(outer: Node, value: Node, scope: Scope): void {
    const v = unwrapValue(value);
    if (!v || v.type === "identifier") return; // `export default foo`: an alias, see exportStatement
    const path = `${scope.prefix}default`;
    if (isFunctionValue(v)) {
      this.emit(path, "function", outer, outer, scope.parentPath);
      this.functionLike(v, path);
    } else if (v.type === "class") {
      this.emit(path, "class", outer, outer, scope.parentPath);
      const body = v.childForFieldName("body");
      if (body) this.classBody(body, path);
    } else {
      this.emit(path, "variable", outer, outer, scope.parentPath);
      if (v.type === "object") this.objectMembers(v, path);
    }
  }

  /** Return-type fact of a function-like node and its nested function declarations. */
  private functionLike(fn: Node, path: string): void {
    this.functionNodes.add(fn.id);
    const returnType = fn.childForFieldName("return_type");
    let declared = returnType ? this.declaredType(returnType, true) : undefined;
    if (declared === "void" || declared === "undefined" || declared === null) declared = undefined;
    const body = fn.childForFieldName("body");
    // Without a declared return type a function returns what its body shows: `() => new Widget()`,
    // `getPool() { return this.pool; }`.
    let inferred: Inferred | undefined;
    if (!returnType && body) {
      inferred = body.type === "statement_block" ? inferReturn(fn, body) : inferFromInit(body);
    }
    const fact = makeFact(
      { scopePath: path, name: lastSegment(path), kind: "return" },
      declared,
      inferred,
    );
    if (fact) this.typeFacts.push(fact);
    if (body?.type === "statement_block") {
      for (const stmt of body.namedChildren) {
        if (stmt.type !== "function_declaration" && stmt.type !== "generator_function_declaration")
          continue;
        const name = stmt.childForFieldName("name");
        if (!name) continue;
        const nested = `${path}.${name.text}`;
        this.emit(nested, "function", stmt, stmt, path);
        this.functionLike(stmt, nested);
      }
    }
  }

  /**
   * `typeNameOf` for a declaration's annotation. `null`: the annotation names a type parameter in scope
   * (`x: T`), which says nothing about x and must not be replaced by a guess from the initialiser.
   */
  private declaredType(
    type: Node | null | undefined,
    unwrapPromise: boolean,
  ): string | null | undefined {
    const name = typeNameOf(type, unwrapPromise);
    return name !== undefined && type && isTypeParameterRef(type, name.split(".")[0]) ? null : name;
  }

  private declaredFieldFact(
    classPath: string,
    name: string,
    type: Node | null,
    init: Node | null,
  ): void {
    const declared = this.declaredType(type, false);
    if (declared === null) return;
    const fact = makeFact(
      { scopePath: classPath, name, kind: "field" },
      declared,
      declared ? undefined : inferFromInit(init),
    );
    if (!fact) return;
    this.typeFacts.push(fact);
    this.fieldFacts.add(`${classPath}\0${name}`);
  }

  // ── imports and exports (statement level) ──────────────────────────────────────────────────────

  private importStatement(stmt: Node): void {
    const require = stmt.namedChildren.find((c) => c.type === "import_require_clause");
    if (require) {
      const id = require.namedChild(0);
      const source = require.childForFieldName("source");
      if (id && source)
        this.imports.push({
          localName: id.text,
          module: stringContent(source),
          site: nodeSpan(require, this.lines),
        });
      return;
    }
    const source = stmt.childForFieldName("source");
    if (!source) return;
    const module = stringContent(source);
    const clause = stmt.namedChildren.find((c) => c.type === "import_clause");
    if (!clause) {
      this.sites.push({
        kind: "import",
        name: module,
        qualifier: [],
        site: nodeSpan(stmt, this.lines),
      });
      return;
    }
    for (const part of clause.namedChildren) {
      if (part.type === "identifier") {
        this.imports.push({
          localName: part.text,
          module,
          importedName: "default",
          site: nodeSpan(part, this.lines),
        });
      } else if (part.type === "namespace_import") {
        const id = part.namedChild(0);
        if (id) this.imports.push({ localName: id.text, module, site: nodeSpan(part, this.lines) });
      } else if (part.type === "named_imports") {
        for (const spec of part.namedChildren) {
          if (spec.type !== "import_specifier") continue;
          const name = spec.childForFieldName("name");
          const alias = spec.childForFieldName("alias");
          if (!name) continue;
          this.imports.push({
            localName: (alias ?? name).text,
            module,
            importedName: name.text,
            site: nodeSpan(spec, this.lines),
          });
        }
      }
    }
  }

  private exportStatement(stmt: Node, unwrapped: Unwrapped): void {
    const source = stmt.childForFieldName("source");
    const clause = stmt.namedChildren.find((c) => c.type === "export_clause");
    if (source) {
      const module = stringContent(source);
      const namespaceExport = stmt.namedChildren.find((c) => c.type === "namespace_export");
      if (clause) {
        for (const spec of clause.namedChildren) {
          if (spec.type !== "export_specifier") continue;
          const name = spec.childForFieldName("name");
          const alias = spec.childForFieldName("alias");
          if (!name) continue;
          this.exports.push({
            name: (alias ?? name).text,
            module,
            importedName: name.text,
            site: nodeSpan(spec, this.lines),
          });
        }
      } else if (namespaceExport) {
        const id = namespaceExport.namedChild(0);
        if (id) this.exports.push({ name: id.text, module, site: nodeSpan(stmt, this.lines) });
      } else {
        this.exports.push({ name: "*", module, site: nodeSpan(stmt, this.lines) });
      }
      return;
    }
    if (clause) {
      for (const spec of clause.namedChildren) {
        if (spec.type !== "export_specifier") continue;
        const name = spec.childForFieldName("name");
        const alias = spec.childForFieldName("alias");
        if (name && alias && alias.text !== name.text)
          this.exports.push({ name: alias.text, localName: name.text });
      }
      return;
    }
    if (unwrapped.isDefault && unwrapped.node) {
      const node = unwrapped.node;
      const named = node.childForFieldName("name");
      if (named && node.type !== "class")
        this.exports.push({ name: "default", localName: named.text });
      else if (node.type === "identifier")
        this.exports.push({ name: "default", localName: node.text });
    }
  }

  // ── the flat scan: sites, bindings from require(), parameter and local facts ───────────────────

  private scan(root: Node): void {
    const assignments: Node[] = [];
    for (const n of root.descendantsOfType(SCAN_TYPES)) {
      switch (n.type) {
        case "variable_declarator":
          this.onDeclarator(n);
          break;
        case "call_expression":
          this.onCall(n);
          break;
        case "new_expression":
          this.onNew(n);
          break;
        case "assignment_expression":
          this.onAssignment(n);
          assignments.push(n);
          break;
        case "augmented_assignment_expression":
          this.onAssignment(n);
          break;
        case "update_expression":
          this.onUpdate(n);
          break;
        case "extends_clause":
          for (const value of n.childrenForFieldName("value")) this.heritage("extends", value);
          break;
        case "implements_clause":
          for (const type of n.namedChildren)
            if (type.type !== "comment") this.heritage("implements", type);
          break;
        case "extends_type_clause":
          for (const type of n.childrenForFieldName("type")) this.heritage("extends", type);
          break;
        case "type_identifier":
        case "nested_type_identifier":
          this.onTypeRef(n);
          break;
        case "jsx_opening_element":
        case "jsx_self_closing_element":
          this.onJsx(n);
          break;
        case "required_parameter":
        case "optional_parameter":
          this.onParameter(n);
          break;
        default:
          break;
      }
    }
    for (const assignment of assignments) this.onConstructorAssignment(assignment);
  }

  private pushSite(kind: SiteDraft["kind"], parts: NameParts, site: Span): void {
    this.sites.push({ kind, name: parts.name, qualifier: parts.qualifier, site });
  }

  private onCall(n: Node): void {
    if (this.handled.has(n.id)) return;
    const fn = n.childForFieldName("function");
    if (!fn) return;
    if (fn.type === "import" || (fn.type === "identifier" && fn.text === "require")) {
      const arg = n.childForFieldName("arguments")?.namedChild(0);
      if (arg?.type === "string" && n.childForFieldName("arguments")?.namedChildCount === 1) {
        this.sites.push({
          kind: "import",
          name: stringContent(arg),
          qualifier: [],
          site: nodeSpan(n, this.lines),
        });
      }
      return;
    }
    const parts = calleeParts(fn);
    if (parts) this.pushSite("call", parts, callSpan(n, fn, this.lines));
  }

  private onNew(n: Node): void {
    const ctor = n.childForFieldName("constructor");
    const parts = calleeParts(ctor);
    if (parts && ctor) this.pushSite("call", parts, callSpan(n, ctor, this.lines));
  }

  private onAssignment(n: Node): void {
    const left = n.childForFieldName("left");
    const parts = calleeParts(left);
    if (parts && left) this.pushSite("write", parts, writeSpan(n, left, this.lines));
  }

  private onUpdate(n: Node): void {
    const argument = n.childForFieldName("argument");
    const parts = calleeParts(argument);
    if (parts && argument) this.pushSite("write", parts, writeSpan(n, argument, this.lines));
  }

  private heritage(kind: "extends" | "implements", node: Node): void {
    const parts = typeRefParts(node);
    if (parts) this.pushSite(kind, parts, nodeSpan(parts.siteNode, this.lines));
  }

  private onTypeRef(n: Node): void {
    if (n.type === "type_identifier") {
      if (n.parent?.type === "nested_type_identifier") return; // reported as the qualified name
      if (isDeclarationName(n) || isTypeParameterRef(n)) return;
    }
    if (heritageKind(n)) return;
    const parts = typeRefParts(n);
    if (parts) this.pushSite("type-ref", parts, nodeSpan(n, this.lines));
  }

  private onJsx(n: Node): void {
    const parts = jsxComponent(n);
    if (!parts) return;
    const whole = nodeSpan(n, this.lines);
    const name = n.childForFieldName("name");
    this.pushSite(
      "call",
      parts,
      spanLineCount(whole) <= SITE_MAX_LINES || !name ? whole : nodeSpan(name, this.lines),
    );
  }

  /** The symbol path a declaration at `node` belongs to (module scope: ""). */
  private scopeOf(node: Node, ownDeclarator?: Node): { path: string; draft?: SymbolDraft } {
    const start = node.startPosition;
    let draft = this.draftIndex.innermost(start.row + 1, start.column + 1);
    if (draft && ownDeclarator && this.ownDeclarators.get(ownDeclarator.id) === draft) {
      // The declarator's own symbol contains it; the variable itself lives in the enclosing scope.
      draft = draft.parentPath !== undefined ? this.draftByPath.get(draft.parentPath) : undefined;
      return { path: draft?.path ?? "", draft };
    }
    return { path: draft?.path ?? "", draft };
  }

  /** Where a variable declared by `declarator` is in scope, or undefined at module level. */
  private declaredScopeSpan(declarator: Node): Span | undefined {
    const kind = declarator.parent?.type === "variable_declaration" ? "var" : "block";
    for (let ancestor = declarator.parent; ancestor; ancestor = ancestor.parent) {
      if (ancestor.type === "program") return undefined;
      if (kind === "var" ? FUNCTION_SCOPES.has(ancestor.type) : BLOCK_SCOPES.has(ancestor.type)) {
        return nodeSpan(ancestor, this.lines);
      }
    }
    return undefined;
  }

  private onDeclarator(d: Node): void {
    const nameNode = d.childForFieldName("name");
    const valueNode = d.childForFieldName("value");
    // `const x = require("./y")` / `const { a, b: c } = require("./y")`
    const call = unwrapValue(valueNode);
    if (call?.type === "call_expression") {
      const arg = call.childForFieldName("arguments")?.namedChild(0);
      if (isRequireCall(call) && arg && nameNode) {
        const module = stringContent(arg);
        this.handled.add(call.id);
        if (nameNode.type === "identifier") {
          this.imports.push({ localName: nameNode.text, module, site: nodeSpan(d, this.lines) });
        } else if (nameNode.type === "object_pattern") {
          for (const part of nameNode.namedChildren) {
            if (part.type === "shorthand_property_identifier_pattern") {
              this.imports.push({
                localName: part.text,
                module,
                importedName: part.text,
                site: nodeSpan(part, this.lines),
              });
            } else if (part.type === "pair_pattern") {
              const key = part.childForFieldName("key");
              const value = part.childForFieldName("value");
              if (key && value?.type === "identifier") {
                this.imports.push({
                  localName: value.text,
                  module,
                  importedName: key.text,
                  site: nodeSpan(part, this.lines),
                });
              }
            }
          }
        }
        return;
      }
    }
    if (nameNode?.type !== "identifier") return;
    const value = unwrapValue(valueNode);
    if (isFunctionValue(value) || value?.type === "class") return; // it is a function/class symbol
    const declared = this.declaredType(d.childForFieldName("type"), false);
    if (declared === null) return;
    const fact = makeFact(
      { scopePath: this.scopeOf(d, d).path, name: nameNode.text, kind: "local" },
      declared,
      declared ? undefined : inferFromInit(valueNode),
    );
    if (!fact) return;
    const visibleIn = this.declaredScopeSpan(d);
    if (visibleIn) fact.visibleIn = visibleIn;
    this.typeFacts.push(fact);
  }

  private onParameter(n: Node): void {
    const pattern = n.childForFieldName("pattern");
    if (!pattern || pattern.type !== "identifier") return;
    const owner = n.parent?.parent;
    if (!owner || !PARAMETER_OWNERS.has(owner.type)) return;
    // Parameters of overload signatures (which are not symbols) belong to nobody.
    if (DECLARED_OWNERS.has(owner.type) && !this.functionNodes.has(owner.id)) return;
    const declared = this.declaredType(n.childForFieldName("type"), false);
    if (declared === null) return;
    const scope = this.scopeOf(n);
    const fact = makeFact(
      { scopePath: scope.path, name: pattern.text, kind: "param" },
      declared,
      declared ? undefined : inferFromInit(n.childForFieldName("value")),
    );
    if (!fact) return;
    fact.visibleIn = nodeSpan(owner, this.lines);
    this.typeFacts.push(fact);
    this.paramFacts.set(`${scope.path}\0${pattern.text}`, fact);
    // Parameter properties (`constructor(private pool: WorkerPool)`) are fields of the class as well.
    const isProperty = n.children.some(
      (c) =>
        c.type === "accessibility_modifier" ||
        c.type === "override_modifier" ||
        c.type === "readonly",
    );
    const classPath = scope.draft?.parentPath;
    if (isProperty && classPath !== undefined && lastSegment(scope.path) === "constructor") {
      const { typeName, initCall, initChain } = fact;
      const field: TypeFact = { scopePath: classPath, name: pattern.text, kind: "field" };
      if (typeName !== undefined) field.typeName = typeName;
      if (initCall) field.initCall = initCall;
      if (initChain) field.initChain = initChain;
      this.typeFacts.push(field);
      this.fieldFacts.add(`${classPath}\0${pattern.text}`);
    }
  }

  /** `this.f = new X()` / `this.f = typedParam` inside a constructor: a field type when none is declared. */
  private onConstructorAssignment(n: Node): void {
    const left = n.childForFieldName("left");
    if (left?.type !== "member_expression" || left.childForFieldName("object")?.type !== "this")
      return;
    const property = left.childForFieldName("property");
    if (!property) return;
    const scope = this.scopeOf(n);
    const classPath = scope.draft?.parentPath;
    if (classPath === undefined || lastSegment(scope.path) !== "constructor") return;
    const key = `${classPath}\0${property.text}`;
    if (this.fieldFacts.has(key)) return;
    const right = n.childForFieldName("right");
    // `this.f = param`: the field has the parameter's type (the parameter is not visible from the class).
    const param =
      right?.type === "identifier"
        ? this.paramFacts.get(`${scope.path}\0${right.text}`)
        : undefined;
    const inferred: Inferred | undefined = param
      ? { typeName: param.typeName, initCall: param.initCall, initChain: param.initChain }
      : inferFromInit(right);
    const fact = makeFact(
      { scopePath: classPath, name: property.text, kind: "field" },
      undefined,
      inferred,
    );
    if (!fact) return;
    this.typeFacts.push(fact);
    this.fieldFacts.add(key);
  }
}

// ─── classifySite ─────────────────────────────────────────────────────────────────────────────────

/** The node whose span is the site of the import binding that `id` is part of (undefined: not an import). */
function importSiteNode(id: Node): Node | undefined {
  let node: Node | null = id;
  for (let i = 0; node && i < 4; i++, node = node.parent) {
    switch (node.type) {
      case "import_specifier":
      case "namespace_import":
      case "import_require_clause":
        return node;
      case "import_clause":
        return id.parent?.id === node.id ? id : undefined; // the default binding
      case "export_specifier": {
        const statement = node.parent?.parent;
        return statement?.type === "export_statement" && statement.childForFieldName("source")
          ? node
          : undefined;
      }
      case "import_statement":
      case "export_statement":
      case "program":
        return undefined;
      default:
        break;
    }
  }
  return undefined;
}

function classifyIdentifier(id: Node, lines: readonly string[]): ClassifiedSite | undefined {
  const parent = id.parent;
  if (!parent) return undefined;

  // Imports (including `export { x } from "..."`).
  const importNode = importSiteNode(id);
  if (importNode) return { kind: "import", site: nodeSpan(importNode, lines) };

  // Calls: `f()`, `a.b.f()`, `new X()`, `new ns.X()`.
  let callee: Node | undefined;
  if (parent.type === "member_expression" && parent.childForFieldName("property")?.id === id.id)
    callee = parent;
  else if (id.type === "identifier" || id.type === "super") callee = id;
  if (callee) {
    const holder = callee.parent;
    if (
      holder?.type === "call_expression" &&
      holder.childForFieldName("function")?.id === callee.id
    ) {
      return { kind: "call", site: callSpan(holder, callee, lines) };
    }
    if (
      holder?.type === "new_expression" &&
      holder.childForFieldName("constructor")?.id === callee.id
    ) {
      return { kind: "call", site: callSpan(holder, callee, lines) };
    }
    // JSX components: <Foo />, <ns.Foo>
    if (
      holder &&
      (holder.type === "jsx_opening_element" || holder.type === "jsx_self_closing_element") &&
      holder.childForFieldName("name")?.id === callee.id &&
      jsxComponent(holder)
    ) {
      const whole = nodeSpan(holder, lines);
      return {
        kind: "call",
        site: spanLineCount(whole) <= SITE_MAX_LINES ? whole : nodeSpan(callee, lines),
      };
    }
  }

  // Heritage: `extends X`, `extends ns.X`, `implements X`, `interface I extends X`.
  {
    let top: Node = id;
    if (parent.type === "member_expression" && parent.childForFieldName("property")?.id === id.id)
      top = parent;
    const holder = top.parent;
    if (
      holder?.type === "extends_clause" &&
      holder.childrenForFieldName("value").some((v) => v.id === top.id)
    ) {
      return { kind: "extends", site: nodeSpan(top, lines) };
    }
  }
  if (id.type === "type_identifier") {
    const heritage = heritageKind(id);
    if (heritage) {
      let top: Node = id;
      while (
        top.parent &&
        (top.parent.type === "nested_type_identifier" || top.parent.type === "generic_type")
      ) {
        if (
          top.parent.type === "generic_type" &&
          top.parent.childForFieldName("name")?.id !== top.id
        )
          break;
        top = top.parent;
      }
      const parts = typeRefParts(top);
      return { kind: heritage, site: nodeSpan(parts?.siteNode ?? id, lines) };
    }
    if (
      isDeclarationName(id) ||
      (parent.type !== "nested_type_identifier" && isTypeParameterRef(id))
    )
      return undefined;
    const siteNode = parent.type === "nested_type_identifier" ? parent : id;
    return { kind: "type-ref", site: nodeSpan(siteNode, lines) };
  }

  // Writes: `x = …`, `this.x = …`, `x += …`, `x++`.
  {
    const target =
      parent.type === "member_expression" && parent.childForFieldName("property")?.id === id.id
        ? parent
        : id;
    const holder = target.parent;
    if (
      holder &&
      (holder.type === "assignment_expression" ||
        holder.type === "augmented_assignment_expression") &&
      holder.childForFieldName("left")?.id === target.id
    ) {
      return { kind: "write", site: writeSpan(holder, target, lines) };
    }
    if (
      holder?.type === "update_expression" &&
      holder.childForFieldName("argument")?.id === target.id
    ) {
      return { kind: "write", site: writeSpan(holder, target, lines) };
    }
  }
  return undefined;
}

// ─── Module resolution ────────────────────────────────────────────────────────────────────────────

function resolveTypescriptModule(spec: string, fromFile: string, repo: RepoView): string[] {
  // `node:fs`, `https://...`: never repository files.
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) return [];
  // Anything but a relative specifier is external, unless the repository defines it itself
  // (tsconfig `paths`/`baseUrl`, workspace packages, package.json `imports`).
  if (!(spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../"))) {
    return resolveBareSpecifier(spec, fromFile, repo);
  }
  const clean = spec.replace(/[?#].*$/, "");
  const joined = repoPath(posix.join(posix.dirname(fromFile), clean));
  if (joined === undefined) return []; // leaves the repository
  const directoryOnly =
    clean === "." || clean === ".." || clean.endsWith("/") || /(^|\/)\.\.?$/.test(clean);
  return probeModule(joined, repo, directoryOnly);
}

// ─── The pack ─────────────────────────────────────────────────────────────────────────────────────

export const typescriptPack: LanguagePack = {
  id: "typescript",
  languages: ["typescript", "tsx", "javascript"],
  grammarFor(language: FileLanguage): GrammarId {
    return language === "typescript" ? "typescript" : "tsx";
  },
  packageScope: "file",
  refs: "heuristic",

  extract(ctx: FileContext): FileFacts {
    return new Extractor(ctx).run();
  },

  classifySite(ctx: FileContext, line: number, col: number): ClassifiedSite | undefined {
    const node = ctx.tree.rootNode.descendantForPosition(
      { row: line - 1, column: col - 1 },
      { row: line - 1, column: col },
    );
    if (!node || !IDENTIFIER_TYPES.has(node.type)) return undefined;
    return classifyIdentifier(node, ctx.lines);
  },

  resolveModule: resolveTypescriptModule,
};
