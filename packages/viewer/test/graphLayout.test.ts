import { deriveGraph, ExplainerModel, type GraphView } from "@xpl/core";
import { describe, expect, it } from "vitest";
import {
  fitScale,
  layoutGraph,
  layoutGraphFitting,
  type LayoutEdge,
  type LayoutNode,
} from "../src/layout/graphLayout.js";
import { distanceToSegment } from "../src/svg.js";
import { makeBundle } from "./world.js";

function graphOf(include: string[]) {
  const bundle = makeBundle();
  const explainer = structuredClone(bundle.explainer);
  const view = explainer.views.find((v) => v.id === "view:overview") as GraphView;
  view.include = include;
  const model = new ExplainerModel(explainer, bundle.index);
  return { graph: deriveGraph(view, model), model };
}

const all = (nodes: LayoutNode[]): LayoutNode[] => nodes.flatMap((n) => [n, ...all(n.children)]);

describe("layoutGraph", () => {
  it("lays boxes out left to right and routes every edge between its two ends", async () => {
    const { graph } = graphOf(["file:src/a.ts", "file:src/b.ts"]);
    expect(graph.edges.map((e) => e.id)).toEqual(["edge:calls:file:src/a.ts->file:src/b.ts"]);
    const layout = await layoutGraph(graph);
    expect(layout.fallback).toBe(false);
    const a = layout.nodes.find((n) => n.id === "file:src/a.ts")!;
    const b = layout.nodes.find((n) => n.id === "file:src/b.ts")!;
    expect(a.x + a.width).toBeLessThanOrEqual(b.x);
    const [edge] = layout.edges;
    expect(edge!.title).toBe("calls ×2");
    expect(edge!.resolution).toBe("precise");
    expect(edge!.kind).toBe("calls");
    expect(edge!.stub).toBe(false);
    expect(edge!.points[0]!.x).toBeCloseTo(a.x + a.width, 0);
    expect(edge!.points.at(-1)!.x).toBeCloseTo(b.x, 0);
    expect(edge!.label).toBeDefined();
    expect(layout.width).toBeGreaterThan(b.x + b.width - 1);
    expect(layout.height).toBeGreaterThan(a.height);
  });

  it("nests included children in their container", async () => {
    const { graph } = graphOf(["file:src/a.ts", "sym:src/a.ts#A", "sym:src/a.ts#A.run"]);
    const layout = await layoutGraph(graph);
    const file = layout.nodes.find((n) => n.id === "file:src/a.ts")!;
    expect(file.children.map((c) => c.id)).toEqual(["sym:src/a.ts#A"]);
    const cls = file.children[0]!;
    expect(cls.children.map((c) => c.id)).toEqual(["sym:src/a.ts#A.run"]);
    // children sit inside their container (coordinates are relative to it)
    expect(cls.x).toBeGreaterThanOrEqual(0);
    expect(cls.x + cls.width).toBeLessThanOrEqual(file.width);
    expect(cls.y + cls.height).toBeLessThanOrEqual(file.height);
    expect(file.badge).toBe("file");
    expect(cls.badge).toBe("class");
    const boxes = all(layout.nodes).filter((n) => !n.ghost);
    expect(boxes.map((n) => n.id).sort()).toEqual(
      ["file:src/a.ts", "sym:src/a.ts#A", "sym:src/a.ts#A.run"].sort(),
    );
  });

  it("draws stubs as edges to ghost boxes that say what leaves the view", async () => {
    const { graph } = graphOf(["sym:src/a.ts#A.run"]);
    const stubId = "stub:out:sym:src/a.ts#A.run->ghost:file:src/b.ts";
    expect(graph.stubs.map((s) => s.id)).toContain(stubId);
    const layout = await layoutGraph(graph);
    const ghost = layout.nodes.find((n) => n.id === "ghost:file:src/b.ts")!;
    expect(ghost.id).toBe("ghost:file:src/b.ts");
    expect(ghost.ghostTarget).toBe("file:src/b.ts");
    expect(ghost.label).toBe("b.ts");
    expect(ghost.detail).toBe("calls ×1");
    const run = layout.nodes.find((n) => n.id === "sym:src/a.ts#A.run")!;
    expect(ghost.x).toBeGreaterThan(run.x + run.width);
    const stub = layout.edges.find((e) => e.id === stubId)!;
    expect(stub.stub).toBe(true);
    expect(stub.resolution).toBe("stub");
    expect(stub.label).toBeUndefined();
    expect(stub.title).toBe("calls ×1");
    expect(stub.points.at(-1)!.x).toBeCloseTo(ghost.x, 0);
  });

  it("marks heuristic edges so they can be drawn lighter", async () => {
    const { graph } = graphOf(["sym:src/a.ts#A.stop", "sym:src/b.ts#B.go"]);
    const layout = await layoutGraph(graph);
    expect(layout.edges.filter((e) => !e.stub).map((e) => [e.id, e.resolution])).toEqual([
      ["edge:calls:sym:src/a.ts#A.stop->sym:src/b.ts#B.go", "heuristic"],
    ]);
  });

  it("falls back to a grid when ELK cannot lay the graph out", async () => {
    const { graph } = graphOf(["file:src/a.ts", "file:src/b.ts"]);
    const layout = await layoutGraph(graph, { "elk.algorithm": "no.such.algorithm" });
    expect(layout.fallback).toBe(true);
    expect(layout.nodes.filter((n) => !n.ghost)).toHaveLength(2);
    const edge = layout.edges.find((e) => !e.stub)!;
    expect(edge.points).toHaveLength(2);
    expect(edge.label).toBeDefined();
  });

  it("holds an edge in the lowest container around both ends, relative to that container", async () => {
    // A.run and A.stop are both inside class A (inside file a.ts): the call between them is A's edge.
    const { graph } = graphOf([
      "file:src/a.ts",
      "sym:src/a.ts#A",
      "sym:src/a.ts#A.run",
      "sym:src/a.ts#A.stop",
      "file:src/b.ts",
    ]);
    const layout = await layoutGraph(graph);
    const file = layout.nodes.find((n) => n.id === "file:src/a.ts")!;
    const cls = file.children[0]!;
    expect(cls.id).toBe("sym:src/a.ts#A");
    expect(cls.edges.map((e) => e.id)).toEqual([
      "edge:calls:sym:src/a.ts#A.stop->sym:src/a.ts#A.run",
    ]);
    expect(file.edges).toEqual([]);
    // route and label are relative to the class: inside its box
    const [inner] = cls.edges;
    for (const p of inner!.points) {
      expect(p.x).toBeGreaterThanOrEqual(-1);
      expect(p.x).toBeLessThanOrEqual(cls.width + 1);
      expect(p.y).toBeGreaterThanOrEqual(-1);
      expect(p.y).toBeLessThanOrEqual(cls.height + 1);
    }
    expect(inner!.label!.x).toBeGreaterThanOrEqual(0);
    expect(inner!.label!.x + inner!.label!.width).toBeLessThanOrEqual(cls.width);
    // an edge from inside the file to the other top-level box belongs to the canvas, whose
    // coordinates are absolute: it starts at the run() box, which sits inside class A inside a.ts
    const crossing = layout.edges.find(
      (e) => e.id === "edge:calls:sym:src/a.ts#A.run->file:src/b.ts",
    );
    expect(crossing).toBeDefined();
    const run = cls.children.find((c) => c.id === "sym:src/a.ts#A.run")!;
    expect(crossing!.points[0]!.x).toBeCloseTo(file.x + cls.x + run.x + run.width, 0);
  });

  it("gives every edge an anchor on its route that no box is drawn over", async () => {
    const { graph } = graphOf([
      "file:src/a.ts",
      "sym:src/a.ts#A",
      "sym:src/a.ts#A.run",
      "file:src/b.ts",
    ]);
    const layout = await layoutGraph(graph);
    const edges: { edge: LayoutEdge; origin: { x: number; y: number }; below: LayoutNode[] }[] = [];
    const walk = (nodes: LayoutNode[], origin: { x: number; y: number }) => {
      for (const node of nodes) {
        const at = { x: origin.x + node.x, y: origin.y + node.y };
        for (const edge of node.edges) edges.push({ edge, origin: at, below: all(node.children) });
        walk(node.children, at);
      }
    };
    walk(layout.nodes, { x: 0, y: 0 });
    for (const edge of layout.edges) edges.push({ edge, origin: { x: 0, y: 0 }, below: [] });
    expect(edges.length).toBeGreaterThan(2);
    for (const { edge, origin } of edges) {
      // on the route
      const distance = Math.min(
        ...edge.points.slice(1).map((p, i) => distanceToSegment(edge.anchor, edge.points[i]!, p)),
      );
      expect(distance, edge.id).toBeLessThan(0.01);
      expect(origin).toBeDefined();
    }
    // the canvas-level edges are not under any node
    const boxes: { x: number; y: number; width: number; height: number }[] = [];
    const collect = (nodes: LayoutNode[], origin: { x: number; y: number }) => {
      for (const n of nodes) {
        const at = { x: origin.x + n.x, y: origin.y + n.y };
        boxes.push({ ...at, width: n.width, height: n.height });
        collect(n.children, at);
      }
    };
    collect(layout.nodes, { x: 0, y: 0 });
    for (const edge of layout.edges) {
      const under = boxes.some(
        (b) =>
          edge.anchor.x >= b.x &&
          edge.anchor.x <= b.x + b.width &&
          edge.anchor.y >= b.y &&
          edge.anchor.y <= b.y + b.height,
      );
      expect(under, `anchor of ${edge.id} is under a box`).toBe(false);
    }
  });

  it("is deterministic", async () => {
    const { graph } = graphOf(["grp:core", "file:config/c.yaml"]);
    expect(await layoutGraph(graph)).toEqual(await layoutGraph(graph));
  });
});

describe("layoutGraphFitting", () => {
  const FLOW = ["file:src/a.ts", "file:src/b.ts", "sym:src/a.ts#A.run", "sym:src/b.ts#B.go"];

  it("fits the layout to the pane: RIGHT in a wide pane, DOWN in a tall one", async () => {
    // one layer per file, then one per method: a chain that is long one way and thin the other
    const { graph } = graphOf(FLOW);
    const wide = await layoutGraphFitting(graph, { width: 1200, height: 300 });
    const tall = await layoutGraphFitting(graph, { width: 300, height: 1200 });
    expect(wide.direction).toBe("RIGHT");
    expect(tall.direction).toBe("DOWN");
    // whichever it picked is the one that fits at the larger scale
    const right = await layoutGraph(graph, { "elk.direction": "RIGHT" });
    const down = await layoutGraph(graph, { "elk.direction": "DOWN" });
    expect(right.direction).toBe("RIGHT");
    expect(down.direction).toBe("DOWN");
    const fits = (l: { width: number; height: number }, v: { width: number; height: number }) =>
      fitScale(l, v);
    expect(fits(wide, { width: 1200, height: 300 })).toBeGreaterThanOrEqual(
      fits(down, { width: 1200, height: 300 }),
    );
    expect(fits(tall, { width: 300, height: 1200 })).toBeGreaterThanOrEqual(
      fits(right, { width: 300, height: 1200 }),
    );
  });

  it("without a pane size it is the plain left-to-right layout", async () => {
    const { graph } = graphOf(["file:src/a.ts", "file:src/b.ts"]);
    expect((await layoutGraphFitting(graph, undefined)).direction).toBe("RIGHT");
    expect((await layoutGraphFitting(graph, { width: 0, height: 0 })).direction).toBe("RIGHT");
  });

  it("keeps the suggested direction unless the other fits clearly larger", async () => {
    const { graph } = graphOf(["file:src/a.ts", "file:src/b.ts"]);
    // a square pane suggests RIGHT (width / height is not below 1) and a small diagram fits either way
    expect((await layoutGraphFitting(graph, { width: 900, height: 900 })).direction).toBe("RIGHT");
    expect((await layoutGraphFitting(graph, { width: 899, height: 900 })).direction).toBe("DOWN");
  });

  it("fitScale is what fitting does: bounded above, padded on every side", () => {
    expect(fitScale({ width: 100, height: 100 }, { width: 1000, height: 1000 })).toBe(1.25);
    expect(fitScale({ width: 100, height: 100 }, { width: 1000, height: 1000 }, 1.6)).toBe(1.6);
    expect(fitScale({ width: 904, height: 100 }, { width: 500, height: 500 })).toBeCloseTo(0.5, 5);
    expect(fitScale({ width: 100, height: 904 }, { width: 500, height: 500 })).toBeCloseTo(0.5, 5);
    expect(fitScale({ width: 0, height: 0 }, { width: 10, height: 10 })).toBe(1.25);
  });
});
