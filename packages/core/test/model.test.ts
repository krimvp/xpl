import { describe, expect, it } from "vitest";
import { defaultLabel, ExplainerModel, symbolLabel, type Explainer } from "../src/index.js";
import {
  anchor,
  concept,
  edge,
  emptyExplainer,
  graphView,
  group,
  jobrunner,
  LLM,
  sequenceView,
  USER,
} from "./helpers.js";

const w = jobrunner();
const DISPATCH = "sym:src/runner.ts#Runner.dispatch";
const POP = "sym:src/queue.ts#Queue.pop";
const DERIVED = `edge:calls:${DISPATCH}->${POP}`;

function build(over: Partial<Explainer> = {}): ExplainerModel {
  const ex = emptyExplainer({
    nodes: [
      group("grp:scheduling", ["file:src/runner.ts", "file:src/queue.ts"]),
      group("grp:core", ["grp:scheduling", "file:src/worker.ts"]),
      {
        id: DISPATCH,
        kind: "symbol",
        parent: "file:src/runner.ts",
        label: "Dispatch loop",
        summary: "The hot loop.",
        detail: "Longer text",
        anchors: [
          anchor(w, {
            file: "src/runner.ts",
            symbol: "Runner.dispatch",
            span: { from: 4, to: 4 },
            role: "call-site",
          }),
        ],
        provenance: { origin: "llm", userFields: ["summary"], commit: "c1" },
      },
      {
        id: "file:src/queue.ts",
        kind: "file",
        parent: "dir:src",
        label: "",
        anchors: [],
        provenance: LLM,
      },
      {
        id: "file:src/gone.ts",
        kind: "file",
        parent: "dir:src",
        label: "Gone",
        anchors: [],
        provenance: LLM,
      },
    ],
    edges: [
      edge("edge:job-completed", "file:src/worker.ts", "file:src/metrics.ts", [], {
        label: "job.completed",
        summary: "event",
      }),
      edge(DERIVED, DISPATCH, POP, [], { kind: "calls", label: "take next" }),
    ],
    concepts: [concept("concept:retry", [], { related: [DISPATCH] })],
    views: [
      graphView("view:overview", ["grp:scheduling"]),
      sequenceView(
        "view:dispatch",
        [DISPATCH, "file:src/queue.ts"],
        [
          {
            id: "dispatch:1",
            from: DISPATCH,
            to: "file:src/queue.ts",
            label: "pop()",
            kind: "call",
            anchors: [],
          },
          {
            id: "dispatch:2",
            from: DISPATCH,
            to: "file:src/queue.ts",
            label: "ack()",
            kind: "call",
            anchors: [],
          },
        ],
      ),
    ],
    tours: [{ id: "tour:intro", title: "Intro", steps: [] }],
    ...over,
  });
  return new ExplainerModel(ex, w.model);
}

describe("ExplainerModel nodes", () => {
  const m = build();

  it("derives structural nodes with default labels", () => {
    expect(m.node("repo")).toMatchObject({
      id: "repo",
      kind: "repo",
      label: "acme/jobrunner",
      parent: null,
      stored: false,
      structural: true,
      anchors: [],
      provenance: { origin: "static" },
    });
    expect(m.node("dir:src/util")).toMatchObject({ kind: "dir", label: "util", parent: "dir:src" });
    expect(m.node("dir:src")).toMatchObject({ parent: "repo" });
    expect(m.node("file:src/worker.ts")).toMatchObject({
      kind: "file",
      label: "worker.ts",
      parent: "dir:src",
    });
    expect(m.node("sym:src/queue.ts#Queue.pop")).toMatchObject({
      kind: "symbol",
      label: "Queue.pop", // methods keep Class.method
      symbolKind: "method",
      parent: "sym:src/queue.ts#Queue",
    });
    expect(m.node("sym:src/runner.ts#backoffDelay")).toMatchObject({
      label: "backoffDelay",
      parent: "file:src/runner.ts",
    });
    expect(m.node("sym:config/default.yaml#retry.maxRetries")).toMatchObject({
      label: "maxRetries",
      symbolKind: "key",
      parent: "sym:config/default.yaml#retry",
    });
    expect(m.node("sym:src/runner.ts#Runner")).toMatchObject({
      label: "Runner",
      symbolKind: "class",
    });
  });

  it("overlays a stored node on the derived one", () => {
    const n = m.node(DISPATCH)!;
    expect(n).toMatchObject({
      label: "Dispatch loop",
      summary: "The hot loop.",
      detail: "Longer text",
      stored: true,
      structural: true,
      kind: "symbol",
      symbolKind: "method",
      parent: "sym:src/runner.ts#Runner", // structure wins over the stored parent
      provenance: { origin: "llm", userFields: ["summary"], commit: "c1" },
    });
    expect(n.anchors).toHaveLength(1);
  });

  it("falls back to the default label when the overlay's label is empty", () => {
    expect(m.node("file:src/queue.ts")).toMatchObject({ label: "queue.ts", stored: true });
  });

  it("does not return overlays of things that are gone from the index", () => {
    expect(m.node("file:src/gone.ts")).toBeUndefined();
    expect(m.hasNode("file:src/gone.ts")).toBe(false);
    expect(m.node("sym:src/runner.ts#Nope")).toBeUndefined();
    expect(m.node("dir:nope")).toBeUndefined();
    expect(m.node("concept:retry")).toBeUndefined();
    expect(m.node("nonsense")).toBeUndefined();
  });

  it("returns stored groups (parent defaults to repo)", () => {
    expect(m.node("grp:scheduling")).toMatchObject({
      kind: "group",
      parent: "repo",
      stored: true,
      structural: false,
      members: ["file:src/runner.ts", "file:src/queue.ts"],
    });
    const odd = build({
      nodes: [group("grp:x", [], { parent: "dir:nope" }), group("grp:y", [], { parent: "grp:y" })],
    });
    expect(odd.node("grp:x")!.parent).toBe("repo");
    expect(odd.parent("grp:y")).toBe("repo");
    const inDir = build({ nodes: [group("grp:x", [], { parent: "dir:src" })] });
    expect(inDir.parent("grp:x")).toBe("dir:src");
    expect(inDir.node("grp:zzz")).toBeUndefined();
  });

  it("memoises nodes", () => {
    expect(m.node("dir:src")).toBe(m.node("dir:src"));
  });
});

describe("ExplainerModel structure", () => {
  const m = build();

  it("walks parents and ancestors along the structural chain", () => {
    expect(m.parent("repo")).toBeUndefined();
    expect(m.parent("dir:src")).toBe("repo");
    expect(m.parent("file:test/retry.test.ts")).toBe("dir:test");
    expect(m.parent("sym:src/queue.ts#Queue")).toBe("file:src/queue.ts");
    expect(m.parent("sym:src/queue.ts#Queue.pop")).toBe("sym:src/queue.ts#Queue");
    expect(m.parent("concept:retry")).toBeUndefined();
    expect(m.ancestors("sym:src/util/sleep.ts#sleep")).toEqual([
      "file:src/util/sleep.ts",
      "dir:src/util",
      "dir:src",
      "repo",
    ]);
    expect(m.ancestors("repo")).toEqual([]);
    expect(m.ancestors("dir:nope")).toEqual([]);
    expect(m.ancestors("grp:scheduling")).toEqual(["repo"]);
  });

  it("lists structural children in order", () => {
    expect(m.children("repo")).toEqual(["dir:config", "dir:src", "dir:test"]);
    expect(m.children("dir:src")).toEqual([
      "dir:src/util",
      "file:src/metrics.ts",
      "file:src/queue.ts",
      "file:src/runner.ts",
      "file:src/worker.ts",
    ]);
    expect(m.children("file:src/runner.ts")).toEqual([
      "sym:src/runner.ts#Runner",
      "sym:src/runner.ts#backoffDelay",
    ]);
    expect(m.children("sym:src/runner.ts#Runner")).toEqual([
      "sym:src/runner.ts#Runner.start",
      "sym:src/runner.ts#Runner.stop",
      "sym:src/runner.ts#Runner.dispatch",
      "sym:src/runner.ts#Runner.log",
    ]);
    expect(m.children("sym:src/runner.ts#backoffDelay")).toEqual([]);
    expect(m.children("grp:scheduling")).toEqual([]); // groups list members, not children
    expect(m.children("dir:nope")).toEqual([]);
    expect(m.members("grp:core")).toEqual(["grp:scheduling", "file:src/worker.ts"]);
    expect(m.members("file:src/worker.ts")).toEqual([]);
  });

  it("finds the groups that contain an element, sorted by id", () => {
    const two = build({
      nodes: [group("grp:b", ["file:src/queue.ts"]), group("grp:a", ["file:src/queue.ts"])],
    });
    expect(two.groupsContaining("file:src/queue.ts").map((g) => g.id)).toEqual(["grp:a", "grp:b"]);
    expect(two.groupIdsContaining("file:src/queue.ts")).toEqual(["grp:a", "grp:b"]);
    expect(two.groupsContaining("file:src/runner.ts")).toEqual([]);
    expect(m.groupsContaining("grp:scheduling").map((g) => g.id)).toEqual(["grp:core"]);
  });

  it("subtreeContains: structural chain, groups and their members, self", () => {
    expect(m.subtreeContains("dir:src", "sym:src/queue.ts#Queue.pop")).toBe(true);
    expect(m.subtreeContains("file:src/queue.ts", "sym:src/queue.ts#Queue.pop")).toBe(true);
    expect(m.subtreeContains("sym:src/queue.ts#Queue", "sym:src/queue.ts#Queue.pop")).toBe(true);
    expect(m.subtreeContains("repo", "file:src/queue.ts")).toBe(true);
    expect(m.subtreeContains("file:src/queue.ts", "file:src/queue.ts")).toBe(true);
    expect(m.subtreeContains("sym:src/queue.ts#Queue.pop", "sym:src/queue.ts#Queue")).toBe(false);
    expect(m.subtreeContains("dir:test", "file:src/queue.ts")).toBe(false);
    expect(m.subtreeContains("file:src/queue.ts", "file:src/runner.ts")).toBe(false);
    // a group's subtree is its members' subtrees, nested groups included
    expect(m.subtreeContains("grp:scheduling", "sym:src/queue.ts#Queue.pop")).toBe(true);
    expect(m.subtreeContains("grp:core", "sym:src/queue.ts#Queue.pop")).toBe(true);
    expect(m.subtreeContains("grp:core", "sym:src/worker.ts#Worker")).toBe(true);
    expect(m.subtreeContains("grp:scheduling", "file:src/worker.ts")).toBe(false);
    expect(m.subtreeContains("dir:nope", "file:src/queue.ts")).toBe(false);
    expect(m.subtreeContains("file:src/queue.ts", "dir:nope")).toBe(false);
  });

  it("subtreeContains survives group cycles", () => {
    const cyc = build({ nodes: [group("grp:a", ["grp:b"]), group("grp:b", ["grp:a"])] });
    expect(cyc.subtreeContains("grp:a", "file:src/queue.ts")).toBe(false);
    expect(cyc.subtreeContains("grp:a", "grp:b")).toBe(true);
    expect(cyc.ancestors("grp:a")).toEqual(["repo"]);
  });

  it("ancestors are worked out once per element (the viewer asks thousands of times)", () => {
    const fresh = build();
    const calls = { n: 0 };
    const parent = fresh.parent.bind(fresh);
    fresh.parent = (id) => (calls.n++, parent(id));
    const pop = "sym:src/queue.ts#Queue.pop";
    for (let i = 0; i < 1000; i++) {
      fresh.subtreeContains("dir:test", pop);
      fresh.ancestors(pop);
    }
    expect(calls.n).toBeLessThanOrEqual(5); // one per element on the chain
    // the returned list is the caller's to change
    fresh.ancestors(pop).push("x");
    expect(fresh.ancestors(pop)).toEqual([
      "sym:src/queue.ts#Queue",
      "file:src/queue.ts",
      "dir:src",
      "repo",
    ]);
  });

  it("containsCode: does code at (file, symbol) lie inside an element?", () => {
    const at = (
      id: string,
      where: { file: string; symbol?: string; range?: { startLine: number; endLine: number } },
    ) => m.containsCode(id, where);
    expect(at("repo", { file: "x" })).toBe(true);
    expect(at("dir:src", { file: "src/queue.ts" })).toBe(true);
    expect(at("dir:src", { file: "srcx/queue.ts" })).toBe(false);
    expect(at("file:src/queue.ts", { file: "src/queue.ts" })).toBe(true);
    expect(at("file:src/queue.ts", { file: "src/worker.ts" })).toBe(false);
    expect(at("sym:src/queue.ts#Queue", { file: "src/queue.ts", symbol: "Queue.pop" })).toBe(true);
    expect(at("sym:src/queue.ts#Queue.pop", { file: "src/queue.ts", symbol: "Queue" })).toBe(false);
    expect(at("sym:src/queue.ts#Queue.pop", { file: "src/queue.ts", symbol: "Queue.pop" })).toBe(
      true,
    );
    expect(at("sym:src/queue.ts#Queue.pop", { file: "src/queue.ts" })).toBe(false); // no symbol, no range
    expect(
      at("sym:src/queue.ts#Queue.pop", {
        file: "src/queue.ts",
        range: { startLine: 6, endLine: 9 },
      }),
    ).toBe(true);
    expect(
      at("sym:src/queue.ts#Queue.pop", {
        file: "src/queue.ts",
        range: { startLine: 6, endLine: 30 },
      }),
    ).toBe(false);
    expect(at("grp:scheduling", { file: "src/queue.ts", symbol: "Queue.pop" })).toBe(true);
    expect(at("grp:core", { file: "src/worker.ts" })).toBe(true);
    expect(at("grp:scheduling", { file: "src/worker.ts" })).toBe(false);
    expect(at("concept:retry", { file: "src/queue.ts" })).toBe(false);
  });
});

describe("ExplainerModel elements", () => {
  const m = build();

  it("tags each kind of element", () => {
    expect(m.element("repo")).toMatchObject({ type: "node" });
    expect(m.element("grp:scheduling")).toMatchObject({ type: "node" });
    expect(m.element("sym:src/queue.ts#Queue")).toMatchObject({ type: "node" });
    expect(m.element("edge:job-completed")).toMatchObject({
      type: "edge",
      edge: { kind: "emits" },
    });
    expect(m.element("concept:retry")).toMatchObject({ type: "concept" });
    const step = m.element("dispatch:2");
    expect(step).toMatchObject({
      type: "step",
      index: 1,
      step: { label: "ack()" },
      view: { id: "view:dispatch" },
    });
  });

  it("knows derivable edge ids when both ends are nodes", () => {
    const id = "edge:calls:file:src/runner.ts->file:src/queue.ts";
    expect(m.element(id)).toEqual({
      type: "derived-edge",
      id,
      kind: "calls",
      from: "file:src/runner.ts",
      to: "file:src/queue.ts",
    });
    expect(m.hasElement("edge:calls:file:src/runner.ts->file:src/nope.ts")).toBe(false);
    expect(m.hasElement("edge:calls:grp:scheduling->file:src/worker.ts")).toBe(true);
  });

  it("prefers a stored overlay on a derived id", () => {
    expect(m.element(DERIVED)).toMatchObject({ type: "edge", edge: { label: "take next" } });
  });

  it("returns undefined for unknown, malformed and render-only ids", () => {
    for (const id of [
      "nope",
      "concept:missing",
      "edge:missing",
      "dispatch:9",
      "ghost:file:src/queue.ts",
      "view:overview",
      "tour:intro",
    ]) {
      expect(m.element(id), id).toBeUndefined();
    }
  });

  it("looks up edges, concepts, views, tours and steps", () => {
    expect(m.edge("edge:job-completed")?.label).toBe("job.completed");
    expect(m.edge("edge:nope")).toBeUndefined();
    expect(m.concept("concept:retry")?.related).toEqual([DISPATCH]);
    expect(m.view("view:overview")?.type).toBe("graph");
    expect(m.tour("tour:intro")?.title).toBe("Intro");
    expect(m.step("dispatch:1")?.index).toBe(0);
    expect(m.stepViewId("dispatch:2")).toBe("view:dispatch");
    expect(m.stepViewId("nope:1")).toBeUndefined();
    expect(m.storedEdges).toHaveLength(2);
    expect(m.concepts).toHaveLength(1);
    expect(m.views).toHaveLength(2);
    expect(m.tours).toHaveLength(1);
    expect(m.groups.map((g) => g.id)).toEqual(["grp:core", "grp:scheduling"]);
  });

  it("labels any element", () => {
    expect(m.label(DISPATCH)).toBe("Dispatch loop");
    expect(m.label("edge:job-completed")).toBe("job.completed");
    expect(m.label(DERIVED)).toBe("take next");
    expect(m.label("edge:calls:file:src/runner.ts->file:src/queue.ts")).toBe("calls");
    expect(m.label("concept:retry")).toBe("retry");
    expect(m.label("dispatch:1")).toBe("pop()");
    expect(m.label("who-knows")).toBe("who-knows");
    const unlabeled = build({
      edges: [edge("edge:x", "repo", "repo", [], { label: "", kind: "custom" })],
    });
    expect(unlabeled.label("edge:x")).toBe("custom");
  });

  it("keeps the first of duplicated ids", () => {
    const dup = build({
      concepts: [
        concept("concept:a", [], { label: "first" }),
        concept("concept:a", [], { label: "second" }),
      ],
    });
    expect(dup.concept("concept:a")?.label).toBe("first");
  });

  it("tolerates a hand-edited explainer with missing arrays", () => {
    const partial = new ExplainerModel(
      { ...emptyExplainer(), nodes: undefined, views: undefined } as never,
      w.model,
    );
    expect(partial.node("repo")?.label).toBe("acme/jobrunner");
    expect(partial.groups).toEqual([]);
    expect(partial.views).toEqual([]);
  });

  it("accepts a raw SymbolIndex", () => {
    const raw = new ExplainerModel(emptyExplainer(), w.index);
    expect(raw.node("file:src/queue.ts")?.label).toBe("queue.ts");
  });
});

describe("default labels", () => {
  it("names symbols by their last path segment, methods by the last two", () => {
    expect(symbolLabel({ path: "Runner.dispatch", kind: "method" })).toBe("Runner.dispatch");
    expect(symbolLabel({ path: "NS.Runner.dispatch", kind: "method" })).toBe("Runner.dispatch");
    expect(symbolLabel({ path: "outer.inner", kind: "function" })).toBe("inner");
    expect(symbolLabel({ path: "workers.0.name", kind: "key" })).toBe("name");
    expect(symbolLabel({ path: "solo", kind: "function" })).toBe("solo");
    expect(symbolLabel({ path: "foo~2", kind: "function" })).toBe("foo~2");
  });

  it("defaultLabel handles every structural id and falls back to the id", () => {
    expect(defaultLabel("repo", w.model, "acme/x")).toBe("acme/x");
    expect(defaultLabel("dir:src/util", w.model, "r")).toBe("util");
    expect(defaultLabel("file:src/queue.ts", w.model, "r")).toBe("queue.ts");
    expect(defaultLabel("sym:src/queue.ts#Queue.pop", w.model, "r")).toBe("Queue.pop");
    expect(defaultLabel("sym:src/queue.ts#Ghost.gone", w.model, "r")).toBe("gone");
    expect(defaultLabel("grp:x", w.model, "r")).toBe("grp:x");
  });
});

describe("user provenance survives the overlay", () => {
  it("keeps a user-authored overlay's provenance", () => {
    const m = build({
      nodes: [
        {
          id: "file:src/queue.ts",
          kind: "file",
          parent: "dir:src",
          label: "Q",
          anchors: [],
          provenance: USER,
        },
      ],
    });
    expect(m.node("file:src/queue.ts")!.provenance).toEqual({ origin: "user" });
  });
});
