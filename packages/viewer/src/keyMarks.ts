/**
 * What a map's Key shows (components/Legend.tsx): one flag per kind of mark, set only when the map draws it.
 */
import type { LayoutEdge, LayoutNode } from "./layout/graphLayout.js";

export interface LegendShows {
  /** Calls that leave the view (stubs) and boxes outside it (ghosts). */
  outside: boolean;
  /** Links the explainer's author drew (events, configuration). */
  authored: boolean;
  /** Links found by name only (heuristic): drawn dashed. */
  heuristic: boolean;
  /** Arrows that hold references found both ways, by a language tool and by name: drawn dash-dot. */
  mixed?: boolean;
  /**
   * The kinds of the arrows drawn (`calls`, `imports`, `extends`, ...), stubs left out, in a fixed order: the Key
   * has a row for each, so a map of imports or of a class hierarchy is not keyed as calls.
   */
  kinds?: readonly string[];
  /** The change's New / Changed pills. */
  change: boolean;
  /** Boxes of code (no architecture role, or a service or component). Default: shown. */
  code?: boolean;
  /** Dashed boxes for what is not this code: an outside system, a person (`role` external or person). */
  outsideSystems?: boolean;
  /** Dotted boxes for ideas linked to no code (`Node.sketch`). */
  sketches?: boolean;
  /** Heavier boxes for a whole system (`role` system). */
  systems?: boolean;
  /** Places that keep data: a database, a cache, a queue, a file store. */
  stores?: boolean;
  /** The icons on the boxes, one of each (see `mapKeyShows`). */
  icons?: readonly KeyIcon[];
  /** The "See what is inside" corner button (a magnifier). */
  zoom?: boolean;
  /** The "Show inside" corner button. */
  expandHere?: boolean;
  /** Lines labelled with a count the viewer made up ("calls ×3"). */
  counts?: boolean;
  /** Lines found in the code (not drawn by the author, not out of the map). */
  found?: boolean;
}

/** An icon as a box draws it: the classes give it the colour of its kind. */
export interface KeyIcon {
  name: string;
  kindClass: string;
  role?: string | undefined;
}

/** The kinds a Key names, in the order it names them (an authored kind such as `emits` has the authored row). */
export const KIND_ORDER = [
  "calls",
  "imports",
  "extends",
  "implements",
  "references",
  "reads",
  "writes",
  "requests",
] as const;

/** The head an arrow of a kind ends in: a class hierarchy and an import do not read as calls (GraphView). */
export function headOf(kind: string): "filled" | "hollow" | "open" {
  if (kind === "extends" || kind === "implements") return "hollow";
  if (kind === "imports" || kind === "references") return "open";
  return "filled";
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
    mixed: false,
    kinds: [],
    change: boxes.changed,
    code: false,
    outsideSystems: false,
    sketches: false,
    systems: false,
    stores: false,
    icons: [],
    zoom: false,
    expandHere: false,
    counts: false,
    found: false,
  };
  const icons = new Map<string, KeyIcon>();
  const kinds = new Set<string>();
  const allEdges: LayoutEdge[] = [...edges];
  const visit = (list: readonly LayoutNode[]) => {
    for (const node of list) {
      allEdges.push(...node.edges);
      if (node.ghost) {
        shows.outside = true;
        continue;
      }
      const role = node.role;
      if (node.sketch) shows.sketches = true;
      else if (!role || role === "service" || role === "component") shows.code = true;
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
    else if (edge.resolution !== "heuristic" && edge.resolution !== "mixed") shows.found = true;
    if (edge.resolution === "heuristic") shows.heuristic = true;
    if (edge.resolution === "mixed") shows.mixed = true;
    if (!edge.stub) kinds.add(edge.kind);
    if (edge.counted && edge.label) shows.counts = true;
  }
  shows.icons = [...icons.values()];
  shows.kinds = KIND_ORDER.filter((kind) => kinds.has(kind));
  return shows;
}
