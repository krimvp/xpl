import { expect, test } from "@playwright/test";

// dist/index.html is written by `vite build` (npm run test:e2e does it first); opened via file://.
const builtViewer = new URL("../dist/index.html", import.meta.url).href;

test("the built single-file viewer renders its title, a CodeMirror editor and an ELK layout", async ({
  page,
}) => {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console.error: ${message.text()}`);
  });

  await page.goto(builtViewer);

  await expect(page).toHaveTitle("xpl viewer");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("xpl viewer");

  // CodeMirror: exactly one editor, holding the sample code, inside a data-file pane.
  await expect(page.locator(".cm-editor")).toHaveCount(1);
  await expect(page.locator('[data-file="src/runner.ts"] .cm-editor')).toBeVisible();
  await expect(page.locator(".cm-content")).toContainText("class Runner");

  // elkjs: the layered layout ran (nodes a -> b -> c go left to right).
  await expect(page.getByTestId("elk-layout")).toContainText("a@");
  const layoutText = (await page.getByTestId("elk-layout").textContent()) ?? "";
  const xs = ["a", "b", "c"].map((id) =>
    Number(new RegExp(`${id}@([\\d.]+),`).exec(layoutText)?.[1]),
  );
  expect(xs[0]).toBeLessThan(xs[1]!);
  expect(xs[1]).toBeLessThan(xs[2]!);

  // @xpl/core (workspace package) made it into the browser bundle; so did marked.
  await expect(page.getByTestId("core-link")).toContainText("calls, extends, implements");
  await expect(page.getByTestId("note").locator("strong")).toHaveText("read-only");

  expect(problems).toEqual([]);
});
