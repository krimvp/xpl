import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { BUNDLE_SCHEMA, parseBundle, type ViewerBundle } from "@xpl/core";
import { findViewerHtml, viewerHtmlCandidates } from "../src/viewer-html.js";
import {
  cloneDir,
  editFile,
  indexedFixture,
  invoke,
  makeTempDir,
  PATCH_PATH,
  readFile,
  STUB_VIEWER_HTML,
  writeViewerStub,
  xpl,
} from "./helpers.js";

let demo: string;
let viewerEnv: { XPL_VIEWER_HTML: string };

beforeAll(async () => {
  const indexed = await indexedFixture();
  demo = cloneDir(indexed);
  await xpl(demo, "new", "demo");
  expect((await xpl(demo, "apply", "demo", PATCH_PATH)).code).toBe(0);
  viewerEnv = { XPL_VIEWER_HTML: writeViewerStub() };
});

const DATA_SCRIPT = /<script id="xpl-data" type="application\/json">([\s\S]*?)<\/script>/;

function bundleOf(html: string): ViewerBundle {
  const match = DATA_SCRIPT.exec(html);
  expect(match, "the page has an xpl-data script").not.toBeNull();
  return parseBundle(match![1]!);
}

function bundle(dir: string, ...argv: string[]) {
  return invoke(["bundle", "demo", ...argv, "--root", dir], { cwd: dir, env: viewerEnv });
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
  it("writes one HTML file with the xpl-data script, and the payload parses back", async () => {
    const { code, out, err } = await bundle(demo, "-o", "out.html");
    expect(err).toBe("");
    expect(code).toBe(0);
    // the default embeds what the explainer needs, and says how much that is and what --files all would add
    expect(out).toMatch(
      /^wrote out\.html \(\d+(\.\d)? KB\): \.explainer\/demo\.explainer\.json, 8 of 12 files embedded \(referenced: \d+(\.\d)? KB of source; --files all adds 4 files, \d+(\.\d)? KB\), mode explore$/,
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
    expect(out).toMatch(
      /^wrote all\.html \(\d+(\.\d)? KB\): \.explainer\/demo\.explainer\.json, 12 files embedded \(all: \d+(\.\d)? KB of source\), mode explore$/,
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
      const { code } = await invoke(["bundle", "other", "-o", out, "--root", dir], {
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
      const { code } = await invoke(["bundle", "solo", "-o", out, "--root", dir], {
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
    const { code } = await bundle(dir, "-o", "out.html");
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
