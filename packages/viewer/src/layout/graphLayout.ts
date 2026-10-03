/**
 * Graph views: `DerivedGraph` (core) -> boxes and routed edges (elkjs) that GraphView draws as SVG.
 *
 * ELK `layered` (direction RIGHT by default; `layoutGraphFitting` picks RIGHT or DOWN by what reads larger
 * in the pane), `hierarchyHandling: INCLUDE_CHILDREN`: one pass lays out the whole
 * containment tree, so edges may cross container borders. Included nodes with included children are
 * containers (ELK compound nodes). Ghost boxes (where a view stops) are plain nodes at the top level;
 * stubs are edges to them.
 *
 * Every edge belongs to the lowest container that holds both of its ends (the canvas for top-level
 * ones) and is declared there, so ELK returns its route and label relative to that container
 * (`elk.json.edgeCoords: CONTAINER`) and GraphView draws it inside the container's group. Node
 * positions are relative to their container too. If ELK throws, a simple grid layout keeps the diagram
 * usable (all edges on the canvas, in canvas coordinates).
 */
import ELKModule, { type ElkExtendedEdge, type ElkNode } from "elkjs/lib/elk.bundled.js";
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
import { nearRoute, routeAnchor, type Box, type Point } from "../svg.js";
import { unionBox } from "../viewport.js";

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
  /**
   * A point of the route that no box drawn above the edge covers: where a click on the edge lands
   * (the edge's group is built around it, so automated clicks at its centre hit the route).
   */
  anchor: Point;
}

/** Which way the layers run: `RIGHT` (columns, left to right) or `DOWN` (rows, top to bottom). */
export type Direction = "RIGHT" | "DOWN";

export interface GraphLayout {
  width: number;
  height: number;
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  /** True when ELK failed and the grid fallback was used. */
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
/** Room for the zoom button of a box that opens a view, and for a person's icon. */
export const ZOOM_SIZE = 22;
export const PERSON_ICON = 20;

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
  extra: { role?: NodeRole; opens?: string } = {},
): number {
  const content = Math.max(
    textWidth(label, NODE_LABEL_FONT, 600),
    badgeWidth(badge) + changeWidth(change),
  );
  const icon = extra.role === "person" ? PERSON_ICON + 6 : 0;
  const zoom = extra.opens !== undefined ? ZOOM_SIZE + 6 : 0;
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
    2 * PAD_X
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
  return edge.label ? edge.label : `${edge.kind} ×${edge.count}`;
}

function stubLabelText(stub: Stub): string {
  return `${stub.kinds.join("/")} ×${stub.count}`;
}

function labelBox(text: string): { text: string; width: number; height: number } {
  return {
    text,
    width: Math.ceil(textWidth(text, EDGE_LABEL_FONT, 500)) + 10,
    height: LABEL_HEIGHT,
  };
}

// ─── Model shared by ELK and the fallback ───────────────────────────────────────────────────────

interface ModelNode {
  label: string;
  badge: string;
  kindClass: string;
  ghostTarget?: string;
  ghostFold?: LayoutNode["ghostFold"];
  detail?: string;
  hint?: string;
  /** Ghosts: `in` when every stub enters the view there, `out` when every stub leaves it. */
  side?: "in" | "out";
  change?: ChangeStatus;
  role?: NodeRole;
  opens?: string;
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
  for (const edge of graph.edges) {
    if (!known.has(edge.from) || !known.has(edge.to) || seen.has(edge.id)) continue;
    seen.add(edge.id);
    edges.push({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      label: edgeLabelText(edge),
      counted: !edge.label,
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
        ...(ghost.direction !== "both" ? { side: ghost.direction } : {}),
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
  return out;
}

// ─── ELK ────────────────────────────────────────────────────────────────────────────────────────

// elkjs ships an ES-style d.ts for a CommonJS file: with a bundler `ELKModule` is the class, under Node's
// own module resolution it is `module.exports`, which carries the class as `.default`.
type ElkConstructor = new () => { layout(graph: ElkNode): Promise<ElkNode> };
const ELK = ((ELKModule as unknown as { default?: unknown }).default ??
  ELKModule) as ElkConstructor;
const elk = new ELK();

const ROOT_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.json.edgeCoords": "CONTAINER",
  "elk.padding": "[top=24,left=24,bottom=24,right=24]",
  // Tight on purpose: a layout is fitted into its pane, so every pixel of air between boxes shrinks the
  // text. These spacings read about 20% larger than ELK's roomy ones on the fixture's overview.
  "elk.spacing.nodeNode": "24",
  "elk.spacing.edgeNode": "14",
  "elk.spacing.edgeEdge": "10",
  "elk.spacing.edgeLabel": "4",
  "elk.layered.spacing.nodeNodeBetweenLayers": "30",
  "elk.layered.spacing.edgeNodeBetweenLayers": "14",
  "elk.layered.spacing.edgeEdgeBetweenLayers": "10",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
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

function toElk(model: Model, id: string, registry: Map<string, ElkNode>): ElkNode {
  const kids = model.children.get(id) ?? [];
  const node = model.nodes.get(id)!;
  let out: ElkNode;
  if (kids.length === 0) {
    // Where a view stops: what only enters it sits in the first layer, what only leaves it in the last.
    const constraint = node.side === "in" ? "FIRST" : node.side === "out" ? "LAST" : undefined;
    out = {
      id,
      ...leafSize(model, id),
      ...(constraint
        ? { layoutOptions: { "elk.layered.layering.layerConstraint": constraint } }
        : {}),
    };
  } else {
    out = {
      id,
      layoutOptions: {
        "elk.padding": `[top=${HEADER_HEIGHT + 8},left=${CONTAINER_PAD},bottom=${CONTAINER_PAD},right=${CONTAINER_PAD}]`,
        "elk.nodeSize.constraints": "MINIMUM_SIZE",
        "elk.nodeSize.minimum": `(${containerMinWidth(node.label, node.badge, node.change)}, ${HEADER_HEIGHT + 60})`,
      },
      children: kids.map((kid) => toElk(model, kid, registry)),
      edges: [],
    };
  }
  registry.set(id, out);
  return out;
}

function routeOf(edge: ElkExtendedEdge): Point[] {
  const points: Point[] = [];
  for (const section of edge.sections ?? []) {
    points.push(section.startPoint, ...(section.bendPoints ?? []), section.endPoint);
  }
  return points.map((p) => ({ x: p.x, y: p.y }));
}

type EdgeMeta = Model["edges"][number];

function layoutEdgeOf(edge: ElkExtendedEdge, meta: EdgeMeta): LayoutEdge {
  const points = routeOf(edge);
  const laidOut: LayoutEdge = {
    id: edge.id,
    stub: meta.stub,
    resolution: meta.resolution,
    kind: meta.kind,
    title: meta.label,
    from: meta.from,
    to: meta.to,
    counted: meta.counted,
    points,
    anchor: points[0] ?? { x: 0, y: 0 },
  };
  const label = edge.labels?.[0];
  if (label && label.text !== undefined && label.x !== undefined && label.y !== undefined) {
    laidOut.label = {
      text: label.text,
      x: label.x,
      y: label.y,
      width: label.width ?? 0,
      height: label.height ?? 0,
    };
  }
  return laidOut;
}

function fromElk(model: Model, node: ElkNode, described: Map<string, EdgeMeta>): LayoutNode {
  return makeNode(
    model,
    node.id,
    { x: node.x ?? 0, y: node.y ?? 0, width: node.width ?? 0, height: node.height ?? 0 },
    (node.children ?? []).map((child) => fromElk(model, child, described)),
    edgesOf(node, described),
  );
}

function edgesOf(node: ElkNode, described: Map<string, EdgeMeta>): LayoutEdge[] {
  return ((node.edges ?? []) as ElkExtendedEdge[]).map((edge) =>
    layoutEdgeOf(edge, described.get(edge.id)!),
  );
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
    edges.forEach((edge, i) => {
      // Not under a box, and not where another edge of the same layer runs (they share tracks).
      const found = routeAnchor(
        routes[i]!,
        (p) =>
          obstacles.some((b) => inside(b, p, 3)) ||
          routes.some((route, j) => j !== i && nearRoute(p, route, 9)),
        { limits, pad: EDGE_BOUNDS_PAD },
      );
      edge.anchor = { x: found.x - origin.x, y: found.y - origin.y };
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
  options: Record<string, string> = {},
  labelOptions: Record<string, string> = {},
  changes?: ChangeMarks,
): Promise<GraphLayout> {
  const model = buildModel(graph, changes);
  const registry = new Map<string, ElkNode>();
  const root: ElkNode = {
    id: "root",
    layoutOptions: { ...ROOT_OPTIONS, ...options },
    children: model.roots.map((id) => toElk(model, id, registry)),
    edges: [],
  };
  for (const edge of model.edges) {
    const holder = holderOf(model, edge.from, edge.to);
    const elkEdge: ElkExtendedEdge = {
      id: edge.id,
      sources: [edge.from],
      targets: [edge.to],
      // Stubs carry no label of their own: their ghost box tells what leaves or enters there.
      ...(edge.stub ? {} : { labels: [{ ...labelBox(edge.label), layoutOptions: labelOptions }] }),
    };
    (holder === "" ? root : registry.get(holder)!).edges!.push(elkEdge);
  }
  try {
    const out = await elk.layout(root);
    const described = new Map(model.edges.map((e) => [e.id, e] as const));
    const nodes = (out.children ?? []).map((child) => fromElk(model, child, described));
    const edges = edgesOf(out, described);
    const width = out.width ?? 0;
    const height = out.height ?? 0;
    placeAnchors(nodes, edges, { width, height });
    const direction = (options["elk.direction"] ?? ROOT_OPTIONS["elk.direction"]) as Direction;
    return { width, height, nodes, edges, fallback: false, direction };
  } catch (error) {
    console.warn("xpl: ELK layout failed, using a grid", error);
    return fallbackLayout(model);
  }
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
    return layoutGraph(graph, {}, {}, changes);
  const suggested: Direction = viewport.width / viewport.height < 1 ? "DOWN" : "RIGHT";
  const other: Direction = suggested === "RIGHT" ? "DOWN" : "RIGHT";
  const first = await layoutGraph(graph, { "elk.direction": suggested }, {}, changes);
  if (
    first.fallback ||
    // shown at its natural size or larger: turning it would not make the text read better
    fitScale(first, viewport, maxZoom, padding) >= 1 ||
    graph.nodes.length + graph.edges.length + graph.stubs.length > BOTH_DIRECTIONS_LIMIT
  ) {
    return first;
  }
  const second = await layoutGraph(graph, { "elk.direction": other }, {}, changes);
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
    const ca = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
    const cb = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    const label = labelBox(edge.label);
    edges.push({
      id: edge.id,
      stub: edge.stub,
      resolution: edge.resolution,
      kind: edge.kind,
      title: edge.label,
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
