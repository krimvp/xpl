/**
 * An `alt` frame with arms (ack / requeue / dead-letter): a dashed line between two arms and each arm's
 * condition, drawn in both themes and at phone width; a click on a condition selects the arm's steps and shows
 * their code, and the caret in an arm's code marks that arm.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  byId,
  focusOf,
  openVariant,
  screenshotPath,
  stateOf,
  watchProblems,
  type Loose,
} from "./helpers.js";

// a console error that only one path raises (the keyboard, a phone) fails the test that took it (T-13)
let problems: string[] = [];
test.beforeEach(({ page }) => {
  problems = watchProblems(page);
});
test.afterEach(() => {
  expect(problems).toEqual([]);
});

/** The fixture's dispatch sequence with the three ways an attempt ends, in one alt frame of three arms. */
async function openOutcome(page: Page, size?: { width: number; height: number }) {
  await openVariant(
    page,
    (bundle) => {
      const view = bundle.explainer.views.find((v: Loose) => v.id === "view:dispatch");
      const [pop, run, requeue] = view.steps;
      const callAt = (line: number, endLine = line) => {
        const anchor = structuredClone(requeue.anchors[0]);
        anchor.resolved.range = { startLine: line, endLine };
        return anchor;
      };
      // in the order the code runs them: ack (line 68), requeue (76-78), dead-letter (80)
      view.steps = [
        pop,
        run,
        { ...requeue, id: "dispatch:4", label: "ack(job)", anchors: [callAt(68)] },
        requeue,
        { ...requeue, id: "dispatch:5", label: "deadLetter(job, error)", anchors: [callAt(80)] },
      ];
      view.frames = [
        {
          id: "frame:loop",
          kind: "loop",
          label: "while the runner runs",
          fromStep: "dispatch:1",
          toStep: "dispatch:5",
        },
        {
          id: "frame:outcome",
          kind: "alt",
          label: "how the attempt ends",
          fromStep: "dispatch:4",
          toStep: "dispatch:5",
          arms: [
            { label: "result.ok", fromStep: "dispatch:4", toStep: "dispatch:4" },
            { label: "retries left", fromStep: "dispatch:3", toStep: "dispatch:3" },
            { label: "else", fromStep: "dispatch:5", toStep: "dispatch:5" },
          ],
        },
      ];
    },
    "?mode=explore",
    size,
  );
  await page.evaluate(() => window.__xpl!.setView("view:dispatch"));
}

/** The numbered steps of the text view, in the order the code runs them. */
const NUMBERED = [
  "1. Runner.dispatch to queue.ts: pop()",
  "2. Runner.dispatch to worker.ts: run(job)",
  "3. Runner.dispatch to queue.ts: ack(job)",
  "4. Runner.dispatch to queue.ts: requeue(job, backoff)",
  "5. Runner.dispatch to queue.ts: deadLetter(job, error)",
];

/** The frame's box (under the steps), its name, and its arms, which are drawn in reading order with the steps. */
const frame = (page: Page) => page.locator('[data-frame-id="frame:outcome"]');
const head = (page: Page) => page.locator('[data-frame-head="frame:outcome"]');
const arms = (page: Page) => page.locator('[data-arm-of="frame:outcome"]');
const arm = (page: Page, n: number) =>
  page.locator(`[data-arm-of="frame:outcome"][data-arm="${n}"]`);

test("an alt frame draws a line between two arms and each arm's condition", async ({ page }) => {
  await openOutcome(page);
  await expect(arms(page)).toHaveCount(3);
  await expect(arms(page).locator(".arm-label")).toHaveText([
    "[result.ok]",
    "[retries left]",
    "[else]",
  ]);
  // the frame's own label names the decision, without brackets, set apart from the conditions (R4-17)
  const title = head(page).locator(".frame-label");
  await expect(title).toHaveText("how the attempt ends");
  const style = (el: Element) => {
    const css = getComputedStyle(el);
    return [css.fill, css.fontStyle];
  };
  const [titleFill, titleStyle] = await title.evaluate(style);
  const [armFill, armStyle] = await arm(page, 0).locator(".arm-label").evaluate(style);
  expect(titleStyle).toBe("italic");
  expect(armStyle).toBe("normal");
  expect(titleFill).not.toBe(armFill);
  // every condition in brackets has one tone: the arms' as the loop's
  const loopFill = await page
    .locator('[data-frame-head="frame:loop"] .frame-label')
    .evaluate((el) => getComputedStyle(el).fill);
  expect(armFill).toBe(loopFill);
  // two dashed lines, each between the arm above and the arm below
  const lines = arms(page).locator(".frame-divider");
  await expect(lines).toHaveCount(2);
  expect(await lines.first().evaluate((el) => getComputedStyle(el).strokeDasharray)).not.toBe(
    "none",
  );
  const row = async (id: string) => (await byId(page, id).locator("path.line").boundingBox())!;
  const lineY = async (n: number) => (await lines.nth(n).boundingBox())!.y;
  expect(await lineY(0)).toBeGreaterThan((await row("dispatch:4")).y);
  expect(await lineY(0)).toBeLessThan((await row("dispatch:3")).y);
  expect(await lineY(1)).toBeGreaterThan((await row("dispatch:3")).y);
  expect(await lineY(1)).toBeLessThan((await row("dispatch:5")).y);
  await page.locator(".diagram").screenshot({ path: screenshotPath("sequence-arms-light") });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.locator(".diagram").screenshot({ path: screenshotPath("sequence-arms-dark") });
  // the key says what the line means
  await page.getByRole("button", { name: "Key" }).click();
  await expect(page.getByText("A dashed line in an alt box")).toBeVisible();
});

test("a click on an arm's condition selects its steps and their code; the caret marks its arm", async ({
  page,
}) => {
  await openOutcome(page);
  await arm(page, 1).locator(".hit").click();
  await expect.poll(async () => (await stateOf(page)).selection).toEqual(["dispatch:3"]);
  await expect(arm(page, 1)).toHaveClass(/is-selected/);
  await expect(arm(page, 0)).not.toHaveClass(/is-selected/);
  // the requeue call (lines 76-78 of runner.ts) and its definition in queue.ts
  await expect
    .poll(async () =>
      (await focusOf(page)).map((f) => [f.file, f.range.startLine, f.range.endLine]),
    )
    .toEqual([
      ["src/runner.ts", 76, 78],
      ["src/queue.ts", 87, 90],
    ]);
  // the keyboard reaches a condition too
  await arm(page, 2).focus();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await stateOf(page)).selection).toEqual(["dispatch:5"]);
  // a step inside an arm still takes its own click
  await byId(page, "dispatch:4").click();
  await expect.poll(async () => (await stateOf(page)).selection).toEqual(["dispatch:4"]);

  // the caret on the dead-letter call marks the last arm, not the others
  await page.evaluate(() => window.__xpl!.setCursor("src/runner.ts", 80));
  await expect(arm(page, 2)).toHaveClass(/is-match/);
  await expect(arm(page, 0)).not.toHaveClass(/is-match/);
  await expect(arm(page, 1)).not.toHaveClass(/is-match/);
});

test("at phone width the arms and their conditions stay inside the frame", async ({ page }) => {
  await openOutcome(page, { width: 390, height: 844 });
  await page.getByRole("button", { name: "Fit all" }).click();
  const outer = (await frame(page).locator(".frame-box").boundingBox())!;
  await expect(arms(page).locator(".arm-label")).toHaveCount(3);
  for (const label of await arms(page).locator(".arm-label").all()) {
    const box = (await label.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(outer.x);
    expect(box.x + box.width).toBeLessThanOrEqual(outer.x + outer.width);
  }
  await page.screenshot({ path: screenshotPath("sequence-arms-390") });
});

// V4-10: Tab went to every condition before step 1; V4-09: a frame's name did nothing
test("Tab reads the frames, the conditions and the steps top to bottom; a frame's name selects its steps", async ({
  page,
}) => {
  await openOutcome(page);
  const order = () =>
    page
      .locator('.sequence .steps > [tabindex="0"]')
      .evaluateAll((els) =>
        els.map(
          (el) =>
            el.getAttribute("data-element-id") ??
            el.getAttribute("data-frame-head") ??
            `arm ${el.getAttribute("data-arm")}`,
        ),
      );
  await expect
    .poll(order)
    .toEqual([
      "frame:loop",
      "dispatch:1",
      "dispatch:2",
      "frame:outcome",
      "arm 0",
      "dispatch:4",
      "arm 1",
      "dispatch:3",
      "arm 2",
      "dispatch:5",
    ]);
  await expect(arm(page, 1)).toHaveAttribute(
    "aria-label",
    /how the attempt ends, arm \[retries left\]/,
  );
  // a click on the frame's name selects all of its steps (their code is the frame's code)
  await head(page).locator(".hit").click();
  await expect
    .poll(async () => (await stateOf(page)).selection)
    .toEqual(["dispatch:4", "dispatch:3", "dispatch:5"]);
  await expect(head(page)).toHaveClass(/is-selected/);
  await expect(head(page)).toHaveAttribute("aria-pressed", "true");
  // the code opens on the frame's first step, the ack call just under `if (result.ok)` (runner.ts 67)
  await expect
    .poll(async () => (await focusOf(page)).map((f) => `${f.file}:${f.range.startLine}`)[0])
    .toBe("src/runner.ts:68");
});

// V5-05: a frame has no code link of its own (no anchors in the schema): its name and conditions say where the
// condition is instead of pretending to show it
test("a frame's name and an arm's condition say that the condition has no code link of its own", async ({
  page,
}) => {
  await openOutcome(page);
  const limit =
    "Click to see its steps and their code. The condition has no code link of its own: it is in the code above step 3.";
  await expect(head(page).locator(":scope > title")).toHaveText(limit);
  await expect(arm(page, 2).locator(":scope > title")).toHaveText(limit);
  await expect(page.locator('[data-frame-head="frame:loop"] > title')).toHaveText(
    "Click to see its steps and their code. The condition has no code link of its own: it is in the code above step 1.",
  );
});

// V4-08: the text view was a straight run of calls, with no frames or arms
test("the text view lists the frames and the arms in reading order, with the step numbers", async ({
  page,
}) => {
  await openOutcome(page);
  await page.getByRole("button", { name: "Text view" }).click();
  const items = page.getByRole("list", { name: "Steps" }).getByRole("button");
  await expect(items.first()).toHaveText("loop [while the runner runs]: steps 1 to 5");
  const texts = await items.allTextContents();
  const at = (pattern: RegExp) => texts.findIndex((text) => pattern.test(text));
  expect(at(/^alt how the attempt ends/)).toBeGreaterThan(-1);
  expect(at(/^\[result\.ok\]/)).toBe(at(/^alt how the attempt ends/) + 1);
  expect(at(/^\[retries left\]/)).toBeLessThan(at(/^\[else\]/));
  expect(texts.filter((text) => /^\d+\. /.test(text))).toEqual(NUMBERED);
  await items.nth(at(/^\[else\]/)).click();
  await expect.poll(async () => (await stateOf(page)).selection).toEqual(["dispatch:5"]);
});
