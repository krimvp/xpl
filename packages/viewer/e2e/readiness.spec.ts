import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { hashText, parseBundle } from "@xpl/core";
import {
  openEditMenu,
  openVariant,
  type Loose,
  withBundle,
  readEmbeddedBundle,
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
  await (await openEditMenu(page)).getByTestId("edit-save-html").click();
  await expect(page.getByTestId("readiness-summary")).toContainText("Ready: 0 errors");
  const [again] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("save-html-ready").click(),
  ]);
  expect(dataOf(readFileSync((await again.path())!, "utf8")).exportInfo?.report.identity).toEqual(
    saved.exportInfo!.report.identity,
  );
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
      return route.fulfill({ contentType: "text/html", body: withBundle(html, bundle) });
    if (path === "/api/explainer") return route.fulfill({ status: 304 });
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
  delete bundle.files["README.md"];
  const initial = "Notes read while the workspace is open.";
  const fresh = "Updated notes saved for offline readers.";
  let workspaceText = initial;
  bundle.index.files.find((file: Loose) => file.path === "README.md").hash = hashText(initial);
  const fetched: string[] = [];
  await page.route("http://xpl.test/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/")
      return route.fulfill({ contentType: "text/html", body: withBundle(html, bundle) });
    if (url.pathname === "/api/explainer") return route.fulfill({ status: 304 });
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
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("save-html-ready").click(),
  ]);
  const saved = readFileSync((await download.path())!, "utf8");
  expect(dataOf(saved).files["README.md"]).toBe(fresh);
  expect(fetched).toEqual([initial, fresh, fresh]);
  await page.unroute("http://xpl.test/**");
  const requests: string[] = [];
  await page.route("http://xpl.test/**", (route) => {
    if (new URL(route.request().url()).pathname === "/")
      return route.fulfill({ contentType: "text/html", body: saved });
    requests.push(route.request().url());
    return route.abort();
  });
  await page.goto("http://xpl.test/?perspective=code");
  await page.locator('.tree-row[data-path="README.md"]').click();
  await expect(page.locator('[data-file="README.md"] .cm-content')).toContainText(fresh);
  expect(requests).toEqual([]);
});
