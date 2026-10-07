import type { DerivedEdge } from "@xpl/core";

/**
 * The edges a map draws, fewer than it derives: a derived edge between two boxes that an authored edge already
 * joins (the same way) is left out, the authored one says it in words; and derived edges of several kinds
 * between the same two boxes become one arrow ("calls ×5 · references ×2"), under the id of the first. A
 * small map no longer gets an arrow per kind of reference.
 */
export function drawnEdges(edges: readonly DerivedEdge[]): DerivedEdge[] {
  const pair = (edge: DerivedEdge) => `${edge.from}\0${edge.to}`;
  const authored = new Set(edges.filter((edge) => edge.stored).map(pair));
  const merged = new Map<string, DerivedEdge>();
  const out: DerivedEdge[] = [];
  for (const edge of edges) {
    if (edge.stored) {
      out.push(edge);
      continue;
    }
    if (authored.has(pair(edge))) continue;
    const first = merged.get(pair(edge));
    if (!first) {
      const copy = { ...edge };
      merged.set(pair(edge), copy);
      out.push(copy);
      continue;
    }
    first.label = `${first.label ?? `${first.kind} ×${first.count}`} · ${edge.kind} ×${edge.count}`;
    first.count += edge.count;
    first.anchors = [...first.anchors, ...edge.anchors];
    if (edge.resolution !== first.resolution) first.resolution = "mixed";
  }
  // a merged arrow's label is still a count made up by the viewer, not words someone wrote
  return out.map((edge) =>
    !edge.stored && edge.label !== undefined ? { ...edge, label: edge.label } : edge,
  );
}
