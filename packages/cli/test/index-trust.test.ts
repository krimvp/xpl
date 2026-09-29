/**
 * The per-language line of `xpl index` is the trust level of every reference the skill will use, so it says
 * exactly how much of a language the precise tool described. The indexer is faked: what is under test is the line.
 */
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { INDEX_SCHEMA, type LanguageInfo, type SymbolIndex } from "@xpl/core";
import { describeRefs } from "../src/commands/build-index.js";
import { makeTempDir, xpl, xplJson } from "./helpers.js";

const languages: Record<string, LanguageInfo> = {
  go: { files: 36, symbols: 736, refs: "heuristic" },
  python: {
    files: 82,
    symbols: 1803,
    refs: "precise",
    tool: "scip-python@0.6.6",
    heuristicFiles: 18,
  },
  text: { files: 140, symbols: 0, refs: "none" },
  typescript: { files: 8, symbols: 114, refs: "precise", tool: "scip-typescript@0.4.0" },
};

vi.mock("@xpl/indexer", async (importOriginal) => {
  const original = await importOriginal<typeof import("@xpl/indexer")>();
  return {
    ...original,
    buildIndex: async () => ({
      index: {
        schema: INDEX_SCHEMA,
        commit: "c1",
        tool: "test",
        languages,
        files: [],
        symbols: [],
        refs: [],
      } satisfies SymbolIndex,
      warnings: [],
    }),
    writeIndex: async (root: string) => join(root, ".explainer", "index-c1.json"),
  };
});

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

describe("xpl index: the trust line", () => {
  it("tells the truth about files that only have heuristic references", async () => {
    const dir = makeTempDir();
    const { code, out } = await xpl(dir, "index");
    expect(code).toBe(0);
    expect(out).toMatch(/^go +36 files +736 symbols +refs: heuristic$/m);
    expect(out).toMatch(
      /^python +82 files +1803 symbols +refs: precise 64\/82 \(scip-python@0\.6\.6\), 18 heuristic$/m,
    );
    expect(out).toMatch(/^text +140 files +0 symbols +refs: none$/m);
    // a language the tool described completely keeps the short line
    expect(out).toMatch(
      /^typescript +8 files +114 symbols +refs: precise \(scip-typescript@0\.4\.0\)$/m,
    );
    // the --json summary carries the same numbers
    const json = await xplJson<{ languages: Record<string, LanguageInfo> }>(dir, "index");
    expect(json.json.languages.python).toMatchObject({ files: 82, heuristicFiles: 18 });
  });
});
