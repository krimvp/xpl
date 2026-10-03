/**
 * The reader UX round of iteration 2, against variants of the TS fixture: one header pattern in Read,
 * Explore and Present; a flow step in Present gets the width a flow needs; no "X → X" chip for a step
 * inside one part; flow boxes named by their actor; the Guide with inline diagrams, a tour picker and one
 * "Tests" list; "Save as HTML" that keeps a presenter's edits; Present code that grows and wraps.
 */
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import {
  byId,
  openEditMenu,
  openTourEditor,
  readEmbeddedBundle,
  stateOf,
  watchProblems,
  withBundle,
} from "./helpers.js";

/** The embedded bundle is edited as loose JSON: many shapes, none worth typing here. */
type Loose = Record<string, any>;

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

const RUNNER = "sym:src/runner.ts#Runner.dispatch";
const QUEUE = "file:src/queue.ts";
const WORKER = "file:src/worker.ts";

/**
 * A typical flow: eight stages, one decision with two branches, each stage done by the runner or handed
 * to the queue or a worker. The second tour step looks at stage 5 (on one branch, far down).
 */
function withEightStageFlow(bundle: Loose): void {
  const view = bundle.explainer.views.find((v: Loose) => v.id === "view:dispatch");
  const template = view.steps[0];
  const stage = (n: number, label: string, from: string, to: string, extra: Loose = {}) => ({
    ...structuredClone(template),
    id: `dispatch:${n}`,
    from,
    to,
    label,
    ...extra,
  });
  view.type = "flow";
  view.frames = [];
  view.steps = [
    stage(1, "Take the next job", RUNNER, QUEUE),
    stage(2, "Is a worker free?", RUNNER, RUNNER, {
      shape: "decision",
      next: [
        { step: "dispatch:3", label: "yes: a worker is idle" },
        { step: "dispatch:6", label: "no: every worker is busy right now" },
      ],
    }),
    stage(3, "Lease the worker", RUNNER, WORKER),
    stage(4, "Run the job", WORKER, WORKER),
    stage(5, "Acknowledge the job", RUNNER, QUEUE, { next: [{ step: "dispatch:8" }] }),
    stage(6, "Wait for a worker", RUNNER, RUNNER),
    stage(7, "Put the job back", RUNNER, QUEUE),
    stage(8, "Record the metrics", RUNNER, RUNNER, { shape: "terminal" }),
  ];
  bundle.explainer.tours[0].steps[1].focus = ["dispatch:5"];
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

/** Whether every selected element of the diagram is inside its pane. */
async function selectedInPane(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const pane = document.querySelector(".diagram .panzoom")!.getBoundingClientRect();
    const selected = [...document.querySelectorAll(".diagram .pz-svg .is-selected")];
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

/** The header's controls in order, by their accessible text (what a person sees, left to right). */
async function headerControls(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".header > *")]
      .filter((el) => el.offsetParent !== null && !el.classList.contains("spacer"))
      .map((el) =>
        el.classList.contains("brand")
          ? "title"
          : el.classList.contains("workspace-tabs")
            ? "tabs"
            : el.classList.contains("view-strip")
              ? "views"
              : el.classList.contains("tour-picker")
                ? "tour"
                : el.classList.contains("step-progress")
                  ? "progress"
                  : el.classList.contains("save-status")
                    ? "status"
                    : el.classList.contains("edit-menu")
                      ? "edit"
                      : (el.textContent ?? "").trim(),
      ),
  );
}

test.describe("one header in every mode", () => {
  for (const size of [
    { width: 1280, height: 720 },
    { width: 1440, height: 900 },
  ]) {
    test(`${size.width}x${size.height}: Read, Explore and Present share the pattern, with the author tools in Edit`, async ({
      page,
    }) => {
      const problems = watchProblems(page);
      await openVariant(page, () => undefined, "", size);
      const header = page.locator(".header");
      const fits = async () => {
        expect((await header.boundingBox())!.height).toBeLessThan(60);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          size.width,
        );
        for (const control of await header.locator("button:visible, select:visible").all()) {
          const at = (await control.boundingBox())!;
          expect(at.x + at.width).toBeLessThanOrEqual(size.width);
          expect(await control.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
        }
      };

      // Read: the reading tabs, then Present and Edit
      await expect(header).toHaveAttribute("data-mode", "read");
      expect(await headerControls(page)).toEqual(["title", "tabs", "Present", "edit"]);
      await fits();

      // Explore: the views, then Present and Edit; no Tours button, no mode switch, no download
      await (await openEditMenu(page)).getByTestId("edit-explore").click();
      await expect(header).toHaveAttribute("data-mode", "explore");
      expect(await headerControls(page)).toEqual(["title", "views", "Present", "edit"]);
      for (const gone of ["Tours", "Read", "Explore", "Download explainer JSON"])
        await expect(header.getByRole("button", { name: gone, exact: true })).toHaveCount(0);
      await expect(page.locator(".diagram-caption .stubs-control")).toHaveCount(0);
      // the view's toggles are in the Edit menu, under "This view"
      const menu = await openEditMenu(page);
      await expect(menu.getByRole("menuitem")).toHaveText([
        /Back to reading/,
        /Edit the guide's steps/,
        /Save as HTML/,
        /Download explainer JSON/,
      ]);
      await expect(menu.getByRole("group", { name: "This view" })).toContainText("Stubs");
      await expect(menu.locator("[data-edge-kind]")).toHaveCount(7);
      await page.keyboard.press("Escape");
      await fits();

      // Present: the tour picker and the step progress, then Exit and Edit
      await page.getByTestId("mode-present").click();
      await expect(header).toHaveAttribute("data-mode", "present");
      expect(await headerControls(page)).toEqual(["title", "tour", "progress", "Exit", "edit"]);
      await expect(header.getByTestId("tour-counter")).toHaveText("1 / 2");
      await fits();
      // Edit works in Present too: the tour editor opens over the talk, and its keys are its own
      await openTourEditor(page);
      await page.getByTestId("tour-step-note").first().fill("### Edited in the talk");
      await page.getByTestId("tour-step-note").first().press("ArrowLeft");
      expect((await stateOf(page)).step).toBe(1);
      await page.getByRole("button", { name: "Close the tour panel" }).click();
      await expect(page.getByTestId("tour-title")).toHaveText("Edited in the talk");
      await expect(header.locator(".save-status")).toHaveText("Unsaved");
      await fits();
      // Exit goes back to where the talk was started from
      await page.getByTestId("present-exit").click();
      await expect(header).toHaveAttribute("data-mode", "explore");
      expect(problems).toEqual([]);
    });
  }

  test("Explore > Back to reading returns to the tab that was open", async ({ page }) => {
    await openVariant(page, () => undefined, "?perspective=map");
    await expect(page.getByTestId("perspective-map")).toHaveAttribute("aria-current", "page");
    await (await openEditMenu(page)).getByTestId("edit-explore").click();
    await (await openEditMenu(page)).getByTestId("edit-read").click();
    await expect(page.getByTestId("perspective-map")).toHaveAttribute("aria-current", "page");
  });
});

test.describe("Present: a flow step", () => {
  for (const size of [
    { width: 1280, height: 720 },
    { width: 1440, height: 900 },
  ]) {
    test(`${size.width}x${size.height}: a typical 8-stage flow reads at 16px or more, framed on the step, Fit all shows it all`, async ({
      page,
    }) => {
      const problems = watchProblems(page);
      await openVariant(page, withEightStageFlow, "?mode=present&tour=tour:intro&step=2", size);
      await expect(byId(page, "dispatch:5")).toHaveClass(/is-selected/);
      // a tour with a flow step gives the diagram more of the width
      const flowPane = (await page.locator(".present-left").boundingBox())!.width;
      expect(flowPane).toBeGreaterThan(size.width * 0.5);
      // read from the back of the room: the flow starts with its text at 16px
      expect(await smallestDiagramText(page)).toBeGreaterThanOrEqual(15.9);
      await expect.poll(() => selectedInPane(page)).toBe(true);
      // "Fit all", when it is offered, shows every stage
      const badge = page.getByTestId("pz-badge");
      if ((await badge.count()) > 0 && (await badge.textContent()) === "Fit all") {
        // it stays off the picture until the mouse moves
        const opacity = () => badge.evaluate((el) => getComputedStyle(el).opacity);
        expect(await opacity()).toBe("0");
        await page.mouse.move(size.width / 4, size.height / 3);
        await expect.poll(opacity).toBe("1");
        await badge.click();
        await expect
          .poll(() =>
            page.evaluate(() => {
              const pane = document.querySelector(".panzoom")!.getBoundingClientRect();
              return [...document.querySelectorAll(".flow-stage")].every((el) => {
                const r = el.getBoundingClientRect();
                return r.top >= pane.top - 1 && r.bottom <= pane.bottom + 1;
              });
            }),
          )
          .toBe(true);
      }
      // one split for the whole tour: a graph step keeps the same columns (the slide does not jump)
      await page.keyboard.press("ArrowLeft");
      await expect(byId(page, "grp:scheduling")).toHaveClass(/is-selected/);
      expect((await page.locator(".present-left").boundingBox())!.width).toBeCloseTo(flowPane, 0);
      expect(problems).toEqual([]);
    });
  }

  test("flow boxes are named by their actor (the step's from), not by where the call goes", async ({
    page,
  }) => {
    await openVariant(page, withEightStageFlow, "?perspective=flow&view=view:dispatch");
    const owner = (id: string) => byId(page, id).locator(".flow-owner");
    // "Acknowledge the job" is done by the runner, handing the job to the queue
    await expect(owner("dispatch:5")).toHaveText("Runner.dispatch → queue.ts");
    // "Run the job" is the worker's own stage
    await expect(owner("dispatch:4")).toHaveText("worker.ts");
    // the decision is the runner's
    await expect(owner("dispatch:2")).toHaveText("Runner.dispatch");
  });
});

test.describe("Present: the code", () => {
  test("the font grows with the screen; long lines wrap in Present only, keeping their indentation", async ({
    page,
  }) => {
    await openVariant(
      page,
      (bundle) => {
        // a long line in runner.ts, in the step's focus
        const lines = bundle.files["src/runner.ts"].split("\n");
        lines[75] = `${lines[75]} // ${"a long comment that runs on and on ".repeat(6)}`;
        bundle.files["src/runner.ts"] = lines.join("\n");
      },
      "?mode=present&tour=tour:intro&step=2",
      { width: 1280, height: 720 },
    );
    const pane = page.locator('.present .pane[data-file="src/runner.ts"]');
    await expect(pane.locator('.cm-line[data-line="76"]')).toBeVisible();
    const font = () =>
      pane.locator(".cm-scroller").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const small = await font();
    expect(small).toBeGreaterThanOrEqual(14);
    // wrapped: no sideways scroll, and the long line takes several rows
    expect(
      await pane.locator(".cm-scroller").evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    const line = pane.locator('.cm-line[data-line="76"]');
    const lineHeight = small * 1.6;
    expect((await line.boundingBox())!.height).toBeGreaterThan(lineHeight * 1.8);
    // its continuation starts under its own indentation, not at the left edge
    expect(
      await line.evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft)),
    ).toBeGreaterThan(small * 2);

    await page.setViewportSize({ width: 1920, height: 1080 });
    await expect.poll(font).toBeGreaterThan(small + 3);

    // Explore: the same file runs on as written
    await page.keyboard.press("Escape");
    const explore = page.locator('.explore .pane[data-file="src/runner.ts"]');
    await expect(explore.locator('.cm-line[data-line="76"]')).toBeVisible();
    expect(
      await explore.locator(".cm-scroller").evaluate((el) => el.scrollWidth > el.clientWidth),
    ).toBe(true);
  });
});

test.describe("the Guide", () => {
  test("a step inside one part shows one box with what it does, never 'X → X'", async ({
    page,
  }) => {
    await openVariant(page, (bundle) => {
      const view = bundle.explainer.views.find((v: Loose) => v.id === "view:dispatch");
      view.steps[1].to = view.steps[1].from; // run(job): the runner's own stage
      bundle.explainer.tours[0].steps[1].focus = ["dispatch:2"];
    });
    const section = page.locator('.guide-section[data-section-id="t2"]');
    await expect(section).toBeVisible();
    const self = section.getByTestId("guide-mini-self");
    await expect(self).toHaveText("inside Runner.dispatch: run(job)");
    await expect(section.locator(".guide-mini-link")).toHaveCount(0);
    await expect(section.locator(".guide-mini")).not.toContainText("→");
  });

  test("each section shows its diagram inline, framed on the step, with a way to the live one", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await openVariant(page, () => undefined, "", { width: 1440, height: 900 });
    const first = page
      .locator('.guide-section[data-section-id="t1"]')
      .getByTestId("guide-snapshot");
    await expect(first).toBeVisible();
    await expect(first).toHaveAttribute("data-view-id", "view:overview");
    // the step's focus is marked in the picture; the picture is no second live diagram (no ids, no clicks)
    await expect(first.locator(".node.is-selected")).toHaveCount(1);
    await expect(first.locator("[data-element-id]")).toHaveCount(0);
    await expect(first.locator("[role=button]")).toHaveCount(0);
    await expect(first.locator("svg")).toHaveCSS("pointer-events", "none");
    // the sequence step's picture: the focused arrow marked and in the frame
    const second = page
      .locator('.guide-section[data-section-id="t2"]')
      .getByTestId("guide-snapshot");
    await second.scrollIntoViewIfNeeded();
    await expect(second.locator(".step.is-selected")).toHaveCount(1);
    const frame = (await second.locator(".snapshot-frame").boundingBox())!;
    const arrow = (await second.locator(".step.is-selected .label").boundingBox())!;
    expect(arrow.y).toBeGreaterThanOrEqual(frame.y);
    expect(arrow.y + arrow.height).toBeLessThanOrEqual(frame.y + frame.height);
    // "Open in Flow" opens the live diagram on the step: the flow's own step stays picked (the section's
    // concept would mark other boxes as related)
    await second.getByTestId("snapshot-open").click();
    expect((await stateOf(page)).perspective).toBe("flow");
    expect((await stateOf(page)).selection).toEqual(["dispatch:3"]);
    expect(problems).toEqual([]);
  });

  test("tests are in one list under the section (not as related files on the right)", async ({
    page,
  }) => {
    await openVariant(page, () => undefined);
    const section = page.locator('.guide-section[data-section-id="t2"]');
    const tests = section.getByTestId("guide-tests");
    await expect(tests).toBeVisible();
    await expect(tests.locator("li")).not.toHaveCount(0);
    await expect(tests).toContainText("test/retry.test.ts");
    // the right rail no longer lists them
    await section.click();
    await expect(page.locator(".workspace-context")).not.toContainText("Tested by");
    // a test opens in the code
    await tests.locator(".guide-test").first().click();
    expect((await stateOf(page)).perspective).toBe("code");
    await expect(page.locator('.pane[data-file="test/retry.test.ts"]')).toBeVisible();
    // a section without tests has no list
    await page.getByTestId("perspective-guide").click();
    await expect(
      page.locator('.guide-section[data-section-id="t1"]').getByTestId("guide-tests"),
    ).toHaveCount(0);
  });

  test("several tours: a tour picker above the title switches the guide", async ({ page }) => {
    await openVariant(page, (bundle) => {
      bundle.explainer.tours.push({
        id: "tour:second",
        title: "The retry path",
        steps: [{ id: "s1", view: "view:dispatch", focus: ["dispatch:3"], note: "### Retry" }],
      });
    });
    const picker = page.getByTestId("guide-tour-picker");
    await expect(picker).toHaveValue("tour:intro");
    await expect(picker.locator("option")).toHaveText(["Intro talk", "The retry path"]);
    await picker.selectOption("tour:second");
    await expect(page.locator(".guide-body > h2")).toHaveText("The retry path");
    await expect(page.locator(".guide-section")).toHaveCount(1);
    // one tour: no picker
    await page.unroute("http://xpl.test/**");
    await openVariant(page, () => undefined);
    await expect(page.getByTestId("guide")).toBeVisible();
    await expect(page.getByTestId("guide-tour-picker")).toHaveCount(0);
  });
});

test.describe("Save as HTML", () => {
  test("a presenter's edit survives: edit a step, save the page, open the saved file, the edit is there", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await openVariant(page, () => undefined, "?mode=present&tour=tour:intro&step=1");
    await openTourEditor(page);
    await page.getByTestId("tour-step-note").first().fill("### Said in the meeting\n\nA new note.");
    await page.getByRole("button", { name: "Close the tour panel" }).click();
    await expect(page.locator(".header .save-status")).toHaveText("Unsaved");
    const menu = await openEditMenu(page);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      menu.getByTestId("edit-save-html").click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.html$/);
    const saved = readFileSync((await download.path())!, "utf8");
    // the page is the viewer as loaded (not the rendered page): one data script, the app, no render
    expect(saved.match(/<script id="xpl-data"/g)).toHaveLength(1);
    expect(saved).toContain('<div id="root"></div>');

    // open the saved file: the edit is there, and nothing else changed
    await page.unroute("http://xpl.test/**");
    await page.route("http://xpl.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: saved }),
    );
    await page.goto("http://xpl.test/?mode=present&tour=tour:intro&step=1");
    await page.waitForFunction(() => window.__xpl !== undefined);
    await expect(page.getByTestId("tour-title")).toHaveText("Said in the meeting");
    await expect(page.getByTestId("tour-note")).toHaveText("A new note.");
    expect((await stateOf(page)).dirty).toBe(false);
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("tour-title")).toHaveText(
      "Where failures go: requeue with backoff",
    );
    await expect(page.locator('[data-file="src/runner.ts"] .cm-editor')).toBeVisible();
    expect(problems).toEqual([]);
  });
});
