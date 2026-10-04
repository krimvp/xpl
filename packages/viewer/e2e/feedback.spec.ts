import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  CHANGE_BUNDLE,
  byId,
  openBundle,
  openEditMenu,
  readEmbeddedBundle,
  withBundle,
  watchProblems,
} from "./helpers.js";

async function exported(page: import("@playwright/test").Page) {
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export feedback JSON" }).click();
  const download = await downloading;
  const path = await download.path();
  expect(path).not.toBeNull();
  return JSON.parse(readFileSync(path!, "utf8"));
}

test("disconnected reader captures selected source, reloads and exports the original request", async ({
  page,
}) => {
  const problems = watchProblems(page);
  await openBundle(page, "view:dispatch");
  await byId(page, "sym:src/runner.ts#Runner.dispatch").click();
  await page.evaluate(() => window.__xpl!.setCursor("src/runner.ts", 40));
  await page.getByRole("button", { name: /^Feedback/ }).click();
  const panel = page.getByRole("dialog", { name: "Reader feedback" });
  await panel.getByLabel("Request kind").selectOption("correct");
  await panel.getByLabel("Feedback note").fill("Explain the retry limit here.");
  await panel.getByRole("button", { name: "Save feedback", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Saved in this browser");
  const file = await exported(page);
  expect(file.schema).toBe("code-explainer/feedback@1");
  expect(file.requests).toHaveLength(1);
  expect(file.requests[0]).toMatchObject({
    id: expect.any(String),
    elementId: "sym:src/runner.ts#Runner.dispatch",
    kind: "correct",
    note: "Explain the retry limit here.",
    context: { explainerHash: expect.any(String), sourceHash: expect.any(String) },
    range: { file: "src/runner.ts", fromLine: 40, toLine: 40, side: "head" },
    outcome: {
      status: "pending",
      reason: "Awaiting an explicit revision pass.",
      at: expect.any(String),
    },
  });
  await page.reload();
  await page.getByRole("button", { name: /^Feedback \(1\)/ }).click();
  await expect(panel).toContainText("Explain the retry limit here.");
  expect(await exported(page)).toEqual(file);
  expect(problems).toEqual([]);
});

test("saved-page feedback retains terminal outcomes and reports changed explanation context", async ({
  page,
}) => {
  const { html, bundle } = readEmbeddedBundle();
  bundle.feedback = {
    schema: "code-explainer/feedback@1",
    requests: [
      {
        id: "prior-request",
        elementId: "concept:retry-policy",
        kind: "explain",
        at: "2026-10-04T12:00:00.000Z",
        context: { explainerHash: "previous-explanation", sourceHash: "previous-source" },
        outcome: {
          status: "unresolved",
          reason: "Need a runtime trace; retry later.",
          at: "2026-10-04T13:00:00.000Z",
        },
      },
    ],
  };
  // Browser storage can hold the old pending result after an updated page embeds a later outcome.
  await page.addInitScript(
    (requests) => {
      const getItem = Storage.prototype.getItem;
      Storage.prototype.getItem = function (key) {
        return key.startsWith("xpl-feedback:")
          ? JSON.stringify({
              schema: "code-explainer/feedback@1",
              requests: requests.map((r) => ({
                ...r,
                outcome: {
                  status: "pending",
                  reason: "Older pending result.",
                  at: "2026-10-04T12:00:00.000Z",
                },
              })),
            })
          : getItem.call(this, key);
      };
    },
    (bundle.feedback as { requests: object[] }).requests,
  );
  await page.route("http://feedback.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: withBundle(html, bundle) }),
  );
  await page.goto("http://feedback.test/");
  await page.getByRole("button", { name: /^Feedback/ }).click();
  const panel = page.getByRole("dialog", { name: "Reader feedback" });
  await expect(panel).toContainText("unresolved · outdated context");
  await expect(panel).toContainText("Need a runtime trace; retry later.");
  expect((await exported(page)).requests).toEqual(
    (bundle.feedback as { requests: unknown[] }).requests,
  );
  await panel.getByRole("button", { name: "Close feedback" }).click();
  await openEditMenu(page);
  const downloading = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Save as HTML" }).click();
  const path = await (await downloading).path();
  expect(path).not.toBeNull();
  const saved = readFileSync(path!, "utf8");
  const script = /<script id="xpl-data"[^>]*>([\s\S]*?)<\/script>/.exec(saved)!;
  expect(JSON.parse(script[1]!).feedback).toEqual(bundle.feedback);
});

test("before-source feedback keeps the selected range when browser storage refuses writes", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("Full", "QuotaExceededError");
    };
  });
  await openBundle(page, "view:dispatch", CHANGE_BUNDLE);
  await byId(page, "concept:retry-policy").click();
  const before = page.locator('.pane[data-file="src/runner.ts"][data-side="base"]');
  await expect(before).toBeVisible();
  await before.locator('.cm-line[data-line="76"]').click();
  await page.getByRole("button", { name: /^Feedback/ }).click();
  const panel = page.getByRole("dialog", { name: "Reader feedback" });
  await panel.getByLabel("Feedback note").fill("Why did the old retry use exponential delay?");
  await panel.getByRole("button", { name: "Save feedback", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("Browser storage unavailable");
  const file = await exported(page);
  expect(file.requests).toHaveLength(1);
  expect(file.requests[0]).toMatchObject({
    elementId: "concept:retry-policy",
    note: "Why did the old retry use exponential delay?",
    range: { file: "src/runner.ts", fromLine: 76, toLine: 76, side: "base" },
  });
});
