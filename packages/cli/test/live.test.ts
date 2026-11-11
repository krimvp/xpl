/**
 * `xpl live`: one cycle (`--once`) on a small git repository, the base it measures from, the loop behind the
 * server (`/api/live`, `/api/bundle`), and the background agent through a fake (`openLive` with `agent`).
 */
import { renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Explainer, LiveStatus, ViewerBundle } from "@xpl/core";
import { createCtx } from "../src/context.js";
import { openLive, type LiveRun } from "../src/live.js";
import type { ViewServer } from "../src/server.js";
import {
  copyFixture,
  editFile,
  git,
  invoke,
  readFile,
  readJson,
  writeFile,
  writeViewerStub,
  xpl,
  xplJson,
} from "./helpers.js";

/** The TS fixture with a folder of two files (`src/store/`), committed on `main`. */
function repo(): string {
  const dir = copyFixture();
  writeFile(
    dir,
    "src/store/disk.ts",
    'import { load } from "./memory.ts";\n\nexport function save(x: string): string {\n  return load(x);\n}\n',
  );
  writeFile(
    dir,
    "src/store/memory.ts",
    "export function load(x: string): string {\n  return x;\n}\n",
  );
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}

const guide = (dir: string) => readJson<Explainer>(dir, ".explainer/live.explainer.json");
const once = (dir: string, ...more: string[]) =>
  xpl(dir, "live", "--once", "--precise", "off", ...more);

/** Edits, adds and deletes a file of the repo: the change the tests record. */
function work(dir: string): void {
  editFile(dir, "src/store/memory.ts", (text) => text.replace("return x;", "return x.trim();"));
  writeFile(dir, "src/extra.ts", "export function extra(): number {\n  return 1;\n}\n");
  rmSync(join(dir, "src/worker.ts"));
}

describe("xpl live --once", () => {
  it("drafts a git-ignored guide top-down: the system, its parts, a map per folder; no change at the base", async () => {
    const dir = repo();
    const r = await once(dir);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const head = git(dir, "rev-parse", "HEAD");
    expect(r.out).toBe(
      `live: .explainer/live.explainer.json on index ${head.slice(0, 7)}; no change since ${head.slice(0, 7)} (HEAD)`,
    );
    expect(readFile(dir, ".explainer/.gitignore").split("\n")).toEqual(
      expect.arrayContaining(["live/", "live.explainer.json", "index-*.json"]),
    );
    // only the managed ignore file is new; commit it like the one `xpl index` writes
    expect(git(dir, "status", "--porcelain", "-uall")).toBe("?? .explainer/.gitignore");
    const ex = guide(dir);
    expect(ex.change).toBeUndefined();
    expect(ex.tours).toEqual([]);
    expect(ex.views.map((v) => v.id)).toEqual([
      "view:system",
      "view:overview",
      "view:map",
      "view:map-src-store",
    ]);
    const node = (id: string) => ex.nodes.find((n) => n.id === id);
    expect(node("grp:ts-jobrunner")?.opens).toBe("view:overview");
    // a part of the project that is a folder opens the map of its files
    expect(node("dir:src/store")).toMatchObject({
      opens: "view:map-src-store",
      label: "TODO: 1-3 plain words for this part (now: store)",
    });
    expect(node("file:src/store/disk.ts")?.label).toBe(
      "TODO: 2-5 plain words for this file (now: disk.ts)",
    );
    expect((await xpl(dir, "validate", "live")).code).toBe(0);
  });

  it("after work: records the change to the working tree, adds and removes boxes, keeps written text", async () => {
    const dir = repo();
    expect((await once(dir)).code).toBe(0);
    const text = { summary: "Keeps jobs until a worker takes them." };
    expect(
      (
        await invoke(["apply", "live", "-", "--actor", "user"], {
          cwd: dir,
          stdin: JSON.stringify({ nodes: [{ id: "file:src/queue.ts", ...text }] }),
        })
      ).code,
    ).toBe(0);
    work(dir);
    const r = await once(dir);
    expect(r.err).toBe("");
    const ex = guide(dir);
    const base = git(dir, "rev-parse", "HEAD");
    expect(ex.change).toMatchObject({ base, head: ex.index.commit, worktree: true });
    expect(ex.index.commit).toMatch(/^wt-/);
    expect(ex.change!.files.map((f) => [f.path, f.status])).toEqual([
      ["src/extra.ts", "added"],
      ["src/store/memory.ts", "modified"],
      ["src/worker.ts", "deleted"],
    ]);
    expect(r.out.split("\n")).toEqual([
      `live: .explainer/live.explainer.json on index ${ex.index.commit}; changed since ${base.slice(0, 7)} (HEAD): 3 files, +4 -88`,
      "  new boxes: file:src/extra.ts",
      "  removed boxes: file:src/worker.ts",
    ]);
    const ids = ex.nodes.map((n) => n.id);
    expect(ids).toContain("file:src/extra.ts");
    expect(ids).not.toContain("file:src/worker.ts");
    for (const view of ex.views) {
      if (view.type === "graph") expect(view.include).not.toContain("file:src/worker.ts");
    }
    const overview = ex.views.find((v) => v.id === "view:overview");
    expect(overview?.type === "graph" && overview.include).toContain("file:src/extra.ts");
    expect(ex.nodes.find((n) => n.id === "grp:ts-jobrunner")?.members).not.toContain(
      "file:src/worker.ts",
    );
    expect(ex.nodes.find((n) => n.id === "file:src/queue.ts")).toMatchObject(text);
    expect((await xpl(dir, "validate", "live")).out).toContain("no errors");

    // nothing moved: the guide is not written again
    const before = readFile(dir, ".explainer/live.explainer.json");
    expect((await once(dir)).code).toBe(0);
    expect(readFile(dir, ".explainer/live.explainer.json")).toBe(before);
  });

  it("measures from the merge base with main on a branch, from --since when given, and remembers the first HEAD", async () => {
    const dir = repo();
    const main = git(dir, "rev-parse", "HEAD");
    git(dir, "checkout", "-q", "-b", "feat");
    writeFile(dir, "src/extra.ts", "export function extra(): number {\n  return 1;\n}\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "extra");
    const feat = git(dir, "rev-parse", "HEAD");
    const r = await xplJson<{ live: LiveStatus }>(dir, "live", "--once", "--precise", "off");
    expect(r.json.live.base).toEqual({ rev: "main", sha: main, how: "merge-base" });
    // a clean tree at a later commit: the change of two commits
    expect(guide(dir).change).toMatchObject({ base: main, head: feat });
    expect(guide(dir).change?.worktree).toBeUndefined();

    const since = await xplJson<{ live: LiveStatus }>(
      dir,
      "live",
      "--once",
      "--precise",
      "off",
      "--since",
      "HEAD",
    );
    expect(since.json.live.base).toEqual({ rev: "HEAD", sha: feat, how: "since" });
    expect(since.json.live.change).toBeNull();
    expect(guide(dir).change).toBeUndefined();

    // on main itself: HEAD at the first start, remembered, so a commit made since stays in the change
    git(dir, "checkout", "-q", "main");
    rmSync(join(dir, ".explainer/live"), { recursive: true });
    expect((await once(dir)).code).toBe(0);
    writeFile(dir, "src/later.ts", "export const later = 1;\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "later");
    const later = await xplJson<{ live: LiveStatus }>(dir, "live", "--once", "--precise", "off");
    expect(later.json.live.base).toEqual({ rev: "HEAD", sha: main, how: "start" });
    // xpl's own folder is not part of the code that changed, even when it is committed
    expect(guide(dir).change?.files.map((f) => f.path)).toEqual(["src/later.ts"]);
    expect(later.json.live.change).toEqual({ files: 1, added: 1, removed: 0 });
  });

  it("uses a guide the user names as it is: never git-ignores it", async () => {
    const dir = repo();
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
    expect((await xpl(dir, "new", "mine")).code).toBe(0);
    expect((await once(dir, "mine")).code).toBe(0);
    expect(readFile(dir, ".explainer/.gitignore")).not.toContain("mine.explainer.json");
    expect(readJson<Explainer>(dir, ".explainer/mine.explainer.json").views[0]?.id).toBe(
      "view:system",
    );
  });
});

/** A design level as the agent writes it (reference/live.md, "The design level"), on the change of `work`. */
const DESIGN = {
  nodes: [
    {
      id: "grp:design-store",
      label: "Job storage",
      summary: "Keeps the jobs and hands them out.",
      members: ["dir:src/store", "file:src/extra.ts", "file:src/queue.ts"],
    },
    {
      id: "grp:design-work",
      label: "Work loop",
      summary: "Takes jobs and runs them.",
      members: ["file:src/runner.ts"],
      anchors: [{ file: "src/worker.ts", at: "base", role: "definition" }],
    },
  ],
  views: [
    {
      id: "view:design",
      type: "graph",
      title: "The design",
      include: ["grp:design-store", "grp:design-work"],
    },
  ],
  tours: [
    {
      id: "tour:live",
      title: "The runner works alone",
      summary: "The runner takes over the work loop. Risk: jobs in flight.",
      steps: [
        {
          id: "design",
          view: "view:design",
          focus: ["grp:design-work"],
          note: "### The runner runs jobs itself\n\nBefore: a worker. Now: the runner.\n\nRisk: jobs in flight.",
          code: [{ file: "src/worker.ts", at: "base", role: "definition" }],
        },
      ],
    },
  ],
};

const applyLive = (dir: string, patch: unknown) =>
  invoke(["apply", "live", "-"], { cwd: dir, stdin: JSON.stringify(patch) });

describe("xpl live keeps the design level", () => {
  const node = (dir: string, id: string) => guide(dir).nodes.find((n) => n.id === id);
  const baseFiles = (dir: string, id: string) =>
    (node(dir, id)?.anchors ?? []).filter((a) => a.at === "base").map((a) => a.file);

  it("makes a box's deleted file a member again when the change no longer deletes it", async () => {
    const dir = repo();
    expect((await once(dir)).code).toBe(0);
    work(dir);
    expect((await once(dir)).code).toBe(0);
    expect((await applyLive(dir, DESIGN)).code).toBe(0);
    expect((await xpl(dir, "validate", "live")).code).toBe(0);

    // the deleted file comes back: it is no longer code before the change only
    git(dir, "checkout", "--", "src/worker.ts");
    expect((await once(dir)).code).toBe(0);
    const validate = await xpl(dir, "validate", "live");
    expect(validate.out + validate.err).toContain("no errors");
    expect(node(dir, "grp:design-work")?.members).toEqual([
      "file:src/runner.ts",
      "file:src/worker.ts",
    ]);
    expect(baseFiles(dir, "grp:design-work")).toEqual([]);
    const step = guide(dir).tours.find((t) => t.id === "tour:live")?.steps[0];
    expect(step?.code ?? []).toEqual([]);
  });

  it("follows moved members, keeps deleted ones as code before the change, and goes with the change", async () => {
    const dir = repo();
    expect((await once(dir)).code).toBe(0);
    work(dir);
    expect((await once(dir)).code).toBe(0);
    expect((await applyLive(dir, DESIGN)).code).toBe(0);

    // moved without git mv; a member that existed at the base deleted; a member new in the change deleted
    git(dir, "mv", "src/runner.ts", "src/loop.ts");
    renameSync(join(dir, "src/queue.ts"), join(dir, "src/jobs.ts"));
    rmSync(join(dir, "src/store/disk.ts"));
    rmSync(join(dir, "src/extra.ts"));
    rmSync(join(dir, "src/store/memory.ts"));
    expect((await once(dir)).code).toBe(0);
    expect(node(dir, "grp:design-store")?.members).toEqual(["file:src/jobs.ts"]);
    expect(baseFiles(dir, "grp:design-store")).toEqual([
      "src/store/disk.ts",
      "src/store/memory.ts",
    ]);
    expect(node(dir, "grp:design-work")?.members).toEqual(["file:src/loop.ts"]);
    expect(node(dir, "grp:design-store")?.label).toBe("Job storage");
    expect((await xpl(dir, "validate", "live")).code).toBe(0);

    // back to the code of the base: no change, so no explanation of one
    git(dir, "reset", "-q", "--hard");
    git(dir, "clean", "-qfd", "src");
    const last = await once(dir);
    expect(last.err).toBe("");
    expect(last.code).toBe(0);
    const ex = guide(dir);
    expect(ex.change).toBeUndefined();
    expect(ex.nodes.filter((n) => n.id.startsWith("grp:design-"))).toEqual([]);
    expect(ex.views.map((v) => v.id)).not.toContain("view:design");
    expect(ex.tours).toEqual([]);
    expect((await xpl(dir, "validate", "live")).code).toBe(0);
  });
});

async function serve(dir: string) {
  const abort = new AbortController();
  let listening!: (s: ViewServer) => void;
  const ready = new Promise<ViewServer>((resolve) => (listening = resolve));
  const done = invoke(["live", "--port", "0", "--no-open", "--precise", "off"], {
    cwd: dir,
    env: { XPL_VIEWER_HTML: writeViewerStub() },
    signal: abort.signal,
    onServer: listening,
  });
  const server = await Promise.race([
    ready,
    done.then((r) => {
      throw new Error(r.err || r.out);
    }),
  ]);
  const get = async <T>(path: string): Promise<T> =>
    (await fetch(new URL(path, server.url))).json() as Promise<T>;
  return {
    get,
    stop: async () => {
      abort.abort();
      return done;
    },
  };
}

describe("xpl live, serving", () => {
  it("follows the edits: /api/live and /api/bundle show the change and the new boxes; a failed cycle waits for the next edit", async () => {
    const dir = repo();
    const live = await serve(dir);
    try {
      const first = await live.get<LiveStatus>("/api/live");
      expect(first).toMatchObject({
        schema: "xpl-live@1",
        guide: "live",
        state: "watching",
        change: null,
        error: null,
        explanation: { backend: "none", state: "off", stale: false },
      });
      expect((await live.get<ViewerBundle>("/api/bundle")).mode).toBe("live");

      work(dir);
      await expect
        .poll(async () => (await live.get<LiveStatus>("/api/live")).change?.files, {
          timeout: 20000,
        })
        .toBe(3);
      const bundle = await live.get<ViewerBundle>("/api/bundle");
      expect(bundle.explainer.change?.worktree).toBe(true);
      expect(bundle.explainer.nodes.map((n) => n.id)).toContain("file:src/extra.ts");
      expect(bundle.explainer.nodes.map((n) => n.id)).not.toContain("file:src/worker.ts");

      // a guide that cannot be read fails the cycle; the status says so, and the next edit tries again
      writeFile(dir, ".explainer/live.explainer.json", "{ not json");
      writeFile(dir, "src/extra.ts", "export function extra(): number {\n  return 2;\n}\n");
      await expect
        .poll(async () => (await live.get<LiveStatus>("/api/live")).state, { timeout: 20000 })
        .toBe("failed");
      expect((await live.get<LiveStatus>("/api/live")).error).toContain("live.explainer.json");
      rmSync(join(dir, ".explainer/live.explainer.json"));
      writeFile(dir, "src/extra.ts", "export function extra(): number {\n  return 3;\n}\n");
      await expect
        .poll(async () => (await live.get<LiveStatus>("/api/live")).state, { timeout: 20000 })
        .toBe("watching");
      expect(guide(dir).change?.files).toHaveLength(3);
    } finally {
      const r = await live.stop();
      expect(r.code).toBe(0);
    }
  }, 60000);
});

describe("the live agent", () => {
  /** A live session on `dir` whose agent answers with `answer(run)`, recording each run. */
  async function session(dir: string, answer: (run: LiveRun, n: number) => unknown) {
    const runs: LiveRun[] = [];
    const out: string[] = [];
    const ctx = createCtx(
      { out: (t) => out.push(t), err: (t) => out.push(t) },
      { root: dir, cwd: dir, env: process.env, json: false, indexOption: undefined },
    );
    const abort = new AbortController();
    const live = await openLive(ctx, {
      name: "live",
      precise: "off",
      backend: "claude",
      agent: async (run) => {
        runs.push(run);
        return answer(run, runs.length);
      },
      agentQuietMs: 0,
      quietMs: 50,
      pollMs: 50,
      signal: abort.signal,
    });
    return { live, runs, out, abort };
  }

  /** The explanation of `work` with its design level (the change spans two parts), clean of lint findings. */
  const explanation = (summary: string) => ({
    nodes: [
      { id: "file:src/extra.ts", label: "Extra number", summary: "Returns the extra number." },
      {
        id: "grp:design-extra",
        label: "Extra number",
        summary: "Gives the runner one more number to read.",
        members: ["file:src/extra.ts"],
      },
      {
        id: "grp:design-store",
        label: "Job storage",
        summary: "Keeps the jobs until a worker takes them.",
        members: ["dir:src/store"],
        anchors: [{ file: "src/worker.ts", at: "base", role: "definition" }],
      },
    ],
    views: [
      {
        id: "view:design",
        type: "graph",
        title: "What the change does",
        include: ["grp:design-extra", "grp:design-store"],
      },
    ],
    tours: [
      {
        id: "tour:live",
        title: "Add an extra number",
        summary,
        steps: [
          {
            id: "t1",
            view: "view:overview",
            focus: ["file:src/extra.ts"],
            note: "### A new part\n\nThe new file returns the extra number for the runner.",
          },
          {
            id: "design",
            view: "view:design",
            focus: ["grp:design-extra", "grp:design-store"],
            note: "### Storage loses its worker\n\nBefore: a worker took the jobs. Now: nothing takes them.\n\nRisk: jobs wait for ever.",
          },
          {
            id: "design-extra",
            view: "view:design",
            focus: ["grp:design-extra"],
            note: "### One more number\n\nBefore: none. Now: a function returns one.",
          },
          {
            id: "design-store",
            view: "view:design",
            focus: ["grp:design-store"],
            note: "### The worker is gone\n\nBefore: a worker loop. Now: the store trims each job.",
          },
        ],
      },
    ],
  });

  it("applies the agent's patch, marks it stale when the code moves, and runs again for the new code", async () => {
    const dir = repo();
    work(dir);
    const { live, runs, abort } = await session(dir, (_, n) =>
      explanation(
        n === 1
          ? "The change adds a file that returns a number. The runner does not call it yet."
          : "The change now returns 3. The runner does not call it yet.",
      ),
    );
    await live.cycle();
    expect(live.status().explanation).toMatchObject({
      stale: true,
      state: "idle",
      explainedAt: null,
    });
    await live.explain();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.change?.worktree).toBe(true);
    expect(runs[0]!.before["src/store/memory.ts"]).toContain("return x;");
    expect(runs[0]!.findings).toEqual([]);
    const after = live.status().explanation;
    expect(after).toMatchObject({ stale: false, state: "idle", error: null });
    expect(after.explainedAt).not.toBeNull();
    expect(guide(dir).tours.find((t) => t.id === "tour:live")?.summary).toBe(
      "The change adds a file that returns a number. The runner does not call it yet.",
    );
    // the same code: no second run
    await live.explain();
    expect(runs).toHaveLength(1);

    const watching = live.watch();
    try {
      writeFile(dir, "src/extra.ts", "export function extra(): number {\n  return 3;\n}\n");
      await expect.poll(() => runs.length, { timeout: 20000 }).toBe(2);
      await expect
        .poll(() => guide(dir).tours.find((t) => t.id === "tour:live")?.summary, { timeout: 20000 })
        .toBe("The change now returns 3. The runner does not call it yet.");
      expect(live.status().explanation.stale).toBe(false);
    } finally {
      abort.abort();
      await watching;
    }
  }, 60000);

  it("still reads stale after a cycle that only drops a gone file from tour:live", async () => {
    const dir = repo();
    work(dir);
    writeFile(dir, "src/more.ts", "export const more = 1;\n");
    const { live } = await session(dir, () => ({
      tours: [
        {
          ...explanation("The change adds two small files. The runner does not call them yet.")
            .tours[0],
          steps: [
            {
              id: "part-src",
              view: "view:overview",
              focus: ["file:src/extra.ts", "file:src/more.ts"],
              note: "### Two new parts\n\nBefore: none. Now: two files that return numbers.",
            },
          ],
        },
      ],
    }));
    await live.cycle();
    await live.explain(true);
    expect(live.status().explanation.stale).toBe(false);
    // the code moves on; the drafted structure drops the gone file from the tour, which is not an explanation
    rmSync(join(dir, "src/more.ts"));
    await live.cycle();
    const tour = guide(dir).tours.find((t) => t.id === "tour:live")!;
    expect(tour.steps[0]!.focus).toEqual(["file:src/extra.ts"]);
    expect(live.status().explanation.stale).toBe(true);
  });

  it("gives a patch with lint findings back once, and applies the second try when no TODO is left", async () => {
    const dir = repo();
    work(dir);
    const long =
      "The change adds a small file to the storage part that returns a number which the runner and the queue can both read again later on. The runner does not call it yet.";
    const { live, runs, out } = await session(dir, () => explanation(long));
    await live.cycle();
    await live.explain();
    expect(runs).toHaveLength(2);
    expect(runs[1]!.findings.join("\n")).toContain("tour:live summary (long-sentence)");
    expect(live.status().explanation).toMatchObject({ state: "idle", stale: false });
    expect(guide(dir).tours.find((t) => t.id === "tour:live")?.summary).toBe(long);
    expect(out.join("\n")).toContain("applied the agent's patch with 1 lint finding");
  });

  it("gives the first try back when a change across parts has no design level", async () => {
    const dir = repo();
    work(dir);
    const plain = explanation("The change adds a file that returns a number. Risk: none yet.");
    const { live, runs } = await session(dir, (_, n) =>
      n === 1
        ? {
            nodes: plain.nodes.slice(0, 1),
            tours: [{ ...plain.tours[0]!, steps: plain.tours[0]!.steps.slice(0, 1) }],
          }
        : plain,
    );
    await live.cycle();
    await live.explain();
    expect(runs).toHaveLength(2);
    expect(runs[1]!.findings.join("\n")).toContain(
      "tour:live steps (design-level): the change touches 3 parts but the guide has no design level",
    );
    expect(guide(dir).views.map((v) => v.id)).toContain("view:design");
  });

  it("gives a patch with lint findings back once, then reports the failure and applies nothing", async () => {
    const dir = repo();
    work(dir);
    const { live, runs } = await session(dir, () => explanation("TODO: write this."));
    await live.cycle();
    const before = readFile(dir, ".explainer/live.explainer.json");
    await live.explain();
    expect(runs).toHaveLength(2);
    expect(runs[1]!.findings.join("\n")).toContain("tour:live summary (todo-left)");
    const status = live.status().explanation;
    expect(status).toMatchObject({ state: "failed", stale: true });
    expect(status.error).toContain("leaves a TODO, so nothing was applied");
    expect(readFile(dir, ".explainer/live.explainer.json")).toBe(before);
  });
});
