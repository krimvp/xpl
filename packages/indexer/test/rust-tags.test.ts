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
  expect(index.languages.rust).toEqual({
    files: 1,
    symbols: 18,
    refs: "heuristic",
    tool: "tree-sitter-rust@0.24.0/query-v3",
  });
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
  expect(index.languages.rust).toEqual({
    files: 9,
    symbols: 82,
    refs: "heuristic",
    tool: "tree-sitter-rust@0.24.0/query-v3",
  });
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
  expect(
    index.refs.map(({ from, to, site, resolution }) => ({ from, to, site, resolution })),
  ).toEqual([
    {
      from: "src/config.rs#load_config",
      to: "src/config.rs#config_from_text",
      site: { startLine: 64, startCol: 5, endLine: 64, endCol: 83 },
      resolution: "heuristic",
    },
    {
      from: "src/config.rs#config_from_text",
      to: "src/config.rs#parse_yaml",
      site: { startLine: 68, startCol: 20, endLine: 68, endCol: 35 },
      resolution: "heuristic",
    },
  ]);
  expect(describeAnalysis(index).details.filter((s) => s.startsWith("rust ("))).not.toContainEqual(
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
  expect(describeAnalysis(index).details.filter((s) => s.startsWith("rust ("))).toEqual([
    "rust (files): file anchors supported (1/1 files analyzed).",
    expect.stringContaining(
      "rust (rust-tags): named symbols, full declaration ranges, nesting partial (1/1 files analyzed)",
    ),
    expect.stringContaining("rust (rust-tags): calls failed (0/1 files analyzed)"),
    expect.stringContaining(
      "rust (rust-tags): imports, inheritance, implementations, type references, reads, writes unsupported (0/1 files analyzed)",
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

it("groups matching tags coverage while keeping syntax-error file scopes separate", async () => {
  const { index, warnings } = await indexFiles({
    "a.rs": "fn a() {}\n",
    "b.rs": "fn broken(\n",
    "c.rs": "fn c() {}\n",
    "d.rs": "fn broken(\n",
  });
  expect(warnings).toEqual([
    "1 file(s) have syntax errors; symbols near these lines may be incomplete: b.rs:1",
    "1 file(s) have syntax errors; symbols near these lines may be incomplete: d.rs:1",
  ]);
  const reports = index.analysis!.filter((r) => r.provider === "rust-tags");
  expect(reports.map((r) => r.files)).toEqual([
    ["a.rs", "c.rs"],
    ["b.rs", "d.rs"],
  ]);
  expect(
    reports.map((r) => r.results.map(({ status, analyzedFiles }) => ({ status, analyzedFiles }))),
  ).toEqual([
    [
      { status: "partial", analyzedFiles: ["a.rs", "c.rs"] },
      { status: "partial", analyzedFiles: ["a.rs", "c.rs"] },
      { status: "unsupported", analyzedFiles: [] },
    ],
    [
      { status: "partial", analyzedFiles: ["b.rs", "d.rs"] },
      { status: "failed", analyzedFiles: [] },
      { status: "unsupported", analyzedFiles: [] },
    ],
  ]);
  expect(reports[0]!.results[0]!.limitations).not.toContain(
    "Syntax errors may leave declarations incomplete.",
  );
  expect(reports[1]!.results[0]!.limitations).toContain(
    "Syntax errors may leave declarations incomplete.",
  );
});

it("resolves unshadowed bare calls between same-file root functions as heuristic", async () => {
  const { index } = await indexFiles({
    "main.rs": "fn leaf() {}\nfn run() { leaf(); missing(); other::leaf(); }\n",
    "other.rs": "fn missing() {}\n",
    "broken.rs": "fn leaf() {}\nfn run() { leaf(); }\nfn broken(\n",
  });
  expect(
    index.refs.map(({ from, to, kind, site, resolution }) => ({
      from,
      to,
      kind,
      site,
      resolution,
    })),
  ).toEqual([
    {
      from: "main.rs#run",
      to: "main.rs#leaf",
      kind: "call",
      site: { startLine: 2, endLine: 2, startCol: 12, endCol: 17 },
      resolution: "heuristic",
    },
  ]);
  expect(index.languages.rust?.refs).toBe("heuristic");
  expect(describeAnalysis(index).details.join("\n")).toContain("calls partial");
});

it("leaves shadowing, macro bodies and non-root dispatch outside the Rust call slice", async () => {
  const { index } = await indexFiles({
    "a.rs": [
      "fn target() {}",
      "fn yes() { target(); }",
      "fn parameter(target: fn()) { target(); }",
      "struct Callbacks { target: fn() }",
      "fn shorthand(value: Callbacks) { let Callbacks { target } = value; target(); }",
      "fn matched(value: Callbacks) { match value { Callbacks { target } => target() } }",
      "fn destructured_parameter(Callbacks { target }: Callbacks) { target(); }",
      "fn binding() { let target = || {}; target(); }",
      "fn pattern() { if let Some(target) = None::<fn()> { target(); } }",
      "fn nested() { fn target() {} target(); }",
      "fn constructor() { struct target(); target(); }",
      "fn imported() { use elsewhere::target; target(); }",
      "fn expanded() { build!(); target(); }",
      "fn closure() { let f = || target(); }",
      "fn qualified(value: Thing) { value.target(); Thing::target(); other::target(); unknown(); }",
      "mod child { fn caller() { target(); } fn target() {} }",
      "struct Thing; impl Thing { fn target() { target(); } }",
      "trait Trait { fn target() { target(); } }",
      "fn duplicate() {} fn duplicate() {} fn ambiguous() { duplicate(); }",
    ].join("\n"),
  });
  expect(index.refs.map((ref) => [ref.from, ref.to, ref.resolution])).toEqual([
    ["a.rs#yes", "a.rs#target", "heuristic"],
  ]);
  expect(describeAnalysis(index).details.join("\n")).toContain(
    "Unknown, shadowed and qualified/generic calls",
  );
});

it("keeps UTF-16 multiline call ranges through the extraction cache", async () => {
  const { index, dir } = await indexFiles({
    "a.rs": 'fn leaf() {}\nfn run() { "é😀"; leaf(\n); }\n',
  });
  const expected = [
    {
      from: "a.rs#run",
      to: "a.rs#leaf",
      kind: "call",
      site: { startLine: 2, startCol: 19, endLine: 3, endCol: 1 },
      resolution: "heuristic",
    },
  ];
  const fields = (refs: typeof index.refs) =>
    refs.map(({ from, to, kind, site, resolution }) => ({ from, to, kind, site, resolution }));
  expect(fields(index.refs)).toEqual(expected);
  const warm = await buildIndex({ root: dir, precise: "off" });
  expect(fields(warm.index.refs)).toEqual(expected);
  expect(warm.extraction.hits).toBe(1);
});
