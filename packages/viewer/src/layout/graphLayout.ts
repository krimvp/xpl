/**
 * Graph views: `DerivedGraph` (core) -> boxes and routed edges (elkjs) that GraphView draws as SVG.
 *
 * ELK `layered`, direction RIGHT, `hierarchyHandling: INCLUDE_CHILDREN`: one pass lays out the whole
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
import { ghostId, type DerivedEdge, type DerivedGraph, type GraphNode, type Stub } from "@xpl/core";
import { textWidth } from "../measure.js";
import { nearRoute, routeAnchor, type Box, type Point } from "../svg.js";

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
  /** Ghosts: the element that joins the view when the ghost is clicked. */
  ghostTarget?: string;
  /** Ghosts: what leaves or enters the view there (`calls ×9`). */
  detail?: string;
  /** Ghosts: the same with every kind named, for the tooltip. */
  hint?: string;
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
  /** Route (start, bends, end) relative to the container that holds the edge, or the canvas. */
  points: Point[];
  label?: { text: string; x: number; y: number; width: number; height: number };
  /**
   * A point of the route that no box drawn above the edge covers: where a click on the edge lands
   * (the edge's group is built around it, so automated clicks at its centre hit the route).
   */
  anchor: Point;
}

export interface GraphLayout {
  width: number;
  height: number;
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  /** True when ELK failed and the grid fallback was used. */
  fallback: boolean;
}

// ─── Sizes ──────────────────────────────────────────────────────────────────────────────────────

/** Padding of an edge's invisible `bounds` rect (see GraphView), which anchors are chosen for. */
export const EDGE_BOUNDS_PAD = 14;

const PAD_X = 14;
const LEAF_HEIGHT = 48;
const GHOST_HEIGHT = 40;
const HEADER_HEIGHT = 34;
const CONTAINER_PAD = 14;
const LABEL_HEIGHT = 17;

const NODE_LABEL_FONT = 13;
const BADGE_FONT = 11.5;

/** Width of the kind badge pill. */
export function badgeWidth(text: string): number {
  return Math.ceil(textWidth(text, BADGE_FONT, 600)) + 12;
}

/** Width of a node label as drawn (containers place their badge after it). */
export function labelWidth(label: string): number {
  return Math.ceil(textWidth(label, NODE_LABEL_FONT, 600));
}

function nodeBadge(node: GraphNode): string {
  return node.symbolKind ?? node.kind;
}

function leafWidth(label: string, badge: string): number {
  const content = Math.max(textWidth(label, NODE_LABEL_FONT, 600), badgeWidth(badge));
  return Math.max(104, Math.ceil(content) + 2 * PAD_X);
}

function containerMinWidth(label: string, badge: string): number {
  // label, badge and the collapse button in one header row
  return (
    Math.ceil(textWidth(label, NODE_LABEL_FONT, 600) + badgeWidth(badge) + 10 + 24) + 2 * PAD_X
  );
}

function ghostWidth(label: string, detail: string): number {
  return Math.max(
    92,
    Math.ceil(Math.max(textWidth(label, 12.5, 600) + 16, textWidth(detail, 11.5, 500))) + 2 * PAD_X,
  );
}

function edgeLabelText(edge: DerivedEdge): string {
  return edge.label ? edge.label : `${edge.kind} ×${edge.count}`;
}

function stubLabelText(stub: Stub): string {
  return `${stub.kinds.join("/")} ×${stub.count}`;
}

function labelBox(text: string): { text: string; width: number; height: number } {
  return { text, width: Math.ceil(textWidth(text, 12, 500)) + 10, height: LABEL_HEIGHT };
}

// ─── Model shared by ELK and the fallback ───────────────────────────────────────────────────────

interface Model {
  roots: string[];
  children: Map<string, string[]>;
  /** Render parent (container) of every non-top-level node. */
  parent: Map<string, string>;
  nodes: Map<
    string,
    {
      label: string;
      badge: string;
      kindClass: string;
      ghostTarget?: string;
      detail?: string;
      hint?: string;
      /** Ghosts: `in` when every stub enters the view there, `out` when every stub leaves it. */
      side?: "in" | "out";
    }
  >;
  edges: {
    id: string;
    from: string;
    to: string;
    label: string;
    stub: boolean;
    resolution: string;
    kind: string;
  }[];
}

function buildModel(graph: DerivedGraph): Model {
  const nodes: Model["nodes"] = new Map();
  const children = new Map<string, string[]>();
  const parent = new Map<string, string>();
  const roots: string[] = [];
  const known = new Set(graph.nodes.map((n) => n.id));
  for (const node of graph.nodes) {
    nodes.set(node.id, {
      label: node.label,
      badge: nodeBadge(node),
      kindClass: node.symbolKind ?? node.kind,
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
  // What each ghost stands for: the kinds and the number of references that end there.
  const ghostKinds = new Map<
    string,
    { kinds: Set<string>; count: number; directions: Set<string> }
  >();
  for (const stub of graph.stubs) {
    const info = ghostKinds.get(stub.ghost) ?? {
      kinds: new Set<string>(),
      count: 0,
      directions: new Set<string>(),
    };
    stub.kinds.forEach((kind) => info.kinds.add(kind));
    info.count += stub.count;
    info.directions.add(stub.direction);
    ghostKinds.set(stub.ghost, info);
  }
  for (const edge of graph.edges) {
    if (!known.has(edge.from) || !known.has(edge.to) || seen.has(edge.id)) continue;
    seen.add(edge.id);
    edges.push({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      label: edgeLabelText(edge),
      stub: false,
      resolution: edge.resolution,
      kind: edge.kind,
    });
  }
  for (const stub of graph.stubs) {
    if (!known.has(stub.inside) || seen.has(stub.id)) continue;
    seen.add(stub.id);
    const ghost = ghostId(stub.ghost);
    if (!nodes.has(ghost)) {
      const info = ghostKinds.get(stub.ghost)!;
      nodes.set(ghost, {
        label: stub.ghostLabel,
        badge: "",
        kindClass: "ghost",
        ghostTarget: stub.ghost,
        // One kind is named; several are left to the tooltip and the details panel.
        detail: `${info.kinds.size === 1 ? `${[...info.kinds][0]} ` : ""}×${info.count}`,
        hint: `${[...info.kinds].sort().join(", ")} ×${info.count}`,
        ...(info.directions.size === 1 ? { side: [...info.directions][0] as "in" | "out" } : {}),
      });
      roots.push(ghost);
    }
    edges.push({
      id: stub.id,
      from: stub.direction === "out" ? stub.inside : ghost,
      to: stub.direction === "out" ? ghost : stub.inside,
      label: stubLabelText(stub),
      stub: true,
      resolution: "stub",
      kind: stub.kinds[0] ?? "calls",
    });
  }
  return { roots, children, parent, nodes, edges };
}

function leafSize(model: Model, id: string): { width: number; height: number } {
  const node = model.nodes.get(id)!;
  if (node.ghostTarget !== undefined) {
    return { width: ghostWidth(node.label, node.detail ?? ""), height: GHOST_HEIGHT };
  }
  return { width: leafWidth(node.label, node.badge), height: LEAF_HEIGHT };
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
    ghost: node.ghostTarget !== undefined,
    ...box,
    children,
    edges,
  };
  if (node.ghostTarget !== undefined) out.ghostTarget = node.ghostTarget;
  if (node.detail !== undefined) out.detail = node.detail;
  if (node.hint !== undefined) out.hint = node.hint;
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
  "elk.spacing.nodeNode": "34",
  "elk.spacing.edgeNode": "22",
  "elk.spacing.edgeEdge": "14",
  "elk.spacing.edgeLabel": "4",
  "elk.layered.spacing.nodeNodeBetweenLayers": "44",
  "elk.layered.spacing.edgeNodeBetweenLayers": "22",
  "elk.layered.spacing.edgeEdgeBetweenLayers": "14",
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
        "elk.nodeSize.minimum": `(${containerMinWidth(node.label, node.badge)}, ${HEADER_HEIGHT + 60})`,
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

export async function layoutGraph(
  graph: DerivedGraph,
  options: Record<string, string> = {},
  labelOptions: Record<string, string> = {},
): Promise<GraphLayout> {
  const model = buildModel(graph);
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
    return { width, height, nodes, edges, fallback: false };
  } catch (error) {
    console.warn("xpl: ELK layout failed, using a grid", error);
    return fallbackLayout(model);
  }
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
        width: Math.max(containerMinWidth(node.label, node.badge), grid.width + 2 * CONTAINER_PAD),
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
  return { ...canvas, nodes, edges, fallback: true };
}
