import { describe, expect, it } from "vitest";
import {
  codeFocus,
  deriveGraph,
  ExplainerModel,
  IndexModel,
  pruneIndex,
  type Explainer,
  type SymbolIndex,
} from "../src/index.js";
import { expectSameViewer } from "./prune-equivalence.js";
import { syntheticRepo } from "./prune-repo.js";
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
  type WorldDecl,
} from "./helpers.js";

const w = jobrunner();
const ids = (list: readonly { id: string }[]) => list.map((entry) => entry.id).sort();
const refKeys = (index: SymbolIndex) =>
  index.refs.map((ref) => `${ref.kind} ${ref.from} -> ${ref.to}`).sort();

/** A small world for the rules: two embedded-or-not files, with a class chain and one of every kind. */
const SMALL: WorldDecl = {
  files: [
    { path: "a.ts", lines: 60 },
    { path: "b.ts", lines: 60 },
    { path: "c.ts", lines: 60 },
    { path: "d.ts", lines: 60 },
  ],
  symbols: [
    { id: "a.ts#A", kind: "class", start: 1, end: 30 },
    { id: "a.ts#A.run", start: 3, end: 10 },
    { id: "a.ts#A.Inner", kind: "class", start: 12, end: 28 },
    { id: "a.ts#A.Inner.deep", start: 14, end: 20 },
    { id: "a.ts#lonely", kind: "function", start: 35, end: 40 },
    { id: "b.ts#B", kind: "class", start: 1, end: 30 },
    { id: "b.ts#B.go", start: 3, end: 10 },
    { id: "b.ts#B.other", start: 12, end: 20 },
    { id: "b.ts#limit", kind: "variable", start: 35, end: 35 },
    { id: "c.ts#C", kind: "class", start: 1, end: 30 },
    { id: "c.ts#C.Inner", kind: "class", start: 3, end: 20 },
    { id: "c.ts#C.Inner.deep", start: 5, end: 9 },
    { id: "c.ts#C.spare", start: 22, end: 28 },
    { id: "c.ts#limit", kind: "variable", start: 35, end: 35 },
    { id: "d.ts#D", kind: "class", start: 1, end: 30 },
    { id: "d.ts#D.go", start: 3, end: 10 },
    { id: "d.ts#quiet", kind: "function", start: 35, end: 40 },
  ],
  refs: [
    { from: "a.ts#A.run", to: "b.ts#B.go", line: 5 },
    { from: "a.ts#A.run", to: "b.ts#limit", kind: "read", line: 6 },
    { from: "b.ts#B.go", to: "a.ts#A.run", line: 5 },
    { from: "b.ts#B.go", to: "c.ts#C.Inner.deep", line: 6 },
    { from: "b.ts#B.go", to: "c.ts#limit", kind: "read", line: 7 },
    { from: "c.ts#C.Inner.deep", to: "d.ts#D.go", line: 6 },
    { from: "c.ts#C.Inner.deep", to: "d.ts#D", kind: "type-ref", line: 7 },
    { from: "d.ts#D.go", to: "c.ts#limit", kind: "read", line: 8 },
    { from: "d.ts#D.go", to: "d.ts#quiet", line: 9 },
    { from: "c.ts#", to: "d.ts#", kind: "import", line: 1 },
    { from: "b.ts#", to: "c.ts#", kind: "import", line: 1 },
  ],
};

describe("pruneIndex: the embedded files", () => {
  it("keeps every file, the symbols of the embedded files, what the kept references end in, and the parents", () => {
    const { index, pruned, symbols, refs } = pruneIndex(w.model, { files: ["src/queue.ts"] });
    expect(pruned).toBe(true);
    expect(index.files).toEqual(w.index.files);
    // queue.ts whole; Runner.dispatch and onJobCompleted reach into it; Runner comes along as a parent
    expect(ids(index.symbols)).toEqual(
      [
        "src/queue.ts#Queue",
        "src/queue.ts#Queue.ack",
        "src/queue.ts#Queue.deadLetter",
        "src/queue.ts#Queue.pop",
        "src/queue.ts#Queue.requeue",
        "src/runner.ts#Runner",
        "src/runner.ts#Runner.dispatch",
        "src/metrics.ts#onJobCompleted",
      ].sort(),
    );
    // the references that touch queue.ts: four calls, the import of Queue and the type reference to it
    expect(refKeys(index)).toEqual(
      [
        "call src/runner.ts#Runner.dispatch -> src/queue.ts#Queue.ack",
        "call src/runner.ts#Runner.dispatch -> src/queue.ts#Queue.deadLetter",
        "call src/runner.ts#Runner.dispatch -> src/queue.ts#Queue.pop",
        "call src/runner.ts#Runner.dispatch -> src/queue.ts#Queue.requeue",
        "import src/runner.ts# -> src/queue.ts#Queue",
        "type-ref src/metrics.ts#onJobCompleted -> src/queue.ts#Queue",
      ].sort(),
    );
    expect(symbols).toEqual({ kept: 8, total: w.index.symbols.length });
    expect(refs).toEqual({ kept: 6, total: w.index.refs.length });
  });

  it("keeps the other fields of the index and marks it with what the full index had", () => {
    const { index } = pruneIndex(w.index, { files: ["src/queue.ts"] });
    expect(index.pruned).toEqual({
      files: w.index.files.length,
      symbols: w.index.symbols.length,
      refs: w.index.refs.length,
    });
    expect(index).toMatchObject({
      schema: w.index.schema,
      commit: w.index.commit,
      tool: w.index.tool,
      languages: w.index.languages,
    });
    expect(w.index.pruned).toBeUndefined();
  });

  it("leaves its input alone and returns new arrays in the original order", () => {
    const before = JSON.stringify(w.index);
    const { index } = pruneIndex(w.index, { files: ["src/runner.ts", "src/worker.ts"] });
    expect(JSON.stringify(w.index)).toBe(before);
    expect(index).not.toBe(w.index);
    const position = new Map(w.index.symbols.map((symbol, i) => [symbol.id, i]));
    const order = index.symbols.map((symbol) => position.get(symbol.id)!);
    expect(order).toEqual([...order].sort((x, y) => x - y));
    const refPosition = new Map(w.index.refs.map((ref, i) => [ref, i]));
    const refOrder = index.refs.map((ref) => refPosition.get(ref)!);
    expect(refOrder).toEqual([...refOrder].sort((x, y) => x - y));
  });

  it("returns the index itself, unmarked, when there is nothing to drop", () => {
    const every = pruneIndex(w.index, { files: w.index.files.map((file) => file.path) });
    expect(every.pruned).toBe(false);
    expect(every.index).toBe(w.index);
    expect(every.index.pruned).toBeUndefined();
    expect(every.symbols.kept).toBe(w.index.symbols.length);
    expect(every.refs.kept).toBe(w.index.refs.length);
  });

  it("ignores paths the index does not have, and takes an IndexModel as well", () => {
    const a = pruneIndex(w.model, { files: ["src/queue.ts", "src/nope.ts"] });
    const b = pruneIndex(w.index, { files: ["src/queue.ts"] });
    expect(a.index).toEqual(b.index);
    // nothing embedded: nothing is kept but the files
    const none = pruneIndex(w.index, { files: [] });
    expect(none.index.symbols).toEqual([]);
    expect(none.index.refs).toEqual([]);
    expect(none.index.files).toEqual(w.index.files);
  });

  it("keeps the counts of the original when it prunes an index that is pruned already", () => {
    const once = pruneIndex(w.index, { files: ["src/queue.ts", "src/runner.ts"] }).index;
    const twice = pruneIndex(once, { files: ["src/queue.ts"] });
    expect(twice.index.pruned).toEqual(once.pruned);
    expect(twice.symbols.total).toBe(once.symbols.length);
    expect(twice.refs.total).toBe(once.refs.length);
    expect(twice.index.refs.length).toBeLessThan(once.refs.length);
  });
});

describe("pruneIndex: reference kinds and dead ends", () => {
  const small = makeWorld(SMALL);

  it("keeps a read only between two embedded files, and the other kinds when either end is one", () => {
    const { index } = pruneIndex(small.index, { files: ["b.ts", "c.ts"] });
    const keys = refKeys(index);
    // both ends embedded
    expect(keys).toContain("read b.ts#B.go -> c.ts#limit");
    // one end embedded: calls stay, reads go
    expect(keys).toContain("call a.ts#A.run -> b.ts#B.go");
    expect(keys).toContain("call c.ts#C.Inner.deep -> d.ts#D.go");
    expect(keys).not.toContain("read a.ts#A.run -> b.ts#limit");
    expect(keys).not.toContain("read d.ts#D.go -> c.ts#limit");
    // no end embedded
    expect(keys).not.toContain("call d.ts#D.go -> d.ts#quiet");
    // an import between module scopes is a reference like any other
    expect(keys).toContain("import b.ts# -> c.ts#");
    expect(keys).toContain("import c.ts# -> d.ts#");
  });

  it("`bothEnds` picks the kinds that need both ends", () => {
    const files = ["b.ts", "c.ts"];
    const all = refKeys(pruneIndex(small.index, { files, bothEnds: [] }).index);
    expect(all).toContain("read a.ts#A.run -> b.ts#limit");
    expect(all).toContain("read d.ts#D.go -> c.ts#limit");
    const strict = refKeys(
      pruneIndex(small.index, { files, bothEnds: ["read", "type-ref"] }).index,
    );
    expect(strict).not.toContain("type-ref c.ts#C.Inner.deep -> d.ts#D");
    expect(strict).toContain("call c.ts#C.Inner.deep -> d.ts#D.go");
  });

  it("keeps the whole parent chain of a symbol a kept reference ends in, and only that", () => {
    const { index } = pruneIndex(small.index, { files: ["b.ts"] });
    // b.ts calls into c.ts#C.Inner.deep: its parents C.Inner and C are kept, the sibling C.spare is not
    expect(ids(index.symbols.filter((s) => s.file === "c.ts"))).toEqual([
      "c.ts#C",
      "c.ts#C.Inner",
      "c.ts#C.Inner.deep",
    ]);
    // the parent links still lead to symbols that are there
    const kept = new Set(index.symbols.map((symbol) => symbol.id));
    for (const symbol of index.symbols) {
      if (symbol.parent !== undefined) expect(kept.has(symbol.parent), symbol.id).toBe(true);
    }
    // so the model derives the same chain as with the whole index
    const pruned = new IndexModel(index);
    for (const id of ["c.ts#C.Inner.deep", "a.ts#A.run"]) {
      expect(pruned.parentSymbol(id)?.id).toBe(small.model.parentSymbol(id)?.id);
    }
  });

  it("drops references that end in something the index cannot resolve", () => {
    const dead = makeWorld({
      ...SMALL,
      refs: [
        ...SMALL.refs!,
        { from: "a.ts#A.run", to: "b.ts#gone", line: 5 },
        { from: "a.ts#A.run", to: "nowhere.ts#", kind: "import", line: 2 },
        { from: "ghost.ts#nothing", to: "b.ts#B.go", line: 2 },
      ],
    });
    const { index } = pruneIndex(dead.index, { files: ["a.ts", "b.ts", "c.ts", "d.ts"] });
    expect(index.refs).toHaveLength(SMALL.refs!.length);
    expect(refKeys(index).join("\n")).not.toMatch(/gone|nowhere|ghost/);
  });
});

describe("pruneIndex: what the explainer draws", () => {
  const small = makeWorld(SMALL);
  const prune = (explainer: Explainer, files: string[] = []) =>
    pruneIndex(small.index, { files, explainer }).index;

  it("keeps the references that have an end inside a graph view, whatever their kind, and the symbols inside it", () => {
    const view = emptyExplainer({ views: [graphView("view:v", ["file:c.ts"])] });
    const index = prune(view);
    // every reference with an end in c.ts, reads and type references included; nothing else
    expect(refKeys(index)).toEqual(
      [
        "call b.ts#B.go -> c.ts#C.Inner.deep",
        "read b.ts#B.go -> c.ts#limit",
        "call c.ts#C.Inner.deep -> d.ts#D.go",
        "type-ref c.ts#C.Inner.deep -> d.ts#D",
        "read d.ts#D.go -> c.ts#limit",
        "import c.ts# -> d.ts#",
        "import b.ts# -> c.ts#",
      ].sort(),
    );
    // all of c.ts is in the view, also C.spare that no reference mentions: the box opens into it
    expect(ids(index.symbols.filter((s) => s.file === "c.ts"))).toEqual(
      ids(small.index.symbols.filter((s) => s.file === "c.ts")),
    );
    // and what those references end in, with its parents
    expect(ids(index.symbols.filter((s) => s.file !== "c.ts"))).toEqual([
      "b.ts#B",
      "b.ts#B.go",
      "d.ts#D",
      "d.ts#D.go",
    ]);
  });

  it("counts a member of an included group, and a directory's files, as inside", () => {
    const grouped = emptyExplainer({
      nodes: [group("grp:g", ["file:d.ts"])],
      views: [graphView("view:v", ["grp:g"])],
    });
    expect(refKeys(prune(grouped))).toContain("read d.ts#D.go -> c.ts#limit");
    const dir = makeWorld({
      files: [
        { path: "lib/x.ts", lines: 20 },
        { path: "lib/y.ts", lines: 20 },
        { path: "other.ts", lines: 20 },
      ],
      symbols: [
        { id: "lib/x.ts#x", kind: "function", start: 1, end: 5 },
        { id: "lib/y.ts#y", kind: "function", start: 1, end: 5 },
        { id: "lib/y.ts#unused", kind: "function", start: 7, end: 9 },
        { id: "other.ts#o", kind: "function", start: 1, end: 5 },
      ],
      refs: [
        { from: "lib/x.ts#x", to: "other.ts#o", kind: "read", line: 2 },
        { from: "lib/x.ts#x", to: "lib/y.ts#y", line: 3 },
      ],
    });
    const { index } = pruneIndex(dir.index, {
      files: [],
      explainer: emptyExplainer({ views: [graphView("view:v", ["dir:lib"])] }),
    });
    expect(index.refs).toHaveLength(2);
    expect(ids(index.symbols)).toContain("lib/y.ts#unused");
  });

  it("leaves the references between things outside every view, and their symbols, out", () => {
    const view = emptyExplainer({ views: [graphView("view:v", ["file:a.ts"])] });
    const index = prune(view);
    expect(refKeys(index).join("\n")).not.toContain("d.ts#D.go -> d.ts#quiet");
    expect(refKeys(index).join("\n")).not.toContain("c.ts#C.Inner.deep -> d.ts#D.go");
    expect(index.symbols.some((symbol) => symbol.id === "d.ts#quiet")).toBe(false);
    // a sequence view has no references to draw
    const sequence = emptyExplainer({
      views: [sequenceView("view:s", ["file:a.ts", "file:b.ts"], [])],
    });
    expect(prune(sequence).refs).toEqual([]);
  });

  it("keeps the symbols the explainer names, with their parents, wherever it names them", () => {
    const named = emptyExplainer({
      nodes: [group("grp:g", ["sym:c.ts#C.Inner.deep"])],
      edges: [edge("edge:x", "sym:d.ts#quiet", "file:a.ts")],
      concepts: [
        concept("concept:c", [
          anchor(small, { file: "a.ts", symbol: "A.Inner.deep", role: "definition" }),
        ]),
      ],
      views: [graphView("view:v", ["sym:b.ts#B.other"])],
      tours: [
        {
          id: "tour:t",
          title: "T",
          steps: [{ id: "t1", view: "view:v", focus: ["sym:c.ts#C.spare"] }],
        },
      ],
    });
    const index = prune(named);
    const kept = new Set(index.symbols.map((symbol) => symbol.id));
    for (const id of [
      "c.ts#C.Inner.deep", // group member
      "c.ts#C.Inner", // its parents
      "c.ts#C",
      "d.ts#quiet", // stored edge end
      "a.ts#A.Inner.deep", // anchor
      "a.ts#A.Inner",
      "a.ts#A",
      "b.ts#B.other", // included by a view
      "b.ts#B",
      "c.ts#C.spare", // tour focus
    ]) {
      expect(kept.has(id), id).toBe(true);
    }
    // and nothing else of a.ts or d.ts, which are not embedded
    expect(kept.has("a.ts#lonely")).toBe(false);
    expect(kept.has("d.ts#D.go")).toBe(false);
  });

  it("finds the symbols inside derived edge, stub and ghost ids", () => {
    const hidden = emptyExplainer({
      views: [
        graphView("view:v", ["file:a.ts"], {
          hidden: [
            "edge:calls:sym:c.ts#C.spare->file:a.ts",
            "stub:out:file:a.ts->ghost:sym:d.ts#quiet",
            "ghost:sym:b.ts#B.other",
          ],
        }),
      ],
    });
    const kept = new Set(prune(hidden).symbols.map((symbol) => symbol.id));
    for (const id of ["c.ts#C.spare", "d.ts#quiet", "b.ts#B.other"]) {
      expect(kept.has(id), id).toBe(true);
    }
  });

  it("keeps the references of a derived edge a tour focuses that no view draws", () => {
    const tour = (focus: string[]): Explainer =>
      emptyExplainer({
        views: [graphView("view:v", ["file:a.ts"])],
        tours: [{ id: "tour:t", title: "T", steps: [{ id: "t1", view: "view:v", focus }] }],
      });
    const edgeId = "edge:calls:file:c.ts->file:d.ts";
    // without the tour: c.ts and d.ts are outside the view, so the call between them is not kept
    expect(refKeys(prune(tour([]))).join("\n")).not.toContain("c.ts#C.Inner.deep -> d.ts#D.go");
    const index = prune(tour([edgeId]));
    expect(refKeys(index)).toContain("call c.ts#C.Inner.deep -> d.ts#D.go");
    // and only the calls: the type reference between the same files is another kind of edge
    expect(refKeys(index).join("\n")).not.toContain("type-ref c.ts#C.Inner.deep -> d.ts#D");
    // the code the viewer shows for the focus is the same
    const model = (idx: SymbolIndex) => new ExplainerModel(tour([edgeId]), new IndexModel(idx));
    expect(codeFocus([edgeId], model(index))).toEqual(codeFocus([edgeId], model(small.index)));
    expect(codeFocus([edgeId], model(index)).length).toBeGreaterThan(0);
    // a stored edge with a derived id counts too
    const stored = emptyExplainer({
      views: [graphView("view:v", ["file:a.ts"])],
      edges: [edge(edgeId, "file:c.ts", "file:d.ts", [], { kind: "calls" })],
    });
    expect(refKeys(prune(stored))).toContain("call c.ts#C.Inner.deep -> d.ts#D.go");
  });

  it("a view of the whole repository keeps everything it can draw: nothing to prune", () => {
    const everything = emptyExplainer({ views: [graphView("view:v", ["repo"])] });
    const result = pruneIndex(small.index, { files: [], explainer: everything });
    expect(result.pruned).toBe(false);
    expect(result.index).toBe(small.index);
  });

  it("survives an explainer with junk in it", () => {
    const junk = emptyExplainer({
      views: [graphView("view:v", ["file:a.ts", "sym:nope.ts#x", 7 as never])],
      tours: [{ id: "tour:t", title: "T", steps: [{ id: "t1", view: "view:v" } as never] }],
    });
    expect(() => prune(junk)).not.toThrow();
  });
});

/** An explainer over the job runner world with a bit of everything. */
function jobrunnerExplainer(): Explainer {
  return emptyExplainer({
    nodes: [group("grp:sched", ["file:src/runner.ts", "file:src/queue.ts"])],
    edges: [
      edge(
        "edge:calls:file:src/runner.ts->file:src/worker.ts",
        "file:src/runner.ts",
        "file:src/worker.ts",
        [],
        {
          kind: "calls",
          label: "runs jobs",
        },
      ),
    ],
    concepts: [
      concept(
        "concept:retry",
        [anchor(w, { file: "src/runner.ts", symbol: "Runner.dispatch", role: "definition" })],
        { related: ["file:src/queue.ts", "grp:sched"] },
      ),
    ],
    views: [
      graphView("view:overview", ["grp:sched", "file:src/worker.ts"]),
      graphView("view:dispatch-code", [
        "sym:src/runner.ts#Runner.dispatch",
        "sym:src/queue.ts#Queue.pop",
        "file:src/metrics.ts",
      ]),
      graphView("view:dirs", ["dir:src", "dir:config"], { excludeFiles: ["test/**"] }),
      graphView("view:one", ["file:src/queue.ts"], { stubs: { mode: "all" } }),
      sequenceView(
        "view:flow",
        ["file:src/runner.ts", "file:src/queue.ts"],
        [
          {
            id: "flow:1",
            from: "file:src/runner.ts",
            to: "file:src/queue.ts",
            label: "pop",
            kind: "call",
            anchors: [anchor(w, { file: "src/queue.ts", symbol: "Queue.pop", role: "definition" })],
          },
        ],
      ),
    ],
    tours: [
      {
        id: "tour:t",
        title: "T",
        steps: [
          {
            id: "t1",
            view: "view:overview",
            focus: ["edge:calls:file:src/runner.ts->file:src/worker.ts"],
          },
          { id: "t2", view: "view:one", focus: ["sym:src/worker.ts#Worker.run", "flow:1"] },
        ],
      },
    ],
  });
}

describe("pruneIndex: the viewer derives the same from the pruned index", () => {
  const explainer = jobrunnerExplainer();

  for (const [name, files] of [
    ["nothing embedded", []],
    ["one file", ["src/worker.ts"]],
    ["the files of the anchors", ["src/runner.ts", "src/queue.ts"]],
    ["all but the tests", w.index.files.map((f) => f.path).filter((p) => !p.startsWith("test/"))],
  ] as [string, string[]][]) {
    it(`the job runner explainer with ${name} embedded`, () => {
      const { index } = pruneIndex(w.index, { files, explainer });
      const stats = expectSameViewer(w.index, index, explainer, { embedded: files });
      expect(stats.graphs).toBeGreaterThan(100);
      expect(stats.edges).toBeGreaterThan(20);
      expect(stats.stubs).toBeGreaterThan(20);
      expect(stats.stubCode).toBeGreaterThan(20);
      expect(stats.ghosts).toBeGreaterThan(20);
      expect(stats.lookups).toBeGreaterThan(10);
    });
  }

  it("the checker notices what a careless pruning loses", () => {
    // a reference that a view draws goes missing
    const { index } = pruneIndex(w.index, { files: [], explainer });
    const lossy: SymbolIndex = {
      ...index,
      refs: index.refs.filter(
        (ref) => !(ref.from.endsWith("#Runner.dispatch") && ref.to.endsWith("#Queue.pop")),
      ),
    };
    expect(() => expectSameViewer(w.index, lossy, explainer)).toThrow();
    // a symbol a view includes goes missing
    const dropped: SymbolIndex = {
      ...index,
      symbols: index.symbols.filter((symbol) => symbol.id !== "src/queue.ts#Queue.pop"),
    };
    expect(() => expectSameViewer(w.index, dropped, explainer)).toThrow();
    // and pruning by the embedded files alone, without the explainer, is not enough
    const naive = pruneIndex(w.index, { files: ["src/worker.ts"] }).index;
    expect(() => expectSameViewer(w.index, naive, explainer)).toThrow();
  });
});

describe("pruneIndex: parents", () => {
  // C.spare is in the view and calls C.Inner.deep, which is not: the ghost stands for its highest parent that the
  // view does not touch, C.Inner. Without that parent the chain would lead straight to C, and the ghost would be
  // the method itself.
  const world = makeWorld({
    ...SMALL,
    refs: [...SMALL.refs!, { from: "c.ts#C.spare", to: "c.ts#C.Inner.deep", line: 24 }],
  });
  const view = graphView("view:v", ["sym:c.ts#C.spare"], { stubs: { mode: "all" } });
  const explainer = emptyExplainer({ views: [view] });

  it("keeps the chain, so the ghost is the same", () => {
    const { index } = pruneIndex(world.index, { files: [], explainer });
    expect(index.symbols.map((symbol) => symbol.id)).toContain("c.ts#C.Inner");
    const model = (idx: SymbolIndex) => new ExplainerModel(explainer, new IndexModel(idx));
    const full = deriveGraph(view, model(world.index));
    expect(full.ghosts.map((ghost) => ghost.id)).toEqual(["ghost:sym:c.ts#C.Inner"]);
    expect(deriveGraph(view, model(index))).toEqual(full);
    expectSameViewer(world.index, index, explainer);
  });

  it("the checker sees a chain that is cut", () => {
    const { index } = pruneIndex(world.index, { files: [], explainer });
    const orphaned: SymbolIndex = {
      ...index,
      symbols: index.symbols.filter((symbol) => symbol.id !== "c.ts#C.Inner"),
    };
    expect(() => expectSameViewer(world.index, orphaned, explainer)).toThrow();
  });
});

describe("pruneIndex: a larger repository", () => {
  const repo = syntheticRepo({ seed: 11, packages: 6, filesPerPackage: 8, bigFiles: 60 });
  const { world, explainer } = repo;

  it("is big enough to mean something", () => {
    expect(world.index.files.length).toBeGreaterThan(100);
    expect(world.index.symbols.length).toBeGreaterThan(1000);
    expect(world.index.refs.length).toBeGreaterThan(2000);
    const kinds = new Set(world.index.refs.map((ref) => ref.kind));
    expect([...kinds].sort()).toEqual([
      "call",
      "extends",
      "implements",
      "import",
      "read",
      "type-ref",
      "write",
    ]);
    // a directory the viewer cannot focus whole
    expect(world.model.filesUnder("packages/big/src").length).toBeGreaterThan(50);
    // an explainer with content the checks below have to cover
    expect(explainer.views.length).toBeGreaterThanOrEqual(6);
  });

  const cases: [string, string[]][] = [
    ["nothing embedded", []],
    ["the files of the anchors", repo.anchorFiles],
    [
      "the first 50 files of the big directory and the anchors",
      [...repo.anchorFiles, ...world.model.filesUnder("packages/big/src").slice(0, 50)],
    ],
  ];
  for (const [name, files] of cases) {
    it(`the same is derived with ${name} embedded`, () => {
      const result = pruneIndex(world.model, { files, explainer });
      const stats = expectSameViewer(world.index, result.index, explainer, { embedded: files });
      // the comparison covered stubs, ghosts and code
      expect(stats.edges).toBeGreaterThan(500);
      expect(stats.stubs).toBeGreaterThan(500);
      expect(stats.stubCode).toBeGreaterThan(200);
      expect(stats.ghosts).toBeGreaterThan(300);
      expect(stats.ranges).toBeGreaterThan(500);
      expect(stats.lookups).toBeGreaterThan(500);
      expect(stats.edits).toBeGreaterThan(20);
      expect(result.pruned).toBe(true);
      expect(result.refs.kept).toBeLessThan(result.refs.total);
      expect(result.symbols.kept).toBeLessThan(result.symbols.total);
    });
  }

  it("has nothing to prune when every file is embedded", () => {
    const files = world.index.files.map((file) => file.path);
    const result = pruneIndex(world.model, { files, explainer });
    expect(result.pruned).toBe(false);
    expect(result.index).toBe(world.index);
  });

  it("prunes most of it for a narrow explainer, and the viewer derives the same", () => {
    const narrow = emptyExplainer({
      views: [graphView("view:one", ["file:packages/p1/src/f1.ts"])],
      concepts: [
        concept("concept:c", [
          anchor(world, { file: "packages/p1/src/f1.ts", symbol: "Cp1_1", role: "definition" }),
        ]),
      ],
    });
    const files = ["packages/p1/src/f1.ts"];
    const { index, refs, symbols } = pruneIndex(world.model, { files, explainer: narrow });
    expect(refs.kept).toBeLessThan(refs.total * 0.1);
    expect(symbols.kept).toBeLessThan(symbols.total * 0.2);
    expectSameViewer(world.index, index, narrow, { embedded: files });
  });

  it("a directory over the focus cap needs the references of its last files: the files alone are not enough", () => {
    const big = world.model.filesUnder("packages/big/src");
    const files = [...repo.anchorFiles, ...big.slice(0, 50)];
    const overview = new ExplainerModel(explainer, world.model);
    const view = overview.view("view:overview");
    if (view?.type !== "graph") throw new Error("view:overview is a graph view");
    expect(view.include).toContain("dir:packages/big/src");
    const shown = deriveGraph(view, overview);
    expect(shown.stubs.length).toBeGreaterThan(0);
    // pruning by the embedded files only: the view of the directory differs, for its last ten files are not there
    const naive = pruneIndex(world.index, { files }).index;
    expect(() => expectSameViewer(world.index, naive, explainer)).toThrow();
    // with the explainer it does not: that is the case "the first 50 files of the big directory" above
    expect(pruneIndex(world.index, { files, explainer }).index.refs.length).toBeGreaterThan(
      naive.refs.length,
    );
  });

  it("is deterministic", () => {
    const again = syntheticRepo({ seed: 11, packages: 6, filesPerPackage: 8, bigFiles: 60 });
    expect(again.world.index).toEqual(world.index);
    expect(again.explainer).toEqual(explainer);
    const other = syntheticRepo({ seed: 12, packages: 6, filesPerPackage: 8, bigFiles: 60 });
    expect(other.world.index.refs).not.toEqual(world.index.refs);
  });
});
