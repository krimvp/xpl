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
  /** The kind of the first such line, for the Key's example ("implements ×3" on a map with no calls). */
  countKind?: string;
  /** Tables (`GraphView.boxText: "members"`): a type, one row per field. */
  tables?: boolean;
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
  "embeds",
  "implements",
  "references",
  "holds",
  "reads",
  "writes",
  "requests",
] as const;

/** The head an arrow of a kind ends in: a class hierarchy and an import do not read as calls (GraphView). */
export function headOf(kind: string): "filled" | "hollow" | "open" {
  if (kind === "extends" || kind === "embeds" || kind === "implements") return "hollow";
  if (kind === "imports" || kind === "references" || kind === "holds") return "open";
  return "filled";
}

/**
 * Technologies whose icon says more than their role's: a git repository is not "outside" the way a
 * web service is, a browser is a window, a settings file is a file.
 */
const TECH_ICONS: [RegExp, string][] = [
  [/\bgit\b|repositor/i, "repo"],
  [/browser|\bhtml\b|web page/i, "browser"],
  [/\b(yaml|json|toml|ini|markdown|csv)\b|\bfiles?\b/i, "file"],
];

/** The name of the icon a box shows: what its technology is, else its role, else the kind of code it is. */
export function iconName(box: {
  role?: string | undefined;
  kindClass: string;
  kindWord?: string | undefined;
  badge?: string | undefined;
}): string {
  // (only where the role's own icon would mislead: the globe of an outside system, a person)
  if ((box.role === "external" || box.role === "person") && box.badge)
    for (const [pattern, icon] of TECH_ICONS) if (pattern.test(box.badge)) return icon;
  return box.role ?? box.kindWord ?? box.kindClass;
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
    countKind: "",
    tables: false,
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
      // a row of a table is a field: no icon, and not a box of its own in the Key
      if (node.row) continue;
      const role = node.role;
      if (node.rows)
        shows.tables = true; // keyed as a table, not as a box of code
      else if (node.sketch) shows.sketches = true;
      else if (!role || role === "service" || role === "component") shows.code = true;
      else if (OUTSIDE_ROLES.has(role)) shows.outsideSystems = true;
      else if (role === "system") shows.systems = true;
      else if (STORE_ROLES.has(role)) shows.stores = true;
      const name = iconName(node);
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
    // a field's arrow on a data map (core names it "holds"), keyed apart from a type named in code
    // and Go's embedded types (core names them "embeds"): Go has no parent types to "extend"
    if (!edge.stub)
      kinds.add(
        edge.kind === "references" && edge.title === "holds"
          ? "holds"
          : edge.kind === "extends" && edge.title?.startsWith("embeds")
            ? "embeds"
            : edge.kind,
      );
    if (edge.counted && edge.label && !shows.counts) {
      shows.counts = true;
      shows.countKind = edge.kind;
    }
  }
  shows.icons = [...icons.values()];
  shows.kinds = KIND_ORDER.filter((kind) => kinds.has(kind));
  return shows;
}

/** A kind of arrow in a few words, for the key line. */
const KIND_SHORT: Record<string, string> = {
  calls: "calls",
  imports: "imports",
  extends: "extends",
  embeds: "embeds",
  implements: "implements",
  references: "uses a type",
  holds: "a field holds this type",
  reads: "reads",
  writes: "writes",
  requests: "web request",
};

/**
 * The items of a map's key line (`KeyLine`), by key (`kind-<kind>`, `authored`, `found`, `heuristic`, `mixed`,
 * `ghost`, `stub`, `shared`), each with its words. `stubLines`: lines to code outside the map are on screen
 * (else only their dashed boxes are). None when every arrow is the plain kind. No two items look alike: a
 * map of calls alone says "calls, found in the code" once, not a "calls" arrow and a "found" arrow that are
 * the same solid line; and it names "calls" only when it draws arrows found in the code.
 */
export function keyLineItems(
  shows: LegendShows,
  stubLines = false,
  shared?: string,
): { key: string; words: string }[] {
  const items: { key: string; words: string }[] = [];
  if (shared) items.push({ key: "shared", words: `every box: ${shared}` });
  const kinds = shows.kinds ?? [];
  const onlyCalls = kinds.length === 1 && kinds[0] === "calls";
  const kindItems = kinds.map((kind) => ({ key: `kind-${kind}`, words: KIND_SHORT[kind] ?? kind }));
  // the kinds when the map mixes them, or draws only arrows that are not calls (a class hierarchy)
  if (kinds.length > 0 && !onlyCalls) items.push(...kindItems);
  if (shows.authored)
    items.push({ key: "authored", words: "added by the author, checked against the code" });
  const found = shows.found && (shows.authored || shows.heuristic || shows.mixed || shows.outside);
  if (found)
    items.push({
      key: "found",
      words: onlyCalls ? "calls, found in the code" : "found in the code",
    });
  if (shows.heuristic) items.push({ key: "heuristic", words: "matched by name" });
  if (shows.mixed) items.push({ key: "mixed", words: "partly matched by name" });
  if (shows.outside) {
    items.push({
      key: "ghost",
      words: stubLines
        ? "code outside this map"
        : "code outside this map (pick a box to see its arrows)",
    });
    if (stubLines) items.push({ key: "stub", words: "leads outside this map" });
  }
  if (items.length === 0) return [];
  // a map of calls alone names them when the line says anything else, so an arrow without words has one
  // here; not when its only arrows are the author's (they carry their own words)
  const derived = shows.found || shows.heuristic || shows.mixed;
  if (onlyCalls && !found && derived) items.splice(shared ? 1 : 0, 0, ...kindItems);
  return items;
}
