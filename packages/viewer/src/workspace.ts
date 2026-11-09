import {
  codeFocus,
  deriveGraph,
  expandInPlace,
  OUTSIDE_ROLES,
  repr,
  type ElementId,
  type ExplainerModel,
  type GraphView,
  type ProcessFlow,
  type SequenceView,
  type View,
} from "@xpl/core";
import { reachOf } from "./derive.js";
import {
  layoutGraph,
  layoutGraphFitting,
  type ChangeMarks,
  type GraphLayout,
} from "./layout/graphLayout.js";
import {
  layoutFlow,
  layoutFlowFitting,
  NARROW_PANE,
  type FlowLayout,
  type FlowLayoutOptions,
} from "./layout/flowLayout.js";
import type { ViewerState } from "./store.js";

export function topicElements(ids: readonly ElementId[], model: ExplainerModel): Set<ElementId> {
  const result = new Set(ids);
  for (const id of ids) {
    const element = model.element(id);
    if (element?.type === "concept")
      for (const related of element.concept.related ?? []) result.add(related);
    if (element?.type === "step") {
      result.add(element.step.from);
      result.add(element.step.to);
    }
    if (element?.type === "edge" || element?.type === "derived-edge") {
      result.add(element.type === "edge" ? element.edge.from : element.from);
      result.add(element.type === "edge" ? element.edge.to : element.to);
    }
  }
  return result;
}

export function topicMatches(
  id: ElementId,
  topics: ReadonlySet<ElementId>,
  model: ExplainerModel,
): boolean {
  return (
    topics.has(id) ||
    [...topics].some(
      (topic) => model.hasNode(topic) && model.hasNode(id) && model.subtreeContains(topic, id),
    )
  );
}

/**
 * True when the picked box holds the whole flow without being one of its boxes (the library a flow of its
 * calls runs in): the flow is then not about that box, and the topic panel names the flow instead.
 */
export function aroundFlow(
  id: ElementId,
  flow: Pick<SequenceView, "participants">,
  model: ExplainerModel,
): boolean {
  if (!model.hasNode(id) || flow.participants.includes(id)) return false;
  // Boxes outside the code (the Fetch API, your app) are not inside any box of it.
  const code = flow.participants.filter((participant) => {
    const role = model.node(participant)?.role;
    return !role || !OUTSIDE_ROLES.includes(role);
  });
  return (
    code.length > 0 &&
    code.every(
      (participant) => model.hasNode(participant) && model.subtreeContains(id, participant),
    )
  );
}

/**
 * The stages drawn as "related" to the selection: those of a selected participant (a box picked on the map,
 * or a concept's related symbol). A selected stage does not make the other stages of its own participant
 * related: in a flow inside one function every box would light up. And when every other stage is related,
 * none is marked, as the mark would say nothing.
 */
export function flowRelated(
  flow: ProcessFlow,
  selection: readonly ElementId[],
  topics: ReadonlySet<ElementId>,
  model: ExplainerModel,
): Set<ElementId> {
  const stageIds = new Set(flow.stages.map((stage) => stage.step.id));
  const owners = topicElements(
    selection.filter((id) => !stageIds.has(id)),
    model,
  );
  const out = new Set<ElementId>();
  for (const { step } of flow.stages) {
    if (topics.has(step.id)) continue;
    if (topicMatches(step.from, owners, model) || topicMatches(step.to, owners, model))
      out.add(step.id);
  }
  const others = flow.stages.filter((stage) => !topics.has(stage.step.id)).length;
  return others > 1 && out.size === others ? new Set() : out;
}

export function workspaceView(state: ViewerState, type: "map" | "flow"): View | undefined {
  const candidates = state.model.views.filter((view) =>
    type === "map" ? view.type === "graph" : view.type === "sequence" || view.type === "flow",
  );
  const current = candidates.find((view) => view.id === state.viewId);
  if (current) return current;
  const topics = topicElements(state.selection, state.model);
  const files = new Set(codeFocus(state.selection, state.model).map((range) => range.file));
  const score = (view: View) => {
    const ids = (
      view.type === "graph"
        ? Array.isArray(view.include)
          ? view.include
          : []
        : [
            ...(Array.isArray(view.participants) ? view.participants : []),
            ...(Array.isArray(view.steps)
              ? view.steps.flatMap((step) => (step?.id ? [step.id] : []))
              : []),
          ]
    ).filter((id) => typeof id === "string");
    const direct = ids.filter((id) => topics.has(id)).length;
    const nested = ids.filter((id) =>
      [...topics].some(
        (topic) =>
          state.model.hasNode(id) &&
          state.model.hasNode(topic) &&
          state.model.subtreeContains(id, topic),
      ),
    ).length;
    const shared = codeFocus(ids, state.model).filter((range) => files.has(range.file)).length;
    return direct * 1000 + nested * 100 + shared + (view.id === state.viewId ? 1 : 0);
  };
  return candidates.reduce<View | undefined>(
    (best, view) => (!best || score(view) > score(best) ? view : best),
    undefined,
  );
}

/**
 * The ids a map's first view looks for its first box in (GraphView `order`): the focus of the first tour step
 * on this map (the tour being read first), then the map's include list. A map opened with nothing selected
 * starts on the box the tour starts on, not on whatever box the include list names first.
 */
export function startOrder(
  model: ExplainerModel,
  view: GraphView,
  tourId?: string,
): readonly ElementId[] {
  const include = Array.isArray(view.include) ? view.include : [];
  const current = tourId ? model.tour(tourId) : undefined;
  const tours = current ? [current, ...model.tours.filter((t) => t !== current)] : model.tours;
  // (a step about every box of the map names no part to start on: the next step that names some does)
  const all = (focus: readonly ElementId[]) =>
    include.length > 1 && include.every((id) => focus.includes(id));
  for (const tour of tours)
    for (const step of tour.steps)
      if (
        step.view === view.id &&
        Array.isArray(step.focus) &&
        step.focus.length > 0 &&
        !all(step.focus)
      )
        return [...step.focus, ...include];
  return include;
}

/** The id of the map a guide without one gets: the boxes of its flow (`workspaceMap`). */
export const GENERATED_MAP_ID = "view:workspace-map";

/** The boxes of the map a guide without one gets: its flow's parts, or the top level of the code. */
function generatedInclude(state: ViewerState): ElementId[] {
  const process = workspaceView(state, "flow") as SequenceView | undefined;
  return (process?.participants ?? state.model.children("repo")).filter(
    (id) => typeof id === "string" && state.model.hasNode(id),
  );
}

/**
 * True when the Map tab has a map to show: one the guide has, or one made of 3 boxes or more. A map of a flow's
 * one or two boxes says less than the flow itself.
 */
export function hasMapTab(state: ViewerState): boolean {
  return (
    state.model.views.some((view) => view.type === "graph") || generatedInclude(state).length >= 3
  );
}

/**
 * True when the Flow tab has a flow or a sequence to show. A guide without one gets no Flow tab: a list of
 * the tour's steps under the name "Flow" only repeated the Tour.
 */
export function hasFlowTab(state: Pick<ViewerState, "model">): boolean {
  return state.model.views.some((view) => view.type === "sequence" || view.type === "flow");
}

export function workspaceMap(state: ViewerState) {
  const authored = workspaceView(state, "map") as GraphView | undefined;
  const process = workspaceView(state, "flow") as SequenceView | undefined;
  const view: GraphView = authored
    ? expandInPlace(
        {
          ...authored,
          include: Array.isArray(authored.include)
            ? authored.include.filter((id) => typeof id === "string")
            : [],
        },
        state.model,
        state.expanded,
      )
    : {
        id: GENERATED_MAP_ID,
        type: "graph",
        // what it draws, in plain words: not a "System map", which in a guide is the top level of all
        title: process?.title ? `Parts of “${process.title}”` : "The top level of the code",
        scope: { root: "repo", depth: 1 },
        include: generatedInclude(state),
        provenance: { origin: "static" },
        stubs: { mode: "none" },
      };
  // (the text names the type of each row of a data-model view)
  const graph = deriveGraph(view, state.model, { text: (file) => state.files[file] });
  const included = new Set(view.include);
  const related = new Set<ElementId>();
  for (const id of topicElements(state.selection, state.model)) {
    const shown = repr(id, included, state.model);
    if (shown) related.add(shown);
  }
  // a box traced on the map (`state.reach`): what it leads to, or what leads to it
  const reach = state.reach;
  if (reach && state.selection.length === 1 && state.selection[0] === reach.from) {
    for (const id of reachOf(graph, reach.from, reach.direction)) related.add(id);
  }
  return { view, graph, related, generated: authored === undefined };
}

/**
 * Is this view read code first (`SequenceView.layout`)? Then Read and Explore show the code as the main pane and
 * the flow as a narrow outline beside it, which follows the selection and the caret. Without a setting: a flow or
 * sequence of three steps or more whose code (every step's anchors in the current code) is all in one file, the
 * steps of one function, where the question lives in the code and a big canvas only repeats it (review
 * 2026-10-03, senior §5). A flow with two or more outcomes (terminal steps) is a choice between them: it is
 * drawn as a diagram, where the outcomes sit side by side (a narrow outline cut them off).
 */
export function codeFirstView(view: View | undefined): boolean {
  if (!view || view.type === "graph") return false;
  if (view.layout === "code-first") return true;
  if (view.layout === "diagram") return false;
  const steps = Array.isArray(view.steps) ? view.steps : [];
  if (steps.length < 3) return false;
  if (view.type === "flow" && steps.filter((step) => step?.shape === "terminal").length >= 2)
    return false;
  const files = new Set<string>();
  for (const step of steps) {
    const anchors = (Array.isArray(step?.anchors) ? step.anchors : []).filter(
      (anchor) => anchor && typeof anchor.file === "string" && anchor.at !== "base",
    );
    if (anchors.length === 0) return false;
    for (const anchor of anchors) files.add(anchor.file);
    if (files.size > 1) return false;
  }
  return true;
}

/** One link of a flow step to a step next to it, for the outline's "Around this step" list. */
export interface StepLink {
  /** The step at the other end. */
  id: string;
  label: string;
  /** Before the step (an arrow into it), or after it. */
  side: "before" | "after";
  /** The arrow's own words ("fits", "next node"), if any. */
  words?: string;
  kind?: "recurse" | "return";
}

/**
 * The steps one arrow away from `stepId` in a flow: where it comes from and where it goes, recurse and return
 * links included (in a narrow outline they often run off the canvas). Arrows in, then arrows out, each in the
 * flow's own order.
 */
export function stepLinks(flow: ProcessFlow, stepId: string): StepLink[] {
  const labels = new Map(flow.stages.map(({ step }) => [step.id, step.label] as const));
  const order = new Map(flow.stages.map(({ step }, i) => [step.id, i] as const));
  const out: StepLink[] = [];
  for (const side of ["before", "after"] as const) {
    const links = flow.transitions
      .filter((t) => (side === "before" ? t.to === stepId : t.from === stepId))
      .map((t) => ({ t, other: side === "before" ? t.from : t.to }))
      // a return with no step goes back to whoever made the call: there is no step to list
      .filter((link): link is { t: (typeof link)["t"]; other: string } => link.other !== undefined)
      .filter(({ t, other }) => (other !== stepId || t.kind) && labels.has(other))
      .sort((a, b) => order.get(a.other)! - order.get(b.other)!);
    for (const { t, other } of links) {
      out.push({
        id: other,
        label: labels.get(other)!,
        side,
        ...(t.label ? { words: t.label } : {}),
        ...(t.kind ? { kind: t.kind } : {}),
      });
    }
  }
  return out;
}

/**
 * The direction (right or down) each graph view was first laid out in, for the page's life: the Tour's
 * picture, the Map, Present and Explore draw a view the same way round, and a pane that changes shape (Show
 * code, a wider slide column) changes only the zoom. The first pane a view is drawn in picks it.
 */
const directions = new Map<string, GraphLayout["direction"]>();

/** `layoutGraphFitting` the first time a view is drawn; the same direction every time after. */
export async function layoutView(
  viewId: string,
  graph: Parameters<typeof layoutGraphFitting>[0],
  viewport: { width: number; height: number } | undefined,
  maxZoom: number | undefined,
  padding: number | undefined,
  changes: ChangeMarks | undefined,
  pins: GraphView["layout"],
): Promise<GraphLayout> {
  const known = directions.get(viewId);
  if (known) return layoutGraph(graph, { direction: known, pins }, changes);
  const layout = await layoutGraphFitting(graph, viewport, maxZoom, padding, changes, pins);
  // (a layout with no direction, the grid fallback, decides nothing)
  if (!layout.fallback && viewport) directions.set(viewId, layout.direction);
  return layout;
}

/** Per flow view: the direction and the number of parts it was first laid out in (as `directions`). */
const flowShapes = new Map<string, Pick<FlowLayout, "direction" | "parts" | "column">>();

/**
 * The pane a flow's shape is chosen for: the window less the page's columns and header, the same size
 * whichever tab or picture draws the flow first. (The real panes differ: the Tour's picture, the Flow tab,
 * Explore and a pane that shows code. A shape picked from the first of them made one flow two layouts on one
 * page, and the next page load could pick a third.)
 */
export function flowPane(): { width: number; height: number } {
  const wide = window.innerWidth >= NARROW_PANE;
  return {
    width: Math.max(320, window.innerWidth - (wide ? 240 : 0)),
    height: Math.max(320, window.innerHeight - 130),
  };
}

/**
 * `layoutFlowFitting` for `flowPane` the first time a flow is drawn; the same direction and parts every time
 * after, so the Tour's picture, the Flow tab and Explore draw a flow the same way round, and "Fit all" or a
 * pane that changes shape changes only the zoom. (Present picks its own, for its slide.)
 */
export async function layoutFlowView(
  viewId: string,
  flow: ProcessFlow,
  options: Omit<FlowLayoutOptions, "direction" | "parts"> = {},
): Promise<FlowLayout> {
  const known = flowShapes.get(viewId);
  if (known) return layoutFlow(flow, { ...options, ...known });
  const layout = await layoutFlowFitting(flow, flowPane(), options);
  flowShapes.set(viewId, {
    direction: layout.direction,
    parts: layout.parts,
    ...(layout.column ? { column: true } : {}),
  });
  return layout;
}
