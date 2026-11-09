/**
 * How a flow is laid out for reading (round 2, V2-06 and V1-08): the step numbers read left to right where a path
 * splits, the main path of a run of choices goes straight down, and a box is as tall as its words.
 */
import { processFlow, type SequenceView } from "@xpl/core";
import { describe, expect, it } from "vitest";
import { layoutFlow, type FlowLayout } from "../src/layout/flowLayout.js";

const F = "sym:a.ts#run";
type Step = Partial<SequenceView["steps"][number]>;

function flowOf(steps: Step[]) {
  return processFlow({
    id: "view:f",
    type: "flow",
    title: "F",
    scope: { root: "repo", depth: 1 },
    participants: [F],
    provenance: { origin: "llm" },
    steps: steps.map((step, n) => ({
      id: `f:${n + 1}`,
      from: F,
      to: F,
      label: `Stage ${n + 1}`,
      kind: "call",
      anchors: [],
      ...step,
    })),
  });
}

const box = (layout: FlowLayout, id: string) => layout.children.find((child) => child.id === id)!;
const centreX = (layout: FlowLayout, id: string) => box(layout, id).x + box(layout, id).width / 2;

/** True when no route of the flow runs through a box it does not start or end at. */
function routesClearBoxes(layout: FlowLayout): boolean {
  return layout.edges.every((edge) => {
    const points = edge.sections.flatMap((s) => [s.startPoint, ...s.bendPoints, s.endPoint]);
    return layout.children
      .filter((child) => child.id !== edge.from && child.id !== edge.to)
      .every((child) =>
        points.slice(1).every((p, i) => {
          const a = points[i]!;
          const inside = (v: number, lo: number, hi: number) => v > lo + 1 && v < hi - 1;
          if (Math.abs(a.x - p.x) < 0.5)
            return !(
              inside(a.x, child.x, child.x + child.width) &&
              Math.max(a.y, p.y) > child.y + 1 &&
              Math.min(a.y, p.y) < child.y + child.height - 1
            );
          return !(
            inside(a.y, child.y, child.y + child.height) &&
            Math.max(a.x, p.x) > child.x + 1 &&
            Math.min(a.x, p.x) < child.x + child.width - 1
          );
        }),
      );
  });
}

describe("a flow laid out for reading", () => {
  it("puts the branch with the lower step numbers on the left, whatever order its links were written in", async () => {
    // (zod's "parse or safeParse" flow: dagre drew the larger safeParse path, steps 6-12, on the left)
    const flow = flowOf([
      {
        next: [
          { step: "f:2", label: "parse" },
          { step: "f:6", label: "safeParse" },
        ],
      },
      {},
      {
        next: [
          { step: "f:5", label: "yes" },
          { step: "f:4", label: "no" },
        ],
      },
      { shape: "terminal" },
      { shape: "terminal" },
      {},
      {
        next: [
          { step: "f:9", label: "yes" },
          { step: "f:8", label: "no" },
        ],
      },
      { shape: "terminal" },
      {},
      {
        next: [
          { step: "f:11", label: "yes" },
          { step: "f:12", label: "no" },
        ],
      },
      { shape: "terminal" },
      { shape: "terminal" },
    ]);
    const layout = await layoutFlow(flow);
    for (const [left, right] of [
      ["f:2", "f:6"],
      ["f:3", "f:7"],
      ["f:4", "f:5"],
      ["f:8", "f:9"],
      ["f:11", "f:12"],
    ] as const)
      expect([left, centreX(layout, left) < centreX(layout, right)]).toEqual([left, true]);
    expect(routesClearBoxes(layout)).toBe(true);
  });

  it("keeps the main path of a run of choices in one column, with each early exit beside it", async () => {
    const flow = flowOf([
      {
        next: [
          { step: "f:2", label: "yes" },
          { step: "f:3", label: "no" },
        ],
      },
      { shape: "terminal", label: "Reload" },
      {
        next: [
          { step: "f:4", label: "yes" },
          { step: "f:5", label: "no" },
        ],
      },
      { shape: "terminal", label: "Reload" },
      {
        next: [
          { step: "f:6", label: "yes" },
          { step: "f:7", label: "no" },
        ],
      },
      { shape: "terminal", label: "Reload" },
      {
        next: [
          { step: "f:8", label: "yes" },
          { step: "f:9", label: "no" },
        ],
      },
      { shape: "terminal", label: "Reload" },
      { shape: "terminal", label: "Update" },
    ]);
    const layout = await layoutFlow(flow);
    const main = ["f:1", "f:3", "f:5", "f:7"].map((id) => centreX(layout, id));
    expect(Math.max(...main) - Math.min(...main)).toBeLessThan(1);
    expect(routesClearBoxes(layout)).toBe(true);
  });

  it("makes a box with a one-line label shorter than one with three lines", async () => {
    const layout = await layoutFlow(
      flowOf([
        { label: "Run" },
        { label: "Read the settings file, check each key and fill in the defaults it lacks" },
      ]),
    );
    expect(box(layout, "f:1").height).toBeLessThan(box(layout, "f:2").height);
  });
});
