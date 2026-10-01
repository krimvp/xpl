import { describe, expect, it } from "vitest";
import {
  applyPatch,
  createExplainer,
  validateExplainer,
  type Anchor,
  type ApplyResult,
  type Explainer,
  type ExplainerPatch,
  type GraphView,
  type Issue,
  type SequenceView,
} from "../src/index.js";
import {
  anchor,
  concept,
  edge,
  emptyExplainer,
  graphView,
  group,
  JOBRUNNER,
  jobrunner,
  makeWorld,
  RUNNER_TEXT,
  sequenceView,
  USER,
  type World,
} from "./helpers.js";

const w = jobrunner();
const DISPATCH = "sym:src/runner.ts#Runner.dispatch";
const F = {
  runner: "file:src/runner.ts",
  queue: "file:src/queue.ts",
  worker: "file:src/worker.ts",
  metrics: "file:src/metrics.ts",
};
const OLD = { origin: "llm" as const, commit: "c0" };

const A = {
  dispatchDef: anchor(w, { file: "src/runner.ts", symbol: "Runner.dispatch", role: "definition" }),
  popCall: anchor(w, {
    file: "src/runner.ts",
    symbol: "Runner.dispatch",
    span: { from: 4, to: 4 },
    role: "call-site",
  }),
  popDef: anchor(w, { file: "src/queue.ts", symbol: "Queue.pop", role: "definition" }),
  requeueCall: anchor(w, {
    file: "src/runner.ts",
    symbol: "Runner.dispatch",
    span: { from: 34, to: 36 },
    role: "call-site",
  }),
  requeueDef: anchor(w, { file: "src/queue.ts", symbol: "Queue.requeue", role: "definition" }),
  retryBlock: anchor(w, {
    file: "src/runner.ts",
    symbol: "Runner.dispatch",
    span: { from: 30, to: 41 },
    role: "definition",
  }),
  emit: anchor(w, {
    file: "src/worker.ts",
    symbol: "Worker.run",
    span: { from: 21, to: 21 },
    role: "call-site",
  }),
  handler: anchor(w, { file: "src/metrics.ts", symbol: "onJobCompleted", role: "definition" }),
};

/** A valid explainer with elements of every origin. */
function seed(): Explainer {
  return JSON.parse(
    JSON.stringify(
      emptyExplainer({
        nodes: [
          group("grp:scheduling", [F.runner, F.queue], { provenance: OLD }),
          {
            id: DISPATCH,
            kind: "symbol",
            parent: "sym:src/runner.ts#Runner",
            label: "Runner.dispatch",
            summary: "Typed by the user.",
            anchors: [A.dispatchDef],
            provenance: { origin: "llm", userFields: ["summary"], commit: "c0" },
          },
        ],
        edges: [
          edge("edge:job-completed", F.worker, F.metrics, [A.emit, A.handler], {
            label: "job.completed",
            provenance: OLD,
          }),
        ],
        concepts: [
          concept("concept:retry-policy", [A.retryBlock], { provenance: USER, summary: "Mine." }),
          concept("concept:idem", [], { label: "Idempotency", summary: "old", provenance: OLD }),
        ],
        views: [
          graphView("view:overview", ["grp:scheduling", F.worker], { provenance: OLD }),
          graphView("view:mine", [F.queue], { provenance: USER }),
          sequenceView(
            "view:dispatch",
            [DISPATCH, F.queue, F.worker],
            [
              {
                id: "dispatch:1",
                from: DISPATCH,
                to: F.queue,
                label: "pop()",
                kind: "call",
                anchors: [A.popCall, A.popDef],
              },
              {
                id: "dispatch:2",
                from: DISPATCH,
                to: F.queue,
                label: "requeue()",
                kind: "call",
                anchors: [A.requeueCall, A.requeueDef],
              },
              {
                id: "dispatch:3",
                from: F.queue,
                to: DISPATCH,
                label: "ok",
                kind: "return",
                anchors: [],
              },
            ],
            {
              provenance: OLD,
              frames: [
                {
                  id: "frame:retry",
                  kind: "loop",
                  label: "retry",
                  fromStep: "dispatch:2",
                  toStep: "dispatch:3",
                },
              ],
            },
          ),
        ],
        tours: [
          {
            id: "tour:intro",
            title: "Intro",
            steps: [
              { id: "t1", view: "view:dispatch", focus: ["dispatch:3"], code: [A.requeueCall] },
            ],
          },
        ],
      }),
    ),
  );
}

function apply(
  patch: ExplainerPatch,
  opts: { actor?: "llm" | "user"; explainer?: Explainer; world?: World } = {},
): ApplyResult {
  const ex = opts.explainer ?? seed();
  const world = opts.world ?? w;
  return applyPatch(ex, patch, world.index, world.getText, { actor: opts.actor ?? "llm" });
}
const errorsOf = (r: ApplyResult): Issue[] => r.issues.filter((i) => i.severity === "error");
const warningsOf = (r: ApplyResult): Issue[] => r.issues.filter((i) => i.severity === "warning");
const el = <T extends { id: string }>(list: T[], id: string): T => {
  const found = list.find((e) => e.id === id);
  if (!found) throw new Error(`no ${id}`);
  return found;
};
const view = (ex: Explainer, id: string) => el(ex.views, id);

describe("seed sanity", () => {
  it("is a valid explainer", () => {
    expect(validateExplainer(seed(), w.index, w.getText, { mode: "strict" })).toEqual([]);
  });
});

describe("createExplainer", () => {
  it("binds an empty explainer to an index", () => {
    const ex = createExplainer({
      title: "Job runner",
      repoName: "acme/jobrunner",
      repoUrl: "https://example.com/acme/jobrunner",
      index: w.index,
      indexPath: ".explainer/index-c1.json",
    });
    expect(ex).toEqual({
      schema: "code-explainer@0",
      title: "Job runner",
      repo: { name: "acme/jobrunner", url: "https://example.com/acme/jobrunner", commit: "c1" },
      index: { path: ".explainer/index-c1.json", commit: "c1" },
      nodes: [],
      edges: [],
      concepts: [],
      views: [],
      tours: [],
    });
    expect(validateExplainer(ex, w.index, w.getText)).toEqual([]);
    const bare = createExplainer({ title: "T", repoName: "r", index: w.model, indexPath: "p" });
    expect("url" in bare.repo).toBe(false);
  });

  it("is a valid target for patches from the start", () => {
    const ex = createExplainer({ title: "T", repoName: "r", index: w.index, indexPath: "p" });
    const r = apply({ concepts: [{ id: "concept:x", label: "X" }] }, { explainer: ex });
    expect(r.ok).toBe(true);
    expect(r.explainer.concepts).toHaveLength(1);
  });
});

describe("applyPatch: basics", () => {
  it("an empty patch is a no-op", () => {
    const r = apply({});
    expect(r).toMatchObject({ ok: true, issues: [], changed: [] });
    expect(r.explainer).toEqual(seed());
  });

  it("adds an element, filling in anchors and provenance, and never mutates its inputs", () => {
    const ex = seed();
    const patch: ExplainerPatch = {
      concepts: [
        {
          id: "concept:queueing",
          label: "Queueing",
          summary: "Jobs wait here.",
          anchors: [
            {
              file: "src/runner.ts",
              symbol: "Runner.dispatch",
              find: "await this.queue.requeue(",
              role: "definition",
            },
          ],
        },
      ],
    };
    const frozenEx = JSON.stringify(ex);
    const frozenPatch = JSON.stringify(patch);
    const r = apply(patch, { explainer: ex });
    expect(r.ok).toBe(true);
    expect(r.changed).toEqual(["concept:queueing"]);
    expect(JSON.stringify(ex)).toBe(frozenEx);
    expect(JSON.stringify(patch)).toBe(frozenPatch);
    expect(r.explainer).not.toBe(ex);
    const added = el(r.explainer.concepts, "concept:queueing");
    expect(added).toEqual({
      id: "concept:queueing",
      label: "Queueing",
      summary: "Jobs wait here.",
      anchors: [
        {
          file: "src/runner.ts",
          symbol: "Runner.dispatch",
          span: { from: 34, to: 34 },
          role: "definition",
          hash: expect.stringMatching(/^sha256-v2:[0-9a-f]{12}$/),
          resolved: { commit: "c1", range: { startLine: 76, endLine: 76 }, status: "ok" },
        },
      ],
      provenance: { origin: "llm", commit: "c1" },
    });
    expect(r.explainer.concepts).toHaveLength(3);
    expect(validateExplainer(r.explainer, w.index, w.getText)).toEqual([]);
  });

  it("returns the input untouched on an error", () => {
    const ex = seed();
    const r = apply(
      { concepts: [{ id: "concept:x", label: "X" }, { id: "nope" } as never] },
      { explainer: ex },
    );
    expect(r.ok).toBe(false);
    expect(r.explainer).toBe(ex);
    expect(r.changed).toEqual([]);
    expect(ex.concepts).toHaveLength(2);
  });

  it("accepts a raw SymbolIndex and an IndexModel", () => {
    const a = applyPatch(
      seed(),
      { concepts: [{ id: "concept:x", label: "X" }] },
      w.index,
      w.getText,
      { actor: "llm" },
    );
    const b = applyPatch(
      seed(),
      { concepts: [{ id: "concept:x", label: "X" }] },
      w.model,
      w.getText,
      { actor: "llm" },
    );
    expect(a.explainer).toEqual(b.explainer);
  });

  it("rejects malformed patches", () => {
    for (const bad of [null, [], "x", 5] as never[]) {
      const r = apply(bad);
      expect(r.ok).toBe(false);
      expect(r.issues[0]).toMatchObject({ severity: "error", path: "" });
    }
    expect(apply({ nope: [] } as never).issues[0]).toMatchObject({
      path: "nope",
      severity: "error",
    });
    expect(apply({ nodes: {} } as never).issues[0]).toMatchObject({ path: "nodes" });
    expect(apply({ concepts: [null] } as never).issues[0]).toMatchObject({ path: "concepts[0]" });
    expect(apply({ concepts: [{ label: "x" }] } as never).issues[0]).toMatchObject({
      path: "concepts[0].id",
    });
    expect(apply({}, { actor: "bot" as never }).ok).toBe(false);
    expect(apply({ title: "" }).issues[0]).toMatchObject({ path: "title" });
    expect(apply({ remove: [3] } as never).issues[0]).toMatchObject({ path: "remove" });
    const broken = { ...seed(), nodes: undefined } as never;
    expect(apply({}, { explainer: broken }).ok).toBe(false);
  });

  it("checks fields: unknown names and wrong types are errors that name the allowed set", () => {
    const typo = apply({ concepts: [{ id: "concept:idem", summery: "x" } as never] });
    expect(typo.ok).toBe(false);
    expect(typo.issues[0]).toMatchObject({
      path: "concepts[0].summery",
      elementId: "concept:idem",
    });
    expect(typo.issues[0]!.message).toContain("allowed:");
    expect(
      apply({ concepts: [{ id: "concept:idem", summary: 3 } as never] }).issues[0],
    ).toMatchObject({ path: "concepts[0].summary" });
    expect(
      apply({ nodes: [{ id: "grp:scheduling", members: "x" } as never] }).issues[0],
    ).toMatchObject({ path: "nodes[0].members" });
    expect(
      apply({ edges: [{ id: "edge:job-completed", kind: "flies" } as never] }).issues[0],
    ).toMatchObject({ path: "edges[0].kind" });
    expect(
      apply({ views: [{ id: "view:overview", type: "graph", include: [1] } as never] }).issues[0],
    ).toMatchObject({ path: "views[0].include" });
  });

  it("reports every problem at once", () => {
    const r = apply({
      concepts: [
        { id: "concept:a", label: "A", anchors: [{ file: "src/nope.ts", role: "usage" }] },
        {
          id: "concept:b",
          label: "B",
          anchors: [
            {
              file: "src/runner.ts",
              symbol: "Runner.dispatch",
              find: "nonexistent()",
              role: "usage",
            },
          ],
        },
        { id: "concept:c" },
      ],
    });
    expect(r.ok).toBe(false);
    expect(errorsOf(r).map((i) => [i.path, i.elementId])).toEqual([
      ["concepts[0].anchors[0]", "concept:a"],
      ["concepts[1].anchors[0]", "concept:b"],
      ["concepts[2].label", "concept:c"],
    ]);
  });

  it("is idempotent: the same patch twice changes nothing the second time", () => {
    const patch: ExplainerPatch = {
      nodes: [{ id: "file:src/queue.ts", summary: "The job queue." }],
      concepts: [
        {
          id: "concept:q",
          label: "Queue",
          anchors: [{ file: "src/queue.ts", symbol: "Queue.pop", role: "definition" }],
        },
      ],
      views: [
        { id: "view:overview", type: "graph", include: ["grp:scheduling", F.worker, F.metrics] },
      ],
    };
    const first = apply(patch);
    expect(first.changed).toEqual(["file:src/queue.ts", "concept:q", "view:overview"]);
    const second = apply(patch, { explainer: first.explainer });
    expect(second).toMatchObject({ ok: true, changed: [] });
    expect(second.explainer).toEqual(first.explainer);
  });

  it("warns when the explainer was resolved against another index", () => {
    const ex = seed();
    ex.index.commit = "old";
    const r = apply({}, { explainer: ex });
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([
      expect.objectContaining({ severity: "warning", code: "commit", path: "index.commit" }),
    ]);
  });
});

describe("applyPatch: merging", () => {
  it("shallow-merges onto an existing element: absent fields keep their values", () => {
    const r = apply({ concepts: [{ id: "concept:idem", summary: "new" }] });
    expect(el(r.explainer.concepts, "concept:idem")).toEqual({
      id: "concept:idem",
      label: "Idempotency",
      summary: "new",
      anchors: [],
      provenance: { origin: "llm", commit: "c1" },
    });
    expect(r.changed).toEqual(["concept:idem"]);
  });

  it("null clears an optional field; a required field cannot be cleared", () => {
    const r = apply({ concepts: [{ id: "concept:idem", summary: null }] });
    expect("summary" in el(r.explainer.concepts, "concept:idem")).toBe(false);
    const bad = apply({ concepts: [{ id: "concept:idem", label: null } as never] });
    expect(bad.ok).toBe(false);
    expect(bad.issues[0]).toMatchObject({ path: "concepts[0].label" });
    expect(bad.issues[0]!.message).toContain("cannot be null");
    expect(bad.issues[0]!.message).toContain("summary, detail, related");
    const members = apply({ nodes: [{ id: "grp:scheduling", members: null }] });
    expect(members.ok).toBe(false); // a group needs members: rejected by validation
    expect(
      apply({
        views: [
          { id: "view:overview", type: "graph", hidden: null, layout: null, edgeKinds: null },
        ],
      }).ok,
    ).toBe(true);
    const frames = apply({ views: [{ id: "view:dispatch", type: "sequence", frames: null }] });
    expect("frames" in view(frames.explainer, "view:dispatch")).toBe(false);
  });

  it("arrays and nested objects replace wholesale", () => {
    const r = apply({
      nodes: [{ id: "grp:scheduling", members: [F.queue] }],
      views: [
        {
          id: "view:overview",
          type: "graph",
          include: [F.worker],
          scope: { root: "repo", depth: 2 },
          layout: { [F.worker]: { x: 1, y: 2 } },
        },
      ],
    });
    expect(r.ok).toBe(true);
    expect(el(r.explainer.nodes, "grp:scheduling").members).toEqual([F.queue]);
    const v = view(r.explainer, "view:overview") as GraphView;
    expect(v.include).toEqual([F.worker]);
    expect(v.scope).toEqual({ root: "repo", depth: 2 });
    expect(v.layout).toEqual({ [F.worker]: { x: 1, y: 2 } });
    expect(v.title).toBe("view:overview"); // untouched
    const layout2 = apply(
      { views: [{ id: "view:overview", type: "graph", layout: { [F.queue]: { x: 0, y: 0 } } }] },
      { explainer: r.explainer },
    );
    expect((view(layout2.explainer, "view:overview") as GraphView).layout).toEqual({
      [F.queue]: { x: 0, y: 0 },
    });
  });

  it("does not change kind or type of an existing node or view", () => {
    expect(apply({ nodes: [{ id: DISPATCH, kind: "file" }] }).issues[0]!.message).toContain(
      "cannot change kind of",
    );
    expect(apply({ nodes: [{ id: DISPATCH, kind: "symbol", label: "D" }] }).ok).toBe(true);
    expect(apply({ views: [{ id: "view:overview", type: "sequence" } as never] }).ok).toBe(false);
    const edgeKind = apply({ edges: [{ id: "edge:job-completed", kind: "custom" }] });
    expect(edgeKind.ok).toBe(true); // an edge's kind may change
    expect(el(edgeKind.explainer.edges, "edge:job-completed").kind).toBe("custom");
  });

  it("replaces an element's anchors wholesale", () => {
    const r = apply({
      edges: [
        {
          id: "edge:job-completed",
          anchors: [
            {
              file: "src/worker.ts",
              symbol: "Worker.run",
              span: { from: 21, to: 21 },
              role: "call-site",
            },
            { file: "src/metrics.ts", symbol: "onJobCompleted", role: "definition" },
          ],
        },
      ],
    });
    expect(r.ok).toBe(true);
    expect(el(r.explainer.edges, "edge:job-completed").anchors).toHaveLength(2);
    const cleared = apply(
      { concepts: [{ id: "concept:retry-policy", anchors: [] }] },
      { actor: "user" },
    );
    expect(el(cleared.explainer.concepts, "concept:retry-policy").anchors).toEqual([]);
  });
});

describe("applyPatch: new elements need their required fields", () => {
  it("nodes", () => {
    const group_ = apply({ nodes: [{ id: "grp:x", label: "X" }] });
    expect(group_.ok).toBe(false);
    expect(group_.issues[0]).toMatchObject({ path: "nodes[0].members", elementId: "grp:x" });
    expect(group_.issues[0]!.message).toContain('new node grp:x needs "members"');
    expect(apply({ nodes: [{ id: "grp:x", members: [F.queue] }] }).issues[0]).toMatchObject({
      path: "nodes[0].label",
    });
    const ok = apply({ nodes: [{ id: "grp:x", label: "X", members: [F.queue] }] });
    expect(ok.ok).toBe(true);
    expect(el(ok.explainer.nodes, "grp:x")).toEqual({
      id: "grp:x",
      kind: "group",
      label: "X",
      parent: "repo",
      members: [F.queue],
      anchors: [],
      provenance: { origin: "llm", commit: "c1" },
    });
    expect(apply({ nodes: [{ id: "wat", label: "x" }] }).issues[0]).toMatchObject({
      code: "bad-id",
    });
    expect(
      apply({ nodes: [{ id: "grp:x", kind: "file", label: "X", members: [] }] }).issues[0],
    ).toMatchObject({ path: "nodes[0].kind" });
  });

  it("structural overlays need only an id: kind, label and parent come from the index", () => {
    const r = apply({
      nodes: [
        { id: "file:src/queue.ts", summary: "The job queue." },
        { id: DISPATCH.replace("dispatch", "start"), summary: "Begins." },
      ],
    });
    expect(r.ok).toBe(true);
    expect(el(r.explainer.nodes, "file:src/queue.ts")).toEqual({
      id: "file:src/queue.ts",
      kind: "file",
      label: "queue.ts",
      summary: "The job queue.",
      parent: "dir:src",
      anchors: [],
      provenance: { origin: "llm", commit: "c1" },
    });
    expect(el(r.explainer.nodes, "sym:src/runner.ts#Runner.start")).toMatchObject({
      kind: "symbol",
      label: "Runner.start",
      parent: "sym:src/runner.ts#Runner",
    });
    const labelled = apply({ nodes: [{ id: "dir:src/util", label: "Utilities" }] });
    expect(el(labelled.explainer.nodes, "dir:src/util")).toMatchObject({
      kind: "dir",
      label: "Utilities",
      parent: "dir:src",
    });
  });

  it("structural overlays must exist in the index", () => {
    const r = apply({ nodes: [{ id: "file:src/nope.ts", summary: "x" }] });
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatchObject({ path: "nodes[0].id", code: "unknown-id" });
    expect(apply({ nodes: [{ id: "sym:src/runner.ts#Nope", summary: "x" }] }).ok).toBe(false);
  });

  it("edges", () => {
    for (const missing of ["from", "to", "kind", "label"]) {
      const full: Record<string, unknown> = {
        id: "edge:x",
        from: F.worker,
        to: F.metrics,
        kind: "emits",
        label: "x",
        anchors: [
          { file: "src/worker.ts", role: "call-site" },
          { file: "src/metrics.ts", role: "definition" },
        ],
      };
      delete full[missing];
      const r = apply({ edges: [full as never] });
      expect(r.ok, missing).toBe(false);
      expect(r.issues[0]).toMatchObject({ path: `edges[0].${missing}` });
    }
    expect(
      apply({ edges: [{ id: "job", from: F.worker, to: F.metrics, kind: "emits", label: "x" }] })
        .issues[0],
    ).toMatchObject({ code: "bad-id" });
  });

  it("an edge with a derived-form id takes kind, ends and label from the id", () => {
    const id = `edge:calls:${F.runner}->${F.queue}`;
    const r = apply({
      edges: [
        {
          id,
          summary: "The runner drives the queue.",
          anchors: [
            {
              file: "src/runner.ts",
              symbol: "Runner.dispatch",
              span: { from: 4, to: 4 },
              role: "call-site",
            },
            { file: "src/queue.ts", symbol: "Queue.pop", role: "definition" },
          ],
        },
      ],
    });
    expect(r.ok).toBe(true);
    expect(el(r.explainer.edges, id)).toMatchObject({
      kind: "calls",
      from: F.runner,
      to: F.queue,
      label: "",
      summary: "The runner drives the queue.",
    });
  });

  it("concepts, views and tours", () => {
    expect(apply({ concepts: [{ id: "concept:x" }] }).issues[0]).toMatchObject({
      path: "concepts[0].label",
    });
    expect(
      apply({ views: [{ id: "view:x", type: "graph", include: [] } as never] }).issues[0],
    ).toMatchObject({ path: "views[0].title" });
    expect(
      apply({ views: [{ id: "view:x", type: "graph", title: "X" } as never] }).issues[0],
    ).toMatchObject({ path: "views[0].include" });
    expect(
      apply({ views: [{ id: "view:x", type: "sequence", title: "X", steps: [] } as never] })
        .issues[0],
    ).toMatchObject({ path: "views[0].participants" });
    expect(
      apply({ views: [{ id: "view:x", type: "sequence", title: "X", participants: [] } as never] })
        .issues[0],
    ).toMatchObject({ path: "views[0].steps" });
    expect(
      apply({ views: [{ id: "view:x", title: "X", include: [] } as never] }).issues[0],
    ).toMatchObject({ path: "views[0].type" });
    expect(apply({ tours: [{ id: "tour:x", steps: [] }] }).issues[0]).toMatchObject({
      path: "tours[0].title",
    });
    expect(apply({ tours: [{ id: "tour:x", title: "X" }] }).issues[0]).toMatchObject({
      path: "tours[0].steps",
    });
  });

  it("a new graph view defaults its scope", () => {
    const r = apply({ views: [{ id: "view:x", type: "graph", title: "X", include: [F.queue] }] });
    expect(r.ok).toBe(true);
    expect(view(r.explainer, "view:x")).toEqual({
      id: "view:x",
      type: "graph",
      title: "X",
      scope: { root: "repo", depth: 1 },
      include: [F.queue],
      provenance: { origin: "llm", commit: "c1" },
    });
    expect(
      apply({
        views: [
          {
            id: "view:x",
            type: "graph",
            title: "X",
            include: [],
            scope: { root: "repo" } as never,
          },
        ],
      }).issues[0],
    ).toMatchObject({ path: "views[0].scope" });
  });
});

describe("applyPatch: provenance", () => {
  it("gives new elements { origin: actor, commit: index commit } unless given", () => {
    const llm = apply({ concepts: [{ id: "concept:x", label: "X" }] });
    expect(el(llm.explainer.concepts, "concept:x").provenance).toEqual({
      origin: "llm",
      commit: "c1",
    });
    const user = apply({ concepts: [{ id: "concept:x", label: "X" }] }, { actor: "user" });
    expect(el(user.explainer.concepts, "concept:x").provenance).toEqual({
      origin: "user",
      commit: "c1",
    });
    const given = apply({
      concepts: [{ id: "concept:x", label: "X", provenance: { origin: "static" } }],
    });
    expect(el(given.explainer.concepts, "concept:x").provenance).toEqual({
      origin: "static",
      commit: "c1",
    });
    const commit = apply({
      concepts: [{ id: "concept:x", label: "X", provenance: { commit: "abc" } }],
    });
    expect(el(commit.explainer.concepts, "concept:x").provenance).toEqual({
      origin: "llm",
      commit: "abc",
    });
  });

  it("does not let an llm patch create user-authored elements, or bad provenance", () => {
    const r = apply({
      concepts: [{ id: "concept:x", label: "X", provenance: { origin: "user" } }],
    });
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatchObject({ path: "concepts[0].provenance.origin" });
    expect(
      apply({
        concepts: [{ id: "concept:x", label: "X", provenance: { origin: "robot" } as never }],
      }).ok,
    ).toBe(false);
    expect(
      apply({ concepts: [{ id: "concept:x", label: "X", provenance: "llm" as never }] }).ok,
    ).toBe(false);
    expect(
      apply(
        { concepts: [{ id: "concept:x", label: "X", provenance: { origin: "user" } }] },
        { actor: "user" },
      ).ok,
    ).toBe(true);
  });

  it("sets provenance.commit of a changed llm element to the index commit", () => {
    const r = apply({
      concepts: [{ id: "concept:idem", summary: "new" }],
      edges: [{ id: "edge:job-completed", label: "renamed" }],
    });
    expect(el(r.explainer.concepts, "concept:idem").provenance).toEqual({
      origin: "llm",
      commit: "c1",
    });
    expect(el(r.explainer.edges, "edge:job-completed").provenance).toEqual({
      origin: "llm",
      commit: "c1",
    });
    const v = apply({ views: [{ id: "view:overview", type: "graph", include: [F.worker] }] });
    expect(view(v.explainer, "view:overview").provenance).toEqual({ origin: "llm", commit: "c1" });
  });

  it("leaves an unchanged element (and its commit) alone", () => {
    const r = apply({ concepts: [{ id: "concept:idem", summary: "old", label: "Idempotency" }] });
    expect(r.changed).toEqual([]);
    expect(el(r.explainer.concepts, "concept:idem").provenance).toEqual({
      origin: "llm",
      commit: "c0",
    });
  });

  it("ignores provenance in an llm patch on an existing element", () => {
    const r = apply({
      concepts: [
        {
          id: "concept:idem",
          summary: "new",
          provenance: { origin: "user", userFields: ["label"] },
        },
      ],
    });
    expect(r.ok).toBe(true);
    expect(el(r.explainer.concepts, "concept:idem").provenance).toEqual({
      origin: "llm",
      commit: "c1",
    });
  });
});

describe("applyPatch: user protection", () => {
  it("an llm patch never modifies a user-authored element (skipped with a warning)", () => {
    const r = apply({
      concepts: [
        { id: "concept:retry-policy", summary: "Overwritten?" },
        { id: "concept:new", label: "New" },
      ],
      views: [{ id: "view:mine", type: "graph", include: [F.worker] }],
    });
    expect(r.ok).toBe(true);
    expect(el(r.explainer.concepts, "concept:retry-policy").summary).toBe("Mine.");
    expect((view(r.explainer, "view:mine") as GraphView).include).toEqual([F.queue]);
    expect(r.changed).toEqual(["concept:new"]);
    expect(warningsOf(r).map((i) => [i.path, i.elementId, i.code])).toEqual([
      ["concepts[0]", "concept:retry-policy", "protected"],
      ["views[0]", "view:mine", "protected"],
    ]);
  });

  it("user-authored nodes and edges are protected too", () => {
    const ex = seed();
    ex.nodes.push(group("grp:mine", [F.worker], { provenance: USER }));
    ex.edges.push(edge("edge:mine", F.worker, F.metrics, [], { provenance: USER }));
    const r = apply(
      { nodes: [{ id: "grp:mine", label: "Nope" }], edges: [{ id: "edge:mine", label: "Nope" }] },
      { explainer: ex },
    );
    expect(r.changed).toEqual([]);
    expect(el(r.explainer.nodes, "grp:mine").label).toBe("mine");
    expect(warningsOf(r)).toHaveLength(2);
  });

  it("an llm patch cannot remove user elements", () => {
    const r = apply({ remove: ["concept:retry-policy", "view:mine", "concept:idem"] });
    expect(r.ok).toBe(true);
    expect(r.explainer.concepts.map((c) => c.id)).toEqual(["concept:retry-policy"]);
    expect(r.explainer.views.map((v) => v.id)).toContain("view:mine");
    expect(r.changed).toEqual(["concept:idem"]);
    expect(warningsOf(r).filter((i) => i.code === "protected")).toHaveLength(2);
  });

  it("a user patch may modify and remove user elements", () => {
    const r = apply(
      {
        concepts: [{ id: "concept:retry-policy", summary: "Edited by me." }],
        remove: ["view:mine"],
      },
      { actor: "user" },
    );
    expect(r.ok).toBe(true);
    const c = el(r.explainer.concepts, "concept:retry-policy");
    expect(c.summary).toBe("Edited by me.");
    expect(c.provenance).toEqual({ origin: "user" }); // no userFields on user elements; commit not bumped
    expect(r.explainer.views.map((v) => v.id)).not.toContain("view:mine");
  });

  it("an llm patch keeps the fields listed in userFields and updates the rest", () => {
    const r = apply({ nodes: [{ id: DISPATCH, summary: "LLM rewrite", label: "Dispatch loop" }] });
    expect(r.ok).toBe(true);
    const n = el(r.explainer.nodes, DISPATCH);
    expect(n.summary).toBe("Typed by the user.");
    expect(n.label).toBe("Dispatch loop");
    expect(n.provenance).toEqual({ origin: "llm", userFields: ["summary"], commit: "c1" });
    expect(warningsOf(r)).toEqual([
      expect.objectContaining({ code: "protected", path: "nodes[0].summary" }),
    ]);
    // nulls and anchors are fields too
    const ex = seed();
    el(ex.nodes, DISPATCH).provenance.userFields = ["summary", "anchors"];
    const p = apply(
      {
        nodes: [
          {
            id: DISPATCH,
            summary: null,
            anchors: [{ file: "src/runner.ts", symbol: "Runner.dispatch", role: "usage" }],
          },
        ],
      },
      { explainer: ex },
    );
    expect(el(p.explainer.nodes, DISPATCH).summary).toBe("Typed by the user.");
    expect(el(p.explainer.nodes, DISPATCH).anchors).toEqual([A.dispatchDef]);
    expect(p.changed).toEqual([]);
  });

  it("a user edit of an llm element adds the changed fields to userFields", () => {
    const first = apply(
      { concepts: [{ id: "concept:idem", summary: "mine", label: "Idempotency" }] },
      { actor: "user" },
    );
    expect(first.ok).toBe(true);
    let c = el(first.explainer.concepts, "concept:idem");
    expect(c.provenance).toEqual({ origin: "llm", commit: "c0", userFields: ["summary"] }); // label was unchanged
    const second = apply(
      { concepts: [{ id: "concept:idem", detail: "more" }] },
      { explainer: first.explainer, actor: "user" },
    );
    c = el(second.explainer.concepts, "concept:idem");
    expect(c.provenance.userFields).toEqual(["summary", "detail"]);
    expect(c.provenance.commit).toBe("c0"); // user edits do not bump the commit
    // and the llm now leaves both alone
    const llm = apply(
      { concepts: [{ id: "concept:idem", summary: "x", detail: "y", label: "Idem" }] },
      { explainer: second.explainer },
    );
    c = el(llm.explainer.concepts, "concept:idem");
    expect([c.summary, c.detail, c.label]).toEqual(["mine", "more", "Idem"]);
    expect(warningsOf(llm).map((i) => i.path)).toEqual([
      "concepts[0].summary",
      "concepts[0].detail",
    ]);
  });

  it("clearing a field as the user marks it too; static elements are treated like llm ones", () => {
    const cleared = apply({ concepts: [{ id: "concept:idem", summary: null }] }, { actor: "user" });
    const c = el(cleared.explainer.concepts, "concept:idem");
    expect("summary" in c).toBe(false);
    expect(c.provenance.userFields).toEqual(["summary"]);
    const ex = seed();
    el(ex.concepts, "concept:idem").provenance = { origin: "static" };
    const s = apply(
      { concepts: [{ id: "concept:idem", label: "Renamed" }] },
      { explainer: ex, actor: "user" },
    );
    expect(el(s.explainer.concepts, "concept:idem").provenance).toEqual({
      origin: "static",
      userFields: ["label"],
    });
  });

  it("a user edit of a view records include / hidden / layout as user fields, and the llm respects them", () => {
    const edit = apply(
      {
        views: [
          {
            id: "view:overview",
            type: "graph",
            include: ["grp:scheduling", F.worker, F.metrics],
            layout: { [F.worker]: { x: 5, y: 5 } },
          },
        ],
      },
      { actor: "user" },
    );
    const v = view(edit.explainer, "view:overview");
    expect(v.provenance).toEqual({
      origin: "llm",
      commit: "c0",
      userFields: ["include", "layout"],
    });
    const regen = apply(
      { views: [{ id: "view:overview", type: "graph", include: [F.queue], title: "Overview!" }] },
      { explainer: edit.explainer },
    );
    const after = view(regen.explainer, "view:overview") as GraphView;
    expect(after.include).toEqual(["grp:scheduling", F.worker, F.metrics]);
    expect(after.title).toBe("Overview!");
  });

  it("a user patch may set provenance explicitly (adopting an element)", () => {
    const r = apply(
      { concepts: [{ id: "concept:idem", provenance: { origin: "user" } }] },
      { actor: "user" },
    );
    expect(el(r.explainer.concepts, "concept:idem").provenance).toEqual({
      origin: "user",
      commit: "c0",
    });
    // ...after which the llm cannot touch it
    const llm = apply(
      { concepts: [{ id: "concept:idem", summary: "x" }] },
      { explainer: r.explainer },
    );
    expect(llm.changed).toEqual([]);
  });
});

describe("applyPatch: remove respects userFields", () => {
  const protectedOf = (r: ApplyResult) =>
    warningsOf(r)
      .filter((i) => i.code === "protected")
      .map((i) => [i.path, i.elementId]);

  it("an llm patch cannot remove an element that carries userFields: skipped with a warning", () => {
    // DISPATCH is an llm overlay whose summary the user typed (userFields: summary)
    const r = apply({ remove: [DISPATCH, "concept:idem"] });
    expect(r.ok).toBe(true);
    expect(r.explainer.nodes.map((n) => n.id)).toContain(DISPATCH);
    expect(r.explainer.concepts.map((c) => c.id)).toEqual(["concept:retry-policy"]);
    expect(r.changed).toEqual(["concept:idem"]);
    expect(protectedOf(r)).toEqual([["remove[0]", DISPATCH]]);
    expect(warningsOf(r)[0]!.message).toBe(
      `${DISPATCH} has fields edited by the user (summary); an llm patch cannot remove it (skipped)`,
    );
  });

  it("covers edges, concepts and views too, whichever field the user edited", () => {
    const ex = seed();
    el(ex.edges, "edge:job-completed").provenance = { ...OLD, userFields: ["label"] };
    el(ex.concepts, "concept:idem").provenance = { ...OLD, userFields: ["detail"] };
    view(ex, "view:overview").provenance = { ...OLD, userFields: ["layout"] };
    const r = apply(
      { remove: ["edge:job-completed", "concept:idem", "view:overview"] },
      { explainer: ex },
    );
    expect(r.changed).toEqual([]);
    expect(r.explainer.edges).toHaveLength(1);
    expect(r.explainer.concepts).toHaveLength(2);
    expect(r.explainer.views.map((v) => v.id)).toContain("view:overview");
    expect(protectedOf(r)).toEqual([
      ["remove[0]", "edge:job-completed"],
      ["remove[1]", "concept:idem"],
      ["remove[2]", "view:overview"],
    ]);
    // the user, on the other hand, may remove all of them
    const asUser = apply(
      { remove: ["edge:job-completed", "concept:idem", "view:overview"] },
      { explainer: ex, actor: "user" },
    );
    expect(asUser.changed).toEqual(["edge:job-completed", "concept:idem", "view:overview"]);
    expect(protectedOf(asUser)).toEqual([]);
  });

  it("an element without userFields is still removable by an llm patch", () => {
    const ex = seed();
    el(ex.concepts, "concept:idem").provenance = { ...OLD, userFields: [] };
    const r = apply({ remove: ["concept:idem"] }, { explainer: ex });
    expect(r.changed).toEqual(["concept:idem"]);
  });

  it("single steps of a view whose steps the user edited are protected; other user fields do not matter", () => {
    const ex = seed();
    view(ex, "view:dispatch").provenance = { ...OLD, userFields: ["steps"] };
    const r = apply({ remove: ["dispatch:1"] }, { explainer: ex });
    expect((view(r.explainer, "view:dispatch") as SequenceView).steps).toHaveLength(3);
    expect(r.changed).toEqual([]);
    expect(protectedOf(r)).toEqual([["remove[0]", "dispatch:1"]]);
    expect(warningsOf(r)[0]!.message).toBe(
      "dispatch:1 belongs to a view whose steps were edited by the user; an llm patch cannot remove it (skipped)",
    );
    const asUser = apply({ remove: ["dispatch:1"] }, { explainer: ex, actor: "user" });
    expect((view(asUser.explainer, "view:dispatch") as SequenceView).steps).toHaveLength(2);

    // the user only retitled the view: its steps are still the llm's to remove
    const retitled = seed();
    view(retitled, "view:dispatch").provenance = { ...OLD, userFields: ["title"] };
    const ok = apply({ remove: ["dispatch:1"] }, { explainer: retitled });
    expect((view(ok.explainer, "view:dispatch") as SequenceView).steps).toHaveLength(2);
    expect(ok.changed).toEqual(["dispatch:1"]);
    // ...but the view as a whole carries a user field and cannot be removed
    const whole = apply({ remove: ["view:dispatch"] }, { explainer: retitled });
    expect(whole.changed).toEqual([]);
    expect(protectedOf(whole)).toEqual([["remove[0]", "view:dispatch"]]);
  });

  it("a protected removal alone leaves the explainer as it was", () => {
    const r = apply({ remove: [DISPATCH] });
    expect(r).toMatchObject({ ok: true, changed: [] });
    expect(r.explainer).toEqual(seed());
  });
});

describe("applyPatch: includeAdd and includeRemove", () => {
  const includeOf = (r: ApplyResult, id = "view:overview") =>
    (view(r.explainer, id) as GraphView).include;
  const edit = (over: Record<string, unknown>) =>
    ({ views: [{ id: "view:overview", type: "graph", ...over }] }) as ExplainerPatch;

  it("includeAdd appends what is missing, in the order given, and is never stored", () => {
    const r = apply(edit({ includeAdd: [F.metrics, F.worker, F.queue] }));
    expect(r.ok).toBe(true);
    expect(includeOf(r)).toEqual(["grp:scheduling", F.worker, F.metrics, F.queue]);
    expect(r.changed).toEqual(["view:overview"]);
    const stored = view(r.explainer, "view:overview") as unknown as Record<string, unknown>;
    expect("includeAdd" in stored).toBe(false);
    expect("includeRemove" in stored).toBe(false);
    expect(validateExplainer(r.explainer, w.index, w.getText)).toEqual([]);
    // the commit of a changed llm view moves with it, like any other edit
    expect(view(r.explainer, "view:overview").provenance).toEqual({ origin: "llm", commit: "c1" });
  });

  it("includeRemove removes; ids that are not in the list are warnings, not errors", () => {
    const r = apply(edit({ includeRemove: [F.worker, F.queue] }));
    expect(r.ok).toBe(true);
    expect(includeOf(r)).toEqual(["grp:scheduling"]);
    expect(warningsOf(r)).toEqual([
      expect.objectContaining({
        path: "views[0].includeRemove[1]",
        elementId: "view:overview",
        message: `${F.queue} is not in the include of view:overview; nothing to remove`,
      }),
    ]);
  });

  it("applies include first, then includeRemove, then includeAdd", () => {
    const r = apply(
      edit({
        include: ["grp:scheduling", F.worker, F.metrics],
        includeRemove: [F.worker],
        includeAdd: [F.queue, F.runner],
      }),
    );
    expect(includeOf(r)).toEqual(["grp:scheduling", F.metrics, F.queue, F.runner]);
  });

  it("is idempotent: the same edit twice changes nothing the second time", () => {
    const patch = edit({ includeAdd: [F.queue], includeRemove: [F.worker] });
    const first = apply(patch);
    expect(first.changed).toEqual(["view:overview"]);
    const second = apply(patch, { explainer: first.explainer });
    expect(second.changed).toEqual([]);
    expect(includeOf(second)).toEqual(includeOf(first));
  });

  it("checks the ids like include: unknown ones are errors pointing into includeAdd", () => {
    const r = apply(edit({ includeAdd: [F.queue, "file:src/queue.tz", "src/runner.ts"] }));
    expect(r.ok).toBe(false);
    expect(r.explainer).toEqual(seed());
    expect(errorsOf(r).map((i) => [i.path, i.elementId])).toEqual([
      ["views[0].includeAdd[1]", "view:overview"],
      ["views[0].includeAdd[2]", "view:overview"],
    ]);
    expect(errorsOf(r)[0]!.message).toContain("src/queue.tz");
    expect(errorsOf(r)[1]!.message).toContain("did you mean file:src/runner.ts?");
    // an id that only the patch's own groups make valid is fine
    const withGroup = apply({
      nodes: [{ id: "grp:new", label: "New", members: [F.metrics] }],
      views: [{ id: "view:overview", type: "graph", includeAdd: ["grp:new"] }],
    });
    expect(withGroup.ok).toBe(true);
    expect(includeOf(withGroup)).toContain("grp:new");
  });

  it("may remove an id that vanished from the index: that is how a stale entry is dropped", () => {
    const ex = seed();
    (view(ex, "view:overview") as GraphView).include.push("sym:src/runner.ts#Runner.gone");
    // the stale entry is an error of the explainer as it is, and blocks patches that touch the view...
    expect(apply(edit({ includeAdd: [F.queue] }), { explainer: ex }).ok).toBe(false);
    // ...unless the same patch removes it
    const r = apply(
      edit({ includeRemove: ["sym:src/runner.ts#Runner.gone"], includeAdd: [F.queue] }),
      { explainer: ex },
    );
    expect(r.ok).toBe(true);
    expect(includeOf(r)).toEqual(["grp:scheduling", F.worker, F.queue]);
    expect(warningsOf(r)).toEqual([]);
  });

  it("an id in both lists is an error", () => {
    const r = apply(edit({ includeAdd: [F.queue], includeRemove: [F.queue] }));
    expect(r.ok).toBe(false);
    expect(errorsOf(r)).toEqual([
      expect.objectContaining({ path: "views[0].includeRemove[0]", elementId: "view:overview" }),
    ]);
    expect(errorsOf(r)[0]!.message).toContain("both includeAdd and includeRemove");
  });

  it("rejects wrong types, and sequence views have no such fields", () => {
    expect(apply(edit({ includeAdd: "file:src/queue.ts" })).issues[0]).toMatchObject({
      path: "views[0].includeAdd",
      severity: "error",
    });
    expect(apply(edit({ includeRemove: [1] })).issues[0]).toMatchObject({
      path: "views[0].includeRemove",
    });
    expect(apply(edit({ includeAdd: null })).issues[0]!.message).toContain("cannot be null");
    const seq = apply({
      views: [{ id: "view:dispatch", type: "sequence", includeAdd: [F.queue] } as never],
    });
    expect(seq.ok).toBe(false);
    expect(seq.issues[0]).toMatchObject({ path: "views[0].includeAdd" });
    expect(seq.issues[0]!.message).toContain("unknown field");
  });

  it("a new view may use includeAdd instead of include", () => {
    const r = apply({
      views: [{ id: "view:fresh", type: "graph", title: "Fresh", includeAdd: [F.queue, F.queue] }],
    });
    expect(r.ok).toBe(true);
    expect(includeOf(r, "view:fresh")).toEqual([F.queue]);
    const missing = apply({ views: [{ id: "view:none", type: "graph", title: "No nodes" }] });
    expect(missing.ok).toBe(false);
    expect(missing.issues[0]!.message).toContain('needs "include"');
  });

  describe("when the user edited include", () => {
    const curated = (): Explainer => {
      const ex = seed();
      view(ex, "view:overview").provenance = {
        origin: "llm",
        commit: "c0",
        userFields: ["include", "layout"],
      };
      return ex;
    };

    it("includeAdd still works for an llm patch: it only adds", () => {
      const r = apply(edit({ includeAdd: [F.queue, F.metrics] }), { explainer: curated() });
      expect(r.ok).toBe(true);
      expect(includeOf(r)).toEqual(["grp:scheduling", F.worker, F.queue, F.metrics]);
      expect(r.changed).toEqual(["view:overview"]);
      expect(warningsOf(r)).toEqual([]);
      // still the user's field: their curation keeps winning over a resent include
      expect(view(r.explainer, "view:overview").provenance).toEqual({
        origin: "llm",
        commit: "c1",
        userFields: ["include", "layout"],
      });
    });

    it("includeRemove and a whole include are skipped with a protected warning", () => {
      const r = apply(
        edit({ include: [F.runner], includeRemove: [F.worker], includeAdd: [F.queue] }),
        { explainer: curated() },
      );
      expect(r.ok).toBe(true);
      expect(includeOf(r)).toEqual(["grp:scheduling", F.worker, F.queue]);
      expect(warningsOf(r).map((i) => [i.code, i.path])).toEqual([
        ["protected", "views[0].include"],
        ["protected", "views[0].includeRemove"],
      ]);
      expect(warningsOf(r)[1]!.message).toContain("includeAdd still works");
    });

    it("includeRemove alone changes nothing", () => {
      const r = apply(edit({ includeRemove: [F.worker] }), { explainer: curated() });
      expect(r.changed).toEqual([]);
      expect(includeOf(r)).toEqual(["grp:scheduling", F.worker]);
      expect(protectedOnly(r)).toEqual(["views[0].includeRemove"]);
    });

    it("a user patch is not held back, and an edit through the ops marks include as the user's", () => {
      const r = apply(edit({ includeRemove: [F.worker] }), {
        explainer: curated(),
        actor: "user",
      });
      expect(includeOf(r)).toEqual(["grp:scheduling"]);
      const plain = apply(edit({ includeAdd: [F.queue] }), { actor: "user" });
      expect(view(plain.explainer, "view:overview").provenance).toEqual({
        origin: "llm",
        commit: "c0",
        userFields: ["include"],
      });
    });

    it("a user-authored view is skipped whole, includeAdd or not", () => {
      const r = apply({
        views: [{ id: "view:mine", type: "graph", includeAdd: [F.worker] }],
      });
      expect(r.changed).toEqual([]);
      expect((view(r.explainer, "view:mine") as GraphView).include).toEqual([F.queue]);
      expect(protectedOnly(r)).toEqual(["views[0]"]);
    });
  });

  function protectedOnly(r: ApplyResult): string[] {
    return warningsOf(r)
      .filter((i) => i.code === "protected")
      .map((i) => i.path);
  }
});

describe("applyPatch: stubs", () => {
  const stubsOf = (r: ApplyResult) => (view(r.explainer, "view:overview") as GraphView).stubs;

  it("stores the stub policy of a graph view, replaces it, and null clears it", () => {
    const set = apply({
      views: [{ id: "view:overview", type: "graph", stubs: { mode: "top", max: 4 } }],
    });
    expect(set.ok).toBe(true);
    expect(stubsOf(set)).toEqual({ mode: "top", max: 4 });
    expect(set.changed).toEqual(["view:overview"]);
    const replaced = apply(
      { views: [{ id: "view:overview", type: "graph", stubs: { mode: "none" } }] },
      { explainer: set.explainer },
    );
    expect(stubsOf(replaced)).toEqual({ mode: "none" });
    const cleared = apply(
      { views: [{ id: "view:overview", type: "graph", stubs: null }] },
      { explainer: set.explainer },
    );
    expect("stubs" in view(cleared.explainer, "view:overview")).toBe(false);
    // a new view may carry it
    const created = apply({
      views: [
        { id: "view:new", type: "graph", title: "New", include: [F.queue], stubs: { mode: "all" } },
      ],
    });
    expect((view(created.explainer, "view:new") as GraphView).stubs).toEqual({ mode: "all" });
  });

  it("rejects what is not a policy, pointing into the patch", () => {
    const bad = (stubs: unknown) =>
      errorsOf(apply({ views: [{ id: "view:overview", type: "graph", stubs } as never] }));
    expect(bad("top")[0]).toMatchObject({ path: "views[0].stubs" });
    expect(bad({ mode: "some" }).map((i) => i.path)).toEqual(["views[0].stubs.mode"]);
    expect(bad({ max: -1 }).map((i) => i.path)).toEqual(["views[0].stubs.max"]);
    expect(bad({ max: 2.5 }).map((i) => i.path)).toEqual(["views[0].stubs.max"]);
    // an unknown key is a warning, the rest of the policy still counts
    const warned = apply({
      views: [{ id: "view:overview", type: "graph", stubs: { limit: 3 } } as never],
    });
    expect(warned.ok).toBe(true);
    expect(warningsOf(warned).map((i) => [i.path, i.message])).toEqual([
      ["views[0].stubs.limit", 'unknown field "limit" in stubs (mode, max)'],
    ]);
    expect(bad({ mode: "top", max: 0 })).toEqual([]);
    // sequence views have none
    expect(
      errorsOf(
        apply({ views: [{ id: "view:dispatch", type: "sequence", stubs: {} } as never] }),
      )[0]!.message,
    ).toContain('unknown field "stubs"');
  });

  it("is a field of the view the user can own: an llm patch keeps it", () => {
    const user = apply(
      { views: [{ id: "view:overview", type: "graph", stubs: { mode: "all" } }] },
      { actor: "user" },
    );
    expect(
      (view(user.explainer, "view:overview").provenance as { userFields?: string[] }).userFields,
    ).toEqual(["stubs"]);
    const llm = apply(
      { views: [{ id: "view:overview", type: "graph", stubs: { mode: "none" } }] },
      { explainer: user.explainer },
    );
    expect(stubsOf(llm)).toEqual({ mode: "all" });
    expect(warningsOf(llm).some((i) => i.code === "protected")).toBe(true);
  });
});

describe("applyPatch: excludeFiles", () => {
  const patch = (over: Record<string, unknown>) =>
    ({ views: [{ id: "view:overview", type: "graph", ...over }] }) as ExplainerPatch;

  it("stores the glob list on a graph view, replaces it, and null clears it", () => {
    const set = apply(patch({ excludeFiles: ["**/*.test.ts", "test/**"] }));
    expect(set.ok).toBe(true);
    expect((view(set.explainer, "view:overview") as GraphView).excludeFiles).toEqual([
      "**/*.test.ts",
      "test/**",
    ]);
    const replaced = apply(patch({ excludeFiles: ["docs/**"] }), { explainer: set.explainer });
    expect((view(replaced.explainer, "view:overview") as GraphView).excludeFiles).toEqual([
      "docs/**",
    ]);
    const cleared = apply(patch({ excludeFiles: null }), { explainer: set.explainer });
    expect("excludeFiles" in view(cleared.explainer, "view:overview")).toBe(false);
    expect(cleared.changed).toEqual(["view:overview"]);
  });

  it("can be given when a view is created", () => {
    const r = apply({
      views: [
        { id: "view:fresh", type: "graph", title: "F", include: [F.queue], excludeFiles: ["x/**"] },
      ],
    });
    expect((view(r.explainer, "view:fresh") as GraphView).excludeFiles).toEqual(["x/**"]);
  });

  it("rejects non-string lists and warns about patterns that cannot match", () => {
    expect(apply(patch({ excludeFiles: "**/test/**" })).issues[0]).toMatchObject({
      path: "views[0].excludeFiles",
      severity: "error",
    });
    expect(apply(patch({ excludeFiles: [1] })).ok).toBe(false);
    const smelly = apply(patch({ excludeFiles: ["/src/**", "./test/**", "", "a\\b"] }));
    expect(smelly.ok).toBe(true);
    expect(warningsOf(smelly).map((i) => i.path)).toEqual([
      "views[0].excludeFiles[0]",
      "views[0].excludeFiles[1]",
      "views[0].excludeFiles[2]",
      "views[0].excludeFiles[3]",
    ]);
    expect(warningsOf(smelly)[0]!.message).toContain("drop the leading");
  });

  it("is a field of the view the user can own: an llm patch keeps it", () => {
    const ex = seed();
    (view(ex, "view:overview") as GraphView).excludeFiles = ["mine/**"];
    view(ex, "view:overview").provenance = { ...OLD, userFields: ["excludeFiles"] };
    const r = apply(patch({ excludeFiles: ["other/**"] }), { explainer: ex });
    expect((view(r.explainer, "view:overview") as GraphView).excludeFiles).toEqual(["mine/**"]);
    expect(warningsOf(r)[0]).toMatchObject({ code: "protected", path: "views[0].excludeFiles" });
  });
});

describe("applyPatch: anchors", () => {
  it("reports anchor errors with their location in the patch", () => {
    const r = apply({
      views: [
        {
          id: "view:dispatch",
          type: "sequence",
          steps: [
            {
              id: "dispatch:1",
              from: DISPATCH,
              to: F.queue,
              label: "pop()",
              kind: "call",
              anchors: [
                {
                  file: "src/runner.ts",
                  symbol: "Runner.dispatch",
                  span: { from: 4, to: 4 },
                  role: "call-site",
                },
                { file: "src/queue.ts", symbol: "Queue.popp", role: "definition" },
              ],
            },
          ],
          frames: null,
        },
      ],
      tours: [
        {
          id: "tour:intro",
          steps: [
            {
              id: "t1",
              view: "view:dispatch",
              focus: [],
              code: [
                {
                  file: "src/runner.ts",
                  symbol: "Runner.dispatch",
                  span: { from: 0, to: 99 },
                  role: "usage",
                },
              ],
            },
          ],
        },
      ],
    });
    expect(r.ok).toBe(false);
    const errs = errorsOf(r);
    expect(errs.map((i) => i.path)).toEqual([
      "views[0].steps[0].anchors[1]",
      "tours[0].steps[0].code[0]",
    ]);
    expect(errs[0]!.message).toContain(
      'Did you mean: sym:src/queue.ts#Queue.pop (anchor: file: "src/queue.ts", symbol: "Queue.pop")',
    );
    expect(errs[1]!.message).toContain("outside");
    expect(errs[0]!.elementId).toBe("dispatch:1"); // a step's anchors belong to the step
    expect(errs[1]!.elementId).toBe("tour:intro");
  });

  it("accepts a stored anchor's hash when it is current, and rejects it when stale", () => {
    const good = apply({ concepts: [{ id: "concept:x", label: "X", anchors: [A.retryBlock] }] });
    expect(good.ok).toBe(true);
    const stale = apply({
      concepts: [
        {
          id: "concept:x",
          label: "X",
          anchors: [{ ...A.retryBlock, hash: "sha256:000000000000" }],
        },
      ],
    });
    expect(stale.ok).toBe(false);
    expect(stale.issues[0]!.message).toContain("stale");
  });

  it("rejects ambiguous and absent find text with the anchor's own error", () => {
    const many = apply({
      concepts: [
        {
          id: "concept:x",
          label: "X",
          anchors: [
            { file: "src/runner.ts", symbol: "Runner.dispatch", find: "this.queue", role: "usage" },
          ],
        },
      ],
    });
    expect(many.issues[0]!.message).toContain("occurs");
    const none = apply({
      concepts: [
        {
          id: "concept:x",
          label: "X",
          anchors: [{ file: "src/runner.ts", find: "definitely not there", role: "usage" }],
        },
      ],
    });
    expect(none.issues[0]!.message).toContain("not found");
  });

  it("anchors given as {anchors: null} or a non-array are errors", () => {
    expect(
      apply({ concepts: [{ id: "concept:idem", anchors: null } as never] }).issues[0],
    ).toMatchObject({ path: "concepts[0].anchors" });
    expect(
      apply({ concepts: [{ id: "concept:idem", anchors: "x" } as never] }).issues[0],
    ).toMatchObject({ path: "concepts[0].anchors" });
  });
});

describe("applyPatch: atomicity and validation", () => {
  it("applies nothing when any element fails", () => {
    const ex = seed();
    const r = apply(
      {
        concepts: [{ id: "concept:good", label: "Good" }],
        nodes: [{ id: "grp:bad", label: "Bad" }],
      },
      { explainer: ex },
    );
    expect(r.ok).toBe(false);
    expect(r.explainer).toBe(ex);
    expect(ex.concepts.map((c) => c.id)).toEqual(["concept:retry-policy", "concept:idem"]);
  });

  it("rejects patches that introduce validation errors, pointing into the patch", () => {
    const r = apply({
      concepts: [{ id: "concept:x", label: "X", related: [DISPATCH, "file:src/nope.ts"] }],
    });
    expect(r.ok).toBe(false);
    expect(errorsOf(r)).toEqual([
      expect.objectContaining({
        path: "concepts[0].related[1]",
        elementId: "concept:x",
        code: "unknown-id",
      }),
    ]);
    expect(r.explainer.concepts).toHaveLength(2);
    const overlay = apply({ edges: [{ id: "edge:job-completed", from: "file:src/gone.ts" }] });
    expect(errorsOf(overlay)[0]).toMatchObject({ path: "edges[0].from" });
    const view_ = apply({
      views: [{ id: "view:overview", type: "graph", include: ["file:src/gone.ts"] }],
    });
    expect(errorsOf(view_)[0]).toMatchObject({
      path: "views[0].include[0]",
      elementId: "view:overview",
    });
    const step = apply({
      views: [
        {
          id: "view:dispatch",
          type: "sequence",
          steps: [{ id: "dispatch:1", from: DISPATCH, to: F.metrics, label: "x", kind: "call" }],
        },
      ],
    });
    expect(errorsOf(step).some((i) => i.path === "views[0].steps[0].to")).toBe(true);
  });

  it("enforces the llm-edge evidence rule", () => {
    const noEvidence = apply({
      edges: [{ id: "edge:new", from: F.worker, to: F.metrics, kind: "emits", label: "x" }],
    });
    expect(noEvidence.ok).toBe(false);
    expect(errorsOf(noEvidence).map((i) => i.code)).toEqual(["evidence", "evidence"]);
    expect(errorsOf(noEvidence)[0]).toMatchObject({
      path: "edges[0].anchors",
      elementId: "edge:new",
    });
    const one = apply({
      edges: [
        {
          id: "edge:new",
          from: F.worker,
          to: F.metrics,
          kind: "emits",
          label: "x",
          anchors: [{ file: "src/worker.ts", symbol: "Worker.run", find: "", role: "call-site" }],
        },
      ],
    });
    expect(one.ok).toBe(false);
    const withEvidence = apply({
      edges: [
        {
          id: "edge:new",
          from: F.worker,
          to: F.metrics,
          kind: "emits",
          label: "x",
          anchors: [
            {
              file: "src/worker.ts",
              symbol: "Worker.run",
              span: { from: 21, to: 21 },
              role: "call-site",
            },
            { file: "src/metrics.ts", symbol: "onJobCompleted", role: "definition" },
          ],
        },
      ],
    });
    expect(withEvidence.ok).toBe(true);
    const asUser = apply(
      { edges: [{ id: "edge:new", from: F.worker, to: F.metrics, kind: "emits", label: "x" }] },
      { actor: "user" },
    );
    expect(asUser.ok).toBe(true);
  });

  it("enforces frame ordering and step references", () => {
    const badFrame = apply({
      views: [
        {
          id: "view:new",
          type: "sequence",
          title: "New",
          participants: [DISPATCH, F.queue],
          steps: [
            { id: "new:1", from: DISPATCH, to: F.queue, label: "a", kind: "call" },
            { id: "new:2", from: F.queue, to: DISPATCH, label: "b", kind: "return" },
          ],
          frames: [{ id: "frame:x", kind: "loop", label: "x", fromStep: "new:2", toStep: "new:1" }],
        },
      ],
    });
    expect(badFrame.ok).toBe(false);
    expect(errorsOf(badFrame)[0]).toMatchObject({ path: "views[0].frames[0]", code: "frame" });
    const good = apply({
      views: [
        {
          id: "view:new",
          type: "sequence",
          title: "New",
          participants: [DISPATCH, F.queue],
          steps: [
            { id: "new:1", from: DISPATCH, to: F.queue, label: "a", kind: "call" },
            { id: "new:2", from: F.queue, to: DISPATCH, label: "b", kind: "return", anchors: [] },
          ],
          frames: [{ id: "frame:x", kind: "loop", label: "x", fromStep: "new:1", toStep: "new:2" }],
        },
      ],
    });
    expect(good.ok).toBe(true);
    expect((view(good.explainer, "view:new") as SequenceView).steps[0]!.anchors).toEqual([]);
  });

  it("checks the parts of steps, frames and tour steps it copies", () => {
    const bad = apply({
      views: [
        {
          id: "view:dispatch",
          type: "sequence",
          steps: [{ id: "dispatch:1", from: DISPATCH, label: "x", kind: "call" } as never],
        },
      ],
    });
    expect(bad.issues[0]).toMatchObject({ path: "views[0].steps[0].to" });
    expect(
      apply({
        views: [
          {
            id: "view:dispatch",
            type: "sequence",
            steps: [
              {
                id: "dispatch:1",
                from: DISPATCH,
                to: F.queue,
                label: "x",
                kind: "call",
                extra: 1,
              } as never,
            ],
          },
        ],
      }).issues[0],
    ).toMatchObject({ path: "views[0].steps[0].extra" });
    expect(
      apply({
        views: [
          {
            id: "view:dispatch",
            type: "sequence",
            frames: [{ id: "frame:z", kind: "loop", label: "x", fromStep: "dispatch:2" } as never],
          },
        ],
      }).issues[0],
    ).toMatchObject({ path: "views[0].frames[0].toStep" });
    expect(
      apply({
        tours: [{ id: "tour:intro", steps: [{ id: "t1", view: "view:dispatch" } as never] }],
      }).issues[0],
    ).toMatchObject({ path: "tours[0].steps[0].focus" });
    expect(
      apply({
        tours: [
          {
            id: "tour:intro",
            steps: [{ id: "t1", view: "view:dispatch", focus: [], editor: { nope: 1 } } as never],
          },
        ],
      }).issues[0],
    ).toMatchObject({ path: "tours[0].steps[0].editor.nope" });
  });

  describe("pre-existing problems elsewhere", () => {
    /** Runner.dispatch's retry block changed and Queue.pop is gone. */
    function driftedWorld(): World {
      const runner = RUNNER_TEXT.split("\n")
        .map((line, i) => (i + 1 === 77 ? "          job, extra," : line))
        .join("\n");
      return makeWorld({
        ...JOBRUNNER,
        files: JOBRUNNER.files.map((f) =>
          f.path === "src/runner.ts" ? { ...f, text: runner } : f,
        ),
        symbols: JOBRUNNER.symbols!.filter((s) => s.id !== "src/queue.ts#Queue.pop"),
      });
    }
    const dw = driftedWorld();
    const seedWithDriftable = (): Explainer => {
      const ex = seed();
      ex.concepts.push(concept("concept:drift-me", [A.retryBlock], { provenance: OLD }));
      return ex;
    };

    it("does not block a patch on untouched elements (drifted anchors of user concepts, etc.)", () => {
      expect(
        validateExplainer(seedWithDriftable(), dw.index, dw.getText).filter(
          (i) => i.severity === "error",
        ).length,
      ).toBeGreaterThan(3);
      const r = apply(
        {
          concepts: [
            {
              id: "concept:new",
              label: "New",
              anchors: [{ file: "src/worker.ts", symbol: "Worker.run", role: "definition" }],
            },
          ],
        },
        { explainer: seedWithDriftable(), world: dw },
      );
      expect(r.ok).toBe(true);
      expect(r.changed).toEqual(["concept:new"]);
      const summary = r.issues.filter(
        (i) => i.severity === "warning" && i.message.includes("existing validation error"),
      );
      expect(summary).toHaveLength(1);
      expect(summary[0]!.message).toContain("did not touch");
    });

    it("blocks a patch that touches an element which is still invalid", () => {
      const r = apply(
        { concepts: [{ id: "concept:drift-me", summary: "re-explained" }] },
        { explainer: seedWithDriftable(), world: dw },
      );
      expect(r.ok).toBe(false);
      expect(errorsOf(r)).toEqual([
        expect.objectContaining({
          code: "anchor-drifted",
          elementId: "concept:drift-me",
          path: "concepts[0].anchors[0]",
        }),
      ]);
    });

    it("accepts the same patch once the element's anchors are rewritten", () => {
      const r = apply(
        {
          concepts: [
            {
              id: "concept:drift-me",
              summary: "re-explained",
              anchors: [
                {
                  file: "src/runner.ts",
                  symbol: "Runner.dispatch",
                  find: "const attempts = job.attempts + 1;",
                  role: "definition",
                },
              ],
            },
          ],
        },
        { explainer: seedWithDriftable(), world: dw },
      );
      expect(r.ok).toBe(true);
      const c = el(r.explainer.concepts, "concept:drift-me");
      expect(c.summary).toBe("re-explained");
      expect(c.anchors[0]!.resolved!.status).toBe("ok");
    });

    it("still rejects a patch that makes things worse", () => {
      const r = apply(
        {
          views: [
            { id: "view:overview", type: "graph", include: ["grp:scheduling", "file:src/nope.ts"] },
          ],
        },
        { explainer: seedWithDriftable(), world: dw },
      );
      expect(r.ok).toBe(false);
      expect(errorsOf(r)).toHaveLength(1);
    });
  });

  it("rejects the same id twice in one patch, and an id both upserted and removed", () => {
    const dup = apply({
      concepts: [
        { id: "concept:x", label: "1" },
        { id: "concept:x", label: "2" },
      ],
    });
    expect(dup.ok).toBe(false);
    expect(dup.issues[0]).toMatchObject({ path: "concepts[1].id", code: "duplicate-id" });
    const both = apply({
      concepts: [{ id: "concept:idem", summary: "x" }],
      remove: ["concept:idem"],
    });
    expect(both.ok).toBe(false);
    expect(both.issues[0]).toMatchObject({ path: "remove", elementId: "concept:idem" });
  });
});

describe("applyPatch: views and tours", () => {
  it("replaces sequence steps wholesale, warning about dropped step ids", () => {
    const r = apply({
      views: [
        {
          id: "view:dispatch",
          type: "sequence",
          steps: [
            {
              id: "dispatch:1",
              from: DISPATCH,
              to: F.queue,
              label: "pop() renamed",
              kind: "call",
              anchors: [
                {
                  file: "src/runner.ts",
                  symbol: "Runner.dispatch",
                  span: { from: 4, to: 4 },
                  role: "call-site",
                },
              ],
            },
            { id: "dispatch:2", from: DISPATCH, to: F.queue, label: "requeue()", kind: "call" },
            { id: "dispatch:3", from: F.queue, to: DISPATCH, label: "ok", kind: "return" },
            { id: "dispatch:4", from: DISPATCH, to: F.worker, label: "run()", kind: "call" },
          ],
        },
      ],
    });
    expect(r.ok).toBe(true);
    const steps = (view(r.explainer, "view:dispatch") as SequenceView).steps;
    expect(steps.map((s) => s.id)).toEqual([
      "dispatch:1",
      "dispatch:2",
      "dispatch:3",
      "dispatch:4",
    ]);
    expect(steps[1]!.anchors).toEqual([]); // replaced wholesale
    expect((view(r.explainer, "view:dispatch") as SequenceView).frames).toHaveLength(1); // untouched
    expect(warningsOf(r)).toEqual([]);
    const dropping = apply({
      views: [
        {
          id: "view:dispatch",
          type: "sequence",
          steps: [{ id: "dispatch:1", from: DISPATCH, to: F.queue, label: "x", kind: "call" }],
        },
      ],
    });
    expect(dropping.ok).toBe(false); // the frame and the tour still point at dropped steps
    expect(errorsOf(dropping).some((i) => i.message.includes("dispatch:3"))).toBe(true);
    const droppedOnly = apply({
      views: [
        {
          id: "view:dispatch",
          type: "sequence",
          steps: [{ id: "dispatch:1", from: DISPATCH, to: F.queue, label: "x", kind: "call" }],
          frames: null,
        },
      ],
      tours: [{ id: "tour:intro", steps: [] }],
    });
    expect(droppedOnly.ok).toBe(true);
    expect(
      warningsOf(droppedOnly).some(
        (i) => i.code === "step" && i.message.includes("dispatch:2, dispatch:3"),
      ),
    ).toBe(true);
  });

  it("updates a graph view's include, adding and removing", () => {
    const r = apply({
      views: [
        {
          id: "view:overview",
          type: "graph",
          include: ["grp:scheduling", F.worker, F.metrics],
          hidden: [F.metrics],
        },
      ],
    });
    expect(r.ok).toBe(true);
    const v = view(r.explainer, "view:overview") as GraphView;
    expect(v.include).toHaveLength(3);
    expect(v.hidden).toEqual([F.metrics]);
    const cleared = apply(
      { views: [{ id: "view:overview", type: "graph", hidden: null }] },
      { explainer: r.explainer },
    );
    expect("hidden" in view(cleared.explainer, "view:overview")).toBe(false);
  });

  it("gives a tour a provenance like any element: the llm's until a user edits it", () => {
    // the seed's tour predates tour provenance: it counts as the llm's, and an llm edit records it
    const llm = apply({ tours: [{ id: "tour:intro", title: "Renamed" }] });
    expect(el(llm.explainer.tours, "tour:intro").provenance).toEqual({
      origin: "llm",
      commit: "c1",
    });
    const user = apply({ tours: [{ id: "tour:intro", title: "Mine" }] }, { actor: "user" });
    expect(user.changed).toEqual(["tour:intro"]);
    expect(el(user.explainer.tours, "tour:intro")).toEqual({
      id: "tour:intro",
      title: "Mine",
      steps: seed().tours[0]!.steps,
      provenance: { origin: "llm", userFields: ["title"] },
    });
    // an llm patch cannot create a tour as the user's, nor make an existing one the user's
    expect(
      apply({
        tours: [{ id: "tour:new", title: "x", steps: [], provenance: { origin: "user" } }],
      }).ok,
    ).toBe(false);
    const ignored = apply({
      tours: [{ id: "tour:intro", title: "Renamed", provenance: { origin: "user" } }],
    });
    expect(el(ignored.explainer.tours, "tour:intro").provenance).toEqual({
      origin: "llm",
      commit: "c1",
    });
  });

  it("creates and updates tours; steps replace wholesale and their code goes through makeAnchor", () => {
    const create = apply({
      tours: [
        {
          id: "tour:new",
          title: "New tour",
          steps: [
            { id: "s1", view: "view:overview", focus: ["grp:scheduling"], note: "Start here." },
            {
              id: "s2",
              view: "view:dispatch",
              focus: ["dispatch:2"],
              code: [
                {
                  file: "src/runner.ts",
                  symbol: "Runner.dispatch",
                  find: "await this.queue.requeue(",
                  role: "call-site",
                },
              ],
              editor: { primary: "src/runner.ts", dimOthers: true },
            },
          ],
        },
      ],
    });
    expect(create.ok).toBe(true);
    const tour = el(create.explainer.tours, "tour:new");
    expect(tour.steps).toHaveLength(2);
    expect(tour.steps[1]!.code![0]).toMatchObject({
      span: { from: 34, to: 34 },
      resolved: { status: "ok" },
    });
    expect(tour.steps[1]!.editor).toEqual({ primary: "src/runner.ts", dimOthers: true });
    const update = apply(
      { tours: [{ id: "tour:new", title: "Renamed" }] },
      { explainer: create.explainer },
    );
    expect(el(update.explainer.tours, "tour:new").title).toBe("Renamed");
    expect(el(update.explainer.tours, "tour:new").steps).toHaveLength(2);
    const replaced = apply(
      { tours: [{ id: "tour:new", steps: [{ id: "s1", view: "view:overview", focus: [] }] }] },
      { explainer: create.explainer },
    );
    expect(el(replaced.explainer.tours, "tour:new").steps).toHaveLength(1);
    // an llm tour the user did not edit: an llm patch may replace it
    expect(update.changed).toEqual(["tour:new"]);
  });
});

describe("applyPatch: remove", () => {
  it("removes elements, views, tours and steps by id, in the order given", () => {
    const r = apply({
      remove: ["edge:job-completed", "concept:idem", "view:overview", "tour:intro", "dispatch:1"],
    });
    expect(r.ok).toBe(true);
    expect(r.explainer.edges).toEqual([]);
    expect(r.explainer.concepts.map((c) => c.id)).toEqual(["concept:retry-policy"]);
    expect(r.explainer.views.map((v) => v.id)).toEqual(["view:mine", "view:dispatch"]);
    expect(r.explainer.tours).toEqual([]);
    expect((view(r.explainer, "view:dispatch") as SequenceView).steps.map((s) => s.id)).toEqual([
      "dispatch:2",
      "dispatch:3",
    ]);
    expect(r.changed).toEqual([
      "edge:job-completed",
      "concept:idem",
      "view:overview",
      "tour:intro",
      "dispatch:1",
    ]);
  });

  it("removing a stored overlay leaves the derived node; unknown ids are warnings", () => {
    // an overlay the user never touched (no userFields): the llm may remove it
    const ex = seed();
    ex.nodes.push({
      id: F.queue,
      kind: "file",
      parent: "dir:src",
      label: "queue.ts",
      summary: "The queue.",
      anchors: [],
      provenance: OLD,
    });
    const r = apply({ remove: [F.queue, "concept:nope"] }, { explainer: ex });
    expect(r.ok).toBe(true);
    expect(r.explainer.nodes.map((n) => n.id)).toEqual(["grp:scheduling", DISPATCH]);
    expect(warningsOf(r)).toEqual([
      expect.objectContaining({ path: "remove[1]", elementId: "concept:nope" }),
    ]);
    expect(r.changed).toEqual([F.queue]);
    // the derived node is still there for the views
    expect(validateExplainer(r.explainer, w.index, w.getText)).toEqual([]);
    // a user patch may remove the overlay that carries their words
    const asUser = apply({ remove: [DISPATCH] }, { actor: "user" });
    expect(asUser.changed).toEqual([DISPATCH]);
    expect(asUser.explainer.nodes.map((n) => n.id)).toEqual(["grp:scheduling"]);
  });

  it("rejects a removal that leaves dangling references, and accepts it with the fix", () => {
    const dangling = apply({ remove: ["grp:scheduling"] });
    expect(dangling.ok).toBe(false);
    expect(
      errorsOf(dangling).some(
        (i) => i.message.includes("grp:scheduling") && i.path.startsWith("views[0].include"),
      ),
    ).toBe(true);
    const fixed = apply({
      remove: ["grp:scheduling"],
      views: [{ id: "view:overview", type: "graph", include: [F.worker] }],
    });
    expect(fixed.ok).toBe(true);
    expect(fixed.changed).toEqual(["view:overview", "grp:scheduling"]);
    const step = apply({ remove: ["dispatch:3"] });
    expect(step.ok).toBe(false); // the frame and the tour point at it
  });
});

describe("applyPatch: robustness", () => {
  it("results are plain JSON", () => {
    const r = apply({
      nodes: [{ id: "file:src/queue.ts", summary: "q" }],
      concepts: [
        { id: "concept:q", label: "Q", anchors: [{ file: "src/queue.ts", role: "test" }] },
      ],
      views: [{ id: "view:x", type: "graph", title: "X", include: [F.queue] }],
      tours: [{ id: "tour:x", title: "X", steps: [{ id: "s", view: "view:x", focus: [F.queue] }] }],
    });
    expect(r.ok).toBe(true);
    expect(JSON.parse(JSON.stringify(r.explainer))).toEqual(r.explainer);
    expect(JSON.parse(JSON.stringify(r.issues))).toEqual(r.issues);
  });

  it("an llm patch cannot remove a step of a user-authored view", () => {
    const ex = seed();
    view(ex, "view:dispatch").provenance = USER;
    const r = apply({ remove: ["dispatch:1"] }, { explainer: ex });
    expect(r.ok).toBe(true);
    expect((view(r.explainer, "view:dispatch") as SequenceView).steps).toHaveLength(3);
    expect(warningsOf(r)).toEqual([
      expect.objectContaining({ code: "protected", elementId: "dispatch:1" }),
    ]);
    const asUser = apply({ remove: ["dispatch:1"] }, { explainer: ex, actor: "user" });
    expect((view(asUser.explainer, "view:dispatch") as SequenceView).steps).toHaveLength(2);
  });

  it("reports the position of a repeated id in remove", () => {
    const r = apply({ remove: ["concept:idem", "concept:nope", "concept:idem", "concept:nope2"] });
    expect(warningsOf(r).map((w) => w.path)).toEqual(["remove[1]", "remove[3]"]);
  });

  it("copies what it stores: later edits of the patch do not leak into the result", () => {
    const patch: ExplainerPatch = { nodes: [{ id: "grp:x", label: "X", members: [F.queue] }] };
    const r = apply(patch);
    (patch.nodes![0] as { members: string[] }).members.push("file:src/nope.ts");
    expect(el(r.explainer.nodes, "grp:x").members).toEqual([F.queue]);
  });
});

describe("applyPatch: title", () => {
  it("changes the title and reports it", () => {
    const r = apply({ title: "New title" });
    expect(r.ok).toBe(true);
    expect(r.explainer.title).toBe("New title");
    expect(r.changed).toEqual(["title"]);
    expect(apply({ title: "Test" }).changed).toEqual([]);
  });
});

// ─── stepsUpdate ────────────────────────────────────────────────────────────────────────────────

describe("applyPatch: stepsUpdate", () => {
  const dispatchOf = (r: ApplyResult) => view(r.explainer, "view:dispatch") as SequenceView;
  const update = (stepsUpdate: unknown[], over: Record<string, unknown> = {}): ExplainerPatch => ({
    views: [{ id: "view:dispatch", type: "sequence", stepsUpdate, ...over } as never],
  });
  const protectedOf = (r: ApplyResult) =>
    warningsOf(r)
      .filter((i) => i.code === "protected")
      .map((i) => [i.path, i.elementId]);

  it("merges fields into the steps it names, leaves every other step and the frames alone", () => {
    const r = apply(
      update([{ id: "dispatch:2", summary: "Requeues with backoff.", label: "requeue(job, ms)" }]),
    );
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.changed).toEqual(["view:dispatch", "dispatch:2"]); // the step is named, not just the view
    const steps = dispatchOf(r).steps;
    expect(steps[1]).toEqual({
      ...seed().views.flatMap((v) => (v.type === "sequence" ? v.steps : []))[1],
      summary: "Requeues with backoff.",
      label: "requeue(job, ms)",
    });
    expect(steps[0]).toEqual((view(seed(), "view:dispatch") as SequenceView).steps[0]);
    expect(steps[2]).toEqual((view(seed(), "view:dispatch") as SequenceView).steps[2]);
    expect(dispatchOf(r).frames).toEqual((view(seed(), "view:dispatch") as SequenceView).frames);
    expect(dispatchOf(r).provenance).toEqual({ origin: "llm", commit: "c1" });
    expect(validateExplainer(r.explainer, w.index, w.getText, { mode: "strict" })).toEqual([]);
    expect("stepsUpdate" in dispatchOf(r)).toBe(false); // never stored
  });

  it("is a summary fix without resending the other steps: several steps in one list, in any order", () => {
    const r = apply(
      update([
        { id: "dispatch:3", summary: "Third." },
        { id: "dispatch:1", summary: "First." },
      ]),
    );
    expect(r.changed).toEqual(["view:dispatch", "dispatch:3", "dispatch:1"]);
    expect(dispatchOf(r).steps.map((s) => s.summary)).toEqual(["First.", undefined, "Third."]);
  });

  it("anchors are AnchorInputs: made against the index, replacing the step's anchors", () => {
    const r = apply(
      update([
        {
          id: "dispatch:1",
          anchors: [
            {
              file: "src/runner.ts",
              symbol: "Runner.dispatch",
              find: "await this.queue.pop()",
              role: "call-site",
            },
          ],
        },
      ]),
    );
    expect(r.ok).toBe(true);
    const anchors = dispatchOf(r).steps[0]!.anchors;
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toMatchObject({
      symbol: "Runner.dispatch",
      span: { from: 4, to: 4 },
      resolved: { status: "ok" },
    });
    // a bad anchor is reported where it is in the patch
    const bad = apply(
      update([
        {
          id: "dispatch:1",
          anchors: [{ file: "src/queue.ts", symbol: "Queue.popp", role: "usage" }],
        },
      ]),
    );
    expect(bad.ok).toBe(false);
    expect(errorsOf(bad).map((i) => [i.path, i.elementId])).toEqual([
      ["views[0].stepsUpdate[0].anchors[0]", "dispatch:1"],
    ]);
    expect(errorsOf(bad)[0]!.message).toContain("Did you mean: sym:src/queue.ts#Queue.pop");
  });

  it("null clears optional fields; required fields reject null", () => {
    const first = apply(update([{ id: "dispatch:2", summary: "x" }]));
    const cleared = apply(update([{ id: "dispatch:2", summary: null }]), {
      explainer: first.explainer,
    });
    expect(cleared.ok).toBe(true);
    expect("summary" in dispatchOf(cleared).steps[1]!).toBe(false);
    expect(cleared.changed).toEqual(["view:dispatch", "dispatch:2"]);
    const label = apply(update([{ id: "dispatch:2", label: null }]));
    expect(label.ok).toBe(false);
    expect(errorsOf(label)[0]).toMatchObject({ path: "views[0].stepsUpdate[0].label" });
    expect(errorsOf(label)[0]!.message).toBe(
      "label cannot be null (null clears only: summary, edge, shape, next)",
    );
  });

  it("an unknown step id is an error that names the view's steps", () => {
    const r = apply(update([{ id: "dispatch:9", summary: "x" }]));
    expect(r.ok).toBe(false);
    expect(errorsOf(r)).toEqual([
      expect.objectContaining({
        path: "views[0].stepsUpdate[0].id",
        elementId: "view:dispatch",
        code: "unknown-id",
        message:
          "step dispatch:9 is not a step of view:dispatch (its steps: dispatch:1, dispatch:2, dispatch:3)",
      }),
    ]);
    expect(r.explainer).toEqual(seed()); // atomic
  });

  it("suggests the step of a similar view, and says when the step belongs to another view", () => {
    const ex = seed();
    ex.views.push(
      sequenceView(
        "view:apply-flow",
        [DISPATCH, F.queue],
        [1, 2, 3, 4].map((n) => ({
          id: `apply-flow:${n}`,
          from: DISPATCH,
          to: F.queue,
          label: `step ${n}`,
          kind: "call" as const,
          anchors: [],
        })),
        { provenance: OLD },
      ),
    );
    const near = apply(
      {
        views: [
          {
            id: "view:apply-flow",
            type: "sequence",
            stepsUpdate: [{ id: "apply:4", summary: "x" }],
          },
        ],
      },
      { explainer: ex },
    );
    expect(errorsOf(near)[0]!.message).toBe(
      "step apply:4 is not a step of view:apply-flow (its steps: apply-flow:1, apply-flow:2, apply-flow:3, apply-flow:4). Did you mean: apply-flow:4?",
    );
    const other = apply(update([{ id: "apply-flow:2", summary: "x" }]), { explainer: ex });
    expect(errorsOf(other)[0]!.message).toBe(
      "step apply-flow:2 belongs to view:apply-flow, not to view:dispatch",
    );
  });

  it("checks the list and its entries: shape, ids, duplicates, fields", () => {
    const notArray = apply(update({ id: "dispatch:1" } as never));
    expect(errorsOf(notArray)[0]).toMatchObject({ path: "views[0].stepsUpdate" });
    const r = apply(
      update([
        3,
        { summary: "no id" },
        { id: "dispatch:1", summry: "typo" },
        { id: "dispatch:2", kind: "flies" },
        { id: "dispatch:3", summary: "a" },
        { id: "dispatch:3", summary: "b" },
      ]),
    );
    expect(errorsOf(r).map((i) => i.path)).toEqual([
      "views[0].stepsUpdate[0]",
      "views[0].stepsUpdate[1].id",
      "views[0].stepsUpdate[2].summry",
      "views[0].stepsUpdate[3].kind",
      "views[0].stepsUpdate[5].id",
    ]);
    expect(errorsOf(r)[2]!.message).toContain("unknown field");
    expect(errorsOf(r)[4]).toMatchObject({ code: "duplicate-id" });
  });

  it("only sequence views have it, and only existing ones", () => {
    const graph = apply({
      views: [{ id: "view:overview", type: "graph", stepsUpdate: [] } as never],
    });
    expect(errorsOf(graph)[0]!.message).toContain('unknown field "stepsUpdate"');
    const created = apply({
      views: [
        {
          id: "view:new",
          type: "sequence",
          title: "New",
          participants: [DISPATCH, F.queue],
          steps: [],
          stepsUpdate: [{ id: "new:1", summary: "x" }],
        },
      ],
    });
    expect(errorsOf(created)[0]).toMatchObject({ path: "views[0].stepsUpdate" });
    expect(errorsOf(created)[0]!.message).toContain("view:new is a new view: send its steps whole");
  });

  it("applies after steps when a patch sends both", () => {
    const r = apply({
      views: [
        {
          id: "view:dispatch",
          type: "sequence",
          steps: [
            { id: "dispatch:1", from: DISPATCH, to: F.queue, label: "pop()", kind: "call" },
            { id: "dispatch:2", from: DISPATCH, to: F.queue, label: "requeue()", kind: "call" },
            { id: "dispatch:3", from: F.queue, to: DISPATCH, label: "ok", kind: "return" },
          ],
          stepsUpdate: [{ id: "dispatch:2", summary: "On the new list." }],
        },
      ],
    });
    expect(r.ok).toBe(true);
    expect(dispatchOf(r).steps[0]!.anchors).toEqual([]); // sent whole
    expect(dispatchOf(r).steps[1]!.summary).toBe("On the new list.");
  });

  it("a step cannot be updated and removed by the same patch", () => {
    const r = apply({ ...update([{ id: "dispatch:3", summary: "x" }]), remove: ["dispatch:3"] });
    expect(r.ok).toBe(false);
    expect(errorsOf(r)[0]).toMatchObject({
      path: "remove",
      elementId: "dispatch:3",
      message: "dispatch:3 is both updated (views[0].stepsUpdate[0]) and removed by this patch",
    });
  });

  it("is idempotent: the same update twice changes nothing the second time", () => {
    const patch = update([{ id: "dispatch:2", summary: "Same." }]);
    const once = apply(patch);
    const twice = apply(patch, { explainer: once.explainer });
    expect(twice.ok).toBe(true);
    expect(twice.changed).toEqual([]);
    expect(twice.explainer).toEqual(once.explainer);
  });

  it("points validation errors at the entry of the patch, not at steps[j]", () => {
    const r = apply(update([{ id: "dispatch:2", to: F.metrics }]));
    expect(r.ok).toBe(false);
    expect(errorsOf(r).map((i) => [i.path, i.elementId])).toEqual([
      ["views[0].stepsUpdate[0].to", "dispatch:2"],
    ]);
    expect(errorsOf(r)[0]!.message).toContain("is not a participant of view:dispatch");
  });

  it("a step it changes must be valid: a drifted anchor of that step is reported, others are not", () => {
    const ex = seed();
    const steps = (view(ex, "view:dispatch") as SequenceView).steps;
    steps[0]!.anchors[0]!.hash = "sha256:000000000000"; // dispatch:1 drifted
    const other = apply(update([{ id: "dispatch:2", summary: "x" }]), { explainer: ex });
    expect(other.ok).toBe(true); // an update of dispatch:2 does not answer for dispatch:1
    expect(warningsOf(other).some((i) => i.message.includes("existing validation error"))).toBe(
      true,
    );
    const same = apply(update([{ id: "dispatch:1", summary: "x" }]), { explainer: ex });
    expect(same.ok).toBe(false); // the step it changes is still drifted: rewrite its anchors too
    expect(errorsOf(same)[0]).toMatchObject({ code: "anchor-drifted", elementId: "dispatch:1" });
    const fixed = apply(
      update([
        {
          id: "dispatch:1",
          summary: "x",
          anchors: [
            {
              file: "src/runner.ts",
              symbol: "Runner.dispatch",
              find: "await this.queue.pop()",
              role: "call-site",
            },
          ],
        },
      ]),
      { explainer: ex },
    );
    expect(fixed.ok).toBe(true);
  });

  describe("when the user edited the view's steps", () => {
    const edited = () => {
      const ex = seed();
      view(ex, "view:dispatch").provenance = { ...OLD, userFields: ["steps"] };
      return ex;
    };

    it("an llm patch skips it with a protected warning; the other fields of the view still merge", () => {
      const r = apply(update([{ id: "dispatch:2", summary: "x" }], { title: "Retitled" }), {
        explainer: edited(),
      });
      expect(r.ok).toBe(true);
      expect(dispatchOf(r).title).toBe("Retitled");
      expect(dispatchOf(r).steps).toEqual((view(edited(), "view:dispatch") as SequenceView).steps);
      expect(protectedOf(r)).toEqual([["views[0].stepsUpdate", "view:dispatch"]]);
      expect(r.changed).toEqual(["view:dispatch"]);
    });

    it("alone it changes nothing: everything it would change is protected", () => {
      const ex = edited();
      const r = apply(update([{ id: "dispatch:2", summary: "x" }]), { explainer: ex });
      expect(r).toMatchObject({ ok: true, changed: [] });
      expect(protectedOf(r)).toEqual([["views[0].stepsUpdate", "view:dispatch"]]);
      expect(r.explainer).toEqual(ex);
    });

    it("a user patch is not held back, and records steps as a user field", () => {
      const fresh = apply(update([{ id: "dispatch:2", summary: "Mine." }]), { actor: "user" });
      expect(fresh.ok).toBe(true);
      expect(dispatchOf(fresh).steps[1]!.summary).toBe("Mine.");
      expect(dispatchOf(fresh).provenance).toEqual({
        origin: "llm",
        commit: "c0",
        userFields: ["steps"],
      });
      // ...after which the llm's stepsUpdate is skipped too
      const llm = apply(update([{ id: "dispatch:2", summary: "Overwritten?" }]), {
        explainer: fresh.explainer,
      });
      expect(llm.changed).toEqual([]);
      expect(dispatchOf(llm).steps[1]!.summary).toBe("Mine.");
    });

    it("an unknown step id is not reported when the update is skipped", () => {
      const r = apply(update([{ id: "dispatch:9", summary: "x" }]), { explainer: edited() });
      expect(r.ok).toBe(true);
      expect(protectedOf(r)).toHaveLength(1);
    });
  });

  it("a user-authored view takes no llm edit at all, stepsUpdate included", () => {
    const ex = seed();
    view(ex, "view:dispatch").provenance = USER;
    const r = apply(update([{ id: "dispatch:2", summary: "x" }]), { explainer: ex });
    expect(r.changed).toEqual([]);
    expect(protectedOf(r)).toEqual([["views[0]", "view:dispatch"]]);
  });
});

// ─── One wave of errors ─────────────────────────────────────────────────────────────────────────

describe("applyPatch: one wave of errors", () => {
  const badSpan = {
    file: "src/runner.ts",
    symbol: "Runner.dispatch",
    span: { from: 0, to: 99 },
    role: "usage",
  } as const;
  const pathsOf = (r: ApplyResult) => errorsOf(r).map((i) => i.path);

  it("a bad code span and a bad focus id are reported together", () => {
    const r = apply({
      tours: [
        {
          id: "tour:intro",
          steps: [
            { id: "t1", view: "view:dispatch", focus: ["dispatch:1"], code: [badSpan] },
            { id: "t2", view: "view:dispatch", focus: ["dispatch:99"] },
          ],
        },
      ],
    });
    expect(r.ok).toBe(false);
    expect(pathsOf(r)).toEqual(["tours[0].steps[0].code[0]", "tours[0].steps[1].focus[0]"]);
    expect(errorsOf(r)[0]!.message).toContain("outside");
    expect(errorsOf(r)[1]!.message).toContain("no step dispatch:99 in view:dispatch");
    expect(r.explainer).toEqual(seed()); // still atomic
  });

  it("the same for a bad anchor and a bad reference in one element", () => {
    const r = apply({
      concepts: [
        {
          id: "concept:x",
          label: "X",
          anchors: [{ file: "src/nope.ts", role: "usage" }],
          related: ["concept:retry", "file:src/queue.ts"],
        },
      ],
    });
    expect(pathsOf(r)).toEqual(["concepts[0].anchors[0]", "concepts[0].related[0]"]);
    expect(errorsOf(r)[1]!.message).toContain("Did you mean: concept:retry-policy?");
  });

  it("reports the references of a view whose steps had a bad anchor, and the rest of the patch", () => {
    const r = apply({
      views: [
        {
          id: "view:dispatch",
          type: "sequence",
          steps: [
            {
              id: "dispatch:1",
              from: DISPATCH,
              to: F.queue,
              label: "pop()",
              kind: "call",
              anchors: [{ file: "src/queue.ts", symbol: "Queue.popp", role: "definition" }],
            },
            // a step end that is not a participant, and frames that point at steps this list drops
            { id: "dispatch:2", from: DISPATCH, to: F.metrics, label: "x", kind: "call" },
          ],
        },
      ],
      concepts: [{ id: "concept:c", label: "C", anchors: [{ file: "src/nope.ts", role: "test" }] }],
    });
    expect(r.ok).toBe(false);
    // the anchors first (patch order), then what the merged result gets wrong: the step end, the frame and the
    // seed's tour that point at what the new steps drop
    expect(pathsOf(r)).toEqual([
      "concepts[0].anchors[0]",
      "views[0].steps[0].anchors[0]",
      "views[0].steps[1].to",
      "views[0].frames[0].toStep",
      "tours[0].steps[0].focus[0]",
    ]);
  });

  it("does not ask for the evidence of an llm edge whose anchor failed", () => {
    const r = apply({
      edges: [
        {
          id: "edge:new",
          from: F.worker,
          to: F.metrics,
          kind: "emits",
          label: "x",
          anchors: [
            {
              file: "src/worker.ts",
              symbol: "Worker.run",
              span: { from: 21, to: 21 },
              role: "call-site",
            },
            { file: "src/metrics.ts", symbol: "onJobCompletd", role: "definition" },
          ],
        },
      ],
    });
    expect(pathsOf(r)).toEqual(["edges[0].anchors[1]"]); // no "needs at least one anchor inside its to"
    // fix the anchor and the evidence is judged after all
    const wrongEnd = apply({
      edges: [
        {
          id: "edge:new",
          from: F.worker,
          to: F.metrics,
          kind: "emits",
          label: "x",
          anchors: [
            {
              file: "src/worker.ts",
              symbol: "Worker.run",
              span: { from: 21, to: 21 },
              role: "call-site",
            },
          ],
        },
      ],
    });
    expect(errorsOf(wrongEnd)[0]).toMatchObject({ code: "evidence" });
  });

  it("does not turn an element that could not be built into an error at every reference to it", () => {
    const r = apply({
      nodes: [{ id: "grp:broken", label: "Broken" }], // a group needs members
      views: [{ id: "view:v", type: "graph", title: "V", include: ["grp:broken", F.queue] }],
      concepts: [{ id: "concept:c", label: "C", related: ["grp:broken"] }],
    });
    expect(errorsOf(r).map((i) => [i.path, i.elementId])).toEqual([
      ["nodes[0].members", "grp:broken"],
    ]);
    // ...and a view that could not be built takes its steps with it
    const view = apply({
      views: [
        {
          id: "view:apply-flow",
          type: "sequence",
          title: "Apply",
          participants: [DISPATCH, F.queue],
          steps: [{ id: "apply-flow:1", from: DISPATCH, to: F.queue, label: "x", kind: "call" }],
          bogus: 1,
        } as never,
      ],
      tours: [
        {
          id: "tour:t",
          title: "T",
          steps: [{ id: "s1", view: "view:apply-flow", focus: ["apply-flow:1"] }],
        },
      ],
    });
    expect(errorsOf(view).map((i) => i.path)).toEqual(["views[0].bogus"]);
  });

  it("still reports what is really missing", () => {
    const r = apply({
      nodes: [{ id: "grp:broken", label: "Broken" }],
      concepts: [{ id: "concept:c", label: "C", related: ["grp:brokn", "grp:broken"] }],
    });
    expect(pathsOf(r)).toEqual(["nodes[0].members", "concepts[0].related[0]"]);
    expect(errorsOf(r)[1]!.message).toContain("no group with id grp:brokn in this explainer");
    expect(errorsOf(r)[1]!.message).toContain("Did you mean: grp:broken?"); // the one being created
  });

  it("an unknown patch field no longer hides the other errors", () => {
    const r = apply({
      nope: [],
      concepts: [
        { id: "concept:x", label: "X", anchors: [{ file: "src/nope.ts", role: "usage" }] },
      ],
    } as never);
    expect(pathsOf(r)).toEqual(["nope", "concepts[0].anchors[0]"]);
  });

  it("finds the dangling reference of a removal in the same wave as a bad anchor", () => {
    const r = apply({
      remove: ["dispatch:3"], // the frame and the tour still point at it
      concepts: [
        { id: "concept:x", label: "X", anchors: [{ file: "src/nope.ts", role: "usage" }] },
      ],
    });
    expect(r.ok).toBe(false);
    expect(pathsOf(r)[0]).toBe("concepts[0].anchors[0]");
    expect(errorsOf(r).some((i) => i.message.includes("dispatch:3"))).toBe(true);
  });

  it("counts every error in the rejection, and a valid patch is not affected", () => {
    expect(apply({ concepts: [{ id: "concept:ok", label: "Ok" }] }).ok).toBe(true);
    const r = apply({
      concepts: [
        { id: "concept:a", label: "A", anchors: [{ file: "src/nope.ts", role: "usage" }] },
        { id: "concept:b", label: "B", related: ["concept:zzz"] },
        { id: "concept:c" },
      ],
    });
    expect(errorsOf(r)).toHaveLength(3);
  });
});

// ─── Tour provenance ────────────────────────────────────────────────────────────────────────────

describe("applyPatch: tour provenance", () => {
  const tourOf = (r: ApplyResult, id = "tour:intro") => el(r.explainer.tours, id);
  const protectedOf = (r: ApplyResult) =>
    warningsOf(r)
      .filter((i) => i.code === "protected")
      .map((i) => [i.path, i.elementId]);
  const withProvenance = (provenance: Explainer["tours"][number]["provenance"]): Explainer => {
    const ex = seed();
    ex.tours[0]!.provenance = provenance;
    return ex;
  };
  const steps = [{ id: "t1", view: "view:overview", focus: [F.queue], note: "New." }];

  it("a new tour gets { origin: actor, commit }, whoever writes it", () => {
    const create = { tours: [{ id: "tour:new", title: "New", steps }] };
    expect(tourOf(apply(create), "tour:new").provenance).toEqual({ origin: "llm", commit: "c1" });
    expect(tourOf(apply(create, { actor: "user" }), "tour:new").provenance).toEqual({
      origin: "user",
      commit: "c1",
    });
  });

  it("an llm patch cannot modify a tour of the user's: skipped with a protected warning", () => {
    const ex = withProvenance({ origin: "user" });
    const r = apply(
      { tours: [{ id: "tour:intro", title: "Overwritten", steps }] },
      { explainer: ex },
    );
    expect(r).toMatchObject({ ok: true, changed: [] });
    expect(protectedOf(r)).toEqual([["tours[0]", "tour:intro"]]);
    expect(r.explainer).toEqual(ex);
    // the user may edit their own tour
    const user = apply(
      { tours: [{ id: "tour:intro", title: "Mine" }] },
      { explainer: ex, actor: "user" },
    );
    expect(tourOf(user)).toMatchObject({ title: "Mine", provenance: { origin: "user" } });
  });

  it("an llm patch cannot remove a tour of the user's, nor one the user edited", () => {
    const theirs = apply(
      { remove: ["tour:intro"] },
      { explainer: withProvenance({ origin: "user" }) },
    );
    expect(theirs.explainer.tours.map((t) => t.id)).toEqual(["tour:intro"]);
    expect(theirs.changed).toEqual([]);
    expect(protectedOf(theirs)).toEqual([["remove[0]", "tour:intro"]]);
    const edited = apply(
      { remove: ["tour:intro"] },
      { explainer: withProvenance({ origin: "llm", userFields: ["steps"] }) },
    );
    expect(edited.explainer.tours).toHaveLength(1);
    expect(protectedOf(edited)).toEqual([["remove[0]", "tour:intro"]]);
    expect(warningsOf(edited)[0]!.message).toBe(
      "tour:intro has fields edited by the user (steps); an llm patch cannot remove it (skipped)",
    );
    // an untouched llm tour is removable, and so is one without provenance (written before tours had any)
    expect(apply({ remove: ["tour:intro"] }).explainer.tours).toEqual([]);
    expect(
      apply(
        { remove: ["tour:intro"] },
        { explainer: withProvenance({ origin: "llm", commit: "c0" }) },
      ).explainer.tours,
    ).toEqual([]);
    // the user may remove their own
    const byUser = apply(
      { remove: ["tour:intro"] },
      { explainer: withProvenance({ origin: "user" }), actor: "user" },
    );
    expect(byUser.explainer.tours).toEqual([]);
  });

  it("a user edit of an llm tour records the fields; the llm then keeps them and changes the rest", () => {
    const edited = apply({ tours: [{ id: "tour:intro", steps }] }, { actor: "user" });
    expect(tourOf(edited).provenance).toEqual({ origin: "llm", userFields: ["steps"] });
    // the llm retitles it and tries to replace its steps: the title changes, the steps stay
    const llm = apply(
      { tours: [{ id: "tour:intro", title: "Better title", steps: [] }] },
      { explainer: edited.explainer },
    );
    expect(llm.ok).toBe(true);
    expect(tourOf(llm).title).toBe("Better title");
    expect(tourOf(llm).steps).toEqual(steps);
    expect(protectedOf(llm)).toEqual([["tours[0].steps", "tour:intro"]]);
    expect(tourOf(llm).provenance).toEqual({ origin: "llm", userFields: ["steps"], commit: "c1" });
    // the same on the title: the user's retitle survives an llm retitle
    const retitled = apply({ tours: [{ id: "tour:intro", title: "Mine" }] }, { actor: "user" });
    const again = apply(
      { tours: [{ id: "tour:intro", title: "Not yours", steps }] },
      { explainer: retitled.explainer },
    );
    expect(tourOf(again).title).toBe("Mine");
    expect(tourOf(again).steps).toEqual(steps);
    expect(protectedOf(again)).toEqual([["tours[0].title", "tour:intro"]]);
  });

  it("a tour summary is optional, merges like the title, null clears it, and a user edit protects it", () => {
    const create = apply({
      tours: [{ id: "tour:new", title: "New", summary: "What this is. Why it matters.", steps }],
    });
    expect(create.ok).toBe(true);
    expect(tourOf(create, "tour:new").summary).toBe("What this is. Why it matters.");
    // a tour without one is stored without the key
    expect(
      "summary" in tourOf(apply({ tours: [{ id: "tour:b", title: "B", steps }] }), "tour:b"),
    ).toBe(false);
    // absent: kept; given: replaced; null: cleared
    const kept = apply(
      { tours: [{ id: "tour:new", title: "Renamed" }] },
      { explainer: create.explainer },
    );
    expect(tourOf(kept, "tour:new").summary).toBe("What this is. Why it matters.");
    const replaced = apply(
      { tours: [{ id: "tour:new", summary: "Better." }] },
      { explainer: create.explainer },
    );
    expect(tourOf(replaced, "tour:new").summary).toBe("Better.");
    const cleared = apply(
      { tours: [{ id: "tour:new", summary: null }] },
      { explainer: create.explainer },
    );
    expect(cleared.ok).toBe(true);
    expect("summary" in tourOf(cleared, "tour:new")).toBe(false);
    // not a string: an error that names the field
    const bad = apply(
      { tours: [{ id: "tour:new", summary: 3 } as never] },
      { explainer: create.explainer },
    );
    expect(bad.ok).toBe(false);
    expect(bad.issues[0]).toMatchObject({
      path: "tours[0].summary",
      message: "summary must be a string",
    });
    // a user's summary is a user field: an llm patch keeps it, and cannot clear it
    const mine = apply({ tours: [{ id: "tour:intro", summary: "Mine." }] }, { actor: "user" });
    expect(tourOf(mine).provenance).toEqual({ origin: "llm", userFields: ["summary"] });
    for (const summary of ["Not yours.", null]) {
      const llm = apply({ tours: [{ id: "tour:intro", summary }] }, { explainer: mine.explainer });
      expect(tourOf(llm).summary).toBe("Mine.");
      expect(protectedOf(llm)).toEqual([["tours[0].summary", "tour:intro"]]);
    }
  });

  it("a patch that touches only what the user owns changes nothing (the CLI turns that into exit 1)", () => {
    const edited = apply({ tours: [{ id: "tour:intro", steps }] }, { actor: "user" });
    const r = apply({ tours: [{ id: "tour:intro", steps: [] }] }, { explainer: edited.explainer });
    expect(r).toMatchObject({ ok: true, changed: [] });
    expect(protectedOf(r)).toEqual([["tours[0].steps", "tour:intro"]]);
    expect(r.explainer).toEqual(edited.explainer);
  });

  it("a tour written before tours had provenance is the llm's: an llm edit records it", () => {
    const legacy = seed();
    expect("provenance" in legacy.tours[0]!).toBe(false);
    const r = apply({ tours: [{ id: "tour:intro", title: "Retitled" }] }, { explainer: legacy });
    expect(tourOf(r)).toMatchObject({
      title: "Retitled",
      provenance: { origin: "llm", commit: "c1" },
    });
    // an unchanged one stays as it is, provenance-less
    const same = apply({ tours: [{ id: "tour:intro", title: "Intro" }] }, { explainer: legacy });
    expect(same.changed).toEqual([]);
    expect("provenance" in tourOf(same)).toBe(false);
  });

  it("an adopting user patch may set provenance; an llm one cannot", () => {
    const adopted = apply(
      { tours: [{ id: "tour:intro", provenance: { origin: "user" } }] },
      { actor: "user" },
    );
    expect(tourOf(adopted).provenance).toEqual({ origin: "user" });
    expect(
      apply({ tours: [{ id: "tour:intro", provenance: { origin: "user" } }] }).explainer,
    ).toEqual(apply({ tours: [{ id: "tour:intro" }] }).explainer);
  });

  it("validation checks a tour's provenance when it has one", () => {
    const ex = seed();
    (ex.tours[0] as { provenance: unknown }).provenance = { origin: "robot" };
    const issues = validateExplainer(ex, w.index, w.getText, { mode: "strict" });
    expect(issues.map((i) => [i.path, i.elementId])).toContainEqual([
      "tours[0].provenance.origin",
      "tour:intro",
    ]);
    expect(validateExplainer(seed(), w.index, w.getText, { mode: "strict" })).toEqual([]);
  });
});

// ─── Spans that start or end on a blank line ────────────────────────────────────────────────────

describe("applyPatch: a span that starts or ends on a blank line", () => {
  const text = [
    "export function f() {", // 1
    "  const a = 1;", // 2
    "", // 3
    "  const b = 2;", // 4
    "", // 5
    "  return a + b;", // 6
    "}", // 7
  ].join("\n");
  const bw = makeWorld({
    files: [{ path: "src/a.ts", text }],
    symbols: [{ id: "src/a.ts#f", kind: "function", start: 1, end: 7 }],
  });
  const applyTo = (anchors: unknown[]) =>
    applyPatch(
      emptyExplainer(),
      { concepts: [{ id: "concept:x", label: "X", anchors: anchors as never }] },
      bw.index,
      bw.getText,
      { actor: "llm" },
    );
  const span = (from: number, to: number) => ({
    file: "src/a.ts",
    symbol: "f",
    span: { from, to },
    role: "usage",
  });

  it("warns that it is probably off by one, and says where the code is", () => {
    const r = applyTo([span(1, 2)]); // lines 2-3: ends on the blank line 3
    expect(r.ok).toBe(true);
    expect(warningsOf(r)).toEqual([
      expect.objectContaining({
        path: "concepts[0].anchors[0]",
        elementId: "concept:x",
        code: "anchor-invalid",
        message: expect.stringContaining(
          "span src/a.ts#f +1..2 ends on a blank line (line 3): probably off by one, the code in it ends at line 2 (offset 1)",
        ),
      }),
    ]);
    const start = applyTo([span(2, 3)]); // lines 3-4: starts on the blank line 3
    expect(warningsOf(start)[0]!.message).toContain(
      "starts on a blank line (line 3): probably off by one, the code in it starts at line 4 (offset 3)",
    );
    const both = applyTo([span(2, 4)]); // lines 3-5: both edges blank
    expect(
      warningsOf(both).map((i) => i.message.match(/(starts|ends) on a blank line/)?.[0]),
    ).toEqual(["starts on a blank line", "ends on a blank line"]);
  });

  it("stays quiet for spans on code, for find anchors, and for anchors resent with their hash", () => {
    expect(warningsOf(applyTo([span(1, 3)]))).toEqual([]); // lines 2-4: code at both edges, a blank inside
    expect(warningsOf(applyTo([span(0, 6)]))).toEqual([]);
    expect(
      warningsOf(applyTo([{ file: "src/a.ts", symbol: "f", find: "const a = 1;", role: "usage" }])),
    ).toEqual([]);
    const stored = (applyTo([span(1, 3)]).explainer.concepts[0] as { anchors: unknown[] }).anchors;
    expect(warningsOf(applyTo(stored))).toEqual([]);
    // a stored anchor whose span has a blank edge (made before this warning) is not nagged about either
    expect(warningsOf(applyTo([anchor(bw, span(1, 2) as never)]))).toEqual([]);
  });

  it("a span of blank lines only is still an error", () => {
    const r = applyTo([span(2, 2)]);
    expect(r.ok).toBe(false);
    expect(errorsOf(r)[0]!.message).toContain("covers only blank lines");
  });
});
