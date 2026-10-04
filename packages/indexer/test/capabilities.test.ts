import { expect, it } from "vitest";
import { indexFiles } from "./helpers.js";
import type { PreciseResolver } from "../src/index.js";

// buildIndex owns support and observed coverage; an empty result must not imply unsupported analysis.
it("reports file anchors, config structure and language relationships independently, even when empty", async () => {
  const { index } = await indexFiles({
    "notes.txt": "ordinary text\n",
    "empty.json": "{}\n",
    "empty.py": "# no symbols or references\n",
    "types.go": "package p\ntype Item struct {}\n",
  });
  expect(index.refs).toEqual([]);
  expect(index.analysis?.find((r) => r.provider === "files")).toMatchObject({
    capabilities: { fileAnchors: "supported" },
    results: [
      {
        capabilities: ["fileAnchors"],
        status: "supported",
        analyzedFiles: ["empty.json", "empty.py", "notes.txt", "types.go"],
      },
    ],
  });
  const json = index.analysis?.find((r) => r.provider === "json");
  expect(json?.capabilities).toEqual({
    symbols: "supported",
    declarationRanges: "supported",
    nesting: "supported",
  });
  expect(json?.results).toContainEqual({
    capabilities: ["call", "import", "extends", "implements", "type-ref", "read", "write"],
    status: "unsupported",
    analyzedFiles: [],
    limitations: ["Relationship analysis is unavailable."],
  });
  const python = index.analysis?.find((r) => r.provider === "python");
  expect(python?.capabilities.call).toBe("partial");
  expect(python?.capabilities.implements).toBeUndefined();
  expect(python?.results.find((r) => r.capabilities.includes("call"))).toMatchObject({
    status: "partial",
    analyzedFiles: ["empty.py"],
  });
  expect(index.analysis?.find((r) => r.provider === "go")?.capabilities.declarationRanges).toBe(
    "partial",
  );
});

it("reports partial described-file coverage and preserves relationship kinds a tool cannot analyze", async () => {
  const resolver: PreciseResolver = {
    id: "calls-only",
    languages: ["typescript"],
    capabilities: { call: "supported" },
    async resolve() {
      return { tool: "calls-only@1", refs: [], describedFiles: ["a.ts"] };
    },
  };
  const { index } = await indexFiles(
    { "a.ts": "import './b';\nexport function a() {}\n", "b.ts": "export const b = 1;\n" },
    { precise: "auto", resolvers: [resolver] },
  );
  expect(
    index.analysis
      ?.find((r) => r.provider === "calls-only")
      ?.results.find((r) => r.capabilities.includes("call")),
  ).toMatchObject({ status: "partial", analyzedFiles: ["a.ts"] });
  expect(index.refs.map((r) => [r.kind, r.resolution])).toEqual([["import", "heuristic"]]);
});

it("keeps heuristic hints when a declared relationship analysis reports failure", async () => {
  const { index } = await indexFiles(
    {
      "a.ts": "export function a() {}\nexport function b() { a(); }\n",
    },
    {
      precise: "auto",
      resolvers: [
        {
          id: "calls-only",
          languages: ["typescript"],
          capabilities: { call: "supported" },
          async resolve() {
            return {
              tool: "calls-only@1",
              refs: [],
              describedFiles: ["a.ts"],
              coverage: {
                call: {
                  status: "failed",
                  analyzedFiles: [],
                  limitations: ["Call analysis failed."],
                },
              },
            };
          },
        },
      ],
    },
  );
  expect(index.refs.map((r) => [r.kind, r.resolution])).toEqual([["call", "heuristic"]]);
  expect(
    index.analysis
      ?.find((r) => r.provider === "calls-only")
      ?.results.find((r) => r.capabilities.includes("call")),
  ).toMatchObject({ status: "failed", analyzedFiles: [] });
});

it("keeps unsupported kinds separate from an explicitly analyzed empty result and tool failure", async () => {
  const resolver: PreciseResolver = {
    id: "calls-only",
    languages: ["typescript"],
    capabilities: { call: "supported" },
    async resolve() {
      return {
        tool: "calls-only@1",
        refs: [],
        describedFiles: ["a.ts"],
        coverage: { call: { status: "supported", analyzedFiles: ["a.ts"], limitations: [] } },
      };
    },
  };
  const { index } = await indexFiles(
    { "a.ts": "export const a = 1;\n" },
    { precise: "auto", resolvers: [resolver] },
  );
  const report = index.analysis?.find((r) => r.provider === "calls-only");
  expect(report?.capabilities).toEqual({ call: "supported" });
  expect(report?.results.find((r) => r.capabilities.includes("call"))).toEqual({
    capabilities: ["call"],
    status: "supported",
    analyzedFiles: ["a.ts"],
    limitations: [],
  });
  expect(report?.results.find((r) => r.capabilities.includes("import"))).toMatchObject({
    status: "unsupported",
    analyzedFiles: [],
  });
  resolver.resolve = async () => {
    throw new Error("tool unavailable");
  };
  const failed = await indexFiles(
    { "a.ts": "export const a = 1;\n" },
    { precise: "auto", resolvers: [resolver] },
  );
  expect(failed.index.analysis?.find((r) => r.provider === "calls-only")?.diagnostics).toEqual([
    "tool unavailable",
  ]);
  expect(
    failed.index.analysis
      ?.find((r) => r.provider === "calls-only")
      ?.results.find((r) => r.capabilities.includes("call")),
  ).toMatchObject({ status: "failed", analyzedFiles: [] });
});
