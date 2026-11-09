import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  CHANGE_BUNDLE,
  byId,
  openBundle,
  openEditMenu,
  openVariant,
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
  await panel.getByRole("button", { name: "Save for the author", exact: true }).click();
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
      revision: 0,
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

test("a shared page saves a question for the author, says how to send it, and lists it in plain words", async ({
  page,
}) => {
  // a page as `xpl bundle` writes it (it names its guide), read, not explored
  await openVariant(page, (bundle) => {
    bundle.guideId = "jobrunner";
  });
  await page.evaluate(() => window.__xpl!.select(["sym:src/runner.ts#Runner.dispatch"]));
  await page.getByRole("button", { name: /^Feedback/ }).click();
  const panel = page.getByRole("dialog", { name: "Reader feedback" });
  // no local service: nothing on this page can answer, so nothing offers to
  await expect(panel.getByTestId("feedback-offline-intro")).toHaveText(
    "Your note stays in this browser. Export it and send the file to whoever gave you this page. You see the answer when they send you a new page.",
  );
  await expect(panel.getByRole("button", { name: "Ask a question" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Save for the author" })).toHaveClass(
    /is-primary/,
  );
  // the author's commands are folded away, with the guide's own name
  const author = panel.locator("details.feedback-author");
  await expect(author).not.toHaveAttribute("open");
  await expect(author.locator("code").first()).toBeHidden();
  await author.locator("summary").click();
  await expect(author.locator("code").first()).toHaveText(
    "xpl feedback jobrunner --import feedback.json",
  );
  await panel.getByLabel("Feedback note").fill("Why does dispatch wait for a free worker?");
  await panel.getByRole("button", { name: "Save for the author", exact: true }).click();
  const item = panel.locator(".feedback-list > li");
  await expect(item).toHaveCount(1);
  await expect(item.locator("strong").first()).toHaveText("Question about Runner.dispatch");
  await expect(item).toContainText("Waiting for the author");
  // no raw id, no author words, and no answer button that cannot work here
  await expect(item.locator("code")).toHaveCount(0);
  await expect(item).not.toContainText("Revision");
  await expect(item).not.toContainText("(head)");
  await expect(item.getByRole("button", { name: "Get an answer" })).toHaveCount(0);
  // the author, in Explore, sees the request's id: the one `xpl feedback` lists
  await page.keyboard.press("Escape");
  await page.goto("http://xpl.test/?mode=explore");
  await page.getByRole("button", { name: /^Feedback/ }).click();
  const id = await panel.locator(".feedback-list > li").first().getAttribute("data-request-id");
  await expect(panel.locator(".feedback-list > li code").first()).toHaveText(id!);
});

test("feedback captured after an offline view edit survives reload with its edited context", async ({
  page,
}) => {
  await openBundle(page, "view:overview");
  await byId(page, "ghost:file:src/bus.ts").click();
  await byId(page, "file:src/bus.ts").click();
  await page.getByRole("button", { name: /^Feedback/ }).click();
  const panel = page.getByRole("dialog", { name: "Reader feedback" });
  await panel.getByLabel("Feedback note").fill("Explain the newly added bus.");
  await panel.getByRole("button", { name: "Save for the author", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Saved in this browser");
  const original = await exported(page);
  expect(original.requests).toHaveLength(1);
  expect(original.requests[0]).toMatchObject({
    elementId: "file:src/bus.ts",
    note: "Explain the newly added bus.",
    outcome: { status: "pending", reason: "Awaiting an explicit revision pass." },
  });
  await page.reload();
  await page.getByRole("button", { name: /^Feedback \(1\)/ }).click();
  await expect(panel).toContainText("outdated context");
  expect(await exported(page)).toEqual(original);
});

test("two tabs retain both requests when each save reads the same pre-write snapshot", async ({
  page,
  context,
}) => {
  const other = await context.newPage();
  for (const tab of [page, other]) {
    await openBundle(tab, "view:dispatch");
    await byId(tab, "sym:src/runner.ts#Runner.dispatch").click();
    await tab.getByRole("button", { name: /^Feedback/ }).click();
    // Force the interleaving where both tabs read before either writes. Writes still use real,
    // shared browser storage; freezing reads makes this race reproducible without timing luck.
    await tab.evaluate(() => {
      const getItem = Storage.prototype.getItem;
      const snapshot = new Map(
        Array.from({ length: localStorage.length }, (_, i) => {
          const key = localStorage.key(i)!;
          return [key, getItem.call(localStorage, key)] as const;
        }),
      );
      Storage.prototype.getItem = function (key) {
        return this === localStorage && key.startsWith("xpl-feedback:")
          ? (snapshot.get(key) ?? null)
          : getItem.call(this, key);
      };
    });
  }
  await page.getByLabel("Feedback note").fill("First tab request.");
  await other.getByLabel("Feedback note").fill("Second tab request.");
  await Promise.all(
    [page, other].map((tab) =>
      tab.getByRole("button", { name: "Save for the author", exact: true }).click(),
    ),
  );
  const first = (await exported(page)).requests;
  const second = (await exported(other)).requests;
  expect(first).toHaveLength(1);
  expect(second).toHaveLength(1);
  expect(first[0].id).not.toBe(second[0].id);
  const captured = [...first, ...second].sort((a, b) => a.note.localeCompare(b.note));
  expect(captured.map((r) => r.note)).toEqual(["First tab request.", "Second tab request."]);
  for (const tab of [page, other]) {
    await tab.reload();
    await tab.getByRole("button", { name: /^Feedback \(2\)/ }).click();
    const saved = (await exported(tab)).requests.sort((a: { note: string }, b: { note: string }) =>
      a.note.localeCompare(b.note),
    );
    expect(saved).toEqual(captured);
  }
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
          revision: 1,
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
        return key.startsWith("xpl-feedback:") && !key.includes(":request:")
          ? JSON.stringify({
              schema: "code-explainer/feedback@1",
              requests: requests.map((r) => ({
                ...r,
                outcome: {
                  revision: 0,
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
  await expect(panel).toContainText("The author could not settle it yet");
  await expect(panel).toContainText("outdated context");
  await expect(panel).toContainText("Need a runtime trace; retry later.");
  expect((await exported(page)).requests).toEqual(
    (bundle.feedback as { requests: unknown[] }).requests,
  );
  await panel.getByRole("button", { name: "Close feedback" }).click();
  await openEditMenu(page);
  await page.getByRole("menuitem", { name: "Save as HTML" }).click();
  await expect(page.getByTestId("save-html-ready")).toBeDisabled();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("save-html-draft").click(),
  ]);
  const path = await download.path();
  expect(path).not.toBeNull();
  const saved = readFileSync(path!, "utf8");
  const script = /<script id="xpl-data"[^>]*>([\s\S]*?)<\/script>/.exec(saved)!;
  expect(JSON.parse(script[1]!).feedback).toEqual(bundle.feedback);
  expect(JSON.parse(script[1]!).exportInfo.status).toBe("draft");
  await page.unroute("http://feedback.test/**");
  await page.route("http://feedback.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: saved }),
  );
  await page.goto("http://feedback.test/");
  await expect(page.getByTestId("draft-pill")).toBeVisible();
  await page.evaluate(() => window.__xpl!.select(["concept:retry-policy"]));
  await page.getByRole("button", { name: /^Feedback \(1\)/ }).click();
  await panel.getByLabel("Feedback note").fill("Explain retries in this draft.");
  await panel.getByRole("button", { name: "Save for the author", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Saved in this browser");
  const requests = (await exported(page)).requests;
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual((bundle.feedback as { requests: unknown[] }).requests[0]);
  expect(requests[1]).toMatchObject({
    elementId: "concept:retry-policy",
    note: "Explain retries in this draft.",
    outcome: { status: "pending", reason: "Awaiting an explicit revision pass." },
  });
  await panel.getByRole("button", { name: "Close feedback" }).click();
  await (await openEditMenu(page)).getByTestId("edit-save-html").click();
  const [again] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("save-html-draft").click(),
  ]);
  const reexported = readFileSync((await again.path())!, "utf8");
  const data = /<script id="xpl-data"[^>]*>([\s\S]*?)<\/script>/.exec(reexported)!;
  expect(JSON.parse(data[1]!).feedback.requests).toEqual(requests);
});

test("two tabs cannot replace a newer outcome for the same request with a stale storage read", async ({
  page,
  context,
}) => {
  const { html, bundle } = readEmbeddedBundle();
  const original = {
    id: "shared-request",
    elementId: "concept:retry-policy",
    kind: "explain",
    at: "2026-10-04T12:00:00.000Z",
    context: { explainerHash: "original-explanation", sourceHash: "original-source" },
    outcome: {
      revision: 3,
      status: "unresolved",
      reason: "Older result.",
      at: "2026-10-04T13:00:00.000Z",
    },
  };
  const newer = {
    ...original,
    outcome: { ...original.outcome, revision: 4, reason: "Newer result." },
  };
  const data = {
    ...bundle,
    server: { api: "/api" },
    feedback: { schema: "code-explainer/feedback@1", requests: [original] },
  };
  const other = await context.newPage();
  await context.route("http://feedback-race.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/requests")
      return route.fulfill({
        json: {
          requests: [route.request().frame().page() === other ? newer : original],
        },
      });
    if (path === "/api/explainer") return route.fulfill({ status: 304 });
    return route.fulfill({ contentType: "text/html", body: withBundle(html, data) });
  });
  for (const tab of [page, other]) await tab.goto("http://feedback-race.test/");
  // Hold the first tab's storage read at revision 3 while the other tab publishes revision 4.
  await page.evaluate(() => {
    const getItem = Storage.prototype.getItem;
    const snapshot = new Map(
      Array.from({ length: localStorage.length }, (_, i) => {
        const key = localStorage.key(i)!;
        return [key, getItem.call(localStorage, key)] as const;
      }),
    );
    Storage.prototype.getItem = function (key) {
      return this === localStorage && key.startsWith("xpl-feedback:")
        ? (snapshot.get(key) ?? null)
        : getItem.call(this, key);
    };
  });
  await other.getByRole("button", { name: /^Feedback/ }).click();
  await expect(other.locator(".feedback-list")).toContainText("Newer result.");
  await page.getByRole("button", { name: /^Feedback/ }).click();
  await expect(page.locator(".feedback-list")).toContainText("Older result.");
  await context.unroute("http://feedback-race.test/**");
  // An older disconnected page must recover revision 4 from real shared browser storage alone.
  await context.route("http://feedback-race.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: withBundle(html, {
        ...bundle,
        feedback: {
          schema: "code-explainer/feedback@1",
          requests: [
            {
              ...original,
              outcome: {
                ...original.outcome,
                revision: 0,
                status: "pending",
                reason: "Awaiting an explicit pass.",
              },
            },
          ],
        },
      }),
    }),
  );
  await page.reload();
  await page.getByRole("button", { name: /^Feedback/ }).click();
  await expect(page.locator(".feedback-list")).toContainText("Newer result.");
  expect((await exported(page)).requests[0].outcome).toEqual(newer.outcome);
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
  await panel.getByRole("button", { name: "Save for the author", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("Browser storage unavailable");
  const file = await exported(page);
  expect(file.requests).toHaveLength(1);
  expect(file.requests[0]).toMatchObject({
    elementId: "concept:retry-policy",
    note: "Why did the old retry use exponential delay?",
    range: { file: "src/runner.ts", fromLine: 76, toLine: 76, side: "base" },
  });
});
