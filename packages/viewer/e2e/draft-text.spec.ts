/**
 * A draft before anyone wrote its text (`xpl draft` puts `TODO: <what to write>` in every text): the map, the
 * lists and the titles show what the index found, marked "(TODO)" (`shortText` in core), and the whole
 * instruction stays where the author writes, in the details of the selected element.
 */
import { expect, test, type Page } from "@playwright/test";
import { byId, openVariant, watchProblems, type Loose } from "./helpers.js";

const BOX = "TODO: 1-3 plain words for this part (now: scheduling)";
const ARROW = "TODO: 1-4 words: what passes here (for example: stores orders)";
const STEP = "TODO: what this part is for, as a plain statement";
const FRAME = "TODO: when these calls run, in a few words (now: `attempts <= maxRetries`)";

/** The TS fixture as `xpl draft` would leave it: the texts of a box, an arrow, a frame and the tour to write. */
const openDraft = (page: Page, search: string) =>
  openVariant(
    page,
    ({ explainer: ex }) => {
      ex.nodes.find((n: Loose) => n.id === "grp:scheduling").label = BOX;
      ex.edges.find((e: Loose) => e.id === "edge:job-completed").label = ARROW;
      ex.views
        .find((v: Loose) => v.id === "view:dispatch")
        .frames.find((f: Loose) => f.id === "frame:retry").label = FRAME;
      ex.tours[0].title = "TODO: what the tour covers, in about 8 plain words";
      ex.tours[0].steps[0].note = `### ${STEP}\n\nTODO: its job in everyday words.`;
    },
    search,
    { width: 1440, height: 900 },
  );

test("a draft's map shows the names the index found, and its details the whole instruction", async ({
  page,
}) => {
  const problems = watchProblems(page);
  await openDraft(page, "?perspective=map&view=view:overview");

  await expect(byId(page, "grp:scheduling").locator(".label").first()).toHaveText(
    "scheduling (TODO)",
  );
  await expect(page.locator(".edge-label text")).toHaveText(["calls ×3", "TODO"]);
  // the list beside the map names the box and the arrow the same way
  const parts = page.getByTestId("parts-panel");
  await expect(parts.locator('[data-part-id="grp:scheduling"] .parts-name')).toHaveText(
    "scheduling (TODO)",
  );
  await expect(parts.locator('[data-part-id="edge:job-completed"] .parts-name')).toHaveText("TODO");

  // selected: the breadcrumb names it short, the panel beside the map says what to write
  await page.evaluate(() => window.__xpl!.select(["grp:scheduling"]));
  await expect(page.getByTestId("breadcrumb-topic")).toHaveText("scheduling (TODO)");
  await expect(
    page.getByRole("complementary", { name: "Selected" }).getByRole("heading", { level: 2 }),
  ).toHaveText(BOX);
  expect(problems).toEqual([]);
});

test("a draft's tour lists its steps by the mark, and the step itself says what to write", async ({
  page,
}) => {
  await openDraft(page, "?perspective=guide");
  const contents = page.getByRole("navigation", { name: "Tour steps" }).getByRole("button");
  await expect(contents.first()).toHaveText("1TODO");
  await expect(page).toHaveTitle("TODO · xpl");
  await expect(page.getByTestId("guide").getByRole("heading", { name: STEP })).toBeVisible();
});

test("a draft's sequence names a frame by the code that decides it", async ({ page }) => {
  await openDraft(page, "?perspective=flow&view=view:dispatch");
  await expect(page.locator('[data-frame-head="frame:retry"] .frame-label')).toHaveText(
    "[attempts <= maxRetries (TODO)]",
  );
});
