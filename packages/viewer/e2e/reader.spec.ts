/**
 * The reader's screens (Read mode and Present), against variants of the TS fixture: regressions of the
 * 2026-10-01 review (a flow view switch crashed, flows squeezed to 150px in Present, sequences not framed
 * on the step, the editor on the wrong range, titles said twice) and the reader-first design (the tour
 * summary first, author tools behind "Edit", plain words, readable diagrams).
 */
import { expect, test, type Page } from "@playwright/test";
import { byId, readEmbeddedBundle, stateOf, toRead, watchProblems, withBundle } from "./helpers.js";

/** The embedded bundle is edited as loose JSON: many shapes, none worth typing here. */
type Loose = Record<string, any>;

const RUNNER = "sym:src/runner.ts#Runner.dispatch";
const QUEUE = "file:src/queue.ts";
const WORKER = "file:src/worker.ts";

async function openVariant(
  page: Page,
  edit: (bundle: Loose) => void,
  search = "",
  size = { width: 1280, height: 720 },
): Promise<void> {
  const { html, bundle } = readEmbeddedBundle();
  edit(bundle);
  await page.setViewportSize(size);
  await page.route("http://xpl.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: withBundle(html, bundle) }),
  );
  await page.goto(`http://xpl.test/${search}`);
  await page.waitForFunction(() => window.__xpl !== undefined);
}

/** A second flow view: the dispatch sequence with other step ids (a switch between the two used to crash). */
function withTwoFlows(bundle: Loose): void {
  const views: Loose[] = bundle.explainer.views;
  const dispatch = views.find((v) => v.id === "view:dispatch")!;
  dispatch.type = "flow";
  views.push({
    ...structuredClone(dispatch),
    id: "view:retry",
    title: "How a failed job comes back",
    steps: dispatch.steps.map((s: Loose) => ({ ...structuredClone(s), id: `retry:${s.id}` })),
    frames: [],
  });
}

/**
 * A long sequence: twelve steps between three participants, so that at Present's readable zoom the last
 * steps are far below the first ones (and out of sight unless the view moves to them).
 */
function withLongSequence(bundle: Loose): string[] {
  const view = bundle.explainer.views.find((v: Loose) => v.id === "view:dispatch");
  const template = view.steps[0];
  const ids: string[] = [];
  view.steps = Array.from({ length: 12 }, (_, i) => {
    const id = `dispatch:${i + 1}`;
    ids.push(id);
    return {
      ...structuredClone(template),
      id,
      from: i % 2 === 0 ? RUNNER : QUEUE,
      to: i % 3 === 0 ? WORKER : i % 2 === 0 ? QUEUE : RUNNER,
      label: `step ${i + 1}: a call with a long enough label`,
    };
  });
  view.frames = [];
  bundle.explainer.tours[0].steps = [
    { id: "t1", view: "view:dispatch", focus: [ids[0]], note: "### The first call" },
    { id: "t2", view: "view:dispatch", focus: [ids.at(-1)], note: "### The last call" },
  ];
  return ids;
}

/**
 * Whether every selected element of the diagram is in its pane: its label (what is read) when it has one,
 * else its box. (A long arrow of a sequence may reach past a narrow pane; its words must not.)
 */
async function selectedInPane(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const pane = document.querySelector(".diagram .panzoom")!.getBoundingClientRect();
    const selected = [...document.querySelectorAll(".diagram .pz-svg .is-selected")].map(
      (el) => el.querySelector(":scope > text.label, :scope > text.flow-stage-label") ?? el,
    );
    return (
      selected.length > 0 &&
      selected.every((el) => {
        const box = el.getBoundingClientRect();
        return (
          box.left >= pane.left - 1 &&
          box.right <= pane.right + 1 &&
          box.top >= pane.top - 1 &&
          box.bottom <= pane.bottom + 1
        );
      })
    );
  });
}

/** The smallest rendered font size (px on screen) of the diagram's visible text. */
async function smallestDiagramText(page: Page): Promise<number> {
  return page.evaluate(() => {
    const sizes = [...document.querySelectorAll<SVGTextElement>(".diagram .pz-svg text")]
      .filter((t) => t.textContent!.trim() && t.getBoundingClientRect().width > 0)
      .filter((t) => getComputedStyle(t).opacity !== "0" && !t.closest(".is-quiet"))
      .map((t) => parseFloat(getComputedStyle(t).fontSize) * (t.getScreenCTM()?.a ?? 1));
    return Math.min(...sizes);
  });
}

test.describe("bugs of the review", () => {
  test("Read > Flow: switching the topic to another flow view draws it (it used to crash)", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await openVariant(page, withTwoFlows, "?perspective=flow&view=view:dispatch");
    await expect(page.getByTestId("process-flow")).toBeVisible();
    await expect(page.locator(".flow-stage")).toHaveCount(3);
    const select = page.getByRole("combobox", { name: "Choose a topic" });
    for (const [view, first] of [
      ["view:retry", "retry:dispatch:1"],
      ["view:dispatch", "dispatch:1"],
      ["view:retry", "retry:dispatch:1"],
    ] as const) {
      await select.selectOption(view);
      await expect(byId(page, first)).toBeVisible();
      await expect(page.locator(".flow-stage")).toHaveCount(3);
      await expect(page.getByRole("alert")).toHaveCount(0);
    }
    expect(problems).toEqual([]);
  });

  test("Present: a flow fills the diagram pane (it was squeezed to 150px)", async ({ page }) => {
    const problems = watchProblems(page);
    await openVariant(
      page,
      (bundle) => {
        withTwoFlows(bundle);
        bundle.explainer.tours[0].steps[1].view = "view:dispatch";
      },
      "?mode=present&tour=tour:intro&step=2",
    );
    await expect(page.locator(".diagram .flow-diagram")).toBeVisible();
    const body = (await page.locator(".diagram-body").boundingBox())!;
    const canvas = (await page.locator(".diagram .flow-diagram .panzoom").boundingBox())!;
    expect(body.height).toBeGreaterThan(250);
    expect(canvas.height).toBeGreaterThan(body.height - 80);
    await expect.poll(() => selectedInPane(page)).toBe(true);
    expect(problems).toEqual([]);
  });

  test("Present: a sequence step is framed on its focus, also deep down a long sequence", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    let ids: string[] = [];
    await openVariant(
      page,
      (bundle) => {
        ids = withLongSequence(bundle);
      },
      "?mode=present&tour=tour:intro&step=1",
    );
    await expect(byId(page, ids[0]!)).toHaveClass(/is-selected/);
    await expect.poll(() => selectedInPane(page)).toBe(true);
    await page.keyboard.press("ArrowRight");
    await expect(byId(page, ids.at(-1)!)).toHaveClass(/is-selected/);
    // before the fix the view stayed on the top-left corner: the last step was far out of sight
    await expect.poll(() => selectedInPane(page)).toBe(true);
    expect(problems).toEqual([]);
  });

  test("Present: with two ranges in one file, the editor shows the step's first one, not the lowest", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    // The code override names the requeue call (runner.ts 76) first, then the pop call (46).
    await openVariant(
      page,
      (bundle) => {
        bundle.explainer.tours[0].steps[1].code = [
          {
            file: "src/runner.ts",
            symbol: "Runner.dispatch",
            span: { from: 34, to: 36 },
            role: "call-site",
          },
          {
            file: "src/runner.ts",
            symbol: "Runner.dispatch",
            span: { from: 4, to: 4 },
            role: "call-site",
          },
        ].map((a) => ({ ...a, hash: "x", resolved: undefined }));
      },
      "?mode=present&tour=tour:intro&step=2",
    );
    // The two places are far apart: each has a pane of its own, the step's first one on top.
    const panes = page.locator('.pane[data-file="src/runner.ts"]');
    await expect(panes).toHaveCount(2);
    await expect(panes.nth(0).locator('.cm-line[data-line="76"]')).toBeInViewport();
    await expect(panes.nth(1).locator('.cm-line[data-line="46"]')).toBeInViewport();
    await expect(panes.nth(0).getByTestId("pane-ranges")).toHaveText("range 1 / 2");
    await expect(panes.nth(1).getByTestId("pane-ranges")).toHaveText("range 2 / 2");
    expect(problems).toEqual([]);
  });

  test("Read: two places far apart in one file get a ‹ range 1 / 2 › stepper in the pane header (and n / p)", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await openVariant(
      page,
      (bundle) => {
        bundle.explainer.tours[0].steps[1].code = [
          {
            file: "src/runner.ts",
            symbol: "Runner.dispatch",
            span: { from: 34, to: 36 },
            role: "call-site",
          },
          {
            file: "src/runner.ts",
            symbol: "Runner.dispatch",
            span: { from: 4, to: 4 },
            role: "call-site",
          },
        ].map((a) => ({ ...a, hash: "x", resolved: undefined }));
      },
      "?perspective=code&tour=tour:intro&step=2",
    );
    const pane = page.locator('.pane[data-file="src/runner.ts"]');
    await expect(pane).toHaveCount(1);
    const stepper = pane.getByTestId("pane-ranges");
    await expect(stepper).toContainText("range 2 / 2");
    await expect(pane.locator('.cm-line[data-line="76"]')).toBeInViewport();
    await stepper.getByRole("button", { name: "Previous range" }).click();
    await expect(stepper).toContainText("range 1 / 2");
    await expect(pane.locator('.cm-line[data-line="46"]')).toBeInViewport();
    // n / p in the code do the same
    await pane.locator('.cm-line[data-line="46"]').click();
    await page.keyboard.press("n");
    await expect(stepper).toContainText("range 2 / 2");
    await expect(pane.locator('.cm-line[data-line="76"]')).toBeInViewport();
    expect(problems).toEqual([]);
  });

  test("Guide: a heading line is the section title, the same everywhere, and is said once", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await openVariant(page, (bundle) => {
      const steps = bundle.explainer.tours[0].steps;
      steps[0].note = "### Fix 1: the scheduler picks the job\n\nIt pops the queue first.";
      // a one-sentence note: the sentence is the title, and is not printed again under it
      steps[1].note = "Where failures go: requeue with backoff.";
    });
    const guide = page.getByTestId("guide");
    await expect(guide).toBeVisible();
    const contents = page.getByRole("navigation", { name: "Guide contents" }).getByRole("button");
    await expect(contents).toHaveText([
      "1Fix 1: the scheduler picks the job",
      "2Where failures go: requeue with backoff",
    ]);
    const first = page.locator('.guide-section[data-section-id="t1"]');
    await expect(first.locator("h3")).toHaveText("Fix 1: the scheduler picks the job");
    await expect(first.getByTestId("section-note")).toHaveText("It pops the queue first.");
    await expect(first).not.toContainText("### ");
    const second = page.locator('.guide-section[data-section-id="t2"]');
    await expect(second.locator("h3")).toHaveText("Where failures go: requeue with backoff");
    await expect(second.getByTestId("section-note")).toHaveCount(0);
    // the breadcrumb, the Present caption and the tour editor name the step the same way
    await expect(page.getByTestId("breadcrumb-topic")).toHaveText(
      "Fix 1: the scheduler picks the job",
    );
    await page.getByTestId("mode-present").click();
    await expect(page.getByTestId("tour-title")).toHaveText("Fix 1: the scheduler picks the job");
    await expect(page.getByTestId("tour-note")).toHaveText("It pops the queue first.");
    await page.keyboard.press("Escape");
    await page.getByTestId("edit-button").click();
    await page.getByTestId("edit-tours").click();
    await expect(page.getByTestId("tour-step-title")).toHaveText([
      "Fix 1: the scheduler picks the job",
      "Where failures go: requeue with backoff",
    ]);
    expect(problems).toEqual([]);
  });
});

/** A flow of `count` stages in a chain: tall, so that fitting all of it would make its text tiny. */
function withTallFlow(bundle: Loose, count = 10): void {
  const view = bundle.explainer.views.find((v: Loose) => v.id === "view:dispatch");
  const template = view.steps[0];
  view.type = "flow";
  view.frames = [];
  view.steps = Array.from({ length: count }, (_, i) => ({
    ...structuredClone(template),
    id: `dispatch:${i + 1}`,
    label: `Stage ${i + 1} of the flow`,
    shape: i === count - 1 ? "terminal" : "stage",
    next: i === count - 1 ? [] : [{ step: `dispatch:${i + 2}` }],
  }));
  bundle.explainer.tours[0].steps[1].focus = ["dispatch:1"];
}

const LONG_NOTE = [
  "### File downloads now stop when the client leaves",
  "",
  "The change sits in one source file, `starlette/responses.py` (+38 −8), and its tests. Before: in a run of the old code where `send` blocked after the client left, the response did not return. Now: with a scope below version 2.4, the same run ends after the first 64 KiB chunk. Then the response runs its `background` task, the work it does after sending. When `send` returns at once instead, the old code sent a whole 16 MiB file, and the new code stopped after 64 KiB.",
].join("\n");

test.describe("round 2 of the review", () => {
  for (const size of [
    { width: 1280, height: 720 },
    { width: 1440, height: 900 },
  ]) {
    test(`${size.width}x${size.height}: a long caption is never cut off (it fits, or it scrolls; the counter is in the header)`, async ({
      page,
    }) => {
      // A note of about 520 characters (a real step 1): it fits without scrolling.
      await openVariant(
        page,
        (bundle) => {
          bundle.explainer.tours[0].steps[0].note = LONG_NOTE;
          bundle.explainer.tours[0].steps[1].note = `### A very long note\n\n${"This sentence is here to make the note far too long. ".repeat(80)}The last words.`;
        },
        "?mode=present&tour=tour:intro&step=1",
        size,
      );
      const caption = page.getByTestId("tour-caption");
      await expect(page.getByTestId("tour-note")).toContainText("stopped after 64 KiB.");
      const fits = await caption.evaluate((el) => el.scrollHeight <= el.clientHeight + 1);
      expect(fits).toBe(true);
      // the diagram keeps room above it
      expect((await page.locator(".diagram-body").boundingBox())!.height).toBeGreaterThan(150);

      // A note far too long for any box: it scrolls inside the caption, down to its last words, and the
      // counter (in the header) stays in sight.
      await page.keyboard.press("ArrowRight");
      await expect(page.getByTestId("tour-counter")).toHaveText("2 / 2");
      expect(await caption.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
      await caption.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
      const last = await caption.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const note = el.querySelector(".tour-note")!.getBoundingClientRect();
        return { noteBottom: note.bottom, boxBottom: box.bottom };
      });
      expect(last.noteBottom).toBeLessThanOrEqual(last.boxBottom);
      await expect(page.getByTestId("tour-counter")).toBeInViewport();
      await expect(page.locator(".header").getByTestId("tour-counter")).toHaveText("2 / 2");
    });
  }

  test("Read > Flow: a tall flow starts readable, and Fit all really shows all of it", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await openVariant(page, withTallFlow, "?perspective=flow&view=view:dispatch");
    await expect(page.locator(".flow-stage")).toHaveCount(10);
    expect(await smallestDiagramText(page)).toBeGreaterThanOrEqual(10.9);
    const badge = page.getByTestId("pz-badge");
    await expect(badge).toHaveText("Fit all");
    await badge.click();
    // every stage in the pane (the text gets as small as that takes)
    await expect.poll(() => stagesInPane(page)).toBe(10);
    await expect(badge).toHaveText("Readable size");
    // and back to a readable first view
    await badge.click();
    expect(await smallestDiagramText(page)).toBeGreaterThanOrEqual(10.9);
    // the Fit button of the toolbar shows all of it too
    await page.getByRole("button", { name: "Fit to view" }).click();
    await expect.poll(() => stagesInPane(page)).toBe(10);
    expect(problems).toEqual([]);
  });

  test("Present: a sequence framed far down keeps the participant names in sight", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await openVariant(page, withLongSequence, "?mode=present&tour=tour:intro&step=1");
    // at the top, the heads of the diagram are in sight: no copy
    await expect(page.getByTestId("sticky-heads")).toHaveCount(0);
    await page.keyboard.press("ArrowRight");
    await expect(byId(page, "dispatch:12")).toHaveClass(/is-selected/);
    const heads = page.getByTestId("sticky-heads");
    await expect(heads).toBeVisible();
    await expect(heads.locator("text")).toHaveText(["Runner.dispatch", "queue.ts", "worker.ts"]);
    // at the top of the pane, in line with the lifelines
    const pane = (await page.locator(".diagram .panzoom").boundingBox())!;
    const head = (await heads.locator(".head").first().boundingBox())!;
    expect(head.y).toBeLessThan(pane.y + 20);
    const line = (await page.locator(".lifeline .line").first().boundingBox())!;
    expect(Math.abs(head.x + head.width / 2 - (line.x + line.width / 2))).toBeLessThan(2);
    expect(problems).toEqual([]);
  });

  test("the page title is the open tour's title in the Guide and in Present, else the explainer's", async ({
    page,
  }) => {
    await openVariant(page, () => undefined);
    await expect(page.getByTestId("guide")).toBeVisible();
    await expect(page).toHaveTitle("Intro talk · xpl");
    await page.getByTestId("perspective-map").click();
    await expect(page).toHaveTitle("Job runner · xpl");
    await page.getByTestId("mode-present").click();
    await expect(page).toHaveTitle("Intro talk · xpl");
    await page.keyboard.press("Escape");
    await expect(page).toHaveTitle("Job runner · xpl");
  });
});

test.describe("the reader's screen", () => {
  test("the tour summary comes first, under the tour title, instead of the fixed hint", async ({
    page,
  }) => {
    await openVariant(page, (bundle) => {
      bundle.explainer.tours[0].summary =
        "The job runner takes jobs from a queue and runs them on workers. A failed job is **tried again** later.";
    });
    const body = page.locator(".guide-body");
    await expect(body.locator("h2")).toHaveText("Intro talk");
    const summary = page.getByTestId("tour-summary");
    await expect(summary).toContainText("takes jobs from a queue");
    await expect(summary.locator("strong")).toHaveText("tried again");
    await expect(body).not.toContainText("Read the story");
    // the summary is between the title and the first section
    // (what is on screen: the phone's step picker is hidden here)
    const order = await body.evaluate((el) =>
      [...el.children]
        .filter((c) => getComputedStyle(c).display !== "none")
        .map((c) => c.getAttribute("data-testid") ?? c.tagName.toLowerCase()),
    );
    expect(order.slice(0, 4)).toEqual(["h2", "tour-summary", "explanation-info", "section"]);

    // without a summary there is no placeholder
    await page.unroute("http://xpl.test/**");
    await openVariant(page, () => undefined);
    await expect(page.getByTestId("guide")).toBeVisible();
    await expect(page.getByTestId("tour-summary")).toHaveCount(0);
    await expect(page.locator(".guide-body")).not.toContainText("Read the story");
  });

  test("say it once: a section with a note does not repeat the summaries; no topic panel repeats it", async ({
    page,
  }) => {
    await openVariant(page, (bundle) => {
      const runner = bundle.explainer.nodes.find(
        (n: Loose) => n.id === "sym:src/runner.ts#Runner.dispatch",
      );
      runner.summary = `**Changed:** ${runner.summary}`;
    });
    const first = page.locator('.guide-section[data-section-id="t1"]');
    await expect(first).toBeVisible();
    // t1 focuses the Scheduling group: its summary is not printed under the note, its parts are listed
    await expect(first).not.toContainText("Decides which job runs next");
    await expect(first.getByTestId("focus-summary")).toHaveCount(0);
    await expect(first.locator(".guide-mini-node")).toHaveText(["runner.ts", "queue.ts"]);
    // the right-hand column does not say the open section again; "Related files" only when there are some
    await expect(page.getByTestId("topic-summary")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Related files" })).toHaveCount(0);
    await expect(page.locator(".workspace-context")).not.toContainText("Select a stage");
    // a box picked from the section is another topic: that one gets its summary (markdown rendered)
    await first.locator(".guide-mini-node", { hasText: "queue.ts" }).click();
    await expect(page.getByTestId("topic-summary")).toBeVisible();
    await page.evaluate(() => window.__xpl!.select(["sym:src/runner.ts#Runner.dispatch"]));
    await expect(page.getByTestId("topic-summary").locator("strong")).toHaveText("Changed:");
    await expect(page.getByTestId("topic-summary")).not.toContainText("**");

    // a step without a note: the summaries stand in for it
    await page.unroute("http://xpl.test/**");
    await openVariant(page, (bundle) => {
      delete bundle.explainer.tours[0].steps[0].note;
    });
    await expect(
      page.locator('.guide-section[data-section-id="t1"]').getByTestId("focus-summary"),
    ).toContainText("Decides which job runs next");
  });

  for (const size of [
    { width: 1280, height: 720 },
    { width: 1440, height: 900 },
  ]) {
    test(`${size.width}x${size.height}: the header holds the title, the four tabs, Present and Edit, and fits`, async ({
      page,
    }) => {
      const problems = watchProblems(page);
      await openVariant(
        page,
        (bundle) => {
          bundle.explainer.title = "Starlette: one Host parser for every reader of the header";
        },
        "",
        size,
      );
      const header = page.locator(".header");
      const tabs = page
        .getByRole("navigation", { name: "Read the explanation" })
        .getByRole("button");
      await expect(tabs).toHaveText(["Guide", "Map", "Flow", "Code"]);
      const controls = [
        ...(await tabs.all()),
        page.getByTestId("mode-present"),
        page.getByTestId("edit-button"),
      ];
      const box = (await header.boundingBox())!;
      expect(box.height).toBeLessThan(60);
      for (const control of controls) {
        await expect(control).toBeVisible();
        const at = (await control.boundingBox())!;
        expect(at.x).toBeGreaterThanOrEqual(0);
        expect(at.x + at.width).toBeLessThanOrEqual(size.width);
        // nothing cut off inside the button either
        expect(await control.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      }
      // the author tools are not on the reader's screen
      for (const hidden of ["Download explainer JSON", "Tours", "Explore", "Read"]) {
        await expect(header.getByRole("button", { name: hidden, exact: true })).toHaveCount(0);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        size.width,
      );
      expect(problems).toEqual([]);
    });
  }

  test("Edit holds the author tools: Explore, the tour editor, saving and the save status", async ({
    page,
  }) => {
    await openVariant(page, () => undefined);
    await page.getByTestId("edit-button").click();
    const menu = page.getByTestId("edit-menu");
    await expect(menu.getByRole("menuitem")).toHaveText([
      /Explore the diagrams/,
      /Edit the guide's steps/,
      /Save as HTML/,
      /Download explainer JSON/,
    ]);
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(page.getByTestId("edit-button")).toBeFocused();

    // the tour editor opens from the menu; an edit shows "Unsaved" in it
    await page.getByTestId("edit-button").click();
    await page.getByTestId("edit-tours").click();
    await expect(page.getByTestId("tour-panel")).toBeVisible();
    await page.getByTestId("tour-step-note").first().fill("### Changed");
    await page.getByRole("button", { name: "Close the tour panel" }).click();
    // "Unsaved" is beside Edit; the menu says what it means
    await expect(page.locator(".header .save-status")).toHaveText("Unsaved");
    await page.getByTestId("edit-button").click();
    await expect(page.getByTestId("edit-menu").locator(".edit-note")).toContainText(
      "live only in this page",
    );
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("edit-download").click(),
    ]);
    expect(download.suggestedFilename()).toBe("jobrunner.explainer.json");

    // Explore: the workbench, with its own tools in the same menu (stubs, edge kinds)
    await page.getByTestId("edit-button").click();
    await page.getByTestId("edit-explore").click();
    expect((await stateOf(page)).perspective).toBe("explore");
    await page.getByTestId("edit-button").click();
    await expect(page.getByTestId("edit-menu").locator(".stubs-control")).toBeVisible();
    // and back to reading
    await page.getByTestId("edit-read").click();
    await expect(page.getByTestId("guide")).toBeVisible();
  });

  test("no internal words in reader views: no group/dir badges, plain roles, plain section names", async ({
    page,
  }) => {
    await openVariant(page, () => undefined, "?perspective=map");
    await expect(byId(page, "grp:scheduling")).toBeVisible();
    // the group box has no "group" badge; a file box keeps "file"
    await expect(byId(page, "grp:scheduling").locator("> .badge")).toHaveCount(0);
    await expect(
      page.locator(".workspace-diagram .node .badge text", { hasText: /^group$|^dir$/ }),
    ).toHaveCount(0);
    await expect(byId(page, WORKER).locator(".badge text")).toHaveText("file");
    // the inspector is called by what it shows, and speaks plainly
    await page.getByTestId("perspective-guide").click();
    await page.locator('.guide-section[data-section-id="t2"]').click();
    await page
      .locator('.guide-section[data-section-id="t2"] .guide-mini-node', {
        hasText: "Runner.dispatch",
      })
      .first()
      .click();
    const inspector = page.locator(".workspace-inspector");
    await expect(inspector.locator("summary")).toHaveText("Where this is in the code");
    await inspector.locator("summary").click();
    await expect(inspector.locator(".role").first()).toHaveText(
      /defined here|called here|test|setting|used here/,
    );
    await expect(inspector).not.toContainText("call-site");
    await expect(inspector.locator(".badge.origin-llm")).toHaveCount(0);
    await expect(inspector.locator(".element-id")).toHaveCount(0);
    await expect(inspector.getByRole("button", { name: "Explain this" })).toHaveCount(0);
    // Present: plain role words on the code panes
    await page.getByTestId("mode-present").click();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".pane-roles .role").first()).toBeVisible();
    const roles = (await page.locator(".pane-roles .role").allInnerTexts()).join(" ");
    expect(roles).toContain("called here");
    expect(roles).not.toMatch(/call-site|definition/);
  });

  test("readable diagrams: Present text is at least 12px; count labels show on hover or selection", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await openVariant(page, () => undefined, "?mode=present&tour=tour:intro&step=1");
    await expect(byId(page, "grp:scheduling")).toHaveClass(/is-selected/);
    expect(await smallestDiagramText(page)).toBeGreaterThanOrEqual(11.9);
    await page.keyboard.press("ArrowRight");
    await expect(byId(page, "dispatch:3")).toHaveClass(/is-selected/);
    expect(await smallestDiagramText(page)).toBeGreaterThanOrEqual(11.9);

    // Read > Map: a "calls ×N" label is quiet until its edge is hovered, or an end of it is selected
    await page.keyboard.press("Escape");
    await toRead(page);
    await page.getByTestId("perspective-map").click();
    const counted = page.locator(".workspace-diagram .edge:not(.is-stub)", {
      has: page.locator(".edge-label text", { hasText: /×\d+$/ }),
    });
    await expect(counted.first()).toBeVisible();
    await page.evaluate(() => window.__xpl!.select([]));
    const quiet = page.locator(".workspace-diagram .edge.is-quiet .edge-label").first();
    await expect(quiet).toHaveCSS("opacity", "0");
    await quiet.locator("..").hover({ force: true });
    await expect(quiet).toHaveCSS("opacity", "1");
    // Explore keeps the labels: it is the author's workbench
    await page.getByTestId("edit-button").click();
    await page.getByTestId("edit-explore").click();
    await expect(page.locator(".diagram .edge.is-quiet")).toHaveCount(0);
    expect(problems).toEqual([]);
  });

  test("Explain this, in a static bundle, says plainly what to do", async ({ page }) => {
    await openVariant(page, () => undefined, "?mode=explore&view=view:dispatch");
    await byId(page, "concept:retry-policy").click();
    await page.getByRole("button", { name: "Explain this" }).click();
    await expect(page.locator(".explain-note")).toContainText(
      "Ask Claude to explain this: paste this into Claude Code.",
    );
    await expect(page.getByTestId("explain-command")).toHaveText(
      "/code-explainer expand concept:retry-policy",
    );
  });
});

/** How many flow stages lie wholly inside the diagram's pane. */
async function stagesInPane(page: Page): Promise<number> {
  return page.evaluate(() => {
    const pane = document.querySelector(".panzoom")!.getBoundingClientRect();
    return [...document.querySelectorAll(".flow-stage")].filter((el) => {
      const r = el.getBoundingClientRect();
      return (
        r.left >= pane.left - 1 &&
        r.right <= pane.right + 1 &&
        r.top >= pane.top - 1 &&
        r.bottom <= pane.bottom + 1
      );
    }).length;
  });
}
