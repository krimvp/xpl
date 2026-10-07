import { expect, test } from "@playwright/test";
import { byId, linesWith, openBundle, openVariant, selectionOf } from "./helpers.js";

const dispatch = "sym:src/runner.ts#Runner.dispatch";
const pop = "sym:src/queue.ts#Queue.pop";

test("map keyboard follows a call to its target and returns to the canvas", async ({ page }) => {
  await openVariant(
    page,
    (bundle) => {
      Object.assign(
        bundle.explainer.views.find((v: { id: string }) => v.id === "view:overview"),
        {
          include: [dispatch, pop],
          stubs: { mode: "none" },
          edgeKinds: ["calls"],
        },
      );
    },
    "?mode=explore&view=view:overview",
  );
  const canvas = page.locator(".diagram .panzoom");
  await canvas.focus();
  await page.keyboard.press("Enter");
  await expect(byId(page, dispatch)).toBeFocused();
  await page.keyboard.press("ArrowRight");
  const edge = page.locator(`[data-key-for="edge:calls:${dispatch}->${pop}"]`);
  await expect(edge).toBeFocused();
  await expect(edge).toHaveAccessibleName(/Runner.dispatch to Queue.pop/);
  await page.keyboard.press("Enter");
  await expect.poll(() => selectionOf(page)).toEqual([`edge:calls:${dispatch}->${pop}`]);
  await expect
    .poll(() => linesWith(page.locator('[data-file="src/runner.ts"]'), ".xpl-hl"))
    .toEqual([46]);
  await page.keyboard.press("ArrowRight");
  await expect(byId(page, pop)).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(edge).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(canvas).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect.poll(() => canvas.evaluate((el) => el.contains(document.activeElement))).toBe(false);
});

for (const type of ["sequence", "flow"] as const) {
  test(`${type} keyboard reaches a step and selects its exact source`, async ({ page }) => {
    if (type === "sequence") await openBundle(page, "view:dispatch");
    else
      await openVariant(
        page,
        (bundle) => {
          bundle.explainer.views.find((v: { id: string }) => v.id === "view:dispatch").type =
            "flow";
        },
        "?mode=explore&view=view:dispatch",
      );
    const canvas = page.locator(".diagram .panzoom");
    await canvas.focus();
    await page.keyboard.press("Enter");
    if (type === "sequence") await page.keyboard.press("ArrowRight");
    await expect(byId(page, "dispatch:1")).toBeFocused();
    if (type === "flow") {
      await page.keyboard.press("ArrowRight");
      await expect(byId(page, "dispatch:2")).toBeFocused();
      await page.keyboard.press("ArrowLeft");
      await expect(byId(page, "dispatch:1")).toBeFocused();
    }
    await page.keyboard.press("ArrowDown");
    await expect(byId(page, "dispatch:2")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(byId(page, "dispatch:3")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(() => selectionOf(page)).toEqual(["dispatch:3"]);
    await expect
      .poll(() => linesWith(page.locator('[data-file="src/runner.ts"]'), ".xpl-hl"))
      .toEqual([76, 77, 78]);
    await page.keyboard.press("Escape");
    await expect(canvas).toBeFocused();
  });
}
