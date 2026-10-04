/**
 * A compact form of the symbol index for a bundle page (`xpl bundle`). As JSON, an index is mostly the same long
 * strings again and again: every reference spells out both symbol ids and the field names of its site. Packed,
 * each symbol id is written once, in `ids`, and a symbol or a reference is a short array of numbers; on xpl's own
 * index that is about a fifth of the size. Nothing is lost: `unpackIndex(packIndex(index))` is equal to `index`
 * (an entry of a shape the packing does not know stays an object, as it was), and `parseBundle` unpacks, so the
 * viewer only ever sees a plain `SymbolIndex`.
 */
import type { IndexedSymbol, Range, Reference, SymbolIndex } from "./schema.js";

export const INDEX_PACKING = "xpl-index-pack@1";

const SYMBOL_KINDS: readonly IndexedSymbol["kind"][] = [
  "class",
  "interface",
  "function",
  "method",
  "type",
  "variable",
  "enum",
  "key",
  "other",
];
const REF_KINDS: readonly Reference["kind"][] = [
  "call",
  "import",
  "extends",
  "implements",
  "type-ref",
  "read",
  "write",
];

/**
 * `[id, kind, startLine, endLine, hash, parent, provider?]`: `id` and `parent` are positions in `ids` (`parent` -1: none),
 * `kind` a position in `SYMBOL_KINDS`. The file and the path are the id's two parts.
 */
type PackedSymbol = [number, number, number, number, string, number, number?];
/**
 * `[from, to, kind, startLine, lines, startCol, endCol, precise, provider?]`: `from` and `to` are positions in `ids`, `kind`
 * one in `REF_KINDS`, `lines` is `endLine - startLine`, a column 0 is none (columns start at 1), `precise` 1 or 0.
 */
type PackedRef = [number, number, number, number, number, number, number, number, number?];

export interface PackedIndex extends Omit<SymbolIndex, "symbols" | "refs"> {
  packing: typeof INDEX_PACKING;
  /** Every symbol id the symbols and references name, once. */
  ids: string[];
  symbols: (PackedSymbol | IndexedSymbol)[];
  refs: (PackedRef | Reference)[];
}

export function isPackedIndex(value: unknown): value is PackedIndex {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { packing?: unknown }).packing === INDEX_PACKING
  );
}

const hasKeys = (value: object, keys: readonly string[]): boolean => {
  const own = Object.keys(value);
  return own.length === keys.length && own.every((key) => keys.includes(key));
};

/** A whole-line range or one with both columns, and nothing else. */
const plainRange = (range: Range | undefined, cols: boolean): boolean =>
  typeof range === "object" &&
  range !== null &&
  Number.isInteger(range.startLine) &&
  Number.isInteger(range.endLine) &&
  hasKeys(
    range,
    cols ? ["startLine", "endLine", "startCol", "endCol"] : ["startLine", "endLine"],
  ) &&
  (!cols || (Number.isInteger(range.startCol) && Number.isInteger(range.endCol)));

/** The index in its packed form, for a bundle page. A new object; `index` is not touched. */
export function packIndex(index: SymbolIndex): PackedIndex {
  const ids: string[] = [];
  const at = new Map<string, number>();
  const id = (value: string): number => {
    let known = at.get(value);
    if (known === undefined) {
      known = ids.length;
      ids.push(value);
      at.set(value, known);
    }
    return known;
  };
  const symbols = (index.symbols ?? []).map((symbol): PackedSymbol | IndexedSymbol => {
    const kind = SYMBOL_KINDS.indexOf(symbol.kind);
    const hash = symbol.id.indexOf("#");
    const fits =
      kind !== -1 &&
      typeof symbol.hash === "string" &&
      hash !== -1 &&
      symbol.id.slice(0, hash) === symbol.file &&
      symbol.id.slice(hash + 1) === symbol.path &&
      plainRange(symbol.range, false) &&
      (symbol.parent === undefined || typeof symbol.parent === "string") &&
      (symbol.provider === undefined || Number.isInteger(symbol.provider)) &&
      hasKeys(symbol, [
        "id",
        "file",
        "path",
        "kind",
        "range",
        "hash",
        ...(symbol.parent === undefined ? [] : ["parent"]),
        ...(symbol.provider === undefined ? [] : ["provider"]),
      ]);
    if (!fits) return symbol;
    const tuple: PackedSymbol = [
      id(symbol.id),
      kind,
      symbol.range.startLine,
      symbol.range.endLine,
      symbol.hash,
      symbol.parent === undefined ? -1 : id(symbol.parent),
    ];
    if (symbol.provider !== undefined) tuple.push(symbol.provider);
    return tuple;
  });
  const refs = (index.refs ?? []).map((ref): PackedRef | Reference => {
    const kind = REF_KINDS.indexOf(ref.kind);
    const cols = ref.site?.startCol !== undefined;
    const fits =
      kind !== -1 &&
      typeof ref.from === "string" &&
      typeof ref.to === "string" &&
      (ref.resolution === "precise" || ref.resolution === "heuristic") &&
      plainRange(ref.site, cols) &&
      (!cols || ref.site.startCol! >= 1) &&
      (ref.provider === undefined || Number.isInteger(ref.provider)) &&
      hasKeys(ref, [
        "from",
        "to",
        "kind",
        "site",
        "resolution",
        ...(ref.provider === undefined ? [] : ["provider"]),
      ]);
    if (!fits) return ref;
    const tuple: PackedRef = [
      id(ref.from),
      id(ref.to),
      kind,
      ref.site.startLine,
      ref.site.endLine - ref.site.startLine,
      cols ? ref.site.startCol! : 0,
      cols ? ref.site.endCol! : 0,
      ref.resolution === "precise" ? 1 : 0,
    ];
    if (ref.provider !== undefined) tuple.push(ref.provider);
    return tuple;
  });
  const { symbols: _symbols, refs: _refs, ...rest } = index;
  return {
    ...rest,
    packing: INDEX_PACKING,
    ids,
    symbols,
    refs,
  };
}

/** The plain index back from its packed form (equal to what was packed). */
export function unpackIndex(packed: PackedIndex): SymbolIndex {
  const { packing: _packing, ids, symbols, refs, ...rest } = packed;
  return {
    ...(rest as Omit<SymbolIndex, "symbols" | "refs">),
    symbols: symbols.map((entry): IndexedSymbol => {
      if (!Array.isArray(entry)) return entry;
      const [at, kind, startLine, endLine, hash, parent, provider] = entry;
      const id = ids[at]!;
      const cut = id.indexOf("#");
      return {
        id,
        file: id.slice(0, cut),
        path: id.slice(cut + 1),
        kind: SYMBOL_KINDS[kind]!,
        range: { startLine, endLine },
        hash,
        ...(parent === -1 ? {} : { parent: ids[parent]! }),
        ...(provider === undefined ? {} : { provider }),
      };
    }),
    refs: refs.map((entry): Reference => {
      if (!Array.isArray(entry)) return entry;
      const [from, to, kind, startLine, lines, startCol, endCol, precise, provider] = entry;
      return {
        from: ids[from]!,
        to: ids[to]!,
        kind: REF_KINDS[kind]!,
        site: {
          startLine,
          endLine: startLine + lines,
          ...(startCol === 0 ? {} : { startCol, endCol }),
        },
        resolution: precise === 1 ? "precise" : "heuristic",
        ...(provider === undefined ? {} : { provider }),
      };
    }),
  };
}
