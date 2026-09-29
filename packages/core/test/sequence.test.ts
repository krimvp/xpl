import { describe, expect, it } from "vitest";
import {
  ExplainerModel,
  participantIndex,
  participantLabels,
  resolveFrames,
  stepEnds,
  stepIndex,
  type SequenceView,
} from "../src/index.js";
import { emptyExplainer, jobrunner, sequenceView } from "./helpers.js";

const DISPATCH = "sym:src/runner.ts#Runner.dispatch";
const step = (id: string, from: string, to: string) => ({
  id,
  from,
  to,
  label: id,
  kind: "call" as const,
  anchors: [],
});

const view: SequenceView = sequenceView(
  "view:v",
  [DISPATCH, "file:src/queue.ts", "file:src/worker.ts"],
  [
    step("v:1", DISPATCH, "file:src/queue.ts"),
    step("v:2", DISPATCH, "file:src/worker.ts"),
    step("v:3", "file:src/worker.ts", "file:src/worker.ts"),
    step("v:4", DISPATCH, "file:src/queue.ts"),
    step("v:5", "file:src/queue.ts", DISPATCH),
  ],
);

describe("step and participant lookups", () => {
  it("finds a step's position", () => {
    expect(stepIndex(view, "v:1")).toBe(0);
    expect(stepIndex(view, "v:5")).toBe(4);
    expect(stepIndex(view, "v:9")).toBe(-1);
  });

  it("finds a participant's lifeline", () => {
    expect(participantIndex(view, DISPATCH)).toBe(0);
    expect(participantIndex(view, "file:src/worker.ts")).toBe(2);
    expect(participantIndex(view, "file:src/metrics.ts")).toBe(-1);
  });

  it("resolves a step's ends to lifelines and detects self calls", () => {
    expect(stepEnds(view, view.steps[0]!)).toEqual({ from: 0, to: 1, self: false });
    expect(stepEnds(view, view.steps[2]!)).toEqual({ from: 2, to: 2, self: true });
    expect(stepEnds(view, view.steps[4]!)).toEqual({ from: 1, to: 0, self: false });
    expect(stepEnds(view, step("x:1", "file:nope", "file:nope"))).toEqual({
      from: -1,
      to: -1,
      self: false,
    });
  });

  it("tolerates views without steps or participants", () => {
    const bare = { ...view, steps: undefined, participants: undefined, frames: undefined } as never;
    expect(stepIndex(bare, "v:1")).toBe(-1);
    expect(participantIndex(bare, DISPATCH)).toBe(-1);
    expect(resolveFrames(bare)).toEqual([]);
  });
});

describe("resolveFrames", () => {
  const frame = (id: string, fromStep: string, toStep: string) => ({
    id: `frame:${id}`,
    kind: "loop" as const,
    label: id,
    fromStep,
    toStep,
  });

  it("resolves frames to inclusive step index ranges", () => {
    const v = { ...view, frames: [frame("a", "v:2", "v:4")] };
    expect(resolveFrames(v)).toEqual([{ frame: v.frames[0], from: 1, to: 3, depth: 0 }]);
  });

  it("computes nesting depth from containment", () => {
    const v = {
      ...view,
      frames: [
        frame("inner", "v:3", "v:3"),
        frame("outer", "v:1", "v:5"),
        frame("middle", "v:2", "v:4"),
        frame("apart", "v:1", "v:1"),
      ],
    };
    const resolved = resolveFrames(v).map((r) => [r.frame.id, r.from, r.to, r.depth]);
    expect(resolved).toEqual([
      ["frame:outer", 0, 4, 0],
      ["frame:apart", 0, 0, 1],
      ["frame:middle", 1, 3, 1],
      ["frame:inner", 2, 2, 2],
    ]);
  });

  it("nests frames with the same range in stored order (first is outer)", () => {
    const v = { ...view, frames: [frame("x", "v:2", "v:3"), frame("y", "v:2", "v:3")] };
    expect(resolveFrames(v).map((r) => [r.frame.id, r.depth])).toEqual([
      ["frame:x", 0],
      ["frame:y", 1],
    ]);
  });

  it("does not nest frames that merely overlap", () => {
    const v = { ...view, frames: [frame("a", "v:1", "v:3"), frame("b", "v:2", "v:5")] };
    expect(resolveFrames(v).map((r) => r.depth)).toEqual([0, 0]);
  });

  it("drops frames with unknown steps or reversed ranges", () => {
    const v = {
      ...view,
      frames: [frame("bad", "v:9", "v:2"), frame("rev", "v:4", "v:2"), frame("ok", "v:1", "v:2")],
    };
    expect(resolveFrames(v).map((r) => r.frame.id)).toEqual(["frame:ok"]);
    expect(resolveFrames({ ...view, frames: undefined })).toEqual([]);
  });
});

describe("participantLabels", () => {
  const w = jobrunner();
  const model = (over = {}) => new ExplainerModel(emptyExplainer(over), w.model);

  it("uses the default labels, left to right", () => {
    expect(participantLabels(view, model())).toEqual([
      { id: DISPATCH, label: "Runner.dispatch" },
      { id: "file:src/queue.ts", label: "queue.ts" },
      { id: "file:src/worker.ts", label: "worker.ts" },
    ]);
  });

  it("qualifies participants whose labels collide", () => {
    const twins = makeTwins();
    const labels = participantLabels(twins.view, twins.model);
    expect(labels.map((l) => l.label)).toEqual([
      "a/index.ts",
      "b/index.ts",
      "Thing.go (a.ts)",
      "Thing.go (b.ts)",
    ]);
  });

  it("falls back to the id when nothing better distinguishes", () => {
    const v = sequenceView("view:v", ["grp:a", "grp:b"], []);
    const m = model({
      nodes: [
        {
          id: "grp:a",
          kind: "group",
          parent: "repo",
          label: "Same",
          members: [],
          anchors: [],
          provenance: { origin: "llm" },
        },
        {
          id: "grp:b",
          kind: "group",
          parent: "repo",
          label: "Same",
          members: [],
          anchors: [],
          provenance: { origin: "llm" },
        },
      ],
    });
    expect(participantLabels(v, m).map((l) => l.label)).toEqual(["grp:a", "grp:b"]);
  });

  it("honours stored labels", () => {
    const m = model({
      nodes: [
        {
          id: "file:src/queue.ts",
          kind: "file",
          parent: "dir:src",
          label: "The queue",
          anchors: [],
          provenance: { origin: "llm" },
        },
      ],
    });
    expect(participantLabels(view, m)[1]).toEqual({ id: "file:src/queue.ts", label: "The queue" });
  });
});

function makeTwins() {
  // two files called index.ts and two methods called Thing.go, in different files
  const world = jobrunner({
    files: [
      { path: "a/index.ts", lines: 10 },
      { path: "b/index.ts", lines: 10 },
      { path: "a.ts", lines: 10 },
      { path: "b.ts", lines: 10 },
    ],
    symbols: [
      { id: "a.ts#Thing", kind: "class", start: 1, end: 9 },
      { id: "a.ts#Thing.go", start: 2, end: 4 },
      { id: "b.ts#Thing", kind: "class", start: 1, end: 9 },
      { id: "b.ts#Thing.go", start: 2, end: 4 },
    ],
    refs: [],
  });
  const v = sequenceView(
    "view:t",
    ["file:a/index.ts", "file:b/index.ts", "sym:a.ts#Thing.go", "sym:b.ts#Thing.go"],
    [],
  );
  return { view: v, model: new ExplainerModel(emptyExplainer(), world.model) };
}
