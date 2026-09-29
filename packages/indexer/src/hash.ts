/**
 * Fast hashing of line ranges with the exact semantics of `@xpl/core`'s `hashText(sliceLines(text, range))`
 * (ARCHITECTURE.md §4.1: trim every line, drop blank lines, join with `\n`, sha256, first 12 hex chars).
 *
 * Symbols nest, so a file's lines are hashed many times (a class, each of its methods, ...). Going through
 * `hashText` repeats the join/split/trim work and uses a pure-JS SHA-256 each time. `FileHasher` trims every
 * line once and digests with Node's native SHA-256, which is several times faster on large files.
 *
 * It is a pure optimisation: `fastHashingMatchesCore()` compares it with `hashText` on a tricky sample the
 * first time it is used, and if core's algorithm ever changes, `FileHasher` silently falls back to
 * `hashText`, so the values in an index never depend on which path ran (test/hash.test.ts checks this too).
 */
import { createHash } from "node:crypto";
import { hashText, sliceLineArray } from "@xpl/core";
import type { Hash, Range } from "@xpl/core";

const SAMPLE_LINES: readonly string[] = [
  "  indented\t",
  "",
  " nbsp ",
  "   ",
  "café 😀",
  "﻿bom",
  "last",
];

function digest(normalized: string): Hash {
  return "sha256:" + createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 12);
}

let fastOk: boolean | undefined;

/** Does the fast path produce the same values as core's `hashText`? Checked once, on a fixed sample. */
export function fastHashingMatchesCore(): boolean {
  if (fastOk === undefined) {
    try {
      const trimmed = SAMPLE_LINES.map((l) => l.trim()).filter((l) => l !== "");
      fastOk = digest(trimmed.join("\n")) === hashText(SAMPLE_LINES.join("\n"));
    } catch {
      fastOk = false;
    }
  }
  return fastOk;
}

/** Hashes ranges of one file's lines. */
export class FileHasher {
  private readonly trimmed: string[];
  private readonly fast = fastHashingMatchesCore();

  /** `lines` = `splitLines(text)`. */
  constructor(private readonly lines: readonly string[]) {
    this.trimmed = this.fast ? lines.map((l) => l.trim()) : [];
  }

  /** `hashText(sliceLines(text, range))`: the hash of the full lines `startLine..endLine` (1-based). */
  hashRange(range: Pick<Range, "startLine" | "endLine">): Hash {
    if (!this.fast) return hashText(sliceLineArray(this.lines, range));
    const from = Math.max(1, range.startLine);
    const to = Math.min(this.trimmed.length, range.endLine);
    const kept: string[] = [];
    for (let i = from - 1; i < to; i++) {
      const line = this.trimmed[i]!;
      if (line !== "") kept.push(line);
    }
    return digest(kept.join("\n"));
  }

  /** The whole file (`hashText(text)`). */
  hashFile(): Hash {
    return this.hashRange({ startLine: 1, endLine: this.lines.length });
  }
}
