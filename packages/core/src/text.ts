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
export function normalizeText(text: string): string {
  return normalizeLines(splitLines(text));
}

/** Same as `normalizeText` for text that is already split. */
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

/**
 * Hashes of every prefix of `lines[start..]`: entry `k - 1` equals `hashNormalized(lines.slice(start,
 * start + k).join("\n"))`, for `k = 1..maxCount`. The lines must already be split on CRLF/LF. Computed incrementally (one SHA-256 state, cloned per prefix), so
 * scanning all windows of a line sequence costs O(lines x maxCount) instead of O(lines x maxCount^2).
 * Retained as a source-prefix hashing utility for callers.
 */
export function normalizedPrefixHashes(
  lines: readonly string[],
  start: number,
  maxCount: number,
): Hash[] {
  const count = Math.min(maxCount, lines.length - start);
  const out: Hash[] = [];
  if (count <= 0) return out;
  const state = sha256.create();
  for (let k = 0; k < count; k++) {
    state.update(utf8ToBytes(k === 0 ? lines[start]! : "\n" + lines[start + k]!));
    out.push("sha256-v2:" + bytesToHex(state.clone().digest()).slice(0, 12));
  }
  return out;
}
