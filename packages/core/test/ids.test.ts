import { describe, expect, it } from "vitest";
import {
  conceptId,
  derivedEdgeId,
  dirId,
  elementIdForSymbolId,
  fileId,
  frameId,
  ghostId,
  groupId,
  isModuleScopeId,
  isNodeId,
  isSlug,
  isStructuralId,
  moduleScopeId,
  nodeKindOfId,
  normalizeElementId,
  parseId,
  splitSymbolId,
  stepId,
  storedEdgeId,
  stubId,
  symbolId,
  symbolIdForElementId,
  symId,
  tourId,
  viewId,
  viewSlug,
} from "../src/index.js";
import { jobrunner, makeWorld } from "./helpers.js";

describe("id builders", () => {
  it("builds every id form of section 4.3", () => {
    expect(dirId("src/core")).toBe("dir:src/core");
    expect(fileId("src/a.ts")).toBe("file:src/a.ts");
    expect(symId("src/a.ts", "A.b")).toBe("sym:src/a.ts#A.b");
    expect(groupId("scheduling")).toBe("grp:scheduling");
    expect(conceptId("retry-policy")).toBe("concept:retry-policy");
    expect(storedEdgeId("job-completed")).toBe("edge:job-completed");
    expect(viewId("dispatch")).toBe("view:dispatch");
    expect(tourId("intro")).toBe("tour:intro");
    expect(frameId("retry")).toBe("frame:retry");
    expect(stepId("view:dispatch", 3)).toBe("dispatch:3");
    expect(stepId("dispatch", 3)).toBe("dispatch:3");
    expect(viewSlug("view:dispatch")).toBe("dispatch");
    expect(ghostId("dir:src")).toBe("ghost:dir:src");
  });

  it("builds derived edge ids and stub ids", () => {
    expect(derivedEdgeId("calls", "sym:a.ts#A.b", "file:b.ts")).toBe(
      "edge:calls:sym:a.ts#A.b->file:b.ts",
    );
    expect(stubId("out", "file:a.ts", "dir:lib")).toBe("stub:out:file:a.ts->ghost:dir:lib");
  });

  it("builds symbol ids", () => {
    expect(symbolId("src/a.ts", "A.b")).toBe("src/a.ts#A.b");
  });

  it("maps symbol ids to element ids: a module scope lifts to its file", () => {
    expect(elementIdForSymbolId("f.ts#")).toBe("file:f.ts");
    expect(elementIdForSymbolId("f.ts#P")).toBe("sym:f.ts#P");
    expect(symbolIdForElementId("sym:f.ts#P.q")).toBe("f.ts#P.q");
    expect(symbolIdForElementId("file:f.ts")).toBe("f.ts#");
    expect(symbolIdForElementId("grp:x")).toBeUndefined();
    expect(moduleScopeId("f.ts")).toBe("f.ts#");
    expect(isModuleScopeId("f.ts#")).toBe(true);
    expect(isModuleScopeId("f.ts#P")).toBe(false);
  });

  it("splits symbol ids at the first # unless the index says otherwise", () => {
    expect(splitSymbolId("src/a.ts#A.b")).toEqual({ file: "src/a.ts", path: "A.b" });
    expect(splitSymbolId("a#b.ts#X")).toEqual({ file: "a", path: "b.ts#X" });
    expect(splitSymbolId("a#b.ts#X", (p) => p === "a#b.ts")).toEqual({ file: "a#b.ts", path: "X" });
    expect(splitSymbolId("nohash")).toEqual({ file: "nohash", path: "" });
  });
});

describe("parseId", () => {
  it("parses structural ids", () => {
    expect(parseId("repo")).toEqual({ type: "repo" });
    expect(parseId("dir:src/core")).toEqual({ type: "dir", path: "src/core" });
    expect(parseId("file:src/a.ts")).toEqual({ type: "file", path: "src/a.ts" });
    expect(parseId("sym:src/a.ts#A.b")).toEqual({
      type: "symbol",
      file: "src/a.ts",
      path: "A.b",
      symbolId: "src/a.ts#A.b",
    });
  });

  it("parses stored ids", () => {
    expect(parseId("grp:sched")).toEqual({ type: "group", slug: "sched" });
    expect(parseId("concept:retry")).toEqual({ type: "concept", slug: "retry" });
    expect(parseId("edge:job-completed")).toEqual({ type: "edge", slug: "job-completed" });
    expect(parseId("view:dispatch")).toEqual({ type: "view", slug: "dispatch" });
    expect(parseId("tour:intro")).toEqual({ type: "tour", slug: "intro" });
    expect(parseId("frame:retry")).toEqual({ type: "frame", slug: "retry" });
    expect(parseId("dispatch:3")).toEqual({ type: "step", view: "dispatch", n: 3 });
  });

  it("parses derived edges and tells them from stored slugs", () => {
    expect(parseId("edge:calls:sym:a.ts#A.b->sym:b.ts#B.c")).toEqual({
      type: "derived-edge",
      kind: "calls",
      from: "sym:a.ts#A.b",
      to: "sym:b.ts#B.c",
    });
    expect(parseId("edge:imports:file:a.ts->file:b.ts")).toMatchObject({
      type: "derived-edge",
      kind: "imports",
    });
    expect(parseId("edge:calls:grp:x->dir:y")).toMatchObject({
      type: "derived-edge",
      from: "grp:x",
    });
    // a stored slug that merely looks like a kind prefix
    expect(parseId("edge:calls:retry")).toEqual({ type: "edge", slug: "calls:retry" });
    // "->" but the ends are not element ids
    expect(parseId("edge:calls:a->b")).toEqual({ type: "edge", slug: "calls:a->b" });
    // emits/custom are never derived
    expect(parseId("edge:emits:file:a->file:b")).toMatchObject({ type: "edge" });
  });

  it("parses render-only ids", () => {
    expect(parseId("ghost:dir:src/core")).toEqual({ type: "ghost", target: "dir:src/core" });
    expect(parseId("stub:in:file:a.ts->ghost:dir:lib")).toEqual({
      type: "stub",
      direction: "in",
      inside: "file:a.ts",
      ghost: "dir:lib",
    });
    expect(parseId("stub:sideways:file:a.ts->ghost:dir:lib")).toEqual({ type: "unknown" });
  });

  it("returns unknown for anything else", () => {
    for (const bad of ["", "foo", "file:", "sym:src/a.ts", "sym:src/a.ts#", "grp:", "x:y"]) {
      expect(parseId(bad).type, bad).toBe("unknown");
    }
  });

  it("does not read a reserved prefix as a step", () => {
    expect(parseId("file:3")).toEqual({ type: "file", path: "3" });
    expect(parseId("edge:1")).toEqual({ type: "edge", slug: "1" });
  });

  it("classifies node ids", () => {
    expect(isNodeId("repo")).toBe(true);
    expect(isNodeId("grp:x")).toBe(true);
    expect(isNodeId("concept:x")).toBe(false);
    expect(isNodeId("dispatch:1")).toBe(false);
    expect(isStructuralId("sym:a#b")).toBe(true);
    expect(isStructuralId("grp:x")).toBe(false);
    expect(nodeKindOfId("sym:a#b")).toBe("symbol");
    expect(nodeKindOfId("grp:x")).toBe("group");
    expect(nodeKindOfId("edge:x")).toBeUndefined();
    expect(isSlug("retry-policy")).toBe(true);
    expect(isSlug("a b")).toBe(false);
    expect(isSlug("-x")).toBe(false);
  });
});

describe("normalizeElementId", () => {
  const w = jobrunner();
  const norm = (input: string) => normalizeElementId(input, w.model);

  it("accepts prefixed structural ids", () => {
    expect(norm("repo")).toEqual({ ok: true, id: "repo" });
    expect(norm("file:src/queue.ts")).toEqual({ ok: true, id: "file:src/queue.ts" });
    expect(norm("dir:src")).toEqual({ ok: true, id: "dir:src" });
    expect(norm("sym:src/queue.ts#Queue.pop")).toEqual({
      ok: true,
      id: "sym:src/queue.ts#Queue.pop",
    });
  });

  it("accepts loose forms and takes a raw SymbolIndex too", () => {
    expect(normalizeElementId("src/queue.ts#Queue.pop", w.index)).toEqual({
      ok: true,
      id: "sym:src/queue.ts#Queue.pop",
    });
    expect(norm("src/queue.ts")).toEqual({ ok: true, id: "file:src/queue.ts" });
    expect(norm("src")).toEqual({ ok: true, id: "dir:src" });
    expect(norm("src/")).toEqual({ ok: true, id: "dir:src" });
    expect(norm("./src/queue.ts")).toEqual({ ok: true, id: "file:src/queue.ts" });
    expect(norm("src\\queue.ts")).toEqual({ ok: true, id: "file:src/queue.ts" });
    expect(norm("src/queue.ts#")).toEqual({ ok: true, id: "file:src/queue.ts" });
    expect(norm("sym:src/queue.ts#")).toEqual({ ok: true, id: "file:src/queue.ts" });
    expect(norm(".")).toEqual({ ok: true, id: "repo" });
    expect(norm("  src/queue.ts  ")).toEqual({ ok: true, id: "file:src/queue.ts" });
  });

  it("passes stored and derived ids through unchecked", () => {
    for (const id of [
      "grp:x",
      "concept:y",
      "edge:z",
      "dispatch:3",
      "view:v",
      "edge:calls:file:a->file:b",
    ]) {
      expect(norm(id)).toEqual({ ok: true, id });
    }
  });

  it("suggests candidates for an unknown symbol", () => {
    const r = norm("src/runner.ts#Runner.dispach");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('symbol "Runner.dispach" not found in src/runner.ts');
      expect(r.error).toContain("Did you mean: sym:src/runner.ts#Runner.dispatch?"); // a typo; the id form
      expect(r.candidates).toEqual(["sym:src/runner.ts#Runner.dispatch"]);
    }
    const near = norm("src/runner.ts#Foo.dispatch");
    expect(near.ok).toBe(false);
    if (!near.ok) {
      expect(near.error).toContain("src/runner.ts#Runner.dispatch");
      expect(near.candidates).toContain("sym:src/runner.ts#Runner.dispatch");
    }
    const other = norm("src/worker.ts#Queue.pop");
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.candidates).toContain("sym:src/queue.ts#Queue.pop");
  });

  it("without candidates it points at the outline of the file", () => {
    const r = norm("src/runner.ts#Zzz");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.candidates).toEqual([]);
      expect(r.error).toBe(
        'symbol "Zzz" not found in src/runner.ts. List the symbols of the file with `xpl outline --under file:src/runner.ts`.',
      );
    }
  });

  it("suggests files and reports files vs directories", () => {
    const r = norm("queue.ts");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.candidates).toContain("file:src/queue.ts");
    const asFile = norm("file:src");
    expect(asFile.ok).toBe(false);
    if (!asFile.ok) expect(asFile.error).toContain("is a directory");
    const asDir = norm("dir:src/queue.ts");
    expect(asDir.ok).toBe(false);
    if (!asDir.ok) expect(asDir.error).toContain("is a file");
    expect(norm("").ok).toBe(false);
    expect(norm("nowhere/at/all").ok).toBe(false);
  });

  it("suggests the directory of that name first, then near names, then those that contain the text", () => {
    const tree = makeWorld({
      files: [
        { path: "examples/tutorial/flaskr/auth.py" },
        { path: "examples/tutorial/flaskr/blog.py" },
        { path: "src/flask/app.py" },
        { path: "src/flask/sansio/app.py" },
        { path: "test/a.py" },
        { path: "docs/index.rst" },
      ],
    });
    const candidates = (input: string) => {
      const r = normalizeElementId(input, tree.model);
      return r.ok ? [] : (r.candidates ?? []);
    };
    // `flask` names src/flask (and not only the longer names that contain it)
    expect(candidates("dir:flask")[0]).toBe("dir:src/flask");
    expect(candidates("flask").filter((c) => c.startsWith("dir:"))[0]).toBe("dir:src/flask");
    expect(candidates("dir:flask")).toEqual([
      "dir:src/flask",
      "dir:src/flask/sansio",
      "dir:examples/tutorial/flaskr",
    ]);
    // a near name: a plural, a typo
    expect(candidates("dir:tests")).toEqual(["dir:test"]);
    expect(candidates("dir:doc")).toEqual(["dir:docs"]);
    // a path suffix
    expect(candidates("dir:flask/sansio")).toEqual(["dir:src/flask/sansio"]);
    expect(candidates("dir:zzz")).toEqual([]);
  });
});
