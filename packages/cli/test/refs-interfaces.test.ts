import { beforeAll, describe, expect, it } from "vitest";
import { indexedFixture, makeTempDir, writeFile, xpl, xplJson } from "./helpers.js";

/** `xpl refs` sees through interfaces: `impl` lines under calls of interface methods. */

const DISPATCH = "sym:internal/runner/runner.go#Runner.Dispatch";
const QUEUE_REQUEUE = "sym:internal/queue/queue.go#Queue.Requeue";

let go: string;
beforeAll(async () => {
  go = await indexedFixture("go-jobrunner");
});

describe("xpl refs --out: interfaces are transparent", () => {
  it("lists the implementations under a call of an interface method", async () => {
    const { code, out } = await xpl(go, "refs", DISPATCH, "--kind", "call");
    expect(code).toBe(0);
    const lines = out.split("\n");
    const at = lines.findIndex((l) =>
      l.includes("call  sym:internal/runner/runner.go#JobQueue.Requeue"),
    );
    expect(at).toBeGreaterThan(0);
    expect(lines[at]).toContain("(internal/runner/runner.go:112, heuristic)  +37");
    expect(lines[at + 1]).toBe(
      "    impl  sym:internal/queue/queue.go#Queue.Requeue  (internal/queue/queue.go:112-124, heuristic)",
    );
    // a method of the same type declared in another file of the package is found too
    expect(out).toContain(
      "    impl  sym:internal/queue/deadletter.go#Queue.DeadLetter  (internal/queue/deadletter.go:16-27, heuristic)",
    );
    // plain calls have no impl lines
    const logf = lines.findIndex((l) =>
      l.includes("call  sym:internal/runner/runner.go#Runner.logf"),
    );
    expect(lines[logf + 1]).not.toContain("impl");
  });

  it("leaves out test doubles and says how many; --tests lists them", async () => {
    const hidden = await xpl(go, "refs", DISPATCH, "--kind", "call");
    expect(hidden.out).not.toContain("recordingQueue");
    expect(hidden.out).toContain(
      "(3 implementations in test files left out: test doubles; --tests lists them)",
    );
    const shown = await xpl(go, "refs", DISPATCH, "--kind", "call", "--tests");
    expect(shown.out).toContain(
      "    impl  sym:internal/runner/retry_test.go#recordingQueue.Requeue  (internal/runner/retry_test.go:53-56, heuristic)",
    );
    expect(shown.out).not.toContain("left out");
    // production implementations come first, in file order
    const lines = shown.out.split("\n");
    const requeue = lines.findIndex((l) =>
      l.includes("call  sym:internal/runner/runner.go#JobQueue.Requeue"),
    );
    expect(lines[requeue + 1]).toContain("queue.go#Queue.Requeue");
    expect(lines[requeue + 2]).toContain("retry_test.go#recordingQueue.Requeue");
  });

  it("--depth expands the implementation in place of the bodiless declaration", async () => {
    const { out } = await xpl(go, "refs", DISPATCH, "--kind", "call", "--depth", "2");
    const lines = out.split("\n");
    const at = lines.findIndex((l) =>
      l.includes("impl  sym:internal/queue/queue.go#Queue.Requeue"),
    );
    expect(lines[at - 1]).toContain("call  sym:internal/runner/runner.go#JobQueue.Requeue");
    // Queue.Requeue's own calls, one level below the impl line
    expect(lines[at + 1]).toMatch(/^ {6}call {2}sym:internal\/queue\/queue\.go#Queue\.release /);
    // it costs no depth: a plain callee is expanded exactly as before
    expect(out).toContain("    call  sym:internal/bus/bus.go#Bus.Emit");
  });

  it("type uses of an interface list its implementations too", async () => {
    const { out } = await xpl(
      go,
      "refs",
      "sym:internal/runner/runner.go#Runner",
      "--kind",
      "type-ref",
    );
    const lines = out.split("\n");
    const at = lines.findIndex((l) =>
      l.includes("type-ref  sym:internal/runner/runner.go#JobQueue "),
    );
    expect(lines[at + 1]).toBe(
      "    impl  sym:internal/queue/queue.go#Queue  (internal/queue/queue.go:33-41, heuristic)",
    );
  });

  it("--json carries the impl entries, their children and the number of hidden test doubles", async () => {
    const { json } = await xplJson<any>(go, "refs", DISPATCH, "--kind", "call", "--depth", "2");
    const requeue = json.out.find(
      (r: any) => r.id === "sym:internal/runner/runner.go#JobQueue.Requeue",
    );
    expect(requeue.children).toHaveLength(1);
    expect(requeue.children[0]).toMatchObject({
      kind: "impl",
      id: QUEUE_REQUEUE,
      from: QUEUE_REQUEUE,
      to: "sym:internal/runner/runner.go#JobQueue.Requeue",
      file: "internal/queue/queue.go",
      site: { startLine: 112, endLine: 124 },
      resolution: "heuristic",
    });
    expect(requeue.children[0].children.length).toBeGreaterThan(0);
    expect(json.hiddenTestImplementations).toBe(3);
    expect(json.totals.out).toBe(15); // the hops are not references of the subject
    const withTests = await xplJson<any>(go, "refs", DISPATCH, "--kind", "call", "--tests");
    expect(withTests.json.hiddenTestImplementations).toBe(0);
  });
});

describe("xpl refs --in: an implementation shows the callers of the interface method", () => {
  it("adds the interface method as an impl line, with its callers below", async () => {
    const { code, out } = await xpl(go, "refs", QUEUE_REQUEUE, "--in");
    expect(code).toBe(0);
    expect(out).toContain("in (1, plus 1 via interface):");
    const lines = out.split("\n");
    const at = lines.findIndex((l) => l.startsWith("  impl  "));
    expect(lines[at]).toBe(
      "  impl  sym:internal/runner/runner.go#JobQueue.Requeue  (internal/runner/runner.go:19, heuristic)  [the interface member it implements; its callers follow]",
    );
    expect(lines[at + 1]).toBe(
      "    call  sym:internal/runner/runner.go#Runner.Dispatch  (internal/runner/runner.go:112, heuristic)  +37",
    );
    // the direct callers stay where they were
    expect(lines.slice(0, at).join("\n")).toContain("recordingQueue.Requeue");
  });

  it("works for a method that has no direct callers at all", async () => {
    const { out } = await xpl(go, "refs", "sym:internal/queue/queue.go#Queue.Pop", "--in");
    expect(out).toContain("in (0, plus 1 via interface):");
    expect(out).toContain("  impl  sym:internal/runner/runner.go#JobQueue.Pop");
    expect(out).toContain("    call  sym:internal/runner/runner.go#Runner.Dispatch");
    expect(out).not.toContain("in: none");
  });

  it("the other implementers are siblings, not callers: they stay out of the hop's list", async () => {
    const { json } = await xplJson<any>(go, "refs", QUEUE_REQUEUE, "--in");
    const hop = json.in.find((r: any) => r.kind === "impl");
    expect(hop.children.map((c: any) => c.kind)).toEqual(["call"]);
    expect(json.totals.in).toBe(1);
  });

  it("leaves everything else as it was", async () => {
    // an interface method has no interface above it; a plain function neither
    const iface = await xpl(go, "refs", "sym:internal/runner/runner.go#JobQueue.Requeue", "--in");
    expect(iface.out).not.toContain("impl");
    const plain = await xpl(go, "refs", "sym:internal/runner/runner.go#backoffDelay", "--in");
    expect(plain.out).not.toContain("impl");
  });
});

describe("TypeScript: implements clauses", () => {
  let dir: string;
  beforeAll(async () => {
    dir = makeTempDir("xpl-iface-");
    writeFile(
      dir,
      "src/store.ts",
      [
        "export interface Store {",
        "  get(key: string): number;",
        "  put(key: string, value: number): void;",
        "}",
        "",
        "export class MemStore implements Store {",
        "  private data = new Map<string, number>();",
        "  get(key: string): number {",
        "    return this.data.get(key) ?? 0;",
        "  }",
        "  put(key: string, value: number): void {",
        "    this.data.set(key, value);",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    writeFile(
      dir,
      "src/use.ts",
      [
        'import type { Store } from "./store.js";',
        "",
        "export function use(store: Store): number {",
        '  store.put("a", 1);',
        '  const a = store.get("a");',
        '  const b = store.get("b");',
        "  return a + b;",
        "}",
        "",
      ].join("\n"),
    );
    writeFile(
      dir,
      "test/fake.test.ts",
      [
        'import type { Store } from "../src/store.js";',
        "",
        "export class FakeStore implements Store {",
        "  get(key: string): number {",
        "    return 1;",
        "  }",
        "  put(key: string, value: number): void {}",
        "}",
        "",
      ].join("\n"),
    );
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
  });

  it("lists implementations once: later calls of the same interface method say (expanded above)", async () => {
    const { out } = await xpl(dir, "refs", "src/use.ts#use", "--kind", "call");
    expect(out.split("\n")).toEqual([
      "sym:src/use.ts#use (function) src/use.ts:3-8",
      "out (3):",
      "  call  sym:src/store.ts#Store.put  (src/use.ts:4, heuristic)  +1",
      "    impl  sym:src/store.ts#MemStore.put  (src/store.ts:11-13, heuristic)",
      "  call  sym:src/store.ts#Store.get  (src/use.ts:5, heuristic)  +2",
      "    impl  sym:src/store.ts#MemStore.get  (src/store.ts:8-10, heuristic)",
      "  call  sym:src/store.ts#Store.get  (src/use.ts:6, heuristic)  +3  (expanded above)",
      "(2 implementations in test files left out: test doubles; --tests lists them)",
    ]);
  });

  it("--in from a class member and the JSON note for the repeated call", async () => {
    const { json } = await xplJson<any>(dir, "refs", "src/use.ts#use", "--kind", "call", "--tests");
    const gets = json.out.filter((r: any) => r.id === "sym:src/store.ts#Store.get");
    expect(gets[0].children.map((c: any) => c.id)).toEqual([
      "sym:src/store.ts#MemStore.get",
      "sym:test/fake.test.ts#FakeStore.get",
    ]);
    expect(gets[1]).toMatchObject({ note: "seen" });
    expect(gets[1].children).toBeUndefined();
    const inbound = await xpl(dir, "refs", "src/store.ts#MemStore.get", "--in");
    expect(inbound.out).toContain("in (0, plus 1 via interface):");
    expect(inbound.out).toContain("    call  sym:src/use.ts#use  (src/use.ts:6, heuristic)  +3");
  });

  it("shows the test doubles when the call itself is in a test file", async () => {
    writeFile(
      dir,
      "test/use.test.ts",
      [
        'import type { Store } from "../src/store.js";',
        "",
        "export function readIt(store: Store): number {",
        '  return store.get("a");',
        "}",
        "",
      ].join("\n"),
    );
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
    const { out } = await xpl(dir, "refs", "test/use.test.ts#readIt", "--kind", "call");
    // no --tests: the caller is a test, so FakeStore is relevant
    expect(out).toContain("    impl  sym:test/fake.test.ts#FakeStore.get");
    expect(out).toContain("    impl  sym:src/store.ts#MemStore.get");
    expect(out).not.toContain("left out");
    // production code still does not see it
    const prod = await xpl(dir, "refs", "src/use.ts#use", "--kind", "call");
    expect(prod.out).not.toContain("FakeStore");
  });

  it("cuts a long list of implementations, and --limit 0 lists them all", async () => {
    const wide = makeTempDir("xpl-iface-wide-");
    const impls = Array.from({ length: 12 }, (_, i) => `Impl${String(i).padStart(2, "0")}`);
    writeFile(wide, "src/shape.ts", "export interface Shape {\n  area(): number;\n}\n");
    writeFile(
      wide,
      "src/impls.ts",
      [
        'import type { Shape } from "./shape.js";',
        ...impls.flatMap((name) => [
          `export class ${name} implements Shape {`,
          "  area(): number {",
          "    return 1;",
          "  }",
          "}",
        ]),
        "",
      ].join("\n"),
    );
    writeFile(
      wide,
      "src/main.ts",
      'import type { Shape } from "./shape.js";\nexport function total(s: Shape): number {\n  return s.area();\n}\n',
    );
    expect((await xpl(wide, "index", "--precise", "off")).code).toBe(0);
    const cut = await xpl(wide, "refs", "src/main.ts#total", "--kind", "call");
    expect(cut.out.split("\n").filter((l) => l.includes("impl  "))).toHaveLength(10);
    expect(cut.out).toContain("    ... 2 more implementations (--limit 0 lists them all)");
    const all = await xpl(wide, "refs", "src/main.ts#total", "--kind", "call", "--limit", "0");
    expect(all.out.split("\n").filter((l) => l.includes("impl  "))).toHaveLength(12);
    expect(all.out).not.toContain("more implementations");
    const { json } = await xplJson<any>(wide, "refs", "src/main.ts#total", "--kind", "call");
    expect(json.out[0].moreImpls).toBe(2);
  });
});

describe("languages without implements references are unaffected", () => {
  it("Python fixture: no impl lines; the test subclasses that override a callee are counted, not listed", async () => {
    const py = await indexedFixture("py-jobrunner");
    const { out } = await xpl(py, "refs", "jobrunner/runner.py#Runner.dispatch", "--kind", "call");
    expect(out).not.toMatch(/^\s+(impl|override) /m);
    expect(out).not.toContain("implementations in test files");
    expect(out).toMatch(
      /^\(\d+ overrides? in test files left out: test subclasses; --tests lists them\)$/m,
    );
  });
});
