/**
 * The per-file replacement rule of `buildIndex` (src/build.ts, `PreciseOutput.describedFiles`): precise
 * references replace the heuristic ones only in the files the precise tool described. Files it did not
 * describe (build-tagged Go files, files a Python project's pyright configuration excludes, ...) keep their
 * heuristic references, and `LanguageInfo.heuristicFiles` counts them. Fake resolvers, no tools.
 */
import { describe, expect, it } from "vitest";
import type { FileLanguage, Reference } from "@xpl/core";
import { buildIndex } from "../src/index.js";
import type { PreciseResolver } from "../src/index.js";
import { indexFiles, makeDir } from "./helpers.js";

const queue = "export class Queue {\n  pop(): number {\n    return 1;\n  }\n}\n";
const runner = (name: string): string =>
  `import { Queue } from "./queue.ts";\nexport function run${name}(q: Queue): number {\n  return q.pop();\n}\n`;

const project = {
  "src/queue.ts": queue,
  "src/a.ts": runner("A"),
  "src/b.ts": runner("B"),
  "src/c.ts": runner("C"),
  "lib/y.js":
    'import { Queue } from "../src/queue.ts";\nexport function runY() {\n  return new Queue().pop();\n}\n',
  "tools/z.py":
    "class Z:\n    def go(self):\n        return 1\n\n\ndef use():\n    return Z().go()\n",
};

const TS: FileLanguage[] = ["typescript", "tsx", "javascript"];

interface FakeOptions {
  id?: string;
  languages?: FileLanguage[];
  tool?: string;
  refs?: Reference[];
  /** Omitted: the resolver does not report which files it described (every file of its languages counts). */
  described?: Iterable<string>;
}

function fake(options: FakeOptions = {}): PreciseResolver {
  return {
    id: options.id ?? "fake-ts",
    languages: options.languages ?? TS,
    async resolve() {
      return {
        refs: options.refs ?? [],
        tool: options.tool ?? "fake@1",
        ...(options.described !== undefined ? { describedFiles: options.described } : {}),
      };
    },
  };
}

const precise = (from: string, to: string, kind: Reference["kind"] = "call"): Reference => ({
  from,
  to,
  kind,
  site: { startLine: 3, endLine: 3, startCol: 10, endCol: 16 },
  resolution: "precise",
});

const fromFile = (refs: readonly Reference[], file: string): Reference[] =>
  refs.filter((r) => r.from.startsWith(`${file}#`));
const summary = (refs: readonly Reference[]): string[] =>
  refs.map((r) => `${r.resolution} ${r.kind} ${r.from} -> ${r.to}`);

const pop = precise("src/a.ts#runA", "src/queue.ts#Queue.pop");

describe("precise references replace heuristic ones per file", () => {
  it("heuristic references of described files are replaced (dropped when the tool has none), those of other files stay", async () => {
    const baseline = await indexFiles(project);
    expect(fromFile(baseline.index.refs, "src/a.ts")).toHaveLength(3);
    expect(fromFile(baseline.index.refs, "src/c.ts")).toHaveLength(3);

    const { index, warnings } = await indexFiles(project, {
      precise: "auto",
      resolvers: [
        fake({
          languages: ["typescript"],
          described: ["src/queue.ts", "src/a.ts", "src/b.ts"],
          refs: [pop],
        }),
      ],
    });
    expect(warnings).toEqual([]);
    // a.ts: only what the tool says; b.ts: described, nothing confirmed, so nothing left
    expect(summary(fromFile(index.refs, "src/a.ts"))).toEqual([
      "precise call src/a.ts#runA -> src/queue.ts#Queue.pop",
    ]);
    expect(fromFile(index.refs, "src/b.ts")).toEqual([]);
    // c.ts was not described: its heuristic references are the heuristic resolver's own, untouched
    expect(fromFile(index.refs, "src/c.ts")).toEqual(fromFile(baseline.index.refs, "src/c.ts"));
    expect(fromFile(index.refs, "src/c.ts").every((r) => r.resolution === "heuristic")).toBe(true);
    // other languages are untouched
    expect(fromFile(index.refs, "lib/y.js")).toEqual(fromFile(baseline.index.refs, "lib/y.js"));
    expect(fromFile(index.refs, "tools/z.py")).toEqual(fromFile(baseline.index.refs, "tools/z.py"));
    expect(index.languages.typescript).toMatchObject({
      refs: "precise",
      tool: "fake@1",
      heuristicFiles: 1, // c.ts
    });
    expect(index.languages.javascript!.refs).toBe("heuristic");
    expect(index.languages.python!.refs).toBe("heuristic");
  });

  it("keeps the references sorted when precise and heuristic ones are mixed", async () => {
    const { index } = await indexFiles(project, {
      precise: "auto",
      resolvers: [
        fake({ languages: ["typescript"], described: ["src/queue.ts", "src/b.ts"], refs: [] }),
      ],
    });
    const files = index.refs.map((r) => r.from.slice(0, r.from.indexOf("#")));
    expect(files).toEqual([...files].sort());
    expect(new Set(files)).toEqual(new Set(["lib/y.js", "src/a.ts", "src/c.ts", "tools/z.py"]));
  });

  // no describedFiles: every file of the resolver's languages is replaced, as before; a tool that described
  // every file is the same, and leaves heuristicFiles absent (not zero)
  it.each([
    ["no describedFiles", undefined],
    ["every file described", ["src/queue.ts", "src/a.ts", "src/b.ts", "src/c.ts"]],
  ])("%s: the precise references replace all of the language", async (_, described) => {
    const { index } = await indexFiles(project, {
      precise: "auto",
      resolvers: [fake({ languages: ["typescript"], refs: [pop], described })],
    });
    expect(summary(index.refs.filter((r) => r.from.startsWith("src/")))).toEqual([
      "precise call src/a.ts#runA -> src/queue.ts#Queue.pop",
    ]);
    expect(index.languages.typescript).toMatchObject({ refs: "precise", tool: "fake@1" });
    expect("heuristicFiles" in index.languages.typescript!).toBe(false);
  });

  it("a file the tool produced references for counts as described even when it is not listed", async () => {
    const { index } = await indexFiles(project, {
      precise: "auto",
      resolvers: [fake({ languages: ["typescript"], described: ["src/queue.ts"], refs: [pop] })],
    });
    expect(summary(fromFile(index.refs, "src/a.ts"))).toEqual([
      "precise call src/a.ts#runA -> src/queue.ts#Queue.pop",
    ]);
    // b.ts and c.ts are not described: heuristic
    expect(fromFile(index.refs, "src/b.ts")).toHaveLength(3);
    expect(fromFile(index.refs, "src/c.ts")).toHaveLength(3);
    expect(index.languages.typescript!.heuristicFiles).toBe(2);
  });

  it("describedFiles may be any iterable", async () => {
    function* files(): Generator<string> {
      yield "src/queue.ts";
      yield "src/a.ts";
    }
    for (const described of [new Set(["src/queue.ts", "src/a.ts"]), files()]) {
      const { index } = await indexFiles(project, {
        precise: "auto",
        resolvers: [fake({ languages: ["typescript"], described, refs: [pop] })],
      });
      expect(index.languages.typescript!.heuristicFiles).toBe(2);
      expect(fromFile(index.refs, "src/b.ts")).toHaveLength(3);
    }
  });

  it("precise references from files of other languages are still ignored", async () => {
    const stray = precise("tools/z.py#use", "tools/z.py#Z");
    const { index } = await indexFiles(project, {
      precise: "auto",
      resolvers: [
        fake({
          languages: ["typescript"],
          described: ["src/queue.ts", "src/a.ts"],
          refs: [pop, stray],
        }),
      ],
    });
    expect(index.refs.some((r) => r.resolution === "precise" && r.from.startsWith("tools/"))).toBe(
      false,
    );
    expect(index.languages.python!.refs).toBe("heuristic");
  });
});

describe("a tool that described nothing", () => {
  const nothing = fake({ languages: ["typescript"], described: [], refs: [] });

  it("auto: is treated as failed, the language keeps its heuristic references", async () => {
    const { index, warnings } = await indexFiles(project, {
      precise: "auto",
      resolvers: [nothing],
    });
    expect(warnings).toEqual([
      'precise resolver "fake-ts" failed (the tool described none of the 4 typescript file(s)); using heuristic references for typescript',
    ]);
    expect(index.languages.typescript!.refs).toBe("heuristic");
    expect(index.refs.every((r) => r.resolution === "heuristic")).toBe(true);
  });

  it("require: fails the build", async () => {
    // require needs a resolver for every language with references: keep to the TypeScript files
    const tsOnly = Object.fromEntries(
      Object.entries(project).filter(([path]) => path.startsWith("src/")),
    );
    await expect(
      buildIndex({ root: makeDir(tsOnly), precise: "require", resolvers: [nothing] }),
    ).rejects.toThrow(
      /precise resolver "fake-ts" failed: the tool described none of the 4 typescript file\(s\)/,
    );
  });
});

describe("languages of one resolver are judged separately", () => {
  it("a language none of whose files was described stays heuristic while the resolver's other languages are precise", async () => {
    const { index } = await indexFiles(project, {
      precise: "auto",
      resolvers: [
        fake({ described: ["src/queue.ts", "src/a.ts", "src/b.ts", "src/c.ts"], refs: [pop] }),
      ],
    });
    expect(index.languages.typescript).toMatchObject({ refs: "precise", tool: "fake@1" });
    expect(index.languages.javascript!.refs).toBe("heuristic");
    expect(index.languages.javascript!.tool).toContain("xpl-heuristic");
    expect(index.languages.javascript).not.toHaveProperty("heuristicFiles");
    expect(fromFile(index.refs, "lib/y.js")).toHaveLength(3);
  });

  it("a later resolver still gets the language the first one left out", async () => {
    const { index } = await indexFiles(project, {
      precise: "auto",
      resolvers: [
        fake({
          id: "fake-ts",
          described: ["src/queue.ts", "src/a.ts", "src/b.ts", "src/c.ts"],
          refs: [pop],
        }),
        fake({
          id: "fake-js",
          languages: ["javascript"],
          tool: "fake-js@2",
          described: ["lib/y.js"],
          refs: [precise("lib/y.js#runY", "src/queue.ts#Queue.pop")],
        }),
      ],
    });
    expect(index.languages.typescript!.tool).toBe("fake@1");
    expect(index.languages.javascript).toMatchObject({ refs: "precise", tool: "fake-js@2" });
    expect(summary(fromFile(index.refs, "lib/y.js"))).toEqual([
      "precise call lib/y.js#runY -> src/queue.ts#Queue.pop",
    ]);
  });
});

describe("build-tagged Go files (the motivating case)", () => {
  const go = {
    "go.mod": "module example.com/m\n\ngo 1.22\n",
    "a/a.go": "package a\n\ntype Store interface {\n\tGet() int\n}\n",
    "b/b.go":
      'package b\n\nimport "example.com/m/a"\n\ntype Mem struct{}\n\nfunc (Mem) Get() int { return 1 }\n\nfunc Use(s a.Store) int { return s.Get() }\n',
    // scip-go builds for the host platform: this file is not part of any package it loads
    "b/b_windows.go":
      "//go:build windows\n\npackage b\n\nfunc onlyWindows() int { return Mem{}.Get() }\n",
  };
  const site = { startLine: 9, endLine: 9, startCol: 34, endCol: 40 };
  const resolver = fake({
    id: "fake-go",
    languages: ["go"],
    tool: "fake-go@1",
    described: ["a/a.go", "b/b.go"],
    refs: [
      { ...precise("b/b.go#Use", "a/a.go#Store.Get"), site },
      {
        from: "b/b.go#Mem",
        to: "a/a.go#Store",
        kind: "implements",
        site: { startLine: 5, endLine: 5, startCol: 6, endCol: 8 },
        resolution: "precise",
      },
    ],
  });

  it("keeps the heuristic references of the file the tool did not describe, drops the rest of the heuristic ones", async () => {
    const baseline = await indexFiles(go);
    const { index } = await indexFiles(go, { precise: "auto", resolvers: [resolver] });
    expect(summary(fromFile(index.refs, "b/b.go")).sort()).toEqual([
      "precise call b/b.go#Use -> a/a.go#Store.Get",
      "precise implements b/b.go#Mem -> a/a.go#Store",
    ]);
    // the tool saw b.go and did not confirm the import or the type-refs: they are gone
    expect(fromFile(baseline.index.refs, "b/b.go").length).toBeGreaterThan(2);
    const windows = fromFile(index.refs, "b/b_windows.go");
    expect(windows).toEqual(fromFile(baseline.index.refs, "b/b_windows.go"));
    expect(windows.length).toBeGreaterThan(0);
    expect(windows.every((r) => r.resolution === "heuristic")).toBe(true);
    expect(index.languages.go).toMatchObject({
      refs: "precise",
      tool: "fake-go@1",
      heuristicFiles: 1,
    });
  });
});
