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

test("a box traced on the map lights up what it leads to, then what leads to it", async ({
  page,
}) => {
  const problems = watchProblems(page);
  await page.goto(`${TS_BUNDLE.href}?mode=explore`);
  await page.waitForFunction(() => window.__xpl !== undefined);
  await page.evaluate(() => window.__xpl!.setView("view:overview"));
  const related = () =>
    page
      .locator(".graph .node.is-related")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-element-id")).sort());

  await byId(page, "grp:scheduling").click();
  const details = page.locator(".details");
  // nothing leads to it on this map: only the way down is offered
  await expect(details.locator("[data-trace]")).toHaveText(["What it leads to"]);
  await details.getByRole("button", { name: "What it leads to" }).click();
  await expect(details.getByRole("button", { name: "What it leads to" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect
    .poll(related)
    .toEqual(["file:src/metrics.ts", "file:src/worker.ts", "grp:scheduling"]);

  await byId(page, "file:src/metrics.ts").click();
  // picking another box ends the trace
  await expect.poll(related).toEqual([]);
  await details.getByRole("button", { name: "What leads to it" }).click();
  await expect
    .poll(related)
    .toEqual(["file:src/metrics.ts", "file:src/worker.ts", "grp:scheduling"]);
  // pressed again, it stops
  await details.getByRole("button", { name: "What leads to it" }).click();
  await expect.poll(related).toEqual([]);
  expect(problems).toEqual([]);
});

test("a reader can trace a box too, from its connections on the map", async ({ page }) => {
  const problems = watchProblems(page);
  await page.goto(`${TS_BUNDLE.href}?perspective=map&view=view:overview`);
  await byId(page, "grp:scheduling").click();
  const connections = page.getByTestId("map-connections");
  await connections.getByRole("button", { name: "What it leads to" }).click();
  await expect
    .poll(() =>
      page
        .locator(".graph .node.is-related")
        .evaluateAll((els) => els.map((el) => el.getAttribute("data-element-id")).sort()),
    )
    .toEqual(["file:src/metrics.ts", "file:src/worker.ts", "grp:scheduling"]);
  expect(problems).toEqual([]);
});

// a line to a dashed box said "calls (of 2 in all)", dropping its count of 1 (its aria said "×1")
test("a box's line to code outside the map keeps its count of 1 beside the total", async ({
  page,
}) => {
  const problems = watchProblems(page);
  await page.goto(`${TS_BUNDLE.href}?perspective=map&view=view:overview`);
  await page.evaluate(() => window.__xpl!.select(["file:src/worker.ts"]));
  await expect(page.getByTestId("map-connections")).toContainText(
    "To bus.ts calls ×1 (of 2 in all) · outside this map",
  );
  expect(problems).toEqual([]);
});
