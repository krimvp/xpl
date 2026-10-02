/**
 * The reader UX round of iteration 2: the tests of a guide section, the flow box's actor, the still
 * pictures of the guide, the flow start zoom in Present and "Save as HTML".
 */
import { describe, expect, it } from "vitest";
import {
  ExplainerModel,
  hashText,
  parseBundle,
  serializeBundle,
  sliceLines,
  type IndexedSymbol,
} from "@xpl/core";
import { indentColumns } from "../src/editor.js";
import { stageActor, wrapWords } from "../src/layout/flowLayout.js";
import { withExplainer } from "../src/saveHtml.js";
import { stepTests } from "../src/stepTests.js";
import { SNAPSHOT_MIN_ZOOM, SNAPSHOT_ZOOM, snapshotView, startView } from "../src/viewport.js";
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
});

describe("flow text and code lines", () => {
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
    floor: 11 / 13,
    readable: 16 / 13,
    readableMin: 11 / 13,
  };
  const flow = { width: 700, height: 1500 };
  it("a wide pane shows the whole width, up to the most", () => {
    const view = startView({ w: 718, h: 424 }, flow, undefined, options)!;
    expect(view.partial).toBe(true);
    expect(view.transform.k).toBeCloseTo(698 / 700, 3);
    const wide = startView({ w: 1083, h: 775 }, flow, undefined, options)!;
    expect(wide.transform.k).toBeCloseTo(16 / 13, 5);
  });
  it("a narrow pane never goes below the least (the text stays readable), and frames the focus", () => {
    const focus = { x: 400, y: 1200, width: 250, height: 100 };
    const view = startView({ w: 400, h: 300 }, flow, focus, options)!;
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
  });
  it("show a big diagram at a readable zoom, centred on the focus as far as the diagram allows", () => {
    const focus = { x: 1200, y: 900, width: 200, height: 80 };
    const view = snapshotView(600, 260, { width: 1500, height: 1600 }, focus)!;
    expect(view.transform.k).toBe(SNAPSHOT_ZOOM);
    const centreX = (300 - view.transform.x) / view.transform.k;
    const centreY = (130 - view.transform.y) / view.transform.k;
    expect(centreY).toBeCloseTo(940, 0);
    // the window cannot go past the right edge of the diagram
    expect(centreX).toBeLessThanOrEqual(1500 - (300 - 10) / view.transform.k + 1);
  });
  it("zoom out to get a big focus in, but not below a floor", () => {
    const content = { width: 3000, height: 3000 };
    // a focus 1000 wide fits at (600 - 20) / 1040
    const fits = snapshotView(600, 260, content, { x: 0, y: 0, width: 1000, height: 100 })!;
    expect(fits.transform.k).toBeCloseTo(580 / 1040, 5);
    // a focus 2000 wide would need less than the floor
    const floor = snapshotView(600, 260, content, { x: 0, y: 0, width: 2000, height: 100 })!;
    expect(floor.transform.k).toBe(SNAPSHOT_MIN_ZOOM);
  });
  it("have nothing to show before they have a width", () => {
    expect(snapshotView(0, 260, { width: 100, height: 100 }, undefined)).toBeUndefined();
  });
});

describe("Save as HTML", () => {
  it("puts the edited explainer in the data, keeps the rest, and drops the server", () => {
    const bundle = makeBundle({ mode: "present", tour: "tour:demo", server: { api: "/api" } });
    const edited = structuredClone(bundle.explainer);
    edited.tours[0]!.steps[0]!.note = "### Edited </script> note";
    const text = withExplainer(serializeBundle(bundle), edited)!;
    expect(text).not.toContain("</script>");
    const saved = parseBundle(text);
    expect(saved.explainer.tours[0]!.steps[0]!.note).toBe("### Edited </script> note");
    expect(saved.files).toEqual(bundle.files);
    expect(saved.index).toEqual(bundle.index);
    expect(saved.mode).toBe("present");
    expect(saved.tour).toBe("tour:demo");
    expect(saved.server).toBeUndefined();
  });
  it("keeps the source a server page fetched since it opened, so the copy opens without the server", () => {
    const bundle = makeBundle({ server: { api: "/api" }, baseFiles: { "src/a.ts": "old a" } });
    const text = withExplainer(serializeBundle(bundle), bundle.explainer, {
      files: { "src/extra.ts": "fetched" },
      baseFiles: { "src/b.ts": "old b" },
    })!;
    const saved = parseBundle(text);
    expect(saved.files["src/extra.ts"]).toBe("fetched");
    expect(saved.files["src/a.ts"]).toBe(bundle.files["src/a.ts"]);
    expect(saved.baseFiles).toEqual({ "src/a.ts": "old a", "src/b.ts": "old b" });
    expect(saved.server).toBeUndefined();
  });
  it("says so when the data is not a bundle", () => {
    expect(withExplainer("{nope", makeBundle().explainer)).toBeUndefined();
  });
});
