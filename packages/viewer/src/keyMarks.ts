/**
 * What a map's Key shows (components/Legend.tsx): one flag per kind of mark, set only when the map draws it.
 */
import type { LayoutEdge, LayoutNode } from "./layout/graphLayout.js";

export interface LegendShows {
  /** Calls that leave the view (stubs) and boxes outside it (ghosts). */
  outside: boolean;
  /** Links the explainer's author drew (events, configuration). */
  authored: boolean;
  /** Links found by name only (heuristic). */
  heuristic: boolean;
  /** The change's New / Changed pills. */
  change: boolean;
  /** Boxes of code (no architecture role, or a service or component). Default: shown. */
  code?: boolean;
  /** Dashed boxes for what is not this code: an outside system, a person (`role` external or person). */
  outsideSystems?: boolean;
  /** Heavier boxes for a whole system (`role` system). */
  systems?: boolean;
  /** Places that keep data: a database, a cache, a queue, a file store. */
  stores?: boolean;
  /** The icons on the boxes, one of each (see `mapKeyShows`). */
  icons?: readonly KeyIcon[];
  /** The "See what is inside" corner button (a magnifier). */
  zoom?: boolean;
  /** The "Show its parts here" corner button. */
  expandHere?: boolean;
  /** Lines labelled with a count the viewer made up ("calls ×3"). */
  counts?: boolean;
}

/** An icon as a box draws it: the classes give it the colour of its kind. */
export interface KeyIcon {
  name: string;
  kindClass: string;
  role?: string | undefined;
}

const OUTSIDE_ROLES = new Set(["external", "person"]);
const STORE_ROLES = new Set(["database", "cache", "queue", "storage"]);

/**
 * What a laid-out map shows, for its key. `canZoomInto` and `canExpandInPlace` say whether a box shows its
 * corner buttons (GraphView draws them on the same condition).
 */
export function mapKeyShows(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  boxes: {
    canZoomInto(id: string): boolean;
    canExpandInPlace(id: string): boolean;
    changed: boolean;
  },
): LegendShows {
  const shows: Required<LegendShows> = {
    outside: false,
    authored: false,
    heuristic: false,
    change: boxes.changed,
    code: false,
    outsideSystems: false,
    systems: false,
    stores: false,
    icons: [],
    zoom: false,
    expandHere: false,
    counts: false,
  };
  const icons = new Map<string, KeyIcon>();
  const allEdges: LayoutEdge[] = [...edges];
  const visit = (list: readonly LayoutNode[]) => {
    for (const node of list) {
      allEdges.push(...node.edges);
      if (node.ghost) {
        shows.outside = true;
        continue;
      }
      const role = node.role;
      if (!role || role === "service" || role === "component") shows.code = true;
      else if (OUTSIDE_ROLES.has(role)) shows.outsideSystems = true;
      else if (role === "system") shows.systems = true;
      else if (STORE_ROLES.has(role)) shows.stores = true;
      const name = node.role ?? node.kindClass; // icons.tsx iconName
      if (!icons.has(name)) icons.set(name, { name, kindClass: node.kindClass, role });
      if (node.opens !== undefined && boxes.canZoomInto(node.id)) shows.zoom = true;
      if (node.expandable && node.children.length === 0 && boxes.canExpandInPlace(node.id)) {
        shows.expandHere = true;
      }
      visit(node.children);
    }
  };
  visit(nodes);
  for (const edge of allEdges) {
    if (edge.stub) shows.outside = true;
    else if (edge.resolution === "llm" || edge.resolution === "user") shows.authored = true;
    if (edge.resolution === "heuristic" || edge.resolution === "mixed") shows.heuristic = true;
    if (edge.counted && edge.label) shows.counts = true;
  }
  shows.icons = [...icons.values()];
  return shows;
}
