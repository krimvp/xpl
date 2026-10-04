import { expect, test } from "@playwright/test";
import { openBundle, openVariant, watchProblems } from "./helpers.js";

test("the exported viewer explains missing analysis without provider internals", async ({
  page,
}) => {
  const problems = watchProblems(page);
  await openBundle(page);
  const notice = page.getByTestId("analysis-coverage");
  await expect(notice.locator("summary")).toHaveText(
    "Analysis coverage: 12 files; some analysis is limited or unavailable.",
  );
  await notice.locator("summary").click();
  await expect(notice).toContainText(
    "Only file anchors are available; named symbols and relationships are unavailable.",
  );
  await expect(notice).toContainText(
    "Heuristic relationships are hints; unresolved targets may be missing.",
  );
  await expect(notice).not.toContainText("tree-sitter");
  expect(problems).toEqual([]);
});

test("legacy coverage stays unknown and failed analysis is visible", async ({ page }) => {
  await openVariant(page, (bundle) => {
    delete bundle.index.analysis;
  });
  const notice = page.getByTestId("analysis-coverage");
  await expect(notice.locator("summary")).toHaveText("Analysis coverage unknown (legacy index).");
  await notice.locator("summary").click();
  await expect(notice).toContainText("an empty result does not establish complete analysis");
  await openVariant(page, (bundle) => {
    bundle.index.analysis.push({
      provider: "test-tool",
      diagnostics: ["test-tool: /private/bin/tool unavailable"],
      capabilities: { call: "supported" },
      files: ["src/runner.ts"],
      results: [
        {
          capabilities: ["call"],
          status: "failed",
          analyzedFiles: [],
          limitations: ["Precise relationship analysis failed; heuristic hints remain."],
        },
      ],
    });
  });
  await expect(notice.locator("summary")).toContainText("some analysis failed");
  await notice.locator("summary").click();
  await expect(notice).toContainText("calls failed (0/1 files analyzed)");
  await expect(notice).not.toContainText("test-tool");
  await expect(notice).not.toContainText("/private/bin/tool");
});
