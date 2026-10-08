import { expect, it } from "vitest";
import { resolve } from "node:path";
import { describeAnalysis } from "@xpl/core";
import { buildIndex } from "../src/index.js";
import { indexFiles } from "./helpers.js";

it("indexes Ruby namespaces, methods and constants as source-backed declarations", async () => {
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
    ["jobs.rb#Jobs.Jobs::VERSION", "variable", { startLine: 3, endLine: 3 }, "jobs.rb#Jobs"],
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
