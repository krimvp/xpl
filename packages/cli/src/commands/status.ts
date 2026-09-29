import {
  ExplainerModel,
  deriveGraph,
  parseId,
  reresolveExplainer,
  resolveStubPolicy,
  validateExplainer,
  type DerivedGraph,
  type DriftedElement,
  type Ghost,
  type ResolveReport,
  type StubMode,
} from "@xpl/core";
import type { CommandSpec } from "../command.js";
import { listText, plural, renderIssues } from "../format.js";
import { readRequests, type QueuedRequest } from "../requests.js";
import { loadExplainer, openWorkspace } from "../repo.js";
import { renderResolveReport } from "./resolve.js";

/** A graph view that draws more ghost boxes than this stops in too many places to be read. */
export const CROWDED_GHOSTS = 12;
/** Ghost ids named in the text output (`--json` lists all of them). */
const TOP_GHOSTS = 5;

/** Where a graph view stops: its ghost boxes and the stubs that lead to them. */
interface GhostStatus {
  /** The view's stub policy (`view.stubs`, defaults filled in). */
  mode: StubMode;
  max: number;
  /** Ghost boxes drawn, and the stubs (dashed edges) that lead to them. */
  total: number;
  stubs: number;
  /** More than `CROWDED_GHOSTS` ghosts: too many to read. */
  crowded: boolean;
  /** Every ghost, the most referenced first: `id` is what `hidden` takes. */
  list: {
    id: string;
    kind: Ghost["kind"];
    label: string;
    count: number;
    direction: Ghost["direction"];
  }[];
  /** Every stub id (`hidden` takes those too). */
  stubIds: string[];
}

interface ViewStatus {
  id: string;
  type: "graph" | "sequence";
  title: string;
  /** Nodes shown (graph: included nodes; sequence: participants). */
  nodes: { total: number; unexplained: string[] };
  /** Graph views: edges shown. `stored` ones (llm/user) need a summary; static ones may have one. */
  edges: { total: number; unexplained: { id: string; stored: boolean }[] };
  /** Graph views: where the view stops. */
  ghosts?: GhostStatus;
  /** Sequence views. */
  steps: { total: number; unexplained: string[] };
}

/** A tour, and the steps that no longer point at anything (their focus ids, or their view, are gone). */
interface TourStatus {
  id: string;
  title: string;
  steps: number;
  unresolved: { step: string; focus: string[]; missingView?: string }[];
}

/** `stubs` is the view's own field (`view.stubs`), as stored: the defaults are filled in here. */
function ghostStatus(graph: DerivedGraph, stubs: unknown): GhostStatus {
  const policy = resolveStubPolicy(stubs);
  const list = [...graph.ghosts]
    .sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((g) => ({
      id: g.id,
      kind: g.kind,
      label: g.label,
      count: g.count,
      direction: g.direction,
    }));
  return {
    ...policy,
    total: graph.ghosts.length,
    stubs: graph.stubs.length,
    crowded: graph.ghosts.length > CROWDED_GHOSTS,
    list,
    stubIds: graph.stubs.map((s) => s.id),
  };
}

function tourStatuses(model: ExplainerModel): TourStatus[] {
  return model.tours.map((tour) => {
    const steps = Array.isArray(tour.steps) ? tour.steps : [];
    const unresolved: TourStatus["unresolved"] = [];
    for (const step of steps) {
      const focus = (Array.isArray(step.focus) ? step.focus : []).filter(
        (id) => typeof id !== "string" || !model.hasElement(id),
      );
      const missingView = model.view(step.view) === undefined ? step.view : undefined;
      if (focus.length > 0 || missingView !== undefined) {
        unresolved.push({
          step: step.id,
          focus: focus.map(String),
          ...(missingView !== undefined ? { missingView: String(missingView) } : {}),
        });
      }
    }
    return { id: tour.id, title: tour.title, steps: steps.length, unresolved };
  });
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
      status.ghosts = ghostStatus(graph, view.stubs);
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

/** Ids of the edges the views show without a summary, at most `max`, then how many more there are. */
function edgeIds(ids: readonly string[], max = 8): string {
  return ids.length <= max
    ? ids.join(", ")
    : `${ids.slice(0, max).join(", ")}, ... +${ids.length - max} more (--json lists all)`;
}

/** The text lines about where a graph view stops: counts, the most referenced ghosts, a crowding warning. */
function ghostLines(g: GhostStatus): string[] {
  const policy = g.mode === "top" ? `top ${g.max}` : g.mode;
  if (g.total === 0) {
    return [
      g.mode === "none"
        ? "  ghosts: none drawn (stubs: none)"
        : "  ghosts: none (nothing leaves the view)",
    ];
  }
  const shown = g.list.slice(0, TOP_GHOSTS).map((ghost) => `${ghost.id} ×${ghost.count}`);
  const lines = [
    `  ghosts: ${g.total} (${plural(g.stubs, "stub")}; stubs: ${policy}), most referenced: ${shown.join(", ")}${
      g.list.length > TOP_GHOSTS
        ? `, ... +${g.list.length - TOP_GHOSTS} more (--json lists all, and the stub ids)`
        : ""
    }`,
  ];
  if (g.crowded) {
    lines.push(
      `  warning: ${g.total} ghosts: this view stops in too many places to read (more than ${CROWDED_GHOSTS}). ` +
        (g.mode === "all"
          ? 'Set "stubs": {"mode": "top"} (what a view without "stubs" does: the 8 most referenced ghosts, the rest folded), '
          : `Lower "stubs": {"max": ${g.max}} to 8 or fewer, `) +
        'put ghost ids in "hidden" (`status --json`: views[].ghosts.list), or add "excludeFiles"',
    );
  }
  return lines;
}

/** `t3 (focus: sym:a#gone, edge:x)`, `t5 (view view:gone is gone)`. */
function unresolvedStep(step: TourStatus["unresolved"][number]): string {
  const parts = [
    ...(step.focus.length > 0 ? [`focus: ${step.focus.join(", ")}`] : []),
    ...(step.missingView !== undefined ? [`view ${step.missingView} is gone`] : []),
  ];
  return `${step.step} (${parts.join("; ")})`;
}

function tourLines(tours: readonly TourStatus[]): string[] {
  const lines = [`tours (${tours.length}):`];
  for (const tour of tours) {
    lines.push(
      `  ${tour.id} (${plural(tour.steps, "step")}): ` +
        (tour.unresolved.length === 0
          ? "every focus id resolves"
          : `${tour.unresolved.length === 1 ? "1 step points" : `${tour.unresolved.length} steps point`} at something that is gone: ${tour.unresolved.map(unresolvedStep).join(", ")}`),
    );
  }
  return lines;
}

/**
 * Drifted elements, split by who can repair them: an llm element whose drifted anchors the user owns
 * (`anchors`, or `steps` for a step) and every element that is not llm-owned wait for the user.
 */
function driftCounts(report: ResolveReport): { total: number; userOwned: number } {
  const locked = (d: DriftedElement) =>
    d.userFields.includes(d.owner === "step" ? "steps" : "anchors");
  return {
    total: report.drifted.length + report.driftedOther.length,
    userOwned: report.drifted.filter(locked).length + report.driftedOther.length,
  };
}

/**
 * Stored overlays of derived edges (`edge:<kind>:<a>-><b>`) that no graph view derives now: the ends of a
 * derived id follow the view's `include`, so an overlay can end up on an id that means nothing any more.
 * (Hidden edges count as derived: hiding is the user's choice, not a stale id.)
 */
function staleOverlays(model: ExplainerModel): string[] {
  const derived = new Set<string>();
  for (const view of model.views) {
    if (view.type !== "graph") continue;
    for (const edge of deriveGraph({ ...view, hidden: [] }, model).edges) derived.add(edge.id);
  }
  return model.storedEdges
    .filter((edge) => parseId(edge.id).type === "derived-edge" && !derived.has(edge.id))
    .map((edge) => edge.id);
}

function unexplainedConcepts(model: ExplainerModel): string[] {
  return model.concepts
    .filter((c) => !(typeof c.summary === "string" && c.summary.trim() !== ""))
    .map((c) => c.id);
}

export const statusCommand: CommandSpec = {
  name: "status",
  usage: "xpl status <explainer>",
  summary: "To-do list: unexplained elements, drifted, missing, queued requests, ghosts, tours",
  details: [
    "The skill's to-do list for an explainer, without changing anything:",
    "  - per view, the visible nodes, edges and steps that have no `summary` (static edges are optional),",
    "  - per graph view, where it stops: the ghost boxes and stubs it draws (counts, and the most referenced ghost",
    "    ids; --json lists every ghost id with its count, and every stub id, in views[].ghosts), with a warning",
    `    above ${CROWDED_GHOSTS} ghosts (a view without "stubs" keeps the 8 most referenced and folds the rest),`,
    "  - concepts without a summary,",
    "  - tours: id, number of steps, and the steps whose focus ids (or view) no longer resolve,",
    "  - llm elements whose anchors drifted (re-explain them, keeping userFields) and missing anchors; drift the",
    "    user owns is counted apart (ask the user),",
    "  - broken references: ids that vanished from the index (overlays of deleted symbols, include, members,",
    "    related, participants, step ends), and stored derived-edge overlays that no graph view derives now,",
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
    const broken = validateExplainer(loaded.explainer, ws.model, ws.texts, {
      mode: "lenient",
    }).filter((issue) => issue.code === "unknown-id");
    const stale = staleOverlays(model);
    const tours = tourStatuses(model);
    const drift = driftCounts(report);
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
      drifted: drift.total,
      driftedUserOwned: drift.userOwned,
      missing: report.missing.length,
      requests: requests.length,
      broken: broken.length,
    };

    if (ctx.json) {
      ctx.emit({
        path: loaded.rel,
        index: { path: ws.indexRel, commit: ws.index.commit },
        todo,
        views,
        concepts: { unexplained: concepts },
        tours,
        anchors: { total: report.total, counts: report.counts },
        drifted: report.drifted,
        driftedOther: report.driftedOther,
        missing: report.missing,
        broken,
        staleOverlays: stale,
        requests,
      });
      return 0;
    }

    const lines = [
      `${loaded.rel}: index ${ws.index.commit}, ${plural(views.length, "view")}, ${plural(model.concepts.length, "concept")}`,
      `to do: ${todo.unexplained} unexplained, ${todo.drifted} drifted${
        todo.driftedUserOwned > 0 ? ` (${todo.driftedUserOwned} user-owned: ask the user)` : ""
      }, ${todo.missing} missing anchors, ${plural(todo.requests, "request")}${
        todo.broken > 0 ? `, ${plural(todo.broken, "broken reference")}` : ""
      }`,
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
        const staticEdges = view.edges.unexplained.filter((e) => !e.stored).map((e) => e.id);
        lines.push(
          `  edges: ${view.edges.total} shown; ` +
            (stored.length > 0
              ? `stored without summary (${stored.length}): ${listText(stored, 8)}`
              : "every stored edge is explained") +
            (staticEdges.length > 0
              ? `; ${staticEdges.length} static without summary (optional): ${edgeIds(staticEdges)}`
              : ""),
        );
        if (view.ghosts) lines.push(...ghostLines(view.ghosts));
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
    if (tours.length > 0) lines.push("", ...tourLines(tours));
    if (report.drifted.length > 0 || report.missing.length > 0 || report.driftedOther.length > 0) {
      lines.push("", ...renderResolveReport(report));
    }
    if (broken.length > 0) {
      lines.push(
        "",
        `broken references (${broken.length}): ids that no longer exist in the index. Repair each with a patch ` +
          "(`includeRemove` drops a stale include entry; resend members, participants or steps without it), or remove the element:",
        ...renderIssues(broken).map((line) => `  ${line}`),
      );
    }
    if (stale.length > 0) {
      lines.push(
        "",
        `warning: stale edge overlays (${stale.length}): stored overlays of derived edges that no graph view derives now ` +
          "(the ends of a derived id follow the view's include, and the code may have changed), so they are ignored. " +
          "Re-create them on the current ids (`status --json`: views[].edges.unexplained) or remove them:",
        ...stale.map((id) => `  ${id}`),
      );
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
