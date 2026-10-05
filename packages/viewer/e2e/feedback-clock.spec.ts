import { expect, test, type Page } from "@playwright/test";
import { execFile, spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { withBundle } from "./helpers.js";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const cli = join(repo, "packages/cli/src/main.ts");
const loader = createRequire(import.meta.url).resolve("tsx");
const execute = promisify(execFile);

async function feedbackExport(page: Page) {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export feedback JSON" }).click(),
  ]);
  return JSON.parse(readFileSync((await download.path())!, "utf8"));
}

for (const [direction, skew] of [
  ["ahead", 300_000],
  ["behind", -300_000],
] as const) {
  test(`author outcomes survive live and portable refresh when the reader clock is ${direction}`, async ({
    page,
    context,
  }) => {
    test.setTimeout(180_000);
    const scratch = mkdtempSync(join(tmpdir(), "xpl-feedback-clock-"));
    const root = join(scratch, "repo");
    const portable = join(scratch, "portable");
    cpSync(join(repo, "fixtures/ts-jobrunner"), root, { recursive: true });
    const env = { ...process.env, XPL_VIEWER_HTML: join(repo, "packages/viewer/dist/index.html") };
    const xpl = async (cwd: string, args: string[], clock?: string) => {
      const result = await execute(
        process.execPath,
        ["--import", loader, ...(clock ? ["--import", clock] : []), cli, ...args],
        { cwd, env },
      );
      return result.stdout;
    };
    let server: ReturnType<typeof spawn> | undefined;
    try {
      await xpl(root, ["index", "--precise", "off"]);
      await xpl(root, ["new", "demo", "--title", "Job runner"]);
      await xpl(root, [
        "apply",
        "demo",
        join(repo, "packages/cli/test/fixtures/ts-example.patch.json"),
      ]);
      const guide = join(scratch, "guide.html");
      await xpl(root, ["bundle", "demo", "--draft", "--files", "all", "-o", guide]);
      const html = readFileSync(guide, "utf8");
      const bundle = JSON.parse(/<script id="xpl-data"[^>]*>([\s\S]*?)<\/script>/.exec(html)![1]!);
      const authorTime = Date.now();
      const readerTime = new Date(authorTime + skew);
      await page.clock.setFixedTime(readerTime);
      await page.goto(pathToFileURL(guide).href);
      await page.waitForFunction(() => !!window.__xpl);
      await page.evaluate(() => window.__xpl!.select(["sym:src/runner.ts#Runner.dispatch"]));
      await page.getByRole("button", { name: /^Feedback/ }).click();
      const panel = page.getByRole("dialog", { name: "Reader feedback" });
      await panel.getByLabel("Feedback note").fill("Explain this reader's retry limit.");
      await panel.getByRole("button", { name: "Save feedback", exact: true }).click();
      await expect(panel.getByRole("status")).toContainText("Saved in this browser");
      const captured = await feedbackExport(page);
      const original = captured.requests[0];
      expect(captured.requests).toHaveLength(1);
      expect(original.at).toBe(readerTime.toISOString());
      const input = join(scratch, "captured.json");
      writeFileSync(input, JSON.stringify(captured));
      await xpl(root, ["feedback", "demo", "--import", input]);
      // A second author store starts with the same pending request; imports must advance its outcome.
      cpSync(root, portable, { recursive: true });
      server = spawn(
        process.execPath,
        ["--import", loader, cli, "view", "demo", "--port", "0", "--no-open"],
        { cwd: root, env },
      );
      const url = await new Promise<string>((resolve, reject) => {
        let output = "";
        let error = "";
        server!.stdout!.on("data", (chunk) => {
          output += chunk;
          const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output);
          if (match) resolve(match[0]);
        });
        server!.stderr!.on("data", (chunk) => {
          error += chunk;
        });
        server!.once("error", reject);
        server!.once("exit", (code) => reject(new Error(`viewer exited ${code}: ${error}`)));
      });
      const live = await context.newPage();
      await live.clock.setFixedTime(readerTime);
      await live.goto(url);
      await live.getByRole("button", { name: /^Feedback/ }).click();
      const livePanel = live.getByRole("dialog", { name: "Reader feedback" });
      await expect(livePanel.locator(".feedback-list")).toContainText("pending");
      const updates = join(scratch, "outcomes.json");
      const outcomeFile = join(scratch, "recorded.json");
      writeFileSync(
        updates,
        JSON.stringify([
          {
            id: original.id,
            context: original.context,
            status: "unresolved",
            reason: "Need a runtime trace; retry later.",
          },
        ]),
      );
      await xpl(root, ["feedback", "demo", "--outcomes", updates]);
      await xpl(root, ["feedback", "demo", "--export", outcomeFile]);
      const recorded = JSON.parse(readFileSync(outcomeFile, "utf8"));
      await livePanel.getByRole("button", { name: "Close feedback" }).click();
      await live.getByRole("button", { name: /^Feedback/ }).click();
      await expect(livePanel.locator(".feedback-list")).toContainText(
        "Need a runtime trace; retry later.",
      );
      expect(await feedbackExport(live)).toEqual(recorded);
      // Same original page and browser namespace, now carrying the author's portable outcome.
      writeFileSync(guide, withBundle(html, { ...bundle, feedback: recorded }));
      await page.reload();
      await page.getByRole("button", { name: /^Feedback \(1\)/ }).click();
      await expect(panel.locator(".feedback-list")).toContainText(
        "Need a runtime trace; retry later.",
      );
      expect(await feedbackExport(page)).toEqual(recorded);
      await xpl(portable, ["feedback", "demo", "--import", outcomeFile]);
      const imported = JSON.parse(await xpl(portable, ["feedback", "demo", "--json"]));
      expect(imported.requests[0].outcome).toEqual(recorded.requests[0].outcome);
      expect(recorded.requests[0].outcome.revision).toBe(1);
      // A newer portable authored result cannot be erased by an older live workspace.
      const branchRoot = join(scratch, "branch-store");
      cpSync(portable, branchRoot, { recursive: true });
      writeFileSync(
        updates,
        JSON.stringify([
          {
            id: original.id,
            context: original.context,
            status: "rejected",
            reason: "Decision from a separate author store.",
          },
        ]),
      );
      await xpl(branchRoot, ["feedback", "demo", "--outcomes", updates]);
      const branchFile = join(scratch, "branch.json");
      await xpl(branchRoot, ["feedback", "demo", "--export", branchFile]);
      const branch = JSON.parse(readFileSync(branchFile, "utf8"));
      expect(branch.requests[0].outcome.revision).toBe(2);
      const keys = await live.evaluate((request) => {
        const keys = Array.from({ length: localStorage.length }, (_, i) =>
          localStorage.key(i)!,
        ).filter((key) => key.includes(`:request:${encodeURIComponent(request.id)}`));
        const legacy = keys[0]!.split(":revision:")[0]!;
        localStorage.setItem(legacy, JSON.stringify(request));
        return [legacy];
      }, branch.requests[0]);
      expect(keys).toHaveLength(1);
      await live.reload();
      await live.getByRole("button", { name: /^Feedback/ }).click();
      await expect(livePanel.locator(".feedback-list")).toContainText(
        "Decision from a separate author store.",
      );
      expect(await feedbackExport(live)).toEqual(branch);
      expect(
        await live.evaluate((key) => JSON.parse(localStorage.getItem(key)!), keys[0]!),
      ).toEqual(branch.requests[0]);
      // Import it into the authoritative store before recording a replacement at revision 3.
      await xpl(root, ["feedback", "demo", "--import", branchFile]);
      // Even the author's clock can move backwards between two explicit recordings.
      const clock = join(scratch, "author-clock.mjs");
      writeFileSync(
        clock,
        `const NativeDate = Date; const fixed = ${authorTime - 600_000}; globalThis.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [fixed])); } static now() { return fixed; } };`,
      );
      writeFileSync(
        updates,
        JSON.stringify([
          {
            id: original.id,
            context: original.context,
            status: "addressed",
            reason: "Explained the retry limit.",
          },
        ]),
      );
      await xpl(root, ["feedback", "demo", "--outcomes", updates], clock);
      await xpl(root, ["feedback", "demo", "--export", outcomeFile]);
      const addressed = JSON.parse(readFileSync(outcomeFile, "utf8"));
      expect(addressed.requests[0].outcome).toMatchObject({
        revision: 3,
        status: "addressed",
        at: new Date(authorTime - 600_000).toISOString(),
      });
      for (const tab of [live, page]) {
        if (tab === page) {
          writeFileSync(guide, withBundle(html, { ...bundle, feedback: addressed }));
          await tab.reload();
        } else await livePanel.getByRole("button", { name: "Close feedback" }).click();
        await tab.getByRole("button", { name: /^Feedback \(1\)/ }).click();
        await expect(tab.locator(".feedback-list")).toContainText("Explained the retry limit.");
        expect(await feedbackExport(tab)).toEqual(addressed);
      }
      await xpl(portable, ["feedback", "demo", "--import", outcomeFile]);
      // Replaying both the original pending export and revision 1 cannot erase revision 3.
      await xpl(portable, ["feedback", "demo", "--import", input]);
      writeFileSync(outcomeFile, JSON.stringify(recorded));
      await xpl(portable, ["feedback", "demo", "--import", outcomeFile]);
      const retained = JSON.parse(await xpl(portable, ["feedback", "demo", "--json"]));
      expect(retained.requests[0].outcome).toEqual(addressed.requests[0].outcome);
      expect(captured.requests[0].outcome.revision).toBe(0);
      expect(retained.requests[0].context).toEqual(original.context);
    } finally {
      if (server) {
        const exited = new Promise<void>((resolve) => server!.once("exit", () => resolve()));
        if (server.exitCode === null && server.signalCode === null) {
          server.kill("SIGTERM");
          await exited;
        }
      }
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}
