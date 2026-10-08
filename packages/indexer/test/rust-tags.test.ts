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
    symbols: 20,
    refs: "heuristic",
    tool: "tree-sitter-rust@0.24.0/query-v6",
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
    ["State.Ready", "variable", 17, 17, "a.rs#State"],
    ["Bits", "class", 18, 18, undefined],
    ["Bits.value", "variable", 18, 18, "a.rs#Bits"],
    ["LIMIT", "variable", 19, 19, undefined],
    ["COUNT", "variable", 20, 20, undefined],
    ["make", "other", 21, 21, undefined],
  ]);
  expect(index.symbols.find((s) => s.path === "Work.run")?.hash).toBe(
    hashText("    fn run(&self);"),
  );
  expect(index.refs).toEqual([]);
});

it("anchors named Rust fields and enum variants under their source declarations", async () => {
  const { index, dir } = await indexFiles({
    "model.rs": [
      "struct Job { id: String, attempts: u8 }",
      "union Bits { raw: u32 }",
      "enum Result { Ready, Failed { reason: String }, Count(u8) }",
      "struct Pair(u8, u8);",
      "",
    ].join("\n"),
  });
  expect(index.symbols.map(({ id, kind, range, parent }) => [id, kind, range, parent])).toEqual([
    ["model.rs#Job", "class", { startLine: 1, endLine: 1 }, undefined],
    ["model.rs#Job.id", "variable", { startLine: 1, endLine: 1 }, "model.rs#Job"],
    ["model.rs#Job.attempts", "variable", { startLine: 1, endLine: 1 }, "model.rs#Job"],
    ["model.rs#Bits", "class", { startLine: 2, endLine: 2 }, undefined],
    ["model.rs#Bits.raw", "variable", { startLine: 2, endLine: 2 }, "model.rs#Bits"],
    ["model.rs#Result", "enum", { startLine: 3, endLine: 3 }, undefined],
    ["model.rs#Result.Ready", "variable", { startLine: 3, endLine: 3 }, "model.rs#Result"],
    ["model.rs#Result.Failed", "variable", { startLine: 3, endLine: 3 }, "model.rs#Result"],
    [
      "model.rs#Result.Failed.reason",
      "variable",
      { startLine: 3, endLine: 3 },
      "model.rs#Result.Failed",
    ],
    ["model.rs#Result.Count", "variable", { startLine: 3, endLine: 3 }, "model.rs#Result"],
    ["model.rs#Pair", "class", { startLine: 4, endLine: 4 }, undefined],
  ]);
  const warm = await buildIndex({ root: dir, precise: "off" });
  expect(warm.extraction.hits).toBe(1);
  expect(warm.index.symbols).toEqual(index.symbols);
});

it("keeps fixture macro definitions and physical impls without inventing expanded declarations", async () => {
  const { index, warnings } = await buildIndex({
    root: resolve("fixtures/rs-jobrunner"),
    precise: "off",
  });
  expect(warnings).toEqual([]);
  expect(index.languages.rust).toEqual({
    files: 9,
    symbols: 140,
    refs: "heuristic",
    tool: "tree-sitter-rust@0.24.0/query-v6",
  });
  const expected = [
    ["src/queue.rs#JobQueue", 21, 27, undefined],
    ["src/queue.rs#Job.id", 6, 6, "src/queue.rs#Job"],
    ["src/queue.rs#Queue.ready", 30, 30, "src/queue.rs#Queue"],
    ["src/queue.rs#JobQueue.pop", 22, 22, "src/queue.rs#JobQueue"],
    ["src/queue.rs#impl Queue", 38, 68, undefined],
    ["src/queue.rs#impl JobQueue for Queue", 70, 114, undefined],
    ["src/queue.rs#impl JobQueue for Queue.pop", 71, 87, "src/queue.rs#impl JobQueue for Queue"],
    ["src/runner.rs#counters", 12, 21, undefined],
    ["src/runner.rs#impl RunnerStats.record", 25, 28, "src/runner.rs#impl RunnerStats"],
    ["src/runner.rs#impl Runner<Q>.dispatch", 65, 101, "src/runner.rs#impl Runner<Q>"],
    ["src/worker.rs#RunResult.Success", 12, 12, "src/worker.rs#RunResult"],
    ["src/worker.rs#RunResult.Success.value", 12, 12, "src/worker.rs#RunResult.Success"],
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
    index.refs
      .slice(0, 2)
      .map(({ from, to, site, resolution }) => ({ from, to, site, resolution })),
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
  expect(index.refs).toHaveLength(14);
  expect(
    index.refs
      .filter((ref) => ref.from.endsWith(".dispatch"))
      .map(({ to, site, resolution }) => [to, site.startLine, resolution]),
  ).toEqual([
    ["src/queue.rs#JobQueue.size", 66, "heuristic"],
    ["src/queue.rs#JobQueue.pop", 67, "heuristic"],
    ["src/worker.rs#impl WorkerPool.lease", 71, "heuristic"],
    ["src/worker.rs#impl Worker.run", 78, "heuristic"],
    ["src/worker.rs#impl WorkerPool.release", 79, "heuristic"],
    ["src/runner.rs#impl RunnerStats.record", 80, "heuristic"],
    ["src/queue.rs#JobQueue.ack", 82, "heuristic"],
    ["src/queue.rs#JobQueue.requeue", 87, "heuristic"],
    ["src/queue.rs#JobQueue.dead_letter", 93, "heuristic"],
    ["src/runner.rs#impl Runner<Q>.stop", 99, "heuristic"],
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

it("resolves source-backed trait and concrete receiver calls across Rust modules", async () => {
  const { index, dir } = await indexFiles({
    "src/lib.rs": "mod queue; mod worker; mod runner;\n",
    "src/queue.rs": "pub trait JobQueue { fn pop(&mut self); fn requeue(&mut self); }\n",
    "src/worker.rs": "pub struct Worker; impl Worker { pub fn run(&mut self) {} }\n",
    "src/runner.rs": [
      "use crate::queue::JobQueue;",
      "use crate::worker::Worker;",
      "pub struct Runner<Q: JobQueue> { queue: Q, worker: Worker }",
      "impl<Q: JobQueue> Runner<Q> {",
      "  fn dispatch(&mut self) {",
      "    self.queue.pop();",
      "    self.queue.requeue();",
      "    self.worker.run();",
      "  }",
      "}",
      "",
    ].join("\n"),
  });
  const calls = index.refs.filter((ref) => ref.from.endsWith(".dispatch"));
  expect(calls.map(({ to, site, resolution }) => [to, site.startLine, resolution])).toEqual([
    ["src/queue.rs#JobQueue.pop", 6, "heuristic"],
    ["src/queue.rs#JobQueue.requeue", 7, "heuristic"],
    ["src/worker.rs#impl Worker.run", 8, "heuristic"],
  ]);
  const warm = await buildIndex({ root: dir, precise: "off" });
  expect(warm.extraction.hits).toBe(4);
  expect(warm.index.refs).toEqual(index.refs);
});

it("omits ambiguous impls, receiver types and imports", async () => {
  const { index } = await indexFiles({
    "src/a.rs": "pub struct Worker; impl Worker { pub fn run(&self) {} }\n",
    "src/b.rs": "pub struct Worker; impl Worker { pub fn run(&self) {} }\n",
    "src/remote.rs": "pub struct Remote; impl Remote { pub fn run(&self) {} }\n",
    "src/local.rs": [
      "// use crate::remote::Remote;",
      "struct Remote;",
      "struct Worker;",
      "impl Worker { fn run(&self) {} }",
      "impl Worker { fn run(&self) {} }",
      "struct Owner { worker: Worker, remote: Remote }",
      "impl Owner { fn dispatch(&self) { self.worker.run(); self.remote.run(); } }",
      "",
    ].join("\n"),
    "src/shadow.rs": [
      "struct Worker; impl Worker { fn run(&self) {} }",
      "struct Other; impl Other { fn run(&self) {} }",
      "fn one() -> Worker { Worker }",
      "fn two() -> Option<Other> { None }",
      "struct Owner;",
      "impl Owner { fn dispatch(&self) {",
      "  let worker: Worker = one();",
      "  if let Some(worker) = two() { worker.run(); }",
      "} }",
      "",
    ].join("\n"),
    "src/qualified.rs": [
      "use crate::remote::Remote;",
      "struct Owner { remote: external::Remote }",
      "impl Owner { fn dispatch(&self) { self.remote.run(); } }",
      "",
    ].join("\n"),
    "src/duplicate-import.rs": [
      "use crate::a::Worker;",
      "use crate::b::Worker;",
      "struct Owner { worker: Worker }",
      "impl Owner { fn dispatch(&self) { self.worker.run(); } }",
      "",
    ].join("\n"),
  });
  expect(index.refs).toEqual([]);
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
    "Unknown, shadowed and ambiguous receivers",
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

it("uses one Rust identifier spelling for raw declarations, calls and shadowing", async () => {
  const { index } = await indexFiles({
    "raw.rs": [
      "fn target() {}",
      "fn r#plain() {}",
      "fn parameter(r#target: fn()) { target(); }",
      "fn binding() { let r#target = || {}; target(); }",
      "fn opposite(target: fn()) { r#target(); }",
      "fn nested() { fn r#target() {} target(); }",
      "struct Callbacks { target: fn() }",
      "fn shorthand(value: Callbacks) { let Callbacks { r#target } = value; target(); }",
      "fn yes() { target(); plain(); r#plain(); }",
    ].join("\n"),
  });
  expect(index.refs.map((ref) => [ref.from, ref.to, ref.resolution])).toEqual([
    ["raw.rs#yes", "raw.rs#target", "heuristic"],
    ["raw.rs#yes", "raw.rs#r#plain", "heuristic"],
    ["raw.rs#yes", "raw.rs#r#plain", "heuristic"],
  ]);
});
