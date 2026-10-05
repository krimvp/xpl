import { readFileSync, writeFileSync, rmSync, cpSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { expect, test, type Page } from "@playwright/test";
import { startViewServer } from "../../cli/src/server.js";
import { run } from "../../cli/src/cli.js";
import { openBundle, openEditMenu, byId, focusOf, selectionOf, stateOf } from "./helpers.js";

const MEMBERS = ["file:src/worker.ts", "file:src/metrics.ts"];
const EDGE = "edge:job-completed";
const GROUP = "grp:execution";
const graphControls = (page: Page) => page.getByTestId("graph-author");
async function openGraphControls(page: Page) {
  const controls = graphControls(page);
  if ((await controls.getAttribute("open")) === null) await controls.locator("summary").click();
  return controls;
}
async function group(page: Page) {
  await page.evaluate((ids) => window.__xpl!.select(ids), MEMBERS);
  const controls = await openGraphControls(page);
  await controls.getByLabel("Group name").fill("Execution");
  await controls.getByRole("button", { name: "Group selected boxes" }).click();
  await expect(byId(page, GROUP)).toBeVisible();
}
async function history(page: Page, redo = false) {
  await (await openEditMenu(page)).getByTestId(redo ? "edit-redo" : "edit-undo").click();
}

test("live graph edits persist, reload with undo, and keep linked source and exact map structure", async ({
  page,
}) => {
  const dir = mkdtempSync(join(tmpdir(), "xpl-graph-e2e-"));
  cpSync(new URL("../../../fixtures/ts-jobrunner", import.meta.url), dir, { recursive: true });
  const command = (args: string[]) =>
    run([...args, "--root", dir], { cwd: dir, out() {}, err() {} });
  expect(await command(["index", "--precise", "off"])).toBe(0);
  expect(await command(["new", "demo"])).toBe(0);
  expect(
    await command([
      "apply",
      "demo",
      new URL("../../cli/test/fixtures/ts-example.patch.json", import.meta.url).pathname,
    ]),
  ).toBe(0);
  const path = join(dir, ".explainer/demo.explainer.json");
  const initial = JSON.parse(readFileSync(path, "utf8"));
  const server = await startViewServer({
    env: { root: dir, cwd: dir, env: process.env, indexOption: undefined, warn() {} },
    explainerPath: path,
    host: "127.0.0.1",
    port: 0,
    viewerHtml: () => readFileSync(new URL("../dist/index.html", import.meta.url), "utf8"),
  });
  try {
    await page.goto(server.url + "?mode=explore&view=view:overview");
    await page.waitForFunction(() => !!window.__xpl);
    await group(page);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.nodes.find((n: { id: string }) => n.id === GROUP)).toMatchObject({
      members: MEMBERS,
      provenance: { origin: "user" },
    });
    expect(saved.edges).toEqual(initial.edges);
    expect(saved.tours).toEqual(initial.tours);
    await page.evaluate((id) => window.__xpl!.select([id]), EDGE);
    await (
      await openGraphControls(page)
    )
      .getByRole("button", { name: "Hide selected items" })
      .click();
    await expect(byId(page, EDGE)).toHaveCount(0);
    await expect.poll(() => selectionOf(page)).toEqual([]);
    await page.reload();
    await page.waitForFunction(() => !!window.__xpl);
    await expect(byId(page, GROUP)).toBeVisible();
    await expect(byId(page, EDGE)).toHaveCount(0);
    await history(page);
    await expect(byId(page, EDGE)).toBeVisible();
    await history(page, true);
    await expect(byId(page, EDGE)).toHaveCount(0);
    await (
      await openGraphControls(page)
    )
      .getByRole("button", { name: /^Restore / })
      .first()
      .click();
    await expect(byId(page, EDGE)).toBeVisible();
    await page.evaluate((id) => window.__xpl!.select([id]), MEMBERS[0]!);
    await expect
      .poll(async () => (await focusOf(page)).map((f) => f.file))
      .toEqual(["src/worker.ts"]);
    await page.evaluate((id) => window.__xpl!.select([id]), GROUP);
    await (
      await openGraphControls(page)
    )
      .getByRole("button", { name: "Ungroup in this map" })
      .click();
    await expect(byId(page, GROUP)).toHaveCount(0);
    await expect.poll(() => selectionOf(page)).toEqual([]);
    expect(
      JSON.parse(readFileSync(path, "utf8")).nodes.find((n: { id: string }) => n.id === GROUP),
    ).toMatchObject({ members: MEMBERS });
    await history(page);
    await expect(byId(page, GROUP)).toBeVisible();
    // Restore-hidden, hide and group creation are one shared history stack.
    await history(page);
    await expect(byId(page, EDGE)).toHaveCount(0);
    await history(page);
    await expect(byId(page, EDGE)).toBeVisible();
    await page.evaluate((id) => window.__xpl!.select([id]), GROUP);
    await history(page);
    await expect(byId(page, GROUP)).toHaveCount(0);
    await expect.poll(() => selectionOf(page)).toEqual([]);
    const undone = JSON.parse(readFileSync(path, "utf8"));
    expect(undone.nodes.map((n: { id: string }) => n.id)).toEqual(
      initial.nodes.map((n: { id: string }) => n.id),
    );
    expect(undone.views[0].include).toEqual(initial.views[0].include);
    expect(await command(["validate", "demo"])).toBe(0);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("offline grouping and visibility survive HTML export and remain explicit author actions", async ({
  page,
}) => {
  await openBundle(page, "view:overview");
  await group(page);
  await page.evaluate((id) => window.__xpl!.select([id]), EDGE);
  await (
    await openGraphControls(page)
  )
    .getByRole("button", { name: "Hide selected items" })
    .click();
  await expect(byId(page, EDGE)).toHaveCount(0);
  await expect(page.locator(".save-status")).toHaveText("Unsaved");
  await (await openEditMenu(page)).getByTestId("edit-save-html").click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("save-html-draft").click(),
  ]);
  const dir = mkdtempSync(join(tmpdir(), "xpl-graph-export-"));
  const path = join(dir, "saved.html");
  writeFileSync(path, readFileSync((await download.path())!, "utf8"));
  try {
    await page.context().setOffline(true);
    await page.goto(pathToFileURL(path).href + "?mode=explore&view=view:overview");
    await page.waitForFunction(() => !!window.__xpl);
    await expect(byId(page, GROUP)).toBeVisible();
    await expect(byId(page, EDGE)).toHaveCount(0);
    await (
      await openGraphControls(page)
    )
      .getByRole("button", { name: "Restore all hidden items" })
      .click();
    await expect(byId(page, EDGE)).toBeVisible();
    await page.evaluate((id) => window.__xpl!.select([id]), MEMBERS[0]!);
    await expect
      .poll(async () => (await focusOf(page)).map((f) => f.file))
      .toEqual(["src/worker.ts"]);
    await page.goto(pathToFileURL(path).href + "?perspective=map&view=view:overview");
    await page.waitForFunction(() => !!window.__xpl);
    await expect(byId(page, GROUP)).toBeVisible();
    await expect(graphControls(page)).toHaveCount(0);
    await page.evaluate(() => window.__xpl!.present("tour:intro"));
    await expect(graphControls(page)).toHaveCount(0);
    await expect.poll(async () => (await stateOf(page)).mode).toBe("present");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("regrouping visible children of a hidden container nests both boxes and keeps undo and ungroup", async ({
  page,
}) => {
  await openBundle(page, "view:overview");
  await group(page);
  await page.evaluate((id) => window.__xpl!.select([id]), GROUP);
  await (
    await openGraphControls(page)
  )
    .getByRole("button", { name: "Hide selected items" })
    .click();
  await expect(byId(page, GROUP)).toHaveCount(0);
  await expect(byId(page, MEMBERS[0]!)).toBeVisible();
  await expect(byId(page, MEMBERS[1]!)).toBeVisible();
  await page.evaluate((ids) => window.__xpl!.select(ids), MEMBERS);
  const controls = await openGraphControls(page);
  await controls.getByLabel("Group name").fill("Z new");
  await controls.getByRole("button", { name: "Group selected boxes" }).click();
  const newGroup = byId(page, "grp:z-new");
  await expect(newGroup).toBeVisible();
  await expect(newGroup.locator('[data-element-id="file:src/worker.ts"]')).toBeVisible();
  await expect(newGroup.locator('[data-element-id="file:src/metrics.ts"]')).toBeVisible();
  await history(page);
  await expect(newGroup).toHaveCount(0);
  await (
    await openGraphControls(page)
  )
    .getByRole("button", { name: "Restore all hidden items" })
    .click();
  await expect(byId(page, GROUP).locator('[data-element-id="file:src/worker.ts"]')).toBeVisible();
  await expect(byId(page, GROUP).locator('[data-element-id="file:src/metrics.ts"]')).toBeVisible();
  await history(page);
  await expect(byId(page, GROUP)).toHaveCount(0);
  await page.evaluate((ids) => window.__xpl!.select(ids), MEMBERS);
  await controls.getByLabel("Group name").fill("Z new");
  await controls.getByRole("button", { name: "Group selected boxes" }).click();
  await page.evaluate(() => window.__xpl!.select(["grp:z-new"]));
  await controls.getByRole("button", { name: "Ungroup in this map" }).click();
  await expect(newGroup).toHaveCount(0);
  await expect(byId(page, MEMBERS[0]!)).toBeVisible();
  await expect(byId(page, MEMBERS[1]!)).toBeVisible();
  await history(page);
  await expect(newGroup.locator('[data-element-id="file:src/worker.ts"]')).toBeVisible();
  await expect(newGroup.locator('[data-element-id="file:src/metrics.ts"]')).toBeVisible();
});
