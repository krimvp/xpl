/**
 * UX review screenshots: opens the fixture bundles (dist/bundles, built by the e2e global setup) and
 * captures every reading tab, Explore, Present, a selection, dark mode and narrow widths.
 *
 *   npx tsx scripts/ux-shots.ts <outDir>
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Page } from "@playwright/test";

const out = resolve(process.argv[2] ?? "ux-shots");
mkdirSync(out, { recursive: true });
const bundles = resolve("dist/bundles");

async function shot(page: Page, name: string) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(name);
}

async function open(page: Page, bundle: string, query = "") {
  await page.goto(pathToFileURL(`${bundles}/${bundle}.html`).href + query);
  await page.waitForFunction(() => !!window.__xpl);
}

const browser = await chromium.launch();
for (const scheme of ["light", "dark"] as const) {
  for (const [w, h] of [
    [1440, 900],
    [1280, 720],
  ] as const) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, colorScheme: scheme });
    const tag = `${scheme}-${w}`;
    if (scheme === "dark" && w !== 1440) {
      await page.close();
      continue;
    }
    await open(page, "ts-jobrunner");
    await shot(page, `${tag}-01-guide`);
    await page.mouse.wheel(0, 900);
    await shot(page, `${tag}-02-guide-scrolled`);
    for (const p of ["map", "flow", "code"]) {
      await page.getByTestId(`perspective-${p}`).click();
      await shot(page, `${tag}-03-${p}`);
    }
    await page.getByTestId("perspective-map").click();
    const box = page.locator("svg g[data-id]").first();
    if (await box.count()) {
      await box.click();
      await shot(page, `${tag}-04-map-selected`);
      await page.getByRole("button", { name: "Show source" }).click().catch(() => {});
      await shot(page, `${tag}-05-map-with-source`);
    }
    await page.getByTestId("edit-button").click();
    await shot(page, `${tag}-06-edit-menu`);
    await page.getByTestId("edit-explore").click();
    await shot(page, `${tag}-07-explore`);
    await page.evaluate(() => window.__xpl!.select([]));
    await page.getByTestId("mode-present").click();
    await shot(page, `${tag}-08-present-1`);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await shot(page, `${tag}-09-present-3`);
    await page.close();
  }
}
for (const [bundle, label] of [
  ["ts-change", "change"],
  ["py-architecture", "arch"],
] as const) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await open(page, bundle);
  await shot(page, `${label}-01-guide`);
  await page.mouse.wheel(0, 900);
  await shot(page, `${label}-02-guide-scrolled`);
  for (const p of ["map", "code"]) {
    await page.getByTestId(`perspective-${p}`).click();
    await shot(page, `${label}-03-${p}`);
  }
  await page.close();
}
// Small screens: a laptop split, a tablet and a phone.
for (const [w, h] of [
  [1024, 700],
  [768, 1024],
  [390, 844],
] as const) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await open(page, "ts-jobrunner");
  await shot(page, `narrow-${w}-guide`);
  await page.getByTestId("perspective-map").click();
  await shot(page, `narrow-${w}-map`);
  await page.close();
}
await browser.close();
