/**
 * The dependency matrix of a map (matrix.ts): which boxes get a row, in what order, and what each cell holds.
 * The order is the contract a reader relies on: what a box uses lies to the right of the diagonal, so a cell
 * below it is an arrow back against the layers (with its mirror cell, a cycle).
 */
import type { DerivedEdge, DerivedGraph, GraphNode } from "@xpl/core";
import { describe, expect, it } from "vitest";
import { buildMatrix } from "../src/matrix.js";
import { mapParts } from "../src/parts.js";

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
    expect(picture(g)).toEqual([
      "a.ts: . 1 . .",
      "b.ts: . . 1 .",
      "c.ts: 4! . . .",
      "alone.ts: . . . .",
    ]);
  });

  it("puts only the arrows of a real cycle below the diagonal", () => {
    // main uses hub; hub and a use each other; hub also uses two leaves. One arrow of the hub-a pair must go
    // back; the arrows to the leaves need not.
    const g = graph(
      ["leaf1", "leaf2", "main", "hub", "a"].map((id) => box(id)),
      [
        arrow("calls", "main", "hub"),
        arrow("calls", "hub", "a"),
        arrow("calls", "a", "hub"),
        arrow("calls", "hub", "leaf1"),
        arrow("calls", "hub", "leaf2"),
      ],
    );
    expect(picture(g)).toEqual([
      "main: . 1 . . .",
      "hub: . . 1 1 1",
      "a: . 1! . . .",
      "leaf1: . . . . .",
      "leaf2: . . . . .",
    ]);
  });

  it("keeps a hub in a two-way pair with many leaves to one back cell", () => {
    const leaves = Array.from({ length: 6 }, (_, i) => `leaf${i}`);
    const g = graph(
      [...leaves, "hub", "twin"].map((id) => box(id)),
      [
        arrow("calls", "hub", "twin"),
        arrow("calls", "twin", "hub"),
        ...leaves.map((leaf) => arrow("calls", "hub", leaf)),
      ],
    );
    const m = buildMatrix(g);
    expect(m.cells.flat().filter((cell) => cell?.back)).toHaveLength(1);
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

  it("calls a cell mixed only when precise and heuristic references meet, not for two authored arrows", () => {
    const g = graph(
      [box("file:a.ts"), box("file:b.ts")],
      [
        arrow("calls", "file:a.ts", "file:b.ts", {
          id: "edge:emits",
          label: "emits",
          resolution: "llm",
          stored: true,
        }),
        arrow("calls", "file:a.ts", "file:b.ts", {
          id: "edge:mine",
          label: "my words",
          resolution: "user",
          stored: true,
        }),
      ],
    );
    const cell = buildMatrix(g).cells[0]![1]!;
    expect(cell.resolution).toBe("user");
    expect(cell.authored).toBe(true);
  });

  it("sums each box's lines out of the map into an Outside column and row, with the stubs' ids", () => {
    const g = graph(
      [box("file:a.ts"), box("file:b.ts")],
      [arrow("calls", "file:a.ts", "file:b.ts")],
    );
    g.stubs = [
      {
        id: "stub:out:a",
        direction: "out",
        inside: "file:a.ts",
        ghost: "x",
        ghostLabel: "x",
        targets: [],
        kinds: ["calls"],
        count: 5,
      },
      {
        id: "stub:out:a2",
        direction: "out",
        inside: "file:a.ts",
        ghost: "y",
        ghostLabel: "y",
        targets: [],
        kinds: ["imports"],
        count: 2,
      },
      {
        id: "stub:in:b",
        direction: "in",
        inside: "file:b.ts",
        ghost: "z",
        ghostLabel: "z",
        targets: [],
        kinds: ["calls"],
        count: 1,
      },
    ];
    const m = buildMatrix(g);
    expect(m.out).toEqual([
      {
        select: ["stub:out:a", "stub:out:a2"],
        count: 7,
        kinds: ["calls", "imports"],
        text: "calls & imports ×7",
      },
      undefined,
    ]);
    expect(m.in).toEqual([
      undefined,
      { select: ["stub:in:b"], count: 1, kinds: ["calls"], text: "calls ×1" },
    ]);
  });
});

describe("one order for the parts list and the matrix", () => {
  it("lists a map's boxes in the matrix's order, a group's boxes under it", () => {
    // the names sort against the arrows: astore.ts and list.ts are used, so they come after their users
    const g = graph(
      [
        box("file:astore.ts"),
        box("grp:cmds", { label: "Commands", kind: "group", container: true }),
        box("file:run.ts", { parent: "grp:cmds" }),
        box("file:list.ts", { parent: "grp:cmds" }),
      ],
      [
        arrow("calls", "file:run.ts", "file:astore.ts"),
        arrow("calls", "file:run.ts", "file:list.ts"),
      ],
    );
    const view = { id: "view:m", type: "graph", title: "m", include: [] } as unknown as Parameters<
      typeof mapParts
    >[1];
    const model = { node: () => undefined } as unknown as Parameters<typeof mapParts>[2];
    const parts = mapParts(g, view, model).boxes.map((b) => b.label);
    expect(parts).toEqual(["Commands", "run.ts", "list.ts", "astore.ts"]);
    expect(buildMatrix(g).boxes.map((b) => b.label)).toEqual(["run.ts", "list.ts", "astore.ts"]);
  });
});
