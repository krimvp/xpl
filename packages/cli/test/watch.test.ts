import { describe, expect, it, vi } from "vitest";
import { renameSync, unlinkSync, existsSync } from "node:fs";
import { promises as filesystem } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  buildIndex,
  writeIndex,
  indexProviders,
  registerProvider,
  unregisterProvider,
  type IndexProvider,
} from "@xpl/indexer";
import {
  cloneDir,
  indexedFixture,
  git,
  invoke,
  PATCH_PATH,
  readFile,
  readJson,
  writeFile,
  writeViewerStub,
  xpl,
  xplJson,
} from "./helpers.js";
import { withRepositoryLock } from "../src/fsutil.js";
import type { ViewServer } from "../src/server.js";

async function start(root: string, ...options: string[]) {
  const abort = new AbortController();
  let listening!: (s: ViewServer) => void;
  const ready = new Promise<ViewServer>((resolve) => {
    listening = resolve;
  });
  const done = invoke(["service", "start", "demo", "--port", "0", ...options], {
    cwd: root,
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
  return {
    server,
    done,
    stop: async () => {
      abort.abort();
      await done;
    },
  };
}

async function setup() {
  const root = await indexedFixture();
  expect((await xpl(root, "new", "demo")).code).toBe(0);
  expect((await xpl(root, "apply", "demo", PATCH_PATH)).code).toBe(0);
  return root;
}
const watchPath = ".explainer/service/watch.json";
async function current(root: string, after = 0) {
  try {
    await expect
      .poll(
        () => {
          try {
            const s = readJson(root, watchPath);
            return s.state === "current" && s.generation > after;
          } catch {
            return false;
          }
        },
        { timeout: 15000 },
      )
      .toBe(true);
  } catch (error) {
    throw new Error(JSON.stringify(readJson(root, watchPath)), { cause: error });
  }
  return readJson(root, watchPath);
}

describe("opt-in coherent service watching", () => {
  it("pauses without releasing its checked pointer, resumes edits and keeps drift or missing evidence unready", async () => {
    const root = await setup();
    expect((await xpl(root, "new", "ready")).code).toBe(0);
    const patch = await invoke(["apply", "ready", "-", "--actor", "user"], {
      cwd: root,
      stdin: JSON.stringify({
        nodes: [
          {
            id: "sym:src/runner.ts#Runner.dispatch",
            summary: "Dispatch runs a queued job on a leased worker.",
            anchors: [{ file: "src/runner.ts", symbol: "Runner.dispatch", role: "definition" }],
          },
        ],
        views: [
          {
            id: "view:dispatch",
            type: "graph",
            title: "Dispatching a job",
            include: ["sym:src/runner.ts#Runner.dispatch"],
            stubs: { mode: "none" },
          },
        ],
      }),
    });
    expect(patch.code, patch.err).toBe(0);
    const guide = readFile(root, ".explainer/ready.explainer.json");
    const running = await start(root, "--watch");
    try {
      const first = await current(root);
      expect((await xplJson(root, "ready", "ready")).json.ready).toBe(true);
      const paused = await xplJson(root, "service", "pause");
      expect(paused.code, paused.err).toBe(0);
      expect(paused.json.watch).toMatchObject({
        state: "paused",
        stale: true,
        generation: first.generation,
        index: first.index,
      });
      expect(paused.json.state).toBe("running");
      const pausedReady = (await xplJson(root, "ready", "ready")).json;
      expect(pausedReady.ready).toBe(false);
      expect(
        pausedReady.findings.filter((f: { code: string }) => f.code === "stale-index"),
      ).toMatchObject([{ severity: "error", message: expect.stringContaining("watch paused") }]);
      const pausedExport = (await (
        await fetch(new URL("/api/export", running.server.url))
      ).json()) as { exportInfo: { report: { ready: boolean } } };
      expect(pausedExport.exportInfo.report.ready).toBe(false);
      writeFile(root, "tsconfig.json", '{"compilerOptions":{"target":"ES2022"}}');
      writeFile(
        root,
        "src/runner.ts",
        readFile(root, "src/runner.ts").replace("this.queue.pop()", "this.queue.pop(123)"),
      );
      unlinkSync(join(root, "src/queue.ts"));
      await delay(1600);
      expect(readJson(root, watchPath).generation).toBe(first.generation);
      expect((await xplJson(root, "ready", "ready")).json.ready).toBe(false);
      const resumed = await xplJson(root, "service", "resume");
      expect(resumed.code, resumed.err).toBe(0);
      const next = await current(root, first.generation);
      expect(readJson(root, next.index.path)).toEqual(
        (await buildIndex({ root, precise: "off" })).index,
      );
      const response = await fetch(new URL("/api/watch", running.server.url));
      expect(response.status).toBe(200);
      const attention = (await response.json()) as {
        guides: { name: string; counts: { drifted: number; missing: number } }[];
      };
      expect(attention.guides.find((g) => g.name === "demo")!.counts).toMatchObject({
        drifted: 2,
        missing: 2,
      });
      expect((await xplJson(root, "ready", "ready")).json.ready).toBe(false);
      const exported = (await (await fetch(new URL("/api/export", running.server.url))).json()) as {
        exportInfo: { report: { ready: boolean; findings: { code: string }[] } };
      };
      expect(exported.exportInfo.report.ready).toBe(false);
      expect(exported.exportInfo.report.findings.map((f) => f.code)).toEqual(
        expect.arrayContaining(["anchor-drifted", "anchor-missing"]),
      );
      writeFile(root, ".explainer/held.patch.json", '{"nodes":[]}');
      writeFile(root, ".explainer/requests.json", "[]");
      writeFile(
        root,
        "export.html",
        '<script id="xpl-data" type="application/json">{"schema":"code-explainer/bundle@0"}</script>',
      );
      // Allow enough polls for an output-triggered generation to violate the contract.
      await delay(1800);
      expect(readJson(root, watchPath).generation).toBe(next.generation);
      expect(readFile(root, ".explainer/ready.explainer.json")).toBe(guide);
      // Isolate missing evidence: readiness must fail even with no surviving drifted anchor.
      unlinkSync(join(root, "src/runner.ts"));
      await current(root, next.generation);
      const missingReady = (await xplJson(root, "ready", "ready")).json;
      expect(missingReady.ready).toBe(false);
      expect(
        missingReady.findings.filter((f: { code: string }) => f.code === "anchor-missing"),
      ).toMatchObject([{ elementId: "sym:src/runner.ts#Runner.dispatch", severity: "error" }]);
      expect(
        missingReady.findings.filter((f: { code: string }) => f.code === "anchor-drifted"),
      ).toEqual([]);
    } finally {
      await running.stop();
    }
  });

  it("drains a publication blocked on locks before pausing and cannot publish its cancelled result", async () => {
    const root = await setup();
    const running = await start(root, "--watch");
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired!: () => void;
    const locked = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    let lock: Promise<void> | undefined;
    try {
      const first = await current(root);
      lock = withRepositoryLock(root, join(root, ".explainer/.gitignore"), async () => {
        acquired();
        await hold;
      });
      await locked;
      writeFile(root, "README.md", "held publication\n");
      const obsolete = (await buildIndex({ root, precise: "off" })).index;
      const target = join(root, ".explainer", `index-${obsolete.commit}.json`);
      await expect.poll(() => existsSync(`${target}.lock`), { timeout: 15000 }).toBe(true);
      const pausing = xplJson(root, "service", "pause");
      await expect.poll(() => readJson(root, watchPath).state).toBe("paused");
      release();
      await lock;
      const paused = await pausing;
      expect(paused.code, paused.err).toBe(0);
      expect(readJson(root, watchPath)).toMatchObject({
        state: "paused",
        stale: true,
        generation: first.generation,
        index: first.index,
      });
      expect(existsSync(target)).toBe(false);
      expect((await xpl(root, "service", "pause")).code).toBe(0);
      const resumes = await Promise.all([
        xpl(root, "service", "resume"),
        xpl(root, "service", "resume"),
      ]);
      expect(resumes.map((r) => r.code)).toEqual([0, 0]);
      expect((await current(root, first.generation)).generation).toBe(first.generation + 1);
    } finally {
      release();
      await lock;
      await running.stop();
    }
  });

  it("polls an unchanged repository without reading source contents", async () => {
    const root = await setup();
    const running = await start(root, "--watch", "--precise", "off");
    const reads: string[] = [];
    let readSpy: ReturnType<typeof vi.spyOn> | undefined;
    let openSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const first = await current(root);
      const originalRead = filesystem.readFile;
      const originalOpen = filesystem.open;
      const observe = (p: unknown) => {
        const path = String(p);
        if (path.startsWith(`${root}/`) && !path.includes("/.explainer/")) reads.push(path);
      };
      readSpy = vi.spyOn(filesystem, "readFile").mockImplementation(
        new Proxy(originalRead, {
          apply(target, context, args) {
            observe(args[0]);
            return Reflect.apply(target, context, args);
          },
        }),
      );
      openSpy = vi.spyOn(filesystem, "open").mockImplementation(
        new Proxy(originalOpen, {
          apply(target, context, args) {
            observe(args[0]);
            return Reflect.apply(target, context, args);
          },
        }),
      );
      syncBuiltinESMExports();
      // Give idle polls a chance to violate the zero-content-read contract.
      await delay(1600);
      expect(readJson(root, watchPath).generation).toBe(first.generation);
      expect(reads).toEqual([]);
    } finally {
      readSpy?.mockRestore();
      openSpy?.mockRestore();
      syncBuiltinESMExports();
      await running.stop();
    }
  });

  it.each(["superseded", "cancelled"])(
    "fences a %s build after waiting for all publication locks",
    async (change) => {
      const root = await setup();
      const running = await start(root, "--watch", "--precise", "off");
      let release!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      let acquired!: () => void;
      const locked = new Promise<void>((resolve) => {
        acquired = resolve;
      });
      let lock: Promise<void> | undefined;
      try {
        const first = await current(root);
        lock = withRepositoryLock(root, join(root, ".explainer/.gitignore"), async () => {
          acquired();
          await hold;
        });
        await locked;
        writeFile(root, "README.md", "obsolete publication\n");
        const obsolete = (await buildIndex({ root, precise: "off" })).index;
        const target = join(root, ".explainer", `index-${obsolete.commit}.json`);
        await expect.poll(() => existsSync(`${target}.lock`), { timeout: 15000 }).toBe(true);
        if (change === "cancelled") {
          const stopped = running.stop();
          release();
          await lock;
          await stopped;
          expect(readJson(root, watchPath)).toMatchObject({
            state: "stopped",
            stale: true,
            generation: first.generation,
            index: first.index,
          });
        } else {
          writeFile(root, "README.md", "latest publication\n");
          release();
          await lock;
          const latest = await current(root, first.generation);
          expect(latest.generation).toBe(first.generation + 1);
          expect(readJson(root, latest.index.path)).toEqual(
            (await buildIndex({ root, precise: "off" })).index,
          );
        }
        expect(existsSync(target)).toBe(false);
      } finally {
        release();
        await lock;
        await running.stop();
      }
    },
  );

  it("coalesces edits and inventories every guide without changing prose or feedback; stops output loops", async () => {
    const root = await setup();
    expect((await xpl(root, "new", "empty")).code).toBe(0);
    expect((await xpl(root, "new", "ready")).code).toBe(0);
    const patched = await invoke(["apply", "ready", "-", "--actor", "user"], {
      cwd: root,
      stdin: JSON.stringify({
        nodes: [
          {
            id: "sym:src/runner.ts#Runner.dispatch",
            summary: "Dispatch takes a waiting job and runs it on a leased worker.",
            anchors: [{ file: "src/runner.ts", symbol: "Runner.dispatch", role: "definition" }],
          },
        ],
        views: [
          {
            id: "view:dispatch",
            type: "graph",
            title: "Dispatching a job",
            include: ["sym:src/runner.ts#Runner.dispatch"],
            stubs: { mode: "none" },
          },
        ],
      }),
    });
    expect(patched.code, patched.err).toBe(0);
    writeFile(
      root,
      ".explainer/requests.json",
      JSON.stringify([{ elementId: "file:src/queue.ts", note: "keep" }]),
    );
    const guide = readFile(root, ".explainer/demo.explainer.json");
    const feedback = readFile(root, ".explainer/requests.json");
    const running = await start(root, "--watch", "--precise", "off");
    try {
      const first = await current(root);
      expect((await xplJson(root, "ready", "ready")).json.ready).toBe(true);
      const source = readFile(root, "src/queue.ts");
      writeFile(root, "src/queue.ts", `// moved\n${source}`);
      writeFile(root, "src/queue.ts", `// moved twice\n// moved\n${source}`);
      const moved = await current(root, first.generation);
      expect(moved.generation).toBe(first.generation + 1);
      const inventory = (await xplJson(root, "status", "--all")).json;
      expect(inventory.guides.map((g: any) => g.name)).toEqual(["demo", "empty", "ready"]);
      expect(inventory.guides[0].anchors.counts).toMatchObject({ drifted: 0, missing: 0 });
      expect(inventory.guides[0].anchors.counts.moved).toBe(2);
      expect(inventory.guides[0].attention).toBe(false);
      const bundle = (await (await fetch(new URL("/api/bundle", running.server.url))).json()) as {
        index: { commit: string };
      };
      expect(bundle.index.commit).toBe(moved.index.commit);
      expect(readFile(root, ".explainer/demo.explainer.json")).toBe(guide);
      expect(readFile(root, ".explainer/requests.json")).toBe(feedback);
      const checkedIndex = readJson(root, moved.index.path);
      await writeIndex(root, { ...checkedIndex, refs: [] });
      const replaced = await xplJson(root, "ready", "ready");
      expect(replaced.json.ready).toBe(false);
      expect(
        replaced.json.findings
          .filter((f: any) => f.code === "stale-index")
          .map((f: any) => f.message),
      ).toEqual([expect.stringContaining("watched index was replaced")]);
      await writeIndex(root, checkedIndex);
      writeFile(
        root,
        "src/runner.ts",
        readFile(root, "src/runner.ts").replace("this.queue.pop()", "this.queue.pop(123)"),
      );
      const drifted = await current(root, moved.generation);
      const affected = (await xplJson(root, "status", "--all")).json.guides[0];
      expect(affected.attention).toBe(true);
      expect(affected.anchors.counts.drifted).toBe(2);
      const userOwned = (await xplJson(root, "status", "--all")).json.guides[2];
      expect(userOwned.driftedOther).toMatchObject([
        { elementId: "sym:src/runner.ts#Runner.dispatch", origin: "user" },
      ]);
      expect((await xplJson(root, "ready", "ready")).json.ready).toBe(false);
      const exported = await invoke(["bundle", "ready", "--out", "export.html", "--json"], {
        cwd: root,
        env: { XPL_VIEWER_HTML: writeViewerStub() },
      });
      expect(exported.code).toBe(1);
      expect(
        JSON.parse(exported.out)
          .readiness.findings.filter((f: any) => f.code === "anchor-drifted")
          .map((f: any) => f.elementId),
      ).toEqual(["sym:src/runner.ts#Runner.dispatch"]);
      writeFile(root, ".explainer/held.patch.json", '{"nodes":[]}');
      writeFile(
        root,
        "export.html",
        '<script id="xpl-data" type="application/json">{"schema":"code-explainer/bundle@0"}</script>',
      );
      // A fixed delay gives an unintended rebuild time to fail this negative contract.
      await delay(1800);
      expect(readJson(root, watchPath).generation).toBe(drifted.generation);
      expect(readFile(root, ".explainer/demo.explainer.json")).toBe(guide);
      expect(readFile(root, ".explainer/requests.json")).toBe(feedback);
    } finally {
      await running.stop();
    }
  });

  it("publishes the clean-run snapshot and status after source/discovery edits, including a rename and deletion", async () => {
    const root = await setup();
    git(root, "init", "-q");
    writeFile(root, ".gitignore", "hidden.ts\ntsconfig.json\n.explainer/\n");
    writeFile(root, "hidden.ts", "export const hidden = 1;\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "initial");
    const running = await start(root, "--watch", "--precise", "off");
    try {
      let state = await current(root);
      for (const edit of [
        () => writeFile(root, "src/added.ts", "export const added = 1;\n"),
        () => renameSync(join(root, "src/added.ts"), join(root, "src/renamed.ts")),
        () => unlinkSync(join(root, "src/queue.ts")),
        () => writeFile(root, "tsconfig.json", '{"compilerOptions":{"target":"ES2022"}}'),
        () => writeFile(root, ".gitignore", "tsconfig.json\n.explainer/\n"),
      ]) {
        edit();
        state = await current(root, state.generation);
        const published = readJson(root, state.index.path);
        expect(published).toEqual((await buildIndex({ root, precise: "off" })).index);
        const live = (await xplJson(root, "status", "--all")).json.guides;
        const cleanRoot = cloneDir(root);
        unlinkSync(join(cleanRoot, watchPath));
        expect((await xpl(cleanRoot, "index", "--precise", "off")).code).toBe(0);
        const clean = (await xplJson(cleanRoot, "status", "--all")).json.guides;
        expect(live).toEqual(clean);
      }
      expect((await xplJson(root, "status", "--all")).json.guides[0].anchors.counts.missing).toBe(
        2,
      );
      expect(readJson(root, state.index.path).files.map((f: any) => f.path)).toContain("hidden.ts");
    } finally {
      await running.stop();
    }
  });

  it("discards a changed-during-build result, retains a marked stale snapshot on failure and recovers", async () => {
    const root = await setup();
    let entered!: () => void;
    let release!: () => void;
    let mode: "normal" | "held" | "fail" = "normal";
    let enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider: IndexProvider = {
      id: "watch-test",
      languages: ["typescript"],
      capabilities: { call: "supported" },
      async analyze(input) {
        if (mode === "held") {
          entered();
          await hold;
        }
        if (mode === "fail") throw new Error("controlled provider failure");
        return {
          provider: this.id,
          version: "1",
          configuration: "controlled-test",
          tool: this.id,
          sourceHashes: Object.fromEntries(input.files.map((f) => [f.path, f.hash])),
          declarations: [],
          relationships: [],
          analysis: [
            {
              provider: this.id,
              capabilities: this.capabilities,
              files: input.files
                .filter((f) => input.languages.includes(f.language))
                .map((f) => f.path),
              results: [
                {
                  capabilities: ["call"],
                  status: "supported",
                  resolution: "precise",
                  limitations: [],
                  analyzedFiles: input.files
                    .filter((f) => input.languages.includes(f.language))
                    .map((f) => f.path),
                },
              ],
            },
          ],
        };
      },
    };
    const semantic = indexProviders().filter((p) => p.mode !== "syntax");
    for (const p of semantic) unregisterProvider(p.id);
    registerProvider(provider);
    const running = await start(root, "--watch", "--precise", "require");
    try {
      const first = await current(root);
      const original = readFile(root, first.index.path);
      mode = "held";
      writeFile(root, "README.md", "first edit\n");
      await enteredPromise;
      expect(readJson(root, watchPath)).toMatchObject({
        state: "building",
        stale: true,
        index: first.index,
      });
      writeFile(root, "README.md", "latest edit\n");
      mode = "normal";
      release();
      const next = await current(root, first.generation);
      expect(next.generation).toBe(first.generation + 1);
      expect(readFile(root, first.index.path)).toBe(original);
      expect(
        readJson(root, next.index.path).files.find((f: any) => f.path === "README.md").hash,
      ).toBe(
        (await buildIndex({ root, precise: "require" })).index.files.find(
          (f) => f.path === "README.md",
        )!.hash,
      );
      mode = "fail";
      writeFile(root, "README.md", "failed edit\n");
      await expect.poll(() => readJson(root, watchPath).state, { timeout: 15000 }).toBe("failed");
      expect(readJson(root, watchPath)).toMatchObject({
        stale: true,
        generation: next.generation,
        index: next.index,
      });
      const failedReady = (await xplJson(root, "ready", "demo")).json;
      expect(failedReady.ready).toBe(false);
      expect(
        failedReady.findings
          .filter((f: any) => f.code === "stale-index")
          .map((f: any) => f.message),
      ).toEqual([expect.stringContaining("watch failed")]);
      mode = "normal";
      writeFile(root, "README.md", "recovered edit\n");
      const recovered = await current(root, next.generation);
      enteredPromise = new Promise<void>((resolve) => {
        entered = resolve;
      });
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      mode = "held";
      writeFile(root, "README.md", "cancelled edit\n");
      await enteredPromise;
      const stopping = running.stop();
      release();
      await stopping;
      expect(readJson(root, watchPath)).toMatchObject({
        state: "stopped",
        stale: true,
        generation: recovered.generation,
        index: recovered.index,
      });
      expect((await xplJson(root, "service", "status")).json.state).toBe("stopped");
      expect((await xpl(root, "index", "--precise", "off")).code).toBe(0);
    } finally {
      release();
      await running.stop();
      unregisterProvider(provider.id);
      for (const p of semantic) registerProvider(p);
    }
  });
});
