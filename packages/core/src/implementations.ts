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
 * implements `Reader`). Overriding a method of a base class is an `extends` relation, not an implementation,
 * and is not covered.
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
