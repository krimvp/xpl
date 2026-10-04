import { describe, expect, it } from "vitest";
import {
  collectAnchors,
  hashText,
  makeAnchor,
  normalizedPrefixHashes,
  normalizeLines,
  hashNormalized,
  reresolveExplainer,
  resolveAnchor,
  TextCache,
  type Anchor,
  type AnchorInput,
  type Explainer,
} from "../src/index.js";
import {
  anchor as mk,
  concept,
  edge,
  emptyExplainer,
  group,
  LLM,
  makeWorld,
  sequenceView,
  textWith,
  USER,
  type SymbolDecl,
} from "./helpers.js";

const V1 = [
  "import { x } from './x';", //   1
  "", //                            2
  "export class Runner {", //       3
  "  run(job) {", //                4
  "    const a = 1;", //            5
  "    const b = 2;", //            6
  "    if (a > b) {", //            7
  "      retry(job);", //           8
  "      log('retrying');", //      9
  "    }", //                       10
  "    return a + b;", //           11
  "  }", //                         12
  "}", //                           13
  "", //                            14
  "export function helper() {", //  15
  "  return 42;", //                16
  "}", //                           17
];
const V1_SYMBOLS: SymbolDecl[] = [
  { id: "src/a.ts#Runner", kind: "class", start: 3, end: 13 },
  { id: "src/a.ts#Runner.run", start: 4, end: 12 },
  { id: "src/a.ts#helper", kind: "function", start: 15, end: 17 },
];

function world(lines: string[], symbols: SymbolDecl[], commit = "c1") {
  return makeWorld({ commit, files: [{ path: "src/a.ts", text: lines.join("\n") }], symbols });
}
const v1 = world(V1, V1_SYMBOLS);

/** An anchor over `Runner.run` offsets 4..5 (lines 8-9 of v1): the retry call and the log call. */
const spanAnchor = (): Anchor =>
  mk(v1, { file: "src/a.ts", symbol: "Runner.run", span: { from: 4, to: 5 }, role: "call-site" });

describe("resolveAnchor: whole symbols and files", () => {
  it("checks working-tree text rather than trusting a stale index hash", () => {
    const symbol = mk(v1, { file: "src/a.ts", symbol: "Runner.run", role: "definition" });
    const file = mk(v1, { file: "src/a.ts", role: "definition" });
    const changed = V1.join("\n").replace("return a + b", "return a * b");
    expect(resolveAnchor(symbol, v1.index, () => changed).status).toBe("drifted");
    // Appended lines lie beyond the old file range and must still change a whole-file anchor.
    expect(resolveAnchor(file, v1.index, () => V1.join("\n") + "\nnewCode();").status).toBe(
      "drifted",
    );
    expect(resolveAnchor(symbol, v1.index, () => undefined)).toMatchObject({
      status: "drifted",
      reason: expect.stringContaining("cannot read"),
    });
    expect(
      makeAnchor(
        { file: "src/a.ts", symbol: "Runner.run", role: "definition" },
        v1.index,
        () => changed,
      ),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("run `xpl index`"),
    });
  });
  it("detects a Python return moving into a conditional and refuses legacy hashes", () => {
    const text = "def f(flag):\n    if flag:\n        return 1\n    return 2";
    const before = makeWorld({
      files: [{ path: "f.py", text }],
      symbols: [{ id: "f.py#f", kind: "function", start: 1, end: 4 }],
    });
    const made = makeAnchor(
      { file: "f.py", symbol: "f", role: "definition" },
      before.index,
      before.getText,
    );
    if (!made.ok) throw new Error(made.error);
    const after = makeWorld({
      files: [{ path: "f.py", text: text.replace("    return 2", "        return 2") }],
      symbols: [{ id: "f.py#f", kind: "function", start: 1, end: 4 }],
    });
    expect(resolveAnchor(made.anchor, after.index, after.getText).status).toBe("drifted");
    const legacy = { ...made.anchor, hash: "sha256:legacy" };
    expect(resolveAnchor(legacy, before.index, before.getText)).toMatchObject({
      status: "drifted",
      reason: expect.stringContaining("legacy"),
    });
  });

  it("is ok when the symbol hash matches (no cache)", () => {
    const a = mk(v1, { file: "src/a.ts", symbol: "Runner.run", role: "definition" });
    const { resolved: _cache, ...bare } = a;
    const r = resolveAnchor(bare, v1.index, v1.getText);
    expect(r.status).toBe("ok");
    expect(r.range).toEqual({ startLine: 4, endLine: 12 });
    expect(r.hash).toBe(a.hash);
  });

  it("is ok when the cached range still matches", () => {
    const a = mk(v1, { file: "src/a.ts", symbol: "Runner.run", role: "definition" });
    expect(resolveAnchor(a, v1.model, v1.getText).status).toBe("ok");
  });

  it("is moved when the text is unchanged but the symbol sits elsewhere", () => {
    const a = mk(v1, { file: "src/a.ts", symbol: "Runner.run", role: "definition" });
    const shifted = world(
      ["// new", "// new", ...V1],
      [
        { id: "src/a.ts#Runner", kind: "class", start: 5, end: 15 },
        { id: "src/a.ts#Runner.run", start: 6, end: 14 },
        { id: "src/a.ts#helper", kind: "function", start: 17, end: 19 },
      ],
    );
    const r = resolveAnchor(a, shifted.index, shifted.getText);
    expect(r.status).toBe("moved");
    expect(r.range).toEqual({ startLine: 6, endLine: 14 });
    expect(r.hash).toBe(a.hash);
  });

  it("is drifted when the symbol text changed", () => {
    const a = mk(v1, { file: "src/a.ts", symbol: "Runner.run", role: "definition" });
    const edited = world(
      V1.map((l) => (l.includes("return a + b") ? "    return a * b;" : l)),
      V1_SYMBOLS,
    );
    const r = resolveAnchor(a, edited.index, edited.getText);
    expect(r.status).toBe("drifted");
    expect(r.range).toEqual({ startLine: 4, endLine: 12 });
    expect(r.hash).toBe(edited.model.symbol("src/a.ts#Runner.run")!.hash);
    expect(r.hash).not.toBe(a.hash);
    expect(r.reason).toContain("changed");
  });

  it("reports indentation changes as drift", () => {
    const a = mk(v1, { file: "src/a.ts", symbol: "Runner.run", role: "definition" });
    const reindented = world(
      V1.map((l) => (l.startsWith("  ") ? "\t" + l : l)),
      V1_SYMBOLS,
    );
    expect(resolveAnchor(a, reindented.index, reindented.getText).status).toBe("drifted");
  });

  it("is missing when the file is gone, keeping the previous range", () => {
    const a = mk(v1, { file: "src/a.ts", symbol: "Runner.run", role: "definition" });
    const other = makeWorld({ files: [{ path: "src/b.ts", lines: 3 }] });
    const r = resolveAnchor(a, other.index, other.getText);
    expect(r.status).toBe("missing");
    expect(r.range).toEqual({ startLine: 4, endLine: 12 });
    expect(r.hash).toBe("");
    expect(r.reason).toContain("src/a.ts");
  });

  it("is missing when the symbol is gone, with a suggestion", () => {
    const a = mk(v1, { file: "src/a.ts", symbol: "Runner.run", role: "definition" });
    const renamed = world(V1, [
      { id: "src/a.ts#Runner", kind: "class", start: 3, end: 13 },
      { id: "src/a.ts#Runner.execute", start: 4, end: 12 },
    ]);
    const r = resolveAnchor(a, renamed.index, renamed.getText);
    expect(r.status).toBe("missing");
    expect(r.reason).toContain("Runner.run");
    const moved = world(V1, [
      { id: "src/a.ts#Runner", kind: "class", start: 3, end: 13 },
      { id: "src/a.ts#Other.run", start: 4, end: 12 },
    ]);
    expect(resolveAnchor(a, moved.index, moved.getText).reason).toContain(
      'did you mean sym:src/a.ts#Other.run (anchor: file: "src/a.ts", symbol: "Other.run")',
    );
  });

  it("missing without a previous range reports 0-0", () => {
    const { resolved: _r, ...bare } = mk(v1, {
      file: "src/a.ts",
      symbol: "helper",
      role: "definition",
    });
    const other = makeWorld({ files: [{ path: "src/b.ts", lines: 3 }] });
    expect(resolveAnchor(bare, other.index, other.getText).range).toEqual({
      startLine: 0,
      endLine: 0,
    });
  });

  it("resolves whole-file anchors against the file hash", () => {
    const a = mk(v1, { file: "src/a.ts", role: "config" });
    expect(a.hash).toBe(v1.model.file("src/a.ts")!.hash);
    expect(resolveAnchor(a, v1.index, v1.getText)).toMatchObject({
      status: "ok",
      range: { startLine: 1, endLine: 17 },
    });
    const edited = world([...V1, "// tail"], V1_SYMBOLS);
    expect(resolveAnchor(a, edited.index, edited.getText).status).toBe("drifted");
    const { resolved: _r, ...bare } = a;
    expect(resolveAnchor(bare, v1.index, v1.getText).status).toBe("ok");
  });
});

describe("resolveAnchor: spans", () => {
  it("is ok at the expected position", () => {
    const a = spanAnchor();
    expect(a.resolved!.range).toEqual({ startLine: 8, endLine: 9 });
    expect(resolveAnchor(a, v1.index, v1.getText)).toMatchObject({
      status: "ok",
      range: { startLine: 8, endLine: 9 },
      hash: a.hash,
    });
  });

  it("is moved when lines were inserted above the span inside the symbol", () => {
    const a = spanAnchor();
    const inserted = [
      ...V1.slice(0, 6),
      "    const c = 3;",
      "    const d = 4;",
      "    const e = 5;",
      ...V1.slice(6),
    ];
    const after = world(inserted, [
      { id: "src/a.ts#Runner", kind: "class", start: 3, end: 16 },
      { id: "src/a.ts#Runner.run", start: 4, end: 15 },
      { id: "src/a.ts#helper", kind: "function", start: 18, end: 20 },
    ]);
    const r = resolveAnchor(a, after.index, after.getText);
    expect(r.status).toBe("moved");
    expect(r.range).toEqual({ startLine: 11, endLine: 12 });
    expect(r.span).toEqual({ from: 7, to: 8 });
    expect(r.hash).toBe(a.hash);
  });

  it("reports blank lines inserted inside the span as drift", () => {
    const a = spanAnchor();
    const blanks = [...V1.slice(0, 8), "", "", ...V1.slice(8)];
    const after = world(blanks, [
      { id: "src/a.ts#Runner", kind: "class", start: 3, end: 15 },
      { id: "src/a.ts#Runner.run", start: 4, end: 14 },
      { id: "src/a.ts#helper", kind: "function", start: 17, end: 19 },
    ]);
    const r = resolveAnchor(a, after.index, after.getText);
    expect(r.status).toBe("drifted");
    expect(r.range).toEqual({ startLine: 8, endLine: 9 });
    expect(r.span).toBeUndefined();
    expect(r.hash).not.toBe(a.hash);
  });

  it("is moved when the symbol moved but the span offsets still hold", () => {
    const a = spanAnchor();
    const shifted = world(
      ["// x", "// y", ...V1],
      [
        { id: "src/a.ts#Runner", kind: "class", start: 5, end: 15 },
        { id: "src/a.ts#Runner.run", start: 6, end: 14 },
        { id: "src/a.ts#helper", kind: "function", start: 17, end: 19 },
      ],
    );
    const r = resolveAnchor(a, shifted.index, shifted.getText);
    expect(r.status).toBe("moved");
    expect(r.range).toEqual({ startLine: 10, endLine: 11 });
    expect(r.span).toBeUndefined();
    const { resolved: _r, ...bare } = a;
    expect(resolveAnchor(bare, shifted.index, shifted.getText).status).toBe("ok");
  });

  it("is drifted when the text in the span changed and is nowhere else", () => {
    const a = spanAnchor();
    const edited = world(
      V1.map((l) => (l.includes("retry(job)") ? "      retry(job, 2);" : l)),
      V1_SYMBOLS,
    );
    const r = resolveAnchor(a, edited.index, edited.getText);
    expect(r.status).toBe("drifted");
    expect(r.range).toEqual({ startLine: 8, endLine: 9 });
    expect(r.span).toBeUndefined();
    expect(r.hash).not.toBe(a.hash);
    expect(r.reason).toContain("src/a.ts#Runner.run +4..5");
  });

  it("clamps the expected range to the region when the symbol got shorter", () => {
    const a = mk(v1, {
      file: "src/a.ts",
      symbol: "Runner.run",
      span: { from: 7, to: 8 },
      role: "usage",
    });
    const shorter = world(V1.slice(0, 8).concat(["  }", "}"]), [
      { id: "src/a.ts#Runner", kind: "class", start: 3, end: 10 },
      { id: "src/a.ts#Runner.run", start: 4, end: 9 },
    ]);
    const r = resolveAnchor(a, shorter.index, shorter.getText);
    expect(r.status).toBe("drifted");
    expect(r.range.endLine).toBeLessThanOrEqual(9);
    expect(r.range.startLine).toBeGreaterThanOrEqual(4);
  });

  it("resolves file-relative spans (no symbol) and re-finds them after insertions", () => {
    const a = mk(v1, { file: "src/a.ts", span: { from: 14, to: 16 }, role: "config" });
    expect(a.resolved!.range).toEqual({ startLine: 15, endLine: 17 });
    expect(resolveAnchor(a, v1.index, v1.getText).status).toBe("ok");
    const after = world(
      ["// a", "// b", "// c", ...V1],
      V1_SYMBOLS.map((s) => ({ ...s, start: s.start + 3, end: s.end + 3 })),
    );
    const r = resolveAnchor(a, after.index, after.getText);
    expect(r.status).toBe("moved");
    expect(r.range).toEqual({ startLine: 18, endLine: 20 });
    expect(r.span).toEqual({ from: 17, to: 19 });
  });

  it("prefers the match nearest to the expected position", () => {
    const rows = [
      "x",
      "target();",
      "y",
      "y",
      "y",
      "target();",
      "z",
      "z",
      "z",
      "z",
      "target();",
      "w",
    ];
    const before = world(rows, []);
    const a = mk(before, { file: "src/a.ts", span: { from: 5, to: 5 }, role: "usage" });
    expect(a.resolved!.range.startLine).toBe(6);
    // Delete the first target line: expected position 6 now holds "z"; nearest target is the one at 5.
    const after = world(
      rows.filter((_, i) => i !== 1),
      [],
    );
    const r = resolveAnchor(a, after.index, after.getText);
    expect(r.status).toBe("moved");
    expect(r.range.startLine).toBe(5);
    expect(r.span).toEqual({ from: 4, to: 4 });
  });

  it("breaks distance ties toward the earlier line", () => {
    const rows = ["target();", "a", "b", "c", "d", "target();", "e", "f", "g", "h", "target();"];
    const w = world(rows, []);
    const a: Anchor = {
      file: "src/a.ts",
      span: { from: 5, to: 5 },
      role: "usage",
      hash: hashText("target();"),
    };
    // expected line 6 holds target() itself -> ok at once
    expect(resolveAnchor(a, w.index, w.getText).status).toBe("ok");
    const off: Anchor = { ...a, span: { from: 2, to: 2 } }; // line 3 = "b": targets at 1, 6, 11 -> 1 and 6 tie? no: |1-3|=2, |6-3|=3
    expect(resolveAnchor(off, w.index, w.getText).range.startLine).toBe(1);
    const tie: Anchor = { ...a, span: { from: 3, to: 3 } }; // line 4 = "c": |1-4|=3, |6-4|=2
    expect(resolveAnchor(tie, w.index, w.getText).range.startLine).toBe(6);
    const equal: Anchor = { ...a, span: { from: 8, to: 8 } }; // line 9 = "g": |6-9|=3, |11-9|=2
    expect(resolveAnchor(equal, w.index, w.getText).range.startLine).toBe(11);
    const exactTie = world(["t();", "a", "t();", "b", "c", "d", "e"], []);
    const t: Anchor = {
      file: "src/a.ts",
      span: { from: 1, to: 1 },
      role: "usage",
      hash: hashText("t();"),
    };
    // line 2 = "a": candidates at 1 and 3, both at distance 1 -> the earlier one
    expect(resolveAnchor(t, exactTie.index, exactTie.getText).range.startLine).toBe(1);
  });

  it("only searches inside the symbol", () => {
    const a = spanAnchor(); // "retry(job); log('retrying');" inside Runner.run
    const elsewhere = world(
      [
        ...V1.slice(0, 7),
        "      // gone",
        "      // gone",
        ...V1.slice(9),
        "  retry(job);",
        "  log('retrying');",
      ],
      [
        { id: "src/a.ts#Runner", kind: "class", start: 3, end: 13 },
        { id: "src/a.ts#Runner.run", start: 4, end: 12 },
      ],
    );
    expect(resolveAnchor(a, elsewhere.index, elsewhere.getText).status).toBe("drifted");
  });

  it("keeps the cached resolution when the text is unavailable", () => {
    const a = spanAnchor();
    expect(resolveAnchor(a, v1.index, () => undefined)).toMatchObject({
      status: "ok",
      range: { startLine: 8, endLine: 9 },
      reason: expect.stringContaining("unavailable"),
    });
    const { resolved: _r, ...bare } = a;
    expect(resolveAnchor(bare, v1.index, () => undefined).status).toBe("drifted");
  });

  it("treats an invalid span as missing", () => {
    const a = { ...spanAnchor(), span: { from: 5, to: 2 } };
    const r = resolveAnchor(a, v1.index, v1.getText);
    expect(r.status).toBe("missing");
    expect(r.reason).toContain("invalid span");
  });

  it("treats an unreadable file (getText throws) as unavailable", () => {
    const throwing = () => {
      throw new Error("ENOENT");
    };
    const a = spanAnchor();
    expect(resolveAnchor(a, v1.index, throwing)).toMatchObject({
      status: "ok",
      reason: expect.stringContaining("unavailable"),
    });
    const r = makeAnchor(
      { file: "src/a.ts", span: { from: 0, to: 0 }, role: "usage" },
      v1.index,
      throwing,
    );
    expect(!r.ok && r.error).toContain("cannot read src/a.ts");
  });

  it("treats a null span like no span", () => {
    const a = mk(v1, { file: "src/a.ts", symbol: "helper", role: "definition" });
    expect(resolveAnchor({ ...a, span: null as never }, v1.index, v1.getText).status).toBe("ok");
  });

  it("accepts a shared TextCache and reads each file once", () => {
    let reads = 0;
    const cache = new TextCache((f) => {
      reads++;
      return v1.texts[f];
    });
    const a = spanAnchor();
    resolveAnchor(a, v1.index, cache);
    resolveAnchor(a, v1.index, cache);
    expect(reads).toBe(1);
  });
});

describe("normalizedPrefixHashes", () => {
  it("equals hashNormalized of every prefix", () => {
    const lines = ["alpha();", "beta()", "gamma;", "delta"];
    const hashes = normalizedPrefixHashes(lines, 1, 10);
    expect(hashes).toHaveLength(3);
    for (let k = 1; k <= 3; k++) {
      expect(hashes[k - 1]).toBe(hashNormalized(lines.slice(1, 1 + k).join("\n")));
    }
    expect(normalizedPrefixHashes(lines, 0, 2)).toHaveLength(2);
    expect(normalizedPrefixHashes(lines, 4, 2)).toEqual([]);
    expect(hashNormalized(normalizeLines(["  a ", "", "b"]))).toBe(hashText("a\nb"));
  });
});

describe("makeAnchor", () => {
  const make = (input: AnchorInput) => makeAnchor(input, v1.index, v1.getText);
  const fail = (input: AnchorInput): string => {
    const r = make(input);
    if (r.ok) throw new Error("expected an error, got " + JSON.stringify(r.anchor));
    return r.error;
  };

  it("anchors a whole symbol with the symbol hash and range", () => {
    const r = make({ file: "src/a.ts", symbol: "Runner.run", role: "definition" });
    expect(r).toEqual({
      ok: true,
      anchor: {
        file: "src/a.ts",
        symbol: "Runner.run",
        role: "definition",
        hash: v1.model.symbol("src/a.ts#Runner.run")!.hash,
        resolved: { commit: "c1", range: { startLine: 4, endLine: 12 }, status: "ok" },
      },
    });
  });

  it("anchors a whole file", () => {
    const r = make({ file: "src/a.ts", role: "test" });
    expect(r.ok && r.anchor.hash).toBe(v1.model.file("src/a.ts")!.hash);
    expect(r.ok && r.anchor.resolved!.range).toEqual({ startLine: 1, endLine: 17 });
    expect(r.ok && "symbol" in r.anchor).toBe(false);
  });

  it("rejects a span against a legacy index even when current source text is readable", () => {
    const legacy = structuredClone(v1.index);
    for (const file of legacy.files) file.hash = "sha256:legacy";
    for (const symbol of legacy.symbols) symbol.hash = "sha256:legacy";
    const result = makeAnchor(
      { file: "src/a.ts", symbol: "Runner.run", span: { from: 4, to: 5 }, role: "call-site" },
      legacy,
      v1.getText,
    );
    expect(result).toEqual({ ok: false, error: expect.stringContaining("legacy index") });
  });

  it("anchors a span relative to the symbol start", () => {
    const r = make({
      file: "src/a.ts",
      symbol: "Runner.run",
      span: { from: 4, to: 5 },
      role: "call-site",
    });
    expect(r.ok && r.anchor).toMatchObject({
      span: { from: 4, to: 5 },
      hash: hashText("      retry(job);\n      log('retrying');"),
      resolved: { range: { startLine: 8, endLine: 9 }, status: "ok" },
    });
  });

  it("treats null fields (a model's way of saying 'not given') as absent", () => {
    const r = make({
      file: "src/a.ts",
      symbol: "Runner.run",
      role: "definition",
      span: null,
      find: null,
      hash: null,
    } as never);
    expect(r.ok && r.anchor).toMatchObject({
      symbol: "Runner.run",
      resolved: { range: { startLine: 4, endLine: 12 } },
    });
    expect(r.ok && "span" in r.anchor).toBe(false);
    expect(make({ file: "src/a.ts", symbol: null, role: "test" } as never).ok).toBe(true);
    expect(make({ file: null, role: "test" } as never).ok).toBe(false);
  });

  it("anchors a file-relative span", () => {
    const r = make({ file: "src/a.ts", span: { from: 0, to: 0 }, role: "config" });
    expect(r.ok && r.anchor.resolved!.range).toEqual({ startLine: 1, endLine: 1 });
  });

  it("produces anchors that resolve ok immediately", () => {
    for (const input of [
      { file: "src/a.ts", role: "test" as const },
      { file: "src/a.ts", symbol: "helper", role: "definition" as const },
      { file: "src/a.ts", symbol: "Runner.run", span: { from: 1, to: 6 }, role: "usage" as const },
      { file: "src/a.ts", span: { from: 2, to: 4 }, role: "usage" as const },
    ]) {
      const r = make(input);
      expect(r.ok).toBe(true);
      if (r.ok) expect(resolveAnchor(r.anchor, v1.index, v1.getText).status).toBe("ok");
    }
  });

  describe("find", () => {
    const find = (text: string, over: Partial<AnchorInput> = {}) =>
      make({ file: "src/a.ts", symbol: "Runner.run", find: text, role: "call-site", ...over });
    const failFind = (text: string): string => {
      const r = find(text);
      if (r.ok) throw new Error("expected an error, got " + JSON.stringify(r.anchor));
      return r.error;
    };

    it("matches exactly, on one line", () => {
      const r = find("retry(job);");
      expect(r.ok && r.anchor.span).toEqual({ from: 4, to: 4 });
      expect(r.ok && "find" in r.anchor).toBe(false);
    });

    it("matches exactly across lines", () => {
      const r = find("retry(job);\n      log('retrying');");
      expect(r.ok && r.anchor.span).toEqual({ from: 4, to: 5 });
      expect(r.ok && r.anchor.hash).toBe(hashText("      retry(job);\n      log('retrying');"));
    });

    it("ignores a leading or trailing newline in the needle", () => {
      const r = find("\nretry(job);\n");
      expect(r.ok && r.anchor.span).toEqual({ from: 4, to: 4 });
    });

    it("falls back to whitespace-collapsed matching (across line breaks and indentation)", () => {
      const joined = find("retry(job); log('retrying');");
      expect(joined.ok && joined.anchor.span).toEqual({ from: 4, to: 5 });
      const indented = find("  retry(job);\n  log('retrying');");
      expect(indented.ok && indented.anchor.span).toEqual({ from: 4, to: 5 });
      const spaced = find("if  (a   >  b)  {");
      expect(spaced.ok && spaced.anchor.span).toEqual({ from: 3, to: 3 });
    });

    it("prefers an exact match over the tolerant one", () => {
      const w = world(["a  b", "a b", "x"], []);
      const r = makeAnchor({ file: "src/a.ts", find: "a  b", role: "usage" }, w.index, w.getText);
      expect(r.ok && r.anchor.span).toEqual({ from: 0, to: 0 });
    });

    it("errors when the text occurs several times, saying how often and where", () => {
      const e = failFind("const");
      expect(e).toContain("occurs 2 times in src/a.ts#Runner.run");
      expect(e).toContain("offsets 1, 2");
      const spaced = world(["  a  =  1;", "a = 1;", "b"], []);
      const r = makeAnchor(
        { file: "src/a.ts", find: "a   =  1;", role: "usage" },
        spaced.index,
        spaced.getText,
      );
      expect(!r.ok && r.error).toContain("occurs 2 times");
    });

    it("counts overlapping occurrences", () => {
      const w = world(["foo();", "foo();", "foo();"], []);
      const r = makeAnchor(
        { file: "src/a.ts", find: "foo();\nfoo();", role: "usage" },
        w.index,
        w.getText,
      );
      expect(!r.ok && r.error).toContain("occurs 2 times");
    });

    it("errors when the text is absent, hinting at the first line's position", () => {
      expect(failFind("nonexistent()")).toContain("not found in src/a.ts#Runner.run");
      const near = failFind("retry(job);\n      somethingElse();");
      expect(near).toContain("not found");
      expect(near).toContain('its first line "retry(job);" occurs at offsets 4');
    });

    it("only looks inside the symbol", () => {
      expect(failFind("return 42;")).toContain("not found");
      const r = make({ file: "src/a.ts", find: "return 42;", role: "usage" });
      expect(r.ok && r.anchor.span).toEqual({ from: 15, to: 15 });
    });

    it("handles CRLF files and needles", () => {
      const crlf = makeWorld({ files: [{ path: "src/a.ts", text: "one\r\ntwo\r\nthree\r\n" }] });
      const r = makeAnchor(
        { file: "src/a.ts", find: "two\r\nthree", role: "usage" },
        crlf.index,
        crlf.getText,
      );
      expect(r.ok && r.anchor.span).toEqual({ from: 1, to: 2 });
      const lf = makeAnchor(
        { file: "src/a.ts", find: "two\nthree", role: "usage" },
        crlf.index,
        crlf.getText,
      );
      expect(lf.ok && lf.anchor.span).toEqual({ from: 1, to: 2 });
    });

    it("rejects an empty needle and giving both find and span", () => {
      expect(failFind("   ")).toContain("empty");
      const both = make({
        file: "src/a.ts",
        symbol: "Runner.run",
        find: "retry(job);",
        span: { from: 1, to: 1 },
        role: "usage",
      });
      expect(!both.ok && both.error).toContain("both span and find");
    });
  });

  describe("errors Claude reads", () => {
    it("unknown file suggests candidates", () => {
      expect(fail_({ file: "a.ts", role: "usage" })).toContain("Did you mean: src/a.ts");
      expect(fail_({ file: "nowhere/zzz.ts", role: "usage" })).toContain("not in the index");
    });

    it("unknown symbol suggests the same last segment in that file", () => {
      const e = fail_({ file: "src/a.ts", symbol: "Runer.run", role: "definition" });
      expect(e).toContain('symbol "Runer.run" not found in src/a.ts');
      expect(e).toContain(
        'Did you mean: sym:src/a.ts#Runner.run (anchor: file: "src/a.ts", symbol: "Runner.run")',
      );
    });

    it("unknown symbol suggests the same path in other files", () => {
      const two = makeWorld({
        files: [
          { path: "src/a.ts", lines: 10 },
          { path: "src/b.ts", lines: 10 },
        ],
        symbols: [{ id: "src/b.ts#Thing.go", start: 1, end: 5 }],
      });
      const r = makeAnchor(
        { file: "src/a.ts", symbol: "Thing.go", role: "definition" },
        two.index,
        two.getText,
      );
      expect(!r.ok && r.error).toContain("src/b.ts#Thing.go");
    });

    it("unknown symbol without candidates points at outline", () => {
      expect(fail_({ file: "src/a.ts", symbol: "Zzz", role: "definition" })).toContain(
        "xpl outline",
      );
    });

    it("explains the file#symbol mistake", () => {
      const e = fail_({ file: "src/a.ts", symbol: "src/a.ts#Runner.run", role: "definition" });
      expect(e).toContain('without the file part: "Runner.run"');
    });

    it("rejects spans outside the symbol, saying the valid offsets", () => {
      const e = fail_({
        file: "src/a.ts",
        symbol: "Runner.run",
        span: { from: 2, to: 20 },
        role: "usage",
      });
      expect(e).toContain("outside src/a.ts#Runner.run");
      expect(e).toContain("offsets 0..8");
    });

    it("rejects malformed spans, roles, fields and blank-only spans", () => {
      expect(fail_({ file: "src/a.ts", span: { from: 3, to: 1 }, role: "usage" })).toContain(
        "0 <= from <= to",
      );
      expect(fail_({ file: "src/a.ts", span: { from: 1.5, to: 2 }, role: "usage" })).toContain(
        "integers",
      );
      expect(fail_({ file: "src/a.ts", role: "nope" as never })).toContain(
        "anchor.role must be one of",
      );
      expect(fail_({ file: "src/a.ts" } as never)).toContain("(missing)");
      expect(fail_({ file: "src/a.ts", role: "usage", bogus: 1 } as never)).toContain(
        'unknown anchor field "bogus"',
      );
      expect(fail_({ file: "", role: "usage" })).toContain("anchor.file");
      expect(fail_(null as never)).toContain("must be an object");
      const blank = world(["a", "", "", "b"], []);
      const r = makeAnchor(
        { file: "src/a.ts", span: { from: 1, to: 2 }, role: "usage" },
        blank.index,
        blank.getText,
      );
      expect(!r.ok && r.error).toContain("only blank lines");
    });

    it("rejects values of the wrong type", () => {
      expect(fail_({ file: "src/a.ts", role: "usage", symbol: 3 } as never)).toContain(
        "anchor.symbol",
      );
      expect(fail_({ file: "src/a.ts", role: "usage", find: 3 } as never)).toContain("anchor.find");
      expect(fail_({ file: "src/a.ts", role: "usage", hash: 3 } as never)).toContain("anchor.hash");
      expect(fail_({ file: "src/a.ts", role: "usage", span: "1..2" } as never)).toContain(
        "anchor.span",
      );
    });

    it("rejects a stale hash and accepts a current one", () => {
      const good = make({ file: "src/a.ts", symbol: "helper", role: "definition" });
      expect(good.ok).toBe(true);
      const hash = good.ok ? good.anchor.hash : "";
      expect(make({ file: "src/a.ts", symbol: "helper", role: "definition", hash }).ok).toBe(true);
      const stale = fail_({
        file: "src/a.ts",
        symbol: "helper",
        role: "definition",
        hash: "sha256:000000000000",
      });
      expect(stale).toContain("stale");
      expect(stale).toContain(hash);
      const spanHash = hashText("  return 42;");
      expect(
        make({
          file: "src/a.ts",
          symbol: "helper",
          span: { from: 1, to: 1 },
          role: "usage",
          hash: spanHash,
        }).ok,
      ).toBe(true);
      expect(
        fail_({
          file: "src/a.ts",
          symbol: "helper",
          span: { from: 1, to: 1 },
          role: "usage",
          hash: hash,
        }),
      ).toContain("stale");
    });

    it("cannot hash a span without the file text", () => {
      const r = makeAnchor(
        { file: "src/a.ts", span: { from: 0, to: 0 }, role: "usage" },
        v1.index,
        () => undefined,
      );
      expect(!r.ok && r.error).toContain("cannot read src/a.ts");
      expect(makeAnchor({ file: "src/a.ts", role: "usage" }, v1.index, () => undefined).ok).toBe(
        false,
      );
    });
  });

  function fail_(input: AnchorInput): string {
    return fail(input);
  }
});

describe("reresolveExplainer", () => {
  const anchors = {
    runDef: mk(v1, { file: "src/a.ts", symbol: "Runner.run", role: "definition" }),
    retry: spanAnchor(),
    helper: mk(v1, { file: "src/a.ts", symbol: "helper", role: "definition" }),
    tail: mk(v1, { file: "src/a.ts", span: { from: 14, to: 16 }, role: "config" }),
    top: mk(v1, { file: "src/a.ts", span: { from: 0, to: 0 }, role: "config" }),
  };

  /** v2: one line inserted inside Runner.run, above the span; everything below moves down by one. */
  const inserted = [...V1.slice(0, 6), "    const c = 3;", ...V1.slice(6)];
  const v2 = world(
    inserted,
    [
      { id: "src/a.ts#Runner", kind: "class", start: 3, end: 14 },
      { id: "src/a.ts#Runner.run", start: 4, end: 13 },
      { id: "src/a.ts#helper", kind: "function", start: 16, end: 18 },
    ],
    "c2",
  );

  function explainer(): Explainer {
    return emptyExplainer({
      nodes: [
        group("grp:g", ["file:src/a.ts"], { anchors: [{ ...anchors.helper, symbol: "gone" }] }),
      ],
      edges: [
        edge("edge:e", "file:src/a.ts", "file:src/a.ts", [anchors.helper], {
          provenance: { origin: "static" },
        }),
      ],
      concepts: [
        concept("concept:llm-drifted", [anchors.runDef], {
          provenance: { origin: "llm", userFields: ["summary"], commit: "c1" },
        }),
        concept("concept:user-drifted", [anchors.runDef], { provenance: USER }),
        concept("concept:moved", [anchors.retry, anchors.tail]),
        concept("concept:fine", [anchors.helper, anchors.top]),
      ],
      views: [
        sequenceView(
          "view:s",
          ["file:src/a.ts"],
          [
            {
              id: "s:1",
              from: "file:src/a.ts",
              to: "file:src/a.ts",
              label: "x",
              kind: "call",
              anchors: [{ ...anchors.runDef, file: "src/gone.ts" }],
            },
          ],
          { provenance: LLM },
        ),
      ],
      tours: [
        {
          id: "tour:t",
          title: "T",
          steps: [
            {
              id: "t1",
              view: "view:s",
              focus: [],
              code: [anchors.retry, { ...anchors.runDef, file: "src/gone.ts" }],
            },
          ],
        },
      ],
    });
  }

  it("re-resolves every anchor and reports counts by status", () => {
    const input = explainer();
    const frozen = JSON.stringify(input);
    const { explainer: out, report } = reresolveExplainer(input, v2.index, v2.getText, {
      indexPath: ".explainer/index-c2.json",
    });
    expect(JSON.stringify(input)).toBe(frozen); // never mutates the input
    expect(report.commit).toBe("c2");
    expect(report.total).toBe(11);
    expect(report.counts).toEqual({ ok: 1, moved: 5, drifted: 2, missing: 3 });
    expect(report.moved).toBe(5);
    expect(out.index).toEqual({ path: ".explainer/index-c2.json", commit: "c2" });
    expect(out.repo).toEqual({ name: "acme/jobrunner", commit: "c2" });
  });

  it("keeps the index path when none is given", () => {
    const { explainer: out } = reresolveExplainer(explainer(), v2.index, v2.getText);
    expect(out.index).toEqual({ path: ".explainer/index-c1.json", commit: "c2" });
  });

  it("rewrites resolved, updates span for content-moved anchors and leaves hashes alone", () => {
    const { explainer: out } = reresolveExplainer(explainer(), v2.index, v2.getText);
    const [retry, tail] = out.concepts.find((c) => c.id === "concept:moved")!.anchors;
    expect(retry!.resolved).toEqual({
      commit: "c2",
      range: { startLine: 9, endLine: 10 },
      status: "moved",
    });
    expect(retry!.span).toEqual({ from: 5, to: 6 });
    expect(retry!.hash).toBe(anchors.retry.hash);
    expect(tail!.resolved).toEqual({
      commit: "c2",
      range: { startLine: 16, endLine: 18 },
      status: "moved",
    });
    expect(tail!.span).toEqual({ from: 15, to: 17 });
    const drifted = out.concepts.find((c) => c.id === "concept:llm-drifted")!.anchors[0]!;
    expect(drifted.resolved?.status).toBe("drifted");
    expect(drifted.hash).toBe(anchors.runDef.hash); // still stale until the element is re-explained
    const [helper, top] = out.concepts.find((c) => c.id === "concept:fine")!.anchors;
    expect(helper!.resolved).toEqual({
      commit: "c2",
      range: { startLine: 16, endLine: 18 },
      status: "moved",
    });
    expect(top!.resolved).toEqual({
      commit: "c2",
      range: { startLine: 1, endLine: 1 },
      status: "ok",
    });
    // a whole-symbol anchor that moved keeps its (absent) span
    expect(helper!.span).toBeUndefined();
  });

  it("re-resolving twice in a row settles: moved anchors become ok", () => {
    const first = reresolveExplainer(explainer(), v2.index, v2.getText).explainer;
    const second = reresolveExplainer(first, v2.index, v2.getText);
    expect(second.report.counts.moved).toBe(0);
    expect(second.report.counts.ok).toBe(6);
    expect(second.report.counts.drifted).toBe(2);
  });

  it("lists drifted llm elements with their anchors and userFields; skips user elements", () => {
    const { report } = reresolveExplainer(explainer(), v2.index, v2.getText);
    expect(report.drifted.map((d) => d.elementId)).toEqual(["concept:llm-drifted"]);
    const d = report.drifted[0]!;
    expect(d.userFields).toEqual(["summary"]);
    expect(d.owner).toBe("concept");
    expect(d.anchors).toEqual([
      expect.objectContaining({
        path: "concepts[0].anchors[0]",
        anchor: { file: "src/a.ts", symbol: "Runner.run", role: "definition" },
        range: { startLine: 4, endLine: 13 },
      }),
    ]);
    expect(report.driftedOther).toEqual([
      { elementId: "concept:user-drifted", origin: "user", paths: ["concepts[1].anchors[0]"] },
    ]);
  });

  it("lists every missing anchor with its element id, whatever the origin", () => {
    const { report } = reresolveExplainer(explainer(), v2.index, v2.getText);
    expect(report.missing.map((m) => [m.elementId, m.owner, m.path])).toEqual([
      ["grp:g", "node", "nodes[0].anchors[0]"],
      ["s:1", "step", "views[0].steps[0].anchors[0]"],
      ["tour:t/t1", "tour-step", "tours[0].steps[0].code[1]"],
    ]);
    expect(report.missing[0]!.reason).toContain("gone");
    expect(report.missing[1]!.anchor).toEqual({
      file: "src/gone.ts",
      symbol: "Runner.run",
      role: "definition",
    });
  });

  it("puts drifted anchors of static elements aside, and drifted tour steps with the llm ones", () => {
    const ex = explainer();
    ex.edges[0]!.anchors = [anchors.runDef];
    ex.tours[0]!.steps[0]!.code = [anchors.runDef];
    const { report } = reresolveExplainer(ex, v2.index, v2.getText);
    expect(report.driftedOther.map((d) => d.elementId).sort()).toEqual([
      "concept:user-drifted",
      "edge:e",
    ]);
    expect(report.drifted.map((d) => [d.elementId, d.owner])).toEqual([
      ["concept:llm-drifted", "concept"],
      ["tour:t/t1", "tour-step"],
    ]);
  });

  it("uses the tour's provenance for the code of its steps: a user's tour is not the llm's to re-explain", () => {
    const ex = explainer();
    ex.tours[0]!.steps[0]!.code = [anchors.runDef]; // drifted in v2
    const drifted = () => reresolveExplainer(ex, v2.index, v2.getText).report;
    // a tour without provenance predates it and counts as the llm's
    expect(drifted().drifted.map((d) => d.elementId)).toContain("tour:t/t1");
    ex.tours[0]!.provenance = { origin: "llm", commit: "c1" };
    expect(drifted().drifted.map((d) => d.elementId)).toContain("tour:t/t1");
    ex.tours[0]!.provenance = { origin: "user" };
    expect(drifted().drifted.map((d) => d.elementId)).not.toContain("tour:t/t1");
    expect(drifted().driftedOther.map((d) => d.elementId)).toContain("tour:t/t1");
    // the fields the user edited travel with the anchors, like a view's steps
    ex.tours[0]!.provenance = { origin: "llm", userFields: ["steps"] };
    const site = collectAnchors(ex).find((s) => s.elementId === "tour:t/t1");
    expect(site).toMatchObject({ owner: "tour-step", origin: "llm", userFields: ["steps"] });
  });

  it("collectAnchors skips null or text where a step belongs, and keeps the paths of the others", () => {
    const ex = explainer();
    ex.tours[0]!.steps[0]!.code = [anchors.runDef];
    (ex.tours[0]!.steps as unknown[]).unshift(null, "text");
    (ex.tours as unknown[]).push({ id: "tour:broken", title: "Broken", steps: "nope" });
    const site = collectAnchors(ex).find((s) => s.elementId === "tour:t/t1");
    expect(site?.path).toBe("tours[0].steps[2].code[0]");
  });

  it("uses the view's origin for sequence steps", () => {
    const ex = explainer();
    const view = ex.views[0]!;
    if (view.type !== "sequence") throw new Error("expected a sequence view");
    view.steps[0]!.anchors = [anchors.runDef];
    let out = reresolveExplainer(ex, v2.index, v2.getText).report;
    expect(out.drifted.map((d) => d.elementId)).toContain("s:1");
    view.provenance = USER;
    out = reresolveExplainer(ex, v2.index, v2.getText).report;
    expect(out.drifted.map((d) => d.elementId)).not.toContain("s:1");
    expect(out.driftedOther.map((d) => d.elementId)).toContain("s:1");
  });
});
