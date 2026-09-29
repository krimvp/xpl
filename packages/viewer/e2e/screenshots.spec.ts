/**
 * Screenshots of both views in both colour schemes, written to e2e/screenshots/ (gitignored) for a human
 * to look at. They also check that nothing throws while the pages render.
 */
import { expect, test } from "@playwright/test";
import { byId, openBundle, screenshotPath, watchProblems } from "./helpers.js";

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme });

    test("overview (graph view)", async ({ page }) => {
      const problems = watchProblems(page);
      await openBundle(page);
      await expect(byId(page, "grp:scheduling")).toBeVisible();
      await expect(byId(page, "edge:job-completed")).toBeVisible();
      await page.screenshot({ path: screenshotPath(`overview-${scheme}`) });
      // With a selection: an edge selected, its anchors' files in the editors.
      await byId(page, "edge:job-completed").click();
      await expect(page.locator('[data-file="src/worker.ts"] .cm-editor')).toBeVisible();
      await expect(page.locator('[data-file="src/metrics.ts"] .cm-editor')).toBeVisible();
      await page.screenshot({ path: screenshotPath(`overview-edge-selected-${scheme}`) });
      expect(problems).toEqual([]);
    });

    test("how a job is dispatched (sequence view)", async ({ page }) => {
      const problems = watchProblems(page);
      await openBundle(page, "view:dispatch");
      await expect(byId(page, "dispatch:3")).toBeVisible();
      await page.screenshot({ path: screenshotPath(`dispatch-${scheme}`) });
      await byId(page, "dispatch:3").click();
      await expect(
        page.locator('[data-file="src/queue.ts"] .cm-line.xpl-hl').first(),
      ).toBeVisible();
      await page.screenshot({ path: screenshotPath(`dispatch-step-selected-${scheme}`) });
      await byId(page, "concept:retry-policy").click();
      await expect(page.locator('[data-file="test/retry.test.ts"] .cm-editor')).toBeVisible();
      await page.screenshot({ path: screenshotPath(`dispatch-concept-selected-${scheme}`) });
      expect(problems).toEqual([]);
    });
  });
}
