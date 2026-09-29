import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { expect, type Locator, type Page } from "@playwright/test";

/** The self-contained TS fixture bundle built by global-setup.ts. */
export const TS_BUNDLE = new URL("../dist/bundles/ts-jobrunner.html", import.meta.url);
/** The Python and Go fixture bundles built by global-setup.ts (same design, other languages). */
export const PY_BUNDLE = new URL("../dist/bundles/py-jobrunner.html", import.meta.url);
export const GO_BUNDLE = new URL("../dist/bundles/go-jobrunner.html", import.meta.url);
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
  await page.goto(bundle.href);
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
