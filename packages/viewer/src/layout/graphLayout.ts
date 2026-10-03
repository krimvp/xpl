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
  type NodeRole,
  type Stub,
} from "@xpl/core";
import type { ChangeStatus } from "../diff.js";
import { textWidth } from "../measure.js";
import { distanceToSegment, nearRoute, routeAnchor, type Box, type Point } from "../svg.js";
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
  /** Position relative to the container (or to the canvas for top-level nodes). */
  x: number;
  y: number;
  width: number;
  height: number;
  children: LayoutNode[];
  /** Edges held by this container (both ends inside it), relative to its top-left corner. */
  edges: LayoutEdge[];
}

export interface LayoutEdge {
  id: string;
  /** A stub (dashed, to a ghost) rather than a derived or stored edge. */
  stub: boolean;
  /** How much to trust the edge: `precise` / `heuristic` (derived), `llm` / `user` / `static` (stored), `stub`. */
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

// Font sizes of the diagram's text in its own units (styles.css draws with the same numbers). A diagram is
// fitted into its pane, so this is what decides how small the text ends up: kept generous, and the boxes
// hardly grow with it (a short label sits in a box of minimum width anyway).
const NODE_LABEL_FONT = 14;
const BADGE_FONT = 12;
const GHOST_LABEL_FONT = 13.5;
const GHOST_DETAIL_FONT = 12.5;
const EDGE_LABEL_FONT = 13;

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
  const text = edge.label ? edge.label : `${edge.kind} ×${edge.count}`;
  // "A reaches C through B": one arrow, which names what it passes through
  const via = edge.via?.map((item) => item.label) ?? [];
  if (via.length === 0) return text;
  return edge.label ? `${text} (via ${via.join(", ")})` : `via ${via.join(", ")}`;
}

/**
 * The edges a map draws, fewer than it derives: a derived edge between two boxes that an authored edge already
 * joins (the same way) is left out, the authored one says it in words; and derived edges of several kinds
 * between the same two boxes become one arrow ("calls ×5 · references ×2"), under the id of the first. A
 * small map no longer gets an arrow per kind of reference.
 */
export function drawnEdges(edges: readonly DerivedEdge[]): DerivedEdge[] {
  const pair = (edge: DerivedEdge) => `${edge.from}\0${edge.to}`;
  const authored = new Set(edges.filter((edge) => edge.stored).map(pair));
  const merged = new Map<string, DerivedEdge>();
  const out: DerivedEdge[] = [];
  for (const edge of edges) {
    if (edge.stored) {
      out.push(edge);
      continue;
    }
    if (authored.has(pair(edge))) continue;
    const first = merged.get(pair(edge));
    if (!first) {
      const copy = { ...edge };
      merged.set(pair(edge), copy);
      out.push(copy);
      continue;
    }
    first.label = `${first.label ?? `${first.kind} ×${first.count}`} · ${edge.kind} ×${edge.count}`;
    if (edge.resolution === "precise") first.resolution = "precise";
  }
  // a merged arrow's label is still a count made up by the viewer, not words someone wrote
  return out.map((edge) =>
    !edge.stored && edge.label !== undefined ? { ...edge, label: edge.label } : edge,
  );
}

function stubLabelText(stub: Stub): string {
  return `${stub.kinds.join(" & ")} ×${stub.count}`;
}

function labelBox(text: string): { text: string; width: number; height: number } {
  return {
    text,
    width: Math.ceil(textWidth(text, EDGE_LABEL_FONT, 500)) + 10,
    height: LABEL_HEIGHT,
  };
}

// ─── Model shared by the layered layout and the fallback ───────────────────────────────────────────────────────

interface ModelNode {
  label: string;
  badge: string;
  kindClass: string;
  ghostTarget?: string;
  ghostFold?: LayoutNode["ghostFold"];
  detail?: string;
  hint?: string;
  change?: ChangeStatus;
  role?: NodeRole;
  opens?: string;
  expandable?: boolean;
}

interface Model {
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
    });
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
        // One kind is named; several are left to the tooltip and the details panel.
        detail: `${kinds.length === 1 ? `${kinds[0]} ` : ""}×${ghost.count}`,
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
  return { roots, children, parent, nodes, edges };
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
  return {
    width: leafWidth(node.label, node.badge, node.change, node),
    height: leafHeight(node.role),
  };
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
  return out;
}

// ─── Layered layout, one container at a time ────────────────────────────────────────────────────

/** Where a layout starts: the reading direction. */
export interface LayoutOptions {
  /** Default `RIGHT`. */
  direction?: Direction;
}

/** Spacing. Tight on purpose: a layout is fitted into its pane, so every pixel of air between boxes shrinks the text. */
const SPACING = { nodeGap: 24, layerGap: 48, edgeGap: 10 };
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

/**
 * Lays out the graph: every container's inside first (its children as one layered level, with room for its
 * header), then the container as one box of the level above, up to the canvas. Then every edge is routed in
 * the container that holds it: dagre's points between the two boxes of that level its ends are drawn in, and
 * right-angled ends on the boxes it actually joins, which may sit deeper inside them.
 */
function layeredLayout(model: Model, direction: Direction): GraphLayout {
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
  for (const edge of model.edges) {
    if (edge.from === edge.to) continue; // a loop: drawn on its box once the boxes are placed
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

  const level = (
    ids: readonly string[],
    holder: string,
    pad: LayeredOptions["pad"],
  ): { nodes: LayoutNode[]; result: LayeredResult } => {
    const nodes = ids.map(build);
    const boxes = nodes.map((n) => ({ id: n.id, width: n.width, height: n.height }));
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
      for (const { edge, end } of crossings) {
        const box = liftTo(model, edge[end], holder);
        const layer = layers.get(box) ?? 0;
        ports.push({ id: portId(edge), width: 2, height: 2 });
        inner.push(
          end === "to"
            ? { id: innerId(edge), from: portId(edge), to: box, minlen: layer + 1 }
            : { id: innerId(edge), from: box, to: portId(edge), minlen: last - layer + 1 },
        );
      }
      result = layered([...boxes, ...ports], [...edges, ...inner], options);
      const own = new Map<string, { side: Side; cross: number }>();
      for (const { edge, end } of crossings) {
        const port = result.boxes.get(portId(edge))!;
        own.set(edge.id, {
          side: end === "to" ? "start" : "end",
          cross: cross === "y" ? port.y + port.height / 2 : port.x + port.width / 2,
        });
      }
      entries.set(holder, own);
    }
    for (const node of nodes) {
      const box = result.boxes.get(node.id)!;
      node.x = box.x;
      node.y = box.y;
    }
    return { nodes, result };
  };
  function build(id: string): LayoutNode {
    const kids = model.children.get(id) ?? [];
    if (kids.length === 0) return makeNode(model, id, { x: 0, y: 0, ...leafSize(model, id) }, []);
    const inner = level(kids, id, CONTAINER_PADDING);
    const info = model.nodes.get(id)!;
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
    levels.push({ id, node, routes: inner.result.routes });
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
  const boxIn = (id: string, holder: LayoutNode | undefined): Box => {
    const node = nodeOf.get(id)!;
    let x = node.x;
    let y = node.y;
    for (let up = parentOf.get(id); up && up !== holder; up = parentOf.get(up.id)) {
      x += up.x;
      y += up.y;
    }
    return { x, y, width: node.width, height: node.height };
  };

  // Route every level: the edges it holds (from border to border where an end lies deeper) and, in a
  // container, the inner part of each edge that crosses its border (from the border to the box inside).
  const outer = new Map<string, { points: Point[]; level: Level }>();
  const inner = new Map<string, Point[]>(); // `${container}\0${edge id}`, container coordinates
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
          ? { fixed: { side: entry.side, cross: entry.cross + (cross === "y" ? box.y : box.x) } }
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
      const at = entry.side === "start" ? 0 : cross === "y" ? size.width : size.height;
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
    for (const item of items) {
      boxes.set(item.from.key, item.from.box);
      boxes.set(item.to.key, item.to.box);
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
    const spread = spreadPorts(ports, boxes, direction);
    const routed = items.map((item) =>
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
    separateTracks(routed, direction);
    items.forEach((item, n) => item.store(routed[n]!));
  }

  // Each edge, whole: the inner parts on its way out of the containers around its start, the part its holder
  // routes, and the inner parts on its way into the containers around its end.
  const canvasEdges: LayoutEdge[] = [];
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
      const box = boxIn(container, holder);
      return (inner.get(`${container}\0${edge.id}`) ?? []).map((p) => ({
        x: p.x + box.x,
        y: p.y + box.y,
      }));
    };
    const points = joined([
      ...chain.from.map(moved),
      route.points,
      ...[...chain.to].reverse().map(moved),
    ]);
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
    const centre = route.level.routes.get(edge.id)?.label;
    if (!edge.stub && centre) {
      const box = labelBox(edge.label);
      laidOut.label = { ...box, x: centre.x - box.width / 2, y: centre.y - box.height / 2 };
    }
    (holder ? holder.edges : canvasEdges).push(laidOut);
  }
  const width = top.result.width;
  const height = top.result.height;
  spreadLabels(canvasEdges);
  const spreadInside = (list: LayoutNode[]) => {
    for (const node of list) {
      spreadLabels(node.edges);
      spreadInside(node.children);
    }
  };
  spreadInside(top.nodes);
  placeAnchors(top.nodes, canvasEdges, { width, height });
  return { width, height, nodes: top.nodes, edges: canvasEdges, fallback: false, direction };
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
 * across the line. Each label stays on or beside its edge.
 */
export function spreadLabels(edges: readonly Pick<LayoutEdge, "points" | "label">[]): void {
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
        return middle >= lo && middle <= hi;
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
}

const size2 = (box: Box, axis: "x" | "y") => (axis === "x" ? box.width : box.height);

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
    out.push({ ...at, width: child.width, height: child.height });
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
  const limits = { x: 0, y: 0, width: canvas.width, height: canvas.height };
  const place = (edges: LayoutEdge[], origin: Point, obstacles: Box[]) => {
    const routes = edges.map((edge) =>
      edge.points.map((p) => ({ x: p.x + origin.x, y: p.y + origin.y })),
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
      all.push({ ...at, width: node.width, height: node.height });
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
  try {
    return layeredLayout(model, options.direction ?? "RIGHT");
  } catch (error) {
    console.warn("xpl: layout failed, using a grid", error);
    return fallbackLayout(model);
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
      out.set(node.id, { ...at, width: node.width, height: node.height });
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
): Promise<GraphLayout> {
  if (!viewport || viewport.width <= 0 || viewport.height <= 0)
    return layoutGraph(graph, {}, changes);
  const suggested: Direction = viewport.width / viewport.height < 1 ? "DOWN" : "RIGHT";
  const other: Direction = suggested === "RIGHT" ? "DOWN" : "RIGHT";
  const first = await layoutGraph(graph, { direction: suggested }, changes);
  if (
    first.fallback ||
    // shown at its natural size or larger: turning it would not make the text read better
    fitScale(first, viewport, maxZoom, padding) >= 1 ||
    graph.nodes.length + graph.edges.length + graph.stubs.length > BOTH_DIRECTIONS_LIMIT
  ) {
    return first;
  }
  const second = await layoutGraph(graph, { direction: other }, changes);
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

function fallbackLayout(model: Model): GraphLayout {
  const grid = gridLayout(
    model,
    model.roots,
    Math.max(2, Math.ceil(Math.sqrt(model.roots.length))),
  );
  const nodes = grid.nodes.map((n) => ({ ...n, x: n.x + 24, y: n.y + 24 }));
  // Absolute boxes, to draw straight edges between centres clipped at the borders.
  const boxes = new Map<string, { x: number; y: number; width: number; height: number }>();
  const walk = (list: LayoutNode[], ox: number, oy: number) => {
    for (const n of list) {
      boxes.set(n.id, { x: ox + n.x, y: oy + n.y, width: n.width, height: n.height });
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
  return { ...canvas, nodes, edges, fallback: true, direction: "RIGHT" };
}
