/** A code pane's header: the "in X" chip (`insideSymbol`). */
import { describe, expect, it } from "vitest";
import { IndexModel, type SymbolIndex } from "@xpl/core";
import { insideSymbol } from "../src/editor.js";

const sym = (path: string, startLine: number, endLine: number) => ({
  id: `a.py#${path}`,
  file: "a.py",
  path,
  kind: "function" as const,
  range: { startLine, endLine },
  hash: "x",
});

// sign: 1-20, verify_signature: 22-40, a long dispatch: 42-200 with a nested inner: 50-60
const index = new IndexModel({
  version: 1,
  commit: "c",
  files: [{ path: "a.py", language: "python", lines: 200, hash: "h" }],
  symbols: [
    sym("sign", 1, 20),
    sym("verify_signature", 22, 40),
    sym("dispatch", 42, 200),
    sym("dispatch.inner", 50, 60),
  ],
  refs: [],
} as unknown as SymbolIndex);

const at = (
  top: number,
  bottom: number,
  ranges = [] as { from: number; to: number }[],
  hunks = ranges,
) => insideSymbol(index, "a.py", top, bottom, ranges, hunks);

describe("the pane's 'in X' chip", () => {
  it("names the function that holds the focus, not the context line at the top", () => {
    // context lines of sign above a focus on verify_signature, whose first line is on screen: no chip
    expect(at(15, 45, [{ from: 22, to: 40 }])).toBeUndefined();
    // the focus starts inside a long function whose first line scrolled away
    expect(at(100, 140, [{ from: 110, to: 120 }])).toBe("dispatch");
    // scrolled into the middle of the focus: the focus is still what the pane is about
    expect(at(30, 60, [{ from: 22, to: 40 }])).toBe("verify_signature");
  });

  it("without a focus on screen: the first change on screen, else the top line", () => {
    // the end of the nested inner at the top, a change of dispatch below it
    expect(at(55, 90, [], [{ from: 70, to: 71 }])).toBe("dispatch");
    expect(at(55, 90)).toBe("dispatch.inner");
    expect(at(15, 45)).toBe("sign");
    expect(at(1, 30)).toBeUndefined();
  });
});
