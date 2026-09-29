/**
 * A minimal protobuf wire-format reader and a decoder for the SCIP messages the importer needs
 * (no generated code, no dependency).
 *
 * The field numbers below were checked against `scip.proto` (github.com/scip-code/scip, v0.10.0; the same
 * numbers are used by the indexers we run: scip-typescript 0.4.0, scip-python 0.6.6, scip-go 0.2.7):
 *
 *   Index              metadata=1  documents=2  external_symbols=3
 *   Metadata           tool_info=2 {name=1 version=2}  project_root=3  text_document_encoding=4
 *   Document           relative_path=1  occurrences=2  symbols=3  language=4  position_encoding=6
 *   Occurrence         range=1 (packed int32)  symbol=2  symbol_roles=3  enclosing_range=7
 *                      (newer schema versions add typed_range=8/9 and typed_enclosing_range=10/11)
 *   SymbolInformation  symbol=1  relationships=4  kind=5  display_name=6  enclosing_symbol=8
 *   Relationship       symbol=1  is_reference=2  is_implementation=3  is_type_definition=4  is_definition=5
 *
 * Everything else (documentation, diagnostics, syntax kinds, document text, signatures, ...) is skipped
 * by wire type, as are fields we do not know, so the decoder keeps working when the schema grows.
 * Ranges stay in the SCIP encoding: 0-based `[line, startChar, endChar]` or
 * `[startLine, startChar, endLine, endChar]`, end exclusive, characters in the document's position encoding.
 */

/** Thrown for input that is not valid protobuf (truncated buffers, bad wire types, ...). */
export class ProtoError extends Error {
  constructor(message: string, offset?: number) {
    super(offset === undefined ? message : `${message} (at byte ${offset})`);
    this.name = "ProtoError";
  }
}

/** Protobuf wire types. */
export const WireType = {
  Varint: 0,
  Fixed64: 1,
  Bytes: 2,
  StartGroup: 3,
  EndGroup: 4,
  Fixed32: 5,
} as const;

const utf8 = new TextDecoder("utf-8");

/** Deepest group nesting `skip` follows before giving up (groups are deprecated; this only guards recursion). */
const MAX_GROUP_DEPTH = 64;

/** A cursor over a byte range of a protobuf message. */
export class ProtoReader {
  pos: number;
  readonly end: number;

  constructor(
    readonly buf: Uint8Array,
    start = 0,
    end = buf.length,
  ) {
    if (start < 0 || end > buf.length || start > end) {
      throw new ProtoError(`invalid reader range ${start}..${end} for a ${buf.length} byte buffer`);
    }
    this.pos = start;
    this.end = end;
  }

  /** True once every byte has been consumed. */
  get done(): boolean {
    return this.pos >= this.end;
  }

  /**
   * An unsigned base-128 varint as a number. Exact up to 2^53 - 1 (SCIP never needs more); the bits of
   * wider values are approximated. Use `readInt32` for `int32`/`enum` fields, which may be sign-extended.
   */
  readVarint(): number {
    let result = 0;
    let scale = 1;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw new ProtoError("truncated varint", this.pos);
      const byte = this.buf[this.pos++]!;
      result += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) return result;
      scale *= 128;
    }
    throw new ProtoError("varint longer than 10 bytes", this.pos);
  }

  /** A varint read as a signed 32-bit integer: negative values arrive as 10-byte sign-extended varints. */
  readInt32(): number {
    let low = 0;
    let shift = 0;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw new ProtoError("truncated varint", this.pos);
      const byte = this.buf[this.pos++]!;
      if (shift < 32) low |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return low | 0;
      shift += 7;
    }
    throw new ProtoError("varint longer than 10 bytes", this.pos);
  }

  /** Field number and wire type of the next field. */
  readTag(): { field: number; wireType: number } {
    const at = this.pos;
    const tag = this.readVarint();
    const field = Math.floor(tag / 8);
    if (field < 1) throw new ProtoError(`invalid field number ${field}`, at);
    return { field, wireType: tag % 8 };
  }

  /** The payload of a length-delimited field, as a view (no copy). */
  readBytes(): Uint8Array {
    const length = this.readVarint();
    if (length > this.end - this.pos) {
      throw new ProtoError(
        `length-delimited field of ${length} bytes overruns its message`,
        this.pos,
      );
    }
    const bytes = this.buf.subarray(this.pos, this.pos + length);
    this.pos += length;
    return bytes;
  }

  /** A length-delimited UTF-8 string. */
  readString(): string {
    return utf8.decode(this.readBytes());
  }

  /** A reader over the payload of the next length-delimited field (a nested message). */
  readMessage(): ProtoReader {
    const length = this.readVarint();
    if (length > this.end - this.pos) {
      throw new ProtoError(`nested message of ${length} bytes overruns its parent`, this.pos);
    }
    const reader = new ProtoReader(this.buf, this.pos, this.pos + length);
    this.pos += length;
    return reader;
  }

  /**
   * Append the values of a `repeated int32` field to `into`. Handles both encodings a parser must accept:
   * packed (`wireType` 2: one length-delimited blob of varints) and unpacked (`wireType` 0: one value).
   */
  readRepeatedInt32(wireType: number, into: number[]): void {
    if (wireType === WireType.Varint) {
      into.push(this.readInt32());
    } else if (wireType === WireType.Bytes) {
      const packed = this.readMessage();
      while (!packed.done) into.push(packed.readInt32());
    } else {
      throw new ProtoError(`repeated int32 field has wire type ${wireType}`, this.pos);
    }
  }

  /** Skip the value of a field with this wire type (unknown fields, fields we do not need). */
  skip(wireType: number, depth = 0): void {
    switch (wireType) {
      case WireType.Varint:
        this.readVarint();
        return;
      case WireType.Fixed64:
        this.advance(8);
        return;
      case WireType.Bytes:
        this.advance(this.readVarint());
        return;
      case WireType.Fixed32:
        this.advance(4);
        return;
      case WireType.StartGroup: {
        if (depth >= MAX_GROUP_DEPTH) throw new ProtoError("groups nested too deeply", this.pos);
        for (;;) {
          if (this.done) throw new ProtoError("unterminated group", this.pos);
          const { wireType: inner } = this.readTag();
          if (inner === WireType.EndGroup) return;
          this.skip(inner, depth + 1);
        }
      }
      default:
        throw new ProtoError(`unsupported wire type ${wireType}`, this.pos);
    }
  }

  private advance(count: number): void {
    if (count > this.end - this.pos) throw new ProtoError("truncated field", this.pos);
    this.pos += count;
  }
}

// ─── SCIP messages ────────────────────────────────────────────────────────────────────────────────

/** `scip.SymbolRole` bit flags of `Occurrence.symbol_roles`. */
export const SymbolRole = {
  Definition: 0x1,
  Import: 0x2,
  WriteAccess: 0x4,
  ReadAccess: 0x8,
  Generated: 0x10,
  Test: 0x20,
  ForwardDefinition: 0x40,
} as const;

/** `scip.PositionEncoding`: how `character` offsets in a document's ranges count. */
export const PositionEncoding = {
  Unspecified: 0,
  /** UTF-8 code units, i.e. bytes. */
  Utf8: 1,
  /** UTF-16 code units. */
  Utf16: 2,
  /** UTF-32 code units, i.e. code points. */
  Utf32: 3,
} as const;

/** A few `scip.SymbolInformation.Kind` values the importer looks at. */
export const SymbolKind = {
  Unspecified: 0,
  Class: 7,
  Enum: 11,
  Interface: 21,
  Module: 29,
  Namespace: 30,
  Package: 35,
  Protocol: 42,
  Struct: 49,
  Trait: 53,
  Type: 54,
  TypeAlias: 55,
  Union: 59,
} as const;

export interface ScipRelationship {
  symbol: string;
  isReference: boolean;
  isImplementation: boolean;
  isTypeDefinition: boolean;
  isDefinition: boolean;
}

export interface ScipSymbolInformation {
  symbol: string;
  relationships: ScipRelationship[];
  /** `SymbolInformation.Kind` (0 = unspecified). */
  kind: number;
  displayName: string;
  enclosingSymbol: string;
}

export interface ScipOccurrence {
  /** `[line, startChar, endChar]` or `[startLine, startChar, endLine, endChar]`; see the file comment. */
  range: number[];
  /** The empty string when the occurrence carries no symbol (highlighting only). */
  symbol: string;
  /** Bitset of `SymbolRole`. */
  symbolRoles: number;
  /** Same encoding as `range`; empty when absent. */
  enclosingRange: number[];
}

export interface ScipDocument {
  /** Path relative to the index's project root, `/`-separated. */
  relativePath: string;
  /** The SCIP language name (`TypeScript`, `Python`, `Go`, ...). */
  language: string;
  /** `PositionEncoding` of the ranges (0 = unspecified). */
  positionEncoding: number;
  occurrences: ScipOccurrence[];
  symbols: ScipSymbolInformation[];
}

export interface ScipMetadata {
  toolName: string;
  toolVersion: string;
  projectRoot: string;
  /** `TextEncoding` of the source files on disk (0 = unspecified, 1 = UTF-8, 2 = UTF-16). */
  textDocumentEncoding: number;
}

export interface ScipIndex {
  metadata: ScipMetadata;
  documents: ScipDocument[];
  externalSymbols: ScipSymbolInformation[];
}

function decodeRelationship(reader: ProtoReader): ScipRelationship {
  const rel: ScipRelationship = {
    symbol: "",
    isReference: false,
    isImplementation: false,
    isTypeDefinition: false,
    isDefinition: false,
  };
  while (!reader.done) {
    const { field, wireType } = reader.readTag();
    if (field === 1 && wireType === WireType.Bytes) rel.symbol = reader.readString();
    else if (field === 2 && wireType === WireType.Varint)
      rel.isReference = reader.readVarint() !== 0;
    else if (field === 3 && wireType === WireType.Varint)
      rel.isImplementation = reader.readVarint() !== 0;
    else if (field === 4 && wireType === WireType.Varint)
      rel.isTypeDefinition = reader.readVarint() !== 0;
    else if (field === 5 && wireType === WireType.Varint)
      rel.isDefinition = reader.readVarint() !== 0;
    else reader.skip(wireType);
  }
  return rel;
}

function decodeSymbolInformation(reader: ProtoReader): ScipSymbolInformation {
  const info: ScipSymbolInformation = {
    symbol: "",
    relationships: [],
    kind: 0,
    displayName: "",
    enclosingSymbol: "",
  };
  while (!reader.done) {
    const { field, wireType } = reader.readTag();
    if (field === 1 && wireType === WireType.Bytes) info.symbol = reader.readString();
    else if (field === 4 && wireType === WireType.Bytes)
      info.relationships.push(decodeRelationship(reader.readMessage()));
    else if (field === 5 && wireType === WireType.Varint) info.kind = reader.readInt32();
    else if (field === 6 && wireType === WireType.Bytes) info.displayName = reader.readString();
    else if (field === 8 && wireType === WireType.Bytes) info.enclosingSymbol = reader.readString();
    else reader.skip(wireType);
  }
  return info;
}

/** `SingleLineRange` (line, start_character, end_character) and `MultiLineRange` (4 numbers), as a flat range. */
function decodeTypedRange(reader: ProtoReader, multiLine: boolean): number[] {
  const values = multiLine ? [0, 0, 0, 0] : [0, 0, 0];
  while (!reader.done) {
    const { field, wireType } = reader.readTag();
    if (wireType === WireType.Varint && field >= 1 && field <= values.length) {
      values[field - 1] = reader.readInt32();
    } else {
      reader.skip(wireType);
    }
  }
  return values;
}

function decodeOccurrence(reader: ProtoReader): ScipOccurrence {
  const occ: ScipOccurrence = { range: [], symbol: "", symbolRoles: 0, enclosingRange: [] };
  // The typed forms (newer schemas) win over the deprecated repeated int32 forms.
  let typedRange: number[] | undefined;
  let typedEnclosing: number[] | undefined;
  while (!reader.done) {
    const { field, wireType } = reader.readTag();
    if (field === 1) reader.readRepeatedInt32(wireType, occ.range);
    else if (field === 2 && wireType === WireType.Bytes) occ.symbol = reader.readString();
    else if (field === 3 && wireType === WireType.Varint) occ.symbolRoles = reader.readInt32();
    else if (field === 7) reader.readRepeatedInt32(wireType, occ.enclosingRange);
    else if ((field === 8 || field === 9) && wireType === WireType.Bytes)
      typedRange = decodeTypedRange(reader.readMessage(), field === 9);
    else if ((field === 10 || field === 11) && wireType === WireType.Bytes)
      typedEnclosing = decodeTypedRange(reader.readMessage(), field === 11);
    else reader.skip(wireType);
  }
  if (typedRange) occ.range = typedRange;
  if (typedEnclosing) occ.enclosingRange = typedEnclosing;
  return occ;
}

function decodeDocument(reader: ProtoReader): ScipDocument {
  const doc: ScipDocument = {
    relativePath: "",
    language: "",
    positionEncoding: 0,
    occurrences: [],
    symbols: [],
  };
  while (!reader.done) {
    const { field, wireType } = reader.readTag();
    if (field === 1 && wireType === WireType.Bytes) doc.relativePath = reader.readString();
    else if (field === 2 && wireType === WireType.Bytes)
      doc.occurrences.push(decodeOccurrence(reader.readMessage()));
    else if (field === 3 && wireType === WireType.Bytes)
      doc.symbols.push(decodeSymbolInformation(reader.readMessage()));
    else if (field === 4 && wireType === WireType.Bytes) doc.language = reader.readString();
    else if (field === 6 && wireType === WireType.Varint) doc.positionEncoding = reader.readInt32();
    else reader.skip(wireType);
  }
  return doc;
}

function decodeMetadata(reader: ProtoReader): ScipMetadata {
  const meta: ScipMetadata = {
    toolName: "",
    toolVersion: "",
    projectRoot: "",
    textDocumentEncoding: 0,
  };
  while (!reader.done) {
    const { field, wireType } = reader.readTag();
    if (field === 2 && wireType === WireType.Bytes) {
      const tool = reader.readMessage();
      while (!tool.done) {
        const t = tool.readTag();
        if (t.field === 1 && t.wireType === WireType.Bytes) meta.toolName = tool.readString();
        else if (t.field === 2 && t.wireType === WireType.Bytes)
          meta.toolVersion = tool.readString();
        else tool.skip(t.wireType);
      }
    } else if (field === 3 && wireType === WireType.Bytes) meta.projectRoot = reader.readString();
    else if (field === 4 && wireType === WireType.Varint)
      meta.textDocumentEncoding = reader.readInt32();
    else reader.skip(wireType);
  }
  return meta;
}

/** Decode a serialized `scip.Index` (the contents of an `index.scip` file). */
export function decodeIndex(bytes: Uint8Array): ScipIndex {
  const reader = new ProtoReader(bytes);
  const index: ScipIndex = {
    metadata: { toolName: "", toolVersion: "", projectRoot: "", textDocumentEncoding: 0 },
    documents: [],
    externalSymbols: [],
  };
  while (!reader.done) {
    const { field, wireType } = reader.readTag();
    if (field === 1 && wireType === WireType.Bytes)
      index.metadata = decodeMetadata(reader.readMessage());
    else if (field === 2 && wireType === WireType.Bytes)
      index.documents.push(decodeDocument(reader.readMessage()));
    else if (field === 3 && wireType === WireType.Bytes)
      index.externalSymbols.push(decodeSymbolInformation(reader.readMessage()));
    else reader.skip(wireType);
  }
  return index;
}

/** A SCIP range normalised to four numbers: 0-based, end exclusive, in the document's position encoding. */
export interface ScipRange {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
}

/** Normalise a 3- or 4-element SCIP range; undefined for anything else or for an inverted range. */
export function parseScipRange(range: readonly number[]): ScipRange | undefined {
  let r: ScipRange;
  if (range.length === 3) {
    r = { startLine: range[0]!, startChar: range[1]!, endLine: range[0]!, endChar: range[2]! };
  } else if (range.length === 4) {
    r = { startLine: range[0]!, startChar: range[1]!, endLine: range[2]!, endChar: range[3]! };
  } else {
    return undefined;
  }
  if (r.startLine < 0 || r.startChar < 0) return undefined;
  if (r.endLine < r.startLine || (r.endLine === r.startLine && r.endChar < r.startChar)) {
    return undefined;
  }
  return r;
}
