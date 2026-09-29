/**
 * Test helper: a tiny protobuf *writer* and encoders for the SCIP messages, so tests can build `index.scip`
 * buffers by hand (the production code only reads them). Field numbers follow scip.proto.
 */

/** Growable byte buffer with the protobuf primitives. */
export class Writer {
  private bytes: number[] = [];

  /** Unsigned varint (up to 2^53 - 1). */
  varint(value: number): this {
    let v = value;
    while (v >= 0x80) {
      this.bytes.push((v % 0x80) | 0x80);
      v = Math.floor(v / 0x80);
    }
    this.bytes.push(v);
    return this;
  }

  /** `int32`: negative values are sign-extended to ten bytes. */
  int32(value: number): this {
    if (value >= 0) return this.varint(value);
    let v = BigInt.asUintN(64, BigInt(value));
    while (v >= 0x80n) {
      this.bytes.push(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    this.bytes.push(Number(v));
    return this;
  }

  tag(field: number, wireType: number): this {
    return this.varint(field * 8 + wireType);
  }

  raw(bytes: ArrayLike<number>): this {
    for (let i = 0; i < bytes.length; i++) this.bytes.push(bytes[i]!);
    return this;
  }

  /** A varint field (`int32`, `bool`, `enum`). */
  field(field: number, value: number): this {
    return this.tag(field, 0).int32(value);
  }

  /** A length-delimited field holding raw bytes. */
  bytesField(field: number, payload: ArrayLike<number>): this {
    return this.tag(field, 2).varint(payload.length).raw(payload);
  }

  string(field: number, value: string): this {
    return this.bytesField(field, new TextEncoder().encode(value));
  }

  message(field: number, build: (w: Writer) => void): this {
    const inner = new Writer();
    build(inner);
    return this.bytesField(field, inner.finish());
  }

  /** `repeated int32` in the packed encoding. */
  packed(field: number, values: readonly number[]): this {
    const inner = new Writer();
    for (const v of values) inner.int32(v);
    return this.bytesField(field, inner.finish());
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

// ─── SCIP messages ────────────────────────────────────────────────────────────────────────────────

export interface RelationshipSpec {
  symbol: string;
  isReference?: boolean;
  isImplementation?: boolean;
  isTypeDefinition?: boolean;
  isDefinition?: boolean;
}

export interface SymbolInfoSpec {
  symbol: string;
  kind?: number;
  displayName?: string;
  enclosingSymbol?: string;
  relationships?: RelationshipSpec[];
}

export interface OccurrenceSpec {
  /** `[line, startChar, endChar]` or `[startLine, startChar, endLine, endChar]`. */
  range: number[];
  symbol?: string;
  roles?: number;
  enclosingRange?: number[];
}

export interface DocumentSpec {
  path: string;
  language?: string;
  positionEncoding?: number;
  occurrences?: OccurrenceSpec[];
  symbols?: SymbolInfoSpec[];
}

export interface IndexSpec {
  tool?: { name: string; version: string };
  projectRoot?: string;
  textEncoding?: number;
  documents?: DocumentSpec[];
  externalSymbols?: SymbolInfoSpec[];
}

function relationship(w: Writer, rel: RelationshipSpec): void {
  w.string(1, rel.symbol);
  if (rel.isReference) w.field(2, 1);
  if (rel.isImplementation) w.field(3, 1);
  if (rel.isTypeDefinition) w.field(4, 1);
  if (rel.isDefinition) w.field(5, 1);
}

function symbolInfo(w: Writer, info: SymbolInfoSpec): void {
  w.string(1, info.symbol);
  for (const rel of info.relationships ?? []) w.message(4, (m) => relationship(m, rel));
  if (info.kind !== undefined) w.field(5, info.kind);
  if (info.displayName !== undefined) w.string(6, info.displayName);
  if (info.enclosingSymbol !== undefined) w.string(8, info.enclosingSymbol);
}

function occurrence(w: Writer, occ: OccurrenceSpec): void {
  w.packed(1, occ.range);
  if (occ.symbol !== undefined) w.string(2, occ.symbol);
  if (occ.roles !== undefined) w.field(3, occ.roles);
  if (occ.enclosingRange) w.packed(7, occ.enclosingRange);
}

function document(w: Writer, doc: DocumentSpec): void {
  w.string(1, doc.path);
  for (const occ of doc.occurrences ?? []) w.message(2, (m) => occurrence(m, occ));
  for (const info of doc.symbols ?? []) w.message(3, (m) => symbolInfo(m, info));
  if (doc.language !== undefined) w.string(4, doc.language);
  if (doc.positionEncoding !== undefined) w.field(6, doc.positionEncoding);
}

/** Serialize an index the way the SCIP indexers do (metadata first, fields in field-number order). */
export function encodeIndex(spec: IndexSpec): Uint8Array {
  const w = new Writer();
  w.message(1, (m) => {
    if (spec.tool) {
      m.message(2, (t) => {
        t.string(1, spec.tool!.name);
        t.string(2, spec.tool!.version);
      });
    }
    if (spec.projectRoot !== undefined) m.string(3, spec.projectRoot);
    if (spec.textEncoding !== undefined) m.field(4, spec.textEncoding);
  });
  for (const doc of spec.documents ?? []) w.message(2, (m) => document(m, doc));
  for (const info of spec.externalSymbols ?? []) w.message(3, (m) => symbolInfo(m, info));
  return w.finish();
}
