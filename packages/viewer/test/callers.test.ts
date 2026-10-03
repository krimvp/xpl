import { describe, expect, it } from "vitest";
import { IndexModel, type SequenceView, type SymbolIndex } from "@xpl/core";
import {
  callersOf,
  callerSubject,
  changeSummary,
  contextFiles,
  symbolAtWord,
} from "../src/callers.js";
import { ViewerStore } from "../src/store.js";
import { makeBundle } from "./world.js";

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

  it("a function that calls itself: one 'itself (recursion)' row first, with every line", () => {
    const raw = {
      version: 1,
      commit: "c",
      files: [{ path: "tree.go", language: "go", lines: 600, hash: "h" }],
      symbols: [
        sym("tree.go", "node.findRoute", 450, 560),
        sym("tree.go", "node.FindRoute", 380, 400),
      ],
      refs: [
        ref("tree.go#node.FindRoute", "tree.go#node.findRoute", 390),
        ref("tree.go#node.findRoute", "tree.go#node.findRoute", 542),
        ref("tree.go#node.findRoute", "tree.go#node.findRoute", 494),
      ],
    } as unknown as SymbolIndex;
    const callers = callersOf("sym:tree.go#node.findRoute", new IndexModel(raw));
    expect(callers.map((c) => [c.label, c.line, c.recursion])).toEqual([
      ["itself (recursion)", 494, [494, 542]],
      ["node.FindRoute", 390, undefined],
    ]);
    // a class whose method calls the class: still a call from inside, not recursion
    expect(callersOf("sym:src/a.ts#A", index()).some((c) => c.recursion)).toBe(false);
  });

  it("says what a change did to a file or a symbol, and where to look", () => {
    const change = {
      base: "b".repeat(40),
      head: "c".repeat(40),
      files: [
        {
          path: "src/a.ts",
          status: "modified" as const,
          hunks: [
            { oldStart: 12, oldLines: 1, newStart: 12, newLines: 2 },
            // two lines removed after head line 15 (inside A.run), one after line 20 (A.run's last line)
            { oldStart: 15, oldLines: 2, newStart: 15, newLines: 0 },
            { oldStart: 21, oldLines: 1, newStart: 20, newLines: 0 },
          ],
        },
      ],
    };
    expect(changeSummary("file:src/a.ts", index(), change)).toEqual({
      words: "Edited by this change",
      added: 2,
      deleted: 4,
      text: "Edited by this change · +2 −4",
      file: "src/a.ts",
      line: 12,
    });
    // a symbol counts the lines inside it: not the line removed below its last line
    expect(changeSummary("sym:src/a.ts#A.run", index(), change)).toMatchObject({
      text: "Edited by this change · +2 −3",
      line: 12,
    });
    expect(changeSummary("sym:src/b.ts#go", index(), change)).toBeUndefined();
    expect(changeSummary("file:src/a.ts", index(), undefined)).toBeUndefined();
  });
});

describe("a name in the code", () => {
  it("is the symbol a reference on that line points at, or the one declared there", () => {
    // line 4 of go calls A.run: "run" there is A.run (a private name's # is dropped)
    expect(symbolAtWord(index(), "src/b.ts", 4, "run")?.id).toBe("src/a.ts#A.run");
    expect(symbolAtWord(index(), "src/b.ts", 4, "#run")?.id).toBe("src/a.ts#A.run");
    // a declaration
    expect(symbolAtWord(index(), "src/b.ts", 12, "stop")?.id).toBe("src/b.ts#stop");
    // an import is not a use; an unknown name is nothing
    expect(symbolAtWord(index(), "src/b.ts", 15, "run")).toBeUndefined();
    expect(symbolAtWord(index(), "src/b.ts", 4, "nothing")).toBeUndefined();
  });
});

describe("whose callers a picked element asks for", () => {
  it("a file or a symbol itself; a step inside one part, the symbol that holds its code", () => {
    const bundle = makeBundle();
    const view = bundle.explainer.views.find((v) => v.id === "view:flow") as SequenceView;
    view.steps.push({
      id: "flow:inner",
      from: "sym:src/a.ts#A.run",
      to: "sym:src/a.ts#A.run",
      label: "inner",
      kind: "call",
      anchors: [{ file: "src/a.ts", symbol: "A.run", span: { from: 2, to: 3 }, role: "usage" }],
    } as SequenceView["steps"][number]);
    const model = new ViewerStore(bundle).getState().model;
    expect(callerSubject("file:src/b.ts", model)).toBe("file:src/b.ts");
    expect(callerSubject("flow:inner", model)).toBe("sym:src/a.ts#A.run");
    // a call between two parts, a concept: no one subject
    expect(callerSubject("flow:1", model)).toBeUndefined();
    expect(callerSubject("concept:retry", model)).toBeUndefined();
  });
});

describe("files the page carries for context", () => {
  it("are the ones nothing in the explainer points at, with who calls them", () => {
    const bundle = makeBundle();
    // a new index object (the model of the old one is cached)
    bundle.index = {
      ...bundle.index,
      files: [
        ...bundle.index.files,
        { path: "src/util.ts", language: "typescript", hash: "h", lines: 5 },
      ],
      symbols: [...bundle.index.symbols, sym("src/util.ts", "helper", 1, 5)],
      refs: [...bundle.index.refs, ref("src/a.ts#A.run", "src/util.ts#helper", 13)],
    };
    const model = new ViewerStore(bundle).getState().model;
    expect([...contextFiles(model, ["src/a.ts", "src/util.ts"], undefined)]).toEqual([
      ["src/util.ts", "A.run calls it"],
    ]);
    // a file the change touches is part of what is explained
    const change = {
      base: "b".repeat(40),
      head: "c".repeat(40),
      files: [{ path: "src/util.ts", status: "added" as const, hunks: [] }],
    };
    expect(contextFiles(model, ["src/util.ts"], change).size).toBe(0);
  });
});
