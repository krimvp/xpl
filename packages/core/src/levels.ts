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

/**
 * A graph view with some of its boxes opened in place: for each box in `expanded` that the view shows and
 * that opens a graph view, the boxes of that view join this one. The parts of a service (its members, or the
 * folders under it) are then drawn inside the service's box, and their arrows cross its border. A box that is
 * shown only because another was opened can be opened too. The view itself is not changed; nothing is stored.
 */
export function expandInPlace(
  view: GraphView,
  model: ExplainerModel,
  expanded: ReadonlySet<ElementId>,
): GraphView {
  const own = Array.isArray(view.include) ? view.include : [];
  if (expanded.size === 0) return view;
  const include = [...own];
  const shown = new Set(include);
  const opened = new Set<ElementId>();
  for (let i = 0; i < include.length; i++) {
    const id = include[i]!;
    if (!expanded.has(id) || opened.has(id)) continue;
    opened.add(id);
    const inner = opensView(model, id);
    if (!inner || inner.type !== "graph" || inner.id === view.id) continue;
    for (const part of Array.isArray(inner.include) ? inner.include : []) {
      if (typeof part === "string" && !shown.has(part)) {
        shown.add(part);
        include.push(part);
      }
    }
  }
  return include.length === own.length ? view : { ...view, include };
}

/** True when the box opens a graph view whose boxes can be shown inside it (`expandInPlace`). */
export function canExpandInPlace(model: ExplainerModel, id: ElementId): boolean {
  return opensView(model, id)?.type === "graph";
}
