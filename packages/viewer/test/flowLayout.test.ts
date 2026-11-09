/**
 * How a flow is laid out for reading (round 2, V2-06 and V1-08): the step numbers read left to right where a path
 * splits, the main path of a run of choices goes straight down, and a box is as tall as its words.
 */
import { processFlow, type SequenceView } from "@xpl/core";
import { describe, expect, it } from "vitest";
import {
  decisionSize,
  layoutFlow,
  layoutFlowFitting,
  stateRoles,
  type FlowLayout,
} from "../src/layout/flowLayout.js";

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

/** The routes of the flow that run through a box they do not start or end at: "a->b crosses c" (none is right). */
function routesThroughBoxes(layout: FlowLayout): string[] {
  const out: string[] = [];
  for (const edge of layout.edges) {
    const points = edge.sections.flatMap((s) => [s.startPoint, ...s.bendPoints, s.endPoint]);
    for (const child of layout.children) {
      if (child.id === edge.from || child.id === edge.to) continue;
      const crosses = points.slice(1).some((p, i) => {
        const a = points[i]!;
        const inside = (v: number, lo: number, hi: number) => v > lo + 1 && v < hi - 1;
        if (Math.abs(a.x - p.x) < 0.5)
          return (
            inside(a.x, child.x, child.x + child.width) &&
            Math.max(a.y, p.y) > child.y + 1 &&
            Math.min(a.y, p.y) < child.y + child.height - 1
          );
        return (
          inside(a.y, child.y, child.y + child.height) &&
          Math.max(a.x, p.x) > child.x + 1 &&
          Math.min(a.x, p.x) < child.x + child.width - 1
        );
      });
      if (crosses) out.push(`${edge.from}->${edge.to} crosses ${child.id}`);
    }
  }
  return out;
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
    expect(routesThroughBoxes(layout)).toEqual([]);
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
    expect(routesThroughBoxes(layout)).toEqual([]);
  });

  it("never puts one box on another when it straightens a main path", async () => {
    // zod's "outcome" flow: two choices side by side, each with two ends; moving one end aside put it on
    // the other choice's end ("Construct and throw error" under "Return successful result")
    const layout = await layoutFlow(
      flowOf([
        {
          label: "Choose parse or safeParse",
          shape: "decision",
          next: [
            { step: "f:2", label: "parse" },
            { step: "f:6", label: "safeParse" },
          ],
        },
        { label: "parse runs the schema", shape: "stage" },
        {
          label: "parse found issues?",
          shape: "decision",
          next: [
            { step: "f:5", label: "yes" },
            { step: "f:4", label: "no" },
          ],
        },
        { label: "Return parsed value", shape: "terminal" },
        { label: "Construct and throw error", shape: "terminal" },
        { label: "safeParse runs the schema", shape: "stage" },
        {
          label: "safeParse found issues?",
          shape: "decision",
          next: [
            { step: "f:9", label: "yes" },
            { step: "f:8", label: "no" },
          ],
        },
        { label: "Return successful result", shape: "terminal" },
        { label: "Return failed result", shape: "stage" },
        {
          label: "Does caller read error?",
          shape: "decision",
          next: [
            { step: "f:11", label: "yes" },
            { step: "f:12", label: "no" },
          ],
        },
        { label: "Build and cache error", shape: "terminal" },
        { label: "Keep failed result", shape: "terminal" },
      ]),
    );
    const boxes = layout.children;
    const overlaps = boxes.flatMap((a, i) =>
      boxes
        .slice(i + 1)
        .filter(
          (b) =>
            a.x < b.x + b.width &&
            b.x < a.x + a.width &&
            a.y < b.y + b.height &&
            b.y < a.y + a.height,
        )
        .map((b) => `${a.id} on ${b.id}`),
    );
    expect(overlaps).toEqual([]);
    expect(routesThroughBoxes(layout)).toEqual([]);
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

/** Vite's "update, reload or no update" flow: a run of five choices, each with an early exit. */
function choices() {
  const choice = (yes: number, no: number, label: string): Step => ({
    label,
    shape: "decision",
    next: [
      { step: `f:${yes}`, label: "yes" },
      { step: `f:${no}`, label: "no" },
    ],
  });
  return flowOf([
    choice(6, 2, "No matched modules?"),
    { label: "Trace affected modules" },
    choice(6, 4, "Dead end found?"),
    choice(6, 5, "Circular invalidation?"),
    choice(6, 7, "HTML template changed?"),
    { label: "Reload the page", shape: "terminal" },
    choice(9, 8, "Any updates to send?"),
    { label: "Stop without an update", shape: "terminal" },
    { label: "Send targeted updates", shape: "terminal" },
  ]);
}

/** The scale the viewer fits a layout into a pane at (PanZoom: 24 px of padding a side, at most 1.25). */
const fit = (layout: FlowLayout, pane: { width: number; height: number }) =>
  Math.min(1.25, (pane.width - 48) / layout.width, (pane.height - 48) / layout.height);

const overlaps = (layout: FlowLayout) =>
  layout.children.flatMap((a, i) =>
    layout.children
      .slice(i + 1)
      .filter(
        (b) =>
          a.x < b.x + b.width &&
          b.x < a.x + a.width &&
          a.y < b.y + b.height &&
          b.y < a.y + a.height,
      )
      .map((b) => `${a.id} on ${b.id}`),
  );

describe("a long flow in a laptop's pane", () => {
  const pane = { width: 1202, height: 770 };

  it("is set left to right in rows when one column top to bottom would show it at half size", async () => {
    // one column, top to bottom, is 1,200 units tall: fitted, its 14 px words come out at about 8 px
    const column = await layoutFlow(choices());
    expect(fit(column, pane)).toBeLessThan(0.62);
    const layout = await layoutFlowFitting(choices(), pane);
    expect([layout.direction, layout.parts]).toEqual(["RIGHT", 2]);
    expect(fit(layout, pane)).toBeGreaterThanOrEqual(0.8);
    expect(overlaps(layout)).toEqual([]);
    expect(routesThroughBoxes(layout)).toEqual([]);
  });

  it("keeps a flow that fits top to bottom in one column", async () => {
    const layout = await layoutFlowFitting(flowOf([{}, {}, {}]), pane);
    expect([layout.direction, layout.parts]).toEqual(["DOWN", 1]);
  });

  it("runs the arrow from the end of one row to the start of the next between the rows", async () => {
    const layout = await layoutFlow(choices(), { direction: "RIGHT", parts: 2 });
    expect(layout.parts).toBe(2);
    const rows = [...new Set(layout.children.map((c) => Math.round(c.y)))].sort((a, b) => a - b);
    const top = (id: string) => box(layout, id).y;
    // the first steps on the first row, the last ones below them, read from the left again
    expect(top("f:9")).toBeGreaterThan(top("f:1") + box(layout, "f:1").height);
    expect(box(layout, "f:9").x).toBeGreaterThan(box(layout, "f:7").x);
    expect(rows.length).toBeGreaterThan(1);
    expect(overlaps(layout)).toEqual([]);
    expect(routesThroughBoxes(layout)).toEqual([]);
  });
});

describe("a decision diamond", () => {
  it("is as big as its words, not a fixed 300 by 150", () => {
    const short = decisionSize("Dead end found?");
    expect(short.width).toBeLessThan(300);
    expect(short.height).toBeLessThan(100);
    // narrower lines (a left-to-right flow): a narrower, taller diamond
    const across = decisionSize("Dead end found?", "", 14);
    expect(across.width).toBeLessThan(200);
    const long = decisionSize("Does the caller read the error before it returns the result?");
    expect(long.width).toBeGreaterThan(short.width);
    expect(long.height).toBeGreaterThan(short.height);
  });

  it("sends its arrows from its outline, not from the empty corners of its box", async () => {
    const layout = await layoutFlow(
      flowOf([
        {
          label: "Dead end found?",
          shape: "decision",
          next: [
            { step: "f:2", label: "yes" },
            { step: "f:3", label: "no" },
          ],
        },
        { shape: "terminal" },
        { shape: "terminal" },
      ]),
    );
    const d = box(layout, "f:1");
    const cx = d.x + d.width / 2,
      cy = d.y + d.height / 2;
    const starts = layout.edges
      .filter((edge) => edge.from === "f:1")
      .map((edge) => edge.sections[0]!.startPoint);
    expect(starts).toHaveLength(2);
    for (const p of starts) {
      // on the diamond: |dx| / half-width + |dy| / half-height = 1
      const onIt = Math.abs(p.x - cx) / (d.width / 2) + Math.abs(p.y - cy) / (d.height / 2);
      expect(onIt).toBeCloseTo(1, 2);
    }
  });
});

describe("a flow of states (xpl draft states)", () => {
  const T = "sym:src/status.ts#JobStatus";
  const start = "sym:src/status.ts#Tracker.start";
  const finish = "sym:src/status.ts#Tracker.finish";
  const step = (id: string, from: string, next: string[]) => ({
    id,
    from,
    to: from,
    label: id,
    kind: "call" as const,
    anchors: [],
    next: next.map((s) => ({ step: s })),
  });
  const view = {
    type: "flow" as const,
    scope: { root: "repo", depth: 2, entryPoints: ["src/status.ts#JobStatus"] },
    participants: [T, start, finish],
    steps: [
      step("queued", T, ["start"]),
      step("start", start, ["running"]),
      step("running", T, ["finish"]),
      step("finish", finish, ["done"]),
      step("done", T, []),
    ],
  };

  it("tells its states from its moves", () => {
    expect(Object.fromEntries(stateRoles(view as never)!)).toEqual({
      queued: "state",
      start: "move",
      running: "state",
      finish: "move",
      done: "state",
    });
  });

  it("finds none in an ordinary flow, even one whose steps all stay in one function", () => {
    expect(stateRoles({ ...view, scope: { root: "repo", depth: 2 } } as never)).toBeUndefined();
    const one = { ...view, steps: view.steps.map((s) => ({ ...s, from: T, to: T })) };
    expect(stateRoles(one as never)).toBeUndefined();
  });
});
