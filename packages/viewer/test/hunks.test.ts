import { describe, expect, it } from "vitest";
import { hunkWords, paneHunks } from "../src/editor.js";

describe("the changes of a pane, for ‹ change 2 / 3 ›", () => {
  it("joins added lines and the removed lines next to them into one change, top to bottom", () => {
    const hunks = paneHunks({
      lines: new Map([
        [75, "changed"],
        [76, "added"],
        [106, "added"],
        [107, "added"],
      ] as const),
      removed: [
        { at: 75, place: "before", from: 75, text: ["a", "b"], count: 2 },
        { at: 65, place: "after", from: 66, text: undefined, count: 1 },
      ],
    });
    expect(hunks).toEqual([
      { from: 65, to: 65, rows: 1 },
      { from: 75, to: 76, rows: 4 },
      { from: 106, to: 107, rows: 2 },
    ]);
  });

  it("a Before pane steps through the lines the change removes; no change, no steps", () => {
    expect(paneHunks({ gone: new Set([3, 4, 9]) })).toEqual([
      { from: 3, to: 4, rows: 2 },
      { from: 9, to: 9, rows: 1 },
    ]);
    expect(paneHunks(null)).toEqual([]);
    expect(paneHunks({})).toEqual([]);
  });
});

describe("the change stepper's words", () => {
  it("counts changes on the code now, places with removed lines on the code before", () => {
    expect(hunkWords(-1, 12, false)).toBe("12 changes");
    expect(hunkWords(1, 12, false)).toBe("change 2 / 12");
    expect(hunkWords(-1, 1, false)).toBe("1 change");
    expect(hunkWords(-1, 7, true)).toBe("removed in 7 places");
    expect(hunkWords(0, 1, true)).toBe("place 1 / 1");
  });
});
