import { ExplainerModel, deriveGraph, reresolveExplainer } from "@xpl/core";
import type { CommandSpec } from "../command.js";
import { listText, plural } from "../format.js";
import { readRequests, type QueuedRequest } from "../requests.js";
import { loadExplainer, openWorkspace } from "../repo.js";
import { renderResolveReport } from "./resolve.js";

interface ViewStatus {
  id: string;
  type: "graph" | "sequence";
  title: string;
  /** Nodes shown (graph: included nodes; sequence: participants). */
  nodes: { total: number; unexplained: string[] };
  /** Graph views: edges shown. `stored` ones (llm/user) need a summary; static ones may have one. */
  edges: { total: number; unexplained: { id: string; stored: boolean }[] };
  /** Sequence views. */
  steps: { total: number; unexplained: string[] };
}

function viewStatuses(model: ExplainerModel): ViewStatus[] {
  const out: ViewStatus[] = [];
  const explained = (id: string) => {
    const summary = model.node(id)?.summary;
    return typeof summary === "string" && summary.trim() !== "";
  };
  for (const view of model.views) {
    const status: ViewStatus = {
      id: view.id,
      type: view.type,
      title: view.title,
      nodes: { total: 0, unexplained: [] },
      edges: { total: 0, unexplained: [] },
      steps: { total: 0, unexplained: [] },
    };
    if (view.type === "graph") {
      const graph = deriveGraph(view, model);
      status.nodes.total = graph.nodes.length;
      status.nodes.unexplained = graph.nodes.filter((n) => !explained(n.id)).map((n) => n.id);
      status.edges.total = graph.edges.length;
      status.edges.unexplained = graph.edges
        .filter((e) => !(typeof e.summary === "string" && e.summary.trim() !== ""))
        .map((e) => ({ id: e.id, stored: e.stored }));
    } else {
      const participants = Array.isArray(view.participants) ? view.participants : [];
      status.nodes.total = participants.length;
      status.nodes.unexplained = participants.filter((id) => model.hasNode(id) && !explained(id));
      const steps = Array.isArray(view.steps) ? view.steps : [];
      status.steps.total = steps.length;
      status.steps.unexplained = steps
        .filter((s) => !(typeof s.summary === "string" && s.summary.trim() !== ""))
        .map((s) => s.id);
    }
    out.push(status);
  }
  return out;
}

function unexplainedConcepts(model: ExplainerModel): string[] {
  return model.concepts
    .filter((c) => !(typeof c.summary === "string" && c.summary.trim() !== ""))
    .map((c) => c.id);
}

export const statusCommand: CommandSpec = {
  name: "status",
  usage: "xpl status <explainer>",
  summary: "To-do list: unexplained elements, drifted, missing, queued requests",
  details: [
    "The skill's to-do list for an explainer, without changing anything:",
    "  - per view, the visible nodes, edges and steps that have no `summary` (static edges are optional),",
    "  - concepts without a summary,",
    "  - llm elements whose anchors drifted (re-explain them, keeping userFields) and missing anchors,",
    "  - explain-this requests the viewer queued in .explainer/requests.json (delete the file once handled).",
  ],
  options: {},
  positionals: [{ name: "explainer" }],
  async run(ctx, args) {
    const loaded = loadExplainer(ctx, args.positionals[0]!);
    const ws = await openWorkspace(ctx, { explainer: loaded });
    const model = new ExplainerModel(loaded.explainer, ws.model);
    const views = viewStatuses(model);
    const concepts = unexplainedConcepts(model);
    const { report } = reresolveExplainer(loaded.explainer, ws.model, ws.texts);
    const queue = readRequests(ctx.root);
    if (queue.error) ctx.warn(queue.error);
    const requests: QueuedRequest[] = queue.requests.filter(
      (r) => r.explainer === undefined || r.explainer === loaded.name,
    );

    // What the skill must do: nodes, stored edges, steps and concepts without a summary.
    const unexplained =
      views.reduce(
        (sum, v) =>
          sum +
          v.nodes.unexplained.length +
          v.edges.unexplained.filter((e) => e.stored).length +
          v.steps.unexplained.length,
        0,
      ) + concepts.length;
    const todo = {
      unexplained,
      drifted: report.drifted.length,
      missing: report.missing.length,
      requests: requests.length,
    };

    if (ctx.json) {
      ctx.emit({
        path: loaded.rel,
        index: { path: ws.indexRel, commit: ws.index.commit },
        todo,
        views,
        concepts: { unexplained: concepts },
        anchors: { total: report.total, counts: report.counts },
        drifted: report.drifted,
        driftedOther: report.driftedOther,
        missing: report.missing,
        requests,
      });
      return 0;
    }

    const lines = [
      `${loaded.rel}: index ${ws.index.commit}, ${plural(views.length, "view")}, ${plural(model.concepts.length, "concept")}`,
      `to do: ${todo.unexplained} unexplained, ${todo.drifted} drifted, ${todo.missing} missing anchors, ${plural(todo.requests, "request")}`,
    ];
    if (views.length === 0)
      lines.push("", "no views yet: apply a patch with a graph or sequence view");
    for (const view of views) {
      lines.push("", `${view.id} (${view.type}): ${view.title}`);
      const shown = view.type === "graph" ? "nodes" : "participants";
      lines.push(
        view.nodes.unexplained.length === 0
          ? `  ${shown}: all ${view.nodes.total} explained`
          : `  ${shown} without summary (${view.nodes.unexplained.length} of ${view.nodes.total}): ${listText(view.nodes.unexplained, 8)}`,
      );
      if (view.type === "graph") {
        const stored = view.edges.unexplained.filter((e) => e.stored).map((e) => e.id);
        const staticEdges = view.edges.unexplained.filter((e) => !e.stored).length;
        lines.push(
          `  edges: ${view.edges.total} shown; ` +
            (stored.length > 0
              ? `stored without summary (${stored.length}): ${listText(stored, 8)}`
              : "every stored edge is explained") +
            (staticEdges > 0 ? `; ${staticEdges} static without summary (optional)` : ""),
        );
      } else {
        lines.push(
          view.steps.unexplained.length === 0
            ? `  steps: all ${view.steps.total} explained`
            : `  steps without summary (${view.steps.unexplained.length} of ${view.steps.total}): ${listText(view.steps.unexplained, 12)}`,
        );
      }
    }
    if (concepts.length > 0) {
      lines.push("", `concepts without summary (${concepts.length}): ${listText(concepts, 8)}`);
    }
    if (report.drifted.length > 0 || report.missing.length > 0 || report.driftedOther.length > 0) {
      lines.push("", ...renderResolveReport(report));
    }
    if (requests.length > 0) {
      lines.push(
        "",
        `requests queued by the viewer (${requests.length}; delete .explainer/requests.json when handled):`,
      );
      for (const r of requests) {
        const details = [
          r.kind ? `${r.kind} ` : "",
          r.elementId,
          r.view ? `  (in ${r.view})` : "",
          r.label ? `  [${r.label}]` : "",
          r.note ? `  "${r.note}"` : "",
        ];
        lines.push(`  ${r.at}  ${details.join("")}`);
      }
    }
    ctx.out(lines.join("\n"));
    return 0;
  },
};
