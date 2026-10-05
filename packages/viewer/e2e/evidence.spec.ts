import { readFileSync, writeFileSync, rmSync, cpSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { startViewServer } from "../../cli/src/server.js";
import { run } from "../../cli/src/cli.js";
import { expect, test } from "@playwright/test";
import { openBundle, openEditMenu, downloadJson, CHANGE_BUNDLE } from "./helpers.js";

// Selection goes through the read-only CodeMirror pane, not a store-only test hook.
test("selected source previews checked evidence, saves with undo, and reopens in offline HTML", async ({
  page,
}) => {
  await openBundle(page);
  await page.evaluate(() => window.__xpl!.select(["concept:retry-policy"]));
  await page.getByTestId("evidence-edit").click();
  const source = page.locator('.pane[data-file="src/runner.ts"] .cm-content').first();
  await source.click();
  await source.press("Control+Home");
  await source.press("Shift+ArrowDown");
  await expect(page.getByTestId("evidence-preview")).toContainText("Checked head: src/runner.ts");
  await expect(page.getByTestId("evidence-preview")).toContainText("file-relative, L1");
  await expect(page.getByTestId("evidence-preview")).toContainText("import");
  await page.getByRole("button", { name: "Add selected evidence", exact: true }).click();
  await page.getByRole("button", { name: "Save evidence", exact: true }).click();
  await expect(page.getByTestId("evidence-edit")).toBeVisible();
  const json = JSON.parse(readFileSync((await (await downloadJson(page)).path())!, "utf8"));
  const concept = json.concepts.find((c: { id: string }) => c.id === "concept:retry-policy");
  expect(concept.anchors.at(-1)).toMatchObject({
    file: "src/runner.ts",
    span: { from: 0, to: 0 },
    resolved: { status: "ok" },
  });
  expect(concept.provenance.origin).toBe("user");
  await (await openEditMenu(page)).getByTestId("edit-undo").click();
  await (await openEditMenu(page)).getByTestId("edit-redo").click();
  await (await openEditMenu(page)).getByTestId("edit-save-html").click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("save-html-draft").click(),
  ]);
  const html = readFileSync((await download.path())!, "utf8");
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/")) apiRequests.push(request.url());
  });
  const savedDir = mkdtempSync(join(tmpdir(), "xpl-reopen-evidence-"));
  const savedPath = join(savedDir, "repaired.html");
  writeFileSync(savedPath, html);
  await page.context().setOffline(true);
  await page.goto(pathToFileURL(savedPath).href + "?mode=explore");
  await page.waitForFunction(() => !!window.__xpl);
  await page.evaluate(() => window.__xpl!.select(["concept:retry-policy"]));
  await expect(page.locator(".details .anchor-row").last()).toContainText("src/runner.ts");
  await expect(page.locator(".details .anchor-row").last()).toContainText("L1");
  await expect(page.locator(".pane .cm-content").first()).toHaveAttribute("aria-readonly", "true");
  expect(apiRequests).toEqual([]);
  await expect((await openEditMenu(page)).getByTestId("edit-undo")).toHaveCount(0);
  rmSync(savedDir, { recursive: true, force: true });
});

test("a base-pane selection is previewed and saved against the change base, never head symbols", async ({
  page,
}) => {
  await openBundle(page, undefined, CHANGE_BUNDLE);
  await page.evaluate(() => window.__xpl!.select(["concept:retry-policy"]));
  await page.locator(".details .anchor-row").filter({ hasText: "before" }).first().click();
  await page.getByTestId("evidence-edit").click();
  const source = page.locator('.pane[data-file="src/runner.ts"][data-side="base"] .cm-content');
  await source.click();
  await source.press("Control+Home");
  await source.press("Shift+ArrowDown");
  await expect(page.getByTestId("evidence-preview")).toContainText("Checked base: src/runner.ts");
  await expect(page.getByTestId("evidence-preview")).toContainText("file-relative, L1");
  await page.getByRole("button", { name: "Add selected evidence", exact: true }).click();
  await page.getByRole("button", { name: "Save evidence", exact: true }).click();
  await expect(page.getByTestId("evidence-edit")).toBeVisible();
  const json = JSON.parse(readFileSync((await (await downloadJson(page)).path())!, "utf8"));
  const anchor = json.concepts
    .find((c: { id: string }) => c.id === "concept:retry-policy")
    .anchors.at(-1);
  expect(anchor).toMatchObject({
    at: "base",
    file: "src/runner.ts",
    span: { from: 0, to: 0 },
    resolved: { commit: "1111111111111111111111111111111111111111", status: "ok" },
  });
  expect(anchor.symbol).toBeUndefined();
});

async function command(root: string, args: string[], patch?: unknown) {
  let error = "";
  const code = await run([...args, "--root", root], {
    cwd: root,
    out() {},
    err: (s) => {
      error += s;
    },
    readStdin: async () => JSON.stringify(patch),
  });
  expect(code, error).toBe(0);
}

test("live repair rejects incomplete and stale evidence, persists explicit repair/removal and protects later LLM revisions", async ({
  page,
}) => {
  const root = mkdtempSync(join(tmpdir(), "xpl-evidence-e2e-"));
  cpSync(new URL("../../../fixtures/ts-jobrunner", import.meta.url), root, { recursive: true });
  await command(root, ["index", "--precise", "off"]);
  await command(root, ["new", "demo"]);
  await command(root, [
    "apply",
    "demo",
    new URL("../../cli/test/fixtures/ts-example.patch.json", import.meta.url).pathname,
    "--actor",
    "llm",
  ]);
  const path = join(root, ".explainer/demo.explainer.json");
  const original = readFileSync(path, "utf8");
  const sourcePath = join(root, "src/runner.ts");
  writeFileSync(
    sourcePath,
    readFileSync(sourcePath, "utf8").replace(
      "const backoff = backoffDelay",
      "const backoff = 2 * backoffDelay",
    ),
  );
  rmSync(join(root, "test/retry.test.ts"));
  await command(root, ["index", "--precise", "off"]);
  const server = await startViewServer({
    env: { root, cwd: root, env: process.env, indexOption: undefined, warn() {} },
    explainerPath: path,
    host: "127.0.0.1",
    port: 0,
    viewerHtml: () => readFileSync(new URL("../dist/index.html", import.meta.url), "utf8"),
  });
  let writes = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/edits")) writes++;
  });
  const open = async () => {
    await page.goto(server.url + "?mode=explore");
    await page.waitForFunction(() => !!window.__xpl);
    await page.evaluate(() => window.__xpl!.select(["concept:retry-policy"]));
    await page.getByTestId("evidence-edit").click();
  };
  const select = async () => {
    await page.evaluate(() => window.__xpl!.setCursor("src/runner.ts", 75));
    await expect(page.getByTestId("evidence-preview")).toContainText(
      "symbol-relative to Runner.dispatch, L75",
    );
    await page.getByLabel("Evidence role", { exact: true }).selectOption("definition");
  };
  try {
    await open();
    await expect(page.locator('.evidence-list li[data-status="drifted"]')).toHaveCount(1);
    await expect(page.locator('.evidence-list li[data-status="missing"]')).toHaveCount(1);
    await select();
    await page
      .locator('.evidence-list li[data-status="drifted"]')
      .getByRole("button", { name: "Replace with selected lines" })
      .click();
    await page.getByRole("button", { name: "Save evidence", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText(
      'file "test/retry.test.ts" is not in the index',
    );
    expect(writes).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(original);
    await page
      .locator('.evidence-list li[data-status="missing"]')
      .getByRole("button", { name: "Remove evidence" })
      .click();
    // The checked candidate is stale by the time the server re-reads source under the lock.
    writeFileSync(
      sourcePath,
      readFileSync(sourcePath, "utf8").replace("2 * backoffDelay", "3 * backoffDelay"),
    );
    await page.getByRole("button", { name: "Save evidence", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("stale anchor");
    expect(writes).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(original);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await command(root, ["index", "--precise", "off"]);
    await open();
    await select();
    await page
      .locator('.evidence-list li[data-status="drifted"]')
      .getByRole("button", { name: "Replace with selected lines" })
      .click();
    await page
      .locator('.evidence-list li[data-status="missing"]')
      .getByRole("button", { name: "Remove evidence" })
      .click();
    // Draft survives navigating to a different target and back.
    await page.evaluate(() => window.__xpl!.select(["file:src/worker.ts"]));
    await page.evaluate(() => window.__xpl!.select(["concept:retry-policy"]));
    await expect(page.getByText("Unsaved evidence draft", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Save evidence", exact: true }).click();
    await expect(page.getByTestId("evidence-edit")).toBeVisible();
    const saved = JSON.parse(readFileSync(path, "utf8")).concepts[0];
    expect(saved.anchors).toHaveLength(2);
    expect(saved.anchors[0]).toMatchObject({
      file: "src/runner.ts",
      symbol: "Runner.dispatch",
      span: { from: 33, to: 33 },
      role: "definition",
      resolved: { status: "ok" },
    });
    expect(saved.provenance.userFields).toEqual(["anchors"]);
    await page.reload();
    await page.waitForFunction(() => !!window.__xpl);
    await page.evaluate(() => window.__xpl!.select(["concept:retry-policy"]));
    await expect(page.locator('.details .anchor-row[data-status="ok"]')).toHaveCount(2);
    await (await openEditMenu(page)).getByTestId("edit-undo").click();
    await expect(page.locator(".save-status")).toContainText("stale anchor");
    expect(JSON.parse(readFileSync(path, "utf8")).concepts[0].anchors).toEqual(saved.anchors);
    await command(root, ["apply", "demo", "-", "--actor", "llm"], {
      concepts: [
        {
          id: "concept:retry-policy",
          anchors: [{ file: "absent.ts", role: "usage" }],
          detail: "Generated detail still joins the repaired evidence.",
        },
      ],
    });
    expect(JSON.parse(readFileSync(path, "utf8")).concepts[0]).toMatchObject({
      anchors: saved.anchors,
      detail: "Generated detail still joins the repaired evidence.",
    });
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const width of [1440, 390]) {
  test(`disabled evidence Save keeps its reason visible at ${width}px with three anchors`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await openBundle(page);
    await page.evaluate(() => window.__xpl!.select(["concept:retry-policy"]));
    await page.getByTestId("evidence-edit").click();
    await expect(page.locator(".evidence-list li")).toHaveCount(3);
    const form = page.locator(".evidence-edit");
    await form.evaluate((form) => form.scrollIntoView({ block: "start" }));
    await expect(page.getByRole("button", { name: "Save evidence", exact: true })).toBeDisabled();
    await expect(form.getByText("No changes", { exact: true })).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("button", { name: "Save evidence", exact: true })).toBeInViewport({
      ratio: 1,
    });
  });
}
