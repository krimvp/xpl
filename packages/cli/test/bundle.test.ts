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

describe("xpl bundle", () => {
  it("writes one HTML file with the xpl-data script, and the payload parses back", async () => {
    const { code, out, err } = await bundle(demo, "-o", "out.html");
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toMatch(
      /^wrote out\.html \(\d+(\.\d)? KB\): \.explainer\/demo\.explainer\.json, 12 files embedded \(all\), mode explore$/,
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
    // every indexed file, with its exact text
    expect(Object.keys(data.files).sort()).toEqual(data.index.files.map((f) => f.path).sort());
    expect(data.files["src/runner.ts"]).toBe(readFile(demo, "src/runner.ts"));
    expect(data.files["config/default.yaml"]).toBe(readFile(demo, "config/default.yaml"));
  });

  it("--files referenced embeds only what the explainer points at", async () => {
    const { code, out } = await bundle(demo, "-o", "small.html", "--files", "referenced");
    expect(code).toBe(0);
    expect(out).toContain("(referenced)");
    const data = bundleOf(readFile(demo, "small.html"));
    expect(Object.keys(data.files).sort()).toEqual([
      "config/default.yaml",
      "src/metrics.ts",
      "src/queue.ts",
      "src/runner.ts",
      "src/worker.ts",
      "test/retry.test.ts",
    ]);
    // not referenced by any anchor, view or concept
    expect(data.files["src/main.ts"]).toBeUndefined();
    expect(data.files["src/config.ts"]).toBeUndefined();
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
      files: { embedded: 12, choice: "all" },
    });
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
