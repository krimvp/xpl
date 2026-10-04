/**
 * The Python extractor: symbols (a structural walk over statements), then reference sites, import bindings
 * and type facts (a flat scan over the node types that matter, like the TypeScript pack).
 */
import type { Node } from "web-tree-sitter";
import { nodeSpan, spanBetween } from "../../ast.js";
import type {
  ExportFact,
  FileContext,
  FileFacts,
  ImportBinding,
  SiteDraft,
  SymbolDraft,
  TypeFact,
} from "../types.js";
import { collectTypeRefs, isAnnotationRoot, typeNameOf, unwrapType } from "./annotations.js";
import {
  isMainGuard,
  isOverload,
  isStaticMethod,
  lastSegment,
  named,
  nestedStatements,
  paramsOf,
  scopeNodeOf,
  underTypeChecking,
} from "./ast.js";
import type { SiteShape } from "./ast.js";
import { alternatives, chainOf, collapseDotted, inferFromInit, rootIdentifierOf } from "./exprs.js";
import type { Env, Inferred } from "./exprs.js";
import { PyScopes } from "./scope.js";
import type { ReadEnv } from "./shapes.js";
import {
  callShape,
  decoratorShape,
  globalNamesOf,
  heritageShapes,
  importCallShape,
  importStatement,
  bareReadShape,
  memberReadShape,
  spanHolds,
  writeShapes,
} from "./shapes.js";

/** Longest function body (in lines) whose `return` statements are inspected. */
const RETURN_SCAN_MAX_LINES = 400;
/** Nodes the flat scan looks at (`descendantsOfType` is a single native call). */
const SCAN_TYPES = [
  "call",
  "decorator",
  "class_definition",
  "function_definition",
  "type",
  "assignment",
  "augmented_assignment",
  // what a `read` can be: a bare name, or the attribute of `a.b` (see `readShape`)
  "identifier",
  "attribute",
];

interface Scope {
  kind: "module" | "class" | "function";
  /** Symbol path of the enclosing class/function; "" at module level. */
  path: string;
}

interface FnInfo {
  /** The receiver (`self`/`cls` under whatever name) in effect in the function's body. */
  receiver?: { name: string; classPath?: string };
  paramNames: Set<string>;
}

/** A type fact from what a declaration says (`declared`, wins) or what its initialiser shows. */
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

/** The definition a statement holds: itself, or the class/function under its decorators. */
function definitionOf(stmt: Node): Node | undefined {
  if (stmt.type === "decorated_definition")
    return stmt.childForFieldName("definition") ?? undefined;
  return stmt.type === "class_definition" || stmt.type === "function_definition" ? stmt : undefined;
}

export class Extractor implements Env {
  private readonly drafts: SymbolDraft[] = [];
  private readonly sites: SiteDraft[] = [];
  private readonly imports: ImportBinding[] = [];
  private readonly exports: ExportFact[] = [];
  private readonly typeFacts: TypeFact[] = [];
  private readonly lines: readonly string[];
  readonly dotted = new Set<string>();
  /** Class/function definition node id -> the path of the symbol it became. */
  private readonly symbolPaths = new Map<number, string>();
  /** Function node id -> path of the class it is a member of. */
  private readonly methodClass = new Map<number, string>();
  private readonly fnCache = new Map<number, FnInfo>();
  private readonly globalsCache = new Map<number, ReadonlySet<string>>();
  private readonly seenFacts = new Set<string>();
  /** `${fn id}\0${param}` -> declared/inferred type name of a parameter. */
  private readonly paramTypes = new Map<string, string>();
  /** Field facts by `${class}\0${field}`: declared ones win over inferred ones (flushed at the end). */
  private readonly fieldDeclared = new Map<string, TypeFact[]>();
  private readonly fieldInferred = new Map<string, TypeFact[]>();
  /** Identifiers and attribute accesses a `read` may sit on, in source order (decided once every fact is known). */
  private readonly readNames: Node[] = [];
  private readonly readMembers: Node[] = [];
  /** The first parameter of every function: what `self` (or whatever a method calls its receiver) can be. */
  private readonly firstParams = new Set<string>();
  /** Where the annotations and the base class lists of the file are (`[start, end)` indexes, in source order). */
  private readonly annotationSpans: [number, number][] = [];
  private readonly baseSpans: [number, number][] = [];
  private readonly scopes = new PyScopes((fn) => this.globalsOf(fn));

  /** Names the file's imports bind (anywhere in it). */
  private importedNames: ReadonlySet<string> = new Set();
  /** Paths of the variables emitted so far: a conditional assignment does not define a name twice. */
  private readonly variables = new Set<string>();

  constructor(private readonly ctx: FileContext) {
    this.lines = ctx.lines;
  }

  run(): FileFacts {
    const root = this.ctx.tree.rootNode;
    // Imports first: `import a.b.c` changes how later qualifiers are spelled, and an imported name is not
    // defined by the fallback assignment that stands in for it (`except ImportError: x = None`).
    for (const stmt of root.descendantsOfType(["import_statement", "import_from_statement"]))
      this.onImport(stmt);
    this.importedNames = new Set(this.imports.map((i) => i.localName));
    this.visitStatements(named(root), { kind: "module", path: "" });
    this.scan(root);
    this.flushFields();
    this.submoduleExports(root);
    return {
      symbols: this.drafts,
      sites: this.sites,
      imports: this.imports,
      typeFacts: this.typeFacts,
      exports: this.exports,
    };
  }

  // ── Env ────────────────────────────────────────────────────────────────────────────────────────

  receiverAt(node: Node): string | undefined {
    const scope = scopeNodeOf(node);
    if (!scope || (scope.type !== "function_definition" && scope.type !== "lambda"))
      return undefined;
    return this.fnInfo(scope).receiver?.name;
  }

  private fnInfo(fn: Node): FnInfo {
    let info = this.fnCache.get(fn.id);
    if (info) return info;
    const params = paramsOf(fn);
    const paramNames = new Set(params.map((p) => p.name));
    let receiver: FnInfo["receiver"];
    const outer = scopeNodeOf(fn);
    if (fn.type === "function_definition" && outer?.type === "class_definition") {
      // A method: its first parameter is the receiver, whatever it is called, unless it is static.
      const first = params[0];
      if (first && !first.splat && !isStaticMethod(fn))
        receiver = { name: first.name, classPath: this.symbolPaths.get(outer.id) };
    } else if (outer && (outer.type === "function_definition" || outer.type === "lambda")) {
      // A nested function or lambda sees the receiver of the method around it unless it shadows the name.
      const inherited = this.fnInfo(outer).receiver;
      if (inherited && !paramNames.has(inherited.name)) receiver = inherited;
    }
    info = { receiver, paramNames };
    this.fnCache.set(fn.id, info);
    return info;
  }

  private globalsOf(fn: Node): ReadonlySet<string> {
    let names = this.globalsCache.get(fn.id);
    if (!names) {
      names = globalNamesOf(fn);
      this.globalsCache.set(fn.id, names);
    }
    return names;
  }

  // ── symbols ────────────────────────────────────────────────────────────────────────────────────

  private emit(path: string, kind: SymbolDraft["kind"], node: Node, parentPath: string): void {
    const draft: SymbolDraft = { path, kind, range: spanBetween(node, node, this.lines) };
    if (parentPath !== "") draft.parentPath = parentPath;
    this.drafts.push(draft);
  }

  /**
   * `direct`: the statements are the body of the scope itself, not of an `if`/`try`/`for`... inside it.
   * Assignments there are conditional definitions (`if CACHE: cacheit = ...` / `else: cacheit = ...`): the
   * first one is the variable, unless the name is defined directly in the scope or imported in the file
   * (`try: import x` / `except: x = None`: the fallback must not shadow the import it stands in for).
   */
  private visitStatements(
    stmts: readonly Node[],
    scope: Scope,
    direct = true,
    /** In an `if` / `try` / `with` (not a loop): its assignments are conditional definitions. */
    assigns = true,
  ): void {
    // Names that have an implementation: `@overload` stubs of them are not symbols.
    const implemented = new Set<string>();
    for (const stmt of stmts) {
      const def = definitionOf(stmt);
      const name = def?.type === "function_definition" ? def.childForFieldName("name") : null;
      if (def && name && !isOverload(def)) implemented.add(name.text);
    }
    if (direct && scope.kind !== "function") {
      const names = new Set<string>();
      for (const stmt of stmts) {
        const name = definitionOf(stmt)?.childForFieldName("name")?.text ?? directTarget(stmt);
        if (name) names.add(name);
      }
      this.directNames.set(scope.path, names);
    }
    for (const stmt of stmts) this.visitStatement(stmt, scope, implemented, direct, assigns);
  }

  private visitStatement(
    stmt: Node,
    scope: Scope,
    implemented: ReadonlySet<string>,
    direct: boolean,
    assigns: boolean,
  ): void {
    const def = definitionOf(stmt);
    if (def) {
      this.definition(stmt, def, scope, implemented);
      return;
    }
    switch (stmt.type) {
      case "expression_statement":
        if (scope.kind !== "function" && (direct || assigns))
          this.assignmentSymbol(stmt, scope, direct);
        break;
      case "type_alias_statement":
        if (direct && scope.kind !== "function") this.typeAliasSymbol(stmt, scope);
        break;
      default:
        // if/try/with/for/while/match: their definitions belong to the scope around them. The `__main__`
        // guard is the script's own body, not module API.
        if (!isMainGuard(stmt)) {
          const nested = nestedStatements(stmt);
          // a loop's assignments are its temporaries, not definitions of the scope
          if (nested.length > 0)
            this.visitStatements(
              nested,
              scope,
              false,
              assigns && CONDITIONAL_BLOCKS.has(stmt.type),
            );
        }
        break;
    }
  }

  private definition(outer: Node, def: Node, scope: Scope, implemented: ReadonlySet<string>): void {
    const nameNode = def.childForFieldName("name");
    if (!nameNode) return;
    const name = nameNode.text;
    if (def.type === "function_definition" && isOverload(def) && implemented.has(name)) return;
    const path = scope.path === "" ? name : `${scope.path}.${name}`;
    const body = def.childForFieldName("body");
    this.symbolPaths.set(def.id, path);
    if (def.type === "class_definition") {
      this.emit(path, "class", outer, scope.path);
      if (body) this.visitStatements(named(body), { kind: "class", path });
      return;
    }
    const isMethod = scope.kind === "class";
    this.emit(path, isMethod ? "method" : "function", outer, scope.path);
    if (isMethod) this.methodClass.set(def.id, scope.path);
    if (body) this.visitStatements(named(body), { kind: "function", path });
  }

  /**
   * `x = 1`, `x: int = 1`, `x: int`, and each name of `x, y = ...` / `(x, y) = ...`, at module or class level.
   * A conditional one (`direct` false) only for a name not imported in the file nor defined yet in the scope.
   */
  private assignmentSymbol(stmt: Node, scope: Scope, direct: boolean): void {
    const assignment = named(stmt)[0];
    if (assignment?.type !== "assignment") return;
    const left = assignment.childForFieldName("left");
    const names =
      left?.type === "identifier"
        ? [left.text]
        : left?.type === "pattern_list" || left?.type === "tuple_pattern"
          ? named(left).flatMap((n) => (n.type === "identifier" ? [n.text] : []))
          : [];
    // a defined name of the scope (a direct `x = ...` comes first whatever the order)
    for (const name of names) {
      const path = scope.path === "" ? name : `${scope.path}.${name}`;
      if (!direct && (this.variables.has(path) || this.importedNames.has(name))) continue;
      if (!direct && this.definedDirectly(scope, name)) continue;
      this.variables.add(path);
      this.emit(path, "variable", stmt, scope.path);
    }
  }

  private readonly directNames = new Map<string, Set<string>>();

  /** Is `name` assigned or defined by a statement directly in the scope's body (any position)? */
  private definedDirectly(scope: Scope, name: string): boolean {
    return this.directNames.get(scope.path)?.has(name) ?? false;
  }

  /** `type Pair = tuple[int, int]` (PEP 695). */
  private typeAliasSymbol(stmt: Node, scope: Scope): void {
    let target = unwrapType(stmt.childForFieldName("left"));
    if (target?.type === "generic_type")
      target = named(target).find((c) => c.type === "identifier");
    if (target?.type !== "identifier") return;
    this.emit(
      scope.path === "" ? target.text : `${scope.path}.${target.text}`,
      "type",
      stmt,
      scope.path,
    );
  }

  // ── imports ────────────────────────────────────────────────────────────────────────────────────

  private onImport(stmt: Node): void {
    const { entries, star } = importStatement(stmt);
    // Imports under `if TYPE_CHECKING:` exist for the type checker: their references are `type-ref`s.
    const typeOnly = underTypeChecking(stmt) ? ({ typeOnly: true } as const) : {};
    for (const entry of entries) {
      this.imports.push({ ...entry.binding, site: nodeSpan(entry.node, this.lines), ...typeOnly });
      if (stmt.type === "import_statement" && entry.binding.localName.includes("."))
        this.dotted.add(entry.binding.localName);
    }
    if (star) this.exports.push({ ...star, site: nodeSpan(stmt, this.lines), ...typeOnly });
  }

  /**
   * Importing from a submodule binds it in its package: after `from .queue import Queue` in `pkg/__init__.py`
   * the package has an attribute `queue`, the module. Declaring that as a re-export lets the resolver see
   * `from pkg import queue` as the module (it looks names up in the package's files and knows nothing of its
   * submodules otherwise). Not when the file itself binds or defines the name, or star-imports that module:
   * the name then means what the code says (`from .config import config`).
   */
  private submoduleExports(root: Node): void {
    if (!/(^|\/)__init__\.pyi?$/.test(this.ctx.file)) return;
    const taken = new Set<string>(this.imports.map((b) => b.localName));
    for (const draft of this.drafts) if (!draft.path.includes(".")) taken.add(draft.path);
    const stars = new Set(this.exports.filter((e) => e.name === "*").map((e) => e.module));
    for (const stmt of root.descendantsOfType("import_from_statement")) {
      const module = stmt.childForFieldName("module_name");
      const sub =
        module?.type === "relative_import"
          ? /^\.([\p{L}_][\p{L}\p{N}_]*)/u.exec(module.text)?.[1]
          : undefined;
      if (sub === undefined || taken.has(sub) || stars.has(`.${sub}`)) continue;
      taken.add(sub); // once per submodule
      this.exports.push({ name: sub, module: `.${sub}` });
    }
  }

  // ── the flat scan ──────────────────────────────────────────────────────────────────────────────

  private scan(root: Node): void {
    const assignments: Node[] = [];
    for (const n of root.descendantsOfType(SCAN_TYPES)) {
      switch (n.type) {
        case "call":
          this.onCall(n);
          break;
        case "decorator": {
          const shape = decoratorShape(n, this.lines);
          if (shape) this.pushShape(shape);
          break;
        }
        case "class_definition": {
          const bases = n.childForFieldName("superclasses");
          if (bases) this.baseSpans.push([bases.startIndex, bases.endIndex]);
          for (const shape of heritageShapes(n, this.lines)) this.pushShape(shape);
          break;
        }
        case "function_definition": {
          const first = paramsOf(n)[0];
          if (first && !first.splat) this.firstParams.add(first.name);
          this.onFunction(n);
          break;
        }
        case "type":
          if (isAnnotationRoot(n)) {
            this.annotationSpans.push([n.startIndex, n.endIndex]);
            for (const shape of collectTypeRefs(n, this.lines)) this.pushShape(shape);
          }
          break;
        case "assignment":
        case "augmented_assignment":
          for (const shape of writeShapes(n, this.lines, (fn) => this.globalsOf(fn)))
            this.pushShape(shape);
          if (n.type === "assignment") assignments.push(n);
          break;
        case "identifier":
          this.readNames.push(n);
          break;
        case "attribute":
          this.readMembers.push(n);
          break;
        default:
          break;
      }
    }
    // Parameter types are known by now: `self.queue = queue` copies the type of `queue`.
    for (const assignment of assignments) this.onAssignmentFacts(assignment);
    this.onReads();
  }

  // ── reads ──────────────────────────────────────────────────────────────────────────────────────

  private onReads(): void {
    if (this.readNames.length === 0 && this.readMembers.length === 0) return;
    // What the file declares or imports: a bare name can only be a read when it is one of these (or when a
    // star import may have brought it in).
    const bare = new Set<string>();
    const roots = new Set<string>();
    for (const draft of this.drafts) {
      const name = lastSegment(draft.path);
      roots.add(name);
      // a variable, or a class or function used as a value (a callback, `isinstance(x, C)`)
      if (draft.kind === "variable" || draft.kind === "class" || draft.kind === "function")
        bare.add(name);
    }
    for (const binding of this.imports) {
      bare.add(binding.localName);
      roots.add(binding.localName);
    }
    const anyBare = this.exports.some((e) => e.name === "*");
    // Locals and parameters with a type fact, by function: their members can be resolved.
    const typed = new Set<string>();
    const typedNames = new Set<string>();
    for (const fact of this.typeFacts)
      if (fact.kind === "local" || fact.kind === "param") {
        typed.add(`${fact.scopePath}\0${fact.name}`);
        typedNames.add(fact.name);
      }
    // The names a receiver can start with: `import a.b.c` binds "a.b.c", which spells `a.b.c.x` (see `collapseDotted`).
    const heads = new Set<string>();
    for (const name of roots) heads.add(name.split(".")[0]!);
    const env: ReadEnv = {
      inAnnotation: (index) => spanHolds(this.annotationSpans, index),
      inBases: (index) => spanHolds(this.baseSpans, index),
    };
    // Cheapest tests first: every `parent` is a walk down from the root of the tree, and most names are locals.
    const reads: { at: number; site: SiteDraft }[] = [];
    if (anyBare || bare.size > 0) {
      for (const leaf of this.readNames) {
        const name = leaf.text;
        if (!anyBare && !bare.has(name)) continue;
        const shape = bareReadShape(leaf, name, this.lines, env);
        if (shape && !this.scopes.bindingScope(leaf, name))
          reads.push({
            at: leaf.startIndex,
            site: { kind: "read", name, qualifier: [], site: shape.site },
          });
      }
    }
    for (const member of this.readMembers) {
      const leaf = member.childForFieldName("attribute");
      const object = member.childForFieldName("object");
      if (!leaf || !object) continue;
      // a receiver that cannot be `self`, is not declared in the file and is no typed local resolves to nothing
      const rootName = rootIdentifierOf(object);
      if (
        rootName === undefined ||
        (rootName !== "super" &&
          !this.firstParams.has(rootName) &&
          !heads.has(rootName) &&
          !typedNames.has(rootName))
      )
        continue;
      const shape = memberReadShape(member, leaf, object, this.lines, env);
      if (!shape) continue;
      const chain = chainOf(object, this);
      if (!chain) continue;
      const root = chain[0]!;
      let ok = root === "this" || root === "super";
      if (!ok) {
        const called = root.endsWith("()");
        const name = called ? root.slice(0, -2) : root;
        const scope = this.scopes.bindingScope(leaf, name);
        if (scope) {
          const path =
            scope.type === "function_definition" ? this.symbolPaths.get(scope.id) : undefined;
          ok = !called && path !== undefined && typed.has(`${path}\0${name}`);
        } else {
          ok = roots.has(name);
        }
      }
      if (ok)
        reads.push({
          at: leaf.startIndex,
          site: { kind: "read", name: shape.name, qualifier: chain, site: shape.site },
        });
    }
    // in source order, by the name being read (an outer attribute access starts before its inner ones)
    reads.sort((a, b) => a.at - b.at);
    for (const read of reads) this.sites.push(read.site);
  }

  private pushShape(shape: SiteShape): void {
    if (shape.name === "") return; // a MISSING identifier of a syntax error
    let qualifier: string[] = [];
    if (shape.qualifierNode) {
      const chain = chainOf(shape.qualifierNode, this);
      if (!chain) return; // `arr[0].run()`: a receiver we cannot spell
      qualifier = chain;
    } else if (shape.qualifierText) {
      qualifier = collapseDotted(shape.qualifierText, this);
    }
    const site: SiteDraft = { kind: shape.kind, name: shape.name, qualifier, site: shape.site };
    if (shape.kind === "call" && qualifier.length === 0 && shape.nameNode.type === "identifier") {
      // a parameter, a local or a nested `def`: never the module-level function of the same name
      const binder = this.scopes.bindingScope(shape.nameNode, shape.name)?.type;
      if (binder === "function_definition" || binder === "lambda") site.local = true;
    }
    this.sites.push(site);
  }

  private onCall(call: Node): void {
    const dynamicImport = importCallShape(call, this.lines);
    if (dynamicImport) {
      this.sites.push({
        kind: "import",
        name: dynamicImport.name,
        qualifier: [],
        site: dynamicImport.site,
      });
      return;
    }
    const shape = callShape(call, this.lines);
    if (shape) this.pushShape(shape);
  }

  // ── type facts ─────────────────────────────────────────────────────────────────────────────────

  private pushFact(fact: TypeFact): void {
    const key = JSON.stringify([
      fact.scopePath,
      fact.name,
      fact.kind,
      fact.typeName,
      fact.initCall,
      fact.initChain,
    ]);
    if (this.seenFacts.has(key)) return;
    this.seenFacts.add(key);
    this.typeFacts.push(fact);
  }

  private addField(
    classPath: string,
    name: string,
    declared: string | undefined,
    inferred: Inferred | undefined,
  ): void {
    const fact = makeFact({ scopePath: classPath, name, kind: "field" }, declared, inferred);
    if (!fact) return;
    const bucket = declared !== undefined ? this.fieldDeclared : this.fieldInferred;
    const key = `${classPath}\0${name}`;
    const list = bucket.get(key);
    if (list) list.push(fact);
    else bucket.set(key, [fact]);
  }

  /** Declared field types win over what assignments show; each distinct fact is emitted once. */
  private flushFields(): void {
    for (const facts of this.fieldDeclared.values()) for (const fact of facts) this.pushFact(fact);
    for (const [key, facts] of this.fieldInferred)
      if (!this.fieldDeclared.has(key)) for (const fact of facts) this.pushFact(fact);
  }

  /** Parameter and return facts of a function (or method) that is a symbol. */
  private onFunction(fn: Node): void {
    const path = this.symbolPaths.get(fn.id);
    if (path === undefined) return;
    const skipReceiver = this.methodClass.has(fn.id) && !isStaticMethod(fn);
    paramsOf(fn).forEach((p, i) => {
      if (p.splat || (i === 0 && skipReceiver)) return;
      const declared = p.type ? typeNameOf(p.type, "value") : undefined;
      const inferred = declared === undefined ? inferFromInit(p.value, this) : undefined;
      const fact = makeFact({ scopePath: path, name: p.name, kind: "param" }, declared, inferred);
      if (!fact) return;
      this.pushFact(fact);
      if (fact.typeName !== undefined) this.paramTypes.set(`${fn.id}\0${p.name}`, fact.typeName);
    });
    if (lastSegment(path) === "__init__") return;
    const returnType = fn.childForFieldName("return_type");
    const declared = returnType ? typeNameOf(returnType, "return") : undefined;
    // Without an annotation a function returns what its body shows: `return Widget()`, `return self.pool`.
    const inferred = returnType ? undefined : this.inferReturn(fn);
    const fact = makeFact(
      { scopePath: path, name: lastSegment(path), kind: "return" },
      declared,
      inferred,
    );
    if (fact) this.pushFact(fact);
  }

  /** What the first evident `return <expr>` of `fn` (not of a nested function) returns. */
  private inferReturn(fn: Node): Inferred | undefined {
    const body = fn.childForFieldName("body");
    if (!body || body.endPosition.row - body.startPosition.row > RETURN_SCAN_MAX_LINES)
      return undefined;
    let inspected = 0;
    for (const stmt of body.descendantsOfType("return_statement")) {
      if (scopeNodeOf(stmt)?.id !== fn.id) continue; // a `return` of a nested function
      if (++inspected > 6) break;
      const inferred = inferFromInit(named(stmt)[0], this);
      if (inferred) return inferred;
    }
    return undefined;
  }

  /**
   * Local, module-variable and field facts of an assignment: `x = Queue()`, `x: Job = ...` (local or module
   * level), `queue: Queue = ...` in a class body, `self.queue: Queue = ...` / `self.queue = Queue()` /
   * `self.queue = queue` (a typed parameter) in a method (fields of the method's class).
   */
  private onAssignmentFacts(n: Node): void {
    const left = n.childForFieldName("left");
    const scope = scopeNodeOf(n);
    if (!left || !scope) return;
    const typeNode = n.childForFieldName("type");
    const right = n.childForFieldName("right");
    const declared = typeNode ? typeNameOf(typeNode, "value") : undefined;

    if (left.type === "identifier") {
      const inferred = declared === undefined ? inferFromInit(right, this) : undefined;
      if (scope.type === "class_definition") {
        const classPath = this.symbolPaths.get(scope.id);
        if (classPath !== undefined) this.addField(classPath, left.text, declared, inferred);
        return;
      }
      let scopePath: string | undefined;
      if (scope.type === "module") scopePath = "";
      else if (scope.type === "function_definition") scopePath = this.symbolPaths.get(scope.id);
      if (scopePath === undefined) return;
      const fact = makeFact({ scopePath, name: left.text, kind: "local" }, declared, inferred);
      if (fact) this.pushFact(fact);
      return;
    }

    if (left.type !== "attribute" || scope.type !== "function_definition") return;
    const object = left.childForFieldName("object");
    const attr = left.childForFieldName("attribute");
    const receiver = this.fnInfo(scope).receiver;
    if (object?.type !== "identifier" || !attr || receiver?.name !== object.text) return;
    if (receiver.classPath === undefined) return;
    const inferred = declared === undefined ? this.fieldInference(right, scope) : undefined;
    this.addField(receiver.classPath, attr.text, declared, inferred);
  }

  /**
   * What `self.x = <right>` shows about the field. A field fact is evaluated from the class, where the
   * method's parameters and locals are not visible: a typed parameter contributes its type, and an
   * initialiser that starts from a parameter says nothing. `q or Queue()` offers both alternatives.
   */
  private fieldInference(right: Node | null, method: Node): Inferred | undefined {
    const alternative = alternatives(right);
    if (alternative.length === 1) return this.fieldValue(alternative[0]!, method);
    for (const each of alternative) {
      const inferred = this.fieldValue(each, method);
      if (inferred && (inferred.typeName !== undefined || inferred.initCall)) return inferred;
    }
    return undefined;
  }

  private fieldValue(value: Node, method: Node): Inferred | undefined {
    if (value.type === "identifier") {
      const typeName = this.paramTypes.get(`${method.id}\0${value.text}`);
      if (typeName !== undefined) return { typeName };
    }
    const inferred = inferFromInit(value, this);
    if (!inferred) return undefined;
    const root = inferred.initCall
      ? (inferred.initCall.qualifier[0] ?? inferred.initCall.name)
      : inferred.initChain?.[0];
    if (root !== undefined && root !== "this" && this.fnInfo(method).paramNames.has(root))
      return undefined;
    return inferred;
  }
}

/** The name a direct `x = ...` statement assigns (single-name targets only). */
function directTarget(stmt: Node): string | undefined {
  if (stmt.type !== "expression_statement") return undefined;
  const assignment = named(stmt)[0];
  const left = assignment?.type === "assignment" ? assignment.childForFieldName("left") : null;
  return left?.type === "identifier" ? left.text : undefined;
}

/** Blocks whose assignments are conditional definitions of the scope around them (not loops or `match`). */
const CONDITIONAL_BLOCKS: ReadonlySet<string> = new Set([
  "if_statement",
  "try_statement",
  "with_statement",
  // the clauses of those (a loop's `else` is under the loop, which already turned assignments off)
  "elif_clause",
  "else_clause",
  "except_clause",
  "except_group_clause",
  "finally_clause",
]);
