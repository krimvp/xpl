/**
 * The frame around a diagram: what the first view and "Fit all" show, and how much of the screen the
 * diagram gets. The floating zoom toolbar never covers a box of a fitted diagram; on a phone the diagram gets
 * most of the screen; the Tour has no empty right column.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  ARCHITECTURE_BUNDLE,
  byId,
  GO_BUNDLE,
  openVariant,
  PY_BUNDLE,
  smallestDiagramText,
  TS_BUNDLE,
  watchProblems,
  type Loose,
} from "./helpers.js";

/** Ids of the map's boxes the zoom toolbar overlaps. */
const boxesUnderToolbar = (page: Page) =>
  page.evaluate(() => {
    const bar = [...document.querySelectorAll<HTMLElement>(".pz-toolbar")]
      .find((el) => el.offsetParent !== null)!
      .getBoundingClientRect();
    return [...document.querySelectorAll(".pz-svg .nodes g[data-element-id]")]
      .filter((g) => {
        const r = g.getBoundingClientRect();
        return r.left < bar.right && r.right > bar.left && r.top < bar.bottom && r.bottom > bar.top;
      })
      .map((g) => (g as SVGElement).dataset.elementId);
  });

test.describe("the zoom toolbar never covers a box of a fitted map", () => {
  for (const width of [1440, 1280, 1024, 390]) {
    test(`${width}px wide: Read > Map with the code open, Explore, and the system map`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 700 });
      const check = async () => {
        await expect(page.locator(".pz-svg .nodes g[data-element-id]").first()).toBeVisible();
        // the first view, then "Fit all"
        await expect.poll(() => boxesUnderToolbar(page)).toEqual([]);
        const fit = page.getByTestId("pz-fit");
        await expect(fit).toHaveText(/^Fit all/);
        await fit.click();
        await expect.poll(() => boxesUnderToolbar(page)).toEqual([]);
      };
      await page.goto(`${TS_BUNDLE.href}?perspective=map`);
      await page.waitForFunction(() => window.__xpl !== undefined);
      await check();
      if (width > 640) {
        await page.getByRole("button", { name: "Show code" }).first().click();
        await check();
      }
      await page.goto(`${TS_BUNDLE.href}?mode=explore`);
      await check();
      await page.goto(`${ARCHITECTURE_BUNDLE.href}?perspective=map`);
      await check();
    });
  }
});

/** The width of the diagram's canvas, and the ids of the boxes not wholly inside it. */
const canvas = (page: Page) =>
  page.evaluate(() => {
    const svg = [...document.querySelectorAll(".pz-svg")].find(
      (el) => el.getBoundingClientRect().width > 0,
    )!;
    const pane = svg.getBoundingClientRect();
    const cut = [...svg.querySelectorAll(".nodes g[data-element-id]")]
      .filter((g) => {
        const r = g.getBoundingClientRect();
        return (
          r.left < pane.left - 1 ||
          r.right > pane.right + 1 ||
          r.top < pane.top - 1 ||
          r.bottom > pane.bottom + 1
        );
      })
      .map((g) => (g as SVGElement).dataset.elementId);
    return { width: Math.round(pane.width), cut };
  });

test.describe("while no code is on screen the diagram takes the code column's width", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Explore: the file list alone beside the diagram, the code column with the first selection", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await page.goto(`${TS_BUNDLE.href}?mode=explore&view=view:overview`);
    await expect(page.getByTestId("code-idle")).toHaveText(
      "Click a box, an arrow or a step to see its code.",
    );
    // the editor column is gone: the diagram has all but the file list (220px) and the padding
    await expect.poll(async () => (await canvas(page)).width).toBeGreaterThan(1150);
    await expect.poll(async () => (await canvas(page)).cut).toEqual([]);
    expect(await smallestDiagramText(page)).toBeGreaterThanOrEqual(9);
    // a file in the list is still one click away
    await expect(page.locator('.tree-row[data-path="src/queue.ts"]')).toBeVisible();
    // a box clicked: its code shows, beside a diagram as wide as the split says (52% of 1440)
    await byId(page, "file:src/worker.ts").first().click();
    await expect(page.locator(".right .editor-stack .pane").first()).toBeVisible();
    await expect(page.getByTestId("code-idle")).toHaveCount(0);
    await expect.poll(async () => (await canvas(page)).width).toBeLessThan(760);
    expect(problems).toEqual([]);
  });

  test("Map: Show code with nothing selected leaves the map its width, and says how to fill it", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await page.goto(`${TS_BUNDLE.href}?perspective=map`);
    await expect(page.locator(".pz-svg .nodes g[data-element-id]").first()).toBeVisible();
    const before = (await canvas(page)).width;
    await page.locator(".workspace-location").getByRole("button", { name: "Show code" }).click();
    await expect(page.getByTestId("code-waiting")).toHaveText(
      "Click a box, an arrow or a step to see its code.",
    );
    await expect(page.locator(".workspace-source")).toHaveCount(0);
    expect((await canvas(page)).width).toBe(before);
    // the first box clicked brings the code column (and its file's code)
    await byId(page, "file:src/worker.ts").first().click();
    await expect(page.locator(".workspace-source .editor-stack .pane").first()).toBeVisible();
    await expect(page.getByTestId("code-waiting")).toHaveCount(0);
    await expect.poll(async () => (await canvas(page)).width).toBeLessThan(before - 300);
    expect(problems).toEqual([]);
  });
});

/**
 * in Explore, while nothing is selected, Concepts and Details are one line under the diagram, so
 * a tall sequence or flow opens whole at 1440x900. The first selection opens the panels, once.
 */
test.describe("Explore with nothing selected gives the diagram the height", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  /** The canvas's size, the ids of the steps and lifelines not wholly in it, the strip's height. */
  const explore = (page: Page) =>
    page.evaluate(() => {
      const svg = document.querySelector(".explore .pz-svg")!;
      const pane = svg.getBoundingClientRect();
      const cut = [
        ...svg.querySelectorAll(
          ":is(g.step, .lifeline-head, .flow-stage, .nodes g)[data-element-id]",
        ),
      ]
        .filter((g) => {
          const r = g.getBoundingClientRect();
          return (
            r.left < pane.left - 1 ||
            r.right > pane.right + 1 ||
            r.top < pane.top - 1 ||
            r.bottom > pane.bottom + 1
          );
        })
        .map((g) => (g as SVGElement).dataset.elementId);
      const strip = document.querySelector<HTMLElement>("[data-testid=lower-folded]");
      return {
        height: Math.round(pane.height),
        cut: [...new Set(cut)],
        strip: strip ? Math.round(strip.getBoundingClientRect().height) : 0,
      };
    });

  for (const [name, bundle] of [
    ["TS", TS_BUNDLE],
    ["Python", PY_BUNDLE],
    ["Go", GO_BUNDLE],
  ] as const) {
    test(`${name}: the dispatch sequence opens whole, at 11px text or more`, async ({ page }) => {
      const problems = watchProblems(page);
      await page.goto(`${bundle.href}?mode=explore&view=view:dispatch`);
      await expect(page.locator(".explore .lifeline-head").first()).toBeVisible();
      await expect.poll(async () => (await explore(page)).cut).toEqual([]);
      const open = await explore(page);
      // (900 less the header, the strip and a banner: 432-464 with the panels open)
      expect(open.height).toBeGreaterThan(700);
      expect(open.strip).toBeLessThanOrEqual(44);
      expect(await smallestDiagramText(page)).toBeGreaterThanOrEqual(11);
      expect(problems).toEqual([]);
    });
  }

  test("a 6-stage flow opens whole at 10.5px or more; a concept chip opens the panels with its details", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await openVariant(
      page,
      (bundle) => {
        const view = bundle.explainer.views.find((v: Loose) => v.id === "view:dispatch");
        const template = view.steps[0];
        view.type = "flow";
        view.frames = [];
        view.steps = Array.from({ length: 6 }, (_, i) => ({
          ...structuredClone(template),
          id: `dispatch:${i + 1}`,
          label: `Stage ${i + 1} of the flow`,
          shape: i === 5 ? "terminal" : "stage",
          next: i === 5 ? [] : [{ step: `dispatch:${i + 2}` }],
        }));
      },
      "?mode=explore&view=view:dispatch",
      { width: 1440, height: 900 },
    );
    await expect(page.locator(".explore .flow-stage").first()).toBeVisible();
    await expect.poll(async () => (await explore(page)).cut).toEqual([]);
    // (with the panels open, 464px: three stages at the flow's 11px floor)
    expect((await explore(page)).height).toBeGreaterThan(700);
    expect(await smallestDiagramText(page)).toBeGreaterThanOrEqual(10.5);
    // the concept is a chip on the strip; its click opens Details above the code, the diagram keeps its height
    const before = (await explore(page)).height;
    await page.getByRole("button", { name: "Retry policy" }).click();
    await expect(
      page.locator('.right .details[data-details-id="concept:retry-policy"]'),
    ).toBeVisible();
    await expect.poll(async () => (await explore(page)).height).toBe(before);
    // clearing the selection keeps Details: the diagram does not move again
    await page.keyboard.press("Escape");
    await expect(page.locator(".right .details")).toBeVisible();
    expect(problems).toEqual([]);
  });

  /**
   * The first selection brings the code and Details. Details goes into the code column, above the code: the
   * diagram keeps its height and re-fits once, to what was selected.
   */
  test("a step selected in a long sequence: the pane keeps 700px or more, and the frame moves to the step and both its lifelines", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    const lanes = ["main", "runner", "queue", "worker", "bus", "metrics"].map(
      (name) => `file:src/${name}.ts`,
    );
    await openVariant(
      page,
      (bundle) => {
        const view = bundle.explainer.views.find((v: Loose) => v.id === "view:dispatch");
        const template = view.steps[0];
        view.participants = lanes;
        view.frames = [];
        view.steps = Array.from({ length: 16 }, (_, i) => ({
          ...structuredClone(template),
          id: `dispatch:${i + 1}`,
          from: lanes[i % 3],
          to: lanes[(i % 3) + 3],
          label: `call number ${i + 1}`,
        }));
      },
      "?mode=explore&view=view:dispatch",
      { width: 1440, height: 900 },
    );
    await expect(page.locator(".explore .lifeline-head").first()).toBeVisible();
    // the last step starts out of sight, as does the step before it
    const away = ["dispatch:15", "dispatch:16"];
    await expect
      .poll(async () => (await explore(page)).cut.filter((id) => away.includes(id!)))
      .toEqual(away);
    await page.evaluate(() => window.__xpl!.select(["dispatch:16"]));
    await expect(page.locator(".right .editor-stack .pane").first()).toBeVisible();
    await expect(page.locator(".right .details")).toBeVisible();
    await expect.poll(async () => (await explore(page)).height).toBeGreaterThan(700);
    // it, the step before it and both its lifelines (main to worker) come into view
    await expect
      .poll(async () => {
        const cut = (await explore(page)).cut;
        return [...away, lanes[0], lanes[3]].filter((id) => cut.includes(id!));
      })
      .toEqual([]);
    expect(problems).toEqual([]);
  });

  test("a box clicked on the map: the pane keeps 700px or more and every box stays whole", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await page.goto(`${TS_BUNDLE.href}?mode=explore&view=view:overview`);
    await expect(page.locator(".explore .nodes g[data-element-id]").first()).toBeVisible();
    await byId(page, "file:src/worker.ts").first().click();
    await expect(page.locator(".right .editor-stack .pane").first()).toBeVisible();
    await expect.poll(async () => (await explore(page)).height).toBeGreaterThan(700);
    await expect.poll(async () => (await explore(page)).cut).toEqual([]);
    expect(problems).toEqual([]);
  });
});

test.describe("a phone gives the diagram most of the screen", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  /** The share of the screen's height the element shows of itself, on arrival (no scrolling). */
  const shareOfScreen = (page: Page, selector: string) =>
    page.evaluate((selector) => {
      const el = [...document.querySelectorAll(selector)].find(
        (candidate) => candidate.getBoundingClientRect().height > 0,
      )!;
      const r = el.getBoundingClientRect();
      const shown = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
      return shown / innerHeight;
    }, selector);

  for (const { name, url } of [
    { name: "a system map", url: `${ARCHITECTURE_BUNDLE.href}?perspective=map` },
    { name: "a map", url: `${TS_BUNDLE.href}?perspective=map` },
    { name: "a sequence", url: `${TS_BUNDLE.href}?perspective=flow` },
  ]) {
    test(`${name}: the canvas is at least 55% of the screen's height`, async ({ page }) => {
      const problems = watchProblems(page);
      await page.goto(url);
      await page.waitForFunction(() => window.__xpl !== undefined);
      await expect(page.locator(".workspace .pz-svg").first()).toBeVisible();
      await expect.poll(() => shareOfScreen(page, ".workspace .pz-svg")).toBeGreaterThan(0.55);
      // what the caption held is one tap away (a caption with only "Explore all diagrams" to hide shows it
      // and has no disclosure)
      const about = page.getByRole("button", { name: /^About this (map|flow)$/ });
      if (name === "a map") await expect(about).toHaveCount(0);
      else {
        await expect(about).toHaveAttribute("aria-expanded", "false");
        await about.click();
      }
      await expect(page.getByTestId("explore-link")).toBeVisible();
      expect(problems).toEqual([]);
    });
  }

  test("Tour, then Flow: the flow opens at its top with the code closed; its steps are one tap away", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await page.goto(TS_BUNDLE.href);
    await expect(page.getByTestId("guide")).toBeVisible();
    await page.getByTestId("perspective-flow").click();
    await expect(page.locator(".workspace-caption h2")).toBeInViewport();
    await expect
      .poll(() => page.locator(".workspace-columns").evaluate((el) => el.scrollTop))
      .toBe(0);
    await expect(page.locator(".workspace-source")).toHaveCount(0);
    await expect(
      page.locator(".workspace-location").getByRole("button", { name: "Show code" }),
    ).toBeVisible();
    // the step selected in the Tour is no reason for a link to the list: clear it, then use the link
    await page.keyboard.press("Escape");
    await expect.poll(() => page.evaluate(() => window.__xpl!.selection())).toEqual([]);
    await expect(page.getByTestId("parts-panel")).not.toBeInViewport({ ratio: 1 });
    await page.getByTestId("caption-steps").click();
    await expect(page.getByTestId("parts-panel")).toBeInViewport({ ratio: 1 });
    expect(problems).toEqual([]);
  });

  test("Map: Hide code after reading the code down the page takes the reader back up to the map", async ({
    page,
  }) => {
    await page.goto(`${TS_BUNDLE.href}?perspective=map`);
    const columns = page.locator(".workspace-columns");
    await page.getByRole("button", { name: "Show code" }).click();
    await byId(page, "file:src/worker.ts").first().click();
    await expect(page.locator(".workspace-source .cm-editor").first()).toBeVisible();
    await columns.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect.poll(() => columns.evaluate((el) => el.scrollTop)).toBeGreaterThan(300);
    await page.getByRole("button", { name: "Hide code" }).click();
    await expect(page.locator(".workspace-source")).toHaveCount(0);
    await expect.poll(() => columns.evaluate((el) => el.scrollTop)).toBe(0);
    await expect(page.locator(".workspace-caption h2")).toBeInViewport();
  });

  test("the Code tab with no file open shows the whole file list, and a hint at its own height", async ({
    page,
  }) => {
    await page.goto(`${TS_BUNDLE.href}?perspective=code`);
    await expect(page.locator(".tree-row").first()).toBeVisible();
    const layout = () =>
      page.evaluate(() => {
        const tree = document.querySelector(".workspace .tree-panel")!.getBoundingClientRect();
        const rows = [...document.querySelectorAll(".workspace .tree-row")];
        const hint = document.querySelector(".workspace .editor-stack.is-empty")!;
        return {
          clipped: rows.filter((row) => row.getBoundingClientRect().bottom > tree.bottom + 1)
            .length,
          hintTaller: hint.getBoundingClientRect().height > 300,
        };
      });
    await expect.poll(layout).toEqual({ clipped: 0, hintTaller: false });
  });

  test("the matrix gets the same height as the map", async ({ page }) => {
    await openVariant(
      page,
      (bundle) => {
        bundle.explainer.views.find((v: Loose) => v.id === "view:overview").render = "matrix";
      },
      "?perspective=map",
      { width: 390, height: 844 },
    );
    await expect(page.getByRole("grid")).toBeVisible();
    await expect
      .poll(() => shareOfScreen(page, ".workspace-diagram .matrix"))
      .toBeGreaterThan(0.55);
  });
});

test("the Tour decides its right column once per tour, so the text never changes width", async ({
  page,
}) => {
  await page.goto(TS_BUNDLE.href);
  await expect(page.getByTestId("guide")).toBeVisible();
  // step 2 lists a settings file, so the column is there from step 1 on, which lists its own code
  await expect(page.locator(".workspace-context")).toBeVisible();
  await expect(page.getByTestId("step-code")).toContainText("runner.ts");
  const width = () =>
    page.locator('.guide-section[data-section-id="t1"]').evaluate((el) => el.clientWidth);
  const before = await width();
  await page
    .locator('.guide-section[data-section-id="t2"]')
    .evaluate((el) => el.scrollIntoView({ block: "start" }));
  await expect(page.getByRole("region", { name: "This step's code" })).toContainText(
    "config/default.yaml",
  );
  expect(await width()).toBe(before);
  // a tour without any related files has no right column at all
  await openVariant(page, (bundle) => {
    for (const tour of bundle.explainer.tours as Loose[])
      for (const step of tour.steps as Loose[]) {
        step.focus = ["grp:scheduling"];
        delete step.code;
      }
  });
  await expect(page.getByTestId("guide")).toBeVisible();
  await expect(page.locator(".workspace-context")).toBeHidden();
});

test("a Tour step with no related files lists its own code, which opens it; a phone shows no bar for it", async ({
  page,
}) => {
  await page.goto(TS_BUNDLE.href);
  const place = page.getByTestId("step-code").getByRole("button").first();
  await expect(place).toHaveText(/^runner\.ts, lines? \d+/);
  await place.click();
  await expect(page.locator(".workspace-source .pane-file").first()).toContainText("runner.ts");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(TS_BUNDLE.href);
  await expect(page.getByTestId("guide")).toBeVisible();
  await expect(page.locator(".workspace-context")).toBeHidden();
});

/**
 * Present: a slide keeps the 12px text floor. A diagram that does not read whole at that size in the
 * 40% column gets a wider one (up to 65%) and then fits whole; one still too big starts on the step's focus,
 * with the lifelines its arrows join in the frame, and "Fit all" in sight without a mouse. The text card is as
 * tall as its text (at most 40% of the column), and "Fit all" sits in the title bar, never on a box.
 */
test.describe("Present keeps the 12px floor and widens the diagram column", () => {
  const FILES = ["main", "runner", "queue", "worker", "bus", "metrics", "config"].map(
    (name) => `file:src/${name}.ts`,
  );
  const addTour = (bundle: Loose) => {
    const views = bundle.explainer.views as Loose[];
    const files = (id: string, title: string, include: string[]) =>
      views.push({
        id,
        type: "graph",
        title,
        scope: { root: "repo", depth: 1 },
        include,
        provenance: { origin: "llm" },
        stubs: { mode: "none" },
      });
    files("view:files", "Every file", FILES);
    // four lifelines, one arrow from the first to each: wide and short, whole at 12px only in a wider column
    const four = FILES.slice(0, 4);
    views.push({
      id: "view:four",
      type: "sequence",
      title: "Four parts",
      scope: { root: "repo", depth: 1 },
      participants: four,
      steps: four.slice(1).map((to, i) => ({
        id: `four:${i + 1}`,
        from: four[0]!,
        to,
        label: `call ${i + 1}`,
        kind: "call",
      })),
      provenance: { origin: "llm" },
    });
    // a long sequence: twelve arrows over six lifelines, the step talked about the last one, at the right
    const lanes = FILES.slice(1);
    views.push({
      id: "view:long",
      type: "sequence",
      title: "A long run",
      scope: { root: "repo", depth: 1 },
      participants: lanes,
      steps: Array.from({ length: 12 }, (_, i) => ({
        id: `long:${i + 1}`,
        from: lanes[i % 3]!,
        to: lanes[(i % 3) + 3]!,
        label: `call number ${i + 1}`,
        kind: "call",
      })),
      provenance: { origin: "llm" },
    });
    (bundle.explainer.tours as Loose[]).unshift({
      id: "tour:d7",
      title: "Wide slides",
      steps: [
        { id: "s1", view: "view:files", focus: [FILES[1]], note: "One line." },
        {
          id: "s2",
          view: "view:long",
          focus: ["long:12"],
          note: "A longer note. ".repeat(12).trim(),
        },
        // (with code on the slide: a step without any gives the diagram the whole width)
        {
          id: "s3",
          view: "view:four",
          focus: ["four:1"],
          note: "One line.",
          code: [
            {
              file: "src/worker.ts",
              role: "definition",
              resolved: { status: "ok", range: { startLine: 1, endLine: 8 } },
            },
          ],
        },
      ],
    });
  };
  /**
   * The slide: the diagram column's share of the width, boxes not wholly in the pane, the smallest text, is
   * "Fit all" on the slide (and does it cross a box), and the text card's height as a share of the column
   * (with the room its text leaves empty).
   */
  const slide = (page: Page) =>
    page.evaluate(() => {
      const pane = document.querySelector(".present-left .pz-svg")!.getBoundingClientRect();
      const left = document.querySelector(".present-left")!.getBoundingClientRect();
      const inside = (el: Element) => {
        const r = el.getBoundingClientRect();
        return (
          r.left >= pane.left - 1 &&
          r.right <= pane.right + 1 &&
          r.top >= pane.top - 1 &&
          r.bottom <= pane.bottom + 1
        );
      };
      const sizes = [...document.querySelectorAll<SVGTextElement>(".present-left .pz-svg text")]
        .filter((t) => t.textContent!.trim() && t.getBoundingClientRect().width > 0)
        .map((t) => parseFloat(getComputedStyle(t).fontSize) * (t.getScreenCTM()?.a ?? 1));
      const fit = document.querySelector<HTMLElement>(".present [data-testid=pz-fit]")!;
      const bar = fit.closest<HTMLElement>(".pz-toolbar")!;
      const chip = fit.getBoundingClientRect();
      const boxes = [
        ...document.querySelectorAll(
          ".present-left :is(.nodes g, .lifelines .lifeline-head)[data-element-id]",
        ),
      ];
      const caption = document.querySelector<HTMLElement>("[data-testid=tour-caption]")!;
      return {
        column: Math.round((left.width / innerWidth) * 100) / 100,
        cut: boxes.filter((g) => !inside(g)).map((g) => (g as SVGElement).dataset.elementId),
        smallest: Math.min(...sizes),
        fitShown: fit.offsetParent !== null && getComputedStyle(bar).opacity === "1",
        cue: fit.classList.contains("is-cue"),
        chipOnBox: boxes.some((g) => {
          const r = g.getBoundingClientRect();
          return (
            r.left < chip.right && r.right > chip.left && r.top < chip.bottom && r.bottom > chip.top
          );
        }),
        caption: caption.offsetHeight / left.height,
        captionSpare: caption.clientHeight - caption.scrollHeight,
      };
    });

  test("1440x900: the map reads whole in the 40% column; the text card is as tall as its text", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await openVariant(page, addTour, "?mode=present&tour=tour:d7", { width: 1440, height: 900 });
    await expect(page.getByTestId("present")).toHaveAttribute("data-step", "1");
    await expect(page.locator(".present-left .nodes g[data-element-id]").first()).toBeVisible();
    await expect
      .poll(() => slide(page))
      .toMatchObject({ cut: [], column: 0.4, fitShown: false, chipOnBox: false, captionSpare: 0 });
    const one = await slide(page);
    expect(one.smallest).toBeGreaterThanOrEqual(11.9);
    // (one line of text: far less than the 40% the card may take)
    expect(one.caption).toBeLessThan(0.2);

    // a sequence too tall for any column: the step's arrow and both its lifelines in the frame, at 12px or
    // more, "Fit all" on the slide while the mouse has not moved, on no box; the longer note, a taller card
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("present")).toHaveAttribute("data-step", "2");
    await expect
      .poll(() => slide(page))
      .toMatchObject({ fitShown: true, cue: true, chipOnBox: false, captionSpare: 0 });
    const two = await slide(page);
    expect(two.smallest).toBeGreaterThanOrEqual(11.9);
    expect(two.caption).toBeGreaterThan(one.caption);
    expect(two.caption).toBeLessThanOrEqual(0.4);
    const pane = await page.locator(".present-left .pz-svg").boundingBox();
    for (const id of ["long:12", "file:src/worker.ts", "file:src/config.ts"]) {
      // (a lifeline: its head, which stays at the top of the pane as the diagram moves)
      const box = await page
        .locator(`.present-left [data-element-id="${id}"]`)
        .first()
        .boundingBox();
      expect(box, id).not.toBeNull();
      expect(box!.x, id).toBeGreaterThanOrEqual(pane!.x - 1);
      expect(box!.x + box!.width, id).toBeLessThanOrEqual(pane!.x + pane!.width + 1);
    }
    expect(problems).toEqual([]);
  });

  test("1280x720: a diagram too wide for 40% gets a wider column and reads whole; a bigger one starts on its focus", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await openVariant(page, addTour, "?mode=present&tour=tour:d7&step=3", {
      width: 1280,
      height: 720,
    });
    // four lifelines: whole at 12px only in a wider column than 40%, which it gets (the middle case: a wider column, then whole)
    await expect(page.getByTestId("present")).toHaveAttribute("data-step", "3");
    await expect(page.locator(".present-left .pz-svg text").first()).toBeVisible();
    await expect
      .poll(() => slide(page))
      .toMatchObject({ cut: [], fitShown: false, chipOnBox: false });
    const four = await slide(page);
    expect(four.column).toBeGreaterThan(0.45);
    expect(four.column).toBeLessThan(0.65);
    expect(four.smallest).toBeGreaterThanOrEqual(11.9);
    // seven files: too big even at 65%: the step's box in the frame, "Fit all" in the title bar
    await page.keyboard.press("Home");
    await expect(page.getByTestId("present")).toHaveAttribute("data-step", "1");
    await expect
      .poll(() => slide(page))
      .toMatchObject({ column: 0.64, fitShown: true, cue: true, chipOnBox: false });
    const seven = await slide(page);
    expect(seven.cut).not.toContain(FILES[1]);
    expect(seven.smallest).toBeGreaterThanOrEqual(11.9);
    expect(problems).toEqual([]);
  });

  // `xpl draft map` writes one step about every box of its map. A frame of part of that map started on
  // a corner, with the boxes at its left edge cut mid-word, while the Map tab fits all of them.
  const SUMMARIES = [
    "Starts the job runner with three sample jobs, runs them, and prints what happened.",
    "Takes the next job, gives it to a free worker, and retries it later with a growing delay.",
    "Keeps waiting jobs in priority order and holds jobs that failed too often.",
    "Runs one job with the handler for its kind and reports the result, with a time limit.",
    "Sends a message to the parts that asked for it when a job succeeds, so they can react.",
    "Counts the jobs that succeeded, by kind, adds up their run time, and prints the totals.",
    "Reads the settings file and turns it into values such as worker count and retry delays.",
  ];
  const addMapTour = (bundle: Loose) => {
    addTour(bundle);
    const labels = [
      "Demo program",
      "Dispatcher",
      "Job queue",
      "Workers",
      "Events",
      "Counters",
      "Settings",
    ];
    (bundle.explainer.nodes as Loose[]).push(
      ...FILES.map((id, i) => ({
        id,
        kind: "file",
        label: labels[i],
        summary: SUMMARIES[i],
        anchors: [],
        provenance: { origin: "llm" },
      })),
    );
    const files = (bundle.explainer.views as Loose[]).find((view) => view.id === "view:files")!;
    files.boxText = "summary";
    (bundle.explainer.tours as Loose[]).unshift({
      id: "tour:map",
      title: "Every part",
      steps: [{ id: "m1", view: "view:files", focus: FILES, note: "Every part of the runner." }],
    });
  };
  for (const size of [
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
  ])
    test(`${size.width}x${size.height}: a step about every box of a map starts with all of them whole`, async ({
      page,
    }) => {
      const problems = watchProblems(page);
      await openVariant(page, addMapTour, "?mode=present&tour=tour:map", size);
      await expect(page.locator(".present-left .nodes g[data-element-id]")).toHaveCount(7);
      await expect.poll(async () => (await slide(page)).cut).toEqual([]);
      await expect(page.getByTestId("pz-fit")).not.toContainText("out of sight");
      expect(problems).toEqual([]);
    });
});

test("Present: the slide's title bar keeps no room for Save image and Text view, so the title is whole", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${ARCHITECTURE_BUNDLE.href}?mode=present&step=2`);
  await expect(page.getByTestId("present")).toHaveAttribute("data-step", "2");
  const title = page.locator(".present .diagram-caption .caption-title");
  await expect(title).toBeVisible();
  await expect.poll(() => title.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
  // (the two buttons are there, only out of the slide)
  await expect(page.locator(".present .pz-toolbar .pz-save")).toBeHidden();
  await expect(page.locator(".present .pz-toolbar .pz-text")).toBeHidden();
});

test("a view's question shows its `code` as code, and a slide cut short gives all of it on hover", async ({
  page,
}) => {
  const ask = (bundle: Loose) => {
    const view = bundle.explainer.views.find((v: Loose) => v.id === "view:dispatch");
    view.scope.question =
      "How does `Runner.dispatch` hand a job to a worker, and what happens when it fails?";
  };
  await openVariant(page, ask, "?perspective=flow", { width: 1440, height: 900 });
  await expect(page.locator(".view-question code")).toHaveText("Runner.dispatch");
  await expect(page.locator(".view-question")).not.toContainText("`");
  await openVariant(page, ask, "?mode=present&step=2", { width: 1280, height: 720 });
  const question = page.locator(".present .caption-question");
  await expect(question.locator("code")).toHaveText("Runner.dispatch");
  await expect(question).toHaveAttribute(
    "title",
    "How does Runner.dispatch hand a job to a worker, and what happens when it fails?",
  );
});

test("Present: the hidden zoom buttons leave the question the title bar's width", async ({
  page,
}) => {
  await openVariant(
    page,
    (bundle: Loose) => {
      const view = bundle.explainer.views.find((v: Loose) => v.id === "view:dispatch");
      view.scope.question = "How does the runner hand a job to a worker?";
    },
    "?mode=present&step=2",
    { width: 1280, height: 720 },
  );
  const question = page.locator(".present .caption-question");
  await expect(question).toBeVisible();
  await expect.poll(() => question.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
});

test("Present: a step with no code gives the diagram the code's width, and a screen reader hears each step's title", async ({
  page,
}) => {
  await openVariant(
    page,
    (bundle: Loose) => {
      // step 1 shows a box with no code link of its own and names no code
      const step = bundle.explainer.tours[0].steps[0];
      step.focus = [];
      delete step.code;
    },
    "?mode=present",
    { width: 1440, height: 900 },
  );
  const present = page.getByTestId("present");
  await expect(present).toHaveAttribute("data-step", "1");
  await expect(present).toHaveAttribute("data-code", "none");
  await expect(page.locator(".present-right")).toBeHidden();
  // (the slide's padding is 8px on each side)
  await expect
    .poll(async () => Math.round((await page.locator(".present-left").boundingBox())!.width))
    .toBe(1440 - 16);
  const announce = page.getByTestId("tour-announce");
  await expect(announce).toHaveText(/^Step 1 of 2: .+/);
  await page.keyboard.press("ArrowRight");
  await expect(present).toHaveAttribute("data-step", "2");
  await expect(present).not.toHaveAttribute("data-code", "none");
  await expect(page.locator(".present-right")).toBeVisible();
  await expect(announce).toHaveText(/^Step 2 of 2: .+/);
  await expect(announce).toHaveAttribute("aria-live", "polite");
});

test("the Code tab with a file open and nothing selected gives the code the whole width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${TS_BUNDLE.href}?perspective=code`);
  await page.locator('.tree-row[data-path="src/queue.ts"]').click();
  await expect(page.locator(".workspace-source .pane").first()).toBeVisible();
  await expect(page.locator(".workspace-context")).toBeHidden();
  const right = await page
    .locator(".workspace-source")
    .evaluate((el) => Math.round(el.getBoundingClientRect().right));
  expect(right).toBe(1440);
});

test("J and K step through the Tour, and the list of steps says so", async ({ page }) => {
  await page.goto(TS_BUNDLE.href);
  await expect(page.getByTestId("guide")).toBeVisible();
  await expect(page.getByTestId("guide-keys")).toHaveText("Keys: J next step, K previous step.");
  const step = () => page.evaluate(() => window.__xpl!.state().stepId);
  await expect.poll(step).toBe("t1");
  await page.keyboard.press("j");
  await expect.poll(step).toBe("t2");
  await expect(page.locator('.guide-section[data-section-id="t2"]')).toBeInViewport();
  // (the last step: J does nothing more)
  await page.keyboard.press("j");
  await expect.poll(step).toBe("t2");
  await page.keyboard.press("k");
  await expect.poll(step).toBe("t1");
  // a text field keeps its letters: real key presses into the search box
  await page.getByRole("button", { name: "Search and guides" }).click();
  const box = page.getByRole("searchbox");
  await box.pressSequentially("jk");
  await expect(box).toHaveValue("jk");
  await expect.poll(step).toBe("t1");
  await page.keyboard.press("Escape");
  // ... and so do the code beside the Tour and the Edit menu
  await page.locator(".workspace-location").getByRole("button", { name: "Show code" }).click();
  const code = page.locator(".workspace-source .cm-content").first();
  await code.click();
  await expect(code).toBeFocused();
  await page.keyboard.press("j");
  await expect(page.getByTestId("guide")).toBeVisible();
  await expect.poll(step).toBe("t1");
  await page.getByTestId("edit-button").click();
  await expect(page.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("j");
  await expect.poll(step).toBe("t1");
});

test.describe("the phone caption's disclosure", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("says whether it is open, names what it controls, and leaves the diagram picker in sight", async ({
    page,
  }) => {
    await page.goto(ARCHITECTURE_BUNDLE.href + "?perspective=map&view=view:overview");
    await page.waitForFunction(() => window.__xpl !== undefined);
    const about = page.getByRole("button", { name: "About this map" });
    await expect(about).toHaveAttribute("aria-expanded", "false");
    const controls = await about.getAttribute("aria-controls");
    await expect(page.locator(`[id="${controls}"]`)).toHaveCount(1);
    // the picker is a control, not "about" text: in sight while the details are closed
    await expect(page.getByRole("combobox", { name: "Choose a diagram" })).toBeVisible();
    await expect(page.locator(".view-question")).toBeHidden();
    await about.click();
    await expect(about).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".view-question")).toBeVisible();
  });
});

test("a reading tab opens on the Tour's step on screen, not on the one applied before the scroll", async ({
  page,
}) => {
  await page.goto(TS_BUNDLE.href);
  await expect(page.getByTestId("guide")).toBeVisible();
  await page
    .locator('.guide-section[data-section-id="t2"]')
    .evaluate((el) => el.scrollIntoView({ block: "start" }));
  await expect(page.getByTestId("breadcrumb-topic")).toContainText("Where failures go");
  await page.getByTestId("perspective-flow").click();
  await expect(page.getByTestId("breadcrumb-topic")).toContainText("Where failures go");
  await expect(page.locator('[data-element-id="dispatch:3"]').first()).toHaveClass(/is-selected/);
});
