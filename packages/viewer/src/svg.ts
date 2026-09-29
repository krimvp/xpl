/** Small SVG path helpers shared by the graph and sequence views. */

export interface Point {
  x: number;
  y: number;
}

const fmt = (n: number): string => (Math.round(n * 100) / 100).toString();

/** A polyline with rounded corners (`radius` px, reduced on short segments). */
export function roundedPath(points: readonly Point[], radius = 8): string {
  if (points.length === 0) return "";
  const first = points[0]!;
  let d = `M${fmt(first.x)} ${fmt(first.y)}`;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!;
    const cur = points[i]!;
    const next = points[i + 1];
    if (!next) {
      d += `L${fmt(cur.x)} ${fmt(cur.y)}`;
      break;
    }
    const inLen = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const outLen = Math.hypot(next.x - cur.x, next.y - cur.y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    if (r < 0.5) {
      d += `L${fmt(cur.x)} ${fmt(cur.y)}`;
      continue;
    }
    const a = {
      x: cur.x + ((prev.x - cur.x) / inLen) * r,
      y: cur.y + ((prev.y - cur.y) / inLen) * r,
    };
    const b = {
      x: cur.x + ((next.x - cur.x) / outLen) * r,
      y: cur.y + ((next.y - cur.y) / outLen) * r,
    };
    d += `L${fmt(a.x)} ${fmt(a.y)}Q${fmt(cur.x)} ${fmt(cur.y)} ${fmt(b.x)} ${fmt(b.y)}`;
  }
  return d;
}

/** A filled triangle whose tip is `tip`, pointing away from `from`. */
export function arrowHeadPath(from: Point, tip: Point, size = 9, halfWidth = 4): string {
  const length = Math.hypot(tip.x - from.x, tip.y - from.y) || 1;
  const ux = (tip.x - from.x) / length;
  const uy = (tip.y - from.y) / length;
  const bx = tip.x - ux * size;
  const by = tip.y - uy * size;
  const px = -uy * halfWidth;
  const py = ux * halfWidth;
  return `M${fmt(tip.x)} ${fmt(tip.y)}L${fmt(bx + px)} ${fmt(by + py)}L${fmt(bx - px)} ${fmt(by - py)}Z`;
}

/** An open ("stick") arrow head: two lines from the tip. */
export function openArrowHeadPath(from: Point, tip: Point, size = 9, halfWidth = 4.5): string {
  const length = Math.hypot(tip.x - from.x, tip.y - from.y) || 1;
  const ux = (tip.x - from.x) / length;
  const uy = (tip.y - from.y) / length;
  const bx = tip.x - ux * size;
  const by = tip.y - uy * size;
  const px = -uy * halfWidth;
  const py = ux * halfWidth;
  return `M${fmt(bx + px)} ${fmt(by + py)}L${fmt(tip.x)} ${fmt(tip.y)}L${fmt(bx - px)} ${fmt(by - py)}`;
}

/** Distance from a point to a segment. */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The smallest box around a route and (optionally) its label. */
export function routeBox(points: readonly Point[], label?: Box): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (label) {
    minX = Math.min(minX, label.x);
    minY = Math.min(minY, label.y);
    maxX = Math.max(maxX, label.x + label.width);
    maxY = Math.max(maxY, label.y + label.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** True when `p` is within `distance` of the polyline `points`. */
export function nearRoute(p: Point, points: readonly Point[], distance: number): boolean {
  for (let i = 1; i < points.length; i++) {
    if (distanceToSegment(p, points[i - 1]!, points[i]!) <= distance) return true;
  }
  return false;
}

/**
 * A point on `points` (a polyline) for a click to land on, as the group of the edge is built around it: a
 * rect centred on that point that reaches around the whole route. So the best point is the one that
 * `blocked` does not veto and whose rect sticks out of `limits` (the canvas) the least, then the one
 * closest to the centre of the route's box. Candidates are sampled along every segment, off the corners.
 * When every candidate is vetoed, the best one is used anyway.
 */
export function routeAnchor(
  points: readonly Point[],
  blocked: (p: Point) => boolean,
  options: { limits?: Box; pad?: number } = {},
): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return points[0]!;
  const { limits, pad = 0 } = options;
  const box = routeBox(points);
  const goal = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const overshoot = (p: Point): number => {
    if (!limits) return 0;
    const hx = Math.max(p.x - box.x, box.x + box.width - p.x) + pad;
    const hy = Math.max(p.y - box.y, box.y + box.height - p.y) + pad;
    return (
      Math.max(0, limits.x - (p.x - hx)) +
      Math.max(0, p.x + hx - (limits.x + limits.width)) +
      Math.max(0, limits.y - (p.y - hy)) +
      Math.max(0, p.y + hy - (limits.y + limits.height))
    );
  };
  const candidates: { p: Point; over: number; d: number }[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 1) continue;
    const steps = Math.max(2, Math.min(40, Math.round(length / 8)));
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      // stay off the corners: a click there is ambiguous between two segments
      if (length >= 24 && (t * length < 6 || (1 - t) * length < 6)) continue;
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      candidates.push({ p, over: overshoot(p), d: Math.hypot(p.x - goal.x, p.y - goal.y) });
    }
  }
  if (candidates.length === 0) return points[0]!;
  // What sticks out by a few px is as good as nothing: only compare beyond that.
  const rank = (c: { over: number; d: number }) => (c.over < 4 ? 0 : c.over);
  candidates.sort((c1, c2) => rank(c1) - rank(c2) || c1.d - c2.d);
  return (candidates.find((c) => !blocked(c.p)) ?? candidates[0]!).p;
}
