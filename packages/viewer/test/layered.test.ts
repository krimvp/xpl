import { describe, expect, it } from "vitest";
import {
  layered,
  orthogonalRoute,
  separateTracks,
  spreadPorts,
  type Port,
} from "../src/layout/layered.js";
import { distanceToSegment, type Point } from "../src/svg.js";

const PAD = { top: 10, right: 10, bottom: 10, left: 10 };
const OPTIONS = { nodeGap: 20, layerGap: 40, edgeGap: 10, pad: PAD };

/** Every segment of a route runs along x or along y. */
const rightAngled = (points: readonly Point[]) =>
  points.slice(1).every((p, i) => p.x === points[i]!.x || p.y === points[i]!.y);

describe("layered", () => {
  it("puts each arrow's target in a later layer, inside the padding", () => {
    const result = layered(
      [
        { id: "a", width: 100, height: 40 },
        { id: "b", width: 100, height: 40 },
        { id: "c", width: 100, height: 40 },
      ],
      [
        { id: "ab", from: "a", to: "b", label: { width: 60, height: 18 } },
        { id: "ac", from: "a", to: "c" },
      ],
      { ...OPTIONS, direction: "RIGHT" },
    );
    const a = result.boxes.get("a")!;
    const b = result.boxes.get("b")!;
    expect(a.x).toBeGreaterThanOrEqual(10);
    expect(a.y).toBeGreaterThanOrEqual(10);
    expect(b.x).toBeGreaterThan(a.x + a.width);
    // room for the label between the layers, and its centre between the boxes
    const label = result.routes.get("ab")!.label!;
    expect(label.x).toBeGreaterThan(a.x + a.width);
    expect(label.x).toBeLessThan(b.x);
    expect(result.routes.get("ac")!.label).toBeUndefined();
    for (const box of result.boxes.values()) {
      expect(box.x + box.width).toBeLessThanOrEqual(result.width - 10);
      expect(box.y + box.height).toBeLessThanOrEqual(result.height - 10);
    }
  });

  it("runs top to bottom when asked", () => {
    const result = layered(
      [
        { id: "a", width: 100, height: 40 },
        { id: "b", width: 100, height: 40 },
      ],
      [{ id: "ab", from: "a", to: "b" }],
      { ...OPTIONS, direction: "DOWN" },
    );
    const a = result.boxes.get("a")!;
    expect(result.boxes.get("b")!.y).toBeGreaterThan(a.y + a.height);
  });

  it("ignores arrows to boxes it was not given, and arrows from a box to itself", () => {
    const result = layered(
      [{ id: "a", width: 10, height: 10 }],
      [
        { id: "aa", from: "a", to: "a" },
        { id: "ax", from: "a", to: "x" },
      ],
      { ...OPTIONS, direction: "RIGHT" },
    );
    expect([...result.routes.keys()]).toEqual([]);
  });
});

describe("routes", () => {
  const from = { x: 0, y: 0, width: 100, height: 40 };
  const to = { x: 200, y: 100, width: 100, height: 40 };

  it("leave and enter along the main axis and turn halfway", () => {
    const route = orthogonalRoute(from, to, [], { from: 20, to: 120 }, "RIGHT");
    expect(route).toEqual([
      { x: 100, y: 20 },
      { x: 150, y: 20 },
      { x: 150, y: 120 },
      { x: 200, y: 120 },
    ]);
    const down = orthogonalRoute(
      { x: 0, y: 0, width: 100, height: 40 },
      { x: 0, y: 140, width: 100, height: 40 },
      [],
      { from: 50, to: 50 },
      "DOWN",
    );
    expect(down).toEqual([
      { x: 50, y: 40 },
      { x: 50, y: 140 },
    ]);
  });

  it("pass through the points between the layers, at right angles", () => {
    const route = orthogonalRoute(from, to, [{ x: 150, y: 70 }], { from: 20, to: 120 }, "RIGHT");
    expect(rightAngled(route)).toBe(true);
    // through the point dagre kept free between the layers (on a straight stretch of the route)
    expect(
      route.slice(1).some((q, i) => distanceToSegment({ x: 150, y: 70 }, route[i]!, q) < 0.01),
    ).toBe(true);
  });

  it("spread the ends that share a side of a box, in the order of where they go", () => {
    const boxes = new Map([["a", { x: 0, y: 0, width: 100, height: 100 }]]);
    const ports = new Map<string, Port>([
      ["low", { box: "a", side: "end", toward: 90 }],
      ["high", { box: "a", side: "end", toward: 10 }],
      ["back", { box: "a", side: "start", toward: 50 }],
    ]);
    const spread = spreadPorts(ports, boxes, "RIGHT");
    expect(spread.get("high")!).toBeLessThan(spread.get("low")!);
    expect(spread.get("back")).toBe(50);
    for (const y of spread.values()) {
      expect(y).toBeGreaterThanOrEqual(20);
      expect(y).toBeLessThanOrEqual(80);
    }
  });

  it("get tracks of their own where they turn in the same gap", () => {
    const a = orthogonalRoute(from, to, [], { from: 10, to: 110 }, "RIGHT");
    const b = orthogonalRoute(
      from,
      { x: 200, y: 200, width: 100, height: 40 },
      [],
      { from: 30, to: 220 },
      "RIGHT",
    );
    expect(a[1]!.x).toBe(b[1]!.x);
    separateTracks([a, b], "RIGHT");
    expect(a[1]!.x).not.toBe(b[1]!.x);
    expect(rightAngled(a) && rightAngled(b)).toBe(true);
    // the one that goes further down turns first, so the two do not cross
    expect(b[1]!.x).toBeLessThan(a[1]!.x);
  });
});
