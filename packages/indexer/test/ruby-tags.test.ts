import { expect, it } from "vitest";
import { resolve } from "node:path";
import { describeAnalysis } from "@xpl/core";
import { buildIndex } from "../src/index.js";
import { indexFiles } from "./helpers.js";

it("indexes Ruby constants under source-backed owners and omits unknown scoped owners", async () => {
  const { index, dir } = await indexFiles({
    "jobs.rb": [
      "module Jobs",
      '  DEFAULT = "é😀"',
      '  Jobs::VERSION = "1"',
      "  class Runner",
      "    def run(job)",
      "      job",
      "    end",
      "    def self.build; new; end",
      "  end",
      "end",
      "",
    ].join("\n"),
  });
  expect(index.files.map(({ path, language }) => [path, language])).toEqual([["jobs.rb", "ruby"]]);
  expect(index.symbols.map(({ id, kind, range, parent }) => [id, kind, range, parent])).toEqual([
    ["jobs.rb#Jobs", "other", { startLine: 1, endLine: 10 }, undefined],
    ["jobs.rb#Jobs.DEFAULT", "variable", { startLine: 2, endLine: 2 }, "jobs.rb#Jobs"],
    ["jobs.rb#Jobs.VERSION", "variable", { startLine: 3, endLine: 3 }, "jobs.rb#Jobs"],
    ["jobs.rb#Jobs.Runner", "class", { startLine: 4, endLine: 9 }, "jobs.rb#Jobs"],
    ["jobs.rb#Jobs.Runner.run", "method", { startLine: 5, endLine: 7 }, "jobs.rb#Jobs.Runner"],
    [
      "jobs.rb#Jobs.Runner.self.build",
      "method",
      { startLine: 8, endLine: 8 },
      "jobs.rb#Jobs.Runner",
    ],
  ]);
  expect(index.refs).toEqual([]);
  const warm = await buildIndex({ root: dir, precise: "off" });
  expect(warm.extraction.hits).toBe(1);
  expect(warm.index.symbols).toEqual(index.symbols);
});

it("resolves rooted and nested Ruby constant owners within the same file", async () => {
  const { index, dir } = await indexFiles({
    "scopes.rb": [
      "module Top; end",
      "module Jobs",
      "  module Other; end",
      "  Other::CONST = 1",
      "  ::Top::CONST = 2",
      "end",
      "Jobs::VERSION = 3",
      "Other::UNKNOWN = 4",
      "",
    ].join("\n"),
    "elsewhere.rb": "module Other; end\n",
  });
  expect(index.symbols.map(({ id, range, parent }) => [id, range, parent])).toEqual([
    ["elsewhere.rb#Other", { startLine: 1, endLine: 1 }, undefined],
    ["scopes.rb#Top", { startLine: 1, endLine: 1 }, undefined],
    ["scopes.rb#Jobs", { startLine: 2, endLine: 6 }, undefined],
    ["scopes.rb#Jobs.Other", { startLine: 3, endLine: 3 }, "scopes.rb#Jobs"],
    ["scopes.rb#Jobs.Other.CONST", { startLine: 4, endLine: 4 }, "scopes.rb#Jobs.Other"],
    ["scopes.rb#Top.CONST", { startLine: 5, endLine: 5 }, "scopes.rb#Top"],
    ["scopes.rb#Jobs.VERSION", { startLine: 7, endLine: 7 }, "scopes.rb#Jobs"],
  ]);
  expect(index.refs).toEqual([]);
  const warm = await buildIndex({ root: dir, precise: "off" });
  expect(warm.extraction.hits).toBe(2);
  expect(warm.index.symbols).toEqual(index.symbols);
});

it("keeps a scoped constant under the active reopened module", async () => {
  const { index } = await indexFiles({
    "reopened.rb": "module Jobs; end\nmodule Jobs\n  Jobs::VERSION = 1\nend\n",
  });
  expect(index.symbols.map(({ id, range, parent }) => [id, range, parent])).toEqual([
    ["reopened.rb#Jobs", { startLine: 1, endLine: 1 }, undefined],
    ["reopened.rb#Jobs~2", { startLine: 2, endLine: 4 }, undefined],
    ["reopened.rb#Jobs.VERSION", { startLine: 3, endLine: 3 }, "reopened.rb#Jobs~2"],
  ]);
  expect(index.refs).toEqual([]);
});

it("uses established owners for qualified Ruby module declarations", async () => {
  const { index } = await indexFiles({
    "qualified.rb": [
      "module Top; end",
      "module Top::Inner; end",
      "Top::Inner::VALUE = 1",
      "module Outer",
      "  module Top::Nested; end",
      "  module Missing::Ghost; end",
      "end",
      "",
    ].join("\n"),
  });
  expect(index.symbols.map(({ id, range, parent }) => [id, range, parent])).toEqual([
    ["qualified.rb#Top", { startLine: 1, endLine: 1 }, undefined],
    ["qualified.rb#Top.Inner", { startLine: 2, endLine: 2 }, "qualified.rb#Top"],
    ["qualified.rb#Top.Inner.VALUE", { startLine: 3, endLine: 3 }, "qualified.rb#Top.Inner"],
    ["qualified.rb#Outer", { startLine: 4, endLine: 7 }, undefined],
    ["qualified.rb#Top.Nested", { startLine: 5, endLine: 5 }, "qualified.rb#Top"],
  ]);
  expect(index.refs).toEqual([]);
});

it("omits children of a qualified Ruby namespace whose owner is unknown", async () => {
  const { index } = await indexFiles({
    "unknown.rb": [
      "module Missing::Ghost",
      "  VALUE = 1",
      "  def run; end",
      "end",
      "module Known",
      "  module Missing::Other",
      "    INNER = 2",
      "  end",
      "  GOOD = 3",
      "end",
      "",
    ].join("\n"),
  });
  expect(index.symbols.map(({ id, range, parent }) => [id, range, parent])).toEqual([
    ["unknown.rb#Known", { startLine: 5, endLine: 10 }, undefined],
    ["unknown.rb#Known.GOOD", { startLine: 9, endLine: 9 }, "unknown.rb#Known"],
  ]);
  expect(index.refs).toEqual([]);
});

it("does not invent lexical ancestors inside a qualified Ruby module", async () => {
  const { index } = await indexFiles({
    "nesting.rb": [
      "module A",
      "  module C; end",
      "  module B",
      "    C::DIRECT = 1",
      "  end",
      "end",
      "module A::B",
      "  ::A::C::ROOTED = 2",
      "  C::WRONG = 3",
      "end",
      "",
    ].join("\n"),
  });
  expect(index.symbols.map(({ id, range, parent }) => [id, range, parent])).toEqual([
    ["nesting.rb#A", { startLine: 1, endLine: 6 }, undefined],
    ["nesting.rb#A.C", { startLine: 2, endLine: 2 }, "nesting.rb#A"],
    ["nesting.rb#A.B", { startLine: 3, endLine: 5 }, "nesting.rb#A"],
    ["nesting.rb#A.C.DIRECT", { startLine: 4, endLine: 4 }, "nesting.rb#A.C"],
    ["nesting.rb#A.B~2", { startLine: 7, endLine: 10 }, "nesting.rb#A"],
    ["nesting.rb#A.C.ROOTED", { startLine: 8, endLine: 8 }, "nesting.rb#A.C"],
  ]);
  expect(index.refs).toEqual([]);
});

it("keeps repeated namespaces separate and reports syntax recovery without relationship claims", async () => {
  const { index, warnings, dir } = await indexFiles({
    "broken.rb": "module Jobs; end\nmodule Jobs; end\nclass Broken\n  def run(\n",
  });
  expect(index.symbols.map(({ id, range }) => [id, range])).toEqual([
    ["broken.rb#Jobs", { startLine: 1, endLine: 1 }],
    ["broken.rb#Jobs~2", { startLine: 2, endLine: 2 }],
  ]);
  expect(warnings).toEqual([
    "1 file(s) have syntax errors; symbols near these lines may be incomplete: broken.rb:3",
  ]);
  expect(describeAnalysis(index).details.join("\n")).toContain(
    "Syntax errors may leave declarations incomplete.",
  );
  expect(index.refs).toEqual([]);
  await expect(buildIndex({ root: dir, precise: "require" })).rejects.toThrow(
    "no precise provider is available for: ruby",
  );
});

it("indexes the runnable Ruby jobrunner with source-backed methods and no reference claims", async () => {
  const { index, warnings } = await buildIndex({
    root: resolve("fixtures/rb-jobrunner"),
    precise: "off",
  });
  expect(warnings).toEqual([]);
  expect(index.languages.ruby).toEqual({ files: 4, symbols: 16, refs: "none" });
  expect(
    index.symbols.map(({ id, range, parent }) => [id, range.startLine, range.endLine, parent]),
  ).toContainEqual([
    "lib/jobrunner/runner.rb#Jobrunner.Runner.drain",
    7,
    11,
    "lib/jobrunner/runner.rb#Jobrunner.Runner",
  ]);
  expect(index.refs).toEqual([]);
  expect(describeAnalysis(index).details.join("\n")).toContain(
    "ruby (ruby-tags): named symbols, full declaration ranges, nesting partial (4/4 files analyzed)",
  );
});
