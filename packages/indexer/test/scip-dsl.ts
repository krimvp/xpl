/**
 * Test DSL for building synthetic SCIP indexes over real source text: `⟦x⟧` markers select the ranges
 * occurrences refer to, so tests do not count columns by hand.
 */
import { SymbolRole, decodeIndex } from "../src/scip/proto.js";
import type { ColumnEncoding, ScipSource } from "../src/scip/map.js";
import { encodeIndex } from "./scip-encode.js";
import type { DocumentSpec, OccurrenceSpec, SymbolInfoSpec } from "./scip-encode.js";

export const DEF = SymbolRole.Definition;

export interface Marked {
  /** The source with the markers removed. */
  text: string;
  /** Marked ranges in order of appearance: 0-based line, UTF-16 columns, end exclusive. */
  ranges: { line: number; start: number; end: number }[];
  lines: string[];
}

/** `⟦x⟧` marks a range in the source; the markers are removed from the text. */
export function marked(source: string): Marked {
  const ranges: Marked["ranges"] = [];
  const open: { index: number; line: number; col: number }[] = [];
  let text = "";
  let line = 0;
  let col = 0;
  for (const ch of source) {
    if (ch === "⟦") {
      open.push({ index: ranges.length, line, col });
      ranges.push({ line, start: col, end: col });
    } else if (ch === "⟧") {
      const o = open.pop()!;
      ranges[o.index]!.end = col;
    } else {
      text += ch;
      if (ch === "\n") {
        line++;
        col = 0;
      } else {
        col += ch.length;
      }
    }
  }
  return { text, ranges, lines: text.split("\n") };
}

function convert(prefix: string, encoding: ColumnEncoding): number {
  if (encoding === "utf16") return prefix.length;
  if (encoding === "utf8") return Buffer.byteLength(prefix, "utf8");
  return [...prefix].length;
}

/** `[symbol, roles]` for marked range `i`; ranges are written in the given column encoding. */
export function occs(
  m: Marked,
  specs: readonly (readonly [index: number, symbol: string, roles?: number])[],
  encoding: ColumnEncoding = "utf16",
  firstLineShift = 0,
): OccurrenceSpec[] {
  return specs.map(([index, symbol, roles = 0]) => {
    const r = m.ranges[index]!;
    const lineText = m.lines[r.line]!;
    const shift = r.line === 0 ? firstLineShift : 0;
    return {
      range: [
        r.line,
        convert(lineText.slice(0, r.start), encoding) + shift,
        convert(lineText.slice(0, r.end), encoding) + shift,
      ],
      symbol,
      roles,
    };
  });
}

/** scip-typescript style symbol: `src/queue.ts`, `Queue#` -> ``scip-typescript npm t 1.0.0 src/`queue.ts`/Queue#``. */
export function ts(file: string, descriptors = ""): string {
  const parts = file.split("/");
  const name = parts.pop()!;
  return `scip-typescript npm t 1.0.0 ${parts.map((p) => `${p}/`).join("")}\`${name}\`/${descriptors}`;
}

/** The module symbol's definition: zero-width at the top of the file, as scip-typescript emits it. */
export const moduleDef = (file: string): OccurrenceSpec => ({
  range: [0, 0, 0],
  symbol: ts(file),
  roles: DEF,
});

export function source(
  documents: DocumentSpec[],
  extra: Partial<ScipSource> = {},
  externalSymbols: SymbolInfoSpec[] = [],
): ScipSource {
  const index = decodeIndex(
    encodeIndex({ tool: { name: "scip-test", version: "1" }, documents, externalSymbols }),
  );
  return { index, pathPrefix: "", defaultEncoding: "utf16", ...extra };
}
