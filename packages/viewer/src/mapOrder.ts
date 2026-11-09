/**
 * a11y: how the keyboard and a screen reader meet the boxes of a map (GraphView): in reading order, by a name
 * that starts with the label.
 */

/** Boxes whose tops are this close count as one row. */
const ROW_SLACK = 8;

/**
 * Boxes in reading order, top-down then left to right: the order Tab takes them in (the layout's own order is
 * not what the reader sees).
 */
export function readingOrder<T extends { x: number; y: number }>(nodes: readonly T[]): T[] {
  return [...nodes].sort((a, b) => (Math.abs(a.y - b.y) > ROW_SLACK ? a.y - b.y : a.x - b.x));
}

/** A box's accessible name: its label first, then what it is, then what a change did ("Fetch API, built-in fetch"). */
export function boxName(label: string, kind?: string, change?: string): string {
  return [label, kind, change].filter(Boolean).join(", ");
}

/**
 * The order Tab takes a map's boxes in. A data map's tables (`rows`) go in the order the map starts in (GraphView
 * `order`: the tour's first box, then the view's include list), one stop each; their rows are reached with the
 * arrow keys (D9). Any other map: reading order.
 */
export function tabOrder<T extends { id: string; x: number; y: number; rows?: boolean }>(
  nodes: readonly T[],
  order: readonly string[],
): T[] {
  const read = readingOrder(nodes);
  if (!nodes.some((node) => node.rows)) return read;
  const rank = (id: string) => {
    const i = order.indexOf(id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return read
    .map((node, i) => ({ node, i }))
    .sort((a, b) => rank(a.node.id) - rank(b.node.id) || a.i - b.i)
    .map(({ node }) => node);
}
