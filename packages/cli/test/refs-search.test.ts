import { beforeAll, describe, expect, it } from "vitest";
import { indexedFixture, xpl, xplJson } from "./helpers.js";

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
    expect(lines[1]).toBe("out (14):");
    // Queue.requeue: lines 76-78, offsets 34..36 (what a call-site anchor's span uses)
    expect(out).toContain(`  call  ${REQUEUE}  (src/runner.ts:76-78, heuristic)  +34..36`);
    expect(out).toContain("  call  sym:src/queue.ts#Queue.pop  (src/runner.ts:46, heuristic)  +4");
    const sites = lines.slice(2).map((l) => Number(/src\/runner\.ts:(\d+)/.exec(l)![1]));
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
    expect(cut.out).toContain("out (14, first 3 shown):");
    const json = await xplJson<{ totals: { out: number }; truncated: boolean }>(
      dir,
      "refs",
      DISPATCH,
      "--limit",
      "3",
    );
    expect(json.json).toMatchObject({ totals: { out: 14 }, truncated: true });
  });

  it("--json returns the tree with anchor-ready offsets", async () => {
    const { json } = await xplJson<any>(dir, "refs", DISPATCH, "--depth", "2");
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
    expect(err).toContain("Did you mean: src/queue.ts#Queue.requeue?");
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
    expect(json.hits[0]).toMatchObject({
      file: "README.md",
      line: 15,
      id: "file:README.md",
      offset: 14,
    });
    const worker = (await xplJson<any>(dir, "search", 'emit("job.completed"')).json.hits[0];
    expect(worker).toMatchObject({
      file: "src/worker.ts",
      line: 51,
      id: "sym:src/worker.ts#Worker.run",
      offset: 21,
    });
  });

  it("an empty pattern is a usage error", async () => {
    const { code, err } = await xpl(dir, "search", "");
    expect(code).toBe(2);
    expect(err).toContain("pattern is empty");
  });
});
