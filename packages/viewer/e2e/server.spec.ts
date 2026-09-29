/**
 * The viewer under `xpl view`: `bundle.server.api` is set, so it fetches missing files, persists view
 * edits and queues explain requests over HTTP. The "server" is Playwright's request interception on a
 * fake origin; the requests recorded here are the contract `xpl view` has to serve.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  byId,
  linesWith,
  readEmbeddedBundle,
  stateOf,
  watchProblems,
  withBundle,
} from "./helpers.js";

interface Recorded {
  files: string[];
  puts: { path: string; body: Record<string, unknown> }[];
  posts: Record<string, unknown>[];
  /** Status PUT answers with; a test may change it while the page is open. */
  putStatus: number;
}

async function serve(
  page: Page,
  opts: {
    /** Files the page does not carry: served on demand by GET /api/file. */
    withheld?: string[];
    putStatus?: number;
    fileStatus?: number;
  } = {},
): Promise<Recorded> {
  const { html, bundle } = readEmbeddedBundle();
  const files = bundle.files as Record<string, string>;
  const withheld: Record<string, string> = {};
  for (const path of opts.withheld ?? []) {
    withheld[path] = files[path]!;
    delete files[path];
  }
  bundle.server = { api: "/api" };
  const recorded: Recorded = { files: [], puts: [], posts: [], putStatus: opts.putStatus ?? 200 };
  await page.route("http://xpl.test/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/") {
      return route.fulfill({ contentType: "text/html", body: withBundle(html, bundle) });
    }
    if (url.pathname === "/api/file" && request.method() === "GET") {
      const path = url.searchParams.get("path")!;
      recorded.files.push(path);
      if (opts.fileStatus) return route.fulfill({ status: opts.fileStatus, body: "gone" });
      return route.fulfill({ contentType: "text/plain", body: withheld[path] ?? "" });
    }
    if (url.pathname.startsWith("/api/views/") && request.method() === "PUT") {
      recorded.puts.push({
        path: decodeURIComponent(url.pathname),
        body: JSON.parse(request.postData() ?? "null") as Record<string, unknown>,
      });
      if (recorded.putStatus >= 400) {
        return route.fulfill({
          status: recorded.putStatus,
          contentType: "application/json",
          body: JSON.stringify({ error: "the explainer is read-only" }),
        });
      }
      return route.fulfill({ contentType: "application/json", body: "{}" });
    }
    if (url.pathname === "/api/requests" && request.method() === "POST") {
      recorded.posts.push(JSON.parse(request.postData() ?? "null") as Record<string, unknown>);
      return route.fulfill({ status: 201, contentType: "application/json", body: "{}" });
    }
    return route.fulfill({ status: 404, body: "not found" });
  });
  await page.goto("http://xpl.test/");
  await page.waitForFunction(() => window.__xpl !== undefined);
  return recorded;
}

test("files missing from the bundle are fetched from GET /api/file when they are needed", async ({
  page,
}) => {
  const problems = watchProblems(page);
  const recorded = await serve(page, { withheld: ["src/runner.ts", "src/queue.ts"] });
  expect((await stateOf(page)).serverMode).toBe(true);
  await page.evaluate(() => window.__xpl!.setView("view:dispatch"));
  expect(recorded.files).toEqual([]);

  await byId(page, "dispatch:3").click();
  const runner = page.locator('[data-file="src/runner.ts"]');
  await expect(runner.locator(".cm-editor")).toBeVisible();
  await expect.poll(() => linesWith(runner, ".xpl-hl")).toEqual([76, 77, 78]);
  await expect
    .poll(() => linesWith(page.locator('[data-file="src/queue.ts"]'), ".xpl-hl"))
    .toEqual([87, 88, 89, 90]);
  expect([...recorded.files].sort()).toEqual(["src/queue.ts", "src/runner.ts"]);
  // Fetched once, however often the pane re-renders.
  await byId(page, "dispatch:1").click();
  await byId(page, "dispatch:3").click();
  expect([...recorded.files].sort()).toEqual(["src/queue.ts", "src/runner.ts"]);
  expect(problems).toEqual([]);
});

test("a file the server cannot deliver shows why", async ({ page }) => {
  await serve(page, { withheld: ["src/queue.ts"], fileStatus: 404 });
  await page.evaluate(() => window.__xpl!.setView("view:dispatch"));
  await byId(page, "dispatch:3").click();
  await expect(page.locator('[data-file="src/queue.ts"] .pane-message')).toContainText(
    "Source unavailable: 404",
  );
  // The other pane is unaffected.
  await expect(page.locator('[data-file="src/runner.ts"] .cm-editor')).toBeVisible();
});

test("view edits are sent to PUT /api/views/<id> with the changed fields (coalesced)", async ({
  page,
}) => {
  const recorded = await serve(page);
  await expect(page.locator(".save-status")).toHaveCount(0);

  await byId(page, "ghost:file:src/bus.ts").click();
  await expect(byId(page, "file:src/bus.ts")).toBeVisible();
  await expect(page.locator(".save-status")).toHaveText("Saved");
  expect(recorded.puts).toHaveLength(1);
  expect(recorded.puts[0]!.path).toBe("/api/views/view:overview");
  expect(recorded.puts[0]!.body).toEqual({
    type: "graph",
    include: ["grp:scheduling", "file:src/worker.ts", "file:src/metrics.ts", "file:src/bus.ts"],
  });
  expect((await stateOf(page)).dirty).toBe(false);

  // Two quick toggles arrive as one request carrying the final value.
  await page.locator('[data-edge-kind="imports"]').click();
  await page.locator('[data-edge-kind="reads"]').click();
  await expect(page.locator(".save-status")).toHaveText("Saved");
  await expect.poll(() => recorded.puts.length).toBe(2);
  expect(recorded.puts[1]!.body).toEqual({
    type: "graph",
    edgeKinds: ["calls", "imports", "extends", "implements", "reads"],
  });
});

test("a rejected save keeps the edit, says so, leaves the download available and can be retried", async ({
  page,
}) => {
  const recorded = await serve(page, { putStatus: 403 });
  await byId(page, "ghost:file:src/bus.ts").click();
  await expect(byId(page, "file:src/bus.ts")).toBeVisible();
  const status = page.locator(".save-status");
  await expect(status).toContainText("Not saved");
  await expect(status).toContainText("403");
  await expect(status).toContainText("the explainer is read-only");
  expect((await stateOf(page)).dirty).toBe(true);
  await expect(page.getByRole("button", { name: "Download explainer JSON" })).toBeEnabled();

  // The server recovers: the retry sends the edit that failed.
  recorded.putStatus = 200;
  await page.getByRole("button", { name: "Retry save" }).click();
  await expect(status).toHaveText("Saved");
  expect((await stateOf(page)).dirty).toBe(false);
  expect(recorded.puts.at(-1)!.body).toEqual({
    type: "graph",
    include: ["grp:scheduling", "file:src/worker.ts", "file:src/metrics.ts", "file:src/bus.ts"],
  });
});

test("Explain this queues a request with POST /api/requests", async ({ page }) => {
  const recorded = await serve(page);
  await page.evaluate(() => window.__xpl!.setView("view:dispatch"));
  await byId(page, "concept:retry-policy").click();
  await page.getByRole("button", { name: "Explain this" }).click();
  await expect(page.locator(".explain-note")).toContainText("Queued");
  expect(recorded.posts).toEqual([
    { kind: "expand", id: "concept:retry-policy", view: "view:dispatch", label: "Retry policy" },
  ]);
  // No command box when the request was queued.
  await expect(page.getByTestId("explain-command")).toHaveCount(0);
});
