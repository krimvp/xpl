/**
 * The reader UX round of iteration 2: the tests of a guide section, the flow box's actor, the still
 * pictures of the guide, the flow start zoom in Present.
 */
import { describe, expect, it } from "vitest";
import { ExplainerModel, hashText, sliceLines, type IndexedSymbol } from "@xpl/core";
import { indentColumns } from "../src/editor.js";
import { sharedActor, stageActor, wrapWords } from "../src/layout/flowLayout.js";
import { stepTests } from "../src/stepTests.js";
import {
  frameView,
  SNAPSHOT_MIN_ZOOM,
  SNAPSHOT_WHOLE,
  SNAPSHOT_ZOOM,
  snapshotView,
} from "../src/viewport.js";
import { makeBundle, makeIndex } from "./world.js";

describe("the tests of a guide section", () => {
  // A test file: a fixture, two tests (one with a local helper), and a test class with a method.
  const TEST_FILE = "tests/test_b.py";
  const text = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
  const sym = (
    path: string,
    kind: IndexedSymbol["kind"],
    start: number,
    end: number,
    parent?: string,
  ) =>
    ({
      id: `${TEST_FILE}#${path}`,
      file: TEST_FILE,
      path,
      kind,
      range: { startLine: start, endLine: end },
      hash: hashText(sliceLines(text, { startLine: start, endLine: end })),
      ...(parent ? { parent: `${TEST_FILE}#${parent}` } : {}),
    }) satisfies IndexedSymbol;
  const model = (anchors: { symbol?: string; span?: { from: number; to: number } }[]) => {
    const bundle = makeBundle();
    const index = makeIndex();
    index.files.push({ path: TEST_FILE, language: "python", hash: hashText(text), lines: 40 });
    index.symbols.push(
      sym("scope", "function", 1, 5),
      sym("test_one", "function", 7, 18),
      sym("test_one.helper", "function", 9, 12, "test_one"),
      sym("test_two", "function", 20, 26),
      sym("TestGroup", "class", 28, 40),
      sym("TestGroup.test_three", "method", 30, 36, "TestGroup"),
    );
    const explainer = structuredClone(bundle.explainer);
    explainer.concepts.push({
      id: "concept:tested",
      label: "Tested",
      summary: "",
      related: [],
      anchors: anchors.map((a) => ({ file: TEST_FILE, role: "test" as const, hash: "x", ...a })),
      provenance: { origin: "llm" },
    });
    return new ExplainerModel(explainer, index);
  };

  it("a whole test file lists its tests by name, not its fixtures or the helpers inside a test", () => {
    const tests = stepTests(["concept:tested"], model([{}]));
    expect(tests.map((t) => t.name)).toEqual(["test_one", "test_two", "test_three"]);
    expect(tests[0]).toEqual({ name: "test_one", file: TEST_FILE, line: 7 });
  });

  it("a range inside a test (also inside its helper) names that test, once", () => {
    const tests = stepTests(
      ["concept:tested"],
      model([{ symbol: "test_one.helper" }, { symbol: "test_one", span: { from: 8, to: 9 } }]),
    );
    expect(tests.map((t) => t.name)).toEqual(["test_one"]);
  });

  it("a test file with only fixtures in focus is listed by its file name", () => {
    expect(stepTests(["concept:tested"], model([{ symbol: "scope" }]))).toEqual([
      { name: "test_b.py", file: TEST_FILE, line: 1 },
    ]);
  });

  it("a step without test code has no tests", () => {
    const bundle = makeBundle();
    const plain = new ExplainerModel(bundle.explainer, bundle.index);
    expect(stepTests(["grp:core", "flow:1"], plain)).toEqual([]);
  });
});

describe("the flow box's actor", () => {
  const names = { label: (id: string) => id.replace(/^.*#/, "") };
  it("is the step's `from`: who does the stage", () => {
    expect(stageActor({ from: "sym:a.py#Router", to: "sym:a.py#Router" }, names)).toBe("Router");
  });
  it("says where the work goes when it leaves the actor, if that fits; else the actor alone", () => {
    expect(stageActor({ from: "sym:a.py#Router", to: "sym:a.py#Route" }, names)).toBe(
      "Router → Route",
    );
    expect(
      stageActor(
        { from: "sym:a.py#FileResponse.__call__", to: "sym:a.py#FileResponse._open" },
        names,
      ),
    ).toBe("FileResponse.__call__");
    expect(stageActor({ from: "sym:a.py#" + "x".repeat(40), to: "sym:a.py#y" }, names)).toBe(
      "x".repeat(33) + "…",
    );
  });
  it("is `to` when the step's code is inside `to`, not `from`", () => {
    const model = {
      ...names,
      subtreeContains: (ancestor: string, id: string) => id.startsWith(ancestor + "."),
    };
    const step = {
      from: "sym:a.ts#Ky",
      to: "sym:b.ts#limit",
      anchors: [{ file: "b.ts", symbol: "limit.transform", role: "usage" }],
    };
    expect(stageActor(step, model, 34, "terminal")).toBe("limit");
    expect(stageActor(step, model)).toBe("limit");
    // the code in `from`: `from` does it
    const inFrom = { ...step, anchors: [{ file: "a.ts", symbol: "Ky.fetch", role: "call-site" }] };
    expect(stageActor(inFrom, model, 34, "terminal")).toBe("Ky");
    // a base anchor says nothing about who does it now
    const base = { ...step, anchors: [{ ...step.anchors[0], at: "base" }] };
    expect(stageActor(base, model, 34, "terminal")).toBe("Ky");
  });
});

describe("a flow done by one part", () => {
  const names = { label: (id: string) => id.replace(/^.*#/, "") };
  const stage = (from: string, to: string) => ({
    step: { id: `${from}>${to}`, from, to, label: "x", kind: "call" as const, anchors: [] },
    frames: [] as string[],
    shape: "stage" as const,
  });
  it("names that part once: the boxes say only where the work goes", () => {
    const own = "sym:Ky.ts#Ky.#calculateRetryDelay";
    const flow = { stages: [stage(own, own), stage(own, "sym:Ky.ts#Ky.#retry"), stage(own, own)] };
    expect(sharedActor(flow)).toBe(own);
    expect(stageActor(flow.stages[0]!.step, names, 34, "stage", own)).toBe("");
    expect(stageActor(flow.stages[1]!.step, names, 34, "stage", own)).toBe("→ retry");
    expect(stageActor(flow.stages[1]!.step, names, 34, "decision", own)).toBe("");
  });
  it("is none when two parts do the work, or there is one box", () => {
    expect(
      sharedActor({ stages: [stage("sym:a#A", "sym:a#B"), stage("sym:a#B", "sym:a#A")] }),
    ).toBe(undefined);
    expect(sharedActor({ stages: [stage("sym:a#A", "sym:a#A")] })).toBe(undefined);
  });
});

describe("flow text and code lines", () => {
  it("cuts a word longer than a line after a dot or before a bracket, so no line runs past the box", () => {
    expect(wrapWords("ky.#runAfterResponseHooks(response)", 28)).toEqual([
      "ky.#runAfterResponseHooks",
      "(response)",
    ]);
    expect(wrapWords("Ky.create(input, validateAndMerge(defaults, options))", 28, 3)).toEqual([
      "Ky.create(input,",
      "validateAndMerge(defaults,",
      "options))",
    ]);
    // no place to cut: at the width
    expect(wrapWords("a".repeat(30), 28)).toEqual(["a".repeat(28), "aa"]);
    for (const line of wrapWords("self._request_body_parts_with_timeout.read_all()", 18))
      expect(line.length).toBeLessThanOrEqual(18);
  });

  it("wraps words into lines, and cuts at the last line with an ellipsis", () => {
    expect(wrapWords("no: HEAD, pathsend, not HTTP or ASGI 2.4+", 18)).toEqual([
      "no: HEAD,",
      "pathsend, not HTTP",
      "or ASGI 2.4+",
    ]);
    expect(wrapWords("one two three four", 8, 2)).toEqual(["one two", "three…"]);
  });
  it("counts the indentation of a code line (a tab as 4)", () => {
    expect(indentColumns("        send_file = partial(")).toBe(8);
    expect(indentColumns("\t\tx")).toBe(8);
    expect(indentColumns("x")).toBe(0);
  });
});

describe("Present starts a flow at the zoom that shows its whole width (readableMin)", () => {
  const options = {
    padding: 10,
    maxZoom: 1.6,
    whole: 11 / 13,
    readable: 16 / 13,
    readableMin: 11 / 13,
  };
  const flow = { width: 700, height: 1500 };
  it("a wide pane shows the whole width, up to the most", () => {
    const view = frameView({ w: 718, h: 424 }, flow, undefined, options)!;
    expect(view.partial).toBe(true);
    expect(view.transform.k).toBeCloseTo(698 / 700, 3);
    const wide = frameView({ w: 1083, h: 775 }, flow, undefined, options)!;
    expect(wide.transform.k).toBeCloseTo(16 / 13, 5);
  });
  it("a narrow pane never goes below the least (the text stays readable), and frames the focus", () => {
    const focus = { x: 400, y: 1200, width: 250, height: 100 };
    const view = frameView({ w: 400, h: 300 }, flow, { boxes: [focus] }, options)!;
    expect(view.transform.k).toBeCloseTo(11 / 13, 5);
    const left = (0 - view.transform.x) / view.transform.k;
    const top = (0 - view.transform.y) / view.transform.k;
    expect(focus.y).toBeGreaterThanOrEqual(top);
    expect(focus.y + focus.height).toBeLessThanOrEqual(top + 300 / view.transform.k);
    expect(focus.x + focus.width).toBeLessThanOrEqual(left + 400 / view.transform.k + 1);
  });
});

describe("the guide's still pictures", () => {
  it("show a small diagram whole, never enlarged, and only as tall as needed", () => {
    const view = snapshotView(800, 260, { width: 300, height: 120 }, undefined)!;
    expect(view.transform.k).toBe(1);
    expect(view.height).toBe(140);
    expect(view.partial).toBe(false);
  });
  it("show a diagram whole when its text comes out at about 10px or more (no cut end boxes)", () => {
    // 1000 wide in 780: 0.78, above the 10px line
    const view = snapshotView(
      800,
      260,
      { width: 1000, height: 150 },
      {
        boxes: [{ x: 400, y: 20, width: 200, height: 60 }],
      },
    )!;
    expect(view.transform.k).toBeCloseTo(780 / 1000, 5);
    expect(view.transform.k).toBeGreaterThanOrEqual(SNAPSHOT_WHOLE);
    expect(view.partial).toBe(false);
  });
  it("show a big diagram at a readable zoom, on the focus, as far as the diagram allows", () => {
    const focus = { x: 1200, y: 900, width: 200, height: 80 };
    const view = snapshotView(600, 260, { width: 1500, height: 1600 }, { boxes: [focus] })!;
    expect(view.transform.k).toBe(SNAPSHOT_ZOOM);
    const centreY = (130 - view.transform.y) / view.transform.k;
    expect(centreY).toBeCloseTo(940, 0);
    const centreX = (300 - view.transform.x) / view.transform.k;
    expect(centreX).toBeLessThanOrEqual(1500 - (300 - 10) / view.transform.k + 1);
  });
  it("take in the focus' neighbours, down to a floor, and count focused boxes left out", () => {
    const content = { width: 3000, height: 3000 };
    const focus = { x: 1000, y: 1000, width: 250, height: 100 };
    const below = { x: 1000, y: 1170, width: 250, height: 100 };
    const view = snapshotView(600, 260, content, { boxes: [focus], neighbours: [below] })!;
    expect(view.transform.k).toBeGreaterThanOrEqual(SNAPSHOT_MIN_ZOOM - 1e-9);
    const top = (0 - view.transform.y) / view.transform.k;
    expect(top).toBeLessThanOrEqual(focus.y);
    expect(top + 260 / view.transform.k).toBeGreaterThanOrEqual(below.y + below.height);
    const far = { x: 2800, y: 2800, width: 100, height: 100 };
    expect(snapshotView(600, 260, content, { boxes: [focus, far] })!.hidden).toBe(1);
  });
  it("grow taller still rather than cut a box the step names (a tall map, every part of it named)", () => {
    // 750 x 715, named top and bottom: at 420 tall (0.57 to fit) the frame is cut; at 620 it is whole
    const content = { width: 750, height: 715 };
    const top = { x: 350, y: 0, width: 100, height: 50 };
    const bottom = { x: 350, y: 665, width: 100, height: 50 };
    const cut = snapshotView(780, 260, content, { boxes: [top, bottom] }, 420)!;
    expect(cut.hidden).toBe(1);
    const view = snapshotView(780, 260, content, { boxes: [top, bottom] }, 420, 620)!;
    expect(view.hidden).toBe(0);
    expect(view.partial).toBe(false);
    expect(view.transform.k).toBeGreaterThanOrEqual(SNAPSHOT_WHOLE);
    expect(view.height).toBeLessThanOrEqual(620);
    // a picture that names nothing it would cut stays at the usual height
    expect(snapshotView(780, 260, content, { boxes: [top] }, 420, 620)!.height).toBeLessThanOrEqual(
      420,
    );
  });
  it("grow taller when that shows the whole diagram", () => {
    // 700 x 380: cut at 260 tall (0.63), whole at 420 tall (0.82)
    const view = snapshotView(600, 260, { width: 700, height: 380 }, undefined, 420)!;
    expect(view.partial).toBe(false);
    expect(view.height).toBeGreaterThan(260);
    expect(view.height).toBeLessThanOrEqual(420);
  });
  it("have nothing to show before they have a width", () => {
    expect(snapshotView(0, 260, { width: 100, height: 100 }, undefined)).toBeUndefined();
  });
});
