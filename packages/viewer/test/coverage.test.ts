import { describe, expect, it } from "vitest";
import type { AnalysisReport, SymbolIndex } from "@xpl/core";
import { coverageGap, coverageSummary } from "../src/components/AnalysisCoverage.js";

const files = ["jobrunner/queue.py", "jobrunner/runner.py"];
const index = (analysis: AnalysisReport[]) =>
  ({
    files: files.map((path) => ({ path, language: "python", hash: "x", lines: 1 })),
    analysis,
  }) as unknown as SymbolIndex;
// what the tree-sitter pack reports for Python: calls by name, no implementations (Python has none)
const python: AnalysisReport = {
  provider: "python",
  capabilities: { call: "partial" },
  files,
  results: [
    { capabilities: ["call"], status: "partial", analyzedFiles: files, limitations: [] },
    { capabilities: ["implements"], status: "unsupported", analyzedFiles: [], limitations: [] },
  ],
};
// the same with a kind of relationship Python does have left out
const treeSitter: AnalysisReport = {
  ...python,
  results: [
    ...python.results,
    { capabilities: ["extends"], status: "unsupported", analyzedFiles: [], limitations: [] },
  ],
};

describe("coverageGap", () => {
  it("says that xpl found no calls in a language it reads no calls of, so the author drew the arrows", () => {
    // what the Ruby pack reports: names in part, no relationships at all
    const ruby: AnalysisReport = {
      provider: "ruby",
      capabilities: { symbols: "partial" },
      files,
      results: [
        { capabilities: ["symbols"], status: "partial", analyzedFiles: files, limitations: [] },
        {
          capabilities: ["call", "import", "extends", "implements", "type-ref", "read", "write"],
          status: "unsupported",
          analyzedFiles: [],
          limitations: [],
        },
      ],
    };
    const rubyIndex = {
      files: files.map((path) => ({ path, language: "ruby", hash: "x", lines: 1 })),
      analysis: [ruby],
    } as unknown as SymbolIndex;
    const gap = coverageGap(rubyIndex, new Set(files));
    expect(gap).toEqual({ files, failed: false, noCalls: ["Ruby"] });
    // (it said "Some arrows may be missing", where xpl had found none and the author drew every one)
    expect(coverageSummary(gap)).toBe(
      "xpl finds no calls in Ruby code: every arrow between the 2 files this guide links to was drawn by the author.",
    );
    expect(coverageSummary(coverageGap(index([treeSitter]), new Set(files)))).toBe(
      "Some arrows may be missing: xpl could not analyze all the code in 2 files this guide links to.",
    );
  });

  it("names linked files that no report analyzed for a kind of relationship", () => {
    expect(coverageGap(index([treeSitter]), new Set(files))).toEqual({ files, failed: false });
  });

  it("counts no gap for a relationship the language cannot have (Python has no implements)", () => {
    expect(coverageGap(index([python]), new Set(files))).toEqual({ files: [], failed: false });
  });

  it("counts no gap for calls matched by name: a Java guide gets no bar, as TypeScript without SCIP", () => {
    // what the Java pack reports: every kind of relationship found by name in every file
    const java: AnalysisReport = {
      provider: "java",
      capabilities: { call: "partial", implements: "partial" },
      files,
      results: [
        {
          capabilities: ["call", "import", "extends", "implements", "type-ref", "read", "write"],
          status: "partial",
          resolution: "heuristic",
          analyzedFiles: files,
          limitations: [],
        },
      ],
    };
    const javaIndex = {
      files: files.map((path) => ({ path, language: "java", hash: "x", lines: 1 })),
      analysis: [java],
    } as unknown as SymbolIndex;
    expect(coverageGap(javaIndex, new Set(files))).toEqual({ files: [], failed: false });
  });

  it("clears a gap that another report (a SCIP tool) covers", () => {
    const scip: AnalysisReport = {
      provider: "scip-python",
      capabilities: { extends: "partial" },
      files,
      results: [
        {
          capabilities: ["extends"],
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
