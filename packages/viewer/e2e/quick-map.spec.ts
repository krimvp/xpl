/**
 * What a quick map needs from the page: boxes that show their summary (`GraphView.boxText`), and a theme the
 * reader picks (Auto follows the device, Light, Dark), kept in this browser.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  byId,
  readEmbeddedBundle,
  TS_BUNDLE,
  watchProblems,
  withBundle,
  type Loose,
} from "./helpers.js";

async function openEdited(page: Page, edit: (bundle: Loose) => void): Promise<void> {
  const { html, bundle } = readEmbeddedBundle();
  edit(bundle);
  await page.route("http://xpl.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: withBundle(html, bundle) }),
  );
  await page.goto("http://xpl.test/?mode=explore");
  await page.waitForFunction(() => window.__xpl !== undefined);
}

test("a map whose boxes show their summary draws it under the label", async ({ page }) => {
  const problems = watchProblems(page);
  await openEdited(page, (bundle) => {
    const view = bundle.explainer.views.find((v: Loose) => v.id === "view:overview");
    view.boxText = "summary";
  });
  await page.evaluate(() => window.__xpl!.setView("view:overview"));

  await expect(byId(page, "grp:scheduling").locator(".box-summary")).toHaveText(
    "Decides which job runs next and hands it to a free worker.",
  );
  // a box with no summary shows its label alone
  await expect(byId(page, "file:src/worker.ts").locator(".box-summary")).toHaveCount(0);
  expect(problems).toEqual([]);
});

test("the theme button cycles Auto, Light and Dark, and the choice outlives a reload", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(`${TS_BUNDLE.href}?mode=explore`);
  const html = page.locator("html");
  const button = page.locator(".theme-btn");
  // Auto follows the device
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(button).toHaveAccessibleName("Theme: Auto (follows your device). Press for Light.");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(html).toHaveAttribute("data-theme", "light");

  await button.click();
  await expect(html).toHaveAttribute("data-theme", "light");
  await expect(button).toHaveAccessibleName("Theme: Light. Press for Dark.");
  await button.click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  // a chosen theme does not follow the device
  await page.emulateMedia({ colorScheme: "light" });
  await expect(html).toHaveAttribute("data-theme", "dark");

  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(page.locator(".theme-btn")).toHaveAccessibleName("Theme: Dark. Press for Auto.");
  await page.locator(".theme-btn").click();
  await expect(html).toHaveAttribute("data-theme", "light");
});
