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
  type IndexModel,
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
      if (inside.has(direction === "out" ? ref.to : ref.from)) continue;
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
export function refLine(entry: RefEntry, showFrom = false): string {
  const from = showFrom ? ` in ${entry.from}` : "";
  return `${entry.kind}  ${entry.id}  (${entry.file}:${linesText(entry.site)}, ${entry.resolution})  ${offsetText(entry.offset)}${from}`;
}

/** Does an outgoing entry of `subject` need its referencing symbol spelled out? */
export function needsFrom(entry: RefEntry, direction: RefDirection, subject: string): boolean {
  return direction === "out" && entry.from !== subject;
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
  entry: RefEntry;
  /** `seen`: expanded elsewhere in this tree; `cycle`: an ancestor of this line. */
  note?: "seen" | "cycle";
  children?: RefNode[];
}

export interface RefTree {
  nodes: RefNode[];
  /** Number of references of the subject itself (the first level), before any limit. */
  total: number;
  /** Lines were dropped because of the limit. */
  truncated: boolean;
}

/**
 * The reference tree of `target` to `depth` levels: each entry's other end is expanded in turn
 * (its own outgoing or incoming references), once per element. `limit` caps the number of entries.
 */
export function buildRefTree(
  model: IndexModel,
  target: Target,
  direction: RefDirection,
  opts: { depth: number; kinds?: ReadonlySet<RefKind>; limit: number },
): RefTree {
  const state = {
    budget: opts.limit > 0 ? opts.limit : Number.POSITIVE_INFINITY,
    truncated: false,
    expanded: new Set<string>([target.id]),
    path: new Set<string>([target.id]),
  };
  let total = 0;
  const expand = (current: Target, depth: number): RefNode[] => {
    const nodes: RefNode[] = [];
    const entries = collectRefs(model, current, direction, opts.kinds);
    if (current === target) total = entries.length;
    for (const entry of entries) {
      if (state.budget <= 0) {
        state.truncated = true;
        break;
      }
      state.budget--;
      const node: RefNode = { entry };
      if (depth > 1) {
        if (state.path.has(entry.id)) node.note = "cycle";
        else if (state.expanded.has(entry.id)) node.note = "seen";
        else {
          state.expanded.add(entry.id);
          state.path.add(entry.id);
          try {
            node.children = expand(resolveTarget(model, entry.id), depth - 1);
          } catch {
            // an endpoint that is not in the index (stale ids): leave it unexpanded
          }
          state.path.delete(entry.id);
        }
      }
      nodes.push(node);
    }
    return nodes;
  };
  const nodes = expand(target, opts.depth);
  return { nodes, total, truncated: state.truncated };
}

export function renderRefTree(
  nodes: readonly RefNode[],
  direction: RefDirection,
  subject: string,
  indent = 1,
): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    const note =
      node.note === "seen" ? "  (expanded above)" : node.note === "cycle" ? "  (cycle)" : "";
    const line = refLine(node.entry, needsFrom(node.entry, direction, subject));
    out.push(`${"  ".repeat(indent)}${line}${note}`);
    if (node.children) {
      out.push(...renderRefTree(node.children, direction, node.entry.id, indent + 1));
    }
  }
  return out;
}

/** JSON form of a tree: entries with their children. */
export function refTreeJson(nodes: readonly RefNode[]): unknown[] {
  return nodes.map((node) => ({
    ...node.entry,
    ...(node.note ? { note: node.note } : {}),
    ...(node.children ? { children: refTreeJson(node.children) } : {}),
  }));
}
