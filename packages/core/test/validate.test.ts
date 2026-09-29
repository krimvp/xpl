import { describe, expect, it } from "vitest";
import {
  validateExplainer,
  type Anchor,
  type Explainer,
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
  LLM,
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

const A = {
  dispatchDef: anchor(w, { file: "src/runner.ts", symbol: "Runner.dispatch", role: "definition" }),
  popCall: anchor(w, {
    file: "src/runner.ts",
    symbol: "Runner.dispatch",
    span: { from: 4, to: 4 },
    role: "call-site",
  }),
  popDef: anchor(w, { file: "src/queue.ts", symbol: "Queue.pop", role: "definition" }),
  runCall: anchor(w, {
    file: "src/runner.ts",
    symbol: "Runner.dispatch",
    span: { from: 18, to: 19 },
    role: "call-site",
  }),
  runDef: anchor(w, { file: "src/worker.ts", symbol: "Worker.run", role: "definition" }),
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
  config: anchor(w, { file: "config/default.yaml", symbol: "retry", role: "config" }),
  test: anchor(w, { file: "test/retry.test.ts", role: "test" }),
};

/** A valid explainer shaped like the handoff example. */
function baseline(): Explainer {
  return JSON.parse(
    JSON.stringify(
      emptyExplainer({
        nodes: [
          group("grp:scheduling", [F.runner, F.queue], { summary: "Decides what runs next." }),
          {
            id: DISPATCH,
            kind: "symbol",
            parent: "sym:src/runner.ts#Runner",
            label: "Runner.dispatch",
            summary: "The hot loop.",
            anchors: [A.dispatchDef],
            provenance: { origin: "llm", userFields: ["summary"], commit: "c1" },
          },
        ],
        edges: [
          edge("edge:job-completed", F.worker, F.metrics, [A.emit, A.handler], {
            label: "job.completed",
            kind: "emits",
          }),
        ],
        concepts: [
          concept("concept:retry-policy", [A.retryBlock, A.config, A.test], {
            related: [DISPATCH, F.queue],
            provenance: USER,
          }),
        ],
        views: [
          graphView("view:overview", ["grp:scheduling", F.worker, F.metrics]),
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
                to: F.worker,
                label: "run(job)",
                kind: "call",
                anchors: [A.runCall, A.runDef],
              },
              {
                id: "dispatch:3",
                from: DISPATCH,
                to: F.queue,
                label: "requeue(job, backoff)",
                kind: "call",
                anchors: [A.requeueCall, A.requeueDef],
              },
            ],
            {
              frames: [
                {
                  id: "frame:retry",
                  kind: "loop",
                  label: "until success",
                  fromStep: "dispatch:2",
                  toStep: "dispatch:3",
                },
              ],
              scope: {
                root: "repo",
                depth: 3,
                question: "How is a job dispatched?",
                entryPoints: ["src/runner.ts#Runner.dispatch"],
              },
            },
          ),
        ],
        tours: [
          {
            id: "tour:intro",
            title: "Intro",
            steps: [
              { id: "t1", view: "view:overview", focus: ["grp:scheduling"], note: "Big picture." },
              {
                id: "t2",
                view: "view:dispatch",
                focus: ["dispatch:3", "concept:retry-policy"],
                editor: { primary: "src/runner.ts" },
                code: [A.requeueCall],
              },
            ],
          },
        ],
      }),
    ),
  );
}

type Mode = "strict" | "lenient";
function check(ex: Explainer, mode: Mode = "strict", world: World = w): Issue[] {
  return validateExplainer(ex, world.index, world.getText, { mode });
}
function edit(mutate: (ex: Explainer) => void, mode: Mode = "strict", world: World = w): Issue[] {
  const ex = baseline();
  mutate(ex);
  return check(ex, mode, world);
}
const seq = (ex: Explainer): SequenceView => ex.views[1] as SequenceView;
const only = (issues: Issue[]): Issue => {
  expect(issues).toHaveLength(1);
  return issues[0]!;
};
const has = (issues: Issue[], match: Partial<Issue> & { text?: string }): boolean =>
  issues.some(
    (i) =>
      (match.path === undefined || i.path === match.path) &&
      (match.code === undefined || i.code === match.code) &&
      (match.severity === undefined || i.severity === match.severity) &&
      (match.elementId === undefined || i.elementId === match.elementId) &&
      (match.text === undefined || i.message.includes(match.text)),
  );
const errs = (issues: Issue[]) => issues.filter((i) => i.severity === "error");
const warns = (issues: Issue[]) => issues.filter((i) => i.severity === "warning");

/** A world where Runner.dispatch's retry block changed and Queue.pop is gone. */
function drifted(): World {
  const runner = RUNNER_TEXT.split("\n")
    .map((line, i) => (i + 1 === 77 ? "          job, extra," : line))
    .join("\n");
  return makeWorld({
    ...JOBRUNNER,
    files: JOBRUNNER.files.map((f) => (f.path === "src/runner.ts" ? { ...f, text: runner } : f)),
    symbols: JOBRUNNER.symbols!.filter((s) => s.id !== "src/queue.ts#Queue.pop"),
  });
}

describe("validateExplainer: a valid explainer", () => {
  it("has no issues in either mode", () => {
    expect(check(baseline())).toEqual([]);
    expect(check(baseline(), "lenient")).toEqual([]);
  });

  it("defaults to strict mode", () => {
    const ex = baseline();
    ex.nodes.push(group("grp:x", ["file:src/gone.ts"]));
    expect(validateExplainer(ex, w.index, w.getText)).toHaveLength(1);
    expect(validateExplainer(ex, w.index, w.getText)[0]!.severity).toBe("error");
  });

  it("accepts a shared TextCache-free call with a raw SymbolIndex", () => {
    expect(validateExplainer(baseline(), w.index, w.getText, { mode: "strict" })).toEqual([]);
  });
});

describe("validateExplainer: top level", () => {
  it("checks schema, title, repo, index and the arrays", () => {
    expect(only(edit((ex) => ((ex as { schema: string }).schema = "nope")))).toMatchObject({
      path: "schema",
    });
    expect(only(edit((ex) => (ex.title = "")))).toMatchObject({
      severity: "warning",
      path: "title",
    });
    expect(only(edit((ex) => ((ex as { repo: unknown }).repo = { name: 1 })))).toMatchObject({
      path: "repo",
    });
    expect(only(edit((ex) => ((ex as { index: unknown }).index = {})))).toMatchObject({
      path: "index",
    });
    const noArrays = edit((ex) => {
      (ex as { edges: unknown }).edges = {};
      (ex as { tours: unknown }).tours = undefined;
    });
    expect(noArrays.map((i) => i.path)).toEqual(["edges", "tours"]);
    expect(check(null as never)).toEqual([
      expect.objectContaining({ severity: "error", path: "" }),
    ]);
  });

  it("warns when the explainer was resolved against another index", () => {
    const issue = only(edit((ex) => (ex.index.commit = "old")));
    expect(issue).toMatchObject({ severity: "warning", path: "index.commit", code: "commit" });
    expect(issue.message).toContain("xpl resolve");
  });
});

describe("validateExplainer: ids", () => {
  it("rejects duplicate ids across nodes, edges, concepts and steps", () => {
    const dup = edit((ex) => ex.nodes.push(group("grp:scheduling", [F.queue])));
    expect(only(dup)).toMatchObject({
      severity: "error",
      path: "nodes[2].id",
      elementId: "grp:scheduling",
      code: "duplicate-id",
    });
    expect(dup[0]!.message).toContain("nodes[0]");
    const crossKind = edit((ex) => ex.concepts.push(concept("edge:job-completed")));
    expect(crossKind.some((i) => i.code === "duplicate-id" && i.path === "concepts[1].id")).toBe(
      true,
    );
    const stepClash = edit((ex) => (seq(ex).steps[0]!.id = "dispatch:2"));
    expect(stepClash.filter((i) => i.code === "duplicate-id")).toHaveLength(1);
    expect(stepClash.find((i) => i.code === "duplicate-id")!.path).toBe("views[1].steps[1].id");
    // a step id clashing with a stored edge id
    const withStepEdge = edit((ex) => {
      ex.edges.push(edge("dispatch:3", F.worker, F.metrics, [A.emit, A.handler]));
    });
    expect(
      withStepEdge.some((i) => i.code === "duplicate-id" && i.path === "views[1].steps[2].id"),
    ).toBe(true);
  });

  it("rejects duplicate view ids, tour ids, frame ids and tour step ids", () => {
    expect(only(edit((ex) => ex.views.push({ ...ex.views[0]! })))).toMatchObject({
      path: "views[2].id",
      code: "duplicate-id",
    });
    expect(only(edit((ex) => ex.tours.push({ ...ex.tours[0]! })))).toMatchObject({
      path: "tours[1].id",
      code: "duplicate-id",
    });
    const frames = edit((ex) => seq(ex).frames!.push({ ...seq(ex).frames![0]! }));
    expect(frames.filter((i) => i.code === "duplicate-id")).toEqual([
      expect.objectContaining({ path: "views[1].frames[1].id" }),
    ]);
    expect(only(edit((ex) => (ex.tours[0]!.steps[1]!.id = "t1")))).toMatchObject({
      path: "tours[0].steps[1].id",
      code: "duplicate-id",
    });
  });

  it("requires the id prefixes of section 4.3", () => {
    expect(
      has(
        edit((ex) => (ex.concepts[0]!.id = "retry-policy")),
        { path: "concepts[0].id", code: "bad-id" },
      ),
    ).toBe(true);
    expect(only(edit((ex) => (ex.edges[0]!.id = "job-completed")))).toMatchObject({
      path: "edges[0].id",
      code: "bad-id",
    });
    expect(
      has(
        edit((ex) => (ex.views[0]!.id = "overview")),
        { path: "views[0].id", code: "bad-id" },
      ),
    ).toBe(true);
    expect(only(edit((ex) => (ex.tours[0]!.id = "intro")))).toMatchObject({
      path: "tours[0].id",
      code: "bad-id",
    });
    expect(only(edit((ex) => (seq(ex).frames![0]!.id = "retry")))).toMatchObject({
      path: "views[1].frames[0].id",
      code: "bad-id",
    });
    expect(
      has(
        edit((ex) => (ex.nodes[0]!.id = "scheduling")),
        { path: "nodes[0].id", code: "bad-id" },
      ),
    ).toBe(true);
    const step = edit((ex) => (seq(ex).steps[0]!.id = "first"));
    expect(only(step)).toMatchObject({ path: "views[1].steps[0].id", code: "step" });
    expect(step[0]!.message).toContain('"dispatch:1"');
  });

  it("checks slugs and reserved view slugs", () => {
    expect(
      has(
        edit((ex) => (ex.concepts[0]!.id = "concept:retry policy")),
        { path: "concepts[0].id", code: "bad-id" },
      ),
    ).toBe(true);
    expect(
      has(
        edit((ex) => (ex.nodes[0]!.id = "grp:")),
        { path: "nodes[0].id", code: "bad-id" },
      ),
    ).toBe(true);
    expect(
      has(
        edit((ex) => (ex.views[0]!.id = "view:file")),
        { text: "reserved" },
      ),
    ).toBe(true);
    expect(
      has(
        edit((ex) => (ex.views[0]!.id = "view:a b")),
        { path: "views[0].id", code: "bad-id" },
      ),
    ).toBe(true);
  });

  it("warns when a step id does not carry its view's slug", () => {
    const issue = only(edit((ex) => (seq(ex).steps[0]!.id = "other:1")));
    expect(issue).toMatchObject({
      severity: "warning",
      path: "views[1].steps[0].id",
      code: "step",
    });
  });

  it("requires stored structural ids to match their kind and exist in the index", () => {
    expect(
      only(
        edit((ex) =>
          ex.nodes.push({
            id: "file:src/queue.ts",
            kind: "dir",
            parent: "dir:src",
            label: "Q",
            anchors: [],
            provenance: LLM,
          }),
        ),
      ),
    ).toMatchObject({
      path: "nodes[2].kind",
      code: "bad-id",
    });
    const gone = edit((ex) =>
      ex.nodes.push({
        id: "file:src/gone.ts",
        kind: "file",
        parent: "dir:src",
        label: "G",
        anchors: [],
        provenance: LLM,
      }),
    );
    expect(only(gone)).toMatchObject({
      severity: "error",
      path: "nodes[2].id",
      code: "unknown-id",
    });
    const lenient = edit(
      (ex) =>
        ex.nodes.push({
          id: "file:src/gone.ts",
          kind: "file",
          parent: "dir:src",
          label: "G",
          anchors: [],
          provenance: LLM,
        }),
      "lenient",
    );
    expect(only(lenient).severity).toBe("warning");
    expect(
      only(
        edit((ex) =>
          ex.nodes.push({
            id: "sym:src/runner.ts#Nope",
            kind: "symbol",
            parent: "file:src/runner.ts",
            label: "N",
            anchors: [],
            provenance: LLM,
          }),
        ),
      ),
    ).toMatchObject({ code: "unknown-id" });
    expect(
      only(
        edit((ex) =>
          ex.nodes.push({
            id: "wat:x",
            kind: "file",
            parent: "repo",
            label: "W",
            anchors: [],
            provenance: LLM,
          }),
        ),
      ),
    ).toMatchObject({ code: "bad-id" });
  });

  it("warns when a structural overlay names a different parent than the index", () => {
    const issue = only(edit((ex) => (ex.nodes[1]!.parent = "file:src/runner.ts")));
    expect(issue).toMatchObject({ severity: "warning", path: "nodes[1].parent" });
    expect(issue.message).toContain("sym:src/runner.ts#Runner");
  });
});

describe("validateExplainer: references", () => {
  it("checks group parents, members and cycles", () => {
    expect(only(edit((ex) => (ex.nodes[0]!.parent = "grp:nope")))).toMatchObject({
      path: "nodes[0].parent",
      code: "unknown-id",
    });
    expect(only(edit((ex) => (ex.nodes[0]!.parent = null as never)))).toMatchObject({
      path: "nodes[0].parent",
    });
    expect(only(edit((ex) => ex.nodes[0]!.members!.push("grp:nope")))).toMatchObject({
      path: "nodes[0].members[2]",
      code: "unknown-id",
    });
    expect(only(edit((ex) => ex.nodes[0]!.members!.push("concept:retry-policy")))).toMatchObject({
      path: "nodes[0].members[2]",
    });
    expect(only(edit((ex) => ex.nodes[0]!.members!.push("grp:scheduling")))).toMatchObject({
      code: "cycle",
    });
    expect(only(edit((ex) => (ex.nodes[0]!.members = [])))).toMatchObject({ severity: "warning" });
    expect(only(edit((ex) => delete ex.nodes[0]!.members))).toMatchObject({
      path: "nodes[0].members",
    });
    const cycle = edit((ex) => {
      ex.nodes[0]!.members!.push("grp:b");
      ex.nodes.push(group("grp:b", ["grp:scheduling"]));
    });
    expect(cycle.filter((i) => i.code === "cycle")).toHaveLength(1);
    expect(cycle.find((i) => i.code === "cycle")!.message).toContain(
      "grp:scheduling -> grp:b -> grp:scheduling",
    );
    expect(only(edit((ex) => (ex.nodes[1]!.members = [F.queue])))).toMatchObject({
      severity: "warning",
      path: "nodes[1].members",
    });
  });

  it("checks the repo node's parent", () => {
    const repo = (parent: string | null) => ({
      id: "repo",
      kind: "repo" as const,
      parent,
      label: "R",
      anchors: [],
      provenance: LLM,
    });
    expect(edit((ex) => ex.nodes.push(repo(null)))).toEqual([]);
    expect(only(edit((ex) => ex.nodes.push(repo("dir:src"))))).toMatchObject({
      path: "nodes[2].parent",
    });
  });

  it("checks edge ends: they must exist and be nodes, with suggestions", () => {
    const unknown = edit((ex) => (ex.edges[0]!.from = "sym:src/queue.ts#Que.pop"));
    const issue = unknown.find((i) => i.path === "edges[0].from")!;
    expect(issue).toMatchObject({
      severity: "error",
      code: "unknown-id",
      elementId: "edge:job-completed",
    });
    expect(issue.message).toContain("Did you mean: src/queue.ts#Queue.pop");
    expect(
      edit((ex) => (ex.edges[0]!.to = "concept:retry-policy")).find(
        (i) => i.path === "edges[0].to",
      )!.message,
    ).toContain("not a node");
    expect(
      edit((ex) => (ex.edges[0]!.to = "nonsense")).find((i) => i.path === "edges[0].to")!.message,
    ).toContain("not an element id");
    expect(
      edit((ex) => (ex.edges[0]!.from = "grp:nope")).find((i) => i.path === "edges[0].from")!
        .message,
    ).toContain("no group");
    expect(
      edit((ex) => (ex.edges[0]!.from = 5 as never)).some((i) => i.path === "edges[0].from"),
    ).toBe(true);
  });

  it("suggests the id when a loose form was written", () => {
    const loose = edit((ex) => (ex.edges[0]!.from = "src/queue.ts#Queue.pop"));
    const issue = loose.find((i) => i.path === "edges[0].from")!;
    expect(issue.message).toContain("did you mean sym:src/queue.ts#Queue.pop?");
    const file = edit(
      (ex) =>
        ex.views[0]!.type === "graph" && (ex.views[0] as GraphView).include.push("src/queue.ts"),
    );
    expect(file.find((i) => i.path === "views[0].include[3]")!.message).toContain(
      "did you mean file:src/queue.ts?",
    );
    const hopeless = edit((ex) => (ex.edges[0]!.to = "zzz"));
    expect(hopeless.find((i) => i.path === "edges[0].to")!.message).toContain("expected repo");
  });

  it("checks concept related ids: any element", () => {
    expect(
      edit((ex) =>
        ex.concepts[0]!.related!.push(
          "edge:job-completed",
          "dispatch:1",
          "concept:retry-policy",
          "grp:scheduling",
          `edge:calls:${F.runner}->${F.queue}`,
        ),
      ),
    ).toEqual([]);
    expect(only(edit((ex) => ex.concepts[0]!.related!.push("edge:nope")))).toMatchObject({
      path: "concepts[0].related[2]",
      elementId: "concept:retry-policy",
    });
    expect(only(edit((ex) => ex.concepts[0]!.related!.push("dispatch:9")))).toMatchObject({
      code: "unknown-id",
    });
    expect(only(edit((ex) => (ex.concepts[0]!.related = "x" as never)))).toMatchObject({
      path: "concepts[0].related",
    });
  });

  it("checks graph view include, hidden, layout, edgeKinds and scope", () => {
    const view = (ex: Explainer) => ex.views[0] as ReturnType<typeof graphView>;
    expect(only(edit((ex) => view(ex).include.push("file:src/nope.ts")))).toMatchObject({
      path: "views[0].include[3]",
      elementId: "view:overview",
      code: "unknown-id",
    });
    expect(only(edit((ex) => view(ex).include.push("concept:retry-policy")))).toMatchObject({
      path: "views[0].include[3]",
    });
    expect(only(edit((ex) => view(ex).include.push(F.worker)))).toMatchObject({
      severity: "warning",
      path: "views[0].include[3]",
    });
    expect(only(edit((ex) => (view(ex).hidden = ["file:src/nope.ts"])))).toMatchObject({
      path: "views[0].hidden[0]",
    });
    expect(
      edit(
        (ex) =>
          (view(ex).hidden = [
            F.worker,
            "edge:job-completed",
            `edge:calls:${F.runner}->${F.queue}`,
            `ghost:${F.queue}`,
            `stub:out:${F.worker}->ghost:${F.queue}`,
          ]),
      ),
    ).toEqual([]);
    expect(only(edit((ex) => (view(ex).hidden = [`ghost:file:nope`])))).toMatchObject({
      path: "views[0].hidden[0]",
    });
    expect(
      edit(
        (ex) =>
          (view(ex).layout = { [F.worker]: { x: 1, y: 2 }, [`ghost:${F.queue}`]: { x: 0, y: 0 } }),
      ),
    ).toEqual([]);
    expect(
      only(edit((ex) => (view(ex).layout = { "file:src/nope.ts": { x: 1, y: 2 } }))),
    ).toMatchObject({ path: "views[0].layout.file:src/nope.ts" });
    expect(
      only(edit((ex) => (view(ex).layout = { [F.worker]: { x: "1", y: 2 } as never }))),
    ).toMatchObject({ path: `views[0].layout.${F.worker}` });
    expect(only(edit((ex) => (view(ex).edgeKinds = ["calls", "flies" as never])))).toMatchObject({
      path: "views[0].edgeKinds",
    });
    expect(edit((ex) => (view(ex).edgeKinds = ["calls", "imports"]))).toEqual([]);
    expect(only(edit((ex) => (view(ex).include = "x" as never)))).toMatchObject({
      path: "views[0].include",
    });
  });

  it("checks scope", () => {
    const view = (ex: Explainer) => ex.views[0]!;
    expect(only(edit((ex) => (view(ex).scope.root = "dir:nope")))).toMatchObject({
      path: "views[0].scope.root",
    });
    expect(only(edit((ex) => (view(ex).scope.depth = -1)))).toMatchObject({
      path: "views[0].scope.depth",
    });
    expect(only(edit((ex) => (view(ex).scope.entryPoints = ["src/runner.ts#Nope"])))).toMatchObject(
      { path: "views[0].scope.entryPoints[0]" },
    );
    expect(only(edit((ex) => ((view(ex) as { scope: unknown }).scope = null)))).toMatchObject({
      path: "views[0].scope",
    });
    expect(only(edit((ex) => (view(ex).type = "chart" as never)))).toMatchObject({
      path: "views[0].type",
    });
  });

  it("checks sequence participants and steps", () => {
    expect(only(edit((ex) => seq(ex).participants.push("file:src/nope.ts")))).toMatchObject({
      path: "views[1].participants[3]",
    });
    expect(only(edit((ex) => seq(ex).participants.push(F.queue)))).toMatchObject({
      severity: "warning",
    });
    const from = edit((ex) => (seq(ex).steps[0]!.from = "file:src/nope.ts"));
    expect(from.find((i) => i.path === "views[1].steps[0].from")).toMatchObject({
      elementId: "dispatch:1",
    });
    const notParticipant = edit((ex) => (seq(ex).steps[0]!.to = F.metrics));
    expect(only(notParticipant)).toMatchObject({ path: "views[1].steps[0].to", code: "step" });
    expect(notParticipant[0]!.message).toContain("not a participant");
    expect(only(edit((ex) => (seq(ex).steps[0]!.kind = "jump" as never)))).toMatchObject({
      path: "views[1].steps[0].kind",
    });
  });

  it("checks a step's edge: stored or derivable edges only", () => {
    expect(
      edit((ex) => (seq(ex).steps[0]!.edge = `edge:calls:${DISPATCH}->sym:src/queue.ts#Queue.pop`)),
    ).toEqual([]);
    expect(edit((ex) => (seq(ex).steps[0]!.edge = "edge:job-completed"))).toEqual([]);
    expect(only(edit((ex) => (seq(ex).steps[0]!.edge = "edge:nope")))).toMatchObject({
      path: "views[1].steps[0].edge",
      elementId: "dispatch:1",
    });
    expect(only(edit((ex) => (seq(ex).steps[0]!.edge = "concept:retry-policy")))).toMatchObject({
      path: "views[1].steps[0].edge",
    });
    expect(
      only(
        edit((ex) => (seq(ex).steps[0]!.edge = `edge:calls:${DISPATCH}->sym:src/queue.ts#Nope`)),
      ),
    ).toMatchObject({ code: "unknown-id" });
  });

  it("checks frames: steps must exist in the view and be ordered", () => {
    expect(only(edit((ex) => (seq(ex).frames![0]!.toStep = "dispatch:9")))).toMatchObject({
      path: "views[1].frames[0].toStep",
      code: "frame",
    });
    expect(only(edit((ex) => (seq(ex).frames![0]!.fromStep = "nope:1")))).toMatchObject({
      path: "views[1].frames[0].fromStep",
    });
    const reversed = edit((ex) => {
      seq(ex).frames![0]!.fromStep = "dispatch:3";
      seq(ex).frames![0]!.toStep = "dispatch:2";
    });
    expect(only(reversed)).toMatchObject({
      path: "views[1].frames[0]",
      code: "frame",
      elementId: "view:dispatch",
    });
    expect(reversed[0]!.message).toContain("comes after");
    expect(
      edit((ex) =>
        seq(ex).frames!.push({
          id: "frame:inner",
          kind: "opt",
          label: "x",
          fromStep: "dispatch:3",
          toStep: "dispatch:3",
        }),
      ),
    ).toEqual([]);
    const crossing = edit((ex) =>
      seq(ex).frames!.push({
        id: "frame:cross",
        kind: "alt",
        label: "x",
        fromStep: "dispatch:1",
        toStep: "dispatch:2",
      }),
    );
    expect(only(crossing)).toMatchObject({ severity: "warning", code: "frame" });
    expect(only(edit((ex) => (seq(ex).frames![0]!.kind = "while" as never)))).toMatchObject({
      path: "views[1].frames[0].kind",
    });
    // a frame that only touches another at a step is a crossing too; equal ranges nest
    expect(
      edit((ex) =>
        seq(ex).frames!.push({
          id: "frame:same",
          kind: "opt",
          label: "x",
          fromStep: "dispatch:2",
          toStep: "dispatch:3",
        }),
      ),
    ).toEqual([]);
  });

  it("checks tours: view, focus, primary file", () => {
    expect(only(edit((ex) => (ex.tours[0]!.steps[0]!.view = "view:nope")))).toMatchObject({
      path: "tours[0].steps[0].view",
      code: "unknown-id",
    });
    expect(only(edit((ex) => ex.tours[0]!.steps[0]!.focus.push("grp:nope")))).toMatchObject({
      path: "tours[0].steps[0].focus[1]",
    });
    expect(only(edit((ex) => ex.tours[0]!.steps[0]!.focus.push("dispatch:1")))).toMatchObject({
      severity: "warning",
      path: "tours[0].steps[0].focus[1]",
    });
    expect(
      edit((ex) => ex.tours[0]!.steps[0]!.focus.push("edge:job-completed", "concept:retry-policy")),
    ).toEqual([]);
    expect(
      only(edit((ex) => (ex.tours[0]!.steps[1]!.editor!.primary = "src/nope.ts"))),
    ).toMatchObject({ path: "tours[0].steps[1].editor.primary" });
    expect(only(edit((ex) => (ex.tours[0]!.steps[1]!.editor = "x" as never)))).toMatchObject({
      path: "tours[0].steps[1].editor",
    });
    expect(
      only(edit((ex) => ((ex.tours[0]!.steps[0] as { focus: unknown }).focus = "x"))),
    ).toMatchObject({ path: "tours[0].steps[0].focus" });
  });
});

describe("validateExplainer: anchors", () => {
  const dw = drifted();

  it("accepts ok and moved anchors in strict mode", () => {
    const shifted = makeWorld({
      ...JOBRUNNER,
      files: JOBRUNNER.files.map((f) =>
        f.path === "src/queue.ts" ? { ...f, text: "// pad\n" + w.texts["src/queue.ts"] } : f,
      ),
      symbols: JOBRUNNER.symbols!.map((s) =>
        s.id.startsWith("src/queue.ts#") ? { ...s, start: s.start + 1, end: s.end + 1 } : s,
      ),
    });
    expect(check(baseline(), "strict", shifted)).toEqual([]);
  });

  it("reports drifted anchors as errors in strict mode, with element, path and message", () => {
    const issues = check(baseline(), "strict", dw);
    const drift = issues.filter((i) => i.code === "anchor-drifted");
    expect(drift).toHaveLength(4);
    const byPath = Object.fromEntries(drift.map((i) => [i.path, i]));
    expect(byPath["concepts[0].anchors[0]"]).toMatchObject({
      severity: "error",
      elementId: "concept:retry-policy",
    });
    expect(byPath["concepts[0].anchors[0]"]!.message).toContain(
      "src/runner.ts#Runner.dispatch +30..41",
    );
    expect(byPath["nodes[1].anchors[0]"]).toMatchObject({ elementId: DISPATCH });
    expect(byPath["views[1].steps[2].anchors[0]"]).toMatchObject({
      elementId: "dispatch:3",
      severity: "error",
    });
    expect(byPath["tours[0].steps[1].code[0]"]).toMatchObject({ elementId: "tour:intro" });
  });

  it("reports missing anchors, per anchor", () => {
    const issues = check(baseline(), "strict", dw).filter((i) => i.code === "anchor-missing");
    expect(issues.map((i) => i.path).sort()).toEqual(["views[1].steps[0].anchors[1]"]);
    expect(issues[0]).toMatchObject({ severity: "error", elementId: "dispatch:1" });
    expect(issues[0]!.message).toContain("Queue.pop");
  });

  it("downgrades drifted and missing anchors to warnings in lenient mode, and only those", () => {
    const strict = check(baseline(), "strict", dw);
    const lenient = check(baseline(), "lenient", dw);
    expect(lenient).toHaveLength(strict.length);
    expect(errs(lenient)).toEqual([]);
    expect(
      warns(lenient)
        .map((i) => i.code)
        .sort(),
    ).toEqual(strict.map((i) => i.code).sort());
  });

  it("checks the shape of anchors", () => {
    expect(only(edit((ex) => ((ex.concepts[0]!.anchors as unknown) = "x")))).toMatchObject({
      path: "concepts[0].anchors",
    });
    expect(only(edit((ex) => (ex.concepts[0]!.anchors[0] = null as never)))).toMatchObject({
      path: "concepts[0].anchors[0]",
      code: "anchor-invalid",
    });
    expect(
      edit((ex) => ((ex.concepts[0]!.anchors[0] as { role: string }).role = "nope")).some(
        (i) => i.path === "concepts[0].anchors[0].role",
      ),
    ).toBe(true);
    expect(
      edit((ex) => ((ex.concepts[0]!.anchors[0] as { file: string }).file = "")).some(
        (i) => i.code === "anchor-invalid",
      ),
    ).toBe(true);
    expect(
      edit((ex) => ((ex.concepts[0]!.anchors[0] as { hash: unknown }).hash = 5)).some(
        (i) => i.path === "concepts[0].anchors[0].hash",
      ),
    ).toBe(true);
  });

  it("resolves anchors against the current text, not only the cached status", () => {
    const stale = baseline();
    (stale.concepts[0]!.anchors[0] as Anchor).hash = "sha256:000000000000"; // cache says ok, hash disagrees
    expect(check(stale).some((i) => i.code === "anchor-drifted")).toBe(true);
  });
});

describe("validateExplainer: llm edge evidence", () => {
  const llmEdge = (from: string, to: string, anchors: Anchor[], provenance = LLM) =>
    edge("edge:x", from, to, anchors, { provenance });
  const withEdge = (e: ReturnType<typeof edge>, mode: Mode = "strict") =>
    edit((ex) => (ex.edges = [e]), mode);

  it("needs an anchor inside from and one inside to", () => {
    expect(withEdge(llmEdge(F.worker, F.metrics, [A.emit, A.handler]))).toEqual([]);
    const none = withEdge(llmEdge(F.worker, F.metrics, []));
    expect(none.map((i) => [i.code, i.path, i.elementId])).toEqual([
      ["evidence", "edges[0].anchors", "edge:x"],
      ["evidence", "edges[0].anchors", "edge:x"],
    ]);
    expect(none[0]!.message).toContain("inside its from (file:src/worker.ts)");
    expect(none[1]!.message).toContain("inside its to (file:src/metrics.ts)");
    const onlyFrom = withEdge(llmEdge(F.worker, F.metrics, [A.emit]));
    expect(only(onlyFrom).message).toContain("inside its to");
    const onlyTo = withEdge(llmEdge(F.worker, F.metrics, [A.handler]));
    expect(only(onlyTo).message).toContain("inside its from");
  });

  it("is not required of user or static edges", () => {
    expect(withEdge(llmEdge(F.worker, F.metrics, [], USER))).toEqual([]);
    expect(withEdge(llmEdge(F.worker, F.metrics, [], { origin: "static" }))).toEqual([]);
  });

  it("file ends: an anchor in the same file; dir ends: under it", () => {
    expect(withEdge(llmEdge(F.worker, "dir:src", [A.emit, A.handler]))).toEqual([]);
    expect(withEdge(llmEdge("dir:src", "dir:config", [A.emit, A.config]))).toEqual([]);
    expect(only(withEdge(llmEdge("dir:test", F.metrics, [A.emit, A.handler])))).toMatchObject({
      code: "evidence",
    });
    expect(only(withEdge(llmEdge(F.worker, F.metrics, [A.emit, A.emit])))).toMatchObject({
      code: "evidence",
    });
  });

  it("symbol ends: the same symbol or a descendant, not an ancestor or a sibling", () => {
    const queueClass = anchor(w, { file: "src/queue.ts", symbol: "Queue", role: "definition" });
    const sleepDef = anchor(w, { file: "src/util/sleep.ts", symbol: "sleep", role: "definition" });
    expect(
      withEdge(llmEdge(DISPATCH, "sym:src/queue.ts#Queue.pop", [A.popCall, A.popDef])),
    ).toEqual([]);
    expect(withEdge(llmEdge(DISPATCH, "sym:src/queue.ts#Queue", [A.popCall, A.popDef]))).toEqual(
      [],
    ); // descendant of Queue
    expect(
      only(withEdge(llmEdge(DISPATCH, "sym:src/queue.ts#Queue.pop", [A.popCall, queueClass]))),
    ).toMatchObject({ code: "evidence" }); // ancestor
    expect(
      only(withEdge(llmEdge(DISPATCH, "sym:src/queue.ts#Queue.pop", [A.popCall, A.requeueDef]))),
    ).toMatchObject({ code: "evidence" }); // sibling
    expect(
      only(withEdge(llmEdge(DISPATCH, "sym:src/util/sleep.ts#sleep", [A.popCall, A.popDef]))),
    ).toMatchObject({ code: "evidence" });
    expect(
      withEdge(llmEdge(DISPATCH, "sym:src/util/sleep.ts#sleep", [A.popCall, sleepDef])),
    ).toEqual([]);
  });

  it("symbol ends: a file-relative anchor inside the symbol's range counts", () => {
    const lines = anchor(w, {
      file: "src/runner.ts",
      span: { from: 75, to: 77 },
      role: "call-site",
    }); // lines 76-78
    expect(withEdge(llmEdge(DISPATCH, F.queue, [lines, A.popDef]))).toEqual([]);
    const outside = anchor(w, {
      file: "src/runner.ts",
      span: { from: 0, to: 2 },
      role: "call-site",
    }); // lines 1-3
    expect(only(withEdge(llmEdge(DISPATCH, F.queue, [outside, A.popDef])))).toMatchObject({
      code: "evidence",
    });
  });

  it("group ends: an anchor inside any member", () => {
    const edgeWithGroup = (anchors: Anchor[]) =>
      edit((ex) => (ex.edges = [llmEdge("grp:scheduling", F.worker, anchors)]));
    expect(edgeWithGroup([A.requeueCall, A.runDef])).toEqual([]); // runner.ts is a member
    expect(edgeWithGroup([A.popDef, A.runDef])).toEqual([]); // queue.ts is a member
    expect(only(edgeWithGroup([A.emit, A.runDef]))).toMatchObject({ code: "evidence" }); // worker.ts is not
  });

  it("still counts an anchor that is drifted or missing (the anchor itself is reported)", () => {
    const dw = drifted(); // Queue.pop is gone, Runner.dispatch's retry block changed
    const issues = edit(
      (ex) => (ex.edges = [llmEdge(DISPATCH, F.queue, [A.requeueCall, A.popDef])]),
      "strict",
      dw,
    );
    expect(issues.some((i) => i.code === "evidence")).toBe(false);
    expect(has(issues, { code: "anchor-missing", elementId: "edge:x" })).toBe(true);
    expect(has(issues, { code: "anchor-drifted", elementId: "edge:x" })).toBe(true);
  });

  it("does not report evidence for an end that does not exist (the reference error is enough)", () => {
    const issues = withEdge(llmEdge(F.worker, "file:src/nope.ts", [A.emit]));
    expect(issues.map((i) => i.code)).toEqual(["unknown-id"]);
  });
});

describe("validateExplainer: field types", () => {
  it("checks kinds, labels, provenance and derived-edge ids", () => {
    expect(only(edit((ex) => ((ex.edges[0]!.kind as string) = "flies")))).toMatchObject({
      path: "edges[0].kind",
    });
    expect(only(edit((ex) => ((ex.concepts[0] as { label: unknown }).label = 3)))).toMatchObject({
      path: "concepts[0].label",
    });
    expect(only(edit((ex) => (ex.concepts[0]!.label = "")))).toMatchObject({
      severity: "warning",
      path: "concepts[0].label",
    });
    expect(
      only(edit((ex) => delete (ex.concepts[0] as { provenance?: unknown }).provenance)),
    ).toMatchObject({ path: "concepts[0].provenance" });
    expect(
      only(edit((ex) => ((ex.concepts[0]!.provenance as { origin: string }).origin = "robot"))),
    ).toMatchObject({ path: "concepts[0].provenance.origin" });
    expect(
      only(
        edit((ex) => ((ex.nodes[1]!.provenance as { userFields: unknown }).userFields = "summary")),
      ),
    ).toMatchObject({ path: "nodes[1].provenance.userFields" });
    expect(only(edit((ex) => ((ex.nodes[0] as { summary: unknown }).summary = 3)))).toMatchObject({
      path: "nodes[0].summary",
    });
    const overlay = edit(
      (ex) =>
        (ex.edges = [
          edge(
            `edge:calls:${F.runner}->${F.queue}`,
            F.runner,
            F.worker,
            [A.requeueCall, A.runDef],
            { kind: "calls" },
          ),
        ]),
    );
    expect(only(overlay)).toMatchObject({ code: "bad-id", path: "edges[0]" });
    expect(overlay[0]!.message).toContain("must match the id");
    expect(
      edit(
        (ex) =>
          (ex.edges = [
            edge(
              `edge:calls:${F.runner}->${F.queue}`,
              F.runner,
              F.queue,
              [A.requeueCall, A.popDef],
              { kind: "calls", label: "" },
            ),
          ]),
      ),
    ).toEqual([expect.objectContaining({ severity: "warning", path: "edges[0].label" })]);
  });

  it("handles sequence views without a steps array, without participants, and empty ones", () => {
    expect(
      has(
        edit((ex) => ((seq(ex) as { steps: unknown }).steps = "x")),
        { path: "views[1].steps" },
      ),
    ).toBe(true);
    expect(
      has(
        edit((ex) => (seq(ex).steps = [])),
        { path: "views[1].steps", severity: "warning" },
      ),
    ).toBe(true);
    expect(
      has(
        edit((ex) => ((seq(ex) as { participants: unknown }).participants = undefined)),
        { path: "views[1].participants" },
      ),
    ).toBe(true);
  });
});

describe("validateExplainer: malformed input does not throw", () => {
  it("reports shapes it cannot read instead of crashing", () => {
    const view = (ex: Explainer) => ex.views[0] as GraphView;
    expect(
      has(
        edit((ex) => ((view(ex) as { hidden: unknown }).hidden = [3])),
        { path: "views[0].hidden[0]" },
      ),
    ).toBe(true);
    expect(
      has(
        edit((ex) => ((view(ex) as { layout: unknown }).layout = [])),
        { path: "views[0].layout" },
      ),
    ).toBe(true);
    expect(
      has(
        edit((ex) => ((seq(ex) as { frames: unknown }).frames = "x")),
        { path: "views[1].frames" },
      ),
    ).toBe(true);
    expect(
      has(
        edit((ex) => (seq(ex).steps[0] = null as never)),
        { path: "views[1].steps[0]" },
      ),
    ).toBe(true);
    expect(
      has(
        edit((ex) => (seq(ex).frames![0] = 5 as never)),
        { path: "views[1].frames[0]" },
      ),
    ).toBe(true);
    expect(
      has(
        edit((ex) => (ex.tours[0]!.steps[0] = "x" as never)),
        { path: "tours[0].steps[0]" },
      ),
    ).toBe(true);
    expect(
      has(
        edit((ex) => ((ex.tours[0] as { steps: unknown }).steps = 5)),
        { path: "tours[0].steps" },
      ),
    ).toBe(true);
    expect(
      has(
        edit((ex) => (ex.nodes[0] = null as never)),
        { path: "nodes[0]" },
      ),
    ).toBe(true);
    expect(
      has(
        edit((ex) => (ex.edges[0] = 3 as never)),
        { path: "edges[0]" },
      ),
    ).toBe(true);
    expect(
      has(
        edit((ex) => (ex.concepts[0] = [] as never)),
        { path: "concepts[0]" },
      ),
    ).toBe(true);
    expect(
      has(
        edit((ex) => (ex.views[0] = "x" as never)),
        { path: "views[0]" },
      ),
    ).toBe(true);
    expect(
      has(
        edit((ex) => (ex.tours[0] = null as never)),
        { path: "tours[0]" },
      ),
    ).toBe(true);
    expect(
      has(
        edit((ex) => ((ex.edges[0]!.provenance as unknown) = "llm")),
        { path: "edges[0].provenance" },
      ),
    ).toBe(true);
    // a missing anchors array reads as []: only the evidence rule notices
    expect(
      edit((ex) => delete (ex.edges[0] as { anchors?: unknown }).anchors).every(
        (i) => i.code === "evidence",
      ),
    ).toBe(true);
    expect(
      has(
        edit((ex) => ((ex.views[0] as { id: unknown }).id = 7)),
        { path: "views[0].id" },
      ),
    ).toBe(true);
    expect(
      has(
        edit((ex) => ((ex.tours[0] as { id: unknown }).id = 7)),
        { path: "tours[0].id" },
      ),
    ).toBe(true);
    expect(
      has(
        edit((ex) => ((ex.nodes[0] as { id: unknown }).id = "")),
        { path: "nodes[0].id" },
      ),
    ).toBe(true);
  });
});

describe("validateExplainer: lenient mode keeps structural rules", () => {
  it("vanished index ids are warnings, unknown stored ids stay errors", () => {
    const gone = (ex: Explainer) => {
      ex.nodes[0]!.members!.push("file:src/gone.ts");
      (ex.views[0] as GraphView).include.push("sym:src/runner.ts#Vanished");
      seq(ex).steps[0]!.edge = "edge:nope";
    };
    const strict = edit(gone, "strict");
    const lenient = edit(gone, "lenient");
    expect(errs(strict)).toHaveLength(3);
    expect(errs(lenient).map((i) => i.path)).toEqual(["views[1].steps[0].edge"]);
    expect(warns(lenient)).toHaveLength(2);
  });
});
