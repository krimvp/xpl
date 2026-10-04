/**
 * The per-language line of `xpl index` is the trust level of every reference the skill will use, so it says
 * exactly how much of a language the precise tool described. index.test.ts checks the line itself.
 */
import { describe, expect, it } from "vitest";
import { describeRefs } from "../src/commands/build-index.js";

describe("describeRefs", () => {
  it("is the refs kind, plus the tool when precise", () => {
    expect(describeRefs({ files: 3, symbols: 1, refs: "none" })).toBe("none");
    expect(describeRefs({ files: 3, symbols: 1, refs: "heuristic" })).toBe("heuristic");
    expect(describeRefs({ files: 8, symbols: 1, refs: "precise", tool: "scip-go@v0.2.7" })).toBe(
      "precise (scip-go@v0.2.7)",
    );
    expect(describeRefs({ files: 8, symbols: 1, refs: "precise" })).toBe("precise");
  });

  it("says how many files the precise tool described when it left some to the heuristic resolver", () => {
    expect(
      describeRefs({
        files: 82,
        symbols: 1,
        refs: "precise",
        tool: "scip-python@0.6.6",
        heuristicFiles: 18,
      }),
    ).toBe("precise 64/82 (scip-python@0.6.6), 18 heuristic");
    // none left over: the plain line
    expect(
      describeRefs({ files: 8, symbols: 1, refs: "precise", tool: "t@1", heuristicFiles: 0 }),
    ).toBe("precise (t@1)");
    // the tool described nothing of it (build constraints excluded every file)
    expect(
      describeRefs({ files: 5, symbols: 1, refs: "precise", tool: "t@1", heuristicFiles: 5 }),
    ).toBe("precise 0/5 (t@1), 5 heuristic");
    expect(
      describeRefs({ files: 5, symbols: 1, refs: "precise", tool: "t@1", heuristicFiles: 9 }),
    ).toBe("precise 0/5 (t@1), 9 heuristic");
  });
});
