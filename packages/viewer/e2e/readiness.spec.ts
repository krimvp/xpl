import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { artifactIdentity, hashText, parseBundle, applyPatch } from "@xpl/core";
import {
  openEditMenu,
  openVariant,
  type Loose,
  withBundle,
  readEmbeddedBundle,
  openTourEditor,
} from "./helpers.js";

function complete(bundle: Loose) {
  for (const id of ["file:src/queue.ts", "file:src/worker.ts", "file:src/metrics.ts"]) {
    const node = bundle.explainer.nodes.find((n: Loose) => n.id === id);
    if (node) node.summary = "Participates in dispatching and observing queued jobs.";
    else
      bundle.explainer.nodes.push({
        id,
        kind: "file",
        parent: "dir:src",
        label: id,
        summary: "Participates in dispatching and observing queued jobs.",
        anchors: [],
        provenance: { origin: "llm" },
      });
  }
  for (const view of bundle.explainer.views)
    if (view.steps)
      for (const step of view.steps) step.summary = "The runner passes work to the next stage.";
  for (const tour of bundle.explainer.tours)
    tour.summary =
      "The runner dispatches queued jobs to workers. Failures return to the queue for retry.";
}

function dataOf(html: string) {
  return parseBundle(/<script id="xpl-data"[^>]*>([\s\S]*?)<\/script>/.exec(html)![1]!);
}

test("Save as HTML reports unfinished fields before download and labels an offline draft preview", async ({
  page,
}) => {
  await openVariant(page, (bundle) => {
    bundle.explainer.title = "TODO: write the story";
  });
  const downloads: string[] = [];
  page.on("download", (download) => downloads.push(download.suggestedFilename()));
  await (await openEditMenu(page)).getByTestId("edit-save-html").click();
  await expect(page.getByTestId("readiness-summary")).toContainText("Not ready");
  await expect(page.locator(".readiness-findings")).toContainText("(explainer).title (todo-left)");
  await expect(page.getByTestId("save-html-ready")).toBeDisabled();
  expect(downloads).toEqual([]);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("save-html-draft").click(),
  ]);
  const html = readFileSync((await download.path())!, "utf8");
  expect(dataOf(html).exportInfo).toMatchObject({
    status: "draft",
    report: { ready: false, scope: "embedded-snapshot" },
  });
  await page.unroute("http://xpl.test/**");
  await page.route("http://xpl.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: html }),
  );
  await page.goto("http://xpl.test/");
  await expect(page.getByTestId("draft-banner")).toContainText("Draft preview");
  await (await openEditMenu(page)).getByTestId("edit-save-html").click();
  await expect(page.getByRole("dialog")).toContainText(
    "cannot check whether the repository changed later",
  );
});

test("a complete snapshot saves ready HTML with source, provenance, identity and author decisions, then reopens without a server", async ({
  page,
}) => {
  await openVariant(page, complete);
  await page.evaluate(() => window.__xpl!.select(["sym:src/runner.ts#Runner.dispatch"]));
  await page.getByRole("button", { name: /^Feedback/ }).click();
  const feedback = page.getByRole("dialog", { name: "Reader feedback" });
  await feedback.getByLabel("Feedback note").fill("Explain the queue wait.");
  await feedback
    .getByRole("button", { name: "Save for the next revision pass", exact: true })
    .click();
  await expect(feedback.getByRole("status")).toContainText("Saved in this browser");
  await feedback.getByRole("button", { name: "Close feedback" }).click();
  await (await openEditMenu(page)).getByTestId("edit-save-html").click();
  await expect(page.getByTestId("readiness-summary")).toContainText("Ready: 0 errors");
  await page
    .getByLabel("Author decision about warnings or omissions (optional)")
    .fill("The overview skips helper functions; their source is included.");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("save-html-ready").click(),
  ]);
  const html = readFileSync((await download.path())!, "utf8");
  const saved = dataOf(html);
  expect(saved.feedback?.requests).toHaveLength(1);
  expect(saved.feedback!.requests[0]).toMatchObject({
    note: "Explain the queue wait.",
    context: saved.exportInfo!.report.identity,
    outcome: { status: "pending", reason: "Awaiting an explicit revision pass." },
  });
  expect(saved.exportInfo).toMatchObject({
    status: "ready",
    report: {
      ready: true,
      scope: "embedded-snapshot",
      errors: 0,
      decisionNote: "The overview skips helper functions; their source is included.",
    },
  });
  expect(saved.server).toBeUndefined();
  expect(saved.files["src/runner.ts"]).toContain("async dispatch");
  expect(
    saved.explainer.nodes.find((node) => node.id === "sym:src/runner.ts#Runner.dispatch")
      ?.provenance.userFields,
  ).toEqual(["summary"]);
  const requests: string[] = [];
  await page.unroute("http://xpl.test/**");
  await page.route("http://xpl.test/**", (route) => {
    if (new URL(route.request().url()).pathname === "/")
      return route.fulfill({ contentType: "text/html", body: html });
    requests.push(route.request().url());
    return route.abort();
  });
  await page.goto("http://xpl.test/");
  await expect(page.getByTestId("explanation-info")).toBeVisible();
  await page.evaluate(() => window.__xpl!.select(["sym:src/runner.ts#Runner.dispatch"]));
  await page.getByRole("button", { name: /^Feedback \(1\)/ }).click();
  await feedback.getByLabel("Feedback note").fill("Explain the ready snapshot too.");
  await feedback
    .getByRole("button", { name: "Save for the next revision pass", exact: true })
    .click();
  await expect(feedback.getByRole("status")).toContainText("Saved in this browser");
  await feedback.getByRole("button", { name: "Close feedback" }).click();
  await (await openEditMenu(page)).getByTestId("edit-save-html").click();
  await expect(page.getByTestId("readiness-summary")).toContainText("Ready: 0 errors");
  const [again] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("save-html-ready").click(),
  ]);
  const reexported = dataOf(readFileSync((await again.path())!, "utf8"));
  expect(reexported.exportInfo?.report.identity).toEqual(saved.exportInfo!.report.identity);
  expect(reexported.feedback?.requests).toHaveLength(2);
  expect(reexported.feedback!.requests[0]).toEqual(saved.feedback!.requests[0]);
  expect(reexported.feedback!.requests[1]).toMatchObject({
    note: "Explain the ready snapshot too.",
    context: saved.exportInfo!.report.identity,
  });
  expect(requests.filter((url) => url.includes("/api/"))).toEqual([]);
});

test("a live save checks the workspace at the export click, even before polling sees the source change", async ({
  page,
}) => {
  const { html, bundle } = readEmbeddedBundle();
  complete(bundle);
  bundle.server = { api: "/api" };
  let changed = false;
  let exports = 0;
  await page.route("http://xpl.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/")
      return route.fulfill({ contentType: "text/html", body: withBundle(html, { ...bundle }) });
    if (path === "/api/explainer") return route.fulfill({ status: 304 });
    if (path === "/api/requests")
      return route.fulfill({ contentType: "application/json", body: '{"requests":[]}' });
    if (path === "/api/export") {
      exports++;
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ...bundle,
          ...(changed ? { sourceWarning: "Source changed: reindex before export." } : {}),
        }),
      });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto("http://xpl.test/");
  await (await openEditMenu(page)).getByTestId("edit-save-html").click();
  await expect(page.getByTestId("save-html-ready")).toBeEnabled();
  changed = true;
  await page.getByTestId("save-html-ready").click();
  await expect(page.getByTestId("readiness-summary")).toContainText("Not ready");
  await expect(page.locator(".readiness-findings")).toContainText("stale-index");
  await expect(page.getByTestId("save-html-ready")).toBeDisabled();
  expect(exports).toBe(2);
});

test("live ready HTML refreshes fetched source and keeps it available after disconnected reopening", async ({
  page,
}) => {
  const { html, bundle: embedded } = readEmbeddedBundle();
  const bundle: Loose = embedded;
  complete(bundle);
  bundle.server = { api: "/api" };
  const original = parseBundle(JSON.stringify(bundle));
  const prior = {
    id: "live-request",
    elementId: "sym:src/runner.ts#Runner.dispatch",
    kind: "explain",
    at: "2026-10-04T12:00:00.000Z",
    context: artifactIdentity(original.explainer, original.index),
    outcome: {
      revision: 0,
      status: "pending",
      reason: "Awaiting a pass.",
      at: "2026-10-04T12:00:00.000Z",
    },
  };
  delete bundle.files["README.md"];
  const initial = "Notes read while the workspace is open.";
  const fresh = "Updated notes saved for offline readers.";
  let workspaceText = initial;
  bundle.index.files.find((file: Loose) => file.path === "README.md").hash = hashText(initial);
  const fetched: string[] = [];
  await page.route("http://xpl.test/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/")
      return route.fulfill({ contentType: "text/html", body: withBundle(html, { ...bundle }) });
    if (url.pathname === "/api/explainer") return route.fulfill({ status: 304 });
    if (url.pathname === "/api/requests")
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ requests: [prior] }),
      });
    if (url.pathname === "/api/file" && url.searchParams.get("path") === "README.md") {
      fetched.push(workspaceText);
      return route.fulfill({ contentType: "text/plain", body: workspaceText });
    }
    if (url.pathname === "/api/export") {
      const current = structuredClone(bundle);
      current.index.files.find((file: Loose) => file.path === "README.md").hash =
        hashText(workspaceText);
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(current) });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto("http://xpl.test/?perspective=code");
  await page.locator('.tree-row[data-path="README.md"]').click();
  await expect(page.locator('[data-file="README.md"] .cm-content')).toContainText(initial);
  workspaceText = fresh;
  await (await openEditMenu(page)).getByTestId("edit-save-html").click();
  await expect(page.getByTestId("readiness-summary")).toContainText("Ready: 0 errors");
  prior.outcome = {
    revision: 1,
    status: "addressed",
    reason: "Explained the queue wait.",
    at: "2026-10-04T13:00:00.000Z",
  };
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("save-html-ready").click(),
  ]);
  const saved = readFileSync((await download.path())!, "utf8");
  expect(dataOf(saved).files["README.md"]).toBe(fresh);
  expect(dataOf(saved).feedback?.requests).toEqual([prior]);
  expect(fetched).toEqual([initial, fresh, fresh]);
  await page.close();
  const offline = await page.context().newPage();
  const requests: string[] = [];
  await offline.route("http://xpl.test/**", (route) => {
    if (new URL(route.request().url()).pathname === "/")
      return route.fulfill({ contentType: "text/html", body: saved });
    requests.push(route.request().url());
    return route.abort();
  });
  await offline.goto("http://xpl.test/?perspective=code");
  await offline.locator('.tree-row[data-path="README.md"]').click();
  await expect(offline.locator('[data-file="README.md"] .cm-content')).toContainText(fresh);
  expect(requests).toEqual([]);
});

test("offline all-content review survives HTML reopening and explicitly gates team export", async ({
  page,
}) => {
  await openVariant(page, complete);
  await expect(page.getByTestId("review-status")).toHaveText("Author review: unchecked");
  await (await openEditMenu(page)).getByTestId("edit-save-html").click();
  await expect(page.getByTestId("save-html-ready")).toBeEnabled();
  await page.getByLabel("Require a current review of all stored content (team policy)").check();
  await expect(page.getByTestId("save-html-ready")).toBeDisabled();
  await expect(page.locator(".readiness-findings")).toContainText("review-required");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await (await openEditMenu(page)).getByTestId("edit-review").click();
  const dialog = page.getByRole("dialog", { name: "Record author review" });
  await dialog.getByLabel("Reviewer name (self-reported)").fill("Ada");
  await dialog
    .getByLabel("Named omissions (one per line)")
    .fill("Runtime initialization was not exercised.");
  await expect(dialog.getByTestId("review-inspection")).toContainText(
    "All stored explanation content",
  );
  await dialog.getByRole("button", { name: "Record inspected review", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByTestId("review-status")).toHaveText("Author review: reviewed");
  await page.getByTestId("explanation-info").locator(":scope > summary").click();
  await expect(page.getByTestId("explanation-info")).toContainText("Ada (self-reported)");
  await expect(page.getByTestId("explanation-info")).toContainText(
    "Runtime initialization was not exercised.",
  );
  await (await openEditMenu(page)).getByTestId("edit-save-html").click();
  await page.getByLabel("Require a current review of all stored content (team policy)").check();
  await expect(page.getByTestId("save-html-ready")).toBeEnabled();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("save-html-ready").click(),
  ]);
  const html = readFileSync((await download.path())!, "utf8");
  const saved = dataOf(html);
  expect(saved.explainer.review).toMatchObject({
    reviewer: "Ada",
    scope: { content: "all", source: "anchored" },
    omissions: ["Runtime initialization was not exercised."],
    sourceCommit: saved.index.commit,
  });
  expect(saved.exportInfo?.report.review).toEqual({ status: "reviewed", required: true });
  const requests: string[] = [];
  await page.unroute("http://xpl.test/**");
  await page.route("http://xpl.test/**", (route) => {
    if (new URL(route.request().url()).pathname === "/")
      return route.fulfill({ contentType: "text/html", body: html });
    requests.push(route.request().url());
    return route.abort();
  });
  await page.goto("http://xpl.test/");
  await expect(page.getByTestId("review-status")).toHaveText("Author review: reviewed");
  await (await openEditMenu(page)).getByTestId("edit-save-html").click();
  await expect(
    page.getByLabel("Require a current review of all stored content (team policy)"),
  ).toBeChecked();
  await expect(page.getByTestId("save-html-ready")).toBeEnabled();
  expect(requests).toEqual([]);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await openTourEditor(page);
  await page
    .getByTestId("tour-step-note")
    .first()
    .fill("### Changed explanation\n\nThe runner starts another dispatch pass.");
  await page.getByRole("button", { name: "Close the tour panel" }).click();
  await page.getByRole("button", { name: "Guide", exact: true }).click();
  await expect(page.getByTestId("review-status")).toHaveText("Author review: out of date");
  await (await openEditMenu(page)).getByTestId("edit-save-html").click();
  await expect(page.getByTestId("save-review-status")).toHaveText("Author review: out of date");
  await expect(page.getByTestId("save-html-ready")).toBeDisabled();
  await page.getByLabel("Require a current review of all stored content (team policy)").uncheck();
  await expect(page.getByTestId("save-html-ready")).toBeEnabled();
});

test("live author recording sends only a review user edit and refuses changes since inspection", async ({
  page,
}) => {
  const { html, bundle: raw } = readEmbeddedBundle();
  complete(raw);
  raw.server = { api: "/api" };
  let bundle = parseBundle(JSON.stringify(raw));
  const puts: unknown[] = [];
  await page.route("http://xpl.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/")
      return route.fulfill({ contentType: "text/html", body: withBundle(html, { ...bundle }) });
    if (path === "/api/explainer") return route.fulfill({ status: 304 });
    if (path === "/api/requests")
      return route.fulfill({ contentType: "application/json", body: '{"requests":[]}' });
    if (path === "/api/export" || path === "/api/bundle")
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(bundle) });
    if (path === "/api/review") {
      const patch = route.request().postDataJSON();
      puts.push(patch);
      const result = applyPatch(
        bundle.explainer,
        patch,
        bundle.index,
        (path) => bundle.files[path],
        { actor: "user" },
      );
      if (!result.ok)
        return route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ error: "Reviewed content changed; inspect again." }),
        });
      bundle = { ...bundle, explainer: result.explainer };
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(bundle.explainer),
      });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto("http://xpl.test/");
  await (await openEditMenu(page)).getByTestId("edit-review").click();
  const dialog = page.getByRole("dialog", { name: "Record author review" });
  await dialog.getByLabel("Reviewer name (self-reported)").fill("Grace");
  await expect(dialog.getByRole("button", { name: "Record inspected review" })).toBeEnabled();
  bundle.explainer.title = "Dispatching jobs after inspection";
  await dialog.getByRole("button", { name: "Record inspected review" }).click();
  await expect(dialog.getByRole("alert")).toContainText("inspect again");
  await expect(page.getByTestId("review-status")).toHaveText("Author review: unchecked");
  await dialog.getByRole("button", { name: "Inspect current snapshot" }).click();
  await expect(dialog.getByTestId("review-inspection")).toContainText(
    "Dispatching jobs after inspection",
  );
  await dialog.getByRole("button", { name: "Record inspected review" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByTestId("review-status")).toHaveText("Author review: reviewed");
  expect(puts).toHaveLength(2);
  expect(Object.keys(puts[1] as object)).toEqual(["review"]);
  expect(bundle.explainer.review?.reviewer).toBe("Grace");
  bundle.explainer.title = "Another authored change";
  await (await openEditMenu(page)).getByTestId("edit-save-html").click();
  await expect(page.getByTestId("save-review-status")).toHaveText("Author review: out of date");
});

test("selected review requires reinspection, survives unrelated tour edits and can be removed as an author edit", async ({
  page,
}) => {
  await openVariant(page, complete);
  await (await openEditMenu(page)).getByTestId("edit-review").click();
  const dialog = page.getByRole("dialog", { name: "Record author review" });
  await dialog.getByLabel("Reviewer name (self-reported)").fill("Ada");
  await dialog.getByLabel("Content scope", { exact: true }).selectOption("selected");
  await dialog.getByLabel("Stored items", { exact: true }).selectOption(["concept:retry-policy"]);
  await expect(dialog.getByRole("button", { name: "Record inspected review" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Inspect current snapshot" }).click();
  await expect(dialog.getByTestId("review-inspection")).toContainText("concept:retry-policy");
  await dialog.getByRole("button", { name: "Record inspected review" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByTestId("review-status")).toHaveText("Author review: reviewed");
  await openTourEditor(page);
  await page
    .getByTestId("tour-step-note")
    .first()
    .fill("### Another tour introduction\n\nThe runner starts scheduling jobs.");
  await page.getByRole("button", { name: "Close the tour panel" }).click();
  await page.getByRole("button", { name: "Guide", exact: true }).click();
  await expect(page.getByTestId("review-status")).toHaveText("Author review: reviewed");
  await (await openEditMenu(page)).getByTestId("edit-save-html").click();
  await expect(page.getByTestId("save-html-ready")).toBeEnabled();
  await page.getByLabel("Require a current review of all stored content (team policy)").check();
  await expect(page.getByTestId("save-html-ready")).toBeDisabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await (await openEditMenu(page)).getByTestId("edit-review").click();
  await expect(dialog.getByLabel("Content scope", { exact: true })).toHaveValue("selected");
  await expect(dialog.getByRole("button", { name: "Remove review" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Remove review" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByTestId("review-status")).toHaveText("Author review: unchecked");
});
