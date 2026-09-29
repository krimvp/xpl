import { describe, expect, it } from "vitest";
import {
  PositionEncoding,
  ProtoError,
  ProtoReader,
  SymbolRole,
  WireType,
  decodeIndex,
  parseScipRange,
} from "../src/scip/proto.js";
import {
  isConstructorSymbol,
  isLocalSymbol,
  isModuleSymbol,
  isTypeSymbol,
  parseScipSymbol,
  symbolPath,
  withoutVersion,
} from "../src/scip/symbol.js";
import { Writer, encodeIndex } from "./scip-encode.js";

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);

describe("ProtoReader: varints", () => {
  it("reads one-byte, multi-byte and 32/53-bit varints", () => {
    expect(new ProtoReader(bytes(0x00)).readVarint()).toBe(0);
    expect(new ProtoReader(bytes(0x7f)).readVarint()).toBe(127);
    expect(new ProtoReader(bytes(0x96, 0x01)).readVarint()).toBe(150);
    expect(new ProtoReader(bytes(0xac, 0x02)).readVarint()).toBe(300);
    expect(new ProtoReader(bytes(0xff, 0xff, 0xff, 0xff, 0x0f)).readVarint()).toBe(0xffffffff);
    expect(new Writer().varint(2 ** 53 - 1).finish()).toHaveLength(8);
    expect(new ProtoReader(new Writer().varint(2 ** 53 - 1).finish()).readVarint()).toBe(
      2 ** 53 - 1,
    );
  });

  it("reads int32 with sign extension (negative numbers take ten bytes)", () => {
    const minusOne = bytes(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01);
    expect(new ProtoReader(minusOne).readInt32()).toBe(-1);
    expect(new ProtoReader(new Writer().int32(-2).finish()).readInt32()).toBe(-2);
    expect(new ProtoReader(new Writer().int32(-2147483648).finish()).readInt32()).toBe(-2147483648);
    expect(new ProtoReader(new Writer().int32(2147483647).finish()).readInt32()).toBe(2147483647);
    // an unsigned 32-bit value wraps like a C cast
    expect(new ProtoReader(bytes(0xff, 0xff, 0xff, 0xff, 0x0f)).readInt32()).toBe(-1);
  });

  it("rejects truncated and over-long varints", () => {
    expect(() => new ProtoReader(bytes(0x80)).readVarint()).toThrow(ProtoError);
    expect(() => new ProtoReader(bytes(0x80)).readInt32()).toThrow(/truncated varint/);
    expect(() => new ProtoReader(new Uint8Array(11).fill(0x80)).readVarint()).toThrow(
      /longer than 10 bytes/,
    );
  });

  it("splits tags into field number and wire type, including fields above 15", () => {
    const w = new Writer().tag(1, WireType.Bytes).tag(16, WireType.Varint).tag(1000, 5);
    const r = new ProtoReader(w.finish());
    expect(r.readTag()).toEqual({ field: 1, wireType: 2 });
    expect(r.readTag()).toEqual({ field: 16, wireType: 0 });
    expect(r.readTag()).toEqual({ field: 1000, wireType: 5 });
    expect(r.done).toBe(true);
    expect(() => new ProtoReader(bytes(0x00)).readTag()).toThrow(/invalid field number/);
  });
});

describe("ProtoReader: length-delimited data", () => {
  it("reads strings as UTF-8 and bytes as views", () => {
    const payload = new TextEncoder().encode("héllo 🚀");
    const w = new Writer().varint(payload.length).raw(payload);
    expect(new ProtoReader(w.finish()).readString()).toBe("héllo 🚀");
    const r = new ProtoReader(bytes(3, 1, 2, 3, 9));
    expect([...r.readBytes()]).toEqual([1, 2, 3]);
    expect(r.pos).toBe(4);
  });

  it("reads nested messages without copying and confines them to their length", () => {
    const outer = new Writer().message(1, (m) => m.field(2, 42).field(3, 7)).field(9, 1);
    const r = new ProtoReader(outer.finish());
    expect(r.readTag().field).toBe(1);
    const inner = r.readMessage();
    expect(inner.readTag()).toEqual({ field: 2, wireType: 0 });
    expect(inner.readVarint()).toBe(42);
    expect(inner.readTag().field).toBe(3);
    expect(inner.readVarint()).toBe(7);
    expect(inner.done).toBe(true);
    expect(r.readTag().field).toBe(9); // the parent continues after the nested message
  });

  it("rejects fields that overrun their message", () => {
    expect(() => new ProtoReader(bytes(5, 1, 2)).readBytes()).toThrow(/overruns/);
    expect(() => new ProtoReader(bytes(5, 1, 2)).readMessage()).toThrow(/overruns/);
    expect(() => new ProtoReader(bytes(1, 2, 3), 2, 1)).toThrow(/invalid reader range/);
  });

  it("reads repeated int32 in packed and unpacked form", () => {
    const out: number[] = [];
    const packed = new Writer().packed(1, [3, -1, 300]);
    const r = new ProtoReader(packed.finish());
    const tag = r.readTag();
    r.readRepeatedInt32(tag.wireType, out);
    expect(out).toEqual([3, -1, 300]);

    const unpacked = new Writer().field(1, 5).field(1, 6);
    const u = new ProtoReader(unpacked.finish());
    for (let i = 0; i < 2; i++) u.readRepeatedInt32(u.readTag().wireType, out);
    expect(out).toEqual([3, -1, 300, 5, 6]);
    expect(() => new ProtoReader(new Writer().finish()).readRepeatedInt32(5, out)).toThrow(
      /wire type 5/,
    );
  });
});

describe("ProtoReader.skip", () => {
  it("skips every wire type", () => {
    const w = new Writer()
      .field(1, 300) // varint
      .tag(2, WireType.Fixed64)
      .raw([1, 2, 3, 4, 5, 6, 7, 8])
      .string(3, "skipped")
      .tag(4, WireType.Fixed32)
      .raw([1, 2, 3, 4])
      .field(5, 99);
    const r = new ProtoReader(w.finish());
    for (let i = 0; i < 4; i++) r.skip(r.readTag().wireType);
    expect(r.readTag()).toEqual({ field: 5, wireType: 0 });
    expect(r.readVarint()).toBe(99);
  });

  it("skips (nested) groups", () => {
    const w = new Writer()
      .tag(1, WireType.StartGroup)
      .field(2, 1)
      .tag(3, WireType.StartGroup)
      .string(4, "in")
      .tag(3, WireType.EndGroup)
      .tag(1, WireType.EndGroup)
      .field(7, 1);
    const r = new ProtoReader(w.finish());
    r.skip(r.readTag().wireType);
    expect(r.readTag().field).toBe(7);
  });

  it("fails on unknown wire types, truncated fields and unterminated groups", () => {
    expect(() => new ProtoReader(bytes()).skip(6)).toThrow(/unsupported wire type/);
    expect(() => new ProtoReader(bytes(1, 2, 3)).skip(WireType.Fixed32)).toThrow(/truncated/);
    expect(() => new ProtoReader(bytes(1, 2, 3)).skip(WireType.Fixed64)).toThrow(/truncated/);
    expect(() => new ProtoReader(bytes(9, 1)).skip(WireType.Bytes)).toThrow(/truncated/);
    const open = new Writer().tag(1, WireType.StartGroup).field(2, 1);
    const r = new ProtoReader(open.finish());
    r.readTag();
    expect(() => r.skip(WireType.StartGroup)).toThrow(/unterminated group/);
  });
});

describe("decodeIndex", () => {
  const symbol = "scip-typescript npm pkg 1.0.0 src/`a.ts`/A#run().";

  it("decodes metadata, documents, occurrences, symbols, relationships and external symbols", () => {
    const encoded = encodeIndex({
      tool: { name: "scip-typescript", version: "0.4.0" },
      projectRoot: "file:///work/repo",
      textEncoding: 1,
      documents: [
        {
          path: "src/a.ts",
          language: "TypeScript",
          positionEncoding: PositionEncoding.Utf8,
          occurrences: [
            {
              range: [3, 4, 7],
              symbol,
              roles: SymbolRole.Definition,
              enclosingRange: [3, 0, 9, 1],
            },
            { range: [10, 2, 12, 5], symbol, roles: SymbolRole.ReadAccess | SymbolRole.Import },
            { range: [0, 0, 0] },
          ],
          symbols: [
            {
              symbol,
              kind: 26,
              displayName: "run",
              enclosingSymbol: "scip-typescript npm pkg 1.0.0 src/`a.ts`/A#",
              relationships: [
                {
                  symbol: "other",
                  isReference: true,
                  isImplementation: true,
                  isTypeDefinition: true,
                  isDefinition: true,
                },
                { symbol: "plain" },
              ],
            },
          ],
        },
        { path: "src/b.ts" },
      ],
      externalSymbols: [{ symbol: "ext npm x 1 y.", kind: 17 }],
    });
    const index = decodeIndex(encoded);
    expect(index.metadata).toEqual({
      toolName: "scip-typescript",
      toolVersion: "0.4.0",
      projectRoot: "file:///work/repo",
      textDocumentEncoding: 1,
    });
    expect(index.documents).toHaveLength(2);
    const doc = index.documents[0]!;
    expect(doc).toMatchObject({
      relativePath: "src/a.ts",
      language: "TypeScript",
      positionEncoding: PositionEncoding.Utf8,
    });
    expect(doc.occurrences).toEqual([
      { range: [3, 4, 7], symbol, symbolRoles: 1, enclosingRange: [3, 0, 9, 1] },
      { range: [10, 2, 12, 5], symbol, symbolRoles: 10, enclosingRange: [] },
      { range: [0, 0, 0], symbol: "", symbolRoles: 0, enclosingRange: [] },
    ]);
    expect(doc.symbols).toEqual([
      {
        symbol,
        kind: 26,
        displayName: "run",
        enclosingSymbol: "scip-typescript npm pkg 1.0.0 src/`a.ts`/A#",
        relationships: [
          {
            symbol: "other",
            isReference: true,
            isImplementation: true,
            isTypeDefinition: true,
            isDefinition: true,
          },
          {
            symbol: "plain",
            isReference: false,
            isImplementation: false,
            isTypeDefinition: false,
            isDefinition: false,
          },
        ],
      },
    ]);
    expect(index.documents[1]).toMatchObject({
      relativePath: "src/b.ts",
      occurrences: [],
      symbols: [],
    });
    expect(index.externalSymbols).toEqual([
      {
        symbol: "ext npm x 1 y.",
        kind: 17,
        displayName: "",
        enclosingSymbol: "",
        relationships: [],
      },
    ]);
  });

  it("decodes hand-written bytes (a whole index in a few lines)", () => {
    // Index { metadata { tool_info { name: "t" } }, documents [ { relative_path: "a", occurrences [ { range: [1, 2, 3], symbol: "s", symbol_roles: 1 } ] } ] }
    const buf = bytes(
      0x0a,
      0x05,
      0x12,
      0x03,
      0x0a,
      0x01,
      0x74, // metadata { tool_info { name: "t" } }
      0x12,
      0x0f, // documents (15 bytes)
      0x0a,
      0x01,
      0x61, //   relative_path: "a"
      0x12,
      0x0a, //   occurrences (10 bytes)
      0x0a,
      0x03,
      0x01,
      0x02,
      0x03, //     range: [1, 2, 3] (packed)
      0x12,
      0x01,
      0x73, //     symbol: "s"
      0x18,
      0x01, //     symbol_roles: 1
    );
    const index = decodeIndex(buf);
    expect(index.metadata.toolName).toBe("t");
    expect(index.documents).toEqual([
      {
        relativePath: "a",
        language: "",
        positionEncoding: 0,
        symbols: [],
        occurrences: [{ range: [1, 2, 3], symbol: "s", symbolRoles: 1, enclosingRange: [] }],
      },
    ]);
  });

  it("accepts an empty buffer and fields in any order", () => {
    expect(decodeIndex(new Uint8Array())).toEqual({
      metadata: { toolName: "", toolVersion: "", projectRoot: "", textDocumentEncoding: 0 },
      documents: [],
      externalSymbols: [],
    });
    // documents before metadata, occurrence fields shuffled
    const w = new Writer()
      .message(2, (d) => {
        d.message(2, (o) => o.field(3, 8).string(2, "sym").packed(1, [1, 1, 4]));
        d.string(1, "z.ts");
      })
      .message(1, (m) => m.string(3, "root"));
    const index = decodeIndex(w.finish());
    expect(index.metadata.projectRoot).toBe("root");
    expect(index.documents[0]).toMatchObject({
      relativePath: "z.ts",
      occurrences: [{ range: [1, 1, 4], symbol: "sym", symbolRoles: 8 }],
    });
  });

  it("decodes unpacked repeated ranges", () => {
    const w = new Writer().message(2, (d) => {
      d.message(2, (o) => o.field(1, 2).field(1, 3).field(1, 9));
    });
    expect(decodeIndex(w.finish()).documents[0]!.occurrences[0]!.range).toEqual([2, 3, 9]);
  });

  it("skips unknown and unneeded fields at every level", () => {
    const w = new Writer()
      .message(1, (m) => {
        m.field(1, 0); // protocol version
        m.message(2, (t) => {
          t.string(1, "tool").string(2, "1.2").string(3, "--flag").field(9, 1);
        });
        m.string(3, "root").field(4, 2).tag(15, WireType.Fixed32).raw([0, 0, 0, 0]);
      })
      .message(2, (d) => {
        d.string(1, "a.ts").string(5, "document text is skipped").string(4, "Go");
        d.message(2, (o) => {
          o.packed(1, [0, 0, 1]).string(2, "s").field(3, 1);
          o.string(4, "override docs")
            .field(5, 6)
            .message(6, (diag) => diag.field(1, 1));
          o.tag(30, WireType.Fixed64).raw(new Array(8).fill(1));
        });
        d.message(3, (s) => {
          s.string(1, "s")
            .string(3, "docs")
            .message(7, (sig) => sig.string(5, "sig"));
          s.message(4, (r) => r.string(1, "t").field(3, 1).string(9, "future"));
        });
        d.tag(99, WireType.StartGroup).field(1, 1).tag(99, WireType.EndGroup);
      })
      .string(77, "future top-level field");
    const index = decodeIndex(w.finish());
    expect(index.metadata).toMatchObject({
      toolName: "tool",
      toolVersion: "1.2",
      textDocumentEncoding: 2,
    });
    const doc = index.documents[0]!;
    expect(doc.language).toBe("Go");
    expect(doc.occurrences).toEqual([
      { range: [0, 0, 1], symbol: "s", symbolRoles: 1, enclosingRange: [] },
    ]);
    expect(doc.symbols[0]).toMatchObject({
      symbol: "s",
      relationships: [{ symbol: "t", isImplementation: true }],
    });
  });

  it("prefers typed ranges over the deprecated encoding and reads both typed shapes", () => {
    const w = new Writer().message(2, (d) => {
      d.message(2, (o) => {
        o.packed(1, [9, 9, 9]); // deprecated, overridden below
        o.message(8, (r) => r.field(1, 4).field(2, 5).field(3, 8)); // single_line_range
        o.message(10, (r) => r.field(1, 4).field(2, 0).field(3, 20)); // single_line_enclosing_range
        o.string(2, "a");
      });
      d.message(2, (o) => {
        o.message(9, (r) => r.field(1, 1).field(2, 2).field(3, 3).field(4, 4)); // multi_line_range
        o.message(11, (r) => r.field(1, 0).field(2, 0).field(3, 9).field(4, 1)); // multi_line_enclosing_range
        o.string(2, "b");
      });
    });
    const [a, b] = decodeIndex(w.finish()).documents[0]!.occurrences;
    expect(a).toMatchObject({ range: [4, 5, 8], enclosingRange: [4, 0, 20] });
    expect(b).toMatchObject({ range: [1, 2, 3, 4], enclosingRange: [0, 0, 9, 1] });
  });

  it("throws ProtoError for truncated or corrupt input", () => {
    const good = encodeIndex({
      documents: [{ path: "a.ts", occurrences: [{ range: [0, 0, 1], symbol: "s" }] }],
    });
    expect(() => decodeIndex(good.subarray(0, good.length - 3))).toThrow(ProtoError);
    expect(() => decodeIndex(bytes(0x12, 0x7f, 0x01))).toThrow(/overruns/);
    expect(() => decodeIndex(bytes(0x0f))).toThrow(ProtoError); // wire type 7
  });

  it("decodes a large index quickly", () => {
    const occurrences = Array.from({ length: 50_000 }, (_, i) => ({
      range: [i, 0, 5],
      symbol: `scip-typescript npm p 1 src/\`a.ts\`/S${i % 100}#`,
      roles: i % 7 === 0 ? 1 : 8,
    }));
    const encoded = encodeIndex({ documents: [{ path: "a.ts", occurrences }] });
    const started = performance.now();
    const index = decodeIndex(encoded);
    expect(index.documents[0]!.occurrences).toHaveLength(50_000);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("parseScipRange", () => {
  it("normalises three- and four-element ranges", () => {
    expect(parseScipRange([3, 4, 9])).toEqual({
      startLine: 3,
      startChar: 4,
      endLine: 3,
      endChar: 9,
    });
    expect(parseScipRange([3, 4, 5, 2])).toEqual({
      startLine: 3,
      startChar: 4,
      endLine: 5,
      endChar: 2,
    });
    expect(parseScipRange([0, 0, 0])).toEqual({
      startLine: 0,
      startChar: 0,
      endLine: 0,
      endChar: 0,
    });
  });

  it("rejects malformed and inverted ranges", () => {
    expect(parseScipRange([])).toBeUndefined();
    expect(parseScipRange([1, 2])).toBeUndefined();
    expect(parseScipRange([1, 2, 3, 4, 5])).toBeUndefined();
    expect(parseScipRange([-1, 0, 3])).toBeUndefined();
    expect(parseScipRange([2, 5, 3])).toBeUndefined();
    expect(parseScipRange([4, 0, 3, 9])).toBeUndefined();
  });
});

describe("SCIP symbol strings", () => {
  it("parses scip-typescript symbols", () => {
    const s = parseScipSymbol(
      "scip-typescript npm ts-jobrunner 0.1.0 src/`runner.ts`/Runner#dispatch().",
    )!;
    expect(s).toMatchObject({
      scheme: "scip-typescript",
      manager: "npm",
      packageName: "ts-jobrunner",
      version: "0.1.0",
    });
    expect(s.descriptors.map((d) => `${d.name}:${d.suffix}`)).toEqual([
      "src:namespace",
      "runner.ts:namespace",
      "Runner:type",
      "dispatch:method",
    ]);
    expect(symbolPath(s)).toBe("Runner.dispatch");
    expect(isTypeSymbol(s)).toBe(false);
    expect(isModuleSymbol(s)).toBe(false);
  });

  it("classifies types, modules, constructors and accessors", () => {
    const type = parseScipSymbol("scip-typescript npm p 1 src/`q.ts`/Queue#")!;
    expect(isTypeSymbol(type)).toBe(true);
    expect(symbolPath(type)).toBe("Queue");
    const module = parseScipSymbol("scip-typescript npm p 1 src/`q.ts`/")!;
    expect(isModuleSymbol(module)).toBe(true);
    expect(symbolPath(module)).toBeUndefined();
    const ctor = parseScipSymbol("scip-typescript npm p 1 src/`q.ts`/Queue#`<constructor>`().")!;
    expect(isConstructorSymbol(ctor)).toBe(true);
    expect(symbolPath(ctor)).toBe("Queue.constructor");
    const getter = parseScipSymbol("scip-typescript npm p 1 src/`q.ts`/Queue#`<get>size`().")!;
    expect(symbolPath(getter)).toBe("Queue.size");
    const pyModule = parseScipSymbol("scip-python python py 0.1.0 `jobrunner.runner`/__init__:")!;
    expect(isModuleSymbol(pyModule)).toBe(true);
  });

  it("parses python and go symbols", () => {
    const py = parseScipSymbol(
      "scip-python python py-jobrunner 0.1.0 `jobrunner.runner`/Runner#dispatch().",
    )!;
    expect(symbolPath(py)).toBe("Runner.dispatch");
    const go = parseScipSymbol(
      "scip-go gomod example.com/jobrunner 9067a8600380 `example.com/jobrunner/internal/runner`/JobQueue#Pop.",
    )!;
    expect(go.packageName).toBe("example.com/jobrunner");
    expect(symbolPath(go)).toBe("JobQueue.Pop");
    const pkg = parseScipSymbol(
      "scip-go gomod example.com/jobrunner . `example.com/jobrunner/internal/queue`/",
    )!;
    expect(isModuleSymbol(pkg)).toBe(true);
  });

  it("has no path for parameters, type parameters and synthetic members", () => {
    expect(
      symbolPath(parseScipSymbol("scip-typescript npm p 1 src/`a.ts`/f().(arg)")!),
    ).toBeUndefined();
    expect(
      symbolPath(parseScipSymbol("scip-typescript npm p 1 src/`a.ts`/Box#[T]")!),
    ).toBeUndefined();
    expect(
      symbolPath(
        parseScipSymbol("scip-typescript npm p 1 src/`c.ts`/Config#metrics.typeLiteral2:prefix.")!,
      ),
    ).toBeUndefined();
  });

  it("handles escaped spaces in package fields and backticks in names", () => {
    const s = parseScipSymbol("scheme  x manager my  pkg 1.0 `weird``name`#")!;
    expect(s.scheme).toBe("scheme x");
    expect(s.manager).toBe("manager");
    expect(s.packageName).toBe("my pkg");
    expect(s.descriptors[0]).toMatchObject({ name: "weird`name", suffix: "type" });
  });

  it("recognises local symbols and rejects malformed input", () => {
    expect(isLocalSymbol("local 12")).toBe(true);
    expect(isLocalSymbol("scip-typescript npm p 1 a#")).toBe(false);
    expect(parseScipSymbol("local 12")).toBeUndefined();
    expect(parseScipSymbol("")).toBeUndefined();
    expect(parseScipSymbol("only three fields")).toBeUndefined();
    expect(parseScipSymbol("a b c d Name")).toBeUndefined(); // no suffix
    expect(parseScipSymbol("a b c d `unterminated")).toBeUndefined();
    expect(parseScipSymbol("a b c d f(broken")).toBeUndefined();
  });

  it("blanks the package version so the same declaration compares equal across indexes", () => {
    const a = "scip-go gomod example.com/a 9067a8600380 `example.com/a`/A().";
    const b = "scip-go gomod example.com/a . `example.com/a`/A().";
    expect(withoutVersion(a)).toBe(withoutVersion(b));
    expect(withoutVersion(a)).not.toBe(
      withoutVersion(a.replace("example.com/a 9", "example.com/b 9")),
    );
    expect(withoutVersion("scheme  x manager my  pkg 1.0 `n`#")).toBe(
      "scheme  x manager my  pkg ~ `n`#",
    );
    expect(withoutVersion("local 4")).toBe("local 4");
    expect(withoutVersion("garbage")).toBe("garbage");
  });

  it("parses overload disambiguators", () => {
    const s = parseScipSymbol("scip-typescript npm p 1 src/`a.ts`/f(+1).")!;
    expect(s.descriptors[s.descriptors.length - 1]).toMatchObject({
      name: "f",
      suffix: "method",
      disambiguator: "+1",
    });
    expect(symbolPath(s)).toBe("f");
  });
});
