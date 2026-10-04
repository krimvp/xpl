import { beforeAll, describe, expect, it } from "vitest";
import { indexedFixture, makeTempDir, writeFile, xpl, xplJson } from "./helpers.js";

let dir: string;
beforeAll(async () => {
  dir = await indexedFixture();
});

const DISPATCH = "sym:src/runner.ts#Runner.dispatch";
const REQUEUE = "sym:src/queue.ts#Queue.requeue";

describe("xpl refs", () => {
  it("lists what a symbol calls, one line per reference site, in source order", async () => {
    const { code, out } = await xpl(dir, "refs", DISPATCH);
    expect(code).toBe(0);
    const lines = out.split("\n");
    expect(lines[0]).toBe(`${DISPATCH} (method) src/runner.ts:42-88`);
    expect(lines[1]).toMatch(/^out \(\d+\):$/); // (how many depends on what the heuristic resolver sees)
    // Queue.requeue: lines 76-78, offsets 34..36 (what a call-site anchor's span uses)
    expect(out).toContain(`  call  ${REQUEUE}  (src/runner.ts:76-78, heuristic)  +34..36`);
    expect(out).toContain("  call  sym:src/queue.ts#Queue.pop  (src/runner.ts:46, heuristic)  +4");
    const sites = lines
      .slice(2)
      .filter((l) => l.startsWith("  "))
      .map((l) => Number(/src\/runner\.ts:(\d+)/.exec(l)![1]));
    expect(sites).toEqual([...sites].sort((a, b) => a - b));
  });

  it("--in lists the callers, with the site offset inside each caller", async () => {
    const { out } = await xpl(dir, "refs", REQUEUE, "--in");
    expect(out.split("\n")[0]).toBe(`${REQUEUE} (method) src/queue.ts:87-90`);
    expect(out).toContain(`  call  ${DISPATCH}  (src/runner.ts:76-78, heuristic)  +34..36`);
    expect(out).toContain("sym:test/retry.test.ts#RecordingQueue.requeue");
    expect(out).toMatch(/^in \(2\):$/m);
  });

  it("--in --out prints both directions", async () => {
    const { out } = await xpl(dir, "refs", "sym:src/runner.ts#Runner.log", "--in", "--out");
    expect(out).toMatch(/^out \(\d+\):$/m);
    expect(out).toMatch(/^in \(\d+\):$/m);
    expect(out).toContain(`sym:src/runner.ts#Runner.dispatch`);
  });

  it("--kind filters by reference kind (edge-kind spellings and lists work too)", async () => {
    const types = await xpl(dir, "refs", DISPATCH, "--kind", "type-ref");
    expect(types.out).toContain("type-ref  sym:src/worker.ts#RunResult");
    expect(types.out).not.toContain("call ");
    const some = await xplJson<{ out: { kind: string }[] }>(
      dir,
      "refs",
      DISPATCH,
      "--kind",
      "calls,writes",
    );
    expect(new Set(some.json.out.map((r) => r.kind))).toEqual(new Set(["call", "write"]));
    const repeated = await xplJson<{ out: { kind: string }[] }>(
      dir,
      "refs",
      DISPATCH,
      "--kind",
      "call",
      "--kind",
      "write",
    );
    expect(repeated.json.out).toHaveLength(some.json.out.length);
    const none = await xpl(dir, "refs", DISPATCH, "--kind", "extends");
    expect(none.out).toContain("out: none (kind extends)");
    const bad = await xpl(dir, "refs", DISPATCH, "--kind", "calls-to");
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('unknown reference kind "calls-to"');
  });

  it("--depth expands a call hierarchy once per element and marks repeats", async () => {
    const { out } = await xpl(dir, "refs", DISPATCH, "--depth", "2", "--kind", "call");
    const lines = out.split("\n");
    // Worker.run is expanded: its own calls follow, indented one level deeper
    const run = lines.findIndex((l) => l.includes("sym:src/worker.ts#Worker.run  "));
    expect(run).toBeGreaterThan(0);
    expect(lines[run + 1]).toMatch(/^ {4}call {2}sym:src\/worker\.ts#withTimeout /);
    // Runner.log is called three times; only the first is expanded
    const logs = lines.filter((l) => l.includes("sym:src/runner.ts#Runner.log  "));
    expect(logs).toHaveLength(3);
    expect(logs.filter((l) => l.includes("(expanded above)"))).toHaveLength(2);
  });

  it("marks cycles instead of looping", async () => {
    const { out, code } = await xpl(
      dir,
      "refs",
      "sym:src/runner.ts#Runner.start",
      "--depth",
      "4",
      "--kind",
      "call",
    );
    expect(code).toBe(0);
    expect(out.split("\n").length).toBeLessThan(200);
  });

  it("files and directories report the references that cross their boundary", async () => {
    const file = await xplJson<{ in: { id: string; from: string; to: string }[] }>(
      dir,
      "refs",
      "file:src/queue.ts",
      "--in",
      "--kind",
      "import",
    );
    expect(file.json.in.length).toBeGreaterThan(0);
    for (const ref of file.json.in) expect(ref.to.startsWith("sym:src/queue.ts#")).toBe(true);
    // references between files of the same directory are not crossing the directory
    const src = await xplJson<{ out: { id: string }[]; in: { from: string }[] }>(
      dir,
      "refs",
      "dir:src",
      "--out",
      "--in",
      "--limit",
      "0",
    );
    expect(src.json.out).toHaveLength(0);
    expect(
      src.json.in.every((r) => r.from.startsWith("sym:test/") || r.from.startsWith("file:test/")),
    ).toBe(true);
  });

  it("--limit cuts long trees and says so", async () => {
    const { out } = await xpl(dir, "refs", DISPATCH, "--limit", "3");
    expect(out.split("\n").filter((l) => /^ {2}\S/.test(l) && !l.includes("... cut"))).toHaveLength(
      3,
    );
    expect(out).toContain("... cut after 3 lines; use --limit 0");
    const all = await xpl(dir, "refs", DISPATCH, "--limit", "0");
    expect(all.out).not.toContain("cut after");
  });

  it("names the referencing symbol when the subject is a class or file, not for methods", async () => {
    const cls = await xpl(dir, "refs", "sym:src/runner.ts#Runner", "--kind", "type-ref");
    expect(cls.out).toContain(
      "  type-ref  sym:src/queue.ts#Queue  (src/runner.ts:14, heuristic)  +0 in sym:src/runner.ts#Runner.queue",
    );
    const file = await xpl(dir, "refs", "file:src/runner.ts", "--kind", "call");
    expect(file.out).toContain(
      `  call  ${REQUEUE}  (src/runner.ts:76-78, heuristic)  +34..36 in ${DISPATCH}`,
    );
    // a method is the referencing symbol itself, and for --in the printed id is the caller
    expect((await xpl(dir, "refs", DISPATCH)).out).not.toContain(" in sym:");
    expect((await xpl(dir, "refs", REQUEUE, "--in")).out).not.toContain(" in sym:");
  });

  it("says how many references there are when it cuts the list", async () => {
    const cut = await xpl(dir, "refs", DISPATCH, "--limit", "3");
    const json = await xplJson<{ totals: { out: number }; truncated: boolean }>(
      dir,
      "refs",
      DISPATCH,
      "--limit",
      "3",
    );
    const total = json.json.totals.out;
    expect(total).toBeGreaterThan(3);
    expect(cut.out).toContain(`out (${total}, first 3 shown):`);
    expect(json.json).toMatchObject({ truncated: true });
  });

  it("--json returns the tree with anchor-ready offsets", async () => {
    const { json } = await xplJson<any>(
      dir,
      "refs",
      DISPATCH,
      "--depth",
      "2",
      "--max-children",
      "0",
    );
    expect(json.id).toBe(DISPATCH);
    const requeue = json.out.find((r: any) => r.id === REQUEUE);
    expect(requeue).toMatchObject({
      kind: "call",
      from: DISPATCH,
      file: "src/runner.ts",
      site: { startLine: 76, endLine: 78 },
      offset: { from: 34, to: 36 },
      resolution: "heuristic",
    });
    expect(json.out.some((r: any) => Array.isArray(r.children))).toBe(true);
  });

  it("unknown ids are reported with suggestions", async () => {
    const { code, err } = await xpl(dir, "refs", "src/queue.ts#Queue.requeu");
    expect(code).toBe(1);
    expect(err).toContain("Did you mean: sym:src/queue.ts#Queue.requeue?");
  });
});

describe("xpl search", () => {
  it("finds text with the enclosing symbol and the line's offset inside it", async () => {
    const { code, out } = await xpl(dir, "search", "job.completed");
    expect(code).toBe(0);
    // Worker.run offset 21 is the job.completed emit
    expect(out).toContain(
      'src/worker.ts:51  sym:src/worker.ts#Worker.run +21  this.bus.emit("job.completed", {',
    );
    expect(out).toContain(
      "src/metrics.ts:23  sym:src/metrics.ts#registerMetrics +1  bus.on<JobCompleted>",
    );
    // hits outside every symbol name the file, offset = line - 1
    expect(out).toContain("README.md:15  file:README.md +14  ");
  });

  it("finds the requeue call at offset 34 of Runner.dispatch", async () => {
    const { out } = await xpl(dir, "search", "this.queue.requeue");
    expect(out).toBe(
      "src/runner.ts:76  sym:src/runner.ts#Runner.dispatch +34  await this.queue.requeue(",
    );
  });

  it("searches config files too, attributing hits to their key", async () => {
    const { out } = await xpl(dir, "search", "maxRetries:");
    expect(out).toContain(
      "config/default.yaml:14  sym:config/default.yaml#retry.maxRetries +0  maxRetries: 3",
    );
  });

  it("--regex and -i", async () => {
    const regex = await xpl(dir, "search", "requeue\\(job", "--regex");
    expect(regex.out).toContain("src/queue.ts:87  sym:src/queue.ts#Queue.requeue +0");
    expect(regex.out).not.toContain("this.queue.requeue(\n");
    const literal = await xpl(dir, "search", "requeue\\(job");
    expect(literal.out).toContain("no matches");
    const ci = await xpl(dir, "search", "QUEUE IS FULL", "-i");
    expect(ci.out).toContain("src/queue.ts:52");
    const cs = await xpl(dir, "search", "QUEUE IS FULL");
    expect(cs.out).toContain("no matches");
    const bad = await xpl(dir, "search", "(", "--regex");
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("invalid regular expression");
  });

  it("--limit shows the first hits and counts the rest", async () => {
    const { out } = await xpl(dir, "search", "queue", "--limit", "2", "-i");
    const lines = out.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toMatch(
      /^\.\.\. \d+ more matches \(showing 2 of \d+ in \d+ files\); raise --limit/,
    );
    const unlimited = await xpl(dir, "search", "queue", "--limit", "0", "-i");
    expect(unlimited.out.split("\n").length).toBeGreaterThan(20);
  });

  it("no match is not an error", async () => {
    const { code, out } = await xpl(dir, "search", "zzz-not-there");
    expect(code).toBe(0);
    expect(out).toBe('no matches for "zzz-not-there" in 12 indexed files');
  });

  it("--json returns hits as data", async () => {
    const { json } = await xplJson<any>(dir, "search", "job.completed", "--limit", "1");
    expect(json.total).toBeGreaterThan(1);
    expect(json.hits).toHaveLength(1);
    // code comes first: the first hit is in src/, not in the README
    expect(json.hits[0]).toMatchObject({
      file: "src/bus.ts",
      line: 1,
      id: "file:src/bus.ts",
      offset: 0,
    });
    expect(json.searched).toBe(12);
    const worker = (await xplJson<any>(dir, "search", 'emit("job.completed"')).json.hits[0];
    expect(worker).toMatchObject({
      file: "src/worker.ts",
      line: 51,
      id: "sym:src/worker.ts#Worker.run",
      offset: 21,
    });
  });

  it("lists code files before config and docs, so the first hits are the code", async () => {
    const { out } = await xpl(dir, "search", "retry", "-i", "--limit", "0");
    const files = [...new Set(out.split("\n").map((l) => l.split(":")[0]!))].filter((f) =>
      /\.(ts|yaml|md)$/.test(f),
    );
    const kind = (file: string) => (file.endsWith(".ts") ? 0 : file.endsWith(".yaml") ? 1 : 2);
    expect(files.map(kind)).toEqual([...files.map(kind)].sort());
    expect(files[0]).toMatch(/\.ts$/);
    expect(files.at(-1)).toBe("README.md");
    // with a limit, the code is what survives
    const two = await xpl(dir, "search", "retry", "-i", "--limit", "2");
    expect(two.out.split("\n")[0]).toMatch(/^src\//);
  });

  it("--code keeps only files in a code language (no README, no yaml)", async () => {
    const all = await xplJson<any>(dir, "search", "retry", "-i", "--limit", "0");
    const code = await xplJson<any>(dir, "search", "retry", "-i", "--limit", "0", "--code");
    const files = new Set(code.json.hits.map((h: any) => h.file));
    expect([...files].every((f: any) => /\.tsx?$/.test(f))).toBe(true);
    expect(all.json.hits.some((h: any) => h.file === "README.md")).toBe(true);
    expect(all.json.hits.some((h: any) => h.file === "config/default.yaml")).toBe(true);
    expect(code.json.total).toBeLessThan(all.json.total);
    expect(code.json).toMatchObject({ code: true });
    const none = await xpl(dir, "search", "A tiny job runner", "--code");
    expect(none.out).toBe(
      'no matches for "A tiny job runner" in 8 indexed files (code files only)',
    );
  });

  it("--under keeps the search in a dir, a file, a symbol or a glob (repeatable)", async () => {
    const files = async (...argv: string[]) => {
      const { json } = await xplJson<any>(dir, "search", "retry", "-i", "--limit", "0", ...argv);
      return [...new Set<string>(json.hits.map((h: any) => h.file))].sort();
    };
    const test = await files("--under", "test");
    expect(test).toEqual(["test/retry.test.ts"]);
    expect(await files("--under", "dir:test")).toEqual(test);
    expect(await files("--under", "test/")).toEqual(test);
    expect(await files("--under", "file:src/runner.ts")).toEqual(["src/runner.ts"]);
    expect(await files("--under", "*.md")).toEqual(["README.md"]);
    expect(await files("--under", "src/*.ts")).toEqual(
      (await files("--under", "dir:src")).filter((f) => /^src\/[^/]+\.ts$/.test(f)),
    );
    // several: repeated, or with commas
    expect(await files("--under", "test", "--under", "*.md")).toEqual([
      "README.md",
      "test/retry.test.ts",
    ]);
    expect(await files("--under", "test,*.md")).toEqual(["README.md", "test/retry.test.ts"]);
    // a symbol id keeps the search inside that symbol's lines
    const symbol = await xplJson<any>(
      dir,
      "search",
      "queue",
      "--limit",
      "0",
      "--under",
      "sym:src/runner.ts#Runner.dispatch",
    );
    expect(symbol.json.hits.length).toBeGreaterThan(0);
    for (const hit of symbol.json.hits) {
      expect(hit.file).toBe("src/runner.ts");
      expect(hit.line).toBeGreaterThanOrEqual(42);
      expect(hit.line).toBeLessThanOrEqual(88);
    }
    expect(symbol.json.under).toEqual(["sym:src/runner.ts#Runner.dispatch"]);
    // the total and the "more" line count inside the scope
    const scoped = await xpl(dir, "search", "retry", "-i", "--under", "test", "--limit", "1");
    expect(scoped.out).toMatch(/^\.\.\. \d+ more matches \(showing 1 of \d+ in 1 file\)/m);
    // combined with --code
    const both = await xpl(dir, "search", "retry", "-i", "--under", "*.md", "--code");
    expect(both.out).toBe(
      'no matches for "retry" in 0 indexed files (under *.md, code files only)',
    );
  });

  it("--under with an id the index does not know fails with suggestions", async () => {
    const { code, err } = await xpl(dir, "search", "retry", "--under", "tests");
    expect(code).toBe(1);
    expect(err).toContain('"tests" is not a file, directory or symbol in the index');
    expect(err).toContain("dir:test");
    const asJson = await xplJson<any>(dir, "search", "retry", "--under", "tests");
    expect(asJson.json).toMatchObject({ ok: false });
    expect(asJson.json.candidates).toContain("dir:test");
  });

  it("lists -i and the new options in its usage and help", async () => {
    const { out } = await xpl(dir, "search", "--help");
    expect(out).toContain(
      "Usage: xpl search <pattern> [--regex] [-i] [--limit n] [--under <dir|glob>] [--code]",
    );
    expect(out).toContain("-i, --ignore-case");
    expect(out).toContain("--under <dir|glob>");
    expect(out).toContain("--code");
  });

  it("an empty pattern is a usage error", async () => {
    const { code, err } = await xpl(dir, "search", "");
    expect(code).toBe(2);
    expect(err).toContain("pattern is empty");
  });
});

describe("xpl refs: recursion", () => {
  it("lists a symbol's own recursion, but not that of a function nested in it or in a file", async () => {
    const repo = makeTempDir("xpl-refs-rec-");
    writeFile(
      repo,
      "a.ts",
      [
        "export function outer(d: number): number {",
        "  function inner(x: number): number {",
        "    return x ? inner(x - 1) : 0;",
        "  }",
        "  return inner(d) + (d ? outer(d - 1) : 0);",
        "}",
        "",
      ].join("\n"),
    );
    expect((await xpl(repo, "index", "--precise", "off")).code).toBe(0);
    const calls = async (...args: string[]) =>
      (await xplJson<{ in?: { id: string }[]; out?: { id: string }[] }>(repo, "refs", ...args))
        .json;
    const ids = (list: { id: string }[] | undefined) => (list ?? []).map((r) => r.id);
    expect(ids((await calls("a.ts#outer", "--in")).in)).toEqual(["sym:a.ts#outer"]);
    expect(ids((await calls("a.ts#outer.inner", "--in")).in)).toEqual([
      "sym:a.ts#outer.inner",
      "sym:a.ts#outer",
    ]);
    expect(ids((await calls("file:a.ts", "--out", "--kind", "call")).out)).toEqual([]);
  });
});

describe("xpl refs: base classes", () => {
  it("lists the overrides under a call of a base method, and the base method's callers above an override", async () => {
    const repo = makeTempDir("xpl-refs-override-");
    writeFile(
      repo,
      "a.ts",
      [
        "export abstract class Node {",
        "  abstract visit(): number;",
        "  walk(): number {",
        "    return this.visit();",
        "  }",
        "}",
        "export class Leaf extends Node {",
        "  visit(): number {",
        "    return 1;",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    expect((await xpl(repo, "index", "--precise", "off")).code).toBe(0);
    const out = (await xpl(repo, "refs", "a.ts#Node.walk", "--out")).out;
    expect(out).toContain("  call  sym:a.ts#Node.visit  (a.ts:4, heuristic)  +1");
    expect(out).toContain("    override  sym:a.ts#Leaf.visit  (a.ts:8-10, heuristic)");
    const into = (await xpl(repo, "refs", "a.ts#Leaf.visit", "--in")).out;
    expect(into).toContain("in (0, plus 1 via base class):");
    expect(into).toContain(
      "  override  sym:a.ts#Node.visit  (a.ts:2, heuristic)  [the base method it overrides; its callers may run this one]",
    );
    expect(into).toContain("    call  sym:a.ts#Node.walk  (a.ts:4, heuristic)  +1");
  });
});
