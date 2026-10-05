import { request } from "node:http";
import { realpathSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  BUNDLE_SCHEMA,
  artifactIdentity,
  makeUserEdit,
  asIndexModel,
  reviewFingerprint,
  TextCache,
  collectAnchors,
  parseBundle,
  type Explainer,
  type ViewerBundle,
} from "@xpl/core";
import { run } from "../src/cli.js";
import { DEFAULT_PORT } from "../src/commands/view.js";
import type { ViewServer } from "../src/server.js";
import {
  bundleOf,
  cloneDir,
  editFile,
  indexedFixture,
  invoke,
  PATCH_PATH,
  readFile,
  readJson,
  writeViewerStub,
  xpl,
  xplJson,
  type Invocation,
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

/** `xpl view` running in-process, stopped by aborting its signal. */
interface Running {
  server: ViewServer;
  url: string;
  done: Promise<Invocation>;
  stop(): Promise<Invocation>;
}

const running: Running[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
});

async function serve(dir: string, ...extra: string[]): Promise<Running> {
  const controller = new AbortController();
  let onServer!: (server: ViewServer) => void;
  const ready = new Promise<ViewServer>((resolve) => (onServer = resolve));
  const done = invoke(["view", "demo", "--port", "0", "--no-open", "--root", dir, ...extra], {
    cwd: dir,
    env: viewerEnv,
    signal: controller.signal,
    onServer,
  });
  const server = await Promise.race([
    ready,
    done.then((result) => {
      throw new Error(`xpl view exited early: ${result.err || result.out}`);
    }),
  ]);
  const handle: Running = {
    server,
    url: server.url.replace(/\/$/, ""),
    done,
    stop: async () => {
      controller.abort();
      return done;
    },
  };
  running.push(handle);
  return handle;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

async function json(res: Response): Promise<any> {
  return JSON.parse(await res.text());
}

describe("xpl view", () => {
  it("version-checks bounded edits and persists undo without replacing concurrent fields", async () => {
    const dir = cloneDir(demo);
    const view = await serve(dir);
    const snapshot = async () => parseBundle(await (await fetch(`${view.url}/api/bundle`)).text());
    const initial = await snapshot();
    const edit = makeUserEdit(
      initial.explainer,
      asIndexModel(initial.index),
      "nodes",
      "file:src/runner.ts",
      { summary: "Corrected runner summary." },
    );
    const attachment = { root: realpathSync(dir), guide: ".explainer/demo.explainer.json" };
    const put = (version: unknown, edits: unknown, expected: unknown = attachment) =>
      fetch(`${view.url}/api/edits`, {
        method: "PUT",
        headers: {
          ...JSON_HEADERS,
          ...(expected ? { "X-Xpl-Attachment": encodeURIComponent(JSON.stringify(expected)) } : {}),
        },
        body: JSON.stringify({ version, edits }),
      });
    const version = artifactIdentity(initial.explainer, initial.index);
    const saved = await put(version, [edit]);
    expect(saved.status).toBe(200);
    const { inverse } = await json(saved);
    expect(
      readJson(dir, ".explainer/demo.explainer.json").nodes.find((n: any) => n.id === edit.id)
        .summary,
    ).toBe("Corrected runner summary.");
    const savedSnapshot = await snapshot();
    const savedVersion = artifactIdentity(savedSnapshot.explainer, savedSnapshot.index);
    for (const wrong of [
      { ...attachment, root: attachment.root + "-copy" },
      { ...attachment, guide: "other" },
    ]) {
      const refused = await put(savedVersion, inverse, wrong);
      expect(refused.status).toBe(409);
      expect(await json(refused)).toMatchObject({
        error: "This address serves a different repository or guide. Open that service's own URL.",
      });
    }
    expect((await put(savedVersion, inverse, null)).status).toBe(400);
    expect(
      readJson(dir, ".explainer/demo.explainer.json").nodes.find((n: any) => n.id === edit.id)
        .summary,
    ).toBe("Corrected runner summary.");
    expect((await put(version, [edit])).status).toBe(409);
    expect(
      (
        await invoke(["apply", "demo", "-", "--actor", "user"], {
          cwd: dir,
          stdin: JSON.stringify({ nodes: [{ id: edit.id, detail: "Concurrent detail." }] }),
        })
      ).code,
    ).toBe(0);
    const current = await snapshot();
    const undo = await put(artifactIdentity(current.explainer, current.index), inverse);
    expect(undo.status).toBe(200);
    const disk = readJson(dir, ".explainer/demo.explainer.json");
    expect(disk.nodes.find((n: any) => n.id === edit.id).detail).toBe("Concurrent detail.");
    expect(disk.nodes.find((n: any) => n.id === edit.id).summary).toBe(
      initial.explainer.nodes.find((n) => n.id === edit.id)?.summary,
    );
    const restored = await snapshot();
    expect(
      (
        await put(artifactIdentity(restored.explainer, restored.index), [
          { ...edit, after: { provenance: { origin: "llm" } } },
        ])
      ).status,
    ).toBe(400);
  });

  it("records and removes author reviews on disk, rejects stale inspected content, and embeds broad evidence", async () => {
    const dir = cloneDir(demo);
    const view = await serve(dir);
    const initial = parseBundle(await (await fetch(`${view.url}/api/export`)).text());
    const scope = { content: "all" as const, source: "repository" as const };
    // Repository review reads every indexed file, including source not referenced by a diagram.
    const texts = new TextCache((path) => readFile(dir, path));
    const review = {
      reviewer: "Ada",
      reviewedAt: "2026-10-04T12:00:00Z",
      scope,
      omissions: ["No runtime tests were run."],
      fingerprint: reviewFingerprint(initial.explainer, initial.index, texts, scope),
    };
    const put = (body: unknown) =>
      fetch(`${view.url}/api/review`, {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });
    const saved = await put({ review });
    expect(saved.status).toBe(200);
    expect(readJson(dir, ".explainer/demo.explainer.json").review).toEqual({
      ...review,
      sourceCommit: initial.index.commit,
    });
    const exported = parseBundle(await (await fetch(`${view.url}/api/export`)).text());
    expect(exported.exportInfo?.report.review).toEqual({ status: "reviewed", required: false });
    expect(exported.files["README.md"]).toBe(readFile(dir, "README.md"));
    const edited = await fetch(`${view.url}/api/views/view:overview`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "Edited after inspection" }),
    });
    expect(edited.status).toBe(200);
    const stale = await put({ review });
    expect(stale.status).toBe(400);
    expect(await json(stale)).toMatchObject({
      issues: [{ code: "review", path: "review.fingerprint" }],
    });
    expect(readJson(dir, ".explainer/demo.explainer.json").review).toEqual({
      ...review,
      sourceCommit: initial.index.commit,
    });
    expect((await put({ review: null, title: "Bypass user patch" })).status).toBe(400);
    expect((await put({ review: null })).status).toBe(200);
    expect(readJson(dir, ".explainer/demo.explainer.json").review).toBeUndefined();
  });

  it("refuses review writes when a live guide is replaced by an external symlink", async () => {
    const { symlinkSync, unlinkSync } = await import("node:fs");
    const dir = cloneDir(demo);
    const outside = cloneDir(demo);
    const view = await serve(dir);
    const guide = ".explainer/demo.explainer.json";
    const before = readFile(outside, guide);
    // A valid clear would normally write this guide; the repository fence must run first.
    unlinkSync(join(dir, guide));
    symlinkSync(join(outside, guide), join(dir, guide));
    const response = await fetch(`${view.url}/api/review`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ review: null }),
    });
    expect(response.status).toBe(403);
    expect(await json(response)).toMatchObject({
      error: "service artifact path leaves its repository",
    });
    expect(readFile(outside, guide)).toBe(before);
    expect(readFile(dir, guide)).toBe(before);
  });

  it("export snapshots include source behind stubs and check current workspace hashes", async () => {
    const dir = cloneDir(demo);
    const view = await serve(dir);
    const before = parseBundle(await (await fetch(`${view.url}/api/export`)).text());
    expect(before.exportInfo?.report.scope).toBe("workspace");
    expect(before.exportInfo?.report.findings.filter((f) => f.code === "stale-index")).toEqual([]);
    expect(before.files["src/main.ts"]).toBe(readFile(dir, "src/main.ts"));
    expect(Object.keys(before.files).sort()).toEqual([
      "config/default.yaml",
      "src/bus.ts",
      "src/main.ts",
      "src/metrics.ts",
      "src/queue.ts",
      "src/runner.ts",
      "src/worker.ts",
      "test/retry.test.ts",
    ]);
    editFile(dir, "src/queue.ts", (text) =>
      text.replace("Date.now() + delayMs", "Date.now() + delayMs + 7"),
    );
    const after = parseBundle(await (await fetch(`${view.url}/api/export`)).text());
    expect(after.exportInfo?.report).toMatchObject({ ready: false, scope: "workspace" });
    expect(after.exportInfo!.report.findings.filter((f) => f.code === "stale-index")).toMatchObject(
      [{ severity: "error", field: "index", hint: expect.stringContaining("xpl index") }],
    );
    expect(after.files["src/queue.ts"]).toContain("Date.now() + delayMs + 7");
  });

  it("keeps a viewer edit and its ownership while CLI apply waits for stdin", async () => {
    const dir = cloneDir(demo);
    const view = await serve(dir);
    let resume!: (text: string) => void;
    let reading!: () => void;
    const waiting = new Promise<void>((resolve) => {
      reading = resolve;
    });
    const input = new Promise<string>((resolve) => {
      resume = resolve;
    });
    const apply = run(["apply", "demo", "-"], {
      cwd: dir,
      out: () => {},
      err: () => {},
      readStdin: () => {
        reading();
        return input;
      },
    });
    await waiting;
    const saved = await fetch(`${view.url}/api/views/view:overview`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "User's title" }),
    });
    expect(saved.status).toBe(200);
    resume(
      JSON.stringify({ title: "CLI title", views: [{ id: "view:overview", title: "LLM title" }] }),
    );
    expect(await apply).toBe(0);
    const explainer = readJson(dir, ".explainer/demo.explainer.json");
    expect(explainer.title).toBe("CLI title");
    const overview = explainer.views.find((v: any) => v.id === "view:overview");
    expect(overview.title).toBe("User's title");
    expect(overview.provenance.userFields).toContain("title");
  });

  it("serializes independent viewer servers writing the same explainer", async () => {
    const dir = cloneDir(demo);
    const first = await serve(dir);
    const second = await serve(dir);
    const results = await Promise.all([
      fetch(`${first.url}/api/views/view:overview`, {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ title: "From first" }),
      }),
      fetch(`${second.url}/api/views/view:overview`, {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ layout: {} }),
      }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const overview = readJson(dir, ".explainer/demo.explainer.json").views.find(
      (v: any) => v.id === "view:overview",
    );
    expect(overview).toMatchObject({ title: "From first", layout: {} });
    expect(overview.provenance.userFields).toEqual(expect.arrayContaining(["title", "layout"]));
  });

  it("prints the URL, serves on 127.0.0.1, and stops when told to", async () => {
    const view = await serve(demo);
    expect(view.server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(view.server.host).toBe("127.0.0.1");
    expect(view.server.port).toBeGreaterThan(0);
    const result = await view.stop();
    expect(result.code).toBe(0);
    expect(result.out).toBe(
      `serving .explainer/demo.explainer.json at ${view.server.url}  (Ctrl-C to stop)`,
    );
    await expect(fetch(`${view.url}/api/bundle`)).rejects.toThrow();
  });

  it("--json prints the URL as data", async () => {
    const view = await serve(demo, "--json");
    const result = await view.stop();
    const data = JSON.parse(result.out);
    expect(data).toMatchObject({
      ok: true,
      host: "127.0.0.1",
      port: view.server.port,
      url: view.server.url,
    });
  });

  it("GET / is the viewer page with the bundle injected", async () => {
    const view = await serve(demo);
    const res = await fetch(`${view.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await res.text();
    expect(html).toContain("<title>stub viewer</title>");
    const data = bundleOf(html);
    expect(data.schema).toBe(BUNDLE_SCHEMA);
    expect(data.server).toEqual({
      api: "/api",
      attachment: { root: realpathSync(demo), guide: ".explainer/demo.explainer.json" },
    });
    expect(data.mode).toBe("explore");
    expect(data.explainer.title).toBe("Job runner");
    // the files referenced by anchors and views; the viewer fetches the rest lazily (what lies behind a stub too)
    expect(Object.keys(data.files).sort()).toEqual([
      "config/default.yaml",
      "src/metrics.ts",
      "src/queue.ts",
      "src/runner.ts",
      "src/worker.ts",
      "test/retry.test.ts",
    ]);
    expect(data.files["src/runner.ts"]).toBe(readFile(demo, "src/runner.ts"));
    expect(data.index.files).toHaveLength(12);
  });

  it("GET /api/bundle returns the same bundle as JSON", async () => {
    const view = await serve(demo);
    const res = await fetch(`${view.url}/api/bundle`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const bundle = (await json(res)) as ViewerBundle;
    expect(bundle.schema).toBe(BUNDLE_SCHEMA);
    expect(bundle.server).toEqual({
      api: "/api",
      attachment: { root: realpathSync(demo), guide: ".explainer/demo.explainer.json" },
    });
    expect(bundle.explainer.views).toHaveLength(2);
    expect(Object.keys(bundle.files)).toContain("src/runner.ts");
    const html = await (await fetch(`${view.url}/`)).text();
    expect(bundleOf(html)).toEqual(bundle);
  });

  it("GET /api/file serves indexed files as text and rejects everything else", async () => {
    const view = await serve(demo);
    const ok = await fetch(`${view.url}/api/file?path=src/queue.ts`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await ok.text()).toBe(readFile(demo, "src/queue.ts"));
    // files the bundle does not embed are available lazily
    expect((await fetch(`${view.url}/api/file?path=src/main.ts`)).status).toBe(200);
    expect(await (await fetch(`${view.url}/api/file?path=README.md`)).text()).toBe(
      readFile(demo, "README.md"),
    );

    for (const bad of [
      "../secret.txt",
      "src/../src/queue.ts",
      "%2e%2e/%2e%2e/etc/passwd",
      "..%2f..%2fetc%2fpasswd",
      "/etc/passwd",
      "src\\queue.ts",
      "src/queue.ts%00",
      "",
    ]) {
      const res = await fetch(`${view.url}/api/file?path=${bad}`);
      expect(res.status, `path=${bad}`).toBe(400);
      expect((await json(res)).error).toContain("repo-relative path");
    }
    // well-formed but not in the index: the index itself, git internals, unknown files
    for (const unknown of [".explainer/demo.explainer.json", "package-lock.json", "src/nope.ts"]) {
      const res = await fetch(`${view.url}/api/file?path=${unknown}`);
      expect(res.status, unknown).toBe(404);
      expect((await json(res)).error).toContain("is not in the index");
    }
    expect((await fetch(`${view.url}/api/file`)).status).toBe(400);
    const suggestions = await json(await fetch(`${view.url}/api/file?path=runner.ts`));
    expect(suggestions.suggestions).toContain("src/runner.ts");
  });

  it("does not follow a symlink out of the repository", async () => {
    const dir = cloneDir(demo);
    const { symlinkSync, writeFileSync, rmSync } = await import("node:fs");
    const outside = join(dir, "..", `outside-${Date.now()}.txt`);
    writeFileSync(outside, "secret");
    rmSync(join(dir, "README.md"));
    symlinkSync(outside, join(dir, "README.md"));
    try {
      const view = await serve(dir);
      const res = await fetch(`${view.url}/api/file?path=README.md`);
      expect(res.status).toBe(404); // README.md is in the (old) index, but it now leaves the root
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it("PUT /api/views/<id> applies a view patch as the user, persists it, and returns the view", async () => {
    const dir = cloneDir(demo);
    const view = await serve(dir);
    const layout = { "file:src/worker.ts": { x: 10, y: 20 } };
    const res = await fetch(`${view.url}/api/views/view:overview`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ layout }),
    });
    expect(res.status).toBe(200);
    const updated = await json(res);
    expect(updated).toMatchObject({ id: "view:overview", type: "graph", layout });
    expect(updated.provenance.userFields).toEqual(["layout"]);
    expect(updated.provenance.origin).toBe("llm"); // still the llm's view; the layout is the user's

    const saved = readJson(dir, ".explainer/demo.explainer.json").views.find(
      (v: any) => v.id === "view:overview",
    );
    expect(saved).toEqual(updated);

    // the encoded id works too, and further edits add to userFields
    const include = [
      "grp:scheduling",
      "file:src/worker.ts",
      "file:src/metrics.ts",
      "file:src/bus.ts",
    ];
    const again = await fetch(`${view.url}/api/views/view%3Aoverview`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ id: "view:overview", type: "graph", include }),
    });
    expect(again.status).toBe(200);
    const twice = await json(again);
    expect(twice.include).toEqual(include);
    expect(twice.provenance.userFields).toEqual(["layout", "include"]);
    expect(twice.layout).toEqual(layout);

    // the bundle shows the edit
    const bundle = (await json(await fetch(`${view.url}/api/bundle`))) as ViewerBundle;
    expect(bundle.explainer.views.find((v) => v.id === "view:overview")).toEqual(twice);
    // an llm patch afterwards keeps the user's fields
    const patch = {
      views: [{ id: "view:overview", type: "graph", layout: {}, title: "Overview (llm)" }],
    };
    const applied = await invoke(["apply", "demo", "-"], {
      cwd: dir,
      stdin: JSON.stringify(patch),
    });
    expect(applied.code).toBe(0);
    const final = readJson(dir, ".explainer/demo.explainer.json").views.find(
      (v: any) => v.id === "view:overview",
    );
    expect(final.title).toBe("Overview (llm)");
    expect(final.layout).toEqual(layout);
    expect(final.include).toEqual(include);
  });

  it("PUT takes the stub policy and folded ghost ids the viewer sends, and records them as the user's", async () => {
    const dir = cloneDir(demo);
    const view = await serve(dir);
    const put = (body: unknown) =>
      fetch(`${view.url}/api/views/view:overview`, {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });
    const res = await put({
      type: "graph",
      stubs: { mode: "top", max: 3 },
      hidden: [
        "ghost:more:out",
        "ghost:rest:file:src/queue.ts",
        "stub:out:file:src/worker.ts->ghost:more:out",
      ],
    });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    const saved = await json(res);
    expect(saved.stubs).toEqual({ mode: "top", max: 3 });
    expect(saved.hidden).toContain("ghost:more:out");
    expect(saved.provenance.userFields).toEqual(["stubs", "hidden"]);
    // an llm patch keeps the user's policy
    const applied = await invoke(["apply", "demo", "-"], {
      cwd: dir,
      stdin: JSON.stringify({
        views: [{ id: "view:overview", type: "graph", stubs: { mode: "all" } }],
      }),
    });
    expect(applied.code).toBe(1);
    expect(applied.out).toContain("nothing was applied");
    expect(
      readJson(dir, ".explainer/demo.explainer.json").views.find(
        (v: any) => v.id === "view:overview",
      ).stubs,
    ).toEqual({ mode: "top", max: 3 });
    // a bad policy or a ghost of a file that is not there is refused
    expect((await put({ type: "graph", stubs: { mode: "loud" } })).status).toBe(400);
    expect((await put({ type: "graph", hidden: ["ghost:rest:file:src/nope.ts"] })).status).toBe(
      400,
    );
  });

  it("PUT rejects an invalid view patch with 400 and the issues, and writes nothing", async () => {
    const dir = cloneDir(demo);
    const before = readFile(dir, ".explainer/demo.explainer.json");
    const view = await serve(dir);
    const res = await fetch(`${view.url}/api/views/view:overview`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ include: ["file:src/nope.ts"] }),
    });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toContain("view patch rejected");
    expect(body.issues[0]).toMatchObject({ severity: "error", path: "views[0].include[0]" });
    expect(body.issues[0].message).toContain("src/nope.ts");
    expect(readFile(dir, ".explainer/demo.explainer.json")).toBe(before);

    const mismatch = await fetch(`${view.url}/api/views/view:overview`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ id: "view:other" }),
    });
    expect(mismatch.status).toBe(400);
    const notObject = await fetch(`${view.url}/api/views/view:overview`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: "[1]",
    });
    expect(notObject.status).toBe(400);
    const notJson = await fetch(`${view.url}/api/views/view:overview`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: "{",
    });
    expect(notJson.status).toBe(400);
    expect((await json(notJson)).error).toContain("not valid JSON");
    // a new view needs its required fields
    const create = await fetch(`${view.url}/api/views/view:mine`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ type: "graph", title: "Mine", include: ["file:src/queue.ts"] }),
    });
    expect(create.status).toBe(200);
    expect(readJson(dir, ".explainer/demo.explainer.json").views.map((v: any) => v.id)).toContain(
      "view:mine",
    );
  });

  it("PUT /api/tours/<id> applies a tour as the user, persists it, and returns the tour", async () => {
    const dir = cloneDir(demo);
    const view = await serve(dir);
    const url = `${view.url}/api/tours/tour:intro`;
    const put = (target: string, body: unknown) =>
      fetch(target, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(body) });
    const original = readJson(dir, ".explainer/demo.explainer.json").tours[0];
    expect(original.steps.map((s: any) => s.id)).toEqual(["t1", "t2"]);

    // Reorder the steps, edit a note, add a step with a code override (anchors as Claude writes them).
    const steps = [
      original.steps[1],
      { ...original.steps[0], note: "Edited by the user." },
      {
        id: "t3",
        view: "view:dispatch",
        focus: ["dispatch:1"],
        code: [{ file: "src/runner.ts", symbol: "Runner.dispatch", role: "definition" }],
        editor: { dimOthers: false, hideFileTree: false },
      },
    ];
    const res = await put(url, { title: "Intro talk (edited)", steps });
    expect(res.status).toBe(200);
    const updated = await json(res);
    expect(updated).toMatchObject({ id: "tour:intro", title: "Intro talk (edited)" });
    expect(updated.steps.map((s: any) => s.id)).toEqual(["t2", "t1", "t3"]);
    expect(updated.steps[1].note).toBe("Edited by the user.");
    expect(updated.steps[2].code[0]).toMatchObject({
      file: "src/runner.ts",
      symbol: "Runner.dispatch",
      role: "definition",
      resolved: { status: "ok" },
    });
    expect(updated.steps[2].code[0].hash).toMatch(/^sha256-v2:/);
    // the tour is the llm's (Claude wrote it), and now records what the user edited
    expect(updated.provenance).toEqual({
      origin: "llm",
      commit: original.provenance.commit,
      userFields: ["title", "steps"],
    });

    const path = ".explainer/demo.explainer.json";
    const saved = readJson(dir, path).tours.find((t: any) => t.id === "tour:intro");
    expect(saved).toEqual(updated);
    // the bundle shows the edit
    const bundle = (await json(await fetch(`${view.url}/api/bundle`))) as ViewerBundle;
    expect(bundle.explainer.tours.find((t) => t.id === "tour:intro")).toEqual(updated);

    // The viewer sends a tour back whole, stored anchors included: nothing changes on disk.
    const before = readFile(dir, path);
    const again = await put(url, { title: updated.title, steps: updated.steps });
    expect(again.status).toBe(200);
    expect(await json(again)).toEqual(updated);
    expect(readFile(dir, path)).toBe(before);

    // Only the fields that are given change (a rename keeps the steps), and the encoded id works.
    const renamed = await put(`${view.url}/api/tours/tour%3Aintro`, { title: "Renamed" });
    expect(renamed.status).toBe(200);
    expect(await json(renamed)).toMatchObject({ title: "Renamed", steps: updated.steps });

    // A new tour needs a title and steps.
    const created = await put(`${view.url}/api/tours/tour:mine`, {
      title: "Mine",
      steps: [{ id: "t1", view: "view:overview", focus: [], note: "Just the view." }],
    });
    expect(created.status).toBe(200);
    expect(await json(created)).toEqual({
      id: "tour:mine",
      title: "Mine",
      steps: [{ id: "t1", view: "view:overview", focus: [], note: "Just the view." }],
      provenance: { origin: "user", commit: original.provenance.commit },
    });
    expect(readJson(dir, path).tours.map((t: any) => t.id)).toEqual(["tour:intro", "tour:mine"]);
    // an llm patch that leaves the tours alone keeps the user's edits
    const applied = await invoke(["apply", "demo", "-"], {
      cwd: dir,
      stdin: JSON.stringify({ title: "Job runner" }),
    });
    expect(applied.code).toBe(0);
    expect(readJson(dir, path).tours.map((t: any) => t.id)).toEqual(["tour:intro", "tour:mine"]);
    // (an llm patch that touches them is refused like any user-owned element: apply-protection.test.ts)
  });

  it("PUT /api/tours/<id> rejects an invalid tour with 400 and the issues, and writes nothing", async () => {
    const dir = cloneDir(demo);
    const before = readFile(dir, ".explainer/demo.explainer.json");
    const view = await serve(dir);
    const put = (id: string, body: unknown) =>
      fetch(`${view.url}/api/tours/${id}`, {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });

    const badView = await put("tour:intro", {
      steps: [{ id: "t1", view: "view:nope", focus: [] }],
    });
    expect(badView.status).toBe(400);
    const body = await json(badView);
    expect(body.error).toContain("tour patch rejected");
    expect(body.issues[0]).toMatchObject({ severity: "error", path: "tours[0].steps[0].view" });
    expect(body.issues[0].message).toContain("view:nope");

    const badFocus = await put("tour:intro", {
      steps: [{ id: "t1", view: "view:overview", focus: ["grp:nope"] }],
    });
    expect(badFocus.status).toBe(400);
    expect((await json(badFocus)).issues[0].path).toBe("tours[0].steps[0].focus[0]");

    const duplicate = await put("tour:intro", {
      steps: [
        { id: "t1", view: "view:overview", focus: [] },
        { id: "t1", view: "view:overview", focus: [] },
      ],
    });
    expect(duplicate.status).toBe(400);
    expect((await json(duplicate)).error).toContain("duplicate");

    const badAnchor = await put("tour:intro", {
      steps: [
        {
          id: "t1",
          view: "view:overview",
          focus: [],
          code: [{ file: "src/nope.ts", role: "definition" }],
        },
      ],
    });
    expect(badAnchor.status).toBe(400);
    expect((await json(badAnchor)).issues[0].message).toContain("src/nope.ts");

    // a new tour needs its title and steps; its id needs the tour: prefix
    expect((await put("tour:fresh", { title: "No steps" })).status).toBe(400);
    expect((await put("tour:fresh", { steps: [] })).status).toBe(400);
    expect((await put("mine", { title: "Bad id", steps: [] })).status).toBe(400);
    expect((await put("tour:intro", { id: "tour:other" })).status).toBe(400);
    expect((await put("tour:intro", [1])).status).toBe(400);
    expect((await put("", { title: "x" })).status).toBe(400);
    expect(readFile(dir, ".explainer/demo.explainer.json")).toBe(before);
  });

  it("refuses writes that are not JSON, cross-origin, from another Host, or too large", async () => {
    const view = await serve(cloneDir(demo));
    const plain = await fetch(`${view.url}/api/views/view:overview`, { method: "PUT", body: "{}" });
    expect(plain.status).toBe(415);
    const plainTour = await fetch(`${view.url}/api/tours/tour:intro`, {
      method: "PUT",
      body: "{}",
    });
    expect(plainTour.status).toBe(415);
    const foreignTour = await fetch(`${view.url}/api/tours/tour:intro`, {
      method: "PUT",
      headers: { ...JSON_HEADERS, Origin: "http://evil.example" },
      body: JSON.stringify({ title: "pwned" }),
    });
    expect(foreignTour.status).toBe(403);
    const foreign = await fetch(`${view.url}/api/requests`, {
      method: "POST",
      headers: { ...JSON_HEADERS, Origin: "http://evil.example" },
      body: JSON.stringify({ elementId: "file:src/queue.ts" }),
    });
    expect(foreign.status).toBe(403);
    const sameOrigin = await fetch(`${view.url}/api/requests`, {
      method: "POST",
      headers: { ...JSON_HEADERS, Origin: view.url },
      body: JSON.stringify({ elementId: "file:src/queue.ts" }),
    });
    expect(sameOrigin.status).toBe(201);
    // too large: the 413 comes back while the body is still being sent (then the server closes)
    const huge = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: view.server.port,
          method: "PUT",
          path: "/api/views/view:overview",
          headers: JSON_HEADERS,
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ layout: { pad: "x".repeat(9 * 1024 * 1024) } }));
    });
    expect(huge).toBe(413);

    // DNS rebinding: a request whose Host is not the server's is refused
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: view.server.port,
          path: "/api/bundle",
          headers: { Host: "evil.example" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
    // localhost is fine
    expect((await fetch(`http://localhost:${view.server.port}/api/bundle`)).status).toBe(200);
  });

  it("POST /api/requests queues an explain-this request for the skill", async () => {
    const dir = cloneDir(demo);
    const view = await serve(dir);
    const res = await fetch(`${view.url}/api/requests`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ elementId: "sym:src/runner.ts#Runner.dispatch", note: "why a loop?" }),
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body).toMatchObject({
      ok: true,
      pending: 0,
      request: {
        elementId: "sym:src/runner.ts#Runner.dispatch",
        note: "why a loop?",
        explainer: "demo",
      },
    });
    expect(new Date(body.request.at).toISOString()).toBe(body.request.at);
    await fetch(`${view.url}/api/requests`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ elementId: "file:src/bus.ts" }),
    });

    const queue = readJson(dir, ".explainer/requests.json");
    expect(queue.map((r: any) => r.elementId)).toEqual([
      "sym:src/runner.ts#Runner.dispatch",
      "file:src/bus.ts",
    ]);
    expect(queue[1].note).toBeUndefined();
    expect((await json(await fetch(`${view.url}/api/requests`))).pending).toBe(0);

    // the skill sees it in `xpl status`
    const status = await xpl(dir, "status", "demo");
    expect(status.out).toContain("requests queued by the viewer (2");
    expect(status.out).toContain('sym:src/runner.ts#Runner.dispatch  "why a loop?"');

    for (const bad of [{}, { elementId: "" }, { elementId: 5 }, { elementId: "x", note: 3 }]) {
      const res = await fetch(`${view.url}/api/requests`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(bad),
      });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(readJson(dir, ".explainer/requests.json")).toHaveLength(2);
  });

  it("also accepts the viewer's own request shape { kind, id, view, label }", async () => {
    const dir = cloneDir(demo);
    const view = await serve(dir);
    const res = await fetch(`${view.url}/api/requests`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        kind: "expand",
        id: "sym:src/runner.ts#Runner.dispatch",
        view: "view:dispatch",
        label: "Runner.dispatch",
      }),
    });
    expect(res.status).toBe(201);
    expect((await json(res)).request).toMatchObject({
      elementId: "sym:src/runner.ts#Runner.dispatch",
      kind: "expand",
      view: "view:dispatch",
      label: "Runner.dispatch",
      explainer: "demo",
    });
    expect(readJson(dir, ".explainer/requests.json")).toHaveLength(1);
    const status = await xpl(dir, "status", "demo");
    expect(status.out).toMatch(
      / expand sym:src\/runner\.ts#Runner\.dispatch {2}\(in view:dispatch\) {2}\[Runner\.dispatch\]$/m,
    );
    const bad = await fetch(`${view.url}/api/requests`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ kind: 5, id: "x" }),
    });
    expect(bad.status).toBe(400);
  });

  it("concurrent requests do not lose each other", async () => {
    const dir = cloneDir(demo);
    const view = await serve(dir);
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        fetch(`${view.url}/api/requests`, {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ elementId: `file:src/queue.ts`, note: `n${i}` }),
        }),
      ),
    );
    expect(responses.map((r) => r.status)).toEqual(Array(12).fill(201));
    expect(readJson(dir, ".explainer/requests.json")).toHaveLength(12);
  });

  it("re-reads the explainer on every request, so `xpl apply` shows up without a restart", async () => {
    const dir = cloneDir(demo);
    const view = await serve(dir);
    const before = (await json(await fetch(`${view.url}/api/bundle`))) as ViewerBundle;
    expect(before.explainer.concepts.map((c) => c.id)).toEqual(["concept:retry-policy"]);
    const patch = {
      concepts: [
        {
          id: "concept:queue",
          label: "Queue",
          summary: "Holds the jobs.",
          anchors: [{ file: "src/queue.ts", symbol: "Queue", role: "definition" }],
        },
      ],
    };
    expect(
      (await invoke(["apply", "demo", "-"], { cwd: dir, stdin: JSON.stringify(patch) })).code,
    ).toBe(0);
    const after = (await json(await fetch(`${view.url}/api/bundle`))) as ViewerBundle;
    expect(after.explainer.concepts.map((c) => c.id)).toEqual([
      "concept:retry-policy",
      "concept:queue",
    ]);
    // and the viewer's own edits keep what apply wrote
    await fetch(`${view.url}/api/views/view:overview`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ layout: { "file:src/worker.ts": { x: 1, y: 2 } } }),
    });
    const saved = readJson(dir, ".explainer/demo.explainer.json");
    expect(saved.concepts.map((c: any) => c.id)).toContain("concept:queue");
  });

  it("GET /api/explainer answers 304 until the explainer on disk changes", async () => {
    const dir = cloneDir(demo);
    const view = await serve(dir);
    const first = await fetch(`${view.url}/api/explainer`);
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(/^"[0-9a-f]{40}"$/);
    expect(((await first.json()) as Explainer).concepts.map((c) => c.id)).toEqual([
      "concept:retry-policy",
    ]);
    const same = await fetch(`${view.url}/api/explainer`, { headers: { "If-None-Match": etag } });
    expect(same.status).toBe(304);

    const patch = { concepts: [{ id: "concept:retry-policy", summary: "Shorter now." }] };
    expect(
      (await invoke(["apply", "demo", "-"], { cwd: dir, stdin: JSON.stringify(patch) })).code,
    ).toBe(0);
    const changed = await fetch(`${view.url}/api/explainer`, {
      headers: { "If-None-Match": etag },
    });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(etag);
    expect(((await changed.json()) as Explainer).concepts[0]!.summary).toBe("Shorter now.");
  });

  it("invalidates polling for source changes, including unanchored files, and follows a new index", async () => {
    const dir = cloneDir(demo);
    const view = await serve(dir);
    const first = await fetch(`${view.url}/api/explainer`);
    const etag = first.headers.get("etag")!;
    editFile(dir, "src/queue.ts", (text) =>
      text.replace("Date.now() + delayMs", "Date.now() + delayMs + 7"),
    );
    const changed = await fetch(`${view.url}/api/explainer`, {
      headers: { "If-None-Match": etag },
    });
    expect(changed.status).toBe(200);
    const nextEtag = changed.headers.get("etag")!;
    expect(nextEtag).not.toBe(etag);
    const stale = parseBundle(await (await fetch(`${view.url}/api/bundle`)).text());
    expect(stale.sourceWarning).toContain("does not match the working tree");
    expect(stale.files["src/queue.ts"]).toContain("delayMs + 7");
    editFile(dir, "src/main.ts", (text) => `${text}\n// source without a stored anchor changed\n`);
    expect(
      (await fetch(`${view.url}/api/explainer`, { headers: { "If-None-Match": nextEtag } })).status,
    ).toBe(200);
    const indexed = await xplJson<any>(dir, "index", "--precise", "off");
    const current = parseBundle(await (await fetch(`${view.url}/api/bundle`)).text());
    expect(current.index.commit).toBe(indexed.json.commit);
    expect(current.sourceWarning).toBeUndefined();
  });

  it("re-resolves the anchors like xpl bundle, and warns about drift but still serves", async () => {
    const dir = cloneDir(demo);
    // onJobCompleted moves down 2 lines (same text); Queue.pop changes
    editFile(dir, "src/metrics.ts", (text) => `// one\n// two\n${text}`);
    editFile(dir, "src/queue.ts", (text) =>
      text.replace(
        "const job: Job | undefined = due[0];",
        "const job: Job | undefined = due.at(0);",
      ),
    );
    const indexed = await invoke(["index", "--precise", "off", "--json"], { cwd: dir });
    const index = JSON.parse(indexed.out).path as string;
    const view = await serve(dir, "--index", index);
    const statusOf = (explainer: Explainer, symbol: string) =>
      collectAnchors(explainer).find((s) => s.anchor.symbol === symbol && !s.anchor.span)!.anchor
        .resolved!;
    const bundle = parseBundle(await (await fetch(`${view.url}/api/bundle`)).text());
    const polled = (await (await fetch(`${view.url}/api/explainer`)).json()) as Explainer;
    for (const explainer of [bundle.explainer, polled]) {
      expect(statusOf(explainer, "onJobCompleted").status).toBe("moved");
      expect(statusOf(explainer, "Queue.pop").status).toBe("drifted");
    }
    // the same explainer both ways, so the page's poll does not bring the stale cache back
    expect(polled).toEqual(bundle.explainer);
    const { err } = await view.stop();
    expect(err).toContain(
      "1 anchor drifted (its code changed): the page says so; to fix it, run `xpl resolve demo --write`",
    );
  });

  it("serves the working tree: edits to a file show up in /api/file", async () => {
    const dir = cloneDir(demo);
    const view = await serve(dir);
    editFile(dir, "src/queue.ts", (text) => `${text}// edited while serving\n`);
    const text = await (await fetch(`${view.url}/api/file?path=src/queue.ts`)).text();
    expect(text.endsWith("// edited while serving\n")).toBe(true);
  });

  it("unknown routes and methods", async () => {
    const view = await serve(demo);
    expect((await fetch(`${view.url}/api/nope`)).status).toBe(404);
    const post = await fetch(`${view.url}/api/bundle`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: "{}",
    });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
    expect((await fetch(`${view.url}/api/views/view:overview`)).status).toBe(405);
    expect((await fetch(`${view.url}/api/tours/tour:intro`)).status).toBe(405);
    expect((await fetch(`${view.url}/favicon.ico`)).status).toBe(204);
    const head = await fetch(`${view.url}/`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("cache-control")).toBe("no-store");
  });

  it("fails early with clear messages", async () => {
    const noViewer = await invoke(["view", "demo", "--no-open", "--port", "0", "--root", demo], {
      cwd: demo,
      env: { XPL_VIEWER_HTML: "/no/such/viewer.html" },
    });
    expect(noViewer.code).toBe(1);
    expect(noViewer.err).toContain("XPL_VIEWER_HTML points to /no/such/viewer.html");
    const noExplainer = await invoke(["view", "ghost", "--no-open", "--root", demo], {
      cwd: demo,
      env: viewerEnv,
    });
    expect(noExplainer.code).toBe(1);
    expect(noExplainer.err).toContain('no explainer "ghost"');
    const badPort = await invoke(["view", "demo", "--port", "70000", "--root", demo], {
      cwd: demo,
      env: viewerEnv,
    });
    expect(badPort.code).toBe(2);
    expect(badPort.err).toContain("--port must be an integer between 0 and 65535");
  });

  it("reports a port that is already taken", async () => {
    const first = await serve(demo);
    const clash = await invoke(
      ["view", "demo", "--no-open", "--port", String(first.server.port), "--root", demo],
      {
        cwd: demo,
        env: viewerEnv,
      },
    );
    expect(clash.code).toBe(1);
    expect(clash.err).toContain(`port ${first.server.port} on 127.0.0.1 is already in use`);
  });

  it("without --port it tries the default port, and falls back to a free one when it is busy", async () => {
    const run = async () => {
      const controller = new AbortController();
      let onServer!: (server: ViewServer) => void;
      const ready = new Promise<ViewServer>((resolve) => (onServer = resolve));
      const done = invoke(["view", "demo", "--no-open", "--root", demo], {
        cwd: demo,
        env: viewerEnv,
        signal: controller.signal,
        onServer,
      });
      const server = await ready;
      return {
        server,
        stop: async () => {
          controller.abort();
          return (await done).code;
        },
      };
    };

    // occupy the default port ourselves (when someone else already has it, that is just as good)
    const blocker = createNetServer();
    const held = await new Promise<boolean>((resolve) => {
      blocker.once("error", () => resolve(false));
      blocker.listen(DEFAULT_PORT, "127.0.0.1", () => resolve(true));
    });
    try {
      const busy = await run();
      expect(busy.server.port).toBeGreaterThan(0);
      expect(busy.server.port).not.toBe(DEFAULT_PORT);
      expect(await busy.stop()).toBe(0);
    } finally {
      if (held) await new Promise((resolve) => blocker.close(resolve));
    }
  });
});
