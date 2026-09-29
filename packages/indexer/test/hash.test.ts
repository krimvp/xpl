import { describe, expect, it } from "vitest";
import { hashText, sliceLines, splitLines } from "@xpl/core";
import { FileHasher } from "../src/index.js";
import { fastHashingMatchesCore } from "../src/hash.js";

const texts: Record<string, string> = {
  plain: "one\ntwo\nthree\n",
  crlf: "one\r\ntwo\r\n\r\nthree\r\n",
  blank: "\n\n   \n\t\n",
  empty: "",
  indent: "class A {\n    m() {\n\t\treturn 1;\n    }\n}\n",
  unicode: "café\n😀 smile\n nbsp \n﻿bom line\n",
  loneSurrogate: "a\ud800b\nc\udc00\n",
  spaces: "  a  \n  b  \n",
  long: Array.from({ length: 500 }, (_, i) => `  line ${i}  `).join("\n"),
};

describe("FileHasher matches @xpl/core hashText(sliceLines(...))", () => {
  it("uses the fast path against the current core implementation", () => {
    expect(fastHashingMatchesCore()).toBe(true);
  });

  it.each(Object.keys(texts))("%s: whole file and every range", (name) => {
    const text = texts[name]!;
    const lines = splitLines(text);
    const hasher = new FileHasher(lines);
    expect(hasher.hashFile()).toBe(hashText(text));
    // a spread of ranges, including empty, inverted and out-of-bounds ones
    const starts = [0, 1, 2, 3, Math.max(1, lines.length - 1), lines.length, lines.length + 3];
    for (const startLine of starts) {
      for (const endLine of [
        startLine - 1,
        startLine,
        startLine + 1,
        startLine + 7,
        lines.length,
        lines.length + 5,
      ]) {
        const range = { startLine, endLine };
        expect(hasher.hashRange(range), `${name} ${startLine}-${endLine}`).toBe(
          hashText(sliceLines(text, range)),
        );
      }
    }
  });

  it("ignores indentation, blank lines and CRLF the way anchors do", () => {
    const a = new FileHasher(splitLines("  x = 1\r\n\r\n\ty = 2\r\n")).hashFile();
    const b = new FileHasher(splitLines("x = 1\ny = 2")).hashFile();
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{12}$/);
  });

  it("is fast enough to hash a large nested file many times", () => {
    const lines = Array.from(
      { length: 50_000 },
      (_, i) => `    const value${i} = compute(${i}, "text");`,
    );
    const hasher = new FileHasher(lines);
    const started = performance.now();
    for (let i = 0; i < 200; i++) hasher.hashRange({ startLine: 1 + i, endLine: 20_000 + i });
    expect(performance.now() - started).toBeLessThan(5000);
  });
});
