import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { renameSync, symlinkSync, unlinkSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { CliError } from "../src/errors.js";
import { createCtx } from "../src/context.js";
import { openJobs, type JobRunner } from "../src/jobs.js";
import { appendRequest } from "../src/requests.js";
import { recordOutcomes } from "../src/requests.js";
import { startViewServer } from "../src/server.js";
import { withRepositoryLock } from "../src/fsutil.js";
import { artifactIdentity } from "@xpl/core";
import { loadExplainer, openWorkspace } from "../src/repo.js";
import {
  cloneDir,
  indexedFixture,
  PATCH_PATH,
  readFile,
  readJson,
  writeFile,
  xpl,
  STUB_VIEWER_HTML,
} from "./helpers.js";

let demo: string;
beforeAll(async () => {
  demo = await indexedFixture();
  expect((await xpl(demo, "new", "demo")).code).toBe(0);
  expect((await xpl(demo, "apply", "demo", PATCH_PATH)).code).toBe(0);
});

async function setup() {
  const root = cloneDir(demo);
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
  const loaded = loadExplainer(ctx, "demo");
  const ws = await openWorkspace(ctx, { explainer: loaded });
  const request = (
    await appendRequest(root, {
      id: "request-original",
      elementId: "file:src/queue.ts",
      kind: "correct",
      note: "Explain the queued job.",
      explainer: "demo",
      context: artifactIdentity(loaded.explainer, ws.index),
    })
  ).request;
  const instanceId = randomUUID();
  writeFile(
    root,
    ".explainer/service/instance.json",
    JSON.stringify({
      schema: "xpl-service-instance@1",
      root,
      instanceId,
      state: "running",
    }),
  );
  return { root, ctx, request, instanceId };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("durable job lifecycle (controlled runner only)", () => {
  it("deduplicates delivery, freezes selection and persists completion without applying a patch", async () => {
    const { root, ctx, request, instanceId } = await setup();
    const entered = deferred<void>();
    const finish = deferred<{ revisionRunId: string }>();
    const runner: JobRunner = async (job, _signal, progress) => {
      await progress("Reading selected feedback");
      entered.resolve();
      return finish.promise;
    };
    const jobs = await openJobs(ctx, instanceId, runner);
    try {
      const original = readFile(root, ".explainer/demo.explainer.json");
      const id = randomUUID();
      const submitted = await jobs.submit("demo", { id, selectedRequestIds: [request.id] });
      await entered.promise;
      const repeated = await jobs.submit("demo", { id, selectedRequestIds: [request.id] });
      expect(repeated.id).toBe(id);
      expect(repeated.input.revisionRunId).toBe(submitted.input.revisionRunId);
      await expect(jobs.submit("demo", { id, selectedRequestIds: ["different"] })).rejects.toThrow(
        "already used",
      );
      await appendRequest(root, {
        ...request,
        id: "request-new",
        note: "Keep this request for later.",
      });
      finish.resolve({ revisionRunId: submitted.input.revisionRunId });
      await expect.poll(async () => (await jobs.get("demo", id)).state).toBe("completed");
      const saved = await jobs.get("demo", id);
      expect(saved.selectedRequestIds).toEqual(["request-original"]);
      expect(saved.input.requests.map((r) => r.id)).toEqual(["request-original"]);
      expect(saved.progress.map((p) => p.message)).toEqual(["Reading selected feedback"]);
      expect(saved.attempt).toBe(1);
      expect(saved.result).toEqual({ revisionRunId: submitted.input.revisionRunId });
      expect(readFile(root, ".explainer/demo.explainer.json")).toBe(original);
      expect(
        readJson(root, ".explainer/requests.json").map(
          (r: { id: string; outcome: { status: string } }) => [r.id, r.outcome.status],
        ),
      ).toEqual([
        ["request-original", "pending"],
        ["request-new", "pending"],
      ]);
      await expect(jobs.retry("demo", id, 1)).rejects.toThrow("cannot retry completed");
    } finally {
      await jobs.close();
    }
  });

  it.each(["cancelled", "superseded"] as const)(
    "fences %s work and serializes conflicting invocations until the old runner exits",
    async (state) => {
      const { ctx, request, instanceId } = await setup();
      const invocations: {
        job: Parameters<JobRunner>[0];
        signal: AbortSignal;
        progress: (message: string) => Promise<void>;
        finish: ReturnType<typeof deferred<{ revisionRunId: string }>>;
      }[] = [];
      const jobs = await openJobs(ctx, instanceId, async (job, signal, progress) => {
        const finish = deferred<{ revisionRunId: string }>();
        invocations.push({ job, signal, progress, finish });
        return finish.promise;
      });
      try {
        const first = await jobs.submit("demo", {
          id: randomUUID(),
          selectedRequestIds: [request.id],
        });
        await expect.poll(() => invocations.length).toBe(1);
        const second = await jobs.submit("demo", {
          id: randomUUID(),
          selectedRequestIds: [request.id],
        });
        expect((await jobs.get("demo", second.id)).state).toBe("queued");
        await jobs.fence("demo", first.id, state);
        expect(invocations[0]!.signal.aborted).toBe(true);
        await invocations[0]!.progress("Late ignored progress");
        expect(invocations.length).toBe(1);
        expect((await jobs.get("demo", first.id)).progress).toEqual([]);
        invocations[0]!.finish.resolve({ revisionRunId: first.input.revisionRunId });
        await expect.poll(() => invocations.length).toBe(2);
        expect((await jobs.get("demo", first.id)).state).toBe(state);
        expect((await jobs.get("demo", first.id)).result).toBeNull();
        await expect(jobs.retry("demo", first.id, 1)).rejects.toThrow(`cannot retry ${state}`);
        invocations[1]!.finish.resolve({ revisionRunId: second.input.revisionRunId });
        await expect.poll(async () => (await jobs.get("demo", second.id)).state).toBe("completed");
        await jobs.fence("demo", second.id, state);
        expect((await jobs.get("demo", second.id)).result).toBeNull();
      } finally {
        await jobs.close();
      }
    },
  );

  it("retains running history and stops scheduling when group cleanup fails", async () => {
    const { ctx, request, instanceId } = await setup();
    const entered = deferred<void>();
    const finish = deferred<void>();
    let invocations = 0;
    const jobs = await openJobs(ctx, instanceId, async () => {
      invocations++;
      entered.resolve();
      await finish.promise;
      throw new CliError("Claude group still has live members", 1, { code: "JOB_PROCESS_CLEANUP" });
    });
    try {
      const first = await jobs.submit("demo", {
        id: randomUUID(),
        selectedRequestIds: [request.id],
      });
      await entered.promise;
      const second = await jobs.submit("demo", {
        id: randomUUID(),
        selectedRequestIds: [request.id],
      });
      finish.resolve();
      await expect.poll(() => jobs.availability.available).toBe(false);
      expect(jobs.availability.reason).toContain("Claude group still has live members");
      expect((await jobs.list("demo")).map(({ state }) => state)).toEqual(["running", "queued"]);
      expect(invocations).toBe(1);
      expect((await jobs.retry("demo", first.id, 1)).state).toBe("running");
      expect((await jobs.get("demo", second.id)).attempt).toBe(0);
      await expect(
        jobs.submit("demo", { id: randomUUID(), selectedRequestIds: [request.id] }),
      ).rejects.toThrow("Job scheduler stopped");
    } finally {
      finish.resolve();
      await jobs.close();
    }
  });

  it("retries a failed invocation once with the same job, revision and immutable request IDs", async () => {
    const { ctx, request, instanceId } = await setup();
    let calls = 0;
    const finish = deferred<{ revisionRunId: string }>();
    let lateProgress!: (message: string) => Promise<void>;
    const jobs = await openJobs(ctx, instanceId, async (_job, _signal, progress) => {
      if (++calls === 1) {
        lateProgress = progress;
        throw new Error("Configured tool failed: repair its local installation and retry.");
      }
      return finish.promise;
    });
    try {
      const original = await jobs.submit("demo", {
        id: randomUUID(),
        selectedRequestIds: [request.id],
      });
      await expect.poll(async () => (await jobs.get("demo", original.id)).state).toBe("failed");
      expect((await jobs.get("demo", original.id)).error).toBe(
        "Configured tool failed: repair its local installation and retry.",
      );
      await jobs.retry("demo", original.id, 1);
      await jobs.retry("demo", original.id, 1);
      await expect.poll(() => calls).toBe(2);
      await lateProgress("Late progress from the failed attempt");
      expect((await jobs.get("demo", original.id)).progress).toEqual([]);
      expect((await jobs.get("demo", original.id)).input).toEqual(original.input);
      finish.resolve({ revisionRunId: original.input.revisionRunId });
      await expect.poll(async () => (await jobs.get("demo", original.id)).state).toBe("completed");
      expect((await jobs.get("demo", original.id)).attempt).toBe(2);
    } finally {
      await jobs.close();
    }
  });

  it("deduplicates retry delivery even after the new attempt has already failed", async () => {
    const { ctx, request, instanceId } = await setup();
    let calls = 0;
    const jobs = await openJobs(ctx, instanceId, async () => {
      calls++;
      throw new Error("Tool remains unavailable");
    });
    try {
      const job = await jobs.submit("demo", { id: randomUUID(), selectedRequestIds: [request.id] });
      await expect.poll(async () => (await jobs.get("demo", job.id)).state).toBe("failed");
      await jobs.retry("demo", job.id, 1);
      await expect.poll(async () => (await jobs.get("demo", job.id)).attempt).toBe(2);
      await expect.poll(async () => (await jobs.get("demo", job.id)).state).toBe("failed");
      const repeated = await jobs.retry("demo", job.id, 1);
      expect(repeated.state).toBe("failed");
      expect(repeated.attempt).toBe(2);
      expect(calls).toBe(2);
    } finally {
      await jobs.close();
    }
  });

  it("selects, dispatches and retries with repository-owned guide/index paths from another cwd", async () => {
    const { root, ctx, request, instanceId } = await setup();
    const outside = cloneDir(demo);
    const index = readJson(root, ".explainer/demo.explainer.json").index.path;
    writeFile(outside, index, "{}");
    let calls = 0;
    const jobs = await openJobs(
      { ...ctx, cwd: outside, indexOption: index },
      instanceId,
      async (job) => {
        if (++calls === 1)
          throw new Error("Controlled failure after reading the attached snapshot");
        return { revisionRunId: job.input.revisionRunId };
      },
    );
    try {
      const job = await jobs.submit("demo", { id: randomUUID(), selectedRequestIds: [request.id] });
      await expect.poll(async () => (await jobs.get("demo", job.id)).state).toBe("failed");
      expect((await jobs.get("demo", job.id)).error).toBe(
        "Controlled failure after reading the attached snapshot",
      );
      expect(job.scope.guide).toBe(".explainer/demo.explainer.json");
      expect(job.input.index).toBe(index);
      await jobs.retry("demo", job.id, 1);
      await expect.poll(async () => (await jobs.get("demo", job.id)).state).toBe("completed");
      expect(calls).toBe(2);
      expect(readFile(outside, index)).toBe("{}");
    } finally {
      await jobs.close();
    }
  });

  it("recovers without killing a reused process ID, replaying completed jobs or publishing a late result", async () => {
    const { root, ctx, request, instanceId } = await setup();
    const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      detached: true,
      stdio: "ignore",
    });
    await once(unrelated, "spawn");
    const entered = deferred<void>();
    const finish = deferred<{ revisionRunId: string }>();
    const old = await openJobs(ctx, instanceId, async (_job, _signal, _progress, started) => {
      await started({
        groupId: unrelated.pid!,
        startTime: "00000000-0000-0000-0000-000000000000:0",
      });
      entered.resolve();
      return finish.promise;
    });
    const job = await old.submit("demo", { id: randomUUID(), selectedRequestIds: [request.id] });
    await entered.promise;
    const newInstance = randomUUID();
    writeFile(
      root,
      ".explainer/service/instance.json",
      JSON.stringify({
        schema: "xpl-service-instance@1",
        root,
        instanceId: newInstance,
        state: "starting",
      }),
    );
    let calls = 0;
    const restarted = await openJobs(ctx, newInstance, async (selected) => {
      calls++;
      return { revisionRunId: selected.input.revisionRunId };
    });
    try {
      expect((await restarted.get("demo", job.id)).state).toBe("interrupted");
      expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
      expect(calls).toBe(0);
      await restarted.retry("demo", job.id, 1);
      await expect.poll(async () => (await restarted.get("demo", job.id)).state).toBe("completed");
      finish.resolve({ revisionRunId: job.input.revisionRunId });
      await expect.poll(() => old.availability.available).toBe(false);
      expect((await restarted.get("demo", job.id)).attempt).toBe(2);
      expect((await restarted.get("demo", job.id)).owner!.instanceId).toBe(newInstance);
      await restarted.close();
      const history = await openJobs(ctx, newInstance);
      try {
        expect((await history.get("demo", job.id)).state).toBe("completed");
        expect(
          (await history.submit("demo", { id: job.id, selectedRequestIds: [request.id] })).state,
        ).toBe("completed");
        expect(calls).toBe(1);
      } finally {
        await history.close();
      }
    } finally {
      if (restarted.availability.available) await restarted.close();
      if (unrelated.exitCode === null && unrelated.signalCode === null) {
        const exited = once(unrelated, "exit");
        unrelated.kill("SIGKILL");
        await exited;
      }
    }
  });

  it("refuses a second worker in the same live instance instead of interrupting its active job", async () => {
    const { ctx, request, instanceId } = await setup();
    const entered = deferred<void>();
    const finish = deferred<{ revisionRunId: string }>();
    const jobs = await openJobs(ctx, instanceId, async () => {
      entered.resolve();
      return finish.promise;
    });
    try {
      const job = await jobs.submit("demo", { id: randomUUID(), selectedRequestIds: [request.id] });
      await entered.promise;
      await expect(openJobs(ctx, instanceId)).rejects.toThrow("already owns a running job");
      expect((await jobs.get("demo", job.id)).state).toBe("running");
      finish.resolve({ revisionRunId: job.input.revisionRunId });
      await expect.poll(async () => (await jobs.get("demo", job.id)).state).toBe("completed");
    } finally {
      await jobs.close();
    }
  });

  it.each(["source", "guide", "outcome"] as const)(
    "keeps failed work retryable but refuses its changed %s snapshot",
    async (kind) => {
      const { root, ctx, request, instanceId } = await setup();
      const jobs = await openJobs(ctx, instanceId, async () => {
        throw new Error("Retryable tool failure");
      });
      try {
        const job = await jobs.submit("demo", {
          id: randomUUID(),
          selectedRequestIds: [request.id],
        });
        await expect.poll(async () => (await jobs.get("demo", job.id)).state).toBe("failed");
        if (kind === "outcome")
          await recordOutcomes(root, [
            {
              id: request.id,
              context: request.context,
              status: "unresolved",
              reason: "Author tried a manual revision.",
            },
          ]);
        else if (kind === "source")
          writeFile(
            root,
            "src/queue.ts",
            readFile(root, "src/queue.ts") + "\n// new source context\n",
          );
        if (kind === "guide") {
          const patch = writeFile(
            root,
            ".explainer/user.patch.json",
            JSON.stringify({
              nodes: [{ id: "file:src/queue.ts", summary: "The author owns this explanation." }],
            }),
          );
          expect((await xpl(root, "apply", "demo", patch, "--actor", "user")).code).toBe(0);
        }
        const beforeRetry = readFile(root, ".explainer/service/jobs.json");
        await expect(jobs.retry("demo", job.id, 1)).rejects.toThrow(
          kind === "outcome"
            ? "selected request request-original changed"
            : "source or explanation changed",
        );
        expect(readFile(root, ".explainer/service/jobs.json")).toBe(beforeRetry);
        expect((await jobs.get("demo", job.id)).attempt).toBe(1);
      } finally {
        await jobs.close();
      }
    },
  );

  it.each(["storage", "owner"] as const)(
    "rechecks %s after waiting for a writer lock without changing ledger bytes",
    async (target) => {
      const { root, ctx, request, instanceId } = await setup();
      const jobs = await openJobs(ctx, instanceId, async () => {
        throw new Error("Retryable tool failure");
      });
      const job = await jobs.submit("demo", { id: randomUUID(), selectedRequestIds: [request.id] });
      await expect.poll(async () => (await jobs.get("demo", job.id)).state).toBe("failed");
      const path = ".explainer/service/jobs.json";
      const original = readFile(root, path);
      const instancePath = ".explainer/service/instance.json";
      const originalInstance = readFile(root, instancePath);
      const held = deferred<void>();
      const release = deferred<void>();
      const holder = withRepositoryLock(root, `${root}/${path}`, async () => {
        held.resolve();
        await release.promise;
      });
      await held.promise;
      const cancel = jobs.fence("demo", job.id, "cancelled");
      await new Promise<void>((resolve) => setImmediate(resolve));
      const foreign = cloneDir(demo);
      if (target === "storage") {
        renameSync(`${root}/${path}`, `${root}/${path}.held`);
        const foreignPath = writeFile(foreign, path, original);
        symlinkSync(foreignPath, `${root}/${path}`);
      } else {
        writeFile(
          root,
          instancePath,
          JSON.stringify({ ...JSON.parse(originalInstance), instanceId: randomUUID() }),
        );
      }
      release.resolve();
      await holder;
      try {
        await expect(cancel).rejects.toThrow(
          target === "storage" ? "leaves its repository" : "no longer owns this repository service",
        );
        expect(readFile(root, path)).toBe(original);
        if (target === "storage") expect(readFile(foreign, path)).toBe(original);
      } finally {
        if (target === "storage") {
          unlinkSync(`${root}/${path}`);
          renameSync(`${root}/${path}.held`, `${root}/${path}`);
        } else writeFile(root, instancePath, originalInstance);
        await jobs.close();
      }
    },
  );

  it("adapts submission, scoped status and cancellation through the managed HTTP routes", async () => {
    const { root, ctx, request, instanceId } = await setup();
    const entered = deferred<void>();
    const finish = deferred<{ revisionRunId: string }>();
    const jobs = await openJobs(ctx, instanceId, async () => {
      entered.resolve();
      return finish.promise;
    });
    const server = await startViewServer({
      env: ctx,
      explainerPath: `${root}/.explainer/demo.explainer.json`,
      host: "127.0.0.1",
      port: 0,
      viewerHtml: () => STUB_VIEWER_HTML,
      control: { root, instanceId, token: "local-test-token", backend: "none", jobs, stop() {} },
    });
    const post = async (path: string, body: unknown) =>
      fetch(new URL(path, server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    try {
      const id = randomUUID();
      const submitted = await post("/api/jobs", { id, selectedRequestIds: [request.id] });
      expect(submitted.status).toBe(200);
      const original = JSON.parse(await submitted.text()).job;
      await entered.promise;
      expect(await (await fetch(new URL(`/api/jobs/${id}`, server.url))).json()).toMatchObject({
        job: { state: "running" },
      });
      const cancelled = await post(`/api/jobs/${id}/cancel`, {});
      expect(cancelled.status).toBe(200);
      expect(await cancelled.json()).toMatchObject({ job: { state: "cancelled" } });
      expect((await post(`/api/jobs/${id}/retry`, { expectedAttempt: 1 })).status).toBe(409);
      finish.resolve({ revisionRunId: original.input.revisionRunId });
      await jobs.close();
      expect((await jobs.get("demo", id)).result).toBeNull();
      expect((await xpl(root, "new", "other")).code).toBe(0);
      expect(await jobs.list("other")).toEqual([]);
      await expect(jobs.get("other", id)).rejects.toThrow("unknown job for this guide");
    } finally {
      await server.close();
      if (jobs.availability.available) await jobs.close();
    }
  });

  it("stops a running attempt, retains queued work and refuses a corrupt ledger without replacing it", async () => {
    const { root, ctx, request, instanceId } = await setup();
    const entered = deferred<void>();
    const jobs = await openJobs(ctx, instanceId, async () => {
      entered.resolve();
      return new Promise(() => {});
    });
    const first = await jobs.submit("demo", { id: randomUUID(), selectedRequestIds: [request.id] });
    await entered.promise;
    const second = await jobs.submit("demo", {
      id: randomUUID(),
      selectedRequestIds: [request.id],
    });
    await jobs.close();
    expect((await jobs.get("demo", first.id)).state).toBe("interrupted");
    expect((await jobs.get("demo", second.id)).state).toBe("queued");
    const path = ".explainer/service/jobs.json";
    const ledger = readJson(root, path);
    ledger.jobs[0].state = "completed";
    writeFile(root, path, JSON.stringify(ledger));
    const corrupt = readFile(root, path);
    await expect(openJobs(ctx, instanceId)).rejects.toThrow("completed job has no result");
    expect(readFile(root, path)).toBe(corrupt);
  });
});
