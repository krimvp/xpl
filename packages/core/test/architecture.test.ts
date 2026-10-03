/**
 * Architecture maps (ARCHITECTURE.md §2, amendment 19): `role`, `tech` and `opens` on boxes, boxes for outside
 * systems that have no members (their anchors are their code), arrows to them, the arrows of a service's parts
 * merged into one when the system map shows the service as one box, and the way down and back up.
 */
import { describe, expect, it } from "vitest";
import {
  applyPatch,
  canExpandInPlace,
  deriveGraph,
  expandInPlace,
  ExplainerModel,
  parentLevel,
  validateExplainer,
  zoomTrail,
  type Explainer,
  type ExplainerPatch,
  type GraphView,
} from "../src/index.js";
import { emptyExplainer, jobrunner } from "./helpers.js";

const w = jobrunner();
const F = {
  runner: "file:src/runner.ts",
  queue: "file:src/queue.ts",
  worker: "file:src/worker.ts",
  metrics: "file:src/metrics.ts",
};
/** The code that "talks to the database" in this made-up story: the queue's requeue and the worker's run. */
const QUEUE_SITE = { file: "src/queue.ts", symbol: "Queue.requeue", role: "usage" as const };
const WORKER_SITE = { file: "src/worker.ts", symbol: "Worker.run", role: "usage" as const };

const PATCH: ExplainerPatch = {
  nodes: [
    {
      id: "grp:app",
      label: "Job runner",
      role: "service",
      tech: "TypeScript",
      opens: "view:inside",
      members: [F.runner, F.queue, F.worker, F.metrics],
      summary: "Runs background jobs.",
    },
    {
      id: "grp:db",
      label: "Jobs database",
      role: "database",
      tech: "PostgreSQL",
      summary: "Keeps the jobs.",
      anchors: [QUEUE_SITE, WORKER_SITE],
    },
  ],
  edges: [
    {
      id: "edge:queue-db",
      from: F.queue,
      to: "grp:db",
      kind: "custom",
      label: "stores jobs",
      anchors: [QUEUE_SITE],
    },
    {
      id: "edge:worker-db",
      from: F.worker,
      to: "grp:db",
      kind: "custom",
      label: "reads jobs",
      anchors: [WORKER_SITE],
    },
  ],
  views: [
    {
      id: "view:system",
      type: "graph",
      title: "The job runner and its database",
      include: ["grp:app", "grp:db"],
    },
    {
      id: "view:inside",
      type: "graph",
      title: "Inside the job runner",
      include: [F.runner, F.queue, F.worker, F.metrics, "grp:db"],
    },
  ],
};

function applied(patch: ExplainerPatch = PATCH): Explainer {
  const r = applyPatch(emptyExplainer(), patch, w.index, w.getText, { actor: "llm" });
  expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
  return r.explainer;
}

describe("role, tech and opens", () => {
  it("are stored, and a box with a role needs no members", () => {
    const ex = applied();
    const db = ex.nodes.find((n) => n.id === "grp:db")!;
    expect(db).toMatchObject({ role: "database", tech: "PostgreSQL", members: [] });
    expect(ex.nodes.find((n) => n.id === "grp:app")!.opens).toBe("view:inside");
    expect(validateExplainer(ex, w.index, w.getText)).toEqual([]);
  });

  it("go on a box of code too, and null clears them", () => {
    const ex = applied({
      ...PATCH,
      nodes: [...PATCH.nodes!, { id: F.metrics, role: "component", tech: "event handler" }],
    });
    expect(ex.nodes.find((n) => n.id === F.metrics)).toMatchObject({ role: "component" });
    const cleared = applyPatch(
      ex,
      { nodes: [{ id: F.metrics, role: null, tech: null }] },
      w.index,
      w.getText,
      {
        actor: "llm",
      },
    );
    expect(cleared.explainer.nodes.find((n) => n.id === F.metrics)!.role).toBeUndefined();
  });

  it("reject an unknown role and an opens that names no view", () => {
    const messages = (node: ExplainerPatch["nodes"]) => {
      const r = applyPatch(emptyExplainer(), { nodes: node }, w.index, w.getText, { actor: "llm" });
      expect(r.ok).toBe(false);
      return r.issues.map((i) => i.message).join("\n");
    };
    expect(messages([{ id: "grp:x", label: "X", role: "server" as never }])).toContain(
      "role must be one of",
    );
    expect(messages([{ id: "grp:x", label: "X", role: "external", opens: "view:nope" }])).toContain(
      'opens "view:nope" is not a view of this explainer',
    );
  });

  it("still ask a plain group for members, and warn about a box that points at no code", () => {
    const r = applyPatch(
      emptyExplainer(),
      { nodes: [{ id: "grp:x", label: "X" }] },
      w.index,
      w.getText,
      {
        actor: "llm",
      },
    );
    expect(r.issues.map((i) => i.message).join("\n")).toContain("members");
    const bare = applyPatch(
      emptyExplainer(),
      { nodes: [{ id: "grp:x", label: "X", role: "external" }] },
      w.index,
      w.getText,
      { actor: "llm" },
    );
    expect(bare.ok).toBe(true);
    expect(bare.issues.map((i) => i.message).join("\n")).toContain("points at no code");
  });

  it("let an llm arrow end at an outside system: its anchors are the evidence at that end", () => {
    // an anchor in the worker is in neither end of queue -> db
    const r = applyPatch(
      emptyExplainer(),
      {
        ...PATCH,
        edges: [
          {
            id: "edge:bad",
            from: F.runner,
            to: "grp:db",
            kind: "custom",
            label: "x",
            anchors: [WORKER_SITE],
          },
        ],
      },
      w.index,
      w.getText,
      { actor: "llm" },
    );
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.message).join("\n")).toContain(
      "needs at least one anchor inside its from",
    );
  });
});

describe("the system map", () => {
  it("shows the service as one box, with one arrow for the arrows of its parts", () => {
    const ex = applied();
    const model = new ExplainerModel(ex, w.model);
    const system = ex.views.find((v) => v.id === "view:system") as GraphView;
    const graph = deriveGraph(system, model);
    expect(graph.nodes.map((n) => [n.id, n.role, n.tech, n.opens])).toEqual([
      ["grp:app", "service", "TypeScript", "view:inside"],
      ["grp:db", "database", "PostgreSQL", undefined],
    ]);
    const stored = graph.edges.filter((e) => e.stored);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ from: "grp:app", to: "grp:db", count: 2 });
    // two different labels make none; both arrows' anchors are kept
    expect(stored[0]!.label).toBeUndefined();
    expect(stored[0]!.anchors.map((a) => a.file).sort()).toEqual(["src/queue.ts", "src/worker.ts"]);
  });

  it("shows each part's own arrow on the map of the inside", () => {
    const ex = applied();
    const model = new ExplainerModel(ex, w.model);
    const inside = ex.views.find((v) => v.id === "view:inside") as GraphView;
    const stored = deriveGraph(inside, model).edges.filter((e) => e.stored);
    expect(stored.map((e) => [e.from, e.to, e.label])).toEqual([
      [F.queue, "grp:db", "stores jobs"],
      [F.worker, "grp:db", "reads jobs"],
    ]);
  });
});

describe("zoom levels", () => {
  it("lead from a box down to its view, and back up", () => {
    const model = new ExplainerModel(applied(), w.model);
    expect(parentLevel(model, "view:inside")).toMatchObject({ box: "grp:app" });
    expect(parentLevel(model, "view:system")).toBeUndefined();
    expect(zoomTrail(model, "view:inside").map((l) => [l.view.id, l.box])).toEqual([
      ["view:system", "grp:app"],
    ]);
    expect(zoomTrail(model, "view:system")).toEqual([]);
  });

  it("stop at a cycle", () => {
    const ex = applied({
      ...PATCH,
      nodes: [...PATCH.nodes!, { id: F.runner, opens: "view:system" }],
    });
    const model = new ExplainerModel(ex, w.model);
    expect(zoomTrail(model, "view:inside").map((l) => l.view.id)).toEqual(["view:system"]);
  });
});

describe("opening a box in place", () => {
  it("adds the boxes of the view it opens to this one, without changing the view", () => {
    const ex = applied();
    const model = new ExplainerModel(ex, w.model);
    const system = ex.views.find((v) => v.id === "view:system") as GraphView;
    expect(canExpandInPlace(model, "grp:app")).toBe(true);
    expect(canExpandInPlace(model, "grp:db")).toBe(false);
    expect(expandInPlace(system, model, new Set())).toBe(system);
    const opened = expandInPlace(system, model, new Set(["grp:app"]));
    expect(opened.include).toEqual(["grp:app", "grp:db", F.runner, F.queue, F.worker, F.metrics]);
    expect(system.include).toEqual(["grp:app", "grp:db"]);
    // the parts are members of the service: drawn inside its box, their arrows cross its border
    const graph = deriveGraph(opened, model);
    expect(graph.nodes.find((n) => n.id === F.queue)!.parent).toBe("grp:app");
    expect(graph.nodes.find((n) => n.id === "grp:app")!.container).toBe(true);
    expect(graph.edges.filter((e) => e.stored).map((e) => [e.from, e.to])).toEqual([
      [F.queue, "grp:db"],
      [F.worker, "grp:db"],
    ]);
    // the derived graph says which boxes can be opened in place
    expect(deriveGraph(system, model).nodes.find((n) => n.id === "grp:app")!.expandable).toBe(true);
  });

  it("ignores a box the view does not show", () => {
    const ex = applied();
    const model = new ExplainerModel(ex, w.model);
    const inside = ex.views.find((v) => v.id === "view:inside") as GraphView;
    expect(expandInPlace(inside, model, new Set(["grp:app"]))).toBe(inside);
  });
});
