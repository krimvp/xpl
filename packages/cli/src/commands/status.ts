import {
  ExplainerModel,
  deriveGraph,
  parseId,
  processFlow,
  reresolveExplainer,
  resolveStubPolicy,
  validateExplainer,
  viewContentStatuses,
  type DerivedGraph,
  type DriftedElement,
  type Ghost,
  type ResolveReport,
  type StubMode,
  type View,
} from "@xpl/core";
import type { CommandSpec } from "../command.js";
import { CliError, UsageError } from "../errors.js";
import { guideInventory } from "../inventory.js";
import { readWatchState } from "../watch-state.js";
import { listText, plural, renderIssues } from "../format.js";
import { artifactIdentity, feedbackContextReason } from "@xpl/core";
import { readRequests, type QueuedRequest } from "../requests.js";
import { loadReadExplainer, openWorkspace } from "../repo.js";
import { renderResolveReport } from "./resolve.js";

/** A graph view that draws more ghost boxes than this stops in too many places to be read. */
export const CROWDED_GHOSTS = 12;
/** Ghost ids named in the text output (`--json` lists all of them). */
const TOP_GHOSTS = 5;
/** Targets named per folded ghost in the text output (`--json` lists all of them). */
const TOP_TARGETS = 3;

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
  /**
   * Every ghost, the most referenced first: `id` is what `hidden` takes. `targets` is what the ghost stands for,
   * most referenced first, each with its reference count: the ids `includeAdd` takes. A folded ghost
   * (`rest`, `more`) is not an element, so its targets are how to expand it; a `target` ghost has just itself.
   */
  list: {
    id: string;
    kind: Ghost["kind"];
    label: string;
    count: number;
    direction: Ghost["direction"];
    targets: { id: string; count: number }[];
  }[];
  /** Every stub id (`hidden` takes those too). */
  stubIds: string[];
}

interface ViewStatus {
  id: string;
  type: "graph" | "sequence" | "flow";
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
      targets: g.targets.map((t) => ({ id: t.target, count: t.count })),
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
  return viewContentStatuses(model).map((status) => {
    const view = model.view(status.id)!;
    return view.type === "graph"
      ? { ...status, ghosts: ghostStatus(deriveGraph(view, model), view.stubs) }
      : status;
  });
}

/** Ids of the edges the views show without a summary, at most `max`, then how many more there are. */
function edgeIds(ids: readonly string[], max = 8): string {
  return ids.length <= max
    ? ids.join(", ")
    : `${ids.slice(0, max).join(", ")}, ... +${ids.length - max} more (--json lists all)`;
}

/** `sym:a.go#T.m ×9, file:b.go ×5, sym:c.go#f ×4, ... +2 more`: what a ghost stands for, at most `TOP_TARGETS`. */
function targetsText(targets: readonly { id: string; count: number }[]): string {
  const shown = targets.slice(0, TOP_TARGETS).map((t) => `${t.id} ×${t.count}`);
  return targets.length > TOP_TARGETS
    ? `${shown.join(", ")}, ... +${targets.length - TOP_TARGETS} more`
    : shown.join(", ");
}

/**
 * The text lines about where a graph view stops: counts, the most referenced ghosts, what each folded ghost
 * stands for, a crowding warning.
 */
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
  // A folded ghost is not an element, so `includeAdd` needs one of the elements it stands for.
  for (const ghost of g.list) {
    if (ghost.kind !== "target") {
      lines.push(`    ${ghost.id} ×${ghost.count} → ${targetsText(ghost.targets)}`);
    }
  }
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

/** An edge a graph view draws, or one its `hidden` takes out (`status --view`). */
interface DrawnEdge {
  id: string;
  kind: string;
  from: string;
  to: string;
  /** Index references it stands for (1 for a stored edge). */
  count: number;
  /** `stored`: an edge of the explainer (llm or user); `derived`: from the index, `overlay` when it has a stored overlay. */
  origin: "stored" | "derived";
  overlay?: boolean;
  label?: string;
  summary: boolean;
}

/** A link a flow or sequence view draws: a step to the next (flow `next`), or a message (sequence). */
interface DrawnLink {
  id: string;
  from: string;
  to?: string;
  kind?: string;
  label?: string;
}

interface ViewEdges {
  /** Graph views: the edges drawn, most references first. */
  drawn?: DrawnEdge[];
  /**
   * Graph views: each `hidden` id, with the arrow it takes out (`edge`), else what it is: a box, a stub or a ghost
   * box it hides, a stored edge that is no arrow of its own on this view (hiding it does nothing), or nothing.
   */
  hidden?: {
    id: string;
    edge?: DrawnEdge;
    is?: "box" | "stub" | "ghost" | "folded edge" | "unknown";
  }[];
  /** Flow and sequence views: the links between steps. */
  links?: DrawnLink[];
}

function drawnEdge(edge: DerivedGraph["edges"][number]): DrawnEdge {
  const derived = parseId(edge.id).type === "derived-edge";
  return {
    id: edge.id,
    kind: edge.kind,
    from: edge.from,
    to: edge.to,
    count: edge.count,
    origin: derived ? "derived" : "stored",
    ...(derived && edge.stored ? { overlay: true } : {}),
    ...(edge.label ? { label: edge.label } : {}),
    summary: typeof edge.summary === "string" && edge.summary.trim() !== "",
  };
}

/** What one view draws (`status --view`): its edges and hidden ids, or its step links. */
function viewEdges(view: View, model: ExplainerModel): ViewEdges {
  if (view.type === "graph") {
    const graph = deriveGraph(view, model);
    const all = deriveGraph({ ...view, hidden: [] }, model);
    const byCount = (a: DrawnEdge, b: DrawnEdge) =>
      b.count - a.count || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const edges = new Map(all.edges.map((edge) => [edge.id, drawnEdge(edge)] as const));
    const stubs = new Set(all.stubs.map((stub) => stub.id));
    const ghosts = new Set(all.ghosts.map((ghost) => ghost.id));
    return {
      drawn: graph.edges.map(drawnEdge).sort(byCount),
      hidden: (Array.isArray(view.hidden) ? view.hidden : []).map((id) => {
        const edge = edges.get(id);
        if (edge) return { id, edge };
        const is = model.hasNode(id)
          ? "box"
          : stubs.has(id)
            ? "stub"
            : ghosts.has(id)
              ? "ghost"
              : model.storedEdges.some((stored) => stored.id === id)
                ? "folded edge"
                : "unknown";
        return { id, is };
      }),
    };
  }
  if (view.type === "flow") {
    return {
      links: processFlow(view).transitions.map((t) => ({
        id: t.id,
        from: t.from,
        ...(t.to !== undefined ? { to: t.to } : {}),
        ...(t.kind ? { kind: t.kind } : {}),
        ...(t.label !== undefined ? { label: t.label } : {}),
      })),
    };
  }
  return {
    links: (Array.isArray(view.steps) ? view.steps : []).map((step) => ({
      id: step.id,
      from: step.from,
      to: step.to,
      kind: step.kind,
      ...(step.label ? { label: step.label } : {}),
    })),
  };
}

/** What a hidden id that is no arrow of the view hides. */
const HIDDEN_WORDS = {
  box: "a box",
  stub: "a stub",
  ghost: "a ghost box",
  "folded edge":
    "a stored edge that is no arrow of its own here: on this map it is part of another arrow between the same boxes, or its ends are not on it; hiding it does nothing, hide that arrow instead",
  unknown: "matches nothing this view would draw now: remove it from hidden",
} as const;

/** `edge:calls:a->b  calls  a → b  ×3  derived (overlay)  "label"  no summary` */
function drawnEdgeLine(edge: DrawnEdge): string {
  return [
    edge.id,
    edge.kind,
    `${edge.from} → ${edge.to}`,
    `×${edge.count}`,
    edge.origin === "stored" ? "stored" : edge.overlay ? "derived (stored overlay)" : "derived",
    ...(edge.label ? [`"${edge.label}"`] : []),
    ...(edge.summary ? [] : ["no summary"]),
  ].join("  ");
}

function viewEdgeLines(edges: ViewEdges): string[] {
  const lines: string[] = [];
  if (edges.drawn) {
    const stored = edges.drawn.filter((e) => e.origin === "stored").length;
    lines.push(
      `  edges drawn (${edges.drawn.length}: ${stored} stored, ${edges.drawn.length - stored} derived), most references first:`,
      ...edges.drawn.map((edge) => `    ${drawnEdgeLine(edge)}`),
    );
  }
  if (edges.hidden) {
    lines.push(
      edges.hidden.length === 0 ? "  hidden: none" : `  hidden (${edges.hidden.length}):`,
      ...edges.hidden.map(
        (h) =>
          `    ${h.edge ? drawnEdgeLine(h.edge) : `${h.id}  (${HIDDEN_WORDS[h.is ?? "unknown"]})`}`,
      ),
    );
  }
  if (edges.links) {
    lines.push(
      `  links (${edges.links.length}):`,
      ...edges.links.map((link) =>
        [
          `    ${link.id}`,
          `${link.from} → ${link.to ?? "(back to the caller)"}`,
          ...(link.kind ? [link.kind] : []),
          ...(link.label ? [`"${link.label}"`] : []),
        ].join("  "),
      ),
    );
  }
  return lines;
}

export const statusCommand: CommandSpec = {
  name: "status",
  usage: "xpl status [explainer] [--view <id>] [--all]",
  summary: "To-do list: unexplained elements, drifted, missing, queued requests, ghosts, tours",
  details: [
    "--all resolves every .explainer/*.explainer.json guide against the current index and reports moved,",
    "drifted and missing anchors, including user-owned anchors and unreadable guides. No prose is written.",
    "Moved code keeps its prose; drift and missing evidence need explicit repair. Watch status is included in --json.",
    "Omit the explainer when the repository has exactly one; otherwise supply its name.",
    "The skill's to-do list for an explainer, without changing anything:",
    "  - per view, the visible nodes, edges and steps that have no `summary` (static edges are optional),",
    "  - per graph view, where it stops: the ghost boxes and stubs it draws (counts, and the most referenced ghost",
    `    ids), with a warning above ${CROWDED_GHOSTS} ghosts (a view without "stubs" keeps the 8 most referenced and`,
    "    folds the rest). A folded ghost (ghost:rest:file:<path>, ghost:more:in|out) is not an element: it gets a line",
    "    under the counts that names up to 3 of the elements it stands for, and includeAdd takes any of them. --json",
    "    lists every ghost id with its count and all its targets, and every stub id, in views[].ghosts,",
    "  - concepts without a summary,",
    "  - tours: id, number of steps, and the steps whose focus ids (or view) no longer resolve,",
    "  - llm elements whose anchors drifted (re-explain them, keeping userFields) and missing anchors; drift the",
    "    user owns is counted apart (ask the user),",
    "  - broken references: ids that vanished from the index (overlays of deleted symbols, include, members,",
    "    related, participants, step ends), and stored derived-edge overlays that no graph view derives now,",
    "  - explain-this requests the viewer queued in .explainer/requests.json (record selected outcomes with xpl feedback --outcomes).",
    "",
    "--view <id>: only that view, and what it draws: a graph view's edges (id, kind, ends, references, stored or",
    "derived, label, whether it has a summary) and each id in its `hidden` with the edge it takes out; a flow's",
    "links between steps (a return with no step goes back to the caller); a sequence's messages. --json adds",
    "`edges: {drawn, hidden}` or `edges: {links}` to the view.",
  ],
  options: {
    all: {
      type: "boolean",
      desc: "Inventory all repository guides against the current index without writing",
    },
    view: {
      type: "string",
      arg: "<id>",
      desc: "Only this view, with the edges (or step links) it draws and what its hidden takes out",
    },
  },
  positionals: [{ name: "explainer", required: false }],
  async run(ctx, args) {
    if (args.flag("all")) {
      if (args.positionals.length || args.str("view"))
        throw new UsageError("--all cannot be combined with an explainer or --view");
      const ws = await openWorkspace(ctx);
      const guides = guideInventory(ctx, ws.model, ws.texts);
      const watch = readWatchState(ctx.root) ?? null;
      if (ctx.json)
        ctx.emit({
          index: { path: ws.indexRel, commit: ws.index.commit },
          stale: ws.stale?.message ?? null,
          watch,
          guides,
        });
      else
        ctx.out(
          [
            `repository guides: index ${ws.index.commit}${ws.stale ? " (out of date)" : ""}`,
            ...guides.map((g) =>
              "error" in g
                ? `${g.name}: needs attention (${g.error})`
                : `${g.name}: ${g.attention ? "needs attention" : "unchanged prose"}; ${g.anchors.counts.moved} moved, ${g.anchors.counts.drifted} drifted, ${g.anchors.counts.missing} missing`,
            ),
          ].join("\n"),
        );
      return 0;
    }
    const loaded = loadReadExplainer(ctx, args.positionals[0], "status");
    const ws = await openWorkspace(ctx, { explainer: loaded });
    const model = new ExplainerModel(loaded.explainer, ws.model);
    const viewId = args.str("view");
    if (viewId !== undefined) {
      const view = model.view(viewId);
      if (view === undefined) {
        throw new CliError(
          `no view ${viewId} in ${loaded.rel}; its views: ${model.views.map((v) => v.id).join(", ") || "none"}`,
        );
      }
      const status = viewStatuses(model).find((v) => v.id === viewId)!;
      const edges = viewEdges(view, model);
      if (ctx.json) {
        ctx.emit({ path: loaded.rel, view: { ...status, edges } });
        return 0;
      }
      ctx.out(
        [
          `${view.id} (${view.type}): ${view.title}`,
          `  ${view.type === "graph" ? "boxes" : "participants"}: ${status.nodes.total}${
            status.nodes.unexplained.length > 0
              ? ` (${status.nodes.unexplained.length} without summary: ${listText(status.nodes.unexplained, 8)})`
              : ""
          }`,
          ...viewEdgeLines(edges),
          ...(status.ghosts ? ghostLines(status.ghosts) : []),
        ].join("\n"),
      );
      return 0;
    }
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
      (r) =>
        (r.explainer === undefined || r.explainer === loaded.name) &&
        r.outcome.status !== "addressed" &&
        r.outcome.status !== "rejected",
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
        `requests queued by the viewer (${requests.length}; record selected outcomes with xpl feedback --outcomes):`,
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
        const contextReason =
          feedbackContextReason(r, artifactIdentity(loaded.explainer, ws.index)) ??
          ws.stale?.message;
        lines.push(
          `    ${r.id}  ${r.outcome.status}: ${r.outcome.reason}${contextReason ? ` (outdated context: ${contextReason})` : ""}`,
        );
      }
    }
    ctx.out(lines.join("\n"));
    return 0;
  },
};
