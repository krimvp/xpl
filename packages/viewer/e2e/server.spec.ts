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
  /** PUT /api/tours/<id>. */
  tourPuts: { path: string; body: Record<string, unknown> }[];
  posts: Record<string, unknown>[];
  /** Status PUT answers with; a test may change it while the page is open. */
  putStatus: number;
  tourStatus: number;
}

async function serve(
  page: Page,
  opts: {
    /** Files the page does not carry: served on demand by GET /api/file. */
    withheld?: string[];
    putStatus?: number;
    tourStatus?: number;
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
  const recorded: Recorded = {
    files: [],
    puts: [],
    tourPuts: [],
    posts: [],
    putStatus: opts.putStatus ?? 200,
    tourStatus: opts.tourStatus ?? 200,
  };
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
    if (url.pathname.startsWith("/api/tours/") && request.method() === "PUT") {
      recorded.tourPuts.push({
        path: decodeURIComponent(url.pathname),
        body: JSON.parse(request.postData() ?? "null") as Record<string, unknown>,
      });
      if (recorded.tourStatus >= 400) {
        return route.fulfill({
          status: recorded.tourStatus,
          contentType: "application/json",
          body: JSON.stringify({ error: "tour patch rejected: stale anchor" }),
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
  await page.goto("http://xpl.test/?mode=explore");
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

  // Two quick toggles arrive as one request carrying the final value. Both clicks happen in one task, so
  // that a slow machine cannot spread them beyond the delay that coalesces edits.
  await page.evaluate(() => {
    for (const kind of ["imports", "reads"]) {
      document.querySelector<HTMLElement>(`[data-edge-kind="${kind}"]`)!.click();
    }
  });
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

/** The fixture's tour:intro as the page embeds it. */
function embeddedTour(): { id: string; title: string; steps: Record<string, unknown>[] } {
  const { bundle } = readEmbeddedBundle();
  const explainer = bundle.explainer as { tours: { id: string; title: string; steps: {}[] }[] };
  return structuredClone(explainer.tours[0]!) as ReturnType<typeof embeddedTour>;
}

test("tour edits are sent to PUT /api/tours/<id> with the whole tour, coalesced", async ({
  page,
}) => {
  const problems = watchProblems(page);
  const recorded = await serve(page);
  await page.getByTestId("tours-button").click();
  const rows = page.getByTestId("tour-step");
  await expect(rows).toHaveCount(2);

  // Typing is many edits; they go out as one request that carries the note as it is by then.
  const note = rows.first().getByTestId("tour-step-note");
  await note.fill("");
  await note.pressSequentially("Edited", { delay: 15 });
  await expect(page.locator(".save-status")).toHaveText("Saved");
  expect(recorded.tourPuts.length).toBeGreaterThan(0);
  expect(recorded.tourPuts.length).toBeLessThan(7);
  const last = recorded.tourPuts.at(-1)!;
  const tour = embeddedTour();
  expect(last.path).toBe("/api/tours/tour:intro");
  expect(last.body).toEqual({
    title: "Intro talk",
    steps: [{ ...tour.steps[0], note: "Edited" }, tour.steps[1]],
  });
  expect(recorded.puts).toEqual([]); // no view was touched
  expect((await stateOf(page)).dirty).toBe(false);
  await expect(page.locator(".save-status")).toHaveAttribute("title", "Your edits are saved");

  // Reordering sends the steps in the new order; deleting one leaves the other.
  recorded.tourPuts.length = 0;
  await rows.first().getByTestId("tour-step-down").click();
  await expect.poll(() => recorded.tourPuts.length).toBe(1);
  expect((recorded.tourPuts[0]!.body.steps as { id: string }[]).map((s) => s.id)).toEqual([
    "t2",
    "t1",
  ]);
  await rows.first().getByTestId("tour-step-delete").click();
  await expect.poll(() => recorded.tourPuts.length).toBe(2);
  expect(recorded.tourPuts[1]!.body).toEqual({
    title: "Intro talk",
    steps: [{ ...tour.steps[0], note: "Edited" }],
  });
  expect(problems).toEqual([]);
});

test("a new tour is created with PUT /api/tours/tour:<slug>, title and steps", async ({ page }) => {
  const recorded = await serve(page);
  await page.evaluate(() => window.__xpl!.setView("view:dispatch"));
  await byId(page, "dispatch:1").click();
  await page.getByTestId("tours-button").click();
  await page.getByTestId("tour-target").selectOption({ label: "New tour…" });
  await page.getByTestId("tour-new-title").fill("My talk");
  await page.getByTestId("tour-add").click();
  await expect(page.locator(".save-status")).toHaveText("Saved");
  expect(recorded.tourPuts).toHaveLength(1);
  expect(recorded.tourPuts[0]).toEqual({
    path: "/api/tours/tour:my-talk",
    body: { title: "My talk", steps: [{ id: "t1", view: "view:dispatch", focus: ["dispatch:1"] }] },
  });
  // and a second step of the same session goes to the same tour
  await byId(page, "dispatch:3").click();
  await page.getByTestId("tour-add").click();
  await expect.poll(() => recorded.tourPuts.length).toBe(2);
  expect(recorded.tourPuts[1]!.path).toBe("/api/tours/tour:my-talk");
  expect((recorded.tourPuts[1]!.body.steps as { id: string }[]).map((s) => s.id)).toEqual([
    "t1",
    "t2",
  ]);
  // the new tour can be presented right away
  await page.getByTestId("tour-present").click();
  await expect(page.getByTestId("tour-picker")).toHaveValue("tour:my-talk");
  await expect(page.getByTestId("tour-counter")).toHaveText("1 / 2");
});

test("a refused tour save keeps the edit, says why, does not hold back a view edit, and can be retried", async ({
  page,
}) => {
  const recorded = await serve(page, { tourStatus: 400 });
  await byId(page, "ghost:file:src/bus.ts").click(); // a view edit, which the server accepts
  await page.getByTestId("tours-button").click();
  await page.getByTestId("tour-step-note").first().fill("Will be refused.");
  const status = page.locator(".save-status");
  await expect(status).toContainText("Not saved");
  await expect(status).toContainText("400");
  await expect(status).toContainText("tour patch rejected: stale anchor");
  expect((await stateOf(page)).dirty).toBe(true);
  expect(recorded.puts).toHaveLength(1); // the view edit went through
  await expect(page.getByRole("button", { name: "Download explainer JSON" })).toBeEnabled();

  recorded.tourStatus = 200;
  await page.getByRole("button", { name: "Retry save" }).click();
  await expect(status).toHaveText("Saved");
  expect((await stateOf(page)).dirty).toBe(false);
  const steps = recorded.tourPuts.at(-1)!.body.steps as { note?: string }[];
  expect(steps[0]!.note).toBe("Will be refused.");
  expect(recorded.puts).toHaveLength(1); // the view edit was not sent again
});
