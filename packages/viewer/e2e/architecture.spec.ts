/**
 * Architecture maps: boxes drawn as what they are (`role`), their technology as the badge, a box that opens
 * the next level down (`opens`), and the trail back up. The bundle is the Python fixture with the skill's
 * worked overview (global-setup.ts).
 */
import { expect, test } from "@playwright/test";
import { ARCHITECTURE_BUNDLE, openBundle, stateOf, TS_BUNDLE } from "./helpers.js";

const box = (page: import("@playwright/test").Page, id: string) =>
  page.locator(`.diagram [data-element-id="${id}"]`).first();
/** The corner buttons of a box: drawn beside it, not inside it (a box is a button itself). */
const buttonsOf = (page: import("@playwright/test").Page, id: string) =>
  page.locator(`.diagram [data-buttons-of="${id}"]`);

test.describe("architecture maps", () => {
  test("view questions distinguish the system map from a dispatch sequence", async ({ page }) => {
    await page.goto(ARCHITECTURE_BUNDLE.href + "?perspective=map&view=view:system");
    await page.waitForFunction(() => window.__xpl !== undefined);
    await expect(page.locator(".workspace-caption")).toContainText(
      "Who starts the job runner, and which settings does it read?",
    );
    await page.goto(TS_BUNDLE.href + "?perspective=flow&view=view:dispatch");
    await page.waitForFunction(() => window.__xpl !== undefined);
    await expect(page.locator(".workspace-caption .eyebrow")).toHaveText("Sequence");
    await expect(page.locator(".workspace-caption")).toContainText(
      "How does a job get from the queue to a worker?",
    );
  });

  test("a reader can follow the visible relationships of a selected component", async ({
    page,
  }) => {
    await page.goto(ARCHITECTURE_BUNDLE.href + "?perspective=map&view=view:overview");
    await page.waitForFunction(() => window.__xpl !== undefined);
    await page.getByRole("button", { name: "Workers, component" }).click();
    const connections = page.getByTestId("map-connections");
    await expect(connections).toBeVisible();
    await expect(connections.locator("li button")).toHaveText([
      /From Startup\s+calls ×2 · derived · heuristic/,
      /From Scheduling\s+calls ×4 · derived · heuristic/,
      /To Events and metrics\s+job.completed · authored/,
    ]);
    const event = connections.getByRole("button", { name: /To Events and metrics.*job.completed/ });
    await event.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("breadcrumb-topic")).toHaveText("job.completed");
    await expect(page.locator('[data-element-id="edge:job-completed"]').first()).toHaveClass(
      /is-selected/,
    );
  });

  test("boundary arrows appear beside the selected box and open their stub details", async ({
    page,
  }) => {
    await page.goto(TS_BUNDLE.href + "?perspective=map&view=view:overview");
    await page.waitForFunction(() => window.__xpl !== undefined);
    await page.getByRole("button", { name: "worker.ts, file" }).click();
    const connections = page.getByTestId("map-connections");
    await expect(connections).toContainText("outside this map");
    const bus = connections.getByRole("button", { name: /To .*bus.ts.*outside this map/ });
    await bus.click();
    await expect(page.getByTestId("breadcrumb-topic")).toContainText("calls");
  });

  test("boxes of code show their level: a folder, a file, a class, a method", async ({ page }) => {
    await openBundle(page, "view:overview");
    const icons = await page
      .locator(".diagram .node:not(.ghost) > .box-icon")
      .evaluateAll((list) => list.map((el) => el.getAttribute("data-icon")));
    expect(icons.length).toBeGreaterThan(0);
    expect(icons.every((name) => name !== null && name !== "")).toBe(true);
  });

  test("the system map draws each box as what it is", async ({ page }) => {
    await openBundle(page, "view:system", ARCHITECTURE_BUNDLE);
    await expect(box(page, "grp:job-runner")).toHaveClass(/role-service/);
    await expect(box(page, "grp:settings-file")).toHaveClass(/role-storage/);
    await expect(box(page, "grp:operator")).toHaveClass(/role-person/);
    // a store is a cylinder: its outline and its lid
    await expect(box(page, "grp:settings-file").locator(":scope > .lid")).toHaveCount(1);
    // the badge is the technology, not "group"
    await expect(box(page, "grp:settings-file").locator(".badge text")).toHaveText("YAML");
    // an icon says what each box is
    await expect(box(page, "grp:job-runner").locator(".box-icon")).toHaveAttribute(
      "data-icon",
      "service",
    );
    await expect(box(page, "grp:settings-file").locator(".box-icon")).toHaveAttribute(
      "data-icon",
      "storage",
    );
    await expect(box(page, "grp:operator").locator(".box-icon")).toHaveAttribute(
      "data-icon",
      "person",
    );
    // only the service opens a level below
    await expect(buttonsOf(page, "grp:job-runner").locator(".zoom")).toHaveCount(1);
    await expect(buttonsOf(page, "grp:settings-file").locator(".zoom")).toHaveCount(0);
    await expect(page.getByTestId("zoom-trail")).toHaveCount(0);
  });

  test("the zoom button opens the inside, and the trail leads back up", async ({ page }) => {
    await openBundle(page, "view:system", ARCHITECTURE_BUNDLE);
    await buttonsOf(page, "grp:job-runner").locator(".zoom").click();
    await expect(page.locator('.diagram[data-view-id="view:overview"]')).toBeVisible();
    // one level down: the parts are components, and the icon says so
    await expect(box(page, "grp:scheduling").locator(":scope > .box-icon")).toHaveAttribute(
      "data-icon",
      "component",
    );
    const trail = page.getByTestId("zoom-trail");
    await expect(trail).toContainText("The job runner and its surroundings");
    await expect(trail).toContainText("Job runner");
    await trail.getByRole("button").first().click();
    await expect(page.locator('.diagram[data-view-id="view:system"]')).toBeVisible();
    expect((await stateOf(page)).viewId).toBe("view:system");
  });

  test("a double-click zooms too, and Details offers it", async ({ page }) => {
    await openBundle(page, "view:system", ARCHITECTURE_BUNDLE);
    await box(page, "grp:job-runner").click();
    await expect(
      page.getByRole("button", { name: /Open its own map: The five parts/ }),
    ).toBeVisible();
    await box(page, "grp:job-runner").dblclick();
    await expect(page.locator('.diagram[data-view-id="view:overview"]')).toBeVisible();
    expect((await stateOf(page)).viewId).toBe("view:overview");
  });

  test("a box shows its inside in place, and folds back", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await openBundle(page, "view:system", ARCHITECTURE_BUNDLE);
    const service = box(page, "grp:job-runner");
    await expect(page.locator('.diagram [data-element-id="grp:scheduling"]')).toHaveCount(0);
    await page.locator('[data-buttons-of="grp:job-runner"] .expand-here').click();
    // the same map, with the service drawn as a container around its components
    await expect(page.locator('.diagram[data-view-id="view:system"]')).toBeVisible();
    await expect(service).toHaveClass(/is-container/);
    await expect(service.locator('[data-element-id="grp:scheduling"]')).toHaveCount(1);
    await expect(service.locator('[data-element-id="file:jobrunner/worker.py"]')).toHaveCount(1);
    // drawn, not stored: the view still includes only its own boxes
    const state = await stateOf(page);
    expect(state.graph!.nodes).toContain("grp:scheduling");
    expect(state.include).toEqual(["grp:operator", "grp:job-runner", "grp:settings-file"]);
    // The wide container extends past the pane at readable zoom. Folding stays on screen.
    const fold = page.locator(".diagram-caption").getByRole("button", {
      name: "Fold Job runner back",
    });
    await expect(fold).toBeVisible();
    await fold.click();
    await expect(page.locator('.diagram [data-element-id="grp:scheduling"]')).toHaveCount(0);
    await expect(service).not.toHaveClass(/is-container/);
    await buttonsOf(page, "grp:job-runner").locator(".expand-here").click();
    await fold.focus();
    await expect(fold).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(service).not.toHaveClass(/is-container/);
    await expect.poll(async () => (await stateOf(page)).include).toEqual(state.include);
    await buttonsOf(page, "grp:job-runner").locator(".expand-here").click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(fold).toBeVisible();
    const bounds = await fold.boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await fold.click();
    await expect(service).not.toHaveClass(/is-container/);
  });

  test("the Read map offers the same reachable fold action", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(ARCHITECTURE_BUNDLE.href + "?perspective=map&view=view:system");
    await page.waitForFunction(() => window.__xpl !== undefined);
    const include = (await stateOf(page)).include;
    await page.locator('[data-buttons-of="grp:job-runner"] .expand-here').click();
    const fold = page.locator(".workspace-caption").getByRole("button", {
      name: "Fold Job runner back",
    });
    await expect(fold).toBeVisible();
    await fold.click();
    await expect(page.locator('[data-element-id="grp:job-runner"]').first()).not.toHaveClass(
      /is-container/,
    );
    await expect.poll(async () => (await stateOf(page)).include).toEqual(include);
  });
});
