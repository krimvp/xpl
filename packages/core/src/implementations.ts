/**
 * Implementations: who implements an interface (or one of its methods), and which interface method a
 * method implements. `xpl refs` uses it to hop through interfaces: a call to `JobQueue.Requeue` ends at a
 * declaration without a body, and what runs is the implementation.
 *
 * The index has two kinds of `implements` reference:
 *
 * - type level: `Queue implements JobQueue` (a TS `implements` clause, or the implicit interface
 *   satisfaction of Go, inferred from the method sets). Members are not linked then, so the members of an
 *   implementing type are matched by name: `JobQueue.Requeue` is implemented by `Queue.Requeue`. Go methods
 *   may sit in another file of the package, so the files next to the type are searched too.
 * - member level: `Impl.run implements Base.run`, from a precise (SCIP) index. Used as they are.
 *
 * An interface that extends another one passes its implementers on to it (whoever implements `ReadCloser`
 * implements `Reader`). Overriding a method of a base class is an `extends` relation, not an implementation:
 * `overridesOf` and `overriddenBy` (below) answer it for the languages whose calls dispatch at run time.
 */
import { dirOf, type IndexModel } from "./index-model.js";
import type { IndexedSymbol, Reference, SymbolId } from "./schema.js";
import { cmp } from "./util.js";

export interface Implementation {
  /** The implementing symbol (`implementationsOf`) or the implemented one (`implementedBy`). */
  id: SymbolId;
  /** How sure the index is: the resolution of the `implements` reference the answer rests on. */
  resolution: Reference["resolution"];
}

/** Members that can implement or be implemented: methods, and fields / properties. */
const MEMBER_KINDS: ReadonlySet<IndexedSymbol["kind"]> = new Set(["method", "variable"]);

/** Last segment of a symbol path without a duplicate suffix (`Runner.dispatch~2` -> `dispatch`). */
function nameOf(path: string): string {
  return path.slice(path.lastIndexOf(".") + 1).replace(/~\d+$/, "");
}

function parentPathOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(0, dot);
}

/** The file itself, then the other files of its directory that have the same language (a Go package). */
function neighbours(index: IndexModel, file: string): string[] {
  const language = index.file(file)?.language;
  const siblings = index.dirChildren(dirOf(file)).files.filter((f) => {
    return f !== file && index.file(f)?.language === language;
  });
  return [file, ...siblings];
}

/** The symbol `path` in `file`, or in the files next to it (Go declares methods anywhere in the package). */
function findNear(index: IndexModel, file: string, path: string): IndexedSymbol | undefined {
  for (const candidate of neighbours(index, file)) {
    const sym = index.symbolAt(candidate, path);
    if (sym) return sym;
  }
  return undefined;
}

/** The type a member belongs to: its parent symbol, else the type of that name declared next to it. */
function ownerOf(index: IndexModel, sym: IndexedSymbol): IndexedSymbol | undefined {
  const parent = index.parentSymbol(sym.id);
  if (parent) return parent;
  const path = parentPathOf(sym.path);
  return path === "" ? undefined : findNear(index, sym.file, path);
}

/** `type` and the interfaces it extends, transitively. */
function interfaceClosure(index: IndexModel, type: IndexedSymbol): IndexedSymbol[] {
  const out: IndexedSymbol[] = [];
  const seen = new Set<SymbolId>();
  const visit = (sym: IndexedSymbol): void => {
    if (seen.has(sym.id)) return;
    seen.add(sym.id);
    out.push(sym);
    for (const ref of index.refsFrom(sym.id)) {
      if (ref.kind !== "extends") continue;
      const target = index.symbol(ref.to);
      if (target?.kind === "interface") visit(target);
    }
  };
  visit(type);
  return out;
}

/** The types that implement `typeId`, directly or through an interface that extends it. */
function implementers(index: IndexModel, typeId: SymbolId): Implementation[] {
  const out = new Map<SymbolId, Implementation>();
  const seen = new Set<SymbolId>();
  const visit = (id: SymbolId): void => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const ref of index.refsTo(id)) {
      const from = index.symbol(ref.from);
      if (!from) continue;
      if (ref.kind === "implements") add(out, from.id, ref.resolution);
      else if (ref.kind === "extends" && from.kind === "interface") visit(from.id);
    }
  };
  visit(typeId);
  return [...out.values()];
}

/** Keeps the better resolution when an id is found twice. */
function add(
  out: Map<SymbolId, Implementation>,
  id: SymbolId,
  resolution: Implementation["resolution"],
) {
  const known = out.get(id);
  if (!known || (known.resolution === "heuristic" && resolution === "precise")) {
    out.set(id, { id, resolution });
  }
}

function sorted(
  index: IndexModel,
  out: Map<SymbolId, Implementation>,
  skip: SymbolId,
): Implementation[] {
  return [...out.values()]
    .filter((impl) => impl.id !== skip)
    .sort((a, b) => {
      const x = index.symbol(a.id);
      const y = index.symbol(b.id);
      return (
        cmp(x?.file ?? "", y?.file ?? "") ||
        (x?.range.startLine ?? 0) - (y?.range.startLine ?? 0) ||
        cmp(a.id, b.id)
      );
    });
}

/**
 * What implements `id`, sorted by file and line: for an interface (or any type) its implementers; for a
 * method or property of one, the same-named members of the implementing types, plus the members that
 * member-level `implements` references name. Empty for anything that nothing implements.
 */
export function implementationsOf(index: IndexModel, id: SymbolId): Implementation[] {
  const sym = index.symbol(id);
  if (!sym) return [];
  const out = new Map<SymbolId, Implementation>();
  // member-level references into it, and type-level ones (with the interfaces that extend it)
  for (const ref of index.refsTo(id)) {
    if (ref.kind === "implements" && index.symbol(ref.from)) add(out, ref.from, ref.resolution);
  }
  if (!MEMBER_KINDS.has(sym.kind)) {
    for (const impl of implementers(index, id)) add(out, impl.id, impl.resolution);
    return sorted(index, out, id);
  }
  const owner = ownerOf(index, sym);
  if (owner) {
    const name = nameOf(sym.path);
    for (const impl of implementers(index, owner.id)) {
      const type = index.symbol(impl.id);
      const member = type ? findNear(index, type.file, `${type.path}.${name}`) : undefined;
      if (member) add(out, member.id, impl.resolution);
    }
  }
  return sorted(index, out, id);
}

/**
 * What `id` implements, sorted by file and line: for a method or property, the interface members it
 * implements (member-level references, or the same-named member of an interface its type implements); for a
 * type, the interfaces it implements. Empty when it implements nothing.
 */
export function implementedBy(index: IndexModel, id: SymbolId): Implementation[] {
  const sym = index.symbol(id);
  if (!sym) return [];
  const out = new Map<SymbolId, Implementation>();
  for (const ref of index.refsFrom(id)) {
    if (ref.kind === "implements" && index.symbol(ref.to)) add(out, ref.to, ref.resolution);
  }
  if (MEMBER_KINDS.has(sym.kind)) {
    const owner = ownerOf(index, sym);
    if (owner) {
      const name = nameOf(sym.path);
      for (const ref of index.refsFrom(owner.id)) {
        const iface = ref.kind === "implements" ? index.symbol(ref.to) : undefined;
        if (!iface) continue;
        for (const type of interfaceClosure(index, iface)) {
          const member = index.symbolAt(type.file, `${type.path}.${name}`);
          if (member) add(out, member.id, ref.resolution);
        }
      }
    }
  }
  return sorted(index, out, id);
}

// ─── Overrides ────────────────────────────────────────────────────────────────────────────────────

/**
 * Languages whose method calls dispatch on the class of the object at run time, so that a call of a base class's
 * method may run a subclass's override (TS / JS, Python). Go is not one: embedding promotes methods, and a call
 * on the embedded type never runs the outer type's method of the same name.
 */
const VIRTUAL_LANGUAGES: ReadonlySet<string> = new Set([
  "typescript",
  "tsx",
  "javascript",
  "python",
]);

/** Constructors are not overridden in this sense: `new Base()` or `super().__init__()` never runs a subclass's. */
const CONSTRUCTORS: ReadonlySet<string> = new Set(["constructor", "__init__", "__new__"]);

/** The class a method of a dispatching language belongs to, and the method's name; undefined otherwise. */
function overridable(
  index: IndexModel,
  sym: IndexedSymbol,
): { owner: IndexedSymbol; name: string } | undefined {
  if (sym.kind !== "method" || !VIRTUAL_LANGUAGES.has(index.file(sym.file)?.language ?? "")) return;
  const name = nameOf(sym.path);
  if (CONSTRUCTORS.has(name)) return undefined;
  const owner = index.parentSymbol(sym.id);
  return owner?.kind === "class" ? { owner, name } : undefined;
}

/**
 * The methods of subclasses (transitively) that override `id`, a method of a class, sorted by file and line. A
 * call of `id` may run any of them. Empty for anything else, and for Go.
 */
export function overridesOf(index: IndexModel, id: SymbolId): Implementation[] {
  const sym = index.symbol(id);
  const target = sym ? overridable(index, sym) : undefined;
  if (!target) return [];
  const out = new Map<SymbolId, Implementation>();
  const seen = new Set<SymbolId>([target.owner.id]);
  const visit = (cls: SymbolId, resolution: Implementation["resolution"]): void => {
    for (const ref of index.refsTo(cls)) {
      if (ref.kind !== "extends") continue;
      const sub = index.symbol(ref.from);
      if (sub?.kind !== "class" || seen.has(sub.id)) continue;
      seen.add(sub.id);
      const via =
        resolution === "precise" && ref.resolution === "precise" ? "precise" : "heuristic";
      const member = index.symbolAt(sub.file, `${sub.path}.${target.name}`);
      if (member?.kind === "method") add(out, member.id, via);
      visit(sub.id, via);
    }
  };
  visit(target.owner.id, "precise");
  return sorted(index, out, id);
}

/**
 * The method that `id` overrides: the nearest base class (breadth first, bases in their order) that has a
 * method of that name. At most one; empty for anything else, and for Go.
 */
export function overriddenBy(index: IndexModel, id: SymbolId): Implementation[] {
  const sym = index.symbol(id);
  const target = sym ? overridable(index, sym) : undefined;
  if (!target) return [];
  const seen = new Set<SymbolId>([target.owner.id]);
  let level: { cls: IndexedSymbol; resolution: Implementation["resolution"] }[] = [
    { cls: target.owner, resolution: "precise" },
  ];
  while (level.length > 0) {
    const next: typeof level = [];
    for (const { cls, resolution } of level) {
      for (const ref of index.refsFrom(cls.id)) {
        if (ref.kind !== "extends") continue;
        const base = index.symbol(ref.to);
        if (base?.kind !== "class" || seen.has(base.id)) continue;
        seen.add(base.id);
        const via =
          resolution === "precise" && ref.resolution === "precise" ? "precise" : "heuristic";
        const member = index.symbolAt(base.file, `${base.path}.${target.name}`);
        if (member?.kind === "method") return [{ id: member.id, resolution: via }];
        next.push({ cls: base, resolution: via });
      }
    }
    level = next;
  }
  return [];
}
