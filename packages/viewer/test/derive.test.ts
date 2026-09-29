import { hashText, INDEX_SCHEMA, type SymbolIndex, type ViewerBundle } from "@xpl/core";
import { describe, expect, it } from "vitest";
import { getDerived, MAX_PANES } from "../src/derive.js";
import { ViewerStore } from "../src/store.js";
import { makeBundle } from "./world.js";

const RUN = "sym:src/a.ts#A.run";

function storeFor(view: string, edit?: (bundle: ViewerBundle) => void) {
  const bundle = makeBundle();
  edit?.(bundle);
  const store = new ViewerStore(bundle, { view });
  return { store, derived: () => getDerived(store.getState()) };
}

const summary = (
  ranges: readonly { file: string; range: { startLine: number; endLine: number }; role: string }[],
) => ranges.map((r) => [r.file, r.range.startLine, r.range.endLine, r.role]);

describe("code focus of a selection", () => {
  it("a sequence step: the call site and the definition, files in anchor order", () => {
    const { store, derived } = storeFor("view:flow");
    store.select(["flow:1"]);
    const { selection } = derived();
    expect(summary(selection.focus)).toEqual([
      ["src/a.ts", 12, 12, "call-site"],
      ["src/b.ts", 3, 10, "definition"],
    ]);
    expect(selection.files.map((f) => f.file)).toEqual(["src/a.ts", "src/b.ts"]);
    expect([...selection.focusFiles]).toEqual(["src/a.ts", "src/b.ts"]);
    expect(derived().panes.map((p) => [p.file, p.focused, p.opened])).toEqual([
      ["src/a.ts", true, false],
      ["src/b.ts", true, false],
    ]);
  });

  it("several elements: their ranges follow the order of the selection", () => {
    const { store, derived } = storeFor("view:flow");
    store.select(["concept:retry", "flow:1"]);
    expect(derived().selection.files.map((f) => f.file)).toEqual([
      "src/a.ts",
      "config/c.yaml",
      "src/b.ts",
    ]);
    store.select(["flow:1", "concept:retry"]);
    expect(derived().selection.files.map((f) => f.file)).toEqual([
      "src/a.ts",
      "src/b.ts",
      "config/c.yaml",
    ]);
  });

  it("a derived edge of the graph view uses the sites of its references", () => {
    const { store, derived } = storeFor("view:overview", (bundle) => {
      const view = bundle.explainer.views.find((v) => v.id === "view:overview")!;
      if (view.type === "graph") view.include = ["file:src/a.ts", "file:src/b.ts"];
    });
    const edge = "edge:calls:file:src/a.ts->file:src/b.ts";
    expect(derived().view.edgeMap.has(edge)).toBe(true);
    store.select([edge]);
    expect(summary(derived().selection.focus)).toEqual([
      ["src/a.ts", 12, 12, "call-site"],
      ["src/a.ts", 25, 25, "call-site"],
      ["src/b.ts", 3, 10, "definition"],
    ]);
  });

  it("a stub: the sites that cross the edge of the view, plus what is on the other side", () => {
    const { store, derived } = storeFor("view:overview", (bundle) => {
      const view = bundle.explainer.views.find((v) => v.id === "view:overview")!;
      if (view.type === "graph") view.include = [RUN];
    });
    const stub = "stub:out:sym:src/a.ts#A.run->ghost:file:src/b.ts";
    expect(derived().view.stubMap.has(stub)).toBe(true);
    store.select([stub]);
    expect(summary(derived().selection.focus)).toEqual([
      ["src/a.ts", 12, 12, "call-site"],
      ["src/b.ts", 3, 10, "definition"],
    ]);
    expect(derived().selection.focus.every((f) => f.elementId === stub)).toBe(true);
    // ghosts are not selectable elements and have no code of their own
    store.select(["ghost:file:src/b.ts"]);
    expect(derived().selection.focus).toEqual([]);
  });
});

describe("what a concept relates to, as drawn in the current view", () => {
  it("in a sequence: the participants that are, or contain, a related element", () => {
    const { store, derived } = storeFor("view:flow");
    store.select(["concept:retry"]);
    expect([...derived().selection.related].sort()).toEqual(["file:src/b.ts", RUN]);
  });

  it("in a graph: the box that stands for it, here the group", () => {
    const { store, derived } = storeFor("view:overview");
    store.select(["concept:retry"]);
    expect([...derived().selection.related].sort()).toEqual(["file:src/b.ts", "grp:core", RUN]);
  });

  it("nothing for elements that are not concepts", () => {
    const { store, derived } = storeFor("view:flow");
    store.select(["flow:1"]);
    expect(derived().selection.related.size).toBe(0);
  });
});

describe("reverse lookup", () => {
  it("finds the innermost element of the view at the cursor line", () => {
    const { store, derived } = storeFor("view:flow");
    store.setCursor("src/a.ts", 12);
    expect(derived().matches).toEqual(["flow:1"]); // the step (1 line) beats the lifeline (16 lines)
    store.setCursor("src/a.ts", 8);
    expect(derived().matches).toEqual(["concept:retry"]);
    store.setCursor("src/a.ts", 15);
    expect(derived().matches).toEqual([RUN]);
    store.setCursor("src/a.ts", 29);
    expect(derived().matches).toEqual([]);
    store.setCursor("config/c.yaml", 3);
    expect(derived().matches).toEqual(["concept:retry"]);
  });

  it("a selection of lines looks up every line it covers", () => {
    const { store, derived } = storeFor("view:flow");
    // lines 8-9 are the concept's, 10-11 only the lifeline's, 12 the step's
    store.setCursor("src/a.ts", 8, 12);
    expect(derived().matches).toEqual(["concept:retry", "flow:1", RUN]);
    store.setCursor("src/a.ts", 8, 9);
    expect(derived().matches).toEqual(["concept:retry"]);
  });

  it("uses the elements of the current view only (plus the concepts)", () => {
    const { store, derived } = storeFor("view:flow");
    store.setCursor("src/a.ts", 27); // A.stop: in no view element
    expect(derived().matches).toEqual([]);
    store.setView("view:overview");
    store.setCursor("src/a.ts", 27);
    expect(derived().matches).toEqual(["grp:core"]);
  });

  it("no cursor, no matches", () => {
    const { derived } = storeFor("view:flow");
    expect(derived().matches).toEqual([]);
  });
});

describe("editor panes", () => {
  it("an opened file goes first, focused or not", () => {
    const { store, derived } = storeFor("view:flow");
    store.openFile("config/c.yaml");
    expect(derived().panes.map((p) => [p.file, p.focused, p.opened])).toEqual([
      ["config/c.yaml", false, true],
    ]);
    store.select(["flow:1"]);
    expect(store.getState().openedFile).toBeUndefined(); // a new selection is the new focus
    store.openFile("src/b.ts");
    expect(derived().panes.map((p) => [p.file, p.focused, p.opened])).toEqual([
      ["src/b.ts", true, true],
      ["src/a.ts", true, false],
    ]);
    store.openFile("config/c.yaml");
    expect(derived().panes.map((p) => p.file)).toEqual(["config/c.yaml", "src/a.ts", "src/b.ts"]);
    expect(derived().panes[0]!.ranges).toEqual([]);
  });

  it("shows at most MAX_PANES files and lists the rest", () => {
    const count = MAX_PANES + 3;
    const texts = Object.fromEntries(
      Array.from({ length: count }, (_, i) => [`f${String(i).padStart(2, "0")}.ts`, "a\nb\nc"]),
    );
    const index: SymbolIndex = {
      schema: INDEX_SCHEMA,
      commit: "t",
      tool: "test",
      languages: {},
      files: Object.entries(texts).map(([path, text]) => ({
        path,
        language: "typescript" as const,
        hash: hashText(text),
        lines: 3,
      })),
      symbols: [],
      refs: [],
    };
    const bundle = makeBundle();
    const store = new ViewerStore({
      ...bundle,
      index,
      files: texts,
      explainer: { ...bundle.explainer, views: [] },
    });
    store.select(["repo"]);
    const derived = getDerived(store.getState());
    expect(derived.panes).toHaveLength(MAX_PANES);
    expect(derived.overflow).toEqual(["f10.ts", "f11.ts", "f12.ts"]);
  });
});

describe("memoisation", () => {
  it("a caret move recomputes the matches only", () => {
    const { store, derived } = storeFor("view:flow");
    store.select(["flow:1"]);
    const before = derived();
    store.setCursor("src/a.ts", 12);
    const after = derived();
    expect(after.selection).toBe(before.selection);
    expect(after.view).toBe(before.view);
    expect(after.panes).toBe(before.panes);
    expect(after.matches).not.toBe(before.matches);
    expect(getDerived(store.getState())).toBe(after);
  });
});
