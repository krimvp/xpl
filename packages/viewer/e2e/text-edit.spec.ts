import { readFileSync, rmSync, cpSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "@playwright/test";
import { startViewServer } from "../../cli/src/server.js";
import { run } from "../../cli/src/cli.js";

async function command(dir: string, args: string[], stdin?: unknown): Promise<number> {
  return run([...args, "--root", dir], {
    cwd: dir,
    out() {},
    err() {},
    readStdin: async () => JSON.stringify(stdin),
  });
}
const readJson = (dir: string, path: string) => JSON.parse(readFileSync(join(dir, path), "utf8"));
const PATCH_PATH = new URL("../../cli/test/fixtures/ts-example.patch.json", import.meta.url)
  .pathname;
import { openEditMenu, openBundle, byId } from "./helpers.js";

const RUNNER = "sym:src/runner.ts#Runner.dispatch";

test("text drafts survive another box and Back to reading until explicitly cancelled", async ({
  page,
}) => {
  await openBundle(page);
  await page.evaluate(() => window.__xpl!.select(["concept:retry-policy"]));
  await page.getByTestId("text-edit").click();
  await page.getByLabel("Summary", { exact: true }).fill("Keep this retry draft.");
  await byId(page, "file:src/worker.ts").click();
  await page.evaluate(() => window.__xpl!.select(["concept:retry-policy"]));
  await expect(page.getByLabel("Summary", { exact: true })).toHaveValue("Keep this retry draft.");
  await (await openEditMenu(page)).getByTestId("edit-read").click();
  await (await openEditMenu(page)).getByTestId("edit-explore").click();
  await expect(page.getByLabel("Summary", { exact: true })).toHaveValue("Keep this retry draft.");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByTestId("text-edit").click();
  await expect(page.getByLabel("Summary", { exact: true })).toHaveValue(
    "Failed jobs are requeued with exponential backoff up to maxRetries, then dead-lettered.",
  );
});

test("the concept editor keeps Save and Cancel in the visible Details pane", async ({ page }) => {
  await openBundle(page);
  await page.evaluate(() => window.__xpl!.select(["concept:retry-policy"]));
  await page.getByTestId("text-edit").click();
  await expect(page.getByTestId("text-save")).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeInViewport({
    ratio: 1,
  });
});

test("an existing empty arrow label does not block a summary correction", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "xpl-arrow-e2e-"));
  cpSync(new URL("../../../fixtures/ts-jobrunner", import.meta.url), dir, { recursive: true });
  expect(await command(dir, ["index", "--precise", "off"])).toBe(0);
  expect(await command(dir, ["new", "demo"])).toBe(0);
  expect(await command(dir, ["apply", "demo", PATCH_PATH])).toBe(0);
  expect(
    await command(dir, ["apply", "demo", "-", "--actor", "user"], {
      edges: [{ id: "edge:job-completed", label: "" }],
    }),
  ).toBe(0);
  const server = await startViewServer({
    env: { root: dir, cwd: dir, env: process.env, indexOption: undefined, warn() {} },
    explainerPath: join(dir, ".explainer/demo.explainer.json"),
    host: "127.0.0.1",
    port: 0,
    viewerHtml: () => readFileSync(new URL("../dist/index.html", import.meta.url), "utf8"),
  });
  try {
    await page.goto(server.url + "?mode=explore");
    await page.waitForFunction(() => !!window.__xpl);
    await page.evaluate(() => window.__xpl!.select(["edge:job-completed"]));
    await page.getByTestId("text-edit").click();
    await expect(page.getByLabel("Label", { exact: true })).toHaveValue("");
    await page
      .getByLabel("Summary", { exact: true })
      .fill("Worker reports a completed job to metrics.");
    await expect(page.getByTestId("text-save")).toBeEnabled();
    await page.getByTestId("text-save").click();
    await expect(page.getByTestId("text-edit")).toBeVisible();
    expect(
      readJson(dir, ".explainer/demo.explainer.json").edges.find(
        (e: { id: string }) => e.id === "edge:job-completed",
      ),
    ).toMatchObject({ label: "", summary: "Worker reports a completed job to metrics." });
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed author save survives offline mode and retries once after reconnect", async ({
  page,
}) => {
  const dir = mkdtempSync(join(tmpdir(), "xpl-reconnect-text-e2e-"));
  cpSync(new URL("../../../fixtures/ts-jobrunner", import.meta.url), dir, { recursive: true });
  expect(await command(dir, ["index", "--precise", "off"])).toBe(0);
  expect(await command(dir, ["new", "demo"])).toBe(0);
  expect(await command(dir, ["apply", "demo", PATCH_PATH])).toBe(0);
  const copied = mkdtempSync(join(tmpdir(), "xpl-reconnect-copy-e2e-"));
  const serve = (root = dir, port = 0) =>
    startViewServer({
      env: { root, cwd: root, env: process.env, indexOption: undefined, warn() {} },
      explainerPath: join(root, ".explainer/demo.explainer.json"),
      host: "127.0.0.1",
      port,
      viewerHtml: () => readFileSync(new URL("../dist/index.html", import.meta.url), "utf8"),
      control: {
        root,
        instanceId: "text-reconnect",
        backend: "none",
        token: "local-test",
        stop() {},
      },
    });
  let server = await serve();
  let attempts = 0;
  let disconnected = true;
  await page.route("**/api/edits", async (route) => {
    attempts++;
    if (disconnected) await route.abort("connectionrefused");
    else await route.continue();
  });
  try {
    await page.goto(server.url + "?mode=explore");
    await page.waitForFunction(() => !!window.__xpl);
    await page.evaluate((id) => window.__xpl!.select([id]), RUNNER);
    await page.getByTestId("text-edit").click();
    await page.getByLabel("Summary", { exact: true }).fill("Keep the draft through reconnect.");
    await page.getByTestId("text-save").click();
    await expect(page.getByRole("alert")).toContainText("Failed to fetch");
    await page.getByRole("button", { name: "Use loaded snapshot offline" }).click();
    await expect(page.getByLabel("Summary", { exact: true })).toHaveValue(
      "Keep the draft through reconnect.",
    );
    disconnected = false;
    await page.getByRole("button", { name: "Retry connection" }).click();
    await expect(page.getByTestId("connection-status")).toContainText("Connected");
    await expect(page.getByLabel("Summary", { exact: true })).toHaveValue(
      "Keep the draft through reconnect.",
    );
    await (await openEditMenu(page)).getByTestId("edit-retry").click();
    await expect(page.getByTestId("text-edit")).toBeVisible();
    await expect(page.locator(".details .summary")).toHaveText("Keep the draft through reconnect.");
    expect(attempts).toBe(2);
    expect(
      readJson(dir, ".explainer/demo.explainer.json").nodes.find(
        (n: { id: string }) => n.id === RUNNER,
      ).summary,
    ).toBe("Keep the draft through reconnect.");
    await (await openEditMenu(page)).getByTestId("edit-undo").click();
    await expect(page.locator(".details .summary")).toHaveText(
      "The hot loop: pop, lease a worker, run, ack or requeue.",
    );
    await expect((await openEditMenu(page)).getByTestId("edit-undo")).toBeDisabled();
    await (await openEditMenu(page)).getByTestId("edit-redo").click();
    await expect(page.locator(".details .summary")).toHaveText("Keep the draft through reconnect.");
    cpSync(dir, copied, { recursive: true });
    const port = server.port;
    await page.getByRole("button", { name: "Use loaded snapshot offline" }).click();
    await server.close();
    server = await serve(copied, port);
    await page.getByRole("button", { name: "Retry connection" }).click();
    await expect(page.getByTestId("connection-status")).toContainText("Service unavailable");
    await (await openEditMenu(page)).getByTestId("edit-undo").click();
    await expect(page.locator(".save-status")).toContainText("different repository or guide");
    expect(
      readJson(copied, ".explainer/demo.explainer.json").nodes.find(
        (n: { id: string }) => n.id === RUNNER,
      ).summary,
    ).toBe("Keep the draft through reconnect.");
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(copied, { recursive: true, force: true });
  }
});

test("live text saves, reload, and undo/redo retain unrelated concurrent edits", async ({
  page,
}) => {
  const dir = mkdtempSync(join(tmpdir(), "xpl-text-e2e-"));
  cpSync(new URL("../../../fixtures/ts-jobrunner", import.meta.url), dir, { recursive: true });
  expect(await command(dir, ["index", "--precise", "off"])).toBe(0);
  expect(await command(dir, ["new", "demo"])).toBe(0);
  expect(await command(dir, ["apply", "demo", PATCH_PATH])).toBe(0);
  const server = await startViewServer({
    env: { root: dir, cwd: dir, env: process.env, indexOption: undefined, warn() {} },
    explainerPath: join(dir, ".explainer/demo.explainer.json"),
    host: "127.0.0.1",
    port: 0,
    viewerHtml: () => readFileSync(new URL("../dist/index.html", import.meta.url), "utf8"),
  });
  const node = () =>
    readJson(dir, ".explainer/demo.explainer.json").nodes.find(
      (n: { id: string }) => n.id === RUNNER,
    );
  try {
    await page.goto(server.url + "?mode=explore");
    await page.waitForFunction(() => !!window.__xpl);
    await page.evaluate((id) => window.__xpl!.select([id]), RUNNER);
    await page.getByTestId("text-edit").click();
    await page
      .getByLabel("Summary", { exact: true })
      .fill("Dispatch runs one queued job at a time.");
    await expect(page.getByText("Unsaved text draft").first()).toBeVisible();
    await page.getByTestId("text-save").click();
    await expect(page.getByTestId("text-edit")).toBeVisible();
    expect(node().summary).toBe("Dispatch runs one queued job at a time.");
    expect(node().provenance.userFields).toEqual(["summary"]);
    await page.reload();
    await page.waitForFunction(() => !!window.__xpl);
    await page.evaluate((id) => window.__xpl!.select([id]), RUNNER);
    await expect(page.locator(".details .summary")).toHaveText(
      "Dispatch runs one queued job at a time.",
    );
    expect(
      await command(dir, ["apply", "demo", "-", "--actor", "user"], {
        nodes: [{ id: RUNNER, detail: "Concurrent detail from another author." }],
      }),
    ).toBe(0);
    await page.reload();
    await page.waitForFunction(() => !!window.__xpl);
    await page.evaluate((id) => window.__xpl!.select([id]), RUNNER);
    await (await openEditMenu(page)).getByTestId("edit-undo").click();
    await expect(page.locator(".details .summary")).toHaveText(
      "The hot loop: pop, lease a worker, run, ack or requeue.",
    );
    expect(node().detail).toBe("Concurrent detail from another author.");
    await (await openEditMenu(page)).getByTestId("edit-redo").click();
    await expect(page.locator(".details .summary")).toHaveText(
      "Dispatch runs one queued job at a time.",
    );
    expect(node().detail).toBe("Concurrent detail from another author.");
    // A form retains its inspected version while another writer changes the same field.
    await page.getByTestId("text-edit").click();
    await page.getByLabel("Summary", { exact: true }).fill("My pending draft.");
    expect(
      await command(dir, ["apply", "demo", "-", "--actor", "user"], {
        nodes: [{ id: RUNNER, summary: "Another author's summary." }],
      }),
    ).toBe(0);
    await page.getByTestId("text-save").click();
    await expect(page.getByRole("alert")).toContainText("changed since you inspected it");
    expect(node().summary).toBe("Another author's summary.");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await (await openEditMenu(page)).getByTestId("edit-undo").click();
    await expect(page.locator(".save-status")).toContainText("summary changed since this edit");
    expect(node().summary).toBe("Another author's summary.");
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("offline concept corrections use the same saved-state undo and remain explicitly unsaved", async ({
  page,
}) => {
  await openBundle(page);
  await page.evaluate(() => window.__xpl!.select(["concept:retry-policy"]));
  await page.getByTestId("text-edit").click();
  await page.getByLabel("Label", { exact: true }).fill("Bounded retries");
  await page
    .getByLabel("Summary", { exact: true })
    .fill("The runner limits retries before sending work to the dead-letter queue.");
  await page.getByTestId("text-save").click();
  await expect(page.locator(".details-title")).toHaveText("Bounded retries");
  await expect(page.locator(".save-status")).toHaveText("Unsaved");
  await expect((await openEditMenu(page)).getByTestId("edit-undo")).toHaveText(
    "Undo label, summary of Bounded retries",
  );
  await (await openEditMenu(page)).getByTestId("edit-undo").click();
  await expect(page.locator(".details-title")).toHaveText("Retry policy");
  await (await openEditMenu(page)).getByTestId("edit-redo").click();
  await expect(page.locator(".details-title")).toHaveText("Bounded retries");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    (await openEditMenu(page)).getByTestId("edit-download").click(),
  ]);
  const saved = JSON.parse(readFileSync((await download.path())!, "utf8"));
  expect(saved.concepts.find((c: { id: string }) => c.id === "concept:retry-policy")).toMatchObject(
    {
      label: "Bounded retries",
      summary: "The runner limits retries before sending work to the dead-letter queue.",
    },
  );
});

test("restarting at the same address for another guide cannot inherit its undo", async ({
  page,
}) => {
  const dir = mkdtempSync(join(tmpdir(), "xpl-history-e2e-"));
  cpSync(new URL("../../../fixtures/ts-jobrunner", import.meta.url), dir, { recursive: true });
  expect(await command(dir, ["index", "--precise", "off"])).toBe(0);
  for (const name of ["a", "b"]) {
    expect(await command(dir, ["new", name])).toBe(0);
    expect(await command(dir, ["apply", name, PATCH_PATH])).toBe(0);
  }
  expect(
    await command(dir, ["apply", "b", "-", "--actor", "user"], {
      nodes: [
        {
          id: RUNNER,
          summary: "Independently authored matching summary.",
          detail: "Guide B's detail.",
        },
      ],
    }),
  ).toBe(0);
  const copied = mkdtempSync(join(tmpdir(), "xpl-history-copy-e2e-"));
  const serve = (guide: string, port = 0, root = dir) =>
    startViewServer({
      env: { root, cwd: root, env: process.env, indexOption: undefined, warn() {} },
      explainerPath: join(root, `.explainer/${guide}.explainer.json`),
      host: "127.0.0.1",
      port,
      viewerHtml: () => readFileSync(new URL("../dist/index.html", import.meta.url), "utf8"),
    });
  let server = await serve("a");
  try {
    await page.goto(server.url + "?mode=explore");
    await page.waitForFunction(() => !!window.__xpl);
    await page.evaluate((id) => window.__xpl!.select([id]), RUNNER);
    await page.getByTestId("text-edit").click();
    await page
      .getByLabel("Summary", { exact: true })
      .fill("Independently authored matching summary.");
    await page.getByTestId("text-save").click();
    await expect(page.getByTestId("text-edit")).toBeVisible();
    await expect((await openEditMenu(page)).getByTestId("edit-undo")).toBeEnabled();
    cpSync(dir, copied, { recursive: true });
    cpSync(
      join(copied, ".explainer/a.explainer.json"),
      join(copied, ".explainer/b.explainer.json"),
    );
    expect(readFileSync(join(copied, ".explainer/b.explainer.json"), "utf8")).toBe(
      readFileSync(join(dir, ".explainer/a.explainer.json"), "utf8"),
    );
    const port = server.port;
    await server.close();
    server = await serve("b", port, copied);
    // The original page still owns A's history; it must not adopt or edit B before reload either.
    await (await openEditMenu(page)).getByTestId("edit-undo").click();
    await expect(page.locator(".save-status")).toContainText("different repository or guide");
    expect(
      readJson(copied, ".explainer/b.explainer.json").nodes.find(
        (n: { id: string }) => n.id === RUNNER,
      ).summary,
    ).toBe("Independently authored matching summary.");
    await page.goto(server.url + "?mode=explore");
    await page.waitForFunction(() => !!window.__xpl);
    await page.evaluate((id) => window.__xpl!.select([id]), RUNNER);
    await expect(page.locator(".details .summary")).toHaveText(
      "Independently authored matching summary.",
    );
    await expect((await openEditMenu(page)).getByTestId("edit-undo")).toHaveCount(0);
    expect(
      readJson(copied, ".explainer/b.explainer.json").nodes.find(
        (n: { id: string }) => n.id === RUNNER,
      ).summary,
    ).toBe("Independently authored matching summary.");
    await server.close();
    server = await serve("b", port);
    await page.goto(server.url + "?mode=explore");
    await page.waitForFunction(() => !!window.__xpl);
    await page.evaluate((id) => window.__xpl!.select([id]), RUNNER);
    await expect(page.locator(".details .summary")).toHaveText(
      "Independently authored matching summary.",
    );
    await expect((await openEditMenu(page)).getByTestId("edit-undo")).toHaveCount(0);
    expect(
      readJson(dir, ".explainer/b.explainer.json").nodes.find(
        (n: { id: string }) => n.id === RUNNER,
      ).summary,
    ).toBe("Independently authored matching summary.");
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(copied, { recursive: true, force: true });
  }
});
