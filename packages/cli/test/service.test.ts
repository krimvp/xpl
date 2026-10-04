import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  cloneDir,
  indexedFixture,
  invoke,
  PATCH_PATH,
  readJson,
  writeViewerStub,
  xpl,
  xplJson,
  makeTempDir,
  readFile,
  writeFile,
} from "./helpers.js";
import type { ViewServer } from "../src/server.js";

let demo: string;
let viewer: string;
beforeAll(async () => {
  demo = await indexedFixture();
  expect((await xpl(demo, "new", "demo")).code).toBe(0);
  expect((await xpl(demo, "apply", "demo", PATCH_PATH)).code).toBe(0);
  viewer = writeViewerStub();
});

async function serve(root: string, ...extra: string[]) {
  const abort = new AbortController();
  let ready!: (server: ViewServer) => void;
  const listening = new Promise<ViewServer>((resolve) => (ready = resolve));
  const done = invoke(["service", "start", "--port", "0", "--root", root, ...extra], {
    env: { XPL_VIEWER_HTML: viewer },
    signal: abort.signal,
    onServer: ready,
  });
  const server = await Promise.race([
    listening,
    done.then((r) => {
      throw new Error(r.err || r.out);
    }),
  ]);
  return {
    server,
    done,
    async close() {
      abort.abort();
      return done;
    },
  };
}

describe("repository service lifecycle", () => {
  it("identifies an exited owner and requires explicit recovery while preserving interrupted records and artifacts", async () => {
    const root = cloneDir(demo);
    const first = await serve(root, "demo");
    await first.close();
    const old = readJson(root, ".explainer/service/instance.json");
    const deadPid = Number(
      execFileSync(process.execPath, ["-e", "console.log(process.pid)"], {
        encoding: "utf8",
      }).trim(),
    );
    old.state = "running";
    old.pid = deadPid;
    writeFile(root, ".explainer/service/instance.json", JSON.stringify(old));
    const artifact = readFile(root, ".explainer/demo.explainer.json");
    expect((await xplJson(root, "service", "status")).json).toMatchObject({
      state: "interrupted",
      instanceId: old.instanceId,
    });
    expect((await xplJson(root, "service", "start")).json.error).toMatch(/interrupted.*--recover/);
    expect(readFile(root, ".explainer/demo.explainer.json")).toBe(artifact);
    const recovered = await serve(root, "--recover");
    try {
      expect(readJson(root, `.explainer/service/interrupted-${old.instanceId}.json`)).toEqual(old);
      expect((await xplJson(root, "service", "status")).json.state).toBe("running");
      expect(readFile(root, ".explainer/demo.explainer.json")).toBe(artifact);
    } finally {
      await recovered.close();
    }
  });

  it("refuses stop/recovery for unverified live ownership and reports transaction locks without stealing them", async () => {
    const root = cloneDir(demo);
    const running = await serve(root, "demo");
    try {
      const record = readJson(root, ".explainer/service/instance.json");
      writeFile(
        root,
        ".explainer/service/instance.json",
        JSON.stringify({ ...record, token: "0".repeat(64) }),
      );
      expect((await xplJson(root, "service", "status")).json.state).toBe("unavailable");
      expect((await xplJson(root, "service", "stop")).json.error).toMatch(
        /cannot verify service ownership/,
      );
      expect((await xplJson(root, "service", "start", "--recover")).json.error).toMatch(
        /PID is alive/,
      );
      expect((await fetch(new URL("/api/bundle", running.server.url))).status).toBe(200);
      writeFile(root, ".explainer/service/instance.json", JSON.stringify(record));
    } finally {
      await running.close();
    }
    mkdirSync(join(root, ".explainer/service/instance.json.lock"));
    expect((await xplJson(root, "service", "status")).json).toMatchObject({
      state: "stopped",
      ownershipLock: true,
    });
  });

  it("reattaches saved guide/backend on restart and keeps canonical repository owners separate", async () => {
    const root = cloneDir(demo);
    const other = cloneDir(demo);
    const alias = join(makeTempDir(), "alias");
    symlinkSync(root, alias);
    const first = await serve(root, "demo", "--backend", "claude");
    const second = await serve(other, "demo");
    try {
      expect((await xplJson(alias, "service", "status")).json).toMatchObject({
        root,
        url: first.server.url,
      });
      expect((await xplJson(alias, "service", "start", "demo")).json.error).toMatch(
        /already running/,
      );
      const firstId = (await xplJson(root, "service", "status")).json.instanceId;
      await first.close();
      const restarted = await serve(root);
      try {
        const status = (await xplJson(root, "service", "status")).json;
        expect(status).toMatchObject({
          root,
          guide: ".explainer/demo.explainer.json",
          backend: "claude",
        });
        expect(status.instanceId).not.toBe(firstId);
        expect((await xplJson(other, "service", "status")).json).toMatchObject({
          state: "running",
          backend: "none",
          url: second.server.url,
        });
        expect((await fetch(new URL("/api/bundle", second.server.url))).status).toBe(200);
      } finally {
        await restarted.close();
      }
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("refuses busy ports and missing or cross-repository guide paths without changing saved artifacts", async () => {
    const root = cloneDir(demo);
    const other = cloneDir(demo);
    const first = await serve(other, "demo");
    const artifact = readFile(root, ".explainer/demo.explainer.json");
    try {
      const busy = await invoke(
        ["service", "start", "demo", "--port", String(first.server.port), "--root", root],
        { env: { XPL_VIEWER_HTML: viewer } },
      );
      expect(busy.code).toBe(1);
      expect(busy.err).toMatch(/already in use; pick another with --port/);
      expect((await xplJson(root, "service", "status")).json.state).toBe("stopped");
      expect((await xplJson(root, "service", "start", "missing")).json.error).toMatch(
        /no explainer/,
      );
      expect(
        (await xplJson(root, "service", "start", join(other, ".explainer/demo.explainer.json")))
          .json.error,
      ).toMatch(/must stay inside repository/);
      symlinkSync(
        join(other, ".explainer/demo.explainer.json"),
        join(root, ".explainer/linked.explainer.json"),
      );
      expect((await xplJson(root, "service", "start", "linked")).json.error).toMatch(
        /must stay inside repository/,
      );
      expect((await invoke(["service", "status", "--root", join(root, "missing")])).err).toMatch(
        /is not a directory/,
      );
      expect(readFile(root, ".explainer/demo.explainer.json")).toBe(artifact);
    } finally {
      await first.close();
    }
  });

  it("refuses a guide replaced with another repository's symlink while serving", async () => {
    const root = cloneDir(demo);
    const other = cloneDir(demo);
    const running = await serve(root, "demo");
    try {
      unlinkSync(join(root, ".explainer/demo.explainer.json"));
      symlinkSync(
        join(other, ".explainer/demo.explainer.json"),
        join(root, ".explainer/demo.explainer.json"),
      );
      const response = await fetch(new URL("/api/bundle", running.server.url));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: "service artifact path leaves its repository",
      });
    } finally {
      await running.close();
    }
  });

  it("reports the actual instance and context, rejects duplicates and stops only its own server", async () => {
    const root = cloneDir(demo);
    const running = await serve(root, "demo", "--backend", "claude");
    try {
      const status = await xplJson(root, "service", "status");
      expect(status.json).toMatchObject({
        ok: true,
        state: "running",
        root,
        guide: ".explainer/demo.explainer.json",
        backend: "claude",
        url: running.server.url,
        pid: process.pid,
      });
      expect(status.json.instanceId).toMatch(/^[0-9a-f-]{36}$/);
      const record = readJson(root, ".explainer/service/instance.json");
      expect(status.out).not.toContain(record.token);
      const headers = {
        Authorization: `Bearer ${record.token}`,
        "Content-Type": "application/json",
        Origin: "http://unrelated.example",
      };
      expect(
        (
          await fetch(new URL("/api/service/stop", running.server.url), {
            method: "POST",
            headers,
            body: "{}",
          })
        ).status,
      ).toBe(403);
      const duplicate = await xplJson(root, "service", "start", "demo");
      expect(duplicate.code).toBe(1);
      expect(duplicate.json.error).toMatch(/already running/);
      expect(
        (await fetch(new URL("/api/service/stop", running.server.url), { method: "POST" })).status,
      ).toBe(403);
      expect((await xplJson(root, "service", "stop")).json.state).toBe("stopped");
      expect((await running.done).code).toBe(0);
      expect((await xplJson(root, "service", "status")).json.state).toBe("stopped");
    } finally {
      await running.close();
    }
  });
});
