/**
 * Variants of the fixture explainer, built by editing the embedded bundle: anchors that drifted or went
 * missing, sequence diagrams with every step kind, self-calls and nested frames. Served from a fake
 * origin so the edited page can be handed to the browser.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  byId,
  focusOf,
  readEmbeddedBundle,
  screenshotPath,
  stateOf,
  watchProblems,
  withBundle,
} from "./helpers.js";

/** The embedded bundle is edited as loose JSON: many shapes, none worth typing here. */
type Loose = Record<string, any>;

async function openVariant(page: Page, edit: (bundle: Loose) => void): Promise<void> {
  const { html, bundle } = readEmbeddedBundle();
  edit(bundle);
  await page.route("http://xpl.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: withBundle(html, bundle) }),
  );
  await page.goto("http://xpl.test/?mode=explore");
  await page.waitForFunction(() => window.__xpl !== undefined);
}

test("anchors that drifted or went missing are badged; missing ones are not drawn as code", async ({
  page,
}) => {
  const problems = watchProblems(page);
  await openVariant(page, (bundle) => {
    const concept = bundle.explainer.concepts[0];
    concept.anchors[0].resolved.status = "moved";
    concept.anchors[1].resolved.status = "drifted";
    concept.anchors[2].resolved.status = "missing";
  });
  await page.evaluate(() => window.__xpl!.setView("view:dispatch"));

  // The concept list says what is stale.
  const item = byId(page, "concept:retry-policy");
  await expect(item.locator(".badge.status-drifted")).toHaveText("1 drifted");
  await expect(item.locator(".badge.status-missing")).toHaveText("1 missing");

  await item.click();
  // Details: one row per anchor with its status.
  const rows = page.locator(".details .anchor-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0).locator(".badge")).toHaveText("moved");
  await expect(rows.nth(1).locator(".badge")).toHaveText("drifted");
  await expect(rows.nth(2).locator(".badge")).toHaveText("missing");
  await expect(rows.nth(1)).toHaveAttribute("data-status", "drifted");
  await expect(rows.nth(2)).toHaveAttribute("data-status", "missing");

  // Missing anchors have no code to show; the others do, and the pane says the text drifted.
  const focus = await focusOf(page);
  expect(focus.map((f) => [f.file, f.status])).toEqual([
    ["src/runner.ts", "moved"],
    ["config/default.yaml", "drifted"],
  ]);
  await expect(page.locator("[data-file]")).toHaveCount(2);
  await expect(
    page.locator('[data-file="config/default.yaml"] .pane-header .badge.status-drifted'),
  ).toBeVisible();
  await expect(page.locator('[data-path="test/retry.test.ts"]')).toHaveClass(/is-dimmed/);
  expect(problems).toEqual([]);
});

test("sequence diagrams: call, return and async arrows, self-calls, nested frames", async ({
  page,
}) => {
  const problems = watchProblems(page);
  const runner = "sym:src/runner.ts#Runner.dispatch";
  await openVariant(page, (bundle) => {
    const view = bundle.explainer.views.find((v: Loose) => v.id === "view:dispatch");
    view.participants = [runner, "file:src/queue.ts", "file:src/worker.ts", "file:src/metrics.ts"];
    view.steps = [
      {
        id: "dispatch:1",
        from: runner,
        to: "file:src/queue.ts",
        label: "pop()",
        kind: "call",
        anchors: [],
      },
      {
        id: "dispatch:2",
        from: "file:src/queue.ts",
        to: runner,
        label: "job",
        kind: "return",
        anchors: [],
      },
      {
        id: "dispatch:3",
        from: runner,
        to: "file:src/worker.ts",
        label: "run(job)",
        kind: "call",
        anchors: [],
      },
      {
        id: "dispatch:4",
        from: "file:src/worker.ts",
        to: "file:src/worker.ts",
        label: "withTimeout(handler)",
        kind: "call",
        anchors: [],
      },
      {
        id: "dispatch:5",
        from: "file:src/worker.ts",
        to: "file:src/metrics.ts",
        label: "job.completed",
        kind: "async",
        anchors: [],
      },
      {
        id: "dispatch:6",
        from: "file:src/worker.ts",
        to: runner,
        label: "result",
        kind: "return",
        anchors: [],
      },
      {
        id: "dispatch:7",
        from: runner,
        to: "sym:src/queue.ts#Queue.ack",
        label: "ack(job)",
        kind: "call",
        anchors: [],
      },
    ];
    view.frames = [
      {
        id: "frame:outer",
        kind: "loop",
        label: "while running",
        fromStep: "dispatch:1",
        toStep: "dispatch:7",
      },
      {
        id: "frame:inner",
        kind: "alt",
        label: "handler ok",
        fromStep: "dispatch:3",
        toStep: "dispatch:5",
      },
      {
        id: "frame:opt",
        kind: "opt",
        label: "metrics enabled",
        fromStep: "dispatch:5",
        toStep: "dispatch:5",
      },
    ];
  });
  await page.evaluate(() => window.__xpl!.setView("view:dispatch"));

  const steps = page.locator("[data-element-id^='dispatch:']");
  await expect(steps).toHaveCount(7);
  await expect(byId(page, "dispatch:1")).toHaveClass(/kind-call/);
  await expect(byId(page, "dispatch:2")).toHaveClass(/kind-return/);
  await expect(byId(page, "dispatch:5")).toHaveClass(/kind-async/);
  // return: dashed line; call: solid.
  const dash = (id: string) =>
    byId(page, id)
      .locator("path.line")
      .evaluate((el) => getComputedStyle(el).strokeDasharray);
  expect(await dash("dispatch:1")).toBe("none");
  expect(await dash("dispatch:2")).not.toBe("none");
  expect(await dash("dispatch:5")).toBe("none");
  // Arrows run between the lifelines they name: dispatch:1 left to right, dispatch:2 back.
  const box = async (id: string) => (await byId(page, id).locator("path.line").boundingBox())!;
  const one = await box("dispatch:1");
  const two = await box("dispatch:2");
  expect(Math.abs(one.x - two.x)).toBeLessThan(2);
  expect(Math.abs(one.width - two.width)).toBeLessThan(2);
  // The self-call is a loop: taller than a straight arrow, at the worker lifeline.
  const self = await box("dispatch:4");
  expect(self.height).toBeGreaterThan(15);
  const worker = (await byId(page, "file:src/worker.ts").locator("rect.head").boundingBox())!;
  // (boxes of strokes include half the stroke width: allow a few px)
  expect(Math.abs(self.x - (worker.x + worker.width / 2))).toBeLessThan(4);
  // A step whose end is inside a participant (Queue.ack in queue.ts) still lands on that lifeline.
  const seven = await box("dispatch:7");
  const queue = (await byId(page, "file:src/queue.ts").locator("rect.head").boundingBox())!;
  expect(Math.abs(seven.x + seven.width - (queue.x + queue.width / 2))).toBeLessThan(4);

  // Frames: three rectangles, nested inside each other, drawn around their steps.
  const frames = page.locator("[data-frame-id]");
  await expect(frames).toHaveCount(3);
  const frameBox = async (id: string) =>
    (await page.locator(`[data-frame-id="${id}"] rect.frame-box`).boundingBox())!;
  const outer = await frameBox("frame:outer");
  const inner = await frameBox("frame:inner");
  const opt = await frameBox("frame:opt");
  const contains = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
    a.x <= b.x && a.y <= b.y && a.x + a.width >= b.x + b.width && a.y + a.height >= b.y + b.height;
  expect(contains(outer, inner)).toBe(true);
  expect(contains(inner, opt)).toBe(true);
  for (const id of ["dispatch:1", "dispatch:7"]) expect(contains(outer, await box(id))).toBe(true);
  for (const id of ["dispatch:3", "dispatch:4", "dispatch:5"])
    expect(contains(inner, await box(id))).toBe(true);
  expect(contains(inner, await box("dispatch:6"))).toBe(false);
  await expect(page.locator('[data-frame-id="frame:inner"]')).toContainText("alt");
  await expect(page.locator('[data-frame-id="frame:inner"]')).toContainText("[handler ok]");
  // Frames never swallow clicks meant for the steps under them.
  await byId(page, "dispatch:4").click();
  expect((await stateOf(page)).selection).toEqual(["dispatch:4"]);
  await page.locator(".diagram").screenshot({ path: screenshotPath("sequence-all-kinds") });
  expect(problems).toEqual([]);
});

test("clicking a stub selects it and shows the reference sites that cross the view's edge", async ({
  page,
}) => {
  await openVariantPlain(page);
  const stub = page.locator('[data-stub-id="stub:out:file:src/metrics.ts->ghost:file:src/bus.ts"]');
  await expect(stub).toBeVisible();
  await stub.click();
  expect((await stateOf(page)).selection).toEqual([
    "stub:out:file:src/metrics.ts->ghost:file:src/bus.ts",
  ]);
  await expect(stub).toHaveClass(/is-selected/);
  const focus = await focusOf(page);
  // The bus.on(...) call in registerMetrics (line 23), then EventBus.on itself.
  expect(focus.map((f) => [f.file, f.range.startLine, f.range.endLine, f.role])).toEqual([
    ["src/metrics.ts", 23, 23, "call-site"],
    ["src/bus.ts", 18, 21, "definition"],
  ]);
  await expect(page.locator(".details")).toContainText("stub");
  await expect(page.locator(".details")).toContainText("bus.ts");
  // The call expression itself is marked inside the highlighted line.
  await expect(
    page.locator('[data-file="src/metrics.ts"] .cm-line[data-line="23"] .xpl-site'),
  ).toBeVisible();
  // "Add to the view" from the details panel does what clicking the ghost does.
  await page
    .locator(".details")
    .getByRole("button", { name: /Add bus\.ts to the view/ })
    .click();
  await expect(byId(page, "file:src/bus.ts")).toBeVisible();
});

async function openVariantPlain(page: Page): Promise<void> {
  await openVariant(page, () => undefined);
}

test("a malformed explainer degrades to messages instead of a blank page", async ({ page }) => {
  const problems = watchProblems(page);
  await openVariant(page, (bundle) => {
    const views = bundle.explainer.views as Loose[];
    views[0]!.include = "not a list";
    views.push({
      id: "view:odd",
      type: "timeline",
      title: "Odd one",
      scope: { root: "repo", depth: 1 },
    });
  });
  await expect(page.locator(".diagram-message")).toContainText("shows nothing yet");
  await page.locator('.tab[data-view-id="view:odd"]').click();
  await expect(page.locator(".diagram-message")).toContainText(
    'cannot draw views of type "timeline"',
  );
  // The rest of the viewer still works.
  await byId(page, "concept:retry-policy").click();
  await expect(page.locator("[data-file]")).toHaveCount(3);
  expect(problems).toEqual([]);
});
