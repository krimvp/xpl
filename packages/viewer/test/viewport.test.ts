import { describe, expect, it } from "vitest";
import {
  fitTransform,
  MIN_ZOOM,
  rawFitScale,
  READABLE_FLOOR,
  READABLE_ZOOM,
  startView,
  unionBox,
  type Box,
} from "../src/viewport.js";

const PANE = { w: 740, h: 460 };
const OPTIONS = { padding: 24, maxZoom: 1.25 };
/** Visible part of the diagram at the readable zoom: (740 - 48) / 0.75 by (460 - 48) / 0.75. */
const VISIBLE = { w: 692 / READABLE_ZOOM, h: 412 / READABLE_ZOOM };

describe("fitTransform", () => {
  it("shows all of the diagram, centred, at most enlarged to maxZoom", () => {
    // 1384 x 412 units: width decides, 692 / 1384 = 0.5
    const wide = fitTransform(PANE, { width: 1384, height: 412 }, OPTIONS)!;
    expect(wide.k).toBeCloseTo(0.5, 5);
    expect(wide.x).toBeCloseTo(24, 5);
    expect(wide.y).toBeCloseTo((460 - 412 * 0.5) / 2, 5);
    // a small diagram is enlarged, but only up to the cap, and centred
    const small = fitTransform(PANE, { width: 100, height: 100 }, OPTIONS)!;
    expect(small.k).toBe(1.25);
    expect(small.x).toBeCloseTo((740 - 125) / 2, 5);
    expect(fitTransform(PANE, { width: 100, height: 100 }, { ...OPTIONS, maxZoom: 1.6 })!.k).toBe(
      1.6,
    );
  });

  it("never goes below the minimum zoom, and keeps a short diagram off the very top edge", () => {
    expect(fitTransform(PANE, { width: 100000, height: 100 }, OPTIONS)!.k).toBe(MIN_ZOOM);
    const tall = fitTransform(PANE, { width: 300, height: 412 }, OPTIONS)!;
    expect(tall.y).toBeGreaterThanOrEqual(12);
  });

  it("has nothing to say about a pane that is not measured yet or an empty diagram", () => {
    expect(fitTransform({ w: 0, h: 0 }, { width: 100, height: 100 }, OPTIONS)).toBeUndefined();
    expect(fitTransform(PANE, { width: 0, height: 100 }, OPTIONS)).toBeUndefined();
    expect(rawFitScale(PANE, { width: 0, height: 0 }, 24)).toBe(0);
  });
});

describe("startView", () => {
  it("is the fit for a diagram that fits at a readable size", () => {
    // 1000 x 400: fit scale 0.692, above the floor
    const content = { width: 1000, height: 400 };
    const view = startView(PANE, content, undefined, OPTIONS)!;
    expect(view.partial).toBe(false);
    expect(view.transform).toEqual(fitTransform(PANE, content, OPTIONS));
    // just above the floor still fits; just below it does not
    const edge = 692 / READABLE_FLOOR;
    expect(startView(PANE, { width: edge - 1, height: 100 }, undefined, OPTIONS)!.partial).toBe(
      false,
    );
    expect(startView(PANE, { width: edge + 1, height: 100 }, undefined, OPTIONS)!.partial).toBe(
      true,
    );
  });

  it("starts at the readable zoom, on the top-left corner, when the fit scale is below the floor", () => {
    // 2500 x 300: fits at 0.277
    const content = { width: 2500, height: 1800 };
    expect(rawFitScale(PANE, content, 24)).toBeLessThan(READABLE_FLOOR);
    const view = startView(PANE, content, undefined, OPTIONS)!;
    expect(view.partial).toBe(true);
    expect(view.transform.k).toBe(READABLE_ZOOM);
    // the corner of the diagram sits at the padding
    expect(view.transform.x).toBeCloseTo(24, 5);
    expect(view.transform.y).toBeCloseTo(24, 5);
  });

  it("the floor and the zoom can be chosen", () => {
    const content = { width: 1000, height: 400 };
    const view = startView(PANE, content, undefined, { ...OPTIONS, floor: 0.8, readable: 1 })!;
    expect(view.partial).toBe(true);
    expect(view.transform.k).toBe(1);
    expect(startView(PANE, content, undefined, { ...OPTIONS, floor: 0.5 })!.partial).toBe(false);
  });

  it("an axis on which the diagram fits at that zoom is centred, like a fit", () => {
    // tall and narrow: 300 wide fits at 0.75 (225 <= 692), 3000 tall does not
    const view = startView(PANE, { width: 300, height: 3000 }, undefined, OPTIONS)!;
    expect(view.partial).toBe(true);
    expect(view.transform.x).toBeCloseTo((740 - 300 * READABLE_ZOOM) / 2, 5);
    expect(view.transform.y).toBeCloseTo(24, 5);
    // wide and flat: the other way round
    const flat = startView(PANE, { width: 4000, height: 200 }, undefined, OPTIONS)!;
    expect(flat.transform.x).toBeCloseTo(24, 5);
    expect(flat.transform.y).toBeCloseTo((460 - 200 * READABLE_ZOOM) / 2, 5);
  });

  const content = { width: 4000, height: 3000 };
  const at = (box: Box) => startView(PANE, content, box, OPTIONS)!.transform;
  /** Diagram unit at the pane's left / top edge padding, i.e. where the window starts. */
  const windowLeft = (x: number) => (24 - x) / READABLE_ZOOM;
  const windowTop = (y: number) => (24 - y) / READABLE_ZOOM;

  it("stays at the corner when what should be seen is in the first window", () => {
    const view = at({ x: 100, y: 80, width: 200, height: 100 });
    expect(view.x).toBeCloseTo(24, 5);
    expect(view.y).toBeCloseTo(24, 5);
  });

  it("moves the window to what should be seen when it is out of sight: centred on it", () => {
    const box = { x: 2000, y: 1500, width: 200, height: 100 };
    const view = at(box);
    expect(windowLeft(view.x)).toBeCloseTo(2100 - VISIBLE.w / 2, 5);
    expect(windowTop(view.y)).toBeCloseTo(1550 - VISIBLE.h / 2, 5);
    // the box is inside the window on screen
    const left = view.x + box.x * READABLE_ZOOM;
    const right = left + box.width * READABLE_ZOOM;
    expect(left).toBeGreaterThanOrEqual(24);
    expect(right).toBeLessThanOrEqual(740 - 24);
    const top = view.y + box.y * READABLE_ZOOM;
    expect(top).toBeGreaterThanOrEqual(24);
    expect(top + box.height * READABLE_ZOOM).toBeLessThanOrEqual(460 - 24);
  });

  it("does not move past the end of the diagram", () => {
    const view = at({ x: 3900, y: 2950, width: 100, height: 50 });
    expect(windowLeft(view.x)).toBeCloseTo(4000 - VISIBLE.w, 5);
    expect(windowTop(view.y)).toBeCloseTo(3000 - VISIBLE.h, 5);
  });

  it("moves only along the axis on which the box is out of sight", () => {
    const view = at({ x: 100, y: 2000, width: 200, height: 100 });
    expect(view.x).toBeCloseTo(24, 5);
    expect(windowTop(view.y)).toBeCloseTo(2050 - VISIBLE.h / 2, 5);
  });

  it("aligns the start of a box that is larger than the window", () => {
    const view = at({ x: 1000, y: 700, width: 2000, height: 2000 });
    expect(windowLeft(view.x)).toBeCloseTo(1000, 5);
    expect(windowTop(view.y)).toBeCloseTo(700, 5);
  });

  it("has nothing to say about a pane that is not measured yet", () => {
    expect(startView({ w: 0, h: 0 }, content, undefined, OPTIONS)).toBeUndefined();
  });
});

describe("unionBox", () => {
  it("is the smallest box around the boxes", () => {
    expect(unionBox([])).toBeUndefined();
    expect(unionBox([{ x: 10, y: 20, width: 30, height: 40 }])).toEqual({
      x: 10,
      y: 20,
      width: 30,
      height: 40,
    });
    expect(
      unionBox([
        { x: 10, y: 20, width: 30, height: 40 },
        { x: 100, y: 5, width: 10, height: 10 },
      ]),
    ).toEqual({ x: 10, y: 5, width: 100, height: 55 });
  });
});
