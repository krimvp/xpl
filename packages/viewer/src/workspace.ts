import {
  codeFocus,
  deriveGraph,
  expandInPlace,
  repr,
  type ElementId,
  type ExplainerModel,
  type GraphView,
  type ProcessFlow,
  type SequenceView,
  type View,
} from "@xpl/core";
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
        id: "view:workspace-map",
        type: "graph",
        title: "System map",
        scope: { root: "repo", depth: 1 },
        include: process?.participants ?? state.model.children("repo"),
        provenance: { origin: "static" },
        stubs: { mode: "none" },
      };
  const graph = deriveGraph(view, state.model);
  const included = new Set(view.include);
  const related = new Set<ElementId>();
  for (const id of topicElements(state.selection, state.model)) {
    const shown = repr(id, included, state.model);
    if (shown) related.add(shown);
  }
  return { view, graph, related, generated: authored === undefined };
}

/**
 * Is this view read code first (`SequenceView.layout`)? Then Read and Explore show the code as the main pane and
 * the flow as a narrow outline beside it, which follows the selection and the caret. Without a setting: a flow or
 * sequence of three steps or more whose code (every step's anchors in the current code) is all in one file, the
 * steps of one function, where the question lives in the code and a big canvas only repeats it (review
 * 2026-10-03, senior §5).
 */
export function codeFirstView(view: View | undefined): boolean {
  if (!view || view.type === "graph") return false;
  if (view.layout === "code-first") return true;
  if (view.layout === "diagram") return false;
  const steps = Array.isArray(view.steps) ? view.steps : [];
  if (steps.length < 3) return false;
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
