/**
 * References around a target, as printed by `xpl refs` and `xpl show --refs`.
 *
 * A target's references are the ones that cross its boundary: outgoing = `from` inside the target
 * (the symbol and its descendants, the file, the directory) and `to` outside; incoming the reverse.
 * Every entry carries the site as an anchor span would name it: line offsets relative to the start of
 * the referencing symbol (file line 1 for module scope), so a `call-site` anchor can be written from it.
 */
import {
  EDGE_TO_REF_KIND,
  elementIdForSymbolId,
  implementationsOf,
  implementedBy,
  overriddenBy,
  overridesOf,
  isTestFile,
  parseId,
  type IndexModel,
  type IndexedSymbol,
  type Range,
  type Reference,
} from "@xpl/core";
import { UsageError } from "./errors.js";
import { linesText, offsetText } from "./format.js";
import { resolveTarget, subtreeIds, type Target } from "./target.js";

export type RefKind = Reference["kind"];
export type RefDirection = "in" | "out";

export const REF_KINDS: readonly RefKind[] = [
  "call",
  "import",
  "extends",
  "implements",
  "type-ref",
  "read",
  "write",
];

export interface RefEntry {
  kind: RefKind;
  /** The other end as an element id (`sym:...`, or `file:...` for a module scope). */
  id: string;
  /** The referencing end (`from` of the index reference) as an element id. */
  from: string;
  to: string;
  /** The file the site lies in (the referencing symbol's file). */
  file: string;
  site: Range;
  /** Site lines as offsets from the referencing symbol's first line (module scope: from line 1). */
  offset: { from: number; to: number };
  resolution: Reference["resolution"];
}

/**
 * A hop through an interface, printed as an `impl` line: in a list of outgoing references, under a call (or
 * type use) of an interface or one of its methods, an implementation of it; in a list of incoming
 * references, the interface member that the subject implements (its own callers follow). `from` is always
 * the implementing symbol and `to` the implemented one, as in an `implements` reference; `id`, `file` and
 * `site` describe the symbol the line shows (`offset` spans all of it).
 */
export interface ImplEntry extends Omit<RefEntry, "kind"> {
  /**
   * `impl`: an interface hop. `override`: a hop through a base class (TS, JS, Python): under a call of a method,
   * the subclass methods that override it (the call may run any of them); for a method's callers, the base
   * method it overrides, with that method's callers below.
   */
  kind: "impl" | "override";
}

/** What a line of the reference tree shows: a reference, or an interface hop. */
export type TreeEntry = RefEntry | ImplEntry;

/** Reference kinds whose target, when it is an interface (member), is followed to its implementations. */
const HOP_KINDS: ReadonlySet<RefKind> = new Set<RefKind>(["call", "type-ref", "read", "write"]);

/** Implementations listed under one interface line; `--limit 0` lists them all. */
export const MAX_IMPLS_PER_HOP = 10;

/** Children listed under one line of a call hierarchy; `--max-children 0` lists them all. */
export const DEFAULT_MAX_CHILDREN = 15;

/** Parses `--kind`: reference kinds (`call`) and edge-kind spellings (`calls`) are both accepted. */
export function parseKinds(values: readonly string[]): Set<RefKind> | undefined {
  if (values.length === 0) return undefined;
  const out = new Set<RefKind>();
  for (const value of values) {
    const kind = (REF_KINDS as readonly string[]).includes(value)
      ? (value as RefKind)
      : EDGE_TO_REF_KIND[value as keyof typeof EDGE_TO_REF_KIND];
    if (!kind) {
      throw new UsageError(`unknown reference kind "${value}" (expected: ${REF_KINDS.join(", ")})`);
    }
    out.add(kind);
  }
  return out;
}

function toEntry(model: IndexModel, ref: Reference, direction: RefDirection): RefEntry {
  const symbol = model.symbol(ref.from);
  const base = symbol ? symbol.range.startLine : 1;
  const file =
    model.fileOfSymbolId(ref.from) ?? ref.from.slice(0, Math.max(0, ref.from.indexOf("#")));
  return {
    kind: ref.kind,
    id: elementIdForSymbolId(direction === "out" ? ref.to : ref.from),
    from: elementIdForSymbolId(ref.from),
    to: elementIdForSymbolId(ref.to),
    file,
    site: { ...ref.site },
    offset: {
      from: Math.max(0, ref.site.startLine - base),
      to: Math.max(0, ref.site.endLine - base),
    },
    resolution: ref.resolution,
  };
}

/** Source order: file, then line and column. */
function bySite(a: RefEntry, b: RefEntry): number {
  return (
    (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
    a.site.startLine - b.site.startLine ||
    (a.site.startCol ?? 0) - (b.site.startCol ?? 0) ||
    a.site.endLine - b.site.endLine ||
    (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

export function collectRefs(
  model: IndexModel,
  target: Target,
  direction: RefDirection,
  kinds?: ReadonlySet<RefKind>,
): RefEntry[] {
  const ids = subtreeIds(model, target);
  const inside = new Set(ids);
  const out: RefEntry[] = [];
  for (const id of ids) {
    for (const ref of direction === "out" ? model.refsFrom(id) : model.refsTo(id)) {
      // a call of the target symbol to itself (recursion) is listed; other references inside it are not,
      // the recursion of a function nested in it included
      const recursion =
        target.type === "symbol" && ref.from === target.symbolId && ref.to === ref.from;
      if (!recursion && inside.has(direction === "out" ? ref.to : ref.from)) continue;
      if (kinds && !kinds.has(ref.kind)) continue;
      out.push(toEntry(model, ref, direction));
    }
  }
  return out.sort(bySite);
}

/** Groups by kind (in `REF_KINDS` order), keeping source order inside each kind. */
export function groupByKind(entries: readonly RefEntry[]): RefEntry[] {
  const order = new Map(REF_KINDS.map((kind, i) => [kind, i] as const));
  return entries
    .map((entry, i) => ({ entry, i }))
    .sort((a, b) => order.get(a.entry.kind)! - order.get(b.entry.kind)! || a.i - b.i)
    .map((x) => x.entry);
}

/**
 * `call  sym:src/queue.ts#Queue.requeue  (src/runner.ts:76-78, heuristic)  +34..36`: the line format of
 * ARCHITECTURE.md §5 (`kind  target-id  (site file:line, resolution)`) plus the site's line offsets
 * inside the referencing symbol, which is what a call-site anchor's span uses. `showFrom` names that
 * symbol (`... +34..36 in sym:src/runner.ts#Runner.dispatch`); it is needed for outgoing references of
 * a file, directory or class, where the sites lie in different symbols. (For incoming references the
 * printed id is the referencing symbol itself, and for a method's outgoing references it is the subject.)
 */
export function refLine(entry: TreeEntry, showFrom = false): string {
  if (entry.kind === "impl" || entry.kind === "override") {
    return `${entry.kind}  ${entry.id}  (${entry.file}:${linesText(entry.site)}, ${entry.resolution})`;
  }
  const from = showFrom ? ` in ${entry.from}` : "";
  return `${entry.kind}  ${entry.id}  (${entry.file}:${linesText(entry.site)}, ${entry.resolution})  ${offsetText(entry.offset)}${from}`;
}

/** Does an outgoing entry of `subject` need its referencing symbol spelled out? */
export function needsFrom(entry: TreeEntry, direction: RefDirection, subject: string): boolean {
  return (
    direction === "out" &&
    entry.kind !== "impl" &&
    entry.kind !== "override" &&
    entry.from !== subject
  );
}

export function countByKind(entries: readonly RefEntry[]): string {
  const counts = new Map<RefKind, number>();
  for (const entry of entries) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
  return REF_KINDS.filter((kind) => counts.has(kind))
    .map((kind) => `${kind} ${counts.get(kind)}`)
    .join(", ");
}

// ─── Call hierarchy ─────────────────────────────────────────────────────────────────────────────

export interface RefNode {
  entry: TreeEntry;
  /** `seen`: expanded above, as far down as this line would be; `cycle`: an ancestor of this line. */
  note?: "seen" | "cycle";
  children?: RefNode[];
  /** Implementations under this line that were cut (`MAX_IMPLS_PER_HOP`). */
  moreImpls?: number;
  /** References under this line that were left out (`maxChildren`). */
  moreChildren?: number;
}

export interface RefTree {
  nodes: RefNode[];
  /** Number of references of the subject itself (the first level), before any limit. */
  total: number;
  /** Lines were dropped because of the limit. */
  truncated: boolean;
  /** First-level `impl` lines (incoming: the interface members the subject implements). */
  hops: number;
  /** Implementations that were left out because they sit in test files (`--tests` shows them). */
  hiddenTests: number;
  /** The same for overrides (subclass methods in test files). */
  hiddenTestOverrides: number;
  /** First-level references left out because of `maxChildren` (only for a hierarchy: `depth` 2 or more). */
  more: number;
}

function symbolOf(model: IndexModel, elementId: string): IndexedSymbol | undefined {
  const parsed = parseId(elementId);
  return parsed.type === "symbol" ? model.symbol(parsed.symbolId) : undefined;
}

/** The `impl` line for a hop: `direction` says which of the two symbols the line shows. */
function implEntry(
  direction: RefDirection,
  implementer: IndexedSymbol,
  implemented: IndexedSymbol,
  resolution: Reference["resolution"],
  kind: ImplEntry["kind"] = "impl",
): ImplEntry {
  const shown = direction === "out" ? implementer : implemented;
  return {
    kind,
    id: `sym:${shown.id}`,
    from: `sym:${implementer.id}`,
    to: `sym:${implemented.id}`,
    file: shown.file,
    site: { startLine: shown.range.startLine, endLine: shown.range.endLine },
    offset: { from: 0, to: shown.range.endLine - shown.range.startLine },
    resolution,
  };
}

/**
 * The reference tree of `target` to `depth` levels: each entry's other end is expanded in turn
 * (its own outgoing or incoming references), once per element. `limit` caps the number of entries.
 *
 * Interfaces are transparent (`impl` lines, see `ImplEntry`). An outgoing reference to an interface or one
 * of its members gets its implementations listed under it (test doubles are left out unless `opts.tests`,
 * or the reference itself lies in a test file); with `depth > 1` they are expanded in place of the
 * declaration, which has no body of its own. For incoming references, a method that implements an
 * interface method gets that method as a first-level `impl` line, with the callers of the interface method
 * below it. Hops cost no depth.
 *
 * A subtree is printed once: an element expanded above is not expanded again (its later lines are marked
 * `seen`, unless nothing was listed below it above), unless the earlier expansion went less deep than this one
 * would (it was met on the last levels first), and then the deeper one is printed too. `maxChildren` (0 or absent: no cap) lists at most that many
 * references under a line, the rest are counted (`moreChildren`); the subject's own list is capped only for a
 * hierarchy (`depth` 2 or more), a flat list is cut by `limit` alone.
 */
export function buildRefTree(
  model: IndexModel,
  target: Target,
  direction: RefDirection,
  opts: {
    depth: number;
    kinds?: ReadonlySet<RefKind>;
    limit: number;
    tests?: boolean;
    maxChildren?: number;
  },
): RefTree {
  const state = {
    budget: opts.limit > 0 ? opts.limit : Number.POSITIVE_INFINITY,
    truncated: false,
    /** Element id -> the depth it was expanded to (levels below it that were listed). */
    expanded: new Map<string, number>([[target.id, opts.depth]]),
    /** Elements expanded above with nothing below them: a repeat of one has no subtree that was printed above. */
    leaves: new Set<string>(),
    path: new Set<string>([target.id]),
    hopped: new Set<string>(),
    hiddenTests: 0,
    hiddenTestOverrides: 0,
  };
  const cap = opts.maxChildren !== undefined && opts.maxChildren > 0 ? opts.maxChildren : Infinity;
  let total = 0;
  let hops = 0;
  let rootMore = 0;

  /** Expands `id` (an element id) below a node, once per element (and depth). */
  const expandId = (node: RefNode, id: string, depth: number): void => {
    if (state.path.has(id)) node.note = "cycle";
    else if (state.leaves.has(id)) return;
    else if ((state.expanded.get(id) ?? 0) >= depth) node.note = "seen";
    else {
      state.expanded.set(id, depth);
      state.path.add(id);
      try {
        const found = expand(resolveTarget(model, id), depth);
        node.children = found.nodes;
        if (found.more > 0) node.moreChildren = found.more;
        else if (found.nodes.length === 0) state.leaves.add(id);
      } catch {
        // an endpoint that is not in the index (stale ids): leave it unexpanded
      }
      state.path.delete(id);
    }
  };

  /** Outgoing: the implementations of the interface (member) an entry points at, as children of its node. */
  const addImplementations = (node: RefNode, depth: number): void => {
    const shown = symbolOf(model, node.entry.id);
    if (!shown) return;
    const impls: { id: string; resolution: Reference["resolution"]; kind: ImplEntry["kind"] }[] = [
      ...implementationsOf(model, shown.id).map((i) => ({ ...i, kind: "impl" as const })),
      ...(node.entry.kind === "call"
        ? overridesOf(model, shown.id).map((i) => ({ ...i, kind: "override" as const }))
        : []),
    ];
    if (impls.length === 0) return;
    if (state.hopped.has(node.entry.id)) {
      node.note ??= "seen";
      return;
    }
    state.hopped.add(node.entry.id);
    // Test doubles are noise for production code that calls the interface, and the point when a test does.
    const showTests =
      opts.tests === true ||
      (node.entry.kind !== "impl" && node.entry.kind !== "override" && isTestFile(node.entry.file));
    const visible = impls.filter((impl) => {
      const symbol = model.symbol(impl.id);
      if (!symbol) return false;
      if (!showTests && isTestFile(symbol.file)) {
        if (impl.kind === "override") state.hiddenTestOverrides++;
        else state.hiddenTests++;
        return false;
      }
      return true;
    });
    const listed = opts.limit > 0 ? visible.slice(0, MAX_IMPLS_PER_HOP) : visible;
    if (listed.length < visible.length) node.moreImpls = visible.length - listed.length;
    for (const impl of listed) {
      if (state.budget <= 0) {
        state.truncated = true;
        break;
      }
      state.budget--;
      const child: RefNode = {
        entry: implEntry("out", model.symbol(impl.id)!, shown, impl.resolution, impl.kind),
      };
      if (depth > 1) expandId(child, child.entry.id, depth - 1);
      (node.children ??= []).push(child);
    }
  };

  /** Incoming: the interface members `current` implements, each with the callers of that member below. */
  const interfaceHops = (current: Target, depth: number): RefNode[] => {
    // members only: the callers of the interface method are what the reader is after
    if (current.type !== "symbol" || !["method", "variable"].includes(current.symbol.kind))
      return [];
    const out: RefNode[] = [];
    const hops = [
      ...implementedBy(model, current.symbolId).map((i) => ({ ...i, kind: "impl" as const })),
      ...overriddenBy(model, current.symbolId).map((i) => ({ ...i, kind: "override" as const })),
    ];
    for (const impl of hops) {
      const implemented = model.symbol(impl.id);
      if (!implemented) continue;
      if (state.budget <= 0) {
        state.truncated = true;
        break;
      }
      state.budget--;
      const node: RefNode = {
        entry: implEntry("in", current.symbol, implemented, impl.resolution, impl.kind),
      };
      if (state.hopped.has(node.entry.id)) node.note = "seen";
      else if (state.path.has(node.entry.id)) node.note = "cycle";
      else {
        state.hopped.add(node.entry.id);
        state.path.add(node.entry.id);
        const found = expand(resolveTarget(model, node.entry.id), depth, true);
        node.children = found.nodes;
        if (found.more > 0) node.moreChildren = found.more;
        state.path.delete(node.entry.id);
      }
      out.push(node);
    }
    return out;
  };

  const expand = (
    current: Target,
    depth: number,
    viaInterface = false,
  ): { nodes: RefNode[]; more: number } => {
    const nodes: RefNode[] = [];
    // The other implementers are siblings, not callers: leave them out of a hop's callers (unless asked for).
    const kinds =
      opts.kinds ??
      (viaInterface ? new Set(REF_KINDS.filter((k) => k !== "implements")) : undefined);
    const entries = collectRefs(model, current, direction, kinds);
    const isRoot = current === target;
    if (isRoot) total = entries.length;
    // a flat list is the whole answer (`total` says how long it is); in a hierarchy every level is capped
    const limitHere = isRoot && opts.depth <= 1 ? Infinity : cap;
    let more = 0;
    for (const entry of entries) {
      if (nodes.length >= limitHere) {
        more = entries.length - nodes.length;
        break;
      }
      if (state.budget <= 0) {
        state.truncated = true;
        break;
      }
      state.budget--;
      const node: RefNode = { entry };
      if (depth > 1) expandId(node, entry.id, depth - 1);
      if (direction === "out" && HOP_KINDS.has(entry.kind)) addImplementations(node, depth);
      nodes.push(node);
    }
    if (isRoot) rootMore = more;
    if (direction === "in") {
      const found = interfaceHops(current, depth);
      if (isRoot) hops = found.length;
      for (const hop of found) nodes.push(hop);
    }
    return { nodes, more };
  };
  const { nodes } = expand(target, opts.depth);
  return {
    nodes,
    total,
    truncated: state.truncated,
    hops,
    hiddenTests: state.hiddenTests,
    hiddenTestOverrides: state.hiddenTestOverrides,
    more: rootMore,
  };
}

export function renderRefTree(
  nodes: readonly RefNode[],
  direction: RefDirection,
  subject: string,
  indent = 1,
  /** References that a `maxChildren` cap left out of this list. */
  more = 0,
  /** The lines so far: appended to, never spread (a tree can have more lines than a call takes arguments). */
  out: string[] = [],
): string[] {
  for (const node of nodes) {
    const note =
      node.note === "seen" ? "  (expanded above)" : node.note === "cycle" ? "  (cycle)" : "";
    const hop =
      direction === "in" && node.entry.kind === "impl"
        ? "  [the interface member it implements; its callers follow]"
        : direction === "in" && node.entry.kind === "override"
          ? "  [the base method it overrides; its callers may run this one]"
          : "";
    const line = refLine(node.entry, needsFrom(node.entry, direction, subject));
    out.push(`${"  ".repeat(indent)}${line}${hop}${note}`);
    if (node.children) {
      renderRefTree(
        node.children,
        direction,
        node.entry.id,
        indent + 1,
        node.moreChildren ?? 0,
        out,
      );
    } else if (node.moreChildren) out.push(moreChildrenLine(node.moreChildren, indent + 1));
    if (node.moreImpls) {
      out.push(
        `${"  ".repeat(indent + 1)}... ${node.moreImpls} more implementations (--limit 0 lists them all)`,
      );
    }
  }
  if (more > 0) out.push(moreChildrenLine(more, indent));
  return out;
}

/** `... +5 more (--max-children 0 lists all)`: what a capped list left out. */
export function moreChildrenLine(count: number, indent: number): string {
  return `${"  ".repeat(indent)}... +${count} more (--max-children 0 lists all)`;
}

/** JSON form of a tree: entries with their children. */
export function refTreeJson(nodes: readonly RefNode[]): unknown[] {
  return nodes.map((node) => ({
    ...node.entry,
    ...(node.note ? { note: node.note } : {}),
    ...(node.moreImpls ? { moreImpls: node.moreImpls } : {}),
    ...(node.moreChildren ? { moreChildren: node.moreChildren } : {}),
    ...(node.children ? { children: refTreeJson(node.children) } : {}),
  }));
}
