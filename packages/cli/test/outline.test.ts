import { beforeAll, describe, expect, it } from "vitest";
import { indexedFixture, xpl, xplJson } from "./helpers.js";

let dir: string;
beforeAll(async () => {
  dir = await indexedFixture();
});

interface Node {
  id: string;
  type: string;
  kind: string;
  range?: { startLine: number; endLine: number };
  fanIn: number;
  fanOut: number;
  more?: number;
  hiddenKeys?: number;
  children?: Node[];
}

function find(node: Node, id: string): Node | undefined {
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const hit = find(child, id);
    if (hit) return hit;
  }
  return undefined;
}

describe("xpl outline", () => {
  it("prints dirs and files two levels below the repo by default", async () => {
    const { code, out } = await xpl(dir, "outline");
    expect(code).toBe(0);
    const lines = out.split("\n");
    expect(lines[0]).toMatch(/^repo {2}\S+ {2}12 files, \d+ symbols$/);
    expect(out).toMatch(/^ {2}dir:src {2}dir {2}7 files {2}in=\d+ out=\d+$/m);
    expect(out).toMatch(
      /^ {4}file:src\/runner\.ts {2}typescript {2}1-111 {2}in=\d+ out=\d+ {2}\[\+4\]$/m,
    );
    // depth 2 stops at files: symbols are not listed
    expect(out).not.toContain("sym:src/runner.ts#Runner");
    expect(out).toContain("[+n]: n children below the depth limit");
  });

  it("--under with --depth lists symbols with kind and line range", async () => {
    const { code, out } = await xpl(
      dir,
      "outline",
      "--under",
      "file:src/runner.ts",
      "--depth",
      "2",
    );
    expect(code).toBe(0);
    expect(out).toMatch(/^file:src\/runner\.ts {2}typescript {2}1-111 /);
    expect(out).toMatch(/^ {2}sym:src\/runner\.ts#Runner {2}class {2}12-93 /m);
    expect(out).toMatch(
      /^ {4}sym:src\/runner\.ts#Runner\.dispatch {2}method {2}42-88 {2}in=\d+ out=\d+$/m,
    );
    expect(out).toMatch(/^ {2}sym:src\/runner\.ts#backoffDelay {2}function {2}108-110 /m);
  });

  it("accepts loose ids (src/a.ts, src/a.ts#A.b, dir:src) for --under", async () => {
    const byPath = await xplJson<{ tree: Node }>(dir, "outline", "--under", "src/runner.ts");
    expect(byPath.json.tree.id).toBe("file:src/runner.ts");
    const bySymbol = await xplJson<{ tree: Node }>(
      dir,
      "outline",
      "--under",
      "src/runner.ts#Runner",
    );
    expect(bySymbol.json.tree.id).toBe("sym:src/runner.ts#Runner");
    expect(bySymbol.json.tree.children?.map((c) => c.id)).toContain(
      "sym:src/runner.ts#Runner.dispatch",
    );
    const byDir = await xplJson<{ tree: Node }>(dir, "outline", "--under", "src/", "--depth", "1");
    expect(byDir.json.tree.id).toBe("dir:src");
  });

  it("fan-in / fan-out count the references crossing the subtree boundary", async () => {
    const { json } = await xplJson<{ tree: Node }>(dir, "outline", "--depth", "4");
    const tree = json.tree;
    // main.ts wires everything together and nobody references it
    const main = find(tree, "file:src/main.ts")!;
    expect(main.fanIn).toBe(0);
    expect(main.fanOut).toBeGreaterThan(0);
    // queue.ts is used by others and uses nothing outside itself
    const queue = find(tree, "file:src/queue.ts")!;
    expect(queue.fanIn).toBeGreaterThan(0);
    expect(queue.fanOut).toBe(0);
    // the requeue method is called from Runner.dispatch and from the test's RecordingQueue
    expect(find(tree, "sym:src/queue.ts#Queue.requeue")!.fanIn).toBe(2);
    // directories: src is used by test/, and everything main.ts does stays inside src
    const src = find(tree, "dir:src")!;
    const test = find(tree, "dir:test")!;
    expect(src.fanIn).toBeGreaterThan(0);
    expect(src.fanOut).toBe(0);
    expect(test.fanOut).toBe(src.fanIn);
  });

  it("agrees with `xpl refs`: a class's fan-out is its outgoing references, internal ones excluded", async () => {
    const outline = await xplJson<{ tree: Node }>(
      dir,
      "outline",
      "--under",
      "sym:src/runner.ts#Runner",
    );
    const refs = await xplJson<{ out: unknown[]; in: unknown[] }>(
      dir,
      "refs",
      "sym:src/runner.ts#Runner",
      "--out",
      "--in",
      "--limit",
      "0",
    );
    expect(refs.json.out.length).toBe(outline.json.tree.fanOut);
    expect(refs.json.in.length).toBe(outline.json.tree.fanIn);
    // Runner.dispatch -> Runner.log stays inside the class: not among the class's outgoing refs
    expect((refs.json.out as { id: string }[]).map((r) => r.id)).not.toContain(
      "sym:src/runner.ts#Runner.log",
    );
  });

  it("hides config keys unless --keys is given", async () => {
    const hidden = await xpl(dir, "outline", "--under", "file:config/default.yaml", "--depth", "3");
    expect(hidden.out).toContain("[16 keys hidden]");
    expect(hidden.out).not.toContain("retry.maxRetries");
    expect(hidden.out).toContain("use --keys");

    const shown = await xpl(
      dir,
      "outline",
      "--under",
      "file:config/default.yaml",
      "--depth",
      "3",
      "--keys",
    );
    expect(shown.out).toMatch(/^ {2}sym:config\/default\.yaml#retry {2}key {2}13-16 /m);
    expect(shown.out).toMatch(/^ {4}sym:config\/default\.yaml#retry\.maxRetries {2}key {2}14-14 /m);
    expect(shown.out).not.toContain("keys hidden");
  });

  it("asking for a config key shows its children without --keys", async () => {
    const { out } = await xpl(dir, "outline", "--under", "config/default.yaml#retry");
    expect(out).toContain("sym:config/default.yaml#retry.maxRetries");
  });

  it("--depth 0 prints only the root; --json nests the tree", async () => {
    const zero = await xpl(dir, "outline", "--under", "dir:src", "--depth", "0");
    expect(
      zero.out.split("\n").filter((l) => l.startsWith("dir:src") || l.startsWith("file:")),
    ).toHaveLength(1);
    expect(zero.out).toContain("[+7]");

    const { json } = await xplJson<{ commit: string; depth: number; tree: Node }>(
      dir,
      "outline",
      "--under",
      "dir:src",
      "--depth",
      "3",
    );
    expect(json.depth).toBe(3);
    expect(json.commit).toMatch(/^wt-/);
    const runner = find(json.tree, "file:src/runner.ts")!;
    expect(runner).toMatchObject({
      type: "file",
      kind: "typescript",
      range: { startLine: 1, endLine: 111 },
    });
    const dispatch = find(json.tree, "sym:src/runner.ts#Runner.dispatch")!;
    expect(dispatch).toMatchObject({
      type: "symbol",
      kind: "method",
      range: { startLine: 42, endLine: 88 },
    });
  });

  it("--limit cuts the text output (not --json) and says how to see the rest", async () => {
    const { out } = await xpl(dir, "outline", "--depth", "3", "--limit", "5");
    const lines = out.split("\n");
    expect(lines.slice(0, 5).every((l) => /^ *(repo|dir:|file:|sym:)/.test(l))).toBe(true);
    expect(lines[5]).toMatch(/^\.\.\. \d+ more lines; narrow it with --under <id>/);
    const all = await xpl(dir, "outline", "--depth", "3", "--limit", "0");
    expect(all.out.split("\n").length).toBeGreaterThan(50);
    const json = await xplJson<{ tree: Node }>(dir, "outline", "--depth", "4", "--limit", "5");
    expect(find(json.json.tree, "sym:src/runner.ts#Runner.dispatch")).toBeDefined();
  });

  it("an unknown id fails with core's suggestions", async () => {
    const { code, err } = await xpl(dir, "outline", "--under", "src/runner.ts#Runner.dispach");
    expect(code).toBe(1);
    expect(err).toContain('symbol "Runner.dispach" not found in src/runner.ts');
    expect(err).toContain("Did you mean: src/runner.ts#Runner.dispatch?");
    const file = await xpl(dir, "outline", "--under", "runner.ts");
    expect(file.code).toBe(1);
    expect(file.err).toContain("Did you mean: file:src/runner.ts");
    const asJson = await xplJson<{ ok: boolean; candidates: string[] }>(
      dir,
      "outline",
      "--under",
      "runner.ts",
    );
    expect(asJson.json.ok).toBe(false);
    expect(asJson.json.candidates).toContain("file:src/runner.ts");
  });
});
