/**
 * Accessibility and small-screen round (review 2026-10-03, M9-M15): a Key that covers what is on screen, the
 * page's audience line, readable dimmed code, keyboard focus and names on the map, and short or narrow
 * screens.
 */
import { expect, test } from "@playwright/test";
import {
  ARCHITECTURE_BUNDLE,
  openBundle,
  readEmbeddedBundle,
  TS_BUNDLE,
  withBundle,
} from "./helpers.js";

test.describe("who the page is for", () => {
  test("the author's audience line shows under the guide's title", async ({ page }) => {
    const { html, bundle } = readEmbeddedBundle();
    (bundle.explainer as { scope?: unknown }).scope = {
      audience: "Deep dive, for engineers working on the job runner",
    };
    await page.route("http://xpl.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: withBundle(html, bundle) }),
    );
    await page.goto("http://xpl.test/");
    await expect(page.getByTestId("audience")).toHaveText(
      "Deep dive, for engineers working on the job runner",
    );
    await expect(page.locator(".header .title")).toHaveAttribute("title", /Deep dive/);
  });

  test("without one, nothing is shown", async ({ page }) => {
    await page.goto(TS_BUNDLE.href);
    await expect(page.getByTestId("guide")).toBeVisible();
    await expect(page.getByTestId("audience")).toHaveCount(0);
  });
});

test.describe("the Key covers what is on screen", () => {
  test("a system map: outside systems, stores, icons and the see-inside button", async ({
    page,
  }) => {
    await openBundle(page, "view:system", ARCHITECTURE_BUNDLE);
    await page.getByTestId("legend-button").click();
    const key = page.getByTestId("legend");
    await expect(key).toContainText("Something outside this code");
    await expect(key).toContainText("Where data is kept");
    await expect(key).toContainText("See what is inside");
    await expect(key.getByTestId("legend-icons")).toContainText("a person");
    await expect(key.getByTestId("legend-icons")).toContainText("a program");
    // nothing on this map was added or edited by a change
    await expect(key).not.toContainText("What the change did");
  });

  test("the flow has a Key too", async ({ page }) => {
    await page.goto(TS_BUNDLE.href);
    await page.getByTestId("perspective-flow").click();
    await expect(page.getByTestId("process-flow")).toBeVisible();
    await page.getByTestId("process-flow").getByTestId("legend-button").click();
    const key = page.getByTestId("legend");
    await expect(key).toContainText("One step");
    await expect(key).toContainText("the order the steps run in");
    await page.keyboard.press("Escape");
    await expect(key).toHaveCount(0);
  });
});

test.describe("the keyboard on a map", () => {
  test("boxes: named label first, no button inside a button, Tab in reading order", async ({
    page,
  }) => {
    await openBundle(page, "view:system", ARCHITECTURE_BUNDLE);
    const names = await page
      .locator('.diagram .nodes .node[role="button"]')
      .evaluateAll((boxes) =>
        boxes.map((box) => [
          box.getAttribute("aria-label") ?? "",
          box.querySelector(":scope > .label")?.textContent ?? "",
        ]),
      );
    expect(names.length).toBeGreaterThan(2);
    for (const [name, label] of names) expect(name.startsWith(label!)).toBe(true);
    await expect(page.locator('.diagram [role="button"] [role="button"]')).toHaveCount(0);

    // Tab from the canvas: the boxes come top-down, then left to right
    await page.locator(".diagram .panzoom").focus();
    const order: { top: number; left: number }[] = [];
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      const at = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el?.matches(".node")) return null;
        const box = el.querySelector(":scope > .box")!.getBoundingClientRect();
        return { top: box.top, left: box.left };
      });
      if (at) order.push(at);
    }
    expect(order.length).toBe(names.length);
    for (let i = 1; i < order.length; i++) {
      const [a, b] = [order[i - 1]!, order[i]!];
      expect(a.top < b.top - 4 || (Math.abs(a.top - b.top) <= 8 && a.left <= b.left)).toBe(true);
    }
  });

  test("keyboard focus has its own ring, apart from the selection outline", async ({ page }) => {
    await openBundle(page, "view:system", ARCHITECTURE_BUNDLE);
    const service = page.locator('.diagram [data-element-id="grp:job-runner"]');
    await page.locator('.diagram [data-element-id="grp:operator"]').click();
    await page.locator(".diagram .panzoom").focus();
    // Tab to the service box (the operator is picked, the service has the focus)
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      if (await service.evaluate((el) => el === document.activeElement)) break;
    }
    await expect(service).toBeFocused();
    const ring = (id: string) =>
      page
        .locator(`.diagram [data-element-id="${id}"] > .focus-ring`)
        .evaluate((el) => getComputedStyle(el).stroke);
    expect(await ring("grp:job-runner")).not.toBe("none");
    expect(await ring("grp:operator")).toBe("none");
    // the focused box keeps its own outline: focus is not drawn like a picked box
    await expect(service).not.toHaveClass(/is-selected/);
  });

  test("each step's buttons and lists say which step they belong to", async ({ page }) => {
    await page.goto(TS_BUNDLE.href);
    await expect(page.getByTestId("guide")).toBeVisible();
    const names = await page
      .locator(".guide-section .section-actions .btn, [data-testid=snapshot-open]")
      .evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute("aria-label") ?? button.textContent),
      );
    expect(names.length).toBeGreaterThan(2);
    expect(new Set(names).size).toBe(names.length);
    expect(names[0]).toMatch(/^(Open in Map|Open in Flow|Show the code), step 1: /);
  });
});
