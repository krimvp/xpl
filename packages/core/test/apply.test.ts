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
          hash: expect.stringMatching(/^sha256:[0-9a-f]{12}$/),
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
    expect(errs[0]!.message).toContain("Did you mean: src/queue.ts#Queue.pop");
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

  it("never gives a tour a provenance, whoever edits it", () => {
    const llm = apply({ tours: [{ id: "tour:intro", title: "Renamed" }] });
    expect("provenance" in el(llm.explainer.tours, "tour:intro")).toBe(false);
    const user = apply({ tours: [{ id: "tour:intro", title: "Mine" }] }, { actor: "user" });
    expect(user.changed).toEqual(["tour:intro"]);
    expect(el(user.explainer.tours, "tour:intro")).toEqual({
      id: "tour:intro",
      title: "Mine",
      steps: seed().tours[0]!.steps,
    });
    expect(
      apply({ tours: [{ id: "tour:intro", title: "x", provenance: { origin: "user" } } as never] })
        .ok,
    ).toBe(false);
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
    // tours have no provenance: an llm patch may replace one
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
    const r = apply({ remove: [DISPATCH.replace("dispatch", "dispatch"), "concept:nope"] });
    expect(r.ok).toBe(true);
    expect(r.explainer.nodes.map((n) => n.id)).toEqual(["grp:scheduling"]);
    expect(warningsOf(r)).toEqual([
      expect.objectContaining({ path: "remove[1]", elementId: "concept:nope" }),
    ]);
    expect(r.changed).toEqual([DISPATCH]);
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
