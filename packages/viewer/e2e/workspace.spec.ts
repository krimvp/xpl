import { expect, test } from "@playwright/test";
import {
  readEmbeddedBundle,
  screenshotPath,
  selectionOf,
  stateOf,
  TS_BUNDLE,
  watchProblems,
  withBundle,
} from "./helpers.js";

test("opens a readable guide with optional synchronized map, flow and source", async ({ page }) => {
  const problems = watchProblems(page);
  await page.goto(TS_BUNDLE.href);
  await expect(page.getByTestId("guide")).toBeVisible();
  await expect(page.locator(".editor-host")).toHaveCount(0);
  await page.getByRole("navigation", { name: "Guide contents" }).getByRole("button").nth(1).click();
  const selection = await selectionOf(page);
  await page.getByTestId("perspective-map").click();
  await expect(page.locator(".workspace-diagram svg")).toBeVisible();
  expect(await selectionOf(page)).toEqual(selection);
  await page.getByTestId("perspective-flow").click();
  await expect(page.getByTestId("process-flow")).toBeVisible();
  await expect(page.locator(".flow-projection")).toContainText("not inferred runtime branches");
  expect(await selectionOf(page)).toEqual(selection);
  await page.getByTestId("perspective-code").click();
  await expect(page.locator(".editor-host").first()).toBeVisible();
  expect(await selectionOf(page)).toEqual(selection);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  expect((await stateOf(page)).perspective).toBe("flow");
  await page.getByRole("button", { name: "Forward", exact: true }).click();
  expect((await stateOf(page)).perspective).toBe("code");
  await page.getByRole("button", { name: "Read its explanation" }).click();
  await expect(page.getByTestId("guide")).toBeVisible();
  await expect(page.locator(".guide-section.is-active")).toHaveAttribute("data-section-id", "t2");
  expect(problems).toEqual([]);
});

test("shows configuration keys, opens supporting files and restores the topic on reload", async ({
  page,
}) => {
  const problems = watchProblems(page);
  await page.goto(TS_BUNDLE.href);
  await expect(page.getByTestId("guide")).toBeVisible();
  await page.getByRole("navigation", { name: "Guide contents" }).getByRole("button").nth(1).click();
  await expect(page.getByRole("region", { name: "Related files" })).toContainText(
    "config/default.yaml",
  );
  await expect(page.locator(".resource-key")).toContainText("retry");
  await page
    .getByRole("region", { name: "Related files" })
    .getByRole("button", { name: "config/default.yaml", exact: true })
    .click();
  await expect(
    page.locator('.workspace-source .pane[data-file="config/default.yaml"]'),
  ).toBeVisible();
  await page.getByTestId("perspective-flow").click();
  const selection = await selectionOf(page);
  await page.reload();
  await expect(page.getByTestId("process-flow")).toBeVisible();
  expect(await selectionOf(page)).toEqual(selection);
  expect((await stateOf(page)).stepId).toBe("t2");
  expect(problems).toEqual([]);
});

test("renders authored decisions and labeled outcomes, linked to code", async ({ page }) => {
  const problems = watchProblems(page);
  const { html, bundle } = readEmbeddedBundle();
  const explainer = bundle.explainer as {
    views: {
      type: string;
      steps?: { id: string; shape?: string; next?: { step: string; label?: string }[] }[];
    }[];
  };
  const flow = explainer.views.find((view) => view.type === "sequence")!;
  flow.type = "flow";
  flow.steps![0]!.shape = "decision";
  flow.steps![0]!.next = [
    { step: flow.steps![1]!.id, label: "success" },
    { step: flow.steps![2]!.id, label: "failure" },
  ];
  for (const step of flow.steps!.slice(1)) {
    step.shape = "terminal";
    step.next = [];
  }
  await page.route("http://xpl.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: withBundle(html, bundle) }),
  );
  await page.goto("http://xpl.test/?perspective=flow");
  await expect(page.locator(".flow-stage polygon")).toBeVisible();
  await expect(page.locator(".flow-transition text", { hasText: "success" })).toBeVisible();
  await expect(page.locator(".flow-transition text", { hasText: "failure" })).toBeVisible();
  await expect(page.locator(".flow-projection")).toHaveCount(0);
  await page.locator('[data-element-id="dispatch:3"]').click();
  await page.getByTestId("perspective-code").click();
  await expect(page.locator('.pane[data-file="src/runner.ts"]')).toBeVisible();
  expect(problems).toEqual([]);
});

test("keeps discovered file collections collapsed and exposes loader evidence", async ({
  page,
}) => {
  const problems = watchProblems(page);
  const { html, bundle } = readEmbeddedBundle();
  const index = bundle.index as { resources?: object[] };
  index.resources = [
    {
      from: "src/runner.ts#Runner.dispatch",
      kind: "discovers",
      pattern: "src/plugins/*.ts",
      files: ["src/worker.ts", "src/queue.ts"],
      site: { startLine: 40, endLine: 40 },
      resolution: "inferred",
    },
  ];
  await page.route("http://xpl.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: withBundle(html, bundle) }),
  );
  await page.goto("http://xpl.test/");
  await expect(page.getByTestId("guide")).toBeVisible();
  await page.evaluate(() => window.__xpl!.select(["sym:src/runner.ts#Runner.dispatch"]));
  const collection = page.locator(".resource-set", { hasText: "src/plugins/*.ts" });
  await expect(collection).not.toHaveAttribute("open", "");
  await expect(collection).toContainText("2 files");
  await collection.locator("summary").first().click();
  await expect(collection).toContainText("not confirmed active plugins");
  await expect(page.locator(".editor-host")).toHaveCount(0);
  await collection.getByRole("button", { name: "src/worker.ts", exact: true }).click();
  await expect(page.locator('.workspace-source .pane[data-file="src/worker.ts"]')).toBeVisible();
  await expect(page.locator('.workspace-source .pane[data-file="src/runner.ts"]')).toBeVisible();
  expect(problems).toEqual([]);
});

for (const scheme of ["light", "dark"] as const) {
  test(`reader layout and source matching in ${scheme} theme`, async ({ page }) => {
    const problems = watchProblems(page);
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(TS_BUNDLE.href);
    await expect(page.getByTestId("guide")).toBeVisible();
    await page.screenshot({ path: screenshotPath(`workspace-guide-${scheme}`) });
    await page
      .getByRole("navigation", { name: "Guide contents" })
      .getByRole("button")
      .nth(1)
      .click();
    await page.getByTestId("perspective-flow").click();
    await expect(page.locator(".flow-stage").first()).toBeVisible();
    await page.screenshot({ path: screenshotPath(`workspace-flow-${scheme}`) });
    await page.getByRole("button", { name: "Show source", exact: true }).click();
    await page.evaluate(() => window.__xpl!.setCursor("src/runner.ts", 76));
    await expect(page.locator('[data-element-id="dispatch:3"]')).toHaveClass(/is-matched/);
    await page.screenshot({ path: screenshotPath(`workspace-source-${scheme}`) });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("perspective-guide").click();
    await page.getByRole("button", { name: "Hide source", exact: true }).click();
    await expect(page.getByTestId("perspective-code")).toBeVisible();
    await expect(page.locator('.guide-section[data-section-id="t2"]')).toBeInViewport();
    await expect(page.locator(".header")).toBeInViewport();
    expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await page.screenshot({ path: screenshotPath(`workspace-mobile-${scheme}`) });
    expect(problems).toEqual([]);
  });
}

test("restores the explanation overview through Back without restarting the first section", async ({
  page,
}) => {
  await page.goto(TS_BUNDLE.href);
  await expect(page.getByTestId("guide")).toBeVisible();
  await page.getByTestId("perspective-map").click();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByTestId("guide")).toBeVisible();
  await expect(page.locator(".guide-section.is-active")).toHaveCount(0);
  expect(await selectionOf(page)).toEqual([]);
  await expect(page.getByRole("button", { name: "Forward", exact: true })).toBeEnabled();
});

test("keeps the reader available when an associated diagram is malformed", async ({ page }) => {
  const problems = watchProblems(page);
  const { html, bundle } = readEmbeddedBundle();
  const explainer = bundle.explainer as {
    views: { type: string; include?: unknown }[];
    tours: { steps: { view: string }[] }[];
  };
  explainer.views.find((view) => view.type === "graph")!.include = null;
  explainer.tours[0]!.steps[0]!.view = "view:dispatch";
  await page.route("http://xpl.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: withBundle(html, bundle) }),
  );
  await page.goto("http://xpl.test/");
  await expect(page.getByTestId("guide")).toBeVisible();
  await page.getByTestId("perspective-map").click();
  await expect(page.locator(".diagram-message")).toContainText("shows nothing yet");
  await page.getByTestId("perspective-flow").click();
  await expect(page.locator(".flow-stage").first()).toBeVisible();
  expect(problems).toEqual([]);
});

test("offers the map, guide and code even without a tour or process model", async ({ page }) => {
  const { html, bundle } = readEmbeddedBundle();
  const explainer = bundle.explainer as { tours: object[]; views: { type: string }[] };
  explainer.tours = [];
  explainer.views = explainer.views.filter((view) => view.type === "graph");
  await page.route("http://xpl.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: withBundle(html, bundle) }),
  );
  await page.goto("http://xpl.test/");
  await expect(page.locator(".guide-fallback")).toBeVisible();
  await page.getByTestId("perspective-map").click();
  await expect(page.locator(".workspace-diagram svg")).toBeVisible();
  await page.getByTestId("perspective-flow").click();
  await expect(page.locator(".guide-path")).toContainText("no authored execution flow");
  await page.getByTestId("perspective-code").click();
  await expect(page.locator(".workspace-source .tree-panel")).toBeVisible();
});
