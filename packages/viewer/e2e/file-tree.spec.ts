/**
 * The file tree lists what can be opened. A static bundle (`xpl bundle`, no server) embeds only the files
 * the explainer needs by default, so its tree lists only those and says how many of the indexed files
 * that is; under `xpl view` every indexed file is listed and fetched when it is opened. TOML files are
 * indexed as `toml` and shown as plain text.
 */
import { expect, test, type Page } from "@playwright/test";
import { byId, readEmbeddedBundle, stateOf, watchProblems, withBundle } from "./helpers.js";

/** The embedded bundle is edited as loose JSON: many shapes, none worth typing here. */
type Loose = Record<string, any>;

/** The twelve files of the TS fixture. */
const ALL = [
  "README.md",
  "config/default.yaml",
  "package.json",
  "src/bus.ts",
  "src/config.ts",
  "src/main.ts",
  "src/metrics.ts",
  "src/queue.ts",
  "src/runner.ts",
  "src/worker.ts",
  "test/retry.test.ts",
  "tsconfig.json",
];

async function openVariant(page: Page, edit: (bundle: Loose) => void): Promise<void> {
  const { html, bundle } = readEmbeddedBundle();
  edit(bundle);
  await page.route("http://xpl.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: withBundle(html, bundle) }),
  );
  await page.goto("http://xpl.test/?mode=explore");
  await page.waitForFunction(() => window.__xpl !== undefined);
}

const listed = (page: Page) =>
  page
    .locator(".tree-row.is-file")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-path")));

test("a bundle that embeds every file lists them all, with no footer", async ({ page }) => {
  const problems = watchProblems(page);
  await openVariant(page, () => undefined);
  expect((await listed(page)).sort()).toEqual([...ALL].sort());
  await expect(page.getByTestId("tree-foot")).toHaveCount(0);
  expect(problems).toEqual([]);
});

test("a static bundle lists only the files it embeds and says how many that is", async ({
  page,
}) => {
  const problems = watchProblems(page);
  const left = [
    "config/default.yaml",
    "src/queue.ts",
    "src/runner.ts",
    "src/worker.ts",
    "src/metrics.ts",
  ];
  await openVariant(page, (bundle) => {
    const files = bundle.files as Record<string, string>;
    for (const path of Object.keys(files)) if (!left.includes(path)) delete files[path];
  });
  // only what is embedded, folders included: `test/` has nothing left
  expect((await listed(page)).sort()).toEqual([...left].sort());
  await expect(page.locator('.tree-row.is-dir[data-path="test"]')).toHaveCount(0);
  await expect(page.locator('.tree-row.is-dir[data-path="src"]')).toBeVisible();
  await expect(page.locator('.tree-row.is-dir[data-path="config"]')).toBeVisible();
  const foot = page.getByTestId("tree-foot");
  await expect(foot).toHaveText("5 of 12 files included · rebuild with --files all");
  await expect(foot).toBeVisible();

  // An embedded file opens; a click on one that is not listed cannot happen, but what the explainer
  // points at still says why there is no code (the concept has an anchor in test/retry.test.ts).
  await page.locator('.tree-row[data-path="src/queue.ts"]').click();
  await expect(page.locator('[data-file="src/queue.ts"] .cm-editor')).toBeVisible();
  await page.evaluate(() => window.__xpl!.setView("view:dispatch"));
  await byId(page, "concept:retry-policy").click();
  await expect(page.locator('[data-file="test/retry.test.ts"] .pane-message')).toContainText(
    "not included in this bundle",
  );
  // the focus marks the files that are listed and greys the others
  await expect(page.locator('.tree-row[data-path="src/runner.ts"]')).toHaveClass(/is-focus/);
  await expect(page.locator('.tree-row[data-path="src/worker.ts"]')).toHaveClass(/is-dimmed/);
  await expect(foot).toBeVisible();
  expect(problems).toEqual([]);
});

test("a bundle with no source at all still says so", async ({ page }) => {
  await openVariant(page, (bundle) => {
    bundle.files = {};
  });
  expect(await listed(page)).toEqual([]);
  await expect(page.getByTestId("tree-foot")).toHaveText(
    "0 of 12 files included · rebuild with --files all",
  );
});

test("under xpl view every indexed file is listed, and fetched when it is opened", async ({
  page,
}) => {
  const { html, bundle } = readEmbeddedBundle();
  const files = bundle.files as Record<string, string>;
  const withheld: Record<string, string> = {};
  for (const path of ["src/bus.ts", "src/main.ts", "README.md", "test/retry.test.ts"]) {
    withheld[path] = files[path]!;
    delete files[path];
  }
  bundle.server = { api: "/api" };
  const fetched: string[] = [];
  await page.route("http://xpl.test/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/") {
      return route.fulfill({ contentType: "text/html", body: withBundle(html, bundle) });
    }
    if (url.pathname === "/api/file") {
      const path = url.searchParams.get("path")!;
      fetched.push(path);
      return route.fulfill({ contentType: "text/plain", body: withheld[path] ?? "" });
    }
    return route.fulfill({ status: 404, body: "not found" });
  });
  await page.goto("http://xpl.test/?mode=explore");
  await page.waitForFunction(() => window.__xpl !== undefined);

  expect((await stateOf(page)).serverMode).toBe(true);
  expect((await listed(page)).sort()).toEqual([...ALL].sort());
  await expect(page.getByTestId("tree-foot")).toHaveCount(0);
  await page.locator('.tree-row[data-path="src/bus.ts"]').click();
  await expect(page.locator('[data-file="src/bus.ts"] .cm-editor')).toBeVisible();
  expect(fetched).toEqual(["src/bus.ts"]);
});

test.describe("TOML", () => {
  const TOML = ["[server]", 'host = "0.0.0.0"', "port = 8080", "", "[log]", 'level = "info"'].join(
    "\n",
  );

  test("a .toml file is language toml: listed, opened as plain text, labelled toml", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await openVariant(page, (bundle) => {
      bundle.index.files.push({
        path: "config/app.toml",
        language: "toml",
        hash: "sha256:0",
        lines: 6,
      });
      bundle.files["config/app.toml"] = TOML;
    });
    const row = page.locator('.tree-row[data-path="config/app.toml"]');
    await expect(row).toBeVisible();
    await row.click();
    const pane = page.locator('[data-file="config/app.toml"]');
    await expect(pane.locator(".cm-editor")).toBeVisible();
    await expect(pane.locator(".pane-meta")).toHaveText("toml · 6 lines");
    await expect(pane.locator(".cm-line")).toHaveCount(6);
    await expect(pane.locator(".cm-line").first()).toHaveText("[server]");
    // plain text: CodeMirror has no TOML mode here, so no line carries highlighting spans ...
    await expect(pane.locator(".cm-line span")).toHaveCount(0);
    // ... where a YAML file next to it does
    await page.locator('.tree-row[data-path="config/default.yaml"]').click();
    const yaml = page.locator('[data-file="config/default.yaml"]');
    await expect(yaml.locator(".pane-meta")).toContainText("yaml ·");
    await expect(yaml.locator(".cm-line span").first()).toBeVisible();
    expect(problems).toEqual([]);
  });
});

test("a PHP source file is listed, opened and labeled with its indexed language", async ({
  page,
}) => {
  const problems = watchProblems(page);
  await openVariant(page, (bundle) => {
    bundle.index.files.push({
      path: "src/Runner.php",
      language: "php",
      hash: "sha256:0",
      lines: 3,
    });
    bundle.files["src/Runner.php"] = "<?php\nclass Runner {}\n";
  });
  const row = page.locator('.tree-row[data-path="src/Runner.php"]');
  await expect(row).toBeVisible();
  await row.click();
  const pane = page.locator('[data-file="src/Runner.php"]');
  await expect(pane.locator(".cm-editor")).toBeVisible();
  await expect(pane.locator(".pane-meta")).toHaveText("php · 3 lines");
  await expect(pane.locator(".cm-line").nth(1)).toHaveText("class Runner {}");
  expect(problems).toEqual([]);
});
