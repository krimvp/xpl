/**
 * Precise references from the real SCIP indexers, on the three job-runner fixtures.
 *
 * These download and run scip-typescript (npm), scip-python (npm) and scip-go (Go module proxy; needs Go and,
 * for Go < 1.25, the toolchain download), so they only run with XPL_TEST_SCIP=1:
 *
 *   XPL_TEST_SCIP=1 npx vitest run packages/indexer/test/scip-integration.test.ts
 *
 * Every fixture is also indexed with `precise: "off"`; the two reference sets are compared (kind, from, to)
 * and the counts are printed, which tells how good the heuristic resolver is.
 */
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { Reference, SymbolIndex } from "@xpl/core";
import { buildIndex } from "../src/index.js";
import { makeDir } from "./helpers.js";

const enabled = process.env.XPL_TEST_SCIP === "1";
const suite = enabled ? describe : describe.skip;
/** First runs download the tools (and the Go toolchain). */
const LONG = 15 * 60_000;

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../../fixtures/${name}`, import.meta.url));

interface Built {
  precise: SymbolIndex;
  heuristic: SymbolIndex;
  warnings: string[];
  root: string;
  /** Files of the fixture directory before the run (nothing may be added or changed by the tools). */
  before: string;
}

/** A temp copy of a fixture (removed after this test file), to add files the fixture does not have. */
function copyFixture(name: string): string {
  const dir = makeDir({});
  cpSync(fixture(name), dir, { recursive: true });
  return dir;
}

/** A recursive listing with file sizes: enough to notice a tool leaving files behind. */
function snapshot(dir: string, prefix = ""): string {
  const lines: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) lines.push(snapshot(`${dir}/${entry.name}`, `${path}/`));
    else lines.push(`${path}:${readFileSync(`${dir}/${entry.name}`).length}`);
  }
  return lines.join("\n");
}

async function build(name: string): Promise<Built> {
  const root = fixture(name);
  const before = snapshot(root);
  const { index: precise, warnings } = await buildIndex({ root, precise: "require" });
  const { index: heuristic } = await buildIndex({ root, precise: "off" });
  return { precise, heuristic, warnings, root, before };
}

const has = (
  refs: readonly Reference[],
  kind: Reference["kind"],
  from: string,
  to: string,
): Reference | undefined => refs.find((r) => r.kind === kind && r.from === from && r.to === to);

interface Diff {
  both: number;
  preciseOnly: string[];
  heuristicOnly: string[];
}

/** Compare the (kind, from, to) sets of the two indexes. */
function compare(precise: SymbolIndex, heuristic: SymbolIndex): Diff {
  const keys = (refs: readonly Reference[]): Set<string> =>
    new Set(refs.map((r) => `${r.kind} ${r.from} -> ${r.to}`));
  const p = keys(precise.refs);
  const h = keys(heuristic.refs);
  return {
    both: [...p].filter((k) => h.has(k)).length,
    preciseOnly: [...p].filter((k) => !h.has(k)).sort(),
    heuristicOnly: [...h].filter((k) => !p.has(k)).sort(),
  };
}

function report(name: string, built: Built): Diff {
  const diff = compare(built.precise, built.heuristic);
  const total = (refs: readonly Reference[]): number => refs.length;
  console.log(
    `[scip] ${name}: precise ${total(built.precise.refs)} refs, heuristic ${total(built.heuristic.refs)} refs; ` +
      `by (kind, from, to): both ${diff.both}, precise-only ${diff.preciseOnly.length}, heuristic-only ${diff.heuristicOnly.length}`,
  );
  return diff;
}

suite("scip integration: ts-jobrunner (scip-typescript)", () => {
  let built: Built;
  let diff: Diff;
  beforeAll(async () => {
    built = await build("ts-jobrunner");
    diff = report("ts-jobrunner", built);
  }, LONG);

  it("indexes the fixture with scip-typescript", () => {
    expect(built.warnings).toEqual([]);
    expect(built.precise.languages.typescript).toMatchObject({
      refs: "precise",
      tool: "scip-typescript@0.4.0",
    });
    expect(built.precise.refs.length).toBeGreaterThan(100);
    expect(built.precise.refs.every((r) => r.resolution === "precise")).toBe(true);
  });

  it("resolves the dispatch loop: pop, lease, run, requeue (site lines 76-78), dead letter", () => {
    const from = "src/runner.ts#Runner.dispatch";
    const requeue = has(built.precise.refs, "call", from, "src/queue.ts#Queue.requeue");
    expect(requeue).toBeDefined();
    expect(requeue!.site).toMatchObject({ startLine: 76, endLine: 78 });
    expect(requeue!.resolution).toBe("precise");
    const run = has(built.precise.refs, "call", from, "src/worker.ts#Worker.run");
    expect(run).toBeDefined();
    expect(run!.site).toMatchObject({ startLine: 60, endLine: 61 });
    for (const to of [
      "src/queue.ts#Queue.pop",
      "src/queue.ts#Queue.ack",
      "src/queue.ts#Queue.deadLetter",
      "src/worker.ts#WorkerPool.lease",
      "src/worker.ts#WorkerPool.release",
      "src/runner.ts#RunnerStats.record",
      "src/runner.ts#backoffDelay",
    ]) {
      expect(has(built.precise.refs, "call", from, to), to).toBeDefined();
    }
    expect(
      has(built.precise.refs, "write", from, "src/runner.ts#RunnerStats.deadLettered"),
    ).toBeDefined();
  });

  it("resolves imports, constructors and heritage", () => {
    const refs = built.precise.refs;
    expect(has(refs, "import", "src/runner.ts#", "src/queue.ts#Queue")).toBeDefined();
    // `new Queue(...)` and `new Runner(...)` in main call the classes
    expect(has(refs, "call", "src/main.ts#main", "src/queue.ts#Queue")).toBeDefined();
    expect(has(refs, "call", "src/main.ts#main", "src/runner.ts#Runner")).toBeDefined();
    expect(
      has(refs, "extends", "test/retry.test.ts#RecordingQueue", "src/queue.ts#Queue"),
    ).toBeDefined();
    // symbols of node:timers/promises and the standard library are external: no references to them
    expect(
      refs.every(
        (r) => r.to.includes("#") && built.precise.files.some((f) => r.to.startsWith(`${f.path}#`)),
      ),
    ).toBe(true);
  });

  it("agrees with the heuristic resolver on this fixture", () => {
    expect(diff.both).toBeGreaterThan(100);
    expect(diff.heuristicOnly.length).toBeLessThanOrEqual(Math.ceil(diff.both * 0.05));
  });

  it("leaves the fixture directory as it was", () => {
    expect(snapshot(built.root)).toBe(built.before);
  });
});

suite("scip integration: py-jobrunner (scip-python)", () => {
  let built: Built;
  let diff: Diff;
  beforeAll(async () => {
    built = await build("py-jobrunner");
    diff = report("py-jobrunner", built);
  }, LONG);

  it("indexes the fixture with scip-python", () => {
    expect(built.warnings).toEqual([]);
    expect(built.precise.languages.python).toMatchObject({
      refs: "precise",
      tool: "scip-python@0.6.6",
    });
    expect(built.precise.refs.length).toBeGreaterThan(100);
  });

  it("resolves the dispatch loop through the Python pack's classification of sites", () => {
    // NOTE: kinds come from the Python pack's `classifySite`; with a stub pack (refs: "none") this resolver is
    // not even invoked, and if only the fallback applied, calls would be dropped and only type-refs kept.
    const from = "jobrunner/runner.py#Runner.dispatch";
    for (const to of [
      "jobrunner/queue.py#Queue.pop",
      "jobrunner/queue.py#Queue.requeue",
      "jobrunner/queue.py#Queue.ack",
      "jobrunner/queue.py#Queue.dead_letter",
      "jobrunner/worker.py#WorkerPool.lease",
      "jobrunner/worker.py#Worker.run",
      "jobrunner/runner.py#backoff_delay",
    ]) {
      expect(has(built.precise.refs, "call", from, to), to).toBeDefined();
    }
    const requeue = has(built.precise.refs, "call", from, "jobrunner/queue.py#Queue.requeue")!;
    expect(requeue.site.startLine).toBeGreaterThanOrEqual(85);
    expect(requeue.resolution).toBe("precise");
  });

  it("resolves imports and inheritance", () => {
    const refs = built.precise.refs;
    expect(has(refs, "import", "jobrunner/runner.py#", "jobrunner/queue.py#Queue")).toBeDefined();
    expect(
      has(refs, "extends", "tests/test_retry.py#RecordingQueue", "jobrunner/queue.py#Queue"),
    ).toBeDefined();
    // instance attributes assigned in __init__ (self._queue = queue) are not symbols of ours: nothing points at __init__
    expect(
      refs.some((r) => r.kind !== "call" && r.to === "jobrunner/runner.py#Runner.__init__"),
    ).toBe(false);
  });

  it("agrees with the heuristic resolver on this fixture", () => {
    expect(diff.both).toBeGreaterThan(100);
    expect(diff.heuristicOnly.length).toBeLessThanOrEqual(Math.ceil(diff.both * 0.05));
  });

  it("leaves the fixture directory as it was", () => {
    expect(snapshot(built.root)).toBe(built.before);
  });
});

suite("scip integration: go-jobrunner (scip-go)", () => {
  let built: Built;
  let diff: Diff;
  beforeAll(async () => {
    built = await build("go-jobrunner");
    diff = report("go-jobrunner", built);
  }, LONG);

  it("indexes the fixture with scip-go", () => {
    expect(built.warnings).toEqual([]);
    expect(built.precise.languages.go).toMatchObject({ refs: "precise", tool: "scip-go@0.2.7" });
    expect(built.precise.refs.length).toBeGreaterThan(100);
  });

  it("resolves calls on interface methods and the worker", () => {
    const from = "internal/runner/runner.go#Runner.Dispatch";
    for (const to of [
      "internal/runner/runner.go#JobQueue.Pop",
      "internal/runner/runner.go#JobQueue.Ack",
      "internal/runner/runner.go#JobQueue.Requeue",
      "internal/runner/runner.go#JobQueue.DeadLetter",
      "internal/runner/runner.go#WorkerPool.Lease",
      "internal/runner/runner.go#WorkerPool.Release",
      "internal/worker/worker.go#Worker.Run",
    ]) {
      expect(has(built.precise.refs, "call", from, to), to).toBeDefined();
    }
  });

  it("finds the implicit interface implementations from SCIP relationships", () => {
    const refs = built.precise.refs;
    const impl = has(
      refs,
      "implements",
      "internal/queue/queue.go#Queue",
      "internal/runner/runner.go#JobQueue",
    );
    expect(impl).toBeDefined();
    expect(impl!.resolution).toBe("precise");
    // the site is the implementing type's name at its definition (`type Queue struct`, line 33)
    expect(impl!.site).toMatchObject({ startLine: 33, endLine: 33 });
    expect(
      has(
        refs,
        "implements",
        "internal/queue/queue.go#Queue.Pop",
        "internal/runner/runner.go#JobQueue.Pop",
      ),
    ).toBeDefined();
    expect(
      has(
        refs,
        "implements",
        "internal/queue/deadletter.go#Queue.DeadLetter",
        "internal/runner/runner.go#JobQueue.DeadLetter",
      ),
    ).toBeDefined();
    expect(
      has(
        refs,
        "implements",
        "internal/worker/pool.go#Pool",
        "internal/runner/runner.go#WorkerPool",
      ),
    ).toBeDefined();
  });

  it("imports packages as their module scope, the file named like the directory first", () => {
    const refs = built.precise.refs;
    expect(
      has(refs, "import", "internal/runner/runner.go#", "internal/queue/queue.go#"),
    ).toBeDefined();
    expect(
      has(refs, "import", "internal/runner/runner.go#", "internal/worker/worker.go#"),
    ).toBeDefined();
    // never a test file as the representative of a package for production code
    expect(
      refs.some(
        (r) =>
          r.kind === "import" && r.from === "cmd/jobrunner/main.go#" && r.to.endsWith("_test.go#"),
      ),
    ).toBe(false);
  });

  it("agrees with the heuristic resolver on this fixture", () => {
    expect(diff.both).toBeGreaterThan(100);
    expect(diff.heuristicOnly.length).toBeLessThanOrEqual(Math.ceil(diff.both * 0.05));
  });

  it("leaves go.mod and the rest of the fixture as it was", () => {
    expect(snapshot(built.root)).toBe(built.before);
  });
});

// ─── Files the tool did not describe keep their heuristic references ──────────────────────────────

const triples = (refs: readonly Reference[]): string[] =>
  refs.map((r) => `${r.kind} ${r.from} -> ${r.to}`).sort();

suite("scip integration: a build-tagged Go file (per-file replacement)", () => {
  const windowsFile = "internal/runner/runner_windows.go";
  let built: { index: SymbolIndex; warnings: string[] };
  beforeAll(async () => {
    const root = copyFixture("go-jobrunner");
    // compiled on Windows only: scip-go builds for the host platform and never loads it
    writeFileSync(
      join(root, windowsFile),
      `//go:build windows

package runner

func windowsOnly(r *Runner) {
	r.logf("only on windows")
}
`,
    );
    built = await buildIndex({ root, precise: "require" });
  }, LONG);

  it("keeps the heuristic references of the file scip-go did not load, marked heuristic, and says so", () => {
    const windows = built.index.refs.filter((r) => r.from.startsWith(`${windowsFile}#`));
    expect(triples(windows)).toEqual([
      `call ${windowsFile}#windowsOnly -> internal/runner/runner.go#Runner.logf`,
      `type-ref ${windowsFile}#windowsOnly -> internal/runner/runner.go#Runner`,
    ]);
    expect(windows.every((r) => r.resolution === "heuristic")).toBe(true);
    expect(built.index.languages.go).toMatchObject({
      refs: "precise",
      tool: "scip-go@0.2.7",
      heuristicFiles: 1,
    });
    expect(built.warnings).toEqual([
      expect.stringMatching(
        /^scip-go@0\.2\.7 did not describe 1 file\(s\).*; their references stay heuristic: internal\/runner\/runner_windows\.go$/,
      ),
    ]);
  });

  it("every other reference is precise: the heuristic ones of the described files are gone", () => {
    const others = built.index.refs.filter((r) => !r.from.startsWith(`${windowsFile}#`));
    expect(others.length).toBeGreaterThan(200);
    expect(others.every((r) => r.resolution === "precise")).toBe(true);
  });
});

suite("scip integration: a file pyright is configured to exclude (per-file replacement)", () => {
  let built: { index: SymbolIndex; warnings: string[] };
  beforeAll(async () => {
    const root = copyFixture("py-jobrunner");
    appendFileSync(join(root, "pyproject.toml"), '\n[tool.pyright]\nexclude = ["scripts"]\n');
    mkdirSync(join(root, "scripts"));
    writeFileSync(
      join(root, "scripts/drain.py"),
      "from jobrunner.queue import Queue\n\n\ndef drain(queue: Queue) -> None:\n    queue.ack(queue.pop())\n",
    );
    built = await buildIndex({ root, precise: "require" });
  }, LONG);

  it("keeps the heuristic references of the excluded file", () => {
    const script = built.index.refs.filter((r) => r.from.startsWith("scripts/drain.py#"));
    expect(triples(script)).toEqual([
      "call scripts/drain.py#drain -> jobrunner/queue.py#Queue.ack",
      "call scripts/drain.py#drain -> jobrunner/queue.py#Queue.pop",
      "import scripts/drain.py# -> jobrunner/queue.py#Queue",
      "type-ref scripts/drain.py#drain -> jobrunner/queue.py#Queue",
    ]);
    expect(script.every((r) => r.resolution === "heuristic")).toBe(true);
    expect(built.index.languages.python).toMatchObject({
      refs: "precise",
      tool: "scip-python@0.6.6",
      heuristicFiles: 1,
    });
    expect(
      built.index.refs
        .filter((r) => !r.from.startsWith("scripts/"))
        .every((r) => r.resolution === "precise"),
    ).toBe(true);
  });
});
