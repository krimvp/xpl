import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildIndex } from "../src/index.js";
import { scipTypescriptProvider } from "../src/scip/index.js";
import { makeDir } from "./helpers.js";
import { encodeIndex } from "./scip-encode.js";
import { ts, DEF } from "./scip-dsl.js";
import { describe, expect, it } from "vitest";
import { hashText } from "@xpl/core";
import { SymbolLookup } from "../src/symbols.js";
import { TreeSitterProvider } from "../src/tree-sitter.js";
import { normalizeProvider, mergeProvider } from "../src/providers.js";
import type { ProviderInput, ProviderOutput } from "../src/providers.js";

const text = 'const emoji = "😀"; function f() { return f; }\n';
const input: ProviderInput = {
  root: "/repo",
  languages: ["typescript"],
  files: [{ path: "a.ts", language: "typescript", hash: hashText(text), lines: 2 }],
  lookup: new SymbolLookup([]),
  warn: () => {},
  sources: [{ path: "a.ts", language: "typescript", text }],
  symbols: [],
  readText: () => undefined,
};
function output(): ProviderOutput {
  return {
    provider: "semantic",
    version: "1",
    configuration: "default",
    tool: "semantic@1",
    sourceHashes: { "a.ts": hashText(text) },
    declarations: [
      {
        identity: "f",
        file: "a.ts",
        name: "f",
        kind: "function",
        identifier: { start: [0, 31], end: [0, 32], encoding: "utf8" },
        declaration: { start: [0, 22], end: [0, 48], encoding: "utf8" },
      },
    ],
    relationships: [],
    analysis: [
      {
        provider: "semantic",
        capabilities: { symbols: "supported", declarationRanges: "supported" },
        files: ["a.ts"],
        results: [
          {
            capabilities: ["symbols", "declarationRanges"],
            status: "supported",
            analyzedFiles: ["a.ts"],
            limitations: [],
          },
        ],
      },
    ],
  };
}
describe("source-backed providers", () => {
  it("preserves YAML keys whose block declaration ends on a blank line", async () => {
    const { index, warnings } = await buildIndex({
      root: makeDir({ "config.yaml": "ok: true\nblank: |\n\n" }),
      precise: "off",
    });
    expect(warnings).toEqual([]);
    expect(index.symbols.map((s) => [s.id, s.range])).toEqual([
      ["config.yaml#ok", { startLine: 1, endLine: 1 }],
      ["config.yaml#blank", { startLine: 2, endLine: 3 }],
    ]);
    expect(index.analysis?.find((r) => r.provider === "yaml")?.results[0]).toMatchObject({
      status: "supported",
      analyzedFiles: ["config.yaml"],
    });
  });
});

it("rejects identifiers that do not name the declaration in the source snapshot", () => {
  const facts = output();
  facts.declarations = [{ ...facts.declarations[0]!, name: "invented" }];
  const result = normalizeProvider(input, facts);
  expect(result.entries).toEqual([]);
  expect(result.analysis[0]?.diagnostics).toContain("f: identifier does not name the declaration");
});

it.each(["utf8", "utf16", "utf32"] as const)(
  "keeps canonical declaration IDs and hashes with %s positions",
  (encoding) => {
    const facts = output();
    const declaration = facts.declarations[0]!;
    facts.declarations = [
      {
        ...declaration,
        identifier: {
          start: [0, encoding === "utf8" ? 31 : encoding === "utf16" ? 29 : 28],
          end: [0, encoding === "utf8" ? 32 : encoding === "utf16" ? 30 : 29],
          encoding,
        },
        declaration: {
          start: [0, encoding === "utf8" ? 22 : encoding === "utf16" ? 20 : 19],
          end: [0, encoding === "utf8" ? 48 : encoding === "utf16" ? 46 : 45],
          encoding,
        },
      },
    ];
    const result = normalizeProvider(input, facts);
    expect(
      result.entries.map((e) => ({
        id: e.symbol.id,
        range: e.symbol.range,
        span: e.span,
        hash: e.symbol.hash,
      })),
    ).toEqual([
      {
        id: "a.ts#f",
        range: { startLine: 1, endLine: 1 },
        span: { startLine: 1, endLine: 1, startCol: 21, endCol: 46 },
        hash: hashText('const emoji = "😀"; function f() { return f; }'),
      },
    ]);
    expect(result.identifiers.get("f")).toEqual({
      startLine: 1,
      endLine: 1,
      startCol: 30,
      endCol: 30,
    });
  },
);

it.each([
  ["past the source", [0, 99], [0, 100]],
  ["inside a UTF-8 character", [0, 17], [0, 18]],
  ["empty evidence", [0, 31], [0, 31]],
  ["reversed lines", [1, 0], [0, 32]],
] as const)("rejects %s instead of clamping it into checked evidence", (_, start, end) => {
  const facts = output();
  facts.declarations = [
    { ...facts.declarations[0]!, identifier: { start, end, encoding: "utf8" } },
  ];
  const result = normalizeProvider(input, facts);
  expect(result.entries).toEqual([]);
  expect(result.analysis[0]?.results[0]?.analyzedFiles).toEqual([]);
});

it("identifier-only facts cannot establish a checked full-declaration anchor", () => {
  const facts = output();
  facts.declarations = [{ ...facts.declarations[0]!, declaration: undefined }];
  const result = normalizeProvider(input, facts);
  expect(result.identifiers.get("f")).toEqual({
    startLine: 1,
    endLine: 1,
    startCol: 30,
    endCol: 30,
  });
  expect(result.entries).toEqual([]);
  expect(result.analysis[0]?.results[0]?.analyzedFiles).toEqual([]);
});

it.each(["tree-sitter", "scip"])(
  "%s preserves declarations and distinguishes a function value from invocation at buildIndex",
  async (adapter) => {
    const root = makeDir({
      "tsconfig.json": "{}",
      "a.ts": "export function f() { return f; }\nexport function g() { return f(); }\n",
    });
    const provider = scipTypescriptProvider({
      run: async (_, args) => {
        writeFileSync(
          args[args.indexOf("--output") + 1]!,
          encodeIndex({
            tool: { name: "scip-typescript", version: "test" },
            documents: [
              {
                path: "a.ts",
                occurrences: [
                  { symbol: ts("a.ts", "f()."), roles: DEF, range: [0, 16, 17] },
                  { symbol: ts("a.ts", "g()."), roles: DEF, range: [1, 16, 17] },
                  { symbol: ts("a.ts", "f()."), range: [0, 29, 30] },
                  { symbol: ts("a.ts", "f()."), range: [1, 29, 30] },
                ],
              },
            ],
          }),
        );
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
    });
    const { index, warnings } = await buildIndex({
      root,
      precise: adapter === "scip" ? "require" : "off",
      providers: [provider],
    });
    expect(warnings).toEqual([]);
    expect(index.symbols.filter((s) => s.file === "a.ts").map((s) => [s.id, s.range])).toEqual([
      ["a.ts#f", { startLine: 1, endLine: 1 }],
      ["a.ts#g", { startLine: 2, endLine: 2 }],
    ]);
    expect(index.refs.map((r) => [r.from, r.to, r.kind, r.resolution])).toEqual([
      ["a.ts#f", "a.ts#f", "read", adapter === "scip" ? "precise" : "heuristic"],
      ["a.ts#g", "a.ts#f", "call", adapter === "scip" ? "precise" : "heuristic"],
    ]);
    expect(index.providers).toEqual([
      { id: "tree-sitter", version: "0.27.0" },
      ...(adapter === "scip" ? [{ id: "scip-typescript", version: "test" }] : []),
    ]);
    expect(index.refs.map((r) => r.provider)).toEqual(adapter === "scip" ? [1, 1] : [0, 0]);
    expect(
      index.analysis?.find(
        (r) => r.provider === (adapter === "scip" ? "scip-typescript" : "typescript"),
      ),
    ).toMatchObject({ version: adapter === "scip" ? "test" : "0.27.0" });
  },
);

it("rejects a SCIP run when source changes without shifting any positions", async () => {
  const root = makeDir({ "tsconfig.json": "{}", "a.ts": "export function f() {}\n" });
  const provider = scipTypescriptProvider({
    run: async (_, args) => {
      writeFileSync(
        args[args.indexOf("--output") + 1]!,
        encodeIndex({
          tool: { name: "scip-typescript", version: "test" },
          documents: [
            {
              path: "a.ts",
              occurrences: [{ symbol: ts("a.ts", "f()."), roles: DEF, range: [0, 16, 17] }],
            },
          ],
        }),
      );
      writeFileSync(join(root, "a.ts"), "export function g() {}\n");
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    },
  });
  const { index, warnings } = await buildIndex({ root, precise: "auto", providers: [provider] });
  expect(index.languages.typescript?.refs).toBe("heuristic");
  expect(warnings).toEqual([
    'precise provider "scip-typescript" failed (source changed while indexing: a.ts); using heuristic references for typescript',
  ]);
});

it("merges only explicitly covered kinds and files, retaining provenance and checked declarations", async () => {
  const sources: ProviderInput["sources"] = [
    { path: "a.ts", language: "typescript", text: "export function a() { a(); return a; }\n" },
    { path: "b.ts", language: "typescript", text: "export function b() { b(); }\n" },
  ];
  const snapshot: ProviderInput = {
    ...input,
    sources,
    files: sources.map((s) => ({
      path: s.path,
      language: s.language,
      hash: hashText(s.text),
      lines: 2,
    })),
    readText: (path) => sources.find((s) => s.path === path)?.text,
  };
  const before = normalizeProvider(snapshot, await new TreeSitterProvider().analyze(snapshot));
  expect(before.refs.map((r) => [r.from, r.kind, r.resolution])).toEqual([
    ["a.ts#a", "call", "heuristic"],
    ["a.ts#a", "read", "heuristic"],
    ["b.ts#b", "call", "heuristic"],
  ]);
  const facts: ProviderOutput = {
    provider: "semantic",
    version: "2",
    tool: "semantic@2",
    configuration: "calls",
    sourceHashes: Object.fromEntries(snapshot.files.map((f) => [f.path, f.hash])),
    declarations: [],
    relationships: [],
    analysis: [
      {
        provider: "semantic",
        files: ["a.ts", "b.ts"],
        capabilities: { call: "supported" },
        results: [
          {
            capabilities: ["call"],
            status: "partial",
            analyzedFiles: ["a.ts"],
            limitations: ["Other files were not analyzed."],
          },
        ],
      },
    ],
  };
  const after = mergeProvider(
    before,
    normalizeProvider({ ...snapshot, symbols: before.entries.map((e) => e.symbol) }, facts),
  );
  expect(after.entries).toEqual(before.entries);
  expect(after.refs.map((r) => [r.from, r.kind, r.resolution])).toEqual([
    ["a.ts#a", "read", "heuristic"],
    ["b.ts#b", "call", "heuristic"],
  ]);
  for (const status of ["unsupported", "failed"] as const) {
    facts.analysis[0]!.results[0]!.status = status;
    expect(mergeProvider(before, normalizeProvider(snapshot, facts)).refs).toEqual(before.refs);
  }
  // A stale empty result cannot erase a previously checked call either.
  facts.analysis[0]!.results[0]!.status = "supported";
  facts.sourceHashes = { "a.ts": "stale", "b.ts": snapshot.files[1]!.hash };
  expect(mergeProvider(before, normalizeProvider(snapshot, facts)).refs).toEqual(before.refs);
});

it("diagnoses unknown relationship kinds without manufacturing calls or erasing hints", () => {
  const facts = output();
  facts.relationships = [
    {
      from: "f",
      to: "f",
      file: "a.ts",
      kind: "reference",
      resolution: "precise",
      evidence: { start: [0, 29], end: [0, 30], encoding: "utf16" },
    },
  ];
  facts.analysis[0]!.capabilities.call = "supported";
  facts.analysis[0]!.results[0]!.capabilities.push("call");
  const result = normalizeProvider(input, facts);
  expect(result.refs).toEqual([]);
  expect(result.analysis[0]?.diagnostics).toContain(
    "f: unknown relationship kind, endpoint or invalid source evidence",
  );
  expect(result.analysis[0]?.results[0]?.analyzedFiles).toEqual([]);
});

it("maps duplicate provider identities and explicit parents to stable source-ordered canonical IDs", () => {
  const snapshot: ProviderInput = {
    ...input,
    sources: [{ path: "a.ts", language: "typescript", text: "class A {\n m() {}\n m() {}\n}\n" }],
  };
  const facts = output();
  facts.sourceHashes = { "a.ts": hashText(snapshot.sources[0]!.text) };
  facts.declarations = [
    {
      identity: "later",
      file: "a.ts",
      name: "m",
      path: "A.m",
      kind: "method",
      parent: "A",
      declaration: { start: [2, 1], end: [2, 7], encoding: "utf16" },
    },
    {
      identity: "A",
      file: "a.ts",
      name: "A",
      kind: "class",
      declaration: { start: [0, 0], end: [3, 1], encoding: "utf16" },
    },
    {
      identity: "earlier",
      file: "a.ts",
      name: "m",
      path: "A.m",
      kind: "method",
      parent: "A",
      declaration: { start: [1, 1], end: [1, 7], encoding: "utf16" },
    },
  ];
  const result = normalizeProvider(snapshot, facts);
  expect([...result.identities]).toEqual([
    ["A", "a.ts#A"],
    ["earlier", "a.ts#A.m"],
    ["later", "a.ts#A.m~2"],
  ]);
  expect(result.entries.map((e) => [e.symbol.id, e.symbol.parent])).toEqual([
    ["a.ts#A", undefined],
    ["a.ts#A.m", "a.ts#A"],
    ["a.ts#A.m~2", "a.ts#A"],
  ]);
});

it("a provider that covers declarations but not nesting cannot remove an existing parent", () => {
  const snapshot: ProviderInput = {
    ...input,
    sources: [{ path: "a.ts", language: "typescript", text: "class A { m() {} }\n" }],
  };
  const facts = output();
  facts.sourceHashes = { "a.ts": hashText(snapshot.sources[0]!.text) };
  facts.analysis[0]!.capabilities.nesting = "supported";
  facts.analysis[0]!.results[0]!.capabilities.push("nesting");
  facts.declarations = [
    {
      identity: "A",
      file: "a.ts",
      name: "A",
      kind: "class",
      declaration: { start: [0, 0], end: [0, 18], encoding: "utf16" },
    },
    {
      identity: "m",
      file: "a.ts",
      name: "m",
      path: "A.m",
      kind: "method",
      parent: "A",
      declaration: { start: [0, 10], end: [0, 16], encoding: "utf16" },
    },
  ];
  const before = normalizeProvider(snapshot, facts);
  expect(before.entries[1]?.symbol.parent).toBe("a.ts#A");
  delete facts.analysis[0]!.capabilities.nesting;
  facts.analysis[0]!.results[0]!.capabilities = ["symbols", "declarationRanges"];
  facts.declarations = facts.declarations.map(({ parent: _, ...declaration }) => declaration);
  const after = mergeProvider(before, normalizeProvider(snapshot, facts));
  expect(after.entries[1]?.symbol.parent).toBe("a.ts#A");
});
