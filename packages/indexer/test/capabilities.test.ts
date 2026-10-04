import { providerFacts } from "./helpers.js";
import { expect, it } from "vitest";
import { indexFiles } from "./helpers.js";
import type { IndexProvider } from "../src/index.js";

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
  const resolver: IndexProvider = {
    id: "calls-only",
    languages: ["typescript"],
    capabilities: { call: "supported" },
    async analyze(input) {
      return providerFacts(
        input,
        { tool: "calls-only@1", refs: [], describedFiles: ["a.ts"] },
        this,
      );
    },
  };
  const { index } = await indexFiles(
    { "a.ts": "import './b';\nexport function a() {}\n", "b.ts": "export const b = 1;\n" },
    { precise: "auto", providers: [resolver] },
  );
  expect(
    index.analysis
      ?.find((r) => r.provider === "calls-only")
      ?.results.find((r) => r.capabilities.includes("call")),
  ).toMatchObject({ status: "partial", analyzedFiles: ["a.ts"] });
  expect(index.refs.map((r) => [r.kind, r.resolution])).toEqual([["import", "heuristic"]]);
});

it.each(["auto", "require"] as const)(
  "treats a wholly failed precise attempt as failure in %s mode",
  async (precise) => {
    const files = { "a.ts": "export function a() {}\nexport function b() { a(); }\n" };
    const resolver: IndexProvider = {
      id: "calls-only",
      languages: ["typescript"],
      capabilities: { call: "supported" },
      async analyze(input) {
        return providerFacts(
          input,
          {
            tool: "calls-only@1",
            refs: [],
            describedFiles: ["a.ts"],
            coverage: {
              call: { status: "failed", analyzedFiles: [], limitations: ["Call analysis failed."] },
            },
          },
          this,
        );
      },
    };
    if (precise === "require") {
      await expect(indexFiles(files, { precise, providers: [resolver] })).rejects.toThrow(
        'precise provider "calls-only" failed: all advertised relationship kinds failed or were unsupported',
      );
      return;
    }
    const { index, warnings } = await indexFiles(files, { precise, providers: [resolver] });
    expect(index.refs.map((r) => [r.kind, r.resolution])).toEqual([["call", "heuristic"]]);
    expect(index.languages.typescript?.refs).toBe("heuristic");
    expect(index.languages.typescript?.tool).toMatch(/^xpl-heuristic@/);
    expect(warnings).toEqual([
      'precise provider "calls-only" failed (all advertised relationship kinds failed or were unsupported); using heuristic references for typescript',
    ]);
    expect(
      index.analysis
        ?.find((r) => r.provider === "calls-only")
        ?.results.find((r) => r.capabilities.includes("call")),
    ).toMatchObject({
      status: "failed",
      analyzedFiles: [],
      limitations: ["Call analysis failed.", "Files outside this analysis keep heuristic hints."],
    });
  },
);

it("keeps unsupported kinds separate from an explicitly analyzed empty result and tool failure", async () => {
  const resolver: IndexProvider = {
    id: "calls-only",
    languages: ["typescript"],
    capabilities: { call: "supported" },
    async analyze(input) {
      return providerFacts(
        input,
        {
          tool: "calls-only@1",
          refs: [],
          describedFiles: ["a.ts"],
          coverage: { call: { status: "supported", analyzedFiles: ["a.ts"], limitations: [] } },
        },
        this,
      );
    },
  };
  const { index } = await indexFiles(
    { "a.ts": "export const a = 1;\n" },
    { precise: "auto", providers: [resolver] },
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
  resolver.analyze = async () => {
    throw new Error("tool unavailable");
  };
  const failed = await indexFiles(
    { "a.ts": "export const a = 1;\n" },
    { precise: "auto", providers: [resolver] },
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

it.each([
  ["json", '{"a":{"b":{"c":{"d":{"e":{"f":{"g":1}}}}}}}'],
  ["yaml", "a:\n  b:\n    c:\n      d:\n        e:\n          f:\n            g: 1\n"],
  ["toml", "[a.b.c.d.e.f]\ng = 1\n[a.b.c.d.e.f.g]\nh = 1\n"],
])(
  "reports truncated %s key structure as partial only in the affected file",
  async (format, source) => {
    const { index, warnings } = await indexFiles({
      [`deep.${format}`]: source,
      [`shallow.${format}`]: format === "json" ? '{"a":1}' : format === "yaml" ? "a: 1" : "a = 1",
    });
    const report = index.analysis?.find((r) => r.provider === format);
    expect(report?.capabilities).toEqual({
      symbols: "supported",
      declarationRanges: "supported",
      nesting: "supported",
    });
    expect(report?.results.filter((r) => r.capabilities.includes("symbols"))).toEqual([
      {
        capabilities: ["symbols", "declarationRanges", "nesting"],
        status: "supported",
        analyzedFiles: [`shallow.${format}`],
        limitations: [],
      },
      {
        capabilities: ["symbols", "declarationRanges", "nesting"],
        status: "partial",
        analyzedFiles: [`deep.${format}`],
        limitations: ["Keys beyond depth 6 were not indexed."],
      },
    ]);
    expect(warnings).toEqual([`deep.${format}: Keys beyond depth 6 were not indexed.`]);
    expect(index.symbols.filter((s) => s.file === `deep.${format}`).map((s) => s.path)).toEqual(
      format === "toml"
        ? ["a.b.c.d.e.f"]
        : ["a", "a.b", "a.b.c", "a.b.c.d", "a.b.c.d.e", "a.b.c.d.e.f"],
    );
  },
);

it.each(
  [
    { analyzedFiles: [], failedImport: false },
    { analyzedFiles: ["a.ts"], failedImport: false },
    { analyzedFiles: [], failedImport: true },
  ].flatMap((observation) => [
    { ...observation, precise: "auto" as const },
    { ...observation, precise: "require" as const },
  ]),
)(
  "preserves unsupported outcomes and rejects unusable precise analysis ($precise, $analyzedFiles, failed import: $failedImport)",
  async ({ analyzedFiles, failedImport, precise }) => {
    const files = { "a.ts": "export function a() {}\nexport function b() { a(); }\n" };
    const resolver: IndexProvider = {
      id: "calls-only",
      languages: ["typescript"],
      capabilities: failedImport
        ? { call: "supported", import: "supported" }
        : { call: "supported" },
      async analyze(input) {
        return providerFacts(
          input,
          {
            tool: "calls-only@1",
            refs: [],
            describedFiles: ["a.ts"],
            coverage: {
              call: {
                status: "unsupported",
                analyzedFiles,
                limitations: ["Call analysis is unavailable for this project."],
              },
              ...(failedImport
                ? {
                    import: {
                      status: "failed" as const,
                      analyzedFiles: [],
                      limitations: ["Import analysis failed."],
                    },
                  }
                : {}),
            },
          },
          this,
        );
      },
    };
    if (precise === "require") {
      await expect(indexFiles(files, { precise, providers: [resolver] })).rejects.toThrow(
        'precise provider "calls-only" failed: all advertised relationship kinds failed or were unsupported',
      );
      return;
    }
    const { index, warnings } = await indexFiles(files, { precise, providers: [resolver] });
    expect(index.refs.map((r) => [r.kind, r.resolution])).toEqual([["call", "heuristic"]]);
    expect(index.languages.typescript?.refs).toBe("heuristic");
    expect(index.languages.typescript?.tool).toMatch(/^xpl-heuristic@/);
    expect(warnings).toEqual([
      'precise provider "calls-only" failed (all advertised relationship kinds failed or were unsupported); using heuristic references for typescript',
    ]);
    const report = index.analysis?.find((r) => r.provider === "calls-only");
    expect(report?.capabilities).toEqual(
      failedImport ? { call: "supported", import: "supported" } : { call: "supported" },
    );
    expect(report?.results.find((r) => r.capabilities.includes("call"))).toMatchObject({
      status: "unsupported",
      analyzedFiles,
      limitations: ["Call analysis is unavailable for this project."],
    });
    expect(report?.results.find((r) => r.capabilities.includes("import"))?.status).toBe(
      failedImport ? "failed" : "unsupported",
    );
  },
);

it.each(["json", "yaml", "toml"])(
  "reports the %s nesting safety limit as partial",
  async (format) => {
    const leaf = format === "json" ? '{"lost":1}' : format === "yaml" ? "{lost: 1}" : "{lost = 1}";
    const nested = "[".repeat(65) + leaf + "]".repeat(65);
    const source =
      format === "json"
        ? `{"root":${nested}}`
        : format === "yaml"
          ? `root: ${nested}`
          : `root = ${nested}`;
    const { index, warnings } = await indexFiles({ [`deep.${format}`]: source });
    expect(index.symbols.map((s) => s.path)).toEqual(["root"]);
    expect(
      index.analysis
        ?.find((r) => r.provider === format)
        ?.results.find((r) => r.capabilities.includes("symbols")),
    ).toEqual({
      capabilities: ["symbols", "declarationRanges", "nesting"],
      status: "partial",
      analyzedFiles: [`deep.${format}`],
      limitations: ["Structure beyond nesting depth 64 was not indexed."],
    });
    expect(warnings).toEqual([
      `deep.${format}: Structure beyond nesting depth 64 was not indexed.`,
    ]);
  },
);
