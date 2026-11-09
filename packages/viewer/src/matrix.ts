import type { DerivedEdge, DerivedGraph } from "@xpl/core";
import { drawnEdges } from "./drawnEdges.js";

/**
 * A map as a dependency matrix (MatrixView): one row and one column per box, and in cell (row, column) the
 * arrows from the row's box to the column's. The same arrows the map draws, so a cell selects what an arrow
 * selects.
 *
 * The order: a box comes before the boxes it uses, so the arrows of a map without cycles all lie above the
 * diagonal. An arrow below it goes back against that order; with its mirror cell above, it is a cycle.
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
  /** References behind the cell (1 per stored arrow). */
  count: number;
  /** One trust label for the cell, `mixed` when its arrows disagree. */
  resolution: DerivedEdge["resolution"];
  /** What the arrows say, as on the map: an authored label, else the kind and count ("calls ×3"). */
  text: string;
  /** The row comes after the column: the arrow goes back against the order. */
  back: boolean;
}

export interface Matrix {
  boxes: MatrixBox[];
  /** `cells[row][column]`, `undefined` where no arrow joins the two. */
  cells: (MatrixCell | undefined)[][];
}

export function buildMatrix(graph: DerivedGraph): Matrix {
  const labels = new Map(graph.nodes.map((node) => [node.id, node.label]));
  const ends = new Set(graph.edges.flatMap((edge) => [edge.from, edge.to]));
  // A container is a frame on the map; it gets a row only when an arrow ends on it.
  const listed = graph.nodes.filter((node) => !node.container || ends.has(node.id));
  const ids = order(
    listed.map((node) => node.id),
    graph.edges,
  );
  const byId = new Map(listed.map((node) => [node.id, node]));
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
      text: "",
      resolution: edge.resolution,
      back: r > c,
    });
  };
  // the drawn arrows first: they set the cell's trust label
  for (const edge of drawnEdges(graph.edges)) {
    const cell = cellOf(edge);
    if (!cell) continue;
    cell.select.push(edge.id);
    cell.count += edge.count;
    if (edge.resolution !== cell.resolution) cell.resolution = "mixed";
    const text = edge.label ?? `${edge.kind} ×${edge.count}`;
    cell.text = cell.text ? `${cell.text}; ${text}` : text;
  }
  // then every arrow of the pair, those the map leaves out for an authored arrow included
  for (const edge of graph.edges) {
    const cell = cellOf(edge);
    if (!cell) continue;
    cell.ids.push(edge.id);
  }
  return { boxes, cells };
}

/**
 * Boxes before the boxes they use (a topological order), the listed order wherever the arrows leave a choice.
 * In a cycle, the box with the fewest arrows still to come in goes first; those arrows end up below the
 * diagonal. Quadratic in the boxes: fine for a map, which a reader can take in only below ~100 of them.
 */
function order(listed: readonly string[], edges: readonly DerivedEdge[]): string[] {
  const known = new Set(listed);
  const users = new Map<string, Set<string>>(listed.map((id) => [id, new Set()]));
  for (const edge of edges) {
    if (known.has(edge.from) && known.has(edge.to) && edge.from !== edge.to)
      users.get(edge.to)!.add(edge.from);
  }
  const left = new Set(listed);
  const out: string[] = [];
  const waiting = (id: string) => [...users.get(id)!].filter((user) => left.has(user)).length;
  while (left.size > 0) {
    let next: string | undefined;
    let fewest = Infinity;
    for (const id of left) {
      const count = waiting(id);
      if (count < fewest) [next, fewest] = [id, count];
      if (count === 0) break;
    }
    left.delete(next!);
    out.push(next!);
  }
  return out;
}
