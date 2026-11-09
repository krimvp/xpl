import { ExplainerModel, type SequenceView } from "@xpl/core";
import { describe, expect, it } from "vitest";
import { ARM_TOP, frameLabelWidth, layoutSequence } from "../src/layout/sequenceLayout.js";
import { textWidth } from "../src/measure.js";
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

  it("makes a frame wide enough for its condition, however short its rows", () => {
    const label = "until the job succeeds or it has been tried maxRetries times";
    const { model: m, view } = model((v) => {
      v.steps = [step("flow:1", RUN, RUN, "go()")];
      v.frames = [{ id: "frame:alt", kind: "alt", label, fromStep: "flow:1", toStep: "flow:1" }];
    });
    const layout = layoutSequence(view, m);
    const [frame] = layout.frames;
    expect(frame!.width).toBeGreaterThanOrEqual(frameLabelWidth("alt", label));
    expect(frame!.x + frame!.width).toBeLessThanOrEqual(layout.width);
  });

  it("splits an alt into its arms: each condition above its rows, clear of the tab and of the arm before", () => {
    const { model: m, view } = model((v) => {
      v.steps = [
        step("flow:1", RUN, "file:src/b.ts", "ack(job)"),
        step("flow:2", RUN, "file:src/b.ts", "requeue(job)"),
        step("flow:3", RUN, "file:src/b.ts", "deadLetter(job)"),
      ];
      v.frames = [
        {
          id: "frame:end",
          kind: "alt",
          label: "how the attempt ends",
          fromStep: "flow:1",
          toStep: "flow:3",
          arms: [
            { label: "ok", fromStep: "flow:1", toStep: "flow:1" },
            {
              label: "a very long condition: retries are left",
              fromStep: "flow:2",
              toStep: "flow:2",
            },
            { label: "else", fromStep: "flow:3", toStep: "flow:3" },
          ],
        },
        // a frame inside the last arm: the arm's condition sits above that frame's tab
        {
          id: "frame:last",
          kind: "opt",
          label: "dead letters on",
          fromStep: "flow:3",
          toStep: "flow:3",
        },
      ];
    });
    const layout = layoutSequence(view, m);
    const [frame, inner] = layout.frames;
    const rows = layout.rows;
    expect(frame!.arms.map((arm) => [arm.label, arm.steps])).toEqual([
      ["ok", ["flow:1"]],
      ["a very long condition: retries are left", ["flow:2"]],
      ["else", ["flow:3"]],
    ]);
    const [ok, retry, rest] = frame!.arms;
    // the first condition sits under the tab, inside the frame
    expect(ok!.top).toBeGreaterThanOrEqual(frame!.y + 20);
    expect(ok!.top + ARM_TOP).toBeLessThanOrEqual(rows[0]!.bandTop);
    // each later line runs between the arm before and its own condition
    expect(retry!.top).toBeGreaterThanOrEqual(rows[0]!.bandBottom);
    expect(retry!.top + ARM_TOP).toBeLessThanOrEqual(rows[1]!.bandTop);
    expect(rest!.top).toBeGreaterThanOrEqual(rows[1]!.bandBottom);
    expect(rest!.top + ARM_TOP).toBeLessThanOrEqual(inner!.y);
    // wide enough for the longest condition, drawn 8 from the left edge
    expect(frame!.width).toBeGreaterThan(
      8 + textWidth("[a very long condition: retries are left]", 12, 500),
    );
    // without arms, the same frame takes no extra rows
    const plain = model((v) => {
      v.steps = view.steps;
      v.frames = [{ ...view.frames![0]!, arms: undefined }];
    });
    expect(layoutSequence(plain.view, plain.model).height).toBeLessThan(
      layout.height - 3 * ARM_TOP,
    );
  });

  it("wraps a long message over lines of about 40 characters, and says which rows sit in a frame", () => {
    const long = "applyPatch(explainer, patch, model, texts, {actor: 'llm', check: true})";
    const { model: m, view } = model((v) => {
      v.steps = [step("flow:1", RUN, "file:src/b.ts", long), step("flow:2", RUN, "file:src/b.ts")];
      v.frames = [
        { id: "frame:l", kind: "loop", label: "each", fromStep: "flow:2", toStep: "flow:2" },
      ];
    });
    const [first, second] = layoutSequence(view, m).rows;
    expect(first!.lines.length).toBeGreaterThan(1);
    expect(first!.lines.every((line) => line.length <= 42)).toBe(true);
    expect(first!.lines.join(" ").replace(/\s+/g, "")).toBe(long.replace(/\s+/g, ""));
    expect([first!.depth, second!.depth]).toEqual([0, 1]);
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
