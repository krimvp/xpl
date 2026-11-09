import { expect, it } from "vitest";
import { changeOmissions, describeAnalysis, readerCoverage } from "../src/index.js";
import { makeWorld } from "./helpers.js";

it("labels analysis sources when a file-only fallback and an artifact report different symbol support", () => {
  const { index } = makeWorld({
    files: [{ path: "a.demo", language: "text", text: "class A {}\n" }],
    symbols: [{ id: "a.demo#A", kind: "class", start: 1, end: 1 }],
  });
  index.analysis = [
    {
      provider: "text",
      capabilities: {},
      files: ["a.demo"],
      results: [
        {
          capabilities: ["symbols"],
          status: "unsupported",
          analyzedFiles: [],
          limitations: [
            "Only file anchors are available; named symbols and references are unavailable.",
          ],
        },
      ],
    },
    {
      provider: "scip-artifact",
      capabilities: { symbols: "partial" },
      files: ["a.demo"],
      results: [
        {
          capabilities: ["symbols"],
          status: "partial",
          analyzedFiles: ["a.demo"],
          limitations: ["Identifier-only declarations are omitted."],
        },
      ],
    },
  ];
  expect(describeAnalysis(index).details).toEqual([
    "text (text): named symbols unsupported (0/1 files analyzed). Only file anchors are available; named symbols and references are unavailable.",
    "text (scip-artifact): named symbols partial (1/1 files analyzed). Identifier-only declarations are omitted.",
  ]);
});

it("lists only observed limits for changed head files and bounds a long report", () => {
  const { index } = makeWorld({
    files: [
      { path: "a.ts", language: "typescript", text: "export const a = 1;\n" },
      { path: "b.ts", language: "typescript", text: "export const b = 1;\n" },
    ],
  });
  index.analysis = [
    {
      provider: "scip",
      capabilities: { call: "supported", import: "supported" },
      files: ["a.ts", "b.ts"],
      results: [
        {
          capabilities: ["call"],
          status: "partial",
          analyzedFiles: ["a.ts"],
          limitations: ["Indirect calls are not resolved."],
        },
        {
          capabilities: ["import"],
          status: "supported",
          analyzedFiles: ["a.ts", "b.ts"],
          limitations: [],
        },
      ],
    },
  ];
  const change = {
    base: "a",
    head: "b",
    files: [
      { path: "a.ts", status: "modified" as const, hunks: [] },
      { path: "missing.ts", status: "added" as const, hunks: [] },
      { path: "old.ts", status: "deleted" as const, hunks: [] },
    ],
  };
  expect(changeOmissions(change, index)).toEqual([
    "missing.ts: absent from the loaded index; source analysis is not recorded there.",
    "old.ts: removed from the head; the loaded index cannot inspect its old code.",
    "scip report: calls partial; 1 of 1 changed paths in its scope analyzed. Reported limit: Indirect calls are not resolved.",
  ]);
  expect(
    changeOmissions({ ...change, files: [{ path: "b.ts", status: "modified", hunks: [] }] }, index),
  ).toEqual([
    "scip report: calls partial; 0 of 1 changed paths in its scope analyzed. Reported limit: Indirect calls are not resolved.",
  ]);
  const many = {
    ...change,
    files: Array.from({ length: 7 }, (_, n) => ({
      path: `missing-${n}.ts`,
      status: "added" as const,
      hunks: [],
    })),
  };
  expect(changeOmissions(many, index)).toEqual([
    ...Array.from(
      { length: 5 },
      (_, n) =>
        `missing-${n}.ts: absent from the loaded index; source analysis is not recorded there.`,
    ),
    "2 more recorded limits.",
  ]);
});

it("identifies a reused index before reporting its coverage", () => {
  const { index } = makeWorld({ files: [{ path: "a.ts", language: "typescript", text: "a\n" }] });
  index.commit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const change = {
    base: "c".repeat(40),
    head: "b".repeat(40),
    files: [{ path: "a.ts", status: "modified" as const, hunks: [] }],
  };
  expect(changeOmissions(change, index)).toEqual([
    "Loaded index aaaaaaa differs from change head bbbbbbb; head analysis coverage is unknown here.",
  ]);
});

it("does not turn missing coverage or an empty result into a claim of complete analysis", () => {
  const { index } = makeWorld({ files: [{ path: "a.ts", language: "typescript", text: "a\n" }] });
  const change = {
    base: "a",
    head: "b",
    files: [{ path: "a.ts", status: "modified" as const, hunks: [] }],
  };
  expect(changeOmissions(change, index)).toEqual([]);
  index.analysis = [];
  expect(changeOmissions(change, index)).toEqual([]);
});

it("gives readers one plain line per language, in the words of the diagrams", () => {
  const { index } = makeWorld({
    files: [
      { path: "src/a.ts", language: "typescript" },
      { path: "src/b.tsx", language: "tsx" },
      { path: "src/main.rs", language: "rust" },
      { path: "cmd/main.go", language: "go" },
      { path: "pkg/q.go", language: "go" },
      { path: "config.yaml", language: "yaml" },
      { path: "package.json", language: "json" },
      { path: "README.md", language: "text" },
    ],
  });
  const all = (status: "supported" | "partial", files: string[], resolution?: "precise") => ({
    capabilities: [
      "symbols",
      "declarationRanges",
      "nesting",
      "call",
      "import",
      "extends",
      "implements",
      "type-ref",
      "read",
      "write",
    ] as const,
    status,
    analyzedFiles: files,
    limitations: [],
  });
  index.analysis = [
    {
      provider: "typescript",
      capabilities: {},
      files: ["src/a.ts", "src/b.tsx"],
      results: [
        {
          capabilities: ["symbols", "declarationRanges", "nesting"],
          status: "supported",
          analyzedFiles: ["src/a.ts", "src/b.tsx"],
          limitations: [],
        },
        {
          ...all("partial", ["src/a.ts", "src/b.tsx"]),
          capabilities: [...all("partial", []).capabilities],
          resolution: "heuristic",
        },
      ],
    },
    {
      provider: "rust-tags",
      capabilities: {},
      files: ["src/main.rs"],
      results: [
        {
          capabilities: ["symbols", "call", "import"],
          status: "partial",
          analyzedFiles: ["src/main.rs"],
          limitations: [],
        },
        {
          capabilities: ["extends", "implements", "type-ref", "read", "write"],
          status: "unsupported",
          analyzedFiles: [],
          limitations: [],
        },
      ],
    },
    {
      provider: "go",
      capabilities: {},
      files: ["cmd/main.go", "pkg/q.go"],
      results: [
        {
          ...all("partial", ["cmd/main.go", "pkg/q.go"]),
          capabilities: [...all("partial", []).capabilities],
          resolution: "heuristic",
        },
      ],
    },
    {
      provider: "scip-go",
      capabilities: {},
      files: ["cmd/main.go", "pkg/q.go"],
      results: [
        {
          capabilities: ["call", "import", "extends", "implements", "type-ref", "read", "write"],
          status: "supported",
          analyzedFiles: ["cmd/main.go"],
          limitations: [],
          resolution: "precise",
        },
      ],
    },
    {
      provider: "yaml",
      capabilities: {},
      files: ["config.yaml"],
      results: [
        {
          capabilities: ["symbols"],
          status: "supported",
          analyzedFiles: ["config.yaml"],
          limitations: [],
        },
      ],
    },
    {
      provider: "text",
      capabilities: {},
      files: ["README.md"],
      results: [
        {
          capabilities: ["symbols", "call"],
          status: "unsupported",
          analyzedFiles: [],
          limitations: [],
        },
      ],
    },
  ];
  expect(readerCoverage(index)).toEqual({
    summary: "What xpl could read: 8 files. Some languages only in part.",
    lines: [
      "Go (2 files): names in part; arrows checked by a language tool in 1 file, matched by name in the rest, so some can be missing.",
      "Rust (1 file): names in part; calls and imports matched by name, so some can be missing; no inherits, implements, type uses, reads or writes.",
      "TypeScript (2 files): names in full; arrows matched by name, so some can be missing.",
      "JSON, YAML (2 files): keys only; no arrows.",
      "Text (1 file): the whole file only.",
    ],
  });
});

it("says what xpl could read in a summary alone when the index recorded nothing", () => {
  const { index } = makeWorld({ files: [{ path: "a.ts" }] });
  delete index.analysis;
  expect(readerCoverage(index)).toEqual({
    summary: "What xpl could read was not recorded (an older index).",
    lines: [],
  });
});

it("says in the summary that arrows are matched by name when every language is read in full that way", () => {
  const { index } = makeWorld({ files: [{ path: "src/A.java", language: "java" }] });
  index.analysis = [
    {
      provider: "java",
      capabilities: {},
      files: ["src/A.java"],
      results: [
        {
          capabilities: ["symbols", "declarationRanges", "nesting"],
          status: "supported",
          analyzedFiles: ["src/A.java"],
          limitations: [],
        },
        {
          capabilities: ["call", "import", "extends", "implements", "type-ref", "read", "write"],
          status: "partial",
          analyzedFiles: ["src/A.java"],
          limitations: [],
          resolution: "heuristic",
        },
      ],
    },
  ];
  expect(readerCoverage(index)).toEqual({
    summary: "What xpl could read: 1 file. Some arrows are matched by name and can be missing.",
    lines: ["Java (1 file): names in full; arrows matched by name, so some can be missing."],
  });
});

it("says every arrow is checked by a language tool, with no warning, when one supported result outranks a partial one", () => {
  const { index } = makeWorld({ files: [{ path: "src/A.java", language: "java" }] });
  const result = (status: "partial" | "supported", capabilities: string[], precise = false) => ({
    capabilities: capabilities as never,
    status,
    analyzedFiles: ["src/A.java"],
    limitations: [],
    ...(precise && { resolution: "precise" as const }),
  });
  index.analysis = [
    {
      provider: "java",
      capabilities: {},
      files: ["src/A.java"],
      results: [
        // a partial read first, then a full one: the full one counts
        result("partial", ["symbols", "declarationRanges", "nesting"]),
        result("supported", ["symbols", "declarationRanges", "nesting"]),
        result(
          "supported",
          ["call", "import", "extends", "implements", "type-ref", "read", "write"],
          true,
        ),
      ],
    },
  ];
  expect(readerCoverage(index)).toEqual({
    summary: "What xpl could read: 1 file.",
    lines: ["Java (1 file): names in full; arrows checked by a language tool."],
  });
});

it("says a language has no names when its symbol pass failed", () => {
  const { index } = makeWorld({ files: [{ path: "a.py", language: "python" }] });
  index.analysis = [
    {
      provider: "python",
      capabilities: {},
      files: ["a.py"],
      results: [
        {
          capabilities: ["symbols", "declarationRanges", "nesting"],
          status: "failed",
          analyzedFiles: [],
          limitations: [],
        },
      ],
    },
  ];
  expect(readerCoverage(index)).toEqual({
    summary: "What xpl could read: 1 file. The analysis failed in part.",
    lines: ["Python (1 file): no names; no arrows; the analysis failed in part."],
  });
});
