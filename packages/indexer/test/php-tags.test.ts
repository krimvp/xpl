import { expect, it } from "vitest";
import { buildIndex } from "../src/index.js";
import { indexFiles } from "./helpers.js";

it("indexes PHP namespaces and declarations with bounded lexical parents", async () => {
  const source = [
    "<?php",
    "namespace Psr\\Log;",
    "interface LoggerInterface {",
    "  public function info(string $message): void;",
    "}",
    "trait Contextual {",
    "  public function context(): array { return []; }",
    "}",
    "class Runner implements LoggerInterface {",
    "  public const VERSION = 'é😀';",
    "  public function info(string $message): void {}",
    "}",
    "function normalize(string $message): string { return $message; }",
    "namespace Other;",
    "class Second {}",
    "",
  ].join("\n");
  const { index, dir } = await indexFiles({ "src/logger.php": source });
  expect(index.files.map(({ path, language }) => [path, language])).toEqual([
    ["src/logger.php", "php"],
  ]);
  expect(index.symbols.map(({ id, kind, range, parent }) => [id, kind, range, parent])).toEqual([
    ["src/logger.php#Psr\\Log", "other", { startLine: 2, endLine: 13 }, undefined],
    [
      "src/logger.php#Psr\\Log.LoggerInterface",
      "interface",
      { startLine: 3, endLine: 5 },
      "src/logger.php#Psr\\Log",
    ],
    [
      "src/logger.php#Psr\\Log.LoggerInterface.info",
      "method",
      { startLine: 4, endLine: 4 },
      "src/logger.php#Psr\\Log.LoggerInterface",
    ],
    [
      "src/logger.php#Psr\\Log.Contextual",
      "type",
      { startLine: 6, endLine: 8 },
      "src/logger.php#Psr\\Log",
    ],
    [
      "src/logger.php#Psr\\Log.Contextual.context",
      "method",
      { startLine: 7, endLine: 7 },
      "src/logger.php#Psr\\Log.Contextual",
    ],
    [
      "src/logger.php#Psr\\Log.Runner",
      "class",
      { startLine: 9, endLine: 12 },
      "src/logger.php#Psr\\Log",
    ],
    [
      "src/logger.php#Psr\\Log.Runner.VERSION",
      "variable",
      { startLine: 10, endLine: 10 },
      "src/logger.php#Psr\\Log.Runner",
    ],
    [
      "src/logger.php#Psr\\Log.Runner.info",
      "method",
      { startLine: 11, endLine: 11 },
      "src/logger.php#Psr\\Log.Runner",
    ],
    [
      "src/logger.php#Psr\\Log.normalize",
      "function",
      { startLine: 13, endLine: 13 },
      "src/logger.php#Psr\\Log",
    ],
    ["src/logger.php#Other", "other", { startLine: 14, endLine: 15 }, undefined],
    [
      "src/logger.php#Other.Second",
      "class",
      { startLine: 15, endLine: 15 },
      "src/logger.php#Other",
    ],
  ]);
  expect(index.refs).toEqual([]);
  const warm = await buildIndex({ root: dir, precise: "off" });
  expect(warm.extraction.hits).toBe(1);
  expect(warm.index.symbols).toEqual(index.symbols);
});

it("keeps reopened PHP namespaces distinct and warns on syntax recovery", async () => {
  const { index, warnings, dir } = await indexFiles({
    "broken.php":
      "<?php\nnamespace Jobs;\nclass First {}\nnamespace Jobs;\nclass Second {}\nclass Broken {\n",
  });
  expect(index.symbols.map(({ id, parent }) => [id, parent])).toEqual([
    ["broken.php#Jobs", undefined],
    ["broken.php#Jobs.First", "broken.php#Jobs"],
    ["broken.php#Jobs~2", undefined],
    ["broken.php#Jobs.Second", "broken.php#Jobs~2"],
    ["broken.php#Jobs.Broken", "broken.php#Jobs~2"],
  ]);
  expect(warnings).toEqual([
    "1 file(s) have syntax errors; symbols near these lines may be incomplete: broken.php:6",
  ]);
  expect(index.refs).toEqual([]);
  await expect(buildIndex({ root: dir, precise: "require" })).rejects.toThrow(
    "no precise provider is available for: php",
  );
});

it("keeps braced namespace declarations inside their source scope", async () => {
  const { index, warnings } = await indexFiles({
    "braced.php":
      "<?php\nnamespace One { class First {} }\nnamespace Two { function second() {} }\n",
  });
  expect(warnings).toEqual([]);
  expect(index.symbols.map(({ id, range, parent }) => [id, range, parent])).toEqual([
    ["braced.php#One", { startLine: 2, endLine: 2 }, undefined],
    ["braced.php#One.First", { startLine: 2, endLine: 2 }, "braced.php#One"],
    ["braced.php#Two", { startLine: 3, endLine: 3 }, undefined],
    ["braced.php#Two.second", { startLine: 3, endLine: 3 }, "braced.php#Two"],
  ]);
});

it("indexes the PHP jobrunner fixture with source-backed methods and no relationships", async () => {
  const { index, warnings } = await buildIndex({ root: "fixtures/php-jobrunner", precise: "off" });
  expect(warnings).toEqual([]);
  expect(index.languages.php).toEqual({ files: 4, symbols: 13, refs: "none" });
  expect(
    index.symbols.map(({ id, range, parent }) => [id, range.startLine, range.endLine, parent]),
  ).toContainEqual([
    "src/Jobrunner/Runner.php#Jobrunner.Runner.drain",
    8,
    15,
    "src/Jobrunner/Runner.php#Jobrunner.Runner",
  ]);
  expect(index.refs).toEqual([]);
});
