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
      // what the caption held is one tap away
      const about = page.getByRole("button", { name: /^About this (map|flow)$/ });
      await expect(about).toHaveAttribute("aria-expanded", "false");
      await about.click();
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

test("the Tour gives its width to the text when the right column has nothing for the step (R3-3)", async ({
  page,
}) => {
  await page.goto(TS_BUNDLE.href);
  await expect(page.getByTestId("guide")).toBeVisible();
  // step 1 (the Scheduling group) has no related files: no column, the text takes the width
  await expect(page.locator(".workspace-context")).toBeHidden();
  // step 2 lists a settings file: the column is back
  await page
    .locator('.guide-section[data-section-id="t2"]')
    .evaluate((el) => el.scrollIntoView({ block: "start" }));
  await expect(page.getByRole("region", { name: "Related files" })).toBeVisible();
  await expect(page.locator(".workspace-context")).toBeVisible();
});
