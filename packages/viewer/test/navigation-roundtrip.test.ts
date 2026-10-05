import { expect, it } from "vitest";
import type { Range } from "@xpl/core";
import { readLaunchParams } from "../src/data.js";
import { ViewerStore, type ViewerState } from "../src/store.js";
import { searchFor } from "../src/url.js";
import { makeBundle } from "./world.js";

const fields = (
  state: Pick<
    ViewerState,
    "mode" | "perspective" | "viewId" | "selection" | "tour" | "applied" | "cursor"
  >,
) => ({
  mode: state.mode,
  perspective: state.perspective,
  viewId: state.viewId,
  selection: state.selection,
  tour: state.tour,
  applied: state.applied,
  cursor: state.cursor,
});

it("round-trips serialized navigation across short action sequences and the b1/b2/b3 cases", () => {
  const actions: Record<string, (store: ViewerStore) => void> = {
    t1: (s) => s.previewStep("tour:demo", 0),
    t2: (s) => s.previewStep("tour:demo", 1),
    t3: (s) => s.previewStep("tour:demo", 2),
    map: (s) => s.setPerspective("map"),
    flow: (s) => s.setPerspective("flow"),
    code: (s) => s.setPerspective("code"),
    explore: (s) => s.setPerspective("explore"),
    select: (s) => s.select(["concept:retry"]),
    clear: (s) => s.select([]),
    view: (s) => {
      s.setView("view:overview");
    },
    head: (s) => s.openRange("src/a.ts", { startLine: 12, endLine: 12, startCol: 6, endCol: 9 }),
    base: (s) =>
      s.openRange("old.ts", { startLine: 1, endLine: 1, startCol: 1, endCol: 3 }, "base"),
    cursor: (s) => s.setCursor("src/b.ts", 4, 4, "head", 2, 5),
    baseCursor: (s) => s.setCursor("old.ts", 1, 1, "base", 1, 3),
    present: (s) => {
      s.present("tour:demo", 1);
    },
    exit: (s) => s.exitPresent(),
  };
  const boundaries: [string, "head" | "base", Range][] = [
    ["first-column", "head", { startLine: 1, endLine: 1, startCol: 1, endCol: 1 }],
    ["line-end", "head", { startLine: 1, endLine: 1, startCol: 8, endCol: 8 }],
    ["last-line-end", "head", { startLine: 30, endLine: 30, startCol: 9, endCol: 9 }],
    ["multiline-ends", "head", { startLine: 1, endLine: 30, startCol: 8, endCol: 9 }],
    ["first-to-end", "base", { startLine: 1, endLine: 1, startCol: 1, endCol: 11 }],
    ["empty-line", "base", { startLine: 2, endLine: 2, startCol: 1, endCol: 1 }],
    ["last-empty-line", "base", { startLine: 4, endLine: 4, startCol: 1, endCol: 1 }],
    ["multiline-empty", "base", { startLine: 2, endLine: 4, startCol: 1, endCol: 1 }],
  ];
  for (const [name, side, range] of boundaries) {
    const file = side === "head" ? "src/a.ts" : "old.ts";
    actions[`cursor-${name}`] = (s) =>
      s.setCursor(file, range.startLine, range.endLine, side, range.startCol, range.endCol);
    actions[`range-${name}`] = (s) => {
      s.openRange(file, range, side);
      expect(s.getState().cursor, name).toEqual({
        file,
        fromLine: range.startLine,
        toLine: range.endLine,
        fromCol: range.startCol,
        toCol: range.endCol,
        ...(side === "base" ? { side } : {}),
      });
    };
  }
  const cases: Record<string, string[]> = {
    "b1 saved Present with cursor": ["present", "cursor"],
    "b1 saved Present Code with cursor": ["code", "present", "cursor"],
    "b1 different-view tour detour": ["present", "exit", "view", "select"],
    "b1 combined step, view, focus and range": ["t2", "map", "select", "cursor"],
    "b2 applied code override after switching to Map": ["t3", "map"],
    "b2 Present history target with cursor": ["present", "cursor", "exit", "present", "cursor"],
  };
  let sequences: string[][] = [[]];
  for (let length = 1; length <= 3; length++) {
    sequences = sequences.flatMap((prefix) =>
      Object.keys(actions).map((name) => [...prefix, name]),
    );
    for (const sequence of sequences) cases[sequence.join(" → ")] = sequence;
  }
  cases.initial = [];
  for (const mode of [undefined, "present"] as const) {
    const bundle = makeBundle({ mode });
    bundle.explainer.change = {
      base: "a".repeat(40),
      head: "b".repeat(40),
      files: [{ path: "old.ts", status: "deleted", hunks: [] }],
    };
    bundle.baseFiles = { "old.ts": "old source\n\nlast line\n" };
    for (const [name, sequence] of Object.entries(cases)) {
      const store = new ViewerStore(bundle);
      for (const action of sequence) actions[action]!(store);
      const state = store.getState();
      const query = searchFor(state, "", mode);
      const restored = new ViewerStore(bundle, readLaunchParams(query));
      expect(fields(restored.getState()), `${mode ?? "explore"}: ${name}; ${query}`).toEqual(
        fields(state),
      );
    }
  }
  const restorer = new ViewerStore(makeBundle());
  const initial = restorer.getState();
  const restored = restorer.restoreState(
    readLaunchParams("?perspective=map&tour=tour:demo&step-id=t3&view=view:overview&focus=flow:2"),
  );
  expect(restored).toMatchObject({
    perspective: "map",
    viewId: "view:overview",
    applied: { stepId: "t3", code: [{ file: "config/c.yaml" }] },
    selection: ["flow:2"],
  });
  expect(restorer.getState()).toBe(initial);
});
