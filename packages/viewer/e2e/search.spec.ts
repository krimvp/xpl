import { expect, test } from "@playwright/test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { injectBundle, parseBundle, hashText } from "@xpl/core";
import { readEmbeddedBundle, stateOf, watchProblems, openEditMenu, toExplore } from "./helpers.js";

// A real file:// page: no service can fill in omitted source or guide snapshots.
test("offline library searches supplied source and prose, opens exact links and switches bounded guides", async ({
  page,
}) => {
  const problems = watchProblems(page);
  const dir = mkdtempSync(join(tmpdir(), "xpl-search-export-"));
  try {
    const { html, bundle: raw } = readEmbeddedBundle();
    const bundle = parseBundle(JSON.stringify(raw));
    bundle.guideId = "repository";
    bundle.files["src/metrics.ts"] = "x".repeat(2 * 1024 * 1024) + "needle-search-literal";
    const index = {
      ...bundle.index,
      symbols: [],
      refs: [],
      pruned: {
        files: bundle.index.files.length,
        symbols: bundle.index.symbols.length,
        refs: bundle.index.refs.length,
      },
    };
    delete index.analysis;
    bundle.guides = [
      {
        guideId: "retry.json",
        explainer: { ...bundle.explainer, title: "Retry subsystem" },
        index,
        files: { "src/queue.ts": bundle.files["src/queue.ts"]! },
      },
    ];
    const url = pathToFileURL(join(dir, "library.html")).href;
    writeFileSync(join(dir, "library.html"), injectBundle(html, bundle, { packIndex: true }));
    await page.goto(url);
    await page.getByRole("button", { name: "Search and guides" }).click();
    const panel = page.getByRole("dialog", { name: "Search and guides" });
    const input = panel.getByRole("searchbox", { name: "Search this snapshot" });
    await input.fill("needle-search-literal");
    const longLine = panel.locator('[data-kind="source"]').first();
    await expect(longLine).toContainText("needle-search-literal");
    expect((await longLine.innerText()).length).toBeLessThan(500);
    await input.fill("requeue");
    const source = panel.locator('[data-kind="source"]').filter({ hasText: "requeue" }).first();
    await expect(source).toBeVisible();
    const link = await source.getAttribute("href");
    expect(link).toMatch(/file=src%2Fqueue.ts.*range=/);
    await source.click();
    await expect(panel).toHaveCount(0);
    await expect.poll(() => stateOf(page).then((s) => s.openedFile)).toBe("src/queue.ts");
    await page.locator('[data-file="src/queue.ts"] .cm-content').first().focus();
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("requeue");
    await page.reload();
    await page.locator('[data-file="src/queue.ts"] .cm-content').first().focus();
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("requeue");
    await page.getByRole("button", { name: "Search and guides" }).click();
    await input.fill("retry");
    await expect(panel.locator('[data-kind="concept"]').first()).toBeVisible();
    await expect(panel.locator('[data-kind="symbol"]').first()).toBeVisible();
    await input.fill("Where failures go");
    const step = panel.locator('[data-kind="step"]').first();
    await expect(step).toBeVisible();
    await step.click();
    await expect.poll(() => stateOf(page).then((s) => s.stepId)).toBe("t2");
    await expect(page).toHaveURL(/step-id=t2/);
    await page.reload();
    await expect.poll(() => stateOf(page).then((s) => s.stepId)).toBe("t2");
    await page.getByRole("button", { name: "Search and guides" }).click();
    await panel.getByRole("link", { name: /Retry subsystem/ }).click();
    await expect(page.locator(".header .title")).toHaveText("Retry subsystem");
    await page.getByRole("button", { name: "Search and guides" }).click();
    await expect(panel).toContainText("Analysis unavailable");
    await expect(panel).toContainText("pruned");
    await expect(panel).toContainText("not included in this export");
    await input.fill("no-such-phrase-12345");
    await expect(panel.getByRole("status")).toContainText("No matches in the supplied snapshot");
    await expect(panel).toContainText("Analysis unavailable");
    await panel.getByRole("button", { name: "Close search" }).click();
    await (await openEditMenu(page)).getByTestId("edit-save-html").click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("save-html-draft").click(),
    ]);
    const saved = join(dir, "saved-library.html");
    await download.saveAs(saved);
    await page.goto(pathToFileURL(saved).href);
    await expect(page.locator(".header .title")).toHaveText("Retry subsystem");
    await page.getByRole("button", { name: "Search and guides" }).click();
    await panel.getByRole("link", { name: /Job runner/ }).click();
    await expect(page.locator(".header .title")).toHaveText("Job runner");
    expect(problems).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source saturation keeps symbols and explanations reachable through bounded group pages", async ({
  page,
}) => {
  const dir = mkdtempSync(join(tmpdir(), "xpl-search-saturated-"));
  try {
    const { html, bundle: raw } = readEmbeddedBundle();
    const bundle = parseBundle(JSON.stringify(raw));
    bundle.files["src/metrics.ts"] +=
      "\n" + Array.from({ length: 100 }, (_, i) => `// requeue usage ${i}`).join("\n");
    bundle.index.files.find((f) => f.path === "src/metrics.ts")!.hash = hashText(
      bundle.files["src/metrics.ts"]!,
    );
    bundle.explainer.tours[0]!.steps[1]!.note = "Requeue failed jobs with the retry policy.";
    writeFileSync(join(dir, "saturated.html"), injectBundle(html, bundle));
    await page.goto(pathToFileURL(join(dir, "saturated.html")).href);
    await page.getByRole("button", { name: "Search and guides" }).click();
    const panel = page.getByRole("dialog", { name: "Search and guides" });
    await panel.getByRole("searchbox").fill("requeue");
    await expect(panel.locator('[data-kind="source"]')).toHaveCount(16);
    await expect(panel.locator('[data-kind="symbol"]').first()).toBeVisible();
    await expect(panel.locator('[data-kind="concept"]').first()).toBeVisible();
    await expect(
      panel.locator('[data-kind="step"]').filter({ hasText: "Requeue failed jobs" }),
    ).toBeVisible();
    const source = panel.getByRole("region", { name: "Source" });
    await expect(source).toContainText("1–16 of 112 matches");
    await source.getByRole("button", { name: "Next Source results" }).click();
    await expect(source).toContainText("17–32 of 112 matches");
    await expect(panel.locator('[data-kind="source"]')).toHaveCount(16);
    await expect(panel.locator('[data-kind="symbol"]').first()).toBeVisible();
    await source.getByRole("button", { name: "Previous Source results" }).click();
    await expect(source).toContainText("1–16 of 112 matches");
    await panel.locator('[data-kind="step"]').filter({ hasText: "Requeue failed jobs" }).click();
    await expect.poll(() => stateOf(page).then((s) => s.stepId)).toBe("t2");
    await page.getByRole("button", { name: "Search and guides" }).click();
    await panel.getByRole("searchbox").fill("requeue");
    await panel.locator('[data-kind="symbol"]').first().click();
    await expect.poll(() => stateOf(page).then((s) => s.openedFile)).toBe("src/queue.ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("live catalog stays scoped to its attachment and switching refuses unsaved drafts", async ({
  page,
}) => {
  const { html, bundle: raw } = readEmbeddedBundle();
  const bundle = parseBundle(JSON.stringify(raw));
  bundle.guideId = "repository";
  bundle.server = {
    api: "/api",
    attachment: { root: "/repo", guide: ".explainer/repository.explainer.json" },
  };
  const preview = {
    ...bundle,
    guideId: "retry.json",
    explainer: { ...bundle.explainer, title: "Retry subsystem" },
    server: undefined,
    readOnlyGuide: {
      stopCommand: "xpl service stop --root '/repo'",
      command: "xpl service start '.explainer/retry.json.explainer.json' --root '/repo'",
    },
  };
  const requests: string[] = [];
  await page.route("http://xpl.test/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/")
      return route.fulfill({
        contentType: "text/html",
        body: injectBundle(html, url.searchParams.get("guide") === "retry.json" ? preview : bundle),
      });
    requests.push(url.pathname);
    if (url.pathname === "/api/guides") {
      expect(
        JSON.parse(decodeURIComponent(route.request().headers()["x-xpl-attachment"]!)),
      ).toEqual(bundle.server!.attachment);
      return route.fulfill({
        json: {
          guides: [
            {
              id: "retry.json",
              title: "Retry subsystem",
              kind: "subsystem",
              commit: "snapshot",
              indexCommit: "snapshot",
              questions: ["When does retry stop?"],
              roots: ["file:src/queue.ts"],
              audience: "Operators",
            },
          ],
          errors: [],
        },
      });
    }
    if (url.pathname === "/api/explainer") return route.fulfill({ status: 304 });
    if (url.pathname === "/api/requests") return route.fulfill({ json: { requests: [] } });
    if (url.pathname === "/favicon.ico") return route.fulfill({ status: 204 });
    return route.fulfill({ status: 404 });
  });
  await page.goto(
    "http://xpl.test/?perspective=explore&view=view:overview&focus=concept:retry-policy",
  );
  await page.getByTestId("text-edit").click();
  await page.getByLabel("Summary", { exact: true }).fill("Unsaved operator explanation.");
  await page.getByRole("button", { name: "Search and guides" }).click();
  const panel = page.getByRole("dialog", { name: "Search and guides" });
  await expect(panel).toContainText("Repository guides");
  await expect(panel).toContainText("When does retry stop?");
  await expect(panel).toContainText("For Operators");
  const next = panel.getByRole("link", { name: /Retry subsystem/ });
  await next.click();
  await expect(panel.getByRole("alert")).toContainText("Save or cancel drafts and pending edits");
  await expect(page.locator(".header .title")).toHaveText("Job runner");
  await panel.getByRole("button", { name: "Close search" }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Search and guides" }).click();
  await next.click();
  await expect(page.locator(".header .title")).toHaveText("Retry subsystem");
  await expect(page.getByText("Read-only guide preview.", { exact: false })).toContainText(
    "xpl service start",
  );
  await expect(page.locator(".read-only-guide code")).toHaveText([
    "xpl service stop --root '/repo'",
    "xpl service start '.explainer/retry.json.explainer.json' --root '/repo'",
  ]);
  await toExplore(page);
  await page.evaluate(() => window.__xpl!.select(["concept:retry-policy"]));
  await expect(page.getByTestId("text-edit")).toBeDisabled();
  await expect(page.getByTestId("evidence-edit")).toBeDisabled();
  const prior = requests.length;
  await page.getByRole("button", { name: "Search and guides" }).click();
  await expect(panel).toContainText("Contained guides");
  expect(requests.slice(prior)).toEqual([]);
  await expect(panel.getByRole("link", { name: "Back to library" })).toHaveAttribute("href", "./");
  await panel.getByRole("link", { name: "Back to library" }).click();
  await expect(page.locator(".header .title")).toHaveText("Job runner");
  await page.getByRole("button", { name: "Search and guides" }).click();
  await expect(panel).toContainText("Repository guides");
  await expect(panel).toContainText("When does retry stop?");
});

for (const width of [1440, 390]) {
  test(`search covers open map author controls at ${width}px and restores placement access`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(
      new URL("../dist/bundles/ts-jobrunner.html", import.meta.url).href +
        "?mode=explore&perspective=explore&view=view:overview",
    );
    await page.waitForFunction(() => !!window.__xpl);
    await page.evaluate(() => window.__xpl!.select(["file:src/worker.ts"]));
    const author = page.getByTestId("graph-author");
    await author.locator("summary").click();
    await expect(author.getByRole("button", { name: "Reset selected placement" })).toBeVisible();
    await page.getByRole("button", { name: "Search and guides" }).click();
    const panel = page.getByRole("dialog", { name: "Search and guides" });
    await expect(panel).toBeVisible();
    await expect
      .poll(() =>
        author.locator(".graph-author-controls").evaluate((controls) => {
          const rect = controls.getBoundingClientRect();
          const x = rect.x + rect.width / 2;
          const y = rect.y + 30;
          return Boolean(document.elementFromPoint(x, y)?.closest(".search-backdrop"));
        }),
      )
      .toBe(true);
    await panel.getByRole("button", { name: "Close search" }).click();
    await expect(panel).toBeHidden();
    await expect(author.getByRole("button", { name: "Reset selected placement" })).toBeVisible();
    await page.getByRole("button", { name: "Move worker.ts", exact: true }).focus();
    await expect(page.getByRole("button", { name: "Move worker.ts", exact: true })).toBeFocused();
  });
}
