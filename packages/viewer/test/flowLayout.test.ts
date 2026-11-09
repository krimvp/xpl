import { readFileSync } from "node:fs";
/**
 * How a flow is laid out for reading: the step numbers read left to right where a path
 * splits, the main path of a run of choices goes straight down, and a box is as tall as its words.
 */
import { processFlow, type SequenceView } from "@xpl/core";
import { describe, expect, it } from "vitest";
import {
  decisionSize,
  layoutFlow,
  layoutFlowFitting,
  stateMachine,
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

  // zod's parse and safeParse: "yes" (step 5) sat above "no" (step 4), so the numbers ran upward
  it("puts the ends of a choice in step order, left to right, or top to bottom when turned", async () => {
    const choice = (yes: number, no: number, label: string, yesWord = "yes", noWord = "no") => ({
      label,
      shape: "decision" as const,
      next: [
        { step: `f:${yes}`, label: yesWord },
        { step: `f:${no}`, label: noWord },
      ],
    });
    const end = (label: string) => ({ label, shape: "terminal" as const });
    const flow = flowOf([
      choice(2, 6, "Choose parse or safeParse", "parse", "safeParse"),
      { label: "parse runs the schema" },
      choice(5, 4, "parse found issues?"),
      end("Return parsed value"),
      end("Construct and throw error"),
      { label: "safeParse runs the schema" },
      choice(9, 8, "safeParse found issues?"),
      end("Return successful result"),
      { label: "Return failed result" },
      choice(11, 12, "Does caller read error?"),
      end("Build and cache error"),
      end("Keep failed result"),
    ]);
    for (const direction of ["DOWN", "RIGHT"] as const) {
      const layout = await layoutFlow(flow, { direction });
      const at = (id: string) => (direction === "DOWN" ? box(layout, id).x : box(layout, id).y);
      expect([at("f:4") < at("f:5"), at("f:8") < at("f:9")]).toEqual([true, true]);
      expect(overlaps(layout)).toEqual([]);
      expect(routesThroughBoxes(layout)).toEqual([]);
    }
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
function choices({ reloadGoesOn = false } = {}) {
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
    // (a reload that goes on to the end is no end of its own: it is drawn once)
    reloadGoesOn
      ? { label: "Reload the page", next: [{ step: "f:9" }] }
      : { label: "Reload the page", shape: "terminal" },
    choice(9, 8, "Any updates to send?"),
    { label: "Stop without an update", shape: "terminal" },
    { label: "Send targeted updates", shape: "terminal" },
  ]);
}

/**
 * ky's retry decision (`Ky.#calculateRetryDelay`): 12 steps, 9 choices in a row, "Throw: no retry" reached 7
 * ways. Step 10 is in another function, so it is the one box that names its function.
 */
function kyRetry() {
  const choice = (label: string, ...next: [number, string][]): Step => ({
    label,
    shape: "decision",
    next: next.map(([n, word]) => ({ step: `f:${n}`, label: word })),
  });
  return flowOf([
    choice("Retries left?", [2, "yes"], [12, "no"]),
    choice("Forced by a hook?", [10, "yes"], [3, "no"]),
    choice("Method allowed?", [4, "yes"], [12, "no"]),
    choice("What does shouldRetry say?", [5, "true, other or not set"], [12, "false"]),
    choice(
      "Which kind of failure?",
      [6, "timeout"],
      [7, "bad status"],
      [10, "network error"],
      [12, "other"],
    ),
    choice("Retry timeouts?", [10, "yes"], [12, "no"]),
    choice("Status in the list?", [8, "yes"], [12, "no"]),
    choice("Did the server say when?", [11, "yes"], [9, "no"]),
    choice("Payload too large?", [12, "yes"], [10, "no"]),
    { label: "Compute the backoff wait", next: [] },
    { label: "Use the server's wait", shape: "terminal", next: [] },
    { label: "Throw: no retry", shape: "terminal", next: [] },
  ]);
}
const kyActors = new Map([["f:10", "Ky.#calculateDelay"]]);

/**
 * A flow of `n` steps from where each leads: a number is the next step of a stage, a pair the "yes" and "no"
 * of a choice ("Choice 4?"). The last two steps are ends.
 */
function runOf(n: number, next: Record<number, number | [number, number]>) {
  return flowOf(
    Array.from({ length: n }, (_, i): Step => {
      const way = next[i + 1];
      if (way === undefined) return { label: `Stage ${i + 1}`, shape: "terminal", next: [] };
      if (typeof way === "number") return { label: `Stage ${i + 1}`, next: [{ step: `f:${way}` }] };
      return {
        label: `Choice ${i + 1}?`,
        shape: "decision",
        next: [
          { step: `f:${way[0]}`, label: "yes" },
          { step: `f:${way[1]}`, label: "no" },
        ],
      };
    }),
  );
}

/** The longest stretch two routes share (on one line, overlapping), in diagram units. */
function sharedRun(a: FlowLayout["edges"][number], b: FlowLayout["edges"][number]): number {
  const segments = (edge: FlowLayout["edges"][number]) => {
    const points = edge.sections.flatMap((s) => [s.startPoint, ...s.bendPoints, s.endPoint]);
    return points.slice(1).map((p, i) => [points[i]!, p] as const);
  };
  let longest = 0;
  for (const [p, q] of segments(a))
    for (const [r, t] of segments(b)) {
      const vertical = Math.abs(p.x - q.x) < 0.5 && Math.abs(r.x - t.x) < 0.5;
      const horizontal = Math.abs(p.y - q.y) < 0.5 && Math.abs(r.y - t.y) < 0.5;
      if (vertical && Math.abs(p.x - r.x) < 0.5)
        longest = Math.max(
          longest,
          Math.min(Math.max(p.y, q.y), Math.max(r.y, t.y)) -
            Math.max(Math.min(p.y, q.y), Math.min(r.y, t.y)),
        );
      if (horizontal && Math.abs(p.y - r.y) < 0.5)
        longest = Math.max(
          longest,
          Math.min(Math.max(p.x, q.x), Math.max(r.x, t.x)) -
            Math.max(Math.min(p.x, q.x), Math.min(r.x, t.x)),
        );
    }
  return longest;
}

/**
 * The pairs of routes from different boxes into different boxes that run side by side closer than `gap` for
 * more than 4 units ("f:6->f:12#5 near f:9->f:10"): on screen they read as one line. (The arrows out of one
 * box leave it at its ports, `spreadPorts`, some 12 units apart.)
 */
function closeRuns(layout: FlowLayout, gap: number): string[] {
  const segments = (edge: FlowLayout["edges"][number]) => {
    const points = edge.sections.flatMap((s) => [s.startPoint, ...s.bendPoints, s.endPoint]);
    return points.slice(1).map((p, i) => [points[i]!, p] as const);
  };
  const out: string[] = [];
  layout.edges.forEach((a, i) =>
    layout.edges.slice(i + 1).forEach((b) => {
      if (a.to === b.to || a.from === b.from) return;
      const near = segments(a).some(([p, q]) =>
        segments(b).some(([r, t]) => {
          for (const [u, v] of [
            ["x", "y"],
            ["y", "x"],
          ] as const) {
            // both run along v, at u values closer than the gap
            if (Math.abs(p[u] - q[u]) > 0.5 || Math.abs(r[u] - t[u]) > 0.5) continue;
            if (Math.abs(p[u] - r[u]) >= gap) continue;
            const overlap =
              Math.min(Math.max(p[v], q[v]), Math.max(r[v], t[v])) -
              Math.max(Math.min(p[v], q[v]), Math.min(r[v], t[v]));
            if (overlap > 4) return true;
          }
          return false;
        }),
      );
      if (near) out.push(`${a.from}->${a.to} near ${b.from}->${b.to}`);
    }),
  );
  return out;
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

  it("sets it in rows, never in columns, in any landscape pane", async () => {
    // (columns cut between choices send each choice's exits down, across and back up past each other)
    // (a still picture names the function under every box: larger diamonds)
    const flow = choices();
    const actors = new Map(flow.stages.map(({ step }) => [step.id, "updateModules"]));
    for (const wide of [pane, { width: 1160, height: 660 }, { width: 1200, height: 770 }]) {
      const layout = await layoutFlowFitting(flow, wide, { actors });
      expect(layout.direction).toBe("RIGHT");
    }
  });

  it("is one column top to bottom in an upright phone pane: the reader scrolls one way", async () => {
    const layout = await layoutFlowFitting(choices(), { width: 372, height: 700 });
    expect([layout.direction, layout.parts, layout.column]).toEqual(["DOWN", 1, true]);
    // narrow boxes in step order, the arrows that skip a step in lanes beside them: it fits across the
    // phone with its words at 10px
    const tops = layout.children.map((c) => c.y);
    expect(tops).toEqual([...tops].sort((a, b) => a - b));
    expect(layout.width * (10 / 13)).toBeLessThanOrEqual(372);
  });

  // a state's two moves out of it to later states had their words on top of each other
  it("in that column, keeps apart the words of two arrows out of one box into the lanes", async () => {
    const flow = flowOf([
      {
        label: "Running on a worker",
        next: [
          { step: "f:2", label: "It succeeded" },
          { step: "f:3", label: "It failed, no retries left" },
          { step: "f:4", label: "It failed, retries left" },
        ],
      },
      { label: "Done", next: [] },
      { label: "Failed", next: [] },
      { label: "Waiting", next: [] },
    ]);
    const layout = await layoutFlow(flow, { column: true });
    const words = layout.edges.flatMap((edge) => edge.labels);
    expect(words).toHaveLength(3);
    const clash = words.filter((a, i) =>
      words
        .slice(i + 1)
        .some(
          (b) =>
            a.x < b.x + b.width &&
            b.x < a.x + a.width &&
            a.y < b.y + b.height &&
            b.y < a.y + a.height,
        ),
    );
    expect(clash).toEqual([]);
    expect(routesThroughBoxes(layout)).toEqual([]);
  });

  it("keeps a flow that fits top to bottom in one column", async () => {
    const layout = await layoutFlowFitting(flowOf([{}, {}, {}]), pane);
    expect([layout.direction, layout.parts]).toEqual(["DOWN", 1]);
  });

  // two arrows out of one choice ran side by side, 7 px apart, across the whole width: they read as dividers.
  // Then they shared one trunk, and the "yes" and "no" of vite's "Circular invalidation?" could not be told
  // apart: one trunk only for arrows into the same box.
  it("runs the arrows into one box of the next row as one trunk, every other arrow a lane apart", async () => {
    const layout = await layoutFlow(choices({ reloadGoesOn: true }), {
      direction: "RIGHT",
      parts: 2,
    });
    const row = (id: string) => (box(layout, id).y > box(layout, "f:1").y + 150 ? 1 : 0);
    const wraps = layout.edges.filter(
      (edge) => edge.to !== undefined && row(edge.from) !== row(edge.to),
    );
    // "Any updates to send?" ends the row: its "no" and "yes" to two ends, the reload's arrow into one of them
    expect(wraps.map((edge) => `${edge.from}->${edge.to}`).sort()).toEqual([
      "f:6->f:9",
      "f:7->f:8",
      "f:7->f:9",
    ]);
    // each one's longest run across the flow: its height
    const across = (edge: FlowLayout["edges"][number]) => {
      const points = edge.sections.flatMap((s) => [s.startPoint, ...s.bendPoints, s.endPoint]);
      const runs = points
        .slice(1)
        .map((p, i) => ({ y: p.y, length: Math.abs(p.x - points[i]!.x) }));
      return runs.sort((a, b) => b.length - a.length)[0]!.y;
    };
    for (const a of wraps)
      for (const b of wraps) {
        if (a === b) continue;
        if (a.to === b.to) expect(across(a)).toBe(across(b));
        else {
          expect(Math.abs(across(a) - across(b))).toBeGreaterThanOrEqual(16);
          expect(sharedRun(a, b)).toBeLessThanOrEqual(20);
        }
      }
  });

  // a 12-step retry decision (5 choices in a row, one end reached 7 ways): "yes" of step 2 ran straight
  // through the diamond of step 4, its word on 4's question; the wrap into step 10 ran through step 5
  it("in a long run of choices, runs no arrow through a box and puts no word on one", async () => {
    const flow = kyRetry();
    const layout = await layoutFlowFitting(flow, pane, { actors: kyActors });
    expect([layout.direction, layout.parts]).toEqual(["RIGHT", 2]);
    expect(routesThroughBoxes(layout)).toEqual([]);
    const onBoxes = layout.edges.flatMap((edge) =>
      edge.labels.flatMap((l) =>
        layout.children
          .filter(
            (c) =>
              l.x < c.x + c.width &&
              c.x < l.x + l.width &&
              l.y < c.y + c.height &&
              c.y < l.y + l.height,
          )
          .map((c) => `${l.text} on ${c.id}`),
      ),
    );
    expect(onBoxes).toEqual([]);
    expect(overlaps(layout)).toEqual([]);
  });

  it("draws an end next to each choice that leads to it, so one arrow runs from one row to the next", async () => {
    const layout = await layoutFlowFitting(kyRetry(), pane, { actors: kyActors });
    expect([layout.direction, layout.parts]).toEqual(["RIGHT", 2]);
    // the rows are either side of the run of the arrow from the end of the first row to the start of the next
    const wrap = layout.edges.find((edge) => edge.from === "f:4" && edge.to === "f:5")!;
    const points = wrap.sections.flatMap((s) => [s.startPoint, ...s.bendPoints, s.endPoint]);
    const runs = points.slice(1).map((p, i) => ({ y: p.y, length: Math.abs(p.x - points[i]!.x) }));
    const second = runs.sort((a, b) => b.length - a.length)[0]!.y;
    const row = (id: string) => (box(layout, id).y >= second ? 1 : 0);
    const wraps = layout.edges.filter((edge) => row(edge.from) !== row(edge.to!));
    expect(wraps.map((edge) => `${edge.from}->${edge.to}`)).toEqual(["f:4->f:5"]);
    // ("Retry timeouts?" no, to Throw, and "Payload too large?" no, to the wait, ran 1 unit apart: one "+"
    // with one "no" on it, and "no timeout retry" read as "compute the wait")
    expect(closeRuns(layout, 14)).toEqual([]);
    // "Compute the backoff wait", a step that leads nowhere, is drawn again beside each choice that ends in it
    expect(
      layout.children.filter((c) => (c.copyOf ?? c.id) === "f:10").map((c) => row(c.id)),
    ).toEqual([0, 1, 1, 1]);
  });

  // In these two runs of choices (found by laying out many such flows) the router drew "Choice 5? no" and
  // "Choice 9? no" side by side, 0 units apart, and "Choice 2? no" through two boxes: `clearOfOthers` moves
  // them, and each of these fails without its pass.
  it("moves a route off another route into a different box, and around a box in its way", async () => {
    const apart = await layoutFlowFitting(
      runOf(12, {
        1: 2,
        2: 3,
        3: 4,
        4: [5, 8],
        5: [6, 10],
        6: [7, 11],
        7: [8, 10],
        8: [9, 12],
        9: [10, 11],
        10: [11, 12],
      }),
      pane,
    );
    expect([apart.direction, apart.parts]).toEqual(["RIGHT", 2]);
    expect(closeRuns(apart, 14)).toEqual([]);
    const around = await layoutFlowFitting(
      runOf(12, {
        1: [2, 12],
        2: [3, 10],
        3: [4, 7],
        4: [5, 12],
        5: [6, 10],
        6: [7, 11],
        7: [8, 11],
        8: [9, 11],
        9: [10, 12],
        10: [11, 12],
      }),
      pane,
    );
    expect([around.direction, around.parts]).toEqual(["RIGHT", 3]);
    expect(routesThroughBoxes(around)).toEqual([]);
    expect(closeRuns(around, 14)).toEqual([]);
  });

  // vite's "HTML template changed?" drew its "yes" 8 units before its "no": "yes - no" read as one label
  it("keeps the words of two arrows out of one choice apart", async () => {
    for (const flow of [choices(), kyRetry()]) {
      const layout = await layoutFlowFitting(flow, pane);
      const touching = layout.edges.flatMap((a, i) =>
        layout.edges
          .slice(i + 1)
          .flatMap((b) =>
            a.from !== b.from
              ? []
              : a.labels.flatMap((l) =>
                  b.labels
                    .filter(
                      (m) =>
                        l.x < m.x + m.width + 12 &&
                        m.x < l.x + l.width + 12 &&
                        l.y < m.y + m.height + 12 &&
                        m.y < l.y + l.height + 12,
                    )
                    .map((m) => `${a.from}: ${l.text} by ${m.text}`),
                ),
          ),
      );
      expect(touching).toEqual([]);
    }
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

  // a move reached from two states drew two arrows with one id (one data-element-id, one React key)
  it("draws a move reached from two states as two arrows, each its own id, both picking the move", () => {
    const flow = {
      ...view,
      steps: [
        step("queued", T, ["start"]),
        step("start", start, ["running"]),
        step("running", T, ["start", "finish"]),
        step("finish", finish, ["done"]),
        step("done", T, []),
      ],
    };
    const roles = stateRoles(flow)!;
    const machine = stateMachine(processFlow(flow as never), roles)!;
    expect(machine.flow.transitions.map((t) => [t.id, t.from, t.to])).toEqual([
      ["start", "queued", "running"],
      ["start#from:running", "running", "running"],
      ["finish", "running", "done"],
    ]);
    expect(machine.moveOf.get("start")).toBe("start");
    expect(machine.moveOf.get("start#from:running")).toBe("start");
    expect(machine.flow.stages.map(({ step }) => step.id)).toEqual(["queued", "running", "done"]);
  });

  it("is no state machine when a move has no state before it: it would have no arrow to be drawn on", () => {
    const flow = {
      ...view,
      steps: [
        step("queued", T, []),
        step("start", start, ["running"]),
        step("running", T, ["finish"]),
        step("finish", finish, ["done"]),
        step("done", T, []),
      ],
    };
    const roles = stateRoles(flow)!;
    expect(roles.get("start")).toBe("move");
    expect(stateMachine(processFlow(flow as never), roles)).toBeUndefined();
  });

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

  // each guard below, removed, drew an ordinary flow as pills and plain boxes with no step numbers
  it("finds none when a state leads straight to another state: its steps do not take turns", () => {
    const steps = [
      step("queued", T, ["running"]),
      step("running", T, ["start"]),
      step("start", start, ["done"]),
      step("done", T, []),
    ];
    expect(stateRoles({ ...view, participants: [T, start], steps } as never)).toBeUndefined();
  });

  it("finds none when the flow does not start at its first participant", () => {
    const scope = { ...view.scope, entryPoints: ["src/other.ts#Runner"] };
    expect(stateRoles({ ...view, scope } as never)).toBeUndefined();
  });

  it("finds none when a step calls from one part to another", () => {
    const steps = view.steps.map((s) => (s.id === "start" ? { ...s, to: T } : s));
    expect(stateRoles({ ...view, steps } as never)).toBeUndefined();
  });

  it("finds none in Cobra's command execution, whose steps stay in two functions", () => {
    const patch = JSON.parse(
      readFileSync(
        new URL("../../../site/examples/cobra/cobra-command-execution.patch.json", import.meta.url),
        "utf8",
      ),
    ) as { views: { id: string }[] };
    const execution = patch.views.find((v) => v.id === "view:execution");
    expect(execution).toBeDefined();
    expect(stateRoles(execution as never)).toBeUndefined();
  });
});
