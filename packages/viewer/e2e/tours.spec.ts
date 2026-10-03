/**
 * Present mode and tours (docs/ARCHITECTURE.md section 6, handoff "Tours"), against the TS fixture
 * bundle: `tour:intro` of Appendix B has two steps,
 *   t1  view:overview  focus [grp:scheduling]                          "Big picture first: ..."
 *   t2  view:dispatch  focus [dispatch:3, concept:retry-policy]        "Where failures go: ..."
 *       editor.primary src/runner.ts
 * The plain fixture is opened from file://; variants (more steps, code overrides, no tours) are served
 * from a fake origin like in variants.spec.ts. Persistence over HTTP is in server.spec.ts.
 */
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import {
  byId,
  downloadJson,
  focusOf,
  linesWith,
  openTourEditor,
  readEmbeddedBundle,
  screenshotPath,
  stateOf,
  TS_BUNDLE,
  watchProblems,
  withBundle,
} from "./helpers.js";

/** The embedded bundle is edited as loose JSON: many shapes, none worth typing here. */
type Loose = Record<string, any>;

const NOTE_1 = "Big picture first: scheduling is two files.";
const NOTE_2 = "Where failures go: requeue with backoff.";

async function open(page: Page, search = "?mode=explore"): Promise<void> {
  await page.goto(TS_BUNDLE.href + search);
  await page.waitForFunction(() => window.__xpl !== undefined);
}

async function openVariant(page: Page, edit: (bundle: Loose) => void, search = ""): Promise<void> {
  const { html, bundle } = readEmbeddedBundle();
  edit(bundle);
  await page.route("http://xpl.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: withBundle(html, bundle) }),
  );
  await page.goto(
    `http://xpl.test/${search || (bundle.mode === "present" ? "" : "?mode=explore")}`,
  );
  await page.waitForFunction(() => window.__xpl !== undefined);
}

/** A third step, so that "next" twice, "last" and "one step per key" are distinguishable. */
const withThirdStep = (bundle: Loose) => {
  bundle.explainer.tours[0].steps.push({
    id: "t3",
    view: "view:dispatch",
    focus: ["dispatch:1"],
    note: "Third: popping the next job.",
  });
};

const searchOf = (page: Page) => new URL(page.url()).search;
const present = (page: Page) => page.getByTestId("present");
const counter = (page: Page) => page.getByTestId("tour-counter");
const note = (page: Page) => page.getByTestId("tour-note");
/**
 * The caption's words: the step title, then the rest of the note. A short note is all title (its first
 * sentence is the title, and nothing is said twice), so the specs compare the caption as a whole.
 */
const caption = (page: Page) => page.locator(".tour-caption").locator(".tour-title, .tour-note");
const captionText = async (page: Page) =>
  (await caption(page).allInnerTexts()).join(" ").replace(/\s+/g, " ").trim();
/** A one-sentence note as the caption shows it: the sentence is the title, without its final period. */
const asTitle = (note: string) => note.replace(/\.$/, "");
const paneFiles = (page: Page) =>
  page.locator("[data-file]").evaluateAll((els) => els.map((el) => el.getAttribute("data-file")));

async function pressAndWaitForStep(page: Page, key: string, step: number): Promise<void> {
  await page.keyboard.press(key);
  await expect.poll(async () => (await stateOf(page)).step, { message: key }).toBe(step);
}

test.describe("tour:intro of the TS fixture", () => {
  test("the Present toggle starts the tour: step 1 is view:overview with grp:scheduling selected", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await open(page);
    expect((await stateOf(page)).mode).toBe("explore");
    await expect(page.locator(".tree-panel")).toBeVisible();
    // Explore has no tour picker; Present has no view tabs
    await expect(page.getByTestId("tour-picker")).toHaveCount(0);

    const toggle = page.getByTestId("mode-present");
    await expect(toggle).toBeEnabled();
    await toggle.click();
    await expect(present(page)).toBeVisible();

    const state = await stateOf(page);
    expect(state).toMatchObject({
      mode: "present",
      tour: "tour:intro",
      step: 1,
      stepCount: 2,
      stepId: "t1",
      detour: false,
      viewId: "view:overview",
      selection: ["grp:scheduling"],
    });
    await expect(byId(page, "grp:scheduling")).toHaveClass(/is-selected/);
    await expect(page.locator(".diagram[data-view-id='view:overview']")).toBeVisible();

    // the caption: counter, note (markdown), buttons
    await expect(counter(page)).toHaveText("1 / 2");
    await expect(page.getByTestId("tour-title")).toHaveText(asTitle(NOTE_1));
    await expect(note(page)).toHaveCount(0); // a one-sentence note is the title: said once
    await expect(page.getByTestId("tour-prev")).toBeDisabled();
    await expect(page.getByTestId("tour-next")).toBeEnabled();
    // the group's members: two whole files
    await expect(page.locator("[data-file]")).toHaveCount(2);
    expect(await paneFiles(page)).toEqual(["src/runner.ts", "src/queue.ts"]);

    // the file tree is out of the way, the editors are not
    await expect(page.locator(".tree-panel")).toHaveCount(0);
    await expect(page.locator('[data-file="src/runner.ts"] .cm-editor')).toBeVisible();
    // the header: the tour picker and the step progress instead of the view tabs, then Exit and Edit
    await expect(page.getByTestId("tour-picker")).toHaveValue("tour:intro");
    await expect(page.locator(".view-tabs")).toHaveCount(0);
    await expect(page.getByTestId("present-exit")).toBeVisible();
    await expect(page.getByTestId("mode-present")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Download explainer JSON" })).toHaveCount(0);
    // and the address bar names the slide (this is a file:// page)
    expect(searchOf(page)).toBe("?mode=present&tour=tour:intro&step=1");
    expect(problems).toEqual([]);
  });

  test("step 2 is view:dispatch with dispatch:3 and concept:retry-policy selected, runner.ts first, its note visible", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await open(page, "?mode=present&tour=tour:intro&step=1");
    await expect(counter(page)).toHaveText("1 / 2");

    await page.keyboard.press("ArrowRight");
    await expect(counter(page)).toHaveText("2 / 2");
    const state = await stateOf(page);
    expect(state).toMatchObject({
      mode: "present",
      tour: "tour:intro",
      step: 2,
      stepId: "t2",
      viewId: "view:dispatch",
      viewType: "sequence",
      selection: ["dispatch:3", "concept:retry-policy"],
    });
    await expect(page.locator(".diagram[data-view-id='view:dispatch']")).toBeVisible();
    await expect(byId(page, "dispatch:3")).toHaveClass(/is-selected/);
    // the concept's related elements light up in the sequence
    await expect(byId(page, "sym:src/runner.ts#Runner.dispatch")).toHaveClass(/is-related/);
    await expect(byId(page, "file:src/queue.ts")).toHaveClass(/is-related/);

    // the note is the caption (a one-sentence note is the step's title)
    await expect(page.getByTestId("tour-title")).toBeVisible();
    await expect(page.getByTestId("tour-title")).toHaveText(asTitle(NOTE_2));
    await expect(page.getByTestId("tour-next")).toBeDisabled();
    await expect(page.getByTestId("tour-prev")).toBeEnabled();

    // runner.ts is the first pane (editor.primary; it is also the first file of the focus)
    await expect
      .poll(() => paneFiles(page))
      .toEqual(["src/runner.ts", "src/queue.ts", "config/default.yaml", "test/retry.test.ts"]);
    expect(state.panes[0]).toMatchObject({ file: "src/runner.ts", focused: true, dim: true });
    const runner = page.locator('[data-file="src/runner.ts"]');
    const queue = page.locator('[data-file="src/queue.ts"]');
    await expect(runner.locator(".cm-editor")).toBeVisible();
    // the call site (76-78) inside the concept's definition (72-83), and Queue.requeue
    await expect
      .poll(async () => {
        const lines = await linesWith(runner, ".xpl-hl");
        return [lines[0], lines.at(-1)];
      })
      .toEqual([72, 83]);
    await expect.poll(() => linesWith(runner, ".xpl-hl-call-site")).toEqual([76, 77, 78]);
    await expect.poll(() => linesWith(queue, ".xpl-hl")).toEqual([87, 88, 89, 90]);
    // dimOthers is on by default: the other lines of a focused file are dimmed
    await expect(runner.locator(".cm-line.xpl-dim").first()).toBeVisible();

    await expect(page.locator(".tree-panel")).toHaveCount(0);
    expect(searchOf(page)).toBe("?mode=present&tour=tour:intro&step=2");
    expect((await focusOf(page)).some((f) => f.file === "config/default.yaml")).toBe(true);
    expect(problems).toEqual([]);
  });

  test("Esc leaves Present and keeps the view, the selection and the code", async ({ page }) => {
    await open(page, "?mode=present&tour=tour:intro&step=2");
    await expect(counter(page)).toHaveText("2 / 2");
    const before = await stateOf(page);

    await page.keyboard.press("Escape");
    await expect(present(page)).toHaveCount(0);
    const after = await stateOf(page);
    expect(after.mode).toBe("explore");
    expect(after.viewId).toBe("view:dispatch");
    expect(after.selection).toEqual(["dispatch:3", "concept:retry-policy"]);
    expect(after.panes.map((p) => p.file)).toEqual(before.panes.map((p) => p.file));
    // Explore is back: the tree, the details of the selection, the view tabs
    await expect(page.locator(".tree-panel")).toBeVisible();
    await expect(page.getByRole("tab", { name: /How a job is dispatched/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(byId(page, "dispatch:3")).toHaveClass(/is-selected/);
    await expect(page.locator(".details")).toContainText("Retry policy");
    await expect(page.locator(".header")).toHaveAttribute("data-mode", "explore");
    // Explore's own Escape (clear the selection) does not fire for the same key press; a second one does
    expect((await stateOf(page)).selection).toHaveLength(2);
    await page.keyboard.press("Escape");
    expect((await stateOf(page)).selection).toEqual([]);
    // the address bar no longer names a slide
    expect(searchOf(page)).toBe("");
  });

  test("Present, Exit and the tour picker switch between the modes and the tours", async ({
    page,
  }) => {
    await open(page);
    await page.getByTestId("mode-present").click();
    await expect(counter(page)).toHaveText("1 / 2");
    await page.getByTestId("tour-next").click();
    await expect(counter(page)).toHaveText("2 / 2");
    await page.getByTestId("present-exit").click();
    await expect(present(page)).toHaveCount(0);
    // Present again resumes at the step it was on
    await page.getByTestId("mode-present").click();
    await expect(counter(page)).toHaveText("2 / 2");
    // the caption buttons walk back
    await page.getByTestId("tour-prev").click();
    await expect(counter(page)).toHaveText("1 / 2");
    expect((await stateOf(page)).viewId).toBe("view:overview");
    // choosing a tour starts it: with one tour that is step 1 again
    await page.getByTestId("tour-next").click();
    await page.getByTestId("tour-picker").selectOption("tour:intro");
    await expect(counter(page)).toHaveText("1 / 2");
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("SELECT");
  });
});

test.describe("keys", () => {
  test("arrows, Page Up/Down, Space, Home and End step through the tour; Escape leaves it", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await openVariant(page, withThirdStep, "?mode=present&tour=tour:intro&step=1");
    await expect(counter(page)).toHaveText("1 / 3");

    await pressAndWaitForStep(page, "ArrowRight", 2);
    await pressAndWaitForStep(page, "PageDown", 3);
    await page.keyboard.press("ArrowRight"); // the end: no wrapping
    await page.keyboard.press("Space");
    await page.keyboard.press("PageDown");
    expect((await stateOf(page)).step).toBe(3);
    await expect(counter(page)).toHaveText("3 / 3");
    await expect(page.getByTestId("tour-title")).toHaveText("Third: popping the next job");
    await pressAndWaitForStep(page, "ArrowLeft", 2);
    await pressAndWaitForStep(page, "PageUp", 1);
    await page.keyboard.press("ArrowLeft"); // the start
    await page.keyboard.press("PageUp");
    expect((await stateOf(page)).step).toBe(1);
    await pressAndWaitForStep(page, "Space", 2);
    await pressAndWaitForStep(page, "Shift+Space", 1);
    await pressAndWaitForStep(page, "End", 3);
    await pressAndWaitForStep(page, "Home", 1);
    // a modifier makes it a browser shortcut, not a step
    await page.keyboard.press("Control+ArrowRight");
    await page.keyboard.press("Alt+ArrowRight");
    expect((await stateOf(page)).step).toBe(1);

    await page.keyboard.press("Escape");
    await expect(present(page)).toHaveCount(0);
    expect((await stateOf(page)).mode).toBe("explore");
    // in Explore the arrows are not tour keys
    await page.keyboard.press("ArrowRight");
    expect((await stateOf(page)).step).toBe(1);
    expect(problems).toEqual([]);
  });

  test("a focused button, the code editor and the diagram give way to the keys; a menu keeps its own", async ({
    page,
  }) => {
    await openVariant(page, withThirdStep, "?mode=present&tour=tour:intro&step=1");
    await expect(counter(page)).toHaveText("1 / 3");

    // Space on the focused Next button steps once (not twice: once as a key, once as a click)
    await page.getByTestId("tour-next").focus();
    await page.keyboard.press("Space");
    await expect.poll(async () => (await stateOf(page)).step).toBe(2);
    await page.waitForTimeout(150);
    expect((await stateOf(page)).step).toBe(2);
    // ... and so does the arrow key with focus on the Previous button
    await page.getByTestId("tour-prev").focus();
    await pressAndWaitForStep(page, "ArrowLeft", 1);

    // a click into the code puts the caret there, and the arrows still step
    await page.locator('[data-file="src/runner.ts"] .cm-line').nth(2).click();
    await expect(page.locator('[data-file="src/runner.ts"] .cm-content')).toBeFocused();
    await pressAndWaitForStep(page, "ArrowRight", 2);
    // ... likewise with a diagram element focused (the diagram pans with the arrows in Explore)
    await byId(page, "dispatch:1").focus();
    await pressAndWaitForStep(page, "ArrowRight", 3);
    await pressAndWaitForStep(page, "ArrowLeft", 2);

    // the tour menu is a form field: its keys stay its own
    await page.getByTestId("tour-picker").focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Home");
    expect((await stateOf(page)).step).toBe(2);
    // a plain page click hands the keys back
    await page.locator(".diagram-caption").click();
    await pressAndWaitForStep(page, "ArrowRight", 3);
  });
});

test.describe("the address bar", () => {
  test("?mode=present&tour=<id>&step=<n> opens that step; the URL follows the steps and Esc", async ({
    page,
  }) => {
    await openVariant(page, withThirdStep, "?mode=present&tour=tour:intro&step=2");
    await expect(counter(page)).toHaveText("2 / 3");
    expect(await stateOf(page)).toMatchObject({ mode: "present", tour: "tour:intro", step: 2 });
    expect((await stateOf(page)).viewId).toBe("view:dispatch");
    expect(searchOf(page)).toBe("?mode=present&tour=tour:intro&step=2");

    await page.keyboard.press("ArrowRight");
    await expect(counter(page)).toHaveText("3 / 3");
    expect(searchOf(page)).toBe("?mode=present&tour=tour:intro&step=3");
    await page.keyboard.press("Home");
    await expect(counter(page)).toHaveText("1 / 3");
    expect(searchOf(page)).toBe("?mode=present&tour=tour:intro&step=1");
    // stepping does not add history entries: there is nothing to go back to
    expect(await page.evaluate(() => history.length)).toBeLessThanOrEqual(2);

    // reload: the same slide
    await page.keyboard.press("ArrowRight");
    await expect(counter(page)).toHaveText("2 / 3");
    await page.reload();
    await page.waitForFunction(() => window.__xpl !== undefined);
    await expect(counter(page)).toHaveText("2 / 3");
    expect((await stateOf(page)).viewId).toBe("view:dispatch");

    await page.keyboard.press("Escape");
    await expect(present(page)).toHaveCount(0);
    expect(searchOf(page)).toBe("");
    await page.getByTestId("mode-present").click();
    expect(searchOf(page)).toBe("?mode=present&tour=tour:intro&step=2");
  });

  test("odd addresses land somewhere sensible: a step past the end, an unknown tour, a short id", async ({
    page,
  }) => {
    await open(page, "?mode=present&tour=tour:intro&step=99");
    await expect(counter(page)).toHaveText("2 / 2");
    expect(searchOf(page)).toBe("?mode=present&tour=tour:intro&step=2");
    await open(page, "?mode=present&tour=tour:nope");
    await expect(counter(page)).toHaveText("1 / 2");
    expect((await stateOf(page)).tour).toBe("tour:intro");
    await open(page, "?mode=present&tour=intro&step=2");
    await expect(counter(page)).toHaveText("2 / 2");
    await open(page, "?mode=present&step=0");
    await expect(counter(page)).toHaveText("1 / 2");
    // without mode=present the page is Explore, and Present resumes at the step asked for
    await open(page, "?mode=explore&tour=tour:intro&step=2");
    expect((await stateOf(page)).mode).toBe("explore");
    expect(searchOf(page)).toBe("?mode=explore&tour=tour:intro&step=2"); // untouched until something changes
    await page.getByTestId("mode-present").click();
    await expect(counter(page)).toHaveText("2 / 2");
  });

  test("the bundle's mode and tour are the defaults; Esc says mode=explore so a reload stays in Explore, and Back returns to the talk", async ({
    page,
  }) => {
    await openVariant(page, (bundle) => {
      bundle.mode = "present";
      bundle.tour = "tour:intro";
    });
    await expect(counter(page)).toHaveText("1 / 2");
    expect(searchOf(page)).toBe("?mode=present&tour=tour:intro&step=1");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Escape");
    await expect(present(page)).toHaveCount(0);
    // the tour and the step stay in the address: Present resumes there
    expect(searchOf(page)).toBe("?mode=explore&tour=tour:intro&step=2");
    // Back returns to the talk, at that step (not to the page before this file)
    await page.goBack();
    await expect(counter(page)).toHaveText("2 / 2");
    expect(searchOf(page)).toBe("?mode=present&tour=tour:intro&step=2");
    await page.keyboard.press("Escape");
    await page.reload();
    await page.waitForFunction(() => window.__xpl !== undefined);
    expect((await stateOf(page)).mode).toBe("explore");
    // the URL wins over the bundle
    await page.goto("http://xpl.test/?mode=explore");
    await page.waitForFunction(() => window.__xpl !== undefined);
    expect((await stateOf(page)).mode).toBe("explore");
  });
});

test.describe("during a talk", () => {
  test("a click is a detour: the selection follows it, the counter stays, the next arrow key returns to the tour", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await open(page, "?mode=present&tour=tour:intro&step=2");
    await expect(counter(page)).toHaveText("2 / 2");
    await expect(page.getByTestId("tour-detour")).toHaveCount(0);

    await byId(page, "dispatch:1").click();
    await expect(byId(page, "dispatch:1")).toHaveClass(/is-selected/);
    await expect(byId(page, "dispatch:3")).not.toHaveClass(/is-selected/);
    await expect(page.getByTestId("tour-detour")).toBeVisible();
    expect(await stateOf(page)).toMatchObject({
      mode: "present",
      step: 2,
      detour: true,
      stepId: null,
      selection: ["dispatch:1"],
    });
    await expect(counter(page)).toHaveText("2 / 2");
    expect(searchOf(page)).toBe("?mode=present&tour=tour:intro&step=2");
    // the code follows the click (the step's own code is not shown any more)
    await expect.poll(() => paneFiles(page)).toEqual(["src/runner.ts", "src/queue.ts"]);
    // the note stays: it belongs to the step
    await expect(page.getByTestId("tour-title")).toHaveText(asTitle(NOTE_2));

    // ← first returns to the step that was interrupted ...
    await page.keyboard.press("ArrowLeft");
    await expect(counter(page)).toHaveText("2 / 2");
    expect(await stateOf(page)).toMatchObject({
      detour: false,
      selection: ["dispatch:3", "concept:retry-policy"],
    });
    // ... so does Esc, which leaves the talk only when there is no detour
    await byId(page, "dispatch:1").click();
    expect((await stateOf(page)).detour).toBe(true);
    await page.keyboard.press("Escape");
    expect(await stateOf(page)).toMatchObject({ mode: "present", step: 2, detour: false });
    // ... then ← goes one step back
    await page.keyboard.press("ArrowLeft");
    await expect(counter(page)).toHaveText("1 / 2");
    expect(await stateOf(page)).toMatchObject({
      detour: false,
      viewId: "view:overview",
      selection: ["grp:scheduling"],
    });
    await expect(page.getByTestId("tour-detour")).toHaveCount(0);

    // "Back to step" re-applies the step that is on
    await page.keyboard.press("ArrowRight");
    await byId(page, "dispatch:2").click();
    await page.getByRole("button", { name: "Back to step 2" }).click();
    expect(await stateOf(page)).toMatchObject({
      detour: false,
      step: 2,
      selection: ["dispatch:3", "concept:retry-policy"],
    });
    // clicking the empty canvas is a detour too (the selection is cleared)
    await page.locator(".panzoom").click({ position: { x: 8, y: 8 } });
    expect((await stateOf(page)).detour).toBe(true);
    expect(problems).toEqual([]);
  });

  test("the diagram cannot be edited: no drill-in, no expanding stubs, no collapse buttons", async ({
    page,
  }) => {
    await open(page, "?mode=present&tour=tour:intro&step=1");
    await expect(byId(page, "grp:scheduling")).toBeVisible();
    const before = (await stateOf(page)).include;
    await byId(page, "grp:scheduling").dblclick();
    await byId(page, "ghost:file:src/bus.ts").click();
    await page.waitForTimeout(150);
    const state = await stateOf(page);
    expect(state.include).toEqual(before);
    expect(state.dirty).toBe(false);
    expect(state.graph!.nodes).not.toContain("file:src/bus.ts");
    await expect(page.locator("[data-collapse-id]")).toHaveCount(0);
    // the edge-kind toggles are not there either
    await expect(page.locator("[data-edge-kind]")).toHaveCount(0);
    // back in Explore the same click edits the view
    await page.keyboard.press("Escape");
    await byId(page, "ghost:file:src/bus.ts").click();
    await expect(byId(page, "file:src/bus.ts")).toBeVisible();
    expect((await stateOf(page)).dirty).toBe(true);
  });

  test("a step's editor options and code override: primary, dimOthers, hideFileTree, code", async ({
    page,
  }) => {
    await openVariant(
      page,
      (bundle) => {
        const [t1, t2] = bundle.explainer.tours[0].steps;
        // t1 shows only Queue.requeue, whatever its focus points at, and keeps the tree
        t1.code = [
          {
            file: "src/queue.ts",
            symbol: "Queue.requeue",
            role: "definition",
            hash: "sha256:0",
            resolved: { commit: "t", range: { startLine: 87, endLine: 90 }, status: "ok" },
          },
        ];
        t1.editor = { hideFileTree: false };
        // t2 opens queue.ts first and leaves the other lines undimmed
        t2.editor = { primary: "src/queue.ts", dimOthers: false };
      },
      "?mode=present&tour=tour:intro&step=1",
    );
    await expect(counter(page)).toHaveText("1 / 2");
    await expect.poll(() => paneFiles(page)).toEqual(["src/queue.ts"]);
    const queue = page.locator('[data-file="src/queue.ts"]');
    await expect.poll(() => linesWith(queue, ".xpl-hl")).toEqual([87, 88, 89, 90]);
    expect((await focusOf(page)).map((f) => [f.file, f.range.startLine, f.range.endLine])).toEqual([
      ["src/queue.ts", 87, 90],
    ]);
    // the selection is still the focus: the group is marked in the diagram
    await expect(byId(page, "grp:scheduling")).toHaveClass(/is-selected/);
    await expect(page.locator(".tree-panel")).toBeVisible();

    await page.keyboard.press("ArrowRight");
    await expect(counter(page)).toHaveText("2 / 2");
    await expect
      .poll(() => paneFiles(page))
      .toEqual(["src/queue.ts", "src/runner.ts", "config/default.yaml", "test/retry.test.ts"]);
    await expect(page.locator('[data-file="src/runner.ts"] .cm-editor')).toBeVisible();
    await expect(page.locator(".cm-line.xpl-dim")).toHaveCount(0);
    expect((await stateOf(page)).panes.every((p) => !p.dim)).toBe(true);
    await expect(page.locator(".tree-panel")).toHaveCount(0);

    // going back re-applies the override
    await page.keyboard.press("ArrowLeft");
    await expect.poll(() => paneFiles(page)).toEqual(["src/queue.ts"]);
    // leaving Present keeps what the step made of the screen
    await page.keyboard.press("Escape");
    expect(await paneFiles(page)).toEqual(["src/queue.ts"]);
  });

  test("the note is markdown, sanitised", async ({ page }) => {
    await openVariant(
      page,
      (bundle) => {
        bundle.explainer.tours[0].steps[0].note =
          '### The **title** line\n\nUse **bold** and `code`.\n\n- one\n- two\n\n<img src=x onerror="window.__pwned = 1"> <script>window.__pwned = 2</script>';
      },
      "?mode=present&tour=tour:intro&step=1",
    );
    // the heading line is the title (its markdown rendered), and is not printed again in the note
    await expect(page.getByTestId("tour-title")).toHaveText("The title line");
    await expect(page.getByTestId("tour-title").locator("strong")).toHaveText("title");
    const box = note(page);
    await expect(box).not.toContainText("The title line");
    await expect(box.locator("strong")).toHaveText("bold");
    await expect(box.locator("code")).toHaveText("code");
    await expect(box.locator("li")).toHaveCount(2);
    await expect(box.locator("img, script")).toHaveCount(0);
    await page.waitForTimeout(100);
    expect(
      await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned),
    ).toBeUndefined();
  });

  test("a step without a note has a title but no caption text; an empty tour says so", async ({
    page,
  }) => {
    await openVariant(
      page,
      (bundle) => {
        delete bundle.explainer.tours[0].steps[0].note;
      },
      "?mode=present&tour=tour:intro&step=1",
    );
    await expect(counter(page)).toHaveText("1 / 2");
    await expect(note(page)).toHaveCount(0);
    // the title of a step without a note: the first element it focuses
    await expect(page.getByTestId("tour-title")).toHaveText("Scheduling");

    await page.unroute("http://xpl.test/**");
    await openVariant(
      page,
      (bundle) => {
        bundle.explainer.tours[0].steps = [];
      },
      "?mode=present&tour=tour:intro",
    );
    await expect(present(page)).toContainText("has no steps yet");
    await page.getByRole("button", { name: "Back to Explore" }).click();
    await expect(present(page)).toHaveCount(0);
  });
});

test.describe("without tours", () => {
  test("Present is disabled and says how to get a tour", async ({ page }) => {
    await openVariant(
      page,
      (bundle) => {
        bundle.explainer.tours = [];
        bundle.mode = "present";
      },
      "?mode=present&tour=tour:intro",
    );
    const toggle = page.getByTestId("mode-present");
    await expect(toggle).toBeDisabled();
    await expect(toggle).toHaveAttribute("title", /\/code-explainer make tour/);
    expect((await stateOf(page)).mode).toBe("explore");
    expect(await page.evaluate(() => window.__xpl!.present("tour:intro"))).toBe(false);
    expect((await stateOf(page)).mode).toBe("explore");
    // the toolbar of the tour panel is still there to make one
    await openTourEditor(page);
    await expect(page.getByTestId("tour-panel")).toContainText("There is no tour yet");
  });
});

test.describe("hand-edited tours", () => {
  test("a malformed tour degrades to an empty one; the rest of the viewer works", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await openVariant(
      page,
      (bundle) => {
        const tours = bundle.explainer.tours as Loose[];
        tours[0]!.steps.splice(1, 0, { id: "junk" }, "text", null);
        tours[0]!.steps[0].focus = ["grp:scheduling", 42];
        tours.push({ id: "tour:broken", title: "Broken", steps: "nope" });
      },
      "?mode=present&tour=tour:intro",
    );
    await expect(counter(page)).toHaveText("1 / 2");
    expect((await stateOf(page)).selection).toEqual(["grp:scheduling"]);
    await page.getByTestId("tour-picker").selectOption("tour:broken");
    await expect(present(page)).toContainText("has no steps yet");
    await page.getByRole("button", { name: "Back to Explore" }).click();
    await openTourEditor(page);
    await page.getByTestId("tour-target").selectOption("tour:broken");
    await expect(page.getByTestId("tour-panel")).toContainText("No steps yet");
    await page.getByTestId("tour-add").click();
    await expect(page.getByTestId("tour-step")).toHaveCount(1);
    expect(problems).toEqual([]);
  });
});

test.describe("hooks", () => {
  test("present(tourId, step), next(), prev() and exitPresent() drive the same actions as the keys", async ({
    page,
  }) => {
    await open(page);
    expect(await page.evaluate(() => window.__xpl!.present("tour:nope"))).toBe(false);
    expect(await page.evaluate(() => window.__xpl!.present("tour:intro", 2))).toBe(true);
    expect(await stateOf(page)).toMatchObject({ mode: "present", tour: "tour:intro", step: 2 });
    await expect(counter(page)).toHaveText("2 / 2");
    await page.evaluate(() => window.__xpl!.prev());
    await expect(counter(page)).toHaveText("1 / 2");
    await page.evaluate(() => window.__xpl!.next());
    await expect(counter(page)).toHaveText("2 / 2");
    await page.evaluate(() => window.__xpl!.next());
    expect((await stateOf(page)).step).toBe(2);
    await page.evaluate(() => window.__xpl!.exitPresent());
    await expect(present(page)).toHaveCount(0);
    expect(await stateOf(page)).toMatchObject({ mode: "explore", tour: "tour:intro", step: 2 });
    // the step defaults to 1; the toggle, not the hook, resumes where the tour was
    expect(await page.evaluate(() => window.__xpl!.present("tour:intro"))).toBe(true);
    expect((await stateOf(page)).step).toBe(1);
    await page.evaluate(() => window.__xpl!.exitPresent());
    await page.getByTestId("mode-present").click();
    expect((await stateOf(page)).step).toBe(1);
    await page.evaluate(() => window.__xpl!.next());
    await page.evaluate(() => window.__xpl!.exitPresent());
    await page.getByTestId("mode-present").click();
    expect((await stateOf(page)).step).toBe(2);
  });
});

test.describe("adding to a tour (in memory: this page has no server)", () => {
  test("an exploration becomes a tour: new tour, steps, notes, reorder, delete and undo, then Present", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await open(page);
    await page.evaluate(() => window.__xpl!.setView("view:dispatch"));
    await expect(byId(page, "dispatch:1")).toBeVisible();

    await byId(page, "dispatch:1").click();
    await openTourEditor(page);
    const panel = page.getByTestId("tour-panel");
    await expect(panel).toBeVisible();
    // the tour of the explainer is offered; the new tour is one choice away
    await expect(page.getByTestId("tour-target")).toHaveValue("tour:intro");
    await page.getByTestId("tour-target").selectOption({ label: "New tour…" });
    const add = page.getByTestId("tour-add");
    await expect(add).toBeDisabled(); // a new tour needs its title
    await page.getByTestId("tour-new-title").fill("My walk");
    await expect(add).toBeEnabled();
    await expect(add).toContainText("How a job is dispatched");
    await expect(add).toContainText("1 selected");
    await add.click();

    // the tour exists, with the step; the panel shows it and the note is ready to be typed
    const rows = panel.getByTestId("tour-step");
    await expect(rows).toHaveCount(1);
    await expect(page.getByTestId("tour-target")).toHaveValue("tour:my-walk");
    await expect(rows.first()).toContainText("How a job is dispatched");
    await expect(rows.first()).toContainText("pop()");
    await expect(rows.first().getByTestId("tour-step-note")).toBeFocused();
    await page.keyboard.type("Start by popping a job.");
    await expect(rows.first().getByTestId("tour-step-note")).toHaveValue("Start by popping a job.");
    let state = await stateOf(page);
    expect(state.dirty).toBe(true);
    expect(state.tour).toBe("tour:my-walk");
    await expect(page.locator(".save-status")).toHaveText("Unsaved");

    // a second step: another selection in the same view (the panel stays open while clicking)
    await byId(page, "dispatch:3").click();
    await byId(page, "concept:retry-policy").click({ modifiers: ["Shift"] });
    await expect(add).toContainText("2 selected");
    await add.click();
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(1)).toContainText("requeue(job, backoff)");
    await expect(rows.nth(1)).toContainText("Retry policy");
    await page.keyboard.type("Then the retry.");

    // a third step in another view, with nothing selected: the whole view
    await page.evaluate(() => window.__xpl!.setView("view:overview"));
    await expect(add).toContainText("nothing selected");
    await add.click();
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(2)).toContainText("whole view");

    // reorder: the second step moves up; the first cannot
    await expect(rows.first().getByTestId("tour-step-up")).toBeDisabled();
    await expect(rows.last().getByTestId("tour-step-down")).toBeDisabled();
    await rows.nth(1).getByTestId("tour-step-up").click();
    await expect(rows.first().getByTestId("tour-step-note")).toHaveValue("Then the retry.");
    await expect(rows.nth(1).getByTestId("tour-step-note")).toHaveValue("Start by popping a job.");
    // delete the whole-view step, then take it back
    await rows.nth(2).getByTestId("tour-step-delete").click();
    await expect(rows).toHaveCount(2);
    await page.getByTestId("tour-undo").click();
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(2)).toContainText("whole view");
    await rows.nth(2).getByTestId("tour-step-delete").click();
    await expect(rows).toHaveCount(2);

    // a step shows its view and selection when clicked, without leaving Explore
    await rows
      .first()
      .getByRole("button", { name: /How a job is dispatched/ })
      .click();
    state = await stateOf(page);
    expect(state.mode).toBe("explore");
    expect(state.viewId).toBe("view:dispatch");
    expect(state.selection).toEqual(["dispatch:3", "concept:retry-policy"]);
    await expect(rows.first()).toHaveAttribute("aria-current", "step");

    // and Present plays it: the picker lists both tours, the notes are the captions
    await page.getByTestId("tour-present").click();
    await expect(present(page)).toBeVisible();
    await expect(page.getByTestId("tour-panel")).toHaveCount(0);
    await expect(page.getByTestId("tour-picker")).toHaveValue("tour:my-walk");
    await expect(page.getByTestId("tour-picker").locator("option")).toHaveText([
      "Intro talk",
      "My walk",
    ]);
    await expect(counter(page)).toHaveText("1 / 2");
    await expect.poll(() => captionText(page)).toBe("Then the retry");
    expect((await stateOf(page)).selection).toEqual(["dispatch:3", "concept:retry-policy"]);
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => captionText(page)).toBe("Start by popping a job");
    expect((await stateOf(page)).selection).toEqual(["dispatch:1"]);
    expect(searchOf(page)).toBe("?mode=present&tour=tour:my-walk&step=2");
    // choosing the other tour starts it
    await page.getByTestId("tour-picker").selectOption("tour:intro");
    await expect(counter(page)).toHaveText("1 / 2");
    await expect.poll(() => captionText(page)).toBe(asTitle(NOTE_1));

    // the download has the tour (the only place it lives without a server)
    await page.keyboard.press("Escape");
    const download = await downloadJson(page);
    const explainer = JSON.parse(await readFile((await download.path())!, "utf8")) as {
      tours: {
        id: string;
        title: string;
        steps: { id: string; view: string; focus: string[]; note?: string }[];
      }[];
    };
    expect(explainer.tours.map((t) => t.id)).toEqual(["tour:intro", "tour:my-walk"]);
    expect(explainer.tours[1]).toEqual({
      id: "tour:my-walk",
      title: "My walk",
      steps: [
        {
          id: "t2",
          view: "view:dispatch",
          focus: ["dispatch:3", "concept:retry-policy"],
          note: "Then the retry.",
        },
        { id: "t1", view: "view:dispatch", focus: ["dispatch:1"], note: "Start by popping a job." },
      ],
    });
    expect(explainer.tours[0]!.steps.map((s) => s.id)).toEqual(["t1", "t2"]);
    expect(problems).toEqual([]);
  });

  test("a step can be added to an existing tour; the note is editable; Esc closes the panel", async ({
    page,
  }) => {
    await open(page);
    await page.evaluate(() => window.__xpl!.setView("view:dispatch"));
    await byId(page, "dispatch:2").click();
    await openTourEditor(page);
    await expect(page.getByTestId("tour-target")).toHaveValue("tour:intro");
    const rows = page.getByTestId("tour-step");
    await expect(rows).toHaveCount(2);
    await expect(rows.first().getByTestId("tour-step-note")).toHaveValue(NOTE_1);
    await page.getByTestId("tour-add").click();
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(2)).toHaveAttribute("data-step-id", "t3");
    await expect(rows.nth(2)).toContainText("job");
    // edit an existing note; clearing a note removes it
    await rows.nth(1).getByTestId("tour-step-note").fill("Edited note.");
    await rows.first().getByTestId("tour-step-note").fill("");
    await page.getByTestId("tour-present").click();
    await expect(counter(page)).toHaveText("1 / 3");
    // no note: the title is what the step focuses, and there is no caption text under it
    await expect(page.getByTestId("tour-title")).toHaveText("Scheduling");
    await expect(note(page)).toHaveCount(0);
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => captionText(page)).toBe("Edited note");
    await page.keyboard.press("Escape");

    // Escape inside the panel closes the panel, not the selection
    await byId(page, "dispatch:1").click();
    await openTourEditor(page);
    await page.getByTestId("tour-step-note").first().focus();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("tour-panel")).toHaveCount(0);
    expect((await stateOf(page)).selection).toEqual(["dispatch:1"]);
  });

  test("stub ids are not stored in a step: a click on a stub adds the whole view", async ({
    page,
  }) => {
    await open(page);
    // click a stub edge of the overview: it is selected, but it is a picture, not an element
    await page.locator("[data-stub-id]").first().click();
    expect((await stateOf(page)).selection[0]).toMatch(/^stub:/);
    await openTourEditor(page);
    await expect(page.getByTestId("tour-add")).toContainText("nothing selected");
    await page.getByTestId("tour-add").click();
    const rows = page.getByTestId("tour-step");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(2)).toContainText("whole view");
  });
});

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme} theme: screenshots for a human`, () => {
    test.use({ colorScheme: scheme });

    test("both steps of tour:intro, and the tour panel", async ({ page }) => {
      const problems = watchProblems(page);
      await open(page, "?mode=present&tour=tour:intro&step=1");
      await expect(counter(page)).toHaveText("1 / 2");
      await expect(byId(page, "grp:scheduling")).toHaveClass(/is-selected/);
      // the group covers the whole of runner.ts: the pane shows it untinted
      await expect(page.locator('[data-file="src/runner.ts"] .cm-line').first()).toBeVisible();
      await page.screenshot({ path: screenshotPath(`tour-step-1-${scheme}`) });

      await page.keyboard.press("ArrowRight");
      await expect(counter(page)).toHaveText("2 / 2");
      await expect(byId(page, "dispatch:3")).toHaveClass(/is-selected/);
      await expect(page.locator('[data-file="test/retry.test.ts"] .cm-editor')).toBeVisible();
      await expect(
        page.locator('[data-file="src/queue.ts"] .cm-line.xpl-hl').first(),
      ).toBeVisible();
      await page.screenshot({ path: screenshotPath(`tour-step-2-${scheme}`) });

      // a detour
      await byId(page, "dispatch:1").click();
      await expect(page.getByTestId("tour-detour")).toBeVisible();
      await page.screenshot({ path: screenshotPath(`tour-detour-${scheme}`) });

      // Explore with the tour panel open
      await page.keyboard.press("Escape");
      await openTourEditor(page);
      await expect(page.getByTestId("tour-panel")).toBeVisible();
      await page.screenshot({ path: screenshotPath(`tour-panel-${scheme}`) });
      expect(problems).toEqual([]);
    });
  });
}
