/**
 * "On this map" (PartsPanel): with nothing picked, the topic column lists the parts of the diagram on screen in
 * words. A row picks its element (its code shows, as for a click on the diagram); a caret in that code marks
 * the row as it marks the box. Steps carry the numbers the diagram draws.
 */
import { expect, test } from "@playwright/test";
import { stateOf, TS_BUNDLE, watchProblems } from "./helpers.js";

const WORKER = "file:src/worker.ts";

test("the map's parts in words: a row picks its box and shows its code; a caret in that code marks the row", async ({
  page,
}) => {
  const problems = watchProblems(page);
  // wide enough for the topic column beside the code the caret opens
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.goto(TS_BUNDLE.href + "?perspective=map");
  await page.waitForFunction(() => window.__xpl !== undefined);
  const panel = page.getByTestId("parts-panel");
  await expect(panel).toContainText("On this map");
  const boxes = panel.getByRole("list", { name: "Boxes" }).locator(".parts-name");
  await expect(boxes).toHaveText(["Scheduling", "worker.ts", "metrics.ts"]);
  // the author's arrow is listed by its words
  await expect(panel.getByRole("list", { name: "Named arrows" })).toContainText("job.completed");

  const row = panel.locator(`[data-part-id="${WORKER}"]`);
  // a row says which boxes it links to, by name, and the pointer on it lights its box
  await expect(row.locator(".parts-links")).toContainText("used by Scheduling");
  await row.hover();
  await expect(page.locator(`.workspace-diagram [data-element-id="${WORKER}"]`)).toHaveClass(
    /is-hover/,
  );
  await page.mouse.move(0, 0);

  // caret in worker.ts (nothing picked): its row lights up like its box
  await page.evaluate(() => window.__xpl!.setCursor("src/worker.ts", 20));
  await expect(row).toHaveClass(/is-match/);
  await expect(page.locator(`.workspace-diagram [data-element-id="${WORKER}"]`)).toHaveClass(
    /is-match/,
  );

  // a click picks the box: the diagram marks it, and the panel gives way to what was picked
  await row.click();
  await expect.poll(async () => (await stateOf(page)).selection).toEqual([WORKER]);
  await expect(page.locator(`.workspace-diagram [data-element-id="${WORKER}"]`)).toHaveClass(
    /is-selected/,
  );
  await expect(panel).toHaveCount(0);
  expect(problems).toEqual([]);
});

test("a sequence's steps in words carry the numbers its arrows carry", async ({ page }) => {
  const problems = watchProblems(page);
  await page.goto(TS_BUNDLE.href + "?perspective=flow&view=view:dispatch");
  await page.waitForFunction(() => window.__xpl !== undefined);
  const steps = page.getByTestId("parts-panel").getByRole("list", { name: "Steps" });
  // every step, not only the first: a numbering that counted frames or arms would drift from step 2 on
  const ids = ["dispatch:1", "dispatch:2", "dispatch:3"];
  await expect(steps.locator(".parts-number")).toHaveText(["1", "2", "3"]);
  await expect
    .poll(() =>
      steps
        .locator("[data-part-id]")
        .evaluateAll((els) => els.map((el) => el.getAttribute("data-part-id"))),
    )
    .toEqual(ids);
  for (const [i, id] of ids.entries())
    await expect(
      page.locator(`.workspace-diagram [data-element-id="${id}"] .step-number text`),
    ).toHaveText(String(i + 1));
  await steps.locator(`[data-part-id="${ids[1]}"]`).click();
  await expect.poll(async () => (await stateOf(page)).selection).toEqual([ids[1]]);
  expect(problems).toEqual([]);
});
