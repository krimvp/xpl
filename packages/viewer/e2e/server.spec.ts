/**
 * The viewer under `xpl view`: `bundle.server.api` is set, so it fetches missing files, persists view
 * edits and queues explain requests over HTTP. The "server" is Playwright's request interception on a
 * fake origin; the requests recorded here are the contract `xpl view` has to serve.
 */
import type { WatchAttention } from "@xpl/core";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import {
  byId,
  linesWith,
  openEditMenu,
  openTourEditor,
  readEmbeddedBundle,
  selectionOf,
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
  serviceStatus: number;
  attention?: WatchAttention;
  watchActions: string[];
  tourStatus: number;
  /** What GET /api/explainer serves; until a test sets it, the explainer is unchanged (304). */
  explainer?: unknown;
  workspace?: Record<string, unknown>;
}

async function serve(
  page: Page,
  opts: {
    /** Files the page does not carry: served on demand by GET /api/file. */
    withheld?: string[];
    managed?: boolean;
    backendAvailable?: boolean;
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
  bundle.server = {
    api: "/api",
    ...(opts.managed
      ? {
          attachment: {
            root: "/repos/jobrunner",
            guide: ".explainer/jobrunner.explainer.json",
            instanceId: "first",
            backend: "claude",
            backendAvailable: opts.backendAvailable ?? false,
          },
        }
      : {}),
  };
  const recorded: Recorded = {
    files: [],
    puts: [],
    serviceStatus: 200,
    watchActions: [],
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
    if (recorded.serviceStatus !== 200 && url.pathname.startsWith("/api/")) {
      if (recorded.serviceStatus === 0) return route.abort("connectionrefused");
      return route.fulfill({
        status: recorded.serviceStatus,
        body: "This address serves a different repository or guide.",
      });
    }
    if (url.pathname === "/api/watch") {
      if (!recorded.attention) return route.fulfill({ status: 404 });
      if (request.method() === "POST") {
        const { action } = JSON.parse(request.postData()!);
        recorded.watchActions.push(action);
        if (action === "stop") recorded.serviceStatus = 0;
        else recorded.attention.watch!.state = action === "pause" ? "paused" : "pending";
      }
      return route.fulfill({ json: recorded.attention });
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
    if (url.pathname === "/api/explainer" && request.method() === "GET") {
      if (recorded.explainer === undefined) return route.fulfill({ status: 304 });
      return route.fulfill({
        contentType: "application/json",
        headers: { etag: '"changed"' },
        body: JSON.stringify(recorded.explainer),
      });
    }
    if (url.pathname === "/api/bundle" && request.method() === "GET") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ...bundle,
          ...recorded.workspace,
          ...(recorded.explainer ? { explainer: recorded.explainer } : {}),
        }),
      });
    }
    if (url.pathname === "/favicon.ico") return route.fulfill({ status: 204 });
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

test("plain view keeps the reader layout without managed service controls", async ({ page }) => {
  await serve(page);
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
  await expect(byId(page, "grp:scheduling")).toBeVisible();
  await expect.poll(async () => (await stateOf(page)).serverMode).toBe(true);
  await expect(page.getByTestId("connection-status")).toHaveCount(0);
  await expect(page.getByTestId("attention-status")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Use loaded snapshot offline" })).toHaveCount(0);
  expect(new URL(page.url()).searchParams.has("attachment")).toBe(false);
});

test("managed attention distinguishes moved, drifted and missing evidence and offers an explicit revision", async ({
  page,
}) => {
  const recorded = await serve(page, { managed: true });
  recorded.attention = {
    enabled: true,
    instanceId: "first",
    watch: {
      state: "current",
      stale: false,
      generation: 2,
      index: { path: ".explainer/index-test.json", commit: "test" },
      error: null,
    },
    guides: [
      {
        name: "jobrunner",
        path: ".explainer/jobrunner.explainer.json",
        title: "Job runner",
        counts: { moved: 1, drifted: 1, missing: 1 },
        errors: [],
        elements: [
          { id: "file:src/queue.ts", file: "src/queue.ts", status: "moved" },
          { id: "concept:retry-policy", file: "src/runner.ts", status: "drifted" },
          { id: "file:src/gone.ts", file: "src/gone.ts", status: "missing" },
        ],
        resolveCommand:
          "xpl resolve --root '/repos/jobrunner' '/repos/jobrunner/.explainer/jobrunner.explainer.json' --write",
        revisionCommand: "xpl revise '.explainer/jobrunner.explainer.json' --select '<request-id>'",
      },
    ],
  };
  recorded.attention.guides.push({
    name: "retry.json",
    path: ".explainer/retry.json.explainer.json",
    title: "Retry",
    counts: { moved: 1, drifted: 0, missing: 0 },
    errors: [],
    elements: [{ id: "file:src/queue.ts", file: "src/queue.ts", status: "moved" }],
    resolveCommand:
      "xpl resolve --root '/repos/jobrunner' '/repos/jobrunner/.explainer/retry.json.explainer.json' --write",
    revisionCommand:
      "xpl revise --root '/repos/jobrunner' '/repos/jobrunner/.explainer/retry.json.explainer.json' --select '<request-id>'",
  });
  const panel = page.getByTestId("attention-status");
  await expect(panel).toContainText("1 guide needs attention");
  await panel.getByText("Watching", { exact: false }).first().click();
  await expect(panel).toContainText("Moved: locations followed unchanged code");
  await expect(panel).toContainText("Drifted: inspect the changed code and revise its explanation");
  await expect(panel).toContainText(
    "Missing: restore the code or explicitly replace/remove its evidence",
  );
  await expect(panel).toContainText(
    "xpl resolve --root '/repos/jobrunner' '/repos/jobrunner/.explainer/retry.json.explainer.json' --write",
  );
  await panel.getByText("Offer revision", { exact: true }).click();
  await expect(panel).toContainText(
    "xpl revise '.explainer/jobrunner.explainer.json' --select '<request-id>'",
  );
  await expect(panel).toContainText("Accept a proposal separately");
  expect(recorded.posts).toEqual([]);
  expect(recorded.puts).toEqual([]);
  expect(recorded.watchActions).toEqual([]);
  // The inventory ID reaches the same Details target that owns evidence repair.
  await panel.getByRole("button", { name: "Inspect element" }).nth(1).click();
  await expect(page.locator('.details[data-details-id="concept:retry-policy"]')).toBeVisible();
  await panel.locator(".attention-list > summary").click();
  await page.getByTestId("evidence-edit").click();
  await expect(page.getByRole("form", { name: "Edit source evidence" })).toBeVisible();
  await expect(page.locator(".evidence-list")).toContainText("src/runner.ts");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(recorded.posts).toEqual([]);
  expect(recorded.puts).toEqual([]);
  await panel.getByText("Watch controls", { exact: true }).click();
  await panel.getByRole("button", { name: "Pause watch" }).click();
  await expect(panel).toContainText("Paused");
  await panel.getByRole("button", { name: "Resume watch" }).click();
  await expect.poll(() => recorded.watchActions).toEqual(["pause", "resume"]);
  await panel.getByRole("button", { name: "Stop service" }).click();
  await expect.poll(() => recorded.watchActions).toEqual(["pause", "resume", "stop"]);
  await expect(page.getByTestId("connection-status")).toContainText("Disconnected");
  await expect(byId(page, "grp:scheduling")).toBeVisible();
});

for (const [width, height] of [
  [1440, 900],
  [1280, 720],
] as const) {
  test(`expanded attention preserves diagram and source space at ${width}x${height}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    const recorded = await serve(page, { managed: true });
    recorded.attention = layoutAttention();
    await page.evaluate(() => window.__xpl!.select(["file:src/queue.ts"]));
    await expect(page.locator(".cm-editor").first()).toBeVisible();
    const panel = page.getByTestId("attention-status");
    await expect(panel).toContainText("3 guides need attention");
    await panel.locator(":scope > details > summary").first().click();
    await expect(panel).toContainText("sym:src/runner.ts#Runner.dispatch");
    await expect
      .poll(() =>
        page
          .locator(".diagram-body")
          .first()
          .evaluate((el) => el.getBoundingClientRect().height),
      )
      .toBeGreaterThan(180);
    await expect
      .poll(() =>
        page
          .locator(".cm-editor")
          .first()
          .evaluate((el) => el.getBoundingClientRect().height),
      )
      .toBeGreaterThan(180);
    await expect(byId(page, "grp:scheduling")).toBeVisible();
    await panel.getByRole("heading", { name: "workers (workers)" }).scrollIntoViewIfNeeded();
    await expect(panel.getByRole("heading", { name: "workers (workers)" })).toBeVisible();
  });
}

test("collapsed service connection, attention and controls fit a compact narrow bar", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const recorded = await serve(page, { managed: true, backendAvailable: true });
  recorded.attention = layoutAttention();
  const panel = page.getByTestId("attention-status");
  await expect(panel).toContainText("3 guides need attention");
  await expect(page.getByTestId("connection-status")).toContainText("Connected");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const connection = document
          .querySelector('[data-testid="connection-status"]')!
          .getBoundingClientRect();
        const attention = document
          .querySelector('[data-testid="attention-status"]')!
          .getBoundingClientRect();
        return (
          Math.max(connection.bottom, attention.bottom) - Math.min(connection.top, attention.top)
        );
      }),
    )
    .toBeLessThan(90);
  await expect(page.getByRole("button", { name: "Pause watch" })).toBeHidden();
  await page.getByText("Watch controls", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause watch" })).toBeVisible();
  await page.getByText("Connection details", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause watch" })).toBeHidden();
  await expect(page.getByTestId("connection-status")).toContainText("/repos/jobrunner");
  const details = page.getByTestId("connection-status").locator(".service-disclosure");
  await expect(
    details.getByText("Agent: Claude Code (configured; sign-in is checked when a job runs)"),
  ).toBeVisible();
  await expect
    .poll(() => details.evaluate((element) => element.getBoundingClientRect().left))
    .toBeGreaterThanOrEqual(0);
  await expect
    .poll(() => details.evaluate((element) => element.getBoundingClientRect().right))
    .toBeLessThanOrEqual(390);
});

function layoutAttention(): WatchAttention {
  return {
    enabled: true,
    instanceId: "first",
    watch: {
      state: "current",
      stale: false,
      generation: 2,
      index: { path: ".explainer/index-test.json", commit: "test" },
      error: null,
    },
    guides: ["jobrunner", "retry", "workers"].map((name) => ({
      name,
      path: `.explainer/${name}.explainer.json`,
      title: name,
      counts: { moved: 0, drifted: 2, missing: 2 },
      errors: [],
      elements: [
        { id: "sym:src/runner.ts#Runner.dispatch", file: "src/runner.ts", status: "drifted" },
        { id: "file:src/queue.ts", file: "src/queue.ts", status: "drifted" },
        { id: "file:src/gone.ts", file: "src/gone.ts", status: "missing" },
        { id: "file:src/gone-worker.ts", file: "src/gone-worker.ts", status: "missing" },
      ],
      resolveCommand:
        "xpl resolve --root '/repos/jobrunner' '/repos/jobrunner/.explainer/jobrunner.explainer.json' --write",
      revisionCommand:
        "xpl revise --root '/repos/jobrunner' '/repos/jobrunner/.explainer/jobrunner.explainer.json' --select '<request-id>'",
    })),
  };
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
  await openEditMenu(page);
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
  const menu = await openEditMenu(page);
  await expect(menu.getByTestId("edit-download")).toBeEnabled();

  // The server recovers: the retry (in the Edit menu) sends the edit that failed.
  recorded.putStatus = 200;
  await menu.getByTestId("edit-retry").click();
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
  expect(recorded.posts).toHaveLength(1);
  expect(recorded.posts[0]).toMatchObject({
    kind: "expand",
    elementId: "concept:retry-policy",
    view: "view:dispatch",
    label: "Retry policy",
    id: expect.any(String),
    context: { explainerHash: expect.any(String), sourceHash: expect.any(String) },
    outcome: { status: "pending", reason: "Awaiting an explicit revision pass." },
  });
  // No command box when the request was queued.
  await expect(page.getByTestId("explain-command")).toHaveCount(0);
});

test("feedback typed under Explain this is queued as the note, and the change comes back by itself", async ({
  page,
}) => {
  const problems = watchProblems(page);
  const recorded = await serve(page);
  await page.evaluate(() => window.__xpl!.setView("view:dispatch"));
  await byId(page, "concept:retry-policy").click();
  await page.getByTestId("feedback").fill("Too long: one sentence is enough.");
  await page.getByRole("button", { name: "Send to Claude" }).click();
  await expect(page.locator(".explain-note")).toContainText("Queued");
  expect(recorded.posts).toHaveLength(1);
  expect(recorded.posts[0]).toMatchObject({
    kind: "expand",
    elementId: "concept:retry-policy",
    note: "Too long: one sentence is enough.",
    view: "view:dispatch",
    label: "Retry policy",
  });
  await expect(page.getByTestId("feedback")).toHaveValue("");

  // Claude applies a patch; the next poll brings it in, with the same element still selected.
  const explainer = structuredClone(readEmbeddedBundle().bundle.explainer) as {
    concepts: { id: string; summary?: string }[];
  };
  explainer.concepts.find((c) => c.id === "concept:retry-policy")!.summary =
    "A failed job waits longer before each new try.";
  recorded.explainer = explainer;
  await expect(page.locator(".details")).toContainText(
    "A failed job waits longer before each new try.",
    { timeout: 10_000 },
  );
  expect(await selectionOf(page)).toEqual(["concept:retry-policy"]);
  expect(problems).toEqual([]);
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
  await openTourEditor(page);
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
  await openTourEditor(page);
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
  await openTourEditor(page);
  await page.getByTestId("tour-step-note").first().fill("Will be refused.");
  const status = page.locator(".save-status");
  await expect(status).toContainText("Not saved");
  await expect(status).toContainText("400");
  await expect(status).toContainText("tour patch rejected: stale anchor");
  expect((await stateOf(page)).dirty).toBe(true);
  expect(recorded.puts).toHaveLength(1); // the view edit went through
  const menu = await openEditMenu(page);
  await expect(menu.getByTestId("edit-download")).toBeEnabled();

  recorded.tourStatus = 200;
  await menu.getByTestId("edit-retry").click();
  await expect(status).toHaveText("Saved");
  expect((await stateOf(page)).dirty).toBe(false);
  const steps = recorded.tourPuts.at(-1)!.body.steps as { note?: string }[];
  expect(steps[0]!.note).toBe("Will be refused.");
  expect(recorded.puts).toHaveLength(1); // the view edit was not sent again
});

test("a source edit refreshes Code and the freshness warning without changing the story or selection", async ({
  page,
}) => {
  const problems = watchProblems(page);
  const recorded = await serve(page);
  await page.evaluate(() => window.__xpl!.setView("view:dispatch"));
  await byId(page, "dispatch:3").click();
  const { bundle } = readEmbeddedBundle();
  const original = (bundle.files as Record<string, string>)["src/runner.ts"]!;
  recorded.workspace = {
    files: {
      ...(bundle.files as Record<string, string>),
      "src/runner.ts": original + "\n// Updated source while the page is open\n",
    },
    sourceWarning: "Source changed: run xpl index before relying on indexed relationships.",
  };
  recorded.explainer = bundle.explainer;
  await expect(page.locator('[data-file="src/runner.ts"] .cm-editor')).toContainText(
    "Updated source while the page is open",
    { timeout: 10_000 },
  );
  await expect(page.getByTestId("source-warning")).toContainText("run xpl index");
  expect(await selectionOf(page)).toEqual(["dispatch:3"]);
  expect(problems).toEqual([]);
});

test("readers can find the limits of source verification beside the guide", async ({ page }) => {
  await serve(page);
  await (await openEditMenu(page)).getByTestId("edit-read").click();
  await page.getByTestId("perspective-guide").click();
  const info = page.getByTestId("explanation-info");
  await info.locator("summary").click();
  await expect(info).toContainText("they do not verify the claims");
  await expect(info).toContainText("applied changes appear here automatically");
});

test("a managed page reports configured Claude without claiming sign-in", async ({ page }) => {
  await serve(page, { managed: true, backendAvailable: true });
  const connection = page.getByTestId("connection-status");
  await expect(connection).toHaveAttribute("data-status", "connected");
  await connection.getByText("Connection details").click();
  await expect(connection).toContainText(
    "Agent: Claude Code (configured; sign-in is checked when a job runs)",
  );
});

test("a managed page shows backend unavailability, refuses another service, and exports its loaded snapshot after stop", async ({
  page,
}) => {
  const recorded = await serve(page, { managed: true });
  const connection = page.getByTestId("connection-status");
  await expect(connection).toHaveAttribute("data-status", "connected");
  expect(JSON.parse(new URL(page.url()).searchParams.get("attachment")!)).toEqual({
    root: "/repos/jobrunner",
    guide: ".explainer/jobrunner.explainer.json",
  });
  await connection.getByText("Connection details").click();
  await expect(connection).toContainText(
    "No agent is configured. Use xpl revise for a manual revision.",
  );
  await page.evaluate(() => window.__xpl!.select(["concept:retry"]));
  recorded.serviceStatus = 409;
  await expect(connection).toHaveAttribute("data-status", "unavailable");
  await expect(connection).toContainText("different repository or guide");
  recorded.serviceStatus = 0;
  await connection.getByRole("button", { name: "Retry connection" }).click();
  await expect(connection).toHaveAttribute("data-status", "disconnected");
  await connection.getByRole("button", { name: "Use loaded snapshot offline" }).click();
  await expect(connection).toHaveAttribute("data-status", "offline");
  await page.getByRole("button", { name: /^Feedback/ }).click();
  const panel = page.getByRole("dialog", { name: "Reader feedback" });
  await panel.getByLabel("Feedback note").fill("Manual revision after stop.");
  await panel.getByRole("button", { name: "Save feedback", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Saved in this browser");
  await panel.getByRole("button", { name: "Close feedback" }).click();
  await openEditMenu(page);
  await page.getByRole("menuitem", { name: "Save as HTML" }).click();
  const dialog = page.getByRole("dialog", { name: "Save as HTML" });
  await expect(dialog).toContainText("Checks only the embedded source snapshot");
  await expect(page.getByTestId("save-html-draft")).toBeEnabled();
  const downloading = page.waitForEvent("download");
  await page.getByTestId("save-html-draft").click();
  const output = readFileSync((await (await downloading).path())!, "utf8");
  const data = JSON.parse(
    /<script id="xpl-data" type="application\/json">([\s\S]*?)<\/script>/.exec(output)![1]!,
  );
  expect(data.server).toBeUndefined();
  expect(data.exportInfo.report.scope).toBe("embedded-snapshot");
  expect(data.feedback.requests[0].note).toBe("Manual revision after stop.");
  expect(recorded.posts).toEqual([]);
  recorded.serviceStatus = 200;
  await connection.getByRole("button", { name: "Retry connection" }).click();
  await expect(connection).toHaveAttribute("data-status", "connected");
  await expect.poll(() => selectionOf(page)).toEqual(["concept:retry"]);
});
