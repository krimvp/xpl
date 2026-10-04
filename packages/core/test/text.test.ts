import { describe, expect, it } from "vitest";
import { hashText, sliceLines, splitLines } from "../src/index.js";

describe("text", () => {
  it("hashes preserve indentation and blank lines, canonicalizing CRLF only", () => {
    const h = hashText("if (x) {\n  y();\n}");
    expect(h).toMatch(/^sha256-v2:[0-9a-f]{12}$/);
    expect(hashText("if (x) {\n\n        y();\r\n}\n")).not.toBe(h);
    expect(hashText("if (x) {\r\n  y();\r\n}")).toBe(h);
    expect(hashText("if (x) {\n  z();\n}")).not.toBe(h);
  });

  it("slices 1-based inclusive full lines", () => {
    const text = "one\ntwo\nthree\nfour";
    expect(splitLines(text)).toHaveLength(4);
    expect(sliceLines(text, { startLine: 2, endLine: 3 })).toBe("two\nthree");
    expect(sliceLines(text, { startLine: 3, endLine: 9 })).toBe("three\nfour");
    expect(sliceLines(text, { startLine: 3, endLine: 2 })).toBe("");
  });
});
