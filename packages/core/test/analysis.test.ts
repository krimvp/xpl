import { expect, it } from "vitest";
import { describeAnalysis } from "../src/index.js";
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
