import { describe, expect, it } from "vitest";
import { hashText, sliceLines, splitLines } from "@xpl/core";
import {
  SpanIndex,
  SymbolLookup,
  assembleSymbols,
  lookupFromSymbols,
  moduleScopeId,
  pointsToSpan,
  spanContains,
  stripDuplicateSuffix,
} from "../src/index.js";
import type { Span, SymbolDraft } from "../src/index.js";

const span = (startLine: number, startCol: number, endLine: number, endCol: number): Span => ({
  startLine,
  startCol,
  endLine,
  endCol,
});

describe("pointsToSpan", () => {
  const lines = ["const a = 1;", "", "function f() {", "}", ""];

  it("converts 0-based rows/columns with an exclusive end to 1-based inclusive", () => {
    // `const` on row 0: columns 0..5 (exclusive)
    expect(pointsToSpan(0, 0, 0, 5, lines)).toEqual(span(1, 1, 1, 5));
    // `f` in `function f`: row 2, columns 9..10
    expect(pointsToSpan(2, 9, 2, 10, lines)).toEqual(span(3, 10, 3, 10));
  });

  it("a node that ends at column 0 of a later row ends at the end of the previous line", () => {
    expect(pointsToSpan(2, 0, 4, 0, lines)).toEqual(span(3, 1, 4, 1)); // `}` line has length 1
    expect(pointsToSpan(0, 0, 1, 0, lines)).toEqual(span(1, 1, 1, 12));
  });

  it("zero-width nodes are widened to one column; empty last lines get column 1", () => {
    expect(pointsToSpan(0, 3, 0, 3, lines)).toEqual(span(1, 4, 1, 4));
    expect(pointsToSpan(0, 0, 2, 0, lines)).toEqual(span(1, 1, 2, 1));
  });
});

describe("spanContains", () => {
  it("is inclusive on both ends and line-aware", () => {
    const s = span(2, 5, 4, 3);
    expect(spanContains(s, 2, 5)).toBe(true);
    expect(spanContains(s, 2, 4)).toBe(false);
    expect(spanContains(s, 3, 1)).toBe(true);
    expect(spanContains(s, 3, 999)).toBe(true);
    expect(spanContains(s, 4, 3)).toBe(true);
    expect(spanContains(s, 4, 4)).toBe(false);
    expect(spanContains(s, 1, 9)).toBe(false);
    expect(spanContains(s, 5, 1)).toBe(false);
  });
});

describe("SpanIndex", () => {
  it("finds the innermost of nested spans, in any input order", () => {
    const index = new SpanIndex([
      { span: span(3, 3, 5, 4), value: "method" },
      { span: span(1, 1, 10, 1), value: "class" },
      { span: span(4, 5, 4, 20), value: "nested" },
      { span: span(12, 1, 14, 1), value: "other" },
    ]);
    expect(index.innermost(4, 10)).toBe("nested");
    expect(index.innermost(4, 21)).toBe("method");
    expect(index.innermost(5, 1)).toBe("method");
    expect(index.innermost(6, 1)).toBe("class");
    expect(index.innermost(1, 1)).toBe("class");
    expect(index.innermost(11, 1)).toBeUndefined();
    expect(index.innermost(13, 1)).toBe("other");
    expect(index.innermost(15, 1)).toBeUndefined();
    expect(index.containing(4, 10)).toEqual(["nested", "method", "class"]);
    expect(index.size).toBe(4);
  });

  it("distinguishes siblings that share a line by column", () => {
    const index = new SpanIndex([
      { span: span(1, 1, 1, 30), value: "outer" },
      { span: span(1, 3, 1, 10), value: "a" },
      { span: span(1, 12, 1, 20), value: "b" },
    ]);
    expect(index.innermost(1, 5)).toBe("a");
    expect(index.innermost(1, 15)).toBe("b");
    expect(index.innermost(1, 11)).toBe("outer");
    expect(index.innermost(1, 25)).toBe("outer");
  });

  it("handles identical spans (the later one is treated as inner) and an empty index", () => {
    const same = new SpanIndex([
      { span: span(1, 1, 1, 9), value: "first" },
      { span: span(1, 1, 1, 9), value: "second" },
    ]);
    expect(same.innermost(1, 5)).toBe("second");
    expect(new SpanIndex<string>([]).innermost(1, 1)).toBeUndefined();
  });

  it("handles many spans quickly", () => {
    const items = Array.from({ length: 20000 }, (_, i) => ({
      span: span(i + 1, 1, i + 1, 40),
      value: i,
    }));
    const index = new SpanIndex(items);
    const t = performance.now();
    for (let i = 0; i < 20000; i++) expect(index.innermost(i + 1, 5)).toBe(i);
    expect(performance.now() - t).toBeLessThan(2000);
  });
});

describe("assembleSymbols", () => {
  const draft = (
    path: string,
    startLine: number,
    endLine: number,
    extra: Partial<SymbolDraft> = {},
  ): SymbolDraft => ({
    path,
    kind: "function",
    range: span(startLine, 1, endLine, 2),
    ...extra,
  });
  const text = "l1\nl2\nl3\nl4\nl5\nl6\n";
  const lines = splitLines(text);

  it("sorts drafts by position, builds ids, whole-line ranges and hashes of the full lines", () => {
    const { entries } = assembleSymbols("f.ts", lines, [draft("b", 4, 5), draft("a", 1, 3)]);
    expect(entries.map((e) => e.symbol.id)).toEqual(["f.ts#a", "f.ts#b"]);
    const a = entries[0]!.symbol;
    expect(a.range).toEqual({ startLine: 1, endLine: 3 });
    expect(a.file).toBe("f.ts");
    expect(a.path).toBe("a");
    expect(a.hash).toBe(hashText(sliceLines(text, { startLine: 1, endLine: 3 })));
    expect(entries[0]!.span).toEqual(span(1, 1, 3, 2)); // columns are kept internally
    expect(entries[0]!.basePath).toBe("a");
  });

  it("numbers duplicate paths in source order and remembers the pre-dedup path", () => {
    const { entries } = assembleSymbols("f.ts", lines, [
      draft("x", 5, 5),
      draft("x", 1, 1),
      draft("x", 3, 3),
      draft("y", 2, 2),
    ]);
    expect(entries.map((e) => e.symbol.path)).toEqual(["x", "y", "x~2", "x~3"]);
    expect(entries.map((e) => e.basePath)).toEqual(["x", "y", "x", "x"]);
    expect(stripDuplicateSuffix("x~3")).toBe("x");
    expect(stripDuplicateSuffix("a.b")).toBe("a.b");
  });

  it("resolves parentPath to the draft with that path, preferring the one that contains the child", () => {
    const { entries } = assembleSymbols("f.ts", lines, [
      draft("A", 1, 2, { kind: "class" }),
      draft("A", 3, 5, { kind: "class" }),
      draft("A.m", 4, 4, { kind: "method", parentPath: "A" }),
      draft("A.n", 1, 1, { kind: "method", parentPath: "A" }),
    ]);
    const byPath = Object.fromEntries(entries.map((e) => [e.symbol.path, e.symbol]));
    expect(byPath["A.m"]!.parent).toBe("f.ts#A~2");
    expect(byPath["A.n"]!.parent).toBe("f.ts#A");
  });

  it("a parent that does not contain the child (Go methods) still applies; a missing parent leaves none", () => {
    const { entries } = assembleSymbols("f.go", lines, [
      draft("Runner", 1, 2, { kind: "class" }),
      draft("Runner.Dispatch", 4, 6, { kind: "method", parentPath: "Runner" }),
      draft("Other.Method", 3, 3, { kind: "method", parentPath: "Other" }),
    ]);
    const byPath = Object.fromEntries(entries.map((e) => [e.symbol.path, e.symbol]));
    expect(byPath["Runner.Dispatch"]!.parent).toBe("f.go#Runner");
    expect(byPath["Other.Method"]!.parent).toBeUndefined();
    expect(byPath["Runner"]!.parent).toBeUndefined();
  });

  it("drops drafts with an empty path and clamps inverted ranges", () => {
    const { entries } = assembleSymbols("f.ts", lines, [draft("", 1, 1), draft("ok", 2, 1)]);
    expect(entries.map((e) => e.symbol.path)).toEqual(["ok"]);
    expect(entries[0]!.symbol.range).toEqual({ startLine: 2, endLine: 2 });
  });

  it("hashes ignore indentation and blank lines like anchors do", () => {
    const a = assembleSymbols("a.ts", ["  x = 1", "", "y = 2"], [draft("s", 1, 3)]).entries[0]!
      .symbol.hash;
    const b = assembleSymbols("b.ts", ["x = 1", "y = 2"], [draft("s", 1, 2)]).entries[0]!.symbol
      .hash;
    expect(a).toBe(b);
  });
});

describe("SymbolLookup", () => {
  const lines = splitLines("class A { m() {} n() {} }\nfunction f() {\n  g();\n}\n");
  const { entries } = assembleSymbols("f.ts", lines, [
    { path: "A", kind: "class", range: span(1, 1, 1, 25) },
    { path: "A.m", kind: "method", range: span(1, 11, 1, 16), parentPath: "A" },
    { path: "A.n", kind: "method", range: span(1, 18, 1, 23), parentPath: "A" },
    { path: "f", kind: "function", range: span(2, 1, 4, 1) },
  ]);
  const lookup = new SymbolLookup(entries);

  it("finds the innermost symbol at a position, telling same-line symbols apart", () => {
    expect(lookup.innermost("f.ts", 1, 12)?.path).toBe("A.m");
    expect(lookup.innermost("f.ts", 1, 19)?.path).toBe("A.n");
    expect(lookup.innermost("f.ts", 1, 17)?.path).toBe("A");
    expect(lookup.innermost("f.ts", 3, 3)?.path).toBe("f");
    expect(lookup.innermost("f.ts", 5, 1)).toBeUndefined();
    expect(lookup.innermost("missing.ts", 1, 1)).toBeUndefined();
  });

  it("fromId falls back to the module scope; get/entry look up by id", () => {
    expect(lookup.fromId("f.ts", 3, 3)).toBe("f.ts#f");
    expect(lookup.fromId("f.ts", 9, 1)).toBe("f.ts#");
    expect(moduleScopeId("src/a.ts")).toBe("src/a.ts#");
    expect(lookup.get("f.ts#A.m")?.kind).toBe("method");
    expect(lookup.entry("f.ts#A.m")?.span).toEqual(span(1, 11, 1, 16));
    expect(lookup.get("f.ts#nope")).toBeUndefined();
  });

  it("line-only queries use whole lines", () => {
    expect(lookup.innermost("f.ts", 3)?.path).toBe("f");
    expect(lookup.innermost("f.ts", 1)?.path).toBe("A");
  });

  it("lookupFromSymbols works from bare index symbols (whole lines only)", () => {
    const bare = lookupFromSymbols(entries.map((e) => e.symbol));
    expect(bare.innermost("f.ts", 3, 1)?.path).toBe("f");
    expect(bare.innermost("f.ts", 1, 1)?.path).toBeDefined();
  });
});
