/**
 * Syntax helpers of the Go pack that `extract` and `classifySite` share, so both apply exactly the same
 * rules: what a call / composite literal / type name / assignment site is, and which span it covers.
 *
 * A "shape" is the syntactic description of one site. It is built from the node that owns the site (a
 * `call_expression`, an assignment statement, a type name) and knows its `core` node, the identifier or
 * selector expression the site is about. `classifySite` walks from an identifier to its owner and accepts
 * the shape only when the shape's `core` is the very node it started from.
 */
import type { Node } from "web-tree-sitter";
import { nodeSpan, spanLineCount } from "../../ast.js";
import type { SiteKind, Span } from "../types.js";

/** A call / assignment / composite literal spanning more lines than this is reported by its callee/target only. */
export const SITE_MAX_LINES = 10;

/** The syntactic description of one reference site. */
export interface SiteShape {
  kind: SiteKind;
  /** Last segment: the called function, the type, the assigned field. */
  name: string;
  /** The node whose text is `name` (what an occurrence of the site points at). */
  nameNode: Node;
  /** The identifier / selector expression / type node the site is about; identifies the site. */
  core: Node;
  /** Receiver expression of a member access (`r.field` in `r.field.M()`); the extractor spells it. */
  operand?: Node;
  /** Package qualifier of a qualified type name (already spelled). */
  qualifier?: string[];
  site: Span;
}

// ─── Small node helpers ───────────────────────────────────────────────────────────────────────────

/** Comments are extras in tree-sitter-go and can sit between any two tokens. */
export function namedChildren(node: Node): Node[] {
  return node.namedChildren.filter((c) => c.type !== "comment");
}

export function firstNamed(node: Node): Node | undefined {
  for (const child of node.namedChildren) if (child.type !== "comment") return child;
  return undefined;
}

/**
 * The nodes in field `field` of `node`, without separators: a field can cover the commas between its
 * elements (`const a, b = 1, 2` has the field `name` on `a`, `,` and `b`).
 */
export function fieldNodes(node: Node, field: string): Node[] {
  return node.childrenForFieldName(field).filter((c) => c.isNamed && c.type !== "comment");
}

/** The `type_spec` / `type_alias` children of a `type_declaration`. */
export function typeSpecs(declaration: Node): Node[] {
  return declaration.namedChildren.filter((c) => c.type === "type_spec" || c.type === "type_alias");
}

/** Text of a string literal node without its quotes (`"a/b"` and `` `a/b` ``). */
export function stringValue(literal: Node): string {
  const text = literal.text;
  return text.length >= 2 ? text.slice(1, -1) : text;
}

// ─── Types ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Base name of a type expression: pointers, parentheses and type arguments stripped, a package qualifier
 * kept (`*pkg.T[int]` -> `pkg.T`). Undefined for slices, maps, arrays, channels, functions and literals.
 */
export function typeNameOf(node: Node | null | undefined, depth = 0): string | undefined {
  if (!node || depth > 8) return undefined;
  switch (node.type) {
    case "type_identifier":
      return node.text;
    case "qualified_type": {
      const pkg = node.childForFieldName("package");
      const name = node.childForFieldName("name");
      return pkg && name ? `${pkg.text}.${name.text}` : undefined;
    }
    case "pointer_type":
    case "parenthesized_type": {
      const inner = firstNamed(node);
      return inner ? typeNameOf(inner, depth + 1) : undefined;
    }
    case "generic_type":
      return typeNameOf(node.childForFieldName("type"), depth + 1);
    default:
      return undefined;
  }
}

/** The names a type parameter list declares (`[K comparable, V any]` -> K, V). */
function declaredTypeParams(list: Node | null): string[] {
  const out: string[] = [];
  if (!list) return out;
  for (const declaration of list.namedChildren) {
    if (declaration.type !== "type_parameter_declaration") continue;
    for (const name of fieldNodes(declaration, "name")) out.push(name.text);
  }
  return out;
}

/** Type parameters a declaration node brings into scope (function/type parameters, a generic receiver's). */
function typeParamsOf(owner: Node): string[] {
  if (owner.type !== "method_declaration")
    return declaredTypeParams(owner.childForFieldName("type_parameters"));
  // `func (q *Queue[T]) Pop()`: T is declared by the receiver.
  const out: string[] = [];
  const receiver = owner.childForFieldName("receiver");
  let type = receiver ? firstNamed(receiver)?.childForFieldName("type") : undefined;
  if (type?.type === "pointer_type") type = firstNamed(type);
  if (type?.type !== "generic_type") return out;
  const args = type.childForFieldName("type_arguments");
  if (!args) return out;
  for (const elem of args.namedChildren) {
    const inner = elem.type === "type_elem" ? firstNamed(elem) : elem;
    if (inner?.type === "type_identifier") out.push(inner.text);
  }
  return out;
}

/** Per-file state for `isTypeParam`: whether the file has any generics at all, and the parameters of each declaration. */
export interface TypeParamScopes {
  enabled: boolean;
  names: Map<number, string[]>;
}

/**
 * Is `name` a type parameter in scope at `node` (`T` inside `func Map[T any]`, `type Box[T any] struct`,
 * `func (q *Queue[T]) Push`)? Such a name refers to no declaration in the repository.
 */
export function isTypeParam(node: Node, name: string, scopes?: TypeParamScopes): boolean {
  if (scopes && !scopes.enabled) return false;
  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
    switch (ancestor.type) {
      case "function_declaration":
      case "method_declaration":
      case "type_spec":
      case "type_alias": {
        let names = scopes?.names.get(ancestor.id);
        if (!names) {
          names = typeParamsOf(ancestor);
          scopes?.names.set(ancestor.id, names);
        }
        if (names.includes(name)) return true;
        break;
      }
      default:
        break;
    }
  }
  return false;
}

/** The receiver variable of a method (`q` in `func (q *Queue) Pop()`); undefined when unnamed or `_`. */
export function receiverNameOf(method: Node): string | undefined {
  const receiver = method.childForFieldName("receiver");
  const declaration = receiver ? firstNamed(receiver) : undefined;
  const name = declaration?.childForFieldName("name");
  return name && name.text !== "_" ? name.text : undefined;
}

/** The base type name of a method's receiver (`Queue` for `*Queue`, `Queue[T]`, `(Queue)`). */
export function receiverBaseName(method: Node): string | undefined {
  const receiver = method.childForFieldName("receiver");
  const declaration = receiver ? firstNamed(receiver) : undefined;
  const name = typeNameOf(declaration?.childForFieldName("type"));
  return name && !name.includes(".") ? name : undefined;
}

// ─── Qualifier chains ─────────────────────────────────────────────────────────────────────────────

/**
 * Qualifier segments of a receiver expression (see types.ts): `r.queue.Pop()` -> ["this", "queue"] inside a
 * method whose receiver variable is `r`. Undefined when the expression cannot be spelled (`arr[0].Run()`).
 */
export function chainOf(
  node: Node | null | undefined,
  receiver: string | undefined,
  depth = 0,
): string[] | undefined {
  if (!node || depth > 16) return undefined;
  switch (node.type) {
    case "identifier":
      if (node.text === "") return undefined; // a MISSING identifier of a syntax error
      return [receiver !== undefined && node.text === receiver ? "this" : node.text];
    case "parenthesized_expression": {
      const inner = firstNamed(node);
      return inner ? chainOf(inner, receiver, depth + 1) : undefined;
    }
    case "unary_expression": {
      // `(*p).m()` and `(&x).m()`: dereferencing does not change which members are reachable.
      const operator = node.childForFieldName("operator")?.text;
      return operator === "*" || operator === "&"
        ? chainOf(node.childForFieldName("operand"), receiver, depth + 1)
        : undefined;
    }
    case "selector_expression": {
      const object = chainOf(node.childForFieldName("operand"), receiver, depth + 1);
      const field = node.childForFieldName("field");
      return object && field ? [...object, field.text] : undefined;
    }
    case "call_expression": {
      const parts = callParts(node);
      if (!parts) return undefined;
      const qualifier = parts.operand ? chainOf(parts.operand, receiver, depth + 1) : [];
      return qualifier ? [...qualifier, `${parts.name}()`] : undefined;
    }
    case "composite_literal": {
      // `Foo{}.M()` / `pkg.Foo{}.M()`: an instance of Foo.
      const type = node.childForFieldName("type");
      const named = type?.type === "generic_type" ? type.childForFieldName("type") : type;
      if (named?.type === "type_identifier") return [`${named.text}()`];
      if (named?.type === "qualified_type") {
        const pkg = named.childForFieldName("package");
        const name = named.childForFieldName("name");
        return pkg && name ? [pkg.text, `${name.text}()`] : undefined;
      }
      return undefined;
    }
    case "type_assertion_expression": {
      // `x.(Foo).M()`: ":Foo" = a value of declared type Foo.
      const name = typeNameOf(node.childForFieldName("type"));
      return name ? [`:${name}`] : undefined;
    }
    default:
      return undefined;
  }
}

// ─── Sites owned by expressions ───────────────────────────────────────────────────────────────────

/**
 * The identifier or selector expression an expression boils down to, peeling parentheses and index
 * expressions (generic instantiation `f[int](x)`, element writes `m[k] = v`). For a callee, `(*T)(x)` is a
 * conversion: the `*T` is peeled too and reported as `conversion`.
 */
function peel(
  node: Node | null | undefined,
  forCallee: boolean,
): { core: Node; conversion: boolean } | undefined {
  let n = node ?? undefined;
  let parens = 0;
  let conversion = false;
  for (let i = 0; n && i < 12; i++) {
    if (n.type === "parenthesized_expression") {
      n = firstNamed(n);
      parens++;
    } else if (n.type === "index_expression") {
      n = n.childForFieldName("operand") ?? undefined;
    } else if (
      forCallee &&
      parens > 0 &&
      !conversion &&
      n.type === "unary_expression" &&
      n.childForFieldName("operator")?.text === "*"
    ) {
      n = n.childForFieldName("operand") ?? undefined;
      conversion = true;
    } else {
      break;
    }
  }
  return n && (n.type === "identifier" || n.type === "selector_expression")
    ? { core: n, conversion }
    : undefined;
}

/** `name`, its node and (for a selector) the receiver expression of an identifier / selector core. */
function nameOfCore(core: Node): { name: string; nameNode: Node; operand?: Node } | undefined {
  if (core.type === "identifier") return { name: core.text, nameNode: core };
  const nameNode = core.childForFieldName("field");
  const operand = core.childForFieldName("operand");
  return nameNode && operand ? { name: nameNode.text, nameNode, operand } : undefined;
}

/** Whole call expression, or only the callee (then its last name) when the call spans more than 10 lines. */
function callSpan(call: Node, core: Node, nameNode: Node, lines: readonly string[]): Span {
  const whole = nodeSpan(call, lines);
  if (spanLineCount(whole) <= SITE_MAX_LINES) return whole;
  const callee = nodeSpan(core, lines);
  return spanLineCount(callee) <= SITE_MAX_LINES ? callee : nodeSpan(nameNode, lines);
}

/** Whole assignment/update statement, or only the target when it spans more than 10 lines. */
function writeSpan(statement: Node, target: Node, lines: readonly string[]): Span {
  const whole = nodeSpan(statement, lines);
  return spanLineCount(whole) <= SITE_MAX_LINES ? whole : nodeSpan(target, lines);
}

/** Whole composite literal / conversion, or only its type when it spans more than 10 lines. */
function literalSpan(literal: Node, type: Node, lines: readonly string[]): Span {
  const whole = nodeSpan(literal, lines);
  return spanLineCount(whole) <= SITE_MAX_LINES ? whole : nodeSpan(type, lines);
}

/** What a `call_expression` calls: the callee's name, its node and receiver expression (no spans yet). */
export interface CallParts {
  /** The identifier / selector expression the callee boils down to. */
  core: Node;
  name: string;
  nameNode: Node;
  /** Receiver expression of `recv.Name(...)`. */
  operand?: Node;
  /** `(*T)(x)`: a type conversion, not a call. */
  conversion: boolean;
}

/** The callee of a call (`f`, `pkg.F`, `x.M`, `f[T]`, `(*T)`); undefined for function literals and other computed callees. */
export function callParts(call: Node): CallParts | undefined {
  const peeled = peel(call.childForFieldName("function"), true);
  if (!peeled) return undefined;
  const parts = nameOfCore(peeled.core);
  if (!parts) return undefined;
  const out: CallParts = {
    core: peeled.core,
    name: parts.name,
    nameNode: parts.nameNode,
    conversion: peeled.conversion,
  };
  if (parts.operand) out.operand = parts.operand;
  return out;
}

/**
 * The site a `call_expression` makes: a `call` of `f`, `pkg.F`, `x.M`, `f[T]`, or - for the conversion
 * `(*T)(x)` - a `type-ref` to T. Undefined for calls of function literals and other computed callees.
 */
export function callShape(call: Node, lines: readonly string[]): SiteShape | undefined {
  const parts = callParts(call);
  if (!parts) return undefined;
  const shape: SiteShape = {
    kind: parts.conversion ? "type-ref" : "call",
    name: parts.name,
    nameNode: parts.nameNode,
    core: parts.core,
    site: parts.conversion
      ? nodeSpan(parts.core, lines)
      : callSpan(call, parts.core, parts.nameNode, lines),
  };
  if (parts.operand) shape.operand = parts.operand;
  return shape;
}

/** The `write` sites of an assignment (`a.x, b = 1, 2`), `x++` or `x--` statement, one per target. */
export function writeShapes(statement: Node, lines: readonly string[]): SiteShape[] {
  let targets: Node[];
  if (statement.type === "assignment_statement") {
    const left = statement.childForFieldName("left");
    targets = left ? namedChildren(left) : [];
  } else {
    const operand = firstNamed(statement);
    targets = operand ? [operand] : [];
  }
  const out: SiteShape[] = [];
  for (const target of targets) {
    const peeled = peel(target, false);
    const parts = peeled ? nameOfCore(peeled.core) : undefined;
    if (!peeled || !parts) continue;
    if (parts.name === "_" && peeled.core.type === "identifier") continue; // `_ = x` assigns nothing
    // The swap idiom `x[i], x[j] = x[j], x[i]` writes to x twice: one site is enough.
    if (out.some((other) => other.core.text === peeled.core.text)) continue;
    const shape: SiteShape = {
      kind: "write",
      name: parts.name,
      nameNode: parts.nameNode,
      core: peeled.core,
      site: writeSpan(statement, target, lines),
    };
    if (parts.operand) shape.operand = parts.operand;
    out.push(shape);
  }
  return out;
}

/** Is this `top` the type of an embedded field / an embedded interface element (not a union or `~T`)? */
function isEmbeddedPosition(top: Node): boolean {
  const parent = top.parent;
  if (!parent) return false;
  if (parent.type === "field_declaration") {
    return (
      parent.childForFieldName("type")?.id === top.id && fieldNodes(parent, "name").length === 0
    );
  }
  return (
    parent.type === "type_elem" &&
    parent.parent?.type === "interface_type" &&
    namedChildren(parent).length === 1
  );
}

/**
 * The site a type name makes. `t` is a `type_identifier` or a whole `qualified_type` (never the name part of
 * one): a declaration name and a type parameter make none; a composite literal's type is a `call` (of the
 * struct, like `new T()`), and so is the type of a `f[T](x)` conversion; an embedded field / interface element
 * is `extends`; anything else is a `type-ref`.
 */
export function typeShape(
  t: Node,
  lines: readonly string[],
  scopes?: TypeParamScopes,
): SiteShape | undefined {
  let nameNode: Node | null;
  let qualifier: string[];
  if (t.type === "type_identifier") {
    nameNode = t;
    qualifier = [];
  } else if (t.type === "qualified_type") {
    nameNode = t.childForFieldName("name");
    const pkg = t.childForFieldName("package");
    if (!nameNode || !pkg) return undefined;
    qualifier = [pkg.text];
  } else {
    return undefined;
  }
  // `Box[int]`: the type name is the `type` child of a generic_type.
  let top = t;
  while (top.parent?.type === "generic_type" && top.parent.childForFieldName("type")?.id === top.id)
    top = top.parent;
  const parent = top.parent;
  if (!parent) return undefined;
  if (
    (parent.type === "type_spec" || parent.type === "type_alias") &&
    parent.childForFieldName("name")?.id === t.id
  )
    return undefined; // the declared name
  if (t.type === "type_identifier" && isTypeParam(t, t.text, scopes)) return undefined;

  const base = { name: nameNode.text, nameNode, core: t, qualifier };
  if (
    (parent.type === "composite_literal" || parent.type === "type_conversion_expression") &&
    parent.childForFieldName("type")?.id === top.id
  ) {
    // `T{...}` constructs a T. `f[int](x)` with one argument is read by tree-sitter as a conversion to the
    // instantiated type `f[int]`, but is far more often a call of the generic function f.
    return { ...base, kind: "call", site: literalSpan(parent, t, lines) };
  }
  return {
    ...base,
    kind: isEmbeddedPosition(top) ? "extends" : "type-ref",
    site: nodeSpan(t, lines),
  };
}

/** Is this bare name in a value position, rather than being declared, assigned, labelled or used as a key? */
function isValuePosition(id: Node): boolean {
  const parent = id.parent;
  if (!parent) return false;
  const is = (field: string): boolean => parent.childForFieldName(field)?.id === id.id;
  switch (parent.type) {
    case "function_declaration":
    case "parameter_declaration":
    case "variadic_parameter_declaration":
    case "type_parameter_declaration":
    case "var_spec":
    case "const_spec":
    case "inc_statement":
    case "dec_statement":
    case "labeled_statement":
      return false;
    case "call_expression":
      return !is("function");
    case "selector_expression":
      return is("operand");
    case "expression_list": {
      // `a, b := ...` and `a, b = ...` declare or assign what is on the left; `for i := range`, `case v := <-ch`
      // and `switch t := x.(type)` declare theirs.
      const holder = parent.parent;
      const side = (field: string): boolean => holder?.childForFieldName(field)?.id === parent.id;
      switch (holder?.type) {
        case "short_var_declaration":
        case "assignment_statement":
          return side("right");
        case "range_clause":
        case "receive_statement":
          return !side("left");
        case "type_switch_statement":
          return !side("alias");
        default:
          return true;
      }
    }
    case "literal_element": {
      // `T{Field: v}`: the key is a field name (or, in a map literal, an expression we cannot tell from it)
      const holder = parent.parent;
      return !(
        holder?.type === "keyed_element" && holder.childForFieldName("key")?.id === parent.id
      );
    }
    default:
      return true;
  }
}

/**
 * The `read` a leaf makes, if any: a bare name, or the field of a selector `x.f`, in a value position that is
 * not a callee (a call) or an assignment target (a write). Purely syntactic: whether the name is local, or
 * resolves to a variable, is decided elsewhere.
 */
export function readShape(leaf: Node, lines: readonly string[]): SiteShape | undefined {
  if (leaf.type !== "identifier" && leaf.type !== "field_identifier") return undefined;
  if (leaf.type === "identifier" && !isValuePosition(leaf)) return undefined;
  if (shapeOfLeaf(leaf, lines)) return undefined; // a call or a write
  if (leaf.type === "identifier") {
    if (leaf.text === "") return undefined; // a MISSING identifier of a syntax error
    return {
      kind: "read",
      name: leaf.text,
      nameNode: leaf,
      core: leaf,
      site: nodeSpan(leaf, lines),
    };
  }
  const selector = leaf.parent;
  if (
    selector?.type !== "selector_expression" ||
    selector.childForFieldName("field")?.id !== leaf.id
  )
    return undefined;
  const operand = selector.childForFieldName("operand");
  if (!operand) return undefined;
  const whole = nodeSpan(selector, lines);
  return {
    kind: "read",
    name: leaf.text,
    nameNode: leaf,
    core: selector,
    operand,
    site: spanLineCount(whole) <= SITE_MAX_LINES ? whole : nodeSpan(leaf, lines),
  };
}

/**
 * The shape of the site an identifier / field identifier / type identifier leaf belongs to, if any: the
 * inverse of the scan the extractor does (owner node -> shape), shared with `classifySite`.
 */
export function shapeOfLeaf(
  leaf: Node,
  lines: readonly string[],
  scopes?: TypeParamScopes,
): SiteShape | undefined {
  if (leaf.type === "type_identifier") {
    const t = leaf.parent?.type === "qualified_type" ? leaf.parent : leaf;
    return typeShape(t, lines, scopes);
  }
  if (leaf.type !== "identifier" && leaf.type !== "field_identifier") return undefined;
  let core: Node = leaf;
  if (leaf.type === "field_identifier") {
    const parent = leaf.parent;
    if (parent?.type !== "selector_expression" || parent.childForFieldName("field")?.id !== leaf.id)
      return undefined;
    core = parent;
  }
  // Climb the wrappers `peel` looks through.
  let top = core;
  for (let i = 0; i < 12; i++) {
    const p = top.parent;
    if (!p) break;
    if (
      p.type === "parenthesized_expression" ||
      (p.type === "index_expression" && p.childForFieldName("operand")?.id === top.id) ||
      (p.type === "unary_expression" &&
        p.childForFieldName("operator")?.text === "*" &&
        p.parent?.type === "parenthesized_expression")
    ) {
      top = p;
      continue;
    }
    break;
  }
  const holder = top.parent;
  if (!holder) return undefined;
  if (holder.type === "call_expression" && holder.childForFieldName("function")?.id === top.id) {
    const shape = callShape(holder, lines);
    return shape && shape.core.id === core.id ? shape : undefined;
  }
  let statement: Node | undefined;
  if (
    holder.type === "expression_list" &&
    holder.parent?.type === "assignment_statement" &&
    holder.parent.childForFieldName("left")?.id === holder.id
  ) {
    statement = holder.parent;
  } else if (holder.type === "inc_statement" || holder.type === "dec_statement") {
    statement = holder;
  }
  return statement ? writeShapes(statement, lines).find((s) => s.core.id === core.id) : undefined;
}
