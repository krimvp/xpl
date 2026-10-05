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

test("live pins reload, reset with exact undo and export linked system, service and nested code maps", async ({
  page,
}) => {
  const dir = mkdtempSync(join(tmpdir(), "xpl-pins-e2e-"));
  cpSync(new URL("../../../fixtures/py-jobrunner", import.meta.url), dir, { recursive: true });
  const command = (args: string[]) =>
    run([...args, "--root", dir], { cwd: dir, out() {}, err() {} });
  expect(await command(["index", "--precise", "off"])).toBe(0);
  expect(await command(["new", "demo"])).toBe(0);
  expect(
    await command([
      "apply",
      "demo",
      new URL(
        "../../../skill/code-explainer/reference/examples/py-overview.patch.json",
        import.meta.url,
      ).pathname,
    ]),
  ).toBe(0);
  const patchPath = join(dir, "code.patch.json");
  writeFileSync(
    patchPath,
    JSON.stringify({
      views: [
        {
          id: "view:code",
          type: "graph",
          title: "Worker code",
          include: [
            "file:jobrunner/worker.py",
            "sym:jobrunner/worker.py#Worker",
            "sym:jobrunner/worker.py#Worker.run",
            "sym:jobrunner/worker.py#WorkerPool",
            "sym:jobrunner/worker.py#WorkerPool.lease",
          ],
          layout: {
            "sym:jobrunner/worker.py#Worker": { x: -30, y: 100 },
            "sym:jobrunner/worker.py#Worker.run": { x: 140, y: -10 },
          },
          stubs: { mode: "none" },
        },
      ],
    }),
  );
  expect(await command(["apply", "demo", patchPath])).toBe(0);
  const path = join(dir, ".explainer/demo.explainer.json");
  const saved = () => JSON.parse(readFileSync(path, "utf8"));
  const server = await startViewServer({
    env: { root: dir, cwd: dir, env: process.env, indexOption: undefined, warn() {} },
    explainerPath: path,
    host: "127.0.0.1",
    port: 0,
    viewerHtml: () => readFileSync(new URL("../dist/index.html", import.meta.url), "utf8"),
  });
  const levels = [
    ["view:system", "grp:job-runner", "Job runner"],
    ["view:overview", "file:jobrunner/worker.py", "Workers"],
    ["view:code", "sym:jobrunner/worker.py#Worker.run", "Worker.run"],
  ];
  const placements: Record<string, { x: number; y: number }> = {};
  try {
    for (const [view, id, label] of levels) {
      await page.goto(server.url + `?mode=explore&view=${view}`);
      await page.waitForFunction(() => !!window.__xpl);
      await page.evaluate((id) => window.__xpl!.select([id]), id!);
      const node = byId(page, id!);
      await expect(node).toBeVisible();
      const before = await node.evaluate((el) => {
        const t = (el as SVGGraphicsElement).transform.baseVal.getItem(0).matrix;
        return { x: t.e, y: t.f };
      });
      const handle = page.getByRole("button", { name: `Move ${label}`, exact: true });
      await handle.focus();
      for (const step of [1, 2, 3]) {
        await page.keyboard.press("ArrowRight");
        await expect
          .poll(() => saved().views.find((v: { id: string }) => v.id === view).layout?.[id!])
          .toEqual({ x: before.x + step * 20, y: before.y });
        await expect(handle).toBeFocused();
        await expect(handle).toHaveAttribute("aria-disabled", "false");
      }
      const position = { x: before.x + 60, y: before.y };
      placements[view!] = position;
      await expect
        .poll(() => saved().views.find((v: { id: string }) => v.id === view).layout?.[id!])
        .toEqual(position);
      await expect(node).toHaveAttribute("transform", `translate(${position.x} ${position.y})`);
      await page.reload();
      await page.waitForFunction(() => !!window.__xpl);
      await expect(node).toHaveAttribute("transform", `translate(${position.x} ${position.y})`);
      await page.evaluate((id) => window.__xpl!.select([id]), id!);
      await expect
        .poll(async () => (await focusOf(page)).map((f) => f.file))
        .toContain("jobrunner/worker.py");
    }
    // A real drag in a nested container follows SVG coordinates and writes only on release.
    await expect(byId(page, "file:jobrunner/worker.py").locator(".focus-ring").first()).toHaveCSS(
      "fill",
      "none",
    );
    const code = byId(page, levels[2]![1]!);
    const handle = page.getByRole("button", { name: "Move Worker.run", exact: true });
    const rect = (await handle.boundingBox())!;
    const beforeDrag = readFileSync(path, "utf8");
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width / 2 + 15, rect.y + rect.height / 2 + 15);
    await expect(code).not.toHaveAttribute(
      "transform",
      `translate(${placements["view:code"]!.x} ${placements["view:code"]!.y})`,
    );
    await page.keyboard.press("Escape");
    await expect.poll(() => selectionOf(page)).toEqual([levels[2]![1]!]);
    await page.mouse.up();
    await expect(code).toHaveAttribute(
      "transform",
      `translate(${placements["view:code"]!.x} ${placements["view:code"]!.y})`,
    );
    expect(readFileSync(path, "utf8")).toBe(beforeDrag);
    for (const interruption of ["selection", "pointercancel"] as const) {
      const at = (await handle.boundingBox())!;
      await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
      await page.mouse.down();
      await page.mouse.move(at.x + at.width / 2 + 15, at.y + at.height / 2 + 15);
      await expect(code).not.toHaveAttribute(
        "transform",
        `translate(${placements["view:code"]!.x} ${placements["view:code"]!.y})`,
      );
      if (interruption === "selection") await page.evaluate(() => window.__xpl!.select([]));
      else await handle.dispatchEvent("pointercancel");
      await page.mouse.up();
      await expect(code).toHaveAttribute(
        "transform",
        `translate(${placements["view:code"]!.x} ${placements["view:code"]!.y})`,
      );
      expect(readFileSync(path, "utf8")).toBe(beforeDrag);
      await page.evaluate((id) => window.__xpl!.select([id]), levels[2]![1]!);
    }

    const dragRect = (await handle.boundingBox())!;
    const scale = await code.evaluate((el) => (el as SVGGraphicsElement).getScreenCTM()!.a);
    const expectedDrag = {
      x: placements["view:code"]!.x + 35 / scale,
      y: placements["view:code"]!.y + 25 / scale,
    };
    await page.mouse.move(dragRect.x + dragRect.width / 2, dragRect.y + dragRect.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      dragRect.x + dragRect.width / 2 + 35,
      dragRect.y + dragRect.height / 2 + 25,
      {
        steps: 5,
      },
    );
    expect(readFileSync(path, "utf8")).toBe(beforeDrag);
    await page.mouse.up();
    await expect
      .poll(() => {
        const position = saved().views.find((v: { id: string }) => v.id === "view:code").layout[
          levels[2]![1]!
        ];
        return [Number(position.x.toFixed(3)), Number(position.y.toFixed(3))];
      })
      .toEqual([Number(expectedDrag.x.toFixed(3)), Number(expectedDrag.y.toFixed(3))]);
    await history(page);
    await expect(code).toHaveAttribute(
      "transform",
      `translate(${placements["view:code"]!.x} ${placements["view:code"]!.y})`,
    );
    const controls = await openGraphControls(page);
    await controls.getByRole("button", { name: "Reset selected placement" }).click();
    await expect
      .poll(
        () =>
          saved().views.find((v: { id: string }) => v.id === "view:code").layout[levels[2]![1]!],
      )
      .toBeUndefined();
    await history(page);
    await expect(code).toHaveAttribute(
      "transform",
      `translate(${placements["view:code"]!.x} ${placements["view:code"]!.y})`,
    );
    // Navigation does not author a graph patch.
    await controls.locator("summary").click();
    const beforeZoom = readFileSync(path, "utf8");
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    expect(readFileSync(path, "utf8")).toBe(beforeZoom);
    // A generated refresh respects existing user ownership, including 32A's group and hidden IDs.
    await page.evaluate(() => window.__xpl!.setView("view:overview"));
    await page.evaluate(() => window.__xpl!.select(["file:jobrunner/worker.py", "grp:events"]));
    const serviceControls = await openGraphControls(page);
    await serviceControls.getByLabel("Group name").fill("Execution");
    await serviceControls.getByRole("button", { name: "Group selected boxes" }).click();
    await expect(byId(page, "grp:execution")).toBeVisible();
    await page.evaluate(() => window.__xpl!.select(["file:jobrunner/__main__.py"]));
    await serviceControls.getByRole("button", { name: "Hide selected items" }).click();
    await expect(byId(page, "file:jobrunner/__main__.py")).toHaveCount(0);
    const prior = saved();
    writeFileSync(
      patchPath,
      JSON.stringify({
        remove: ["grp:execution"],
        views: [
          {
            id: "view:overview",
            title: "Regenerated parts",
            include: ["file:jobrunner/worker.py"],
            hidden: [],
            layout: {},
          },
        ],
      }),
    );
    expect(await command(["apply", "demo", patchPath])).toBe(0);
    const regenerated = saved();
    expect(regenerated.nodes.find((n: { id: string }) => n.id === "grp:execution")).toEqual(
      prior.nodes.find((n: { id: string }) => n.id === "grp:execution"),
    );
    const service = regenerated.views.find((v: { id: string }) => v.id === "view:overview");
    const priorService = prior.views.find((v: { id: string }) => v.id === "view:overview");
    expect({ include: service.include, hidden: service.hidden, layout: service.layout }).toEqual({
      include: priorService.include,
      hidden: priorService.hidden,
      layout: priorService.layout,
    });
    await page.goto(server.url + "?mode=explore&view=view:overview");
    await page.waitForFunction(() => !!window.__xpl);
    await expect(byId(page, "grp:execution")).toBeVisible();
    await expect(byId(page, "file:jobrunner/__main__.py")).toHaveCount(0);
    await (await openEditMenu(page)).getByTestId("edit-save-html").click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("save-html-draft").click(),
    ]);
    const exportPath = join(dir, "pinned.html");
    await download.saveAs(exportPath);
    await page.context().setOffline(true);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [view, id] of levels) {
        await page.goto(pathToFileURL(exportPath).href + `?perspective=map&view=${view}`);
        await page.waitForFunction(() => !!window.__xpl);
        const pos = placements[view!]!;
        const scale = () =>
          byId(page, id!).evaluate((el) =>
            Number((el as SVGGraphicsElement).getScreenCTM()!.a.toFixed(3)),
          );
        await expect.poll(scale).toBeGreaterThanOrEqual(0.9);
        await page.getByRole("button", { name: "Fit to view" }).click();
        await expect.poll(scale).toBeGreaterThanOrEqual(0.9);
        await expect(byId(page, id!)).toHaveAttribute("transform", `translate(${pos.x} ${pos.y})`);
        await page.evaluate((id) => window.__xpl!.select([id]), id!);
        await expect
          .poll(async () => (await focusOf(page)).map((f) => f.file))
          .toContain("jobrunner/worker.py");
        await expect(page.locator(".move-handle")).toHaveCount(0);
        await page.getByRole("button", { name: "Show source", exact: true }).click();
        await expect(page.locator(".cm-editor").first()).toBeVisible();
        if (view === "view:code")
          await expect(page.locator(".cm-line.xpl-hl").first()).toBeVisible();
      }
    }
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
