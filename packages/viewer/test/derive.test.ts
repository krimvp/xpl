import {
  BUNDLE_SCHEMA,
  createExplainer,
  hashText,
  INDEX_SCHEMA,
  type Anchor,
  type SymbolIndex,
  type ViewerBundle,
} from "@xpl/core";
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
  it("excludes test references when selecting an aggregated directory stub", () => {
    const files = {
      "src/main.ts": "function run() {\n  go();\n  test();\n}",
      "lib/b.ts": "function go() {}",
      "lib/b.test.ts": "function test() {}",
    };
    const index: SymbolIndex = {
      schema: INDEX_SCHEMA,
      commit: "repro",
      tool: "test",
      languages: {},
      files: Object.entries(files).map(([path, text]) => ({
        path,
        language: "typescript",
        hash: hashText(text),
        lines: text.split("\n").length,
      })),
      symbols: Object.entries(files).map(([file, text], i) => ({
        id: `${file}#${["run", "go", "test"][i]}`,
        file,
        path: ["run", "go", "test"][i]!,
        kind: "function",
        range: { startLine: 1, endLine: text.split("\n").length },
        hash: hashText(text),
      })),
      refs: [
        {
          from: "src/main.ts#run",
          to: "lib/b.ts#go",
          kind: "call",
          site: { startLine: 2, endLine: 2 },
          resolution: "precise",
        },
        {
          from: "src/main.ts#run",
          to: "lib/b.test.ts#test",
          kind: "call",
          site: { startLine: 3, endLine: 3 },
          resolution: "precise",
        },
      ],
    };
    const explainer = createExplainer({
      title: "Test",
      repoName: "test",
      index,
      indexPath: ".explainer/index-repro.json",
    });
    explainer.views.push({
      id: "view:repro",
      type: "graph",
      title: "Repro",
      scope: { root: "repo", depth: 1 },
      include: ["file:src/main.ts"],
      excludeFiles: ["**/*.test.ts"],
      provenance: { origin: "llm", commit: "repro" },
    });
    const store = new ViewerStore({ schema: BUNDLE_SCHEMA, index, explainer, files });
    const derived = () => getDerived(store.getState());
    const stub = [...derived().view.stubMap.values()].find(
      (s) => s.direction === "out" && s.targets.some((t) => t.target === "dir:lib"),
    )!;
    expect(stub).toBeDefined();
    store.select([stub.id]);
    expect(derived().selection.files.map((f) => f.file)).toEqual(["src/main.ts", "lib/b.ts"]);
    expect(
      derived().selection.focus.some((f) => f.file === "src/main.ts" && f.range.startLine === 3),
    ).toBe(false);
  });

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

  it("a stub to a folded ghost: the sites and definitions of every element it folds", () => {
    const { store, derived } = storeFor("view:overview", (bundle) => {
      const view = bundle.explainer.views.find((v) => v.id === "view:overview")!;
      if (view.type === "graph") view.include = [RUN];
    });
    // A.stop calls A.run, and A.stop is a symbol of a.ts, a file the view shows in part
    const stub = "stub:in:sym:src/a.ts#A.run->ghost:rest:file:src/a.ts";
    expect(derived().view.stubMap.has(stub)).toBe(true);
    store.select([stub]);
    expect(summary(derived().selection.focus)).toEqual([
      ["src/a.ts", 26, 26, "call-site"],
      ["src/a.ts", 5, 20, "definition"],
    ]);
    // a reference that ends in something the view shows is not part of it
    expect(derived().selection.focus.every((f) => f.elementId === stub)).toBe(true);
    // the overflow ghost works the same way
    const { store: capped, derived: cappedDerived } = storeFor("view:overview", (bundle) => {
      const view = bundle.explainer.views.find((v) => v.id === "view:overview")!;
      if (view.type === "graph") {
        view.include = [RUN];
        view.stubs = { max: 0 };
      }
    });
    capped.select(["stub:out:sym:src/a.ts#A.run->ghost:more:out"]);
    expect(summary(cappedDerived().selection.focus)).toEqual([
      ["src/a.ts", 12, 12, "call-site"],
      ["src/b.ts", 3, 10, "definition"],
    ]);
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
    // the concept (3 lines) does not hide the drawn lifeline around it: concepts are added on top
    store.setCursor("src/a.ts", 8);
    expect(derived().matches).toEqual(["concept:retry", RUN]);
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
    expect(derived().matches).toEqual(["concept:retry", RUN]);
  });

  it("a concept inside a step does not hide the step (chi: the pop at tree.go:500)", () => {
    const { store, derived } = storeFor("view:flow", (bundle) => {
      const concept = bundle.explainer.concepts.find((c) => c.id === "concept:retry")!;
      // one line, inside the step's line 12 range widened to 11-13
      concept.anchors = [
        { file: "src/a.ts", symbol: "A.run", span: { from: 6, to: 6 }, role: "definition" },
      ] as Anchor[];
      const step = (bundle.explainer.views[1] as { steps: { id: string; anchors: unknown[] }[] })
        .steps[0]!;
      step.anchors = [
        { file: "src/a.ts", symbol: "A.run", span: { from: 5, to: 7 }, role: "call-site" },
      ];
    });
    store.setCursor("src/a.ts", 11);
    expect(derived().matches).toEqual(["concept:retry", "flow:1"]);
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

  it("a pane scrolls to the first range in the step's order, not to the lowest line", () => {
    // flow:1 is at line 12 of src/a.ts, the concept starts at line 7: selected in this order, the pane leads
    // with line 12 (a step about the second place in a file shows that place first).
    const { store, derived } = storeFor("view:flow");
    store.select(["flow:1", "concept:retry"]);
    const a = derived().panes.find((p) => p.file === "src/a.ts")!;
    expect(a.ranges.map((r) => r.range.startLine).sort((x, y) => x - y)).toEqual([7, 12]);
    expect(a.lead).toBe(12);
    store.select(["concept:retry", "flow:1"]);
    expect(derived().panes.find((p) => p.file === "src/a.ts")!.lead).toBe(7);
    // a code override leads in its own order
    const { store: other, derived: otherDerived } = storeFor("view:flow", (bundle) => {
      const step = bundle.explainer.tours[0]!.steps[1]!;
      step.code = [
        ...bundle.explainer.edges.find((e) => e.id === "edge:notifies")!.anchors.slice(0, 1),
        ...bundle.explainer.concepts[0]!.anchors.slice(0, 1),
      ].reverse();
    });
    other.previewStep("tour:demo", 1);
    expect(otherDerived().panes.find((p) => p.file === "src/a.ts")!.lead).toBe(7);
    // a file that was only opened (not in the focus) has no lead
    other.openFile("config/c.yaml");
    expect(otherDerived().panes.find((p) => p.file === "config/c.yaml")!.lead).toBeUndefined();
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
