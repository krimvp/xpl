import type { Tour } from "@xpl/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDerived } from "../src/derive.js";
import { clampStep, stepIndex } from "../src/modes.js";
import { tourKeyAction } from "../src/present/keys.js";
import { ViewerStore } from "../src/store.js";
import {
  appendStep,
  focusIds,
  focusLabel,
  insertStep,
  moveStep,
  newStepId,
  newTourId,
  removeStep,
  sanitizeTours,
  setStepNote,
  slugFromTitle,
  withTour,
} from "../src/tours.js";
import { searchFor } from "../src/url.js";
import { readLaunchParams } from "../src/data.js";
import { makeBundle, TOUR } from "./world.js";

const tourOf = (store: ViewerStore, id = "tour:demo"): Tour => store.getState().model.tour(id)!;
const derived = (store: ViewerStore) => getDerived(store.getState());
const panes = (store: ViewerStore) => derived(store).panes.map((p) => p.file);

describe("tour helpers", () => {
  const tour: Tour = {
    id: "tour:x",
    title: "X",
    steps: [
      { id: "t1", view: "view:overview", focus: [] },
      { id: "t2", view: "view:overview", focus: ["grp:core"], note: "two" },
      { id: "t7", view: "view:flow", focus: ["flow:1"] },
    ],
  };

  it("makes slugs and unique tour ids from titles", () => {
    expect(slugFromTitle("Retry policy: the “why”")).toBe("retry-policy-the-why");
    expect(slugFromTitle("Ünïcode Tëst")).toBe("unicode-test");
    expect(slugFromTitle("  --  ")).toBe("tour");
    expect(slugFromTitle("x".repeat(80))).toBe("x".repeat(48));
    expect(slugFromTitle("a".repeat(47) + " b")).toBe("a".repeat(47));
    expect(newTourId("My talk", [])).toBe("tour:my-talk");
    expect(newTourId("My talk", ["tour:my-talk"])).toBe("tour:my-talk-2");
    expect(newTourId("My talk", ["tour:my-talk", "tour:my-talk-2"])).toBe("tour:my-talk-3");
  });

  it("numbers steps above the highest t<n>, and never reuses an id", () => {
    expect(newStepId(tour)).toBe("t8");
    expect(newStepId({ ...tour, steps: [] })).toBe("t1");
    expect(newStepId({ ...tour, steps: [{ id: "intro", view: "v", focus: [] }] })).toBe("t1");
    const added = appendStep(tour, "view:flow", ["flow:2"]);
    expect(added.stepId).toBe("t8");
    expect(added.tour.steps.at(-1)).toEqual({ id: "t8", view: "view:flow", focus: ["flow:2"] });
    expect(tour.steps).toHaveLength(3); // the original is untouched
  });

  it("moves, removes and restores steps; no-ops give back the same tour", () => {
    const ids = (t: Tour) => t.steps.map((s) => s.id);
    expect(ids(moveStep(tour, "t2", -1))).toEqual(["t2", "t1", "t7"]);
    expect(ids(moveStep(tour, "t2", 1))).toEqual(["t1", "t7", "t2"]);
    expect(moveStep(tour, "t1", -1)).toBe(tour);
    expect(moveStep(tour, "t7", 1)).toBe(tour);
    expect(moveStep(tour, "nope", 1)).toBe(tour);
    expect(ids(removeStep(tour, "t2"))).toEqual(["t1", "t7"]);
    expect(removeStep(tour, "nope")).toBe(tour);
    const gone = removeStep(tour, "t2");
    expect(insertStep(gone, tour.steps[1]!, 1)).toEqual(tour);
    expect(insertStep(gone, tour.steps[1]!, 99).steps.at(-1)!.id).toBe("t2");
    expect(insertStep(tour, tour.steps[0]!, 0)).toBe(tour);
  });

  it("sets and clears notes; only whitespace clears, text is kept as typed", () => {
    expect(setStepNote(tour, "t1", "hello ").steps[0]!.note).toBe("hello ");
    expect(setStepNote(tour, "t2", "two")).toBe(tour);
    expect(setStepNote(tour, "t1", "   ")).toBe(tour);
    expect(setStepNote(tour, "nope", "x")).toBe(tour);
    const cleared = setStepNote(tour, "t2", "");
    expect("note" in cleared.steps[1]!).toBe(false);
    expect(cleared.steps[1]).toEqual({ id: "t2", view: "view:overview", focus: ["grp:core"] });
  });

  it("upserts a tour into the explainer", () => {
    const { explainer } = makeBundle();
    const created = withTour(explainer, { id: "tour:new", title: "New", steps: [] });
    expect(created.tours.map((t) => t.id)).toEqual(["tour:demo", "tour:new"]);
    const changed = withTour(created, { ...created.tours[0]!, title: "Renamed" });
    expect(changed.tours.map((t) => t.title)).toEqual(["Renamed", "New"]);
    expect(explainer.tours).toHaveLength(1);
  });

  it("keeps only focus ids the model knows and a step may store", () => {
    const store = new ViewerStore(makeBundle(), { view: "view:overview" });
    const { model } = store.getState();
    expect(
      focusIds(
        [
          "grp:core",
          "grp:core",
          "concept:retry",
          "edge:calls:file:src/a.ts->file:src/b.ts",
          "stub:out:file:src/a.ts->ghost:file:src/b.ts",
          "ghost:file:src/b.ts",
          "grp:nope",
          "flow:1",
        ],
        model,
      ),
    ).toEqual(["grp:core", "concept:retry", "edge:calls:file:src/a.ts->file:src/b.ts", "flow:1"]);
    expect(focusLabel("edge:calls:file:src/a.ts->file:src/b.ts", model)).toBe("a.ts calls b.ts");
    expect(focusLabel("concept:retry", model)).toBe("Retry");
  });

  it("counts steps from 1 outside and from 0 inside", () => {
    expect(stepIndex(1, 3)).toBe(0);
    expect(stepIndex(3, 3)).toBe(2);
    expect(stepIndex(99, 3)).toBe(2);
    expect(stepIndex(0, 3)).toBe(0);
    expect(stepIndex(undefined, 3)).toBe(0);
    expect(stepIndex(2, 0)).toBe(0);
    expect(clampStep(-4, 3)).toBe(0);
    expect(clampStep(Number.NaN, 3)).toBe(0);
    expect(clampStep(Number.MAX_SAFE_INTEGER, 3)).toBe(2);
  });
});

describe("hand-edited tours", () => {
  const loose = (tours: unknown) => {
    const bundle = makeBundle();
    (bundle.explainer as unknown as { tours: unknown }).tours = tours;
    return bundle;
  };

  it("keeps sound tours as they are (same objects) and repairs what can be repaired", () => {
    const { explainer } = makeBundle();
    expect(sanitizeTours(explainer)).toBe(explainer);
    const fixed = sanitizeTours({
      ...explainer,
      tours: [
        explainer.tours[0],
        { id: "tour:no-title", steps: "not a list" },
        {
          id: "tour:odd",
          title: "Odd",
          steps: [
            {
              id: "a",
              view: "view:flow",
              focus: ["flow:1", 4, null],
              note: 5,
              editor: "x",
              code: {},
            },
            { id: "b", focus: [] },
            "text",
            null,
            { id: "c", view: "view:flow", focus: "flow:2" },
          ],
        },
        { title: "no id", steps: [] },
        7,
      ] as never,
    });
    expect(fixed.tours.map((t) => t.id)).toEqual(["tour:demo", "tour:no-title", "tour:odd"]);
    expect(fixed.tours[0]).toBe(explainer.tours[0]);
    expect(fixed.tours[1]).toEqual({ id: "tour:no-title", title: "tour:no-title", steps: [] });
    expect(fixed.tours[2]!.steps).toEqual([
      { id: "a", view: "view:flow", focus: ["flow:1"] },
      { id: "c", view: "view:flow", focus: [] },
    ]);
    expect(sanitizeTours({ ...explainer, tours: undefined } as never).tours).toEqual([]);
    expect(sanitizeTours({ ...explainer, tours: {} } as never).tours).toEqual([]);
    // the input is not touched
    expect(explainer.tours).toHaveLength(1);
  });

  it("the store plays what it can and does not throw on the rest", () => {
    const store = new ViewerStore(
      loose([
        { id: "tour:broken", title: 3, steps: "nope" },
        { id: "tour:demo", title: "Demo", steps: [TOUR.steps[0], { id: "x" }, TOUR.steps[1]] },
      ]),
    );
    expect(store.getState().model.tours.map((t) => [t.id, t.steps.length])).toEqual([
      ["tour:broken", 0],
      ["tour:demo", 2],
    ]);
    expect(store.present("tour:broken")).toBe(true);
    expect(store.getState().applied).toBeUndefined();
    expect(store.getState().mode).toBe("present");
    store.nextStep();
    store.prevStep();
    expect(store.present("tour:demo", 1)).toBe(true);
    expect(store.getState().selection).toEqual(["flow:1", "concept:retry"]);
    store.exitPresent();
    // editing a tour writes it back whole and clean; the others in the file stay as they were
    store.setStepNote("tour:demo", "t2", "note");
    const saved = JSON.parse(store.explainerJson()) as {
      tours: { id: string; steps: unknown[] }[];
    };
    expect(saved.tours.map((t) => t.id)).toEqual(["tour:broken", "tour:demo"]);
    expect(saved.tours[0]!.steps).toBe("nope");
    expect(saved.tours[1]!.steps).toHaveLength(2);
    expect(store.addToTour({ title: "Fresh" })).toBeDefined();
    const broken = new ViewerStore(loose("none"));
    expect(broken.getState().model.tours).toEqual([]);
    expect(broken.present()).toBe(false);
    expect(broken.addToTour({ title: "First" })).toBeDefined();
    expect(broken.getState().model.tours.map((t) => t.id)).toEqual(["tour:first"]);
  });
});

describe("starting in Present", () => {
  it("opens the first tour at step 1 when the bundle says present", () => {
    const store = new ViewerStore(makeBundle({ mode: "present" }));
    const state = store.getState();
    expect(state.mode).toBe("present");
    expect(state.tour).toEqual({ tourId: "tour:demo", step: 0 });
    expect(state.viewId).toBe("view:overview");
    expect(state.selection).toEqual(["grp:core"]);
  });

  it("the URL wins over the bundle; steps count from 1; `intro` means `tour:intro`", () => {
    const bundle = makeBundle({ mode: "explore", tour: "tour:other" });
    const store = new ViewerStore(bundle, { mode: "present", tour: "demo", step: 2 });
    expect(store.getState().mode).toBe("present");
    expect(store.getState().tour).toEqual({ tourId: "tour:demo", step: 1 });
    expect(store.getState().viewId).toBe("view:flow");
    expect(store.getState().selection).toEqual(["flow:1", "concept:retry"]);
    // past the end: the last step
    const late = new ViewerStore(makeBundle(), { mode: "present", step: 99 });
    expect(late.getState().tour!.step).toBe(2);
  });

  it("falls back to the bundle's tour, then to the first, and to Explore without any tour", () => {
    const fromBundle = new ViewerStore(makeBundle({ mode: "present", tour: "tour:demo" }), {
      tour: "tour:nope",
    });
    expect(fromBundle.getState().tour!.tourId).toBe("tour:demo");
    const unknown = new ViewerStore(makeBundle(), { mode: "present", tour: "tour:nope" });
    expect(unknown.getState().tour!.tourId).toBe("tour:demo");

    const bare = makeBundle({ mode: "present", tour: "tour:demo" });
    bare.explainer.tours = [];
    const store = new ViewerStore(bare, { mode: "present" });
    expect(store.getState().mode).toBe("explore");
    expect(store.getState().tour).toBeUndefined();
    expect(store.present()).toBe(false);
    store.setMode("present");
    expect(store.getState().mode).toBe("explore");
  });

  it("Explore keeps a requested tour without presenting it", () => {
    const store = new ViewerStore(makeBundle(), { tour: "tour:demo", step: 2 });
    expect(store.getState().mode).toBe("explore");
    expect(store.getState().tour).toEqual({ tourId: "tour:demo", step: 1 });
    expect(store.getState().selection).toEqual([]);
    store.setMode("present"); // resumes where the tour was
    expect(store.getState().tour!.step).toBe(1);
    expect(store.getState().viewId).toBe("view:flow");
    const plain = new ViewerStore(makeBundle());
    expect(plain.getState().tour).toBeUndefined();
    expect(plain.getState().mode).toBe("explore");
  });

  it("reads 1-based steps from the URL", () => {
    expect(readLaunchParams("?mode=present&tour=tour:intro&step=3")).toEqual({
      mode: "present",
      tour: "tour:intro",
      step: 3,
    });
    expect(readLaunchParams("?step=0").step).toBeUndefined();
    expect(readLaunchParams("?step=x").step).toBeUndefined();
    expect(readLaunchParams("?step=1.5").step).toBeUndefined();
  });
});

describe("what a step applies", () => {
  it("step 1: its view, its focus as the selection, default editor options", () => {
    const store = new ViewerStore(makeBundle());
    expect(store.present("tour:demo", 0)).toBe(true);
    const state = store.getState();
    expect(state.mode).toBe("present");
    expect(state.viewId).toBe("view:overview");
    expect(state.selection).toEqual(["grp:core"]);
    expect(state.applied).toEqual({
      tourId: "tour:demo",
      stepId: "t1",
      code: undefined,
      dimOthers: true,
      hideFileTree: true,
      primary: undefined,
    });
    expect(panes(store)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(derived(store).panes.every((p) => p.dim && p.focused)).toBe(true);
  });

  it("step 2: a sequence view, steps and concepts selected, editor.primary first", () => {
    const store = new ViewerStore(makeBundle());
    store.present("tour:demo", 1);
    const state = store.getState();
    expect(state.viewId).toBe("view:flow");
    expect(state.selection).toEqual(["flow:1", "concept:retry"]);
    expect(state.applied!.primary).toBe("src/b.ts");
    // natural order would be a.ts, b.ts, c.yaml
    expect(derived(store).selection.files.map((f) => f.file)).toEqual([
      "src/a.ts",
      "src/b.ts",
      "config/c.yaml",
    ]);
    expect(panes(store)).toEqual(["src/b.ts", "src/a.ts", "config/c.yaml"]);
    // the primary file is not "opened by the user"
    expect(derived(store).panes.every((p) => !p.opened)).toBe(true);
  });

  it("step 3: step.code replaces the code of the focus; dimOthers false; the tree stays", () => {
    const store = new ViewerStore(makeBundle());
    store.present("tour:demo", 2);
    const state = store.getState();
    expect(state.selection).toEqual(["flow:2"]);
    expect(state.applied).toMatchObject({ dimOthers: false, hideFileTree: false });
    expect(state.applied!.code).toHaveLength(1);
    const { selection } = derived(store);
    expect(
      selection.focus.map((f) => [f.file, f.range.startLine, f.range.endLine, f.role, f.elementId]),
    ).toEqual([["config/c.yaml", 2, 4, "config", "tour:demo/t3"]]);
    expect(panes(store)).toEqual(["config/c.yaml"]);
    expect(derived(store).panes[0]).toMatchObject({ focused: true, dim: false });
  });

  it("a derived edge in the focus is selected; its code is the reference sites and the definition", () => {
    const bundle = makeBundle();
    const edge = "edge:calls:file:src/a.ts->file:src/b.ts";
    bundle.explainer.tours[0]!.steps[0]!.focus = [edge];
    const store = new ViewerStore(bundle);
    store.present("tour:demo", 0);
    expect(store.getState().selection).toEqual([edge]);
    expect(
      derived(store).selection.focus.map((f) => [
        f.file,
        f.range.startLine,
        f.range.endLine,
        f.role,
      ]),
    ).toEqual([
      ["src/a.ts", 12, 12, "call-site"],
      ["src/a.ts", 25, 25, "call-site"],
      ["src/b.ts", 3, 10, "definition"],
    ]);
  });

  it("the primary file need not be in the focus: it is shown first, unfocused", () => {
    const bundle = makeBundle();
    bundle.explainer.tours[0]!.steps[1]!.editor = { primary: "src/b.ts" };
    bundle.explainer.tours[0]!.steps[1]!.focus = ["concept:retry"];
    const store = new ViewerStore(bundle);
    store.present("tour:demo", 1);
    expect(derived(store).panes.map((p) => [p.file, p.focused, p.dim])).toEqual([
      ["src/b.ts", false, false],
      ["src/a.ts", true, true],
      ["config/c.yaml", true, true],
    ]);
    // a primary that is not in the index is ignored
    bundle.explainer.tours[0]!.steps[1]!.editor = { primary: "src/gone.ts" };
    const other = new ViewerStore(bundle);
    other.present("tour:demo", 1);
    expect(panes(other)).toEqual(["src/a.ts", "config/c.yaml"]);
  });

  it("an empty code override is no override; unknown focus ids and views are skipped", () => {
    const bundle = makeBundle();
    const steps = bundle.explainer.tours[0]!.steps;
    steps[0]!.code = [];
    steps[1]!.focus = ["concept:retry", "grp:nope"];
    steps[2]!.view = "view:gone";
    const store = new ViewerStore(bundle);
    store.present("tour:demo", 0);
    expect(store.getState().applied!.code).toBeUndefined();
    expect(panes(store)).toEqual(["src/a.ts", "src/b.ts"]);
    store.goToStep(1);
    expect(store.getState().selection).toEqual(["concept:retry"]);
    store.goToStep(2);
    expect(store.getState().viewId).toBe("view:flow"); // the view of the step before stays
  });
});

describe("moving through a tour", () => {
  it("next, previous, first and last stay inside the tour", () => {
    const store = new ViewerStore(makeBundle());
    store.present("tour:demo");
    const step = () => store.getState().tour!.step;
    store.prevStep();
    expect(step()).toBe(0);
    store.nextStep();
    store.nextStep();
    expect(step()).toBe(2);
    store.nextStep();
    expect(step()).toBe(2);
    store.goToStep(0);
    expect(store.getState().viewId).toBe("view:overview");
    store.goToStep(Number.MAX_SAFE_INTEGER);
    expect(step()).toBe(2);
    expect(store.getState().viewId).toBe("view:flow");
  });

  it("a click is a detour; the next step applies again; `goToStep` returns to the step", () => {
    const store = new ViewerStore(makeBundle());
    store.present("tour:demo", 2);
    expect(store.getState().applied).toBeDefined();
    store.click("concept:retry");
    expect(store.getState().applied).toBeUndefined();
    expect(store.getState().mode).toBe("present");
    expect(store.getState().tour!.step).toBe(2); // still on step 3
    // without the override the code follows what was clicked
    expect(panes(store)).toEqual(["src/a.ts", "config/c.yaml"]);
    expect(derived(store).panes.every((p) => p.dim)).toBe(true);
    store.goToStep(2);
    expect(store.getState().applied!.stepId).toBe("t3");
    expect(panes(store)).toEqual(["config/c.yaml"]);
    store.click("flow:1");
    store.prevStep(); // an arrow key returns to the tour, one step back
    expect(store.getState().tour!.step).toBe(1);
    expect(store.getState().selection).toEqual(["flow:1", "concept:retry"]);
    // clicking the selection again is not a detour
    store.select(["flow:1", "concept:retry"]);
    expect(store.getState().applied).toBeDefined();
  });

  it("switching views and clearing the selection are detours too", () => {
    const store = new ViewerStore(makeBundle());
    store.present("tour:demo", 1);
    store.setView("view:overview");
    expect(store.getState().applied).toBeUndefined();
    store.goToStep(1);
    store.clearSelection();
    expect(store.getState().applied).toBeUndefined();
    expect(store.getState().selection).toEqual([]);
  });

  it("leaving Present keeps the view, the selection and what the step made of the code", () => {
    const store = new ViewerStore(makeBundle());
    store.present("tour:demo", 2);
    store.exitPresent();
    const state = store.getState();
    expect(state.mode).toBe("explore");
    expect(state.viewId).toBe("view:flow");
    expect(state.selection).toEqual(["flow:2"]);
    expect(panes(store)).toEqual(["config/c.yaml"]);
    expect(state.tour).toEqual({ tourId: "tour:demo", step: 2 });
    store.exitPresent(); // idempotent
    // clicking in Explore drops the override, like anywhere else
    store.click("flow:1");
    expect(panes(store)).toEqual(["src/a.ts", "src/b.ts"]);
    // Present again resumes at that step
    store.setMode("present");
    expect(store.getState().tour!.step).toBe(2);
    expect(store.getState().selection).toEqual(["flow:2"]);
  });

  it("chooseTour: in Explore it only picks, in Present it starts the tour", () => {
    const bundle = makeBundle();
    bundle.explainer.tours.push({
      id: "tour:second",
      title: "Second",
      steps: [{ id: "t1", view: "view:flow", focus: ["flow:2"] }],
    });
    const store = new ViewerStore(bundle);
    store.chooseTour("tour:second");
    expect(store.getState().mode).toBe("explore");
    expect(store.getState().tour).toEqual({ tourId: "tour:second", step: 0 });
    expect(store.getState().selection).toEqual([]);
    store.setMode("present");
    expect(store.getState().viewId).toBe("view:flow");
    store.chooseTour("tour:demo");
    expect(store.getState().tour).toEqual({ tourId: "tour:demo", step: 0 });
    expect(store.getState().viewId).toBe("view:overview");
    store.chooseTour("tour:nope");
    expect(store.getState().tour!.tourId).toBe("tour:demo");
  });

  it("previewStep shows a step in Explore, without leaving it", () => {
    const store = new ViewerStore(makeBundle());
    store.previewStep("tour:demo", 1);
    expect(store.getState().mode).toBe("explore");
    expect(store.getState().viewId).toBe("view:flow");
    expect(store.getState().selection).toEqual(["flow:1", "concept:retry"]);
    expect(store.getState().tour).toEqual({ tourId: "tour:demo", step: 1 });
    store.previewStep("tour:demo", 9);
    store.previewStep("tour:nope", 0);
    expect(store.getState().tour!.step).toBe(1);
  });

  it("a talk does not edit the diagram", () => {
    const bundle = makeBundle();
    const view = bundle.explainer.views.find((v) => v.id === "view:overview")!;
    if (view.type === "graph") view.include = ["sym:src/a.ts#A.run"];
    bundle.explainer.tours[0]!.steps[0]!.focus = [];
    const store = new ViewerStore(bundle);
    store.present("tour:demo", 0);
    store.expandStub({ ghost: "file:src/b.ts" });
    store.drillIn("sym:src/a.ts#A.run");
    store.collapse("sym:src/a.ts#A.run");
    store.toggleEdgeKind("calls");
    store.setStubMode("all");
    expect(store.getState().dirty).toBe(false);
    expect(store.getState().explainer).toBe(bundle.explainer);
    store.exitPresent();
    store.setStubMode("all");
    expect(store.getState().dirty).toBe(true);
    store.toggleEdgeKind("calls");
    expect(store.getState().dirty).toBe(true);
  });
});

describe("the tour hooks' numbering", () => {
  it("state() counts from 1", async () => {
    const { installTestHooks } = await import("../src/testHooks.js");
    const store = new ViewerStore(makeBundle());
    const target = {} as Window;
    const hooks = installTestHooks(store, target);
    expect(hooks.state()).toMatchObject({ mode: "explore", tour: null, step: null });
    expect(hooks.present("tour:nope")).toBe(false);
    expect(hooks.present("tour:demo", 2)).toBe(true);
    expect(hooks.state()).toMatchObject({
      mode: "present",
      tour: "tour:demo",
      step: 2,
      stepCount: 3,
      stepId: "t2",
      detour: false,
      viewId: "view:flow",
    });
    hooks.next();
    expect(hooks.state().step).toBe(3);
    hooks.next();
    expect(hooks.state().step).toBe(3);
    hooks.prev();
    hooks.prev();
    expect(hooks.state().step).toBe(1);
    hooks.select(["grp:core", "concept:retry"]);
    expect(hooks.state()).toMatchObject({ detour: true, stepId: null });
    hooks.exitPresent();
    expect(hooks.state()).toMatchObject({ mode: "explore", tour: "tour:demo", step: 1 });
    expect(hooks.present("tour:demo")).toBe(true);
    expect(hooks.state().step).toBe(1);
    expect(target.__xpl).toBe(hooks);
  });
});

describe("editing tours", () => {
  it("Add to tour appends a step for the current view and selection", () => {
    const store = new ViewerStore(makeBundle(), { view: "view:flow" });
    store.select(["flow:2", "concept:retry"]);
    const at = store.addToTour({ tourId: "tour:demo" });
    expect(at).toEqual({ tourId: "tour:demo", stepId: "t4" });
    expect(tourOf(store).steps.at(-1)).toEqual({
      id: "t4",
      view: "view:flow",
      focus: ["flow:2", "concept:retry"],
    });
    expect(store.getState().dirty).toBe(true);
    // stub and ghost ids are not stored; nothing selected is a step for the whole view
    store.select(["stub:out:sym:src/a.ts#A.run->ghost:file:src/b.ts"]);
    store.clearSelection();
    store.addToTour({ tourId: "tour:demo" });
    expect(tourOf(store).steps.at(-1)).toEqual({ id: "t5", view: "view:flow", focus: [] });
    // the explainer JSON (the download) has it
    const json = JSON.parse(store.explainerJson()) as { tours: Tour[] };
    expect(json.tours[0]!.steps.map((s) => s.id)).toEqual(["t1", "t2", "t3", "t4", "t5"]);
    // an unknown tour, or an empty title, adds nothing
    expect(store.addToTour({ tourId: "tour:nope" })).toBeUndefined();
    expect(store.addToTour({ title: "   " })).toBeUndefined();
    expect(tourOf(store).steps).toHaveLength(5);
  });

  it("Add to tour with a title creates tour:<slug>, unique, and makes it the current tour", () => {
    const store = new ViewerStore(makeBundle(), { view: "view:overview" });
    store.select(["grp:core"]);
    const first = store.addToTour({ title: "My talk" });
    expect(first).toEqual({ tourId: "tour:my-talk", stepId: "t1" });
    expect(tourOf(store, "tour:my-talk")).toEqual({
      id: "tour:my-talk",
      title: "My talk",
      steps: [{ id: "t1", view: "view:overview", focus: ["grp:core"] }],
    });
    expect(store.getState().tour).toEqual({ tourId: "tour:my-talk", step: 0 });
    expect(store.addToTour({ title: "My talk" })!.tourId).toBe("tour:my-talk-2");
    expect(store.getState().model.tours.map((t) => t.id)).toEqual([
      "tour:demo",
      "tour:my-talk",
      "tour:my-talk-2",
    ]);
  });

  it("the first tour of an explainer without tours can be created in Explore", () => {
    const bundle = makeBundle();
    bundle.explainer.tours = [];
    const store = new ViewerStore(bundle);
    expect(store.getState().model.tours).toHaveLength(0);
    store.addToTour({ title: "First" });
    expect(store.getState().model.tours).toHaveLength(1);
    store.setMode("present");
    expect(store.getState().mode).toBe("present");
  });

  it("notes, order and deletion (with undo); the position stays inside the tour", () => {
    const store = new ViewerStore(makeBundle());
    store.setStepNote("tour:demo", "t3", "Third, with a note.");
    expect(tourOf(store).steps[2]!.note).toBe("Third, with a note.");
    store.setStepNote("tour:demo", "t3", "");
    expect("note" in tourOf(store).steps[2]!).toBe(false);

    store.moveStep("tour:demo", "t3", -1);
    expect(tourOf(store).steps.map((s) => s.id)).toEqual(["t1", "t3", "t2"]);
    store.moveStep("tour:demo", "t1", -1);
    expect(tourOf(store).steps.map((s) => s.id)).toEqual(["t1", "t3", "t2"]);

    store.present("tour:demo", 2);
    store.exitPresent();
    const removed = store.removeStep("tour:demo", "t2")!;
    expect(removed.index).toBe(2);
    expect(removed.step.id).toBe("t2");
    expect(store.getState().tour!.step).toBe(1); // clamped: the tour has two steps now
    store.restoreStep("tour:demo", removed.step, removed.index);
    expect(tourOf(store).steps.map((s) => s.id)).toEqual(["t1", "t3", "t2"]);
    expect(store.removeStep("tour:demo", "nope")).toBeUndefined();
    expect(store.removeStep("tour:nope", "t1")).toBeUndefined();
  });

  it("a drill-in style rebuild of the model is not needed for a tour edit: the drawing is reused", () => {
    const store = new ViewerStore(makeBundle());
    const before = derived(store).view;
    store.setStepNote("tour:demo", "t1", "typing…");
    expect(derived(store).view).toBe(before);
    store.toggleEdgeKind("calls");
    expect(derived(store).view).not.toBe(before);
  });
});

describe("saving tours under xpl view", () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  let respond: (url: string, init?: RequestInit) => Response;

  beforeEach(() => {
    vi.useFakeTimers();
    calls.length = 0;
    respond = () => new Response("{}", { status: 200 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, ...(init ? { init } : {}) });
        return respond(url, init);
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const body = (i: number) => JSON.parse(String(calls[i]!.init!.body)) as Record<string, unknown>;
  const server = () => new ViewerStore(makeBundle({ server: { api: "/api" } }));

  it("PUTs the whole tour to /tours/<id>, once for quick edits, with what it is by then", async () => {
    const store = server();
    store.setStepNote("tour:demo", "t1", "a");
    store.setStepNote("tour:demo", "t1", "ab");
    store.moveStep("tour:demo", "t2", -1);
    expect(store.getState().save).toEqual({ status: "saving" });
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/tours/tour:demo");
    expect(calls[0]!.init!.method).toBe("PUT");
    const sent = body(0) as { title: string; steps: { id: string; note?: string }[] };
    expect(sent.title).toBe("Demo");
    expect(sent.steps.map((s) => s.id)).toEqual(["t2", "t1", "t3"]);
    expect(sent.steps[1]!.note).toBe("ab");
    expect(store.getState().save).toEqual({ status: "saved" });
    expect(store.getState().dirty).toBe(false);
  });

  it("creates a new tour with PUT /tours/tour:<slug> (title and steps)", async () => {
    const store = server();
    store.select(["grp:core"]);
    store.addToTour({ title: "My talk" });
    await vi.advanceTimersByTimeAsync(400);
    expect(calls.map((c) => c.url)).toEqual(["/api/tours/tour:my-talk"]);
    expect(body(0)).toEqual({
      title: "My talk",
      steps: [{ id: "t1", view: "view:overview", focus: ["grp:core"] }],
    });
  });

  it("a refused tour keeps its edit, says why, and does not hold back a view edit", async () => {
    const store = server();
    respond = (url) =>
      url.includes("/tours/")
        ? new Response(JSON.stringify({ error: "tour patch rejected: stale anchor" }), {
            status: 400,
            statusText: "Bad Request",
          })
        : new Response("{}", { status: 200 });
    store.setStepNote("tour:demo", "t1", "note");
    store.exitPresent();
    store.select([]);
    store.toggleEdgeKind("reads");
    await vi.advanceTimersByTimeAsync(400);
    expect(calls.map((c) => c.url).sort()).toEqual([
      "/api/tours/tour:demo",
      "/api/views/view:overview",
    ]);
    expect(store.getState().save).toEqual({
      status: "error",
      message: "400 Bad Request: tour patch rejected: stale anchor",
    });
    expect(store.getState().dirty).toBe(true);
    // newer edits queue behind it; once the server accepts, one PUT carries the latest tour
    respond = () => new Response("{}", { status: 200 });
    store.setStepNote("tour:demo", "t1", "newer note");
    await vi.advanceTimersByTimeAsync(400);
    const last = body(calls.length - 1) as { steps: { note?: string }[] };
    expect(calls.at(-1)!.url).toBe("/api/tours/tour:demo");
    expect(last.steps[0]!.note).toBe("newer note");
    expect(store.getState().save).toEqual({ status: "saved" });
    expect(store.getState().dirty).toBe(false);
  });
});

describe("the address bar", () => {
  const present = { mode: "present" as const, tour: { tourId: "tour:intro", step: 1 } };
  const explore = { mode: "explore" as const, tour: undefined };

  it("names the slide while presenting, with a readable tour id and 1-based step", () => {
    expect(searchFor(present, "", undefined)).toBe("?mode=present&tour=tour:intro&step=2");
    expect(searchFor(present, "?mode=present&tour=tour%3Aintro&step=1", undefined)).toBe(
      "?mode=present&tour=tour:intro&step=2",
    );
    // other parameters stay
    expect(searchFor(present, "?view=view:x", undefined)).toBe(
      "?view=view:x&mode=present&tour=tour:intro&step=2",
    );
  });

  it("leaving Present drops tour and step; mode=explore only when the bundle opens in Present", () => {
    const talk = "?mode=present&tour=tour:intro&step=2";
    expect(searchFor(explore, talk, undefined)).toBe("");
    expect(searchFor(explore, talk, "explore")).toBe("");
    expect(searchFor(explore, talk, "present")).toBe("?mode=explore");
    expect(searchFor(explore, `${talk}&view=view:x`, undefined)).toBe("?view=view:x");
    expect(searchFor({ mode: "present", tour: undefined }, "", undefined)).toBe("");
  });
});

describe("the tour keys", () => {
  const act = (key: string, extra: Record<string, boolean> = {}) =>
    tourKeyAction({ key, ...extra });

  it("maps arrows, paging, space, home/end and escape", () => {
    expect(["ArrowRight", "PageDown", " "].map((k) => act(k))).toEqual(["next", "next", "next"]);
    expect(["ArrowLeft", "PageUp"].map((k) => act(k))).toEqual(["prev", "prev"]);
    expect(act(" ", { shiftKey: true })).toBe("prev");
    expect(act("Home")).toBe("first");
    expect(act("End")).toBe("last");
    expect(act("Escape")).toBe("exit");
  });

  it("leaves everything else, and browser shortcuts, alone", () => {
    for (const key of ["a", "Enter", "ArrowUp", "ArrowDown", "Tab", "0", "+"]) {
      expect(act(key), key).toBeUndefined();
    }
    for (const mod of ["ctrlKey", "metaKey", "altKey"]) {
      expect(act("ArrowRight", { [mod]: true }), mod).toBeUndefined();
      expect(act("Home", { [mod]: true }), mod).toBeUndefined();
    }
  });
});

// Keep the tour of the shared world in sync with what these tests assume.
describe("the test world", () => {
  it("has the demo tour", () => {
    expect(makeBundle().explainer.tours.map((t) => t.id)).toEqual([TOUR.id]);
  });
});
