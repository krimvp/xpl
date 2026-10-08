import { cpSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { beforeAll, expect, it } from "vitest";
import type { SymbolIndex } from "@xpl/core";
import { buildIndex, scipArtifactProvider } from "../src/index.js";
import { makeDir, writeFiles } from "./helpers.js";

const data = new URL("./data/java-jobrunner/", import.meta.url);
const artifact = gunzipSync(readFileSync(new URL("index.scip.gz", data)));
const manifest: unknown = JSON.parse(readFileSync(new URL("manifest.json", data), "utf8"));
const path = (file: string) => `src/main/java/jobrunner/${file}.java`;
const id = (file: string, symbol: string) => `${path(file)}#${symbol}`;
let index: SymbolIndex;
let root: string;
beforeAll(async () => {
  root = makeDir();
  cpSync(fileURLToPath(new URL("../../../fixtures/java-jobrunner/", import.meta.url)), root, {
    recursive: true,
  });
  const built = await buildIndex({
    root,
    precise: "require",
    providers: [scipArtifactProvider({ artifact, manifest })],
  });
  expect(built.warnings).toEqual([]);
  index = built.index;
});

it("imports the recorded scip-java overloads, both nested class forms and annotation-inclusive ranges", () => {
  const selected = [
    id("Handler", "Handler"),
    id("Handler", "Handler.handle"),
    id("Queue", "Queue.Job"),
    id("Queue", "Queue.push"),
    id("Queue", "Queue.push~2"),
    id("Runner", "Runner.Stats"),
    id("Worker", "Worker.run"),
  ];
  expect(
    index.symbols
      .filter((s) => selected.includes(s.id))
      .map((s) => [s.id, s.kind, s.parent, s.range]),
  ).toEqual([
    [id("Handler", "Handler"), "interface", undefined, { startLine: 3, endLine: 6 }],
    [
      id("Handler", "Handler.handle"),
      "method",
      id("Handler", "Handler"),
      { startLine: 5, endLine: 5 },
    ],
    [id("Queue", "Queue.Job"), "class", id("Queue", "Queue"), { startLine: 10, endLine: 25 }],
    [id("Queue", "Queue.push"), "method", id("Queue", "Queue"), { startLine: 37, endLine: 37 }],
    [id("Queue", "Queue.push~2"), "method", id("Queue", "Queue"), { startLine: 38, endLine: 43 }],
    [id("Runner", "Runner.Stats"), "class", id("Runner", "Runner"), { startLine: 8, endLine: 15 }],
    [id("Worker", "Worker.run"), "method", id("Worker", "Worker"), { startLine: 20, endLine: 42 }],
  ]);
  expect(index.files.filter((f) => f.path.endsWith(".java")).map((f) => f.language)).toEqual(
    Array(13).fill("java"),
  );
});

it("keeps precise artifact type mentions beside heuristic Java inheritance and calls", () => {
  expect(
    index.refs
      .filter((r) => r.from === id("EchoHandler", "EchoHandler"))
      .map((r) => [r.to, r.kind, r.resolution, r.site]),
  ).toEqual([
    [
      id("BaseHandler", "BaseHandler"),
      "extends",
      "heuristic",
      { startLine: 3, startCol: 40, endLine: 3, endCol: 50 },
    ],
    [
      id("BaseHandler", "BaseHandler"),
      "type-ref",
      "precise",
      { startLine: 3, startCol: 40, endLine: 3, endCol: 50 },
    ],
    [
      id("Handler", "Handler"),
      "implements",
      "heuristic",
      { startLine: 3, startCol: 63, endLine: 3, endCol: 69 },
    ],
    [
      id("Handler", "Handler"),
      "type-ref",
      "precise",
      { startLine: 3, startCol: 63, endLine: 3, endCol: 69 },
    ],
  ]);
  expect(
    index.refs
      .filter(
        (r) =>
          r.from === id("Runner", "Runner.dispatch") &&
          (r.site.startLine === 44 || r.site.startLine === 51) &&
          (r.to.endsWith(".pop") || r.to.endsWith(".run")),
      )
      .map((r) => [r.to, r.kind, r.resolution]),
  ).toEqual([
    [id("Queue", "Queue.pop"), "call", "heuristic"],
    [id("Worker", "Worker.run"), "call", "heuristic"],
  ]);
  const report = index.analysis!.find((r) => r.provider === "scip-artifact")!;
  expect(
    report.results
      .filter(
        (r) =>
          r.capabilities.includes("call") ||
          r.capabilities.includes("extends") ||
          r.capabilities.includes("implements"),
      )
      .map((r) => [r.capabilities, r.status, r.analyzedFiles]),
  ).toEqual([
    [["call"], "unsupported", []],
    [["extends"], "unsupported", []],
    [["implements"], "unsupported", []],
  ]);
  const prefix = "scip-java maven maven/dev.xpl.fixture/java-jobrunner 1.0.0 jobrunner/";
  expect(report.diagnostics).toEqual(
    expect.arrayContaining([
      `${path("Runner")}:44:35: ${prefix}Queue#pop().: occurrence classification unavailable (calls are not encoded in SCIP roles)`,
      `${path("Runner")}:51:33: ${prefix}Worker#run().: occurrence classification unavailable (calls are not encoded in SCIP roles)`,
      `${path("Metrics")}:17:79: ${prefix}Metrics#onJobCompleted().: occurrence classification unavailable (calls are not encoded in SCIP roles)`,
      `${path("EchoHandler")}: SymbolInformation relationships omitted; implementation/override direction and class inheritance are not established by these flags`,
    ]),
  );
});

it("keeps the syntax record without inventing unsupported artifact accessors", () => {
  const report = index.analysis!.find((r) => r.provider === "scip-artifact")!;
  expect(
    index.symbols
      .filter((s) => s.id.startsWith(id("Queue", "Queue.DeadJob")))
      .map((s) => [s.path, s.kind, s.range]),
  ).toEqual([["Queue.DeadJob", "class", { startLine: 27, endLine: 27 }]]);
  expect(
    report.diagnostics!.filter((d) =>
      d.includes("Queue#DeadJob#job().: external, omitted or unresolved target"),
    ),
  ).toEqual([
    "src/test/java/jobrunner/RetryTest.java:38:40: scip-java maven maven/dev.xpl.fixture/java-jobrunner 1.0.0 jobrunner/Queue#DeadJob#job().: external, omitted or unresolved target",
  ]);
});

it("leaves an uncompiled Java file at file anchors and reports incomplete artifact coverage", async () => {
  const incompleteRoot = makeDir();
  cpSync(root, incompleteRoot, { recursive: true });
  writeFiles(incompleteRoot, {
    "src/main/java/jobrunner/Uncompiled.java": "class Uncompiled {}\n",
  });
  const { index: incomplete } = await buildIndex({
    root: incompleteRoot,
    precise: "require",
    providers: [scipArtifactProvider({ artifact, manifest })],
  });
  expect(incomplete.files.find((f) => f.path.endsWith("Uncompiled.java"))).toMatchObject({
    language: "java",
    lines: 2,
  });
  expect(
    incomplete.symbols.filter((s) => s.file.endsWith("Uncompiled.java")).map((s) => s.path),
  ).toEqual(["Uncompiled"]);
  const ranges = incomplete
    .analysis!.find((r) => r.provider === "scip-artifact")!
    .results.find((r) => r.capabilities.includes("declarationRanges"))!;
  expect(ranges.status).toBe("partial");
  expect(ranges.analyzedFiles).toHaveLength(13);
  expect(ranges.limitations).toContain(
    "Some source files are absent, stale or have unknown positions.",
  );
  const { index: fallback } = await buildIndex({ root: incompleteRoot, precise: "off" });
  expect(fallback.files.filter((f) => f.path.endsWith(".java"))).toHaveLength(14);
  expect(
    fallback.symbols.filter((s) => s.file.endsWith("Uncompiled.java")).map((s) => s.path),
  ).toEqual(["Uncompiled"]);
});
