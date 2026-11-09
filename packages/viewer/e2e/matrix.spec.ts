/**
 * A map as a dependency matrix (MatrixView): the reader's "Matrix" switch, or a view that opens as one
 * (`GraphView.render`). The two-way link holds in the matrix as on the map: a cell selects its arrow and
 * shows its reference sites, the caret in the code lights the cell, and the keyboard reaches every cell.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  byId,
  focusOf,
  openBundle,
  openVariant,
  selectionOf,
  watchProblems,
  type Loose,
} from "./helpers.js";

const CALLS = "edge:calls:grp:scheduling->file:src/worker.ts";

/** The overview opens as a matrix (`render: "matrix"`): its three boxes are too few for the reader's switch. */
async function openMatrix(page: Page): Promise<void> {
  await openVariant(
    page,
    (bundle) => {
      bundle.explainer.views.find((v: Loose) => v.id === "view:overview").render = "matrix";
    },
    "?mode=explore",
  );
  await page.evaluate(() => window.__xpl!.setView("view:overview"));
  await expect(page.getByRole("grid")).toBeVisible();
}

test("each row of the matrix uses its columns; a cell selects the arrow and shows where it is called", async ({
  page,
}) => {
  const problems = watchProblems(page);
  await openMatrix(page);
  await expect(page.getByRole("rowheader")).toHaveText([
    "1Scheduling",
    "2worker.ts",
    "3metrics.ts",
    "Outside this map",
  ]);
  await expect(page.getByRole("columnheader")).toHaveText(["1", "2", "3", "Out"]);
  const cell = byId(page, CALLS);
  await expect(cell).toHaveText("3");
  await expect(cell).toHaveAccessibleName(
    "Scheduling → worker.ts: calls ×3. heuristic (matched by name)",
  );
  // an arrow the author added is marked, not counted: it is one arrow, not one reference
  await expect(byId(page, "edge:job-completed")).toHaveText("•");

  await cell.click();
  await expect.poll(() => selectionOf(page)).toEqual([CALLS]);
  await expect(cell).toHaveClass(/is-selected/);
  await expect
    .poll(async () =>
      (await focusOf(page))
        .filter((f) => f.role === "call-site")
        .map((f) => [f.file, f.range.startLine]),
    )
    .toEqual([
      ["src/runner.ts", 53],
      ["src/runner.ts", 60],
      ["src/runner.ts", 63],
    ]);
  expect(problems).toEqual([]);
});

test("the caret on a call site lights the cell of its arrow", async ({ page }) => {
  await openMatrix(page);
  const cell = byId(page, CALLS);
  await page.evaluate(() => window.__xpl!.setCursor("src/runner.ts", 53));
  await expect(cell).toHaveClass(/is-match/);
  // a line no arrow passes through: the cell goes out
  await page.evaluate(() => window.__xpl!.setCursor("src/runner.ts", 1));
  await expect(cell).not.toHaveClass(/is-match/);
});

test("the arrow keys move between cells and headers; Enter selects", async ({ page }) => {
  await openMatrix(page);
  // one tab stop: the first arrow
  const stop = page.locator('.matrix-grid [tabindex="0"]');
  await expect(stop).toHaveCount(1);
  await stop.focus();
  await expect(byId(page, CALLS)).toBeFocused();

  // down to worker.ts's row, right to its arrow to metrics.ts
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  await expect(byId(page, "edge:job-completed")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => selectionOf(page)).toEqual(["edge:job-completed"]);

  // Home: the row's header, which selects the box
  await page.keyboard.press("Home");
  await expect(page.getByRole("rowheader", { name: "2: worker.ts" })).toBeFocused();
  await page.keyboard.press(" ");
  await expect.poll(() => selectionOf(page)).toEqual(["file:src/worker.ts"]);
});

test("a view with render: matrix opens as a matrix, and Diagram switches it back to the map", async ({
  page,
}) => {
  await openMatrix(page);
  await page.getByRole("button", { name: "Diagram" }).click();
  await expect(page.getByRole("grid")).toHaveCount(0);
  await expect(page.locator(`g[data-element-id="${CALLS}"]`)).toBeVisible();
  // the way back reads "Matrix"
  await page.getByRole("button", { name: "Matrix" }).click();
  await expect(page.getByRole("grid")).toBeVisible();
});

test("the lines out of the map fill an Outside column and row; a cell selects them as the map's stubs", async ({
  page,
}) => {
  await openMatrix(page);
  const out = page.locator(".matrix-cell.is-outside.has-arrow").first();
  await expect(out).toHaveAccessibleName(/outside this map/);
  await out.click();
  const picked = await selectionOf(page);
  expect(picked.length).toBeGreaterThan(0);
  expect(picked.every((id) => id.startsWith("stub:"))).toBe(true);
  await expect(page.getByTestId("matrix-key").locator('[data-key-item="outside"]')).toHaveText(
    "leads outside this map",
  );
});

test("a map of three boxes offers no matrix; a fourth box brings the switch, but not in Present", async ({
  page,
}) => {
  await openBundle(page, "view:overview");
  await expect(page.locator(".pz-toolbar")).toBeVisible();
  await expect(page.getByRole("button", { name: "Matrix" })).toHaveCount(0);

  const four = (bundle: Loose) =>
    bundle.explainer.views
      .find((v: Loose) => v.id === "view:overview")
      .include.push("file:src/bus.ts");
  await openVariant(page, four, "?mode=explore");
  await page.evaluate(() => window.__xpl!.setView("view:overview"));
  await expect(page.getByRole("button", { name: "Matrix" })).toBeVisible();
  await openVariant(page, four, "?mode=present");
  await expect(page.locator(".pz-toolbar").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Matrix" })).toHaveCount(0);
});

test("the matrix keeps Save image (a PNG of the grid) and Text view", async ({ page }) => {
  await openMatrix(page);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save image" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.png$/);
  await page.getByRole("button", { name: "Text view" }).click();
  await expect(page.getByRole("region", { name: "Diagram as text" })).toContainText(
    "worker.ts to metrics.ts",
  );
});

for (const scheme of ["light", "dark"] as const) {
  test(`${scheme}: a cell shows its trust by its fill, as its key says, not by colour alone`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openMatrix(page);
    const image = (el: Locator) => el.evaluate((node) => getComputedStyle(node).backgroundImage);
    const outline = (el: Locator) => el.evaluate((node) => getComputedStyle(node).boxShadow);
    const key = page.getByTestId("matrix-key");
    // matched by name: stripes, the same on the cell and its key swatch
    const striped = await image(byId(page, CALLS));
    expect(striped).toContain("repeating-linear-gradient");
    await expect(key.locator('[data-key-item="heuristic"]')).toHaveText("matched by name");
    expect(await image(key.locator('[data-key-item="heuristic"] .matrix-swatch'))).toBe(striped);
    // added by the author: no stripes, an outline
    const authored = byId(page, "edge:job-completed");
    expect(await image(authored)).toBe("none");
    expect(await outline(authored)).not.toBe("none");
    expect(await outline(key.locator('[data-key-item="authored"] .matrix-swatch'))).toBe(
      await outline(authored),
    );
  });
}

test("on a phone the map's zoom toolbar, Matrix included, is one row inside the screen", async ({
  page,
}) => {
  await openVariant(
    page,
    (bundle) =>
      bundle.explainer.views
        .find((v: Loose) => v.id === "view:overview")
        .include.push("file:src/bus.ts"),
    "?perspective=map",
    { width: 390, height: 844 },
  );
  const toolbar = page.locator(".workspace-diagram .pz-toolbar");
  const matrix = toolbar.getByRole("button", { name: "Matrix" });
  await expect(matrix).toBeVisible();
  const [bar, button] = await Promise.all([toolbar.boundingBox(), matrix.boundingBox()]);
  expect(bar!.height, "one row").toBeLessThan(40);
  expect(button!.x + button!.width).toBeLessThanOrEqual(390);
});
