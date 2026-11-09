/**
 * Trust is never shown by colour alone (AGENTS.md "never blur precise and heuristic"): an arrow
 * matched by name is dashed on the map, on the key line under the caption and in the Key, with one dash in all
 * three places and in both themes; a line out of the map has a dash of its own, and is not drawn (nor in the
 * Tab order) until its box is selected.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { byId, TS_BUNDLE, watchProblems } from "./helpers.js";

const HEURISTIC = "edge:calls:grp:scheduling->file:src/worker.ts";

const dash = (line: Locator) => line.evaluate((el) => getComputedStyle(el).strokeDasharray);

async function openMap(page: Page) {
  await page.goto(TS_BUNDLE.href + "?perspective=map");
  await page.waitForFunction(() => window.__xpl !== undefined);
  await page.evaluate(() => window.__xpl!.select([]));
}

for (const scheme of ["light", "dark"] as const) {
  test(`${scheme}: a heuristic arrow is dashed on the map, the key line and the Key, the same way`, async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await page.emulateMedia({ colorScheme: scheme });
    await openMap(page);
    const onMap = await dash(byId(page, HEURISTIC).locator(".line"));
    expect(onMap).not.toBe("none");
    const keyLine = page.getByTestId("key-line");
    await expect(keyLine.locator('[data-key-item="heuristic"]')).toContainText("matched by name");
    // a screen reader hears a list of marks, each with its look in words, not one run-on sentence
    await expect(keyLine).toHaveAccessibleName("Key to this map's lines");
    await expect(keyLine.getByRole("listitem").filter({ hasText: "matched by name" })).toHaveText(
      "dashed arrow: matched by name",
    );
    await expect(keyLine.locator('[data-key-item="authored"]')).toHaveText(
      "thick purple arrow: added by the author, checked against the code",
    );
    expect(await dash(keyLine.locator('[data-key-item="heuristic"] line'))).toBe(onMap);
    // an authored arrow beside it stays solid
    expect(await dash(keyLine.locator('[data-key-item="authored"] line'))).toBe("none");
    await page.getByTestId("legend-button").click();
    const row = page.getByTestId("legend").locator(".legend-row", { hasText: "matched by name" });
    expect(await dash(row.locator("line"))).toBe(onMap);
    await page.keyboard.press("Escape");

    // lines out of the map: hidden and out of the Tab order until a box is selected, then dotted
    const stubs = page.locator(".workspace-diagram .edge.is-stub");
    // (the overview's 8 lines out of it: 3 boxes used by main.ts and the tests, 2 of them using bus.ts)
    await expect(stubs).toHaveCount(8);
    await expect(page.locator('.workspace-diagram [data-key-for^="stub:"]')).toHaveCount(0);
    await expect(keyLine.locator('[data-key-item="stub"]')).toHaveCount(0);
    await expect(keyLine.locator('[data-key-item="ghost"]')).toContainText("outside this map");
    await byId(page, "file:src/worker.ts").click();
    const shown = page.locator(".workspace-diagram .edge.is-stub:not(.is-stub-quiet)").first();
    await expect(shown).toBeVisible();
    const stubDash = await dash(shown.locator(".line"));
    expect(stubDash).not.toBe("none");
    expect(stubDash).not.toBe(onMap);
    expect(await dash(keyLine.locator('[data-key-item="stub"] line'))).toBe(stubDash);
    expect(problems).toEqual([]);
  });
}

test("picking an arrow shows no lines out of the map, only the arrow the reader asked about", async ({
  page,
}) => {
  await openMap(page);
  await byId(page, "edge:job-completed").click();
  // the code of the arrow puts the caret in its ends' files; their lines out stay hidden
  await expect(page.locator(".workspace-diagram .edge.is-stub:not(.is-stub-quiet)")).toHaveCount(0);
  // a box picked after it brings its own back
  await byId(page, "file:src/worker.ts").click();
  await expect(
    page.locator(".workspace-diagram .edge.is-stub:not(.is-stub-quiet)").first(),
  ).toBeVisible();
});
