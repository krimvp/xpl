import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { hashText, INDEX_SCHEMA, splitLines } from "@xpl/core";
import type { Reference, SymbolIndex } from "@xpl/core";
import {
  buildIndex,
  preciseResolvers,
  registerPreciseResolver,
  unregisterPreciseResolver,
  writeIndex,
} from "../src/index.js";
import type { PreciseInput, PreciseResolver } from "../src/index.js";
import { indexFiles, makeDir, makeRepo, symbol } from "./helpers.js";

const src = (...lines: string[]): string => lines.join("\n") + "\n";

const project = {
  "src/queue.ts": src("export class Queue {", "  pop(): number { return 1; }", "}"),
  "src/run.ts": src(
    "import { Queue } from './queue';",
    "export function run(q: Queue) {",
    "  return q.pop();",
    "}",
  ),
  "config/app.yaml": "retry:\n  max: 3\n",
  "package.json": '{"name": "x", "scripts": {"test": "vitest"}}\n',
  "README.md": "# Project\n",
  "app/main.py": "def main():\n    pass\n",
  "cmd/main.go": "package main\n\nfunc main() {}\n",
};

describe("buildIndex", () => {
  it("returns a SymbolIndex with schema, commit, tool, root, files, symbols and refs", async () => {
    const { index, warnings, dir } = await indexFiles(project);
    expect(index.schema).toBe(INDEX_SCHEMA);
    expect(index.schema).toBe("code-explainer/index@0");
    expect(index.commit).toMatch(/^wt-[0-9a-f]{10}$/);
    expect(index.root).toBe(dir);
    expect(warnings).toEqual([]);
    expect(Object.keys(index)).toEqual([
      "schema",
      "commit",
      "tool",
      "languages",
      "root",
      "files",
      "symbols",
      "refs",
    ]);
  });

  it("lists every text file with language, hash and line count, sorted by path", async () => {
    const { index } = await indexFiles(project);
    expect(index.files.map((f) => `${f.path}:${f.language}`)).toEqual([
      "README.md:text",
      "app/main.py:python",
      "cmd/main.go:go",
      "config/app.yaml:yaml",
      "package.json:json",
      "src/queue.ts:typescript",
      "src/run.ts:typescript",
    ]);
    const readme = index.files.find((f) => f.path === "README.md")!;
    expect(readme).toEqual({
      path: "README.md",
      language: "text",
      hash: hashText("# Project\n"),
      lines: 2,
    });
    const queue = index.files.find((f) => f.path === "src/queue.ts")!;
    expect(queue.lines).toBe(splitLines(project["src/queue.ts"]).length);
    expect(queue.hash).toBe(hashText(project["src/queue.ts"]));
  });

  it("names the indexer and the grammar versions in `tool`", async () => {
    const { index } = await indexFiles(project);
    expect(index.tool).toMatch(/^xpl-indexer@\d+\.\d+\.\d+ web-tree-sitter@\d+\.\d+\.\d+ /);
    for (const grammar of [
      "tree-sitter-typescript@",
      "tree-sitter-yaml@",
      "tree-sitter-json@",
      "tree-sitter-python@",
      "tree-sitter-go@",
    ]) {
      expect(index.tool).toContain(grammar);
    }
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
    expect(index.tool).toContain(
      `tree-sitter-typescript@${pkg.dependencies["tree-sitter-typescript"]}`,
    );
    expect(index.tool).toContain(`web-tree-sitter@${pkg.dependencies["web-tree-sitter"]}`);
  });

  it("summarises languages: files, symbols and where references come from", async () => {
    const { index } = await indexFiles(project);
    expect(Object.keys(index.languages)).toEqual([
      "go",
      "json",
      "python",
      "text",
      "typescript",
      "yaml",
    ]);
    expect(index.languages.typescript).toMatchObject({ files: 2, refs: "heuristic" });
    expect(index.languages.typescript!.symbols).toBe(
      index.symbols.filter((s) => s.file.startsWith("src/")).length,
    );
    expect(index.languages.typescript!.tool).toContain("tree-sitter-typescript@");
    expect(index.languages.yaml).toEqual({ files: 1, symbols: 2, refs: "none" });
    expect(index.languages.json).toEqual({ files: 1, symbols: 3, refs: "none" });
    expect(index.languages.text).toEqual({ files: 1, symbols: 0, refs: "none" });
    // The Python and Go packs are stubs for now: they index files but find nothing yet.
    expect(index.languages.python).toEqual({ files: 1, symbols: 0, refs: "none" });
    expect(index.languages.go).toEqual({ files: 1, symbols: 0, refs: "none" });
    const total = Object.values(index.languages).reduce((sum, l) => sum + l.symbols, 0);
    expect(total).toBe(index.symbols.length);
  });

  it("is deterministic: the same tree gives byte-identical JSON", async () => {
    const dir = makeDir(project);
    const a = JSON.stringify((await buildIndex({ root: dir, precise: "off" })).index);
    const b = JSON.stringify((await buildIndex({ root: dir, precise: "off" })).index);
    expect(a).toBe(b);
  });

  it("restricts to the requested languages", async () => {
    const { index } = await indexFiles(project, { languages: ["typescript", "yaml"] });
    expect(index.files.map((f) => f.path)).toEqual([
      "config/app.yaml",
      "src/queue.ts",
      "src/run.ts",
    ]);
    expect(Object.keys(index.languages)).toEqual(["typescript", "yaml"]);
    expect(index.symbols.every((s) => s.file !== "package.json")).toBe(true);
    const textOnly = await indexFiles(project, { languages: ["text"] });
    expect(textOnly.index.files.map((f) => f.path)).toEqual(["README.md"]);
    expect(textOnly.index.symbols).toEqual([]);
  });

  it("rejects unknown languages, missing roots and files as roots", async () => {
    const dir = makeDir(project);
    await expect(buildIndex({ root: dir, languages: ["typescript", "cobol"] })).rejects.toThrow(
      /unknown language "cobol"/,
    );
    await expect(buildIndex({ root: join(dir, "nope") })).rejects.toThrow(/no such directory/);
    await expect(buildIndex({ root: join(dir, "README.md") })).rejects.toThrow(/not a directory/);
    await expect(buildIndex({ root: dir, precise: "sometimes" as "auto" })).rejects.toThrow(
      /invalid precise mode/,
    );
  });

  it("indexes an empty directory", async () => {
    const { index, warnings } = await indexFiles({});
    expect(index.files).toEqual([]);
    expect(index.symbols).toEqual([]);
    expect(index.refs).toEqual([]);
    expect(index.languages).toEqual({});
    expect(warnings).toEqual([]);
  });

  it("resolves a relative root against the working directory", async () => {
    const dir = makeDir(project);
    const { index } = await buildIndex({ root: relative(process.cwd(), dir), precise: "off" });
    expect(index.root).toBe(resolve(dir));
    expect(index.files.length).toBe(7);
  });

  it("warns about files with syntax errors but still returns their symbols", async () => {
    const { index, warnings } = await indexFiles({
      "ok.ts": "export const ok = 1;\n",
      "broken.ts": "export function fine() {}\nexport class {{{ \n",
    });
    expect(symbol(index, "broken.ts", "fine")).toBeDefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/1 file\(s\) have syntax errors.*broken\.ts/);
  });

  it("indexes files with CRLF line endings and a BOM, keeping ranges and hashes consistent", async () => {
    const crlf = "export class A {\r\n  m() {}\r\n}\r\n";
    const bom = "﻿export const b = 1;\n";
    const { index } = await indexFiles({ "crlf.ts": crlf, "bom.ts": bom });
    expect(symbol(index, "crlf.ts", "A")!.range).toEqual({ startLine: 1, endLine: 3 });
    expect(symbol(index, "crlf.ts", "A.m")!.range).toEqual({ startLine: 2, endLine: 2 });
    expect(symbol(index, "crlf.ts", "A")!.hash).toBe(hashText(crlf));
    expect(symbol(index, "bom.ts", "b")).toBeDefined();
    expect(index.files.find((f) => f.path === "crlf.ts")!.lines).toBe(4);
  });

  it("columns count UTF-16 code units, also after astral characters", async () => {
    const source = "const s = '😀é'; foo();\n";
    const { index } = await indexFiles({ "u.ts": `${source}function foo() {}\n` });
    const call = index.refs.find((r) => r.kind === "call")!;
    expect(call.site.startCol).toBe(source.indexOf("foo") + 1);
    expect(call.site.endCol).toBe(source.indexOf("foo();") + "foo()".length);
  });

  it("indexes ~1000 files in seconds", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 1000; i++) {
      const next = (i + 1) % 1000;
      files[`src/m${i}.ts`] = src(
        `import { C${next} } from './m${next}';`,
        `export class C${i} {`,
        `  private peer: C${next} = new C${next}();`,
        "  private count = 0;",
        `  run(n: number): number {`,
        "    this.count += n;",
        "    return this.peer.run(this.count);",
        "  }",
        "  helper() { return this.run(1); }",
        "}",
        `export function make${i}(): C${i} { return new C${i}(); }`,
      );
    }
    const dir = makeDir(files);
    const started = performance.now();
    const { index } = await buildIndex({ root: dir, precise: "off" });
    const elapsed = performance.now() - started;
    expect(index.files).toHaveLength(1000);
    expect(index.symbols.length).toBeGreaterThanOrEqual(6000);
    expect(
      index.refs.some(
        (r) => r.from === "src/m7.ts#C7.run" && r.to === "src/m8.ts#C8.run" && r.kind === "call",
      ),
    ).toBe(true);
    expect(elapsed).toBeLessThan(20_000); // typically 1-3 s; generous for slow CI machines
  }, 60_000);
});

describe("writeIndex", () => {
  it("writes .explainer/index-<commit>.json pretty-printed, and a .gitignore for index-*.json", async () => {
    const dir = makeDir(project);
    const { index } = await buildIndex({ root: dir, commit: "abc1234", precise: "off" });
    const path = await writeIndex(dir, index);
    expect(path).toBe(join(dir, ".explainer", "index-abc1234.json"));
    const text = readFileSync(path, "utf8");
    expect(text).toBe(`${JSON.stringify(index, null, 2)}\n`);
    expect(text.startsWith('{\n  "schema": "code-explainer/index@0"')).toBe(true);
    expect(JSON.parse(text)).toEqual(index);
    expect(readFileSync(join(dir, ".explainer", ".gitignore"), "utf8")).toBe("index-*.json\n");
  });

  it("works for relative roots", async () => {
    const dir = makeDir(project);
    const { index } = await buildIndex({ root: dir, commit: "c1", precise: "off" });
    const path = await writeIndex(relative(process.cwd(), dir), index);
    expect(path).toBe(join(resolve(dir), ".explainer", "index-c1.json"));
    expect(existsSync(path)).toBe(true);
  });

  it("keeps a customised .gitignore, adding the pattern once", async () => {
    const dir = makeDir({ ".explainer/.gitignore": "requests.json" });
    const { index } = await buildIndex({ root: dir, commit: "c1", precise: "off" });
    await writeIndex(dir, index);
    await writeIndex(dir, index);
    expect(readFileSync(join(dir, ".explainer", ".gitignore"), "utf8")).toBe(
      "requests.json\nindex-*.json\n",
    );
    writeFileSync(join(dir, ".explainer", ".gitignore"), "a\nindex-*.json\nb\n");
    await writeIndex(dir, index);
    expect(readFileSync(join(dir, ".explainer", ".gitignore"), "utf8")).toBe(
      "a\nindex-*.json\nb\n",
    );
  });

  it("overwrites an index of the same commit, leaves others, and leaves no temp files", async () => {
    const dir = makeDir(project);
    const one = (await buildIndex({ root: dir, commit: "c1", precise: "off" })).index;
    const two = (await buildIndex({ root: dir, commit: "c2", precise: "off" })).index;
    await writeIndex(dir, one);
    await writeIndex(dir, two);
    writeFileSync(join(dir, "README.md"), "# Changed\n");
    const changed = (await buildIndex({ root: dir, commit: "c1", precise: "off" })).index;
    await writeIndex(dir, changed);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(join(dir, ".explainer")).sort()).toEqual([
      ".gitignore",
      "index-c1.json",
      "index-c2.json",
    ]);
    expect(
      (
        JSON.parse(readFileSync(join(dir, ".explainer", "index-c1.json"), "utf8")) as SymbolIndex
      ).files.find((f) => f.path === "README.md")!.hash,
    ).toBe(hashText("# Changed\n"));
  });

  it("refuses commit ids that are not safe file names", async () => {
    const dir = makeDir(project);
    const { index } = await buildIndex({ root: dir, precise: "off" });
    await expect(writeIndex(dir, { ...index, commit: "../evil" })).rejects.toThrow(
      /invalid commit id/,
    );
  });

  it("the written index does not change what the next build indexes", async () => {
    const dir = makeRepo(project);
    const first = (await buildIndex({ root: dir, precise: "off" })).index;
    await writeIndex(dir, first);
    const second = (await buildIndex({ root: dir, precise: "off" })).index;
    expect(second.files).toEqual(first.files);
    expect(second.commit).toBe(first.commit);
  });
});

describe("precise resolvers (registry and modes)", () => {
  const fake = (overrides: Partial<PreciseResolver> = {}): PreciseResolver => ({
    id: "fake-ts",
    languages: ["typescript", "tsx", "javascript"],
    async resolve(input: PreciseInput) {
      const ref: Reference = {
        from: "src/run.ts#run",
        to: "src/queue.ts#Queue",
        kind: "call",
        site: { startLine: 3, endLine: 3, startCol: 1, endCol: 5 },
        resolution: "precise",
      };
      // a resolver must only produce refs for the languages it was asked for: this one is ignored
      const stray: Reference = { ...ref, from: "app/main.py#main" };
      return { refs: input.languages.length > 0 ? [ref, stray] : [], tool: "fake-scip@1.2.3" };
    },
    ...overrides,
  });

  it("starts with an empty registry", () => {
    expect(preciseResolvers()).toEqual([]);
  });

  it("auto with no resolver uses heuristic references silently", async () => {
    const { index, warnings } = await indexFiles(project, { precise: "auto" });
    expect(warnings).toEqual([]);
    expect(index.languages.typescript!.refs).toBe("heuristic");
    expect(index.refs.length).toBeGreaterThan(0);
    expect(index.refs.every((r) => r.resolution === "heuristic")).toBe(true);
  });

  it("require with no resolver fails with a clear message naming the languages", async () => {
    const dir = makeDir(project);
    await expect(buildIndex({ root: dir, precise: "require" })).rejects.toThrow(
      /precise references are required.*no precise resolver is available for: typescript/,
    );
  });

  it("require does not complain about repositories that have nothing to resolve", async () => {
    const dir = makeDir({ "a.yaml": "a: 1\n", "b.json": "{}\n", "c.md": "x\n", "d.py": "x = 1\n" });
    const { index } = await buildIndex({ root: dir, precise: "require" });
    expect(index.files).toHaveLength(4);
  });

  it("off never runs a resolver", async () => {
    let calls = 0;
    const resolver = fake({ resolve: async () => (calls++, { refs: [], tool: "x" }) });
    await indexFiles(project, { precise: "off", resolvers: [resolver] });
    expect(calls).toBe(0);
  });

  it("a resolver replaces the heuristic references of its languages and marks them precise", async () => {
    const { index, warnings } = await indexFiles(project, { precise: "auto", resolvers: [fake()] });
    expect(warnings).toEqual([]);
    expect(index.languages.typescript).toMatchObject({ refs: "precise", tool: "fake-scip@1.2.3" });
    const fromTs = index.refs.filter((r) => r.from.startsWith("src/"));
    expect(fromTs).toEqual([
      {
        from: "src/run.ts#run",
        to: "src/queue.ts#Queue",
        kind: "call",
        site: { startLine: 3, endLine: 3, startCol: 1, endCol: 5 },
        resolution: "precise",
      },
    ]);
    // refs the resolver produced for a language it does not own are ignored
    expect(index.refs.some((r) => r.from.startsWith("app/"))).toBe(false);
    // languages without references stay "none"
    expect(index.languages.yaml!.refs).toBe("none");
  });

  it("hands the resolver everything a SCIP importer needs", async () => {
    let seen: PreciseInput | undefined;
    let classified: unknown;
    const resolver = fake({
      async resolve(input) {
        seen = input;
        classified = await input.withFile("src/run.ts", (ctx, pack) =>
          pack.classifySite(ctx, 3, 12),
        );
        return { refs: [], tool: "fake-scip@1" };
      },
    });
    await indexFiles(project, { precise: "auto", resolvers: [resolver] });
    expect(seen).toBeDefined();
    const input = seen!;
    expect([...input.languages].sort()).toEqual(["typescript"]);
    expect(input.files.map((f) => f.path)).toContain("README.md");
    expect(input.symbols.length).toBeGreaterThan(0);
    expect(input.lookup.innermost("src/queue.ts", 2, 3)?.id).toBe("src/queue.ts#Queue.pop");
    expect(input.lookup.fromId("src/run.ts", 1, 1)).toBe("src/run.ts#");
    expect(input.readText("src/queue.ts")).toBe(project["src/queue.ts"]);
    expect(input.readText("missing.ts")).toBeUndefined();
    expect(await input.withFile("README.md", () => 1)).toBeUndefined(); // text has no language pack
    expect(classified).toMatchObject({ kind: "call" }); // `q.pop()` at 3:12
    expect(input.root).toMatch(/xpl-indexer-/);
  });

  it("auto: a failing resolver becomes a warning and the language keeps heuristic references", async () => {
    const resolver = fake({
      resolve: async (input: PreciseInput) => {
        input.warn("indexing took a while");
        throw new Error("scip-typescript not found");
      },
    });
    const { index, warnings } = await indexFiles(project, {
      precise: "auto",
      resolvers: [resolver],
    });
    expect(warnings).toEqual([
      "indexing took a while",
      'precise resolver "fake-ts" failed (scip-typescript not found); using heuristic references for typescript',
    ]);
    expect(index.languages.typescript!.refs).toBe("heuristic");
    expect(index.refs.every((r) => r.resolution === "heuristic")).toBe(true);
  });

  it("require: a failing resolver aborts the build", async () => {
    const resolver = fake({
      resolve: async () => {
        throw new Error("boom");
      },
    });
    await expect(
      indexFiles(project, { precise: "require", resolvers: [resolver] }),
    ).rejects.toThrow(/precise resolver "fake-ts" failed: boom/);
  });

  it("require: satisfied when every language with references has a resolver", async () => {
    const { index } = await indexFiles(project, { precise: "require", resolvers: [fake()] });
    expect(index.languages.typescript!.refs).toBe("precise");
  });

  it("resolvers only run when their languages occur, and the registry is honoured by default", async () => {
    let calls = 0;
    const goResolver = fake({
      id: "fake-go",
      languages: ["go"],
      resolve: async () => (calls++, { refs: [], tool: "x" }),
    });
    await indexFiles(project, { precise: "auto", resolvers: [goResolver] }); // go has no refs yet (stub pack)
    expect(calls).toBe(0);
    registerPreciseResolver(fake({ id: "registered" }));
    try {
      expect(preciseResolvers().map((r) => r.id)).toEqual(["registered"]);
      const { index } = await indexFiles(project, { precise: "auto" });
      expect(index.languages.typescript!.tool).toBe("fake-scip@1.2.3");
      // registering the same id replaces it
      registerPreciseResolver(
        fake({ id: "registered", resolve: async () => ({ refs: [], tool: "second@2" }) }),
      );
      expect(preciseResolvers()).toHaveLength(1);
      expect(
        (await indexFiles(project, { precise: "auto" })).index.languages.typescript!.tool,
      ).toBe("second@2");
    } finally {
      expect(unregisterPreciseResolver("registered")).toBe(true);
      expect(unregisterPreciseResolver("registered")).toBe(false);
    }
    expect(preciseResolvers()).toEqual([]);
  });
});
