/**
 * Levels of an architecture explainer (ARCHITECTURE.md §2, amendment 19): a box with `opens` leads to the
 * view that shows what is inside it (a system map -> the inside of one service -> its code). These helpers
 * find the way down and the way back up.
 */
import type { ExplainerModel } from "./model.js";
import type { ElementId, GraphView, View } from "./schema.js";

/** One level above a view: the view that shows a box, and the box that opens the level below. */
export interface ZoomLevel {
  view: View;
  /** The box in `view` whose `opens` leads one level down. */
  box: ElementId;
}

/** The view a box opens, when the box says and the view exists. */
export function opensView(model: ExplainerModel, id: ElementId): View | undefined {
  const opens = model.node(id)?.opens;
  return typeof opens === "string" ? model.view(opens) : undefined;
}

/** The graph view one level up from `viewId`: the first one (in file order) with a box that opens it. */
export function parentLevel(model: ExplainerModel, viewId: string): ZoomLevel | undefined {
  for (const view of model.views) {
    if (view.type !== "graph" || view.id === viewId) continue;
    const include = Array.isArray((view as GraphView).include) ? (view as GraphView).include : [];
    const box = include.find((id) => typeof id === "string" && model.node(id)?.opens === viewId);
    if (box !== undefined) return { view, box };
  }
  return undefined;
}

/**
 * The levels above `viewId`, top first ("System map", then "Inside the API service"); empty for a view no
 * box opens. Stops at a cycle (two views that open each other).
 */
export function zoomTrail(model: ExplainerModel, viewId: string): ZoomLevel[] {
  const trail: ZoomLevel[] = [];
  const seen = new Set<string>([viewId]);
  let level = parentLevel(model, viewId);
  while (level && !seen.has(level.view.id)) {
    seen.add(level.view.id);
    trail.unshift(level);
    level = parentLevel(model, level.view.id);
  }
  return trail;
}
