/**
 * `GraphView.boxText`: a map whose boxes carry their summary, so a reader can scan what every box does without
 * opening it. The derived graph hands each box's summary to the viewer only on such a view.
 */
import { describe, expect, it } from "vitest";
import {
  applyPatch,
  deriveGraph,
  ExplainerModel,
  type ExplainerPatch,
  type GraphView,
} from "../src/index.js";
import { emptyExplainer, jobrunner } from "./helpers.js";

const w = jobrunner();

const PATCH: ExplainerPatch = {
  nodes: [
    { id: "file:src/queue.ts", label: "Job queue", summary: "Holds the jobs waiting to run." },
    { id: "file:src/worker.ts", label: "Worker" },
  ],
  views: [
    {
      id: "view:cards",
      type: "graph",
      title: "The files",
      include: ["file:src/queue.ts", "file:src/worker.ts"],
      boxText: "summary",
    },
    {
      id: "view:plain",
      type: "graph",
      title: "The files",
      include: ["file:src/queue.ts", "file:src/worker.ts"],
    },
  ],
};

describe("boxText", () => {
  const r = applyPatch(emptyExplainer(), PATCH, w.index, w.getText, { actor: "llm" });
  const model = new ExplainerModel(r.explainer, w.model);
  const nodesOf = (id: string) =>
    deriveGraph(r.explainer.views.find((v) => v.id === id) as GraphView, model).nodes.map((n) => [
      n.id,
      n.summary,
    ]);

  it("gives each box of a summary view its summary, and none on other views", () => {
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(nodesOf("view:cards")).toEqual([
      ["file:src/queue.ts", "Holds the jobs waiting to run."],
      ["file:src/worker.ts", undefined],
    ]);
    expect(nodesOf("view:plain")).toEqual([
      ["file:src/queue.ts", undefined],
      ["file:src/worker.ts", undefined],
    ]);
  });

  it("is cleared by null and rejects any other value", () => {
    const cleared = applyPatch(
      r.explainer,
      { views: [{ id: "view:cards", type: "graph", boxText: null }] },
      w.index,
      w.getText,
      { actor: "llm" },
    );
    expect((cleared.explainer.views[0] as GraphView).boxText).toBeUndefined();
    const wrong = applyPatch(
      emptyExplainer(),
      {
        views: [
          {
            id: "view:x",
            type: "graph",
            title: "X",
            include: ["file:src/queue.ts"],
            boxText: "detail" as never,
          },
        ],
      },
      w.index,
      w.getText,
      { actor: "llm" },
    );
    expect(wrong.issues.map((i) => i.message)).toContain(
      'boxText must be "summary" (each box shows its summary under its label)',
    );
  });
});
