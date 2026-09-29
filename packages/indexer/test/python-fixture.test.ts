/**
 * Integration test on the Python job-runner fixture (fixtures/py-jobrunner): the same design as the TS
 * fixture of the handoff example, written idiomatically in Python (ARCHITECTURE.md §8).
 */
import { cpSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Reference, SymbolIndex } from "@xpl/core";
import { buildIndex } from "../src/index.js";
import { makeDir } from "./helpers.js";

const fixture = resolve(import.meta.dirname, "../../../fixtures/py-jobrunner");

let index: SymbolIndex;
let warnings: string[];

beforeAll(async () => {
  expect(existsSync(fixture), `fixture missing: ${fixture}`).toBe(true);
  ({ index, warnings } = await buildIndex({ root: fixture, precise: "off" }));
});

const sym = (id: string) => index.symbols.find((s) => s.id === id);
const refsFrom = (from: string, to: string, kind: Reference["kind"]) =>
  index.refs.filter((r) => r.from === from && r.to === to && r.kind === kind);
const count = <T>(xs: T[], key: (x: T) => string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const x of xs) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return out;
};

describe("py-jobrunner: files and symbols", () => {
  it("indexes the repository without warnings", () => {
    expect(warnings).toEqual([]);
    const paths = index.files.map((f) => f.path);
    for (const expected of [
      "jobrunner/__init__.py",
      "jobrunner/__main__.py",
      "jobrunner/bus.py",
      "jobrunner/config.py",
      "jobrunner/metrics.py",
      "jobrunner/queue.py",
      "jobrunner/runner.py",
      "jobrunner/worker.py",
      "tests/test_retry.py",
      "config/default.yaml",
    ]) {
      expect(paths).toContain(expected);
    }
    expect(paths).toEqual([...paths].sort());
    expect(index.languages.python).toMatchObject({ files: 9, symbols: 128, refs: "heuristic" });
    expect(index.languages.python!.tool).toContain("tree-sitter-python@");
  });

  it("Runner.dispatch spans lines 61-96", () => {
    const dispatch = sym("jobrunner/runner.py#Runner.dispatch")!;
    expect(dispatch).toBeDefined();
    expect(dispatch.kind).toBe("method");
    expect(dispatch.range).toEqual({ startLine: 61, endLine: 96 });
    expect(dispatch.parent).toBe("jobrunner/runner.py#Runner");
    expect(dispatch.path).toBe("Runner.dispatch");
  });

  it("has the symbols the explainer anchors to, with their exact ranges", () => {
    const expected: Array<[id: string, kind: string, start: number, end: number]> = [
      ["jobrunner/queue.py#Queue", "class", 32, 90],
      ["jobrunner/queue.py#Queue.pop", "method", 58, 70],
      ["jobrunner/queue.py#Queue.requeue", "method", 72, 79],
      ["jobrunner/queue.py#Queue.dead_letter", "method", 86, 90],
      ["jobrunner/queue.py#Queue.size", "method", 44, 47], // starts at its @property decorator
      ["jobrunner/queue.py#Job", "class", 10, 20], // starts at @dataclass
      ["jobrunner/queue.py#Job.priority", "variable", 17, 17],
      ["jobrunner/worker.py#Worker", "class", 34, 64],
      ["jobrunner/worker.py#Worker.run", "method", 41, 64],
      ["jobrunner/worker.py#WorkerPool.lease", "method", 79, 82],
      ["jobrunner/worker.py#Handler", "variable", 16, 16],
      ["jobrunner/runner.py#Runner", "class", 35, 99],
      ["jobrunner/runner.py#backoff_delay", "function", 17, 19],
      ["jobrunner/runner.py#RunnerStats.dead_lettered", "variable", 27, 27],
      ["jobrunner/bus.py#EventBus.emit", "method", 35, 41],
      ["jobrunner/metrics.py#on_job_completed", "function", 18, 22],
      ["jobrunner/metrics.py#register_metrics", "function", 25, 27],
      ["jobrunner/config.py#RunnerConfig.from_config", "method", 61, 64], // @classmethod
      ["jobrunner/config.py#load_config.text", "function", 113, 114], // nested def
      ["jobrunner/__main__.py#demo_handlers.flaky", "function", 27, 32],
      ["tests/test_retry.py#RecordingQueue.requeue", "method", 28, 30],
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

  it('the `if __name__ == "__main__"` block of __main__.py has no symbols', () => {
    const main = index.symbols.filter((s) => s.file === "jobrunner/__main__.py").map((s) => s.path);
    expect(main).toEqual([
      "DEFAULT_CONFIG",
      "demo_handlers",
      "demo_handlers.echo",
      "demo_handlers.flaky",
      "demo_handlers.broken",
      "run",
      "main",
    ]);
  });

  it("config/default.yaml#retry spans lines 13-16 (the retry policy the runner reads)", () => {
    const retry = sym("config/default.yaml#retry")!;
    expect(retry.kind).toBe("key");
    expect(retry.range).toEqual({ startLine: 13, endLine: 16 });
  });

  it("counts of symbols by kind and file (a regression net for the pack)", () => {
    const py = index.symbols.filter((s) => /\.py$/.test(s.file));
    expect(count(py, (s) => s.kind)).toEqual({ variable: 54, function: 19, class: 23, method: 32 });
    expect(count(py, (s) => s.file)).toEqual({
      "jobrunner/__init__.py": 1,
      "jobrunner/__main__.py": 7,
      "jobrunner/bus.py": 10,
      "jobrunner/config.py": 36,
      "jobrunner/metrics.py": 8,
      "jobrunner/queue.py": 20,
      "jobrunner/runner.py": 13,
      "jobrunner/worker.py": 16,
      "tests/test_retry.py": 17,
    });
  });

  it("every symbol's range lies inside its file, ids follow the path, parents exist", () => {
    for (const symbol of index.symbols) {
      const file = index.files.find((f) => f.path === symbol.file)!;
      expect(symbol.range.startLine).toBeGreaterThanOrEqual(1);
      expect(symbol.range.endLine).toBeLessThanOrEqual(file.lines);
      expect(symbol.range.endLine).toBeGreaterThanOrEqual(symbol.range.startLine);
      expect(symbol.id).toBe(`${symbol.file}#${symbol.path}`);
      if (symbol.parent) expect(sym(symbol.parent), symbol.parent).toBeDefined();
    }
  });
});

describe("py-jobrunner: references from Runner.dispatch", () => {
  const dispatch = "jobrunner/runner.py#Runner.dispatch";

  it("self._queue.pop() -> Queue.pop, site line 65", () => {
    const refs = refsFrom(dispatch, "jobrunner/queue.py#Queue.pop", "call");
    expect(refs).toHaveLength(1);
    expect([refs[0]!.site.startLine, refs[0]!.site.endLine]).toEqual([65, 65]);
    expect(refs[0]!.resolution).toBe("heuristic");
  });

  it("worker.run(...) -> Worker.run through `worker = await self._pool.lease()`, site line 77", () => {
    const refs = refsFrom(dispatch, "jobrunner/worker.py#Worker.run", "call");
    expect(refs).toHaveLength(1);
    expect([refs[0]!.site.startLine, refs[0]!.site.endLine]).toEqual([77, 77]);
    // the lease() call itself resolves through the annotated field `_pool: WorkerPool`
    const lease = refsFrom(dispatch, "jobrunner/worker.py#WorkerPool.lease", "call");
    expect(lease.map((r) => r.site.startLine)).toEqual([71]);
    // and so does the options object built on the same line
    expect(refsFrom(dispatch, "jobrunner/worker.py#RunOptions", "call")).toHaveLength(1);
  });

  it("self._queue.requeue(...) -> Queue.requeue (line 90) and dead_letter (line 92), inside the retry block 86-94", () => {
    const requeue = refsFrom(dispatch, "jobrunner/queue.py#Queue.requeue", "call");
    expect(requeue.map((r) => [r.site.startLine, r.site.endLine])).toEqual([[90, 90]]);
    const deadLetter = refsFrom(dispatch, "jobrunner/queue.py#Queue.dead_letter", "call");
    expect(deadLetter.map((r) => [r.site.startLine, r.site.endLine])).toEqual([[92, 92]]);
    for (const ref of [...requeue, ...deadLetter]) {
      expect(ref.site.startLine).toBeGreaterThanOrEqual(86);
      expect(ref.site.endLine).toBeLessThanOrEqual(94);
    }
  });

  it("also finds the other calls of the loop and the counter it writes", () => {
    const expected: Array<[to: string, kind: Reference["kind"], lines: number[]]> = [
      ["jobrunner/queue.py#Queue.ack", "call", [83]],
      ["jobrunner/worker.py#WorkerPool.release", "call", [79]],
      ["jobrunner/runner.py#Runner._log", "call", [74, 94, 96]],
      ["jobrunner/runner.py#RunnerStats.record", "call", [80]],
      ["jobrunner/runner.py#backoff_delay", "call", [89]],
      ["jobrunner/runner.py#RunnerStats.dead_lettered", "write", [93]],
    ];
    for (const [to, kind, lines] of expected) {
      expect(
        refsFrom(dispatch, to, kind).map((r) => r.site.startLine),
        to,
      ).toEqual(lines);
    }
  });

  it("references nothing else: the whole of dispatch is these 25 references (13 calls, 11 reads, 1 write)", () => {
    const from = index.refs.filter((r) => r.from === dispatch);
    expect(count(from, (r) => r.kind)).toEqual({ call: 13, read: 11, write: 1 });
    expect(from).toHaveLength(25);
  });

  it("reads: the fields of the job, the result and the configuration; instance attributes are not symbols", () => {
    const reads = index.refs.filter((r) => r.from === dispatch && r.kind === "read");
    expect(reads.map((r) => r.to.slice(r.to.indexOf("#") + 1)).sort()).toEqual([
      "Job.attempts",
      "Job.attempts",
      "Job.id",
      "Job.id",
      "RetryConfig.max_retries",
      "RunResult.error",
      "RunResult.ok",
      "RunnerConfig.idle_delay_ms",
      "RunnerConfig.retry",
      "RunnerConfig.retry",
      "RunnerConfig.timeout_ms",
    ]);
  });
});

describe("py-jobrunner: what the static index cannot see", () => {
  it("there is no reference from worker.py to metrics.py: the event bus hides it", () => {
    const worker = index.refs.filter((r) => r.from.startsWith("jobrunner/worker.py#"));
    expect(worker.length).toBeGreaterThan(0);
    expect(worker.filter((r) => r.to.startsWith("jobrunner/metrics.py#"))).toEqual([]);
    // the emit call is visible up to the bus
    const emit = refsFrom(
      "jobrunner/worker.py#Worker.run",
      "jobrunner/bus.py#EventBus.emit",
      "call",
    );
    expect(emit.map((r) => r.site.startLine)).toEqual([63]);
    // and metrics registers its handler on the bus from the other side
    expect(
      refsFrom("jobrunner/metrics.py#register_metrics", "jobrunner/bus.py#EventBus.on", "call"),
    ).toHaveLength(1);
    expect(
      refsFrom(
        "jobrunner/metrics.py#register_metrics",
        "jobrunner/metrics.py#on_job_completed",
        "call",
      ),
    ).toHaveLength(1); // the call inside the lambda
  });

  it("nothing calls on_job_completed from outside metrics.py", () => {
    const outside = index.refs.filter(
      (r) =>
        r.to === "jobrunner/metrics.py#on_job_completed" &&
        !r.from.startsWith("jobrunner/metrics.py#"),
    );
    expect(outside).toEqual([]);
  });
});

describe("py-jobrunner: imports, heritage, the demo and the tests", () => {
  it("import refs go from the module scope to the imported symbols (relative imports resolved)", () => {
    expect(refsFrom("jobrunner/runner.py#", "jobrunner/queue.py#Queue", "import")).toHaveLength(1);
    expect(
      refsFrom("jobrunner/runner.py#", "jobrunner/worker.py#WorkerPool", "import"),
    ).toHaveLength(1);
    expect(
      refsFrom("jobrunner/runner.py#", "jobrunner/config.py#RetryConfig", "import"),
    ).toHaveLength(1);
    expect(refsFrom("jobrunner/__main__.py#", "jobrunner/runner.py#Runner", "import")).toHaveLength(
      1,
    );
    // the package re-exports, and imports from the package's absolute dotted name work too
    expect(refsFrom("jobrunner/__init__.py#", "jobrunner/queue.py#Queue", "import")).toHaveLength(
      1,
    );
    expect(
      refsFrom("tests/test_retry.py#", "jobrunner/runner.py#backoff_delay", "import"),
    ).toHaveLength(1);
    // only the six in-repo names are imported references; asyncio, time, collections, dataclasses are not
    expect(
      index.refs.filter((r) => r.from === "jobrunner/runner.py#" && r.kind === "import"),
    ).toHaveLength(6);
  });

  it("the test's RecordingQueue extends Queue and calls super().requeue / super().__init__", () => {
    expect(
      refsFrom("tests/test_retry.py#RecordingQueue", "jobrunner/queue.py#Queue", "extends"),
    ).toHaveLength(1);
    expect(
      refsFrom(
        "tests/test_retry.py#RecordingQueue.requeue",
        "jobrunner/queue.py#Queue.requeue",
        "call",
      ),
    ).toHaveLength(1);
    expect(
      refsFrom(
        "tests/test_retry.py#RecordingQueue.__init__",
        "jobrunner/queue.py#Queue.__init__",
        "call",
      ),
    ).toHaveLength(1);
  });

  it("the demo wires everything: run() constructs and calls the pieces; the main guard calls main() from module scope", () => {
    for (const to of [
      "jobrunner/queue.py#Queue",
      "jobrunner/runner.py#Runner",
      "jobrunner/worker.py#Worker",
      "jobrunner/worker.py#WorkerPool",
      "jobrunner/bus.py#EventBus",
      "jobrunner/queue.py#Queue.push",
      "jobrunner/runner.py#Runner.start",
      "jobrunner/runner.py#Runner.stop",
      "jobrunner/config.py#RunnerConfig.from_config",
      "jobrunner/config.py#load_config",
    ]) {
      expect(refsFrom("jobrunner/__main__.py#run", to, "call").length, to).toBeGreaterThan(0);
    }
    expect(refsFrom("jobrunner/__main__.py#", "jobrunner/__main__.py#main", "call")).toHaveLength(
      1,
    );
  });

  it("annotations become type references, dataclass fields included", () => {
    expect(
      refsFrom("jobrunner/queue.py#Queue.pop", "jobrunner/queue.py#Job", "type-ref").map(
        (r) => r.site.startLine,
      ),
    ).toEqual([58]);
    expect(
      refsFrom("jobrunner/config.py#Config.retry", "jobrunner/config.py#RetryConfig", "type-ref"),
    ).toHaveLength(1);
    expect(
      refsFrom("jobrunner/queue.py#DeadJob.job", "jobrunner/queue.py#Job", "type-ref"),
    ).toHaveLength(1);
  });

  it("counts of references by kind (a regression net for the pack)", () => {
    expect(count(index.refs, (r) => r.kind)).toEqual({
      import: 44,
      "type-ref": 50,
      call: 93,
      write: 4,
      extends: 1,
      read: 74,
    });
  });
});

describe("py-jobrunner: index-level properties", () => {
  it("has a deterministic working-tree commit id and byte-identical output", async () => {
    expect(index.commit).toMatch(/^wt-[0-9a-f]{10}$/);
    const again = await buildIndex({ root: fixture, precise: "off" });
    expect(again.index.commit).toBe(index.commit);
    expect(JSON.stringify(again.index)).toBe(JSON.stringify(index));
  });

  it("all refs reference existing files and symbols; module scopes only as `<file>#`", () => {
    const ids = new Set(index.symbols.map((s) => s.id));
    const files = new Set(index.files.map((f) => f.path));
    for (const ref of index.refs) {
      for (const id of [ref.from, ref.to]) {
        const hash = id.indexOf("#");
        expect(files.has(id.slice(0, hash)), id).toBe(true);
        if (id.slice(hash + 1) !== "") expect(ids.has(id), id).toBe(true);
      }
      expect(ref.from).not.toBe(ref.to);
      expect(ref.resolution).toBe("heuristic");
      expect(ref.site.startLine).toBeGreaterThanOrEqual(1);
    }
  });

  it("indexing a copy of the fixture elsewhere gives the same symbols and references", async () => {
    const copy = makeDir();
    cpSync(fixture, copy, {
      recursive: true,
      filter: (src) => !src.includes(`${join("py-jobrunner", ".explainer")}`),
    });
    const built = await buildIndex({ root: copy, precise: "off" });
    expect(built.index.commit).toBe(index.commit);
    expect(built.index.symbols).toEqual(index.symbols);
    expect(built.index.refs).toEqual(index.refs);
  });
});
