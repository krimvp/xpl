import { describe, expect, it } from "vitest";
import {
  buildReverseIndex,
  codeFocus,
  deriveGraph,
  derivedEdgeMap,
  ExplainerModel,
  MAX_DIR_FOCUS_FILES,
  mergeFocusByFile,
  viewCandidates,
  type Anchor,
  type Explainer,
  type FocusRange,
} from "../src/index.js";
import {
  anchor,
  concept,
  edge,
  emptyExplainer,
  graphView,
  group,
  jobrunner,
  makeWorld,
  sequenceView,
  textWith,
} from "./helpers.js";

const w = jobrunner();
const F = {
  runner: "file:src/runner.ts",
  queue: "file:src/queue.ts",
  worker: "file:src/worker.ts",
};
const S = {
  dispatch: "sym:src/runner.ts#Runner.dispatch",
  requeue: "sym:src/queue.ts#Queue.requeue",
  pop: "sym:src/queue.ts#Queue.pop",
};

const callSite = anchor(w, {
  file: "src/runner.ts",
  symbol: "Runner.dispatch",
  span: { from: 34, to: 36 },
  role: "call-site",
});
const requeueDef = anchor(w, { file: "src/queue.ts", symbol: "Queue.requeue", role: "definition" });

function model(over: Partial<Explainer> = {}, world = w): ExplainerModel {
  return new ExplainerModel(emptyExplainer(over), world.model);
}
const brief = (ranges: FocusRange[]) =>
  ranges.map((r) => `${r.file}:${r.range.startLine}-${r.range.endLine}:${r.role}:${r.elementId}`);

describe("codeFocus: anchors", () => {
  const m = model({
    concepts: [concept("concept:retry", [callSite, requeueDef]), concept("concept:empty")],
    views: [
      sequenceView(
        "view:d",
        [S.dispatch, F.queue],
        [
          {
            id: "d:1",
            from: S.dispatch,
            to: F.queue,
            label: "requeue",
            kind: "call",
            anchors: [callSite, requeueDef],
          },
        ],
      ),
    ],
  });

  it("is the union of the element's resolved anchors, with role, element and status", () => {
    expect(codeFocus(["concept:retry"], m)).toEqual([
      {
        file: "src/runner.ts",
        range: { startLine: 76, endLine: 78 },
        role: "call-site",
        elementId: "concept:retry",
        status: "ok",
      },
      {
        file: "src/queue.ts",
        range: { startLine: 17, endLine: 30 },
        role: "definition",
        elementId: "concept:retry",
        status: "ok",
      },
    ]);
  });

  it("works for sequence steps and keeps the order of ids", () => {
    expect(brief(codeFocus(["d:1", "concept:retry"], m))).toEqual([
      "src/runner.ts:76-78:call-site:d:1",
      "src/queue.ts:17-30:definition:d:1",
      "src/runner.ts:76-78:call-site:concept:retry",
      "src/queue.ts:17-30:definition:concept:retry",
    ]);
  });

  it("has no focus for a concept without anchors, unknown ids and render-only ids", () => {
    expect(
      codeFocus(
        [
          "concept:empty",
          "concept:nope",
          "ghost:file:src/queue.ts",
          "stub:in:a->ghost:b",
          "nonsense",
        ],
        m,
      ),
    ).toEqual([]);
  });

  it("lists an element once even if its id is repeated", () => {
    expect(codeFocus(["concept:retry", "concept:retry"], m)).toHaveLength(2);
  });

  it("passes anchor statuses through and excludes missing anchors", () => {
    const moved: Anchor = { ...callSite, resolved: { ...callSite.resolved!, status: "moved" } };
    const drifted: Anchor = {
      ...requeueDef,
      resolved: { ...requeueDef.resolved!, status: "drifted" },
    };
    const missing: Anchor = {
      ...requeueDef,
      symbol: "Gone",
      resolved: { commit: "c0", range: { startLine: 3, endLine: 4 }, status: "missing" },
    };
    const mm = model({ concepts: [concept("concept:c", [moved, drifted, missing])] });
    expect(codeFocus(["concept:c"], mm).map((r) => r.status)).toEqual(["moved", "drifted"]);
  });

  it("computes a range for anchors that were never resolved, from the index", () => {
    const { resolved: _a, ...bareSpan } = callSite;
    const { resolved: _b, ...bareDef } = requeueDef;
    const bareFile: Anchor = { file: "src/worker.ts", role: "config", hash: "sha256:x" };
    const bareGone: Anchor = { file: "src/gone.ts", role: "config", hash: "sha256:x" };
    const bareNoSym: Anchor = {
      file: "src/queue.ts",
      symbol: "Nope",
      role: "config",
      hash: "sha256:x",
    };
    const fileSpan: Anchor = {
      file: "src/worker.ts",
      span: { from: 2, to: 4 },
      role: "usage",
      hash: "sha256:x",
    };
    const mm = model({
      concepts: [
        concept("concept:c", [bareSpan, bareDef, bareFile, bareGone, bareNoSym, fileSpan]),
      ],
    });
    expect(brief(codeFocus(["concept:c"], mm))).toEqual([
      "src/runner.ts:76-78:call-site:concept:c",
      "src/queue.ts:17-30:definition:concept:c",
      "src/worker.ts:1-40:config:concept:c",
      "src/worker.ts:3-5:usage:concept:c",
    ]);
  });

  it("keeps columns of ranges that carry them", () => {
    const a: Anchor = {
      file: "src/runner.ts",
      role: "call-site",
      hash: "",
      resolved: {
        commit: "c1",
        range: { startLine: 46, endLine: 46, startCol: 7, endCol: 30 },
        status: "ok",
      },
    };
    const r = codeFocus(["concept:c"], model({ concepts: [concept("concept:c", [a])] }));
    expect(r[0]!.range).toEqual({ startLine: 46, endLine: 46, startCol: 7, endCol: 30 });
  });
});

describe("codeFocus: structural fallbacks", () => {
  const m = model({
    nodes: [
      group("grp:g", [F.runner, S.requeue]),
      group("grp:outer", ["grp:g", F.worker]),
      group("grp:anchored", [F.queue], { anchors: [callSite] }),
      {
        id: F.worker,
        kind: "file",
        parent: "dir:src",
        label: "W",
        anchors: [callSite],
        provenance: { origin: "llm" },
      },
    ],
  });

  it("symbol -> its range", () => {
    expect(codeFocus([S.requeue], m)).toEqual([
      {
        file: "src/queue.ts",
        range: { startLine: 17, endLine: 30 },
        role: "definition",
        elementId: S.requeue,
        status: "ok",
      },
    ]);
  });

  it("file -> the whole file", () => {
    expect(brief(codeFocus([F.queue], m))).toEqual([
      "src/queue.ts:1-60:definition:file:src/queue.ts",
    ]);
  });

  it("dir and repo -> their files, capped", () => {
    expect(brief(codeFocus(["dir:src/util"], m))).toEqual([
      "src/util/sleep.ts:1-5:definition:dir:src/util",
    ]);
    expect(codeFocus(["dir:src"], m).map((r) => r.file)).toEqual([
      "src/metrics.ts",
      "src/queue.ts",
      "src/runner.ts",
      "src/util/sleep.ts",
      "src/worker.ts",
    ]);
    expect(codeFocus(["repo"], m)).toHaveLength(7);
    const many = makeWorld({
      files: Array.from({ length: 60 }, (_, i) => ({
        path: `lib/f${String(i).padStart(2, "0")}.ts`,
        lines: 3,
      })),
    });
    const r = codeFocus(["dir:lib"], model({}, many));
    expect(r).toHaveLength(MAX_DIR_FOCUS_FILES);
    expect(r[0]!.file).toBe("lib/f00.ts");
  });

  it("group -> its members' focus, attributed to the group", () => {
    expect(brief(codeFocus(["grp:g"], m))).toEqual([
      "src/runner.ts:1-100:definition:grp:g",
      "src/queue.ts:17-30:definition:grp:g",
    ]);
  });

  it("nested groups recurse; a member's own anchors win over its fallback", () => {
    expect(brief(codeFocus(["grp:outer"], m))).toEqual([
      "src/runner.ts:1-100:definition:grp:outer",
      "src/queue.ts:17-30:definition:grp:outer",
      "src/runner.ts:76-78:call-site:grp:outer", // file:src/worker.ts has a stored overlay with an anchor
    ]);
  });

  it("a group with anchors uses them, not its members", () => {
    expect(brief(codeFocus(["grp:anchored"], m))).toEqual([
      "src/runner.ts:76-78:call-site:grp:anchored",
    ]);
  });

  it("survives group cycles", () => {
    const cyc = model({ nodes: [group("grp:a", ["grp:b", F.queue]), group("grp:b", ["grp:a"])] });
    expect(brief(codeFocus(["grp:a"], cyc))).toEqual(["src/queue.ts:1-60:definition:grp:a"]);
  });

  it("falls back when a node's only anchors are missing", () => {
    const missing: Anchor = {
      ...requeueDef,
      symbol: "Gone",
      resolved: { commit: "c0", range: { startLine: 3, endLine: 4 }, status: "missing" },
    };
    const mm = model({
      nodes: [
        {
          id: F.queue,
          kind: "file",
          parent: "dir:src",
          label: "Q",
          anchors: [missing],
          provenance: { origin: "llm" },
        },
      ],
    });
    expect(brief(codeFocus([F.queue], mm))).toEqual([
      "src/queue.ts:1-60:definition:file:src/queue.ts",
    ]);
  });

  it("uses a stored overlay's anchors instead of the fallback", () => {
    expect(brief(codeFocus([F.worker], m))).toEqual([
      "src/runner.ts:76-78:call-site:file:src/worker.ts",
    ]);
  });
});

describe("codeFocus: edges", () => {
  const files = `edge:calls:${F.runner}->${F.queue}`;
  const single = `edge:calls:${S.dispatch}->${S.requeue}`;

  it("computes a derived edge from the references between the two subtrees", () => {
    const m = model({ nodes: [group("grp:sched", [F.runner])] });
    expect(brief(codeFocus([files], m))).toEqual([
      `src/runner.ts:46-46:call-site:${files}`,
      `src/runner.ts:68-68:call-site:${files}`,
      `src/runner.ts:76-78:call-site:${files}`,
      `src/runner.ts:80-80:call-site:${files}`,
      `src/queue.ts:5-15:definition:${files}`,
      `src/queue.ts:17-30:definition:${files}`,
      `src/queue.ts:32-40:definition:${files}`,
      `src/queue.ts:42-55:definition:${files}`,
    ]);
    expect(brief(codeFocus([single], m))).toEqual([
      `src/runner.ts:76-78:call-site:${single}`,
      `src/queue.ts:17-30:definition:${single}`,
    ]);
    // group endpoints: the subtrees of the members
    const viaGroup = `edge:calls:grp:sched->${F.worker}`;
    expect(brief(codeFocus([viaGroup], m))).toEqual([
      `src/runner.ts:60-61:call-site:${viaGroup}`,
      `src/worker.ts:5-36:definition:${viaGroup}`,
    ]);
  });

  it("uses the derived edges of the view when given", () => {
    const view = graphView("view:v", [F.runner, F.queue]);
    const m = model({ views: [view] });
    const graph = deriveGraph(view, m);
    const map = derivedEdgeMap(graph);
    expect(map.size).toBe(graph.edges.length);
    const viaMap = codeFocus([files], m, { derivedEdges: map });
    expect(viaMap).toEqual(codeFocus([files], m));
    // a map entry wins over recomputation
    const fake = new Map([[files, { ...map.get(files)!, anchors: [callSite] }]]);
    expect(brief(codeFocus([files], m, { derivedEdges: fake }))).toEqual([
      `src/runner.ts:76-78:call-site:${files}`,
    ]);
  });

  it("has no focus for a derived edge nothing backs, or of a kind without references", () => {
    const m = model();
    expect(codeFocus([`edge:calls:${F.queue}->${F.runner}`], m)).toEqual([]);
    expect(codeFocus([`edge:calls:${F.runner}->file:src/nope.ts`], m)).toEqual([]);
    expect(codeFocus([`edge:imports:${F.worker}->${F.queue}`], m)).toEqual([]);
  });

  it("uses the anchors of a stored edge, and derives a bare overlay on a derived id", () => {
    const stored = edge("edge:job-completed", F.worker, F.queue, [callSite, requeueDef]);
    const bareOverlay = edge(single, S.dispatch, S.requeue, [], { kind: "calls" });
    const bareStored = edge("edge:bare", F.worker, F.queue);
    const m = model({ edges: [stored, bareOverlay, bareStored] });
    expect(brief(codeFocus(["edge:job-completed"], m))).toEqual([
      "src/runner.ts:76-78:call-site:edge:job-completed",
      "src/queue.ts:17-30:definition:edge:job-completed",
    ]);
    expect(brief(codeFocus([single], m))).toEqual([
      `src/runner.ts:76-78:call-site:${single}`,
      `src/queue.ts:17-30:definition:${single}`,
    ]);
    expect(codeFocus(["edge:bare"], m)).toEqual([]);
  });
});

describe("mergeFocusByFile", () => {
  const r = (
    file: string,
    s: number,
    e: number,
    role: FocusRange["role"] = "definition",
    el = "x",
  ): FocusRange => ({
    file,
    range: { startLine: s, endLine: e },
    role,
    elementId: el,
    status: "ok",
  });

  it("groups by file in order of first appearance and sorts the ranges", () => {
    const out = mergeFocusByFile([r("b.ts", 20, 25), r("a.ts", 5, 6), r("b.ts", 1, 3)]);
    expect(out.map((f) => f.file)).toEqual(["b.ts", "a.ts"]);
    expect(out[0]!.ranges.map((x) => [x.range.startLine, x.range.endLine])).toEqual([
      [1, 3],
      [20, 25],
    ]);
  });

  it("merges overlapping ranges, keeping every role and element", () => {
    const [file] = mergeFocusByFile([
      r("a.ts", 42, 88, "definition", "A"),
      r("a.ts", 76, 78, "call-site", "B"),
      r("a.ts", 80, 90, "usage", "A"),
      r("a.ts", 100, 101, "test", "C"),
    ]);
    expect(file!.ranges).toHaveLength(2);
    expect(file!.ranges[0]).toMatchObject({
      range: { startLine: 42, endLine: 90 },
      roles: ["definition", "call-site", "usage"],
      elementIds: ["A", "B"],
    });
    expect(file!.ranges[0]!.sources.map((s) => [s.range.startLine, s.role])).toEqual([
      [42, "definition"],
      [76, "call-site"],
      [80, "usage"],
    ]);
    expect(file!.ranges[1]).toMatchObject({
      range: { startLine: 100, endLine: 101 },
      roles: ["test"],
    });
  });

  it("merges ranges that share a line but not merely adjacent ones", () => {
    const [file] = mergeFocusByFile([r("a.ts", 1, 3), r("a.ts", 3, 5), r("a.ts", 6, 8)]);
    expect(file!.ranges.map((x) => [x.range.startLine, x.range.endLine])).toEqual([
      [1, 5],
      [6, 8],
    ]);
  });

  it("returns whole-line ranges and does not mutate its input", () => {
    const input = [
      { ...r("a.ts", 1, 3), range: { startLine: 1, endLine: 3, startCol: 2, endCol: 4 } },
      r("a.ts", 2, 9),
    ];
    const copy = JSON.stringify(input);
    const [file] = mergeFocusByFile(input);
    expect(file!.ranges[0]!.range).toEqual({ startLine: 1, endLine: 9 });
    expect(JSON.stringify(input)).toBe(copy);
    expect(mergeFocusByFile([])).toEqual([]);
  });
});

describe("buildReverseIndex", () => {
  const anchorAt = (span: [number, number]) =>
    anchor(w, {
      file: "src/runner.ts",
      symbol: "Runner.dispatch",
      span: { from: span[0], to: span[1] },
      role: "usage",
    });

  it("returns the element with the smallest span (innermost wins)", () => {
    const m = model({
      concepts: [
        concept("concept:outer", [anchorAt([0, 40])]), // lines 42-82
        concept("concept:inner", [anchorAt([30, 41])]), // lines 72-83
        concept("concept:tiny", [anchorAt([34, 36])]), // lines 76-78
      ],
    });
    const idx = buildReverseIndex(["concept:outer", "concept:inner", "concept:tiny"], m);
    expect(idx.lookup("src/runner.ts", 77)).toEqual(["concept:tiny"]);
    expect(idx.lookup("src/runner.ts", 73)).toEqual(["concept:inner"]);
    expect(idx.lookup("src/runner.ts", 82)).toEqual(["concept:inner"]);
    expect(idx.lookup("src/runner.ts", 84)).toEqual([]);
    expect(idx.lookup("src/runner.ts", 45)).toEqual(["concept:outer"]);
    expect(idx.lookup("src/runner.ts", 41)).toEqual([]);
    expect(idx.lookup("src/other.ts", 77)).toEqual([]);
  });

  it("returns every element on a tie, in id order whatever the candidate order", () => {
    const m = model({
      concepts: [
        concept("concept:b", [anchorAt([34, 36])]),
        concept("concept:a", [anchorAt([34, 36])]),
        concept("concept:c", [anchorAt([10, 44])]),
      ],
    });
    const forward = buildReverseIndex(["concept:b", "concept:a", "concept:c"], m).lookup(
      "src/runner.ts",
      77,
    );
    const backward = buildReverseIndex(["concept:c", "concept:a", "concept:b"], m).lookup(
      "src/runner.ts",
      77,
    );
    expect(forward).toEqual(["concept:a", "concept:b"]);
    expect(backward).toEqual(forward);
  });

  it("counts an element with several ranges around a line by its smallest one", () => {
    const m = model({
      concepts: [
        concept("concept:many", [anchorAt([0, 46]), anchorAt([34, 36])]),
        concept("concept:mid", [anchorAt([30, 41])]),
      ],
    });
    const idx = buildReverseIndex(["concept:many", "concept:mid"], m);
    expect(idx.lookup("src/runner.ts", 77)).toEqual(["concept:many"]); // its 3-line range beats mid's 12
    expect(idx.lookup("src/runner.ts", 73)).toEqual(["concept:mid"]); // many only has the 47-line range there
  });

  it("uses structural fallbacks: a symbol beats its file", () => {
    const m = model();
    const idx = buildReverseIndex([F.runner, S.dispatch, "sym:src/runner.ts#Runner"], m);
    expect(idx.lookup("src/runner.ts", 50)).toEqual([S.dispatch]);
    expect(idx.lookup("src/runner.ts", 15)).toEqual(["sym:src/runner.ts#Runner"]);
    expect(idx.lookup("src/runner.ts", 5)).toEqual([F.runner]);
  });

  it("includes drifted ranges and excludes missing ones", () => {
    const drifted: Anchor = { ...callSite, resolved: { ...callSite.resolved!, status: "drifted" } };
    const missing: Anchor = {
      ...callSite,
      symbol: "Gone",
      resolved: { commit: "c0", range: { startLine: 76, endLine: 78 }, status: "missing" },
    };
    const m = model({
      concepts: [concept("concept:d", [drifted]), concept("concept:m", [missing])],
    });
    const idx = buildReverseIndex(["concept:d", "concept:m"], m);
    expect(idx.lookup("src/runner.ts", 77)).toEqual(["concept:d"]);
  });

  it("passes derivedEdges through to the focus of derived-edge candidates", () => {
    const view = graphView("view:v", [F.runner, F.queue]);
    const m = model({ views: [view] });
    const graph = deriveGraph(view, m);
    const cands = viewCandidates(view, m, graph);
    const idx = buildReverseIndex(cands, m, { derivedEdges: derivedEdgeMap(graph) });
    // line 77 is inside the requeue call site (3 lines) of the runner->queue edge; the file nodes are bigger
    expect(idx.lookup("src/runner.ts", 77)).toEqual([`edge:calls:${F.runner}->${F.queue}`]);
    expect(idx.lookup("src/queue.ts", 20)).toEqual([`edge:calls:${F.runner}->${F.queue}`]); // requeue definition, 14 lines
    expect(idx.lookup("src/queue.ts", 58)).toEqual([F.queue]);
  });
});

describe("viewCandidates", () => {
  const m = model({
    concepts: [concept("concept:b"), concept("concept:a")],
    edges: [edge("edge:e", F.worker, F.queue)],
  });

  it("graph views: included nodes, shown edges, concepts", () => {
    const view = graphView("view:v", [F.runner, F.queue, F.worker]);
    const graph = deriveGraph(
      view,
      model({ concepts: m.concepts as never, edges: m.storedEdges as never, views: [view] }),
    );
    const cands = viewCandidates(
      view,
      model({ concepts: m.concepts as never, edges: m.storedEdges as never, views: [view] }),
    );
    expect(cands.slice(0, 3)).toEqual([F.queue, F.runner, F.worker]);
    expect(cands).toContain("edge:e");
    expect(cands).toContain(`edge:calls:${F.runner}->${F.queue}`);
    expect(cands.slice(-2)).toEqual(["concept:a", "concept:b"]);
    // a precomputed graph is reused
    expect(viewCandidates(view, m, graph)).toEqual([
      ...graph.nodes.map((n) => n.id),
      ...graph.edges.map((e) => e.id),
      "concept:a",
      "concept:b",
    ]);
  });

  it("sequence views: participants, steps, concepts", () => {
    const view = sequenceView(
      "view:s",
      [S.dispatch, F.queue],
      [
        { id: "s:1", from: S.dispatch, to: F.queue, label: "a", kind: "call", anchors: [] },
        { id: "s:2", from: F.queue, to: S.dispatch, label: "b", kind: "return", anchors: [] },
      ],
    );
    expect(viewCandidates(view, m)).toEqual([
      S.dispatch,
      F.queue,
      "s:1",
      "s:2",
      "concept:a",
      "concept:b",
    ]);
  });

  it("does not repeat ids", () => {
    const view = sequenceView("view:s", [S.dispatch, S.dispatch], []);
    expect(viewCandidates(view, m)).toEqual([S.dispatch, "concept:a", "concept:b"]);
  });
});

describe("focus text helper", () => {
  it("textWith fills unspecified lines", () => {
    expect(textWith(3, { 2: "x" })).toBe("// 1\nx\n// 3");
  });
});
