/**
 * The shapes a diagram could not say before (review 2026-10-03, A6): recursion and unwinding in a flow
 * (`FlowLink.kind`), "A reaches C through B" (`Edge.via`), and a flow step drawn from a part whose code it is not.
 */
import { describe, expect, it } from "vitest";
import {
  applyPatch,
  deriveGraph,
  ExplainerModel,
  hopRefs,
  processFlow,
  validateExplainer,
  type Explainer,
  type SequenceStep,
  type SequenceView,
} from "../src/index.js";
import { anchor, edge, emptyExplainer, graphView, jobrunner, sequenceView } from "./helpers.js";

const w = jobrunner();
const START = "sym:src/runner.ts#Runner.start";
const DISPATCH = "sym:src/runner.ts#Runner.dispatch";
const POP = "sym:src/queue.ts#Queue.pop";
const RUN = "sym:src/worker.ts#Worker.run";
const QUEUE = "file:src/queue.ts";
const dispatchAt = (from: number, to = from) =>
  anchor(w, {
    file: "src/runner.ts",
    symbol: "Runner.dispatch",
    span: { from, to },
    role: "call-site",
  });

const check = (ex: Explainer) => validateExplainer(ex, w.index, w.getText);
const errors = (ex: Explainer) => check(ex).filter((i) => i.severity === "error");
const warnings = (ex: Explainer) => check(ex).filter((i) => i.severity === "warning");

function flow(steps: Partial<SequenceStep>[], over: Partial<SequenceView> = {}): Explainer {
  return emptyExplainer({
    views: [
      sequenceView(
        "view:walk",
        [DISPATCH, QUEUE],
        steps.map((step, n) => ({
          id: `walk:${n + 1}`,
          from: DISPATCH,
          to: DISPATCH,
          label: `Stage ${n + 1}`,
          kind: "call",
          anchors: [dispatchAt(n)],
          ...step,
        })),
        { type: "flow", ...over },
      ),
    ],
  });
}

describe("flow: recurse and return links", () => {
  const recursive = () =>
    flow([
      {
        shape: "decision",
        next: [
          { step: "walk:2", label: "yes" },
          { step: "walk:4", label: "no" },
        ],
      },
      { next: [{ step: "walk:1", kind: "recurse", label: "the child" }] },
      { shape: "terminal", next: [{ step: "walk:2", kind: "return", label: "found" }] },
      { shape: "terminal" },
    ]);

  it("validates, and a terminal may return to its caller", () => {
    expect(errors(recursive())).toEqual([]);
    expect(warnings(recursive())).toEqual([]);
  });

  it("are transitions with their kind; a step with only a recurse link still goes on", () => {
    const f = processFlow(recursive().views[0] as SequenceView);
    expect(f.transitions.map(({ from, to, kind }) => [from, to, kind])).toEqual([
      ["walk:1", "walk:2", undefined],
      ["walk:1", "walk:4", undefined],
      ["walk:2", "walk:1", "recurse"],
      ["walk:2", "walk:3", undefined],
      ["walk:3", "walk:2", "return"],
    ]);
    // a recurse link and one way on is not a choice
    expect(f.stages[1]!.shape).toBe("stage");
  });

  it("rejects an unknown kind and other links out of a terminal", () => {
    const bad = flow([{ next: [{ step: "walk:1", kind: "jump" as "recurse" }] }]);
    expect(errors(bad).map((i) => i.path)).toEqual(["views[0].steps[0].next[0].kind"]);
    const terminal = flow([{ shape: "terminal", next: [{ step: "walk:1", kind: "recurse" }] }]);
    expect(errors(terminal)[0]!.message).toContain('only "return" links');
  });

  it("warns when a recurse link points forward", () => {
    const forward = flow([{ next: [{ step: "walk:2", kind: "recurse" }] }, {}]);
    expect(warnings(forward).map((i) => i.message)).toEqual([
      expect.stringContaining("a recurse link runs earlier steps again"),
    ]);
  });

  it("are accepted by a patch, also in stepsUpdate", () => {
    const base = recursive();
    const result = applyPatch(
      base,
      {
        views: [
          {
            id: "view:walk",
            type: "flow",
            stepsUpdate: [
              { id: "walk:4", shape: "stage", next: [{ step: "walk:1", kind: "recurse" }] },
            ],
          },
        ],
      },
      w.index,
      w.getText,
      { actor: "llm" },
    );
    expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
    const step = (result.explainer!.views[0] as SequenceView).steps[3]!;
    expect(step.next).toEqual([{ step: "walk:1", kind: "recurse" }]);
  });
});

describe("flow: layout setting", () => {
  it("takes code-first or diagram", () => {
    expect(errors(flow([{}], { layout: "code-first" }))).toEqual([]);
    expect(errors(flow([{}], { layout: "diagram" }))).toEqual([]);
    expect(errors(flow([{}], { layout: "wide" as "diagram" }))[0]!.path).toBe("views[0].layout");
  });
});

describe("flow: a step's owner and its code", () => {
  it("warns when the first anchor is not in the step's from, naming the participant that holds it", () => {
    const popDef = anchor(w, { file: "src/queue.ts", symbol: "Queue.pop", role: "definition" });
    const issues = warnings(flow([{ anchors: [popDef] }]));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ path: "views[0].steps[0].from", code: "step" });
    expect(issues[0]!.message).toContain(`it is in ${QUEUE}`);
  });

  it("is quiet for an answer that comes back to the part whose code it is", () => {
    const popDef = anchor(w, { file: "src/queue.ts", symbol: "Queue.pop", role: "definition" });
    expect(
      warnings(flow([{ from: QUEUE, kind: "return", anchors: [dispatchAt(4), popDef] }])),
    ).toEqual([]);
  });

  it("is quiet when the code is in from, and in a sequence view", () => {
    expect(warnings(flow([{}]))).toEqual([]);
    const popDef = anchor(w, { file: "src/queue.ts", symbol: "Queue.pop", role: "definition" });
    const ex = flow([{ anchors: [popDef] }]);
    (ex.views[0] as SequenceView).type = "sequence";
    expect(warnings(ex)).toEqual([]);
  });
});

describe("edges: via", () => {
  const via = (
    over: Parameters<typeof edge>[4] = {},
    anchors = [] as ReturnType<typeof anchor>[],
  ) =>
    emptyExplainer({
      edges: [
        edge("edge:start-pops", START, POP, anchors, { kind: "calls", via: [DISPATCH], ...over }),
      ],
      views: [graphView("view:map", [START, POP])],
    });

  it("needs no anchors when the index shows every hop", () => {
    expect(hopRefs(new ExplainerModel(via(), w.index), START, DISPATCH)).toHaveLength(1);
    expect(errors(via())).toEqual([]);
  });

  it("needs anchors at both ends of a hop the index does not show", () => {
    const emit = anchor(w, {
      file: "src/worker.ts",
      symbol: "Worker.run",
      span: { from: 21, to: 21 },
      role: "call-site",
    });
    const handler = anchor(w, {
      file: "src/metrics.ts",
      symbol: "onJobCompleted",
      role: "definition",
    });
    const ex = (anchors: ReturnType<typeof anchor>[]) =>
      emptyExplainer({
        edges: [edge("edge:x", DISPATCH, "file:src/metrics.ts", anchors, { via: [RUN] })],
      });
    const missing = errors(ex([]));
    expect(missing.map((i) => i.code)).toEqual(["evidence"]);
    expect(missing[0]!.message).toContain(`from ${RUN} to file:src/metrics.ts`);
    expect(errors(ex([emit, handler]))).toEqual([]);
  });

  it("must name nodes that exist, other than the ends", () => {
    expect(errors(via({ via: ["sym:src/queue.ts#Nope"] })).map((i) => i.path)).toEqual([
      "edges[0].via[0]",
    ]);
    expect(errors(via({ via: [POP] }))[0]!.message).toContain("an end of the edge");
    expect(errors(via({ via: [] }))[0]!.path).toBe("edges[0].via");
  });

  it("is drawn as one arrow that knows what it passes through, its code the hops' references", () => {
    const ex = via();
    const model = new ExplainerModel(ex, w.index);
    const graph = deriveGraph(ex.views[0] as never, model);
    const arrow = graph.edges.find((e) => e.id === "edge:start-pops")!;
    expect(arrow.via).toEqual([{ id: DISPATCH, label: model.label(DISPATCH) }]);
    expect(arrow.anchors.map((a) => [a.file, a.symbol, a.role])).toContainEqual([
      "src/runner.ts",
      "Runner.start",
      "call-site",
    ]);
    // the references through Runner.dispatch are the arrow, not stubs to a ghost Runner.dispatch
    expect(graph.stubs.filter((s) => s.ghost.includes("Runner.dispatch"))).toEqual([]);
  });

  it("is accepted by a patch, and cleared by null", () => {
    const opts = { actor: "llm" as const };
    const made = applyPatch(
      emptyExplainer(),
      {
        edges: [
          {
            id: "edge:start-pops",
            from: START,
            to: POP,
            kind: "calls",
            label: "pops",
            via: [DISPATCH],
          },
        ],
      },
      w.index,
      w.getText,
      opts,
    );
    expect(made.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(made.explainer!.edges[0]!.via).toEqual([DISPATCH]);
    const cleared = applyPatch(
      made.explainer!,
      { edges: [{ id: "edge:start-pops", via: null }] },
      w.index,
      w.getText,
      opts,
    );
    // without via, the edge needs anchors at both ends again
    expect(cleared.issues.some((i) => i.code === "evidence")).toBe(true);
  });
});
