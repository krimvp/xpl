import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
import { artifactIdentity, parseBundle } from "@xpl/core";
import { randomUUID } from "node:crypto";
import { createCtx } from "../src/context.js";
import { openJobs, type Job } from "../src/jobs.js";
import { appendRequest } from "../src/requests.js";
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
  it.each([false, true])(
    "offers the discovered guide path when its name collides with repository JSON (unreadable: %s)",
    async (unreadable) => {
      const root = cloneDir(demo);
      expect((await xplJson(root, "new", "retry.json", "--title", "Retry guide")).code).toBe(0);
      expect((await xplJson(root, "apply", "retry.json", PATCH_PATH)).code).toBe(0);
      writeFile(root, "retry.json", readFile(root, ".explainer/demo.explainer.json"));
      if (unreadable) writeFile(root, ".explainer/retry.json.explainer.json", "{");
      const running = await serve(root, "demo");
      try {
        const response = await fetch(new URL("/api/watch", running.server.url));
        expect(response.status).toBe(200);
        const report = (await response.json()) as {
          guides: {
            name: string;
            path: string | null;
            title: string;
            revisionCommand: string;
            resolveCommand: string;
          }[];
        };
        const guide = report.guides.find((g) => g.name === "retry.json");
        expect(guide).toMatchObject({
          title: unreadable ? "retry.json" : "Job runner",
          path: unreadable ? null : ".explainer/retry.json.explainer.json",
          resolveCommand: `xpl resolve --root '${root}' '${root}/.explainer/retry.json.explainer.json' --write`,
          revisionCommand: `xpl revise --root '${root}' '${root}/.explainer/retry.json.explainer.json' --select '<request-id>'`,
        });
      } finally {
        await running.close();
      }
    },
  );

  it.each([false, true])(
    "guards managed watch controls and stops safely (watch enabled: %s)",
    async (enabled) => {
      const root = cloneDir(demo);
      const running = await serve(root, "demo", ...(enabled ? ["--watch"] : []));
      const instance = readJson(root, ".explainer/service/instance.json");
      const attachment = encodeURIComponent(
        JSON.stringify({ root, guide: ".explainer/demo.explainer.json" }),
      );
      const post = (body: unknown, headers: Record<string, string> = {}) =>
        fetch(new URL("/api/watch", running.server.url), {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify(body),
        });
      try {
        const report = await fetch(new URL("/api/watch", running.server.url));
        expect(report.status).toBe(200);
        const initial = (await report.json()) as { enabled: boolean; instanceId: string };
        expect(initial.enabled).toBe(enabled);
        expect(initial.instanceId).toBe(instance.instanceId);
        const body = { action: "pause", instanceId: instance.instanceId };
        const headers = { "X-Xpl-Attachment": attachment };
        expect((await post(body)).status).toBe(403);
        expect((await post(body, { ...headers, Origin: "https://foreign.example" })).status).toBe(
          403,
        );
        expect((await post(body, { ...headers, "Content-Type": "text/plain" })).status).toBe(415);
        expect(
          (
            await post(body, {
              "X-Xpl-Attachment": encodeURIComponent(
                JSON.stringify({ root, guide: ".explainer/other.explainer.json" }),
              ),
            })
          ).status,
        ).toBe(409);
        expect((await post({ ...body, instanceId: "old-instance" }, headers)).status).toBe(409);
        expect((await post({ ...body, patch: {} }, headers)).status).toBe(400);
        const pause = await post(body, headers);
        expect(pause.status).toBe(enabled ? 200 : 409);
        if (enabled) {
          expect(
            ((await pause.json()) as { watch: { state: string; stale: boolean } }).watch,
          ).toMatchObject({ state: "paused", stale: true });
          expect(readJson(root, ".explainer/service/instance.json").state).toBe("running");
          expect((await post({ ...body, action: "resume" }, headers)).status).toBe(200);
        }
        // Stopping must still work if the attached guide disappeared.
        renameSync(
          join(root, ".explainer/demo.explainer.json"),
          join(root, ".explainer/moved.explainer.json"),
        );
        const missingReport = await fetch(new URL("/api/watch", running.server.url), { headers });
        expect(missingReport.status).toBe(200);
        const missingAttention = (await missingReport.json()) as {
          guides: { name: string; errors: string[] }[];
        };
        expect(missingAttention.guides.find((g) => g.name === "demo")).toMatchObject({
          errors: [expect.stringContaining("missing")],
        });
        expect(missingAttention.guides.find((g) => g.name === "moved")).toBeDefined();
        if (enabled) {
          expect((await post(body, headers)).status).toBe(200);
          expect((await post({ ...body, action: "resume" }, headers)).status).toBe(200);
        }
        const stopped = await post({ ...body, action: "stop" }, headers);
        expect(stopped.status).toBe(200);
        expect((await running.done).code).toBe(0);
        expect((await xplJson(root, "service", "status")).json.state).toBe("stopped");
        expect(readJson(root, ".explainer/service/jobs.json").jobs).toEqual([]);
      } finally {
        await running.close();
      }
    },
  );

  it("retires an interrupted watch before recovering without watching and returns to manual indexes", async () => {
    const root = cloneDir(demo);
    const initial = await serve(root, "demo", "--watch");
    await expect
      .poll(
        () => {
          try {
            return readJson(root, ".explainer/service/watch.json").state;
          } catch {
            return "absent";
          }
        },
        { timeout: 15000 },
      )
      .toBe("current");
    await initial.close();
    const instance = readJson(root, ".explainer/service/instance.json");
    writeFile(
      root,
      ".explainer/service/instance.json",
      JSON.stringify({ ...instance, state: "running", pid: 2147483647 }),
    );
    const watch = readJson(root, ".explainer/service/watch.json");
    writeFile(
      root,
      ".explainer/service/watch.json",
      JSON.stringify({ ...watch, state: "current" }),
    );
    const recovering = await serve(root, "demo", "--recover");
    try {
      writeFile(root, "README.md", "manual indexing after recovery\n");
      const manual = (await xplJson(root, "index", "--precise", "off")).json;
      expect((await xplJson(root, "status", "--all")).json.index.commit).toBe(manual.commit);
      const bundle = (await (
        await fetch(new URL("/api/bundle", recovering.server.url))
      ).json()) as { index: { commit: string } };
      expect(bundle.index.commit).toBe(manual.commit);
      expect(readJson(root, ".explainer/service/watch.json").state).toBe("stopped");
    } finally {
      await recovering.close();
    }
    expect((await xplJson(root, "status", "--all")).json.watch.state).toBe("stopped");
  });

  it("pauses without interrupting jobs, then recovers the watched attachment and interrupts the old attempt", async () => {
    const root = cloneDir(demo);
    const initial = await serve(
      root,
      "demo",
      "--watch",
      "--backend",
      "claude",
      "--skill-dir",
      `${root}/chosen-skill`,
      "--job-timeout",
      "17",
    );
    const currentWatch = () => readJson(root, ".explainer/service/watch.json");
    await expect.poll(() => currentWatch().state, { timeout: 15000 }).toBe("current");
    const watch = currentWatch();
    const guide = readFile(root, ".explainer/demo.explainer.json");
    const instance = readJson(root, ".explainer/service/instance.json");
    const bundle = parseBundle(
      await (await fetch(new URL("/api/bundle", initial.server.url))).text(),
    );
    const ctx = createCtx(
      { out() {}, err() {} },
      {
        root,
        cwd: root,
        env: {},
        json: true,
        indexOption: undefined,
      },
    );
    const request = (
      await appendRequest(root, {
        id: "request-interrupted",
        elementId: "file:src/queue.ts",
        kind: "correct",
        note: "Explain the queued job.",
        explainer: "demo",
        context: artifactIdentity(bundle.explainer, bundle.index),
      })
    ).request;
    // Save a genuine running ledger, then restore it with the dead owner as a crash fixture.
    const jobs = await openJobs(
      ctx,
      instance.instanceId,
      async (_job, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true }),
        ),
    );
    let ledger: { jobs: Job[] };
    try {
      const job = await jobs.submit("demo", { id: randomUUID(), selectedRequestIds: [request.id] });
      await expect.poll(async () => (await jobs.get("demo", job.id)).state).toBe("running");
      const paused = await xplJson(root, "service", "pause");
      expect(paused.code, paused.err).toBe(0);
      expect(paused.json.state).toBe("running");
      expect(paused.json.watch.state).toBe("paused");
      expect(await jobs.get("demo", job.id)).toMatchObject({
        state: "running",
        owner: { instanceId: instance.instanceId },
      });
      ledger = readJson<{ jobs: Job[] }>(root, ".explainer/service/jobs.json");
    } finally {
      await jobs.close();
      await initial.close();
    }
    writeFile(
      root,
      ".explainer/service/instance.json",
      JSON.stringify({ ...instance, pid: 2147483647 }),
    );
    writeFile(root, ".explainer/service/watch.json", JSON.stringify(watch));
    writeFile(root, ".explainer/service/jobs.json", JSON.stringify(ledger));
    writeFile(root, "README.md", "changed after watched owner exited\n");
    const recovered = await serve(root, "--recover", "--watch");
    try {
      const owner = readJson(root, ".explainer/service/instance.json");
      expect(owner.instanceId).not.toBe(instance.instanceId);
      await expect
        .poll(() => [currentWatch().state, currentWatch().instanceId], { timeout: 15000 })
        .toEqual(["current", owner.instanceId]);
      const publication = currentWatch();
      expect(publication.generation).toBe(watch.generation + 1);
      expect(publication.index.commit).not.toBe(watch.index.commit);
      const attached = parseBundle(
        await (await fetch(new URL("/api/bundle", recovered.server.url))).text(),
      );
      expect(attached.server!.attachment!).toEqual({
        root,
        guide: ".explainer/demo.explainer.json",
        instanceId: owner.instanceId,
        backend: "claude",
        backendAvailable: true,
      });
      expect(attached.index.commit).toBe(publication.index.commit);
      expect(readJson(root, ".explainer/service/context.json")).toMatchObject({
        backend: "claude",
        skillDir: `${root}/chosen-skill`,
        jobTimeout: 17,
      });
      const history = (await (await fetch(new URL("/api/jobs", recovered.server.url))).json()) as {
        jobs: Job[];
      };
      expect(history.jobs).toEqual([
        {
          ...ledger.jobs[0],
          state: "interrupted",
          error: "Service interrupted this attempt. Inspect its progress and explicitly retry.",
          updatedAt: expect.any(String),
        },
      ]);
      expect(readFile(root, ".explainer/demo.explainer.json")).toBe(guide);
      expect(readJson(root, ".explainer/requests.json")[0].outcome.status).toBe("pending");
    } finally {
      await recovered.close();
    }
  });

  it("exposes local job history but rejects submission without a runner before selecting feedback", async () => {
    const root = cloneDir(demo);
    const running = await serve(root, "demo");
    try {
      const history = await fetch(new URL("/api/jobs", running.server.url));
      expect(history.status).toBe(200);
      expect(await history.json()).toEqual({
        available: false,
        reason:
          "Job runner unavailable. Start the service with --backend claude to use the installed, authenticated Claude Code CLI, or use manual xpl revise.",
        jobs: [],
      });
      const submission = {
        id: "39a00000-0000-4000-8000-000000000001",
        selectedRequestIds: ["request-does-not-exist"],
      };
      const submit = (body: unknown, headers: Record<string, string> = {}) =>
        fetch(new URL("/api/jobs", running.server.url), {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify(body),
        });
      expect((await submit(submission, { Origin: "https://foreign.example" })).status).toBe(403);
      expect((await submit(submission, { "Content-Type": "text/plain" })).status).toBe(415);
      expect((await submit({ ...submission, patch: {} })).status).toBe(400);
      const unavailable = await submit(submission);
      expect(unavailable.status).toBe(503);
      expect(await unavailable.json()).toMatchObject({
        error: expect.stringContaining("manual xpl revise"),
      });
      expect(existsSync(join(root, ".explainer/revisions"))).toBe(false);
      expect(readJson(root, ".explainer/service/jobs.json").jobs).toEqual([]);
      const unknown = await fetch(new URL(`/api/jobs/${submission.id}`, running.server.url));
      expect(unknown.status).toBe(404);
      expect(
        (
          await fetch(new URL(`/api/jobs/${submission.id}/accept`, running.server.url), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          })
        ).status,
      ).toBe(404);
    } finally {
      await running.close();
    }
    const restarted = await serve(root);
    try {
      expect(await (await fetch(new URL("/api/jobs", restarted.server.url))).json()).toMatchObject({
        jobs: [],
      });
    } finally {
      await restarted.close();
    }
  });

  it("publishes a stable guide attachment and refreshes its instance after restart", async () => {
    const root = cloneDir(demo);
    const first = await serve(
      root,
      "demo",
      "--backend",
      "claude",
      "--skill-dir",
      `${root}/chosen-skill`,
      "--job-timeout",
      "17",
    );
    let etag: string | null;
    let instanceId: string;
    try {
      expect(readJson(root, ".explainer/service/context.json")).toMatchObject({
        skillDir: `${root}/chosen-skill`,
        jobTimeout: 17,
      });
      const reported = await xpl(root, "service", "status");
      expect(reported.code).toBe(0);
      expect(reported.out).toContain("backend: claude (runner configured)");
      const response = await fetch(new URL("/api/bundle", first.server.url));
      const bundle = parseBundle(await response.text());
      instanceId = readJson(root, ".explainer/service/instance.json").instanceId;
      expect(bundle.server!.attachment!).toEqual({
        root,
        guide: ".explainer/demo.explainer.json",
        instanceId,
        backend: "claude",
        backendAvailable: true,
      });
      etag = (await fetch(new URL("/api/explainer", first.server.url))).headers.get("etag");
    } finally {
      await first.close();
    }
    const restarted = await serve(root);
    try {
      expect(readJson(root, ".explainer/service/context.json")).toMatchObject({
        skillDir: `${root}/chosen-skill`,
        jobTimeout: 17,
      });
      const bundle = parseBundle(
        await (await fetch(new URL("/api/bundle", restarted.server.url))).text(),
      );
      expect(bundle.server!.attachment!.root).toBe(root);
      expect(bundle.server!.attachment!.guide).toBe(".explainer/demo.explainer.json");
      expect(bundle.server!.attachment!.instanceId).not.toBe(instanceId!);
      expect(
        (await fetch(new URL("/api/explainer", restarted.server.url))).headers.get("etag"),
      ).not.toBe(etag!);
    } finally {
      await restarted.close();
    }
  });

  it.each(["restart", "recover"])(
    "reattaches its saved guide to the new watched publication after %s",
    async (action) => {
      const root = cloneDir(demo);
      const published = async (instanceId: string) => {
        await expect
          .poll(
            () => {
              try {
                const watch = readJson(root, ".explainer/service/watch.json");
                return { state: watch.state, instanceId: watch.instanceId };
              } catch {
                return null;
              }
            },
            { timeout: 15000 },
          )
          .toEqual({ state: "current", instanceId });
        return readJson(root, ".explainer/service/watch.json");
      };
      const first = await serve(root, "demo", "--watch", "--backend", "claude");
      const firstId = readJson(root, ".explainer/service/instance.json").instanceId;
      let previous;
      try {
        previous = await published(firstId);
      } finally {
        await first.close();
      }
      expect(readJson(root, ".explainer/service/watch.json").state).toBe("stopped");
      if (action === "recover") {
        const instance = readJson(root, ".explainer/service/instance.json");
        writeFile(
          root,
          ".explainer/service/instance.json",
          JSON.stringify({ ...instance, state: "running", pid: 2147483647 }),
        );
        writeFile(root, ".explainer/service/watch.json", JSON.stringify(previous));
      }
      writeFile(root, "README.md", "source changed while watch was stopped\n");
      const restarted = await serve(
        root,
        "--watch",
        ...(action === "recover" ? ["--recover"] : []),
      );
      try {
        const instanceId = readJson(root, ".explainer/service/instance.json").instanceId;
        expect(instanceId).not.toBe(firstId);
        const current = await published(instanceId);
        expect(current.index.commit).not.toBe(previous.index.commit);
        const attachment = { root, guide: ".explainer/demo.explainer.json" };
        const response = await fetch(new URL("/api/bundle", restarted.server.url), {
          headers: { "X-Xpl-Attachment": encodeURIComponent(JSON.stringify(attachment)) },
        });
        expect(response.status).toBe(200);
        const bundle = parseBundle(await response.text());
        expect(bundle.server!.attachment).toEqual({
          ...attachment,
          instanceId,
          backend: "claude",
          backendAvailable: true,
        });
        expect(bundle.index.commit).toBe(current.index.commit);
        expect((await xplJson(root, "status", "--all")).json.index.commit).toBe(
          current.index.commit,
        );
      } finally {
        await restarted.close();
      }
    },
  );

  it.each(["root", "guide"])(
    "refuses an attached page's different %s before reads or writes",
    async (field) => {
      const root = cloneDir(demo);
      const running = await serve(root, "demo");
      const attachment = { root, guide: ".explainer/demo.explainer.json" };
      const encode = () => encodeURIComponent(JSON.stringify(attachment));
      try {
        expect(
          (
            await fetch(new URL("/api/requests", running.server.url), {
              headers: { "X-Xpl-Attachment": encode() },
            })
          ).status,
        ).toBe(200);
        attachment[field as "root" | "guide"] =
          field === "root" ? cloneDir(demo) : ".explainer/another.explainer.json";
        for (const method of ["GET", "POST"]) {
          const response = await fetch(new URL("/api/requests", running.server.url), {
            method,
            headers: { "X-Xpl-Attachment": encode(), "Content-Type": "application/json" },
            ...(method === "POST"
              ? { body: JSON.stringify({ elementId: "file:src/queue.ts" }) }
              : {}),
          });
          expect(response.status).toBe(409);
          expect(await response.json()).toEqual({
            error:
              "This address serves a different repository or guide. Open that service's own URL.",
          });
        }
        const bookmark = new URL(running.server.url);
        bookmark.searchParams.set("attachment", JSON.stringify(attachment));
        expect((await fetch(bookmark)).status).toBe(409);
        expect(existsSync(join(root, ".explainer/requests.json"))).toBe(false);
      } finally {
        await running.close();
      }
    },
  );

  it("refuses an empty foreign service directory swapped while startup waits for ownership", async () => {
    const root = cloneDir(demo);
    const other = cloneDir(demo);
    const dir = join(root, ".explainer/service");
    const held = join(root, ".explainer/service-held");
    const foreign = join(other, ".explainer/service");
    mkdirSync(dir, { mode: 0o755 });
    mkdirSync(foreign);
    mkdirSync(join(dir, "instance.json.lock"));
    const abort = new AbortController();
    let settled = false;
    const done = invoke(["service", "start", "demo", "--root", root, "--port", "0"], {
      env: { XPL_VIEWER_HTML: viewer },
      signal: abort.signal,
    });
    done.then(() => {
      settled = true;
    });
    try {
      // Startup has checked and prepared this directory, but its ownership transaction is blocked.
      await expect.poll(() => statSync(dir).mode & 0o777).toBe(0o700);
      await delay(250);
      expect(settled).toBe(false);
      renameSync(dir, held);
      symlinkSync(foreign, dir);
      rmdirSync(join(held, "instance.json.lock"));
      const result = await done;
      expect(readdirSync(foreign)).toEqual([]);
      expect(result.code).toBe(1);
      expect(result.err).toContain("service artifact path leaves its repository");
    } finally {
      for (const path of [join(dir, "instance.json.lock"), join(held, "instance.json.lock")]) {
        try {
          rmdirSync(path);
        } catch {
          /* released by test */
        }
      }
      abort.abort();
      await done;
    }
  });

  const feedback = {
    id: "held-request",
    elementId: "file:src/queue.ts",
    kind: "explain",
    at: "2026-10-04T12:00:00.000Z",
    context: null,
    outcome: {
      revision: 0,
      status: "outdated",
      reason: "Original snapshot unavailable.",
      at: "2026-10-04T12:00:00.000Z",
    },
    explainer: "demo",
  };

  it.each([
    ["legacy", { elementId: "file:src/queue.ts" }],
    ["snapshot-bound", feedback],
  ])(
    "rejects a requests symlink swapped while %s feedback waits for its lock",
    async (_kind, body) => {
      const root = cloneDir(demo);
      const other = cloneDir(demo);
      const foreign = JSON.stringify([
        { ...feedback, id: "foreign-request", elementId: "file:src/runner.ts" },
      ]);
      const foreignPath = writeFile(other, ".explainer/requests.json", foreign);
      const running = await serve(root, "demo");
      const lock = join(root, ".explainer/requests.json.lock");
      mkdirSync(lock);
      let pending: Promise<Response> | undefined;
      try {
        expect((await fetch(new URL("/api/requests", running.server.url))).status).toBe(200);
        let settled = false;
        pending = fetch(new URL("/api/requests", running.server.url), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        pending.then(() => {
          settled = true;
        });
        // Keep the transaction blocked while the POST reaches the existing filesystem lock.
        await delay(250);
        expect(settled).toBe(false);
        symlinkSync(foreignPath, join(root, ".explainer/requests.json"));
        rmdirSync(lock);
        const response = await pending;
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({
          error: "service artifact path leaves its repository",
        });
        expect(lstatSync(join(root, ".explainer/requests.json")).isSymbolicLink()).toBe(true);
        expect(readFile(other, ".explainer/requests.json")).toBe(foreign);
      } finally {
        try {
          rmdirSync(lock);
        } catch {
          /* released by test */
        }
        await pending;
        await running.close();
      }
    },
  );

  it("keeps foreground --root job history attached when another cwd has the same guide", async () => {
    const root = cloneDir(demo);
    const outside = cloneDir(demo);
    const abort = new AbortController();
    let ready!: (server: ViewServer) => void;
    const listening = new Promise<ViewServer>((resolve) => {
      ready = resolve;
    });
    const done = invoke(["service", "start", "demo", "--root", root, "--port", "0"], {
      cwd: outside,
      env: { XPL_VIEWER_HTML: viewer },
      signal: abort.signal,
      onServer: ready,
    });
    try {
      const server = await Promise.race([
        listening,
        done.then((result) => {
          throw new Error(result.err || result.out);
        }),
      ]);
      const bundle = await fetch(new URL("/api/bundle", server.url));
      expect(bundle.status).toBe(200);
      expect(parseBundle(await bundle.text()).server!.attachment!.root).toBe(root);
      const history = await fetch(new URL("/api/jobs", server.url));
      expect(history.status).toBe(200);
      expect(await history.json()).toMatchObject({ available: false, jobs: [] });
    } finally {
      abort.abort();
      await done;
    }
  });

  it("resolves a repo-relative pinned index from outside the repository and persists its resolved path", async () => {
    const root = cloneDir(demo);
    const outside = makeTempDir();
    const index = join(
      ".explainer",
      readdirSync(join(root, ".explainer")).find((name) => /^index-.+\.json$/.test(name))!,
    );
    const abort = new AbortController();
    let ready!: (server: ViewServer) => void;
    const listening = new Promise<ViewServer>((resolve) => {
      ready = resolve;
    });
    const done = invoke(
      ["service", "start", "demo", "--root", root, "--index", index, "--port", "0"],
      { cwd: outside, env: { XPL_VIEWER_HTML: viewer }, signal: abort.signal, onServer: ready },
    );
    try {
      const server = await Promise.race([
        listening,
        done.then((r) => {
          throw new Error(r.err || r.out);
        }),
      ]);
      expect((await fetch(new URL("/api/bundle", server.url))).status).toBe(200);
      expect(readJson(root, ".explainer/service/context.json").index).toBe(join(root, index));
    } finally {
      abort.abort();
      await done;
    }
  });

  it("persists queued feedback before ownership becomes stopped while its request lock is held", async () => {
    const root = cloneDir(demo);
    const running = await serve(root, "demo");
    const lock = join(root, ".explainer/requests.json.lock");
    mkdirSync(lock);
    let pending: Promise<unknown> | undefined;
    try {
      expect((await fetch(new URL("/api/requests", running.server.url))).status).toBe(200);
      let settled = false;
      pending = fetch(new URL("/api/requests", running.server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(feedback),
      }).catch(() => undefined);
      pending.then(() => {
        settled = true;
      });
      await delay(250);
      expect(settled).toBe(false);
      const record = readJson(root, ".explainer/service/instance.json");
      const stop = await fetch(new URL("/api/service/stop", running.server.url), {
        method: "POST",
        headers: { Authorization: `Bearer ${record.token}`, "Content-Type": "application/json" },
        body: "{}",
      });
      expect(stop.status).toBe(200);
      expect(await stop.json()).toEqual({ instanceId: record.instanceId, root });
      // Give a premature shutdown time to mark ownership stopped while the writer is still blocked.
      await delay(50);
      expect(readJson(root, ".explainer/service/instance.json").state).toBe("running");
      rmdirSync(lock);
      await expect
        .poll(() => {
          if (readJson(root, ".explainer/service/instance.json").state !== "stopped") return null;
          return readJson(root, ".explainer/requests.json");
        })
        .toEqual([feedback]);
      expect((await running.done).code).toBe(0);
    } finally {
      try {
        rmdirSync(lock);
      } catch {
        /* released by test */
      }
      await pending;
      await running.close();
    }
  });

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
    const refused = await invoke(["service", "start", "--json"], {
      cwd: root,
      env: { XPL_VIEWER_HTML: viewer },
    });
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.out).error).toMatch(/interrupted.*--recover/);
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
      const refused = await invoke(["service", "start", "--recover", "--json"], {
        cwd: root,
        env: { XPL_VIEWER_HTML: viewer },
      });
      expect(refused.code).toBe(1);
      expect(JSON.parse(refused.out).error).toMatch(/PID is alive/);
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
      const duplicate = await invoke(["service", "start", "demo", "--json"], {
        cwd: alias,
        env: { XPL_VIEWER_HTML: viewer },
      });
      expect(duplicate.code).toBe(1);
      expect(JSON.parse(duplicate.out).error).toMatch(/already running/);
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
      const duplicate = await invoke(["service", "start", "demo", "--json"], {
        cwd: root,
        env: { XPL_VIEWER_HTML: viewer },
      });
      expect(duplicate.code).toBe(1);
      expect(JSON.parse(duplicate.out).error).toMatch(/already running/);
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
