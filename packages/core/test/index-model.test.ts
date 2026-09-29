import { describe, expect, it } from "vitest";
import { asIndexModel, IndexModel } from "../src/index.js";
import { jobrunner, makeWorld, textWith } from "./helpers.js";

describe("IndexModel", () => {
  const w = jobrunner();
  const m = w.model;

  it("indexes files by path, sorted", () => {
    expect(m.files.map((f) => f.path)).toEqual([
      "config/default.yaml",
      "src/metrics.ts",
      "src/queue.ts",
      "src/runner.ts",
      "src/util/sleep.ts",
      "src/worker.ts",
      "test/retry.test.ts",
    ]);
    expect(m.file("src/queue.ts")?.lines).toBe(60);
    expect(m.hasFile("src/queue.ts")).toBe(true);
    expect(m.hasFile("nope.ts")).toBe(false);
    expect(m.commit).toBe("c1");
  });

  it("looks symbols up by id and by (file, path)", () => {
    expect(m.symbol("src/queue.ts#Queue.pop")?.range).toEqual({ startLine: 5, endLine: 15 });
    expect(m.symbolAt("src/queue.ts", "Queue.pop")?.id).toBe("src/queue.ts#Queue.pop");
    expect(m.symbol("src/queue.ts#Nope")).toBeUndefined();
    expect(m.symbolAt("src/queue.ts", "Nope")).toBeUndefined();
  });

  it("lists the symbols of a file sorted by range, outer before inner", () => {
    expect(m.symbolsInFile("src/queue.ts").map((s) => s.path)).toEqual([
      "Queue",
      "Queue.pop",
      "Queue.requeue",
      "Queue.ack",
      "Queue.deadLetter",
    ]);
    expect(m.symbolsInFile("test/retry.test.ts")).toEqual([]);
  });

  it("knows symbol children and top-level symbols", () => {
    expect(m.childSymbols("src/queue.ts#Queue").map((s) => s.path)).toEqual([
      "Queue.pop",
      "Queue.requeue",
      "Queue.ack",
      "Queue.deadLetter",
    ]);
    expect(m.topLevelSymbols("src/runner.ts").map((s) => s.path)).toEqual([
      "Runner",
      "backoffDelay",
    ]);
    expect(m.parentSymbol("src/queue.ts#Queue.pop")?.id).toBe("src/queue.ts#Queue");
    expect(m.parentSymbol("src/queue.ts#Queue")).toBeUndefined();
    expect(m.symbolWithin("src/queue.ts#Queue.pop", "src/queue.ts#Queue")).toBe(true);
    expect(m.symbolWithin("src/queue.ts#Queue.pop", "src/queue.ts#Queue.pop")).toBe(true);
    expect(m.symbolWithin("src/queue.ts#Queue", "src/queue.ts#Queue.pop")).toBe(false);
  });

  it("indexes refs by from and to, module scopes included", () => {
    expect(m.refsFrom("src/runner.ts#Runner.dispatch")).toHaveLength(7);
    expect(m.refsTo("src/queue.ts#Queue.requeue").map((r) => r.from)).toEqual([
      "src/runner.ts#Runner.dispatch",
    ]);
    expect(m.refsFrom("src/runner.ts#").map((r) => r.kind)).toEqual(["import", "import"]);
    expect(m.refsFrom("src/nothing.ts#")).toEqual([]);
    expect(m.refs).toHaveLength(12);
  });

  it("derives directories (root excluded) and their children", () => {
    expect(m.directories).toEqual(["config", "src", "src/util", "test"]);
    expect(m.hasDirectory("src/util")).toBe(true);
    expect(m.hasDirectory("")).toBe(false);
    expect(m.dirParent("src/util")).toBe("src");
    expect(m.dirParent("src")).toBe("");
    expect(m.dirParent("nope")).toBeUndefined();
    expect(m.dirChildren("").dirs).toEqual(["config", "src", "test"]);
    expect(m.dirChildren("").files).toEqual([]);
    expect(m.dirChildren("src").dirs).toEqual(["src/util"]);
    expect(m.dirChildren("src").files).toEqual([
      "src/metrics.ts",
      "src/queue.ts",
      "src/runner.ts",
      "src/worker.ts",
    ]);
    expect(m.filesUnder("src/util")).toEqual(["src/util/sleep.ts"]);
    expect(m.filesUnder("src")).toHaveLength(5);
    expect(m.filesUnder("")).toHaveLength(7);
    expect(m.filesUnder("nope")).toEqual([]);
  });

  it("finds the innermost symbol at a line", () => {
    expect(m.innermostSymbolAt("src/runner.ts", 77)?.path).toBe("Runner.dispatch");
    expect(m.innermostSymbolAt("src/runner.ts", 12)?.path).toBe("Runner");
    expect(m.innermostSymbolAt("src/runner.ts", 98)?.path).toBe("backoffDelay");
    expect(m.innermostSymbolAt("src/runner.ts", 5)).toBeUndefined();
    expect(m.innermostSymbolAt("src/nope.ts", 5)).toBeUndefined();
  });

  it("prefers the deeper symbol when ranges are equal", () => {
    const one = makeWorld({
      files: [{ path: "a.ts", lines: 5 }],
      symbols: [
        { id: "a.ts#A", kind: "class", start: 1, end: 3 },
        { id: "a.ts#A.m", start: 1, end: 3 },
      ],
    });
    expect(one.model.innermostSymbolAt("a.ts", 2)?.path).toBe("A.m");
  });

  it("knows module scopes", () => {
    expect(m.moduleScopeId("src/queue.ts")).toBe("src/queue.ts#");
    expect(m.isModuleScope("src/queue.ts#")).toBe(true);
    expect(m.isModuleScope("nope.ts#")).toBe(false);
    expect(m.isModuleScope("src/queue.ts#Queue")).toBe(false);
    expect(m.fileOfSymbolId("src/queue.ts#")).toBe("src/queue.ts");
    expect(m.fileOfSymbolId("src/queue.ts#Queue.pop")).toBe("src/queue.ts");
    expect(m.fileOfSymbolId("nope.ts#")).toBeUndefined();
  });

  it("suggests symbols: same last segment in the file, same path elsewhere", () => {
    expect(m.suggestSymbols("src/runner.ts", "Foo.dispatch").map((s) => s.id)).toEqual([
      "src/runner.ts#Runner.dispatch",
    ]);
    expect(m.suggestSymbols("src/runner.ts", "runner.DISPATCH")[0]?.id).toBe(
      "src/runner.ts#Runner.dispatch",
    );
    expect(m.suggestSymbols("src/worker.ts", "Queue.pop").map((s) => s.id)).toEqual([
      "src/queue.ts#Queue.pop",
    ]);
    expect(m.suggestSymbols("src/runner.ts", "Nothing.like.this")).toEqual([]);
    expect(m.suggestSymbols("src/queue.ts", "X.pop", 1)).toHaveLength(1);
  });

  it("suggests files by base name and by substring", () => {
    expect(m.suggestFiles("queue.ts")).toEqual(["src/queue.ts"]);
    expect(m.suggestFiles("lib/queue.ts")).toEqual(["src/queue.ts"]);
    expect(m.suggestFiles("sleep")).toEqual(["src/util/sleep.ts"]);
    expect(m.suggestFiles("zzz")).toEqual([]);
  });

  it("memoises asIndexModel per index object and passes models through", () => {
    expect(asIndexModel(w.index)).toBe(asIndexModel(w.index));
    expect(asIndexModel(m)).toBe(m);
    expect(new IndexModel(w.index)).not.toBe(m);
  });

  it("ignores duplicate paths and ids (first wins) and tolerates dangling parents", () => {
    const index = {
      ...w.index,
      files: [...w.index.files, { ...w.index.files[0]!, lines: 999 }],
      symbols: [
        ...w.index.symbols,
        { ...w.index.symbols[0]!, range: { startLine: 1, endLine: 2 } },
        {
          id: "src/queue.ts#Orphan",
          file: "src/queue.ts",
          path: "Orphan",
          kind: "function" as const,
          range: { startLine: 56, endLine: 57 },
          hash: "sha256:000000000000",
          parent: "src/queue.ts#Gone",
        },
      ],
    };
    const dup = new IndexModel(index);
    expect(dup.files).toHaveLength(w.index.files.length);
    expect(dup.symbols).toHaveLength(w.index.symbols.length + 1);
    expect(dup.symbol(w.index.symbols[0]!.id)?.range).toEqual(w.index.symbols[0]!.range);
    expect(dup.topLevelSymbols("src/queue.ts").map((s) => s.path)).toContain("Orphan");
  });

  it("accepts an index without refs", () => {
    const tiny = makeWorld({ files: [{ path: "a.ts", text: textWith(3) }] });
    expect(tiny.model.refs).toEqual([]);
    expect(tiny.model.directories).toEqual([]);
    expect(tiny.model.dirChildren("").files).toEqual(["a.ts"]);
  });
});
