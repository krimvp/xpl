import type { DerivedEdge, DerivedGraph } from "@xpl/core";
import { drawnEdges } from "./drawnEdges.js";

/**
 * A map as a dependency matrix (MatrixView): one row and one column per box, and in cell (row, column) the
 * arrows from the row's box to the column's. The same arrows the map draws, so a cell selects what an arrow
 * selects. A last row and column, "Outside this map", hold the map's lines out of it (its stubs), by box.
 *
 * The order (`boxOrder`, shared with the parts list): a box comes before the boxes it uses, so the arrows of
 * a map without cycles all lie above the diagonal. Only an arrow of a real cycle lies below it, and then
 * the cycle's other arrows lie above.
 */
export interface MatrixBox {
  id: string;
  label: string;
  /** The label of the container the box is drawn in, if any. */
  group?: string;
}

export interface MatrixCell {
  /** The arrows the map draws for this pair (normally one): what a click selects. */
  select: string[];
  /** Every derived or stored arrow of the pair, merged or not: the caret lights the cell when it is on any. */
  ids: string[];
  /** References behind the cell: the code links the map counts on its arrow. */
  count: number;
  /** Every arrow drawn here is one the author added (its count is not a count of references). */
  authored: boolean;
  /** The kinds of the pair's arrows ("calls", "imports"), each once, in the order met. */
  kinds: string[];
  /** One trust label for the cell: `mixed` only when precise and heuristic references meet in it. */
  resolution: DerivedEdge["resolution"];
  /** What the arrows say, as on the map: an authored label, else the kind and count ("calls ×3"). */
  text: string;
  /** The row comes after the column: the arrow goes back against the order. */
  back: boolean;
}

/** A box's lines out of the map, or into it: the stubs the map draws to its dashed boxes. */
export interface MatrixOutside {
  /** The stub ids (what a click selects, as on the map). */
  select: string[];
  count: number;
  kinds: string[];
  /** "calls & imports ×12", the map's own words for a stub. */
  text: string;
}

export interface Matrix {
  boxes: MatrixBox[];
  /** `cells[row][column]`, `undefined` where no arrow joins the two. */
  cells: (MatrixCell | undefined)[][];
  /** Per row: what the box uses outside this map. Empty when the map has no line out of it. */
  out: (MatrixOutside | undefined)[];
  /** Per column: what outside this map uses the box. */
  in: (MatrixOutside | undefined)[];
}

export function buildMatrix(graph: DerivedGraph, include: readonly string[] = []): Matrix {
  const labels = new Map(graph.nodes.map((node) => [node.id, node.label]));
  const ends = new Set(graph.edges.flatMap((edge) => [edge.from, edge.to]));
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  // A container is a frame on the map; it gets a row only when an arrow ends on it.
  const ids = boxOrder(graph, include).filter((id) => !byId.get(id)!.container || ends.has(id));
  const boxes = ids.map((id): MatrixBox => {
    const parent = byId.get(id)!.parent;
    const group = parent === undefined ? undefined : labels.get(parent);
    return { id, label: labels.get(id)!, ...(group !== undefined ? { group } : {}) };
  });

  const at = new Map(ids.map((id, i) => [id, i]));
  const cells: (MatrixCell | undefined)[][] = ids.map(() => ids.map(() => undefined));
  const cellOf = (edge: DerivedEdge): MatrixCell | undefined => {
    const r = at.get(edge.from);
    const c = at.get(edge.to);
    if (r === undefined || c === undefined || r === c) return undefined;
    return (cells[r]![c] ??= {
      select: [],
      ids: [],
      count: 0,
      authored: true,
      kinds: [],
      text: "",
      resolution: edge.resolution,
      back: r > c,
    });
  };
  // the drawn arrows first: they set the cell's trust label
  for (const edge of drawnEdges(graph.edges)) {
    const cell = cellOf(edge);
    if (!cell) continue;
    if (cell.select.length > 0) cell.resolution = joinTrust(cell.resolution, edge.resolution);
    cell.select.push(edge.id);
    cell.count += edge.count;
    cell.authored &&= AUTHORED.has(edge.resolution);
    const text = edge.label ?? `${edge.kind} ×${edge.count}`;
    cell.text = cell.text ? `${cell.text}; ${text}` : text;
  }
  // then every arrow of the pair, those the map leaves out for an authored arrow included
  for (const edge of graph.edges) {
    const cell = cellOf(edge);
    if (!cell) continue;
    cell.ids.push(edge.id);
    if (!cell.kinds.includes(edge.kind)) cell.kinds.push(edge.kind);
  }

  const out: (MatrixOutside | undefined)[] = ids.map(() => undefined);
  const into: (MatrixOutside | undefined)[] = ids.map(() => undefined);
  for (const stub of graph.stubs) {
    const i = at.get(stub.inside);
    if (i === undefined) continue;
    const side = stub.direction === "out" ? out : into;
    const sum = (side[i] ??= { select: [], count: 0, kinds: [], text: "" });
    sum.select.push(stub.id);
    sum.count += stub.count;
    for (const kind of stub.kinds) if (!sum.kinds.includes(kind)) sum.kinds.push(kind);
    sum.text = `${sum.kinds.join(" & ")} ×${sum.count}`;
  }
  return { boxes, cells, out, in: into };
}

/** Trust labels of arrows the author added: the cell shows a mark, not a count of references. */
const AUTHORED = new Set<DerivedEdge["resolution"]>(["llm", "user", "static"]);
/** Found in the code by references: two of them that disagree make `mixed`. */
const FOUND = new Set<DerivedEdge["resolution"]>(["precise", "heuristic", "mixed"]);
/** Otherwise the cell says the weaker word: matched by name before the author's word before found. */
const WEAKEST_FIRST: DerivedEdge["resolution"][] = [
  "heuristic",
  "mixed",
  "user",
  "llm",
  "static",
  "precise",
];

/**
 * The trust of two arrows in one cell. `mixed` means precise and heuristic references together, never two
 * authored arrows (an `llm` and a `user` one are not "partly matched by name").
 */
export function joinTrust(
  a: DerivedEdge["resolution"],
  b: DerivedEdge["resolution"],
): DerivedEdge["resolution"] {
  if (a === b) return a;
  if (FOUND.has(a) && FOUND.has(b)) return "mixed";
  return WEAKEST_FIRST.indexOf(a) <= WEAKEST_FIRST.indexOf(b) ? a : b;
}

/**
 * The reading order of a map's boxes: the one order the matrix's rows and the parts list ("On this map")
 * share. A container's boxes follow it, together. Among the boxes of one level, a box comes before the boxes
 * it uses (an arrow between their contents counts for them); boxes that use each other, directly or round a
 * loop, are taken as one (strongly connected components, Tarjan) and only their own arrows can go back up the
 * order. Wherever the arrows leave a choice, the author's order (`include`) decides, then the graph's.
 */
export function boxOrder(graph: DerivedGraph, include: readonly string[] = []): string[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const listed = new Map<string, number>();
  include.forEach((id, i) => listed.has(id) || listed.set(id, i));
  const place = new Map(graph.nodes.map((node, i) => [node.id, i]));
  const rank = (id: string) => [listed.get(id) ?? Number.MAX_SAFE_INTEGER, place.get(id)!] as const;
  const before = (a: string, b: string) => {
    const [x, y] = [rank(a), rank(b)];
    return x[0] - y[0] || x[1] - y[1];
  };
  const parentOf = (id: string) => {
    const parent = byId.get(id)?.parent;
    return parent !== undefined && byId.has(parent) ? parent : undefined;
  };
  const children = new Map<string | undefined, string[]>();
  for (const node of graph.nodes) {
    const parent = parentOf(node.id);
    const list = children.get(parent);
    if (list) list.push(node.id);
    else children.set(parent, [node.id]);
  }
  /** The ancestor of `id` (or `id`) that is a child of `parent`. */
  const under = (id: string, parent: string | undefined): string | undefined => {
    for (let at: string | undefined = id; at !== undefined; at = parentOf(at))
      if (parentOf(at) === parent) return at;
    return undefined;
  };

  const out: string[] = [];
  const walk = (parent: string | undefined) => {
    const level = [...(children.get(parent) ?? [])].sort(before);
    const uses = new Map<string, Set<string>>(level.map((id) => [id, new Set()]));
    for (const edge of graph.edges) {
      const from = under(edge.from, parent);
      const to = under(edge.to, parent);
      if (from !== undefined && to !== undefined && from !== to) uses.get(from)!.add(to);
    }
    for (const id of orderLevel(level, uses)) {
      out.push(id);
      walk(id);
    }
  };
  walk(undefined);
  return out;
}

/**
 * One level's boxes (`level` in the author's order), users before what they use. The components that use
 * each other come out of Tarjan's algorithm; they are placed users first, the earliest listed of the ready
 * ones each time. Inside a component the box with the fewest users still to place goes first, so its loop's
 * closing arrow is the one that goes back.
 */
function orderLevel(
  level: readonly string[],
  uses: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  const index = new Map(level.map((id, i) => [id, i]));
  const component = new Map<string, number>();
  const components: string[][] = [];
  // Tarjan's strongly connected components
  const low = new Map<string, number>();
  const seen = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const visit = (id: string) => {
    seen.set(id, seen.size);
    low.set(id, seen.get(id)!);
    stack.push(id);
    onStack.add(id);
    for (const next of uses.get(id)!) {
      if (!seen.has(next)) {
        visit(next);
        low.set(id, Math.min(low.get(id)!, low.get(next)!));
      } else if (onStack.has(next)) low.set(id, Math.min(low.get(id)!, seen.get(next)!));
    }
    if (low.get(id) === seen.get(id)) {
      const members: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.set(member, components.length);
        members.push(member);
      } while (member !== id);
      components.push(members.sort((a, b) => index.get(a)! - index.get(b)!));
    }
  };
  for (const id of level) if (!seen.has(id)) visit(id);

  // the components, users first (Kahn), the earliest listed ready one each time
  const waiting = components.map(() => 0);
  const next = components.map(() => new Set<number>());
  for (const [from, targets] of uses)
    for (const to of targets) {
      const [a, b] = [component.get(from)!, component.get(to)!];
      if (a !== b && !next[a]!.has(b)) {
        next[a]!.add(b);
        waiting[b]! += 1;
      }
    }
  const first = (members: readonly string[]) => index.get(members[0]!)!;
  const ready = components.map((_, i) => i).filter((i) => waiting[i] === 0);
  const out: string[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => first(components[a]!) - first(components[b]!));
    const taken = ready.shift()!;
    out.push(...withinCycle(components[taken]!, uses));
    for (const b of next[taken]!) if (--waiting[b]! === 0) ready.push(b);
  }
  return out;
}

/** The boxes of one loop: the one with the fewest users still to place first, the listed order on a tie. */
function withinCycle(
  members: readonly string[],
  uses: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  if (members.length === 1) return [...members];
  const left = new Set(members);
  const users = (id: string) => members.filter((m) => left.has(m) && uses.get(m)!.has(id)).length;
  const out: string[] = [];
  while (left.size > 0) {
    let best: string | undefined;
    let fewest = Infinity;
    for (const id of left) {
      const count = users(id);
      if (count < fewest) [best, fewest] = [id, count];
    }
    left.delete(best!);
    out.push(best!);
  }
  return out;
}
