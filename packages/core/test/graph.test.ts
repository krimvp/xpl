import { describe, expect, it } from "vitest";
import {
  collapse,
  defaultInclude,
  deriveGraph,
  derivedEdgeAnchors,
  drillChildren,
  drillIn,
  expandStub,
  ExplainerModel,
  MAX_DERIVED_ANCHORS,
  repr,
  type Explainer,
  type GraphView,
} from "../src/index.js";
import {
  anchor,
  edge,
  emptyExplainer,
  graphView,
  group,
  jobrunner,
  makeWorld,
  textWith,
  USER,
} from "./helpers.js";

const w = jobrunner();
const F = {
  runner: "file:src/runner.ts",
  queue: "file:src/queue.ts",
  worker: "file:src/worker.ts",
  metrics: "file:src/metrics.ts",
  sleep: "file:src/util/sleep.ts",
};
const S = {
  dispatch: "sym:src/runner.ts#Runner.dispatch",
  start: "sym:src/runner.ts#Runner.start",
  pop: "sym:src/queue.ts#Queue.pop",
  requeue: "sym:src/queue.ts#Queue.requeue",
};

function modelOf(over: Partial<Explainer> = {}, world = w): ExplainerModel {
  return new ExplainerModel(emptyExplainer(over), world.model);
}
function derive(
  include: string[],
  over: Partial<GraphView> = {},
  ex: Partial<Explainer> = {},
  world = w,
) {
  const view = graphView("view:v", include, over);
  const model = modelOf({ views: [view], ...ex }, world);
  return { view, model, graph: deriveGraph(view, model) };
}
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe("repr", () => {
  const m = modelOf({
    nodes: [
      group("grp:scheduling", [F.runner, F.queue]),
      group("grp:core", ["grp:scheduling", F.worker]),
      group("grp:sym", [S.pop]),
    ],
  });

  it("returns the nearest included element on the structural chain", () => {
    expect(repr("sym:src/queue.ts#Queue.pop", new Set([F.queue]), m)).toBe(F.queue);
    expect(
      repr("sym:src/queue.ts#Queue.pop", new Set([F.queue, "sym:src/queue.ts#Queue"]), m),
    ).toBe("sym:src/queue.ts#Queue");
    expect(repr("sym:src/queue.ts#Queue.pop", new Set([S.pop, F.queue]), m)).toBe(S.pop);
    expect(repr("sym:src/queue.ts#Queue.pop", new Set(["dir:src"]), m)).toBe("dir:src");
    expect(repr("sym:src/queue.ts#Queue.pop", new Set(["repo"]), m)).toBe("repo");
  });

  it("is undefined for elements outside the view", () => {
    expect(repr("sym:src/queue.ts#Queue.pop", new Set([F.runner]), m)).toBeUndefined();
    expect(repr("sym:src/queue.ts#Queue.pop", new Set(), m)).toBeUndefined();
    expect(repr("dir:src", new Set([F.runner]), m)).toBeUndefined(); // a container is not in its child
  });

  it("accepts an array as the include list", () => {
    expect(repr(F.queue, [F.queue], m)).toBe(F.queue);
  });

  it("uses an included group when an element on the chain is a member", () => {
    expect(repr(F.runner, new Set(["grp:scheduling"]), m)).toBe("grp:scheduling");
    expect(repr(S.dispatch, new Set(["grp:scheduling"]), m)).toBe("grp:scheduling");
    expect(repr(F.worker, new Set(["grp:scheduling"]), m)).toBeUndefined();
    expect(repr(S.pop, new Set(["grp:sym"]), m)).toBe("grp:sym");
  });

  it("prefers the element itself over a group, and the nearer level over a group above", () => {
    expect(repr(F.queue, new Set([F.queue, "grp:scheduling"]), m)).toBe(F.queue);
    // Queue.pop: the file is included and so is the group that contains the file -> the file wins
    expect(repr(S.pop, new Set([F.queue, "grp:scheduling"]), m)).toBe(F.queue);
    // ...but a group that contains the symbol itself is found first
    expect(repr(S.pop, new Set([F.queue, "grp:sym"]), m)).toBe("grp:sym");
  });

  it("follows nested groups", () => {
    expect(repr(F.queue, new Set(["grp:core"]), m)).toBe("grp:core");
    expect(repr(F.queue, new Set(["grp:core", "grp:scheduling"]), m)).toBe("grp:scheduling");
    expect(repr(F.worker, new Set(["grp:core"]), m)).toBe("grp:core");
  });

  it("picks the first included group by id when several contain the element", () => {
    const two = modelOf({ nodes: [group("grp:b", [F.queue]), group("grp:a", [F.queue])] });
    expect(repr(F.queue, new Set(["grp:a", "grp:b"]), two)).toBe("grp:a");
    expect(repr(F.queue, new Set(["grp:b"]), two)).toBe("grp:b");
  });
});

describe("deriveGraph: nodes", () => {
  it("lists included nodes with labels and kinds, sorted by id", () => {
    const { graph } = derive([F.worker, F.queue, S.dispatch]);
    expect(graph.nodes).toEqual([
      { id: F.queue, label: "queue.ts", kind: "file", container: false },
      { id: F.worker, label: "worker.ts", kind: "file", container: false },
      {
        id: S.dispatch,
        label: "Runner.dispatch",
        kind: "symbol",
        symbolKind: "method",
        container: false,
      },
    ]);
  });

  it("marks containers and gives every node its render parent", () => {
    const { graph } = derive([F.runner, S.dispatch, S.start, F.queue, "dir:src"]);
    const by = Object.fromEntries(graph.nodes.map((n) => [n.id, n]));
    expect(by[S.dispatch]).toMatchObject({ parent: F.runner, container: false });
    expect(by[S.start]).toMatchObject({ parent: F.runner });
    expect(by[F.runner]).toMatchObject({ parent: "dir:src", container: true });
    expect(by[F.queue]).toMatchObject({ parent: "dir:src" });
    expect(by["dir:src"]).toMatchObject({ container: true });
    expect(by["dir:src"]!.parent).toBeUndefined();
  });

  it("puts a node inside the nearest included ancestor, skipping levels that are not included", () => {
    const { graph } = derive(["dir:src", S.dispatch]);
    expect(graph.nodes.find((n) => n.id === S.dispatch)!.parent).toBe("dir:src");
  });

  it("checks groups at a node's own level before moving to its structural parent", () => {
    const g = group("grp:g", [F.queue]);
    const { graph } = derive(["dir:src", "grp:g", F.queue], {}, { nodes: [g] });
    const by = Object.fromEntries(graph.nodes.map((n) => [n.id, n]));
    expect(by[F.queue]!.parent).toBe("grp:g"); // not dir:src
    expect(by["grp:g"]).toMatchObject({ container: true, kind: "group" });
    expect(by["grp:g"]!.parent).toBeUndefined(); // stored parent is repo
    expect(by["dir:src"]!.container).toBe(false);
    const inSrc = derive(
      ["dir:src", "grp:g", F.queue],
      {},
      { nodes: [group("grp:g", [F.queue], { parent: "dir:src" })] },
    );
    const by2 = Object.fromEntries(inSrc.graph.nodes.map((n) => [n.id, n]));
    expect(by2["grp:g"]!.parent).toBe("dir:src");
    expect(by2["dir:src"]!.container).toBe(true);
  });

  it("nests groups", () => {
    const { graph } = derive(
      ["grp:core", "grp:scheduling", F.queue],
      {},
      {
        nodes: [
          group("grp:scheduling", [F.queue]),
          group("grp:core", ["grp:scheduling", F.worker]),
        ],
      },
    );
    const by = Object.fromEntries(graph.nodes.map((n) => [n.id, n]));
    expect(by[F.queue]!.parent).toBe("grp:scheduling");
    expect(by["grp:scheduling"]).toMatchObject({ parent: "grp:core", container: true });
    expect(by["grp:core"]).toMatchObject({ container: true });
  });

  it("breaks group cycles instead of looping", () => {
    const { graph } = derive(
      ["grp:a", "grp:b"],
      {},
      {
        nodes: [group("grp:a", ["grp:b"]), group("grp:b", ["grp:a"])],
      },
    );
    const parents = graph.nodes.map((n) => n.parent ?? null);
    expect(parents.filter((p) => p === null)).toHaveLength(1);
  });

  it("ignores include entries that do not exist and duplicates", () => {
    const { graph } = derive([
      "file:src/nope.ts",
      F.queue,
      F.queue,
      "concept:x",
      "sym:src/queue.ts#Nope",
    ]);
    expect(ids(graph.nodes)).toEqual([F.queue]);
  });

  it("has no nodes, edges or stubs for an empty include", () => {
    expect(derive([]).graph).toEqual({ nodes: [], edges: [], stubs: [] });
  });
});

describe("deriveGraph: derived edges", () => {
  const files = [F.runner, F.queue, F.worker, F.metrics, F.sleep];

  it("aggregates references per (kind, from, to) with count, resolution and anchors", () => {
    const { graph } = derive(files);
    const e = graph.edges.find((x) => x.id === `edge:calls:${F.runner}->${F.queue}`)!;
    expect(e).toMatchObject({
      from: F.runner,
      to: F.queue,
      kind: "calls",
      count: 4,
      resolution: "precise",
      stored: false,
    });
    expect(e.label).toBeUndefined();
    const sites = e.anchors.filter((a) => a.role === "call-site");
    expect(sites.map((a) => a.resolved!.range.startLine)).toEqual([46, 68, 76, 80]);
    expect(sites[2]).toMatchObject({
      file: "src/runner.ts",
      symbol: "Runner.dispatch",
      span: { from: 34, to: 36 },
      hash: "",
      resolved: { commit: "c1", range: { startLine: 76, endLine: 78 }, status: "ok" },
    });
    const defs = e.anchors.filter((a) => a.role === "definition");
    expect(defs.map((a) => a.symbol)).toEqual([
      "Queue.pop",
      "Queue.requeue",
      "Queue.ack",
      "Queue.deadLetter",
    ]);
    expect(defs[1]).toMatchObject({
      file: "src/queue.ts",
      hash: w.model.symbol("src/queue.ts#Queue.requeue")!.hash,
      resolved: { range: { startLine: 17, endLine: 30 }, status: "ok" },
    });
    expect(e.anchors).toHaveLength(8);
  });

  it("marks an edge heuristic unless a reference is precise", () => {
    const { graph } = derive(files);
    expect(graph.edges.find((x) => x.id === `edge:calls:${F.runner}->${F.sleep}`)!.resolution).toBe(
      "heuristic",
    );
    expect(graph.edges.find((x) => x.id === `edge:calls:${F.worker}->${F.sleep}`)!.resolution).toBe(
      "precise",
    );
  });

  it("uses the default kinds and skips edges inside a single node", () => {
    const { graph } = derive(files);
    expect(ids(graph.edges)).toEqual([
      `edge:calls:${F.runner}->${F.queue}`,
      `edge:calls:${F.runner}->${F.sleep}`,
      `edge:calls:${F.runner}->${F.worker}`,
      `edge:calls:${F.worker}->${F.sleep}`,
    ]);
    // dispatch -> backoffDelay and start -> dispatch stay inside file:src/runner.ts
  });

  it("maps reference kinds: call->calls, import->imports (module scope lifts to the file), type-ref->references", () => {
    const { graph } = derive(files, { edgeKinds: ["imports", "references"] });
    expect(ids(graph.edges)).toEqual([
      `edge:imports:${F.runner}->${F.queue}`,
      `edge:imports:${F.runner}->${F.worker}`,
      `edge:references:${F.metrics}->${F.queue}`,
    ]);
    const all = derive(files, {
      edgeKinds: ["calls", "imports", "references", "reads", "writes", "extends", "implements"],
    }).graph;
    expect(all.edges).toHaveLength(7);
  });

  it("lets opts.edgeKinds override the view's kinds", () => {
    const view = graphView("view:v", files, { edgeKinds: ["imports"] });
    const m = modelOf({ views: [view] });
    expect(ids(deriveGraph(view, m).edges)).toHaveLength(2);
    expect(ids(deriveGraph(view, m, { edgeKinds: ["references"] }).edges)).toEqual([
      `edge:references:${F.metrics}->${F.queue}`,
    ]);
    expect(deriveGraph(view, m, { edgeKinds: [] }).edges).toEqual([]);
  });

  it("lifts symbol references to whichever level the view shows", () => {
    const { graph } = derive([S.dispatch, S.pop, S.requeue, F.worker]);
    expect(ids(graph.edges)).toEqual([
      `edge:calls:${S.dispatch}->${F.worker}`,
      `edge:calls:${S.dispatch}->${S.pop}`,
      `edge:calls:${S.dispatch}->${S.requeue}`,
    ]);
    const requeue = graph.edges.find((e) => e.to === S.requeue)!;
    expect(requeue.count).toBe(1);
    expect(requeue.anchors.map((a) => a.role)).toEqual(["call-site", "definition"]);
  });

  it("draws an edge from a nested node to its container, and between containers", () => {
    const { graph } = derive([F.runner, S.dispatch, F.queue]);
    expect(graph.edges.map((e) => [e.from, e.to])).toContainEqual([S.dispatch, F.runner]); // -> backoffDelay
    expect(graph.edges.map((e) => [e.from, e.to])).toContainEqual([S.dispatch, F.queue]);
  });

  it("aggregates through a group, and skips edges internal to it", () => {
    const { graph } = derive(
      ["grp:scheduling", F.worker],
      {},
      {
        nodes: [group("grp:scheduling", [F.runner, F.queue])],
      },
    );
    expect(ids(graph.edges)).toEqual([`edge:calls:grp:scheduling->${F.worker}`]);
    expect(graph.edges[0]).toMatchObject({ count: 1 });
  });

  it("is deterministic: same graph whatever the order of refs and include", () => {
    const reversed = makeWorld({
      files: w.index.files.map((f) => ({
        path: f.path,
        text: w.texts[f.path]!,
        language: f.language,
      })),
      symbols: w.index.symbols.map((s) => ({
        id: s.id,
        kind: s.kind,
        start: s.range.startLine,
        end: s.range.endLine,
      })),
      refs: [...w.index.refs].reverse().map((r) => ({
        from: r.from,
        to: r.to,
        kind: r.kind,
        line: r.site.startLine,
        endLine: r.site.endLine,
        resolution: r.resolution,
      })),
    });
    const a = derive(files).graph;
    const b = derive([...files].reverse(), {}, {}, reversed).graph;
    expect(b).toEqual(a);
  });

  it("caps derived anchors at 50 sites and 50 definitions and counts every reference", () => {
    const n = 60;
    const big = makeWorld({
      files: [
        { path: "a.ts", text: textWith(400) },
        { path: "b.ts", text: textWith(400) },
      ],
      symbols: [
        { id: "a.ts#f", kind: "function", start: 1, end: 200 },
        ...Array.from({ length: n }, (_, i) => ({
          id: `b.ts#t${i}`,
          kind: "function" as const,
          start: 1 + i * 5,
          end: 5 + i * 5,
        })),
      ],
      refs: Array.from({ length: n }, (_, i) => ({
        from: "a.ts#f",
        to: `b.ts#t${i}`,
        line: 3 + i,
      })),
    });
    const view = graphView("view:v", ["file:a.ts", "file:b.ts"]);
    const graph = deriveGraph(
      view,
      new ExplainerModel(emptyExplainer({ views: [view] }), big.model),
    );
    const e = graph.edges[0]!;
    expect(e.count).toBe(60);
    expect(e.anchors.filter((a) => a.role === "call-site")).toHaveLength(MAX_DERIVED_ANCHORS);
    expect(e.anchors.filter((a) => a.role === "definition")).toHaveLength(MAX_DERIVED_ANCHORS);
    const lines = e.anchors
      .filter((a) => a.role === "call-site")
      .map((a) => a.resolved!.range.startLine);
    expect(lines[0]).toBe(3);
    expect(lines[49]).toBe(52);
  });

  it("derivedEdgeAnchors handles module-scope targets (whole file) and skips unknown ends", () => {
    const anchors = derivedEdgeAnchors(
      [
        ...w.index.refs.filter((r) => r.kind === "import" && r.to.endsWith("#Queue")),
        {
          from: "nowhere.ts#x",
          to: "src/queue.ts#",
          kind: "import",
          site: { startLine: 1, endLine: 1 },
          resolution: "precise",
        },
      ],
      w.model,
    );
    // site: the module-scope import in runner.ts (no symbol); definitions: the whole file, then Queue
    expect(anchors[0]).toMatchObject({
      file: "src/runner.ts",
      role: "usage",
      span: { from: 1, to: 1 },
    });
    expect(anchors[0]!.symbol).toBeUndefined();
    expect(anchors.map((a) => a.role)).toEqual(["usage", "definition", "definition"]);
    expect(anchors[1]).toMatchObject({
      file: "src/queue.ts",
      hash: w.model.file("src/queue.ts")!.hash,
      resolved: { range: { startLine: 1, endLine: 60 } },
    });
    expect(anchors[1]!.symbol).toBeUndefined();
    expect(anchors[2]).toMatchObject({ file: "src/queue.ts", symbol: "Queue" });
  });
});

describe("deriveGraph: stored edges", () => {
  const stored = edge("edge:job-completed", F.worker, F.metrics, [], {
    label: "job.completed",
    summary: "event bus",
  });

  it("shows stored edges whatever their kind, through repr", () => {
    const { graph } = derive([F.worker, F.metrics], {}, { edges: [stored] });
    expect(graph.edges).toEqual([
      {
        id: "edge:job-completed",
        from: F.worker,
        to: F.metrics,
        kind: "emits",
        label: "job.completed",
        summary: "event bus",
        count: 1,
        resolution: "llm",
        stored: true,
        anchors: [],
      },
    ]);
  });

  it("lifts stored edges to the represented ends and skips them when both ends coincide", () => {
    const g = group("grp:g", [F.worker, F.metrics]);
    expect(derive(["grp:g"], {}, { nodes: [g], edges: [stored] }).graph.edges).toEqual([]);
    const lifted = derive(
      ["grp:g", F.queue],
      {},
      {
        nodes: [g],
        edges: [edge("edge:x", F.worker, F.queue)],
      },
    ).graph;
    expect(lifted.edges[0]).toMatchObject({ from: "grp:g", to: F.queue });
  });

  it("reports resolution from the edge's provenance", () => {
    const { graph } = derive(
      [F.worker, F.metrics],
      {},
      {
        edges: [
          edge("edge:a", F.worker, F.metrics, [], { provenance: USER }),
          edge("edge:b", F.worker, F.metrics, [], { provenance: { origin: "static" } }),
        ],
      },
    );
    expect(graph.edges.map((e) => [e.id, e.resolution])).toEqual([
      ["edge:a", "user"],
      ["edge:b", "static"],
    ]);
  });

  it("produces stubs when one end is outside", () => {
    const { graph } = derive([F.worker], { edgeKinds: [] }, { edges: [stored] });
    expect(graph.edges).toEqual([]);
    expect(graph.stubs).toEqual([
      {
        id: `stub:out:${F.worker}->ghost:${F.metrics}`,
        direction: "out",
        inside: F.worker,
        ghost: F.metrics,
        ghostLabel: "metrics.ts",
        kinds: ["emits"],
        count: 1,
      },
    ]);
    const incoming = derive([F.metrics], { edgeKinds: [] }, { edges: [stored] }).graph.stubs;
    expect(incoming).toMatchObject([{ direction: "in", inside: F.metrics, ghost: F.worker }]);
  });

  it("skips stored edges whose ends do not exist", () => {
    const { graph } = derive(
      [F.worker],
      { edgeKinds: [] },
      { edges: [edge("edge:z", F.worker, "file:src/nope.ts")] },
    );
    expect(graph.edges).toEqual([]);
    expect(graph.stubs).toEqual([]);
  });

  it("overlays a stored edge on the derived edge with the same id (no duplicate)", () => {
    const id = `edge:calls:${F.runner}->${F.queue}`;
    const a = anchor(w, {
      file: "src/runner.ts",
      symbol: "Runner.dispatch",
      span: { from: 34, to: 36 },
      role: "call-site",
    });
    const overlay = edge(id, F.runner, F.queue, [a], {
      kind: "calls",
      label: "requeue with backoff",
      summary: "Failed jobs go back.",
    });
    const { graph } = derive([F.runner, F.queue], {}, { edges: [overlay] });
    const same = graph.edges.filter((e) => e.id === id);
    expect(same).toHaveLength(1);
    expect(same[0]).toMatchObject({
      label: "requeue with backoff",
      summary: "Failed jobs go back.",
      stored: true,
      count: 4,
      resolution: "precise",
      kind: "calls",
    });
    expect(same[0]!.anchors).toEqual([a]);
    // an overlay without anchors keeps the derived anchors, and an empty label is not a label
    const bare = derive(
      [F.runner, F.queue],
      {},
      { edges: [edge(id, F.runner, F.queue, [], { kind: "calls", label: "" })] },
    ).graph.edges.find((e) => e.id === id)!;
    expect(bare.anchors).toHaveLength(8);
    expect(bare.label).toBeUndefined();
    expect(bare.stored).toBe(true);
  });

  it("shows a stored edge with a derived-form id that no reference backs as its own edge", () => {
    const id = `edge:calls:${F.worker}->${F.metrics}`;
    const { graph } = derive(
      [F.worker, F.metrics],
      {},
      {
        edges: [edge(id, F.worker, F.metrics, [], { kind: "calls" })],
      },
    );
    expect(graph.edges).toMatchObject([{ id, count: 1, stored: true, resolution: "llm" }]);
  });
});

describe("deriveGraph: stubs and ghosts", () => {
  it("creates a stub for a reference that leaves the view, ghosting the highest ancestor without included nodes", () => {
    const { graph } = derive([F.runner, S.dispatch, S.start, F.queue]);
    expect(graph.stubs).toEqual([
      {
        id: `stub:out:${S.dispatch}->ghost:dir:src/util`,
        direction: "out",
        inside: S.dispatch,
        ghost: "dir:src/util", // sleep.ts is alone in src/util, which holds no included node
        ghostLabel: "util",
        kinds: ["calls"],
        count: 1,
      },
      {
        id: `stub:out:${S.dispatch}->ghost:${F.worker}`,
        direction: "out",
        inside: S.dispatch,
        ghost: F.worker, // dir:src holds included nodes, so the ghost is the file
        ghostLabel: "worker.ts",
        kinds: ["calls"],
        count: 1,
      },
    ]);
  });

  it("chooses the highest ancestor: a whole top-level directory can be a ghost", () => {
    const top = jobrunnerWithTopDir();
    const { graph } = derive(["file:core/queue.ts"], {}, {}, top);
    expect(graph.stubs).toEqual([
      {
        id: "stub:in:file:core/queue.ts->ghost:dir:app",
        direction: "in",
        inside: "file:core/queue.ts",
        ghost: "dir:app", // app/main.ts and app/more/other.ts both live under app/
        ghostLabel: "app",
        kinds: ["calls"],
        count: 2,
      },
    ]);
    // once something in app/ is in the view, the ghost narrows to what is still outside
    const narrower = derive(["file:core/queue.ts", "file:app/main.ts"], {}, {}, top).graph;
    expect(narrower.stubs.map((s) => s.ghost)).toEqual(["dir:app/more"]);
  });

  it("shows inbound stubs with their kinds", () => {
    const { graph } = derive([F.queue], { edgeKinds: ["calls", "imports", "references"] });
    expect(graph.stubs.map((s) => [s.direction, s.inside, s.ghost, s.kinds, s.count])).toEqual([
      ["in", F.queue, F.metrics, ["references"], 1],
      ["in", F.queue, F.runner, ["calls", "imports"], 5],
    ]);
  });

  it("aggregates stubs per (direction, inside, ghost) with kinds and counts", () => {
    const { graph } = derive([F.queue], { edgeKinds: ["calls", "imports", "references"] });
    const fromRunner = graph.stubs.find((s) => s.ghost === F.runner)!;
    expect(fromRunner.count).toBe(5); // 4 calls + 1 import
    expect(fromRunner.kinds).toEqual(["calls", "imports"]);
  });

  it("only makes stubs for the shown edge kinds", () => {
    expect(derive([F.queue]).graph.stubs.map((s) => s.kinds)).toEqual([["calls"]]);
    expect(
      derive([F.queue], { edgeKinds: ["imports"] }).graph.stubs.map((s) => [s.ghost, s.kinds]),
    ).toEqual([[F.runner, ["imports"]]]);
    expect(derive([F.queue], { edgeKinds: [] }).graph.stubs).toEqual([]);
  });

  it("uses the outside element itself when it contains an included node", () => {
    // included: sym:sleep only; module-scope style ref to a file that contains an included symbol
    const tiny = makeWorld({
      files: [
        { path: "a.ts", lines: 10 },
        { path: "b.ts", lines: 10 },
      ],
      symbols: [
        { id: "a.ts#f", kind: "function", start: 1, end: 5 },
        { id: "b.ts#g", kind: "function", start: 1, end: 5 },
      ],
      refs: [{ from: "a.ts#f", to: "b.ts#", kind: "import", line: 2 }],
    });
    const view = graphView("view:v", ["sym:a.ts#f", "sym:b.ts#g"], { edgeKinds: ["imports"] });
    const g = deriveGraph(view, new ExplainerModel(emptyExplainer({ views: [view] }), tiny.model));
    expect(g.stubs).toMatchObject([{ inside: "sym:a.ts#f", ghost: "file:b.ts", direction: "out" }]);
  });

  it("treats members of an included group as covered when choosing ghosts", () => {
    const { graph } = derive(["grp:g"], {}, { nodes: [group("grp:g", [F.runner])] });
    // dispatch -> worker/sleep/queue leave the group. dir:src contains group member runner.ts,
    // so the ghosts are the files (queue, worker) and dir:src/util.
    expect(graph.stubs.map((s) => s.ghost).sort()).toEqual(["dir:src/util", F.queue, F.worker]);
  });

  it("ghosts a stored group target as the group itself", () => {
    const { graph } = derive(
      [F.worker],
      {},
      {
        nodes: [group("grp:g", [F.metrics])],
        edges: [edge("edge:y", F.worker, "grp:g")],
      },
    );
    expect(graph.stubs.find((s) => s.ghost === "grp:g")).toMatchObject({
      direction: "out",
      inside: F.worker,
      ghostLabel: "g",
      kinds: ["emits"],
    });
  });

  it("orders stubs by id", () => {
    const { graph } = derive([S.dispatch]);
    expect(ids(graph.stubs)).toEqual([...ids(graph.stubs)].sort());
    expect(graph.stubs.length).toBeGreaterThan(2);
  });
});

describe("deriveGraph: hidden", () => {
  it("removes hidden nodes and the edges and stubs touching them, after derivation", () => {
    const base = derive([F.runner, F.queue, F.worker]).graph;
    expect(base.edges.map((e) => e.to)).toContain(F.worker);
    const { graph } = derive([F.runner, F.queue, F.worker], { hidden: [F.worker] });
    expect(ids(graph.nodes)).toEqual([F.queue, F.runner]);
    expect(graph.edges.map((e) => e.id)).toEqual([`edge:calls:${F.runner}->${F.queue}`]);
    // the edge to worker is not re-lifted anywhere, and no stub appears in its place
    expect(graph.stubs.map((s) => s.ghost)).toEqual(["dir:src/util"]);
    const hiddenInside = derive([F.runner, F.queue], { hidden: [F.runner] }).graph;
    expect(hiddenInside.stubs).toEqual([]);
    expect(hiddenInside.edges).toEqual([]);
  });

  it("removes hidden edge ids (derived and stored) and hidden stub / ghost ids", () => {
    const eid = `edge:calls:${F.runner}->${F.queue}`;
    const withEdge = derive([F.runner, F.queue, F.worker], { hidden: [eid] }).graph;
    expect(withEdge.edges.map((e) => e.id)).not.toContain(eid);
    expect(withEdge.edges).toHaveLength(1);
    const stored = derive(
      [F.worker, F.metrics],
      { hidden: ["edge:job-completed"] },
      {
        edges: [edge("edge:job-completed", F.worker, F.metrics)],
      },
    ).graph;
    expect(stored.edges).toEqual([]);
    const stubbed = derive([F.runner]);
    const stubIds = ids(stubbed.graph.stubs);
    const hideStub = derive([F.runner], { hidden: [stubIds[0]!] }).graph;
    expect(ids(hideStub.stubs)).toEqual(stubIds.slice(1));
    const hideGhost = derive([F.runner], { hidden: [`ghost:${F.worker}`] }).graph;
    expect(hideGhost.stubs.map((s) => s.ghost)).not.toContain(F.worker);
    const hideTarget = derive([F.runner], { hidden: [F.worker] }).graph;
    expect(hideTarget.stubs.map((s) => s.ghost)).not.toContain(F.worker);
  });

  it("moves the children of a hidden container up to the nearest visible container", () => {
    const { graph } = derive(["dir:src", F.runner, S.dispatch], { hidden: [F.runner] });
    const by = Object.fromEntries(graph.nodes.map((n) => [n.id, n]));
    expect(by[F.runner]).toBeUndefined();
    expect(by[S.dispatch]!.parent).toBe("dir:src");
    expect(by["dir:src"]!.container).toBe(true);
    const bothHidden = derive(["dir:src", F.runner, S.dispatch], {
      hidden: [F.runner, "dir:src"],
    }).graph;
    expect(bothHidden.nodes[0]).toMatchObject({ id: S.dispatch, container: false });
    expect(bothHidden.nodes[0]!.parent).toBeUndefined();
    const emptied = derive(["dir:src", F.runner], { hidden: [F.runner] }).graph;
    expect(emptied.nodes).toMatchObject([{ id: "dir:src", container: false }]);
  });

  it("ignores hidden ids that match nothing", () => {
    const a = derive([F.runner, F.queue]).graph;
    const b = derive([F.runner, F.queue], {
      hidden: ["file:src/nope.ts", "concept:x", "edge:zzz"],
    }).graph;
    expect(b).toEqual(a);
  });
});

describe("deriveGraph: excludeFiles", () => {
  // pkg/a.go (f) and pkg/a_test.go (t) both call lib/b.go (g); only the test calls lib/c.go (h) and
  // other/o.go (o); the production code calls lib/b.go only.
  const tiny = makeWorld({
    files: [
      { path: "pkg/a.go", lines: 20 },
      { path: "pkg/a_test.go", lines: 20 },
      { path: "lib/b.go", lines: 20 },
      { path: "lib/c.go", lines: 20 },
      { path: "other/o.go", lines: 20 },
    ],
    symbols: [
      { id: "pkg/a.go#f", kind: "function", start: 1, end: 9 },
      { id: "pkg/a_test.go#t", kind: "function", start: 1, end: 9 },
      { id: "lib/b.go#g", kind: "function", start: 1, end: 9 },
      { id: "lib/c.go#h", kind: "function", start: 1, end: 9 },
      { id: "other/o.go#o", kind: "function", start: 1, end: 9 },
    ],
    refs: [
      { from: "pkg/a.go#f", to: "lib/b.go#g", line: 3 },
      { from: "pkg/a_test.go#t", to: "lib/b.go#g", line: 4 },
      { from: "pkg/a_test.go#t", to: "lib/c.go#h", line: 5 },
      { from: "pkg/a_test.go#t", to: "other/o.go#o", line: 6 },
    ],
  });
  const TESTS = ["**/*_test.go"];
  const both = ["dir:pkg", "dir:lib"];

  it("ignores the references that start in an excluded file: edges through tests disappear, the rest is recounted", () => {
    const all = derive(both, {}, {}, tiny).graph;
    expect(all.edges.map((e) => [e.id, e.count])).toEqual([
      ["edge:calls:dir:pkg->dir:lib", 3], // f->g, t->g, t->h
    ]);
    const { graph } = derive(both, { excludeFiles: TESTS }, {}, tiny);
    expect(graph.edges.map((e) => [e.id, e.count])).toEqual([["edge:calls:dir:pkg->dir:lib", 1]]);
    // the sites and definitions of the dropped references are gone with them
    const edge = graph.edges[0]!;
    expect(edge.anchors.map((a) => [a.file, a.role])).toEqual([
      ["pkg/a.go", "call-site"],
      ["lib/b.go", "definition"],
    ]);
    // nodes are untouched
    expect(ids(graph.nodes)).toEqual(ids(all.nodes));
  });

  it("drops an edge that exists only through excluded files", () => {
    const lib = ["dir:lib", "dir:other"];
    const withTest = derive(["dir:pkg", ...lib], {}, {}, tiny).graph;
    expect(withTest.edges.map((e) => e.id)).toEqual([
      "edge:calls:dir:pkg->dir:lib",
      "edge:calls:dir:pkg->dir:other",
    ]);
    const { graph } = derive(["dir:pkg", ...lib], { excludeFiles: TESTS }, {}, tiny);
    expect(graph.edges.map((e) => e.id)).toEqual(["edge:calls:dir:pkg->dir:lib"]);
    expect(ids(graph.nodes)).toEqual(["dir:lib", "dir:other", "dir:pkg"]); // the box stays
  });

  it("filters stubs the same way: fewer references, or none at all", () => {
    const stubs = (include: string[], over: Partial<GraphView> = {}) =>
      derive(include, over, {}, tiny).graph.stubs.map((s) => [s.inside, s.ghost, s.count]);
    expect(stubs(["dir:lib"])).toEqual([["dir:lib", "dir:pkg", 3]]);
    expect(stubs(["dir:lib"], { excludeFiles: TESTS })).toEqual([["dir:lib", "dir:pkg", 1]]);
    // dir:other is reached only from the test: no stub is left
    expect(stubs(["dir:other"])).toEqual([["dir:other", "dir:pkg", 1]]);
    expect(stubs(["dir:other"], { excludeFiles: TESTS })).toEqual([]);
    // outgoing stubs too: pkg/a_test.go (named by the view, so it keeps its references) leads to two ghosts
    expect(stubs(["file:pkg/a_test.go"], { excludeFiles: TESTS })).toEqual([
      ["file:pkg/a_test.go", "dir:lib", 2],
      ["file:pkg/a_test.go", "dir:other", 1],
    ]);
    expect(stubs(["dir:pkg"], { excludeFiles: TESTS })).toEqual([["dir:pkg", "dir:lib", 1]]);
  });

  it("a reference is dropped when either end lies in an excluded file", () => {
    const view = { excludeFiles: ["lib/b.go"] };
    const { graph } = derive(both, view, {}, tiny);
    // f->g and t->g end in lib/b.go; t->h remains
    expect(graph.edges.map((e) => [e.id, e.count])).toEqual([["edge:calls:dir:pkg->dir:lib", 1]]);
    expect(graph.edges[0]!.anchors.map((a) => a.file)).toEqual(["pkg/a_test.go", "lib/c.go"]);
  });

  it("nodes and edges of files the view includes by name are kept, whatever excludeFiles says", () => {
    const named = derive([...both, "file:pkg/a_test.go"], { excludeFiles: TESTS }, {}, tiny).graph;
    expect(named.nodes.map((n) => n.id)).toContain("file:pkg/a_test.go");
    expect(named.edges.map((e) => [e.id, e.count])).toEqual([
      ["edge:calls:dir:pkg->dir:lib", 1],
      ["edge:calls:file:pkg/a_test.go->dir:lib", 2],
    ]);
    // a symbol of the file counts as naming it
    const bySymbol = derive([...both, "sym:pkg/a_test.go#t"], { excludeFiles: TESTS }, {}, tiny);
    expect(bySymbol.graph.edges.some((e) => e.from === "sym:pkg/a_test.go#t")).toBe(true);
    // and so do the members of an included group
    const inGroup = derive(
      [...both, "grp:tests"],
      { excludeFiles: TESTS },
      { nodes: [group("grp:tests", ["file:pkg/a_test.go"])] },
      tiny,
    ).graph;
    expect(inGroup.edges.some((e) => e.from === "grp:tests")).toBe(true);
  });

  it("a directory that is included does not count as naming the files below it", () => {
    const { graph } = derive(
      ["dir:pkg", "dir:lib", "dir:other"],
      { excludeFiles: TESTS },
      {},
      tiny,
    );
    expect(graph.edges.every((e) => e.from === "dir:pkg")).toBe(true);
    expect(graph.edges.map((e) => e.id)).toEqual(["edge:calls:dir:pkg->dir:lib"]);
  });

  it("does not touch stored edges, and an empty or missing list changes nothing", () => {
    const stored = edge("edge:x", "file:pkg/a_test.go", "file:lib/c.go");
    const ex = { edges: [stored] };
    const g = derive(
      ["file:pkg/a_test.go", "file:lib/c.go"],
      { excludeFiles: TESTS },
      ex,
      tiny,
    ).graph;
    expect(g.edges.map((e) => e.id)).toContain("edge:x");
    const plain = derive(both, {}, {}, tiny).graph;
    expect(derive(both, { excludeFiles: [] }, {}, tiny).graph).toEqual(plain);
    expect(derive(both, { excludeFiles: ["nothing/**"] }, {}, tiny).graph).toEqual(plain);
    expect(derive(both, { excludeFiles: [3 as never, ""] }, {}, tiny).graph).toEqual(plain);
  });

  it("uses the same glob rules everywhere: **, * and ?", () => {
    const edges = (patterns: string[]) =>
      derive(both, { excludeFiles: patterns }, {}, tiny).graph.edges.map((e) => e.count);
    expect(edges(["pkg/**"])).toEqual([]); // every reference starts in pkg/
    expect(edges(["pkg/a?test.go"])).toEqual([1]);
    expect(edges(["pkg/a?.go"])).toEqual([3]); // ? is exactly one character
    expect(edges(["**/a_test.go"])).toEqual([1]);
    expect(edges(["*_test.go"])).toEqual([1]); // no slash: matches the file name at any depth
    expect(edges(["pkg/*_test.go"])).toEqual([1]);
    expect(edges(["lib/*.go"])).toEqual([]); // every reference ends in lib/
  });

  it("keeps the viewer's derivation and the focus fallback consistent: sites of excluded files are not derived anchors", () => {
    const { graph } = derive(both, { excludeFiles: TESTS }, {}, tiny);
    expect(graph.edges[0]!.anchors.some((a) => a.file === "pkg/a_test.go")).toBe(false);
  });
});

describe("view edits", () => {
  const m = modelOf({ nodes: [group("grp:g", [F.runner, F.queue])] });

  it("expandStub adds the ghost target to include, without mutating the view", () => {
    const view = graphView("view:v", [F.runner]);
    const graph = deriveGraph(view, modelOf({ views: [view] }));
    const stub = graph.stubs.find((s) => s.ghost === F.worker)!;
    const next = expandStub(view, stub);
    expect(next.include).toEqual([F.runner, F.worker]);
    expect(view.include).toEqual([F.runner]);
    expect(next).not.toBe(view);
    expect(expandStub(next, stub)).toBe(next);
    const after = deriveGraph(next, modelOf({ views: [next] }));
    expect(after.stubs.map((s) => s.ghost)).not.toContain(F.worker);
    expect(after.edges.map((e) => e.to)).toContain(F.worker);
  });

  it("drillIn adds the children, making the node a container", () => {
    const view = graphView("view:v", [F.runner, F.queue]);
    const next = drillIn(view, F.runner, m);
    expect(next.include).toEqual([
      F.runner,
      F.queue,
      "sym:src/runner.ts#Runner",
      "sym:src/runner.ts#backoffDelay",
    ]);
    expect(view.include).toEqual([F.runner, F.queue]);
    const g = deriveGraph(next, modelOf({ views: [next] }));
    expect(g.nodes.find((n) => n.id === F.runner)!.container).toBe(true);
    expect(g.nodes.find((n) => n.id === "sym:src/runner.ts#Runner")!.parent).toBe(F.runner);
  });

  it("drillIn opens a group into its members, includes the node itself when missing, and no-ops sensibly", () => {
    const view = graphView("view:v", ["grp:g"]);
    expect(drillIn(view, "grp:g", m).include).toEqual(["grp:g", F.runner, F.queue]);
    expect(drillIn(graphView("view:v", []), F.queue, m).include).toEqual([
      F.queue,
      ...m.children(F.queue),
    ]);
    const leaf = graphView("view:v", [S.pop]);
    expect(drillIn(leaf, S.pop, m)).toBe(leaf);
    expect(drillIn(leaf, "file:src/nope.ts", m)).toBe(leaf);
    const full = drillIn(view, "grp:g", m);
    expect(drillIn(full, "grp:g", m)).toBe(full);
    expect(drillChildren(m, "grp:g")).toEqual([F.runner, F.queue]);
    expect(drillChildren(m, F.queue)).toEqual(m.children(F.queue));
  });

  it("collapse removes the included descendants", () => {
    const view = graphView("view:v", [
      "dir:src",
      F.runner,
      S.dispatch,
      F.queue,
      F.worker,
      "dir:test",
    ]);
    const next = collapse(view, F.runner, m);
    expect(next.include).toEqual(["dir:src", F.runner, F.queue, F.worker, "dir:test"]);
    expect(collapse(view, "dir:src", m).include).toEqual(["dir:src", "dir:test"]);
    expect(collapse(view, "repo", m).include).toEqual([]);
    expect(collapse(view, F.worker, m)).toBe(view);
    expect(view.include).toHaveLength(6);
  });

  it("collapse on a group removes its members' subtrees", () => {
    const view = graphView("view:v", ["grp:g", F.runner, S.dispatch, F.worker]);
    expect(collapse(view, "grp:g", m).include).toEqual(["grp:g", F.worker]);
  });

  it("drillIn then collapse round-trips", () => {
    const view = graphView("view:v", [F.runner]);
    const there = drillIn(view, F.runner, m);
    expect(collapse(there, F.runner, m).include).toEqual([F.runner]);
  });
});

describe("defaultInclude", () => {
  const m = modelOf({ nodes: [group("grp:g", [F.runner, F.queue])] });

  it("depth 1 of the repo: the top-level directories and files", () => {
    expect(defaultInclude({ root: "repo", depth: 1 }, m)).toEqual([
      "dir:config",
      "dir:src",
      "dir:test",
    ]);
  });

  it("depth d: nodes exactly d levels down, plus shallower leaves", () => {
    expect(defaultInclude({ root: "repo", depth: 2 }, m)).toEqual([
      "file:config/default.yaml",
      "dir:src/util",
      F.metrics,
      F.queue,
      F.runner,
      F.worker,
      "file:test/retry.test.ts",
    ]);
    const d3 = defaultInclude({ root: "repo", depth: 3 }, m);
    expect(d3).toContain(F.sleep); // src/util/sleep.ts is exactly 3 levels down
    expect(d3).toContain("sym:src/queue.ts#Queue"); // symbols of files at level 2
    expect(d3).toContain("file:test/retry.test.ts"); // a shallower leaf: a file without symbols
    expect(d3).not.toContain(F.queue);
    expect(d3).not.toContain("dir:src/util");
  });

  it("works from any root and for groups", () => {
    expect(defaultInclude({ root: "dir:src/util", depth: 1 }, m)).toEqual([F.sleep]);
    expect(defaultInclude({ root: F.runner, depth: 1 }, m)).toEqual([
      "sym:src/runner.ts#Runner",
      "sym:src/runner.ts#backoffDelay",
    ]);
    expect(defaultInclude({ root: F.runner, depth: 2 }, m)).toEqual([
      "sym:src/runner.ts#backoffDelay", // a leaf above depth 2 comes first (breadth first)
      "sym:src/runner.ts#Runner.start",
      "sym:src/runner.ts#Runner.stop",
      "sym:src/runner.ts#Runner.dispatch",
      "sym:src/runner.ts#Runner.log",
    ]);
    expect(defaultInclude({ root: "grp:g", depth: 1 }, m)).toEqual([F.runner, F.queue]);
  });

  it("handles depth 0, leaves and unknown roots", () => {
    expect(defaultInclude({ root: "repo", depth: 0 }, m)).toEqual(["repo"]);
    expect(defaultInclude({ root: S.pop, depth: 1 }, m)).toEqual([S.pop]);
    expect(defaultInclude({ root: "dir:nope", depth: 1 }, m)).toEqual([]);
  });

  it("gives a derivable view", () => {
    const include = defaultInclude({ root: "repo", depth: 2 }, m);
    const { graph } = derive(include);
    expect(graph.nodes).toHaveLength(include.length);
    expect(graph.edges.length).toBeGreaterThan(0);
  });
});

function jobrunnerWithTopDir() {
  // `Queue` lives under a top-level directory the view does not include: its ghost is the directory.
  return makeWorld({
    files: [
      { path: "core/queue.ts", lines: 10 },
      { path: "app/main.ts", lines: 10 },
      { path: "app/more/other.ts", lines: 10 },
    ],
    symbols: [
      { id: "core/queue.ts#Queue", kind: "class", start: 1, end: 9 },
      { id: "app/main.ts#main", kind: "function", start: 1, end: 9 },
      { id: "app/more/other.ts#other", kind: "function", start: 1, end: 9 },
    ],
    refs: [
      { from: "app/main.ts#main", to: "core/queue.ts#Queue", line: 3 },
      { from: "app/more/other.ts#other", to: "core/queue.ts#Queue", line: 3 },
    ],
  });
}
