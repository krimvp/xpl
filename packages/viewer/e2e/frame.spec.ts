/**
 * The frame around a diagram (round 3): what the first view and "Fit all" show, and how much of the screen the
 * diagram gets. The floating zoom toolbar never covers a box of a fitted diagram (D6); on a phone the diagram gets most of the screen
 * (R3-2); the Tour has no empty right column (R3-3).
 */
import { expect, test, type Page } from "@playwright/test";
import {
  ARCHITECTURE_BUNDLE,
  openVariant,
  TS_BUNDLE,
  watchProblems,
  type Loose,
} from "./helpers.js";

/** Ids of the map's boxes the zoom toolbar overlaps. */
const boxesUnderToolbar = (page: Page) =>
  page.evaluate(() => {
    const bar = [...document.querySelectorAll<HTMLElement>(".pz-toolbar")]
      .find((el) => el.offsetParent !== null)!
      .getBoundingClientRect();
    return [...document.querySelectorAll(".pz-svg .nodes g[data-element-id]")]
      .filter((g) => {
        const r = g.getBoundingClientRect();
        return r.left < bar.right && r.right > bar.left && r.top < bar.bottom && r.bottom > bar.top;
      })
      .map((g) => (g as SVGElement).dataset.elementId);
  });

test.describe("the zoom toolbar never covers a box of a fitted map (D6)", () => {
  for (const width of [1440, 1280, 1024, 390]) {
    test(`${width}px wide: Read > Map with the code open, Explore, and the system map`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 700 });
      const check = async () => {
        await expect(page.locator(".pz-svg .nodes g[data-element-id]").first()).toBeVisible();
        // the first view, then "Fit all" (when it is offered: a fitted map offers "Readable size")
        await expect.poll(() => boxesUnderToolbar(page)).toEqual([]);
        const fit = page.getByTestId("pz-fit");
        if ((await fit.textContent())?.startsWith("Fit all")) await fit.click();
        await expect.poll(() => boxesUnderToolbar(page)).toEqual([]);
      };
      await page.goto(`${TS_BUNDLE.href}?perspective=map`);
      await page.waitForFunction(() => window.__xpl !== undefined);
      await check();
      if (width > 640) {
        await page.getByRole("button", { name: "Show code" }).first().click();
        await check();
      }
      await page.goto(`${TS_BUNDLE.href}?mode=explore`);
      await check();
      await page.goto(`${ARCHITECTURE_BUNDLE.href}?perspective=map`);
      await check();
    });
  }
});

test.describe("a phone gives the diagram most of the screen (R3-2)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  /** The share of the screen's height the element shows of itself, on arrival (no scrolling). */
  const shareOfScreen = (page: Page, selector: string) =>
    page.evaluate((selector) => {
      const el = [...document.querySelectorAll(selector)].find(
        (candidate) => candidate.getBoundingClientRect().height > 0,
      )!;
      const r = el.getBoundingClientRect();
      const shown = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
      return shown / innerHeight;
    }, selector);

  for (const { name, url } of [
    { name: "a system map", url: `${ARCHITECTURE_BUNDLE.href}?perspective=map` },
    { name: "a map", url: `${TS_BUNDLE.href}?perspective=map` },
    { name: "a sequence", url: `${TS_BUNDLE.href}?perspective=flow` },
  ]) {
    test(`${name}: the canvas is at least 55% of the screen's height`, async ({ page }) => {
      const problems = watchProblems(page);
      await page.goto(url);
      await page.waitForFunction(() => window.__xpl !== undefined);
      await expect(page.locator(".workspace .pz-svg").first()).toBeVisible();
      await expect.poll(() => shareOfScreen(page, ".workspace .pz-svg")).toBeGreaterThan(0.55);
      // what the caption held is one tap away (a caption with only "Explore all diagrams" to hide shows it
      // and has no disclosure, R4-24)
      const about = page.getByRole("button", { name: /^About this (map|flow)$/ });
      if (name === "a map") await expect(about).toHaveCount(0);
      else {
        await expect(about).toHaveAttribute("aria-expanded", "false");
        await about.click();
      }
      await expect(page.getByTestId("explore-link")).toBeVisible();
      expect(problems).toEqual([]);
    });
  }

  test("the matrix gets the same height as the map", async ({ page }) => {
    await openVariant(
      page,
      (bundle) => {
        bundle.explainer.views.find((v: Loose) => v.id === "view:overview").render = "matrix";
      },
      "?perspective=map",
      { width: 390, height: 844 },
    );
    await expect(page.getByRole("grid")).toBeVisible();
    await expect
      .poll(() => shareOfScreen(page, ".workspace-diagram .matrix"))
      .toBeGreaterThan(0.55);
  });
});

test("the Tour decides its right column once per tour, so the text never changes width (R3-3, R4-4)", async ({
  page,
}) => {
  await page.goto(TS_BUNDLE.href);
  await expect(page.getByTestId("guide")).toBeVisible();
  // step 2 lists a settings file, so the column is there from step 1 on, which says it has none
  await expect(page.locator(".workspace-context")).toBeVisible();
  await expect(page.getByTestId("related-none")).toHaveText("No related files for this step.");
  const width = () =>
    page.locator('.guide-section[data-section-id="t1"]').evaluate((el) => el.clientWidth);
  const before = await width();
  await page
    .locator('.guide-section[data-section-id="t2"]')
    .evaluate((el) => el.scrollIntoView({ block: "start" }));
  await expect(page.getByRole("region", { name: "Related files" })).toContainText(
    "config/default.yaml",
  );
  expect(await width()).toBe(before);
  // a tour without any related files has no right column at all
  await openVariant(page, (bundle) => {
    for (const tour of bundle.explainer.tours as Loose[])
      for (const step of tour.steps as Loose[]) {
        step.focus = ["grp:scheduling"];
        delete step.code;
      }
  });
  await expect(page.getByTestId("guide")).toBeVisible();
  await expect(page.locator(".workspace-context")).toBeHidden();
});

/**
 * Present (D7): a slide keeps the 12px text floor. A diagram that does not read whole at that size in the 40%
 * column gets a wider one (up to 65%) and then fits whole; one still too big starts on the step's focus, with
 * the lifelines its arrows join in the frame, and "Fit all" in sight without a mouse.
 */
test.describe("Present keeps the 12px floor and widens the diagram column (D7)", () => {
  const FILES = ["main", "runner", "queue", "worker", "bus", "metrics", "config"].map(
    (name) => `file:src/${name}.ts`,
  );
  const addTour = (bundle: Loose) => {
    const views = bundle.explainer.views as Loose[];
    views.push({
      id: "view:files",
      type: "graph",
      title: "Every file",
      scope: { root: "repo", depth: 1 },
      include: FILES,
      provenance: { origin: "llm" },
      stubs: { mode: "none" },
    });
    // a long sequence: twelve arrows over six lifelines, the step talked about the last one, at the right
    const lanes = FILES.slice(1);
    views.push({
      id: "view:long",
      type: "sequence",
      title: "A long run",
      scope: { root: "repo", depth: 1 },
      participants: lanes,
      steps: Array.from({ length: 12 }, (_, i) => ({
        id: `long:${i + 1}`,
        from: lanes[i % 3]!,
        to: lanes[(i % 3) + 3]!,
        label: `call number ${i + 1}`,
        kind: "call",
      })),
      provenance: { origin: "llm" },
    });
    (bundle.explainer.tours as Loose[]).unshift({
      id: "tour:d7",
      title: "D7",
      steps: [
        { id: "s1", view: "view:files", focus: [FILES[1]] },
        { id: "s2", view: "view:long", focus: ["long:12"] },
      ],
    });
  };
  /** Boxes, and lifeline heads, wholly in the diagram's pane; the text size; is "Fit all" on screen? */
  const slide = (page: Page) =>
    page.evaluate(() => {
      const pane = document.querySelector(".present-left .pz-svg")!.getBoundingClientRect();
      const inside = (el: Element) => {
        const r = el.getBoundingClientRect();
        return (
          r.left >= pane.left - 1 &&
          r.right <= pane.right + 1 &&
          r.top >= pane.top - 1 &&
          r.bottom <= pane.bottom + 1
        );
      };
      const sizes = [...document.querySelectorAll<SVGTextElement>(".present-left .pz-svg text")]
        .filter((t) => t.textContent!.trim() && t.getBoundingClientRect().width > 0)
        .map((t) => parseFloat(getComputedStyle(t).fontSize) * (t.getScreenCTM()?.a ?? 1));
      const fit = document.querySelector<HTMLElement>(".present [data-testid=pz-fit]")!;
      const bar = fit.closest<HTMLElement>(".pz-toolbar")!;
      return {
        column: document.querySelector(".present-left")!.getBoundingClientRect().width / innerWidth,
        cut: [...document.querySelectorAll(".present-left .nodes g[data-element-id]")]
          .filter((g) => !inside(g))
          .map((g) => (g as SVGElement).dataset.elementId),
        smallest: Math.min(...sizes),
        fitShown: fit.offsetParent !== null && getComputedStyle(bar).opacity === "1",
        cue: fit.classList.contains("is-cue"),
      };
    });

  for (const size of [
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
  ]) {
    test(`${size.width}x${size.height}`, async ({ page }) => {
      const problems = watchProblems(page);
      await openVariant(page, addTour, "?mode=present&tour=tour:d7", size);
      await expect(page.getByTestId("present")).toHaveAttribute("data-step", "1");
      // a map: whole in the 40% column at 12px, or given a wider column (at most 65%); one still too big
      // starts on the step's box, "Fit all" in sight
      await expect(page.locator(".present-left .nodes g[data-element-id]").first()).toBeVisible();
      await page.waitForTimeout(500);
      let now = await slide(page);
      expect(now.smallest).toBeGreaterThanOrEqual(11.9);
      expect(now.column).toBeLessThanOrEqual(0.66);
      if (now.cut.length > 0) {
        expect(now.column).toBeGreaterThan(0.6);
        await expect.poll(async () => (await slide(page)).fitShown).toBe(true);
        expect(now.cut).not.toContain(FILES[1]);
      }
      // (at 1280x720 this map does not read whole at 12px in 40%: the column is wider)
      if (size.width === 1280) expect(now.column).toBeGreaterThan(0.45);

      // a sequence too tall for any column: the step's arrow and both its lifelines in the frame, at 12px or
      // more, with "Fit all" on the slide while the mouse has not moved
      await page.keyboard.press("ArrowRight");
      await expect(page.getByTestId("present")).toHaveAttribute("data-step", "2");
      await expect.poll(async () => (await slide(page)).fitShown).toBe(true);
      now = await slide(page);
      expect(now.cue).toBe(true);
      expect(now.smallest).toBeGreaterThanOrEqual(11.9);
      const pane = await page.locator(".present-left .pz-svg").boundingBox();
      for (const id of ["long:12", "file:src/worker.ts", "file:src/config.ts"]) {
        // (a lifeline: its head, which stays at the top of the pane as the diagram moves)
        const box = await page
          .locator(`.present-left [data-element-id="${id}"]`)
          .first()
          .boundingBox();
        expect(box, id).not.toBeNull();
        expect(box!.x, id).toBeGreaterThanOrEqual(pane!.x - 1);
        expect(box!.x + box!.width, id).toBeLessThanOrEqual(pane!.x + pane!.width + 1);
      }
      expect(problems).toEqual([]);
    });
  }
});

test.describe("the phone caption's disclosure (R4-21, R4-22)", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("says whether it is open, names what it controls, and leaves the diagram picker in sight", async ({
    page,
  }) => {
    await page.goto(ARCHITECTURE_BUNDLE.href + "?perspective=map&view=view:overview");
    await page.waitForFunction(() => window.__xpl !== undefined);
    const about = page.getByRole("button", { name: "About this map" });
    await expect(about).toHaveAttribute("aria-expanded", "false");
    const controls = await about.getAttribute("aria-controls");
    expect(await page.locator(`[id="${controls}"]`).count()).toBe(1);
    // the picker is a control, not "about" text: in sight while the details are closed
    await expect(page.getByRole("combobox", { name: "Choose a diagram" })).toBeVisible();
    await expect(page.locator(".view-question")).toBeHidden();
    await about.click();
    await expect(about).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".view-question")).toBeVisible();
  });
});

test("a reading tab opens on the Tour's step on screen, not on the one applied before the scroll (R4-5)", async ({
  page,
}) => {
  await page.goto(TS_BUNDLE.href);
  await expect(page.getByTestId("guide")).toBeVisible();
  await page
    .locator('.guide-section[data-section-id="t2"]')
    .evaluate((el) => el.scrollIntoView({ block: "start" }));
  await expect(page.getByTestId("breadcrumb-topic")).toContainText("Where failures go");
  await page.getByTestId("perspective-flow").click();
  await expect(page.getByTestId("breadcrumb-topic")).toContainText("Where failures go");
  await expect(page.locator('[data-element-id="dispatch:3"]').first()).toHaveClass(/is-selected/);
});
