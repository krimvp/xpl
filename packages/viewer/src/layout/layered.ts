/**
 * One level of a layered ("Sugiyama") layout, on dagre (MIT): boxes of known size and the arrows between
 * them in, positions and right-angled routes out. graphLayout.ts runs it once per container (and once for
 * the canvas), flowLayout.ts once per flow.
 *
 * dagre places the boxes in layers (ranks) along the main axis and gives each arrow the points it passes
 * through between the layers (and its label's centre). `orthogonalRoute` turns those points into a route of
 * horizontal and vertical segments that leaves its first box and enters its last on the sides that face the
 * layers in between, and `spreadPorts` spreads the arrows that share a side of a box along it, so they do not
 * all start at its middle.
 */
import dagre from "@dagrejs/dagre";
import type { Box, Point } from "../svg.js";

/** Which way the layers run: `RIGHT` (columns, left to right) or `DOWN` (rows, top to bottom). */
export type Direction = "RIGHT" | "DOWN";

export interface LayeredNode {
  id: string;
  width: number;
  height: number;
}

export interface LayeredEdge {
  id: string;
  from: string;
  to: string;
  /** The size of the label, when the arrow has one: dagre keeps room for it between the layers. */
  label?: { width: number; height: number };
  /** How many layers the arrow spans at least (default 1). */
  minlen?: number;
  /** How much dagre tries to keep the arrow short and straight (default 1). */
  weight?: number;
}

export interface LayeredOptions {
  direction: Direction;
  /** Space between boxes of one layer. */
  nodeGap: number;
  /** Space between layers. */
  layerGap: number;
  /** Space between arrows that run side by side. */
  edgeGap: number;
  /** Space around the whole level, per side. */
  pad: { top: number; right: number; bottom: number; left: number };
}

export interface LayeredResult {
  width: number;
  height: number;
  /** Top-left corners and sizes, in the level's coordinates (the padding included). */
  boxes: Map<string, Box>;
  /**
   * Per arrow: the points dagre routes it through between its two boxes (without the two ends on the
   * boxes), and the centre of its label.
   */
  routes: Map<string, { via: Point[]; label?: Point }>;
}

/**
 * The layer index of each box (0 = the first layer), read off the positions: dagre puts the centres of the
 * boxes of one layer on one line.
 */
export function layerIndex(result: LayeredResult, direction: Direction): Map<string, number> {
  const { main } = axes(direction);
  const centre = (b: Box) => Math.round(main === "x" ? b.x + b.width / 2 : b.y + b.height / 2);
  const lines = [...new Set([...result.boxes.values()].map(centre))].sort((a, b) => a - b);
  return new Map([...result.boxes].map(([id, box]) => [id, lines.indexOf(centre(box))]));
}

/** Space kept free around an arrow's label along the arrow. */
const LABEL_AIR = 28;

/** Lays out one level. The boxes keep the order they are given in where the layering leaves a choice. */
export function layered(
  nodes: readonly LayeredNode[],
  edges: readonly LayeredEdge[],
  options: LayeredOptions,
): LayeredResult {
  const g = new dagre.graphlib.Graph({ multigraph: true, directed: true });
  g.setGraph({
    rankdir: options.direction === "RIGHT" ? "LR" : "TB",
    nodesep: options.nodeGap,
    ranksep: options.layerGap,
    edgesep: options.edgeGap,
    marginx: 0,
    marginy: 0,
  });
  const known = new Set<string>();
  for (const node of nodes) {
    g.setNode(node.id, { width: node.width, height: node.height });
    known.add(node.id);
  }
  for (const edge of edges) {
    if (!known.has(edge.from) || !known.has(edge.to) || edge.from === edge.to) continue;
    g.setEdge(
      edge.from,
      edge.to,
      {
        minlen: edge.minlen ?? 1,
        weight: edge.weight ?? 1,
        labelpos: "c",
        // room around the label, so that the arrow shows on both sides of it
        width: edge.label ? edge.label.width + LABEL_AIR : 0,
        height: edge.label ? edge.label.height + LABEL_AIR / 2 : 0,
      },
      edge.id,
    );
  }
  dagre.layout(g);
  const { left, top, right, bottom } = options.pad;
  const boxes = new Map<string, Box>();
  for (const node of nodes) {
    const placed = g.node(node.id) as { x: number; y: number; width: number; height: number };
    boxes.set(node.id, {
      x: left + placed.x - placed.width / 2,
      y: top + placed.y - placed.height / 2,
      width: placed.width,
      height: placed.height,
    });
  }
  const routes: LayeredResult["routes"] = new Map();
  for (const e of g.edges()) {
    const label = g.edge(e) as { points?: Point[]; x?: number; y?: number; width?: number };
    const points = (label.points ?? []).map((p) => ({ x: p.x + left, y: p.y + top }));
    routes.set(e.name!, {
      // the first and last points are on the boxes; the route builder picks its own
      via: points.slice(1, -1),
      ...(label.width && label.x !== undefined && label.y !== undefined
        ? { label: { x: label.x + left, y: label.y + top } }
        : {}),
    });
  }
  const size = g.graph() as { width?: number; height?: number };
  const contentWidth = Math.max(0, ...[...boxes.values()].map((b) => b.x + b.width - left));
  const contentHeight = Math.max(0, ...[...boxes.values()].map((b) => b.y + b.height - top));
  return {
    width: left + Math.max(size.width ?? 0, contentWidth) + right,
    height: top + Math.max(size.height ?? 0, contentHeight) + bottom,
    boxes,
    routes,
  };
}

// ─── Routes ─────────────────────────────────────────────────────────────────────────────────────

type Axis = "x" | "y";
const axes = (direction: Direction): { main: Axis; cross: Axis } =>
  direction === "RIGHT" ? { main: "x", cross: "y" } : { main: "y", cross: "x" };

const at = (main: Axis, m: number, c: number): Point =>
  main === "x" ? { x: m, y: c } : { x: c, y: m };

/** The side of a box an arrow uses: `end` faces the next layers (right or bottom), `start` the previous. */
export type Side = "start" | "end";

/** One end of an arrow on a box: which box, which side, and where it is going (to sort the ends of a side). */
export interface Port {
  box: string;
  side: Side;
  /** The cross coordinate of the point the arrow heads for: ports on one side are ordered by it. */
  toward: number;
}

/** Which side of `box` an arrow that heads for `toward` uses. */
export function sideToward(box: Box, toward: Point, direction: Direction): Side {
  const { main } = axes(direction);
  const centre = main === "x" ? box.x + box.width / 2 : box.y + box.height / 2;
  return toward[main] >= centre ? "end" : "start";
}

/**
 * The cross coordinate of every port, by `edgeId:from` / `edgeId:to`: the ports of one side of one box are
 * spread evenly in the order of where they go, so arrows leave side by side. Wide ports use more of
 * the box side when automatic routes need a clear lane; saved pins keep the original middle 60%.
 */
export function spreadPorts(
  ports: ReadonlyMap<string, Port>,
  boxes: ReadonlyMap<string, Box>,
  direction: Direction,
  wide = false,
): Map<string, number> {
  const { cross } = axes(direction);
  const groups = new Map<string, string[]>();
  for (const [key, port] of ports) {
    const group = `${port.box}\0${port.side}`;
    const list = groups.get(group);
    if (list) list.push(key);
    else groups.set(group, [key]);
  }
  const out = new Map<string, number>();
  for (const keys of groups.values()) {
    const box = boxes.get(ports.get(keys[0]!)!.box)!;
    const start = cross === "y" ? box.y : box.x;
    const size = cross === "y" ? box.height : box.width;
    keys.sort((a, b) => ports.get(a)!.toward - ports.get(b)!.toward || (a < b ? -1 : 1));
    keys.forEach((key, i) => {
      const fraction = wide
        ? keys.length === 1
          ? 0.5
          : 0.15 + (0.7 * i) / (keys.length - 1)
        : 0.2 + (0.6 * (i + 1)) / (keys.length + 1);
      out.set(key, start + size * fraction);
    });
  }
  return out;
}

/**
 * A right-angled route from the `from` box to the `to` box through dagre's points: it leaves `from` and enters
 * `to` along the main axis, at the given cross coordinates (`spreadPorts`), and turns halfway between layers.
 */
export function orthogonalRoute(
  from: Box,
  to: Box,
  via: readonly Point[],
  ports: { from: number; to: number },
  direction: Direction,
  sides: { from?: Side; to?: Side } = {},
): Point[] {
  const { main, cross } = axes(direction);
  const lo = (b: Box) => (main === "x" ? b.x : b.y);
  const hi = (b: Box) => (main === "x" ? b.x + b.width : b.y + b.height);
  const centre = (b: Box) => (main === "x" ? b.x + b.width / 2 : b.y + b.height / 2);
  const first = via[0] ?? at(main, centre(to), ports.to);
  const last = via[via.length - 1] ?? at(main, centre(from), ports.from);
  const fromSide = sides.from ?? (first[main] >= centre(from) ? "end" : "start");
  const toSide = sides.to ?? (last[main] <= centre(to) ? "start" : "end");
  const start = at(main, fromSide === "end" ? hi(from) : lo(from), ports.from);
  const end = at(main, toSide === "start" ? lo(to) : hi(to), ports.to);
  const points = [start, ...via, end];
  const out: Point[] = [start];
  for (let i = 1; i < points.length; i++) {
    const p = out[out.length - 1]!;
    const q = points[i]!;
    if (Math.abs(p[cross] - q[cross]) > 0.5 && Math.abs(p[main] - q[main]) > 0.5) {
      const turn = (p[main] + q[main]) / 2;
      out.push(at(main, turn, p[cross]), at(main, turn, q[cross]));
    } else if (Math.abs(p[cross] - q[cross]) > 0.5) {
      // the same layer coordinate (a turn back): step out along the main axis first
      out.push(at(main, p[main], q[cross]));
    }
    out.push(q);
  }
  return simplify(out);
}

/** Drops repeated points and the middle point of three in a line. */
function simplify(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.x - p.x) < 0.01 && Math.abs(prev.y - p.y) < 0.01) continue;
    const before = out[out.length - 2];
    if (
      prev &&
      before &&
      ((Math.abs(before.x - prev.x) < 0.01 && Math.abs(prev.x - p.x) < 0.01) ||
        (Math.abs(before.y - prev.y) < 0.01 && Math.abs(prev.y - p.y) < 0.01))
    ) {
      out[out.length - 1] = p;
      continue;
    }
    out.push(p);
  }
  return out;
}

/**
 * Gives arrows that turn in the same gap between layers tracks of their own: without it, every arrow that
 * leaves a box turns halfway and they run on top of each other. A turn is a segment across the main axis
 * between two segments along it; the turns at one place are spread over the room their neighbours leave,
 * ordered so that arrows that fan out do not cross (the one going furthest turns first).
 */
export function separateTracks(routes: Point[][], direction: Direction, gap = 8): void {
  const { main, cross } = axes(direction);
  interface Turn {
    route: Point[];
    i: number;
    lo: number;
    hi: number;
    key: number;
  }
  const turns: Turn[] = [];
  for (const route of routes) {
    for (let i = 1; i + 1 < route.length; i++) {
      const a = route[i]!;
      const b = route[i + 1]!;
      const before = route[i - 1]!;
      const after = route[i + 2];
      // a segment across the main axis, between two along it
      if (Math.abs(a[main] - b[main]) > 0.5 || Math.abs(a[cross] - b[cross]) < 0.5) continue;
      if (
        Math.abs(before[cross] - a[cross]) > 0.5 ||
        !after ||
        Math.abs(after[cross] - b[cross]) > 0.5
      )
        continue;
      const lo = Math.min(before[main], after[main]);
      const hi = Math.max(before[main], after[main]);
      // going down (or right) along the cross axis: the furthest one turns first
      const down = b[cross] > a[cross];
      turns.push({ route, i, lo, hi, key: down ? -a[cross] : a[cross] });
    }
  }
  const groups = new Map<number, Turn[]>();
  for (const turn of turns) {
    const at = Math.round(turn.route[turn.i]![main]);
    const list = groups.get(at);
    if (list) list.push(turn);
    else groups.set(at, [turn]);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const lo = Math.max(...list.map((t) => t.lo)) + gap;
    const hi = Math.min(...list.map((t) => t.hi)) - gap;
    if (hi - lo < list.length) continue;
    list.sort((a, b) => a.key - b.key);
    list.forEach((turn, n) => {
      const value = lo + ((hi - lo) * (n + 1)) / (list.length + 1);
      turn.route[turn.i]![main] = value;
      turn.route[turn.i + 1]![main] = value;
    });
  }
}
