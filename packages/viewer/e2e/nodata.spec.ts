import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { EMPTY_VIEWER, watchProblems } from "./helpers.js";

test("the built viewer without data says so instead of failing", async ({ page }) => {
  const problems = watchProblems(page);
  await page.goto(EMPTY_VIEWER.href);
  await expect(page).toHaveTitle("xpl viewer");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("xpl viewer");
  await expect(page.getByTestId("no-data")).toContainText('no <script id="xpl-data">');
  expect(await page.evaluate(() => window.__xpl)).toBeUndefined();
  expect(problems).toEqual([]);
});

test("data that is not a bundle is reported, not thrown", async ({ page }) => {
  const problems = watchProblems(page);
  const html = readFileSync(EMPTY_VIEWER, "utf8").replace(
    "</head>",
    () => '<script id="xpl-data" type="application/json">{"schema":"nope"}</script></head>',
  );
  await page.route("http://xpl.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: html }),
  );
  await page.goto("http://xpl.test/");
  await expect(page.getByTestId("no-data")).toContainText("could not be read");
  await expect(page.getByTestId("no-data")).toContainText("code-explainer/bundle@0");
  expect(problems).toEqual([]);
});
