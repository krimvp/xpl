import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { SearchQuery } from "@codemirror/search";
import { findCountWords, hunkWords, paneHunks } from "../src/editor.js";

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

describe("the find panel's count", () => {
  const doc = "go();\nstop();\ngo(go);\n";
  it("says how many matches, and which one is selected", () => {
    const query = new SearchQuery({ search: "go" });
    expect(findCountWords(EditorState.create({ doc }), query)).toBe("3 matches");
    const third = doc.lastIndexOf("go");
    const at = EditorState.create({ doc, selection: { anchor: third, head: third + 2 } });
    expect(findCountWords(at, query)).toBe("3 of 3");
    expect(findCountWords(at, new SearchQuery({ search: "nothing" }))).toBe("No matches");
    expect(findCountWords(at, new SearchQuery({ search: "" }))).toBe("");
  });
});
