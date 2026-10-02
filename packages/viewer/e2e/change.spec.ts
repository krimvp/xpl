/**
 * A change explainer (iteration 2, task B) against the TS fixture with a made-up change (scripts/ts-change.json,
 * built by global-setup.ts): runner.ts rewrites its retry delay (base 76-77 -> head 75-78), drops a log line
 * (base 66, after head 65) and adds a helper (head 106-110); bus.ts was renamed from events.ts; legacy.ts was
 * removed; metrics.ts is new; the test file changes. The concept "Retry policy" and the second tour step carry a
 * base anchor on the old delay.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  byId,
  CHANGE_BUNDLE,
  linesWith,
  openEditMenu,
  readEmbeddedBundle,
  stateOf,
  watchProblems,
  withBundle,
} from "./helpers.js";

async function open(page: Page, search = ""): Promise<void> {
  await page.goto(CHANGE_BUNDLE.href + search);
  await page.waitForFunction(() => window.__xpl !== undefined);
}

const pane = (page: Page, file: string, side: "head" | "base" = "head") =>
  page.locator(`.pane[data-file="${file}"][data-side="${side}"]`);

/** The `data-line` numbers of a pane's rendered lines that carry a class. */
const marked = (page: Page, file: string, cls: string, side: "head" | "base" = "head") =>
  linesWith(pane(page, file, side), `.${cls}`);

test.describe("the code of a change", () => {
  test("added and rewritten lines are marked, removed lines sit between them, read-only, with + and −", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await open(page, "?perspective=code");
    await page.evaluate(() => window.__xpl!.setCursor("src/runner.ts", 75));
    const runner = pane(page, "src/runner.ts");
    await expect(runner.locator(".cm-editor")).toBeVisible();
    await expect(runner.getByTestId("pane-change")).toHaveText("Changed");
    await expect.poll(() => marked(page, "src/runner.ts", "xpl-chg")).toEqual([75, 76, 77, 78]);
    // the two old lines, above head line 75, taken from the code before the change
    const removed = runner.locator('.xpl-removed[data-removed-from="76"]');
    await expect(removed).toHaveAttribute("data-removed-count", "2");
    await expect(removed.locator(".xpl-removed-line")).toHaveText([
      "        const backoff = this.config.retry.baseDelayMs * attempts;",
      "        await this.queue.requeue(job, backoff);",
    ]);
    const above = await removed.boundingBox();
    const line75 = await runner.locator('.cm-line[data-line="75"]').boundingBox();
    expect(above!.y + above!.height).toBeLessThanOrEqual(line75!.y + 1);
    // the gutter says it without colour
    await expect(runner.locator(".xpl-diff-gutter .xpl-diff-mark.is-changed").first()).toHaveText(
      "+",
    );
    await expect(runner.locator(".xpl-diff-gutter .xpl-diff-mark.is-removed").first()).toHaveText(
      "−",
    );
    // a removed line with no replacement goes below the line it followed (base 66, after head 65)
    await page.evaluate(() => window.__xpl!.setCursor("src/runner.ts", 64));
    const log = runner.locator('.xpl-removed[data-removed-from="66"]');
    await expect(log).toContainText("this.log(`finished ${job.id}`);");
    const line65 = await runner.locator('.cm-line[data-line="65"]').boundingBox();
    expect((await log.boundingBox())!.y).toBeGreaterThanOrEqual(line65!.y + line65!.height - 1);
    // the removed text cannot be edited, and clicking it moves no caret into the head code
    await expect(log).not.toHaveAttribute("contenteditable", "true");
    expect(problems).toEqual([]);
  });

  test("Show changes turns the marks and the removed lines off and on, for every changed file", async ({
    page,
  }) => {
    await open(page, "?perspective=code");
    await page.evaluate(() => window.__xpl!.setCursor("src/runner.ts", 75));
    const runner = pane(page, "src/runner.ts");
    const toggle = runner.getByTestId("show-changes");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(runner.locator(".xpl-removed")).not.toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(runner.locator(".xpl-removed")).toHaveCount(0);
    await expect.poll(() => marked(page, "src/runner.ts", "xpl-chg")).toEqual([]);
    await expect(runner.locator(".xpl-diff-gutter")).toHaveCount(0);
    await toggle.click();
    await expect.poll(() => marked(page, "src/runner.ts", "xpl-chg")).toEqual([75, 76, 77, 78]);
    // an unchanged file has no toggle; a new file is all added
    await page.evaluate(() => window.__xpl!.setCursor("src/queue.ts", 10));
    await expect(pane(page, "src/queue.ts").getByTestId("show-changes")).toHaveCount(0);
    await page.evaluate(() => window.__xpl!.setCursor("src/metrics.ts", 1));
    const metrics = pane(page, "src/metrics.ts");
    await expect(metrics.getByTestId("pane-change")).toHaveText("New file");
    await expect
      .poll(async () => (await marked(page, "src/metrics.ts", "xpl-add")).slice(0, 3))
      .toEqual([1, 2, 3]);
  });

  test("a renamed file names its old path; a removed file opens as it was, labelled", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await open(page);
    const files = page.getByTestId("change-files");
    await files.locator('[data-path="src/bus.ts"]').click();
    expect((await stateOf(page)).perspective).toBe("code");
    const bus = pane(page, "src/bus.ts");
    await expect(bus.getByTestId("pane-change")).toHaveText("Renamed from src/events.ts");
    await expect(bus.locator('.xpl-removed[data-removed-from="1"]')).toContainText(
      'Payload of the "job.completed" event',
    );

    await page.getByTestId("perspective-guide").click();
    await page.getByTestId("change-files").locator('[data-path="src/legacy.ts"]').click();
    const legacy = pane(page, "src/legacy.ts", "base");
    await expect(legacy.getByTestId("pane-before")).toHaveText("Before (base 1111111)");
    await expect(legacy.getByTestId("pane-change")).toHaveText("Removed");
    await expect(legacy.locator(".cm-content")).toContainText("export function linearDelay");
    await expect
      .poll(() => marked(page, "src/legacy.ts", "xpl-gone", "base"))
      .toEqual([1, 2, 3, 4]);
    // it is read-only: typing changes nothing
    await legacy.locator('.cm-line[data-line="3"]').click();
    await page.keyboard.type("xyz");
    await expect(legacy.locator('.cm-line[data-line="3"]')).toHaveText(
      "  return attempt * stepMs;",
    );
    expect(problems).toEqual([]);
  });
});

test.describe("base anchors", () => {
  test("an element with a base anchor shows the old lines next to the head code, labelled Before", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await open(page, "?perspective=code");
    await page.evaluate(() => window.__xpl!.select(["concept:retry-policy"]));
    const before = pane(page, "src/runner.ts", "base");
    await expect(before).toBeVisible();
    await expect(before.getByTestId("pane-before")).toHaveText("Before (base 1111111)");
    // the anchor's base lines are highlighted, and they are the lines the change rewrote
    await expect.poll(() => marked(page, "src/runner.ts", "xpl-hl", "base")).toEqual([76, 77]);
    await expect
      .poll(() => marked(page, "src/runner.ts", "xpl-gone", "base"))
      .toEqual([66, 76, 77]);
    await expect(before.locator('.cm-line[data-line="76"]')).toContainText(
      "const backoff = this.config.retry.baseDelayMs * attempts;",
    );
    // the head pane is next to it, with head lines only (the base anchor's 76-77 are not drawn on it)
    const head = pane(page, "src/runner.ts");
    await expect
      .poll(() => marked(page, "src/runner.ts", "xpl-hl"))
      .toEqual([72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83]);
    const headBox = (await head.boundingBox())!;
    expect((await before.boundingBox())!.y).toBeGreaterThanOrEqual(headBox.y + headBox.height - 1);
    // a click into the old code looks nothing up (its lines are not the current code's)
    const cursor = (await stateOf(page)).cursor;
    await before.locator('.cm-line[data-line="76"]').click();
    expect((await stateOf(page)).cursor).toEqual(cursor);
    expect(problems).toEqual([]);
  });

  test("Present: a step whose code names the old lines first shows them first, then the new ones", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    await open(page, "?mode=present&tour=tour:intro&step=2");
    await expect(page.getByTestId("tour-title")).toHaveText("The delay now doubles");
    const panes = page.locator(".present .pane");
    await expect(panes).toHaveCount(2);
    await expect(panes.nth(0)).toHaveAttribute("data-side", "base");
    await expect(panes.nth(1)).toHaveAttribute("data-side", "head");
    await expect(panes.nth(0).locator('.cm-line[data-line="76"]')).toBeInViewport();
    await expect(panes.nth(1).locator('.cm-line[data-line="75"]')).toBeInViewport();
    // the old lines just above the new ones are in sight too
    await expect(panes.nth(1).locator('.xpl-removed[data-removed-from="76"]')).toBeInViewport();
    expect(problems).toEqual([]);
  });

  test("the details list a base anchor as 'before' and open the old code there", async ({
    page,
  }) => {
    await open(page, "?perspective=map");
    await page.evaluate(() => window.__xpl!.select(["concept:retry-policy"]));
    await page.locator(".workspace-inspector > summary").click();
    const row = page.locator(".anchor-row", { has: page.locator(".anchor-before") });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("src/runner.ts@base");
    await row.click();
    const before = pane(page, "src/runner.ts", "base");
    await expect(before).toBeVisible();
    await expect(before.locator('.cm-line[data-line="76"]')).toBeInViewport();
  });
});

test.describe("the change in the reading screens", () => {
  test("the map marks the boxes the change touches with plain words", async ({ page }) => {
    const problems = watchProblems(page);
    await open(page, "?perspective=map");
    const metrics = byId(page, "file:src/metrics.ts");
    await expect(metrics.locator(".change-pill text")).toHaveText("New");
    // the pill sits inside its box, clear of the label
    const box = (await metrics.locator(".box").boundingBox())!;
    const pill = (await metrics.locator(".change-pill").boundingBox())!;
    const label = (await metrics.locator(".label").boundingBox())!;
    expect(pill.x + pill.width).toBeLessThanOrEqual(box.x + box.width);
    expect(pill.y).toBeGreaterThanOrEqual(label.y + label.height - 2);
    // unchanged boxes have none; a group holding changed files is not marked itself
    await expect(byId(page, "file:src/worker.ts").locator(".change-pill")).toHaveCount(0);
    await expect(byId(page, "grp:scheduling").locator(":scope > .change-pill")).toHaveCount(0);
    // inside the group: runner.ts changed
    await byId(page, "grp:scheduling").dblclick();
    await expect(byId(page, "file:src/runner.ts").locator(".change-pill text")).toHaveText(
      "Changed",
    );
    await expect(byId(page, "file:src/queue.ts").locator(".change-pill")).toHaveCount(0);
    expect(problems).toEqual([]);
  });

  test("the guide lists the files of the change under the summary, and each opens in the Code tab", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    await open(page);
    const list = page.getByTestId("change-files");
    // on the first screen, right under the summary
    await expect(list).toBeInViewport();
    const summary = (await page.getByTestId("tour-summary").boundingBox())!;
    expect((await list.boundingBox())!.y).toBeGreaterThan(summary.y);
    await expect(list.locator("h3")).toContainText("5 files, +53 −9");
    const rows = list.getByTestId("change-file");
    await expect(rows).toHaveCount(5);
    // source files first, then the tests (marked)
    await expect(rows.last()).toHaveAttribute("data-path", "test/retry.test.ts");
    await expect(rows.last().locator(".change-test")).toHaveText("test");
    await expect(list.locator('[data-path="src/runner.ts"]')).toContainText("Changed");
    await expect(list.locator('[data-path="src/runner.ts"]')).toContainText("+9 −3");
    await expect(list.locator('[data-path="src/metrics.ts"]')).toContainText("New");
    await expect(list.locator('[data-path="src/legacy.ts"]')).toContainText("Removed");
    await expect(list.locator('[data-path="src/bus.ts"]')).toContainText("from src/events.ts");
    // a file opens in the Code tab at its first change
    await list.locator('[data-path="src/runner.ts"]').click();
    const state = await stateOf(page);
    expect(state.perspective).toBe("code");
    expect(state.openedFile).toBe("src/runner.ts");
    expect(state.cursor).toEqual({ file: "src/runner.ts", fromLine: 65, toLine: 65 });
    await expect(pane(page, "src/runner.ts").locator('.cm-line[data-line="65"]')).toBeInViewport();
    expect(problems).toEqual([]);
  });

  test("an explainer without a change shows none of it", async ({ page }) => {
    await page.goto(new URL("../dist/bundles/ts-jobrunner.html", import.meta.url).href);
    await page.waitForFunction(() => window.__xpl !== undefined);
    await expect(page.getByTestId("guide")).toBeVisible();
    await expect(page.getByTestId("change-files")).toHaveCount(0);
    await page.getByTestId("perspective-map").click();
    await expect(page.locator(".change-pill")).toHaveCount(0);
    await page.evaluate(() => window.__xpl!.setCursor("src/runner.ts", 75));
    await expect(page.getByTestId("show-changes")).toHaveCount(0);
    await expect(page.locator(".xpl-diff-gutter")).toHaveCount(0);
  });
});

test.describe("under xpl view", () => {
  test("the code before the change is fetched from GET /api/base-file when the page does not carry it", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    const { html, bundle } = readEmbeddedBundle(CHANGE_BUNDLE);
    const base = bundle.baseFiles as Record<string, string>;
    delete bundle.baseFiles;
    bundle.server = { api: "/api" };
    const asked: string[] = [];
    await page.route("http://xpl.test/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/")
        return route.fulfill({ contentType: "text/html", body: withBundle(html, bundle) });
      if (url.pathname === "/api/base-file") {
        const path = url.searchParams.get("path")!;
        asked.push(path);
        if (!(path in base))
          return route.fulfill({ status: 404, body: `${path} has no code before the change` });
        return route.fulfill({ contentType: "text/plain", body: base[path] });
      }
      return route.fulfill({ status: 404, body: "not found" });
    });
    await page.goto("http://xpl.test/?perspective=code");
    await page.waitForFunction(() => window.__xpl !== undefined);
    expect(asked).toEqual([]);
    // a changed file's removed lines need the base: fetched once
    await page.evaluate(() => window.__xpl!.setCursor("src/runner.ts", 75));
    await expect(
      pane(page, "src/runner.ts")
        .locator('.xpl-removed[data-removed-from="76"] .xpl-removed-line')
        .first(),
    ).toContainText("baseDelayMs * attempts");
    expect(asked).toEqual(["src/runner.ts"]);
    // a base anchor's pane uses what was fetched
    await page.evaluate(() => window.__xpl!.select(["concept:retry-policy"]));
    await expect(
      pane(page, "src/runner.ts", "base").locator('.cm-line[data-line="76"]'),
    ).toBeVisible();
    // runner.ts is not fetched again; the concept's test file is changed too, so its old lines are fetched
    expect([...asked].sort()).toEqual(["src/runner.ts", "test/retry.test.ts"]);
    // Save as HTML is offered under xpl view too
    await expect((await openEditMenu(page)).getByTestId("edit-save-html")).toBeVisible();
    expect(problems).toEqual([]);
  });

  test("a static page without the code before the change says so instead of the removed lines", async ({
    page,
  }) => {
    const { html, bundle } = readEmbeddedBundle(CHANGE_BUNDLE);
    delete bundle.baseFiles;
    await page.route("http://xpl.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: withBundle(html, bundle) }),
    );
    await page.goto("http://xpl.test/?perspective=code");
    await page.waitForFunction(() => window.__xpl !== undefined);
    await page.evaluate(() => window.__xpl!.setCursor("src/runner.ts", 75));
    await expect(
      pane(page, "src/runner.ts").locator('.xpl-removed[data-removed-from="76"]'),
    ).toContainText("2 lines removed (the code before the change is not included in this page)");
  });
});
