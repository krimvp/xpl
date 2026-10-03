/**
 * A diagram too big to read when it is fitted into its pane starts zoomed in instead: at a readable zoom
 * (0.75), looking at its first box (or at the selection), with a "Fit all" badge. Fit still shows all of it.
 *
 * The page is the viewer with a synthetic pipeline of 17 stages added to the fixture (a chain of groups
 * with stored edges, no members, so nothing else is drawn): fitted, it comes out at about 0.2.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  byId,
  readEmbeddedBundle,
  screenshotPath,
  stateOf,
  watchProblems,
  withBundle,
} from "./helpers.js";

/** The embedded bundle is edited as loose JSON: many shapes, none worth typing here. */
type Loose = Record<string, any>;

const STAGES = [
  "Ingest",
  "Parse",
  "Validate",
  "Enrich",
  "Route",
  "Queue",
  "Lease",
  "Run",
  "Retry",
  "Ack",
  "Meter",
  "Emit",
  "Store",
  "Index",
  "Cache",
  "Notify",
  "Archive",
];
const IDS = STAGES.map((_, i) => `grp:n${i + 1}`);
const FIRST = IDS[0]!;
const LAST = IDS.at(-1)!;

function withPipeline(bundle: Loose): void {
  const explainer = bundle.explainer;
  STAGES.forEach((name, i) =>
    explainer.nodes.push({
      id: IDS[i],
      kind: "group",
      label: `Stage ${i + 1}: ${name}`,
      parent: "repo",
      members: [],
      provenance: { origin: "llm" },
    }),
  );
  IDS.slice(1).forEach((id, i) =>
    explainer.edges.push({
      id: `edge:s${i + 1}`,
      from: IDS[i],
      to: id,
      kind: "custom",
      label: `step ${i + 1}`,
      anchors: [],
      provenance: { origin: "llm" },
    }),
  );
  explainer.views.push({
    id: "view:pipeline",
    type: "graph",
    title: "Pipeline",
    scope: { root: "repo", depth: 1 },
    include: IDS,
    stubs: { mode: "none" },
    provenance: { origin: "llm" },
  });
  explainer.tours.push({
    id: "tour:pipeline",
    title: "Pipeline",
    steps: [
      { id: "t1", view: "view:pipeline", focus: [LAST], note: "The end of the pipeline." },
      { id: "t2", view: "view:pipeline", focus: [FIRST], note: "And its start." },
      { id: "t3", view: "view:overview", focus: ["grp:scheduling"], note: "A small diagram." },
    ],
  });
}

async function open(page: Page, search = "?mode=explore"): Promise<void> {
  const { html, bundle } = readEmbeddedBundle();
  withPipeline(bundle);
  await page.route("http://xpl.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: withBundle(html, bundle) }),
  );
  await page.goto(`http://xpl.test/${search}`);
  await page.waitForFunction(() => window.__xpl !== undefined);
}

const canvas = (page: Page) => page.locator(".panzoom");
const zoomOf = async (page: Page) => Number(await canvas(page).getAttribute("data-zoom"));
const badge = (page: Page) => page.getByTestId("pz-badge");
const fitButton = (page: Page) => page.getByRole("button", { name: "Fit to view" });

async function showPipeline(page: Page): Promise<void> {
  await page.evaluate(() => window.__xpl!.setView("view:pipeline"));
  await expect(page.locator('.diagram[data-view-id="view:pipeline"]')).toBeVisible();
  await expect(byId(page, FIRST)).toBeVisible();
}

/** True when the box of a node lies inside the pane (a box outside is still in the DOM, but clipped). */
async function inPane(page: Page, id: string): Promise<boolean> {
  const pane = await canvas(page).boundingBox();
  const box = await byId(page, id).locator("> rect.box").boundingBox();
  if (!pane || !box) return false;
  return (
    box.x >= pane.x - 1 &&
    box.y >= pane.y - 1 &&
    box.x + box.width <= pane.x + pane.width + 1 &&
    box.y + box.height <= pane.y + pane.height + 1
  );
}

const inPaneAll = async (page: Page, ids: readonly string[]) =>
  (await Promise.all(ids.map((id) => inPane(page, id)))).every(Boolean);

/** The zoom Present starts a big diagram at (PanZoom's PRESENT_READABLE_ZOOM): 12px text stays 12px. */
const PRESENT_ZOOM = 1;

async function expectZoom(page: Page, near: number): Promise<void> {
  await expect.poll(() => zoomOf(page)).toBeCloseTo(near, 2);
}

const viewports = [
  { name: "a tall pane (the default window): the layers run downwards", w: 1440, h: 900 },
  { name: "a wide, low pane: the layers run to the right", w: 1800, h: 560, direction: "RIGHT" },
];

for (const viewport of viewports) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.w, height: viewport.h } });

    test("a diagram that cannot be fitted at a readable size starts at zoom 0.75 on its first box; Fit goes below", async ({
      page,
    }) => {
      const problems = watchProblems(page);
      await open(page);
      await showPipeline(page);

      // The initial view: zoomed in, at the floor, looking at Stage 1; the rest is out of sight.
      await expectZoom(page, 0.75);
      expect(await inPane(page, FIRST)).toBe(true);
      expect(await inPane(page, LAST)).toBe(false);
      expect(await inPaneAll(page, IDS)).toBe(false);
      if (viewport.direction) {
        await expect(page.locator(".graph")).toHaveAttribute("data-direction", viewport.direction);
      }
      await expect(badge(page)).toBeVisible();
      await expect(badge(page)).toHaveText("Fit all");
      // ... and every label at that zoom is readable: a 14px label is about 10px on screen
      const label = await byId(page, FIRST).locator("text.label").boundingBox();
      expect(label!.height).toBeGreaterThan(9);
      await page.screenshot({ path: screenshotPath(`large-graph-start-${viewport.h}`) });

      // Fit still shows all of it, below the floor.
      await fitButton(page).click();
      await expect.poll(() => zoomOf(page)).toBeLessThan(0.6);
      expect(await zoomOf(page)).toBeGreaterThanOrEqual(0.1);
      expect(await inPaneAll(page, IDS)).toBe(true);
      await expect(badge(page)).toHaveText("Readable size");
      await page.screenshot({ path: screenshotPath(`large-graph-fit-${viewport.h}`) });

      // "Readable size" goes back to the start.
      await badge(page).click();
      await expectZoom(page, 0.75);
      expect(await inPane(page, FIRST)).toBe(true);
      expect(await inPane(page, LAST)).toBe(false);
      await expect(badge(page)).toHaveText("Fit all");

      // The badge fits all of it too, and so does the 0 key.
      await badge(page).click();
      await expect.poll(() => zoomOf(page)).toBeLessThan(0.6);
      expect(await inPaneAll(page, IDS)).toBe(true);
      await badge(page).click();
      await expectZoom(page, 0.75);
      await canvas(page).focus();
      await page.keyboard.press("0");
      await expect.poll(() => zoomOf(page)).toBeLessThan(0.6);
      expect(await inPaneAll(page, IDS)).toBe(true);
      expect(problems).toEqual([]);
    });

    test("the viewport stays where the user put it; a click does not move it; another view starts over", async ({
      page,
    }) => {
      await open(page);
      await showPipeline(page);
      await expectZoom(page, 0.75);

      // A click on a box selects it and leaves the viewport alone.
      await byId(page, FIRST).click();
      expect((await stateOf(page)).selection).toEqual([FIRST]);
      expect(await zoomOf(page)).toBeCloseTo(0.75, 3);
      expect(await inPane(page, FIRST)).toBe(true);

      // Zooming with the buttons is the user's: the badge stays, the zoom is theirs.
      await page.getByRole("button", { name: "Zoom in" }).click();
      expect(await zoomOf(page)).toBeCloseTo(0.9375, 3);
      await expect(badge(page)).toHaveText("Fit all");

      // A small diagram has no floor to apply and no badge: it is fitted as before.
      await page.evaluate(() => window.__xpl!.setView("view:overview"));
      await expect(page.locator('.diagram[data-view-id="view:overview"]')).toBeVisible();
      await expect(byId(page, "grp:scheduling")).toBeVisible();
      await expect.poll(() => zoomOf(page)).toBeGreaterThan(0.6);
      await expect(badge(page)).toHaveCount(0);

      // Back in the big one: it starts over, at the floor.
      await page.evaluate(() => window.__xpl!.setView("view:pipeline"));
      await expect(byId(page, FIRST)).toBeVisible();
      await expectZoom(page, 0.75);
      expect(await inPane(page, FIRST)).toBe(true);
    });
  });
}

test.describe("what a big diagram starts on", () => {
  test("a tour step's focus: the diagram looks at it, and at the next step's focus after it", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await open(page, "?mode=present&tour=tour:pipeline&step=1");
    await expect(page.getByTestId("tour-counter")).toHaveText("1 / 3");
    await expect(byId(page, LAST)).toHaveClass(/is-selected/);

    // Step 1 focuses Stage 17, at the far end: the first view is on it, not on the corner. Present starts
    // at zoom 1 (not 0.75 as Explore does): the smallest diagram text is 12px or more for the room.
    await expectZoom(page, PRESENT_ZOOM);
    expect(await inPane(page, LAST)).toBe(true);
    expect(await inPane(page, FIRST)).toBe(false);
    await expect(badge(page)).toHaveText("Fit all");
    await page.screenshot({ path: screenshotPath("large-graph-step-last") });

    // Step 2 focuses Stage 1, in the same view: the diagram moves to it.
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("tour-counter")).toHaveText("2 / 3");
    await expect(byId(page, FIRST)).toHaveClass(/is-selected/);
    await expectZoom(page, PRESENT_ZOOM);
    expect(await inPane(page, FIRST)).toBe(true);
    expect(await inPane(page, LAST)).toBe(false);

    // A detour (the user moves the diagram, then a step comes again) starts the step over.
    await page.getByRole("button", { name: "Zoom out" }).click();
    expect(await zoomOf(page)).toBeLessThan(0.9);
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByTestId("tour-counter")).toHaveText("1 / 3");
    await expectZoom(page, PRESENT_ZOOM);
    expect(await inPane(page, LAST)).toBe(true);

    // Step 3 is a small diagram again: fitted, no badge.
    await page.keyboard.press("End");
    await expect(page.getByTestId("tour-counter")).toHaveText("3 / 3");
    await expect(byId(page, "grp:scheduling")).toBeVisible();
    await expect(badge(page)).toHaveCount(0);
    await expect.poll(() => zoomOf(page)).toBeGreaterThan(0.75);
    expect(problems).toEqual([]);
  });

  test("Explore starts on the first box of the include list when nothing is selected", async ({
    page,
  }) => {
    // The same graph with its include list turned round: the entry point is now Stage 17.
    const { html, bundle } = readEmbeddedBundle();
    withPipeline(bundle);
    const view = (bundle.explainer as Loose).views.find((v: Loose) => v.id === "view:pipeline");
    view.include = [...IDS].reverse();
    await page.route("http://xpl.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: withBundle(html, bundle) }),
    );
    await page.goto("http://xpl.test/?mode=explore");
    await page.waitForFunction(() => window.__xpl !== undefined);
    await showPipeline(page);
    await expectZoom(page, 0.75);
    expect(await inPane(page, LAST)).toBe(true);
    expect(await inPane(page, FIRST)).toBe(false);
  });
});

test("a short pane (a laptop at 200%): Fit all sits among the zoom buttons, not on the boxes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 720, height: 450 });
  await open(page, "?mode=explore");
  await showPipeline(page);
  const pane = (await canvas(page).boundingBox())!;
  expect(pane.height).toBeLessThan(240);
  await expect(page.locator(".pz-toolbar [data-testid=pz-badge]")).toBeVisible();
  await badge(page).click();
  await expect(badge(page)).toHaveText("Readable size");
  // a tall pane keeps the pill in its corner
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator(".panzoom > [data-testid=pz-badge]")).toBeVisible();
});

/** Keep the helper honest: the boxes the checks above measure exist. */
test("the synthetic pipeline has its 17 stages", async ({ page }) => {
  await open(page);
  await showPipeline(page);
  const boxes: Locator = page.locator(".graph .node");
  await expect(boxes).toHaveCount(17);
  expect((await stateOf(page)).graph!.nodes).toHaveLength(17);
});
