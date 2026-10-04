import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { expect, type Locator, type Page } from "@playwright/test";

/** The self-contained TS fixture bundle built by global-setup.ts. */
export const TS_BUNDLE = new URL("../dist/bundles/ts-jobrunner.html", import.meta.url);
/** The Python and Go fixture bundles built by global-setup.ts (same design, other languages). */
export const PY_BUNDLE = new URL("../dist/bundles/py-jobrunner.html", import.meta.url);
export const GO_BUNDLE = new URL("../dist/bundles/go-jobrunner.html", import.meta.url);
/**
 * The TS fixture as a change explainer (scripts/ts-change.json): a record with a renamed, a deleted, an added
 * and two modified files, the code before the change embedded, and a base anchor on the retry concept and in
 * the second tour step.
 */
/** The Python fixture with the skill's worked overview: a system map that zooms into the parts. */
export const ARCHITECTURE_BUNDLE = new URL("../dist/bundles/py-architecture.html", import.meta.url);
export const CHANGE_BUNDLE = new URL("../dist/bundles/ts-change.html", import.meta.url);
/** The viewer without any data. */
export const EMPTY_VIEWER = new URL("../dist/index.html", import.meta.url);

export const screenshotPath = (name: string): string =>
  fileURLToPath(new URL(`./screenshots/${name}.png`, import.meta.url));

/** Collects everything that would show up in a developer console as a problem. */
export function watchProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console.error: ${message.text()}`);
  });
  return problems;
}

/**
 * Opens the bundle (the TS fixture unless `bundle` says otherwise) and waits until the app has installed
 * `window.__xpl`; optionally switches view.
 */
export async function openBundle(
  page: Page,
  view?: string,
  bundle: URL = TS_BUNDLE,
): Promise<void> {
  await page.goto(bundle.href + "?mode=explore");
  await page.waitForFunction(() => window.__xpl !== undefined);
  if (view) {
    await page.evaluate((id) => window.__xpl!.setView(id), view);
    await expect(page.locator(`.diagram[data-view-id="${view}"]`)).toBeVisible();
  }
}

/**
 * The toolbar's Fit: all of the diagram in view. A diagram too big to read when fitted starts zoomed in, with
 * part of it out of sight (PanZoom, "Fit all"): a spec that goes through every element fits it first.
 */
export async function fitAll(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Fit to view" }).click();
}

export const focusOf = (page: Page) => page.evaluate(() => window.__xpl!.focus());
export const matchesOf = (page: Page) => page.evaluate(() => window.__xpl!.matches());
export const selectionOf = (page: Page) => page.evaluate(() => window.__xpl!.selection());
export const stateOf = (page: Page) => page.evaluate(() => window.__xpl!.state());

/** The `data-line` numbers of the rendered lines of a pane that carry a class. */
export async function linesWith(pane: Locator, selector: string): Promise<number[]> {
  const lines = await pane
    .locator(`.cm-line${selector}`)
    .evaluateAll((els) => els.map((el) => Number(el.getAttribute("data-line"))));
  return lines.sort((a, b) => a - b);
}

/** The element by its test-hook id (ids contain ":" and "#", so no CSS `#id` selectors). */
export const byId = (page: Page, id: string): Locator => page.locator(`[data-element-id="${id}"]`);

/** The bundle JSON embedded in the fixture page (TS unless `file` says otherwise), for building variants of it. */
export function readEmbeddedBundle(file: URL = TS_BUNDLE): {
  html: string;
  bundle: Record<string, unknown>;
} {
  const html = readFileSync(file, "utf8");
  const match = /<script id="xpl-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (!match) throw new Error("no xpl-data script in the fixture bundle");
  return { html, bundle: JSON.parse(match[1]!) as Record<string, unknown> };
}

/** The page with `bundle` embedded instead (JSON safe inside a script element). */
export function withBundle(html: string, bundle: Record<string, unknown>): string {
  const json = JSON.stringify(bundle).replace(/</g, "\\u003c");
  return html.replace(
    /<script id="xpl-data" type="application\/json">[\s\S]*?<\/script>/,
    () => `<script id="xpl-data" type="application/json">${json}</script>`,
  );
}

/**
 * The header's Edit menu holds every author tool (in Read, Explore and Present): the tour editor, the stub
 * and edge-kind toggles of a graph view (Explore), Save as HTML and the JSON download. Opens it (when it is
 * not open) and resolves to the menu.
 */
export async function openEditMenu(page: Page): Promise<Locator> {
  const menu = page.getByTestId("edit-menu");
  if ((await menu.count()) === 0) await page.getByTestId("edit-button").click();
  await expect(menu).toBeVisible();
  return menu;
}

/** Opens the tour editor (Edit > Edit the guide's steps). */
export async function openTourEditor(page: Page): Promise<void> {
  if ((await page.getByTestId("tour-panel").count()) > 0) return;
  await (await openEditMenu(page)).getByTestId("edit-tours").click();
  await expect(page.getByTestId("tour-panel")).toBeVisible();
}

/** Edit > Download explainer JSON; resolves to the download. */
export async function downloadJson(page: Page) {
  const menu = await openEditMenu(page);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    menu.getByTestId("edit-download").click(),
  ]);
  return download;
}

/** A stub-mode or edge-kind toggle of the current graph view, in the Edit menu (opened when needed). */
export async function viewToggle(page: Page, selector: string): Promise<Locator> {
  return (await openEditMenu(page)).locator(selector);
}

/** Explore (from Read: Edit > Explore the diagrams). */
export async function toExplore(page: Page): Promise<void> {
  await (await openEditMenu(page)).getByTestId("edit-explore").click();
  await expect(page.locator(".header")).toHaveAttribute("data-mode", "explore");
}

/** Back to reading from Explore (Edit > Back to reading). */
export async function toRead(page: Page): Promise<void> {
  await (await openEditMenu(page)).getByTestId("edit-read").click();
  await expect(page.locator(".header")).toHaveAttribute("data-mode", "read");
}

/** The embedded bundle edited as loose JSON: many shapes, none worth typing in a test. */
export type Loose = Record<string, any>;

/** The TS fixture page with `edit` applied to its bundle, served at http://xpl.test/`search`. */
export async function openVariant(
  page: Page,
  edit: (bundle: Loose) => void,
  search = "",
  size = { width: 1280, height: 720 },
): Promise<void> {
  const { html, bundle } = readEmbeddedBundle();
  edit(bundle);
  await page.setViewportSize(size);
  await page.route("http://xpl.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: withBundle(html, bundle) }),
  );
  await page.goto(`http://xpl.test/${search}`);
  await page.waitForFunction(() => window.__xpl !== undefined);
}

/** The smallest font size (screen px) of the visible text of the diagram. */
export async function smallestDiagramText(page: Page): Promise<number> {
  return page.evaluate(() => {
    const sizes = [...document.querySelectorAll<SVGTextElement>(".diagram .pz-svg text")]
      .filter((t) => t.textContent!.trim() && t.getBoundingClientRect().width > 0)
      .filter((t) => getComputedStyle(t).opacity !== "0" && !t.closest(".is-quiet"))
      .map((t) => parseFloat(getComputedStyle(t).fontSize) * (t.getScreenCTM()?.a ?? 1));
    return Math.min(...sizes);
  });
}
