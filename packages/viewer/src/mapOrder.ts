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
