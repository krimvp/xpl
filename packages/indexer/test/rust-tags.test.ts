import { expect, it } from "vitest";
import { indexFiles } from "./helpers.js";
import { resolve } from "node:path";
import { buildIndex } from "../src/index.js";
import { describeAnalysis, hashText } from "@xpl/core";

it("indexes Rust tags with precise off and keeps lexical trait, impl and module parents", async () => {
  const source = [
    "pub trait Work {",
    "    fn run(&self);",
    "    fn defaulted(&self) {}",
    "}",
    "pub struct Runner<T>(T);",
    "impl<T> Runner<T> {",
    "    pub fn run(&self) {}",
    "}",
    "impl<T> Work for Runner<T> {",
    "    fn run(&self) {}",
    "}",
    "mod demo {",
    "    pub fn run() { unknown(); }",
    "}",
    "mod demo { pub fn run() {} }",
    "type Alias = Runner<u8>;",
    "enum State { Ready }",
    "union Bits { value: u32 }",
    "const LIMIT: u32 = 3;",
    "static COUNT: u32 = 0;",
    "macro_rules! make { () => { struct Generated; } }",
    "make!();",
    "",
  ].join("\n");
  const { index, warnings } = await indexFiles({ "a.rs": source });
  expect(warnings).toEqual([]);
  expect(index.languages.rust).toEqual({ files: 1, symbols: 18, refs: "none" });
  expect(
    index.symbols.map((s) => [s.path, s.kind, s.range.startLine, s.range.endLine, s.parent]),
  ).toEqual([
    ["Work", "interface", 1, 4, undefined],
    ["Work.run", "method", 2, 2, "a.rs#Work"],
    ["Work.defaulted", "method", 3, 3, "a.rs#Work"],
    ["Runner", "class", 5, 5, undefined],
    ["impl Runner<T>", "other", 6, 8, undefined],
    ["impl Runner<T>.run", "method", 7, 7, "a.rs#impl Runner<T>"],
    ["impl Work for Runner<T>", "other", 9, 11, undefined],
    ["impl Work for Runner<T>.run", "method", 10, 10, "a.rs#impl Work for Runner<T>"],
    ["demo", "other", 12, 14, undefined],
    ["demo.run", "function", 13, 13, "a.rs#demo"],
    ["demo~2", "other", 15, 15, undefined],
    ["demo.run~2", "function", 15, 15, "a.rs#demo~2"],
    ["Alias", "type", 16, 16, undefined],
    ["State", "enum", 17, 17, undefined],
    ["Bits", "class", 18, 18, undefined],
    ["LIMIT", "variable", 19, 19, undefined],
    ["COUNT", "variable", 20, 20, undefined],
    ["make", "other", 21, 21, undefined],
  ]);
  expect(index.symbols.find((s) => s.path === "Work.run")?.hash).toBe(
    hashText("    fn run(&self);"),
  );
  expect(index.refs).toEqual([]);
});

it("keeps fixture macro definitions and physical impls without inventing expanded declarations", async () => {
  const { index, warnings } = await buildIndex({
    root: resolve("fixtures/rs-jobrunner"),
    precise: "off",
  });
  expect(warnings).toEqual([]);
  expect(index.languages.rust).toEqual({ files: 9, symbols: 82, refs: "none" });
  const expected = [
    ["src/queue.rs#JobQueue", 21, 27, undefined],
    ["src/queue.rs#JobQueue.pop", 22, 22, "src/queue.rs#JobQueue"],
    ["src/queue.rs#impl Queue", 38, 68, undefined],
    ["src/queue.rs#impl JobQueue for Queue", 70, 114, undefined],
    ["src/queue.rs#impl JobQueue for Queue.pop", 71, 87, "src/queue.rs#impl JobQueue for Queue"],
    ["src/runner.rs#counters", 12, 21, undefined],
    ["src/runner.rs#impl RunnerStats.record", 25, 28, "src/runner.rs#impl RunnerStats"],
    ["src/runner.rs#impl Runner<Q>.dispatch", 65, 101, "src/runner.rs#impl Runner<Q>"],
    ["src/main.rs#demo.echo", 13, 15, "src/main.rs#demo"],
    ["src/worker.rs#demo.handlers.echo", 106, 108, "src/worker.rs#demo.handlers"],
  ];
  expect(
    expected.map(([id]) => {
      const s = index.symbols.find((s) => s.id === id);
      return s ? [s.id, s.range.startLine, s.range.endLine, s.parent] : undefined;
    }),
  ).toEqual(expected);
  expect(index.symbols.filter((s) => s.path === "RunnerStats" || s.path === "$name")).toEqual([]);
  expect(index.refs).toEqual([]);
  expect(describeAnalysis(index).details.filter((s) => s.startsWith("rust:"))).not.toContainEqual(
    expect.stringContaining("Only file anchors are available"),
  );
});

it("reports syntax recovery and does not promise precise Rust relationships", async () => {
  const { index, warnings, dir } = await indexFiles({
    "a.rs": 'const EMOJI: &str = "é😀"; fn valid() {}\nfn broken(\n',
  });
  expect(index.symbols.map((s) => [s.path, s.range])).toEqual([
    ["EMOJI", { startLine: 1, endLine: 1 }],
    ["valid", { startLine: 1, endLine: 1 }],
  ]);
  expect(warnings).toEqual([
    "1 file(s) have syntax errors; symbols near these lines may be incomplete: a.rs:2",
  ]);
  expect(describeAnalysis(index).details.filter((s) => s.startsWith("rust:"))).toEqual([
    "rust: file anchors supported (1/1 files analyzed).",
    expect.stringContaining(
      "named symbols, full declaration ranges, nesting partial (1/1 files analyzed)",
    ),
    expect.stringContaining(
      "calls, imports, inheritance, implementations, type references, reads, writes unsupported (0/1 files analyzed)",
    ),
  ]);
  expect(describeAnalysis(index).details.join("\n")).toContain(
    "Syntax errors may leave declarations incomplete.",
  );
  await expect(buildIndex({ root: dir, precise: "require" })).rejects.toThrow(
    "no precise provider is available for: rust",
  );
});

it("keeps multiline generic and scoped impl headers as declaration anchors", async () => {
  const { index, warnings } = await indexFiles({
    "a.rs": [
      "impl<T> api::Work for api::Runner<",
      "    T,",
      "> {",
      "    fn run(&self) {}",
      "}",
      'extern "C" { fn external(); }',
      "",
    ].join("\n"),
  });
  expect(warnings).toEqual([]);
  expect(index.symbols.map((s) => [s.path, s.kind, s.range, s.parent])).toEqual([
    ["impl api::Work for api::Runner< T, >", "other", { startLine: 1, endLine: 5 }, undefined],
    [
      "impl api::Work for api::Runner< T, >.run",
      "method",
      { startLine: 4, endLine: 4 },
      "a.rs#impl api::Work for api::Runner< T, >",
    ],
    ["external", "function", { startLine: 6, endLine: 6 }, undefined],
  ]);
});
