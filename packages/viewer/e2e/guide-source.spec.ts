import { expect, test } from "@playwright/test";
import {
  TS_BUNDLE,
  CHANGE_BUNDLE,
  readEmbeddedBundle,
  withBundle,
  openVariant,
  stateOf,
} from "./helpers.js";

test("Read shows a bounded first source excerpt and opens its exact range by keyboard", async ({
  page,
}) => {
  await openVariant(page, (bundle) => {
    bundle.explainer.tours[0].steps = [
      {
        id: "excerpt",
        view: "view:overview",
        focus: [],
        note: "Read the runner",
        code: [
          {
            file: "src/runner.ts",
            role: "definition",
            resolved: { status: "moved", range: { startLine: 44, endLine: 80 } },
          },
          {
            file: "src/queue.ts",
            role: "definition",
            resolved: { status: "ok", range: { startLine: 1, endLine: 10 } },
          },
        ],
      },
    ];
  });
  const excerpt = page.getByRole("region", { name: "Source excerpt, step 1" });
  await expect(excerpt).toContainText("src/runner.ts");
  await expect(excerpt).toContainText("const job = await this.queue.pop()");
  await expect(excerpt.locator(".guide-source-line")).toHaveCount(12);
  await expect(excerpt).toContainText("Showing lines 44–55 of 44–80");
  await expect(excerpt).toContainText("First source range of 2");
  const action = excerpt.getByRole("button", { name: "Open full code" });
  await action.focus();
  await page.keyboard.press("Enter");
  await expect
    .poll(() => stateOf(page).then((s) => s.cursor))
    .toEqual({ file: "src/runner.ts", fromLine: 44, toLine: 80, fromCol: 1, toCol: 55 });
});

test("Read explains unavailable source without substituting another anchor", async ({ page }) => {
  await openVariant(page, (bundle) => {
    delete bundle.files["src/runner.ts"];
    bundle.explainer.tours[0].steps = [
      {
        id: "missing",
        view: "view:overview",
        focus: [],
        note: "Missing source",
        code: [
          {
            file: "src/runner.ts",
            role: "definition",
            resolved: { status: "ok", range: { startLine: 44, endLine: 46 } },
          },
          {
            file: "src/queue.ts",
            role: "definition",
            resolved: { status: "ok", range: { startLine: 1, endLine: 10 } },
          },
        ],
      },
    ];
  });
  const excerpt = page.getByRole("region", { name: "Source excerpt, step 1" });
  await expect(excerpt).toContainText("Source is not available in this page");
  await expect(excerpt.locator("pre")).toHaveCount(0);
  await expect(excerpt.getByRole("button", { name: "Open full code" })).toHaveCount(0);
});

test("Read preserves before-change source and its exact navigation side", async ({ page }) => {
  const { html, bundle } = readEmbeddedBundle(CHANGE_BUNDLE);
  const edited = bundle as Parameters<Parameters<typeof openVariant>[1]>[0];
  edited.explainer.tours[0].steps = [
    {
      id: "before",
      view: "view:overview",
      focus: [],
      note: "Before the retry change",
      code: [
        {
          file: "src/runner.ts",
          at: "base",
          role: "context",
          resolved: { status: "ok", range: { startLine: 76, endLine: 77 } },
        },
      ],
    },
  ];
  await page.route("http://xpl.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: withBundle(html, edited) }),
  );
  await page.goto("http://xpl.test/");
  const excerpt = page.getByRole("region", { name: "Source excerpt, step 1" });
  await expect(excerpt).toContainText("before change");
  await expect(excerpt).toContainText("this.config.retry.baseDelayMs * attempts");
  await excerpt.getByRole("button", { name: "Open full code" }).click();
  await expect
    .poll(() => stateOf(page).then((s) => s.cursor))
    .toMatchObject({ file: "src/runner.ts", side: "base", fromLine: 76, toLine: 77 });
});

for (const reason of ["drifted", "no-anchor"] as const) {
  test(`Read does not claim a checked excerpt for ${reason}`, async ({ page }) => {
    await openVariant(page, (bundle) => {
      bundle.explainer.tours[0].steps = [
        {
          id: "unchecked",
          view: "view:overview",
          focus: [],
          note: "Uncertain source",
          ...(reason === "drifted"
            ? {
                code: [
                  {
                    file: "src/runner.ts",
                    role: "definition",
                    resolved: { status: "drifted", range: { startLine: 44, endLine: 46 } },
                  },
                ],
              }
            : {}),
        },
      ];
    });
    const excerpt = page.getByRole("region", { name: "Source excerpt, step 1" });
    await expect(excerpt).toContainText(
      reason === "drifted" ? "Source has changed" : "No checked source range",
    );
    await expect(excerpt.locator("pre")).toHaveCount(0);
  });
}

test("Read excerpts work in an offline bundle and fit a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(TS_BUNDLE.href);
  const excerpt = page.getByRole("region", { name: "Source excerpt, step 1" });
  await expect(excerpt).toContainText("src/runner.ts");
  await expect(excerpt.locator("pre")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
  await excerpt.locator("pre").focus();
  await page.keyboard.press("Tab");
  await expect(excerpt.getByRole("button", { name: "Open full code" })).toBeFocused();
});
