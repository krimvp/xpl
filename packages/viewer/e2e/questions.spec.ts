import { expect, test } from "@playwright/test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "../../cli/src/cli.js";
import { createCtx } from "../../cli/src/context.js";
import { openJobs, type AnswerRunner } from "../../cli/src/jobs.js";
import { claudeAnswerRunner } from "../../cli/src/claude-runner.js";
import { startViewServer } from "../../cli/src/server.js";
import { readRequests } from "../../cli/src/requests.js";
import { hashText, validateFeedbackAnswer } from "@xpl/core";
import { byId, openBundle, CHANGE_BUNDLE, readEmbeddedBundle } from "./helpers.js";

async function service(runner?: AnswerRunner, real = false) {
  const root = mkdtempSync(join(tmpdir(), "xpl-questions-browser-"));
  cpSync(resolve("../../fixtures/ts-jobrunner"), root, {
    recursive: true,
    filter: (path) => !/[\\/](\.explainer|node_modules)([\\/]|$)/.test(path),
  });
  const io = { out() {}, err() {}, cwd: root, env: real ? process.env : {} };
  const cmd = (...args: string[]) => run(args, io);
  let jobs: Awaited<ReturnType<typeof openJobs>> | undefined;
  let server: Awaited<ReturnType<typeof startViewServer>> | undefined;
  try {
    expect(await cmd("index", "--precise", "off")).toBe(0);
    expect(await cmd("new", "demo")).toBe(0);
    expect(await cmd("apply", "demo", resolve("../cli/test/fixtures/ts-example.patch.json"))).toBe(
      0,
    );
    const ctx = createCtx(io, { root, cwd: root, env: io.env, json: true, indexOption: undefined });
    const instanceId = randomUUID();
    mkdirSync(join(root, ".explainer/service"), { recursive: true });
    writeFileSync(
      join(root, ".explainer/service/instance.json"),
      JSON.stringify({ schema: "xpl-service-instance@1", root, instanceId, state: "running" }),
    );
    jobs = await openJobs(
      ctx,
      instanceId,
      undefined,
      real
        ? claudeAnswerRunner(ctx, {
            timeoutMs: 60_000,
            skillDir: process.env.XPL_TEST_CLAUDE_SKILL_DIR,
          })
        : runner,
    );
    server = await startViewServer({
      env: ctx,
      explainerPath: join(root, ".explainer/demo.explainer.json"),
      host: "127.0.0.1",
      port: 0,
      viewerHtml: () => readFileSync(resolve("dist/index.html"), "utf8"),
      control: {
        root,
        instanceId,
        token: "test",
        backend: real ? "claude" : "none",
        jobs,
        stop() {},
      },
    });
    return {
      root,
      cmd,
      jobs,
      server,
      async close() {
        await server!.close();
        await jobs!.close();
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await server?.close();
    await jobs?.close();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function evidence(job: Parameters<AnswerRunner>[0]) {
  const source = job.input.sources.find((s) => s.file === "src/queue.ts" && s.side === "head")!;
  return {
    text: "Queue holds pending jobs.",
    references: [
      {
        file: source.file,
        side: source.side,
        fromLine: 1,
        toLine: 2,
        quote: "export interface Job {\n  id: string;",
      },
    ],
  };
}

async function exportFeedback(page: import("@playwright/test").Page) {
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export feedback JSON" }).click();
  const path = await (await downloading).path();
  expect(path).not.toBeNull();
  return readFileSync(path!, "utf8");
}

test("an offline element question remains pending, reloads and imports without duplicates", async ({
  page,
}) => {
  await openBundle(page, "view:dispatch");
  await byId(page, "sym:src/runner.ts#Runner.dispatch").click();
  await page.getByRole("button", { name: "Ask a question", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Reader feedback" });
  await panel.getByLabel("Feedback note").fill("Why does dispatch wait for a free worker?");
  await panel.getByRole("button", { name: "Ask a question", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("pending feedback");
  await expect(panel.getByRole("status")).toContainText("/code-explainer feedback");
  await expect(panel.locator(".feedback-list > li")).toHaveCount(1);
  const downloading = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Export feedback JSON" }).click();
  const path = await (await downloading).path();
  expect(path).not.toBeNull();
  const contents = readFileSync(path!, "utf8");
  const feedback = JSON.parse(contents);
  expect(feedback.requests).toHaveLength(1);
  expect(feedback.requests[0]).toMatchObject({
    kind: "explain",
    note: "Why does dispatch wait for a free worker?",
    outcome: { status: "pending" },
  });
  await page.reload();
  await page.getByRole("button", { name: /^Feedback/ }).click();
  await expect(panel).toContainText("Why does dispatch wait for a free worker?");
  for (let i = 0; i < 2; i++) {
    await panel.getByLabel("Import feedback JSON").setInputFiles({
      name: "feedback.json",
      mimeType: "application/json",
      buffer: Buffer.from(contents),
    });
    await expect(panel.getByRole("status")).toContainText("Imported feedback");
  }
  await expect(panel.locator(".feedback-list > li")).toHaveCount(1);
});

for (const width of [1440, 390])
  test(`live question retry, exact reference, reload and portable history at ${width}px`, async ({
    page,
  }) => {
    let calls = 0;
    let finish!: () => void;
    const app = await service(async (job, _signal, progress) => {
      if (++calls === 1) throw new Error("Answer backend failed; retry this question.");
      await progress("Reading the recorded queue source");
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return evidence(job);
    });
    try {
      await page.setViewportSize({ width, height: 844 });
      const before = readFileSync(join(app.root, ".explainer/demo.explainer.json"), "utf8");
      await page.goto(app.server.url + "?mode=explore&view=view:overview");
      await page.waitForFunction(() => !!window.__xpl);
      await page.evaluate(() => window.__xpl!.select(["file:src/queue.ts"]));
      await page.getByRole("button", { name: "Ask a question", exact: true }).click();
      const panel = page.getByRole("dialog", { name: "Reader feedback" });
      await panel.getByLabel("Feedback note").fill("How does the queue hold jobs?");
      await expect(page.getByTestId("connection-status")).toContainText("Connected");
      await panel.getByRole("button", { name: "Ask a question", exact: true }).click();
      await expect(panel.locator('[data-job-state="failed"]')).toContainText(
        "Answer backend failed",
      );
      await panel.getByRole("button", { name: "Retry question" }).click();
      await expect(panel.locator('[data-job-state="running"]')).toContainText(
        "Reading the recorded queue source",
      );
      finish();
      await expect(panel.getByRole("region", { name: "Answer", exact: true })).toContainText(
        "Queue holds pending jobs.",
      );
      await panel.getByRole("button", { name: "src/queue.ts:1–2 (head)", exact: true }).click();
      const code = page.locator('.pane[data-file="src/queue.ts"][data-side="head"]');
      await expect(code).toBeVisible();
      await expect(code.locator(".cm-selectionBackground").first()).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => window.__xpl!.state().cursor))
        .toMatchObject({ file: "src/queue.ts", fromLine: 1, toLine: 2 });
      await page.getByRole("button", { name: /^Feedback/ }).click();
      const exported = await exportFeedback(page);
      expect(JSON.parse(exported).requests[0].answers).toHaveLength(1);
      await page.reload();
      await page.getByRole("button", { name: /^Feedback/ }).click();
      await expect(panel.getByRole("region", { name: "Answer", exact: true })).toContainText(
        "Queue holds pending jobs.",
      );
      for (let i = 0; i < 2; i++) {
        await panel.getByLabel("Import feedback JSON").setInputFiles({
          name: "feedback.json",
          mimeType: "application/json",
          buffer: Buffer.from(exported),
        });
        await expect(panel.getByRole("status")).toContainText("Imported feedback");
      }
      await expect(panel.locator(".feedback-list > li")).toHaveCount(1);
      await expect(panel.getByRole("region", { name: "Answer", exact: true })).toHaveCount(1);
      expect(JSON.parse(await exportFeedback(page))).toEqual(JSON.parse(exported));
      expect(readRequests(app.root).requests[0]?.outcome.status).toBe("pending");
      expect(calls).toBe(2);
      expect(readFileSync(join(app.root, ".explainer/demo.explainer.json"), "utf8")).toBe(before);
      expect(await panel.evaluate((el) => el.getBoundingClientRect().right)).toBeLessThanOrEqual(
        width,
      );
    } finally {
      finish?.();
      await app.close();
    }
  });

test("running and queued questions can be cancelled without publishing answers", async ({
  page,
}) => {
  const app = await service(async (_job, signal, progress) => {
    await progress("Waiting for recorded source");
    await new Promise<void>((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
      if (signal.aborted) reject(new Error("Cancelled"));
    });
  });
  try {
    await page.goto(app.server.url + "?mode=explore");
    await page.waitForFunction(() => !!window.__xpl);
    await page.evaluate(() => window.__xpl!.select(["file:src/queue.ts"]));
    await page.getByRole("button", { name: /^Feedback/ }).click();
    const panel = page.getByRole("dialog", { name: "Reader feedback" });
    await expect(page.getByTestId("connection-status")).toContainText("Connected");
    for (const question of ["How does the queue work?", "Why does it hold jobs?"]) {
      await panel.getByLabel("Feedback note").fill(question);
      await panel.getByRole("button", { name: "Ask a question", exact: true }).click();
    }
    await expect(panel.locator('[data-job-state="running"]')).toHaveCount(1);
    const queued = panel.locator('[data-job-state="queued"]');
    await expect(queued).toHaveCount(1);
    await queued.getByRole("button", { name: "Cancel question" }).click();
    await panel
      .locator('[data-job-state="running"]')
      .getByRole("button", { name: "Cancel question" })
      .click();
    await expect(panel.locator('[data-job-state="cancelled"]')).toHaveCount(2);
    await page.reload();
    await page.getByRole("button", { name: /^Feedback/ }).click();
    await expect(panel.locator('[data-job-state="cancelled"]')).toHaveCount(2);
    await expect(panel.getByRole("region", { name: "Answer", exact: true })).toHaveCount(0);
    expect(readRequests(app.root).requests.map((r) => [r.outcome.status, r.answers ?? []])).toEqual(
      [
        ["pending", []],
        ["pending", []],
      ],
    );
  } finally {
    await app.close();
  }
});

for (const changed of ["source", "guide"] as const)
  test(`a ${changed} change during answering retains the snapshot and warns before source navigation`, async ({
    page,
  }) => {
    let finish!: () => void;
    const app = await service(async (job) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return evidence(job);
    });
    try {
      await page.goto(app.server.url + "?mode=explore");
      await page.waitForFunction(() => !!window.__xpl);
      await page.evaluate(() => window.__xpl!.select(["file:src/queue.ts"]));
      await page.getByRole("button", { name: /^Feedback/ }).click();
      const panel = page.getByRole("dialog", { name: "Reader feedback" });
      await expect(page.getByTestId("connection-status")).toContainText("Connected");
      await panel.getByLabel("Feedback note").fill("What does this queue hold?");
      await panel.getByRole("button", { name: "Ask a question", exact: true }).click();
      await expect(panel.locator('[data-job-state="running"]')).toHaveCount(1);
      if (changed === "source") {
        const file = join(app.root, "src/queue.ts");
        writeFileSync(file, "// source moved during answer\n" + readFileSync(file, "utf8"));
      } else {
        const patch = join(tmpdir(), `xpl-question-${randomUUID()}.json`);
        try {
          writeFileSync(
            patch,
            JSON.stringify({
              nodes: [{ id: "file:src/queue.ts", summary: "Author changed this explanation." }],
            }),
          );
          expect(await app.cmd("apply", "demo", patch, "--actor", "user")).toBe(0);
        } finally {
          rmSync(patch);
        }
      }
      finish();
      await expect(panel).toContainText("Outdated context:");
      await expect(panel.getByRole("region", { name: "Answer", exact: true })).toContainText(
        "Queue holds pending jobs.",
      );
      if (changed === "source") {
        await expect(page.locator('.pane[data-file="src/queue.ts"] .cm-content')).toContainText(
          "source moved during answer",
        );
        await panel.getByRole("button", { name: "src/queue.ts:1–2 (head)", exact: true }).click();
        await expect(panel.getByLabel("Highlighted recorded source")).toHaveText(
          "export interface Job {\n  id: string;",
        );
        await expect(panel).toContainText("Current source differs");
      }
      const requests = readRequests(app.root).requests;
      expect(requests[0]?.answers?.[0]?.context).toEqual(requests[0]?.context);
      expect(requests[0]?.outcome.status).toBe("pending");
    } finally {
      finish?.();
      await app.close();
    }
  });

test("an unavailable managed backend saves the question on disk for the explicit offline pass", async ({
  page,
}) => {
  const app = await service();
  try {
    await page.goto(app.server.url + "?mode=explore");
    await page.waitForFunction(() => !!window.__xpl);
    await page.evaluate(() => window.__xpl!.select(["file:src/queue.ts"]));
    await page.getByRole("button", { name: /^Feedback/ }).click();
    const panel = page.getByRole("dialog", { name: "Reader feedback" });
    await expect(page.getByTestId("connection-status")).toContainText("Connected");
    await panel.getByLabel("Feedback note").fill("How does this queue hold jobs?");
    await panel.getByRole("button", { name: "Ask a question", exact: true }).click();
    await expect(panel.getByRole("status")).toContainText("pending feedback");
    await expect(panel.getByRole("status")).toContainText("/code-explainer feedback");
    expect(readRequests(app.root).requests).toHaveLength(1);
    expect(readRequests(app.root).requests[0]?.outcome.status).toBe("pending");
    expect(await app.jobs.listAnswers("demo")).toEqual([]);
  } finally {
    await app.close();
  }
});

test("a disconnected service keeps the question in browser feedback through reload", async ({
  page,
}) => {
  const app = await service(async (job) => evidence(job));
  try {
    await page.goto(app.server.url + "?mode=explore");
    await page.waitForFunction(() => !!window.__xpl);
    await page.evaluate(() => window.__xpl!.select(["file:src/queue.ts"]));
    await expect(page.getByTestId("connection-status")).toContainText("Connected");
    await page.route("**/api/**", (route) => route.abort("connectionrefused"));
    await page.getByRole("button", { name: /^Feedback/ }).click();
    const panel = page.getByRole("dialog", { name: "Reader feedback" });
    await panel
      .getByLabel("Feedback note")
      .fill("What happens while this service is disconnected?");
    await panel.getByRole("button", { name: "Ask a question", exact: true }).click();
    await expect(panel.getByRole("status")).toContainText("pending feedback");
    await expect(panel.getByRole("status")).toContainText("--import feedback.json");
    const exported = JSON.parse(await exportFeedback(page));
    expect(exported.requests[0]).toMatchObject({
      note: "What happens while this service is disconnected?",
      outcome: { status: "pending" },
    });
    expect(readRequests(app.root).requests).toHaveLength(0);
    expect(await app.jobs.listAnswers("demo")).toEqual([]);
    await page.reload();
    await page.getByRole("button", { name: /^Feedback/ }).click();
    await expect(panel.locator(".feedback-list > li")).toHaveCount(1);
    expect(JSON.parse(await exportFeedback(page))).toEqual(exported);
  } finally {
    await app.close();
  }
});

test("real installed Claude returns a source-linked answer in the reader session", async ({
  page,
}) => {
  test.skip(process.env.XPL_TEST_CLAUDE_ANSWER !== "1", "Opt-in provider proof");
  test.setTimeout(90_000);
  const app = await service(undefined, true);
  try {
    const before = readFileSync(join(app.root, ".explainer/demo.explainer.json"), "utf8");
    await page.goto(app.server.url + "?mode=explore");
    await page.waitForFunction(() => !!window.__xpl);
    await page.evaluate(() => window.__xpl!.select(["file:src/queue.ts"]));
    await page.getByRole("button", { name: /^Feedback/ }).click();
    const panel = page.getByRole("dialog", { name: "Reader feedback" });
    await expect(page.getByTestId("connection-status")).toContainText("Connected");
    await panel
      .getByLabel("Feedback note")
      .fill("What does Queue.push do? Answer briefly and cite its exact source lines.");
    await panel.getByRole("button", { name: "Ask a question", exact: true }).click();
    await expect(panel.locator(".answer-attempt")).toHaveAttribute("data-job-state", "completed", {
      timeout: 70_000,
    });
    const answer = panel.getByRole("region", { name: "Answer", exact: true });
    await expect(answer).toContainText("push");
    await expect(answer.locator(".answer-evidence button").first()).toBeVisible();
    await answer.locator(".answer-evidence button").first().click();
    await expect(page.locator(".cm-selectionBackground").first()).toBeVisible();
    expect(readFileSync(join(app.root, ".explainer/demo.explainer.json"), "utf8")).toBe(before);
  } finally {
    await app.close();
  }
});

for (const side of ["head", "base"] as const)
  test(`a code selection captures exact ${side} lines and opens an imported answer reference`, async ({
    page,
  }) => {
    await openBundle(page, "view:dispatch", CHANGE_BUNDLE);
    await byId(page, "concept:retry-policy").click();
    const pane = page.locator(`.pane[data-file="src/runner.ts"][data-side="${side}"]`);
    await expect(pane).toBeVisible();
    await pane.locator('.cm-line[data-line="76"]').click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Shift+ArrowDown");
    await pane.getByRole("button", { name: "Ask about selected lines" }).click();
    const panel = page.getByRole("dialog", { name: "Reader feedback" });
    await panel.getByLabel("Feedback note").fill("Why did this retry wait?");
    await panel.getByRole("button", { name: "Ask a question", exact: true }).click();
    await expect(panel.getByRole("status")).toContainText("pending feedback");
    const feedback = JSON.parse(await exportFeedback(page));
    expect(feedback.requests[0].range).toEqual({
      file: "src/runner.ts",
      fromLine: 76,
      toLine: 77,
      side,
    });
    const bundle = readEmbeddedBundle(CHANGE_BUNDLE).bundle;
    const source = (side === "base" ? bundle.baseFiles : bundle.files) as Record<string, string>;
    const text = source["src/runner.ts"]!;
    const quote =
      side === "base"
        ? "        const backoff = this.config.retry.baseDelayMs * attempts;\n        await this.queue.requeue(job, backoff);"
        : "        await this.queue.requeue(\n          job,";
    const answer = validateFeedbackAnswer(
      {
        text: "Retry waits before dispatching again.",
        references: [{ file: "src/runner.ts", side, fromLine: 76, toLine: 77, quote }],
      },
      feedback.requests[0],
      [{ file: "src/runner.ts", side, text, hash: hashText(text) }],
      "imported-answer",
      "2026-10-05T12:00:00.000Z",
    );
    feedback.requests[0].answers = [answer];
    await panel.getByLabel("Import feedback JSON").setInputFiles({
      name: "answer.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(feedback)),
    });
    await expect(panel.getByRole("region", { name: "Answer", exact: true })).toContainText(
      "Retry waits before dispatching again.",
    );
    await panel.getByRole("button", { name: `src/runner.ts:76–77 (${side})`, exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.__xpl!.state().cursor))
      .toMatchObject({
        file: "src/runner.ts",
        fromLine: 76,
        toLine: 77,
        ...(side === "base" ? { side: "base" } : {}),
      });
    await expect(pane.locator(".cm-selectionBackground").first()).toBeVisible();
  });
