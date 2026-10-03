/** The keyboard meets a map's boxes in reading order, by names that start with the label (M13). */
import { describe, expect, it } from "vitest";
import { boxName, readingOrder } from "../src/mapOrder.js";

describe("readingOrder", () => {
  it("goes top-down, then left to right within a row", () => {
    // ky's map as the layout lists it: Fetch API, Web servers, ky, Your app (the top box last)
    const boxes = [
      { id: "fetch", x: 40, y: 340 },
      { id: "web", x: 40, y: 510 },
      { id: "ky", x: 0, y: 170 },
      { id: "app", x: 30, y: 0 },
    ];
    expect(readingOrder(boxes).map((b) => b.id)).toEqual(["app", "ky", "fetch", "web"]);
  });

  it("boxes a few pixels apart in height are one row, read left to right", () => {
    const boxes = [
      { id: "right", x: 300, y: 102 },
      { id: "left", x: 0, y: 100 },
      { id: "below", x: 0, y: 200 },
    ];
    expect(readingOrder(boxes).map((b) => b.id)).toEqual(["left", "right", "below"]);
  });
});

describe("boxName", () => {
  it("puts the label first", () => {
    expect(boxName("Fetch API", "built-in fetch")).toBe("Fetch API, built-in fetch");
    expect(boxName("limitResponseSize", "function", "New")).toBe(
      "limitResponseSize, function, New",
    );
    expect(boxName("Errors")).toBe("Errors");
  });
});
