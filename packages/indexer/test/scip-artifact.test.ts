import { createHash } from "node:crypto";
import { hashText } from "@xpl/core";
import { expect, it } from "vitest";
import { buildIndex, scipArtifactProvider } from "../src/index.js";
import { makeDir } from "./helpers.js";
import { encodeIndex } from "./scip-encode.js";
import type { IndexSpec } from "./scip-encode.js";

const sym = (path: string) => `synthetic test demo 1 ${path}`;
const text = "class A {\n read() { A; }\n}\n";
const spec: IndexSpec = {
  tool: { name: "synthetic", version: "1" },
  documents: [
    {
      path: "a.demo",
      positionEncoding: 2,
      symbols: [
        { symbol: sym("A#"), kind: 7 },
        { symbol: sym("A#read()."), kind: 26 },
      ],
      occurrences: [
        { symbol: sym("A#"), roles: 1, range: [0, 6, 7], enclosingRange: [0, 0, 2, 1] },
        { symbol: sym("A#read()."), roles: 1, range: [1, 1, 5], enclosingRange: [1, 1, 14] },
        { symbol: sym("A#"), range: [1, 10, 11] },
      ],
    },
  ],
};
function provider(
  input = spec,
  sourceHashes: Record<string, string> = { "a.demo": hashText(text) },
  defaultEncoding?: "utf8" | "utf16" | "utf32",
) {
  const artifact = encodeIndex(input);
  return scipArtifactProvider({
    artifact,
    manifest: {
      artifactSha256: createHash("sha256").update(artifact).digest("hex"),
      sourceHashes,
      ...(defaultEncoding ? { defaultEncoding } : {}),
    },
  });
}

it("imports source-backed declarations, nesting and type mentions without a language pack", async () => {
  const { index, warnings } = await buildIndex({
    root: makeDir({ "a.demo": text }),
    precise: "require",
    providers: [provider()],
  });
  expect(warnings).toEqual([]);
  expect(index.symbols.map((s) => [s.id, s.kind, s.parent, s.range])).toEqual([
    ["a.demo#A", "class", undefined, { startLine: 1, endLine: 3 }],
    ["a.demo#A.read", "method", "a.demo#A", { startLine: 2, endLine: 2 }],
  ]);
  expect(index.refs.map((r) => [r.from, r.to, r.kind, r.resolution, r.site])).toEqual([
    [
      "a.demo#A.read",
      "a.demo#A",
      "type-ref",
      "precise",
      { startLine: 2, startCol: 11, endLine: 2, endCol: 11 },
    ],
  ]);
  expect(index.languages.text).toMatchObject({ symbols: 2, refs: "precise" });
});

it.each([
  {
    name: "matching BOM-bearing source",
    source: "\uFEFF// header\nclass A {}\n",
    ids: ["a.demo#A"],
  },
  { name: "source whose leading BOM was removed", source: "// header\nclass A {}\n", ids: [] },
])("preserves embedded source identity for $name", async ({ source, ids }) => {
  const artifact = encodeIndex({
    documents: [
      {
        path: "a.demo",
        text: "\uFEFF// header\nclass A {}\n",
        positionEncoding: 2,
        symbols: [{ symbol: sym("A#"), kind: 7 }],
        occurrences: [
          { symbol: sym("A#"), roles: 1, range: [1, 6, 7], enclosingRange: [1, 0, 10] },
        ],
      },
    ],
  });
  const { index } = await buildIndex({
    root: makeDir({ "a.demo": source }),
    precise: "auto",
    providers: [scipArtifactProvider({ artifact })],
  });
  expect(index.symbols.map((s) => s.id)).toEqual(ids);
  if (!ids.length) {
    expect(index.analysis?.find((r) => r.provider === "scip-artifact")?.diagnostics).toContain(
      "a.demo: source snapshot missing or stale; regenerate artifact and manifest together",
    );
  }
});

it("preserves overload targets, nested declarations and document-scoped local identities", async () => {
  const a = "class A {\n m() { m; x; }\n m() { m; }\n class B {}\n}\n";
  const b = "let x;\nread x;\n";
  const { index } = await buildIndex({
    root: makeDir({ "a.demo": a, "b.demo": b }),
    precise: "require",
    providers: [
      provider(
        {
          documents: [
            {
              path: "a.demo",
              positionEncoding: 2,
              symbols: [
                { symbol: sym("A#"), kind: 7 },
                { symbol: sym("A#m()."), kind: 26 },
                { symbol: sym("A#m(+1)."), kind: 80 },
                { symbol: sym("A#B#"), kind: 7 },
                { symbol: "local 0", kind: 61, displayName: "x", enclosingSymbol: sym("A#m().") },
              ],
              occurrences: [
                { symbol: sym("A#m(+1)."), roles: 1, range: [2, 1, 2], enclosingRange: [2, 1, 11] },
                { symbol: sym("A#"), roles: 1, range: [0, 6, 7], enclosingRange: [0, 0, 4, 1] },
                { symbol: sym("A#m()."), roles: 1, range: [1, 1, 2], enclosingRange: [1, 1, 14] },
                { symbol: "local 0", roles: 1, range: [1, 10, 11], enclosingRange: [1, 10, 12] },
                { symbol: sym("A#B#"), roles: 1, range: [3, 7, 8], enclosingRange: [3, 1, 11] },
                { symbol: sym("A#m(+1)."), roles: 8, range: [1, 7, 8] },
                { symbol: sym("A#m()."), roles: 8, range: [2, 7, 8] },
              ],
            },
            {
              path: "b.demo",
              positionEncoding: 2,
              symbols: [{ symbol: "local 0", kind: 61 }],
              occurrences: [
                { symbol: "local 0", roles: 1, range: [0, 4, 5], enclosingRange: [0, 0, 6] },
                { symbol: "local 0", roles: 8, range: [1, 5, 6] },
              ],
            },
          ],
        },
        { "a.demo": hashText(a), "b.demo": hashText(b) },
      ),
    ],
  });
  expect(index.symbols.map((s) => [s.id, s.parent])).toEqual([
    ["a.demo#A", undefined],
    ["a.demo#A.m", "a.demo#A"],
    ["a.demo#A.m.x", "a.demo#A.m"],
    ["a.demo#A.m~2", "a.demo#A"],
    ["a.demo#A.B", "a.demo#A"],
    ["b.demo#x", undefined],
  ]);
  expect(index.refs.map((r) => [r.from, r.to, r.kind])).toEqual([
    ["a.demo#A.m", "a.demo#A.m~2", "read"],
    ["a.demo#A.m~2", "a.demo#A.m", "read"],
    ["b.demo#", "b.demo#x", "read"],
  ]);
  expect(
    index.analysis
      ?.find((r) => r.provider === "scip-artifact")
      ?.results.find((r) => r.capabilities.includes("nesting"))?.analyzedFiles,
  ).toEqual(["a.demo"]);
});

it.each(["utf8", "utf16", "utf32"] as const)(
  "converts %s columns after non-ASCII text to exact UTF-16 evidence",
  async (encoding) => {
    const source = "😀 class Café {}\nCafé;\n";
    const start = encoding === "utf8" ? 11 : encoding === "utf16" ? 9 : 8;
    const end = start + (encoding === "utf8" ? 5 : 4);
    const positionEncoding = encoding === "utf8" ? 1 : encoding === "utf16" ? 2 : 3;
    const { index } = await buildIndex({
      root: makeDir({ "a.demo": source }),
      precise: "require",
      providers: [
        provider({
          documents: [
            {
              path: "a.demo",
              positionEncoding,
              text: source,
              symbols: [{ symbol: sym("`Café`#"), kind: 7 }],
              occurrences: [
                {
                  symbol: sym("`Café`#"),
                  roles: 1,
                  range: [0, start, end],
                  enclosingRange: [
                    0,
                    encoding === "utf8" ? 5 : encoding === "utf16" ? 3 : 2,
                    end + 3,
                  ],
                },
                { symbol: sym("`Café`#"), range: [1, 0, encoding === "utf8" ? 5 : 4] },
              ],
            },
          ],
        }),
      ],
    });
    expect(index.symbols.map((s) => [s.id, s.kind])).toEqual([["a.demo#Café", "class"]]);
    expect(index.refs.map((r) => r.site)).toEqual([
      { startLine: 2, startCol: 1, endLine: 2, endCol: 4 },
    ]);
  },
);

it.each(["stale", "missing", "embedded stale"])(
  "refuses %s source evidence while retaining file anchors",
  async (mode) => {
    const changed = structuredClone(spec);
    if (mode === "embedded stale") changed.documents![0]!.text = text.replace("A", "B");
    const { index, warnings } = await buildIndex({
      root: makeDir({ "a.demo": text }),
      precise: "auto",
      providers: [
        provider(changed, mode === "missing" ? {} : { "a.demo": hashText(text.replace("A", "B")) }),
      ],
    });
    expect(index.files.map((f) => f.path)).toEqual(["a.demo"]);
    expect(index.symbols).toEqual([]);
    expect(index.refs).toEqual([]);
    expect(warnings).toEqual([expect.stringContaining('precise provider "scip-artifact" failed')]);
    expect(index.analysis?.find((r) => r.provider === "scip-artifact")?.diagnostics).toContain(
      "a.demo: source snapshot missing or stale; regenerate artifact and manifest together",
    );
  },
);

it("accepts embedded source without a manifest and never imports unverified bytes", async () => {
  const embedded = structuredClone(spec);
  embedded.documents![0]!.text = text;
  const root = makeDir({ "a.demo": text });
  const { index } = await buildIndex({
    root,
    precise: "require",
    providers: [scipArtifactProvider({ artifact: encodeIndex(embedded) })],
  });
  expect(index.symbols.map((s) => s.id)).toEqual(["a.demo#A", "a.demo#A.read"]);
  await expect(
    buildIndex({
      root,
      precise: "require",
      providers: [scipArtifactProvider({ artifact: encodeIndex(spec) })],
    }),
  ).rejects.toThrow("the tool described none");
  expect(() =>
    scipArtifactProvider({
      artifact: encodeIndex(spec),
      manifest: { artifactSha256: "old", sourceHashes: {} },
    }),
  ).toThrow("artifact digest does not match");
});

it("filters identifier-only, malformed and unclassified facts before they can remove valid coverage", async () => {
  const changed = structuredClone(spec);
  changed.documents![0]!.symbols!.push({ symbol: sym("A#synthetic()."), kind: 9 });
  changed.documents![0]!.occurrences!.push(
    { symbol: sym("A#synthetic()."), roles: 1, range: [0, 6, 7] },
    { symbol: sym("A#read()."), range: [1, 1, 5] },
    { symbol: sym("External#"), range: [1, 10, 11] },
    { symbol: sym("A#read()."), range: [1, 999, 1000] },
  );
  const { index } = await buildIndex({
    root: makeDir({ "a.demo": text }),
    precise: "require",
    providers: [provider(changed)],
  });
  expect(index.symbols.map((s) => s.id)).toEqual(["a.demo#A", "a.demo#A.read"]);
  expect(index.refs.map((r) => r.kind)).toEqual(["type-ref"]);
  const report = index.analysis!.find((r) => r.provider === "scip-artifact")!;
  expect(report.results.find((r) => r.capabilities.includes("declarationRanges"))).toMatchObject({
    status: "partial",
    analyzedFiles: ["a.demo"],
  });
  expect(report.results.find((r) => r.capabilities.includes("call"))).toMatchObject({
    status: "unsupported",
    analyzedFiles: [],
    limitations: ["SCIP occurrence roles do not distinguish calls from callable values."],
  });
  expect(report.diagnostics).toEqual([
    expect.stringContaining("full declaration/identifier range missing or invalid"),
    expect.stringContaining("occurrence classification unavailable"),
    expect.stringContaining("external, omitted or unresolved target"),
    expect.stringContaining("invalid occurrence range"),
  ]);
});

it("requires verified defaults for unspecified encoding, without treating UTF-8 source encoding as positions", async () => {
  const changed = structuredClone(spec);
  changed.textEncoding = 1;
  changed.documents![0]!.positionEncoding = 0;
  const root = makeDir({ "a.demo": text });
  await expect(
    buildIndex({ root, precise: "require", providers: [provider(changed)] }),
  ).rejects.toThrow("the tool described none");
  expect(
    (
      await buildIndex({
        root,
        precise: "require",
        providers: [provider(changed, { "a.demo": hashText(text) }, "utf16")],
      })
    ).index.symbols.map((s) => s.id),
  ).toEqual(["a.demo#A", "a.demo#A.read"]);
});

it("rejects unsafe, undiscovered generated paths and foreign project roots", async () => {
  const changed = structuredClone(spec);
  changed.documents!.push(
    ...["../a.demo", "/a.demo", "a\\demo", "target/generated.demo"].map((path) => ({
      ...spec.documents![0]!,
      path,
    })),
  );
  const root = makeDir({ "a.demo": text, "target/generated.demo": text });
  const { index } = await buildIndex({ root, precise: "require", providers: [provider(changed)] });
  expect(index.symbols.map((s) => s.id)).toEqual(["a.demo#A", "a.demo#A.read"]);
  expect(index.analysis?.find((r) => r.provider === "scip-artifact")?.diagnostics).toEqual([
    expect.stringContaining("../a.demo: document is outside"),
    expect.stringContaining("/a.demo: document is outside"),
    expect.stringContaining("a\\demo: document is outside"),
    expect.stringContaining("target/generated.demo: document is outside"),
  ]);
  changed.projectRoot = "file:///another-project";
  await expect(
    buildIndex({ root, precise: "require", providers: [provider(changed)] }),
  ).rejects.toThrow("project_root differs");
});

it("retains only role-backed reads, writes and imports and reports unmapped implementation flags", async () => {
  const changed = structuredClone(spec);
  changed.documents![0]!.occurrences = [
    ...changed.documents![0]!.occurrences!,
    { symbol: sym("A#read()."), range: [1, 1, 5], roles: 12 },
    { symbol: sym("A#"), range: [1, 10, 11], roles: 2 },
  ];
  changed.documents![0]!.symbols![1]!.relationships = [
    { symbol: sym("A#"), isImplementation: true, isReference: true },
  ];
  const { index } = await buildIndex({
    root: makeDir({ "a.demo": text }),
    precise: "require",
    providers: [provider(changed)],
  });
  expect(index.refs.map((r) => [r.kind, r.to])).toEqual([
    ["read", "a.demo#A.read"],
    ["write", "a.demo#A.read"],
    ["import", "a.demo#A"],
    ["type-ref", "a.demo#A"],
  ]);
  const report = index.analysis!.find((r) => r.provider === "scip-artifact")!;
  expect(report.results.find((r) => r.capabilities.includes("implements"))).toMatchObject({
    status: "unsupported",
    analyzedFiles: [],
  });
  expect(report.diagnostics).toEqual([
    expect.stringContaining("SymbolInformation relationships omitted"),
  ]);
});

it("omits unchecked parents while keeping independently checked nesting and honest unknown kinds", async () => {
  const changed = structuredClone(spec);
  changed.documents![0]!.symbols![0]!.kind = 0;
  changed.documents![0]!.symbols![0]!.enclosingSymbol = sym("A#read().");
  const { index } = await buildIndex({
    root: makeDir({ "a.demo": text }),
    precise: "require",
    providers: [provider(changed)],
  });
  expect(index.symbols.map((s) => [s.id, s.kind, s.parent])).toEqual([
    ["a.demo#A", "other", undefined],
    ["a.demo#A.read", "method", "a.demo#A"],
  ]);
  const report = index.analysis!.find((r) => r.provider === "scip-artifact")!;
  expect(report.results.find((r) => r.capabilities.includes("nesting"))).toMatchObject({
    status: "partial",
    analyzedFiles: ["a.demo"],
  });
  expect(report.diagnostics).toEqual([
    expect.stringContaining("kind 0 mapped to other"),
    expect.stringContaining("enclosing symbol missing or not containing declaration"),
    expect.stringContaining("occurrence classification unavailable"),
  ]);
});
