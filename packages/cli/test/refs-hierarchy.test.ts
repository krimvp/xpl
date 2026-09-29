/**
 * `xpl refs --depth n` on a small made-up index: a subtree is printed once (and again, deeper, when the first
 * print stopped short of what a nearer occurrence needs), and `--max-children` caps every level.
 */
import { describe, expect, it } from "vitest";
import { INDEX_SCHEMA, IndexModel, type Reference, type SymbolIndex } from "@xpl/core";
import { buildRefTree, refTreeJson, renderRefTree } from "../src/ref-data.js";
import { resolveTarget } from "../src/target.js";
import { indexedFixture, xpl, xplJson } from "./helpers.js";

/** `names` are functions of a.ts, ten lines each; `calls` are `[caller, callee]` pairs, one line apart. */
function world(names: string[], calls: [string, string][]): IndexModel {
  const line = new Map<string, number>();
  names.forEach((name, i) => line.set(name, 1 + i * 10));
  const used = new Map<string, number>();
  const refs: Reference[] = calls.map(([from, to]) => {
    const n = (used.get(from) ?? 0) + 1;
    used.set(from, n);
    const at = line.get(from)! + Math.min(n, 8);
    return {
      from: `a.ts#${from}`,
      to: `a.ts#${to}`,
      kind: "call",
      site: { startLine: at, endLine: at },
      resolution: "precise",
    };
  });
  const index: SymbolIndex = {
    schema: INDEX_SCHEMA,
    commit: "c1",
    tool: "test",
    languages: {},
    files: [{ path: "a.ts", language: "typescript", hash: "h", lines: names.length * 10 }],
    symbols: names.map((name) => ({
      id: `a.ts#${name}`,
      file: "a.ts",
      path: name,
      kind: "function" as const,
      range: { startLine: line.get(name)!, endLine: line.get(name)! + 9 },
      hash: `h-${name}`,
    })),
    refs,
  };
  return new IndexModel(index);
}

const kindsCall = new Set<"call">(["call"]);

function print(
  model: IndexModel,
  start: string,
  opts: { depth: number; maxChildren?: number; limit?: number },
): string[] {
  const target = resolveTarget(model, `sym:a.ts#${start}`);
  const tree = buildRefTree(model, target, "out", {
    limit: 0,
    kinds: kindsCall,
    ...opts,
  });
  return renderRefTree(tree.nodes, "out", target.id, 1, tree.more);
}

const names = (lines: string[]) => lines.map((l) => /sym:a\.ts#(\w+)/.exec(l)?.[1] ?? l.trim());

describe("refs --depth: a subtree is printed once", () => {
  it("marks a repeat as expanded above instead of printing its subtree again", () => {
    // A calls B and B2; both call C; C calls D. C is expanded under B, where it is met first.
    const model = world(
      ["A", "B", "B2", "C", "D"],
      [
        ["A", "B"],
        ["A", "B2"],
        ["B", "C"],
        ["B2", "C"],
        ["C", "D"],
      ],
    );
    const lines = print(model, "A", { depth: 3 });
    expect(names(lines)).toEqual(["B", "C", "D", "B2", "C"]);
    expect(lines[4]).toMatch(/sym:a\.ts#C .*\(expanded above\)$/);
    expect(lines.filter((l) => l.includes("(expanded above)"))).toHaveLength(1);
  });

  it("expands it again, deeper, when the first print stopped short of what the nearer one needs", () => {
    // A calls B and C; B calls C; C calls D; D calls E. Depth 3: under B, C is met on the last levels and
    // shows D only; under A it is one level nearer and must show D -> E too
    const model = world(
      ["A", "B", "C", "D", "E"],
      [
        ["A", "B"],
        ["A", "C"],
        ["B", "C"],
        ["C", "D"],
        ["D", "E"],
      ],
    );
    const lines = print(model, "A", { depth: 3 });
    expect(names(lines)).toEqual(["B", "C", "D", "C", "D", "E"]);
    expect(lines.some((l) => l.includes("(expanded above)"))).toBe(false);
    // the other way round: the deeper print comes first, the later, shallower one is a repeat
    const first = world(
      ["A", "B", "C", "D", "E"],
      [
        ["A", "C"],
        ["A", "B"],
        ["B", "C"],
        ["C", "D"],
        ["D", "E"],
      ],
    );
    const again = print(first, "A", { depth: 3 });
    expect(names(again)).toEqual(["C", "D", "E", "B", "C"]);
    expect(again[4]).toMatch(/\(expanded above\)$/);
  });

  it("does not mark a repeat of an element that has nothing below it", () => {
    // B and C both call D, which calls nothing: no subtree was printed above, so there is nothing to point back to
    const model = world(
      ["A", "B", "C", "D"],
      [
        ["A", "B"],
        ["A", "C"],
        ["B", "D"],
        ["C", "D"],
      ],
    );
    const lines = print(model, "A", { depth: 3 });
    expect(names(lines)).toEqual(["B", "D", "C", "D"]);
    expect(lines.some((l) => l.includes("(expanded above)"))).toBe(false);
    // two calls of such a function from one place, on the first level a hierarchy expands
    const twice = world(
      ["A", "D"],
      [
        ["A", "D"],
        ["A", "D"],
      ],
    );
    const pair = print(twice, "A", { depth: 2 });
    expect(names(pair)).toEqual(["D", "D"]);
    expect(pair.some((l) => l.includes("(expanded above)"))).toBe(false);
  });

  it("marks a cycle, and never expands the subject again", () => {
    const model = world(
      ["A", "B"],
      [
        ["A", "B"],
        ["B", "A"],
      ],
    );
    const lines = print(model, "A", { depth: 4 });
    expect(names(lines)).toEqual(["B", "A"]);
    expect(lines[1]).toMatch(/\(cycle\)$/);
  });
});

describe("refs --max-children", () => {
  /** H calls G1..G20; G1 calls K1..K20. */
  const hub = () => {
    const calls: [string, string][] = [];
    const list = ["H"];
    for (let i = 1; i <= 20; i++) {
      list.push(`G${i}`);
      calls.push(["H", `G${i}`]);
    }
    for (let i = 1; i <= 20; i++) {
      list.push(`K${i}`);
      calls.push(["G1", `K${i}`]);
    }
    return world(list, calls);
  };

  it("caps every level of a hierarchy, root included, and says how many were left out", () => {
    const lines = print(hub(), "H", { depth: 2, maxChildren: 15 });
    const top = lines.filter((l) => /^ {2}\S/.test(l));
    expect(top.filter((l) => l.includes("call"))).toHaveLength(15);
    expect(top.at(-1)).toBe("  ... +5 more (--max-children 0 lists all)");
    // G1's own callees: 15 shown, 5 more
    const g1 = lines.findIndex((l) => l.includes("sym:a.ts#G1 "));
    expect(lines.slice(g1 + 1, g1 + 16).every((l) => l.startsWith("    call"))).toBe(true);
    expect(lines[g1 + 16]).toBe("    ... +5 more (--max-children 0 lists all)");
    expect(lines).toHaveLength(15 + 1 + 15 + 1);
  });

  it("does not cap a flat list (depth 1): only --limit cuts that", () => {
    const model = hub();
    const target = resolveTarget(model, "sym:a.ts#H");
    const tree = buildRefTree(model, target, "out", {
      depth: 1,
      limit: 0,
      kinds: kindsCall,
      maxChildren: 3,
    });
    expect(tree.nodes).toHaveLength(20);
    expect(tree.more).toBe(0);
    expect(renderRefTree(tree.nodes, "out", target.id).some((l) => l.includes("more"))).toBe(false);
  });

  it("0 (or no value) lists everything", () => {
    for (const maxChildren of [0, undefined]) {
      const lines = print(hub(), "H", { depth: 2, maxChildren });
      expect(lines.filter((l) => l.includes("call"))).toHaveLength(20 + 20);
      expect(lines.some((l) => l.includes("more"))).toBe(false);
    }
  });

  it("a cut list keeps the first ones, in source order, and counts the rest in the JSON tree", () => {
    const model = hub();
    const target = resolveTarget(model, "sym:a.ts#H");
    const tree = buildRefTree(model, target, "out", {
      depth: 2,
      limit: 0,
      kinds: kindsCall,
      maxChildren: 2,
    });
    expect(tree.total).toBe(20); // the subject's own count is not the cut one
    expect(tree.nodes.map((n) => n.entry.id)).toEqual(["sym:a.ts#G1", "sym:a.ts#G2"]);
    expect(tree.more).toBe(18);
    const json = refTreeJson(tree.nodes) as {
      id: string;
      moreChildren?: number;
      children?: unknown[];
    }[];
    expect(json[0]).toMatchObject({ id: "sym:a.ts#G1", moreChildren: 18 });
    expect(json[0]!.children).toHaveLength(2);
    expect(json[1]!.moreChildren).toBeUndefined(); // G2 calls nothing
  });

  it("the budget of --limit still applies, and a cut list does not hide the cut", () => {
    const model = hub();
    const target = resolveTarget(model, "sym:a.ts#H");
    const tree = buildRefTree(model, target, "out", {
      depth: 2,
      limit: 5,
      kinds: kindsCall,
      maxChildren: 15,
    });
    expect(tree.truncated).toBe(true);
  });
});

describe("xpl refs --max-children", () => {
  it("is in the usage and the help, defaults to 15, and reaches the output and the JSON", async () => {
    const dir = await indexedFixture();
    const DISPATCH = "sym:src/runner.ts#Runner.dispatch";
    const help = await xpl(dir, "refs", "--help");
    expect(help.out).toContain("[--max-children n]");
    expect(help.out).toContain("--max-children <n>");
    const capped = await xpl(
      dir,
      "refs",
      DISPATCH,
      "--depth",
      "2",
      "--kind",
      "call",
      "--max-children",
      "1",
    );
    const lines = capped.out.split("\n");
    expect(lines.filter((l) => /^ {2}call /.test(l))).toHaveLength(1);
    expect(
      lines.some((l) => /^ {2}\.\.\. \+\d+ more \(--max-children 0 lists all\)$/.test(l)),
    ).toBe(true);
    // the header still counts what there is
    expect(lines[1]).toMatch(/^out \((?!1\))\d+\):$/);
    const flat = await xpl(dir, "refs", DISPATCH, "--kind", "call", "--max-children", "1");
    expect(flat.out).not.toContain("more (--max-children");
    expect(flat.out.split("\n").filter((l) => /^ {2}call /.test(l)).length).toBeGreaterThan(3);
    const all = await xpl(
      dir,
      "refs",
      DISPATCH,
      "--depth",
      "2",
      "--kind",
      "call",
      "--max-children",
      "0",
    );
    expect(all.out).not.toContain("more (--max-children");
    const json = await xplJson<any>(
      dir,
      "refs",
      DISPATCH,
      "--depth",
      "2",
      "--kind",
      "call",
      "--max-children",
      "1",
    );
    expect(json.json.out).toHaveLength(1);
    expect(json.json.moreChildren.out).toBeGreaterThan(1);
    expect(json.json.totals.out).toBeGreaterThan(2);
    const bad = await xpl(dir, "refs", DISPATCH, "--max-children", "lots");
    expect(bad.code).toBe(2);
  });
});
