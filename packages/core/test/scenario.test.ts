/**
 * The handoff acceptance checks, run against the pure logic: a synthetic src/runner.ts where
 * Runner.dispatch spans lines 42-88, a sequence view shaped like Appendix B (dispatch:3 anchored at
 * offsets 34-36 plus the Queue.requeue definition), and concept:retry-policy at offsets 30-41.
 * The explainer is built the way the CLI builds it: createExplainer + applyPatch.
 */
import { describe, expect, it } from "vitest";
import {
  applyPatch,
  buildReverseIndex,
  codeFocus,
  createExplainer,
  deriveGraph,
  derivedEdgeMap,
  ExplainerModel,
  mergeFocusByFile,
  reresolveExplainer,
  validateExplainer,
  viewCandidates,
  type Explainer,
  type ExplainerPatch,
  type SequenceView,
} from "../src/index.js";
import { JOBRUNNER, jobrunner, makeWorld, RUNNER_TEXT, textWith, type World } from "./helpers.js";

const DISPATCH = "sym:src/runner.ts#Runner.dispatch";

const PATCH: ExplainerPatch = {
  nodes: [
    {
      id: "grp:scheduling",
      label: "Scheduling",
      summary: "Decides which job runs next and hands it to a free worker.",
      members: ["file:src/runner.ts", "file:src/queue.ts"],
    },
    { id: DISPATCH, summary: "The hot loop: pop, lease a worker, run, ack or requeue." },
  ],
  edges: [
    {
      id: "edge:job-completed",
      from: "file:src/worker.ts",
      to: "file:src/metrics.ts",
      kind: "emits",
      label: "job.completed",
      summary: "Worker publishes on the event bus; metrics subscribes.",
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
  views: [
    {
      id: "view:overview",
      type: "graph",
      title: "Overview",
      scope: { root: "repo", depth: 1 },
      include: ["grp:scheduling", "file:src/worker.ts", "file:src/metrics.ts"],
    },
    {
      id: "view:dispatch",
      type: "sequence",
      title: "How a job is dispatched",
      scope: {
        root: "repo",
        depth: 3,
        question: "How does a job get from the queue to a worker?",
        entryPoints: ["src/runner.ts#Runner.dispatch"],
      },
      participants: [DISPATCH, "file:src/queue.ts", "file:src/worker.ts"],
      steps: [
        {
          id: "dispatch:1",
          from: DISPATCH,
          to: "file:src/queue.ts",
          label: "pop()",
          kind: "call",
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
        {
          id: "dispatch:2",
          from: DISPATCH,
          to: "file:src/worker.ts",
          label: "run(job)",
          kind: "call",
          anchors: [
            {
              file: "src/runner.ts",
              symbol: "Runner.dispatch",
              span: { from: 18, to: 19 },
              role: "call-site",
            },
            { file: "src/worker.ts", symbol: "Worker.run", role: "definition" },
          ],
        },
        {
          id: "dispatch:3",
          from: DISPATCH,
          to: "file:src/queue.ts",
          label: "requeue(job, backoff)",
          kind: "call",
          anchors: [
            {
              file: "src/runner.ts",
              symbol: "Runner.dispatch",
              find: "await this.queue.requeue(\n          job,\n          backoff);",
              role: "call-site",
            },
            { file: "src/queue.ts", symbol: "Queue.requeue", role: "definition" },
          ],
        },
      ],
      frames: [
        {
          id: "frame:retry",
          kind: "loop",
          label: "until success or maxRetries",
          fromStep: "dispatch:2",
          toStep: "dispatch:3",
        },
      ],
    },
  ],
  tours: [
    {
      id: "tour:intro",
      title: "Intro talk",
      steps: [
        { id: "t1", view: "view:overview", focus: ["grp:scheduling"], note: "Big picture first." },
        {
          id: "t2",
          view: "view:dispatch",
          focus: ["dispatch:3", "concept:retry-policy"],
          note: "Where failures go.",
          editor: { primary: "src/runner.ts" },
        },
      ],
    },
  ],
};

const USER_PATCH: ExplainerPatch = {
  concepts: [
    {
      id: "concept:retry-policy",
      label: "Retry policy",
      summary:
        "Failed jobs are requeued with exponential backoff up to maxRetries, then dead-lettered.",
      anchors: [
        {
          file: "src/runner.ts",
          symbol: "Runner.dispatch",
          span: { from: 30, to: 41 },
          role: "definition",
        },
        { file: "config/default.yaml", symbol: "retry", role: "config" },
        { file: "test/retry.test.ts", role: "test" },
      ],
      related: [DISPATCH, "file:src/queue.ts"],
    },
  ],
};

function build(world: World): Explainer {
  const base = createExplainer({
    title: "Job runner",
    repoName: "acme/jobrunner",
    index: world.index,
    indexPath: ".explainer/index-c1.json",
  });
  // The concept is the user's (the tour points at it), so it goes in first, as a user patch.
  const withConcept = applyPatch(base, USER_PATCH, world.index, world.getText, { actor: "user" });
  expect(withConcept.issues.filter((i) => i.severity === "error")).toEqual([]);
  const full = applyPatch(withConcept.explainer, PATCH, world.index, world.getText, {
    actor: "llm",
  });
  expect(full.issues.filter((i) => i.severity === "error")).toEqual([]);
  return full.explainer;
}

describe("handoff acceptance checks (core logic)", () => {
  const world = jobrunner();
  const explainer = build(world);
  const model = new ExplainerModel(explainer, world.model);
  const seq = explainer.views.find((v) => v.id === "view:dispatch") as SequenceView;

  it("the runner fixture has Runner.dispatch at 42-88", () => {
    expect(world.model.symbol("src/runner.ts#Runner.dispatch")!.range).toEqual({
      startLine: 42,
      endLine: 88,
    });
  });

  it("the explainer built through applyPatch validates strictly", () => {
    expect(validateExplainer(explainer, world.index, world.getText, { mode: "strict" })).toEqual(
      [],
    );
    const step3 = seq.steps.find((s) => s.id === "dispatch:3")!;
    expect(step3.anchors[0]).toMatchObject({
      span: { from: 34, to: 36 },
      resolved: { range: { startLine: 76, endLine: 78 } },
    });
    expect(explainer.concepts[0]!.provenance).toEqual({ origin: "user", commit: "c1" });
  });

  it("clicking dispatch:3 focuses runner.ts 76-78 and the Queue.requeue definition", () => {
    const focus = codeFocus(["dispatch:3"], model);
    expect(focus.map((f) => [f.file, f.range.startLine, f.range.endLine, f.role])).toEqual([
      ["src/runner.ts", 76, 78, "call-site"],
      ["src/queue.ts", 17, 30, "definition"],
    ]);
    const files = mergeFocusByFile(focus);
    expect(
      files.map((f) => [f.file, f.ranges.map((r) => [r.range.startLine, r.range.endLine])]),
    ).toEqual([
      ["src/runner.ts", [[76, 78]]],
      ["src/queue.ts", [[17, 30]]],
    ]);
  });

  it("the cursor on the requeue call selects dispatch:3, elsewhere in the retry block the concept", () => {
    const candidates = viewCandidates(seq, model);
    expect(candidates).toEqual([
      DISPATCH,
      "file:src/queue.ts",
      "file:src/worker.ts",
      "dispatch:1",
      "dispatch:2",
      "dispatch:3",
      "concept:retry-policy",
    ]);
    const idx = buildReverseIndex(candidates, model);
    for (const line of [76, 77, 78])
      expect(idx.lookup("src/runner.ts", line)).toEqual(["dispatch:3"]); // offsets 34-36
    expect(idx.lookup("src/runner.ts", 77)).toEqual(["dispatch:3"]); // offset 35
    for (const line of [72, 73, 74, 75])
      expect(idx.lookup("src/runner.ts", line)).toEqual(["concept:retry-policy"]); // offsets 30-33
    expect(idx.lookup("src/runner.ts", 73)).toEqual(["concept:retry-policy"]); // offset 31
    expect(idx.lookup("src/runner.ts", 79)).toEqual(["concept:retry-policy"]); // still in the block, offsets 37-41
    expect(idx.lookup("src/runner.ts", 83)).toEqual(["concept:retry-policy"]);
  });

  it("other steps and the surrounding code map sensibly", () => {
    const idx = buildReverseIndex(viewCandidates(seq, model), model);
    expect(idx.lookup("src/runner.ts", 46)).toEqual(["dispatch:1"]);
    expect(idx.lookup("src/runner.ts", 60)).toEqual(["dispatch:2"]);
    expect(idx.lookup("src/runner.ts", 61)).toEqual(["dispatch:2"]);
    expect(idx.lookup("src/runner.ts", 50)).toEqual([DISPATCH]); // the lifeline: the whole method
    expect(idx.lookup("src/runner.ts", 84)).toEqual([DISPATCH]);
    expect(idx.lookup("src/runner.ts", 90)).toEqual([]); // Runner.log is not in this view
    expect(idx.lookup("src/queue.ts", 20)).toEqual(["dispatch:3"]); // requeue: 14 lines beats the 60-line file lifeline
    expect(idx.lookup("src/queue.ts", 8)).toEqual(["dispatch:1"]);
    expect(idx.lookup("src/queue.ts", 58)).toEqual(["file:src/queue.ts"]);
    expect(idx.lookup("config/default.yaml", 14)).toEqual(["concept:retry-policy"]); // the config anchor: lines 13-16
    expect(idx.lookup("test/retry.test.ts", 3)).toEqual(["concept:retry-policy"]);
  });

  it("clicking the concept focuses all its anchors", () => {
    const focus = codeFocus(["concept:retry-policy"], model);
    expect(focus.map((f) => [f.file, f.range.startLine, f.range.endLine, f.role])).toEqual([
      ["src/runner.ts", 72, 83, "definition"],
      ["config/default.yaml", 13, 16, "config"],
      ["test/retry.test.ts", 1, 30, "test"],
    ]);
  });

  it("the overview graph: group container, derived and stored edges, stubs, and reverse lookup", () => {
    const overview = explainer.views.find((v) => v.id === "view:overview")!;
    if (overview.type !== "graph") throw new Error("graph expected");
    const graph = deriveGraph(overview, model);
    expect(graph.nodes.map((n) => n.id)).toEqual([
      "file:src/metrics.ts",
      "file:src/worker.ts",
      "grp:scheduling",
    ]);
    expect(graph.edges.map((e) => e.id)).toEqual([
      "edge:calls:grp:scheduling->file:src/worker.ts",
      "edge:job-completed",
    ]);
    expect(graph.edges[1]).toMatchObject({
      stored: true,
      resolution: "llm",
      label: "job.completed",
    });
    expect(graph.stubs.map((s) => [s.inside, s.ghost])).toContainEqual([
      "grp:scheduling",
      "dir:src/util",
    ]);
    const candidates = viewCandidates(overview, model, graph);
    const idx = buildReverseIndex(candidates, model, { derivedEdges: derivedEdgeMap(graph) });
    // the call from Runner.dispatch to Worker.run (lines 60-61): the derived edge is the innermost element
    expect(idx.lookup("src/runner.ts", 60)).toEqual([
      "edge:calls:grp:scheduling->file:src/worker.ts",
    ]);
    // the emit call site inside Worker.run (offset 21 -> line 26)
    expect(idx.lookup("src/worker.ts", 26)).toEqual(["edge:job-completed"]);
    expect(idx.lookup("src/metrics.ts", 10)).toEqual(["edge:job-completed"]);
    // a line of runner.ts that only the group covers
    expect(idx.lookup("src/runner.ts", 12)).toEqual(["grp:scheduling"]);
  });
});

describe("regeneration on a new commit (core logic)", () => {
  const before = jobrunner();
  const explainer = build(before);

  /** The runner.ts of `before` with `prefix` extra lines on top. */
  function shifted(prefix: number, edit?: (lines: string[]) => string[], commit = "c2"): World {
    const shift = (n: number) => n + prefix;
    const text = (edit ?? ((l) => l))(RUNNER_TEXT.split("\n"));
    return makeWorld({
      ...JOBRUNNER,
      commit,
      files: JOBRUNNER.files.map((f) =>
        f.path === "src/runner.ts"
          ? { ...f, text: textWith(prefix) + (prefix ? "\n" : "") + text.join("\n") }
          : f,
      ),
      symbols: JOBRUNNER.symbols!.map((s) =>
        s.id.startsWith("src/runner.ts#") ? { ...s, start: shift(s.start), end: shift(s.end) } : s,
      ),
      refs: [],
    });
  }

  it("moves every anchor of runner.ts when lines are added above, keeping the acceptance checks true", () => {
    const after = shifted(3);
    const { explainer: out, report } = reresolveExplainer(explainer, after.index, after.getText, {
      indexPath: ".explainer/index-c2.json",
    });
    expect(report.counts.drifted).toBe(0);
    expect(report.counts.missing).toBe(0);
    expect(report.counts.moved).toBeGreaterThan(0);
    expect(out.index).toEqual({ path: ".explainer/index-c2.json", commit: "c2" });
    const model = new ExplainerModel(out, after.model);
    expect(
      codeFocus(["dispatch:3"], model).map((f) => [f.file, f.range.startLine, f.range.endLine]),
    ).toEqual([
      ["src/runner.ts", 79, 81],
      ["src/queue.ts", 17, 30],
    ]);
    const seq = out.views.find((v) => v.id === "view:dispatch") as SequenceView;
    const idx = buildReverseIndex(viewCandidates(seq, model), model);
    expect(idx.lookup("src/runner.ts", 80)).toEqual(["dispatch:3"]);
    expect(idx.lookup("src/runner.ts", 76)).toEqual(["concept:retry-policy"]);
    // resolved again after the re-resolve: everything settles
    const again = reresolveExplainer(out, after.index, after.getText);
    expect(again.report.counts.moved).toBe(0);
    expect(validateExplainer(out, after.index, after.getText, { mode: "strict" })).toEqual([]);
  });

  it("reports the llm step as drifted, and the user's concept separately, when the retry block changes", () => {
    const after = shifted(0, (lines) =>
      lines.map((l, i) => (i + 1 === 77 ? "          job, attempts," : l)),
    );
    const { report } = reresolveExplainer(explainer, after.index, after.getText);
    expect(report.counts).toMatchObject({ drifted: 2, missing: 0 });
    expect(report.drifted.map((d) => [d.elementId, d.owner, d.userFields])).toEqual([
      ["dispatch:3", "step", []],
    ]);
    expect(report.drifted[0]!.anchors.map((a) => a.path)).toEqual(["views[1].steps[2].anchors[0]"]);
    // the user's concept is never re-explained, but it is not forgotten either
    expect(report.driftedOther).toEqual([
      { elementId: "concept:retry-policy", origin: "user", paths: ["concepts[0].anchors[0]"] },
    ]);
  });

  it("the llm can then re-anchor the drifted step through a patch, and the user's concept is left alone", () => {
    const after = shifted(0, (lines) =>
      lines.map((l, i) => (i + 1 === 77 ? "          job, attempts," : l)),
    );
    const resolved = reresolveExplainer(explainer, after.index, after.getText).explainer;
    const before = resolved.views.find((v) => v.id === "view:dispatch") as SequenceView;
    const patch: ExplainerPatch = {
      views: [
        {
          id: "view:dispatch",
          type: "sequence",
          steps: before.steps.map((step) =>
            step.id === "dispatch:3"
              ? {
                  ...step,
                  anchors: [
                    {
                      file: "src/runner.ts",
                      symbol: "Runner.dispatch",
                      find: "await this.queue.requeue(\n          job, attempts,\n          backoff);",
                      role: "call-site" as const,
                    },
                    step.anchors[1]!,
                  ],
                }
              : step,
          ),
        },
      ],
      concepts: [{ id: "concept:retry-policy", summary: "llm rewrite" }],
    };
    const r = applyPatch(resolved, patch, after.index, after.getText, { actor: "llm" });
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.changed).toEqual(["view:dispatch"]);
    const concept = r.explainer.concepts.find((c) => c.id === "concept:retry-policy")!;
    expect(concept.summary).toContain("Failed jobs"); // untouched
    expect(
      r.issues.some((i) => i.code === "protected" && i.elementId === "concept:retry-policy"),
    ).toBe(true);
    const seq = r.explainer.views.find((v) => v.id === "view:dispatch") as SequenceView;
    expect(seq.provenance.commit).toBe("c2");
    expect(seq.steps[2]!.anchors[0]!.resolved!.status).toBe("ok");
    // the drifted step is fixed; only the user's concept still drifts
    const rest = reresolveExplainer(r.explainer, after.index, after.getText).report;
    expect(rest.drifted).toEqual([]);
    expect(rest.driftedOther.map((d) => d.elementId)).toEqual(["concept:retry-policy"]);
  });
});
