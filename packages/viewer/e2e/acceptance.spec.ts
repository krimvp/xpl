/**
 * The acceptance checks of docs/ARCHITECTURE.md section 8 / the task brief, against the TS fixture
 * bundle (fixtures/ts-jobrunner + Appendix B of docs/handoff.md), opened from file://.
 */
import { expect, test } from "@playwright/test";
import {
  byId,
  focusOf,
  linesWith,
  matchesOf,
  openBundle,
  screenshotPath,
  stateOf,
  watchProblems,
} from "./helpers.js";

const DISPATCH = "sym:src/runner.ts#Runner.dispatch";

test.describe("view:dispatch", () => {
  test("clicking step dispatch:3 shows runner.ts and queue.ts: the call and the definition highlighted, the rest dimmed", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await openBundle(page, "view:dispatch");

    await byId(page, "dispatch:3").click();

    // Panes: the call site's file first, then the callee's.
    await expect(page.locator("[data-file]")).toHaveCount(2);
    const files = await page
      .locator("[data-file]")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-file")));
    expect(files).toEqual(["src/runner.ts", "src/queue.ts"]);
    const runner = page.locator('[data-file="src/runner.ts"]');
    const queue = page.locator('[data-file="src/queue.ts"]');
    await expect(runner.locator(".cm-editor")).toBeVisible();
    await expect(queue.locator(".cm-editor")).toBeVisible();

    // runner.ts lines 76-78 (offsets 34-36 of Runner.dispatch) and the Queue.requeue definition.
    await expect.poll(() => linesWith(runner, ".xpl-hl")).toEqual([76, 77, 78]);
    await expect.poll(() => linesWith(queue, ".xpl-hl")).toEqual([87, 88, 89, 90]);
    await expect.poll(() => linesWith(runner, ".xpl-hl-call-site")).toEqual([76, 77, 78]);
    await expect.poll(() => linesWith(queue, ".xpl-hl-definition")).toEqual([87, 88, 89, 90]);

    // Every other visible line is dimmed, and there are some.
    for (const pane of [runner, queue]) {
      await expect(pane.locator(".cm-line.xpl-dim").first()).toBeVisible();
      await expect(pane.locator(".cm-line:not(.xpl-hl):not(.xpl-dim)")).toHaveCount(0);
      expect(await pane.locator(".cm-line.xpl-dim.xpl-hl").count()).toBe(0);
    }

    // The focus is exactly those two ranges.
    const focus = await focusOf(page);
    expect(
      focus.map(({ file, range, role }) => [file, range.startLine, range.endLine, role]),
    ).toEqual([
      ["src/runner.ts", 76, 78, "call-site"],
      ["src/queue.ts", 87, 90, "definition"],
    ]);
    expect(focus.every((f) => f.elementId === "dispatch:3" && f.status === "ok")).toBe(true);

    // The selection shows on the step; files outside the focus are greyed in the tree.
    await expect(byId(page, "dispatch:3")).toHaveClass(/is-selected/);
    await expect(page.locator('[data-path="src/runner.ts"]')).not.toHaveClass(/is-dimmed/);
    await expect(page.locator('[data-path="src/queue.ts"]')).not.toHaveClass(/is-dimmed/);
    await expect(page.locator('[data-path="src/worker.ts"]')).toHaveClass(/is-dimmed/);
    await expect(page.locator('[data-path="config/default.yaml"]')).toHaveClass(/is-dimmed/);

    expect(problems).toEqual([]);
  });

  test("the caret maps back to the innermost diagram element: dispatch:3 on the call, the concept elsewhere in the retry block", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await openBundle(page, "view:dispatch");
    await byId(page, "dispatch:3").click();
    const runner = page.locator('[data-file="src/runner.ts"]');
    await expect.poll(() => linesWith(runner, ".xpl-hl")).toEqual([76, 77, 78]);

    // A real click on the text of line 77 (`job,` inside the requeue call, offset 35).
    const line77 = runner.locator('.cm-line[data-line="77"]');
    await expect(line77).toHaveText(/^\s*job,\s*$/);
    await line77.click({ position: { x: 96, y: 9 } });
    await expect.poll(() => matchesOf(page)).toEqual(["dispatch:3"]);
    await expect(byId(page, "dispatch:3")).toHaveClass(/is-match/);
    await expect(byId(page, "concept:retry-policy")).not.toHaveClass(/is-match/);
    // ... and it is the only element on the page that is marked as a match.
    await expect(page.locator(".is-match")).toHaveCount(1);
    expect((await stateOf(page)).cursor).toMatchObject({ file: "src/runner.ts", fromLine: 77 });

    // The same through the test hook.
    await page.evaluate(() => window.__xpl!.setCursor("src/runner.ts", 73));
    await expect.poll(() => matchesOf(page)).toEqual(["concept:retry-policy"]);
    await expect(byId(page, "concept:retry-policy")).toHaveClass(/is-match/);
    await expect(byId(page, "dispatch:3")).not.toHaveClass(/is-match/);
    await expect(page.locator(".is-match")).toHaveCount(1);

    await page.evaluate(() => window.__xpl!.setCursor("src/runner.ts", 77));
    await expect.poll(() => matchesOf(page)).toEqual(["dispatch:3"]);
    await expect(byId(page, "dispatch:3")).toHaveClass(/is-match/);
    await expect(byId(page, "concept:retry-policy")).not.toHaveClass(/is-match/);

    // ... and a real click on line 73 (offset 31) agrees with the hook.
    const line73 = runner.locator('.cm-line[data-line="73"]');
    await line73.click({ position: { x: 60, y: 9 } });
    await expect.poll(() => matchesOf(page)).toEqual(["concept:retry-policy"]);

    // Other lines of the sequence: the pop() call, the run(job) call and the lifeline elsewhere.
    await page.evaluate(() => window.__xpl!.setCursor("src/runner.ts", 46));
    await expect.poll(() => matchesOf(page)).toEqual(["dispatch:1"]);
    // A caret moved by the hook is shown where it is: the editor scrolls to it.
    await expect(runner.locator('.cm-line[data-line="46"]')).toBeInViewport();
    await page.evaluate(() => window.__xpl!.setCursor("src/runner.ts", 61));
    await expect.poll(() => matchesOf(page)).toEqual(["dispatch:2"]);
    await page.evaluate(() => window.__xpl!.setCursor("src/runner.ts", 50));
    await expect.poll(() => matchesOf(page)).toEqual([DISPATCH]);
    await expect(byId(page, DISPATCH)).toHaveClass(/is-match/);

    expect(problems).toEqual([]);
  });

  test("setCursor on a file no pane shows opens it, and matches are found there", async ({
    page,
  }) => {
    await openBundle(page, "view:dispatch");
    // No selection: config/default.yaml is not on screen. Line 14 is inside the retry key.
    await page.evaluate(() => window.__xpl!.setCursor("config/default.yaml", 14));
    await expect(page.locator('[data-file="config/default.yaml"] .cm-editor')).toBeVisible();
    await expect.poll(() => matchesOf(page)).toEqual(["concept:retry-policy"]);
    await expect(byId(page, "concept:retry-policy")).toHaveClass(/is-match/);
    // The file was only opened, not focused: nothing dimmed.
    await expect(page.locator('[data-file="config/default.yaml"] .cm-line.xpl-dim')).toHaveCount(0);
  });

  test("clicking concept:retry-policy focuses runner.ts 72-83, the retry key and the test, and marks the related lifelines", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await openBundle(page, "view:dispatch");

    await byId(page, "concept:retry-policy").click();

    const focus = await focusOf(page);
    expect(
      focus.map(({ file, range, role }) => [file, range.startLine, range.endLine, role]),
    ).toEqual([
      ["src/runner.ts", 72, 83, "definition"],
      ["config/default.yaml", 13, 16, "config"],
      ["test/retry.test.ts", 1, 91, "test"],
    ]);

    const files = await page
      .locator("[data-file]")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-file")));
    expect(files).toEqual(["src/runner.ts", "config/default.yaml", "test/retry.test.ts"]);
    await expect
      .poll(() => linesWith(page.locator('[data-file="src/runner.ts"]'), ".xpl-hl"))
      .toEqual([72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83]);
    await expect
      .poll(() => linesWith(page.locator('[data-file="config/default.yaml"]'), ".xpl-hl-config"))
      .toEqual([13, 14, 15, 16]);
    await expect(
      page.locator('[data-file="test/retry.test.ts"] .cm-line.xpl-hl-test').first(),
    ).toBeVisible();
    // The config file dims everything but the retry key.
    await expect(
      page.locator('[data-file="config/default.yaml"] .cm-line:not(.xpl-hl):not(.xpl-dim)'),
    ).toHaveCount(0);

    // Co-highlighting: what the concept relates to.
    await expect(byId(page, "concept:retry-policy")).toHaveClass(/is-selected/);
    await expect(byId(page, DISPATCH)).toHaveClass(/is-related/);
    await expect(byId(page, "file:src/queue.ts")).toHaveClass(/is-related/);
    await expect(byId(page, "file:src/worker.ts")).not.toHaveClass(/is-related/);
    expect((await stateOf(page)).related.sort()).toEqual(["file:src/queue.ts", DISPATCH].sort());

    // Tree: the three files are in the focus, the others are greyed.
    await expect(page.locator('[data-path="test/retry.test.ts"]')).not.toHaveClass(/is-dimmed/);
    await expect(page.locator('[data-path="src/bus.ts"]')).toHaveClass(/is-dimmed/);

    expect(problems).toEqual([]);
  });
});

test.describe("view:overview", () => {
  test("renders the group as a box, the stored edge, a stub or derived edge; clicking a ghost adds it to the view", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await openBundle(page);
    expect((await stateOf(page)).viewId).toBe("view:overview");

    // grp:scheduling is a box (not a container: its members are not in the view).
    const group = byId(page, "grp:scheduling");
    await expect(group).toBeVisible();
    await expect(group).toHaveClass(/kind-group/);
    await expect(group).not.toHaveClass(/is-container/);
    await expect(group.locator("rect.box")).toBeVisible();
    await expect(group).toContainText("Scheduling");

    // The stored edge from worker to metrics, with its label.
    const edge = byId(page, "edge:job-completed");
    await expect(edge).toBeVisible();
    await expect(edge).toContainText("job.completed");
    await expect(edge).toHaveClass(/res-llm/);
    const worker = await byId(page, "file:src/worker.ts").locator("> rect.box").boundingBox();
    const metrics = await byId(page, "file:src/metrics.ts").locator("> rect.box").boundingBox();
    const route = await edge.locator("path.line").boundingBox();
    expect(worker && metrics && route).toBeTruthy();
    // It leaves worker.ts on the right and ends at metrics.ts on the left (layout runs left to right).
    expect(route!.x).toBeGreaterThanOrEqual(worker!.x + worker!.width - 2);
    expect(route!.x + route!.width).toBeLessThanOrEqual(metrics!.x + 2);

    // At least one derived edge and at least one stub with its ghost box.
    await expect(page.locator('[data-element-id^="edge:calls:"]').first()).toBeVisible();
    await expect(page.locator("[data-stub-id]").first()).toBeVisible();
    const ghost = byId(page, "ghost:file:src/bus.ts");
    await expect(ghost).toBeVisible();
    await expect(ghost).toContainText("bus.ts");
    // Heuristic derived edges are drawn lighter than precise ones would be.
    await expect(
      page.locator('[data-element-id="edge:calls:grp:scheduling->file:src/worker.ts"]'),
    ).toHaveClass(/res-heuristic/);

    // Click the ghost: bus.ts joins the view, the ghost is gone.
    await expect(byId(page, "file:src/bus.ts")).toHaveCount(0);
    await ghost.click();
    await expect(byId(page, "file:src/bus.ts")).toBeVisible();
    await expect(byId(page, "ghost:file:src/bus.ts")).toHaveCount(0);
    const state = await stateOf(page);
    expect(state.include).toContain("file:src/bus.ts");
    expect(state.graph!.nodes).toContain("file:src/bus.ts");
    expect(state.dirty).toBe(true);
    // Its edges arrived with it (worker.ts and metrics.ts call EventBus).
    await expect(
      page.locator('[data-element-id="edge:calls:file:src/worker.ts->file:src/bus.ts"]'),
    ).toBeVisible();

    await page.screenshot({ path: screenshotPath("overview-after-expand") });
    expect(problems).toEqual([]);
  });
});
