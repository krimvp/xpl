import { describe, expect, it } from "vitest";
import {
  applyPatch,
  applyUserEdits,
  makeGraphEdits,
  ExplainerModel,
  deriveGraph,
  type GraphView,
  createExplainer,
  makeUserEdit,
  reresolveExplainer,
  IndexModel,
} from "../src/index.js";
import { makeWorld } from "./helpers.js";

const world = () => makeWorld({ files: [{ path: "a.ts", text: "function run() {}" }] });

describe("bounded user edits", () => {
  it("undoes only edited fields, keeps unrelated edits, and keeps user protection", () => {
    const w = world();
    const initial = createExplainer({
      title: "Demo",
      repoName: "Demo",
      indexPath: ".explainer/index-c1.json",
      index: w.index,
    });
    const edit = makeUserEdit(initial, w.model, "nodes", "file:a.ts", { summary: "Runs work." });
    const saved = applyUserEdits(initial, [edit], w.model, w.getText);
    expect(saved.explainer.nodes.find((n) => n.id === "file:a.ts")).toMatchObject({
      summary: "Runs work.",
      provenance: { origin: "user" },
    });
    const other = applyPatch(
      saved.explainer,
      { nodes: [{ id: "file:a.ts", detail: "Someone else's detail." }] },
      w.model,
      w.getText,
      { actor: "user" },
    );
    expect(other.ok).toBe(true);
    if (!other.ok) throw new Error("fixture failed");
    const undone = applyUserEdits(other.explainer, saved.inverse, w.model, w.getText);
    expect(undone.explainer.nodes.find((n) => n.id === "file:a.ts")).toMatchObject({
      detail: "Someone else's detail.",
    });
    expect(undone.explainer.nodes.find((n) => n.id === "file:a.ts")?.summary).toBeUndefined();
    const redone = applyUserEdits(undone.explainer, undone.inverse, w.model, w.getText);
    expect(redone.explainer.nodes.find((n) => n.id === "file:a.ts")?.summary).toBe("Runs work.");
    const llm = applyPatch(
      redone.explainer,
      { nodes: [{ id: "file:a.ts", summary: "Generated replacement." }] },
      w.model,
      w.getText,
      { actor: "llm" },
    );
    expect(llm.ok).toBe(true);
    if (llm.ok)
      expect(llm.explainer.nodes.find((n) => n.id === "file:a.ts")?.summary).toBe("Runs work.");
  });
});

it("refuses conflicting fields and unsupported payloads without changing the artifact", () => {
  const w = world();
  const initial = createExplainer({
    title: "Demo",
    repoName: "Demo",
    indexPath: ".explainer/index-c1.json",
    index: w.index,
  });
  const edit = makeUserEdit(initial, w.model, "nodes", "file:a.ts", { summary: "My summary." });
  const saved = applyUserEdits(initial, [edit], w.model, w.getText);
  const newer = applyUserEdits(
    saved.explainer,
    [
      makeUserEdit(saved.explainer, w.model, "nodes", "file:a.ts", {
        summary: "Someone else's summary.",
      }),
    ],
    w.model,
    w.getText,
  );
  expect(() => applyUserEdits(newer.explainer, saved.inverse, w.model, w.getText)).toThrow(
    "summary changed since this edit",
  );
  expect(newer.explainer.nodes.find((n) => n.id === "file:a.ts")?.summary).toBe(
    "Someone else's summary.",
  );
  for (const after of [{ unsupported: [] }, { provenance: { origin: "llm" } }, { summary: 42 }]) {
    expect(() => applyUserEdits(initial, [{ ...edit, after }], w.model, w.getText)).toThrow(
      "Invalid or unsupported edit field",
    );
  }
});

it("saves checked evidence, builds conditional inverses and protects it from later LLM patches", () => {
  const w = makeWorld({ files: [{ path: "a.ts", text: "const first = 1;\nconst second = 2;" }] });
  const initial = createExplainer({
    title: "Demo",
    repoName: "Demo",
    indexPath: ".explainer/index-c1.json",
    index: w.index,
  });
  const setup = applyPatch(
    initial,
    {
      concepts: [
        {
          id: "concept:run",
          label: "Run",
          summary: "Old text.",
          anchors: [{ file: "a.ts", span: { from: 0, to: 0 }, role: "usage" }],
        },
      ],
    },
    w.model,
    w.getText,
    { actor: "llm" },
  );
  expect(setup.ok).toBe(true);
  if (!setup.ok) throw new Error("fixture failed");
  const saved = applyUserEdits(
    setup.explainer,
    [
      makeUserEdit(setup.explainer, w.model, "concepts", "concept:run", {
        summary: "Checked by the author.",
        anchors: [{ file: "a.ts", find: "const second = 2;", role: "definition" }],
      }),
    ],
    w.model,
    w.getText,
  );
  expect(saved.explainer.concepts[0]).toMatchObject({
    summary: "Checked by the author.",
    anchors: [
      { file: "a.ts", span: { from: 1, to: 1 }, role: "definition", resolved: { status: "ok" } },
    ],
    provenance: { origin: "llm", userFields: ["summary", "anchors"] },
  });
  expect(saved.inverse[0]!.before.anchors).toEqual([
    expect.objectContaining({ span: { from: 1, to: 1 } }),
  ]);
  const index = new IndexModel({ ...w.index, commit: "c2" });
  const fresh = reresolveExplainer(saved.explainer, index, w.getText).explainer;
  const undone = applyUserEdits(fresh, saved.inverse, index, w.getText);
  expect(undone.explainer.concepts[0]).toMatchObject({
    summary: "Old text.",
    anchors: [{ span: { from: 0, to: 0 } }],
  });
  const redone = applyUserEdits(undone.explainer, undone.inverse, index, w.getText);
  const revised = applyPatch(
    redone.explainer,
    {
      concepts: [
        {
          id: "concept:run",
          summary: "Generated replacement.",
          anchors: [{ file: "missing.ts", role: "usage" }],
          detail: "New generated detail.",
        },
      ],
    },
    index,
    w.getText,
    { actor: "llm" },
  );
  expect(revised.ok).toBe(true);
  if (!revised.ok) throw new Error("revision failed");
  expect(revised.explainer.concepts[0]).toMatchObject({
    summary: "Checked by the author.",
    detail: "New generated detail.",
    anchors: [{ file: "a.ts", span: { from: 1, to: 1 } }],
  });
});

it("groups visible siblings, undoes their exact structure, and preserves references during regeneration", () => {
  const w = makeWorld({ files: [{ path: "a.ts" }, { path: "b.ts" }, { path: "outside.ts" }] });
  const initial = createExplainer({
    title: "Demo",
    repoName: "Demo",
    indexPath: ".explainer/index-c1.json",
    index: w.index,
  });
  const setup = applyPatch(
    initial,
    {
      nodes: [{ id: "grp:outer", label: "Outer", members: ["file:a.ts", "file:b.ts"] }],
      edges: [
        {
          id: "edge:work",
          from: "file:a.ts",
          to: "file:b.ts",
          kind: "calls",
          label: "Work",
          anchors: [
            { file: "a.ts", span: { from: 0, to: 0 }, role: "usage" },
            { file: "b.ts", span: { from: 0, to: 0 }, role: "definition" },
          ],
        },
      ],
      views: [
        {
          id: "view:map",
          type: "graph",
          title: "Map",
          include: ["grp:outer", "file:a.ts", "file:b.ts"],
        },
      ],
      tours: [
        {
          id: "tour:walk",
          title: "Walk",
          steps: [{ id: "walk:1", view: "view:map", focus: ["file:a.ts", "edge:work"] }],
        },
      ],
    },
    w.model,
    w.getText,
    { actor: "llm" },
  );
  if (!setup.ok) throw new Error(JSON.stringify(setup.issues));
  const edits = makeGraphEdits(setup.explainer, w.model, "view:map", {
    type: "group",
    id: "grp:work",
    label: "Work",
    members: ["file:a.ts", "file:b.ts"],
  });
  const saved = applyUserEdits(setup.explainer, edits, w.model, w.getText);
  const model = new ExplainerModel(saved.explainer, w.model);
  expect(
    deriveGraph(model.view("view:map") as GraphView, model).nodes.map((n) => [n.id, n.parent]),
  ).toEqual([
    ["file:a.ts", "grp:work"],
    ["file:b.ts", "grp:work"],
    ["grp:outer", undefined],
    ["grp:work", "grp:outer"],
  ]);
  expect(saved.explainer.edges).toEqual(setup.explainer.edges);
  expect(saved.explainer.tours).toEqual(setup.explainer.tours);
  const refreshed = applyPatch(
    saved.explainer,
    {
      nodes: [{ id: "grp:outer", members: [] }],
      views: [{ id: "view:map", type: "graph", include: [] }],
      remove: ["grp:work"],
    },
    w.model,
    w.getText,
    { actor: "llm" },
  );
  if (!refreshed.ok) throw new Error(JSON.stringify(refreshed.issues));
  expect(refreshed.explainer.nodes).toEqual(saved.explainer.nodes);
  expect(refreshed.explainer.views).toEqual(saved.explainer.views);
  const undone = applyUserEdits(refreshed.explainer, saved.inverse, w.model, w.getText);
  expect(undone.explainer.nodes.map((n) => [n.id, n.members])).toEqual(
    setup.explainer.nodes.map((n) => [n.id, n.members]),
  );
  expect((undone.explainer.views[0] as GraphView).include).toEqual([
    "grp:outer",
    "file:a.ts",
    "file:b.ts",
  ]);
  const redone = applyUserEdits(undone.explainer, undone.inverse, w.model, w.getText);
  expect(redone.explainer.nodes.map((n) => [n.id, n.members])).toEqual(
    saved.explainer.nodes.map((n) => [n.id, n.members]),
  );
});

it("regroups visible children of a hidden container and undoes its exact membership", () => {
  const w = makeWorld({ files: [{ path: "a.ts" }, { path: "b.ts" }, { path: "outside.ts" }] });
  const setup = applyPatch(
    createExplainer({
      title: "Demo",
      repoName: "Demo",
      indexPath: ".explainer/index-c1.json",
      index: w.index,
    }),
    {
      nodes: [
        { id: "grp:old", label: "Old", members: ["file:a.ts", "file:outside.ts", "file:b.ts"] },
      ],
      views: [
        {
          id: "view:map",
          type: "graph",
          title: "Map",
          include: ["grp:old", "file:a.ts", "file:b.ts"],
        },
      ],
    },
    w.model,
    w.getText,
    { actor: "user" },
  );
  if (!setup.ok) throw new Error(JSON.stringify(setup.issues));
  const hidden = applyUserEdits(
    setup.explainer,
    makeGraphEdits(setup.explainer, w.model, "view:map", { type: "hide", ids: ["grp:old"] }),
    w.model,
    w.getText,
  );
  const parents = (explainer: typeof setup.explainer) => {
    const model = new ExplainerModel(explainer, w.model);
    return deriveGraph(model.view("view:map") as GraphView, model).nodes.map((n) => [
      n.id,
      n.parent,
    ]);
  };
  expect(parents(hidden.explainer)).toEqual([
    ["file:a.ts", undefined],
    ["file:b.ts", undefined],
  ]);
  const grouped = applyUserEdits(
    hidden.explainer,
    makeGraphEdits(hidden.explainer, w.model, "view:map", {
      type: "group",
      id: "grp:z-new",
      label: "New",
      members: ["file:a.ts", "file:b.ts"],
    }),
    w.model,
    w.getText,
  );
  expect(parents(grouped.explainer)).toEqual([
    ["file:a.ts", "grp:z-new"],
    ["file:b.ts", "grp:z-new"],
    ["grp:z-new", undefined],
  ]);
  expect(grouped.explainer.nodes.find((n) => n.id === "grp:old")?.members).toEqual([
    "file:outside.ts",
    "grp:z-new",
  ]);
  expect(grouped.explainer.nodes.find((n) => n.id === "grp:z-new")?.parent).toBe("grp:old");
  const undone = applyUserEdits(grouped.explainer, grouped.inverse, w.model, w.getText);
  expect(undone.explainer.nodes.map((n) => [n.id, n.members])).toEqual(
    hidden.explainer.nodes.map((n) => [n.id, n.members]),
  );
  expect(undone.explainer.views).toEqual(hidden.explainer.views);
  expect(parents(undone.explainer)).toEqual([
    ["file:a.ts", undefined],
    ["file:b.ts", undefined],
  ]);
});

it("ungroups inside a hidden parent while retaining containment and exact undo", () => {
  const w = makeWorld({ files: [{ path: "a.ts" }, { path: "b.ts" }] });
  const setup = applyPatch(
    createExplainer({
      title: "Demo",
      repoName: "Demo",
      indexPath: ".explainer/index-c1.json",
      index: w.index,
    }),
    {
      nodes: [
        { id: "grp:old", label: "Old", members: ["grp:inner"] },
        { id: "grp:inner", parent: "grp:old", label: "Inner", members: ["file:a.ts", "file:b.ts"] },
      ],
      views: [
        {
          id: "view:map",
          type: "graph",
          title: "Map",
          include: ["grp:old", "grp:inner"],
          hidden: ["grp:old"],
        },
      ],
    },
    w.model,
    w.getText,
    { actor: "user" },
  );
  if (!setup.ok) throw new Error(JSON.stringify(setup.issues));
  const ungrouped = applyUserEdits(
    setup.explainer,
    makeGraphEdits(setup.explainer, w.model, "view:map", { type: "ungroup", id: "grp:inner" }),
    w.model,
    w.getText,
  );
  const model = new ExplainerModel(ungrouped.explainer, w.model);
  const view = model.view("view:map") as GraphView;
  expect(deriveGraph(view, model).nodes.map((n) => [n.id, n.parent])).toEqual([
    ["file:a.ts", undefined],
    ["file:b.ts", undefined],
  ]);
  expect(deriveGraph({ ...view, hidden: [] }, model).nodes.map((n) => [n.id, n.parent])).toEqual([
    ["file:a.ts", "grp:old"],
    ["file:b.ts", "grp:old"],
    ["grp:old", undefined],
  ]);
  expect(ungrouped.explainer.nodes).toEqual(setup.explainer.nodes);
  const undone = applyUserEdits(ungrouped.explainer, ungrouped.inverse, w.model, w.getText);
  expect(undone.explainer.views).toEqual(setup.explainer.views);
  expect(undone.explainer.nodes).toEqual(setup.explainer.nodes);
});

it("hides and restores derived arrows and stubs without changing evidence, and undo restores absent hidden", () => {
  const w = makeWorld({
    files: [{ path: "a.ts" }, { path: "b.ts" }, { path: "outside.ts" }],
    symbols: [
      { id: "a.ts#run", start: 1, end: 3 },
      { id: "b.ts#run", start: 1, end: 3 },
      { id: "outside.ts#run", start: 1, end: 3 },
    ],
    refs: [
      { from: "a.ts#run", to: "b.ts#run", line: 2 },
      { from: "b.ts#run", to: "outside.ts#run", line: 2 },
    ],
  });
  const initial = createExplainer({
    title: "Demo",
    repoName: "Demo",
    indexPath: ".explainer/index-c1.json",
    index: w.index,
  });
  const setup = applyPatch(
    initial,
    {
      views: [{ id: "view:map", type: "graph", title: "Map", include: ["file:a.ts", "file:b.ts"] }],
    },
    w.model,
    w.getText,
    { actor: "llm" },
  );
  if (!setup.ok) throw new Error(JSON.stringify(setup.issues));
  const graphOf = (e: typeof initial) => {
    const model = new ExplainerModel(e, w.model);
    return deriveGraph(model.view("view:map") as GraphView, model);
  };
  const graph = graphOf(setup.explainer);
  expect(graph.edges.map((e) => e.id)).toEqual(["edge:calls:file:a.ts->file:b.ts"]);
  expect(graph.stubs.map((s) => s.id)).toEqual(["stub:out:file:b.ts->ghost:file:outside.ts"]);
  const ids = [graph.edges[0]!.id, graph.stubs[0]!.id];
  const hidden = applyUserEdits(
    setup.explainer,
    makeGraphEdits(setup.explainer, w.model, "view:map", { type: "hide", ids }),
    w.model,
    w.getText,
  );
  expect(graphOf(hidden.explainer).edges).toEqual([]);
  expect(graphOf(hidden.explainer).stubs).toEqual([]);
  const refresh = applyPatch(
    hidden.explainer,
    { views: [{ id: "view:map", type: "graph", hidden: [] }] },
    w.model,
    w.getText,
    { actor: "llm" },
  );
  if (!refresh.ok) throw new Error(JSON.stringify(refresh.issues));
  expect((refresh.explainer.views[0] as GraphView).hidden).toEqual(ids);
  const restored = applyUserEdits(
    hidden.explainer,
    makeGraphEdits(hidden.explainer, w.model, "view:map", { type: "restore", ids }),
    w.model,
    w.getText,
  );
  expect(graphOf(restored.explainer)).toEqual(graph);
  const undone = applyUserEdits(hidden.explainer, hidden.inverse, w.model, w.getText);
  expect((undone.explainer.views[0] as GraphView).hidden).toBeUndefined();
  expect(graphOf(undone.explainer)).toEqual(graph);
});

it("ungroups only this map, retains links to the stored group, and restores the exact inclusion order", () => {
  const w = makeWorld({ files: [{ path: "a.ts" }, { path: "b.ts" }, { path: "outside.ts" }] });
  const initial = createExplainer({
    title: "Demo",
    repoName: "Demo",
    indexPath: ".explainer/index-c1.json",
    index: w.index,
  });
  const setup = applyPatch(
    initial,
    {
      nodes: [{ id: "grp:work", label: "Work", members: ["file:a.ts", "file:b.ts"] }],
      edges: [
        { id: "edge:work", from: "grp:work", to: "file:outside.ts", kind: "calls", label: "Work" },
      ],
      views: [
        {
          id: "view:map",
          type: "graph",
          title: "Map",
          include: ["file:outside.ts", "grp:work"],
          layout: { "grp:work": { x: 1, y: 2 } },
        },
        { id: "view:other", type: "graph", title: "Other", include: ["grp:work"] },
      ],
      tours: [
        {
          id: "tour:walk",
          title: "Walk",
          steps: [{ id: "walk:1", view: "view:map", focus: ["grp:work"] }],
        },
      ],
    },
    w.model,
    w.getText,
    { actor: "user" },
  );
  if (!setup.ok) throw new Error(JSON.stringify(setup.issues));
  const saved = applyUserEdits(
    setup.explainer,
    makeGraphEdits(setup.explainer, w.model, "view:map", { type: "ungroup", id: "grp:work" }),
    w.model,
    w.getText,
  );
  expect((saved.explainer.views[0] as GraphView).include).toEqual([
    "file:outside.ts",
    "file:a.ts",
    "file:b.ts",
  ]);
  expect(saved.explainer.nodes).toEqual(setup.explainer.nodes);
  expect(saved.explainer.edges).toEqual(setup.explainer.edges);
  expect(saved.explainer.tours).toEqual(setup.explainer.tours);
  expect(saved.explainer.views[1]).toEqual(setup.explainer.views[1]);
  const undone = applyUserEdits(saved.explainer, saved.inverse, w.model, w.getText);
  expect((undone.explainer.views[0] as GraphView).include).toEqual(["file:outside.ts", "grp:work"]);
});

it("refuses group creation undo after enrichment or new references, without removing anything", () => {
  const w = makeWorld({ files: [{ path: "a.ts" }, { path: "b.ts" }] });
  const initial = createExplainer({
    title: "Demo",
    repoName: "Demo",
    indexPath: ".explainer/index-c1.json",
    index: w.index,
  });
  const setup = applyPatch(
    initial,
    {
      views: [{ id: "view:map", type: "graph", title: "Map", include: ["file:a.ts", "file:b.ts"] }],
    },
    w.model,
    w.getText,
    { actor: "llm" },
  );
  if (!setup.ok) throw new Error(JSON.stringify(setup.issues));
  const saved = applyUserEdits(
    setup.explainer,
    makeGraphEdits(setup.explainer, w.model, "view:map", {
      type: "group",
      id: "grp:work",
      label: "Work",
      members: ["file:a.ts", "file:b.ts"],
    }),
    w.model,
    w.getText,
  );
  const enrich = applyPatch(
    saved.explainer,
    { nodes: [{ id: "grp:work", summary: "Another author's summary." }] },
    w.model,
    w.getText,
    { actor: "user" },
  );
  if (!enrich.ok) throw new Error(JSON.stringify(enrich.issues));
  expect(() => applyUserEdits(enrich.explainer, saved.inverse, w.model, w.getText)).toThrow(
    "node changed since this edit",
  );
  const linked = applyPatch(
    saved.explainer,
    {
      tours: [
        {
          id: "tour:walk",
          title: "Walk",
          steps: [{ id: "walk:1", view: "view:map", focus: ["grp:work"] }],
        },
      ],
    },
    w.model,
    w.getText,
    { actor: "user" },
  );
  if (!linked.ok) throw new Error(JSON.stringify(linked.issues));
  expect(() => applyUserEdits(linked.explainer, saved.inverse, w.model, w.getText)).toThrow(
    /grp:work/,
  );
  expect(linked.explainer.nodes.find((n) => n.id === "grp:work")?.members).toEqual([
    "file:a.ts",
    "file:b.ts",
  ]);
});

it("rejects forged graph fields, structural existence edits and invalid group references at the edit boundary", () => {
  const w = makeWorld({ files: [{ path: "a.ts" }, { path: "b.ts" }] });
  const initial = createExplainer({
    title: "Demo",
    repoName: "Demo",
    indexPath: ".explainer/index-c1.json",
    index: w.index,
  });
  const setup = applyPatch(
    initial,
    {
      views: [{ id: "view:map", type: "graph", title: "Map", include: ["file:a.ts", "file:b.ts"] }],
    },
    w.model,
    w.getText,
    { actor: "llm" },
  );
  if (!setup.ok) throw new Error(JSON.stringify(setup.issues));
  const node = { label: "Work", parent: "repo", members: ["file:a.ts", "file:b.ts"], anchors: [] };
  const cases = [
    {
      edit: {
        collection: "views",
        id: "view:map",
        before: { hidden: null },
        after: { scope: { root: "repo" } },
      },
      error: "Invalid or unsupported graph edit field",
    },
    {
      edit: {
        collection: "nodes",
        id: "file:a.ts",
        before: { members: [] },
        after: { members: [] },
      },
      error: "Structural graph fields can only edit groups",
    },
    {
      edit: { collection: "groups", id: "file:a.ts", before: { node: null }, after: { node } },
      error: "Only group nodes support existence edits",
    },
    {
      edit: {
        collection: "groups",
        id: "grp:work",
        before: { node: null },
        after: { node: { ...node, provenance: { origin: "llm" } } },
      },
      error: "Invalid or unsupported edit field: provenance",
    },
    {
      edit: {
        collection: "groups",
        id: "grp:work",
        before: { node: null },
        after: { node: { ...node, members: ["file:absent.ts"] } },
      },
      error: 'member: unknown file "absent.ts"',
    },
  ];
  for (const { edit, error } of cases)
    expect(() => applyUserEdits(setup.explainer, [edit], w.model, w.getText)).toThrow(error);
  expect(setup.explainer.nodes).toEqual([]);
});
