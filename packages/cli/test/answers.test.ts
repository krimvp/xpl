import { renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { beforeAll, expect, it } from "vitest";
import {
  hashText,
  artifactIdentity,
  FEEDBACK_SCHEMA,
  parseFeedbackFile,
  sliceLines,
  validateFeedbackAnswer,
  type FeedbackRequest,
  type ViewerBundle,
} from "@xpl/core";
import { createCtx } from "../src/context.js";
import { claudeAnswerRunner } from "../src/claude-runner.js";
import { startViewServer } from "../src/server.js";
import { openJobs, type AnswerRunner } from "../src/jobs.js";
import { loadExplainer, openWorkspace } from "../src/repo.js";
import { appendRequest, importRequests, readRequests } from "../src/requests.js";
import {
  STUB_VIEWER_HTML,
  applyStdin,
  git,
  makeTempDir,
  cloneDir,
  indexedFixture,
  PATCH_PATH,
  readFile,
  readJson,
  writeFile,
  xpl,
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
    { root, cwd: root, env: {}, json: true, indexOption: undefined },
  );
  const loaded = loadExplainer(ctx, "demo");
  const ws = await openWorkspace(ctx, { explainer: loaded });
  const { request } = await appendRequest(root, {
    id: "question-original",
    elementId: "file:src/queue.ts",
    kind: "explain",
    note: "How is a job queued?",
    explainer: "demo",
    context: artifactIdentity(loaded.explainer, ws.index),
    range: { file: "src/queue.ts", side: "head", fromLine: 1, toLine: 2 },
  });
  const instanceId = randomUUID();
  writeFile(
    root,
    ".explainer/service/instance.json",
    JSON.stringify({ schema: "xpl-service-instance@1", root, instanceId, state: "running" }),
  );
  return { root, ctx, request, instanceId };
}

function evidence(job: Parameters<AnswerRunner>[0]) {
  const source = job.input.sources.find((s) => s.file === "src/queue.ts" && s.side === "head")!;
  return {
    text: "Queue holds jobs.",
    references: [
      {
        file: source.file,
        side: source.side,
        fromLine: 1,
        toLine: 2,
        quote: sliceLines(source.text, { startLine: 1, endLine: 2 }),
      },
    ],
  };
}

function history(root: string, request: FeedbackRequest, count: number, prefix: string) {
  const text = readFile(root, "src/queue.ts");
  const answer = validateFeedbackAnswer(
    {
      text: "Queue holds jobs.",
      references: [
        {
          file: "src/queue.ts",
          side: "head",
          fromLine: 1,
          toLine: 1,
          quote: "export interface Job {",
        },
      ],
    },
    request,
    [{ file: "src/queue.ts", side: "head", text, hash: hashText(text) }],
    prefix,
    "2026-10-05T00:00:00.000Z",
  );
  return Array.from({ length: count }, (_, i) => ({ ...answer, id: `${prefix}-${i}` }));
}

it("rejects an overflowing history import without changing the readable store", async () => {
  const { root, request } = await setup();
  await importRequests(root, [{ ...request, answers: history(root, request, 600, "first") }]);
  expect(readRequests(root).requests[0]?.answers).toHaveLength(600);
  const before = readFile(root, ".explainer/requests.json");
  await expect(
    importRequests(root, [{ ...request, answers: history(root, request, 600, "second") }]),
  ).rejects.toThrow("answers must be an array of at most 1000 entries");
  expect(readFile(root, ".explainer/requests.json")).toBe(before);
  expect(readRequests(root).error).toBeUndefined();
  expect(readRequests(root).requests[0]?.answers).toHaveLength(600);
});

it.each(["overflow", "cross-request ID collision"] as const)(
  "rejects answer completion on %s without publishing history or a result receipt",
  async (conflict) => {
    const { root, ctx, request, instanceId } = await setup();
    const id = randomUUID();
    let requestId = request.id;
    if (conflict === "overflow") {
      await importRequests(root, [{ ...request, answers: history(root, request, 1000, "saved") }]);
    } else {
      const answer = { ...history(root, request, 1, "saved")[0]!, id };
      requestId = "question-second";
      await importRequests(root, [
        { ...request, answers: [answer] },
        { ...request, id: requestId },
      ]);
    }
    const before = readFile(root, ".explainer/requests.json");
    const jobs = await openJobs(ctx, instanceId, undefined, async (job) => evidence(job));
    try {
      await jobs.submitAnswer("demo", { id, requestId });
      // Read the durable lifecycle directly: history reconciliation must not mask a bad receipt.
      await expect
        .poll(() => readJson(root, ".explainer/service/jobs.json").jobs[0].state, {
          timeout: 10_000,
        })
        .toBe("failed");
      const failed = await jobs.getAnswer("demo", id);
      expect(failed.error).toBe(
        conflict === "overflow"
          ? "answers must be an array of at most 1000 entries"
          : `answer ID ${id} belongs to another request`,
      );
      expect(failed.result).toBeNull();
      expect(readFile(root, ".explainer/requests.json")).toBe(before);
      expect(readRequests(root).error).toBeUndefined();
    } finally {
      await jobs.close();
    }
  },
);

it.each(["source", "guide"] as const)(
  "answers frozen context after a mid-run %s change and ports history without editing guide/outcomes",
  async (changed) => {
    const { root, ctx, request, instanceId } = await setup();
    let finish!: () => void;
    let calls = 0;
    const jobs = await openJobs(ctx, instanceId, undefined, async (job, _signal, progress) => {
      calls++;
      await progress("Reading frozen source");
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return evidence(job);
    });
    try {
      let before = readFile(root, ".explainer/demo.explainer.json");
      const id = randomUUID();
      await jobs.submitAnswer("demo", { id, requestId: request.id });
      await expect.poll(() => typeof finish).toBe("function");
      expect((await jobs.submitAnswer("demo", { id, requestId: request.id })).id).toBe(id);
      if (changed === "source")
        writeFile(
          root,
          "src/queue.ts",
          "// changed while answering\n" + readFile(root, "src/queue.ts"),
        );
      else {
        expect(
          (
            await applyStdin(
              root,
              {
                nodes: [
                  { id: "file:src/queue.ts", summary: "Author changed this queue explanation." },
                ],
              },
              "--actor",
              "user",
            )
          ).code,
        ).toBe(0);
        before = readFile(root, ".explainer/demo.explainer.json");
      }
      finish();
      await expect.poll(async () => (await jobs.getAnswer("demo", id)).state).toBe("completed");
      const completed = await jobs.getAnswer("demo", id);
      expect(completed.contextReason).toContain(
        changed === "source" ? "does not match" : "snapshot changed",
      );
      expect(completed.result?.context).toEqual(request.context);
      expect(completed.result?.references[0]?.quote).toBe("export interface Job {\n  id: string;");
      expect(readFile(root, ".explainer/demo.explainer.json")).toBe(before);
      expect(readRequests(root).requests[0]?.outcome).toEqual(request.outcome);
      const saved = readRequests(root).requests[0]!;
      expect(saved.answers?.map((a) => a.id)).toEqual([id]);
      const portable = parseFeedbackFile({ schema: FEEDBACK_SCHEMA, requests: [saved] });
      await importRequests(root, portable.requests);
      await importRequests(root, [request]);
      expect(readRequests(root).requests[0]?.answers).toEqual(saved.answers);
      await jobs.close();
      const restored = await openJobs(ctx, instanceId);
      try {
        expect((await restored.getAnswer("demo", id)).result).toEqual(completed.result);
        expect((await restored.submitAnswer("demo", { id, requestId: request.id })).state).toBe(
          "completed",
        );
        expect(calls).toBe(1);
      } finally {
        await restored.close();
      }
    } finally {
      finish?.();
      if (jobs.availability.available) await jobs.close();
    }
  },
);

it("fails bad evidence then retries once against the same input without duplicating an answer", async () => {
  const { root, ctx, request, instanceId } = await setup();
  let calls = 0;
  const jobs = await openJobs(ctx, instanceId, undefined, async (job) => {
    const output = evidence(job);
    if (++calls === 1) output.references[0]!.quote = "invented();";
    return output;
  });
  try {
    const original = await jobs.submitAnswer("demo", { id: randomUUID(), requestId: request.id });
    await expect.poll(async () => (await jobs.getAnswer("demo", original.id)).state).toBe("failed");
    expect((await jobs.getAnswer("demo", original.id)).error).toBe(
      "answer quote does not match recorded source range",
    );
    expect(readRequests(root).requests[0]?.answers).toBeUndefined();
    await jobs.retry("demo", original.id, 1);
    await expect
      .poll(async () => (await jobs.getAnswer("demo", original.id)).state)
      .toBe("completed");
    await jobs.retry("demo", original.id, 1);
    expect((await jobs.getAnswer("demo", original.id)).input).toEqual(original.input);
    expect(readRequests(root).requests[0]?.answers?.map((a) => a.id)).toEqual([original.id]);
    expect(calls).toBe(2);
  } finally {
    await jobs.close();
  }
});

it.each(["cancelled", "superseded"] as const)(
  "fences a late %s answer and serializes the next invocation",
  async (state) => {
    const { root, ctx, request, instanceId } = await setup();
    let finish!: () => void;
    let signal!: AbortSignal;
    let calls = 0;
    const jobs = await openJobs(ctx, instanceId, undefined, async (job, abort) => {
      if (++calls > 1) return evidence(job);
      signal = abort;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return evidence(job);
    });
    try {
      const job = await jobs.submitAnswer("demo", { id: randomUUID(), requestId: request.id });
      await expect.poll(() => typeof finish).toBe("function");
      const next = await jobs.submitAnswer("demo", { id: randomUUID(), requestId: request.id });
      await jobs.fence("demo", job.id, state);
      expect(signal.aborted).toBe(true);
      expect(calls).toBe(1);
      finish();
      await expect
        .poll(async () => (await jobs.getAnswer("demo", next.id)).state)
        .toBe("completed");
      expect((await jobs.getAnswer("demo", job.id)).state).toBe(state);
      expect((await jobs.getAnswer("demo", job.id)).result).toBeNull();
      expect(readRequests(root).requests[0]?.answers?.map((a) => a.id)).toEqual([next.id]);
      expect(readRequests(root).requests[0]?.outcome).toEqual(request.outcome);
    } finally {
      finish?.();
      if (jobs.availability.available) await jobs.close();
    }
  },
);

it("replays a completed publication after restart and preserves newer outcomes and new requests", async () => {
  const { root, ctx, request, instanceId } = await setup();
  const jobs = await openJobs(ctx, instanceId, undefined, async (job) => evidence(job));
  const job = await jobs.submitAnswer("demo", { id: randomUUID(), requestId: request.id });
  await expect.poll(async () => (await jobs.getAnswer("demo", job.id)).state).toBe("completed");
  await jobs.close();
  const newer = {
    ...request,
    outcome: {
      ...request.outcome,
      revision: 1,
      status: "unresolved" as const,
      reason: "Needs a guide edit.",
    },
  };
  // Simulate a crash after the job receipt but before its separate request-history write.
  writeFile(
    root,
    ".explainer/requests.json",
    JSON.stringify([newer, { ...request, id: "question-new" }]),
  );
  const restarted = await openJobs(ctx, instanceId);
  try {
    const requests = readRequests(root).requests;
    expect(
      requests.map((r) => [r.id, r.outcome.status, r.answers?.map((a) => a.id) ?? []]),
    ).toEqual([
      [request.id, "unresolved", [job.id]],
      ["question-new", "pending", []],
    ]);
    expect((await restarted.getAnswer("demo", job.id)).result?.id).toBe(job.id);
  } finally {
    await restarted.close();
  }
});

it("retains a pending offline question when no answer runner is configured", async () => {
  const { root, ctx, request, instanceId } = await setup();
  const jobs = await openJobs(ctx, instanceId);
  try {
    await expect(
      jobs.submitAnswer("demo", { id: randomUUID(), requestId: request.id }),
    ).rejects.toThrow("runner unavailable");
    expect(readRequests(root).requests).toEqual([request]);
    expect(await jobs.listAnswers("demo")).toEqual([]);
  } finally {
    await jobs.close();
  }
});

it("validates renamed base evidence against the recorded git commit, including selected base ranges", async () => {
  const root = makeTempDir();
  const before =
    "export function value() {\n  return before();\n}\n" +
    Array.from({ length: 10 }, (_, i) => `export const constant${i} = ${i};`).join("\n");
  writeFile(root, "old.ts", before);
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  renameSync(`${root}/old.ts`, `${root}/new.ts`);
  writeFile(root, "new.ts", before.replace("before()", "after()"));
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "head");
  expect((await xpl(root, "index", "--precise", "off")).code).toBe(0);
  expect((await xpl(root, "new", "demo")).code).toBe(0);
  expect((await xpl(root, "change", "demo", "HEAD~1..HEAD")).code).toBe(0);
  const ctx = createCtx(
    { out() {}, err() {} },
    { root, cwd: root, env: {}, json: true, indexOption: undefined },
  );
  const loaded = loadExplainer(ctx, "demo");
  const ws = await openWorkspace(ctx, { explainer: loaded });
  expect(loaded.explainer.change?.files).toMatchObject([
    { path: "new.ts", status: "renamed", oldPath: "old.ts" },
  ]);
  const { request } = await appendRequest(root, {
    id: "base-question",
    elementId: "file:new.ts",
    kind: "explain",
    note: "What did value return before the rename?",
    explainer: "demo",
    context: artifactIdentity(loaded.explainer, ws.index),
    range: { file: "new.ts", side: "base", fromLine: 2, toLine: 2 },
  });
  const instanceId = randomUUID();
  writeFile(
    root,
    ".explainer/service/instance.json",
    JSON.stringify({ schema: "xpl-service-instance@1", root, instanceId, state: "running" }),
  );
  let calls = 0;
  const jobs = await openJobs(ctx, instanceId, undefined, async () => ({
    text: "The original function called before.",
    references: [
      {
        file: "new.ts",
        side: "base",
        fromLine: 2,
        toLine: 2,
        quote: ++calls === 1 ? "  return after();" : "  return before();",
      },
    ],
  }));
  try {
    const job = await jobs.submitAnswer("demo", { id: randomUUID(), requestId: request.id });
    await expect.poll(async () => (await jobs.getAnswer("demo", job.id)).state).toBe("failed");
    expect((await jobs.getAnswer("demo", job.id)).error).toBe(
      "answer quote does not match recorded source range",
    );
    await jobs.retry("demo", job.id, 1);
    await expect.poll(async () => (await jobs.getAnswer("demo", job.id)).state).toBe("completed");
    expect((await jobs.getAnswer("demo", job.id)).result?.references).toEqual([
      { file: "new.ts", side: "base", fromLine: 2, toLine: 2, quote: "  return before();" },
    ]);
    expect((await jobs.getAnswer("demo", job.id)).contextReason).toBeNull();
  } finally {
    await jobs.close();
  }
});

it("submits and reads a same-session answer through loopback routes and exports its portable feedback", async () => {
  const { root, ctx, request, instanceId } = await setup();
  const jobs = await openJobs(ctx, instanceId, undefined, async (job) => evidence(job));
  const server = await startViewServer({
    env: ctx,
    explainerPath: `${root}/.explainer/demo.explainer.json`,
    host: "127.0.0.1",
    port: 0,
    viewerHtml: () => STUB_VIEWER_HTML,
    control: { root, instanceId, token: "answer-test", backend: "none", jobs, stop() {} },
  });
  try {
    const id = randomUUID();
    const post = await fetch(new URL("/api/answers", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, requestId: request.id }),
    });
    expect(post.status).toBe(200);
    expect(await post.json()).toMatchObject({
      job: { id, scope: { kind: "answer" }, input: { request: { id: request.id } } },
    });
    await expect
      .poll(async () => {
        const response = await fetch(new URL(`/api/answers/${id}`, server.url));
        return ((await response.json()) as { job: { state: string } }).job.state;
      })
      .toBe("completed");
    const response = await fetch(new URL(`/api/answers/${id}`, server.url));
    expect(await response.json()).toMatchObject({
      job: {
        result: { id, requestId: request.id, text: "Queue holds jobs." },
        contextReason: null,
      },
    });
    const exported = `${root}/feedback-export.json`;
    expect((await xpl(root, "feedback", "demo", "--export", exported)).code).toBe(0);
    expect(
      parseFeedbackFile(
        JSON.parse(readFile(root, "feedback-export.json")),
      ).requests[0]?.answers?.map((a) => a.id),
    ).toEqual([id]);
    const wrong = await fetch(new URL(`/api/jobs/${id}`, server.url));
    expect(wrong.status).toBe(404);
  } finally {
    await server.close();
    await jobs.close();
  }
});

it.skipIf(process.env.XPL_TEST_CLAUDE_ANSWER !== "1")(
  "real installed Claude answers a frozen question (opt-in provider proof)",
  async () => {
    const { ctx: local, request, instanceId } = await setup();
    const ctx = { ...local, env: process.env };
    const jobs = await openJobs(
      ctx,
      instanceId,
      undefined,
      claudeAnswerRunner(ctx, {
        timeoutMs: 60_000,
        skillDir: process.env.XPL_TEST_CLAUDE_SKILL_DIR,
      }),
    );
    try {
      const job = await jobs.submitAnswer("demo", { id: randomUUID(), requestId: request.id });
      await expect
        .poll(
          async () =>
            ["completed", "failed"].includes((await jobs.getAnswer("demo", job.id)).state),
          { timeout: 65_000 },
        )
        .toBe(true);
      const completed = await jobs.getAnswer("demo", job.id);
      expect(completed.error).toBeNull();
      expect(completed.state).toBe("completed");
      const result = (await jobs.getAnswer("demo", job.id)).result;
      expect(result).toMatchObject({ id: job.id, requestId: request.id, context: request.context });
      expect(result?.references.length).toBeGreaterThan(0);
    } finally {
      await jobs.close();
    }
  },
  70_000,
);

it("refuses a completed receipt whose portable evidence differs from the job's recorded source", async () => {
  const { root, ctx, request, instanceId } = await setup();
  const jobs = await openJobs(ctx, instanceId, undefined, async (job) => evidence(job));
  const job = await jobs.submitAnswer("demo", { id: randomUUID(), requestId: request.id });
  await expect.poll(async () => (await jobs.getAnswer("demo", job.id)).state).toBe("completed");
  await jobs.close();
  const path = ".explainer/service/jobs.json";
  const ledger = readJson(root, path);
  const result = ledger.jobs[0].result;
  result.sources[0].text = "forged();\nforgedAgain();";
  result.sources[0].hash = hashText(result.sources[0].text);
  result.references[0].quote = result.sources[0].text;
  writeFile(root, path, JSON.stringify(ledger));
  writeFile(root, ".explainer/requests.json", JSON.stringify([request]));
  const corrupt = readFile(root, path);
  await expect(openJobs(ctx, instanceId)).rejects.toThrow("quote does not match recorded source");
  expect(readFile(root, path)).toBe(corrupt);
});

it("answers the viewer's re-resolved snapshot after reindexing without rewriting the stored guide", async () => {
  const { root, ctx, request, instanceId } = await setup();
  writeFile(
    root,
    "src/queue.ts",
    "// moved since the guide was saved\n" + readFile(root, "src/queue.ts"),
  );
  expect((await xpl(root, "index", "--precise", "off")).code).toBe(0);
  const before = readFile(root, ".explainer/demo.explainer.json");
  const jobs = await openJobs(ctx, instanceId, undefined, async (job) => evidence(job));
  const server = await startViewServer({
    env: ctx,
    explainerPath: `${root}/.explainer/demo.explainer.json`,
    host: "127.0.0.1",
    port: 0,
    viewerHtml: () => STUB_VIEWER_HTML,
    control: { root, instanceId, token: "test", backend: "none", jobs, stop() {} },
  });
  try {
    const bundle = (await (await fetch(new URL("/api/bundle", server.url))).json()) as ViewerBundle;
    const context = artifactIdentity(bundle.explainer, bundle.index);
    const { request: current } = await appendRequest(root, {
      ...request,
      id: "viewer-question",
      context,
    });
    const post = await fetch(new URL("/api/answers", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: randomUUID(), requestId: current.id }),
    });
    expect(post.status, await post.clone().text()).toBe(200);
    const receipt = (await post.json()) as { job: { id: string } };
    await expect
      .poll(async () => (await jobs.getAnswer("demo", receipt.job.id)).state)
      .toBe("completed");
    expect((await jobs.getAnswer("demo", receipt.job.id)).contextReason).toBeNull();
    expect((await jobs.getAnswer("demo", receipt.job.id)).input.expected).toEqual(context);
    expect(readFile(root, ".explainer/demo.explainer.json")).toBe(before);
  } finally {
    await server.close();
    await jobs.close();
  }
});
