import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { byId, openBundle, watchProblems } from "./helpers.js";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Clicks the diagram's "Save image" and returns the file it downloads. */
async function saveImage(page: Page): Promise<{ name: string; png: Buffer }> {
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save image" }).click();
  const file = await download;
  return { name: file.suggestedFilename(), png: readFileSync((await file.path())!) };
}

/** Width and height from the PNG's header chunk. */
const sizeOf = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

/** The red, green and blue of the image's top-left pixel (the background), decoded by the browser. */
const cornerOf = (page: Page, png: Buffer) =>
  page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    return [...context.getImageData(2, 2, 1, 1).data.slice(0, 3)];
  }, png.toString("base64"));

test("Save image downloads the whole map as a PNG named after the view, with the selection shown", async ({
  page,
}) => {
  const problems = watchProblems(page);
  await openBundle(page, "view:overview");
  const first = await saveImage(page);
  expect(first.name).toBe("Overview.png");
  expect([...first.png.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
  expect(first.png.length).toBeGreaterThan(10_000);

  // the whole diagram at its own size, not what the viewport shows
  for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Zoom in" }).click();
  const zoomed = await saveImage(page);
  expect(sizeOf(zoomed.png)).toEqual(sizeOf(first.png));

  await byId(page, "file:src/worker.ts").click();
  const selected = await saveImage(page);
  expect(sizeOf(selected.png)).toEqual(sizeOf(first.png));
  expect(selected.png.equals(first.png)).toBe(false);
  expect(problems).toEqual([]);
});

test("Save image keeps the theme: a light background in light, a dark one in dark", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await openBundle(page, "view:overview");
  const [lr, lg, lb] = await cornerOf(page, (await saveImage(page)).png);
  expect(Math.min(lr!, lg!, lb!)).toBeGreaterThan(200);

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const [dr, dg, db] = await cornerOf(page, (await saveImage(page)).png);
  expect(Math.max(dr!, dg!, db!)).toBeLessThan(60);
});

test("Save image works on a sequence diagram", async ({ page }) => {
  await openBundle(page, "view:dispatch");
  const { name, png } = await saveImage(page);
  expect(name).toBe("How a job is dispatched.png");
  expect([...png.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
  expect(png.length).toBeGreaterThan(10_000);
});
