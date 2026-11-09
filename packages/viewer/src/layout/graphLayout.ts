/**
 * Graph views: `DerivedGraph` (core) -> boxes and routed edges that GraphView draws as SVG.
 *
 * A layered layout (layered.ts, on dagre; direction RIGHT by default, `layoutGraphFitting` picks RIGHT or
 * DOWN by what reads larger in the pane). Included nodes with included children are containers: each
 * container's inside is laid out first, as a level of its own with room for the container's header, and
 * the container then takes part in the level above as one box of that size. Ghost boxes (where a view
 * stops) are plain nodes at the top level; stubs are edges to them.
 *
 * Every edge belongs to the lowest container that holds both of its ends (the canvas for top-level
 * ones). It is laid out in that container's level between the two boxes its ends are drawn in there, and
 * routed relative to that container's top-left corner, with right-angled ends on the boxes it joins (which
 * may sit deeper inside those two): GraphView draws it inside the container's group. Node positions are
 * relative to their container too. If the layout throws, a simple grid keeps the diagram usable (all edges
 * on the canvas, in canvas coordinates).
 */
import {
  ghostId,
  type DerivedEdge,
  type DerivedGraph,
  type Ghost,
  type GhostTarget,
  type GraphNode,
  type GraphView,
  type NodeRole,
  type Stub,
} from "@xpl/core";
import { drawnEdges } from "../drawnEdges.js";
import type { ChangeStatus } from "../diff.js";
import { textWidth } from "../measure.js";
import {
  distanceToSegment,
  nearRoute,
  routeAnchor,
  routeBox,
  type Box,
  type Point,
} from "../svg.js";
import { unionBox, type Focus } from "../viewport.js";
import {
  layered,
  layerIndex,
  orthogonalRoute,
  separateTracks,
  sideToward,
  spreadPorts,
  type Direction,
  type LayeredEdge,
  type LayeredNode,
  type LayeredOptions,
  type LayeredResult,
  type Port,
  type Side,
} from "./layered.js";

export type { Point } from "../svg.js";

export interface LayoutNode {
  /** Element id; `ghost:<id>` for ghost boxes. */
  id: string;
  label: string;
  /** Text of the kind badge (`file`, `class`, `method`, `group`, ...). Ghosts: empty. */
  badge: string;
  /** Every box of the map has this badge (`GraphLayout.sharedBadge`): not drawn, still in the box's name. */
  badgeShared?: boolean;
  /** CSS class suffix: the node kind, or the symbol kind for symbols; `ghost` for ghost boxes. */
  kindClass: string;
  ghost: boolean;
  /** Ghosts: the element that joins the view when the ghost is clicked (a ghost for one element). */
  ghostTarget?: string;
  /**
   * Ghosts that stand for several elements ("rest of <file>", "N more"): a click offers them as a list
   * (`targets`, most referenced first) instead of adding anything. `file` is the file a "rest" ghost is the
   * rest of.
   */
  ghostFold?: { kind: "rest" | "more"; targets: GhostTarget[]; file?: string };
  /** Ghosts: what leaves or enters the view there (`calls ×9`). */
  detail?: string;
  /** Ghosts: the same with every kind named, for the tooltip. */
  hint?: string;
  /** What the explainer's change did to it (diff.ts `changeStatus`): a "New" or "Changed" pill. */
  change?: ChangeStatus;
  /** What the box is in the architecture (`Node.role`): it picks the shape (a cylinder for a database). */
  role?: NodeRole;
  /** The view that shows what is inside the box (`Node.opens`): the box offers to zoom into it. */
  opens?: string;
  /** The box opens a map, whose boxes it can also show inside itself, on this map. */
  expandable?: boolean;
  /** Its summary as drawn under the label, line by line (`GraphView.boxText`); the last may end in "…". */
  lines?: string[];
  /** An idea linked to no code (`Node.sketch`): drawn dashed, with a "sketch" badge. */
  sketch?: boolean;
  /** A table (`GraphView.boxText: "members"`): its children are rows, stacked under its header. */
  rows?: boolean;
  /** A row of a table: a field, drawn as one line of text with the type its code names. */
  row?: boolean;
  /** A row: the type its declaration line names (`number`). */
  memberType?: string;
  /** Position relative to the container (or to the canvas for top-level nodes). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Frame offset from the stable container origin; negative children expand its top/left. */
  frame?: Point;
  children: LayoutNode[];
  /** Edges held by this container (both ends inside it), relative to its top-left corner. */
  edges: LayoutEdge[];
}

export interface LayoutEdge {
  id: string;
  /** A stub (dashed, to a ghost) rather than a derived or stored edge. */
  stub: boolean;
  /** How much to trust the edge: `precise` / `heuristic` / `mixed` (derived), `llm` / `user` / `static` (stored), `stub`. */
  resolution: string;
  /** Edge kind (`calls`, `emits`, ...), for styling. */
  kind: string;
  /** Text for tooltips and screen readers (`calls ×3`, the stored label); stubs draw no label of their own. */
  title: string;
  /** The boxes the edge joins (as drawn: a ghost's render id for a stub). */
  from: string;
  to: string;
  /**
   * The label is a count made up by the viewer (`calls ×3`), not words someone wrote: reader views show it
   * only on hover or when the edge or one of its ends is selected.
   */
  counted: boolean;
  /** Route (start, bends, end) relative to the container that holds the edge, or the canvas. */
  points: Point[];
  label?: { text: string; x: number; y: number; width: number; height: number };
  /** What the edge passes through without a box (`Edge.via`), by name: the tooltip says so. */
  via?: string[];
  /**
   * One of two arrows between the same two boxes, one each way: both are drawn on one route (`points`, read
   * from each one's own tail), and this is the half of it that ends at this arrow's head. A click there (its
   * hit path, its anchor) picks this arrow, and its label sits on it.
   */
  own?: Point[];
  /**
   * A point of the route that no box drawn above the edge covers: where a click on the edge lands
   * (the edge's group is built around it, so automated clicks at its centre hit the route).
   */
  anchor: Point;
}

export type { Direction } from "./layered.js";

export interface GraphLayout {
  width: number;
  height: number;
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  /** True when the layered layout failed and the grid fallback was used. */
  fallback: boolean;
  direction: Direction;
  /** The badge every box of the map had ("Go"): drawn on none of them, said once by the key line (V2-14). */
  sharedBadge?: string;
}

// ─── Sizes ──────────────────────────────────────────────────────────────────────────────────────

/** Padding of an edge's invisible `bounds` rect (see GraphView), which anchors are chosen for. */
export const EDGE_BOUNDS_PAD = 14;

const PAD_X = 14;
const LEAF_HEIGHT = 48;
const GHOST_HEIGHT = 40;
const HEADER_HEIGHT = 34;
const CONTAINER_PAD = 14;
const LABEL_HEIGHT = 18;
const ROUTE_BOX_GAP = 8;
/** A row of a table (`GraphView.boxText: "members"`): its height, its fonts, and the room under the last row. */
export const ROW_HEIGHT = 24;
const ROW_NAME_FONT = 13;
const ROW_TYPE_FONT = 12.5;
const TABLE_FOOT = 6;
/** The gap between a row's name and its type. */
const ROW_GAP = 18;

// Font sizes of the diagram's text in its own units (styles.css draws with the same numbers). A diagram is
// fitted into its pane, so this is what decides how small the text ends up: kept generous, and the boxes
// hardly grow with it (a short label sits in a box of minimum width anyway).
const NODE_LABEL_FONT = 14;
const BADGE_FONT = 12;
const GHOST_LABEL_FONT = 13.5;
const GHOST_DETAIL_FONT = 12.5;
const EDGE_LABEL_FONT = 13;
/** A box's summary (`GraphView.boxText`): its font, line height, and the lines it may take. */
export const SUMMARY_FONT = 12.5;
export const SUMMARY_LINE = 16;
const SUMMARY_LINES = 3;
/** A box that shows its summary is at least this wide, so a sentence wraps on a few lines, not a dozen. */
const SUMMARY_BOX_WIDTH = 300;

/**
 * `text` wrapped at word boundaries into lines no wider than `width`, at most `max` of them; the last line of a
 * longer text is cut and ends in "…". A word longer than a line is cut too.
 */
function wrapText(text: string, width: number, max = SUMMARY_LINES): string[] {
  const fits = (line: string) => textWidth(line, SUMMARY_FONT) <= width;
  const cut = (line: string) => {
    let out = line;
    while (out.length > 1 && !fits(`${out}…`)) out = out.slice(0, -1);
    return `${out.trimEnd()}…`;
  };
  const lines: string[] = [];
  let line = "";
  const words = text.trim().split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    const next = line === "" ? word : `${line} ${word}`;
    if (fits(next)) {
      line = next;
      continue;
    }
    if (line === "") {
      lines.push(cut(word));
    } else {
      lines.push(line);
      line = word;
    }
    if (lines.length === max) {
      lines[max - 1] = cut(`${lines[max - 1]!.replace(/…$/, "")} ${words.slice(i).join(" ")}`);
      return lines;
    }
  }
  if (line !== "") lines.push(fits(line) ? line : cut(line));
  if (lines.length > max) lines.splice(max - 1, lines.length, cut(lines.slice(max - 1).join(" ")));
  return lines;
}

/** Width of the kind badge pill. */
export function badgeWidth(text: string): number {
  return Math.ceil(textWidth(text, BADGE_FONT, 600)) + 12;
}

/** Width of a node label as drawn (containers place their badge after it). */
export function labelWidth(label: string): number {
  return Math.ceil(textWidth(label, NODE_LABEL_FONT, 600));
}

/**
 * The badge of a box: its technology or its role on an architecture map ("PostgreSQL", "database"), else
 * the kind of code it is.
 */
function nodeBadge(node: GraphNode): string {
  if (node.sketch) return "sketch";
  if (node.role !== undefined) return node.tech ?? ROLE_WORDS[node.role];
  return node.symbolKind ?? node.kind;
}

/** The plain name of each role, for the badge of a box without a `tech`. */
export const ROLE_WORDS: Record<NodeRole, string> = {
  person: "person",
  system: "system",
  service: "service",
  component: "component",
  database: "database",
  cache: "cache",
  queue: "queue",
  storage: "storage",
  external: "external system",
};

/** Roles drawn as a cylinder: they keep data, and need room for its lid. */
export const CYLINDER_ROLES: ReadonlySet<NodeRole> = new Set(["database", "cache", "storage"]);
/** The height of a cylinder's lid (the ellipse on top). */
export const CYLINDER_LID = 9;
/** Room for the zoom button of a box that opens a view. */
export const ZOOM_SIZE = 22;
/** Room for the icon left of a box's label (components/icons.tsx: 16 units and a gap). */
export const ICON_ROOM = 23;

/** The words of the change pill. */
export function changeText(change: ChangeStatus): string {
  return change === "new" ? "New" : "Changed";
}

/** The gap between the kind badge and the change pill. */
export const PILL_GAP = 6;

/** Width of the change pill (with the gap before it), 0 without one. */
function changeWidth(change: ChangeStatus | undefined): number {
  return change ? badgeWidth(changeText(change)) + PILL_GAP : 0;
}

function leafWidth(
  label: string,
  badge: string,
  change?: ChangeStatus,
  extra: { role?: NodeRole; opens?: string; expandable?: boolean } = {},
): number {
  const content = Math.max(
    textWidth(label, NODE_LABEL_FONT, 600),
    badgeWidth(badge) + changeWidth(change),
  );
  const icon = ICON_ROOM;
  const zoom =
    (extra.opens !== undefined ? ZOOM_SIZE + 6 : 0) + (extra.expandable ? ZOOM_SIZE + 4 : 0);
  // an architecture box is a little wider: it is read on its own, from a distance
  const min = extra.role !== undefined ? 150 : 104;
  return Math.max(min, Math.ceil(content) + 2 * PAD_X + icon + zoom);
}

/** The height of a box that is not a container. */
function leafHeight(role: NodeRole | undefined): number {
  if (role === undefined) return LEAF_HEIGHT;
  return LEAF_HEIGHT + 8 + (CYLINDER_ROLES.has(role) ? CYLINDER_LID : 0);
}

function containerMinWidth(label: string, badge: string, change?: ChangeStatus): number {
  // label, badge, the change pill and the collapse button in one header row
  return (
    Math.ceil(
      textWidth(label, NODE_LABEL_FONT, 600) + badgeWidth(badge) + changeWidth(change) + 10 + 24,
    ) +
    2 * PAD_X +
    ICON_ROOM
  );
}

/** How wide a table must be for this row: its name, a gap and its type, inside the padding. */
function rowWidth(node: ModelNode): number {
  const type = node.memberType ? ROW_GAP + textWidth(node.memberType, ROW_TYPE_FONT) : 0;
  return Math.ceil(textWidth(node.label, ROW_NAME_FONT, 500) + type) + 2 * PAD_X;
}

function ghostWidth(label: string, detail: string): number {
  return Math.max(
    92,
    Math.ceil(
      Math.max(
        textWidth(label, GHOST_LABEL_FONT, 600) + 16,
        textWidth(detail, GHOST_DETAIL_FONT, 500),
      ),
    ) +
      2 * PAD_X,
  );
}

function edgeLabelText(edge: DerivedEdge): string {
  const text =
    (edge.label ? edge.label : `${edge.kind} ×${edge.count}`) +
    (edge.resolution === "mixed" ? " (partly matched by name)" : "");
  // "A reaches C through B": one arrow, which names what it passes through
  const via = edge.via?.map((item) => item.label) ?? [];
  if (via.length === 0) return text;
  return edge.label ? `${text} (via ${via.join(", ")})` : `via ${via.join(", ")}`;
}

function stubLabelText(stub: Stub): string {
  return `${stub.kinds.join(" & ")} ×${stub.count}`;
}

/**
 * The label of one of a two-way pair, which shares its line with its twin: led by an arrow that points the way
 * this one goes ("↓ viewer page", "↑ HTTP /api"), so the two labels on one line cannot be read the wrong way.
 */
function wayLabel(text: string, points: readonly Point[]): string {
  const [a, b] = [points[0], points[points.length - 1]];
  if (!a || !b) return text;
  const way =
    Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? (b.x > a.x ? "→" : "←") : b.y > a.y ? "↓" : "↑";
  return `${way} ${text}`;
}

function labelBox(text: string): { text: string; width: number; height: number } {
  return {
    text,
    // measured bold: an authored label is drawn at 650 and a selected one at 700, and the box behind
    // it must hide the line under every letter (people N7: "races fetch with a timer" on its own line)
    width: Math.ceil(textWidth(text, EDGE_LABEL_FONT, 700)) + 10,
    height: LABEL_HEIGHT,
  };
}

// ─── Model shared by the layered layout and the fallback ───────────────────────────────────────────────────────

interface ModelNode {
  label: string;
  badge: string;
  badgeShared?: boolean;
  kindClass: string;
  ghostTarget?: string;
  ghostFold?: LayoutNode["ghostFold"];
  detail?: string;
  hint?: string;
  change?: ChangeStatus;
  role?: NodeRole;
  /** Its summary, to show under the label (`GraphView.boxText`), and that summary as wrapped by `leafSize`. */
  summary?: string;
  lines?: string[];
  sketch?: boolean;
  opens?: string;
  expandable?: boolean;
  rows?: boolean;
  /** A row's place in its table (`GraphNode.row`). */
  row?: number;
  memberType?: string;
}

interface Model {
  /** See `GraphLayout.sharedBadge`. */
  sharedBadge?: string;
  roots: string[];
  children: Map<string, string[]>;
  /** Render parent (container) of every non-top-level node. */
  parent: Map<string, string>;
  nodes: Map<string, ModelNode>;
  edges: {
    id: string;
    from: string;
    to: string;
    label: string;
    counted: boolean;
    stub: boolean;
    resolution: string;
    kind: string;
    via?: string[];
  }[];
}

function buildModel(graph: DerivedGraph, changes: ChangeMarks | undefined): Model {
  const nodes: Model["nodes"] = new Map();
  const children = new Map<string, string[]>();
  const parent = new Map<string, string>();
  const roots: string[] = [];
  const known = new Set(graph.nodes.map((n) => n.id));
  for (const node of graph.nodes) {
    const change = changes?.get(node.id);
    nodes.set(node.id, {
      label: node.label,
      badge: nodeBadge(node),
      kindClass: node.symbolKind ?? node.kind,
      ...(change ? { change } : {}),
      ...(node.role !== undefined ? { role: node.role } : {}),
      ...(node.opens !== undefined ? { opens: node.opens } : {}),
      ...(node.expandable ? { expandable: true } : {}),
      ...(node.summary && !node.container ? { summary: node.summary } : {}),
      ...(node.sketch ? { sketch: true } : {}),
      ...(node.rows ? { rows: true } : {}),
      ...(node.row !== undefined ? { row: node.row } : {}),
      ...(node.memberType !== undefined ? { memberType: node.memberType } : {}),
    });
  }
  // a technology or role every box of an architecture map shares ("Go" x 7) tells no box apart: it is drawn
  // on none (at least 4 boxes); a box of code keeps its kind
  const leaves = graph.nodes.filter((node) => !node.container && node.row === undefined);
  const shared = nodes.get(leaves[0]?.id ?? "")?.badge;
  let sharedBadge: string | undefined;
  if (
    shared &&
    leaves.length >= 4 &&
    leaves.every((node) => node.role !== undefined && nodes.get(node.id)!.badge === shared)
  ) {
    sharedBadge = shared;
    for (const node of leaves) nodes.get(node.id)!.badgeShared = true;
  }
  for (const node of graph.nodes) {
    if (node.parent !== undefined && known.has(node.parent)) {
      const list = children.get(node.parent);
      if (list) list.push(node.id);
      else children.set(node.parent, [node.id]);
      parent.set(node.id, node.parent);
    } else roots.push(node.id);
  }
  const edges: Model["edges"] = [];
  const seen = new Set<string>();
  // What each ghost stands for. Core says (`graph.ghosts`); a graph built without them (by hand) is read
  // off its stubs instead.
  const ghosts = new Map<string, Ghost>((graph.ghosts ?? []).map((ghost) => [ghost.key, ghost]));
  const ghostOf = (stub: Stub): Ghost => {
    const known = ghosts.get(stub.ghost);
    if (known) return known;
    const own = graph.stubs.filter((s) => s.ghost === stub.ghost);
    const directions = new Set(own.map((s) => s.direction));
    const made: Ghost = {
      id: ghostId(stub.ghost),
      key: stub.ghost,
      kind: "target",
      label: stub.ghostLabel,
      target: stub.ghost,
      kinds: [...new Set(own.flatMap((s) => s.kinds))].sort(),
      count: own.reduce((n, s) => n + s.count, 0),
      direction: directions.size === 2 ? "both" : directions.has("in") ? "in" : "out",
      targets: [],
    };
    ghosts.set(stub.ghost, made);
    return made;
  };
  for (const edge of drawnEdges(graph.edges.filter((e) => known.has(e.from) && known.has(e.to)))) {
    if (seen.has(edge.id)) continue;
    seen.add(edge.id);
    edges.push({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      label: edgeLabelText(edge),
      counted: !edge.label && !edge.via?.length,
      ...(edge.via?.length ? { via: edge.via.map((item) => item.label) } : {}),
      stub: false,
      resolution: edge.resolution,
      kind: edge.kind,
    });
  }
  // The boxes each ghost links to: its count is a total over them when there are several (U12).
  const insides = new Map<string, Set<string>>();
  for (const stub of graph.stubs)
    if (known.has(stub.inside))
      insides.set(stub.ghost, (insides.get(stub.ghost) ?? new Set()).add(stub.inside));
  for (const stub of graph.stubs) {
    if (!known.has(stub.inside) || seen.has(stub.id)) continue;
    seen.add(stub.id);
    const box = ghostId(stub.ghost);
    if (!nodes.has(box)) {
      const ghost = ghostOf(stub);
      const kinds = [...ghost.kinds].sort();
      nodes.set(box, {
        label: ghost.label,
        badge: "",
        kindClass: "ghost",
        ...(ghost.kind === "target"
          ? { ghostTarget: ghost.key }
          : {
              ghostFold: {
                kind: ghost.kind,
                targets: ghost.targets,
                ...(ghost.kind === "rest" ? { file: parseFile(ghost.key) } : {}),
              },
            }),
        // Always a verb (two kinds at most; more are left to the tooltip and the details panel).
        detail: `${kinds.slice(0, 2).join(" & ")}${kinds.length > 2 ? " …" : ""} ×${ghost.count}${(insides.get(stub.ghost)?.size ?? 0) > 1 ? " in all" : ""}`,
        hint: `${kinds.join(", ")} ×${ghost.count}`,
      });
      roots.push(box);
    }
    edges.push({
      id: stub.id,
      from: stub.direction === "out" ? stub.inside : box,
      to: stub.direction === "out" ? box : stub.inside,
      label: stubLabelText(stub),
      counted: true,
      stub: true,
      resolution: "stub",
      kind: stub.kinds[0] ?? "calls",
    });
  }
  return { roots, children, parent, nodes, edges, ...(sharedBadge ? { sharedBadge } : {}) };
}

/** `rest:file:<path>` -> `file:<path>`. */
function parseFile(key: string): string {
  return `file:${key.slice("rest:file:".length)}`;
}

/** A ghost box, whether it stands for one element or for several. */
const isGhost = (node: ModelNode): boolean =>
  node.ghostTarget !== undefined || node.ghostFold !== undefined;

function leafSize(model: Model, id: string): { width: number; height: number } {
  const node = model.nodes.get(id)!;
  if (isGhost(node)) {
    return { width: ghostWidth(node.label, node.detail ?? ""), height: GHOST_HEIGHT };
  }
  const width = leafWidth(node.label, node.badgeShared ? "" : node.badge, node.change, node);
  if (node.summary === undefined) return { width, height: leafHeight(node.role) };
  const wide = Math.max(width, SUMMARY_BOX_WIDTH);
  // the text starts after the icon, like the label
  node.lines = wrapText(node.summary, wide - 2 * PAD_X - ICON_ROOM);
  return { width: wide, height: leafHeight(node.role) + node.lines.length * SUMMARY_LINE + 6 };
}

function makeNode(
  model: Model,
  id: string,
  box: { x: number; y: number; width: number; height: number },
  children: LayoutNode[],
  edges: LayoutEdge[] = [],
): LayoutNode {
  const node = model.nodes.get(id)!;
  const out: LayoutNode = {
    id,
    label: node.label,
    badge: node.badge,
    ...(node.badgeShared ? { badgeShared: true } : {}),
    kindClass: node.kindClass,
    ghost: isGhost(node),
    ...box,
    children,
    edges,
  };
  if (node.ghostTarget !== undefined) out.ghostTarget = node.ghostTarget;
  if (node.ghostFold !== undefined) out.ghostFold = node.ghostFold;
  if (node.detail !== undefined) out.detail = node.detail;
  if (node.hint !== undefined) out.hint = node.hint;
  if (node.change !== undefined) out.change = node.change;
  if (node.role !== undefined) out.role = node.role;
  if (node.opens !== undefined) out.opens = node.opens;
  if (node.expandable) out.expandable = true;
  if (node.lines !== undefined && children.length === 0) out.lines = node.lines;
  if (node.sketch) out.sketch = true;
  if (node.rows && children.length > 0) out.rows = true;
  if (node.row !== undefined) out.row = true;
  if (node.memberType !== undefined) out.memberType = node.memberType;
  return out;
}

// ─── Layered layout, one container at a time ────────────────────────────────────────────────────

/** Where a layout starts: the reading direction. */
export interface LayoutOptions {
  /** Default `RIGHT`. */
  direction?: Direction;
  pins?: GraphView["layout"];
}

/** The physical frame; children and routes stay relative to the node's logical origin. */
export function nodeBox(node: LayoutNode, origin: Point = { x: 0, y: 0 }): Box {
  return {
    x: origin.x + node.x + (node.frame?.x ?? 0),
    y: origin.y + node.y + (node.frame?.y ?? 0),
    width: node.width,
    height: node.height,
  };
}

/** Bounds of the visible frames, routes and labels, including pins above/left of the origin. */
export function graphBounds(layout: GraphLayout): Box {
  const boxes = [...absoluteBoxes(layout.nodes).values()];
  const edges = (list: LayoutEdge[], origin: Point) => {
    for (const edge of list) {
      const box = routeBox(edge.points, edge.label);
      boxes.push({ ...box, x: box.x + origin.x, y: box.y + origin.y });
    }
  };
  const visit = (nodes: LayoutNode[], origin: Point) => {
    for (const node of nodes) {
      const at = { x: origin.x + node.x, y: origin.y + node.y };
      edges(node.edges, at);
      visit(node.children, at);
    }
  };
  edges(layout.edges, { x: 0, y: 0 });
  visit(layout.nodes, { x: 0, y: 0 });
  const box = unionBox(boxes) ?? { x: 0, y: 0, width: layout.width, height: layout.height };
  return { x: box.x - 12, y: box.y - 12, width: box.width + 24, height: box.height + 24 };
}

function enclose(node: LayoutNode): void {
  if (!node.children.length) return;
  const bounds = unionBox(node.children.map((child) => nodeBox(child)))!;
  const x = Math.min(0, bounds.x - CONTAINER_PAD);
  const y = Math.min(0, bounds.y - HEADER_HEIGHT - 8);
  node.frame = { x, y };
  node.width = Math.max(node.width, bounds.x + bounds.width + CONTAINER_PAD) - x;
  node.height = Math.max(node.height, bounds.y + bounds.height + CONTAINER_PAD) - y;
}

/** Spacing. Tight on purpose: a layout is fitted into its pane, so every pixel of air between boxes shrinks the text. */
const SPACING = { nodeGap: 24, layerGap: 48, edgeGap: 10 };
/** DOWN: the gap between the lanes a table's row arrows run in beside it. */
const LANE = 8;
const CANVAS_PAD = 24;
const CONTAINER_PADDING = {
  top: HEADER_HEIGHT + 8,
  right: CONTAINER_PAD,
  bottom: CONTAINER_PAD,
  left: CONTAINER_PAD,
};

/** The container that holds an edge: the lowest one around both ends, "" for the canvas. */
function holderOf(model: Model, from: string, to: string): string {
  const above = (id: string): string[] => {
    const out: string[] = [];
    for (let cur = model.parent.get(id); cur !== undefined; cur = model.parent.get(cur))
      out.push(cur);
    return out;
  };
  const around = new Set(above(to));
  return above(from).find((id) => around.has(id)) ?? "";
}

/** The box at the level of `holder` that `id` is drawn in: `id` itself or the ancestor right below `holder`. */
function liftTo(model: Model, id: string, holder: string): string {
  let cur = id;
  for (
    let parent = model.parent.get(cur);
    (parent ?? "") !== holder;
    parent = model.parent.get(cur)
  ) {
    if (parent === undefined) return cur;
    cur = parent;
  }
  return cur;
}

type EdgeMeta = Model["edges"][number];

interface Level {
  /** The container's id, "" for the canvas. */
  id: string;
  /** The box of the level: a container's own node, or undefined for the canvas. */
  node: LayoutNode | undefined;
  routes: LayeredResult["routes"];
}

/** Detour orthogonal segments around other boxes after their pinned positions replace dagre's. */
function aroundBoxes(points: Point[], boxes: Box[]): Point[] {
  let route = points;
  for (let pass = 0; pass < 32; pass++) {
    let changed = false;
    for (let i = 1; i < route.length; i++) {
      const a = route[i - 1]!,
        b = route[i]!;
      const horizontal = a.y === b.y;
      const obstacle = boxes.find((box) =>
        horizontal
          ? a.y > box.y &&
            a.y < box.y + box.height &&
            Math.max(a.x, b.x) > box.x &&
            Math.min(a.x, b.x) < box.x + box.width
          : a.x === b.x &&
            a.x > box.x &&
            a.x < box.x + box.width &&
            Math.max(a.y, b.y) > box.y &&
            Math.min(a.y, b.y) < box.y + box.height,
      );
      if (!obstacle || inside(obstacle, a, 0) || inside(obstacle, b, 0)) continue;
      const cross = horizontal ? "y" : "x",
        along = horizontal ? "x" : "y";
      const size = horizontal ? "height" : "width",
        length = horizontal ? "width" : "height";
      const low = obstacle[cross] - 10,
        high = obstacle[cross] + obstacle[size] + 10;
      const offset = Math.abs(a[cross] - low) <= Math.abs(a[cross] - high) ? low : high;
      const forward = a[along] < b[along];
      const entry = forward ? obstacle[along] - 10 : obstacle[along] + obstacle[length] + 10;
      const exit = forward ? obstacle[along] + obstacle[length] + 10 : obstacle[along] - 10;
      route = [
        ...route.slice(0, i),
        { ...a, [along]: entry },
        { ...a, [along]: entry, [cross]: offset },
        { ...b, [along]: exit, [cross]: offset },
        { ...b, [along]: exit },
        ...route.slice(i),
      ];
      changed = true;
      break;
    }
    if (!changed) break;
  }
  return route;
}

/** True when two orthogonal routes cross or share a stretch away from their ends. */
function routesMeet(a: readonly Point[], b: readonly Point[]): boolean {
  const inside = (value: number, p: number, q: number) =>
    value > Math.min(p, q) && value < Math.max(p, q);
  const shared = (p: number, q: number, r: number, s: number) =>
    Math.min(Math.max(p, q), Math.max(r, s)) - Math.max(Math.min(p, q), Math.min(r, s)) > 1;
  for (let i = 1; i < a.length; i++) {
    const p = a[i - 1]!,
      q = a[i]!;
    for (let j = 1; j < b.length; j++) {
      const r = b[j - 1]!,
        s = b[j]!;
      const pVertical = p.x === q.x;
      const rVertical = r.x === s.x;
      if (pVertical !== rVertical) {
        const [v, w, h, k] = pVertical ? [p, q, r, s] : [r, s, p, q];
        if (inside(v!.x, h!.x, k!.x) && inside(h!.y, v!.y, w!.y)) return true;
      } else if (
        pVertical
          ? p.x === r.x && shared(p.y, q.y, r.y, s.y)
          : p.y === r.y && shared(p.x, q.x, r.x, s.x)
      ) {
        return true;
      }
    }
  }
  return false;
}

function routeCrossings(routes: readonly Point[][]): Set<string> {
  const pairs = new Set<string>();
  for (let i = 0; i < routes.length; i++) {
    const a = routes[i]!;
    for (let j = i + 1; j < routes.length; j++) {
      const b = routes[j]!;
      for (let ai = 1; ai < a.length; ai++) {
        const p = a[ai - 1]!,
          q = a[ai]!;
        for (let bi = 1; bi < b.length; bi++) {
          const r = b[bi - 1]!,
            s = b[bi]!;
          const dx = q.x - p.x,
            dy = q.y - p.y,
            ex = s.x - r.x,
            ey = s.y - r.y;
          const det = dx * ey - dy * ex;
          if (Math.abs(det) < 0.001) continue;
          const x = r.x - p.x,
            y = r.y - p.y;
          const alongA = (x * ey - y * ex) / det,
            alongB = (x * dy - y * dx) / det;
          if (alongA > 0.001 && alongA < 0.999 && alongB > 0.001 && alongB < 0.999)
            pairs.add(`${i}\0${j}`);
        }
      }
    }
  }
  return pairs;
}

function hasNoNewHits<T>(before: ReadonlySet<T>, after: ReadonlySet<T>): boolean {
  return [...after].every((hit) => before.has(hit));
}

function routeLength(points: readonly Point[]): number {
  return points
    .slice(1)
    .reduce((n, p, i) => n + Math.abs(p.x - points[i]!.x) + Math.abs(p.y - points[i]!.y), 0);
}

function crossesBox(points: readonly Point[], box: Box, gap: number): boolean {
  const left = box.x - gap,
    right = box.x + box.width + gap,
    top = box.y - gap,
    bottom = box.y + box.height + gap;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!,
      b = points[i]!;
    if (
      a.x === b.x &&
      a.x > left &&
      a.x < right &&
      Math.max(a.y, b.y) > top &&
      Math.min(a.y, b.y) < bottom
    )
      return true;
    if (
      a.y === b.y &&
      a.y > top &&
      a.y < bottom &&
      Math.max(a.x, b.x) > left &&
      Math.min(a.x, b.x) < right
    )
      return true;
  }
  return false;
}

/** Room kept between a label and a bend of its line, px: a label on a corner reads as two lines. */
const LABEL_BEND_GAP = 4;

/** A turn shorter than this, px, is a jog between two tracks: a label may sit across it. */
const JOG = 4;

/** One straight run of a right-angled route (see `straightRuns`). */
interface Run {
  along: "x" | "y";
  lo: number;
  hi: number;
  /** The segments along the run's axis (between them, jogs): the line's position under a point of the run. */
  pieces: [Point, Point][];
  /** Where the line goes past each end of the run (undefined: it ends there, at a box). */
  beforeLo?: Point;
  beforeHi?: Point;
}

/** The straight runs of a right-angled route: each follows one axis, across jogs shorter than `JOG`. */
function straightRuns(points: readonly Point[]): Run[] {
  const runs: { run: Run; first: number; last: number }[] = [];
  let current: (typeof runs)[number] | undefined;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!,
      b = points[i]!;
    const flat = Math.abs(a.y - b.y) < 0.5;
    const upright = Math.abs(a.x - b.x) < 0.5;
    if (!flat && !upright) {
      current = undefined;
      continue;
    }
    const along = flat ? "x" : "y";
    if (current && current.run.along !== along) {
      // a turn: a short one is a jog inside the run, a long one ends it
      if (Math.abs(b[along] - a[along]) < JOG) continue;
      current = undefined;
    }
    if (!current) {
      current = { run: { along, lo: Infinity, hi: -Infinity, pieces: [] }, first: i - 1, last: i };
      runs.push(current);
    }
    current.run.lo = Math.min(current.run.lo, a[along], b[along]);
    current.run.hi = Math.max(current.run.hi, a[along], b[along]);
    current.run.pieces.push([a, b]);
    current.last = i;
  }
  return runs.map(({ run, first, last }) => {
    const start = points[first]!,
      end = points[last]!;
    const before = points[first - 1],
      after = points[last + 1];
    const [atLo, atHi] = start[run.along] <= end[run.along] ? [before, after] : [after, before];
    return {
      ...run,
      ...(atLo ? { beforeLo: atLo } : {}),
      ...(atHi ? { beforeHi: atHi } : {}),
    };
  });
}

/** The line under `at` along a run: the piece that spans it (the first one at a jog). */
function lineAt(run: Run, at: number): number {
  const across = run.along === "x" ? "y" : "x";
  const piece =
    run.pieces.find(
      ([a, b]) =>
        at >= Math.min(a[run.along], b[run.along]) && at <= Math.max(a[run.along], b[run.along]),
    ) ?? run.pieces[0]!;
  return piece[0][across];
}

/**
 * Where a label of `size` may sit along its route: a stretch its centre slides along, on a straight run long
 * enough to hold it clear of the bends (`beside` false), or beside a level run, touching it, on a side the
 * line does not turn to (`beside` true: a bend at an end of the run that turns to that side bounds the label
 * there; one that turns away does not, and the label may reach past it by up to half its width).
 */
interface LabelSpan {
  along: "x" | "y";
  lo: number;
  hi: number;
  beside: boolean;
  /** The centre's other coordinate, at `at` along the span. */
  across(at: number): number;
}

function labelSpans(
  points: readonly Point[],
  size: { width: number; height: number },
): LabelSpan[] {
  const spans: LabelSpan[] = [];
  const runs = straightRuns(points);
  // On a level run (an upright line under a wide label would hide in it, and its neighbours with it).
  for (const run of runs) {
    if (run.along !== "x") continue;
    const half = size.width / 2 + LABEL_BEND_GAP;
    const lo = run.lo + half;
    const hi = run.hi - half;
    if (lo <= hi)
      spans.push({ along: "x", lo, hi, beside: false, across: (at) => lineAt(run, at) });
  }
  // Beside a run: above or below a level one, left or right of an upright one.
  for (const run of runs) {
    const cross = run.along === "x" ? "y" : "x";
    const along = run.along === "x" ? size.width : size.height;
    const away = (run.along === "x" ? size.height : size.width) / 2 + LABEL_BESIDE_GAP;
    const half = along / 2 + LABEL_BEND_GAP;
    // (the line under the label: the run's first piece; a jog moves it by less than `JOG`)
    const line = run.pieces[0]![0][cross];
    for (const side of [-1, 1] as const) {
      const towards = (bend: Point | undefined) =>
        !bend || Math.sign(bend[cross] - line) === side || Math.abs(bend[cross] - line) < 0.5;
      const lo = (towards(run.beforeLo) ? run.lo : run.lo - along / 2) + half;
      const hi = (towards(run.beforeHi) ? run.hi : run.hi + along / 2) - half;
      if (lo > hi) continue;
      spans.push({
        along: run.along,
        lo,
        hi,
        beside: true,
        across: (at) => lineAt(run, clampTo(at, run.lo, run.hi)) + side * away,
      });
    }
  }
  return spans;
}

const spanPoint = (span: LabelSpan, at: number): Point => {
  const along = clampTo(at, span.lo, span.hi);
  return span.along === "x"
    ? { x: along, y: span.across(along) }
    : { x: span.across(along), y: along };
};

/**
 * Where a label of `size` sits on its route (its centre): on a straight run, clear of the bends, as near
 * `hint` (dagre's label position) as it can; when no run is long enough, beside a level run (`labelSpans`);
 * else at `hint`.
 */
export function labelOnRoute(
  points: readonly Point[],
  size: { width: number; height: number },
  hint: Point | undefined,
): Point | undefined {
  const spans = labelSpans(points, size);
  for (const beside of [false, true]) {
    let best: Point | undefined;
    let bestDistance = Infinity;
    for (const span of spans) {
      if (span.beside !== beside) continue;
      const point = spanPoint(span, hint ? hint[span.along] : (span.lo + span.hi) / 2);
      // without a hint, the longest stretch (below a line before above it)
      const distance = hint ? Math.hypot(point.x - hint.x, point.y - hint.y) : span.lo - span.hi;
      if (distance < bestDistance) {
        best = point;
        bestDistance = distance;
      }
    }
    if (best) return best;
  }
  return hint ?? labelCentre(points);
}

/** Room between a label set beside its line and the line, px. */
const LABEL_BESIDE_GAP = 2;

const clampTo = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

function labelCentre(points: readonly Point[]): Point | undefined {
  let centre: Point | undefined,
    longest = -1;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!,
      b = points[i]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length > longest) {
      longest = length;
      centre = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
  }
  return centre;
}

/**
 * Lays out the graph: every container's inside first (its children as one layered level, with room for its
 * header), then the container as one box of the level above, up to the canvas. Then every edge is routed in
 * the container that holds it: dagre's points between the two boxes of that level its ends are drawn in, and
 * right-angled ends on the boxes it actually joins, which may sit deeper inside them.
 */
/**
 * `turned`: the border crossings (`${container}\0${edge id}`) whose port goes on the other side of the container
 * than the edge's direction suggests (the second pass of `layoutGraph`). `facingAway`, when given, is filled
 * with the crossings whose port ended up on the side away from the edge's other end: such an edge would leave
 * the container, then run back across it to reach that end.
 */
function layeredLayout(
  model: Model,
  direction: Direction,
  pins: GraphView["layout"],
  turned: ReadonlySet<string> = new Set(),
  facingAway?: Set<string>,
): GraphLayout {
  const cross = direction === "RIGHT" ? "y" : "x";
  const ancestors = (id: string, holder: string): string[] => {
    const out: string[] = [];
    for (
      let cur = model.parent.get(id);
      cur !== undefined && cur !== holder;
      cur = model.parent.get(cur)
    )
      out.push(cur);
    return out;
  };
  // Per edge: the container that holds it, and the containers it crosses on the way to each end (innermost
  // first). Per container: the edges that cross its border.
  const held = new Map<string, EdgeMeta[]>();
  const chains = new Map<string, { from: string[]; to: string[] }>();
  const crossing = new Map<string, { edge: EdgeMeta; end: "from" | "to" }[]>();
  // Two arrows between the same two boxes, one each way: the second (its twin) takes the first one's route,
  // read backwards, so a two-way link is one line with a head at each end, not two long routes (V2-04).
  const twinOf = new Map<string, EdgeMeta>();
  {
    const firstOf = new Map<string, EdgeMeta>();
    for (const edge of model.edges) {
      if (edge.stub || edge.from === edge.to) continue;
      const back = firstOf.get(`${edge.to}\0${edge.from}`);
      if (back && ![...twinOf.values()].includes(back) && !twinOf.has(back.id))
        twinOf.set(edge.id, back);
      else if (!firstOf.has(`${edge.from}\0${edge.to}`))
        firstOf.set(`${edge.from}\0${edge.to}`, edge);
    }
  }
  for (const edge of model.edges) {
    if (edge.from === edge.to) continue; // a loop: drawn on its box once the boxes are placed
    if (twinOf.has(edge.id)) continue; // drawn on its twin's route
    const holder = holderOf(model, edge.from, edge.to);
    const list = held.get(holder);
    if (list) list.push(edge);
    else held.set(holder, [edge]);
    const chain = { from: ancestors(edge.from, holder), to: ancestors(edge.to, holder) };
    chains.set(edge.id, chain);
    for (const end of ["from", "to"] as const) {
      for (const container of chain[end]) {
        const crossings = crossing.get(container);
        if (crossings) crossings.push({ edge, end });
        else crossing.set(container, [{ edge, end }]);
      }
    }
  }
  const portId = (edge: EdgeMeta) => `\0port:${edge.id}`;
  const innerId = (edge: EdgeMeta) => `\0inner:${edge.id}`;

  /** Where an edge crosses a container's border: on which side, and where along it (container coordinates). */
  const entries = new Map<string, Map<string, { side: Side; cross: number }>>();
  const levels: Level[] = [];
  // The inner part of an edge that crosses a container's border, from the border to the box inside
  // (`${container}\0${edge id}`, container coordinates): routed per level below, laid by hand in a table.
  const inner = new Map<string, Point[]>();
  // DOWN: room beside a table for the lanes its rows' arrows run down (or up) in, left and right of it.
  const laneRoom = new Map<string, { left: number; right: number }>();

  const level = (
    ids: readonly string[],
    holder: string,
    pad: LayeredOptions["pad"],
  ): { nodes: LayoutNode[]; result: LayeredResult } => {
    const nodes = ids.map(build);
    const room = (id: string) => laneRoom.get(id) ?? { left: 0, right: 0 };
    const boxes = nodes.map((n) => ({
      id: n.id,
      width: n.width + room(n.id).left + room(n.id).right,
      height: n.height,
    }));
    const edges: LayeredEdge[] = (held.get(holder) ?? []).map((edge) => ({
      id: edge.id,
      from: liftTo(model, edge.from, holder),
      to: liftTo(model, edge.to, holder),
      // Stubs carry no label of their own: their ghost box tells what leaves or enters there.
      ...(edge.stub ? {} : { label: labelBox(edge.label) }),
    }));
    const options = { direction, ...SPACING, pad };
    let result = layered(boxes, edges, options);
    // Edges that cross the border: a port in a layer of its own before (or after) everything, so the part
    // inside is routed around the boxes, from the border to the box it joins.
    const crossings = holder === "" ? [] : (crossing.get(holder) ?? []);
    if (crossings.length > 0) {
      const layers = layerIndex(result, direction);
      const last = Math.max(0, ...layers.values());
      const ports: LayeredNode[] = [];
      const inner: LayeredEdge[] = [];
      // An edge into the container enters at its start side, one out of it leaves at its end side; a turned
      // one the other way round (its other end lies on that side).
      const atStart = (edge: EdgeMeta, end: "from" | "to") =>
        (end === "to") !== turned.has(`${holder}\0${edge.id}`);
      for (const { edge, end } of crossings) {
        const box = liftTo(model, edge[end], holder);
        const layer = layers.get(box) ?? 0;
        ports.push({ id: portId(edge), width: 2, height: 2 });
        inner.push(
          atStart(edge, end)
            ? { id: innerId(edge), from: portId(edge), to: box, minlen: layer + 1 }
            : { id: innerId(edge), from: box, to: portId(edge), minlen: last - layer + 1 },
        );
      }
      result = layered([...boxes, ...ports], [...edges, ...inner], options);
      const own = new Map<string, { side: Side; cross: number }>();
      for (const { edge, end } of crossings) {
        const port = result.boxes.get(portId(edge))!;
        // (dagre routed a turned edge against the arrow: its track is read backwards)
        if (atStart(edge, end) !== (end === "to")) result.routes.get(innerId(edge))?.via.reverse();
        own.set(edge.id, {
          side: atStart(edge, end) ? "start" : "end",
          cross: cross === "y" ? port.y + port.height / 2 : port.x + port.width / 2,
        });
      }
      entries.set(holder, own);
    }
    for (const node of nodes) {
      const box = result.boxes.get(node.id)!;
      const pin = pins?.[node.id];
      node.x = pin?.x ?? box.x + room(node.id).left - (node.frame?.x ?? 0);
      node.y = pin?.y ?? box.y - (node.frame?.y ?? 0);
    }
    // Unpinned siblings keep dagre's order, but yield space when a pin occupies their old position.
    const occupied = nodes.filter((node) => pins?.[node.id]).map((node) => nodeBox(node));
    for (const node of nodes.filter((node) => !pins?.[node.id])) {
      for (let tries = 0; tries < occupied.length; tries++) {
        const box = nodeBox(node);
        const obstacle = occupied.find(
          (other) =>
            box.x < other.x + other.width + 12 &&
            box.x + box.width + 12 > other.x &&
            box.y < other.y + other.height + 12 &&
            box.y + box.height + 12 > other.y,
        );
        if (!obstacle) break;
        if (direction === "RIGHT")
          node.y = obstacle.y + obstacle.height + 12 - (node.frame?.y ?? 0);
        else node.x = obstacle.x + obstacle.width + 12 - (node.frame?.x ?? 0);
      }
      occupied.push(nodeBox(node));
    }
    for (const node of nodes)
      result.boxes.set(node.id, { ...result.boxes.get(node.id)!, ...nodeBox(node) });
    if (nodes.some((node) => pins?.[node.id] || node.frame?.x || node.frame?.y)) {
      // Dagre's tracks and label centres describe the automatic positions, not these boxes.
      for (const route of result.routes.values()) {
        route.via = [];
        route.label = undefined;
      }
      const bounds = unionBox(nodes.map((node) => nodeBox(node)));
      if (bounds) {
        result.width = Math.max(result.width, bounds.x + bounds.width + (pad?.right ?? 0));
        result.height = Math.max(result.height, bounds.y + bounds.height + (pad?.bottom ?? 0));
      }
    }
    return { nodes, result };
  };
  function build(id: string): LayoutNode {
    const kids = model.children.get(id) ?? [];
    if (kids.length === 0) return makeNode(model, id, { x: 0, y: 0, ...leafSize(model, id) }, []);
    const info = model.nodes.get(id)!;
    if (info.rows) return table(id, kids, info);
    const inner = level(kids, id, CONTAINER_PADDING);
    const node = makeNode(
      model,
      id,
      {
        x: 0,
        y: 0,
        width: Math.max(inner.result.width, containerMinWidth(info.label, info.badge, info.change)),
        height: Math.max(inner.result.height, HEADER_HEIGHT + 60),
      },
      inner.nodes,
    );
    enclose(node);
    levels.push({ id, node, routes: inner.result.routes });
    return node;
  }
  /**
   * A table (`GraphView.boxText: "members"`): its rows stacked under the header, as wide as the table, in the
   * order the code declares them. An arrow of a row starts (or ends) on the table's side at the height of that
   * row, so no route runs inside the table.
   */
  function table(id: string, kids: readonly string[], info: ModelNode): LayoutNode {
    const order = [...kids].sort(
      (a, b) => (model.nodes.get(a)!.row ?? 0) - (model.nodes.get(b)!.row ?? 0),
    );
    const width = Math.max(
      containerMinWidth(info.label, info.badge, info.change),
      ...order.map((kid) => rowWidth(model.nodes.get(kid)!)),
    );
    const rows = order.map((kid, i) =>
      makeNode(
        model,
        kid,
        { x: 0, y: HEADER_HEIGHT + i * ROW_HEIGHT, width, height: ROW_HEIGHT },
        [],
      ),
    );
    const height = HEADER_HEIGHT + rows.length * ROW_HEIGHT + TABLE_FOOT;
    const node = makeNode(model, id, { x: 0, y: 0, width, height }, rows);
    // RIGHT: an arrow into the table enters on the left, one out of it leaves on the right (a turned one the
    // other way round), at the height of its row. DOWN: it still leaves its row on the right (enters on the
    // left), in a lane of its own beside the table, and crosses the table's bottom (top) line in that lane.
    const own = new Map<string, { side: Side; cross: number }>();
    const lanes = { left: 0, right: 0 };
    for (const { edge, end } of crossing.get(id) ?? []) {
      const row = rows.find((r) => r.id === liftTo(model, edge[end], id));
      if (!row) continue;
      const atStart = (end === "to") !== turned.has(`${id}\0${edge.id}`);
      const side: Side = atStart ? "start" : "end";
      const y = row.y + ROW_HEIGHT / 2;
      if (direction === "RIGHT") {
        own.set(edge.id, { side, cross: y });
        continue;
      }
      const out = end === "from";
      const lane = out ? width + LANE * ++lanes.right : -LANE * ++lanes.left;
      const border = side === "start" ? 0 : height;
      const lead = [
        { x: out ? width : 0, y },
        { x: lane, y },
        { x: lane, y: border },
      ];
      own.set(edge.id, { side, cross: lane });
      // stored in the arrow's direction: from the row out, or from the border in
      inner.set(`${id}\0${edge.id}`, out ? lead : lead.reverse());
    }
    if (lanes.left || lanes.right)
      laneRoom.set(id, { left: lanes.left * LANE, right: lanes.right * LANE });
    entries.set(id, own);
    return node;
  }
  const pad = { top: CANVAS_PAD, right: CANVAS_PAD, bottom: CANVAS_PAD, left: CANVAS_PAD };
  const top = level(model.roots, "", pad);
  levels.push({ id: "", node: undefined, routes: top.result.routes });

  // Boxes relative to each container (and to the canvas), to route what it holds.
  const parentOf = new Map<string, LayoutNode>();
  const nodeOf = new Map<string, LayoutNode>();
  const index = (list: LayoutNode[], parent: LayoutNode | undefined) => {
    for (const node of list) {
      nodeOf.set(node.id, node);
      if (parent) parentOf.set(node.id, parent);
      index(node.children, node);
    }
  };
  index(top.nodes, undefined);
  const originIn = (id: string, holder: LayoutNode | undefined): Point => {
    const node = nodeOf.get(id)!;
    let x = node.x;
    let y = node.y;
    for (let up = parentOf.get(id); up && up !== holder; up = parentOf.get(up.id)) {
      x += up.x;
      y += up.y;
    }
    return { x, y };
  };
  const boxIn = (id: string, holder: LayoutNode | undefined): Box => {
    const node = nodeOf.get(id)!;
    return nodeBox(node, {
      x: originIn(id, holder).x - node.x,
      y: originIn(id, holder).y - node.y,
    });
  };

  // Route every level: the edges it holds (from border to border where an end lies deeper) and, in a
  // container, the inner part of each edge that crosses its border (from the border to the box inside).
  const outer = new Map<string, { points: Point[]; level: Level }>();
  for (const lvl of levels) {
    const holder = lvl.node;
    interface End {
      box: Box;
      key: string;
      fixed?: { side: Side; cross: number };
    }
    const items: { id: string; from: End; to: End; via: Point[]; store: (p: Point[]) => void }[] =
      [];
    /** One end of a routed edge at this level: `id` drawn here, or the container it lies in. */
    const endOf = (edge: EdgeMeta, end: "from" | "to", id: string): End => {
      const box = boxIn(id, holder);
      const entry = id !== edge[end] ? entries.get(id)?.get(edge.id) : undefined;
      return {
        box,
        key: id,
        ...(entry
          ? { fixed: { side: entry.side, cross: entry.cross + originIn(id, holder)[cross] } }
          : {}),
      };
    };
    for (const edge of held.get(lvl.id) ?? []) {
      items.push({
        id: edge.id,
        from: endOf(edge, "from", liftTo(model, edge.from, lvl.id)),
        to: endOf(edge, "to", liftTo(model, edge.to, lvl.id)),
        via: lvl.routes.get(edge.id)?.via ?? [],
        store: (points) => outer.set(edge.id, { points, level: lvl }),
      });
    }
    for (const { edge, end } of lvl.id === "" ? [] : (crossing.get(lvl.id) ?? [])) {
      const entry = entries.get(lvl.id)!.get(edge.id)!;
      const size = holder!;
      const start = cross === "y" ? (size.frame?.x ?? 0) : (size.frame?.y ?? 0);
      const at = start + (entry.side === "start" ? 0 : cross === "y" ? size.width : size.height);
      const border: End = {
        box:
          cross === "y"
            ? { x: at, y: entry.cross, width: 0, height: 0 }
            : { x: entry.cross, y: at, width: 0, height: 0 },
        key: portId(edge),
        fixed: entry,
      };
      const inside = endOf(edge, end, liftTo(model, edge[end], lvl.id));
      items.push({
        id: innerId(edge),
        from: end === "to" ? border : inside,
        to: end === "to" ? inside : border,
        via: lvl.routes.get(innerId(edge))?.via ?? [],
        store: (points) => inner.set(`${lvl.id}\0${edge.id}`, points),
      });
    }
    // the free ends of a side are spread along it; fixed ones (at a port) stay where the port is
    const boxes = new Map<string, Box>();
    const ports = new Map<string, Port>();
    const centre = (b: Box): Point => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
    // an arrow to or from a table itself (not one of its rows) meets it at its header: it means the type
    const band = (key: string, box: Box): Box =>
      nodeOf.get(key)?.rows ? { ...box, height: HEADER_HEIGHT } : box;
    for (const item of items) {
      boxes.set(item.from.key, band(item.from.key, item.from.box));
      boxes.set(item.to.key, band(item.to.key, item.to.box));
      const next = item.via[0] ?? centre(item.to.box);
      const previous = item.via[item.via.length - 1] ?? centre(item.from.box);
      if (!item.from.fixed)
        ports.set(`${item.id}\0from`, {
          box: item.from.key,
          side: sideToward(item.from.box, next, direction),
          toward: next[cross],
        });
      if (!item.to.fixed)
        ports.set(`${item.id}\0to`, {
          box: item.to.key,
          side: sideToward(item.to.box, previous, direction),
          toward: previous[cross],
        });
    }
    const siblings = holder?.children ?? top.nodes;
    const pinned = siblings.some((node) => pins?.[node.id]);
    // Selection can lay this level out again; keep the added route search within the viewer's small-map limit.
    const simplifyRoutes = !pinned && siblings.length + items.length <= BOTH_DIRECTIONS_LIMIT;
    const obstacles = siblings.map((node) => [node.id, nodeBox(node)] as const);
    const boxHits = (routes: readonly Point[][]) => {
      const hits = new Set<string>();
      routes.forEach((route, i) => {
        for (const [id, box] of obstacles)
          if (id !== items[i]!.from.key && id !== items[i]!.to.key && crossesBox(route, box, 0))
            hits.add(`${i}\0${id}`);
      });
      return hits;
    };
    const routeWith = (wide: boolean) => {
      const spread = spreadPorts(ports, boxes, direction, wide);
      const routes = items.map((item) =>
        orthogonalRoute(
          item.from.box,
          item.to.box,
          item.via,
          {
            from: item.from.fixed?.cross ?? spread.get(`${item.id}\0from`)!,
            to: item.to.fixed?.cross ?? spread.get(`${item.id}\0to`)!,
          },
          direction,
          {
            ...(item.from.fixed ? { from: item.from.fixed.side } : {}),
            ...(item.to.fixed ? { to: item.to.fixed.side } : {}),
          },
        ),
      );
      separateTracks(routes, direction);
      return routes;
    };
    const original = routeWith(false);
    const widened = simplifyRoutes ? routeWith(true) : undefined;
    const routed =
      widened &&
      hasNoNewHits(routeCrossings(original), routeCrossings(widened)) &&
      hasNoNewHits(boxHits(original), boxHits(widened))
        ? widened
        : original;
    if (simplifyRoutes) {
      const main = direction === "RIGHT" ? "x" : "y";
      for (let n = 0; n < items.length; n++) {
        const item = items[n]!;
        const old = routed[n]!;
        if (item.from.fixed || item.to.fixed || old.length <= 4) continue;
        const start = old[0]!,
          end = old.at(-1)!;
        const fromEnd =
          item.from.box[main] + (main === "x" ? item.from.box.width : item.from.box.height);
        if (
          Math.abs(start[main] - fromEnd) > 0.01 ||
          Math.abs(end[main] - item.to.box[main]) > 0.01 ||
          end[main] <= start[main]
        )
          continue;
        const middle = (start[main] + end[main]) / 2;
        const candidate = [start, { ...start, [main]: middle }, { ...end, [main]: middle }, end];
        if (routeLength(candidate) >= routeLength(old) - 5) continue;
        if (
          obstacles.some(
            ([id, box]) =>
              id !== item.from.key &&
              id !== item.to.key &&
              crossesBox(candidate, box, ROUTE_BOX_GAP),
          )
        )
          continue;
        if (routed.some((other, j) => j !== n && routesMeet(candidate, other))) continue;
        routed[n] = candidate;
        const route = lvl.routes.get(item.id);
        if (route) route.label = undefined;
      }
    }
    items.forEach((item, n) =>
      item.store(
        pinned
          ? aroundBoxes(
              routed[n]!,
              siblings
                .filter((node) => node.id !== item.from.key && node.id !== item.to.key)
                .map((node) => nodeBox(node)),
            )
          : routed[n]!,
      ),
    );
  }

  // Each edge, whole: the inner parts on its way out of the containers around its start, the part its holder
  // routes, and the inner parts on its way into the containers around its end.
  const canvasEdges: LayoutEdge[] = [];
  const leads = new Map<string, { laidOut: LayoutEdge; holder: LayoutNode | undefined }>();
  const pairedWith = new Set([...twinOf.values()].map((edge) => edge.id));
  for (const edge of model.edges) {
    if (edge.from === edge.to && nodeOf.has(edge.from)) {
      const parent = parentOf.get(edge.from);
      (parent ? parent.edges : canvasEdges).push(loopEdge(edge, boxIn(edge.from, parent)));
      continue;
    }
    const route = outer.get(edge.id);
    if (!route) continue;
    const holder = route.level.node;
    const chain = chains.get(edge.id)!;
    const moved = (container: string): Point[] => {
      const box = originIn(container, holder);
      return (inner.get(`${container}\0${edge.id}`) ?? []).map((p) => ({
        x: p.x + box.x,
        y: p.y + box.y,
      }));
    };
    const points = dropDetours(
      joined([...chain.from.map(moved), route.points, ...[...chain.to].reverse().map(moved)]),
    );
    const laidOut: LayoutEdge = {
      id: edge.id,
      stub: edge.stub,
      resolution: edge.resolution,
      kind: edge.kind,
      title: edge.label,
      ...(edge.via ? { via: edge.via } : {}),
      from: edge.from,
      to: edge.to,
      counted: edge.counted,
      points,
      anchor: points[0] ?? { x: 0, y: 0 },
    };
    if (pairedWith.has(edge.id)) laidOut.own = halfRoute(points);
    const box = edge.stub
      ? undefined
      : labelBox(laidOut.own ? wayLabel(edge.label, points) : edge.label);
    const centre =
      box &&
      (laidOut.own
        ? labelOnRoute(laidOut.own, box, undefined)
        : labelOnRoute(points, box, route.level.routes.get(edge.id)?.label));
    if (box && centre) {
      laidOut.label = { ...box, x: centre.x - box.width / 2, y: centre.y - box.height / 2 };
    }
    (holder ? holder.edges : canvasEdges).push(laidOut);
    leads.set(edge.id, { laidOut, holder });
  }
  for (const edge of model.edges) {
    const lead = twinOf.get(edge.id);
    const drawn = lead && leads.get(lead.id);
    if (!drawn) continue;
    const points = [...drawn.laidOut.points].reverse();
    const own = halfRoute(points);
    const twin: LayoutEdge = {
      id: edge.id,
      stub: false,
      resolution: edge.resolution,
      kind: edge.kind,
      title: edge.label,
      ...(edge.via ? { via: edge.via } : {}),
      from: edge.from,
      to: edge.to,
      counted: edge.counted,
      points,
      own,
      anchor: own[0] ?? { x: 0, y: 0 },
    };
    const box = labelBox(wayLabel(edge.label, points));
    const centre = labelOnRoute(own, box, undefined);
    if (centre) twin.label = { ...box, x: centre.x - box.width / 2, y: centre.y - box.height / 2 };
    (drawn.holder ? drawn.holder.edges : canvasEdges).push(twin);
  }
  if (facingAway) {
    // A port on the side of its container away from the edge's other end: the next pass turns it.
    const main = direction === "RIGHT" ? "x" : "y";
    const size = main === "x" ? "width" : "height";
    for (const [container, own] of entries) {
      const outside = boxIn(container, undefined);
      for (const [edgeId, { side }] of own) {
        const edge = model.edges.find((item) => item.id === edgeId);
        if (!edge) continue;
        const inside = (id: string) => id === container || ancestors(id, "").includes(container);
        const far = inside(edge.from) ? edge.to : edge.from;
        if (!nodeOf.has(far)) continue;
        const other = boxIn(far, undefined);
        const middle = other[main] + other[size] / 2;
        if (side === "end" ? middle < outside[main] : middle > outside[main] + outside[size])
          facingAway.add(`${container}\0${edgeId}`);
      }
    }
  }
  const width = top.result.width;
  const height = top.result.height;
  spreadLabels(
    canvasEdges,
    top.nodes.map((node) => nodeBox(node)),
    { x: 0, y: 0, width, height },
  );
  const spreadInside = (list: LayoutNode[]) => {
    for (const node of list) {
      spreadLabels(
        node.edges,
        node.children.map((child) => nodeBox(child)),
        {
          x: node.frame?.x ?? 0,
          y: node.frame?.y ?? 0,
          width: node.width,
          height: node.height,
        },
      );
      spreadInside(node.children);
    }
  };
  spreadInside(top.nodes);
  placeAnchors(top.nodes, canvasEdges, { width, height });
  const layout = {
    width,
    height,
    nodes: top.nodes,
    edges: canvasEdges,
    fallback: false,
    direction,
  };
  if (pins && [...nodeOf.keys()].some((id) => pins[id])) {
    const bounds = graphBounds(layout);
    layout.width = bounds.width;
    layout.height = bounds.height;
  }
  return layout;
}

/** How far a loop reaches out of its box, px. */
const LOOP_REACH = 16;

/**
 * An edge of a box to itself (a function that calls itself): a loop out of the top of the box, round its
 * top-right corner, and back into its right side, its label over the loop. `box` is in the
 * coordinates the edge is drawn in.
 */
function loopEdge(edge: EdgeMeta, box: Box): LayoutEdge {
  const right = box.x + box.width;
  const start = { x: right - Math.min(36, box.width / 3), y: box.y };
  const points = [
    start,
    { x: start.x, y: box.y - LOOP_REACH },
    { x: right + LOOP_REACH, y: box.y - LOOP_REACH },
    { x: right + LOOP_REACH, y: box.y + Math.min(14, box.height / 3) },
    { x: right, y: box.y + Math.min(14, box.height / 3) },
  ];
  const laidOut: LayoutEdge = {
    id: edge.id,
    stub: edge.stub,
    resolution: edge.resolution,
    kind: edge.kind,
    title: edge.label,
    ...(edge.via ? { via: edge.via } : {}),
    from: edge.from,
    to: edge.to,
    counted: edge.counted,
    points,
    anchor: points[2]!,
  };
  if (!edge.stub) {
    const label = labelBox(edge.label);
    laidOut.label = {
      ...label,
      x: (start.x + right + LOOP_REACH) / 2 - label.width / 2,
      y: box.y - LOOP_REACH - label.height - 2,
    };
  }
  return laidOut;
}

const extent = (box: Box, axis: "x" | "y") => (axis === "x" ? box.width : box.height);

/** Room kept between two edge labels, px. */
const LABEL_GAP = 4;

const overlap = (a: Box, b: Box, gap: number) =>
  a.x < b.x + b.width + gap &&
  b.x < a.x + a.width + gap &&
  a.y < b.y + b.height + gap &&
  b.y < a.y + a.height + gap;

/**
 * Labels of one level that would overlap ("calls ×5" over "calls ×15", where two edges share a gap) are
 * moved apart: the later one slides along its own line, as far as that line goes, else steps off it
 * across the line. Each label stays on or beside its edge. A second pass on levels of at most 150 edges
 * tries positions along the owner route when another route crosses a label or a box covers part of it. If
 * none clears the other routes, labels and boxes inside the level, the first pass's position stays.
 */
export function spreadLabels(
  edges: readonly (Pick<LayoutEdge, "points" | "label"> & { stub?: boolean })[],
  boxes: readonly Box[] = [],
  bounds?: Box,
): void {
  const placed: Box[] = [];
  for (const edge of edges) {
    const label = edge.label;
    if (!label) continue;
    // The segment the label sits on: the one nearest its centre.
    const centre = { x: label.x + label.width / 2, y: label.y + label.height / 2 };
    let best: [Point, Point] | undefined;
    let nearest = Infinity;
    for (let i = 1; i < edge.points.length; i++) {
      const a = edge.points[i - 1]!;
      const b = edge.points[i]!;
      const d = distanceToSegment(centre, a, b);
      if (d < nearest) {
        nearest = d;
        best = [a, b];
      }
    }
    const along: "x" | "y" =
      best && Math.abs(best[1].x - best[0].x) >= Math.abs(best[1].y - best[0].y) ? "x" : "y";
    const across = along === "x" ? "y" : "x";
    const lo = best ? Math.min(best[0][along], best[1][along]) : -Infinity;
    const hi = best ? Math.max(best[0][along], best[1][along]) : Infinity;
    for (let pass = 0; pass < 8; pass++) {
      const hit = placed.find((other) => overlap(label, other, LABEL_GAP));
      if (!hit) break;
      // the way that moves it least, along its line, kept on the segment
      const forward = hit[along] + extent(hit, along) + LABEL_GAP - label[along];
      const back = hit[along] - LABEL_GAP - extent(label, along) - label[along];
      const fits = (shift: number) => {
        const middle = label[along] + shift + extent(label, along) / 2;
        const moved = { ...label, [along]: label[along] + shift };
        return middle >= lo && middle <= hi && !boxes.some((box) => overlap(moved, box, 0));
      };
      const options = [forward, back].filter(fits).sort((a, b) => Math.abs(a) - Math.abs(b));
      if (options.length > 0) label[along] += options[0]!;
      else {
        // off the line: just past the other label, on the side that moves it least
        const after = hit[across] + extent(hit, across) + LABEL_GAP - label[across];
        const before = hit[across] - LABEL_GAP - extent(label, across) - label[across];
        label[across] += Math.abs(after) <= Math.abs(before) ? after : before;
      }
    }
    placed.push(label);
  }
  if (edges.length > BOTH_DIRECTIONS_LIMIT) return;
  for (const edge of edges) {
    const label = edge.label;
    if (!label) continue;
    // (a stub's dashed line is drawn only for what a reader looks at: a label need not clear it)
    const foreign = edges.filter((other) => other !== edge && !other.stub);
    // a label under a box, crossed by another line, or pushed off its own line (by another label) moves
    const reach = LABEL_BESIDE_GAP + 2;
    const atItsLine = crossesBox(
      edge.points,
      {
        x: label.x - reach,
        y: label.y - reach,
        width: label.width + 2 * reach,
        height: label.height + 2 * reach,
      },
      0,
    );
    if (
      atItsLine &&
      !boxes.some((box) => overlap(label, box, 0)) &&
      !foreign.some((other) => crossesBox(other.points, label, 0))
    )
      continue;
    const centre = { x: label.x + label.width / 2, y: label.y + label.height / 2 };
    const otherLabels = placed.filter((other) => other !== label);
    const withinLevel = (candidate: Box) =>
      !boxes.some((box) => overlap(candidate, box, 0)) &&
      (!bounds ||
        (candidate.x >= bounds.x &&
          candidate.y >= bounds.y &&
          candidate.x + candidate.width <= bounds.x + bounds.width &&
          candidate.y + candidate.height <= bounds.y + bounds.height));
    const clear = (candidate: Box) =>
      withinLevel(candidate) &&
      !otherLabels.some((other) => overlap(candidate, other, LABEL_GAP)) &&
      !foreign.some((other) => crossesBox(other.points, candidate, LABEL_GAP));
    // Where it may go: along its spans (on a straight run or beside a level one, never on a bend), at
    // their ends, in their middle, and just past each other label; nearest first, on the line before beside.
    const spots = labelSpans(edge.points, label).flatMap((span) => {
      const at = [
        centre[span.along],
        span.lo,
        span.hi,
        (span.lo + span.hi) / 2,
        ...otherLabels.flatMap((other) => [
          other[span.along] - LABEL_GAP - extent(label, span.along) / 2,
          other[span.along] + extent(other, span.along) + LABEL_GAP + extent(label, span.along) / 2,
        ]),
      ];
      return at.map((value) => ({ point: spanPoint(span, value), beside: span.beside }));
    });
    const cost = (spot: (typeof spots)[number]) =>
      Math.hypot(spot.point.x - centre.x, spot.point.y - centre.y) + (spot.beside ? 24 : 0);
    // When none of those is clear: on any point of the line, a bend too, shifted by a few px across it.
    // A bend under a label reads worse than a straight run, a foreign line through it worse still.
    const anywhere = edge.points.slice(1).flatMap((end, i) => {
      const start = edge.points[i]!;
      const across = start.x === end.x ? "x" : "y";
      return [start, { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }, end].flatMap((point) =>
        [0, 1, -1, 2, -2, 3, -3, 4, -4].map((offset) => ({
          ...point,
          [across]: point[across] + offset,
        })),
      );
    });
    const distance = (point: Point) => Math.hypot(point.x - centre.x, point.y - centre.y);
    const positions = [
      ...spots.sort((a, b) => cost(a) - cost(b)).map((spot) => spot.point),
      ...anywhere.sort((a, b) => distance(a) - distance(b)),
    ];
    // When no place clears everything, the first that is clear of boxes and other labels (a line through a label
    // reads better than a label under a box, or away from its own line), then the first that is clear of boxes.
    const tests = [
      clear,
      (candidate: Box) =>
        withinLevel(candidate) &&
        !otherLabels.some((other) => overlap(candidate, other, LABEL_GAP)),
      withinLevel,
    ];
    const stillBad =
      !atItsLine ||
      boxes.some((box) => overlap(label, box, 0)) ||
      otherLabels.some((other) => overlap(label, other, LABEL_GAP));
    for (const [n, test] of tests.entries()) {
      // (a relaxed test only replaces a place that is itself under a box or another label)
      if (n > 0 && !stillBad) break;
      const point = positions.find((p) =>
        test({
          x: p.x - label.width / 2,
          y: p.y - label.height / 2,
          width: label.width,
          height: label.height,
        }),
      );
      if (!point) continue;
      label.x = point.x - label.width / 2;
      label.y = point.y - label.height / 2;
      break;
    }
  }
}

/** The second half of a route, by length: from its middle to its end (the head). */
export function halfRoute(points: readonly Point[]): Point[] {
  const total = routeLength(points);
  let left = total / 2;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!,
      b = points[i]!;
    const length = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    if (length >= left && length > 0) {
      const t = left / length;
      return [{ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, ...points.slice(i)];
    }
    left -= length;
  }
  return [...points];
}

/** A jog no longer than this, px, between a run and a run back the other way is a detour (`dropDetours`). */
const DETOUR_JOG = 16;

/**
 * A right-angled route without detours: where it runs past the place it next turns to, steps a few px across
 * (a jog between two tracks, where the parts of an edge routed at two levels meet) and runs back, it turns at
 * that place instead. What is left lies inside the detour's own area, so it crosses nothing new.
 */
export function dropDetours(points: readonly Point[]): Point[] {
  let route = [...points];
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i + 3 < route.length; i++) {
      const [a, b, c, d] = [route[i]!, route[i + 1]!, route[i + 2]!, route[i + 3]!];
      const along = Math.abs(a.y - b.y) < 0.5 ? "x" : Math.abs(a.x - b.x) < 0.5 ? "y" : undefined;
      if (!along) continue;
      const across = along === "x" ? "y" : "x";
      const jog = Math.abs(b[across] - c[across]);
      if (Math.abs(b[along] - c[along]) > 0.5 || jog < 0.5 || jog > DETOUR_JOG) continue;
      if (Math.abs(c[across] - d[across]) > 0.5) continue;
      const out = Math.sign(b[along] - a[along]);
      // back the other way, to a place between where the run started and where it turned
      if (out === 0 || Math.sign(d[along] - c[along]) !== -out) continue;
      if ((d[along] - a[along]) * out <= 0) continue;
      const turn = { ...a, [along]: d[along] } as Point;
      route = [...route.slice(0, i + 1), turn, ...route.slice(i + 3)];
      changed = true;
      break;
    }
  }
  // (a turn that now lies on a straight line is no turn)
  return route.filter((p, i) => {
    const before = route[i - 1];
    const after = route[i + 1];
    if (!before || !after) return true;
    return !(
      (Math.abs(before.x - p.x) < 0.5 && Math.abs(p.x - after.x) < 0.5) ||
      (Math.abs(before.y - p.y) < 0.5 && Math.abs(p.y - after.y) < 0.5)
    );
  });
}

/** Routes laid end to end: where one ends the next starts, so the shared point is kept once. */
function joined(parts: readonly Point[][]): Point[] {
  const out: Point[] = [];
  for (const part of parts) {
    for (const p of part) {
      const last = out[out.length - 1];
      if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue;
      out.push(p);
    }
  }
  return out;
}

// ─── Anchors: where a click on an edge lands ────────────────────────────────────────────────────

const inside = (box: Box, p: Point, margin: number) =>
  p.x >= box.x - margin &&
  p.x <= box.x + box.width + margin &&
  p.y >= box.y - margin &&
  p.y <= box.y + box.height + margin;

/** Absolute boxes of everything below `node` (whose top-left corner is at `origin`). */
function boxesBelow(node: LayoutNode, origin: Point, out: Box[] = []): Box[] {
  for (const child of node.children) {
    const at = { x: origin.x + child.x, y: origin.y + child.y };
    out.push(nodeBox(child, origin));
    boxesBelow(child, at, out);
  }
  return out;
}

/**
 * Gives every edge its `anchor`: a point on its route that is not under a node box or another edge. Nodes are drawn above
 * the edges of their level, and the edges a container holds above the container's own body, so the
 * boxes that can cover an edge are the nodes inside its holder.
 */
function placeAnchors(
  nodes: LayoutNode[],
  rootEdges: LayoutEdge[],
  canvas: { width: number; height: number },
): void {
  const extent = unionBox([...absoluteBoxes(nodes).values()]);
  const limits = {
    x: Math.min(0, extent?.x ?? 0) - EDGE_BOUNDS_PAD,
    y: Math.min(0, extent?.y ?? 0) - EDGE_BOUNDS_PAD,
    width:
      Math.max(canvas.width, extent ? extent.x + extent.width : 0) -
      Math.min(0, extent?.x ?? 0) +
      2 * EDGE_BOUNDS_PAD,
    height:
      Math.max(canvas.height, extent ? extent.y + extent.height : 0) -
      Math.min(0, extent?.y ?? 0) +
      2 * EDGE_BOUNDS_PAD,
  };
  const place = (edges: LayoutEdge[], origin: Point, obstacles: Box[]) => {
    // (one of a two-way pair is picked on its own half of the shared line)
    const routes = edges.map((edge) =>
      (edge.own ?? edge.points).map((p) => ({ x: p.x + origin.x, y: p.y + origin.y })),
    );
    // the labels of the level are drawn above all of its lines (GraphView EdgeLabels)
    const labels = edges.flatMap((edge) =>
      edge.label ? [{ ...edge.label, x: edge.label.x + origin.x, y: edge.label.y + origin.y }] : [],
    );
    edges.forEach((edge, i) => {
      // Not under a box or a label (they take the click), and not where another edge of the same layer
      // runs (they share tracks); when no point is that free, the edges are given up first, then the labels.
      const underBox = (p: Point) => obstacles.some((b) => inside(b, p, 3));
      const underLabel = (p: Point) => labels.some((b) => inside(b, p, 3));
      const onTrack = (p: Point) => routes.some((route, j) => j !== i && nearRoute(p, route, 9));
      const vetoes = [
        (p: Point) => underBox(p) || underLabel(p) || onTrack(p),
        (p: Point) => underBox(p) || underLabel(p),
        (p: Point) => underBox(p) || onTrack(p),
        underBox,
      ];
      let found: Point | undefined;
      for (const veto of vetoes) {
        const point = routeAnchor(routes[i]!, veto, { limits, pad: EDGE_BOUNDS_PAD });
        found ??= point;
        if (!veto(point)) {
          found = point;
          break;
        }
      }
      edge.anchor = { x: found!.x - origin.x, y: found!.y - origin.y };
    });
  };
  const all: Box[] = [];
  const collect = (list: LayoutNode[], origin: Point) => {
    for (const node of list) {
      const at = { x: origin.x + node.x, y: origin.y + node.y };
      all.push(nodeBox(node, origin));
      collect(node.children, at);
    }
  };
  collect(nodes, { x: 0, y: 0 });
  place(rootEdges, { x: 0, y: 0 }, all);
  const visit = (list: LayoutNode[], origin: Point) => {
    for (const node of list) {
      const at = { x: origin.x + node.x, y: origin.y + node.y };
      if (node.edges.length > 0) place(node.edges, at, boxesBelow(node, at));
      visit(node.children, at);
    }
  };
  visit(nodes, { x: 0, y: 0 });
}

/** What the explainer's change did to the nodes of a graph, by node id (only the changed ones). */
export type ChangeMarks = ReadonlyMap<string, ChangeStatus>;

export async function layoutGraph(
  graph: DerivedGraph,
  options: LayoutOptions = {},
  changes?: ChangeMarks,
): Promise<GraphLayout> {
  const model = buildModel(graph, changes);
  const shared = (layout: GraphLayout): GraphLayout =>
    model.sharedBadge ? { ...layout, sharedBadge: model.sharedBadge } : layout;
  try {
    const direction = options.direction ?? "RIGHT";
    // A second pass when an edge leaves (or enters) a group on the side away from its other end.
    const away = new Set<string>();
    const first = layeredLayout(model, direction, options.pins, undefined, away);
    return shared(away.size === 0 ? first : layeredLayout(model, direction, options.pins, away));
  } catch (error) {
    console.warn("xpl: layout failed, using a grid", error);
    return shared(fallbackLayout(model, options.pins));
  }
}

/** The grid that stands in when the layered layout fails: every box, every edge straight between centres. */
export function gridLayoutOf(graph: DerivedGraph, changes?: ChangeMarks): GraphLayout {
  return fallbackLayout(buildModel(graph, changes));
}

// ─── Where a diagram too big to fit starts ──────────────────────────────────────────────────────

/** The boxes of all nodes (containers and what is inside them, ghosts) by id, in canvas coordinates. */
export function absoluteBoxes(nodes: readonly LayoutNode[]): Map<string, Box> {
  const out = new Map<string, Box>();
  const walk = (list: readonly LayoutNode[], origin: Point) => {
    for (const node of list) {
      const at = { x: origin.x + node.x, y: origin.y + node.y };
      out.set(node.id, nodeBox(node, origin));
      walk(node.children, at);
    }
  };
  walk(nodes, { x: 0, y: 0 });
  return out;
}

/**
 * What a diagram that is too big to be shown whole starts on (see viewport.ts): the selected boxes, else the
 * first box of the view's include list that is drawn (`order`: the include list keeps the author's order,
 * which puts the entry point first). Undefined leaves the start at the top-left corner.
 */
export function startAnchor(
  layout: Pick<GraphLayout, "nodes">,
  selection: readonly string[],
  order: readonly string[],
): Box | undefined {
  const boxes = absoluteBoxes(layout.nodes);
  const selected = unionBox(selection.flatMap((id) => boxes.get(id) ?? []));
  if (selected) return selected;
  for (const id of order) {
    const box = boxes.get(id);
    if (box) return box;
  }
  return undefined;
}

/** Every edge of the layout, at any level (an edge inside a container joins boxes by their render ids). */
function allEdges(layout: Pick<GraphLayout, "nodes" | "edges">): LayoutEdge[] {
  const out = [...layout.edges];
  const walk = (list: readonly LayoutNode[]) => {
    for (const node of list) {
      out.push(...node.edges);
      walk(node.children);
    }
  };
  walk(layout.nodes);
  return out;
}

/**
 * What a still picture showing only `window` (canvas coordinates) of the layout cuts: the boxes (without boxes
 * inside them) that are not wholly in it, and the edges with an end it does not show (such a box, or a
 * container wholly out of it). The picture fades them: an arrow from a box that is not there, or a sliver of
 * a box at the edge, reads as a mistake.
 */
export function cutAt(layout: Pick<GraphLayout, "nodes" | "edges">, window: Box): Set<string> {
  const boxes = absoluteBoxes(layout.nodes);
  const leaves = new Set<string>();
  const walk = (list: readonly LayoutNode[]) => {
    for (const node of list) {
      if (node.children.length === 0) leaves.add(node.id);
      walk(node.children);
    }
  };
  walk(layout.nodes);
  const slack = 1;
  const inside = (box: Box) =>
    box.x >= window.x - slack &&
    box.y >= window.y - slack &&
    box.x + box.width <= window.x + window.width + slack &&
    box.y + box.height <= window.y + window.height + slack;
  const meets = (box: Box) =>
    box.x < window.x + window.width &&
    box.x + box.width > window.x &&
    box.y < window.y + window.height &&
    box.y + box.height > window.y;
  const cut = new Set<string>();
  for (const id of leaves) if (!inside(boxes.get(id)!)) cut.add(id);
  const shown = (id: string) => {
    const box = boxes.get(id);
    return box !== undefined && (leaves.has(id) ? inside(box) : meets(box));
  };
  for (const edge of allEdges(layout)) if (!shown(edge.from) || !shown(edge.to)) cut.add(edge.id);
  return cut;
}

/**
 * What the first view frames for `ids` (render ids of boxes or edges, in order; see viewport.ts
 * `frameView`): the box of each (an edge stands for the two boxes it joins), and their neighbours, the
 * boxes at the other end of an edge from one of them. Undefined when none of them is drawn.
 */
export function frameFocus(
  layout: Pick<GraphLayout, "nodes" | "edges">,
  ids: readonly string[],
): Focus | undefined {
  const boxes = absoluteBoxes(layout.nodes);
  const edges = allEdges(layout);
  const byId = new Map(edges.map((edge) => [edge.id, edge] as const));
  const focused: string[] = [];
  for (const id of ids) {
    const edge = byId.get(id);
    for (const one of edge ? [edge.from, edge.to] : [id])
      if (boxes.has(one) && !focused.includes(one)) focused.push(one);
  }
  if (focused.length === 0) return undefined;
  const inFocus = new Set(focused);
  const near = new Set<string>();
  for (const edge of edges) {
    if (inFocus.has(edge.from) && !inFocus.has(edge.to)) near.add(edge.to);
    if (inFocus.has(edge.to) && !inFocus.has(edge.from)) near.add(edge.from);
  }
  return {
    boxes: focused.map((id) => boxes.get(id)!),
    neighbours: [...near].flatMap((id) => boxes.get(id) ?? []),
  };
}

/**
 * What a diagram too big to be shown whole frames first: the selection and its neighbours (`frameFocus`),
 * else the first box of the view's include list that is drawn, alone.
 */
export function startFocus(
  layout: Pick<GraphLayout, "nodes" | "edges">,
  selection: readonly string[],
  order: readonly string[],
): Focus | undefined {
  const selected = frameFocus(layout, selection);
  if (selected) return selected;
  const first = startAnchor(layout, [], order);
  return first ? { boxes: [first] } : undefined;
}

// ─── Direction: whichever reads larger in the pane ──────────────────────────────────────────────

/** The scale a diagram is shown at when fitted into a viewport (PanZoom's "Fit"): bigger reads better. */
export function fitScale(
  layout: { width: number; height: number },
  viewport: { width: number; height: number },
  maxZoom = 1.25,
  padding = 24,
): number {
  if (layout.width <= 0 || layout.height <= 0) return maxZoom;
  return Math.min(
    maxZoom,
    (viewport.width - 2 * padding) / layout.width,
    (viewport.height - 2 * padding) / layout.height,
  );
}

/** Above this many nodes, edges and stubs only the direction the pane's shape suggests is tried. */
const BOTH_DIRECTIONS_LIMIT = 150;
/** The other direction has to fit this much larger to win: the reading direction stays put otherwise. */
const OTHER_DIRECTION_MARGIN = 1.08;

/**
 * Lays the graph out for a pane of the given size. A wide pane suggests `RIGHT`, a tall one `DOWN`; for
 * graphs that are not huge, and that the suggested direction cannot show at natural size, both are laid
 * out and the one that fits the pane at the larger scale wins (ties and near-ties keep the suggested
 * one). Without a size it is plain `layoutGraph`. A layered layout is as wide as it has layers times a
 * box, and as tall as its widest layer: in a tall pane the same graph laid out downwards is drawn much
 * larger than one laid out to the right, and vice versa.
 */
export async function layoutGraphFitting(
  graph: DerivedGraph,
  viewport: { width: number; height: number } | undefined,
  maxZoom = 1.25,
  padding = 24,
  changes?: ChangeMarks,
  pins?: GraphView["layout"],
): Promise<GraphLayout> {
  if (!viewport || viewport.width <= 0 || viewport.height <= 0)
    return layoutGraph(graph, { pins }, changes);
  const suggested: Direction = viewport.width / viewport.height < 1 ? "DOWN" : "RIGHT";
  const other: Direction = suggested === "RIGHT" ? "DOWN" : "RIGHT";
  const first = await layoutGraph(graph, { direction: suggested, pins }, changes);
  if (
    first.fallback ||
    // shown at its natural size or larger: turning it would not make the text read better
    fitScale(first, viewport, maxZoom, padding) >= 1 ||
    graph.nodes.length + graph.edges.length + graph.stubs.length > BOTH_DIRECTIONS_LIMIT
  ) {
    return first;
  }
  const second = await layoutGraph(graph, { direction: other, pins }, changes);
  if (second.fallback) return first;
  return fitScale(second, viewport, maxZoom, padding) >
    fitScale(first, viewport, maxZoom, padding) * OTHER_DIRECTION_MARGIN
    ? second
    : first;
}

// ─── Fallback: a grid ───────────────────────────────────────────────────────────────────────────

/** Rows of at most `columns` boxes, containers sized around their own grid. */
function gridLayout(
  model: Model,
  ids: string[],
  columns: number,
): { nodes: LayoutNode[]; width: number; height: number } {
  const GAP = 28;
  const placed: LayoutNode[] = [];
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  let width = 0;
  ids.forEach((id, i) => {
    const kids = model.children.get(id) ?? [];
    let size: { width: number; height: number };
    let inner: LayoutNode[] = [];
    if (kids.length > 0) {
      const grid = gridLayout(model, kids, 2);
      const node = model.nodes.get(id)!;
      size = {
        width: Math.max(
          containerMinWidth(node.label, node.badge, node.change),
          grid.width + 2 * CONTAINER_PAD,
        ),
        height: grid.height + HEADER_HEIGHT + 8 + CONTAINER_PAD,
      };
      inner = grid.nodes.map((n) => ({ ...n, x: n.x + CONTAINER_PAD, y: n.y + HEADER_HEIGHT + 8 }));
    } else size = leafSize(model, id);
    if (i > 0 && i % columns === 0) {
      x = 0;
      y += rowHeight + GAP;
      rowHeight = 0;
    }
    placed.push(makeNode(model, id, { x, y, ...size }, inner));
    x += size.width + GAP;
    rowHeight = Math.max(rowHeight, size.height);
    width = Math.max(width, x - GAP);
  });
  return { nodes: placed, width, height: y + rowHeight };
}

function fallbackLayout(model: Model, pins?: GraphView["layout"]): GraphLayout {
  const grid = gridLayout(
    model,
    model.roots,
    Math.max(2, Math.ceil(Math.sqrt(model.roots.length))),
  );
  const nodes = grid.nodes.map((n) => ({ ...n, x: n.x + 24, y: n.y + 24 }));
  const pinNodes = (list: LayoutNode[]) => {
    for (const node of list) {
      pinNodes(node.children);
      enclose(node);
      Object.assign(node, pins?.[node.id]);
    }
  };
  pinNodes(nodes);
  // Absolute boxes, to draw straight edges between centres clipped at the borders.
  const boxes = new Map<string, { x: number; y: number; width: number; height: number }>();
  const walk = (list: LayoutNode[], ox: number, oy: number) => {
    for (const n of list) {
      boxes.set(n.id, nodeBox(n, { x: ox, y: oy }));
      walk(n.children, ox + n.x, oy + n.y);
    }
  };
  walk(nodes, 0, 0);
  const clip = (
    box: { x: number; y: number; width: number; height: number },
    toward: Point,
  ): Point => {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const dx = toward.x - cx;
    const dy = toward.y - cy;
    if (dx === 0 && dy === 0) return { x: cx, y: cy };
    const scale = Math.min(
      dx === 0 ? Infinity : box.width / 2 / Math.abs(dx),
      dy === 0 ? Infinity : box.height / 2 / Math.abs(dy),
    );
    return { x: cx + dx * scale, y: cy + dy * scale };
  };
  const edges: LayoutEdge[] = [];
  for (const edge of model.edges) {
    const a = boxes.get(edge.from);
    const b = boxes.get(edge.to);
    if (!a || !b) continue;
    if (edge.from === edge.to) {
      edges.push(loopEdge(edge, a));
      continue;
    }
    const ca = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
    const cb = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    const label = labelBox(edge.label);
    edges.push({
      id: edge.id,
      stub: edge.stub,
      resolution: edge.resolution,
      kind: edge.kind,
      title: edge.label,
      ...(edge.via ? { via: edge.via } : {}),
      from: edge.from,
      to: edge.to,
      counted: edge.counted,
      points: [clip(a, cb), clip(b, ca)],
      anchor: { x: (ca.x + cb.x) / 2, y: (ca.y + cb.y) / 2 },
      label: {
        ...label,
        x: (ca.x + cb.x) / 2 - label.width / 2,
        y: (ca.y + cb.y) / 2 - label.height / 2,
      },
    });
  }
  const canvas = { width: grid.width + 48, height: grid.height + 48 };
  placeAnchors(nodes, edges, canvas);
  const layout: GraphLayout = { ...canvas, nodes, edges, fallback: true, direction: "RIGHT" };
  if (pins)
    Object.assign(layout, { width: graphBounds(layout).width, height: graphBounds(layout).height });
  return layout;
}
