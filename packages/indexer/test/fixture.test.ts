/**
 * Integration test on the TS job-runner fixture (fixtures/ts-jobrunner), which reproduces the worked
 * example of docs/handoff.md exactly (ARCHITECTURE.md §8).
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Reference, SymbolIndex } from "@xpl/core";
import { buildIndex } from "../src/index.js";
import { describeFixtureInvariants } from "./helpers.js";

const fixture = resolve(import.meta.dirname, "../../../fixtures/ts-jobrunner");

let index: SymbolIndex;
let warnings: string[];

beforeAll(async () => {
  expect(existsSync(fixture), `fixture missing: ${fixture}`).toBe(true);
  ({ index, warnings } = await buildIndex({ root: fixture, precise: "off" }));
});

const sym = (id: string) => index.symbols.find((s) => s.id === id);
const refsFrom = (from: string, to: string, kind: Reference["kind"]) =>
  index.refs.filter((r) => r.from === from && r.to === to && r.kind === kind);

describe("ts-jobrunner: files and symbols", () => {
  it("indexes the repository without warnings", () => {
    expect(warnings).toEqual([]);
    const paths = index.files.map((f) => f.path);
    for (const expected of [
      "src/runner.ts",
      "src/queue.ts",
      "src/worker.ts",
      "src/metrics.ts",
      "src/bus.ts",
      "src/config.ts",
      "src/main.ts",
      "config/default.yaml",
      "test/retry.test.ts",
    ]) {
      expect(paths).toContain(expected);
    }
    expect(paths).toEqual([...paths].sort());
    expect(paths.every((p) => !p.startsWith(".explainer/") && !p.includes("node_modules"))).toBe(
      true,
    );
  });

  it("Runner.dispatch spans lines 42-88 (the handoff example)", () => {
    const dispatch = sym("src/runner.ts#Runner.dispatch")!;
    expect(dispatch).toBeDefined();
    expect(dispatch.kind).toBe("method");
    expect(dispatch.range).toEqual({ startLine: 42, endLine: 88 });
    expect(dispatch.parent).toBe("src/runner.ts#Runner");
    expect(dispatch.file).toBe("src/runner.ts");
    expect(dispatch.path).toBe("Runner.dispatch");
  });

  it("has the symbols the explainer anchors to", () => {
    for (const id of [
      "src/queue.ts#Queue.requeue",
      "src/queue.ts#Queue.pop",
      "src/worker.ts#Worker.run",
      "src/worker.ts#WorkerPool.lease",
      "src/metrics.ts#onJobCompleted",
      "src/runner.ts#Runner",
      "src/runner.ts#backoffDelay",
      "src/bus.ts#EventBus.emit",
    ]) {
      expect(sym(id), id).toBeDefined();
    }
    expect(sym("src/queue.ts#Queue")!.kind).toBe("class");
    expect(sym("src/queue.ts#Job")!.kind).toBe("interface");
    expect(sym("src/metrics.ts#onJobCompleted")!.kind).toBe("function");
    expect(sym("src/worker.ts#RunResult")!.kind).toBe("type");
  });

  it("config/default.yaml#retry spans lines 13-16 with its child keys", () => {
    const retry = sym("config/default.yaml#retry")!;
    expect(retry.kind).toBe("key");
    expect(retry.range).toEqual({ startLine: 13, endLine: 16 });
    const children = index.symbols.filter((s) => s.parent === retry.id);
    expect(children.map((s) => s.path)).toEqual([
      "retry.maxRetries",
      "retry.baseDelayMs",
      "retry.maxDelayMs",
    ]);
    expect(children.map((s) => s.range.startLine)).toEqual([14, 15, 16]);
  });
});

describe("ts-jobrunner: references from Runner.dispatch", () => {
  const dispatch = "src/runner.ts#Runner.dispatch";

  it("this.queue.pop() -> Queue.pop, site line 46", () => {
    const refs = refsFrom(dispatch, "src/queue.ts#Queue.pop", "call");
    expect(refs).toHaveLength(1);
    expect(refs[0]!.site.startLine).toBe(46);
    expect(refs[0]!.site.endLine).toBe(46);
    expect(refs[0]!.resolution).toBe("heuristic");
  });

  it("worker.run(...) -> Worker.run through `const worker = await this.pool.lease()`, site lines 60-61", () => {
    const refs = refsFrom(dispatch, "src/worker.ts#Worker.run", "call");
    expect(refs).toHaveLength(1);
    expect(refs[0]!.site.startLine).toBe(60);
    expect(refs[0]!.site.endLine).toBe(61);
    // the lease() call itself resolves through the field type WorkerPool
    expect(refsFrom(dispatch, "src/worker.ts#WorkerPool.lease", "call")).toHaveLength(1);
  });

  it("this.queue.requeue(...) -> Queue.requeue, site lines 76-78", () => {
    const refs = refsFrom(dispatch, "src/queue.ts#Queue.requeue", "call");
    expect(refs).toHaveLength(1);
    expect(refs[0]!.site.startLine).toBe(76);
    expect(refs[0]!.site.endLine).toBe(78);
  });

  it("also finds the other calls of the loop", () => {
    for (const to of [
      "src/queue.ts#Queue.ack",
      "src/queue.ts#Queue.deadLetter",
      "src/worker.ts#WorkerPool.release",
      "src/runner.ts#Runner.log",
      "src/runner.ts#RunnerStats.record",
      "src/runner.ts#backoffDelay",
    ]) {
      expect(refsFrom(dispatch, to, "call").length, to).toBeGreaterThan(0);
    }
  });
});

describe("ts-jobrunner: what the static index cannot see", () => {
  it("there is no reference from worker.ts to metrics.ts: the event bus hides it", () => {
    const worker = index.refs.filter((r) => r.from.startsWith("src/worker.ts#"));
    expect(worker.length).toBeGreaterThan(0);
    expect(worker.filter((r) => r.to.startsWith("src/metrics.ts#"))).toEqual([]);
    // the emit call is visible up to the bus
    expect(refsFrom("src/worker.ts#Worker.run", "src/bus.ts#EventBus.emit", "call")).toHaveLength(
      1,
    );
    // and metrics registers its handler on the bus from the other side
    expect(
      refsFrom("src/metrics.ts#registerMetrics", "src/bus.ts#EventBus.on", "call"),
    ).toHaveLength(1);
    expect(
      refsFrom("src/metrics.ts#registerMetrics", "src/metrics.ts#onJobCompleted", "call"),
    ).toHaveLength(1);
  });

  it("nothing calls onJobCompleted from outside metrics.ts", () => {
    const outside = index.refs.filter(
      (r) => r.to === "src/metrics.ts#onJobCompleted" && !r.from.startsWith("src/metrics.ts#"),
    );
    expect(outside).toEqual([]);
  });
});

describe("ts-jobrunner: imports, heritage and the test file", () => {
  it("import refs go from the module scope to the imported symbols", () => {
    expect(refsFrom("src/main.ts#", "src/runner.ts#Runner", "import")).toHaveLength(1);
    expect(refsFrom("src/main.ts#", "src/queue.ts#Queue", "import")).toHaveLength(1);
    expect(refsFrom("src/main.ts#", "src/worker.ts#WorkerPool", "import")).toHaveLength(1);
  });

  it("`import type` is a type reference, not an import: runner.ts only depends on queue.ts and worker.ts at compile time", () => {
    for (const to of ["src/queue.ts#Queue", "src/queue.ts#Job", "src/worker.ts#WorkerPool"]) {
      expect(refsFrom("src/runner.ts#", to, "type-ref"), to).toHaveLength(1);
      expect(refsFrom("src/runner.ts#", to, "import"), to).toHaveLength(0);
    }
    expect(index.refs.filter((r) => r.kind === "import" && r.from === "src/runner.ts#")).toEqual(
      [],
    );
  });

  it("the test's RecordingQueue extends Queue and calls super.requeue", () => {
    expect(
      refsFrom("test/retry.test.ts#RecordingQueue", "src/queue.ts#Queue", "extends"),
    ).toHaveLength(1);
    expect(
      refsFrom("test/retry.test.ts#RecordingQueue.requeue", "src/queue.ts#Queue.requeue", "call"),
    ).toHaveLength(1);
  });

  it("the demo wires everything: main() constructs and calls the pieces", () => {
    for (const to of [
      "src/queue.ts#Queue",
      "src/runner.ts#Runner",
      "src/worker.ts#Worker",
      "src/worker.ts#WorkerPool",
      "src/bus.ts#EventBus",
      "src/queue.ts#Queue.push",
      "src/runner.ts#Runner.start",
      "src/runner.ts#Runner.stop",
    ]) {
      expect(refsFrom("src/main.ts#main", to, "call").length, to).toBeGreaterThan(0);
    }
  });
});

describeFixtureInvariants(fixture, () => index);

describe("ts-jobrunner: languages", () => {
  it("summarises languages", () => {
    expect(index.languages.typescript).toMatchObject({ refs: "heuristic" });
    expect(index.languages.yaml).toMatchObject({ files: 1, refs: "none" });
    expect(index.languages.typescript!.files).toBeGreaterThanOrEqual(8);
    expect(index.tool).toContain("tree-sitter-typescript@");
  });
});
