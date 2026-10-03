/**
 * Recursion in a flow (recurse and return links, loops on one box) and arrows "via" code that has no box (review
 * 2026-10-03, A6).
 */
import { processFlow, type DerivedGraph, type SequenceView } from "@xpl/core";
import { describe, expect, it } from "vitest";
import { layoutFlow, levelTitle, transitionText } from "../src/layout/flowLayout.js";
import { layoutGraph } from "../src/layout/graphLayout.js";
import { codeFirstView } from "../src/workspace.js";

const F = "sym:tree.go#node.findRoute";
function view(steps: Partial<SequenceView["steps"][number]>[]): SequenceView {
  return {
    id: "view:match",
    type: "flow",
    title: "Match",
    scope: { root: "repo", depth: 1 },
    participants: [F],
    provenance: { origin: "llm" },
    steps: steps.map((step, n) => ({
      id: `match:${n + 1}`,
      from: F,
      to: F,
      label: `Stage ${n + 1}`,
      kind: "call",
      anchors: [],
      ...step,
    })),
  };
}

describe("flow: recurse and return links", () => {
  it("say which way the level changes, after their own words", () => {
    expect(transitionText({ label: "yes" })).toBe("yes");
    expect(transitionText({})).toBeUndefined();
    expect(transitionText({ kind: "recurse" })).toBe("one level down");
    expect(transitionText({ kind: "recurse", label: "the child" })).toBe(
      "the child (one level down)",
    );
    expect(transitionText({ kind: "return", label: "found" })).toBe("found (up one level)");
    expect(levelTitle("recurse", "Groups left?")).toContain('steps from "Groups left?" run again');
  });

  it("are laid out as transitions that keep their kind and label", async () => {
    const flow = processFlow(
      view([
        { shape: "decision", next: [{ step: "match:2", label: "yes" }, { step: "match:3" }] },
        { next: [{ step: "match:1", kind: "recurse", label: "the child" }] },
        { shape: "terminal", next: [{ step: "match:2", kind: "return", label: "found" }] },
      ]),
    );
    const layout = await layoutFlow(flow);
    const byKind = (kind: string) => layout.edges.find((edge) => edge.kind === kind)!;
    expect(byKind("recurse")).toMatchObject({ from: "match:2", to: "match:1" });
    expect(byKind("recurse").labels[0]!.text).toBe("the child (one level down)");
    expect(byKind("return")).toMatchObject({ from: "match:3", to: "match:2" });
    // the step with only a recurse link still goes on to the next one
    expect(layout.edges.some((edge) => edge.from === "match:2" && edge.to === "match:3")).toBe(
      true,
    );
  });

  it("draws a stage's link to itself as a loop on its right side, inside the picture", async () => {
    const flow = processFlow(
      view([
        {
          shape: "decision",
          next: [
            { step: "match:1", label: "no: next node" },
            { step: "match:2", label: "fits" },
          ],
        },
        { next: [{ step: "match:2", kind: "recurse" }] },
      ]),
    );
    const layout = await layoutFlow(flow);
    for (const id of ["match:1", "match:2"]) {
      const loop = layout.edges.find((edge) => edge.from === id && edge.to === id)!;
      const box = layout.children.find((child) => child.id === id)!;
      const { startPoint, bendPoints, endPoint } = loop.sections[0]!;
      expect(startPoint.x).toBeCloseTo(box.x + box.width, 0);
      expect(Math.max(...bendPoints.map((p) => p.x))).toBeGreaterThan(box.x + box.width);
      expect(endPoint.y).toBeLessThan(startPoint.y);
      expect(loop.labels[0]!.x).toBeGreaterThan(box.x + box.width);
      expect(layout.width).toBeGreaterThanOrEqual(loop.labels[0]!.x + loop.labels[0]!.width);
    }
    expect(
      layout.edges.find((edge) => edge.from === "match:2" && edge.to === "match:2")!.kind,
    ).toBe("recurse");
  });
});

describe("map: an arrow via code without a box", () => {
  it("names what it passes through in its label and keeps the names for its tooltip", async () => {
    const graph: DerivedGraph = {
      nodes: [
        { id: "file:a.ts", label: "a.ts", kind: "file", container: false },
        { id: "file:c.ts", label: "c.ts", kind: "file", container: false },
      ],
      edges: [
        {
          id: "edge:a-c",
          from: "file:a.ts",
          to: "file:c.ts",
          kind: "calls",
          label: "loads the plugins",
          count: 1,
          resolution: "llm",
          stored: true,
          anchors: [],
          via: [{ id: "sym:b.ts#load", label: "load" }],
        },
      ],
      stubs: [],
      ghosts: [],
    };
    const layout = await layoutGraph(graph);
    const edge = layout.edges.find((e) => e.id === "edge:a-c")!;
    expect(edge.label!.text).toBe("loads the plugins (via load)");
    expect(edge.via).toEqual(["load"]);
    expect(edge.counted).toBe(false);
  });
});

describe("code-first views", () => {
  const at = (file: string) => ({ file, role: "call-site" as const, hash: "" });
  const steps = (files: string[]) => view(files.map((file) => ({ anchors: [at(file)] })));

  it("are the flows and sequences whose steps' code is all in one file", () => {
    expect(codeFirstView(steps(["tree.go", "tree.go", "tree.go"]))).toBe(true);
    expect(codeFirstView({ ...steps(["tree.go", "tree.go", "tree.go"]), type: "sequence" })).toBe(
      true,
    );
    expect(codeFirstView(steps(["tree.go", "mux.go", "tree.go"]))).toBe(false);
    // too short to need it, or a step without code
    expect(codeFirstView(steps(["tree.go", "tree.go"]))).toBe(false);
    expect(
      codeFirstView(view([{ anchors: [at("tree.go")] }, {}, { anchors: [at("tree.go")] }])),
    ).toBe(false);
    // code before the change does not count
    expect(
      codeFirstView(
        view([
          { anchors: [at("tree.go")] },
          { anchors: [at("tree.go"), { ...at("mux.go"), at: "base" as const }] },
          { anchors: [at("tree.go")] },
        ]),
      ),
    ).toBe(true);
  });

  it("follow the view's layout setting when it has one", () => {
    expect(codeFirstView({ ...steps(["a.go", "b.go"]), layout: "code-first" })).toBe(true);
    expect(codeFirstView({ ...steps(["a.go", "a.go", "a.go"]), layout: "diagram" })).toBe(false);
    expect(codeFirstView(undefined)).toBe(false);
  });
});
