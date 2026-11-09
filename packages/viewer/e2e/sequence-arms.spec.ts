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

const frame = (page: Page) => page.locator('[data-frame-id="frame:outcome"]');
const arm = (page: Page, n: number) => frame(page).locator(`.frame-arm[data-arm="${n}"]`);

test("an alt frame draws a line between two arms and each arm's condition", async ({ page }) => {
  const problems = watchProblems(page);
  await openOutcome(page);
  await expect(frame(page).locator(".frame-arm")).toHaveCount(3);
  await expect(frame(page).locator(".arm-label")).toHaveText([
    "[result.ok]",
    "[retries left]",
    "[else]",
  ]);
  // the frame's own label names the decision, without brackets
  await expect(frame(page).locator(".frame-label").first()).toHaveText("how the attempt ends");
  // two dashed lines, each between the arm above and the arm below
  const lines = frame(page).locator(".frame-divider");
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
  expect(problems).toEqual([]);
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
  for (const label of await frame(page).locator(".arm-label").all()) {
    const box = (await label.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(outer.x);
    expect(box.x + box.width).toBeLessThanOrEqual(outer.x + outer.width);
  }
  await page.screenshot({ path: screenshotPath("sequence-arms-390") });
});
