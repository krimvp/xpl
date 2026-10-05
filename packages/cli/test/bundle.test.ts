import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  BUNDLE_SCHEMA,
  collectAnchors,
  reviewFingerprint,
  parseBundle,
  TextCache,
} from "@xpl/core";
import { buildIndex, writeIndex } from "@xpl/indexer";
import { findViewerHtml, viewerHtmlCandidates } from "../src/viewer-html.js";
import {
  bundleOf,
  cloneDir,
  editFile,
  indexedFixture,
  invoke,
  makeTempDir,
  PATCH_PATH,
  readFile,
  readJson,
  STUB_VIEWER_HTML,
  writeViewerStub,
  xpl,
  xplJson,
} from "./helpers.js";

let demo: string;
let viewerEnv: { XPL_VIEWER_HTML: string };

beforeAll(async () => {
  const indexed = await indexedFixture();
  demo = cloneDir(indexed);
  await xpl(demo, "new", "demo");
  expect((await xpl(demo, "apply", "demo", PATCH_PATH)).code).toBe(0);
  // Complete the old structural example through apply: ready export requires the text status counts.
  const completed = await invoke(["apply", "demo", "-"], {
    cwd: demo,
    stdin: JSON.stringify({
      nodes: [
        { id: "file:src/metrics.ts", summary: "Counts the jobs completed by workers." },
        { id: "file:src/worker.ts", summary: "Runs the assigned job with a timeout." },
        { id: "file:src/queue.ts", summary: "Stores waiting jobs and schedules retries." },
      ],
      views: [
        {
          id: "view:dispatch",
          type: "sequence",
          stepsUpdate: [
            { id: "dispatch:1", summary: "The runner removes the next waiting job." },
            { id: "dispatch:2", summary: "The worker runs the selected job." },
            { id: "dispatch:3", summary: "The queue schedules a failed job for retry." },
          ],
        },
      ],
      tours: [
        {
          id: "tour:intro",
          summary:
            "The scheduler sends queued jobs to workers. Failed jobs return to the queue with a delay.",
          stepsUpdate: [
            {
              id: "t1",
              note: "### Scheduling\n\nScheduling is two files. Metrics counts completed work; the worker runs each job.",
            },
            {
              id: "t2",
              note: "### Failure handling\n\nThe queue retries failed jobs with backoff.",
            },
          ],
        },
      ],
    }),
  });
  expect(completed.code, completed.err).toBe(0);
  viewerEnv = { XPL_VIEWER_HTML: writeViewerStub() };
});

function bundle(dir: string, ...argv: string[]) {
  return invoke(["bundle", "demo", ...argv, "--root", dir], { cwd: dir, env: viewerEnv });
}

/** Indexes the edited tree; returns the new index file (the explainer stays bound to its old one). */
async function reindex(dir: string): Promise<string> {
  const { code, json } = await xplJson<{ path: string }>(dir, "index", "--precise", "off");
  expect(code).toBe(0);
  return json.path;
}

/** The first anchor of the explainer at `symbol` (with no span), wherever it is stored. */
function anchorOf(explainer: any, symbol: string): any {
  const found = collectAnchors(explainer).find(
    (site) => site.anchor.symbol === symbol && site.anchor.span === undefined,
  );
  expect(found, `an anchor at ${symbol}`).toBeDefined();
  return found!.anchor;
}

/** What the demo explainer needs: its anchors' files, its views' nodes and participants, and its ghosts. */
const REFERENCED = [
  "config/default.yaml",
  "src/bus.ts",
  "src/main.ts",
  "src/metrics.ts",
  "src/queue.ts",
  "src/runner.ts",
  "src/worker.ts",
  "test/retry.test.ts",
];

describe("xpl bundle", () => {
  it("retains observed failures and abilities through a saved index and a pruned, packed HTML bundle", async () => {
    const dir = cloneDir(demo);
    const { index } = await buildIndex({
      root: dir,
      precise: "auto",
      providers: [
        {
          id: "calls-only",
          languages: ["typescript"],
          capabilities: { call: "supported" },
          async analyze() {
            throw new Error("tool unavailable");
          },
        },
      ],
    });
    await writeIndex(dir, index);
    expect((await xpl(dir, "new", "coverage")).code).toBe(0);
    const result = await invoke(["bundle", "coverage", "-o", "coverage.html", "--draft"], {
      cwd: dir,
      env: viewerEnv,
    });
    expect(result.code).toBe(0);
    const embedded = bundleOf(readFile(dir, "coverage.html")).index;
    expect(embedded.pruned).toMatchObject({ files: 12, symbols: 160, refs: 297 });
    expect(embedded.analysis).toEqual(index.analysis);
    expect(
      embedded.analysis
        ?.find((r) => r.provider === "calls-only")
        ?.results.find((r) => r.capabilities.includes("call")),
    ).toMatchObject({ status: "failed", analyzedFiles: [] });
  });
  it("refuses stale-index validation and export, including --allow-drift and the skip-check environment", async () => {
    const dir = cloneDir(demo);
    editFile(dir, "src/queue.ts", (text) =>
      text.replace("Date.now() + delayMs", "Date.now() + delayMs + 7"),
    );
    const strict = await xplJson<any>(dir, "validate", "demo");
    expect(strict.code).toBe(1);
    expect(strict.json.issues).toContainEqual(
      expect.objectContaining({
        path: "index",
        severity: "error",
        message: expect.stringContaining("does not match the working tree"),
      }),
    );
    const lenient = await xplJson<any>(dir, "validate", "demo", "--lenient");
    expect(lenient.code).toBe(0);
    expect(lenient.json.issues).toContainEqual(
      expect.objectContaining({ path: "index", severity: "warning" }),
    );
    for (const args of [[], ["--allow-drift"]]) {
      const result = await invoke(["bundle", "demo", "-o", "stale.html", ...args], {
        cwd: dir,
        env: { ...viewerEnv, XPL_SKIP_STALE_CHECK: "1" },
      });
      expect(result.code).toBe(1);
      expect(result.err).toContain("Refusing to export");
      expect(existsSync(join(dir, "stale.html"))).toBe(false);
    }
    const skipped = await invoke(["validate", "demo"], {
      cwd: dir,
      env: { XPL_SKIP_STALE_CHECK: "1" },
    });
    expect(skipped.code).toBe(1);
  });
  it("writes one HTML file with the xpl-data script, and the payload parses back", async () => {
    const { code, out, err } = await bundle(demo, "-o", "out.html");
    expect(err).toBe("");
    expect(code).toBe(0);
    // the default embeds what the explainer needs, and says how much that is and what --files all would add,
    // and how much of the symbol index it kept
    expect(out).toMatch(
      /^wrote out\.html \(\d+(\.\d)? KB\): \.explainer\/demo\.explainer\.json, 8 of 12 files embedded \(referenced: \d+(\.\d)? KB of source; --files all adds 4 files, \d+(\.\d)? KB\), index \d+(\.\d)? KB \(\d+(\.\d)? KB as plain JSON, pruned from \d+(\.\d)? KB\), mode explore$/,
    );

    const html = readFile(demo, "out.html");
    expect(html).toContain("<title>stub viewer</title>"); // the viewer page itself
    expect(html.match(/<script id="xpl-data"/g)).toHaveLength(1);
    const data = bundleOf(html);
    expect(data.schema).toBe(BUNDLE_SCHEMA);
    expect(data.explainer.title).toBe("Job runner");
    expect(data.explainer.views.map((v) => v.id)).toEqual(["view:overview", "view:dispatch"]);
    expect(data.index.commit).toBe(data.explainer.index.commit);
    expect(data.index.symbols.some((s) => s.id === "src/runner.ts#Runner.dispatch")).toBe(true);
    expect(data.mode).toBe("explore");
    expect(data.tour).toBeUndefined();
    expect(data.server).toBeUndefined();
    // the files of the anchors and of what the views draw, with their exact text
    expect(Object.keys(data.files).sort()).toEqual(REFERENCED);
    expect(data.files["src/runner.ts"]).toBe(readFile(demo, "src/runner.ts"));
    expect(data.files["config/default.yaml"]).toBe(readFile(demo, "config/default.yaml"));
    // the index still lists every file: the viewer's file tree is built from it
    expect(data.index.files).toHaveLength(12);
  });

  it("--files all embeds every indexed file and says so", async () => {
    const { code, out } = await bundle(demo, "-o", "all.html", "--files", "all");
    expect(code).toBe(0);
    // --files all embeds the whole index as well: nothing to say about pruning
    expect(out).toMatch(
      /^wrote all\.html \(\d+(\.\d)? KB\): \.explainer\/demo\.explainer\.json, 12 files embedded \(all: \d+(\.\d)? KB of source\), index \d+(\.\d)? KB \(\d+(\.\d)? KB as plain JSON\), mode explore$/,
    );
    const data = bundleOf(readFile(demo, "all.html"));
    expect(Object.keys(data.files).sort()).toEqual(data.index.files.map((f) => f.path).sort());
    expect(data.files["src/main.ts"]).toBe(readFile(demo, "src/main.ts"));
  });

  it("--files referenced is the default: the same files as saying it", async () => {
    const explicit = await bundle(demo, "-o", "small.html", "--files", "referenced");
    expect(explicit.code).toBe(0);
    expect(explicit.out).toContain("(referenced:");
    const data = bundleOf(readFile(demo, "small.html"));
    expect(Object.keys(data.files).sort()).toEqual(REFERENCED);
    // not referenced by any anchor, view, ghost or concept
    expect(data.files["src/config.ts"]).toBeUndefined();
    expect(data.files["README.md"]).toBeUndefined();
    expect(readFile(demo, "small.html").length).toBeLessThan(readFile(demo, "all.html").length);
  });

  it("referenced covers the nodes of graph views, the participants of sequence views and the ghosts one hop out", async () => {
    const dir = cloneDir(demo);
    expect((await xpl(dir, "new", "other")).code).toBe(0);
    const apply = (patch: object) =>
      invoke(["apply", "other", "-"], { cwd: dir, stdin: JSON.stringify(patch) });
    const filesOf = async (out: string) => {
      const { code } = await invoke(["bundle", "other", "-o", out, "--draft", "--root", dir], {
        cwd: dir,
        env: viewerEnv,
      });
      expect(code).toBe(0);
      return Object.keys(bundleOf(readFile(dir, out)).files).sort();
    };

    // a graph view of one file and nothing else, no anchors: the file, and what its dashed stubs lead to
    // (the files that call it: main, runner and the test; worker only mentions its types, which a view does
    // not draw by default; nor bus, metrics, config or the docs)
    expect(
      (
        await apply({
          views: [
            { id: "view:queue", type: "graph", title: "Queue", include: ["file:src/queue.ts"] },
          ],
        })
      ).code,
    ).toBe(0);
    expect(await filesOf("queue.html")).toEqual([
      "src/main.ts",
      "src/queue.ts",
      "src/runner.ts",
      "test/retry.test.ts",
    ]);

    // a group and a directory in a graph view: their files; a sequence view: its participants, with no anchors
    expect(
      (
        await apply({
          nodes: [{ id: "grp:cfg", label: "Config", members: ["file:src/config.ts"] }],
          views: [
            { id: "view:queue", type: "graph", include: ["dir:config"] },
            {
              id: "view:groups",
              type: "graph",
              title: "Groups",
              include: ["grp:cfg", "dir:test"],
            },
            {
              id: "view:flow",
              type: "sequence",
              title: "Flow",
              participants: ["file:src/bus.ts", "file:src/metrics.ts"],
              steps: [
                {
                  id: "flow:1",
                  from: "file:src/bus.ts",
                  to: "file:src/metrics.ts",
                  label: "deliver",
                  kind: "async",
                },
              ],
            },
          ],
        })
      ).code,
    ).toBe(0);
    const files = await filesOf("groups.html");
    for (const file of [
      "config/default.yaml", // dir:config
      "src/config.ts", // grp:cfg
      "test/retry.test.ts", // dir:test
      "src/bus.ts", // participants of view:flow
      "src/metrics.ts",
    ]) {
      expect(files, file).toContain(file);
    }
    expect(files).not.toContain("README.md");
    expect(files).not.toContain("package.json");
  });

  it("embeds what a dashed stub shows when clicked, and honours excludeFiles and the stub policy", async () => {
    const dir = cloneDir(demo);
    expect((await xpl(dir, "new", "solo")).code).toBe(0);
    const apply = (view: object) =>
      invoke(["apply", "solo", "-"], {
        cwd: dir,
        stdin: JSON.stringify({
          views: [{ id: "view:solo", type: "graph", title: "Solo", ...view }],
        }),
      });
    const filesOf = async (out: string) => {
      const { code } = await invoke(["bundle", "solo", "-o", out, "--draft", "--root", dir], {
        cwd: dir,
        env: viewerEnv,
      });
      expect(code).toBe(0);
      return Object.keys(bundleOf(readFile(dir, out)).files).sort();
    };
    expect((await apply({ include: ["file:src/queue.ts"] })).code).toBe(0);
    expect(await filesOf("a.html")).toEqual([
      "src/main.ts",
      "src/queue.ts",
      "src/runner.ts",
      "test/retry.test.ts",
    ]);
    // the references of files the view excludes are not shown at its edge, so their files are not needed
    expect((await apply({ excludeFiles: ["test/**"] })).code).toBe(0);
    expect(await filesOf("b.html")).toEqual(["src/main.ts", "src/queue.ts", "src/runner.ts"]);
    // no stubs, no ghosts: the view shows its own nodes and nothing beyond
    expect((await apply({ excludeFiles: null, stubs: { mode: "none" } })).code).toBe(0);
    expect(await filesOf("c.html")).toEqual(["src/queue.ts"]);
  });

  it("prints the output path as given: relative as typed, absolute when absolute", async () => {
    const relative = await bundle(demo, "-o", "./nested-as-typed.html");
    expect(relative.out).toMatch(/^wrote \.\/nested-as-typed\.html \(/);
    const target = join(demo, "abs.html");
    const absolute = await bundle(demo, "-o", target);
    expect(absolute.out).toMatch(
      new RegExp(`^wrote ${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(`),
    );
    expect(existsSync(target)).toBe(true);
    const json = JSON.parse((await bundle(demo, "-o", target, "--json")).out);
    expect(json).toMatchObject({ path: target, absolutePath: target });
    const asTyped = JSON.parse((await bundle(demo, "-o", "./j2.html", "--json")).out);
    expect(asTyped).toMatchObject({ path: "./j2.html", absolutePath: join(demo, "j2.html") });
  });

  it("--mode present and --tour set the initial mode and tour", async () => {
    await bundle(demo, "-o", "present.html", "--mode", "present");
    expect(bundleOf(readFile(demo, "present.html"))).toMatchObject({ mode: "present" });
    expect(bundleOf(readFile(demo, "present.html")).tour).toBeUndefined();

    const withTour = await bundle(demo, "-o", "tour.html", "--tour", "intro");
    expect(withTour.code).toBe(0);
    expect(withTour.out).toContain("mode present, tour tour:intro");
    expect(bundleOf(readFile(demo, "tour.html"))).toMatchObject({
      mode: "present",
      tour: "tour:intro",
    });

    await bundle(demo, "-o", "tour2.html", "--tour", "tour:intro", "--mode", "explore");
    expect(bundleOf(readFile(demo, "tour2.html"))).toMatchObject({
      mode: "explore",
      tour: "tour:intro",
    });

    const unknown = await bundle(demo, "-o", "x.html", "--tour", "nope");
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('no tour "nope"');
    expect(unknown.err).toContain("tours: tour:intro");
    const typo = await bundle(demo, "-o", "x.html", "--tour", "intr");
    expect(typo.err).toContain(
      'no tour "intr" in .explainer/demo.explainer.json. Did you mean: tour:intro?',
    );
    expect(existsSync(join(demo, "x.html"))).toBe(false);
  });

  it("escapes source text so it cannot break out of the script element", async () => {
    const dir = cloneDir(demo);
    const hostile = 'const a = "</script><script>alert(1)</script>"; // <!--  ';
    editFile(dir, "src/bus.ts", (text) => `${text}\n${hostile}\n`);
    const index = await reindex(dir);
    const { code } = await bundle(dir, "-o", "out.html", "--index", index, "--allow-drift");
    expect(code).toBe(0);
    const html = readFile(dir, "out.html");
    expect(html).not.toContain("<script>alert(1)");
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(bundleOf(html).files["src/bus.ts"]).toContain(hostile);
  });

  it("resolves -o against the working directory, not the root", async () => {
    const elsewhere = makeTempDir();
    const { code, out } = await invoke(["bundle", "demo", "-o", "here.html", "--root", demo], {
      cwd: elsewhere,
      env: viewerEnv,
    });
    expect(code).toBe(0);
    expect(out).toContain("wrote here.html");
    expect(existsSync(join(elsewhere, "here.html"))).toBe(true);
    expect(existsSync(join(demo, "here.html"))).toBe(false);
  });

  it("--json describes the result", async () => {
    const { code, out } = await bundle(demo, "-o", "j.html", "--json");
    const json = JSON.parse(out);
    expect(code).toBe(0);
    expect(json).toMatchObject({
      ok: true,
      path: "j.html",
      mode: "explore",
      files: { embedded: 8, choice: "referenced", indexed: 12 },
    });
    expect(json.files.embeddedBytes).toBeGreaterThan(1000);
    expect(json.files.indexedBytes).toBeGreaterThan(json.files.embeddedBytes);
    expect(json.bytes).toBe(Buffer.byteLength(readFile(demo, "j.html")));
    expect(json.index.commit).toMatch(/^wt-/);
  });

  it("re-resolves the anchors: code that moved is highlighted at its new lines (status moved, not a stale ok)", async () => {
    const dir = cloneDir(demo);
    // three lines above onJobCompleted: its text (and hash) is the same, at new lines
    editFile(dir, "src/metrics.ts", (text) => `// one\n// two\n// three\n${text}`);
    const index = await reindex(dir);
    const stored = readJson<any>(dir, ".explainer/demo.explainer.json");
    const before = anchorOf(stored, "onJobCompleted");
    expect(before.resolved.status).toBe("ok"); // the cache in the file still says the old lines

    const { code, err } = await bundle(dir, "-o", "moved.html", "--index", index);
    expect(err).toBe("");
    expect(code).toBe(0);
    const data = bundleOf(readFile(dir, "moved.html"));
    const after = anchorOf(data.explainer, "onJobCompleted");
    const symbol = data.index.symbols.find((s) => s.id === "src/metrics.ts#onJobCompleted")!;
    expect(after.hash).toBe(symbol.hash);
    expect(after.resolved.status).toBe("moved");
    expect(after.resolved.range.startLine).toBe(symbol.range.startLine);
    expect(after.resolved.range.startLine).toBe(before.resolved.range.startLine + 3);
    // nothing is written back
    expect(readJson<any>(dir, ".explainer/demo.explainer.json")).toEqual(stored);
  });

  it("refuses an explainer whose anchors drifted, and --allow-drift writes it with the drift on the page", async () => {
    const dir = cloneDir(demo);
    editFile(dir, "src/queue.ts", (text) =>
      text.replace(
        "const job: Job | undefined = due[0];",
        "const job: Job | undefined = due.at(0);",
      ),
    );
    const index = await reindex(dir);

    const refused = await bundle(dir, "-o", "drift.html", "--index", index);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(
      ".explainer/demo.explainer.json does not match the code: 1 anchor drifted (its code changed), so the page would point at the wrong code",
    );
    expect(refused.err).toContain("run `xpl resolve demo --write`");
    expect(refused.err).toContain("--allow-drift");
    expect(existsSync(join(dir, "drift.html"))).toBe(false);

    const allowed = await bundle(
      dir,
      "-o",
      "drift.html",
      "--index",
      index,
      "--allow-drift",
      "--json",
    );
    expect(allowed.code).toBe(0);
    const json = JSON.parse(allowed.out);
    expect(json.anchors).toMatchObject({ drifted: 1, missing: 0 });
    expect(json.warnings.join("\n")).toContain(
      "1 anchor drifted (its code changed): the page says so",
    );
    const data = bundleOf(readFile(dir, "drift.html"));
    expect(anchorOf(data.explainer, "Queue.pop").resolved.status).toBe("drifted");
  });

  it("usage and environment errors", async () => {
    const noOut = await bundle(demo);
    expect(noOut.code).toBe(2);
    expect(noOut.err).toContain("missing -o <out.html>");
    const badFiles = await bundle(demo, "-o", "x.html", "--files", "some");
    expect(badFiles.code).toBe(2);
    const badMode = await bundle(demo, "-o", "x.html", "--mode", "loud");
    expect(badMode.code).toBe(2);
    const noExplainer = await bundle(demo, "nope", "-o", "x.html");
    expect(noExplainer.code).toBe(2); // two positionals: unexpected argument
    const missingViewer = await invoke(["bundle", "demo", "-o", "x.html", "--root", demo], {
      cwd: demo,
      env: { XPL_VIEWER_HTML: "/no/such/viewer.html" },
    });
    expect(missingViewer.code).toBe(1);
    expect(missingViewer.err).toContain("XPL_VIEWER_HTML points to /no/such/viewer.html");
  });

  it("says to run npm run build when there is no viewer build", () => {
    expect(() => findViewerHtml({}, [])).toThrow(/run `npm run build`/);
    expect(findViewerHtml({}, [resolve(demo, "nope.html"), resolve(demo, "out.html")])).toBe(
      resolve(demo, "out.html"),
    );
    // the search order: next to the bundle, then the viewer package's build, then the CLI's copy
    const candidates = viewerHtmlCandidates();
    expect(candidates[0]).toMatch(/viewer\.html$/);
    expect(candidates[1]).toMatch(/packages[\\/]viewer[\\/]dist[\\/]index\.html$/);
    expect(candidates[2]).toMatch(/packages[\\/]cli[\\/]dist[\\/]viewer\.html$/);
  });

  it.skipIf(!viewerEnvBuilt())(
    "uses the real viewer build when it exists (no XPL_VIEWER_HTML)",
    async () => {
      const { code } = await invoke(["bundle", "demo", "-o", "real.html", "--root", demo], {
        cwd: demo,
        env: {},
      });
      expect(code).toBe(0);
      const html = readFile(demo, "real.html");
      expect(html.length).toBeGreaterThan(STUB_VIEWER_HTML.length * 10);
      expect(bundleOf(html).explainer.title).toBe("Job runner");
      expect(readFileSync(join(demo, "real.html"), "utf8")).toContain("xpl-data");
    },
  );
});

function viewerEnvBuilt(): boolean {
  return viewerHtmlCandidates().some((candidate) => existsSync(candidate));
}

describe("xpl bundle: what the reader would see by mistake", () => {
  it("refuses unfinished text before writing ready HTML, with an explicit draft path", async () => {
    const dir = cloneDir(demo);
    const scratch = makeTempDir("xpl-bundle-todo-");
    const patch = join(scratch, "todo-patch.json");
    writeFileSync(
      patch,
      JSON.stringify({
        concepts: [{ id: "concept:todo", label: "Retries", summary: "TODO: say what it does" }],
      }),
    );
    expect((await xpl(dir, "apply", "demo", patch)).code).toBe(0);
    const out = join(scratch, "page.html");
    const r = await bundle(dir, "-o", out);
    expect(r.code).toBe(1);
    expect(r.err).toContain("todo-left");
    expect(r.err).toContain("concept:todo.summary");
    expect(existsSync(out)).toBe(false);
    const draft = await bundle(dir, "-o", out, "--draft");
    expect(draft.code).toBe(0);
    expect(bundleOf(readFileSync(out, "utf8")).exportInfo).toMatchObject({
      status: "draft",
      report: { ready: false, scope: "workspace" },
    });
  });
});

describe("xpl ready", () => {
  it("opts into review policy through ready and bundle without changing the default export", async () => {
    const dir = cloneDir(demo);
    expect((await xplJson<any>(dir, "ready", "demo")).json.review).toEqual({
      status: "unchecked",
      required: false,
    });
    const required = await xplJson<any>(dir, "ready", "demo", "--require-review");
    expect(required.code).toBe(1);
    expect(required.json.findings.filter((f: any) => f.code === "review-required")).toHaveLength(1);
    const out = join(makeTempDir("xpl-review-policy-"), "reviewed.html");
    const blocked = await bundle(dir, "-o", out, "--require-review");
    expect(blocked.code).toBe(1);
    expect(existsSync(out)).toBe(false);
    expect((await bundle(dir, "-o", out)).code).toBe(0);
    const snapshot = parseBundle(JSON.stringify(bundleOf(readFileSync(out, "utf8"))));
    const scope = { content: "all" as const, source: "repository" as const };
    const review = {
      reviewer: "Ada",
      reviewedAt: "2026-10-04T12:00:00Z",
      scope,
      omissions: [],
      fingerprint: reviewFingerprint(
        snapshot.explainer,
        snapshot.index,
        new TextCache((path) => readFile(dir, path)),
        scope,
      ),
    };
    const applied = await invoke(["apply", "demo", "-", "--actor", "user"], {
      cwd: dir,
      stdin: JSON.stringify({ review }),
    });
    expect(applied.code, applied.err).toBe(0);
    expect((await xplJson<any>(dir, "ready", "demo", "--require-review")).code).toBe(0);
    const exported = await bundle(dir, "-o", out, "--require-review");
    expect(exported.code, exported.err).toBe(0);
    const saved = bundleOf(readFileSync(out, "utf8"));
    expect(saved.exportInfo?.report.review).toEqual({ status: "reviewed", required: true });
    expect(saved.files["README.md"]).toBe(readFile(dir, "README.md"));
  });

  it("checks a real untouched path draft without lint, refuses HTML, and records machine findings before output", async () => {
    const dir = cloneDir(await indexedFixture());
    const scratch = makeTempDir("xpl-ready-path-");
    const patch = join(scratch, "path.json");
    expect((await xpl(dir, "new", "path")).code).toBe(0);
    const drafted = await xpl(
      dir,
      "draft",
      "path",
      "path",
      "src/runner.ts#Runner.dispatch",
      "-o",
      patch,
    );
    expect(drafted.code, drafted.err).toBe(0);
    expect((await xpl(dir, "apply", "path", patch)).code).toBe(0);
    expect((await xpl(dir, "validate", "path")).code).toBe(0);
    const checked = await xplJson<any>(
      dir,
      "ready",
      "path",
      "--note",
      "This is an unfinished draft.",
    );
    expect(checked.code).toBe(1);
    expect(checked.json).toMatchObject({
      ok: false,
      ready: false,
      scope: "workspace",
      decisionNote: "This is an unfinished draft.",
    });
    expect(checked.json.findings.filter((f: any) => f.code === "todo-left")).toHaveLength(28);
    const out = join(scratch, "ready.html");
    const exported = await invoke(["bundle", "path", "-o", out, "--json"], {
      cwd: dir,
      env: viewerEnv,
    });
    expect(exported.code).toBe(1);
    const { ok: _ok, decisionNote: _note, ...report } = checked.json;
    expect(JSON.parse(exported.out).readiness).toEqual(report);
    expect(existsSync(out)).toBe(false);
  });

  it("exports a completed fixture with the same ready report, embedded source and provenance", async () => {
    const dir = cloneDir(demo);
    const checked = await xplJson<any>(
      dir,
      "ready",
      "demo",
      "--note",
      "The tour leaves helper calls for the code reader.",
    );
    expect(checked.code).toBe(0);
    expect(checked.json).toMatchObject({ ok: true, ready: true, errors: 0, scope: "workspace" });
    const out = join(makeTempDir("xpl-ready-complete-"), "complete.html");
    const exported = await bundle(
      dir,
      "-o",
      out,
      "--note",
      "The tour leaves helper calls for the code reader.",
    );
    expect(exported.code, exported.err).toBe(0);
    const saved = bundleOf(readFileSync(out, "utf8"));
    const { ok: _ok, ...report } = checked.json;
    expect(saved.exportInfo).toEqual({ status: "ready", report });
    expect(saved.files["src/runner.ts"]).toBe(readFile(dir, "src/runner.ts"));
    expect(saved.explainer.nodes[0]!.provenance).toEqual(
      readJson(dir, ".explainer/demo.explainer.json").nodes[0].provenance,
    );
  });
});
