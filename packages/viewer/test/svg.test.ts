import { describe, expect, it } from "vitest";
import {
  arrowHeadPath,
  openArrowHeadPath,
  roundedPath,
  routeAnchor,
  routeBox,
} from "../src/svg.js";

describe("roundedPath", () => {
  it("draws a straight route as one line", () => {
    expect(
      roundedPath([
        { x: 0, y: 0 },
        { x: 50, y: 0 },
      ]),
    ).toBe("M0 0L50 0");
    expect(roundedPath([])).toBe("");
  });

  it("rounds the corners of an orthogonal route with quadratic curves", () => {
    const d = roundedPath(
      [
        { x: 0, y: 0 },
        { x: 40, y: 0 },
        { x: 40, y: 40 },
      ],
      8,
    );
    expect(d).toBe("M0 0L32 0Q40 0 40 8L40 40");
  });

  it("shrinks the radius on short segments", () => {
    const d = roundedPath(
      [
        { x: 0, y: 0 },
        { x: 6, y: 0 },
        { x: 6, y: 100 },
      ],
      8,
    );
    expect(d).toBe("M0 0L3 0Q6 0 6 3L6 100");
  });
});

describe("arrow heads", () => {
  it("puts the tip of a filled head on the end point, pointing away from the start", () => {
    const d = arrowHeadPath({ x: 0, y: 0 }, { x: 100, y: 0 }, 10, 4);
    expect(d.startsWith("M100 0")).toBe(true);
    expect(d).toContain("L90 4");
    expect(d).toContain("L90 -4");
    expect(d.endsWith("Z")).toBe(true);
  });

  it("draws an open head as two strokes meeting at the tip", () => {
    const d = openArrowHeadPath({ x: 0, y: 0 }, { x: 100, y: 0 }, 10, 5);
    expect(d).toBe("M90 5L100 0L90 -5");
  });
});

describe("routeBox and routeAnchor", () => {
  const route = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 200, y: 100 },
  ];
  const nothing = () => false;
  const near = (p: { x: number; y: number }, x: number, y: number, tolerance = 4) =>
    Math.hypot(p.x - x, p.y - y) <= tolerance;

  it("gives the box around a route and its label", () => {
    expect(routeBox(route)).toEqual({ x: 0, y: 0, width: 200, height: 100 });
    expect(routeBox(route, { x: 150, y: 120, width: 60, height: 16 })).toEqual({
      x: 0,
      y: 0,
      width: 210,
      height: 136,
    });
  });

  it("anchors on the route point closest to the centre of its box", () => {
    // the centre (100, 50) is on the vertical run
    expect(near(routeAnchor(route, nothing), 100, 50)).toBe(true);
    // an L: the centre (100, 100) is off the route; the corner-free point nearest to it is used
    const elbow = [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 200 },
    ];
    const anchor = routeAnchor(elbow, nothing);
    expect(anchor.y === 0 || anchor.x === 200).toBe(true);
    expect(Math.hypot(anchor.x - 100, anchor.y - 100)).toBeLessThan(105);
    // limits: staying inside the canvas beats being close to the centre
    const limits = { x: 0, y: 0, width: 200, height: 200 };
    const inside = routeAnchor(route, nothing, { limits, pad: 10 });
    expect(near(inside, 100, 50)).toBe(true);
  });

  it("skips points that are vetoed and takes the next closest", () => {
    const first = routeAnchor(route, nothing);
    const vetoed = (p: { x: number; y: number }) => Math.hypot(p.x - first.x, p.y - first.y) < 20;
    const second = routeAnchor(route, vetoed);
    expect(Math.hypot(second.x - first.x, second.y - first.y)).toBeGreaterThanOrEqual(20);
    // ... and it is still on the route
    expect(second.x === 100 || second.y === 0 || second.y === 100).toBe(true);
  });

  it("falls back to the closest point when everything is vetoed", () => {
    const first = routeAnchor(route, nothing);
    expect(routeAnchor(route, () => true)).toEqual(first);
  });

  it("copes with degenerate routes", () => {
    expect(routeAnchor([], nothing)).toEqual({ x: 0, y: 0 });
    expect(routeAnchor([{ x: 3, y: 4 }], nothing)).toEqual({ x: 3, y: 4 });
    expect(
      routeAnchor(
        [
          { x: 3, y: 4 },
          { x: 3, y: 4 },
        ],
        nothing,
      ),
    ).toEqual({ x: 3, y: 4 });
  });
});
