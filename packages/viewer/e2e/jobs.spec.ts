/** Controlled runner at the production service seam. No real agent or provider calls. */
import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, expect } from "@playwright/test";
import { run } from "../../cli/src/cli.js";
import { createCtx } from "../../cli/src/context.js";
import { openJobs } from "../../cli/src/jobs.js";
import { startViewServer } from "../../cli/src/server.js";
import { appendRequest, readRequests } from "../../cli/src/requests.js";
import { loadExplainer, openWorkspace } from "../../cli/src/repo.js";
import { artifactIdentity } from "@xpl/core";
import { watchProblems } from "./helpers.js";

for (const width of [1440, 390])
  test(`readable job review and search/map controls coexist at ${width}px`, async ({ page }) => {
    const root = mkdtempSync(join(tmpdir(), "xpl-jobs-browser-"));
    const errors: string[] = [];
    const io = { out() {}, err: (s: string) => errors.push(s), cwd: root, env: {} };
    const cmd = (...args: string[]) => run(args, io);
    cpSync(resolve("../../fixtures/ts-jobrunner"), root, {
      recursive: true,
      filter: (p) => !/[\\/](\.explainer|node_modules)([\\/]|$)/.test(p),
    });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let attempts = 0;
    let jobs: Awaited<ReturnType<typeof openJobs>> | undefined;
    let server: Awaited<ReturnType<typeof startViewServer>> | undefined;
    try {
      expect(await cmd("index", "--precise", "off"), errors.join("\n")).toBe(0);
      expect(await cmd("new", "demo")).toBe(0);
      const patch = join(root, ".explainer", "initial-patch.json");
      writeFileSync(
        patch,
        JSON.stringify({
          nodes: [
            {
              id: "file:src/queue.ts",
              label: "Pending queue",
              summary: "Queue holds pending jobs.",
              detail: "The **queue** stores jobs before dispatch.",
              anchors: [
                {
                  file: "src/queue.ts",
                  symbol: "Queue",
                  span: { from: 0, to: 4 },
                  role: "definition",
                },
              ],
            },
          ],
          views: [
            {
              id: "view:queue",
              type: "graph",
              title: "Queue",
              include: ["file:src/queue.ts"],
              edgeKinds: [],
            },
          ],
        }),
      );
      expect(await cmd("apply", "demo", patch)).toBe(0);
      const ctx = createCtx(io, { root, cwd: root, env: {}, json: true, indexOption: undefined });
      const loaded = loadExplainer(ctx, "demo");
      const ws = await openWorkspace(ctx, { explainer: loaded });
      const request = (
        await appendRequest(root, {
          id: "original",
          elementId: "file:src/queue.ts",
          kind: "correct",
          note: "Explain the queued job",
          explainer: "demo",
          context: artifactIdentity(loaded.explainer, ws.index),
        })
      ).request;
      await appendRequest(root, {
        ...request,
        id: "reject-me",
        note: "Use a different explanation",
      });
      const instanceId = randomUUID();
      mkdirSync(join(root, ".explainer/service"), { recursive: true });
      writeFileSync(
        join(root, ".explainer/service/instance.json"),
        JSON.stringify({ schema: "xpl-service-instance@1", root, instanceId, state: "running" }),
      );
      jobs = await openJobs(ctx, instanceId, async (job, signal, progress) => {
        attempts++;
        if (attempts === 1) throw new Error("Claude Code is rate limited. Wait and retry.");
        await progress("Reading selected source and feedback");
        if (attempts >= 3) {
          signal.throwIfAborted();
          await new Promise<void>((_resolve, reject) =>
            signal.addEventListener(
              "abort",
              () => reject(new Error("Cancelled controlled runner")),
              { once: true },
            ),
          );
        }
        await held;
        signal.throwIfAborted();
        return {
          revisionRunId: job.input.revisionRunId,
          proposals: job.selectedRequestIds.map((id, index) => ({
            id,
            patch: {
              nodes: [
                {
                  id: request.elementId,
                  label: "Dispatch queue",
                  summary:
                    index === 0
                      ? "The queue holds pending jobs until the runner takes them."
                      : "The queue sends each job to the runner.",
                  detail: "The **queue** stores jobs until dispatch.",
                  anchors: [
                    {
                      file: "src/queue.ts",
                      symbol: "Queue",
                      span: { from: 0, to: 8 },
                      role: "definition",
                    },
                  ],
                },
              ],
            },
          })),
        };
      });
      server = await startViewServer({
        env: ctx,
        explainerPath: loaded.abs,
        port: 0,
        host: "127.0.0.1",
        viewerHtml: () => readFileSync(resolve("dist/index.html"), "utf8"),
        control: { token: "test-token", instanceId, root, backend: "claude", jobs, stop() {} },
      });
      const problems = watchProblems(page);
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.goto(server.url + "?mode=explore&perspective=explore&view=view:queue");
      const connection = page.getByTestId("connection-status").locator("details");
      await connection.locator("summary").click();
      await expect(connection).toHaveAttribute("open", "");
      await page.getByRole("button", { name: "Jobs", exact: true }).click();
      await expect(connection).not.toHaveAttribute("open", "");
      const panel = page.getByTestId("jobs-panel");
      await panel.getByLabel("Explain the queued job").check();
      await panel.getByLabel("Use a different explanation").check();
      await panel.getByRole("button", { name: "Start selected job" }).click();
      await expect(panel).toContainText("rate limited");
      await panel.getByRole("button", { name: "Retry job" }).click();
      await expect(panel).toContainText("Reading selected source and feedback");
      await appendRequest(root, {
        ...request,
        id: "new-feedback",
        note: "Keep this feedback for later",
      });
      release();
      await panel.getByRole("button", { name: "Review proposal" }).click();
      const modal = page.getByRole("dialog", { name: "Review job proposal" });
      await modal.getByText("Source before/after", { exact: true }).click();
      const source = modal.locator(".job-source");
      await expect(source.getByText("Before", { exact: true }).first()).toBeVisible();
      await expect(source.getByText("After", { exact: true }).first()).toBeVisible();
      await modal.getByText("Source before/after", { exact: true }).click();
      const item = modal.getByRole("group", { name: "Explain the queued job", exact: true });
      const summary = item.getByRole("region", { name: "Summary change" });
      await expect(summary.locator(".job-before")).toHaveText("Queue holds pending jobs.");
      await expect(summary.locator(".job-after")).toHaveText(
        "The queue holds pending jobs until the runner takes them.",
      );
      await expect(summary.locator(".job-after mark")).toHaveText([
        "The queue",
        "jobs until the runner takes them.",
      ]);
      await expect(
        item.getByRole("region", { name: "Detail change" }).locator("strong").first(),
      ).toHaveText("queue");
      await expect(item.getByRole("region", { name: "Evidence change" })).toContainText(
        "src/queue.ts:28–32 (defined here) · ok",
      );
      await expect(item.getByRole("region", { name: "Evidence change" })).toContainText(
        "src/queue.ts:28–36 (defined here) · ok",
      );
      await expect(item.locator(".job-raw-change pre").first()).toBeHidden();
      await item.getByText("Show raw change", { exact: true }).first().click();
      await expect(item.locator(".job-raw-change pre").first()).toContainText('"startLine"');
      await item.getByText("Show raw change", { exact: true }).first().click();
      expect(await modal.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await expect(modal.getByRole("button", { name: "Accept reviewed revision" })).toBeDisabled();
      await item.getByLabel("Decision").selectOption("addressed");
      await item.getByLabel("Reason (required)").fill("Checked queue source");
      const reject = modal.getByRole("group", { name: "Use a different explanation", exact: true });
      await reject.getByLabel("Decision").selectOption("rejected");
      await reject.getByLabel("Reason (required)").fill("Keep the original meaning");
      await expect(modal.getByRole("button", { name: "Accept reviewed revision" })).toBeDisabled();
      await modal.getByRole("button", { name: "Review decisions" }).click();
      await expect(modal.getByRole("button", { name: "Accept reviewed revision" })).toBeEnabled();
      const completed = (await jobs.list("demo")).find((job) => job.state === "completed")!;
      await jobs.review("demo", completed.id, {
        attemptId: completed.owner!.attemptId,
        decisions: [
          { id: "original", status: "addressed", reason: "Checked source in another view" },
          { id: "reject-me", status: "rejected", reason: "Keep the original meaning" },
        ],
      });
      const staleResponse = page.waitForResponse((response) => response.url().endsWith("/accept"));
      await modal.getByRole("button", { name: "Accept reviewed revision" }).click();
      expect((await staleResponse).status()).toBe(409);
      await expect(modal.getByRole("alert")).toContainText(
        "The decisions changed in another view; review again.",
      );
      await expect(item.getByLabel("Reason (required)")).toHaveValue(
        "Checked source in another view",
      );
      await expect(modal.getByRole("button", { name: "Accept reviewed revision" })).toBeDisabled();
      await modal.getByRole("button", { name: "Review decisions" }).click();
      await expect(modal.getByRole("button", { name: "Accept reviewed revision" })).toBeEnabled();
      await modal.getByRole("button", { name: "Accept reviewed revision" }).click();
      await expect(panel).toContainText("Accepted");
      expect(
        readRequests(root).requests.map((r) => [r.id, r.outcome.status, r.outcome.revision]),
      ).toEqual([
        ["original", "addressed", 1],
        ["reject-me", "rejected", 1],
        ["new-feedback", "pending", 0],
      ]);
      if (width === 390) await page.getByRole("button", { name: "Jobs", exact: true }).click();
      const author = page.getByTestId("graph-author");
      await author.locator("summary").click();
      await expect(author.getByLabel("Group name")).toBeVisible();
      await page.getByRole("button", { name: "Search and guides" }).click();
      const search = page.getByRole("dialog", { name: "Search and guides" });
      await search.getByRole("searchbox").click({ timeout: 5000 });
      await search.getByRole("searchbox").fill("Queue");
      await expect(search.locator("[data-kind]").first()).toBeVisible();
      await search.getByRole("button", { name: "Close search" }).click();
      await expect(author.getByLabel("Group name")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await author.locator("summary").click();
      if (width === 390) await page.getByRole("button", { name: "Jobs", exact: true }).click();
      const acceptedBytes = readFileSync(join(root, ".explainer/demo.explainer.json"), "utf8");
      await panel.getByLabel("Keep this feedback for later").check();
      await panel.getByRole("button", { name: "Start selected job" }).click();
      await expect(panel.locator('[data-job-state="running"]')).toContainText(
        "Reading selected source and feedback",
      );
      await panel.getByRole("button", { name: "Cancel job" }).click();
      await expect(panel).toContainText("Cancelled");
      await page.reload();
      await page.getByRole("button", { name: "Jobs", exact: true }).click();
      await expect(panel).toContainText("Accepted");
      await expect(panel).toContainText("Cancelled");
      expect(readFileSync(join(root, ".explainer/demo.explainer.json"), "utf8")).toBe(
        acceptedBytes,
      );
      expect(readRequests(root).requests.map((r) => r.outcome.status)).toEqual([
        "addressed",
        "rejected",
        "pending",
      ]);
      expect(problems).toEqual([
        "console.error: Failed to load resource: the server responded with a status of 409 (Conflict)",
      ]);
    } finally {
      release?.();
      await server?.close();
      await jobs?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
