import { describe, expect, it } from "vitest";
import { markParts, plainText, snippet, symbolRank, testTitle } from "../src/searchSnippet.js";

describe("search result text", () => {
  it("shows a step's Markdown as the words a reader sees", () => {
    expect(
      plainText(
        "### A patch replaces `only` the fields\n\n`mergeExisting` copies **all** of [it](x.md).",
      ),
    ).toBe("A patch replaces only the fields mergeExisting copies all of it.");
  });

  it("starts and ends the snippet on a word, with one ellipsis glyph", () => {
    const text = `${"lorem ipsum ".repeat(10)}draws boxes and steps from the code ${"dolor sit ".repeat(50)}`;
    const cut = snippet(text, "steps");
    expect(cut.startsWith("…")).toBe(true);
    expect(cut.slice(1, cut.indexOf(" "))).toMatch(/^(lorem|ipsum)$/);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.slice(cut.lastIndexOf(" ") + 1, -1)).toMatch(/^(dolor|sit)$/);
  });

  it("cuts minified code where it must, near the match", () => {
    const cut = snippet(`${"x".repeat(1000)}needle`, "needle");
    expect(cut).toBe(`…${"x".repeat(80)}needle`);
  });

  it("names a test case by its describe titles joined with ›", () => {
    const symbols = new Map([
      ["a", { path: "regeneration on the $name fixture" }],
      ["b", { path: "regeneration on the $name fixture.on their own", parent: "a" }],
      [
        "c",
        { path: "regeneration on the $name fixture.on their own.maxRetries changed", parent: "b" },
      ],
    ]);
    expect(testTitle({ symbol: (id) => symbols.get(id) }, "c")).toBe(
      "regeneration on the $name fixture › on their own › maxRetries changed",
    );
  });

  it("marks every match of the pattern, whatever its case", () => {
    expect(markParts("Patch the patch", "patch")).toEqual([
      { text: "Patch", match: true },
      { text: " the ", match: false },
      { text: "patch", match: true },
    ]);
  });

  it("ranks a name in the page first, a test in the page after it, then names out of the page", () => {
    const files = { "src/queue.ts": "", "test/retry.test.ts": "" };
    const ranks = ["src/queue.ts", "test/retry.test.ts", "src/gone.ts", "test/gone.test.ts"].map(
      (file) => symbolRank({ file }, files),
    );
    expect(ranks).toEqual([0, 1, 2, 3]);
  });
});
