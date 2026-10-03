import { describe, expect, it } from "vitest";
import {
  fitTransform,
  MIN_ZOOM,
  rawFitScale,
  READABLE_FLOOR,
  READABLE_ZOOM,
  boxInView,
  FRAME_SHRINK,
  frameView,
  reveal,
  settle,
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

describe("frameView: the first view of a diagram", () => {
  const at = (box: Box | undefined, content = { width: 4000, height: 3000 }) =>
    frameView(PANE, content, box && { boxes: [box] }, OPTIONS)!;

  it("is the fit for a diagram that fits at a readable size", () => {
    // 1000 x 400: fit scale 0.692, above the floor
    const content = { width: 1000, height: 400 };
    const view = frameView(PANE, content, undefined, OPTIONS)!;
    expect(view).toMatchObject({ partial: false, hidden: 0 });
    expect(view.transform).toEqual(fitTransform(PANE, content, OPTIONS));
    // just above the floor still fits; just below it does not
    const edge = 692 / READABLE_FLOOR;
    expect(frameView(PANE, { width: edge - 1, height: 100 }, undefined, OPTIONS)!.partial).toBe(
      false,
    );
    expect(frameView(PANE, { width: edge + 1, height: 100 }, undefined, OPTIONS)!.partial).toBe(
      true,
    );
  });

  it("without a focus, starts at the readable zoom on the top-left corner", () => {
    const content = { width: 2500, height: 1800 };
    expect(rawFitScale(PANE, content, 24)).toBeLessThan(READABLE_FLOOR);
    const view = frameView(PANE, content, undefined, OPTIONS)!;
    expect(view.partial).toBe(true);
    expect(view.transform).toEqual({ k: READABLE_ZOOM, x: 24, y: 24 });
  });

  it("the whole-diagram floor and the zoom can be chosen", () => {
    const content = { width: 1000, height: 400 };
    const view = frameView(PANE, content, undefined, { ...OPTIONS, whole: 0.8, readable: 1 })!;
    expect(view.partial).toBe(true);
    expect(view.transform.k).toBe(1);
    expect(frameView(PANE, content, undefined, { ...OPTIONS, whole: 0.5 })!.partial).toBe(false);
  });

  it("centres an axis on which the diagram fits at that zoom, like a fit", () => {
    const view = frameView(PANE, { width: 300, height: 3000 }, undefined, OPTIONS)!;
    expect(view.transform.x).toBeCloseTo((740 - 300 * READABLE_ZOOM) / 2, 5);
    expect(view.transform.y).toBeCloseTo(24, 5);
  });

  it("stays at the corner when the focus is in the first window", () => {
    expect(at({ x: 100, y: 80, width: 200, height: 100 }).transform).toMatchObject({
      x: 24,
      y: 24,
    });
  });

  it("moves the window to a focus out of sight, centred on it, never past the end", () => {
    const box = { x: 2000, y: 1500, width: 200, height: 100 };
    const view = at(box);
    expect(view.transform.k).toBe(READABLE_ZOOM);
    expect(boxInView(view.transform, PANE, box)).toBe(true);
    expect((24 - view.transform.x) / READABLE_ZOOM).toBeCloseTo(2100 - VISIBLE.w / 2, 5);
    const end = at({ x: 3900, y: 2950, width: 100, height: 50 });
    expect((24 - end.transform.x) / READABLE_ZOOM).toBeCloseTo(4000 - VISIBLE.w, 5);
    expect((24 - end.transform.y) / READABLE_ZOOM).toBeCloseTo(3000 - VISIBLE.h, 5);
  });

  it("frames the focus and its neighbours together, down to 0.7 of the readable zoom", () => {
    const focus = { x: 2000, y: 1500, width: 200, height: 100 };
    const left = { x: 1400, y: 1500, width: 200, height: 100 };
    const right = { x: 2600, y: 1500, width: 200, height: 100 };
    const view = frameView(
      PANE,
      { width: 4000, height: 3000 },
      { boxes: [focus], neighbours: [left, right] },
      OPTIONS,
    )!;
    // 1400 units wide: (740 - 48) / 1400 = 0.494, not below 0.75 * 0.7 = 0.525: only one neighbour fits
    expect(view.transform.k).toBeGreaterThanOrEqual(READABLE_ZOOM * FRAME_SHRINK - 1e-9);
    expect(boxInView(view.transform, PANE, focus)).toBe(true);
    const shown = [left, right].filter((box) => boxInView(view.transform, PANE, box));
    expect(shown).toHaveLength(1);
    expect(view).toMatchObject({ hidden: 0, context: 1 });
    // with room for both, both are in, at the readable zoom or less
    const near = frameView(
      PANE,
      { width: 4000, height: 3000 },
      {
        boxes: [focus],
        neighbours: [
          { ...left, x: 1700 },
          { ...right, x: 2300 },
        ],
      },
      OPTIONS,
    )!;
    expect(near.context).toBe(2);
    expect(near.transform.k).toBeLessThanOrEqual(READABLE_ZOOM);
  });

  it("never shrinks a frame below the text size readableMin promises (a Present flow)", () => {
    const focus = { x: 2000, y: 1500, width: 200, height: 100 };
    const left = { x: 1700, y: 1500, width: 200, height: 100 };
    const right = { x: 2300, y: 1500, width: 200, height: 100 };
    const view = frameView(
      PANE,
      { width: 4000, height: 3000 },
      { boxes: [focus], neighbours: [left, right] },
      { ...OPTIONS, readable: 1, readableMin: 1 },
    )!;
    // both neighbours would fit at 0.7, but the promise is 1: the frame stays at 1 and keeps fewer of them
    expect(view.transform.k).toBeCloseTo(1, 5);
    expect(boxInView(view.transform, PANE, focus)).toBe(true);
  });

  it("frames the union of several focused elements when it fits, else the first and counts the rest", () => {
    const a = { x: 1000, y: 1000, width: 200, height: 100 };
    const b = { x: 1500, y: 1100, width: 200, height: 100 };
    const both = frameView(PANE, { width: 4000, height: 3000 }, { boxes: [a, b] }, OPTIONS)!;
    expect(both.hidden).toBe(0);
    expect(boxInView(both.transform, PANE, a) && boxInView(both.transform, PANE, b)).toBe(true);
    const far = { x: 3500, y: 2800, width: 200, height: 100 };
    const apart = frameView(PANE, { width: 4000, height: 3000 }, { boxes: [a, far] }, OPTIONS)!;
    expect(apart.hidden).toBe(1);
    expect(boxInView(apart.transform, PANE, a)).toBe(true);
  });

  it("shows the whole diagram when a frame would be no larger", () => {
    // fits whole at 0.55 (below the floor), the two far corners need less than that
    const content = { width: 1258, height: 700 };
    const view = frameView(
      PANE,
      content,
      {
        boxes: [
          { x: 0, y: 0, width: 50, height: 50 },
          { x: 1208, y: 650, width: 50, height: 50 },
        ],
      },
      OPTIONS,
    )!;
    expect(view.partial).toBe(false);
    expect(view.transform).toEqual(fitTransform(PANE, content, OPTIONS));
  });

  it("a focus too big for the pane shows its core", () => {
    const size = { w: 400, h: 300 };
    const content = { width: 3000, height: 2000 };
    const options = { padding: 20, readable: 1, whole: 0.9, maxZoom: 1.25 };
    const core = { x: 1500, y: 100, width: 100, height: 40 };
    const far = frameView(
      size,
      content,
      { boxes: [{ x: 0, y: 100, width: 2000, height: 40 }], core },
      options,
    )!;
    expect(far.transform.k).toBe(1);
    expect(-far.transform.x).toBeLessThanOrEqual(1500);
    expect(-far.transform.x + 400).toBeGreaterThanOrEqual(1600);
  });

  it("has nothing to say about a pane that is not measured yet", () => {
    expect(
      frameView({ w: 0, h: 0 }, { width: 10, height: 10 }, undefined, OPTIONS),
    ).toBeUndefined();
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

describe("settle and reveal (zooming, and the selection kept in sight)", () => {
  it("centres a diagram that fits, and leaves no empty band beside one that does not", () => {
    const small = settle({ k: 0.5, x: 0, y: 300 }, PANE, { width: 400, height: 400 }, 24);
    expect(small).toEqual({ k: 0.5, x: (740 - 200) / 2, y: (460 - 200) / 2 });
    // zoomed out towards the top: the diagram (2000 x 1000 at 0.4 = 800 x 400) moves up, not down
    const tall = settle({ k: 0.4, x: -20, y: 250 }, PANE, { width: 2000, height: 1000 }, 24);
    expect(tall.y).toBeCloseTo((460 - 400) / 2, 5);
    expect(tall.x).toBe(-20);
    const big = settle({ k: 1, x: 100, y: -5000 }, PANE, { width: 2000, height: 1000 }, 24);
    expect(big).toEqual({ k: 1, x: 24, y: 460 - 24 - 1000 });
  });

  it("pans just enough to show a box out of sight, and leaves a box in sight alone", () => {
    const t = { k: 1, x: 0, y: 0 };
    const inside = { x: 100, y: 100, width: 100, height: 50 };
    expect(reveal(t, PANE, inside, 32)).toEqual(t);
    const right = reveal(t, PANE, { x: 1000, y: 100, width: 100, height: 50 }, 32);
    expect(right).toEqual({ k: 1, x: 740 - 32 - 1100, y: 0 });
    expect(boxInView(right, PANE, { x: 1000, y: 100, width: 100, height: 50 })).toBe(true);
    const above = reveal(t, PANE, { x: 100, y: -300, width: 100, height: 50 }, 32);
    expect(above.y).toBe(332);
  });
});
