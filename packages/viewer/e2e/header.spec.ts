/**
 * The header of an explainer with many views (the repo's own explainer has 16): still one row, whatever
 * the number of tabs. The tab strip takes the room the controls leave and scrolls sideways; a "Views" menu
 * lists every view by its full title and jumps to it; Tours, Explore / Present and the download stay on the
 * screen, at every desktop width and on a phone.
 *
 * The page is the fixture explainer with 14 more views (16 in all), with titles as long as real ones.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  byId,
  fitAll,
  readEmbeddedBundle,
  screenshotPath,
  stateOf,
  TS_BUNDLE,
  watchProblems,
  withBundle,
} from "./helpers.js";

/** The embedded bundle is edited as loose JSON: many shapes, none worth typing here. */
type Loose = Record<string, any>;

const EXTRA_TITLES = [
  "xpl architecture: the four packages and the skill",
  "From a repository to a viewer: index, new, apply, bundle, load",
  "xpl index (1/3): from files to symbols",
  "xpl index (2/3): references, commit id and the written index",
  "xpl index (3/3): inside a SCIP resolver",
  "The indexer: the files behind `xpl index`",
  "How xpl apply merges, anchors, validates and writes a patch",
  "Code behind xpl apply",
  "From the page's data to the store",
  "How a diagram is drawn: derive, lay out, render",
  "Diagram to code: a click highlights lines",
  "Code to diagram: the caret lights up elements",
  "How xpl resolve re-finds and classifies every anchor",
  "After resolve: the to-do list and a re-explain that leaves the user's edits alone",
];
const QUESTION = "What does this view answer?";

/** Adds views to the fixture: graphs and sequences in turn, the sequences with a question. Returns the ids of all of them. */
function withManyViews(bundle: Loose): string[] {
  const views: Loose[] = bundle.explainer.views;
  EXTRA_TITLES.forEach((title, i) => {
    const id = `view:many-${i + 1}`;
    if (i % 2 === 0) {
      views.push({
        id,
        type: "graph",
        title,
        scope: { root: "repo", depth: 1 },
        include: ["file:src/queue.ts", "file:src/runner.ts"],
        stubs: { mode: "none" },
        provenance: { origin: "llm" },
      });
    } else {
      views.push({
        id,
        type: "sequence",
        title,
        scope: { root: "repo", depth: 1, question: QUESTION },
        participants: ["file:src/runner.ts", "file:src/queue.ts"],
        steps: [
          {
            id: `${id}:1`,
            from: "file:src/runner.ts",
            to: "file:src/queue.ts",
            label: "pop()",
            kind: "call",
            anchors: [],
          },
        ],
        provenance: { origin: "llm" },
      });
    }
  });
  // A tour that plays the last view, to arrive there through Present.
  bundle.explainer.tours.push({
    id: "tour:last",
    title: "The last view",
    steps: [{ id: "l1", view: views.at(-1)!.id, focus: [], note: "The last view." }],
  });
  return views.map((v) => v.id as string);
}

/** Opens the page (`?view=` optionally) at the given window size; resolves to the ids and titles of the views. */
async function openMany(
  page: Page,
  size: { width: number; height: number },
  query = "?mode=explore",
): Promise<{ ids: string[]; titles: string[] }> {
  const { html, bundle } = readEmbeddedBundle();
  const ids = withManyViews(bundle);
  const titles = (bundle.explainer as Loose).views.map((v: Loose) => v.title as string);
  await page.setViewportSize(size);
  await page.route("http://xpl.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: withBundle(html, bundle) }),
  );
  await page.goto(`http://xpl.test/${query}`);
  await page.waitForFunction(() => window.__xpl !== undefined);
  return { ids, titles };
}

const strip = (page: Page) => page.locator(".view-tabs");
const tab = (page: Page, id: string) => page.locator(`.tab[data-view-id="${id}"]`);
const viewsButton = (page: Page) => page.getByTestId("views-button");
const viewsMenu = (page: Page) => page.getByTestId("views-menu");
const menuItem = (page: Page, id: string) => page.locator(`.views-item[data-view-id="${id}"]`);

/** The controls of the header, all of them. */
const controls = (page: Page): Record<string, Locator> => ({
  views: viewsButton(page),
  tours: page.getByTestId("tours-button"),
  explore: page.getByTestId("mode-explore"),
  present: page.getByTestId("mode-present"),
  download: page.getByRole("button", { name: "Download explainer JSON" }),
});

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box, "the element is laid out").not.toBeNull();
  return box!;
}

/** Whether the start of the tab (its icon and the first letters) is in sight: on a phone a tab can be wider than the strip. */
function tabStartInSight(page: Page, id: string): Promise<boolean> {
  return page.evaluate((viewId) => {
    const frame = document.querySelector(".view-tabs")!.getBoundingClientRect();
    const at = document
      .querySelector<HTMLElement>(`.tab[data-view-id="${viewId}"]`)!
      .getBoundingClientRect();
    return at.left >= frame.left - 0.5 && at.left <= frame.right - 60;
  }, id);
}

/** Whether the tab is in sight in the strip: inside it, and not under an arrow (whatever is on top of its middle is the tab). */
function tabInSight(page: Page, id: string): Promise<boolean> {
  return page.evaluate((viewId) => {
    const frame = document.querySelector(".view-tabs")!.getBoundingClientRect();
    const el = document.querySelector<HTMLElement>(`.tab[data-view-id="${viewId}"]`)!;
    const at = el.getBoundingClientRect();
    if (at.left < frame.left - 0.5 || at.right > frame.right + 0.5) return false;
    return [0.15, 0.5, 0.85].every((f) => {
      const hit = document.elementFromPoint(at.left + at.width * f, at.top + at.height / 2);
      return hit !== null && el.contains(hit);
    });
  }, id);
}

const scrollLeftOf = (page: Page) => strip(page).evaluate((el) => el.scrollLeft);
const maxScrollOf = (page: Page) => strip(page).evaluate((el) => el.scrollWidth - el.clientWidth);

/** Everything on the header row is inside the window, and it is one row. */
async function expectOneRowOnScreen(page: Page, size: { width: number; height: number }) {
  const header = await boxOf(page.locator(".header"));
  expect(Math.round(header.width), "the header is as wide as the window").toBe(size.width);
  expect(header.height, "one row").toBeLessThan(60);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
    "the page is not wider than the window",
  ).toBeLessThanOrEqual(size.width);
  for (const [name, control] of Object.entries(controls(page))) {
    await expect(control, name).toBeVisible();
    const box = await boxOf(control);
    expect(box.x, `${name} starts inside the window`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `${name} ends inside the window`).toBeLessThanOrEqual(size.width);
    expect(box.y, `${name} is on the row`).toBeGreaterThanOrEqual(header.y);
    expect(box.y + box.height, `${name} is on the row`).toBeLessThanOrEqual(
      header.y + header.height,
    );
  }
  // The strip is between the title and the controls, and does not run into the Views button.
  const tabs = await boxOf(strip(page));
  const views = await boxOf(viewsButton(page));
  expect(tabs.x + tabs.width).toBeLessThanOrEqual(views.x);
  expect(views.x + views.width).toBeLessThanOrEqual((await boxOf(controls(page).tours!)).x);
}

for (const size of [
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
]) {
  test.describe(`${size.width}px wide, 16 views`, () => {
    test("one row: every control is on the screen and takes the room it needs", async ({
      page,
    }) => {
      const problems = watchProblems(page);
      await openMany(page, size);
      await expect(page.locator(".tab")).toHaveCount(16);
      await expectOneRowOnScreen(page, size);
      // The strip has taken the free room: the tabs do not fit, so it scrolls.
      expect(await maxScrollOf(page)).toBeGreaterThan(500);
      await expect(viewsButton(page)).toHaveAccessibleName("Views (16)");
      await page.screenshot({
        path: screenshotPath(`header-16-views-${size.width}`),
        clip: { x: 0, y: 0, width: size.width, height: 120 },
      });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.screenshot({
        path: screenshotPath(`header-16-views-${size.width}-dark`),
        clip: { x: 0, y: 0, width: size.width, height: 120 },
      });
      expect(problems).toEqual([]);
    });

    test("the save status (the widest the controls get) does not push a control off the row", async ({
      page,
    }) => {
      const problems = watchProblems(page);
      await openMany(page, size);
      // An edit: "Unsaved" appears and the download becomes the primary button.
      await byId(page, "ghost:file:src/bus.ts").click();
      await expect(page.locator(".save-status")).toHaveText("Unsaved");
      await expectOneRowOnScreen(page, size);
      await expect(page.locator(".view-tabs-frame")).toBeVisible();
      expect((await boxOf(page.getByTestId("view-tabs-frame"))).width).toBeGreaterThan(300);
      expect(problems).toEqual([]);
    });

    test("the Views menu lists every view by its full title and jumps to each of them", async ({
      page,
    }) => {
      const problems = watchProblems(page);
      const { ids, titles } = await openMany(page, size);
      expect(ids).toHaveLength(16);

      await viewsButton(page).click();
      await expect(viewsMenu(page)).toBeVisible();
      await expect(viewsButton(page)).toHaveAttribute("aria-expanded", "true");
      await expect(page.locator(".views-item")).toHaveCount(16);
      // Full titles, not the start of them: the menu wraps rather than cuts.
      await expect(page.locator(".views-item")).toHaveText(titles);
      // The type icon of each view, and the checked one is the current one.
      await expect(page.locator(".views-item .tab-icon.is-graph")).toHaveCount(8);
      await expect(page.locator(".views-item .tab-icon.is-sequence")).toHaveCount(8);
      await expect(page.locator('.views-item[aria-checked="true"]')).toHaveCount(1);
      await expect(menuItem(page, ids[0]!)).toHaveAttribute("aria-checked", "true");
      // Inside the window, under the button.
      const menu = await boxOf(viewsMenu(page));
      expect(menu.x).toBeGreaterThanOrEqual(0);
      expect(menu.x + menu.width).toBeLessThanOrEqual(size.width);
      expect(menu.y).toBeGreaterThan((await boxOf(viewsButton(page))).y);
      await page.screenshot({
        path: screenshotPath(`header-views-menu-${size.width}`),
        clip: { x: 0, y: 0, width: size.width, height: 620 },
      });
      await page.keyboard.press("Escape");
      await expect(viewsMenu(page)).toHaveCount(0);

      // Every view, from the menu: the view opens, its tab is the selected one and in sight.
      for (const id of [...ids].reverse().concat(ids)) {
        await viewsButton(page).click();
        await menuItem(page, id).click();
        await expect(viewsMenu(page)).toHaveCount(0);
        await expect(page.locator(`.diagram[data-view-id="${id}"]`)).toBeVisible();
        await expect(tab(page, id)).toHaveAttribute("aria-selected", "true");
        await expect.poll(() => tabInSight(page, id), { message: `tab of ${id}` }).toBe(true);
        expect((await stateOf(page)).viewId).toBe(id);
      }
      await expectOneRowOnScreen(page, size);
      expect(problems).toEqual([]);
    });

    test("the strip scrolls: wheel, arrows and edge cues; every tab can be reached and clicked", async ({
      page,
    }) => {
      const problems = watchProblems(page);
      const { ids } = await openMany(page, size);
      const frame = page.getByTestId("view-tabs-frame");
      const start = page.getByTestId("strip-arrow-start");
      const end = page.getByTestId("strip-arrow-end");
      const first = tab(page, ids[0]!);
      const last = tab(page, ids.at(-1)!);

      // At the start: more to the right only.
      expect(await scrollLeftOf(page)).toBe(0);
      await expect(frame).toHaveAttribute("data-more-start", "false");
      await expect(frame).toHaveAttribute("data-more-end", "true");
      await expect(start).toHaveCSS("opacity", "0");
      await expect(end).toHaveCSS("opacity", "1");
      expect(await tabInSight(page, ids[0]!)).toBe(true);
      expect(await tabInSight(page, ids.at(-1)!)).toBe(false);

      // The mouse wheel, which turns up and down, moves the strip sideways.
      const at = await boxOf(strip(page));
      await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
      await page.mouse.wheel(0, 300);
      await expect.poll(() => scrollLeftOf(page)).toBeGreaterThan(100);
      await expect(frame).toHaveAttribute("data-more-start", "true");
      await expect(start).toHaveCSS("opacity", "1");
      await page.mouse.wheel(0, -100000);
      await expect.poll(() => scrollLeftOf(page)).toBe(0);
      await expect(frame).toHaveAttribute("data-more-start", "false");

      // All the way to the end: the last tab is in sight, the cues have moved to the other side.
      for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 500);
      await expect.poll(async () => (await maxScrollOf(page)) - (await scrollLeftOf(page))).toBe(0);
      await expect(frame).toHaveAttribute("data-more-start", "true");
      await expect(frame).toHaveAttribute("data-more-end", "false");
      await expect(end).toHaveCSS("opacity", "0");
      await expect.poll(() => tabInSight(page, ids.at(-1)!)).toBe(true);
      // A real click on it, where it is on the screen: it is not covered by anything.
      const lastBox = await boxOf(last);
      await page.mouse.click(lastBox.x + lastBox.width / 2, lastBox.y + lastBox.height / 2);
      await expect(page.locator(`.diagram[data-view-id="${ids.at(-1)}"]`)).toBeVisible();
      await expect(last).toHaveAttribute("aria-selected", "true");
      await page.screenshot({
        path: screenshotPath(`header-16-views-${size.width}-scrolled`),
        clip: { x: 0, y: 0, width: size.width, height: 120 },
      });

      // The arrow of the start takes the strip back, a page at a time, to the first tab.
      for (let pages = 0; (await scrollLeftOf(page)) > 0; pages++) {
        expect(pages, "the strip gets to its start").toBeLessThan(20);
        const from = await scrollLeftOf(page);
        await start.click();
        await expect.poll(() => scrollLeftOf(page)).toBeLessThan(from);
        if (pages === 0) expect(from - (await scrollLeftOf(page))).toBeGreaterThan(0);
        // Let the scroll settle before the next page.
        await expect
          .poll(async () => {
            const a = await scrollLeftOf(page);
            await page.waitForTimeout(60);
            return a === (await scrollLeftOf(page));
          })
          .toBe(true);
      }
      await expect(start).toHaveCSS("opacity", "0");
      await expect.poll(() => tabInSight(page, ids[0]!)).toBe(true);
      const firstBox = await boxOf(first);
      await page.mouse.click(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);
      await expect(first).toHaveAttribute("aria-selected", "true");
      await expect(page.locator(`.diagram[data-view-id="${ids[0]}"]`)).toBeVisible();

      // ... and the arrow of the end takes it forward again.
      const beforeEnd = await scrollLeftOf(page);
      await end.click();
      await expect.poll(() => scrollLeftOf(page)).toBeGreaterThan(beforeEnd + 100);

      // Every tab, one after the other: scroll to it, click it where it is on the screen.
      for (const id of ids) {
        await page.evaluate((viewId) => {
          const el = document.querySelector<HTMLElement>(".view-tabs")!;
          const t = document.querySelector<HTMLElement>(`.tab[data-view-id="${viewId}"]`)!;
          el.scrollLeft += t.getBoundingClientRect().left - el.getBoundingClientRect().left - 60;
        }, id);
        await expect.poll(() => tabInSight(page, id), { message: `tab of ${id}` }).toBe(true);
        const box = await boxOf(tab(page, id));
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await expect(tab(page, id)).toHaveAttribute("aria-selected", "true");
        expect((await stateOf(page)).viewId).toBe(id);
      }
      await expectOneRowOnScreen(page, size);
      expect(problems).toEqual([]);
    });

    test("the active tab is in sight after every way of switching view", async ({ page }) => {
      const problems = watchProblems(page);
      const { ids } = await openMany(page, size);
      const last = ids.at(-1)!;
      const middle = ids[9]!;

      // The test hook (what a tour or the URL does), forwards and back.
      for (const id of [last, ids[0]!, middle, last, ids[1]!]) {
        await page.evaluate((viewId) => window.__xpl!.setView(viewId), id);
        await expect(tab(page, id)).toHaveAttribute("aria-selected", "true");
        await expect.poll(() => tabInSight(page, id), { message: `tab of ${id}` }).toBe(true);
      }
      // A tab click on a tab that is partly hidden brings it in.
      await page.evaluate((viewId) => window.__xpl!.setView(viewId), ids[0]!);
      const edge = await boxOf(page.locator(".view-tabs"));
      await page.mouse.move(edge.x + 40, edge.y + edge.height / 2);
      await page.mouse.wheel(0, 400);
      await expect.poll(() => scrollLeftOf(page)).toBeGreaterThan(200);
      await page.evaluate((viewId) => window.__xpl!.setView(viewId), ids[2]!);
      await expect.poll(() => tabInSight(page, ids[2]!)).toBe(true);
      expect(problems).toEqual([]);
    });

    test("the page opens with the tab of ?view= in sight", async ({ page }) => {
      const problems = watchProblems(page);
      const last = "view:many-14";
      await openMany(page, size, `?view=${last}`);
      await expect(page.locator(`.diagram[data-view-id="${last}"]`)).toBeVisible();
      await expect(tab(page, last)).toHaveAttribute("aria-selected", "true");
      expect(await tabInSight(page, last)).toBe(true);
      expect(await scrollLeftOf(page)).toBeGreaterThan(500);
      await expectOneRowOnScreen(page, size);
      expect(problems).toEqual([]);
    });

    test("the Tours panel and the Views menu open one at a time, and both sit under the row", async ({
      page,
    }) => {
      const problems = watchProblems(page);
      await openMany(page, size);
      const tours = page.getByTestId("tours-button");
      await tours.click();
      await expect(page.getByTestId("tour-panel")).toBeVisible();
      const panel = await boxOf(page.getByTestId("tour-panel"));
      expect(panel.x + panel.width).toBeLessThanOrEqual(size.width);
      await viewsButton(page).click();
      await expect(viewsMenu(page)).toBeVisible();
      await expect(page.getByTestId("tour-panel")).toHaveCount(0);
      await tours.click();
      await expect(page.getByTestId("tour-panel")).toBeVisible();
      await expect(viewsMenu(page)).toHaveCount(0);
      expect(problems).toEqual([]);
    });
  });
}

test.describe("keyboard", () => {
  const size = { width: 1440, height: 900 };

  test("the Views menu: arrows, Home, End, Enter, Escape and Tab", async ({ page }) => {
    const problems = watchProblems(page);
    const { ids } = await openMany(page, size);
    const focusedId = () =>
      page.evaluate(() => document.activeElement?.getAttribute("data-view-id") ?? null);

    // ArrowDown on the button opens the menu, on the current view.
    await viewsButton(page).focus();
    await page.keyboard.press("ArrowDown");
    await expect(viewsMenu(page)).toBeVisible();
    expect(await focusedId()).toBe(ids[0]);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    expect(await focusedId()).toBe(ids[2]);
    await page.keyboard.press("End");
    expect(await focusedId()).toBe(ids.at(-1));
    await page.keyboard.press("ArrowDown");
    expect(await focusedId(), "wraps round").toBe(ids[0]);
    await page.keyboard.press("ArrowUp");
    expect(await focusedId(), "wraps round").toBe(ids.at(-1));
    await page.keyboard.press("Home");
    expect(await focusedId()).toBe(ids[0]);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");

    // Enter jumps, closes the menu and hands the focus back to the button.
    await page.keyboard.press("Enter");
    await expect(viewsMenu(page)).toHaveCount(0);
    await expect(page.locator(`.diagram[data-view-id="${ids[3]}"]`)).toBeVisible();
    await expect(viewsButton(page)).toBeFocused();
    await expect(viewsButton(page)).toHaveAttribute("aria-expanded", "false");

    // Reopened, it starts on the new current view; Escape closes it and leaves the view (and the selection) be.
    await page.evaluate(() => window.__xpl!.select(["file:src/queue.ts"]));
    expect((await stateOf(page)).selection).toEqual(["file:src/queue.ts"]);
    await page.keyboard.press("Enter");
    await expect(viewsMenu(page)).toBeVisible();
    expect(await focusedId()).toBe(ids[3]);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");
    await expect(viewsMenu(page)).toHaveCount(0);
    await expect(viewsButton(page)).toBeFocused();
    expect((await stateOf(page)).viewId).toBe(ids[3]);
    expect((await stateOf(page)).selection).toEqual(["file:src/queue.ts"]);

    // Space opens it too; Tab closes it and carries on to the next control.
    await page.keyboard.press("Space");
    await expect(viewsMenu(page)).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(viewsMenu(page)).toHaveCount(0);
    await expect(page.getByTestId("tours-button")).toBeFocused();

    // A press outside closes it.
    await viewsButton(page).click();
    await expect(viewsMenu(page)).toBeVisible();
    await page.locator("h1.title").click();
    await expect(viewsMenu(page)).toHaveCount(0);
    expect(problems).toEqual([]);
  });

  test("the menu of a short window scrolls, to the current view", async ({ page }) => {
    const problems = watchProblems(page);
    const { ids } = await openMany(page, { width: 1440, height: 480 });
    const last = ids.at(-1)!;
    await page.evaluate((id) => window.__xpl!.setView(id), last);
    await viewsButton(page).click();
    const menu = await boxOf(viewsMenu(page));
    expect(menu.y + menu.height).toBeLessThanOrEqual(480);
    await expect(menuItem(page, last)).toBeFocused();
    const item = await boxOf(menuItem(page, last));
    expect(item.y).toBeGreaterThanOrEqual(menu.y);
    expect(item.y + item.height).toBeLessThanOrEqual(menu.y + menu.height);
    expect(await viewsMenu(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await page.keyboard.press("Home");
    await expect(menuItem(page, ids[0]!)).toBeFocused();
    await expect.poll(() => viewsMenu(page).evaluate((el) => el.scrollTop)).toBe(0);
    expect(problems).toEqual([]);
  });

  test("the tabs: one stop in the tab order; ← → Home End move along them, Enter picks", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    const { ids } = await openMany(page, size);
    const focusedId = () =>
      page.evaluate(() => document.activeElement?.getAttribute("data-view-id") ?? null);

    // Only the current tab is in the tab order.
    await expect(page.locator('.tab[tabindex="0"]')).toHaveCount(1);
    await expect(page.locator('.tab[tabindex="-1"]')).toHaveCount(15);
    await expect(tab(page, ids[0]!)).toHaveAttribute("tabindex", "0");
    await tab(page, ids[0]!).focus();
    await page.keyboard.press("ArrowRight");
    expect(await focusedId()).toBe(ids[1]);
    await page.keyboard.press("End");
    expect(await focusedId()).toBe(ids.at(-1));
    // The focused tab is brought in, clear of the arrows.
    await expect.poll(() => tabInSight(page, ids.at(-1)!)).toBe(true);
    await page.keyboard.press("ArrowRight");
    expect(await focusedId(), "wraps round").toBe(ids[0]);
    await expect.poll(() => tabInSight(page, ids[0]!)).toBe(true);
    await page.keyboard.press("ArrowLeft");
    expect(await focusedId()).toBe(ids.at(-1));
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    expect(await focusedId()).toBe(ids.at(-3));
    await expect.poll(() => tabInSight(page, ids.at(-3)!)).toBe(true);
    // Arrows only move the focus: the view is the same until Enter.
    expect((await stateOf(page)).viewId).toBe(ids[0]);
    await page.keyboard.press("Enter");
    await expect(page.locator(`.diagram[data-view-id="${ids.at(-3)}"]`)).toBeVisible();
    await expect(tab(page, ids.at(-3)!)).toHaveAttribute("tabindex", "0");
    await expect(page.locator('.tab[tabindex="0"]')).toHaveCount(1);
    // Tab leaves the strip for the Views button.
    await page.keyboard.press("Tab");
    await expect(viewsButton(page)).toBeFocused();
    expect(problems).toEqual([]);
  });

  test("tab tooltips carry the full title, then the question of a sequence view", async ({
    page,
  }) => {
    const { ids, titles } = await openMany(page, size);
    await expect(tab(page, ids[0]!)).toHaveAttribute("title", titles[0]!);
    await expect(tab(page, "view:many-2")).toHaveAttribute(
      "title",
      `${EXTRA_TITLES[1]}\n${QUESTION}`,
    );
    await expect(tab(page, "view:dispatch")).toHaveAttribute(
      "title",
      "How a job is dispatched\nHow does a job get from the queue to a worker?",
    );
  });
});

test.describe("a tablet", () => {
  for (const size of [
    { width: 1000, height: 720 },
    { width: 800, height: 900 },
  ]) {
    test(`${size.width}px: the controls stay beside the title, the strip has the row under them`, async ({
      page,
    }) => {
      const problems = watchProblems(page);
      const { ids } = await openMany(page, size);
      if (size.width > 900) {
        // (a dirty page shows "Unsaved": the widest the controls get)
        await fitAll(page);
        await byId(page, "ghost:file:src/bus.ts").click();
        await expect(page.locator(".save-status")).toHaveText("Unsaved");
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        size.width,
      );
      const header = await boxOf(page.locator(".header"));
      expect(Math.round(header.width)).toBe(size.width);
      const stripBox = await boxOf(page.getByTestId("view-strip"));
      const title = await boxOf(page.locator("h1.title"));
      // One row of the title and the controls, then the strip under it, the whole width.
      for (const [name, control] of Object.entries(controls(page))) {
        if (name === "views") continue;
        await expect(control, name).toBeVisible();
        const box = await boxOf(control);
        expect(box.x, name).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, name).toBeLessThanOrEqual(size.width);
        expect(box.y + box.height, `${name} is above the strip`).toBeLessThanOrEqual(stripBox.y);
        expect(Math.abs(box.y - title.y), `${name} is beside the title`).toBeLessThan(20);
      }
      expect(stripBox.x + stripBox.width).toBeLessThanOrEqual(size.width);
      expect(stripBox.width).toBeGreaterThan(size.width - 40);
      const tabs = await boxOf(strip(page));
      expect(tabs.width, "the strip is not squeezed").toBeGreaterThan(size.width * 0.6);
      expect(tabs.x + tabs.width).toBeLessThanOrEqual((await boxOf(viewsButton(page))).x);
      await page.screenshot({
        path: screenshotPath(`header-16-views-${size.width}`),
        clip: { x: 0, y: 0, width: size.width, height: 140 },
      });

      // The menu and the tabs work as everywhere else.
      await viewsButton(page).click();
      const menu = await boxOf(viewsMenu(page));
      expect(menu.x).toBeGreaterThanOrEqual(0);
      expect(menu.x + menu.width).toBeLessThanOrEqual(size.width);
      await menuItem(page, ids.at(-1)!).click();
      await expect(page.locator(`.diagram[data-view-id="${ids.at(-1)}"]`)).toBeVisible();
      await expect.poll(() => tabInSight(page, ids.at(-1)!)).toBe(true);
      expect(problems).toEqual([]);
    });
  }
});

test.describe("a phone", () => {
  const size = { width: 390, height: 844 };

  test("the header wraps, nothing leaves the screen, the strip still scrolls and the menu fits", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    const { ids, titles } = await openMany(page, size);

    // The page is as wide as the phone; every control is on it.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      size.width,
    );
    for (const [name, control] of Object.entries(controls(page))) {
      await expect(control, name).toBeVisible();
      const box = await boxOf(control);
      expect(box.x, name).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, name).toBeLessThanOrEqual(size.width);
    }
    // The strip has a row of its own, as wide as the header allows, and scrolls in itself.
    const frame = await boxOf(page.getByTestId("view-strip"));
    expect(frame.x + frame.width).toBeLessThanOrEqual(size.width);
    expect(await maxScrollOf(page)).toBeGreaterThan(500);
    expect(await tabStartInSight(page, ids[0]!)).toBe(true);
    await page.screenshot({
      path: screenshotPath("header-16-views-390"),
      clip: { x: 0, y: 0, width: size.width, height: 200 },
    });

    // The wheel works here too; the active tab follows a switch.
    const at = await boxOf(strip(page));
    await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
    await page.mouse.wheel(0, 300);
    await expect.poll(() => scrollLeftOf(page)).toBeGreaterThan(100);
    await page.evaluate((id) => window.__xpl!.setView(id), ids.at(-1)!);
    await expect.poll(() => tabStartInSight(page, ids.at(-1)!)).toBe(true);

    // The menu opens inside the screen, wraps long titles and jumps.
    await viewsButton(page).click();
    const menu = await boxOf(viewsMenu(page));
    expect(menu.x).toBeGreaterThanOrEqual(0);
    expect(menu.x + menu.width).toBeLessThanOrEqual(size.width);
    await expect(page.locator(".views-item")).toHaveText(titles);
    await page.screenshot({ path: screenshotPath("header-views-menu-390") });
    await menuItem(page, ids[1]!).click();
    await expect(page.locator(`.diagram[data-view-id="${ids[1]}"]`)).toBeVisible();
    await expect.poll(() => tabStartInSight(page, ids[1]!)).toBe(true);

    // Tours: the panel opens within the screen.
    await page.getByTestId("tours-button").click();
    const panel = await boxOf(page.getByTestId("tour-panel"));
    expect(panel.x).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(size.width);
    expect(problems).toEqual([]);
  });
});

test.describe("a few views", () => {
  test("the strip is as wide as its tabs, without arrows, and Present takes the strip away", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(TS_BUNDLE.href + "?mode=explore");
    await page.waitForFunction(() => window.__xpl !== undefined);
    const frame = page.getByTestId("view-tabs-frame");
    await expect(page.locator(".tab")).toHaveCount(2);
    // Nothing to scroll: no arrows, and the pill is no wider than its tabs (not stretched over the row).
    await expect(frame).toHaveAttribute("data-more-start", "false");
    await expect(frame).toHaveAttribute("data-more-end", "false");
    await expect(page.getByTestId("strip-arrow-start")).toHaveCSS("opacity", "0");
    await expect(page.getByTestId("strip-arrow-end")).toHaveCSS("opacity", "0");
    expect(await maxScrollOf(page)).toBe(0);
    const frameBox = await boxOf(frame);
    const lastTab = await boxOf(page.locator(".tab").last());
    expect(frameBox.x + frameBox.width - (lastTab.x + lastTab.width)).toBeLessThan(8);
    // The menu is there for the full titles all the same.
    await viewsButton(page).click();
    await expect(page.locator(".views-item")).toHaveText(["Overview", "How a job is dispatched"]);
    await page.keyboard.press("Escape");

    // Present shows the tour picker instead of the tabs and the menu; Explore brings them back.
    await page.getByRole("button", { name: "Present" }).click();
    await expect(page.locator(".view-tabs")).toHaveCount(0);
    await expect(viewsButton(page)).toHaveCount(0);
    await expect(page.getByTestId("tour-picker")).toBeVisible();
    await page.getByRole("button", { name: "Explore" }).click();
    await expect(page.locator(".view-tabs")).toHaveCount(1);
    await expect(viewsButton(page)).toHaveAccessibleName("Views (2)");
    expect(problems).toEqual([]);
  });

  test("a switch back from Present finds the tab in sight", async ({ page }) => {
    const problems = watchProblems(page);
    const { ids } = await openMany(page, { width: 1440, height: 900 });
    await page.getByRole("button", { name: "Present" }).click();
    await expect(page.locator(".view-tabs")).toHaveCount(0);
    // The tour of the last view is played: it is the view on screen when Explore comes back.
    await page.getByTestId("tour-picker").selectOption("tour:last");
    await expect(page.locator(`.diagram[data-view-id="${ids.at(-1)}"]`)).toBeVisible();
    await page.getByRole("button", { name: "Explore" }).click();
    await expect(page.locator(".view-tabs")).toHaveCount(1);
    await expect(tab(page, ids.at(-1)!)).toHaveAttribute("aria-selected", "true");
    await expect.poll(() => tabInSight(page, ids.at(-1)!)).toBe(true);
    expect(await scrollLeftOf(page)).toBeGreaterThan(500);
    expect(problems).toEqual([]);
  });
});
