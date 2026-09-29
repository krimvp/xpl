/**
 * Language-agnostic helpers over tree-sitter nodes and spans, shared by the framework and the packs.
 *
 * Convention (schema.ts, ARCHITECTURE.md §2.1): lines and columns are 1-based and inclusive, columns are
 * UTF-16 code units. tree-sitter (web-tree-sitter) reports 0-based rows/columns (already in UTF-16 code
 * units for string input) with an exclusive end; the helpers here convert.
 */
import type { Node } from "web-tree-sitter";
import type { Span } from "./languages/types.js";

export type { Span } from "./languages/types.js";

/**
 * Convert tree-sitter points (0-based row/column, exclusive end) to a `Span`. A node that ends at column 0
 * of a later row (it swallowed the newline, e.g. a YAML document) ends at the end of the previous line.
 */
export function pointsToSpan(
  startRow: number,
  startColumn: number,
  endRow: number,
  endColumn: number,
  lines: readonly string[],
): Span {
  let lastRow = endRow;
  let lastCol = endColumn;
  if (endColumn === 0 && endRow > startRow) {
    lastRow = endRow - 1;
    lastCol = (lines[lastRow] ?? "").length;
  }
  const startLine = startRow + 1;
  const startCol = startColumn + 1;
  const endLine = lastRow + 1;
  // Exclusive 0-based end column == inclusive 1-based end column. Zero-width nodes are widened to 1.
  const endCol = Math.max(lastCol, endLine === startLine ? startCol : 1);
  return { startLine, startCol, endLine, endCol };
}

/** The span of `node`. */
export function nodeSpan(node: Node, lines: readonly string[]): Span {
  const s = node.startPosition;
  const e = node.endPosition;
  return pointsToSpan(s.row, s.column, e.row, e.column, lines);
}

/** From the start of `first` to the end of `last`. */
export function spanBetween(first: Node, last: Node, lines: readonly string[]): Span {
  const s = first.startPosition;
  const e = last.endPosition;
  return pointsToSpan(s.row, s.column, e.row, e.column, lines);
}

/** Number of lines a span covers. */
export function spanLineCount(span: Span): number {
  return span.endLine - span.startLine + 1;
}

/** Is the 1-based position inside the span (inclusive)? */
export function spanContains(span: Span, line: number, col: number): boolean {
  if (line < span.startLine || line > span.endLine) return false;
  if (line === span.startLine && col < span.startCol) return false;
  if (line === span.endLine && col > span.endCol) return false;
  return true;
}

/** Order two positions: negative if a is before b. */
export function comparePos(aLine: number, aCol: number, bLine: number, bCol: number): number {
  return aLine !== bLine ? aLine - bLine : aCol - bCol;
}

/** Text of a node, or "" for null. */
export function textOf(node: Node | null | undefined): string {
  return node ? node.text : "";
}

/**
 * Innermost-span lookup over a set of (possibly nested) spans of one file: "which item most tightly
 * contains this position?". Items must be properly nested or disjoint; partially overlapping items are
 * tolerated (the answer is still an item that contains the position).
 */
export class SpanIndex<T> {
  private readonly starts: Span[];
  private readonly values: T[];
  private readonly parents: Int32Array;

  constructor(items: readonly { span: Span; value: T }[]) {
    const order = items
      .map((item, i) => ({ item, i }))
      .sort(
        (a, b) =>
          comparePos(
            a.item.span.startLine,
            a.item.span.startCol,
            b.item.span.startLine,
            b.item.span.startCol,
          ) ||
          comparePos(
            b.item.span.endLine,
            b.item.span.endCol,
            a.item.span.endLine,
            a.item.span.endCol,
          ) ||
          a.i - b.i,
      );
    this.starts = order.map((o) => o.item.span);
    this.values = order.map((o) => o.item.value);
    this.parents = new Int32Array(order.length).fill(-1);
    // parent[i] = nearest earlier item that contains item i's start (a stack sweep).
    const stack: number[] = [];
    for (let i = 0; i < this.starts.length; i++) {
      const s = this.starts[i]!;
      while (stack.length > 0) {
        const top = this.starts[stack[stack.length - 1]!]!;
        if (spanContains(top, s.startLine, s.startCol)) break;
        stack.pop();
      }
      this.parents[i] = stack.length > 0 ? stack[stack.length - 1]! : -1;
      stack.push(i);
    }
  }

  get size(): number {
    return this.values.length;
  }

  /** Index of the last item whose start is at or before the position (-1 if none). */
  private lastStartingAtOrBefore(line: number, col: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = this.starts[mid]!;
      if (comparePos(s.startLine, s.startCol, line, col) <= 0) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }

  /** The innermost item containing the position. */
  innermost(line: number, col: number): T | undefined {
    let i = this.lastStartingAtOrBefore(line, col);
    while (i >= 0) {
      if (spanContains(this.starts[i]!, line, col)) return this.values[i];
      i = this.parents[i]!;
    }
    return undefined;
  }

  /** Every item containing the position, innermost first. */
  containing(line: number, col: number): T[] {
    const out: T[] = [];
    let i = this.lastStartingAtOrBefore(line, col);
    while (i >= 0) {
      if (spanContains(this.starts[i]!, line, col)) out.push(this.values[i]!);
      i = this.parents[i]!;
    }
    return out;
  }
}
