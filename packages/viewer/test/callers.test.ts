import { describe, expect, it } from "vitest";
import { IndexModel, type SymbolIndex } from "@xpl/core";
import { callersOf, changeSummary } from "../src/callers.js";

const sym = (file: string, path: string, startLine: number, endLine: number) => ({
  id: `${file}#${path}`,
  file,
  path,
  kind: "function" as const,
  range: { startLine, endLine },
  hash: "x",
});
const ref = (from: string, to: string, line: number, kind = "call") => ({
  from,
  to,
  kind: kind as "call",
  site: { startLine: line, endLine: line },
  resolution: "precise" as const,
});

function index(): IndexModel {
  const raw = {
    version: 1,
    commit: "c",
    files: [
      { path: "src/a.ts", language: "typescript", lines: 40, hash: "h" },
      { path: "src/b.ts", language: "typescript", lines: 40, hash: "h" },
    ],
    symbols: [
      sym("src/a.ts", "A", 1, 30),
      sym("src/a.ts", "A.run", 5, 20),
      sym("src/b.ts", "go", 1, 10),
      sym("src/b.ts", "stop", 12, 20),
    ],
    refs: [
      ref("src/b.ts#go", "src/a.ts#A.run", 4),
      ref("src/b.ts#go", "src/a.ts#A.run", 8),
      ref("src/b.ts#stop", "src/a.ts#A", 14, "extends"),
      ref("src/a.ts#A", "src/a.ts#A.run", 25),
      ref("src/b.ts#", "src/a.ts#A.run", 30),
      ref("src/b.ts#stop", "src/a.ts#A.run", 15, "import"),
    ],
  } as unknown as SymbolIndex;
  return new IndexModel(raw);
}

describe("who calls this", () => {
  it("lists each calling symbol once, at its first call, and leaves out calls from inside", () => {
    const callers = callersOf("sym:src/a.ts#A", index());
    expect(callers.map((c) => [c.label, c.line])).toEqual([
      ["go", 4],
      ["stop", 14],
      ["b.ts (top level)", 30],
    ]);
    // A.run: A calls it from outside A.run; an import is not a use
    expect(callersOf("sym:src/a.ts#A.run", index()).map((c) => c.label)).toEqual([
      "A",
      "go",
      "b.ts (top level)",
    ]);
    // a file: only callers in other files
    expect(callersOf("file:src/a.ts", index()).map((c) => c.file)).toEqual([
      "src/b.ts",
      "src/b.ts",
      "src/b.ts",
    ]);
    expect(callersOf("grp:x", index())).toEqual([]);
  });

  it("says what a change did to a file or a symbol, and where to look", () => {
    const change = {
      base: "b".repeat(40),
      head: "c".repeat(40),
      files: [
        {
          path: "src/a.ts",
          status: "modified" as const,
          hunks: [{ oldStart: 12, oldLines: 1, newStart: 12, newLines: 2 }],
        },
      ],
    };
    expect(changeSummary("file:src/a.ts", index(), change)).toEqual({
      text: "Edited by this change: +2 −1",
      file: "src/a.ts",
      line: 12,
    });
    expect(changeSummary("sym:src/a.ts#A.run", index(), change)?.line).toBe(12);
    expect(changeSummary("sym:src/b.ts#go", index(), change)).toBeUndefined();
    expect(changeSummary("file:src/a.ts", index(), undefined)).toBeUndefined();
  });
});
