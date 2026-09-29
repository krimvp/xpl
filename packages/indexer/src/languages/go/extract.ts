/**
 * The Go extractor: symbols, reference sites, import bindings and type facts of one file.
 *
 * Two passes over the syntax tree:
 *
 * 1. structure: the top-level declarations become symbols (functions, methods, types with their fields and
 *    interface methods, `var` / `const` specs), plus the facts that hang off them (field types, result types);
 * 2. a flat scan (`descendantsOfType`) for sites (calls, type names, assignments) and for the facts about
 *    local names (parameters, `:=`, `var`, `range`, type switches).
 *
 * Go specifics worth knowing when reading the code:
 *
 * - A symbol's range never includes doc comments (they are separate sibling nodes). A type declaration's
 *   range starts at the type NAME, not at the `type` keyword: the index stores whole lines only, and
 *   `inferRefs` (./implements.ts) takes the start of a type symbol as the site of its `implements` refs.
 * - The receiver variable of a method is emitted as the qualifier root `"this"`.
 * - Embedded struct fields and embedded interface elements are `extends` sites, not symbols (an embedded
 *   field's "name" is its type's name, and a symbol there would swallow the site the resolver needs to find
 *   the struct's bases).
 * - Local names get a type fact even when their type is unknown, with `visibleIn` set to Go's scope of the
 *   name (from the end of the declaration to the end of the enclosing block, statement or case clause;
 *   function body for parameters). That makes locals shadow imports, and bare assignments / calls of
 *   locals are dropped rather than resolved to a same-named package-level symbol.
 */
import type { Node, Point } from "web-tree-sitter";
import { SpanIndex, nodeSpan, spanBetween, spanContains } from "../../ast.js";
import type {
  ExportFact,
  FileContext,
  FileFacts,
  ImportBinding,
  SiteDraft,
  Span,
  SymbolDraft,
  TypeFact,
} from "../types.js";
import { assumedPackageNames } from "./modules.js";
import {
  callParts,
  callShape,
  chainOf,
  fieldNodes,
  firstNamed,
  isTypeParam,
  namedChildren,
  readShape,
  receiverBaseName,
  receiverNameOf,
  stringValue,
  typeNameOf,
  typeShape,
  typeSpecs,
  writeShapes,
} from "./shapes.js";
import type { SiteShape, TypeParamScopes } from "./shapes.js";
import type { GoFileData, Signature } from "./signature.js";

/** Node types the flat scan looks at (`descendantsOfType` is a single native call). */
const SCAN_TYPES = [
  "call_expression",
  "type_identifier",
  "qualified_type",
  "assignment_statement",
  "inc_statement",
  "dec_statement",
  "short_var_declaration",
  "var_spec",
  "parameter_declaration",
  "variadic_parameter_declaration",
  "range_clause",
  "type_switch_statement",
  "receive_statement",
  // the leaves a `read` can sit on (see `readShape`)
  "identifier",
  "field_identifier",
];

/** Nodes that end the scope of a name declared inside them. */
const SCOPE_OWNERS = new Set([
  "block",
  "expression_case",
  "default_case",
  "type_case",
  "communication_case",
  "if_statement",
  "for_statement",
  "expression_switch_statement",
  "type_switch_statement",
]);

/**
 * Predeclared types and the builtin functions nobody redefines. A site naming one of them refers to the
 * language, not to the repository, so it is not emitted (unless the file itself declares a symbol of that
 * name: `type any = interface{}` in old code). `min`, `max` and `clear` are left out on purpose: code from
 * before Go 1.21 defines its own, in whatever file of the package.
 */
const PREDECLARED = new Set([
  "bool",
  "byte",
  "comparable",
  "complex64",
  "complex128",
  "error",
  "float32",
  "float64",
  "int",
  "int8",
  "int16",
  "int32",
  "int64",
  "rune",
  "string",
  "uint",
  "uint8",
  "uint16",
  "uint32",
  "uint64",
  "uintptr",
  "any",
]);
const BUILTIN_FUNCTIONS = new Set([
  "append",
  "cap",
  "close",
  "complex",
  "copy",
  "delete",
  "imag",
  "len",
  "make",
  "new",
  "panic",
  "print",
  "println",
  "real",
  "recover",
]);

/** Nested anonymous struct fields are symbols down to this depth. */
const MAX_STRUCT_DEPTH = 3;

/** What an initialiser / declaration says about a name's type. */
interface Inferred {
  typeName?: string;
  initCall?: { qualifier: string[]; name: string };
  initChain?: string[];
}

function scopeOwner(declaration: Node): Node | undefined {
  for (let ancestor = declaration.parent; ancestor; ancestor = ancestor.parent) {
    if (SCOPE_OWNERS.has(ancestor.type)) return ancestor;
  }
  return undefined;
}

/** Is this declaration at package level (not inside any function)? */
function isPackageLevel(node: Node): boolean {
  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
    if (ancestor.type === "source_file") return true;
    if (
      ancestor.type === "block" ||
      ancestor.type === "func_literal" ||
      ancestor.type === "function_declaration" ||
      ancestor.type === "method_declaration"
    )
      return false;
  }
  return true;
}

class Extractor {
  private readonly drafts: SymbolDraft[] = [];
  private readonly sites: SiteDraft[] = [];
  /** Sites whose callee / target is a bare identifier: dropped when a local of that name is in scope. */
  private readonly bareSites = new Set<SiteDraft>();
  private readonly imports: ImportBinding[] = [];
  private readonly exports: ExportFact[] = [];
  private readonly typeFacts: TypeFact[] = [];
  private readonly lines: readonly string[];
  private draftIndex = new SpanIndex<SymbolDraft>([]);
  /** Names of the types declared in this file (a method's parent is its receiver type only if it is here). */
  private readonly declaredTypes = new Set<string>();
  /** Names of every top-level symbol of this file. */
  private readonly declaredNames = new Set<string>();
  /** Names declared here as aliases (`type X = Y`): the same type as Y, so a wildcard in signatures. */
  private readonly aliases = new Set<string>();
  /** For `inferRefs`: method signatures and constraint interfaces of this file. */
  private readonly data: GoFileData = { signatures: {}, constraints: [] };
  /** Scopes of the local names declared in this file, by name. */
  private readonly localScopes = new Map<string, Span[]>();
  /** Once the scan is over the locals are final: a name with many scopes is looked up in an index. */
  private scanDone = false;
  private readonly localIndexes = new Map<string, SpanIndex<true>>();
  private readonly typeParams: TypeParamScopes = { enabled: true, names: new Map() };
  /** The methods of the file in source order, for `receiverAt`. */
  private readonly methods: { start: Point; end: Point; receiver: string | undefined }[] = [];
  /** Identifiers and selector fields a `read` may sit on, in source order (decided once every local is known). */
  private readonly readLeaves: Node[] = [];
  /** The names the file's imports bind (packages, not variables). */
  private readonly importNames = new Set<string>();

  constructor(private readonly ctx: FileContext) {
    this.lines = ctx.lines;
  }

  run(): FileFacts {
    const root = this.ctx.tree.rootNode;
    // Type parameters are only looked for in files that have generics (a cheap native scan).
    this.typeParams.enabled =
      root.descendantsOfType(["type_parameter_list", "generic_type"]).length > 0;
    for (const node of root.namedChildren) {
      if (node.type !== "type_declaration") continue;
      for (const spec of typeSpecs(node)) {
        const name = spec.childForFieldName("name");
        if (!name) continue;
        this.declaredTypes.add(name.text);
        if (spec.type === "type_alias") this.aliases.add(name.text);
      }
    }
    for (const node of root.namedChildren) {
      if (node.type === "method_declaration")
        this.methods.push({
          start: node.startPosition,
          end: node.endPosition,
          receiver: receiverNameOf(node),
        });
    }
    for (const node of root.namedChildren) this.topLevel(node);
    for (const draft of this.drafts)
      if (!draft.path.includes(".")) this.declaredNames.add(draft.path);
    this.draftIndex = new SpanIndex(this.drafts.map((d) => ({ span: d.range, value: d })));
    this.scan(root);
    return {
      symbols: this.drafts,
      sites: this.sites.filter((site) => !this.shadowed(site)),
      imports: this.imports,
      typeFacts: this.typeFacts,
      exports: this.exports,
      data: this.data,
    };
  }

  // ── symbols ────────────────────────────────────────────────────────────────────────────────────

  private emit(
    path: string,
    kind: SymbolDraft["kind"],
    first: Node,
    last: Node,
    parentPath?: string,
  ): void {
    const draft: SymbolDraft = { path, kind, range: spanBetween(first, last, this.lines) };
    if (parentPath !== undefined) draft.parentPath = parentPath;
    this.drafts.push(draft);
  }

  private topLevel(node: Node): void {
    switch (node.type) {
      case "import_declaration":
        this.importDeclaration(node);
        break;
      case "function_declaration":
        this.functionDeclaration(node);
        break;
      case "method_declaration":
        this.methodDeclaration(node);
        break;
      case "type_declaration":
        this.typeDeclaration(node);
        break;
      case "const_declaration":
        this.valueDeclaration(
          node,
          node.namedChildren.filter((c) => c.type === "const_spec"),
        );
        break;
      case "var_declaration": {
        const specs: Node[] = [];
        for (const child of node.namedChildren) {
          if (child.type === "var_spec") specs.push(child);
          else if (child.type === "var_spec_list")
            for (const spec of child.namedChildren) if (spec.type === "var_spec") specs.push(spec);
        }
        this.valueDeclaration(node, specs);
        break;
      }
      case "ERROR":
        for (const child of node.namedChildren) this.topLevel(child);
        break;
      default:
        break;
    }
  }

  private functionDeclaration(node: Node): void {
    const name = node.childForFieldName("name");
    if (!name || name.text === "" || name.text === "_") return;
    this.emit(name.text, "function", node, node);
    this.returnFact(name.text, name.text, node.childForFieldName("result"));
  }

  private methodDeclaration(node: Node): void {
    const name = node.childForFieldName("name");
    const owner = receiverBaseName(node);
    if (!name || name.text === "" || name.text === "_" || !owner) return;
    const path = `${owner}.${name.text}`;
    this.emit(path, "method", node, node, this.declaredTypes.has(owner) ? owner : undefined);
    this.returnFact(path, name.text, node.childForFieldName("result"));
    this.data.signatures[path] = this.signature(node);
  }

  private typeDeclaration(declaration: Node): void {
    const grouped = declaration.children.some((c) => c.type === "(");
    for (const spec of typeSpecs(declaration)) {
      const nameNode = spec.childForFieldName("name");
      if (!nameNode || nameNode.text === "" || nameNode.text === "_") continue;
      const type = spec.childForFieldName("type");
      const kind =
        type?.type === "struct_type"
          ? "class"
          : type?.type === "interface_type"
            ? "interface"
            : "type";
      const path = nameNode.text;
      this.emit(path, kind, nameNode, grouped ? spec : declaration);
      if (type?.type === "struct_type") this.structFields(type, path, 0);
      else if (type?.type === "interface_type") {
        this.interfaceMethods(type, path);
        if (this.declaresTypeSet(type)) this.data.constraints.push(path);
      }
    }
  }

  /** Does the interface list types (`~int | string`, `int`, `comparable`)? Then it is a constraint. */
  private declaresTypeSet(iface: Node): boolean {
    for (const elem of iface.namedChildren) {
      if (elem.type !== "type_elem") continue;
      const parts = namedChildren(elem);
      if (parts.length !== 1) return true; // a union
      const only = parts[0]!;
      if (only.type === "negated_type") return true; // ~T
      // a lone name: an embedded interface, unless it is a predeclared type that is no interface
      if (only.type === "type_identifier") {
        const name = only.text;
        if (name === "comparable" || (PREDECLARED.has(name) && name !== "error" && name !== "any"))
          return true;
      } else if (only.type !== "qualified_type" && only.type !== "generic_type") {
        return true; // a literal type: []byte, map[K]V, ...
      }
    }
    return false;
  }

  /** Fields of a struct type: `Type.field` symbols (embedded fields are `extends` sites, see the file comment). */
  private structFields(struct: Node, path: string, depth: number): void {
    const list = struct.namedChildren.find((c) => c.type === "field_declaration_list");
    if (!list) return;
    for (const field of list.namedChildren) {
      if (field.type !== "field_declaration") continue;
      const type = field.childForFieldName("type");
      const names = fieldNodes(field, "name");
      if (names.length === 0) {
        // Embedded: the field is named like its type (`*pkg.T[int]` -> T).
        if (depth === 0) this.embeddedFieldFact(path, type);
        continue;
      }
      names.forEach((name, i) => {
        if (name.text === "_" || name.text === "") return;
        const memberPath = `${path}.${name.text}`;
        // `a, b int`: each name's range starts at the name, so a definition is attributed to its own field.
        this.emit(memberPath, "variable", i === 0 ? field : name, field, path);
        if (depth === 0) this.fieldFact(path, name.text, type);
        if (type?.type === "struct_type" && depth < MAX_STRUCT_DEPTH)
          this.structFields(type, memberPath, depth + 1);
      });
    }
  }

  private interfaceMethods(iface: Node, path: string): void {
    for (const member of iface.namedChildren) {
      if (member.type !== "method_elem") continue;
      const name = member.childForFieldName("name");
      if (!name || name.text === "" || name.text === "_") continue;
      const memberPath = `${path}.${name.text}`;
      this.emit(memberPath, "method", member, member, path);
      this.returnFact(memberPath, name.text, member.childForFieldName("result"));
      this.data.signatures[memberPath] = this.signature(member);
    }
  }

  // ── signatures ─────────────────────────────────────────────────────────────────────────────────

  /** The coarse signature of a method declaration / interface method (see ./signature.ts). */
  private signature(method: Node): Signature {
    const result = method.childForFieldName("result");
    return {
      params: this.parameterTypes(method.childForFieldName("parameters")),
      results: result
        ? result.type === "parameter_list"
          ? this.parameterTypes(result)
          : [this.signatureType(result)]
        : [],
    };
  }

  /** One entry per parameter: `a, b int` is two ints, `...T` is a variadic. */
  private parameterTypes(list: Node | null): string[] {
    const out: string[] = [];
    if (!list) return out;
    for (const declaration of namedChildren(list)) {
      const type = this.signatureType(declaration.childForFieldName("type"));
      if (declaration.type === "variadic_parameter_declaration") {
        out.push(`...${type}`);
      } else if (declaration.type === "parameter_declaration") {
        const count = Math.max(1, fieldNodes(declaration, "name").length);
        for (let i = 0; i < count; i++) out.push(type);
      }
    }
    return out;
  }

  /**
   * A type as a comparable string: package qualifiers and type arguments dropped, pointers and composite
   * shapes kept, and `?` for what cannot be told (type parameters, local aliases, anything unusual).
   */
  private signatureType(node: Node | null | undefined, depth = 0): string {
    if (!node || depth > 6) return "?";
    switch (node.type) {
      case "type_identifier": {
        const name = node.text;
        if (this.aliases.has(name) || isTypeParam(node, name, this.typeParams)) return "?";
        return name === "uint8" ? "byte" : name === "int32" ? "rune" : name;
      }
      case "qualified_type":
        return node.childForFieldName("name")?.text ?? "?";
      case "generic_type":
        return this.signatureType(node.childForFieldName("type"), depth + 1);
      case "pointer_type": {
        const inner = firstNamed(node);
        return `*${this.signatureType(inner, depth + 1)}`;
      }
      case "parenthesized_type":
        return this.signatureType(firstNamed(node), depth + 1);
      case "slice_type":
        return `[]${this.signatureType(node.childForFieldName("element"), depth + 1)}`;
      case "array_type":
        return `[${node.childForFieldName("length")?.text ?? ""}]${this.signatureType(node.childForFieldName("element"), depth + 1)}`;
      case "map_type":
        return `map[${this.signatureType(node.childForFieldName("key"), depth + 1)}]${this.signatureType(node.childForFieldName("value"), depth + 1)}`;
      case "channel_type":
        return `chan ${this.signatureType(node.childForFieldName("value"), depth + 1)}`;
      case "function_type": {
        const result = node.childForFieldName("result");
        const results = result
          ? result.type === "parameter_list"
            ? this.parameterTypes(result)
            : [this.signatureType(result, depth + 1)]
          : [];
        return `func(${this.parameterTypes(node.childForFieldName("parameters")).join(",")})(${results.join(",")})`;
      }
      case "interface_type":
        return namedChildren(node).length === 0 ? "any" : "interface";
      case "struct_type":
        return "struct";
      default:
        return "?";
    }
  }

  /** `var` / `const` specs: one variable per name; a group's specs are ranged one by one. */
  private valueDeclaration(declaration: Node, specs: readonly Node[]): void {
    const grouped =
      declaration.children.some((c) => c.type === "(") ||
      declaration.namedChildren.some((c) => c.type === "var_spec_list");
    for (const spec of specs) {
      const holder = grouped ? spec : declaration;
      // `a, b = 1, 2`: each name's range starts at the name, so a definition is attributed to its own symbol.
      fieldNodes(spec, "name").forEach((name, i) => {
        if (name.text === "" || name.text === "_") return;
        this.emit(name.text, "variable", i === 0 ? holder : name, holder);
      });
    }
  }

  // ── facts hanging off declarations ─────────────────────────────────────────────────────────────

  /**
   * `typeNameOf` for a declaration's type; undefined when the type has no name (slice, map, function...) or
   * names a type parameter in scope, which says nothing about the declared name.
   */
  private declaredTypeName(type: Node): string | undefined {
    const name = typeNameOf(type);
    if (!name) return undefined;
    if (!name.includes(".") && isTypeParam(type, name, this.typeParams)) return undefined;
    return name;
  }

  private fieldFact(structPath: string, name: string, type: Node | null): void {
    const typeName = type ? this.declaredTypeName(type) : undefined;
    if (typeName !== undefined)
      this.typeFacts.push({ scopePath: structPath, name, kind: "field", typeName });
  }

  private embeddedFieldFact(structPath: string, type: Node | null): void {
    if (!type) return;
    const typeName = this.declaredTypeName(type);
    if (typeName === undefined) return;
    const name = typeName.slice(typeName.lastIndexOf(".") + 1);
    this.typeFacts.push({ scopePath: structPath, name, kind: "field", typeName });
  }

  /** The declared type of the first result, unless it is `error` (the value `x, err := f()` binds to `x`). */
  private returnFact(path: string, name: string, result: Node | null): void {
    if (!result) return;
    const first =
      result.type === "parameter_list"
        ? (firstNamed(result)?.childForFieldName("type") ?? undefined)
        : result;
    const typeName = first ? this.declaredTypeName(first) : undefined;
    if (typeName === undefined || typeName === "error") return;
    this.typeFacts.push({ scopePath: path, name, kind: "return", typeName });
  }

  // ── imports ────────────────────────────────────────────────────────────────────────────────────

  private importDeclaration(declaration: Node): void {
    for (const child of declaration.namedChildren) {
      if (child.type === "import_spec") this.importSpec(child);
      else if (child.type === "import_spec_list")
        for (const spec of child.namedChildren)
          if (spec.type === "import_spec") this.importSpec(spec);
    }
  }

  private importSpec(spec: Node): void {
    const path = spec.childForFieldName("path");
    if (!path) return;
    const module = stringValue(path);
    if (module === "") return;
    const alias = spec.childForFieldName("name");
    const site = nodeSpan(spec, this.lines);
    for (const localName of alias ? [alias.text] : assumedPackageNames(module)) {
      this.imports.push({ localName, module, site });
      this.importNames.add(localName);
    }
    // `import . "pkg"` brings every exported name of pkg into the file: like a star import.
    if (alias?.type === "dot") this.exports.push({ name: "*", module, site });
  }

  // ── the flat scan ──────────────────────────────────────────────────────────────────────────────

  private scan(root: Node): void {
    for (const n of root.descendantsOfType(SCAN_TYPES)) {
      switch (n.type) {
        case "call_expression": {
          const shape = callShape(n, this.lines);
          if (shape) this.pushShape(shape);
          break;
        }
        case "type_identifier":
        case "qualified_type":
          this.onTypeName(n);
          break;
        case "assignment_statement":
        case "inc_statement":
        case "dec_statement":
          for (const shape of writeShapes(n, this.lines)) this.pushShape(shape);
          break;
        case "short_var_declaration":
          this.onShortVarDeclaration(n);
          break;
        case "var_spec":
          this.onVarSpec(n);
          break;
        case "parameter_declaration":
        case "variadic_parameter_declaration":
          this.onParameter(n);
          break;
        case "range_clause":
          this.onRange(n);
          break;
        case "type_switch_statement":
          this.onTypeSwitch(n);
          break;
        case "receive_statement":
          this.onReceive(n);
          break;
        case "identifier":
        case "field_identifier":
          this.readLeaves.push(n);
          break;
        default:
          break;
      }
    }
    this.scanDone = true;
    for (const leaf of this.readLeaves) this.onRead(leaf);
  }

  /**
   * A read of a package variable or of a field. Bare names that are locals are dropped with the other bare
   * sites (`shadowed`); the names of the language, the receiver and the packages of the file's imports are
   * not variables to read.
   */
  private onRead(leaf: Node): void {
    if (leaf.type === "identifier") {
      // What is dropped below for a bare name, asked before the walk up the tree that `readShape` takes
      // (most names are locals): the names of the language, the packages of the imports, the receiver, and
      // the locals in scope (the sites `shadowed` would remove at the end).
      const name = leaf.text;
      if (
        !this.declaredNames.has(name) &&
        (PREDECLARED.has(name) || BUILTIN_FUNCTIONS.has(name) || this.importNames.has(name))
      )
        return;
      const at = nodeSpan(leaf, this.lines);
      if (this.isLocalAt(name, at.startLine, at.startCol)) return;
      if (this.receiverAt(leaf) === name) return;
    }
    const shape = readShape(leaf, this.lines);
    if (!shape) return;
    this.pushShape(shape);
  }

  private onTypeName(n: Node): void {
    if (n.type === "type_identifier") {
      if (n.parent?.type === "qualified_type") return; // reported as the qualified name
      // `int`, `string`, ...: the language's own types (`error` stays: it can be embedded in an interface).
      const text = n.text;
      if (text !== "error" && PREDECLARED.has(text) && !this.declaredNames.has(text)) return;
    }
    const shape = typeShape(n, this.lines, this.typeParams);
    if (shape) this.pushShape(shape);
  }

  /**
   * The variable a method's receiver is bound to at `node` (`q` in `func (q *Queue) Pop()`), if any and if
   * no local of the same name (a closure's parameter, a `:=`) hides it there.
   */
  private receiverAt(node: Node): string | undefined {
    const at = node.startPosition;
    // Methods do not nest and are in source order: binary search for the last one starting at or before `at`.
    let lo = 0;
    let hi = this.methods.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const start = this.methods[mid]!.start;
      if (start.row < at.row || (start.row === at.row && start.column <= at.column)) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const method = this.methods[found];
    if (!method?.receiver) return undefined;
    const { end } = method;
    if (at.row > end.row || (at.row === end.row && at.column >= end.column)) return undefined;
    return this.isLocalAt(method.receiver, at.row + 1, at.column + 1) ? undefined : method.receiver;
  }

  private chain(node: Node): string[] | undefined {
    return chainOf(node, this.receiverAt(node));
  }

  private pushShape(shape: SiteShape): void {
    let qualifier: string[] | undefined;
    if (shape.qualifier) qualifier = shape.qualifier;
    else qualifier = shape.operand ? this.chain(shape.operand) : [];
    if (!qualifier) return; // a receiver that cannot be spelled (`arr[0].Run()`)
    if (qualifier.length === 0 && this.isLanguageName(shape)) return;
    const draft: SiteDraft = { kind: shape.kind, name: shape.name, qualifier, site: shape.site };
    this.sites.push(draft);
    if (
      (shape.kind === "call" || shape.kind === "write" || shape.kind === "read") &&
      qualifier.length === 0 &&
      shape.core.type === "identifier"
    )
      this.bareSites.add(draft);
  }

  /** `int`, `error`, `len(...)`, `string(b)`: names of the language itself (see PREDECLARED). */
  private isLanguageName(shape: SiteShape): boolean {
    if (this.declaredNames.has(shape.name)) return false;
    if (shape.kind === "type-ref") return PREDECLARED.has(shape.name);
    if (shape.kind === "call" && shape.core.type === "identifier")
      return BUILTIN_FUNCTIONS.has(shape.name) || PREDECLARED.has(shape.name);
    return false;
  }

  /** Is `name` already a variable of the scope that ends where `scope` ends, at the 1-based position? */
  private declaredInScope(name: string, scope: Span, line: number, col: number): boolean {
    return !!this.localScopes
      .get(name)
      ?.some(
        (s) =>
          s.endLine === scope.endLine && s.endCol === scope.endCol && spanContains(s, line, col),
      );
  }

  /** Is a local variable called `name` in scope at the 1-based position? */
  private isLocalAt(name: string, line: number, col: number): boolean {
    const scopes = this.localScopes.get(name);
    if (!scopes) return false;
    if (!this.scanDone || scopes.length <= 8)
      return scopes.some((scope) => spanContains(scope, line, col));
    // `err` has a scope in nearly every function; every use of it asks
    let index = this.localIndexes.get(name);
    if (!index) {
      index = new SpanIndex(scopes.map((span) => ({ span, value: true as const })));
      this.localIndexes.set(name, index);
    }
    return index.innermost(line, col) !== undefined;
  }

  /** A bare `name(...)` / `name = ...` where a local `name` is in scope refers to the local, not a package-level symbol. */
  private shadowed(site: SiteDraft): boolean {
    return (
      this.bareSites.has(site) && this.isLocalAt(site.name, site.site.startLine, site.site.startCol)
    );
  }

  // ── local names ────────────────────────────────────────────────────────────────────────────────

  /** Path of the symbol a declaration at `node` belongs to (`""` outside any symbol). */
  private scopePathOf(node: Node): string {
    const start = node.startPosition;
    return this.draftIndex.innermost(start.row + 1, start.column + 1)?.path ?? "";
  }

  /** From the end of `declaration` to the end of the block / statement / clause it is declared in. */
  private scopeAfter(declaration: Node): Span | undefined {
    const owner = scopeOwner(declaration);
    if (!owner) return undefined;
    const end = nodeSpan(owner, this.lines);
    return {
      startLine: declaration.endPosition.row + 1,
      startCol: declaration.endPosition.column + 1,
      endLine: end.endLine,
      endCol: end.endCol,
    };
  }

  private declareLocal(
    nameNode: Node,
    scope: Span,
    kind: "local" | "param",
    info?: Inferred,
  ): void {
    const name = nameNode.text;
    if (name === "" || name === "_") return;
    const fact: TypeFact = { scopePath: this.scopePathOf(nameNode), name, kind, visibleIn: scope };
    this.applyInferred(fact, info);
    this.typeFacts.push(fact);
    const scopes = this.localScopes.get(name);
    if (scopes) scopes.push(scope);
    else this.localScopes.set(name, [scope]);
  }

  private applyInferred(fact: TypeFact, info: Inferred | undefined): void {
    if (!info) return;
    if (info.typeName !== undefined) fact.typeName = info.typeName;
    else if (info.initCall) fact.initCall = info.initCall;
    else if (info.initChain) fact.initChain = info.initChain;
  }

  private onShortVarDeclaration(n: Node): void {
    const left = n.childForFieldName("left");
    const right = n.childForFieldName("right");
    const scope = this.scopeAfter(n);
    if (!left || !scope) return;
    const names = namedChildren(left);
    const values = right ? namedChildren(right) : [];
    const at = n.startPosition;
    names.forEach((nameNode, i) => {
      if (nameNode.type !== "identifier") return;
      // `x, err := f()` where `err` is already declared in this very scope (or is a parameter / named
      // result) assigns to it: no new variable.
      if (this.declaredInScope(nameNode.text, scope, at.row + 1, at.column + 1)) return;
      // `a, b := x, y` pairs them up; `v, err := f()` / `v, ok := x.(T)` types the first name only.
      const value = values.length === names.length ? values[i] : i === 0 ? values[0] : undefined;
      this.declareLocal(nameNode, scope, "local", value ? this.inferFromInit(value) : undefined);
    });
  }

  private onVarSpec(n: Node): void {
    const names = fieldNodes(n, "name");
    const type = n.childForFieldName("type");
    const valueList = n.childForFieldName("value");
    const values = valueList ? namedChildren(valueList) : [];
    const packageLevel = isPackageLevel(n);
    const scope = packageLevel ? undefined : this.scopeAfter(n);
    if (!packageLevel && !scope) return;
    names.forEach((nameNode, i) => {
      let info: Inferred | undefined;
      if (type) {
        const typeName = this.declaredTypeName(type);
        if (typeName !== undefined) info = { typeName };
      } else {
        const value = values.length === names.length ? values[i] : i === 0 ? values[0] : undefined;
        if (value) info = this.inferFromInit(value);
      }
      if (scope) {
        this.declareLocal(nameNode, scope, "local", info);
      } else if (nameNode.text !== "_" && nameNode.text !== "") {
        // Package level: visible in the whole package (facts are per file, so other files do not see it).
        const fact: TypeFact = { scopePath: "", name: nameNode.text, kind: "local" };
        this.applyInferred(fact, info);
        this.typeFacts.push(fact);
      }
    });
  }

  private onParameter(n: Node): void {
    const list = n.parent;
    const owner = list?.parent;
    if (
      !list ||
      !owner ||
      (owner.type !== "function_declaration" &&
        owner.type !== "method_declaration" &&
        owner.type !== "func_literal")
    )
      return;
    // Parameters and named results; not the receiver, not function *types*.
    if (
      owner.childForFieldName("parameters")?.id !== list.id &&
      owner.childForFieldName("result")?.id !== list.id
    )
      return;
    const body = owner.childForFieldName("body");
    if (!body) return;
    const type = n.type === "parameter_declaration" ? n.childForFieldName("type") : null;
    const typeName = type ? this.declaredTypeName(type) : undefined;
    // A parameter is in scope in the function body only (its type in the signature is not shadowed by it).
    const scope = nodeSpan(body, this.lines);
    for (const nameNode of fieldNodes(n, "name"))
      this.declareLocal(
        nameNode,
        scope,
        "param",
        typeName !== undefined ? { typeName } : undefined,
      );
  }

  private onRange(n: Node): void {
    if (!n.children.some((c) => c.type === ":=")) return;
    const left = n.childForFieldName("left");
    const body = n.parent?.type === "for_statement" ? n.parent.childForFieldName("body") : null;
    if (!left || !body) return;
    const scope = nodeSpan(body, this.lines);
    for (const nameNode of namedChildren(left))
      if (nameNode.type === "identifier") this.declareLocal(nameNode, scope, "local");
  }

  /** `switch v := x.(type) { case *A: ... }`: in a single-type clause `v` has that type. */
  private onTypeSwitch(n: Node): void {
    const alias = n.childForFieldName("alias");
    const nameNode = alias ? namedChildren(alias)[0] : undefined;
    if (!nameNode || nameNode.type !== "identifier") return;
    for (const clause of n.namedChildren) {
      if (clause.type !== "type_case" && clause.type !== "default_case") continue;
      const types = clause.type === "type_case" ? fieldNodes(clause, "type") : [];
      const typeName = types.length === 1 ? this.declaredTypeName(types[0]!) : undefined;
      this.declareLocal(
        nameNode,
        nodeSpan(clause, this.lines),
        "local",
        typeName !== undefined ? { typeName } : undefined,
      );
    }
  }

  /** `case v := <-ch:` of a select statement. */
  private onReceive(n: Node): void {
    if (!n.children.some((c) => c.type === ":=")) return;
    const left = n.childForFieldName("left");
    const clause = n.parent;
    if (!left || !clause) return;
    const scope = nodeSpan(clause, this.lines);
    for (const nameNode of namedChildren(left))
      if (nameNode.type === "identifier") this.declareLocal(nameNode, scope, "local");
  }

  /** What an initialiser evidently is: `&T{}`, `T{}`, `new(T)`, `f()`, `pkg.New()`, `x.(T)`, `T(x)`, an alias. */
  private inferFromInit(expr: Node): Inferred | undefined {
    let n: Node | undefined = expr;
    for (let i = 0; n && i < 8; i++) {
      if (n.type === "parenthesized_expression") {
        n = firstNamed(n);
      } else if (
        n.type === "unary_expression" &&
        ["&", "*"].includes(n.childForFieldName("operator")?.text ?? "")
      ) {
        n = n.childForFieldName("operand") ?? undefined;
      } else {
        break;
      }
    }
    if (!n) return undefined;
    switch (n.type) {
      case "composite_literal": {
        const typeName = this.declaredTypeName(n.childForFieldName("type") ?? n);
        return typeName !== undefined ? { typeName } : undefined;
      }
      case "type_conversion_expression":
      case "type_assertion_expression": {
        const type = n.childForFieldName("type");
        const typeName = type ? this.declaredTypeName(type) : undefined;
        return typeName !== undefined ? { typeName } : undefined;
      }
      case "call_expression": {
        const fn = n.childForFieldName("function");
        if (fn?.type === "identifier" && fn.text === "new") {
          const arg = n.childForFieldName("arguments");
          const type = arg ? firstNamed(arg) : undefined;
          const typeName = type ? this.declaredTypeName(type) : undefined;
          return typeName !== undefined ? { typeName } : undefined;
        }
        if (fn?.type === "identifier" && fn.text === "make") return undefined;
        const parts = callParts(n);
        if (!parts) return undefined;
        const qualifier = parts.operand ? this.chain(parts.operand) : [];
        if (!qualifier) return undefined;
        // `(*T)(x)` is a conversion: the value has type T.
        if (parts.conversion) return { typeName: [...qualifier, parts.name].join(".") };
        return { initCall: { qualifier, name: parts.name } };
      }
      case "identifier":
      case "selector_expression": {
        // An alias: `q := r.queue`, `w := worker`.
        const chain = this.chain(n);
        return chain && chain.length <= 6 ? { initChain: chain } : undefined;
      }
      default:
        return undefined;
    }
  }
}

/** Extract the facts of one parsed Go file. */
export function extractGo(ctx: FileContext): FileFacts {
  return new Extractor(ctx).run();
}
