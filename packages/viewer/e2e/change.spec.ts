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
    // a changed file's "Show changes" toggle says it: no "Changed" pill next to it
    await expect(runner.getByTestId("show-changes")).toBeVisible();
    await expect(runner.getByTestId("pane-change")).toHaveCount(0);
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
    // in Read mode it starts folded to its header (the head pane shows the removed lines inline); a click opens it
    await expect(before).toHaveClass(/is-folded/);
    await before.getByTestId("pane-fold").click();
    await expect(before).not.toHaveClass(/is-folded/);
    // its header says "Before" once (no "used here" role), and counts the places with removed lines
    await expect(before.locator(".pane-roles .role")).toHaveCount(0);
    await expect(before.getByTestId("pane-hunks")).toContainText("removed in 2 places");
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
    // a reader's narrow column names the file, the tooltip the whole path
    await expect(row).toContainText("runner.ts, lines 76–77");
    await expect(row).toHaveAttribute("title", /src\/runner\.ts/);
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
    // unchanged boxes have none; a group holding changed files is marked "Changed", so the map shows where
    // the change is before any box is opened
    await expect(byId(page, "file:src/worker.ts").locator(".change-pill")).toHaveCount(0);
    await expect(byId(page, "grp:scheduling").locator(":scope > .change-pill text")).toHaveText(
      "Changed",
    );
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
    // one width for every status pill, so the paths start in one column
    const widths = await list
      .locator(".change-status")
      .evaluateAll((pills) => pills.map((pill) => Math.round(pill.getBoundingClientRect().width)));
    expect(new Set(widths).size).toBe(1);
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
    // (in Read mode the Before pane starts folded: the head pane shows the removed lines inline)
    await pane(page, "src/runner.ts", "base").getByTestId("pane-fold").click();
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

test.describe("reading a changed file", () => {
  test("a file opened from the change list takes the column, shows its first change whole, and steps through the rest", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    await open(page);
    await page.locator('[data-testid="change-file"][data-path="src/runner.ts"]').click();
    const runner = pane(page, "src/runner.ts");
    await expect(runner).toHaveClass(/is-expanded/);
    // the other panes fold to their names
    await expect(page.locator(".pane.is-folded").first()).toBeVisible();
    await expect(page.locator(".pane.is-folded .pane-body").first()).toBeHidden();
    // the first change (a line removed after 65) is in view, not at the edge
    await expect(runner.locator('.xpl-removed[data-at="after:65"]')).toBeInViewport();
    const hunks = runner.getByTestId("pane-hunks");
    await expect(hunks).toContainText("change 1 / 3");
    // n steps to the next change; its added lines are in view
    await runner.locator('.cm-line[data-line="65"]').click();
    await page.keyboard.press("n");
    await expect(hunks).toContainText("change 2 / 3");
    for (const line of [75, 76, 77, 78]) {
      await expect(runner.locator(`.cm-line[data-line="${line}"]`)).toBeInViewport();
    }
    await runner.getByRole("button", { name: "Next change" }).click();
    await expect(hunks).toContainText("change 3 / 3");
    await expect(runner.locator('.cm-line[data-line="110"]')).toBeInViewport();
    await expect(runner.getByRole("button", { name: "Next change" })).toBeDisabled();
    // the expand button gives the other files back
    await runner.getByTestId("pane-expand").click();
    await expect(page.locator(".pane.is-folded")).toHaveCount(0);
    expect(problems).toEqual([]);
  });

  test("a narrow pane keeps the file name whole and puts the change controls on a second row", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 700 });
    await open(page, "?perspective=map");
    await page.getByRole("button", { name: "Show source" }).click();
    await page.evaluate(() => window.__xpl!.setCursor("src/runner.ts", 75));
    const runner = pane(page, "src/runner.ts");
    const header = runner.locator(".pane-header");
    await expect(runner.getByTestId("show-changes")).toBeVisible();
    expect((await header.boundingBox())!.width).toBeLessThan(600);
    const name = (await runner.locator(".pane-file b").boundingBox())!;
    const file = (await runner.locator(".pane-file").boundingBox())!;
    expect(file.width).toBeGreaterThanOrEqual(name.width - 1);
    const toggle = (await runner.getByTestId("show-changes").boundingBox())!;
    expect(toggle.y).toBeGreaterThan(name.y + name.height - 1);
    expect(await header.evaluate((h) => h.scrollWidth <= h.clientWidth + 1)).toBe(true);
  });

  test("the tree marks what the change did to each file, lists removed files and filters by path", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await open(page, "?perspective=code");
    const mark = (path: string) =>
      page.locator(`.tree-row[data-path="${path}"] [data-testid="tree-change-mark"]`);
    await expect(mark("src/runner.ts")).toHaveText("M");
    await expect(mark("src/metrics.ts")).toHaveText("A");
    await expect(mark("src/bus.ts")).toHaveText("R");
    await expect(mark("src/legacy.ts")).toHaveText("D");
    await expect(mark("src/worker.ts")).toHaveCount(0);
    await page.getByTestId("tree-filter").fill("leg");
    await expect(page.locator(".tree-row.is-file")).toHaveCount(1);
    // a result: the name, and its folder under it
    await expect(page.locator(".tree-row.is-file .name")).toHaveText("legacy.ts");
    await expect(page.locator(".tree-row.is-file .tree-dir")).toHaveText("src");
    await page.locator('.tree-row[data-path="src/legacy.ts"]').click();
    await expect(pane(page, "src/legacy.ts", "base")).toBeVisible();
    expect(problems).toEqual([]);
  });
});

test.describe("reading the diagrams", () => {
  test("the map's Key explains its marks, the change pills among them, and closes with Escape", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await open(page, "?perspective=map");
    await page.getByTestId("legend-button").click();
    const legend = page.getByTestId("legend");
    await expect(legend).toBeVisible();
    await expect(legend).toContainText("The one you picked");
    await expect(legend).toContainText("What the change did");
    await page.keyboard.press("Escape");
    await expect(legend).toHaveCount(0);
    // a picked box keeps its solid outline, even when the map also marks it related
    await byId(page, "grp:scheduling").click();
    const dash = await byId(page, "grp:scheduling")
      .locator(":scope > .box")
      .evaluate((el) => getComputedStyle(el).strokeDasharray);
    expect(dash).toBe("none");
    expect(problems).toEqual([]);
  });

  test("Present keeps one caption height for the whole tour, so the diagram does not jump", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    await open(page, "?mode=present");
    const caption = page.getByTestId("tour-caption");
    const counter = page.getByTestId("tour-counter");
    const total = Number((await counter.innerText()).split("/")[1]);
    const heights = new Set<number>();
    for (let step = 1; step <= total; step++) {
      await expect(counter).toHaveText(`${step} / ${total}`);
      heights.add(Math.round((await caption.boundingBox())!.height));
      await page.keyboard.press("ArrowRight");
    }
    expect(heights.size).toBe(1);
    expect(problems).toEqual([]);
  });
});

test.describe("reading, presenting and leaving", () => {
  test("the browser's Back button leaves a talk started on the page, and the slide's code stays shown", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await open(page);
    await page.getByTestId("mode-present").click();
    await expect(page.getByTestId("present")).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId("present")).toHaveCount(0);
    await expect(page.locator(".workspace")).toBeVisible();
    // back in the reading screens, the code of the slide is still there
    await expect(page.locator(".workspace-source .pane").first()).toBeVisible();
    expect((await stateOf(page)).mode).toBe("explore");
    expect(problems).toEqual([]);
  });

  test("Esc leaves a talk like Back does: afterwards the address and the screen agree; focus returns to Present", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await open(page);
    await page.getByTestId("mode-present").click();
    await expect(page.getByTestId("present")).toBeFocused();
    // the code's scrolling areas can be reached with the keyboard, and say what they show
    const scroller = page.locator(".present .cm-scroller").first();
    await expect(scroller).toHaveAttribute("tabindex", "0");
    await expect(scroller).toHaveAttribute("aria-label", /source code/);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("present")).toHaveCount(0);
    await expect(page.getByTestId("mode-present")).toBeFocused();
    const state = await stateOf(page);
    // the address names the step on screen (Esc went back over the talk's own entry)
    await expect.poll(() => new URL(page.url()).searchParams.get("step")).toBe(String(state.step));
    expect(new URL(page.url()).searchParams.get("view")).toBe(state.viewId);
    expect(problems).toEqual([]);
  });

  test("the guide's contents and the breadcrumb follow the section being read", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    await open(page);
    const contents = page.locator(".guide-contents button");
    await expect(contents.first()).toHaveAttribute("aria-current", "step");
    const last = page.locator(".guide-section").last();
    await last.scrollIntoViewIfNeeded();
    await page
      .locator(".workspace-columns, .guide-body")
      .evaluateAll((els) => els.forEach((el) => el.scrollTo({ top: el.scrollHeight })));
    await expect(contents.last()).toHaveAttribute("aria-current", "step");
    const title = (await contents.last().innerText()).replace(/^\d+\s*/, "").trim();
    await expect(page.getByTestId("breadcrumb-topic")).toHaveText(title);
    expect(problems).toEqual([]);
  });

  test("a map edge's accessible name says which two boxes it joins", async ({ page }) => {
    await open(page, "?perspective=map");
    const edge = page.locator('.edge-keys [role="button"]').first();
    await expect(edge).toHaveAttribute("aria-label", /^.+ to .+: /);
    // Tab reaches the boxes before the edges
    const order = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".graph [tabindex='0']")].map((el) =>
        el.closest(".edge-keys") ? "edge" : "box",
      ),
    );
    expect(order.indexOf("edge")).toBeGreaterThan(order.lastIndexOf("box"));
    // Enter on a focused edge picks it
    await edge.focus();
    await page.keyboard.press("Enter");
    expect((await stateOf(page)).selection).toEqual([await edge.getAttribute("data-key-for")]);
  });
});

test.describe("who calls this, and what the change did to it", () => {
  test("a picked file says what the change did to it and who calls it; each row opens the code", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await open(page, "?perspective=map");
    await byId(page, "file:src/metrics.ts").click();
    // under the topic summary, not folded away in "Where this is in the code"
    const facts = page.getByTestId("topic-summary").getByTestId("topic-facts");
    await expect(facts.getByTestId("element-change")).toContainText("Added by this change");
    await expect(facts.getByTestId("element-change")).toContainText("+36 −0");
    await page.locator(".workspace-inspector > summary").click();
    await expect(page.getByTestId("element-change")).toHaveCount(1);
    const callers = facts.getByTestId("callers");
    await expect(callers).toContainText("Called from");
    await expect(callers).toContainText("main");
    await callers.getByRole("button").first().click();
    await expect(pane(page, "src/main.ts")).toBeVisible();
    expect(problems).toEqual([]);
  });

  test("an edited symbol says how many lines the change added and removed in it", async ({
    page,
  }) => {
    await open(page, "?perspective=map");
    await page.evaluate(() => window.__xpl!.select(["sym:src/runner.ts#Runner.dispatch"]));
    const change = page.getByTestId("topic-summary").getByTestId("element-change");
    await expect(change).toContainText("Edited by this change");
    await expect(change).toContainText("+4 −3");
  });

  test("a name in the code offers who calls it and its definition", async ({ page }) => {
    const problems = watchProblems(page);
    await open(page, "?perspective=code");
    await page.evaluate(() => window.__xpl!.setCursor("src/runner.ts", 32));
    const runner = pane(page, "src/runner.ts");
    const line = runner.locator('.cm-line[data-line="32"]');
    await expect(line).toBeVisible();
    // the "dispatch" of `this.dispatch()`
    const wordAt = () =>
      line.evaluate((element) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const i = node.textContent!.indexOf("dispatch");
          if (i < 0) continue;
          const range = document.createRange();
          range.setStart(node, i + 2);
          range.setEnd(node, i + 3);
          const box = range.getBoundingClientRect();
          return { x: box.x + 1, y: box.y + box.height / 2 };
        }
        return undefined;
      });
    const at = await wordAt();
    await page.mouse.move(at!.x, at!.y);
    const actions = page.getByTestId("symbol-actions");
    await expect(actions).toContainText("Runner.dispatch");
    await actions.getByRole("button", { name: "Who calls it" }).click();
    expect((await stateOf(page)).selection).toEqual(["sym:src/runner.ts#Runner.dispatch"]);
    await expect(page.getByTestId("topic-summary").getByTestId("callers")).toContainText(
      "Runner.start",
    );
    // Ctrl+click on the name: its definition
    await page.getByRole("button", { name: "Back" }).click();
    await line.scrollIntoViewIfNeeded();
    const again = await wordAt();
    await page.keyboard.down("Control");
    await page.mouse.click(again!.x, again!.y);
    await page.keyboard.up("Control");
    await expect.poll(async () => (await stateOf(page)).cursor?.fromLine).toBe(42);
    expect(problems).toEqual([]);
  });

  test("beside the code on a 1440 screen, Who calls it opens the topic panel over the code; a caller row centres its line", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, "?perspective=map");
    await page.getByRole("button", { name: "Show source" }).click();
    await page.evaluate(() => window.__xpl!.setCursor("src/runner.ts", 32));
    const line = pane(page, "src/runner.ts").locator('.cm-line[data-line="32"]');
    await expect(line).toBeVisible();
    // the topic column is folded away beside the code at this width
    await expect(page.locator(".workspace-context")).toBeHidden();
    const wordAt = () =>
      line.evaluate((element) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const i = node.textContent!.indexOf("dispatch");
          if (i < 0) continue;
          const range = document.createRange();
          range.setStart(node, i + 2);
          range.setEnd(node, i + 3);
          const box = range.getBoundingClientRect();
          return { x: box.x + 1, y: box.y + box.height / 2 };
        }
        return undefined;
      });
    const at = await wordAt();
    await page.mouse.click(at!.x, at!.y);
    await page.keyboard.press("Shift+F12");
    const panel = page.locator(".workspace.is-context-open .workspace-context");
    await expect(panel).toBeVisible();
    const callers = panel.getByTestId("callers");
    await expect(callers).toContainText("Runner.start");
    await expect(callers.getByRole("button").first()).toBeFocused();
    // Esc closes it; Shift+F12 again, then a caller row: the code comes back, its line in the middle
    await page.keyboard.press("Escape");
    await expect(page.locator(".workspace.is-context-open")).toHaveCount(0);
    await line.scrollIntoViewIfNeeded();
    const again = await wordAt();
    await page.mouse.click(again!.x, again!.y);
    await page.keyboard.press("Shift+F12");
    await panel.getByTestId("callers").getByRole("button").first().click();
    await expect(page.locator(".workspace.is-context-open")).toHaveCount(0);
    const target = (await stateOf(page)).cursor!;
    expect(target.file).toBe("src/runner.ts");
    const scroller = pane(page, "src/runner.ts").locator(".cm-scroller");
    await expect
      .poll(async () => {
        const box = (await scroller.boundingBox())!;
        const row = await pane(page, "src/runner.ts")
          .locator(`.cm-line[data-line="${target.fromLine}"]`)
          .boundingBox();
        return !!row && row.y > box.y && row.y + row.height < box.y + box.height;
      })
      .toBe(true);
    expect(problems).toEqual([]);
  });

  test("a change's guide step lists the code outside it that calls what changed", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await open(page);
    const callers = page.getByTestId("guide-callers").first();
    await expect(callers).toContainText("Code that calls what changed");
    await expect(callers.getByRole("button").first()).toContainText("src/");
    expect(problems).toEqual([]);
  });

  test("a double-click on a guide picture opens the live diagram", async ({ page }) => {
    await open(page);
    const picture = page.getByTestId("guide-snapshot").first();
    const map = (await picture.getAttribute("data-view-id"))!;
    await picture.dblclick();
    const state = await stateOf(page);
    expect(["map", "flow"]).toContain(state.perspective);
    expect(state.viewId).toBe(map);
  });
});
