import { expect, it } from "vitest";
import { changeOmissions, describeAnalysis } from "../src/index.js";
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
            "Only file anchors are available; named symbols and relationships are unavailable.",
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
    "text (text): named symbols unsupported (0/1 files analyzed). Only file anchors are available; named symbols and relationships are unavailable.",
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
