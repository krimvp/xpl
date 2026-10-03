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
