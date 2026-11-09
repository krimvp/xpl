import { deriveGraph, ExplainerModel, type GraphView, type SequenceView } from "@xpl/core";
import { describe, expect, it } from "vitest";
import { firstSentence, linkWords, mapParts, stepParts } from "../src/parts.js";
import { makeBundle } from "./world.js";

function world() {
  const bundle = makeBundle();
  const model = new ExplainerModel(bundle.explainer, bundle.index);
  const overview = model.view("view:overview") as GraphView;
  const flow = model.view("view:flow") as SequenceView;
  return { model, overview, flow };
}

describe("the parts of a diagram in words", () => {
  it("lists a map's boxes in the author's order, each with what it is for and its arrows on the map", () => {
    const { model, overview } = world();
    const parts = mapParts(deriveGraph(overview, model), overview, model);
    expect(parts.boxes.map((box) => [box.label, box.depth])).toEqual([
      ["Core", 0],
      ["c.yaml", 0],
    ]);
    // the boxes it uses and the ones that use it, by name; a file's kind is left to its badge
    expect(parts.boxes[0]).toMatchObject({
      summary: "A and B together.",
      links: ["uses c.yaml"],
    });
    expect(parts.boxes[1]).toMatchObject({ links: ["used by Core"] });
    expect(parts.boxes[1]!.kind).toBeUndefined();
    // an arrow its author named is listed by its words, between the names of its two boxes
    expect(parts.arrows).toEqual([
      expect.objectContaining({
        id: "edge:notifies",
        from: "Core",
        to: "c.yaml",
        label: "notifies",
      }),
    ]);
  });

  it("numbers the steps of a sequence in the order the diagram numbers them, with who calls whom", () => {
    const { model, flow } = world();
    expect(stepParts(flow, model).map((step) => [step.number, step.id, step.label])).toEqual([
      [1, "flow:1", "go(1)"],
      [2, "flow:2", "ok"],
    ]);
    expect(stepParts(flow, model)[0]).toMatchObject({ from: "A.run", to: "b.ts" });
    // the same steps drawn as a flow: the same numbers, no arrow ends
    const asFlow = stepParts({ ...flow, type: "flow" }, model);
    expect(asFlow.map((step) => [step.number, step.id])).toEqual([
      [1, "flow:1"],
      [2, "flow:2"],
    ]);
    expect(asFlow[0]!.from).toBeUndefined();
  });

  // "Job queue implements Runner" on a folder map read as if the queue were a kind of runner
  it("says where the interface is when an implements arrow joins two files", () => {
    const { model, overview } = world();
    const graph = deriveGraph(overview, model);
    graph.edges = [
      {
        id: "edge:implements:file:src/b.ts->file:config/c.yaml",
        from: "grp:core",
        to: "file:config/c.yaml",
        kind: "implements",
        label: "implements an interface in",
        count: 1,
        resolution: "heuristic",
        stored: false,
        anchors: [],
      },
    ];
    const parts = mapParts(graph, overview, model);
    expect(parts.boxes.map((box) => box.links)).toEqual([
      ["implements an interface in c.yaml"],
      ["has an interface implemented by Core"],
    ]);
  });

  // Go has no parent types: an embedded type read "extends" / "extended by"
  it("says embeds and embedded by for a Go struct's embedded type", () => {
    const { model, overview } = world();
    const graph = deriveGraph(overview, model);
    const edge = (label: string) => ({
      id: "edge:extends:grp:core->file:config/c.yaml",
      from: "grp:core",
      to: "file:config/c.yaml",
      kind: "extends" as const,
      label,
      count: 1,
      resolution: "heuristic" as const,
      stored: false,
      anchors: [],
    });
    graph.edges = [edge("embeds")];
    expect(mapParts(graph, overview, model).boxes.map((box) => box.links)).toEqual([
      ["embeds c.yaml"],
      ["embedded by Core"],
    ]);
    graph.edges = [edge("embeds a type in")];
    expect(mapParts(graph, overview, model).boxes.map((box) => box.links)).toEqual([
      ["embeds a type in c.yaml"],
      ["has a type embedded by Core"],
    ]);
  });

  it("says a box's links by name, and counts them past two", () => {
    expect(linkWords("uses", ["worker.ts"])).toBe("uses worker.ts");
    expect(linkWords("used by", ["main.ts", "test"])).toBe("used by main.ts and test");
    expect(linkWords("uses", ["a", "b", "c"])).toBe("uses 3 boxes here");
    expect(linkWords("uses", [])).toBeUndefined();
    expect(linkWords("held by", ["a", "b", "c"], "fields")).toBe("held by 3 fields here");
  });

  it("keeps the first sentence of a summary, not a dot inside a name", () => {
    expect(firstSentence("Reads config.yaml at start. Then it waits.")).toBe(
      "Reads config.yaml at start.",
    );
    expect(firstSentence("  One sentence  ")).toBe("One sentence");
    expect(firstSentence(undefined)).toBeUndefined();
  });
});
