/**
 * The symbol index in a bundle. `xpl bundle` embeds a pruned one by default (core's `pruneIndex`, ARCHITECTURE.md §5),
 * and the viewer must derive exactly what it derives from the whole index. The checks compare the derivations of
 * the two (`expectSameViewer`, shared with core's tests): on the committed example explainers of the three fixtures,
 * on narrower explainers of them, and on a synthetic repository that is larger than any fixture; and the command:
 * `--embed-index`, `--files all`, the summary line, `--json`.
 */
import { cpSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  IndexModel,
  parseBundle,
  serializeBundle,
  type Explainer,
  type SymbolIndex,
  type ViewerBundle,
} from "@xpl/core";
import { defaultIndexChoice, embedIndex, makeBundle, referencedFiles } from "../src/bundle-data.js";
import { expectSameViewer } from "../../core/test/prune-equivalence.js";
import { syntheticRepo } from "../../core/test/prune-repo.js";
import {
  cloneDir,
  FIXTURES_DIR,
  indexedFixture,
  invoke,
  PATCH_PATH,
  readFile,
  readJson,
  writeViewerStub,
  xpl,
} from "./helpers.js";

const viewerEnv = { XPL_VIEWER_HTML: writeViewerStub() };
const DATA_SCRIPT = /<script id="xpl-data" type="application\/json">([\s\S]*?)<\/script>/;

function bundleOf(dir: string, out: string): ViewerBundle {
  const match = DATA_SCRIPT.exec(readFile(dir, out));
  expect(match, `${out} has an xpl-data script`).not.toBeNull();
  return parseBundle(match![1]!);
}

/** `xpl bundle <name> -o <out> ...`, and the bundle it wrote. */
async function bundle(dir: string, name: string, out: string, ...argv: string[]) {
  const result = await invoke(["bundle", name, "-o", out, ...argv, "--root", dir], {
    cwd: dir,
    env: viewerEnv,
  });
  expect(result.code, result.err + result.out).toBe(0);
  return { ...result, data: bundleOf(dir, out) };
}

/** The whole index of an indexed directory, as written by `xpl index`. */
function fullIndex(dir: string): SymbolIndex {
  const name = readdirSync(join(dir, ".explainer")).find((file) => /^index-.+\.json$/.test(file))!;
  return readJson<SymbolIndex>(dir, `.explainer/${name}`);
}

const sizeOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

describe("--embed-index: what the command embeds", () => {
  let demo: string;
  let full: SymbolIndex;

  beforeAll(async () => {
    const indexed = await indexedFixture();
    demo = cloneDir(indexed);
    await xpl(demo, "new", "demo");
    expect((await xpl(demo, "apply", "demo", PATCH_PATH)).code).toBe(0);
    full = fullIndex(demo);
  });

  it("embeds a pruned index by default, marked with the counts of the full one", async () => {
    const { data, out } = await bundle(demo, "demo", "pruned.html");
    const pruned = data.index;
    expect(pruned.pruned).toEqual({
      files: full.files.length,
      symbols: full.symbols.length,
      refs: full.refs.length,
    });
    // every file stays, and so does everything else the index says about itself
    expect(pruned.files).toEqual(full.files);
    expect(pruned).toMatchObject({
      schema: full.schema,
      commit: full.commit,
      tool: full.tool,
      languages: full.languages,
    });
    expect(pruned.symbols.length).toBeLessThan(full.symbols.length);
    expect(pruned.refs.length).toBeLessThan(full.refs.length);
    // what is kept is an unchanged selection of the full index, in its order
    const symbols = new Set(full.symbols.map((symbol) => JSON.stringify(symbol)));
    for (const symbol of pruned.symbols) expect(symbols.has(JSON.stringify(symbol))).toBe(true);
    // the summary line says what that saved
    const saved =
      /index (\d+(?:\.\d)? (?:B|KB|MB)) \((\d+(?:\.\d)? (?:B|KB|MB)) as plain JSON, pruned from (\d+(?:\.\d)? (?:B|KB|MB))\)/.exec(
        out,
      );
    expect(saved, out).not.toBeNull();
    // and the explainer is exactly what the file holds
    expect(data.explainer).toEqual(readJson(demo, ".explainer/demo.explainer.json"));
  });

  it("--files all embeds the whole index, unmarked", async () => {
    const { data, out } = await bundle(demo, "demo", "all.html", "--files", "all");
    expect(data.index).toEqual(full);
    expect(data.index.pruned).toBeUndefined();
    expect(out).toMatch(/, index \d+(\.\d)? KB \(\d+(\.\d)? KB as plain JSON\), mode explore$/);
    expect(out).not.toContain("pruned");
  });

  it("--embed-index full keeps the whole index next to the referenced files", async () => {
    const { data, out } = await bundle(demo, "demo", "keep.html", "--embed-index", "full");
    expect(data.index).toEqual(full);
    expect(Object.keys(data.files)).toHaveLength(8);
    expect(out).toContain("8 of 12 files embedded");
    expect(out).not.toContain("pruned");
    // it is the bigger page
    const pruned = await bundle(demo, "demo", "smaller.html");
    expect(readFile(demo, "smaller.html").length).toBeLessThan(readFile(demo, "keep.html").length);
    expect(pruned.data.index.refs.length).toBeLessThan(data.index.refs.length);
  });

  it("--embed-index pruned with --files all embeds every file and finds nothing to prune", async () => {
    const { data, out } = await bundle(
      demo,
      "demo",
      "nothing.html",
      "--files",
      "all",
      "--embed-index",
      "pruned",
    );
    expect(Object.keys(data.files)).toHaveLength(12);
    // every file's code is there, so everything its symbols and references say is kept
    expect(data.index.symbols).toHaveLength(full.symbols.length);
    expect(data.index.refs).toHaveLength(full.refs.length);
    expect(data.index.pruned).toBeUndefined();
    expect(out).not.toContain("pruned from");
  });

  it("--json reports what was embedded of the index", async () => {
    const result = await invoke(["bundle", "demo", "-o", "j.html", "--json", "--root", demo], {
      cwd: demo,
      env: viewerEnv,
    });
    expect(result.code).toBe(0);
    const json = JSON.parse(result.out);
    const data = bundleOf(demo, "j.html");
    expect(json.index).toMatchObject({
      commit: full.commit,
      choice: "pruned",
      pruned: true,
      bytes: sizeOf(data.index),
      fullBytes: sizeOf(full),
      symbols: { embedded: data.index.symbols.length, indexed: full.symbols.length },
      refs: { embedded: data.index.refs.length, indexed: full.refs.length },
    });
    expect(json.index.path).toMatch(/^\.explainer\/index-.+\.json$/);
    expect(json.index.bytes).toBeLessThan(json.index.fullBytes);
    // the page holds it packed, and that is what the size says
    expect(json.index.packedBytes).toBeLessThan(json.index.bytes / 2);
    expect(readFile(demo, "j.html")).toContain('"packing":"xpl-index-pack@1"');

    const whole = JSON.parse(
      (
        await invoke(
          ["bundle", "demo", "-o", "j2.html", "--json", "--files", "all", "--root", demo],
          {
            cwd: demo,
            env: viewerEnv,
          },
        )
      ).out,
    );
    expect(whole.index).toMatchObject({
      choice: "full",
      pruned: false,
      bytes: sizeOf(full),
      fullBytes: sizeOf(full),
      symbols: { embedded: full.symbols.length, indexed: full.symbols.length },
      refs: { embedded: full.refs.length, indexed: full.refs.length },
    });
  });

  it("rejects a value that is not full or pruned, and leaves --index to pick the index file", async () => {
    const bad = await invoke(
      ["bundle", "demo", "-o", "x.html", "--embed-index", "some", "--root", demo],
      {
        cwd: demo,
        env: viewerEnv,
      },
    );
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('--embed-index must be one of full, pruned (got "some")');
    // `--index` is the global option that names an index file, for bundle as for every command
    const file = readdirSync(join(demo, ".explainer")).find((name) =>
      /^index-.+\.json$/.test(name),
    )!;
    const chosen = await bundle(demo, "demo", "chosen.html", "--index", `.explainer/${file}`);
    expect(chosen.data.index.commit).toBe(full.commit);
    const wrong = await invoke(
      ["bundle", "demo", "-o", "x.html", "--index", "pruned", "--root", demo],
      {
        cwd: demo,
        env: viewerEnv,
      },
    );
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain('index file "pruned" not found');
    // the help says so
    const help = await invoke(["bundle", "--help"]);
    expect(help.out).toContain("--embed-index full|pruned");
    expect(help.out).toContain("--index <path>");
  });

  it("chooses full for --files all and pruned otherwise", () => {
    expect(defaultIndexChoice("all")).toBe("full");
    expect(defaultIndexChoice("referenced")).toBe("pruned");
  });
});

/**
 * Per fixture: the committed example explainer (after `xpl index --precise off` on a copy), and explainers that
 * need only a part of the index. The file that holds the queue, and something anchored elsewhere.
 */
const FIXTURES = [
  { name: "ts-jobrunner", queue: "src/queue.ts", other: "src/worker.ts" },
  { name: "py-jobrunner", queue: "jobrunner/queue.py", other: "jobrunner/worker.py" },
  { name: "go-jobrunner", queue: "internal/queue/queue.go", other: "internal/worker/worker.go" },
] as const;

for (const fixture of FIXTURES) {
  describe(`the index pruned for the ${fixture.name} explainers`, () => {
    let dir: string;
    let full: SymbolIndex;

    beforeAll(async () => {
      dir = await indexedFixture(fixture.name);
      cpSync(
        join(FIXTURES_DIR, fixture.name, ".explainer", "jobrunner.explainer.json"),
        join(dir, ".explainer", "jobrunner.explainer.json"),
      );
      full = fullIndex(dir);
    });

    /** Bundles `name` with the pruned and with the whole index, and checks what the viewer derives from each. */
    async function checked(name: string) {
      const pruned = await bundle(dir, name, `${name}-pruned.html`);
      const whole = await bundle(dir, name, `${name}-whole.html`, "--embed-index", "full");
      expect(whole.data.index).toEqual(full);
      const embedded = Object.keys(pruned.data.files);
      const stats = expectSameViewer(whole.data.index, pruned.data.index, pruned.data.explainer, {
        embedded,
      });
      // the files the viewer needs are the same computed from the pruned index: nothing it draws was lost
      expect(referencedFiles(pruned.data.explainer, new IndexModel(pruned.data.index))).toEqual(
        referencedFiles(whole.data.explainer, new IndexModel(whole.data.index)),
      );
      expect(embedded.sort()).toEqual(
        referencedFiles(whole.data.explainer, new IndexModel(whole.data.index)),
      );
      return { pruned: pruned.data, whole: whole.data, stats };
    }

    it("the committed example explainer", async () => {
      const { pruned, stats } = await checked("jobrunner");
      expect(stats.graphs).toBeGreaterThan(30);
      expect(stats.ghosts).toBeGreaterThan(0);
      expect(stats.stubCode).toBeGreaterThan(0);
      expect(stats.ranges).toBeGreaterThan(5);
      expect(pruned.index.pruned?.files).toBe(full.files.length);
      expect(pruned.index.symbols.length).toBeLessThanOrEqual(full.symbols.length);
    });

    it("an explainer of one file and a concept anchored in another", async () => {
      expect((await xpl(dir, "new", "narrow")).code).toBe(0);
      const patch = {
        views: [
          { id: "view:queue", type: "graph", title: "Queue", include: [`file:${fixture.queue}`] },
        ],
        concepts: [
          {
            id: "concept:elsewhere",
            label: "Elsewhere",
            anchors: [{ file: fixture.other, role: "definition" }],
          },
        ],
      };
      const applied = await invoke(["apply", "narrow", "-"], {
        cwd: dir,
        stdin: JSON.stringify(patch),
      });
      expect(applied.code, applied.out + applied.err).toBe(0);
      const { pruned, stats } = await checked("narrow");
      expect(stats.stubs).toBeGreaterThan(0);
      expect(stats.ghosts).toBeGreaterThan(0);
      // a good part of the index is gone: what neither view nor code can reach
      expect(pruned.index.symbols.length).toBeLessThan(full.symbols.length);
      expect(pruned.index.refs.length).toBeLessThan(full.refs.length);
    });

    it("a sequence view has no references to draw: only what touches its files stays, and the tour still plays", async () => {
      expect((await xpl(dir, "new", "flow")).code).toBe(0);
      const patch = {
        views: [
          {
            id: "view:flow",
            type: "sequence",
            title: "Flow",
            participants: [`file:${fixture.queue}`, `file:${fixture.other}`],
            steps: [
              {
                id: "flow:1",
                from: `file:${fixture.queue}`,
                to: `file:${fixture.other}`,
                label: "hands over",
                kind: "call",
              },
            ],
          },
        ],
        tours: [
          { id: "tour:t", title: "T", steps: [{ id: "s1", view: "view:flow", focus: ["flow:1"] }] },
        ],
      };
      const applied = await invoke(["apply", "flow", "-"], {
        cwd: dir,
        stdin: JSON.stringify(patch),
      });
      expect(applied.code, applied.out + applied.err).toBe(0);
      const { pruned } = await checked("flow");
      // the participants' code is embedded, so what touches those two files is what is kept (a read: both ends)
      const model = new IndexModel(full);
      const embedded = new Set(Object.keys(pruned.files));
      expect(embedded).toEqual(new Set([fixture.queue, fixture.other]));
      const at = (id: string) => embedded.has(model.fileOfSymbolId(id) ?? "");
      for (const ref of pruned.index.refs) {
        expect(ref.kind === "read" ? at(ref.from) && at(ref.to) : at(ref.from) || at(ref.to)).toBe(
          true,
        );
      }
      expect(pruned.index.refs.length).toBeLessThan(full.refs.length);
      expect(pruned.index.symbols.length).toBeLessThan(full.symbols.length);
    });
  });
}

describe("embedIndex on a larger repository", () => {
  const repo = syntheticRepo({ seed: 5, packages: 6, filesPerPackage: 8, bigFiles: 64 });
  const { world, explainer } = repo;
  const files = referencedFiles(explainer, world.model);

  it("embeds the files the explainer references, and less of the index than there is", () => {
    // a directory the viewer focuses only in part: some of its 64 files are not embedded
    const big = files.filter((file) => file.startsWith("packages/big/src/"));
    expect(big.length).toBeGreaterThanOrEqual(50);
    expect(big.length).toBeLessThan(64);
    const embedded = embedIndex({ index: world.index, model: world.model, explainer, files });
    expect(embedded.choice).toBe("pruned");
    expect(embedded.pruned).toBe(true);
    expect(embedded.bytes).toBeLessThan(embedded.fullBytes);
    expect(embedded.refs.embedded).toBeLessThan(embedded.refs.indexed);
    expect(embedded.refs.indexed).toBe(world.index.refs.length);
    expect(embedded.symbols.indexed).toBe(world.index.symbols.length);
    expect(embedded.fullBytes).toBe(sizeOf(world.index));
    expect(embedded.bytes).toBe(sizeOf(embedded.index));
  });

  it("the viewer derives the same from what the bundle carries, and needs the same files", () => {
    const embedded = embedIndex({ index: world.index, model: world.model, explainer, files });
    // through the page: serialized into the script element and read back, as the viewer does
    const page = parseBundle(
      serializeBundle(makeBundle({ explainer, index: embedded.index, files: {} })),
    );
    expect(page.index.pruned).toEqual({
      files: world.index.files.length,
      symbols: world.index.symbols.length,
      refs: world.index.refs.length,
    });
    const stats = expectSameViewer(world.index, page.index, explainer, { embedded: files });
    expect(stats.edges).toBeGreaterThan(500);
    expect(stats.stubs).toBeGreaterThan(500);
    expect(stats.stubCode).toBeGreaterThan(200);
    expect(stats.ghosts).toBeGreaterThan(300);
    expect(stats.ranges).toBeGreaterThan(500);
    expect(stats.lookups).toBeGreaterThan(500);
    expect(referencedFiles(explainer, new IndexModel(page.index))).toEqual(files);
  });

  it("embeds the whole index when asked, as the same object", () => {
    const embedded = embedIndex({
      index: world.index,
      model: world.model,
      explainer,
      files,
      choice: "full",
    });
    expect(embedded.index).toBe(world.index);
    expect(embedded.pruned).toBe(false);
    expect(embedded.bytes).toBe(embedded.fullBytes);
  });

  it("prunes most of the index of a narrow explainer of it", () => {
    const narrow: Explainer = {
      ...explainer,
      views: explainer.views.filter((view) => view.id === "view:quiet"),
      tours: [],
      nodes: [],
      edges: [],
      concepts: [],
    };
    const narrowFiles = referencedFiles(narrow, world.model);
    const embedded = embedIndex({
      index: world.index,
      model: world.model,
      explainer: narrow,
      files: narrowFiles,
    });
    expect(embedded.bytes).toBeLessThan(embedded.fullBytes * 0.15);
    expectSameViewer(world.index, embedded.index, narrow, { embedded: narrowFiles });
  });
});
