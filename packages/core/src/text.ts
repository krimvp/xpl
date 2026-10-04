/**
 * Text helpers shared by the indexer, the anchor resolver and the viewer (ARCHITECTURE.md §4.1).
 * Everything that hashes code goes through `hashText`, so drift detection is consistent everywhere.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { Hash, Range } from "./schema.js";

/** Splits on `\n` or `\r\n`. A trailing newline yields a final empty line, like most editors. */
export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/** Full lines `startLine..endLine` (1-based, inclusive), joined with `\n`. Out-of-range lines are dropped. */
export function sliceLines(text: string, range: Range): string {
  return sliceLineArray(splitLines(text), range);
}

/** Same as `sliceLines` for text that is already split. */
export function sliceLineArray(lines: readonly string[], range: Range): string {
  const start = Math.max(1, range.startLine);
  const end = Math.min(lines.length, range.endLine);
  return end < start ? "" : lines.slice(start - 1, end).join("\n");
}

/** Trim every line, drop lines that are empty after trimming, join with `\n`. */
export function normalizeLines(lines: readonly string[]): string {
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed !== "") out.push(trimmed);
  }
  return out.join("\n");
}

/** Versioned source hash: preserve indentation and blank lines; canonicalize CRLF to LF only. */
export function hashText(text: string): Hash {
  return hashNormalized(splitLines(text).join("\n"));
}

/** Hash of source text already canonicalized to LF. Never trim source before hashing. */
export function hashNormalized(normalized: string): Hash {
  return "sha256-v2:" + bytesToHex(sha256(utf8ToBytes(normalized))).slice(0, 12);
}

/** Hash of lines `range` of `text` (full lines). */
export function hashRange(text: string, range: Range): Hash {
  return hashText(sliceLines(text, range));
}
