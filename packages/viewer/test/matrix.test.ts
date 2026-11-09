/**
 * The dependency matrix of a map (matrix.ts): which boxes get a row, in what order, and what each cell holds.
 * The order is the contract a reader relies on: what a box uses lies to the right of the diagonal, so a cell
 * below it is an arrow back against the layers (with its mirror cell, a cycle).
 */
import type { DerivedEdge, DerivedGraph, GraphNode } from "@xpl/core";
import { describe, expect, it } from "vitest";
import { buildMatrix } from "../src/matrix.js";

const box = (id: string, over: Partial<GraphNode> = {}): GraphNode => ({
  id,
  label: id.replace(/^file:/, ""),
  kind: "file",
  container: false,
  ...over,
});

const arrow = (
  kind: DerivedEdge["kind"],
  from: string,
  to: string,
  over: Partial<DerivedEdge> = {},
): DerivedEdge => ({
  id: `edge:${kind}:${from}->${to}`,
  from,
  to,
  kind,
  count: 1,
  resolution: "precise",
  stored: false,
  anchors: [],
  ...over,
});

const graph = (nodes: GraphNode[], edges: DerivedEdge[]): DerivedGraph => ({
  nodes,
  edges,
  stubs: [],
  ghosts: [],
});

/** The matrix as text: one line per row, `.` for an empty cell, the count for an arrow, `!` after a back arrow. */
function picture(g: DerivedGraph): string[] {
  const m = buildMatrix(g);
  return m.boxes.map(
    (row, r) =>
      `${row.label}: ` +
      m.cells[r]!.map((cell) => (cell ? `${cell.count}${cell.back ? "!" : ""}` : ".")).join(" "),
  );
}

describe("buildMatrix", () => {
  it("orders the boxes so that every arrow of a map without cycles lies above the diagonal", () => {
    // listed against the layers: the store first, the command that uses everything last
    const g = graph(
      [box("file:store.ts"), box("file:queue.ts"), box("file:cli.ts")],
      [
        arrow("calls", "file:cli.ts", "file:queue.ts", { count: 3 }),
        arrow("calls", "file:queue.ts", "file:store.ts", { count: 2 }),
        arrow("imports", "file:cli.ts", "file:store.ts"),
      ],
    );
    expect(picture(g)).toEqual(["cli.ts: . 3 1", "queue.ts: . . 2", "store.ts: . . ."]);
  });

  it("puts the arrow that closes a cycle below the diagonal, and keeps the listed order where it can", () => {
    const g = graph(
      [box("file:a.ts"), box("file:b.ts"), box("file:c.ts"), box("file:alone.ts")],
      [
        arrow("calls", "file:a.ts", "file:b.ts"),
        arrow("calls", "file:b.ts", "file:c.ts"),
        arrow("calls", "file:c.ts", "file:a.ts", { count: 4 }),
      ],
    );
    // (a box nothing points at may come first: alone.ts)
    expect(picture(g)).toEqual([
      "alone.ts: . . . .",
      "a.ts: . . 1 .",
      "b.ts: . . . 1",
      "c.ts: . 4! . .",
    ]);
  });

  it("joins the arrows of one pair into one cell that selects the arrow the map draws", () => {
    const g = graph(
      [box("file:a.ts"), box("file:b.ts")],
      [
        arrow("calls", "file:a.ts", "file:b.ts", { count: 2 }),
        arrow("references", "file:a.ts", "file:b.ts", { resolution: "heuristic" }),
      ],
    );
    const cell = buildMatrix(g).cells[0]![1]!;
    expect(cell).toMatchObject({
      count: 3,
      resolution: "mixed",
      text: "calls ×2 · references ×1",
      select: ["edge:calls:file:a.ts->file:b.ts"],
      ids: ["edge:calls:file:a.ts->file:b.ts", "edge:references:file:a.ts->file:b.ts"],
    });
  });

  it("gives a container a row only when an arrow ends on it, and names each box's container", () => {
    const g = graph(
      [
        box("dir:src", { label: "src", kind: "dir", container: true }),
        box("file:src/a.ts", { label: "a.ts", parent: "dir:src" }),
        box("grp:jobs", { label: "Jobs", kind: "group", container: true }),
        box("file:src/b.ts", { label: "b.ts", parent: "grp:jobs" }),
      ],
      [arrow("calls", "file:src/a.ts", "grp:jobs", { resolution: "llm", stored: true })],
    );
    expect(buildMatrix(g).boxes).toEqual([
      { id: "file:src/a.ts", label: "a.ts", group: "src" },
      { id: "grp:jobs", label: "Jobs" },
      { id: "file:src/b.ts", label: "b.ts", group: "Jobs" },
    ]);
  });
});
