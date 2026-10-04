import { beforeAll, describe, expect, it } from "vitest";
import { indexedFixture, makeTempDir, writeFile, xpl, xplJson } from "./helpers.js";

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

  it("labels the repo with the name `xpl new` records, not the directory's", async () => {
    const { out } = await xpl(dir, "outline", "--depth", "1");
    // the fixture's package.json says ts-jobrunner; the temp directory it was copied to is called otherwise
    expect(out.split("\n")[0]).toMatch(/^repo {2}ts-jobrunner {2}12 files, \d+ symbols$/);
    const json = await xplJson<{ tree: Node & { label: string } }>(dir, "outline", "--depth", "0");
    expect(json.json.tree.label).toBe("ts-jobrunner");
    const named = await xpl(dir, "new", "labelled");
    expect(named.out).toContain("repo: ts-jobrunner (package.json)");
    // an explainer's `--repo` does not change what outline says: it is the same detection `new` runs
    const show = await xplJson<{ tree: Node & { label: string } }>(dir, "show", "repo");
    expect(show.json.tree.label).toBe("ts-jobrunner");
  });

  describe("--kind", () => {
    const symbols = (out: string) =>
      out
        .split("\n")
        .filter((l) => /^ *sym:/.test(l))
        .map((l) => l.trim().split(/ {2}/).slice(0, 2));

    it("lists only symbols of those kinds; what contains a match stays for context", async () => {
      const { code, out } = await xpl(
        dir,
        "outline",
        "--under",
        "file:src/runner.ts",
        "--kind",
        "method",
        "--depth",
        "3",
      );
      expect(code).toBe(0);
      expect(symbols(out)).toEqual([
        ["sym:src/runner.ts#Runner", "class"], // context: it holds methods
        ["sym:src/runner.ts#Runner.constructor", "method"],
        ["sym:src/runner.ts#Runner.start", "method"],
        ["sym:src/runner.ts#Runner.stop", "method"],
        ["sym:src/runner.ts#Runner.dispatch", "method"],
        ["sym:src/runner.ts#Runner.log", "method"],
        ["sym:src/runner.ts#RunnerStats", "class"],
        ["sym:src/runner.ts#RunnerStats.record", "method"],
      ]);
      // no properties, no top-level function, no type alias
      expect(out).not.toContain("Runner.queue");
      expect(out).not.toContain("backoffDelay");
      expect(out).not.toContain("#Logger");
      expect(out).toContain(
        "--kind method: only symbols of these kinds, plus the dirs, files and parent",
      );
      // without a filter they are all there
      expect(
        (await xpl(dir, "outline", "--under", "file:src/runner.ts", "--depth", "3")).out,
      ).toContain("backoffDelay");
    });

    it("takes several kinds, repeated or comma-separated, and finds them across the repo", async () => {
      const commas = await xplJson<{ kinds: string[]; tree: Node }>(
        dir,
        "outline",
        "--kind",
        "class,function",
        "--depth",
        "4",
      );
      const repeated = await xplJson<{ tree: Node }>(
        dir,
        "outline",
        "--kind",
        "class",
        "--kind",
        "function",
        "--depth",
        "4",
      );
      expect(commas.json.kinds).toEqual(["class", "function"]);
      expect(repeated.json.tree).toEqual(commas.json.tree);
      const kinds = new Set<string>();
      const walk = (node: Node) => {
        if (node.type === "symbol") kinds.add(node.kind);
        (node.children ?? []).forEach(walk);
      };
      walk(commas.json.tree);
      expect([...kinds].sort()).toEqual(["class", "function"]);
      // a class or function is where it is: under its dir and file
      expect(find(commas.json.tree, "sym:src/queue.ts#Queue")).toBeDefined();
      expect(find(commas.json.tree, "sym:src/config.ts#loadConfig")).toBeDefined();
      // directories and files without a match are not listed
      expect(find(commas.json.tree, "dir:config")).toBeUndefined();
      expect(find(commas.json.tree, "file:README.md")).toBeUndefined();
      expect(find(commas.json.tree, "file:src/runner.ts")).toBeDefined();
    });

    it("counts only what matches in [+n]", async () => {
      // depth 2 from the repo stops at the files: src/queue.ts holds one class and no other match
      const { out } = await xpl(dir, "outline", "--kind", "class", "--depth", "2");
      expect(out).toMatch(/^ {4}file:src\/queue\.ts {2}typescript {2}1-104 .* \[\+1\]$/m);
      expect(out).toMatch(/^ {4}file:src\/runner\.ts {2}typescript .* \[\+2\]$/m);
      expect(out).not.toContain("keys hidden");
    });

    it("kind key shows the config keys without --keys; no match says so", async () => {
      const keys = await xpl(
        dir,
        "outline",
        "--under",
        "file:config/default.yaml",
        "--kind",
        "key",
        "--depth",
        "2",
      );
      expect(keys.out).toContain("sym:config/default.yaml#retry  key");
      // the root is the match itself
      const itself = await xpl(
        dir,
        "outline",
        "--under",
        "sym:src/runner.ts#Runner.dispatch",
        "--kind",
        "method",
      );
      expect(itself.out.split("\n")[0]).toMatch(/^sym:src\/runner\.ts#Runner\.dispatch {2}method /);
      expect(itself.out).toContain("--kind method: only symbols of these kinds");
      expect(itself.out).not.toContain("no symbol of kind");
      const none = await xpl(dir, "outline", "--under", "file:README.md", "--kind", "class");
      expect(none.code).toBe(0);
      expect(none.out).toContain("no symbol of kind class under file:README.md");
    });

    it("an unknown kind is a usage error that lists the kinds", async () => {
      const { code, err } = await xpl(dir, "outline", "--kind", "meth");
      expect(code).toBe(2);
      expect(err).toContain(
        'unknown symbol kind "meth" (expected: class, interface, function, method, type, variable, enum, key, other)',
      );
      expect((await xpl(dir, "outline", "--help")).out).toContain("--kind <k,...>");
    });
  });

  it("an unknown id fails with core's suggestions", async () => {
    const { code, err } = await xpl(dir, "outline", "--under", "src/runner.ts#Runner.dispach");
    expect(code).toBe(1);
    expect(err).toContain('symbol "Runner.dispach" not found in src/runner.ts');
    expect(err).toContain("Did you mean: sym:src/runner.ts#Runner.dispatch?");
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

describe("xpl outline: recursion", () => {
  it("marks a symbol that calls itself, which the fan counts leave out", async () => {
    const dir = makeTempDir("xpl-outline-rec-");
    writeFile(
      dir,
      "a.ts",
      "export function fact(n: number): number { return n ? n * fact(n - 1) : 1; }\nexport function once(): number { return fact(3); }\n",
    );
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
    const { out } = await xpl(dir, "outline", "--under", "file:a.ts");
    expect(out).toContain("sym:a.ts#fact  function  1-1  in=1 out=0  recursive");
    expect(out).toMatch(/sym:a\.ts#once  function  2-2  in=0 out=1$/m);
    const { json } = await xplJson<{ tree: { children: { id: string; recursive?: boolean }[] } }>(
      dir,
      "outline",
      "--under",
      "file:a.ts",
    );
    expect(json.tree.children.map((c) => [c.id, c.recursive ?? false])).toEqual([
      ["sym:a.ts#fact", true],
      ["sym:a.ts#once", false],
    ]);
  });
});
