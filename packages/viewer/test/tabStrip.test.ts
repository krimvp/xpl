import { describe, expect, it } from "vitest";
import { revealOffset, stepIndex, stripEdges, wheelTravel } from "../src/tabStrip.js";

describe("stripEdges: which ends of the tab strip have more tabs", () => {
  it("nothing to scroll: no cue at either end", () => {
    expect(stripEdges(0, 300, 300)).toEqual({ start: false, end: false });
    expect(stripEdges(0, 300, 400)).toEqual({ start: false, end: false });
  });

  it("at the start only the end has more; in the middle both; at the end only the start", () => {
    expect(stripEdges(0, 1000, 400)).toEqual({ start: false, end: true });
    expect(stripEdges(250, 1000, 400)).toEqual({ start: true, end: true });
    expect(stripEdges(600, 1000, 400)).toEqual({ start: true, end: false });
  });

  it("forgives the fractions of a pixel of a scaled page", () => {
    expect(stripEdges(0.4, 1000, 400)).toEqual({ start: false, end: true });
    expect(stripEdges(599.4, 1000, 400)).toEqual({ start: true, end: false });
  });
});

describe("revealOffset: scrolling a tab into sight", () => {
  const strip = (scrollLeft: number, width = 400, scrollWidth = 2000) => ({
    scrollLeft,
    width,
    scrollWidth,
  });

  it("leaves the strip alone when the tab is in sight, clear of the arrows", () => {
    expect(revealOffset(strip(500), { left: 600, right: 760 }, 44)).toBe(500);
    expect(revealOffset(strip(500), { left: 544, right: 856 }, 44)).toBe(500);
  });

  it("scrolls back for a tab hidden or under the arrow at the start, forward for the end", () => {
    expect(revealOffset(strip(500), { left: 300, right: 460 }, 44)).toBe(256);
    expect(revealOffset(strip(500), { left: 520, right: 680 }, 44)).toBe(476);
    expect(revealOffset(strip(500), { left: 1000, right: 1160 }, 44)).toBe(804);
    expect(revealOffset(strip(500), { left: 800, right: 880 }, 44)).toBe(524);
  });

  it("stays within what the strip can scroll to", () => {
    expect(revealOffset(strip(500), { left: 10, right: 120 }, 44)).toBe(0);
    expect(revealOffset(strip(0), { left: 1900, right: 2000 }, 44)).toBe(1600);
  });

  it("centres a tab that fits the strip but not with the arrows", () => {
    // 340 wide in 400: no room for two arrows of 44, but it can be seen whole.
    expect(revealOffset(strip(0), { left: 700, right: 1040 }, 44)).toBe(670);
  });

  it("shows a tab wider than the strip from its start, clear of the arrow", () => {
    expect(revealOffset(strip(0), { left: 700, right: 1150 }, 44)).toBe(656);
    expect(revealOffset(strip(900), { left: 700, right: 1150 }, 44)).toBe(656);
  });

  it("copes with a strip with nothing to scroll", () => {
    expect(revealOffset(strip(0, 400, 400), { left: 20, right: 180 }, 44)).toBe(0);
  });
});

describe("wheelTravel: the wheel over the strip", () => {
  it("turns the up-and-down travel of a wheel into sideways travel, in pixels", () => {
    expect(wheelTravel({ deltaX: 0, deltaY: 100, deltaMode: 0 }, 500)).toBe(100);
    expect(wheelTravel({ deltaX: 0, deltaY: -120, deltaMode: 0 }, 500)).toBe(-120);
    expect(wheelTravel({ deltaX: 3, deltaY: 40, deltaMode: 0 }, 500)).toBe(40);
  });

  it("counts lines and pages", () => {
    expect(wheelTravel({ deltaX: 0, deltaY: 3, deltaMode: 1 }, 500)).toBe(48);
    expect(wheelTravel({ deltaX: 0, deltaY: 1, deltaMode: 2 }, 500)).toBe(500);
  });

  it("leaves a sideways gesture to the browser", () => {
    expect(wheelTravel({ deltaX: 60, deltaY: 2, deltaMode: 0 }, 500)).toBeUndefined();
    expect(wheelTravel({ deltaX: -30, deltaY: 30, deltaMode: 0 }, 500)).toBeUndefined();
    expect(wheelTravel({ deltaX: 0, deltaY: 0, deltaMode: 0 }, 500)).toBeUndefined();
  });
});

describe("stepIndex: the arrow keys along tabs and menu entries", () => {
  const row = { prev: "ArrowLeft", next: "ArrowRight" };

  it("steps and wraps round", () => {
    expect(stepIndex("ArrowRight", 0, 5, row)).toBe(1);
    expect(stepIndex("ArrowRight", 4, 5, row)).toBe(0);
    expect(stepIndex("ArrowLeft", 3, 5, row)).toBe(2);
    expect(stepIndex("ArrowLeft", 0, 5, row)).toBe(4);
  });

  it("Home and End jump", () => {
    expect(stepIndex("Home", 3, 5, row)).toBe(0);
    expect(stepIndex("End", 1, 5, row)).toBe(4);
  });

  it("starts at an end when nothing has the focus", () => {
    expect(stepIndex("ArrowRight", -1, 5, row)).toBe(0);
    expect(stepIndex("ArrowLeft", -1, 5, row)).toBe(4);
  });

  it("ignores other keys, other directions and an empty row", () => {
    expect(stepIndex("ArrowDown", 1, 5, row)).toBeUndefined();
    expect(stepIndex("a", 1, 5, row)).toBeUndefined();
    expect(stepIndex("ArrowRight", -1, 0, row)).toBeUndefined();
    expect(stepIndex("ArrowDown", 1, 5, { prev: "ArrowUp", next: "ArrowDown" })).toBe(2);
  });
});
