import { ExplainerModel, type SequenceView } from "@xpl/core";
import { describe, expect, it } from "vitest";
import { layoutSequence } from "../src/layout/sequenceLayout.js";
import { makeBundle } from "./world.js";

const RUN = "sym:src/a.ts#A.run";
const STOP = "sym:src/a.ts#A.stop";

function model(edit?: (view: SequenceView) => void) {
  const bundle = makeBundle();
  const explainer = structuredClone(bundle.explainer);
  const view = explainer.views.find((v) => v.id === "view:flow") as SequenceView;
  edit?.(view);
  return { model: new ExplainerModel(explainer, bundle.index), view };
}

const step = (
  id: string,
  from: string,
  to: string,
  label = id,
  kind: "call" | "return" | "async" = "call",
) => ({
  id,
  from,
  to,
  label,
  kind,
  anchors: [],
});

describe("layoutSequence", () => {
  it("puts participants left to right and steps top to bottom", () => {
    const { model: m, view } = model();
    const layout = layoutSequence(view, m);
    expect(layout.lifelines.map((l) => l.id)).toEqual([RUN, "file:src/b.ts"]);
    expect(layout.lifelines[0]!.label).toBe("A.run");
    expect(layout.lifelines[0]!.x).toBeLessThan(layout.lifelines[1]!.x);
    const [first, second] = layout.rows;
    expect(first!.y).toBeLessThan(second!.y);
    // flow:1 goes A.run -> b.ts, flow:2 (a return) comes back
    expect(first!.x1).toBeLessThan(first!.x2);
    expect(second!.x1).toBeGreaterThan(second!.x2);
    expect(first!.x1).toBe(layout.lifelines[0]!.x);
    expect(first!.x2).toBe(layout.lifelines[1]!.x);
    expect(layout.width).toBeGreaterThan(layout.lifelines[1]!.x);
    expect(layout.height).toBeGreaterThan(second!.y);
  });

  it("makes room for long labels between lifelines", () => {
    const short = model();
    const long = model((view) => {
      view.steps[0]!.label = "a really rather long message label that needs room to breathe";
    });
    const gap = (l: ReturnType<typeof layoutSequence>) => l.lifelines[1]!.x - l.lifelines[0]!.x;
    expect(gap(layoutSequence(long.view, long.model))).toBeGreaterThan(
      gap(layoutSequence(short.view, short.model)) + 100,
    );
  });

  it("draws a call from a participant to itself as a loop with its label on the right", () => {
    const { model: m, view } = model((v) => {
      v.steps = [step("flow:1", RUN, RUN, "retry()")];
    });
    const [row] = layoutSequence(view, m).rows;
    expect(row!.self).toBe(true);
    expect(row!.x1).toBe(row!.x2);
    expect(row!.labelAnchor).toBe("start");
    expect(row!.labelX).toBeGreaterThan(row!.x1);
    expect(row!.bandRight).toBeGreaterThan(row!.labelX);
  });

  it("lands a step on the participant that contains its end", () => {
    const { model: m, view } = model((v) => {
      v.participants = [RUN, "file:src/b.ts"];
      v.steps = [step("flow:1", RUN, "sym:src/b.ts#B.go")];
    });
    const layout = layoutSequence(view, m);
    expect(layout.rows[0]!.x2).toBe(layout.lifelines[1]!.x);
    expect(layout.rows[0]!.detached).toBe(false);
  });

  it("does not lose a step whose end is on no lifeline", () => {
    const { model: m, view } = model((v) => {
      v.steps = [step("flow:1", RUN, STOP.replace("A.stop", "Missing"))];
    });
    const [row] = layoutSequence(view, m).rows;
    expect(row!.detached).toBe(true);
    expect(row!.self).toBe(true);
  });

  it("nests frames: the outer one contains the inner one and the rows of both", () => {
    const { model: m, view } = model((v) => {
      v.steps = [
        step("flow:1", RUN, "file:src/b.ts"),
        step("flow:2", "file:src/b.ts", RUN, "ok", "return"),
        step("flow:3", RUN, "file:src/b.ts"),
        step("flow:4", RUN, "file:src/b.ts"),
      ];
      v.frames = [
        { id: "frame:inner", kind: "opt", label: "inner", fromStep: "flow:2", toStep: "flow:3" },
        { id: "frame:outer", kind: "loop", label: "outer", fromStep: "flow:1", toStep: "flow:3" },
      ];
    });
    const layout = layoutSequence(view, m);
    expect(layout.frames.map((f) => f.frame.id)).toEqual(["frame:outer", "frame:inner"]);
    const [outer, inner] = layout.frames;
    expect(outer!.depth).toBe(0);
    expect(inner!.depth).toBe(1);
    const contains = (a: typeof outer, b: typeof inner) =>
      a!.x <= b!.x &&
      a!.y <= b!.y &&
      a!.x + a!.width >= b!.x + b!.width &&
      a!.y + a!.height >= b!.y + b!.height;
    expect(contains(outer, inner)).toBe(true);
    // Rows 1-3 are inside the outer frame, row 4 is not; row 1 is not inside the inner one.
    const inside = (frame: typeof outer, rowIndex: number) => {
      const row = layout.rows[rowIndex]!;
      return row.y > frame!.y && row.y < frame!.y + frame!.height;
    };
    expect([0, 1, 2].every((i) => inside(outer, i))).toBe(true);
    expect(inside(outer, 3)).toBe(false);
    expect(inside(inner, 0)).toBe(false);
    expect(inside(inner, 1) && inside(inner, 2)).toBe(true);
  });

  it("copes with a view without steps, participants or frames", () => {
    const { model: m, view } = model((v) => {
      v.steps = [];
      v.participants = [];
      delete (v as { frames?: unknown }).frames;
    });
    const layout = layoutSequence(view, m);
    expect(layout.lifelines).toEqual([]);
    expect(layout.rows).toEqual([]);
    expect(layout.frames).toEqual([]);
  });
});
