import { expect, test } from "@playwright/test";
import { openVariant, watchProblems } from "./helpers.js";

test("analysis coverage is in About this guide; a bar only when linked code was left out", async ({
  page,
}) => {
  const problems = watchProblems(page);
  await openVariant(page, () => undefined);
  // TypeScript calls matched by name, JSON and YAML with no calls: nothing a reader must be warned about
  await expect(page.getByTestId("analysis-coverage")).toHaveCount(0);
  await page.getByTestId("explanation-info").locator(":scope > summary").click();
  const notice = page.getByTestId("analysis-details");
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
  await expect(notice).toContainText("typescript (typescript):");
  // a file the guide does not link to, left out of the analysis: no bar either
  await openVariant(page, (bundle) => {
    bundle.index.files.push({ path: "src/extra.ts", language: "typescript", hash: "x", lines: 1 });
    bundle.index.analysis.push({
      provider: "test-tool",
      capabilities: { call: "supported" },
      files: ["src/extra.ts"],
      results: [{ capabilities: ["call"], status: "failed", analyzedFiles: [], limitations: [] }],
    });
  });
  await expect(page.getByTestId("explanation-info")).toBeVisible();
  await expect(page.getByTestId("analysis-coverage")).toHaveCount(0);
  expect(problems).toEqual([]);
});

test("legacy coverage stays unknown and failed analysis is visible", async ({ page }) => {
  await openVariant(page, (bundle) => {
    delete bundle.index.analysis;
  });
  await expect(page.getByTestId("analysis-coverage")).toHaveCount(0);
  await page.getByTestId("explanation-info").locator(":scope > summary").click();
  const details = page.getByTestId("analysis-details");
  await expect(details.locator("summary")).toHaveText("Analysis coverage unknown (legacy index).");
  await details.locator("summary").click();
  await expect(details).toContainText("an empty result does not establish complete analysis");
  const notice = page.getByTestId("analysis-coverage");
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
  // one plain line, the files at risk under it, the tool's report in About this guide
  await expect(notice.locator("summary")).toHaveText(
    "Some arrows may be missing: the code analysis failed in 1 file this guide links to.",
  );
  await notice.locator("summary").click();
  await expect(notice).toContainText("src/runner.ts");
  await page.getByTestId("explanation-info").locator(":scope > summary").click();
  const report = page.getByTestId("analysis-details");
  await expect(report.locator("summary")).toContainText("some analysis failed");
  await report.locator("summary").click();
  await expect(report).toContainText("calls failed (0/1 files analyzed)");
  await expect(report).toContainText("typescript (test-tool): calls failed");
  await expect(report).not.toContainText("/private/bin/tool");
});
