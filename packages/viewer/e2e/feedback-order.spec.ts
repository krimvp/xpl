import { expect, test } from "@playwright/test";
import { execFile, spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

test("a delayed disk refresh cannot replace a newer outcome in the panel, browser or exports", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const repo = fileURLToPath(new URL("../../..", import.meta.url));
  const root = mkdtempSync(join(tmpdir(), "xpl-feedback-order-"));
  cpSync(join(repo, "fixtures/ts-jobrunner"), root, { recursive: true });
  const loader = createRequire(import.meta.url).resolve("tsx");
  const cli = join(repo, "packages/cli/src/main.ts");
  const env = { ...process.env, XPL_VIEWER_HTML: join(repo, "packages/viewer/dist/index.html") };
  const execute = promisify(execFile);
  const xpl = async (args: string[]) =>
    (await execute(process.execPath, ["--import", loader, cli, ...args], { cwd: root, env }))
      .stdout;
  let server: ReturnType<typeof spawn> | undefined;
  let release = () => {};
  try {
    await xpl(["index", "--precise", "off"]);
    await xpl(["new", "demo", "--title", "Job runner"]);
    await xpl(["apply", "demo", join(repo, "packages/cli/test/fixtures/ts-example.patch.json")]);
    server = spawn(
      process.execPath,
      ["--import", loader, cli, "view", "demo", "--port", "0", "--no-open"],
      { cwd: root, env },
    );
    const url = await new Promise<string>((resolve, reject) => {
      let output = "";
      server!.stdout!.on("data", (chunk) => {
        output += chunk;
        const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output);
        if (match) resolve(match[0]);
      });
      server!.once("error", reject);
      server!.once("exit", (code) => reject(new Error(`viewer exited ${code}`)));
    });
    // Observe completion of the real response body, without replacing its data or our modules.
    await page.addInitScript(() => {
      const json = Response.prototype.json;
      Response.prototype.json = async function () {
        const value = await json.call(this);
        if (this.url.endsWith("/api/requests")) {
          document.documentElement.dataset.feedbackReads = String(
            Number(document.documentElement.dataset.feedbackReads ?? 0) + 1,
          );
        }
        return value;
      };
    });
    await page.goto(url);
    await page.waitForFunction(() => !!window.__xpl);
    await page.evaluate(() => window.__xpl!.select(["sym:src/runner.ts#Runner.dispatch"]));
    await page.getByRole("button", { name: /^Feedback/ }).click();
    const panel = page.getByRole("dialog", { name: "Reader feedback" });
    await panel.getByLabel("Feedback note").fill("Explain the retry limit.");
    await panel
      .getByRole("button", { name: "Save for the next revision pass", exact: true })
      .click();
    await expect(panel.getByRole("status")).toContainText("Saved to disk");
    const original = JSON.parse(await xpl(["feedback", "demo", "--json"])).requests[0];
    const updates = join(tmpdir(), `xpl-outcomes-${original.id}.json`);
    const record = async (reason: string) => {
      writeFileSync(
        updates,
        JSON.stringify([
          { id: original.id, context: original.context, status: "unresolved", reason },
        ]),
      );
      await xpl(["feedback", "demo", "--outcomes", updates]);
    };
    try {
      for (const reason of ["First pass.", "Second pass.", "Old revision three."])
        await record(reason);
      await panel.getByRole("button", { name: "Close feedback" }).click();
      const delayed = new Promise<void>((resolve) => {
        release = resolve;
      });
      let captured = () => {};
      const capturedResponse = new Promise<void>((resolve) => {
        captured = resolve;
      });
      await page.route(
        "**/api/requests",
        async (route) => {
          const response = await route.fetch();
          expect((await response.json()).requests[0].outcome.revision).toBe(3);
          captured();
          await delayed;
          await route.fulfill({ response });
        },
        { times: 1 },
      );
      await page.getByRole("button", { name: /^Feedback/ }).click();
      await capturedResponse;
      await record("New revision four must survive.");
      await panel.getByRole("button", { name: "Close feedback" }).click();
      await page.getByRole("button", { name: /^Feedback/ }).click();
      await expect(panel.locator(".feedback-list")).toContainText(
        "New revision four must survive.",
      );
      const reads = Number(await page.locator("html").getAttribute("data-feedback-reads"));
      release();
      await expect(page.locator("html")).toHaveAttribute("data-feedback-reads", String(reads + 1));
      await expect(panel.locator(".feedback-list")).toContainText(
        "New revision four must survive.",
      );
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.getByRole("button", { name: "Export feedback JSON" }).click(),
      ]);
      const exported = JSON.parse(readFileSync((await download.path())!, "utf8"));
      expect(exported.requests[0].outcome).toMatchObject({
        revision: 4,
        status: "unresolved",
        reason: "New revision four must survive.",
      });
      await page.reload();
      await page.getByRole("button", { name: /^Feedback/ }).click();
      await expect(panel.locator(".feedback-list")).toContainText(
        "New revision four must survive.",
      );
      expect(
        JSON.parse(await xpl(["feedback", "demo", "--json"])).requests[0].outcome.revision,
      ).toBe(4);
    } finally {
      rmSync(updates, { force: true });
    }
  } finally {
    release();
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = new Promise<void>((resolve) => server!.once("exit", () => resolve()));
      server.kill("SIGTERM");
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
