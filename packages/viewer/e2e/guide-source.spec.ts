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
  await expect(excerpt.locator(".guide-source-caption")).toHaveText(
    "src/runner.ts · lines 44–55 (12 of its 37 lines) · code link 1 of 2",
  );
  const action = excerpt.getByRole("button", { name: "Show code" });
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
  await expect(excerpt).toContainText("This page does not include this code");
  await expect(excerpt.locator("pre")).toHaveCount(0);
  await expect(excerpt.getByRole("button", { name: "Show code" })).toHaveCount(0);
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
  await expect(excerpt).toContainText("before the change");
  await expect(excerpt).toContainText("this.config.retry.baseDelayMs * attempts");
  await excerpt.getByRole("button", { name: "Show code" }).click();
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
      reason === "drifted" ? "The code has changed" : "No checked code",
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
  // runner.ts starts with import lines: the excerpt starts after them, at the first line that says something
  await expect(excerpt.locator(".guide-source-line").first()).not.toContainText("import");
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
  await excerpt.locator("pre").focus();
  await page.keyboard.press("Tab");
  await expect(excerpt.getByRole("button", { name: "Show code" })).toBeFocused();
});

// A tour picture fills its frame: the canvas' flex rule (`.pz-svg { height: auto }`) once left every still
// picture at the browser's default 150px, cutting the diagram under its own frame.
test("each tour picture is as tall as its frame", async ({ page }) => {
  for (const bundle of [TS_BUNDLE, CHANGE_BUNDLE]) {
    await page.goto(bundle.href);
    // (a short map picture is shorter than 150px: every picture fills its frame, and none is cut to a strip)
    await expect(page.locator(".snapshot-frame svg").first()).toBeVisible();
    const heights = await page
      .locator(".snapshot-frame:has(svg)")
      .evaluateAll((frames) =>
        frames.map((el) => [
          el.getBoundingClientRect().height,
          el.querySelector("svg")!.getBoundingClientRect().height,
        ]),
      );
    expect(Math.min(...heights.map(([frame]) => frame!))).toBeGreaterThan(60);
    for (const [frameHeight, svgHeight] of heights)
      expect(Math.abs(svgHeight! - frameHeight!)).toBeLessThan(2);
  }
});

test("a Before/Now step numbers its code links in the step's order and pages to the code before", async ({
  page,
}) => {
  const { html, bundle } = readEmbeddedBundle(CHANGE_BUNDLE);
  const edited = bundle as Parameters<Parameters<typeof openVariant>[1]>[0];
  edited.explainer.tours[0].steps = [
    {
      id: "before-now",
      view: "view:overview",
      focus: [],
      note: "Before: one delay. Now: a growing delay.",
      code: [
        {
          file: "src/runner.ts",
          at: "base",
          role: "context",
          resolved: { status: "ok", range: { startLine: 76, endLine: 77 } },
        },
        {
          file: "src/queue.ts",
          role: "definition",
          resolved: { status: "ok", range: { startLine: 1, endLine: 10 } },
        },
      ],
    },
  ];
  await page.route("http://xpl.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: withBundle(html, edited) }),
  );
  await page.goto("http://xpl.test/");
  const excerpt = page.getByRole("region", { name: "Source excerpt, step 1" });
  // the step's first code link shows first (the one its note talks about first), not the definition
  await expect(excerpt.locator(".guide-source-caption")).toHaveText(
    "src/runner.ts (before the change) · lines 76–77 · code link 1 of 2",
  );
  // the two arrows say which way they go
  await excerpt.getByRole("button", { name: "Next code link (2 of 2)" }).click();
  await expect(excerpt.locator(".guide-source-caption")).toHaveText(
    /^src\/queue\.ts · lines? \d+(–\d+)? · code link 2 of 2$/,
  );
  await excerpt.getByRole("button", { name: "Previous code link (1 of 2)" }).click();
  await expect(excerpt.locator(".guide-source-caption")).toHaveText(
    "src/runner.ts (before the change) · lines 76–77 · code link 1 of 2",
  );
  await expect(excerpt.locator("pre.is-before")).toContainText(
    "this.config.retry.baseDelayMs * attempts",
  );
});

test("a change step's excerpt marks the lines the change removes or adds, and leaves the lines around them plain", async ({
  page,
}) => {
  const { html, bundle } = readEmbeddedBundle(CHANGE_BUNDLE);
  const edited = bundle as Parameters<Parameters<typeof openVariant>[1]>[0];
  edited.explainer.tours[0].steps = [
    {
      id: "marks",
      view: "view:overview",
      focus: [],
      note: "Before: one delay. Now: a growing delay, and a cap.",
      code: [
        // base 76-77 became head 75-78; head 106-110 are new lines
        {
          file: "src/runner.ts",
          at: "base",
          role: "context",
          resolved: { status: "ok", range: { startLine: 74, endLine: 79 } },
        },
        {
          file: "src/runner.ts",
          role: "definition",
          resolved: { status: "ok", range: { startLine: 103, endLine: 110 } },
        },
      ],
    },
  ];
  await page.route("http://xpl.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: withBundle(html, edited) }),
  );
  await page.goto("http://xpl.test/");
  const excerpt = page.getByRole("region", { name: "Source excerpt, step 1" });
  const marked = (mark: string) =>
    excerpt
      .locator(`.guide-source-line.${mark} .guide-source-number`)
      .evaluateAll((els) => els.map((el) => Number(el.textContent)));
  await expect(excerpt.locator(".guide-source-caption")).toContainText("before the change");
  await expect.poll(() => marked("is-gone")).toEqual([76, 77]);
  await expect.poll(() => marked("is-add")).toEqual([]);
  // the 3px bar of a removed line sits left of its number ("76" read "/6"): the number starts 6px in
  const gap = await excerpt
    .locator(".guide-source-line.is-gone")
    .first()
    .evaluate(
      (line) =>
        line.querySelector(".guide-source-number")!.getBoundingClientRect().left -
        line.getBoundingClientRect().left,
    );
  expect(gap).toBe(6);
  // the words the rewrite changed, as in the code pane
  await expect(excerpt.locator(".xpl-word-del").first()).toBeVisible();
  await excerpt.getByRole("button", { name: "Next code link (2 of 2)" }).click();
  await expect(excerpt.locator(".guide-source-caption")).not.toContainText("before the change");
  await expect.poll(() => marked("is-add")).toEqual([106, 107, 108, 109, 110]);
  await expect.poll(() => marked("is-gone")).toEqual([]);
});
