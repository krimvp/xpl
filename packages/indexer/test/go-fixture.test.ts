/**
 * Integration test on the Go job-runner fixture (fixtures/go-jobrunner): the same design as the TS fixture,
 * written the way Go is written (packages under internal/, implicit interfaces, an event bus).
 *
 * Line numbers are pinned by the fixture (its README says so); `nl -ba` the files to check them.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Reference, SymbolIndex } from "@xpl/core";
import { buildIndex } from "../src/index.js";
import { describeFixtureInvariants } from "./helpers.js";

const fixture = resolve(import.meta.dirname, "../../../fixtures/go-jobrunner");

let index: SymbolIndex;
let warnings: string[];

beforeAll(async () => {
  expect(existsSync(fixture), `fixture missing: ${fixture}`).toBe(true);
  ({ index, warnings } = await buildIndex({ root: fixture, precise: "off" }));
});

const sym = (id: string) => index.symbols.find((s) => s.id === id);
const refsFrom = (from: string, to: string, kind: Reference["kind"]) =>
  index.refs.filter((r) => r.from === from && r.to === to && r.kind === kind);

const RUNNER = "internal/runner/runner.go";
const QUEUE = "internal/queue/queue.go";
const DEAD = "internal/queue/deadletter.go";
const WORKER = "internal/worker/worker.go";
const POOL = "internal/worker/pool.go";
const BUS = "internal/bus/bus.go";
const METRICS = "internal/metrics/metrics.go";
const TEST = "internal/runner/retry_test.go";

describe("go-jobrunner: files and symbols", () => {
  it("indexes the repository without warnings", () => {
    expect(warnings).toEqual([]);
    const paths = index.files.map((f) => f.path);
    for (const expected of [
      "cmd/jobrunner/main.go",
      RUNNER,
      TEST,
      QUEUE,
      DEAD,
      WORKER,
      POOL,
      BUS,
      METRICS,
      "internal/config/config.go",
      "config/default.yaml",
      "go.mod",
    ]) {
      expect(paths).toContain(expected);
    }
    expect(paths).toEqual([...paths].sort());
    expect(paths.some((p) => p.startsWith(".explainer/"))).toBe(false);
    expect(index.languages.go).toMatchObject({ files: 10, refs: "heuristic" });
    expect(index.tool).toContain("tree-sitter-go@");
  });

  it("(*Runner).Dispatch spans lines 75-126 and is a child of Runner", () => {
    const dispatch = sym(`${RUNNER}#Runner.Dispatch`)!;
    expect(dispatch).toBeDefined();
    expect(dispatch.kind).toBe("method");
    expect(dispatch.path).toBe("Runner.Dispatch");
    expect(dispatch.file).toBe(RUNNER);
    expect(dispatch.range).toEqual({ startLine: 75, endLine: 126 }); // the doc comment (73-74) is excluded
    expect(dispatch.parent).toBe(`${RUNNER}#Runner`);
  });

  it("has the symbols the explainer anchors to, with their kinds and ranges", () => {
    const expected: Array<[string, string, number, number]> = [
      [`${RUNNER}#Runner`, "class", 57, 63],
      [`${RUNNER}#JobQueue`, "interface", 17, 22],
      [`${RUNNER}#JobQueue.Requeue`, "method", 19, 19],
      [`${RUNNER}#WorkerPool`, "interface", 25, 28],
      [`${RUNNER}#backoffDelay`, "function", 129, 135],
      [`${RUNNER}#New`, "function", 66, 71],
      [`${QUEUE}#Queue`, "class", 33, 41],
      [`${QUEUE}#Queue.Pop`, "method", 86, 108],
      [`${QUEUE}#Queue.Requeue`, "method", 112, 124],
      [`${QUEUE}#Job`, "class", 13, 21],
      [`${QUEUE}#ErrEmpty`, "variable", 25, 25],
      [`${DEAD}#Queue.DeadLetter`, "method", 16, 27],
      [`${DEAD}#DeadJob`, "class", 9, 13],
      [`${WORKER}#Worker.Run`, "method", 45, 85],
      [`${WORKER}#Handler`, "type", 14, 14],
      [`${WORKER}#Result.OK`, "method", 29, 29],
      [`${POOL}#Pool.Lease`, "method", 20, 27],
      [`${BUS}#Bus.Emit`, "method", 42, 50],
      [`${BUS}#Subscribe`, "function", 62, 68],
      [`${METRICS}#Metrics.OnJobCompleted`, "method", 29, 35],
      [`${METRICS}#Register`, "function", 38, 40],
      [`${TEST}#recordingQueue`, "class", 25, 32],
      [`${TEST}#TestFailsTwiceThenSucceedsIsAckedAfterTwoRequeues`, "function", 102, 123],
    ];
    for (const [id, kind, start, end] of expected) {
      const symbol = sym(id);
      expect(symbol, id).toBeDefined();
      expect([symbol!.kind, symbol!.range.startLine, symbol!.range.endLine], id).toEqual([
        kind,
        start,
        end,
      ]);
    }
  });

  it("a method declared in another file than its type is top-level in its file, with the same path", () => {
    const deadLetter = sym(`${DEAD}#Queue.DeadLetter`)!;
    expect(deadLetter.path).toBe("Queue.DeadLetter");
    expect(deadLetter.parent).toBeUndefined();
    expect(sym(`${DEAD}#Queue.Dead`)!.parent).toBeUndefined();
    expect(sym(`${QUEUE}#Queue.Pop`)!.parent).toBe(`${QUEUE}#Queue`);
    expect(sym(`${DEAD}#DeadJob.Err`)!.parent).toBe(`${DEAD}#DeadJob`);
  });

  it("counts of symbols by kind", () => {
    const counts: Record<string, number> = {};
    for (const s of index.symbols.filter((s) => s.file.endsWith(".go")))
      counts[s.kind] = (counts[s.kind] ?? 0) + 1;
    expect(counts).toEqual({
      function: 29,
      class: 20,
      variable: 73,
      type: 3,
      method: 31,
      interface: 2,
    });
  });

  it("config/default.yaml is indexed by its own pack next to the Go files", () => {
    expect(sym("config/default.yaml#retry")!.kind).toBe("key");
    expect(sym("config/default.yaml#retry")!.range).toEqual({ startLine: 13, endLine: 16 });
  });
});

describe("go-jobrunner: references from (*Runner).Dispatch", () => {
  const dispatch = `${RUNNER}#Runner.Dispatch`;

  it("r.queue.Pop() lands on the interface method JobQueue.Pop, site line 79", () => {
    const refs = refsFrom(dispatch, `${RUNNER}#JobQueue.Pop`, "call");
    expect(refs).toHaveLength(1);
    expect(refs[0]!.site.startLine).toBe(79);
    expect(refs[0]!.site.endLine).toBe(79);
    expect(refs[0]!.resolution).toBe("heuristic");
    // the field is typed by the interface: statically it is not *queue.Queue
    expect(refsFrom(dispatch, `${QUEUE}#Queue.Pop`, "call")).toEqual([]);
  });

  it("w.Run(...) -> Worker.Run through `w, err := r.pool.Lease(ctx)`, site line 97", () => {
    const refs = refsFrom(dispatch, `${WORKER}#Worker.Run`, "call");
    expect(refs).toHaveLength(1);
    expect(refs[0]!.site.startLine).toBe(97);
    // the lease itself resolves through the field type WorkerPool
    const lease = refsFrom(dispatch, `${RUNNER}#WorkerPool.Lease`, "call");
    expect(lease.map((r) => r.site.startLine)).toEqual([89]);
  });

  it("the retry block: Requeue at line 112 and DeadLetter at line 116, both through JobQueue", () => {
    const requeue = refsFrom(dispatch, `${RUNNER}#JobQueue.Requeue`, "call");
    expect(requeue.map((r) => r.site.startLine)).toEqual([112]);
    const deadLetter = refsFrom(dispatch, `${RUNNER}#JobQueue.DeadLetter`, "call");
    expect(deadLetter.map((r) => r.site.startLine)).toEqual([116]);
    expect(refsFrom(dispatch, `${DEAD}#Queue.DeadLetter`, "call")).toEqual([]);
    // both lie inside the retry block 108-121
    for (const ref of [...requeue, ...deadLetter]) {
      expect(ref.site.startLine).toBeGreaterThanOrEqual(108);
      expect(ref.site.endLine).toBeLessThanOrEqual(121);
    }
  });

  it("also finds the other calls, the composite literal and the write of the loop", () => {
    for (const to of [
      `${RUNNER}#JobQueue.Ack`,
      `${RUNNER}#WorkerPool.Release`,
      `${RUNNER}#Stats.record`,
      `${RUNNER}#Runner.logf`,
      `${RUNNER}#backoffDelay`,
      `${RUNNER}#sleep`,
      `${WORKER}#Result.OK`,
      `${WORKER}#Options`,
    ]) {
      expect(refsFrom(dispatch, to, "call").length, to).toBeGreaterThan(0);
    }
    expect(
      refsFrom(dispatch, `${RUNNER}#Stats.DeadLettered`, "write").map((r) => r.site.startLine),
    ).toEqual([119]);
    // calls into the standard library are not references
    const targets = index.refs.filter((r) => r.from === dispatch).map((r) => r.to.split("#")[0]);
    expect(targets.every((f) => f!.startsWith("internal/"))).toBe(true);
  });

  it("type-refs of the signature and the receiver", () => {
    expect(refsFrom(dispatch, `${RUNNER}#Runner`, "type-ref")).toHaveLength(1);
  });
});

describe("go-jobrunner: implicit interfaces", () => {
  it("*queue.Queue implements runner.JobQueue and *worker.Pool implements runner.WorkerPool", () => {
    const queue = refsFrom(`${QUEUE}#Queue`, `${RUNNER}#JobQueue`, "implements");
    expect(queue).toHaveLength(1);
    // the site is the type's declaration name: `type Queue struct {` on line 33
    expect(queue[0]!.site).toEqual({ startLine: 33, startCol: 6, endLine: 33, endCol: 10 });
    expect(queue[0]!.resolution).toBe("heuristic");
    const pool = refsFrom(`${POOL}#Pool`, `${RUNNER}#WorkerPool`, "implements");
    expect(pool).toHaveLength(1);
    expect(pool[0]!.site).toEqual({ startLine: 6, startCol: 6, endLine: 6, endCol: 9 });
  });

  it("the test's recordingQueue embeds *queue.Queue: it extends it and thereby implements JobQueue", () => {
    expect(refsFrom(`${TEST}#recordingQueue`, `${QUEUE}#Queue`, "extends")).toHaveLength(1);
    expect(refsFrom(`${TEST}#recordingQueue`, `${RUNNER}#JobQueue`, "implements")).toHaveLength(1);
    // Push is promoted from the embedded Queue
    expect(refsFrom(`${TEST}#runOne`, `${QUEUE}#Queue.Push`, "call").length).toBeGreaterThan(0);
    expect(
      refsFrom(`${TEST}#recordingQueue.Requeue`, `${QUEUE}#Queue.Requeue`, "call"),
    ).toHaveLength(1);
  });

  it("no other type implements anything", () => {
    const implemented = index.refs
      .filter((r) => r.kind === "implements")
      .map((r) => `${r.from} -> ${r.to}`);
    expect(implemented.sort()).toEqual([
      `${QUEUE}#Queue -> ${RUNNER}#JobQueue`,
      `${TEST}#recordingQueue -> ${RUNNER}#JobQueue`,
      `${POOL}#Pool -> ${RUNNER}#WorkerPool`,
    ]);
  });
});

describe("go-jobrunner: what the static index cannot see", () => {
  it("there is no reference from the worker package to metrics: the event bus hides it", () => {
    const worker = index.refs.filter(
      (r) => r.from.startsWith("internal/worker/") || r.from.startsWith("internal/worker#"),
    );
    expect(worker.length).toBeGreaterThan(0);
    expect(worker.filter((r) => r.to.startsWith(METRICS))).toEqual([]);
    // the emit call is visible up to the bus
    expect(refsFrom(`${WORKER}#Worker.Run`, `${BUS}#Bus.Emit`, "call")).toHaveLength(1);
    expect(refsFrom(`${WORKER}#Worker.Run`, `${BUS}#Bus.Emit`, "call")[0]!.site.startLine).toBe(83);
    // and metrics registers its handler on the bus from the other side
    expect(refsFrom(`${METRICS}#Register`, `${BUS}#Subscribe`, "call")).toHaveLength(1);
  });

  it("OnJobCompleted is passed to the bus as a method value: a read from Register", () => {
    const callers = index.refs.filter((r) => r.to === `${METRICS}#Metrics.OnJobCompleted`);
    expect(callers.map((r) => `${r.from} ${r.kind} ${r.site.startLine}`)).toEqual([
      `${METRICS}#Register read 39`,
    ]);
  });
});

describe("go-jobrunner: packages, imports and files of one package", () => {
  it("an import is a reference from the importing file to the main file of the package", () => {
    expect(refsFrom("cmd/jobrunner/main.go#", `${QUEUE}#`, "import")).toHaveLength(1);
    expect(refsFrom("cmd/jobrunner/main.go#", `${RUNNER}#`, "import")).toHaveLength(1);
    expect(refsFrom(`${RUNNER}#`, `${QUEUE}#`, "import")).toHaveLength(1);
    expect(refsFrom(`${RUNNER}#`, `${WORKER}#`, "import")).toHaveLength(1);
    expect(refsFrom(`${METRICS}#`, `${BUS}#`, "import")).toHaveLength(1);
    expect(refsFrom(`${TEST}#`, `${METRICS}#`, "import")).toHaveLength(1);
    // the worker never imports metrics (and vice versa)
    expect(
      index.refs.filter(
        (r) =>
          r.kind === "import" && r.from === `${WORKER}#` && r.to.startsWith("internal/metrics"),
      ),
    ).toEqual([]);
    expect(index.refs.filter((r) => r.kind === "import").length).toBe(17);
  });

  it("methods and helpers of the other files of a package resolve: deadletter.go <-> queue.go", () => {
    expect(refsFrom(`${DEAD}#Queue.DeadLetter`, `${QUEUE}#Queue.release`, "call")).toHaveLength(1);
    expect(refsFrom(`${DEAD}#Queue.DeadLetter`, `${QUEUE}#Job.Attempts`, "write")).toHaveLength(1);
    expect(refsFrom(`${DEAD}#Queue.DeadLetter`, `${QUEUE}#Queue.dead`, "write")).toHaveLength(1);
    expect(refsFrom(`${DEAD}#Queue.DeadLetter`, `${DEAD}#DeadJob`, "call")).toHaveLength(1);
    expect(refsFrom(`${QUEUE}#Queue.dead`, `${DEAD}#DeadJob`, "type-ref")).toHaveLength(1);
    expect(refsFrom(`${TEST}#newRecordingQueue`, `${QUEUE}#New`, "call")).toHaveLength(1);
    // runner_test.go (package runner) calls the constructor and the loop of runner.go
    expect(refsFrom(`${TEST}#runOne`, `${RUNNER}#New`, "call")).toHaveLength(1);
    expect(refsFrom(`${TEST}#runOne`, `${RUNNER}#Runner.Dispatch`, "call")).toHaveLength(1);
  });

  it("main wires the packages: constructors, the queue methods promoted through types, the loop", () => {
    const main = "cmd/jobrunner/main.go#run";
    for (const to of [
      `${QUEUE}#New`,
      `${RUNNER}#New`,
      `${WORKER}#New`,
      `${POOL}#NewPool`,
      `${BUS}#New`,
      `${METRICS}#New`,
      `${METRICS}#Register`,
      "internal/config/config.go#Load",
      `${QUEUE}#Queue.Push`,
      `${QUEUE}#Queue.Len`,
      `${QUEUE}#Queue.Acked`,
      `${DEAD}#Queue.Dead`,
      `${RUNNER}#Runner.Dispatch`,
      `${METRICS}#Metrics.Lines`,
    ]) {
      expect(refsFrom(main, to, "call").length, to).toBeGreaterThan(0);
    }
  });

  it("summary of the references by kind", () => {
    const counts: Record<string, number> = {};
    for (const r of index.refs) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
    expect(counts.implements).toBe(3);
    expect(counts.extends).toBe(1);
    expect(counts.import).toBe(17);
    expect(counts.call).toBeGreaterThan(90);
    expect(counts["type-ref"]).toBeGreaterThan(80);
    expect(counts.write).toBeGreaterThan(15);
  });
});

describeFixtureInvariants(fixture, () => index);
