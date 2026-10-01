/**
 * `xpl bundle --files boundary`: the referenced files plus the files of the direct callers and callees of every
 * anchored symbol and the tests that reference one, capped by `--boundary-max`; the summary line, `--json`, and an
 * index pruned for exactly the embedded files.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { IndexModel, parseBundle, type SymbolIndex, type ViewerBundle } from "@xpl/core";
import { expectSameViewer } from "../../core/test/prune-equivalence.js";
import { boundaryFiles } from "../src/bundle-data.js";
import {
  cloneDir,
  indexedFixture,
  invoke,
  makeTempDir,
  PATCH_PATH,
  readFile,
  readJson,
  writeViewerStub,
  xpl,
} from "./helpers.js";

const viewerEnv = { XPL_VIEWER_HTML: writeViewerStub() };
const DATA_SCRIPT = /<script id="xpl-data" type="application\/json">([\s\S]*?)<\/script>/;
/** Where the pages go: outside the repositories, so that they never count as a change of the working tree. */
const OUT = makeTempDir("xpl-boundary-out-");

function bundleOf(out: string): ViewerBundle {
  const match = DATA_SCRIPT.exec(readFile(OUT, out));
  expect(match, `${out} has an xpl-data script`).not.toBeNull();
  return parseBundle(match![1]!);
}

/** `xpl bundle <name> -o <out> ... --root <dir>`, run in `OUT`. */
function bundle(dir: string, name: string, out: string, ...argv: string[]) {
  return invoke(["bundle", name, "-o", out, ...argv, "--root", dir], { cwd: OUT, env: viewerEnv });
}

function fullIndex(dir: string): SymbolIndex {
  const name = readdirSync(join(dir, ".explainer")).find((file) => /^index-.+\.json$/.test(file))!;
  return readJson<SymbolIndex>(dir, `.explainer/${name}`);
}

/** A new explainer `name` in `dir` with one concept anchored at `anchors` (no views: only the anchors count). */
async function anchoredAt(dir: string, name: string, anchors: object[]) {
  expect((await xpl(dir, "new", name)).code).toBe(0);
  const applied = await invoke(["apply", name, "-"], {
    cwd: dir,
    stdin: JSON.stringify({
      concepts: [{ id: "concept:x", label: "X", summary: "What it does.", anchors }],
    }),
  });
  expect(applied.code, applied.out + applied.err).toBe(0);
}

describe("--files boundary", () => {
  let dir: string;

  beforeAll(async () => {
    dir = cloneDir(await indexedFixture());
    // registerMetrics (src/metrics.ts): main() calls it, it calls EventBus.on (src/bus.ts), and the retry test
    // imports and calls it
    await anchoredAt(dir, "metrics", [
      { file: "src/metrics.ts", symbol: "registerMetrics", role: "definition" },
    ]);
  });

  it("adds the files of direct callers, callees and tests, and says so", async () => {
    const referenced = await bundle(dir, "metrics", "ref.html");
    expect(referenced.code, referenced.err).toBe(0);
    expect(Object.keys(bundleOf("ref.html").files)).toEqual(["src/metrics.ts"]);

    const { code, out, err } = await bundle(dir, "metrics", "b.html", "--files", "boundary");
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toMatch(
      /^wrote b\.html \([\d.]+ KB\): \.explainer\/metrics\.explainer\.json, 4 of 12 files embedded \(referenced 1, boundary \+3: callers 1, callees 1, tests 1; [\d.]+ KB of source; --files all adds 8 files, [\d.]+ KB\), index [\d.]+ KB \(pruned from [\d.]+ KB\), mode explore$/,
    );
    const data = bundleOf("b.html");
    expect(Object.keys(data.files).sort()).toEqual([
      "src/bus.ts", // callee: EventBus.on
      "src/main.ts", // caller: main()
      "src/metrics.ts", // referenced
      "test/retry.test.ts", // test: runOne() calls it
    ]);
    expect(data.files["test/retry.test.ts"]).toBe(readFile(dir, "test/retry.test.ts"));
  });

  it("--json lists what was added and why", async () => {
    const { code, out } = await bundle(dir, "metrics", "j.html", "--files", "boundary", "--json");
    expect(code).toBe(0);
    const json = JSON.parse(out);
    expect(json.files).toMatchObject({
      embedded: 4,
      choice: "boundary",
      referenced: 1,
      boundary: {
        // callers, tests and callees in turn, the most referenced first
        added: [
          { file: "src/main.ts", reason: "caller", refs: 1 },
          { file: "test/retry.test.ts", reason: "test", refs: 2 },
          { file: "src/bus.ts", reason: "callee", refs: 1 },
        ],
        cut: [],
        max: 40,
        symbols: 1,
      },
    });
  });

  it("--boundary-max caps the files added and names the ones cut", async () => {
    const { code, out } = await bundle(
      dir,
      "metrics",
      "cap.html",
      "--files",
      "boundary",
      "--boundary-max",
      "1",
    );
    expect(code).toBe(0);
    expect(out).toContain(
      "2 of 12 files embedded (referenced 1, boundary +1: callers 1, callees 0, tests 0; 2 more cut at --boundary-max 1: test/retry.test.ts, src/bus.ts;",
    );
    expect(Object.keys(bundleOf("cap.html").files).sort()).toEqual([
      "src/main.ts",
      "src/metrics.ts",
    ]);
    const zero = await bundle(
      dir,
      "metrics",
      "zero.html",
      "--files",
      "boundary",
      "--boundary-max",
      "0",
    );
    expect(zero.out).toContain("boundary +0: callers 0, callees 0, tests 0; 3 more cut");
    expect(Object.keys(bundleOf("zero.html").files)).toEqual(["src/metrics.ts"]);
  });

  it("the cap takes callers, tests and callees in turn", () => {
    const index = new IndexModel(fullIndex(dir));
    const explainer = readJson(dir, ".explainer/metrics.explainer.json");
    const two = boundaryFiles(explainer, index, ["src/metrics.ts"], 2);
    expect(two.added.map((e) => e.reason)).toEqual(["caller", "test"]);
    expect(two.cut.map((e) => [e.file, e.reason])).toEqual([["src/bus.ts", "callee"]]);
    // the referenced files are never added again
    const none = boundaryFiles(explainer, index, ["src/metrics.ts", "src/main.ts", "src/bus.ts"]);
    expect(none.added.map((e) => e.file)).toEqual(["test/retry.test.ts"]);
    // an anchor in a test file draws no boundary: what a test calls is not a neighbour of the code
    const inTest = {
      ...explainer,
      concepts: [
        {
          id: "concept:t",
          label: "T",
          anchors: [{ file: "test/retry.test.ts", symbol: "runOne", role: "test" }],
        },
      ],
    };
    expect(boundaryFiles(inTest, index, ["test/retry.test.ts"])).toMatchObject({
      added: [],
      symbols: 0,
    });
  });

  it("a constructor is called through its class: main() and the test reach Queue.constructor", async () => {
    const ctor = cloneDir(dir);
    await anchoredAt(ctor, "ctor", [
      { file: "src/queue.ts", symbol: "Queue.constructor", role: "definition" },
    ]);
    const { code } = await bundle(ctor, "ctor", "c.html", "--files", "boundary");
    expect(code).toBe(0);
    expect(Object.keys(bundleOf("c.html").files).sort()).toEqual([
      "src/main.ts", // new Queue(...)
      "src/queue.ts",
      "test/retry.test.ts", // class RecordingQueue extends Queue
    ]);
  });

  it("the pruned index is cut for the embedded files: the viewer derives the same as from the whole index", async () => {
    const demo = cloneDir(dir);
    expect((await xpl(demo, "new", "demo")).code).toBe(0);
    expect((await xpl(demo, "apply", "demo", PATCH_PATH)).code).toBe(0);
    await anchoredAt(demo, "narrow", [
      { file: "src/metrics.ts", symbol: "registerMetrics", role: "definition" },
    ]);
    const full = fullIndex(demo);
    for (const name of ["demo", "narrow"]) {
      const { code } = await bundle(demo, name, `${name}.html`, "--files", "boundary");
      expect(code).toBe(0);
      const data = bundleOf(`${name}.html`);
      const embedded = Object.keys(data.files);
      expectSameViewer(full, data.index, data.explainer, { embedded });
      // every symbol of an embedded file is in the embedded index (the code panel and the boxes need them)
      const kept = new Set(data.index.symbols.map((s) => s.id));
      for (const sym of full.symbols) {
        if (embedded.includes(sym.file)) expect(kept.has(sym.id), sym.id).toBe(true);
      }
    }
  });

  it("an explainer without anchored symbols adds nothing; --boundary-max needs --files boundary", async () => {
    // the demo explainer anchors files and symbols whose neighbours the views already embed
    const plain = cloneDir(dir);
    expect((await xpl(plain, "new", "empty")).code).toBe(0);
    const { out } = await bundle(plain, "empty", "e.html", "--files", "boundary");
    expect(out).toContain("boundary +0: no anchored symbols to draw it around");

    const usage = await bundle(dir, "metrics", "u.html", "--boundary-max", "3");
    expect(usage.code).toBe(2);
    expect(usage.err).toContain("--boundary-max needs --files boundary");
    const bad = await bundle(
      dir,
      "metrics",
      "u.html",
      "--files",
      "boundary",
      "--boundary-max",
      "x",
    );
    expect(bad.code).toBe(2);
    const badChoice = await bundle(dir, "metrics", "u.html", "--files", "neighbours");
    expect(badChoice.code).toBe(2);
    expect(badChoice.err).toContain("--files must be one of referenced, boundary, all");
  });
});
