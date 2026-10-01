/**
 * Seeded randomised tests of the anchor invariants: text that did not change is never reported
 * drifted, and whatever range is reported holds exactly the anchored text.
 */
import { describe, expect, it } from "vitest";
import { hashText, makeAnchor, resolveAnchor, sliceLines, type Anchor } from "../src/index.js";
import { makeWorld, type SymbolDecl } from "./helpers.js";

/** Small deterministic PRNG. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const pick = (r: () => number, n: number) => Math.floor(r() * n);

/** A file of distinct lines (some blank), with a symbol around the middle. */
function randomFile(r: () => number) {
  const n = 30 + pick(r, 40);
  const lines: string[] = [];
  for (let i = 1; i <= n; i++) {
    lines.push(
      r() < 0.12 ? "" : `${"  ".repeat(pick(r, 4))}const value${i} = call${i}(${pick(r, 1000)});`,
    );
  }
  // the symbol covers a middle stretch that starts and ends on non-blank lines
  let start = 8 + pick(r, 5);
  let end = n - 8 - pick(r, 5);
  while (lines[start - 1] === "") start++;
  while (lines[end - 1] === "") end--;
  return { lines, start, end };
}

describe("anchor invariants (randomised)", () => {
  it("unchanged text is never drifted, and the resolved range holds exactly the anchored text", () => {
    const r = rng(20240607);
    let moved = 0;
    for (let round = 0; round < 250; round++) {
      const { lines, start, end } = randomFile(r);
      const before = makeWorld({
        files: [{ path: "f.ts", text: lines.join("\n") }],
        symbols: [{ id: "f.ts#S", kind: "function", start, end }],
      });
      // an anchored span of 1-6 non-blank lines inside the symbol
      const size = end - start + 1;
      const from = pick(r, size - 1);
      const to = Math.min(size - 1, from + pick(r, 6));
      const made = makeAnchor(
        { file: "f.ts", symbol: "S", span: { from, to }, role: "usage" },
        before.index,
        before.getText,
      );
      if (!made.ok) continue; // blank-only span: nothing to anchor
      const anchor: Anchor = made.anchor;
      const anchoredLines = lines.slice(start - 1 + from, start + to);

      // edit: insert 1-4 blank lines / new distinct lines above, inside (outside the span) or below
      const edited = [...lines];
      let symStart = start;
      let symEnd = end;
      const inserts = 1 + pick(r, 4);
      const spanStart = start + from; // 1-based first anchored line, in current coordinates
      const spanEnd = start + to;
      let curSpanStart = spanStart;
      let curSpanEnd = spanEnd;
      for (let k = 0; k < inserts; k++) {
        let at = pick(r, edited.length + 1); // insert before edited[at] (0-based)
        if (at + 1 > curSpanStart && at + 1 <= curSpanEnd) at = curSpanStart - 1;
        const line1 = at + 1; // the new line's 1-based number
        const text = r() < 0.4 ? "" : `// inserted ${round}-${k}`;
        edited.splice(at, 0, text);
        if (line1 <= curSpanStart) {
          curSpanStart++;
          curSpanEnd++;
        } else if (line1 <= curSpanEnd) curSpanEnd++;
        if (line1 <= symStart) symStart++;
        if (line1 <= symEnd) symEnd++;
      }
      // keep the symbol range on non-blank lines like a real indexer would
      while (edited[symStart - 1] === "") symStart++;
      while (edited[symEnd - 1] === "") symEnd--;
      if (symStart > curSpanStart || symEnd < curSpanEnd) continue; // an edit ate into the span's frame

      const after = makeWorld({
        files: [{ path: "f.ts", text: edited.join("\n") }],
        symbols: [{ id: "f.ts#S", kind: "function", start: symStart, end: symEnd } as SymbolDecl],
      });
      const result = resolveAnchor(anchor, after.index, after.getText);
      expect(result.status, `round ${round}`).not.toBe("drifted");
      expect(result.status, `round ${round}`).not.toBe("missing");
      if (result.status === "moved") moved++;
      const text = sliceLines(edited.join("\n"), result.range);
      expect(hashText(text), `round ${round}`).toBe(anchor.hash);
      expect(hashText(anchoredLines.join("\n"))).toBe(anchor.hash);
      // and the reported span is consistent with the reported range
      const base = symStart;
      const span = result.span ?? anchor.span!;
      if (result.span) {
        expect(result.range.startLine).toBe(base + span.from);
        expect(result.range.endLine).toBe(base + span.to);
      }
    }
    expect(moved).toBeGreaterThan(100); // the edits really do move things
  });

  it("changing the anchored text makes it drifted (or missing), never ok", () => {
    const r = rng(7);
    let drifted = 0;
    for (let round = 0; round < 150; round++) {
      const { lines, start, end } = randomFile(r);
      const world = (ls: string[]) =>
        makeWorld({
          files: [{ path: "f.ts", text: ls.join("\n") }],
          symbols: [{ id: "f.ts#S", kind: "function", start, end }],
        });
      const before = world(lines);
      const size = end - start + 1;
      const from = 1 + pick(r, size - 2);
      const made = makeAnchor(
        { file: "f.ts", symbol: "S", span: { from, to: from }, role: "usage" },
        before.index,
        before.getText,
      );
      if (!made.ok) continue;
      const edited = [...lines];
      edited[start - 1 + from] = edited[start - 1 + from] + " // changed";
      const after = world(edited);
      const result = resolveAnchor(made.anchor, after.index, after.getText);
      expect(result.status, `round ${round}`).toBe("drifted");
      drifted++;
    }
    expect(drifted).toBeGreaterThan(100);
  });

  it("find: a needle re-indented and re-spaced still finds its lines", () => {
    const r = rng(99);
    let checked = 0;
    for (let round = 0; round < 200; round++) {
      const { lines, start, end } = randomFile(r);
      const world = makeWorld({
        files: [{ path: "f.ts", text: lines.join("\n") }],
        symbols: [{ id: "f.ts#S", kind: "function", start, end }],
      });
      const size = end - start + 1;
      const from = pick(r, size - 3);
      const to = from + pick(r, 3);
      const chosen = lines.slice(start - 1 + from, start + to);
      const nonBlank = chosen.map((l) => l.trim()).filter((l) => l !== "");
      if (nonBlank.length === 0 || chosen[0] === "" || chosen[chosen.length - 1] === "") continue;
      // exact needle: the lines as they are
      const exact = makeAnchor(
        { file: "f.ts", symbol: "S", find: chosen.join("\n"), role: "usage" },
        world.index,
        world.getText,
      );
      expect(exact.ok && exact.anchor.span, `exact ${round}`).toEqual({ from, to });
      // tolerant needle: other indentation, blank lines dropped, spaces doubled
      const loose = nonBlank
        .map((l) => `${" ".repeat(pick(r, 6))}${l.replace(/ /g, "  ")}`)
        .join("\n");
      const found = makeAnchor(
        { file: "f.ts", symbol: "S", find: loose, role: "usage" },
        world.index,
        world.getText,
      );
      // dropping blank lines from a multi-line needle only matches text without blank lines inside
      if (!chosen.includes("")) {
        expect(found.ok && found.anchor.span, `loose ${round}`).toEqual({ from, to });
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(80);
  });
});
