/**
 * What a reader sees: step titles (said once), the flow layout of another view (no crash), the plain
 * words of the reader views and the tour summary.
 */
import { describe, expect, it } from "vitest";
import { ExplainerModel, processFlow, type SequenceView, type TourStep } from "@xpl/core";
import { placedStages } from "../src/layout/flowLayout.js";
import { readerBadge, roleWords } from "../src/readerWords.js";
import { MAX_SENTENCE_TITLE, noteParts, stepText, stepTitle } from "../src/stepTitle.js";
import { makeBundle } from "./world.js";

const model = () => {
  const bundle = makeBundle();
  return new ExplainerModel(bundle.explainer, bundle.index);
};
const step = (note: string | undefined, focus: string[] = ["grp:core"]): TourStep => ({
  id: "s",
  view: "view:overview",
  focus,
  ...(note === undefined ? {} : { note }),
});

describe("step titles", () => {
  it("a leading heading line is the title, whole (no split at ': '), and is not repeated in the body", () => {
    const parts = noteParts(
      "### Fix 1: drop `q=0` entries\n\nThe matcher now skips them. Then it sorts.",
    );
    expect(parts).toEqual({
      title: "Fix 1: drop q=0 entries",
      titleMarkdown: "Fix 1: drop `q=0` entries",
      from: "heading",
      body: "\nThe matcher now skips them. Then it sorts.",
    });
    expect(noteParts("  \n# Only a title  ")).toEqual({
      title: "Only a title",
      titleMarkdown: "Only a title",
      from: "heading",
    });
    // closing hashes are not part of the title
    expect(noteParts("## Plain title ##\nBody.").title).toBe("Plain title");
  });

  it("without a heading, a short first sentence is the title and the body is the rest", () => {
    expect(
      noteParts("The router picks the first route that matches. A partial match is kept."),
    ).toEqual({
      title: "The router picks the first route that matches",
      titleMarkdown: "The router picks the first route that matches",
      from: "sentence",
      body: "A partial match is kept.",
    });
    // one sentence: all title, no body (the old guide printed it as the heading and again as the text)
    expect(noteParts("The router picks the first route that matches.")).toEqual({
      title: "The router picks the first route that matches",
      titleMarkdown: "The router picks the first route that matches",
      from: "sentence",
    });
    // the colon does not cut it ("Fix 1", "Note" were titles before)
    expect(noteParts("Note: a custom `match` skips it. So it gets no fix.").title).toBe(
      "Note: a custom match skips it",
    );
    // a question keeps its mark; dots inside code, numbers and "e.g." do not end the sentence
    expect(noteParts("Why two layers? One is outside.").title).toBe("Why two layers?");
    expect(noteParts("It calls `self.app(scope)` here. Then more.").title).toBe(
      "It calls self.app(scope) here",
    );
    expect(noteParts("Ports above 65535.5 fail, e.g. foo:65536. Then more.").title).toBe(
      "Ports above 65535.5 fail, e.g. foo:65536",
    );
  });

  it("a first sentence over the limit is no title: then the first focused element names the step", () => {
    const long = `${"word ".repeat(20).trim()}. Short.`;
    expect(long.indexOf(".")).toBeGreaterThan(MAX_SENTENCE_TITLE);
    expect(noteParts(long)).toEqual({ body: long });
    const m = model();
    // the label of the first focused element, never "A · B" joins of two labels
    expect(stepTitle(step(long, ["grp:core", "concept:retry"]), m)).toBe("Core");
    expect(stepText(step(long, ["grp:core", "concept:retry"]), m)).toEqual({
      title: "Core",
      body: long,
    });
    // a list or a code block does not open with a title
    expect(noteParts("- one\n- two").title).toBeUndefined();
    // no note, no focus: the view's title
    expect(stepTitle(step(undefined, []), m)).toBe("Overview");
    expect(stepText(step("   ", []), m)).toEqual({ title: "Overview" });
  });
});

describe("process flow of another view (Read > Flow, the topic select)", () => {
  it("draws only the boxes of its own stages: a layout of the previous flow is skipped, not a crash", () => {
    const bundle = makeBundle();
    const original = bundle.explainer.views.find((v) => v.type === "sequence") as SequenceView;
    const a = processFlow({ ...original, id: "view:a", type: "flow" });
    const b = processFlow({
      ...original,
      id: "view:b",
      type: "flow",
      steps: original.steps.map((s) => ({ ...s, id: `b:${s.id}` })),
    });
    const layoutOfA = {
      id: "process",
      children: a.stages.map((stage, i) => ({
        id: stage.step.id,
        x: 0,
        y: i * 100,
        width: 290,
        height: 108,
      })),
    };
    // the old code looked every laid-out node up in the new flow and destructured `undefined`
    expect(placedStages(b, layoutOfA)).toEqual([]);
    expect(placedStages(a, layoutOfA).map(({ node, stage }) => [node.id, stage.step.id])).toEqual(
      a.stages.map((stage) => [stage.step.id, stage.step.id]),
    );
  });
});

describe("plain words for readers", () => {
  it("anchor roles say what the lines are", () => {
    expect(roleWords("call-site")).toBe("called here");
    expect(roleWords("definition")).toBe("defined here");
    expect(roleWords("test")).toBe("test");
  });

  it("boxes keep the kind of code they are, never the explainer's own structure", () => {
    expect(readerBadge("group")).toBeUndefined();
    expect(readerBadge("dir")).toBeUndefined();
    expect(readerBadge("file")).toBe("file");
    expect(readerBadge("class")).toBe("class");
  });
});

describe("tour summary", () => {
  it("survives the tour editor's edits (a note, a move): the tour is written back whole", async () => {
    const { ViewerStore } = await import("../src/store.js");
    const bundle = makeBundle();
    bundle.explainer.tours[0]!.summary = "What this is. Why it matters.";
    const store = new ViewerStore(bundle);
    store.setStepNote("tour:demo", "t1", "### New title\n\nNew body.");
    store.moveStep("tour:demo", "t1", 1);
    const tour = store.getState().model.tour("tour:demo")!;
    expect(tour.summary).toBe("What this is. Why it matters.");
    expect(JSON.parse(store.explainerJson()).tours[0].summary).toBe(
      "What this is. Why it matters.",
    );
  });
});
