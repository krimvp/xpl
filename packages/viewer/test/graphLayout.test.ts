import { drawnEdges } from "../src/drawnEdges.js";
import {
  deriveGraph,
  ExplainerModel,
  type DerivedEdge,
  type DerivedGraph,
  type GraphView,
} from "@xpl/core";
import { describe, expect, it } from "vitest";
import {
  absoluteBoxes,
  cutAt,
  fitScale,
  gridLayoutOf,
  layoutGraph,
  layoutGraphFitting,
  spreadLabels,
  dropDetours,
  SUMMARY_FONT,
  ICON_ROOM,
  startAnchor,
  startFocus,
  type LayoutEdge,
  type LayoutNode,
} from "../src/layout/graphLayout.js";
import { textWidth } from "../src/measure.js";
import { distanceToSegment } from "../src/svg.js";
import { makeBundle } from "./world.js";

function graphOf(include: string[], over: Partial<GraphView> = {}) {
  const bundle = makeBundle();
  const explainer = structuredClone(bundle.explainer);
  const view = explainer.views.find((v) => v.id === "view:overview") as GraphView;
  view.include = include;
  Object.assign(view, over);
  const model = new ExplainerModel(explainer, bundle.index);
  return { graph: deriveGraph(view, model), model };
}

const all = (nodes: LayoutNode[]): LayoutNode[] => nodes.flatMap((n) => [n, ...all(n.children)]);

const routeHitsLabel = (
  points: readonly { x: number; y: number }[],
  label: { x: number; y: number; width: number; height: number },
) =>
  points.some((point, i) => {
    if (i === 0) return false;
    const previous = points[i - 1]!;
    return point.x === previous.x
      ? point.x > label.x &&
          point.x < label.x + label.width &&
          Math.max(point.y, previous.y) > label.y &&
          Math.min(point.y, previous.y) < label.y + label.height
      : point.y > label.y &&
          point.y < label.y + label.height &&
          Math.max(point.x, previous.x) > label.x &&
          Math.min(point.x, previous.x) < label.x + label.width;
  });

describe("layoutGraph", () => {
  it("straightens a clear long arrow while keeping an authored label", async () => {
    const ids = ["startup", "settings", "scheduling", "workers", "events"];
    const edge = (from: string, to: string, label?: string): DerivedEdge => ({
      id: `edge:${from}-${to}`,
      from,
      to,
      kind: label ? "emits" : "calls",
      ...(label ? { label } : {}),
      count: 1,
      resolution: "static",
      stored: true,
      anchors: [],
    });
    const graph: DerivedGraph = {
      nodes: ids.map((id) => ({
        id,
        label: id === "events" ? "Events and metrics" : id,
        kind: "group" as const,
        role: "component" as const,
        container: false,
      })),
      edges: [
        edge("startup", "settings"),
        edge("startup", "scheduling"),
        edge("startup", "workers"),
        edge("startup", "events"),
        edge("scheduling", "workers"),
        edge("workers", "events", "job.completed"),
      ],
      stubs: [],
      ghosts: [],
    };
    const layout = await layoutGraph(graph, { direction: "DOWN" });
    expect(layout.fallback).toBe(false);
    const route = layout.edges.find((item) => item.id === "edge:startup-workers")!;
    expect(route.points).toHaveLength(4);
    const scheduling = absoluteBoxes(layout.nodes).get("scheduling")!;
    for (let i = 1; i < route.points.length; i++) {
      const a = route.points[i - 1]!,
        b = route.points[i]!;
      if (a.x !== b.x || Math.max(a.y, b.y) <= scheduling.y) continue;
      if (Math.min(a.y, b.y) >= scheduling.y + scheduling.height) continue;
      expect(
        Math.max(scheduling.x - a.x, a.x - scheduling.x - scheduling.width),
      ).toBeGreaterThanOrEqual(8);
    }
    expect(layout.edges.find((item) => item.id === "edge:workers-events")!.label!.text).toBe(
      "job.completed",
    );
  });
  it("keeps a shortened arrow outside a sibling box", async () => {
    const graph: DerivedGraph = {
      nodes: Array.from({ length: 6 }, (_, i) => ({
        id: `n${i}`,
        label: `n${i}`,
        kind: "group" as const,
        role: "component" as const,
        container: false,
      })),
      edges: ["0-2", "0-3", "1-2", "1-3", "1-4", "2-4"].map((pair) => ({
        id: `e${pair}`,
        from: `n${pair[0]}`,
        to: `n${pair[2]}`,
        kind: "calls" as const,
        count: 1,
        resolution: "static" as const,
        stored: true,
        anchors: [],
      })),
      stubs: [],
      ghosts: [],
    };
    const layout = await layoutGraph(graph);
    const obstruction = absoluteBoxes(layout.nodes).get("n3")!;
    const points = layout.edges.find((edge) => edge.id === "e1-4")!.points;
    const crosses = points.slice(1).filter((p, i) => {
      const q = points[i]!;
      return p.y === q.y
        ? p.y > obstruction.y &&
            p.y < obstruction.y + obstruction.height &&
            Math.max(p.x, q.x) > obstruction.x &&
            Math.min(p.x, q.x) < obstruction.x + obstruction.width
        : p.x > obstruction.x &&
            p.x < obstruction.x + obstruction.width &&
            Math.max(p.y, q.y) > obstruction.y &&
            Math.min(p.y, q.y) < obstruction.y + obstruction.height;
    });
    expect(crosses).toEqual([]);
  });
  it("keeps widened ports from crossing arrows that were separate", async () => {
    const graph: DerivedGraph = {
      nodes: Array.from({ length: 6 }, (_, i) => ({
        id: `n${i}`,
        label: `n${i}`,
        kind: "group" as const,
        role: "component" as const,
        container: false,
      })),
      edges: ["0-3", "0-4", "1-2", "2-3", "2-5", "3-4"].map((pair) => ({
        id: `e${pair}`,
        from: `n${pair[0]}`,
        to: `n${pair[2]}`,
        kind: "calls" as const,
        count: 1,
        resolution: "static" as const,
        stored: true,
        anchors: [],
      })),
      stubs: [],
      ghosts: [],
    };
    const { edges } = await layoutGraph(graph);
    const crossing = edges.some((a, i) =>
      edges.slice(i + 1).some((b) =>
        a.points.slice(1).some((q, ai) => {
          const p = a.points[ai]!;
          return b.points.slice(1).some((s, bi) => {
            const r = b.points[bi]!;
            return (
              (p.x === q.x &&
                r.y === s.y &&
                p.x > Math.min(r.x, s.x) &&
                p.x < Math.max(r.x, s.x) &&
                r.y > Math.min(p.y, q.y) &&
                r.y < Math.max(p.y, q.y)) ||
              (p.y === q.y &&
                r.x === s.x &&
                r.x > Math.min(p.x, q.x) &&
                r.x < Math.max(p.x, q.x) &&
                p.y > Math.min(r.y, s.y) &&
                p.y < Math.max(r.y, s.y))
            );
          });
        }),
      ),
    );
    expect(crossing).toBe(false);
  });
  it("keeps automatic boxes clear of a pinned sibling without moving the pin", async () => {
    const { graph } = graphOf(["file:src/a.ts", "file:src/b.ts"]);
    const automatic = await layoutGraph(graph);
    const position = { x: automatic.nodes[1]!.x, y: automatic.nodes[1]!.y };
    const layout = await layoutGraph(graph, { pins: { "file:src/a.ts": position } });
    const a = layout.nodes.find((n) => n.id === "file:src/a.ts")!;
    const b = layout.nodes.find((n) => n.id === "file:src/b.ts")!;
    expect({ x: a.x, y: a.y }).toEqual(position);
    const overlapWidth = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const overlapHeight = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    expect(Math.min(overlapWidth, overlapHeight)).toBeLessThanOrEqual(0);
  });
  it("routes around a box pinned across an arrow's old track", async () => {
    const { graph } = graphOf(["file:src/a.ts", "file:src/b.ts", "file:config/c.yaml"]);
    graph.edges = graph.edges.filter((e) => e.to === "file:src/b.ts");
    const layout = await layoutGraph(graph, {
      pins: {
        "file:src/a.ts": { x: 20, y: 100 },
        "file:src/b.ts": { x: 600, y: 100 },
        "file:config/c.yaml": { x: 310, y: 85 },
      },
    });
    const obstruction = absoluteBoxes(layout.nodes).get("file:config/c.yaml")!;
    const edge = layout.edges[0]!;
    expect(layout.edges).toHaveLength(1);
    const crosses = edge.points.slice(1).filter((p, i) => {
      const q = edge.points[i]!;
      return p.y === q.y
        ? p.y > obstruction.y &&
            p.y < obstruction.y + obstruction.height &&
            Math.max(p.x, q.x) > obstruction.x &&
            Math.min(p.x, q.x) < obstruction.x + obstruction.width
        : p.x > obstruction.x &&
            p.x < obstruction.x + obstruction.width &&
            Math.max(p.y, q.y) > obstruction.y &&
            Math.min(p.y, q.y) < obstruction.y + obstruction.height;
    });
    expect(crosses).toEqual([]);
  });
  it("honors nested negative pins, sizes their containers and reroutes crossing arrows", async () => {
    const pins = {
      "file:src/a.ts": { x: -80, y: 120 },
      "sym:src/a.ts#A": { x: -40, y: 100 },
      "sym:src/a.ts#A.run": { x: 220, y: -30 },
      "file:src/b.ts": { x: 700, y: 50 },
    };
    const { graph } = graphOf(Object.keys(pins));
    const automatic = await layoutGraph(graph);
    const layout = await layoutGraph(graph, { pins });
    expect(layout.fallback).toBe(false);
    const nodes = new Map(all(layout.nodes).map((n) => [n.id, n]));
    for (const [id, position] of Object.entries(pins)) {
      expect({ x: nodes.get(id)!.x, y: nodes.get(id)!.y }).toEqual(position);
    }
    const boxes = absoluteBoxes(layout.nodes);
    for (const [parentId, childId] of [
      ["file:src/a.ts", "sym:src/a.ts#A"],
      ["sym:src/a.ts#A", "sym:src/a.ts#A.run"],
    ]) {
      const parent = boxes.get(parentId!)!;
      const child = boxes.get(childId!)!;
      expect(child.x).toBeGreaterThan(parent.x);
      expect(child.y).toBeGreaterThanOrEqual(parent.y + 34);
      expect(child.x + child.width).toBeLessThan(parent.x + parent.width);
      expect(child.y + child.height).toBeLessThan(parent.y + parent.height);
    }
    const run = boxes.get("sym:src/a.ts#A.run")!;
    const b = boxes.get("file:src/b.ts")!;
    const edge = layout.edges.find((e) => e.from === "sym:src/a.ts#A.run")!;
    const onBorder = (box: typeof b, p: { x: number; y: number }) =>
      Math.min(
        Math.abs(p.x - box.x),
        Math.abs(p.x - box.x - box.width),
        Math.abs(p.y - box.y),
        Math.abs(p.y - box.y - box.height),
      );
    expect(onBorder(run, edge.points[0]!)).toBeLessThan(0.01);
    expect(onBorder(b, edge.points.at(-1)!)).toBeLessThan(0.01);
    expect(edge.points).not.toEqual(automatic.edges.find((e) => e.id === edge.id)!.points);
    expect(
      Math.min(
        ...edge.points.slice(1).map((p, i) => distanceToSegment(edge.anchor, edge.points[i]!, p)),
      ),
    ).toBeLessThan(0.01);
    expect(await layoutGraph(graph)).toEqual(automatic);
  });
  it("lays boxes out left to right and routes every edge between its two ends", async () => {
    const { graph } = graphOf(["file:src/a.ts", "file:src/b.ts"]);
    expect(graph.edges.map((e) => e.id)).toEqual(["edge:calls:file:src/a.ts->file:src/b.ts"]);
    const layout = await layoutGraph(graph);
    expect(layout.fallback).toBe(false);
    const a = layout.nodes.find((n) => n.id === "file:src/a.ts")!;
    const b = layout.nodes.find((n) => n.id === "file:src/b.ts")!;
    expect(a.x + a.width).toBeLessThanOrEqual(b.x);
    const [edge] = layout.edges;
    expect(edge!.title).toBe("calls ×2 (partly matched by name)");
    expect(edge!.resolution).toBe("mixed");
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
    // below the container's header (its label and badge)
    expect(cls.y).toBeGreaterThanOrEqual(34);
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

  it("names every kind of reference on a ghost, so its count always has a verb", async () => {
    const stub = (inside: string, kinds: DerivedEdge["kind"][], count: number) => ({
      id: `stub:in:${inside}->ghost:file:test.ts`,
      direction: "in" as const,
      inside,
      ghost: "file:test.ts",
      ghostLabel: "test.ts",
      targets: [],
      kinds,
      count,
    });
    const graph: DerivedGraph = {
      nodes: [{ id: "a", label: "a.ts", kind: "file", container: false }],
      edges: [],
      stubs: [stub("a", ["calls", "extends"], 13)],
      ghosts: [],
    };
    const layout = await layoutGraph(graph);
    expect(layout.nodes.find((n) => n.ghost)!.detail).toBe("calls & extends ×13");
  });

  it("says a ghost's count is a total when it links to several boxes (the details give each box's share)", async () => {
    const stub = (inside: string, count: number) => ({
      id: `stub:in:${inside}->ghost:file:main.ts`,
      direction: "in" as const,
      inside,
      ghost: "file:main.ts",
      ghostLabel: "main.ts",
      targets: [],
      kinds: ["calls" as const],
      count,
    });
    const graph: DerivedGraph = {
      nodes: ["a", "b"].map((id) => ({
        id,
        label: `${id}.ts`,
        kind: "file" as const,
        container: false,
      })),
      edges: [],
      stubs: [stub("a", 7), stub("b", 5)],
      ghosts: [],
    };
    const layout = await layoutGraph(graph);
    expect(layout.nodes.find((n) => n.ghost)!.detail).toBe("calls ×12 in all");
  });

  it("draws a ghost that folds several elements as one box that carries its pick-list", async () => {
    // A.stop calls A.run: the rest of a.ts (a file shown in part) is one ghost, not one per symbol
    const { graph } = graphOf(["sym:src/a.ts#A.run"]);
    const layout = await layoutGraph(graph);
    const rest = layout.nodes.find((n) => n.id === "ghost:rest:file:src/a.ts")!;
    expect(rest.ghost).toBe(true);
    expect(rest.label).toBe("rest of a.ts");
    expect(rest.detail).toBe("calls ×1");
    expect(rest.hint).toBe("calls ×1");
    expect(rest.ghostTarget).toBeUndefined(); // nothing is added by clicking it
    expect(rest.ghostFold).toMatchObject({ kind: "rest", file: "file:src/a.ts" });
    expect(rest.ghostFold!.targets.map((t) => [t.target, t.count])).toEqual([
      ["sym:src/a.ts#A.stop", 1],
    ]);
    // it only enters the view there, so it is placed before what it enters
    const run = layout.nodes.find((n) => n.id === "sym:src/a.ts#A.run")!;
    expect(rest.x + rest.width).toBeLessThanOrEqual(run.x);
    // the ghost for a single element stays a plain one
    const plain = layout.nodes.find((n) => n.id === "ghost:file:src/b.ts")!;
    expect(plain.ghostTarget).toBe("file:src/b.ts");
    expect(plain.ghostFold).toBeUndefined();
    expect(
      layout.edges.some((e) => e.id === graph.stubs.find((s) => s.ghost.startsWith("rest:"))!.id),
    ).toBe(true);
  });

  it("draws the overflow ghost with every folded element in its list", async () => {
    const { graph } = graphOf(["sym:src/a.ts#A.run"], { stubs: { max: 0 } });
    const layout = await layoutGraph(graph);
    expect(
      layout.nodes
        .filter((n) => n.ghost)
        .map((n) => [n.id, n.label])
        .sort(),
    ).toEqual([
      ["ghost:more:in", "+1 more"],
      ["ghost:more:out", "+1 more"],
    ]);
    const out = layout.nodes.find((n) => n.id === "ghost:more:out")!;
    expect(out.ghostFold).toMatchObject({ kind: "more" });
    expect(out.ghostFold!.file).toBeUndefined();
    expect(out.ghostFold!.targets.map((t) => t.target)).toEqual(["file:src/b.ts"]);
  });

  it("draws no ghost and no stub when the view says none", async () => {
    const { graph } = graphOf(["sym:src/a.ts#A.run"], { stubs: { mode: "none" } });
    const layout = await layoutGraph(graph);
    expect(layout.nodes.filter((n) => n.ghost)).toEqual([]);
    expect(layout.edges.filter((e) => e.stub)).toEqual([]);
  });

  it("still lays out a graph built without the ghost list, reading the ghosts off the stubs", async () => {
    const { graph } = graphOf(["sym:src/a.ts#A.run"], { stubs: { mode: "all" } });
    const { ghosts: _dropped, ...bare } = graph;
    const layout = await layoutGraph(bare as typeof graph);
    const ghost = layout.nodes.find((n) => n.id === "ghost:file:src/b.ts")!;
    expect(ghost).toMatchObject({
      ghostTarget: "file:src/b.ts",
      label: "b.ts",
      detail: "calls ×1",
    });
  });

  it("marks heuristic edges so they can be drawn lighter", async () => {
    const { graph } = graphOf(["sym:src/a.ts#A.stop", "sym:src/b.ts#B.go"]);
    const layout = await layoutGraph(graph);
    expect(layout.edges.filter((e) => !e.stub).map((e) => [e.id, e.resolution])).toEqual([
      ["edge:calls:sym:src/a.ts#A.stop->sym:src/b.ts#B.go", "heuristic"],
    ]);
  });

  it("has a grid to fall back on when the layered layout fails", async () => {
    const { graph } = graphOf(["file:src/a.ts", "file:src/b.ts"]);
    const layout = gridLayoutOf(graph);
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

  it("badges a sketch box as a sketch, whatever its role, and keeps the role's shape", async () => {
    const graph: DerivedGraph = {
      nodes: [
        {
          id: "grp:client",
          label: "Client",
          kind: "group",
          role: "person",
          sketch: true,
          container: false,
        },
        { id: "grp:db", label: "Orders", kind: "group", role: "database", container: false },
      ],
      edges: [],
      stubs: [],
      ghosts: [],
    };
    const layout = await layoutGraph(graph);
    expect(layout.nodes.map((n) => [n.id, n.badge, n.role, n.sketch])).toEqual([
      ["grp:client", "sketch", "person", true],
      ["grp:db", "database", "database", undefined],
    ]);
  });

  it("wraps a box's summary on at most three lines that fit the box, and makes the box taller", async () => {
    const LONG =
      "Reads every job from the queue, runs it with the handler registered for its kind, retries it with a growing delay when it fails, and records how long each run took for the metrics page.";
    const box = (id: string, summary?: string) => ({
      id,
      label: id,
      kind: "file" as const,
      container: false,
      ...(summary ? { summary } : {}),
    });
    const graph: DerivedGraph = {
      nodes: [box("short", "Holds jobs."), box("long", LONG), box("bare")],
      edges: [],
      stubs: [],
      ghosts: [],
    };
    const layout = await layoutGraph(graph);
    const node = (id: string) => layout.nodes.find((n) => n.id === id)!;
    expect(node("short").lines).toEqual(["Holds jobs."]);
    expect(node("bare").lines).toBeUndefined();
    const long = node("long").lines!;
    expect(long).toHaveLength(3);
    expect(long[2]).toMatch(/…$/);
    // the words of the lines, in order, are the summary's first words
    const shown = long.join(" ").replace(/…$/, "").split(" ");
    expect(LONG.split(" ").slice(0, shown.length - 1)).toEqual(shown.slice(0, -1));
    for (const line of long) {
      expect(textWidth(line, SUMMARY_FONT)).toBeLessThanOrEqual(
        node("long").width - 28 - ICON_ROOM,
      );
    }
    expect(node("short").height).toBeGreaterThan(node("bare").height);
    expect(node("long").height).toBeGreaterThan(node("short").height);
    expect(node("short").width).toBe(node("long").width);
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

describe("where a diagram too big to fit starts", () => {
  const NESTED = ["file:src/a.ts", "sym:src/a.ts#A", "sym:src/a.ts#A.run", "file:src/b.ts"];

  it("absoluteBoxes gives every box in canvas coordinates, children included", async () => {
    const { graph } = graphOf(NESTED);
    const layout = await layoutGraph(graph);
    const boxes = absoluteBoxes(layout.nodes);
    // every node, containers and what is inside them; ghost boxes are boxes too
    expect([...boxes.keys()].filter((id) => !id.startsWith("ghost:")).sort()).toEqual(
      [...NESTED].sort(),
    );
    expect([...boxes.keys()].some((id) => id.startsWith("ghost:"))).toBe(true);
    // a child sits inside its container, in the container's coordinates plus the container's own position
    const file = layout.nodes.find((n) => n.id === "file:src/a.ts")!;
    const cls = file.children.find((n) => n.id === "sym:src/a.ts#A")!;
    expect(boxes.get("file:src/a.ts")).toEqual({
      x: file.x,
      y: file.y,
      width: file.width,
      height: file.height,
    });
    expect(boxes.get("sym:src/a.ts#A")).toEqual({
      x: file.x + cls.x,
      y: file.y + cls.y,
      width: cls.width,
      height: cls.height,
    });
    const method = cls.children.find((n) => n.id === "sym:src/a.ts#A.run")!;
    expect(boxes.get("sym:src/a.ts#A.run")!.x).toBe(file.x + cls.x + method.x);
    expect(boxes.get("sym:src/a.ts#A.run")!.y).toBe(file.y + cls.y + method.y);
  });

  it("starts on the selected boxes; else on the first box of the include list that is drawn", async () => {
    const { graph } = graphOf(NESTED);
    const layout = await layoutGraph(graph);
    const boxes = absoluteBoxes(layout.nodes);
    const box = (id: string) => boxes.get(id)!;
    // the selection wins (a concept or an edge that is not a box is skipped)
    expect(startAnchor(layout, ["file:src/b.ts"], NESTED)).toEqual(box("file:src/b.ts"));
    expect(startAnchor(layout, ["concept:x", "file:src/b.ts"], NESTED)).toEqual(
      box("file:src/b.ts"),
    );
    // several: the box around them
    const both = startAnchor(layout, ["file:src/a.ts", "file:src/b.ts"], NESTED)!;
    expect(both.x).toBe(Math.min(box("file:src/a.ts").x, box("file:src/b.ts").x));
    expect(both.x + both.width).toBe(
      Math.max(
        box("file:src/a.ts").x + box("file:src/a.ts").width,
        box("file:src/b.ts").x + box("file:src/b.ts").width,
      ),
    );
    // no (drawn) selection: the first included box, in the order of the include list
    expect(startAnchor(layout, [], NESTED)).toEqual(box("file:src/a.ts"));
    expect(startAnchor(layout, ["edge:whatever"], ["file:src/b.ts", "file:src/a.ts"])).toEqual(
      box("file:src/b.ts"),
    );
    expect(startAnchor(layout, [], ["file:src/gone.ts", "file:src/b.ts"])).toEqual(
      box("file:src/b.ts"),
    );
    // nothing to go by: the top-left corner
    expect(startAnchor(layout, [], [])).toBeUndefined();
    expect(startAnchor(layout, ["concept:x"], ["file:src/gone.ts"])).toBeUndefined();
  });

  it("frames the selection with its neighbours: the boxes at the other end of its edges", async () => {
    const { graph } = graphOf(NESTED);
    const layout = await layoutGraph(graph);
    const boxes = absoluteBoxes(layout.nodes);
    const edge = layout.edges.find((e) => e.from === "file:src/a.ts" || e.to === "file:src/a.ts");
    const focus = startFocus(layout, ["file:src/b.ts"], NESTED)!;
    expect(focus.boxes).toEqual([boxes.get("file:src/b.ts")]);
    if (edge) {
      // an edge stands for the two boxes it joins
      const ends = startFocus(layout, [edge.id], NESTED)!;
      expect(ends.boxes).toEqual([boxes.get(edge.from), boxes.get(edge.to)]);
    }
    const all = layout.edges.concat(
      layout.nodes.flatMap(function inner(n): LayoutEdge[] {
        return [...n.edges, ...n.children.flatMap(inner)];
      }),
    );
    const near = all
      .filter((e) => e.from === "file:src/b.ts" || e.to === "file:src/b.ts")
      .map((e) => (e.from === "file:src/b.ts" ? e.to : e.from));
    expect(focus.neighbours).toEqual(
      expect.arrayContaining([...new Set(near)].map((id) => boxes.get(id))),
    );
    // nothing selected: the first box of the include list, alone
    expect(startFocus(layout, [], NESTED)).toEqual({ boxes: [boxes.get("file:src/a.ts")] });
    expect(startFocus(layout, [], [])).toBeUndefined();
  });
});

const derived = (over: Partial<DerivedEdge>): DerivedEdge => ({
  id: "edge:x",
  from: "a",
  to: "b",
  kind: "calls",
  count: 1,
  resolution: "precise",
  stored: false,
  anchors: [],
  ...over,
});

describe("what a map draws", () => {
  it("leaves out a derived edge an authored one already says, and merges the kinds of one pair", () => {
    const edges = drawnEdges([
      derived({ id: "edge:calls:a->b", count: 5 }),
      derived({ id: "edge:references:a->b", kind: "references", count: 2 }),
      derived({ id: "edge:calls:b->a", from: "b", to: "a", count: 1, resolution: "heuristic" }),
      derived({ id: "edge:calls:a->c", to: "c", count: 3 }),
      derived({ id: "edge:said", to: "c", resolution: "llm", stored: true, label: "asks c" }),
    ]);
    expect(edges.map((e) => [e.id, e.label])).toEqual([
      ["edge:calls:a->b", "calls ×5 · references ×2"],
      ["edge:calls:b->a", undefined],
      ["edge:said", "asks c"],
    ]);
  });

  it.each([
    ["precise", "heuristic"],
    ["heuristic", "precise"],
    ["mixed", "precise"],
    ["precise", "mixed"],
  ] as const)("keeps %s and %s evidence mixed when merging kinds", (first, second) => {
    const edges = drawnEdges([
      derived({ resolution: first }),
      derived({ id: "edge:references", kind: "references", resolution: second }),
    ]);
    expect(edges.map((edge) => edge.resolution)).toEqual(["mixed"]);
  });

  it("draws an edge of a box to itself as a loop on its top-right corner, with its label", async () => {
    const graph: DerivedGraph = {
      nodes: [
        { id: "a", label: "findRoute", kind: "symbol", container: false },
        { id: "b", label: "other", kind: "symbol", container: false },
      ],
      edges: [
        derived({ id: "edge:loop", to: "a", resolution: "llm", stored: true, label: "recurses" }),
        derived({ id: "edge:ab" }),
      ],
      stubs: [],
      ghosts: [],
    };
    for (const layout of [await layoutGraph(graph), gridLayoutOf(graph)]) {
      const box = absoluteBoxes(layout.nodes).get("a")!;
      const loop = layout.edges.find((e) => e.id === "edge:loop")!;
      expect(loop.from).toBe("a");
      expect(loop.to).toBe("a");
      expect(loop.points.length).toBeGreaterThan(3);
      // out of the top, back into the right side
      expect(loop.points[0]!.y).toBeCloseTo(box.y, 5);
      expect(loop.points.at(-1)!.x).toBeCloseTo(box.x + box.width, 5);
      expect(Math.min(...loop.points.map((p) => p.y))).toBeLessThan(box.y);
      expect(loop.label?.text).toBe("recurses");
    }
  });

  it("takes an arrow out of a group on the side that faces its other end, and never back through the group", async () => {
    // xpl's own overview: cli (in a group with skill) serves the viewer, which is laid out above the group.
    const box = (id: string, parent?: string) => ({
      id,
      label: id,
      kind: "group" as const,
      container: id === "tools",
      ...(parent ? { parent } : {}),
    });
    const said = (from: string, to: string, label?: string) =>
      derived({ id: `edge:${from}-${to}`, from, to, ...(label ? { label, stored: true } : {}) });
    const graph: DerivedGraph = {
      nodes: [
        box("tools"),
        box("skill", "tools"),
        box("cli", "tools"),
        box("viewer"),
        box("indexer"),
        box("core"),
      ],
      edges: [
        said("skill", "cli", "runs the cli"),
        said("cli", "viewer", "viewer page"),
        said("viewer", "cli", "HTTP /api"),
        said("cli", "core"),
        said("cli", "indexer"),
        said("indexer", "core"),
        said("viewer", "core"),
      ],
      stubs: [],
      ghosts: [],
    };
    for (const direction of ["DOWN", "RIGHT"] as const) {
      const layout = await layoutGraph(graph, { direction });
      const group = absoluteBoxes(layout.nodes).get("tools")!;
      const inGroup = (p: { x: number; y: number }) =>
        p.x > group.x + 1 &&
        p.x < group.x + group.width - 1 &&
        p.y > group.y + 1 &&
        p.y < group.y + group.height - 1;
      for (const edge of layout.edges) {
        // walk the route in 2px steps: it goes in (or out of) the group once at most
        let changes = 0;
        let was: boolean | undefined;
        for (let i = 1; i < edge.points.length; i++) {
          const a = edge.points[i - 1]!,
            b = edge.points[i]!;
          const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2));
          for (let s = 0; s <= steps; s++) {
            const now = inGroup({
              x: a.x + ((b.x - a.x) * s) / steps,
              y: a.y + ((b.y - a.y) * s) / steps,
            });
            if (was !== undefined && now !== was) changes++;
            was = now;
          }
        }
        expect({ direction, edge: edge.id, changes }).toEqual({
          direction,
          edge: edge.id,
          changes: edge.from === "cli" || edge.to === "cli" ? 1 : 0,
        });
      }
    }
  });

  it("puts each label on or against a straight part of its own line, not on a bend", async () => {
    // the shape of the job runner's overview: one authored label and counted calls between files
    const files = ["main", "scheduling", "worker", "metrics", "bus", "queue"];
    const call = (from: string, to: string, label?: string) =>
      derived({
        id: `edge:${from}-${to}`,
        from,
        to,
        count: 3,
        ...(label ? { label, stored: true, resolution: "llm" as const } : {}),
      });
    const graph: DerivedGraph = {
      nodes: files.map((id) => ({
        id,
        label: `${id}.ts`,
        kind: "file" as const,
        container: false,
      })),
      edges: [
        call("main", "scheduling"),
        call("main", "worker"),
        call("main", "metrics"),
        call("scheduling", "worker"),
        call("scheduling", "queue"),
        call("worker", "metrics", "job.completed"),
        call("worker", "bus"),
        call("metrics", "bus"),
      ],
      stubs: [],
      ghosts: [],
    };
    for (const direction of ["DOWN", "RIGHT"] as const) {
      const layout = await layoutGraph(graph, { direction });
      for (const edge of layout.edges) {
        const label = edge.label!;
        // on its line, or beside it and touching it
        const corners = [0, 1].flatMap((i) =>
          [0, 1].map((j) => ({ x: label.x + i * label.width, y: label.y + j * label.height })),
        );
        const near = edge.points.slice(1).some((p, i) => {
          const a = edge.points[i]!;
          const crosses =
            Math.max(a.x, p.x) >= label.x &&
            Math.min(a.x, p.x) <= label.x + label.width &&
            Math.max(a.y, p.y) >= label.y &&
            Math.min(a.y, p.y) <= label.y + label.height;
          return (
            crosses ||
            corners.some((c) => distanceToSegment(c, a, p) <= 4) ||
            (a.y === p.y &&
              Math.min(Math.abs(a.y - label.y), Math.abs(a.y - label.y - label.height)) <= 4 &&
              Math.max(a.x, p.x) > label.x &&
              Math.min(a.x, p.x) < label.x + label.width)
          );
        });
        // a bend turns the line (a jog of a few px between two tracks, or a point on a straight line, is none)
        type P = { x: number; y: number };
        const turns = (a: P, p: P, b: P) =>
          Math.hypot(a.x - p.x, a.y - p.y) >= 4 &&
          Math.hypot(b.x - p.x, b.y - p.y) >= 4 &&
          Math.abs((p.x - a.x) * (b.y - p.y) - (p.y - a.y) * (b.x - p.x)) >
            0.1 * Math.hypot(a.x - p.x, a.y - p.y) * Math.hypot(b.x - p.x, b.y - p.y);
        const bends = edge.points
          .slice(1, -1)
          .filter((p, i) => turns(edge.points[i]!, p, edge.points[i + 2]!))
          .filter(
            (p) =>
              p.x > label.x &&
              p.x < label.x + label.width &&
              p.y > label.y &&
              p.y < label.y + label.height,
          );
        expect({ direction, edge: edge.id, onLine: near, bends }).toEqual({
          direction,
          edge: edge.id,
          onLine: true,
          bends: [],
        });
      }
    }
  });

  it("spreads labels that would overlap, along their own lines", () => {
    const label = (x: number, y: number) => ({ text: "calls ×5", x, y, width: 60, height: 18 });
    const edges = [
      {
        points: [
          { x: 0, y: 9 },
          { x: 400, y: 9 },
        ],
        label: label(100, 0),
      },
      {
        points: [
          { x: 0, y: 12 },
          { x: 400, y: 12 },
        ],
        label: label(120, 3),
      },
    ];
    spreadLabels(edges);
    const [a, b] = edges.map((e) => e.label);
    const apart = a!.x + a!.width <= b!.x || b!.x + b!.width <= a!.x;
    expect(apart).toBe(true);
    // still at its line (on it, or beside it and touching it, where the other line does not run through it)
    expect(b!.y <= 12 + 2 && b!.y + b!.height >= 12 - 2).toBe(true);
    expect(routeHitsLabel(edges[0]!.points, b!)).toBe(false);
  });

  it("keeps the Go overview event label off unrelated incoming routes", () => {
    const edges = [
      {
        points: [
          { x: 388.5, y: 288 },
          { x: 388.5, y: 304 },
          { x: 494, y: 304 },
          { x: 494, y: 328 },
          { x: 494.5, y: 368 },
        ],
        label: { text: "job.completed", x: 439.5, y: 319, width: 109, height: 18 },
      },
      {
        points: [
          { x: 447.95, y: 176 },
          { x: 447.95, y: 368 },
        ],
      },
      {
        points: [
          { x: 541.05, y: 268 },
          { x: 541.05, y: 368 },
        ],
      },
    ];
    spreadLabels(edges);
    const label = edges[0]!.label!;
    expect(edges.slice(1).map((edge) => routeHitsLabel(edge.points, label))).toEqual([
      false,
      false,
    ]);
    const centre = { x: label.x + label.width / 2, y: label.y + label.height / 2 };
    expect(
      Math.min(
        ...edges[0]!.points
          .slice(1)
          .map((point, i) => distanceToSegment(centre, edges[0]!.points[i]!, point)),
      ),
    ).toBeLessThan(12);
  });

  it("clears a foreign route with a small shift beside the owner's segment", () => {
    const edges = [
      {
        points: [
          { x: 359.55, y: 288 },
          { x: 359.55, y: 304 },
          { x: 457.25, y: 304 },
          { x: 457.25, y: 328 },
          { x: 457.5, y: 368 },
        ],
        label: { text: "job.completed", x: 405.75, y: 319, width: 103, height: 18 },
      },
      {
        points: [
          { x: 414.1, y: 176 },
          { x: 414.1, y: 368 },
        ],
      },
      {
        points: [
          { x: 500.9, y: 268 },
          { x: 500.9, y: 368 },
        ],
      },
    ];
    spreadLabels(
      edges,
      [
        { x: 259.25, y: 240, width: 118, height: 48 },
        { x: 395.5, y: 368, width: 124, height: 48 },
      ],
      { x: 0, y: 0, width: 629, height: 528 },
    );
    const label = edges[0]!.label!;
    expect(edges.slice(1).map((edge) => routeHitsLabel(edge.points, label))).toEqual([
      false,
      false,
    ]);
    expect(Math.abs(label.x + label.width / 2 - 359.55)).toBeLessThanOrEqual(2);
    expect(label.x + label.width).toBeLessThanOrEqual(414.1 - 4);
    expect(label.y).toBe(295);
  });

  it("does not move a cleared label into its target box", async () => {
    const graph: DerivedGraph = {
      nodes: Array.from({ length: 6 }, (_, i) => ({
        id: `n${i}`,
        label: `n${i}`,
        kind: "group" as const,
        role: "component" as const,
        container: false,
      })),
      edges: ["0-4", "1-2", "1-4", "3-4", "3-5"].map((pair) => ({
        id: `e${pair}`,
        from: `n${pair[0]}`,
        to: `n${pair[2]}`,
        kind: "calls" as const,
        label: pair === "1-2" || pair.startsWith("3-") ? "event.completed" : "short",
        count: 1,
        resolution: "static" as const,
        stored: true,
        anchors: [],
      })),
      stubs: [],
      ghosts: [],
    };
    const layout = await layoutGraph(graph);
    const label = layout.edges.find((edge) => edge.id === "e1-2")!.label!;
    const target = absoluteBoxes(layout.nodes).get("n2")!;
    expect(
      label.x + label.width <= target.x ||
        label.x >= target.x + target.width ||
        label.y + label.height <= target.y ||
        label.y >= target.y + target.height,
    ).toBe(true);
  });

  it("does not introduce a foreign-route hit while clearing another label", async () => {
    const graph: DerivedGraph = {
      nodes: Array.from({ length: 6 }, (_, i) => ({
        id: `n${i}`,
        label: `n${i}`,
        kind: "group" as const,
        role: "component" as const,
        container: false,
      })),
      edges: ["0-1", "1-3", "1-4", "2-3", "2-4", "2-5"].map((pair) => ({
        id: `e${pair}`,
        from: `n${pair[0]}`,
        to: `n${pair[2]}`,
        kind: "calls" as const,
        label: pair === "1-3" ? "short" : "event.completed",
        count: 1,
        resolution: "static" as const,
        stored: true,
        anchors: [],
      })),
      stubs: [],
      ghosts: [],
    };
    const layout = await layoutGraph(graph, { direction: "DOWN" });
    const label = layout.edges.find((edge) => edge.id === "e2-4")!.label!;
    const foreign = layout.edges.find((edge) => edge.id === "e2-5")!;
    expect(routeHitsLabel(foreign.points, label)).toBe(false);
  });
});

describe("labels and routes a reader can follow (round 2)", () => {
  const overlaps = (a: Box, b: Box) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  type Box = { x: number; y: number; width: number; height: number };

  it("moves a label off a box it would sit under, and keeps it at its own line", () => {
    // (the self map: "applyPatch, injectBundle, …" half under the Indexer box beside its line)
    const route = [
      { x: 60, y: 0 },
      { x: 60, y: 100 },
      { x: 180, y: 100 },
      { x: 180, y: 240 },
    ];
    const edges = [
      {
        points: route,
        label: { text: "applyPatch, injectBundle, …", x: 100, y: 91, width: 160, height: 18 },
      },
    ];
    const box = { x: 230, y: 105, width: 100, height: 60 };
    spreadLabels(edges, [box], { x: 0, y: 0, width: 400, height: 240 });
    const label = edges[0]!.label!;
    expect(overlaps(label, box)).toBe(false);
    // on its line, or beside it and touching it
    const grown = {
      x: label.x - 4,
      y: label.y - 4,
      width: label.width + 8,
      height: label.height + 8,
    };
    expect(routeHitsLabel(route, grown)).toBe(true);
  });

  it("drops a detour that runs past the turn and doubles back", () => {
    // (the self map's "viewer page" arrow: left to x 153, up 6 px, then right again to x 330)
    const route = [
      { x: 403, y: 388 },
      { x: 403, y: 359 },
      { x: 376, y: 359 },
      { x: 376, y: 123 },
      { x: 153, y: 123 },
      { x: 153, y: 117 },
      { x: 330, y: 117 },
      { x: 330, y: 80 },
    ];
    expect(dropDetours(route)).toEqual([
      { x: 403, y: 388 },
      { x: 403, y: 359 },
      { x: 376, y: 359 },
      { x: 376, y: 123 },
      { x: 330, y: 123 },
      { x: 330, y: 80 },
    ]);
    // a route that turns back around something (a long way across) keeps its shape
    const around = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 60 },
      { x: 20, y: 60 },
    ];
    expect(dropDetours(around)).toEqual(around);
  });

  it("draws two arrows between the same two boxes, one each way, as one line with a head at each end", async () => {
    const node = (id: string) => ({ id, label: id, kind: "group" as const, container: false });
    const graph: DerivedGraph = {
      nodes: [node("cli"), node("viewer"), node("core")],
      edges: [
        derived({
          id: "edge:embeds",
          from: "cli",
          to: "viewer",
          label: "viewer page (dist/index.html)",
          stored: true,
          resolution: "llm",
        }),
        derived({
          id: "edge:api",
          from: "viewer",
          to: "cli",
          label: "HTTP /api (xpl view)",
          stored: true,
          resolution: "llm",
        }),
        derived({ id: "edge:calls:cli->core", from: "cli", to: "core", count: 4 }),
      ],
      stubs: [],
      ghosts: [],
    };
    for (const direction of ["DOWN", "RIGHT"] as const) {
      const layout = await layoutGraph(graph, { direction });
      const there = layout.edges.find((edge) => edge.id === "edge:embeds")!;
      const back = layout.edges.find((edge) => edge.id === "edge:api")!;
      // one route, read both ways
      expect(back.points).toEqual([...there.points].reverse());
      // each label on the line, apart from the other
      expect(overlaps(there.label!, back.label!)).toBe(false);
      // a click near an arrow's head picks that arrow: its anchor is on its own half of the line
      const half = (edge: LayoutEdge) => {
        const tip = edge.points.at(-1)!;
        const tail = edge.points[0]!;
        return (
          Math.hypot(edge.anchor.x - tip.x, edge.anchor.y - tip.y) <=
          Math.hypot(edge.anchor.x - tail.x, edge.anchor.y - tail.y) + 0.5
        );
      };
      expect([direction, half(there), half(back)]).toEqual([direction, true, true]);
      // each label points the way its own arrow goes (R3-18): on one line, two labels must not read alike
      const way = (edge: LayoutEdge) => {
        const [a, b] = [edge.points[0]!, edge.points.at(-1)!];
        return Math.abs(b.x - a.x) >= Math.abs(b.y - a.y)
          ? b.x > a.x
            ? "→"
            : "←"
          : b.y > a.y
            ? "↓"
            : "↑";
      };
      for (const edge of [there, back]) expect(edge.label!.text).toContain(way(edge));
      expect(way(there)).not.toBe(way(back));
    }
  });
});

describe("what a still picture's frame cuts", () => {
  const node = (id: string, x: number, y: number, children: LayoutNode[] = []) =>
    ({ id, x, y, width: 100, height: 40, children, edges: [] }) as unknown as LayoutNode;
  const edge = (id: string, from: string, to: string) => ({ id, from, to }) as LayoutEdge;

  it("is the boxes not wholly in the frame, and the arrows with an end out of it", () => {
    const layout = {
      nodes: [node("a", 0, 0), node("b", 0, 100), node("c", 0, 300), node("d", 150, 100)],
      edges: [edge("a-b", "a", "b"), edge("b-c", "b", "c"), edge("b-d", "b", "d")],
    };
    // the frame shows a and b whole, d in part, c not at all
    const cut = cutAt(layout, { x: 0, y: 0, width: 200, height: 200 });
    expect([...cut].sort()).toEqual(["b-c", "b-d", "c", "d"]);
  });

  it("keeps a container that is partly in the frame, and the arrows into it", () => {
    const group = node("g", 0, 100, [node("inner", 10, 30)]);
    (group as { width: number; height: number }).width = 400;
    (group as { width: number; height: number }).height = 400;
    const layout = { nodes: [node("a", 0, 0), group], edges: [edge("a-g", "a", "g")] };
    const cut = cutAt(layout, { x: 0, y: 0, width: 300, height: 250 });
    expect(cut.has("g")).toBe(false);
    expect(cut.has("a-g")).toBe(false);
    expect(cut.has("inner")).toBe(false);
  });
});

/** A data-model view (`GraphView.boxText: "members"`): types as tables, fields as rows, arrows from the rows. */
describe("tables", () => {
  const type = (id: string): DerivedGraph["nodes"][number] => ({
    id,
    label: id,
    kind: "symbol",
    symbolKind: "interface",
    container: true,
    rows: true,
  });
  const field = (parent: string, name: string, row: number, memberType: string) => ({
    id: `${parent}.${name}`,
    label: name,
    kind: "symbol" as const,
    symbolKind: "variable" as const,
    container: false,
    parent,
    row,
    memberType,
  });
  const graph: DerivedGraph = {
    // in id order, as core gives them: the rows follow `row`, not this order
    nodes: [
      type("DeadJob"),
      field("DeadJob", "error", 1, "string"),
      field("DeadJob", "job", 0, "Job"),
      type("Job"),
      field("Job", "attempts", 1, "number"),
      field("Job", "id", 0, "string"),
    ],
    edges: [
      {
        id: "edge:references:DeadJob.job->Job",
        from: "DeadJob.job",
        to: "Job",
        kind: "references",
        count: 1,
        resolution: "precise",
        stored: false,
        anchors: [],
      },
    ],
    stubs: [],
    ghosts: [],
  };

  it("stacks the rows under the header in code order, as wide as the table, and reads to the right", async () => {
    const layout = await layoutGraph(graph, { direction: "DOWN" });
    expect(layout.direction).toBe("RIGHT");
    const dead = layout.nodes.find((n) => n.id === "DeadJob")!;
    expect(dead.rows).toBe(true);
    expect(dead.children.map((c) => [c.id, c.row, c.memberType, c.width === dead.width])).toEqual([
      ["DeadJob.job", true, "Job", true],
      ["DeadJob.error", true, "string", true],
    ]);
    const [first, second] = dead.children;
    expect(second!.y).toBe(first!.y + first!.height);
    expect(dead.height).toBeGreaterThanOrEqual(second!.y + second!.height);
  });

  it("starts a row's arrow on the table's side at the row's height, and ends it at the other table's header", async () => {
    const layout = await layoutGraph(graph);
    const boxes = absoluteBoxes(layout.nodes);
    const row = boxes.get("DeadJob.job")!;
    const job = boxes.get("Job")!;
    const edge = layout.edges.find((e) => e.id === "edge:references:DeadJob.job->Job")!;
    const start = edge.points[0]!;
    const end = edge.points.at(-1)!;
    expect(start.x).toBe(row.x + row.width);
    expect(start.y).toBe(row.y + row.height / 2);
    expect(end.x).toBe(job.x);
    // the header band: above the first row of Job
    expect(end.y).toBeGreaterThan(job.y);
    expect(end.y).toBeLessThan(boxes.get("Job.id")!.y);
  });
});
