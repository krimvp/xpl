import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, promises as filesystem } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { withRepositoryLock } from "../src/fsutil.js";
import { continueRevision } from "../src/revision.js";
import { beforeAll, expect, it, vi } from "vitest";
import { artifactIdentity, type Explainer } from "@xpl/core";
import { createCtx } from "../src/context.js";
import { openJobs, type JobRunner } from "../src/jobs.js";
import { loadExplainer, openWorkspace } from "../src/repo.js";
import { appendRequest, readRequests, recordOutcomes } from "../src/requests.js";
import {
  applyStdin,
  cloneDir,
  indexedFixture,
  readFile,
  readJson,
  writeFile,
  xpl,
} from "./helpers.js";

let demo: string;
beforeAll(async () => {
  demo = await indexedFixture();
  expect((await xpl(demo, "new", "demo")).code).toBe(0);
  expect(
    (
      await applyStdin(demo, {
        nodes: [{ id: "file:src/queue.ts", summary: "Queue holds pending jobs." }],
        views: [
          {
            id: "view:queue",
            type: "graph",
            title: "Queue",
            include: ["file:src/queue.ts"],
            edgeKinds: [],
          },
        ],
      })
    ).code,
  ).toBe(0);
});
async function setup() {
  const root = cloneDir(demo);
  const ctx = createCtx(
    { out() {}, err() {} },
    { root, cwd: root, env: {}, json: true, indexOption: undefined },
  );
  const loaded = loadExplainer(ctx, "demo");
  const ws = await openWorkspace(ctx, { explainer: loaded });
  const request = (
    await appendRequest(root, {
      id: "selected",
      elementId: "file:src/queue.ts",
      kind: "correct",
      note: "Explain pending jobs",
      explainer: "demo",
      context: artifactIdentity(loaded.explainer, ws.index),
    })
  ).request;
  const instanceId = randomUUID();
  const instance = () =>
    writeFile(
      root,
      ".explainer/service/instance.json",
      JSON.stringify({ schema: "xpl-service-instance@1", root, instanceId, state: "running" }),
    );
  instance();
  const runner: JobRunner = async (job) => ({
    revisionRunId: job.input.revisionRunId,
    proposals: [
      {
        id: request.id,
        patch: {
          nodes: [{ id: request.elementId, summary: "The queue holds jobs until dispatch." }],
        },
      },
    ],
  });
  const jobs = await openJobs(ctx, instanceId, runner);
  const job = await jobs.submit("demo", { id: randomUUID(), selectedRequestIds: [request.id] });
  await expect.poll(async () => (await jobs.get("demo", job.id)).state).toBe("completed");
  const finished = await jobs.get("demo", job.id);
  const action: { attemptId: string; reviewToken?: string } = {
    attemptId: finished.owner!.attemptId,
  };
  const choices = [{ id: request.id, status: "addressed" as const, reason: "Checked source." }];
  return { root, ctx, instanceId, request, jobs, job: finished, action, choices };
}

it("reviews selected proposals then accepts once, preserving feedback added during review", async () => {
  const { root, request, jobs, job, action, choices } = await setup();
  try {
    const before = readFile(root, ".explainer/demo.explainer.json");
    const review = await jobs.review("demo", job.id, action);
    expect(review.state).toBe("proposed");
    expect(
      review.proposals[0]!.changes.find((c) => c.id === request.elementId)!.after,
    ).toMatchObject({ summary: "The queue holds jobs until dispatch." });
    await expect(jobs.review("demo", job.id, { ...action, accept: true })).rejects.toThrow(
      "review author decisions",
    );
    await appendRequest(root, { ...request, id: "new-feedback", note: "Keep this for later." });
    const inspected = await jobs.review("demo", job.id, { ...action, decisions: choices });
    action.reviewToken = inspected.reviewToken;
    expect(inspected.state).toBe("reviewed");
    expect(readFile(root, ".explainer/demo.explainer.json")).toBe(before);
    expect(readRequests(root).requests.map((r) => r.outcome.status)).toEqual([
      "pending",
      "pending",
    ]);
    expect((await jobs.review("demo", job.id, { ...action, accept: true })).state).toBe("done");
    const after = readFile(root, ".explainer/demo.explainer.json");
    expect(JSON.parse(after).nodes.find((n: any) => n.id === request.elementId).summary).toBe(
      "The queue holds jobs until dispatch.",
    );
    expect(
      readRequests(root).requests.map((r) => [r.id, r.outcome.status, r.outcome.revision]),
    ).toEqual([
      ["selected", "addressed", 1],
      ["new-feedback", "pending", 0],
    ]);
    expect((await jobs.get("demo", job.id)).result?.accepted).toBe(true);
    await expect(jobs.fence("demo", job.id, "cancelled")).rejects.toThrow("acceptance has started");
    expect((await jobs.review("demo", job.id, { ...action, accept: true })).state).toBe("done");
    expect(readFile(root, ".explainer/demo.explainer.json")).toBe(after);
    expect(readRequests(root).requests.map((r) => r.outcome.revision)).toEqual([1, 0]);
  } finally {
    await jobs.close();
  }
});

it.each(["candidate", "reason"])(
  "refuses acceptance when another view changes the %s",
  async (change) => {
    const { root, request, jobs, job, action, choices } = await setup();
    try {
      const first = await jobs.review("demo", job.id, {
        ...action,
        decisions: change === "candidate" ? [{ ...choices[0]!, status: "rejected" }] : choices,
      });
      const second = await jobs.review("demo", job.id, {
        ...action,
        decisions: [{ ...choices[0]!, reason: "Reviewed in another view." }],
      });
      const before = readFile(root, ".explainer/demo.explainer.json");
      const feedback = readFile(root, ".explainer/requests.json");
      await expect(jobs.review("demo", job.id, { ...action, accept: true })).rejects.toMatchObject({
        extra: { status: 409 },
      });
      const stale = {
        ...action,
        accept: true,
        reviewToken: first.reviewToken,
      };
      await expect(jobs.review("demo", job.id, stale)).rejects.toMatchObject({
        message: "The decisions changed in another view; review again.",
        extra: { status: 409 },
      });
      expect(readFile(root, ".explainer/demo.explainer.json")).toBe(before);
      expect(readFile(root, ".explainer/requests.json")).toBe(feedback);
      const current = { ...action, accept: true, reviewToken: second.reviewToken };
      expect((await jobs.review("demo", job.id, current)).state).toBe("done");
      expect(
        readRequests(root).requests.map((r) => [r.id, r.outcome.status, r.outcome.reason]),
      ).toEqual([[request.id, "addressed", "Reviewed in another view."]]);
    } finally {
      await jobs.close();
    }
  },
);

it.each(["cancelled", "superseded", "old-attempt", "source", "content", "outcome"])(
  "refuses %s results without publishing or finalizing feedback",
  async (cause) => {
    const { root, request, jobs, job, action, choices } = await setup();
    try {
      action.reviewToken = (
        await jobs.review("demo", job.id, { ...action, decisions: choices })
      ).reviewToken;
      let expected: string;
      if (cause === "cancelled" || cause === "superseded") {
        await jobs.fence("demo", job.id, cause);
        expected = "cannot review";
      } else if (cause === "old-attempt") {
        action.attemptId = randomUUID();
        expected = "attempt";
      } else if (cause === "source") {
        writeFile(root, "src/queue.ts", readFile(root, "src/queue.ts") + "\n// changed source\n");
        expected = "index";
      } else if (cause === "content") {
        expect(
          (
            await applyStdin(
              root,
              { nodes: [{ id: request.elementId, summary: "Author text." }] },
              "--actor",
              "user",
            )
          ).code,
        ).toBe(0);
        expected = "changed since review";
      } else {
        await recordOutcomes(root, [
          {
            id: request.id,
            context: request.context,
            status: "unresolved",
            reason: "Another author.",
            expectedRevision: 0,
          },
        ]);
        expected = "changed since review";
      }
      const before = readFile(root, ".explainer/demo.explainer.json");
      const feedback = readFile(root, ".explainer/requests.json");
      await expect(jobs.review("demo", job.id, { ...action, accept: true })).rejects.toThrow(
        expected,
      );
      expect(readFile(root, ".explainer/demo.explainer.json")).toBe(before);
      expect(readFile(root, ".explainer/requests.json")).toBe(feedback);
    } finally {
      await jobs.close();
    }
  },
);

it.each(["artifact", "commit-receipt", "outcomes", "done-receipt"])(
  "recovers %s interruption and never republishes an already written candidate",
  async (boundary) => {
    const { root, ctx, instanceId, request, jobs, job, action, choices } = await setup();
    action.reviewToken = (
      await jobs.review("demo", job.id, { ...action, decisions: choices })
    ).reviewToken;
    const realRename = filesystem.rename;
    let stopped = false;
    let publications = 0;
    const spy = vi.spyOn(filesystem, "rename").mockImplementation(async (from, to) => {
      const destination = String(to);
      const data = JSON.parse(readFileSync(String(from), "utf8"));
      const stop =
        !stopped &&
        ((boundary === "artifact" && destination.endsWith("demo.explainer.json")) ||
          (boundary === "outcomes" && destination.endsWith("requests.json")) ||
          (destination.endsWith("run.json") &&
            data.state ===
              (boundary === "commit-receipt"
                ? "committed"
                : boundary === "done-receipt"
                  ? "done"
                  : "never")));
      if (stop) {
        stopped = true;
        throw new Error("Injected interruption");
      }
      if (destination.endsWith("demo.explainer.json")) publications++;
      return realRename(from, to);
    });
    syncBuiltinESMExports();
    try {
      await expect(jobs.review("demo", job.id, { ...action, accept: true })).rejects.toThrow(
        "Injected interruption",
      );
      expect(stopped).toBe(true);
      await jobs.close();
      await appendRequest(root, { ...request, id: "during-recovery", note: "Keep new feedback." });
      const reopened = await openJobs(ctx, instanceId);
      try {
        await expect(reopened.fence("demo", job.id, "superseded")).rejects.toThrow(
          "acceptance has started",
        );
        expect((await reopened.review("demo", job.id, { ...action, accept: true })).state).toBe(
          "done",
        );
        expect(publications).toBe(1);
        expect(
          readJson<Explainer>(root, ".explainer/demo.explainer.json").nodes.find(
            (n) => n.id === request.elementId,
          )!.summary,
        ).toBe("The queue holds jobs until dispatch.");
        expect(
          readRequests(root).requests.map((r) => [r.id, r.outcome.status, r.outcome.revision]),
        ).toEqual([
          ["selected", "addressed", 1],
          ["during-recovery", "pending", 0],
        ]);
        const bytes = readFile(root, ".explainer/demo.explainer.json");
        await reopened.review("demo", job.id, { ...action, accept: true });
        expect(publications).toBe(1);
        expect(readFile(root, ".explainer/demo.explainer.json")).toBe(bytes);
      } finally {
        await reopened.close();
      }
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
      await jobs.close();
    }
  },
);

it.each(["ledger", "revision", "artifact", "outcomes"])(
  "rechecks repository ownership after waiting for the %s lock",
  async (boundary) => {
    const { root, jobs, job, action, choices } = await setup();
    action.reviewToken = (
      await jobs.review("demo", job.id, { ...action, decisions: choices })
    ).reviewToken;
    const ledger = join(root, ".explainer/service/jobs.json");
    const revision = join(root, `.explainer/revisions/${job.input.revisionRunId}/run.json`);
    const artifact = join(root, ".explainer/demo.explainer.json");
    const outcomes = join(root, ".explainer/requests.json");
    const paths = { ledger, revision, artifact, outcomes };
    const before = [ledger, artifact, outcomes].map((p) => readFileSync(p, "utf8"));
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((r) => (entered = r)),
      held = new Promise<void>((r) => (release = r));
    const lock = withRepositoryLock(root, paths[boundary as keyof typeof paths], async () => {
      entered();
      await held;
    });
    await ready;
    const pending = jobs.review("demo", job.id, { ...action, accept: true });
    const rejection = expect(pending).rejects.toThrow("no longer owns");
    try {
      if (boundary !== "ledger")
        await expect
          .poll(() =>
            existsSync(
              (boundary === "revision" ? ledger : boundary === "artifact" ? revision : artifact) +
                ".lock",
            ),
          )
          .toBe(true);
      writeFile(
        root,
        ".explainer/service/instance.json",
        JSON.stringify({
          schema: "xpl-service-instance@1",
          root,
          instanceId: randomUUID(),
          state: "running",
        }),
      );
      release();
      await lock;
      await rejection;
      expect([ledger, artifact, outcomes].map((p) => readFileSync(p, "utf8"))).toEqual(before);
    } finally {
      release();
      await lock;
      await pending.catch(() => {});
    }
  },
);

it("a retry replaces an unready proposal's attempt fence and manual writes cannot bypass it", async () => {
  const { root, ctx, instanceId, request, jobs } = await setup();
  await jobs.close();
  let invocations = 0;
  const worker = await openJobs(ctx, instanceId, async (job) => ({
    revisionRunId: job.input.revisionRunId,
    proposals: [
      {
        id: request.id,
        patch: {
          nodes: [
            {
              id: request.elementId,
              summary:
                ++invocations === 1 ? "TODO explain this" : "The queue holds jobs until dispatch.",
            },
          ],
        },
      },
    ],
  }));
  try {
    const submitted = await worker.submit("demo", {
      id: randomUUID(),
      selectedRequestIds: [request.id],
    });
    await expect.poll(async () => (await worker.get("demo", submitted.id)).state).toBe("failed");
    const failed = await worker.get("demo", submitted.id);
    expect(failed.error).toContain("not ready for review");
    const old = { attemptId: failed.owner!.attemptId };
    await worker.retry("demo", failed.id, failed.attempt);
    await expect.poll(async () => (await worker.get("demo", failed.id)).state).toBe("completed");
    const retried = await worker.get("demo", failed.id);
    await expect(worker.review("demo", failed.id, old)).rejects.toThrow("attempt changed");
    const file = writeFile(
      root,
      ".explainer/manual-decisions.json",
      JSON.stringify([{ id: request.id, status: "addressed", reason: "Bypass" }]),
    );
    await expect(
      continueRevision(ctx, "demo", failed.input.revisionRunId, { decisions: file }),
    ).rejects.toThrow("guarded job review");
    await expect(
      continueRevision(ctx, "demo", failed.input.revisionRunId, { proposal: file }),
    ).rejects.toThrow("guarded job review");
    await expect(
      continueRevision(ctx, "demo", failed.input.revisionRunId, { accept: true }),
    ).rejects.toThrow("guarded job review");
    const review = await worker.review("demo", failed.id, { attemptId: retried.owner!.attemptId });
    expect(review.state).toBe("proposed");
    expect(
      review.proposals[0]!.changes.find((c) => c.id === request.elementId)!.after,
    ).toMatchObject({ summary: "The queue holds jobs until dispatch." });
    expect(readRequests(root).requests[0]!.outcome.status).toBe("pending");
  } finally {
    await worker.close();
  }
});

it("generated changes preserve user fields while committing the accepted summary", async () => {
  const root = cloneDir(demo);
  expect(
    (
      await applyStdin(
        root,
        { nodes: [{ id: "file:src/queue.ts", label: "My queue" }] },
        "--actor",
        "user",
      )
    ).code,
  ).toBe(0);
  const ctx = createCtx(
    { out() {}, err() {} },
    { root, cwd: root, env: {}, json: true, indexOption: undefined },
  );
  const loaded = loadExplainer(ctx, "demo"),
    ws = await openWorkspace(ctx, { explainer: loaded });
  const request = (
    await appendRequest(root, {
      id: "protected",
      elementId: "file:src/queue.ts",
      kind: "correct",
      explainer: "demo",
      context: artifactIdentity(loaded.explainer, ws.index),
    })
  ).request;
  const instanceId = randomUUID();
  writeFile(
    root,
    ".explainer/service/instance.json",
    JSON.stringify({ schema: "xpl-service-instance@1", root, instanceId, state: "running" }),
  );
  const jobs = await openJobs(ctx, instanceId, async (job) => ({
    revisionRunId: job.input.revisionRunId,
    proposals: [
      {
        id: request.id,
        patch: {
          nodes: [
            {
              id: request.elementId,
              label: "Generated label",
              summary: "The queue holds jobs until dispatch.",
            },
          ],
        },
      },
    ],
  }));
  try {
    const job = await jobs.submit("demo", { id: randomUUID(), selectedRequestIds: [request.id] });
    await expect.poll(async () => (await jobs.get("demo", job.id)).state).toBe("completed");
    const action: { attemptId: string; reviewToken?: string } = {
      attemptId: (await jobs.get("demo", job.id)).owner!.attemptId,
    };
    action.reviewToken = (
      await jobs.review("demo", job.id, {
        ...action,
        decisions: [{ id: request.id, status: "addressed", reason: "Keep my label." }],
      })
    ).reviewToken;
    await jobs.review("demo", job.id, { ...action, accept: true });
    expect(
      readJson<Explainer>(root, ".explainer/demo.explainer.json").nodes.find(
        (n) => n.id === request.elementId,
      ),
    ).toMatchObject({
      label: "My queue",
      summary: "The queue holds jobs until dispatch.",
      provenance: { userFields: ["label"] },
    });
  } finally {
    await jobs.close();
  }
});
