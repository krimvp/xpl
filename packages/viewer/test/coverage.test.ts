import { describe, expect, it } from "vitest";
import type { AnalysisReport, SymbolIndex } from "@xpl/core";
import { coverageGap } from "../src/components/AnalysisCoverage.js";

const files = ["jobrunner/queue.py", "jobrunner/runner.py"];
const index = (analysis: AnalysisReport[]) =>
  ({
    files: files.map((path) => ({ path, language: "python", hash: "x", lines: 1 })),
    analysis,
  }) as unknown as SymbolIndex;
// what the tree-sitter pack reports for Python: calls by name, no implementations
const treeSitter: AnalysisReport = {
  provider: "python",
  capabilities: { call: "partial" },
  files,
  results: [
    { capabilities: ["call"], status: "partial", analyzedFiles: files, limitations: [] },
    { capabilities: ["implements"], status: "unsupported", analyzedFiles: [], limitations: [] },
  ],
};

describe("coverageGap", () => {
  it("names linked files that no report analysed for a kind of relationship", () => {
    expect(coverageGap(index([treeSitter]), new Set(files))).toEqual({ files, failed: false });
  });

  it("clears a gap that another report (a SCIP tool) covers", () => {
    const scip: AnalysisReport = {
      provider: "scip-python",
      capabilities: { implements: "partial" },
      files,
      results: [
        {
          capabilities: ["implements"],
          status: "partial",
          analyzedFiles: files,
          limitations: [],
          resolution: "precise",
        },
      ],
    };
    expect(coverageGap(index([treeSitter, scip]), new Set(files))).toEqual({
      files: [],
      failed: false,
    });
  });

  it("still names the files a tool failed on, though another report gave hints for them", () => {
    const failing: AnalysisReport = {
      provider: "scip-python",
      capabilities: { call: "supported" },
      files,
      results: [{ capabilities: ["call"], status: "failed", analyzedFiles: [], limitations: [] }],
    };
    const covering = { ...treeSitter, results: [treeSitter.results[0]!] };
    expect(coverageGap(index([covering, failing]), new Set(files))).toEqual({
      files,
      failed: true,
    });
  });
});
