/**
 * The first view of a sequence too big to show whole (sequenceFocus.ts + viewport.ts frameView): it frames the
 * step's arrow with both its lifelines, and slides so that no arrow's words cross the pane's sides (R6-1,
 * V6-05) and no empty lifeline beside the arrows is kept instead of the ones they join.
 */
import { ExplainerModel, type SequenceView } from "@xpl/core";
import { describe, expect, it } from "vitest";
import { layoutSequence } from "../src/layout/sequenceLayout.js";
import { labelBox, sequenceFocus } from "../src/sequenceFocus.js";
import { frameView } from "../src/viewport.js";
import { makeBundle } from "./world.js";

const LANES = [
  "file:src/a.ts",
  "sym:src/a.ts#A.run",
  "sym:src/a.ts#A.stop",
  "file:src/b.ts",
  "sym:src/b.ts#B.go",
];

/** Five lifelines; a call from the first to the third, then calls among the last three. */
function layout() {
  const bundle = makeBundle();
  const explainer = structuredClone(bundle.explainer);
  const view = explainer.views.find((v) => v.id === "view:flow") as SequenceView;
  view.participants = LANES;
  const call = (id: string, from: number, to: number, label: string) => ({
    id,
    from: LANES[from]!,
    to: LANES[to]!,
    label,
    kind: "call" as const,
    anchors: [],
  });
  view.steps = [
    call("s1", 0, 2, "first(job, options)"),
    call("s2", 2, 3, "next(job)"),
    call("s3", 3, 4, "run(job)"),
    call("s4", 2, 4, "done(job)"),
  ];
  view.frames = [];
  return layoutSequence(view, new ExplainerModel(explainer, bundle.index));
}

describe("sequenceFocus: the first view of a big sequence", () => {
  const seq = layout();
  // a pane a little narrower than the diagram, at the readable zoom: it shows part of it
  const size = { w: seq.width * 0.55, h: seq.height + 40 };
  const options = { padding: 10, maxZoom: 1, whole: 1, readable: 1 };

  it("frames the step's arrow and both its lifelines, and cuts no arrow's words at the sides", () => {
    const framed = frameView(size, seq, sequenceFocus(seq, new Set(["s2"])), options)!;
    expect(framed.partial).toBe(true);
    const { k, x } = framed.transform;
    const span = (box: { x: number; width: number }): [number, number] => [
      x + box.x * k,
      x + (box.x + box.width) * k,
    ];
    const cut = seq.rows
      .filter((row) => {
        const [left, right] = span(labelBox(row));
        return (left < 0 && right > 0) || (left < size.w && right > size.w);
      })
      .map((row) => row.step.id);
    expect(cut).toEqual([]);
    const inside = (id: string) => {
      const lane = seq.lifelines.find((one) => one.id === id)!;
      const [left, right] = span({ x: lane.x - lane.headWidth / 2, width: lane.headWidth });
      return left >= 0 && right <= size.w;
    };
    expect([LANES[2], LANES[3]].map((id) => inside(id!))).toEqual([true, true]);
    // (the empty first lifeline is the one left out, not one the arrows in sight join)
    expect(inside(LANES[0]!)).toBe(false);
  });
});
