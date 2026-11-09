/**
 * How a long flow is set in a laptop's pane: a run of choices that is one tall column top to bottom
 * is set left to right in rows when that reads larger, and opens whole. A flow of states (`xpl draft states`)
 * draws states as pills and moves as plain boxes, with no step numbers.
 */
import { expect, test, type Page } from "@playwright/test";
import { openVariant, smallestDiagramText, watchProblems, type Loose } from "./helpers.js";

/** The ids of the flow's steps not wholly inside the Explore canvas. */
const cut = (page: Page) =>
  page.evaluate(() => {
    const svg = document.querySelector(".explore .pz-svg")!;
    const pane = svg.getBoundingClientRect();
    return [...svg.querySelectorAll<SVGElement>(".flow-stage[data-stage-id]")]
      .filter((g) => {
        const r = g.getBoundingClientRect();
        return (
          r.left < pane.left - 1 ||
          r.right > pane.right + 1 ||
          r.top < pane.top - 1 ||
          r.bottom > pane.bottom + 1
        );
      })
      .map((g) => g.dataset.stageId);
  });

/** The TS fixture's dispatch view turned into a flow with these steps. */
const asFlow = (steps: (template: Loose) => Loose[], scope?: Loose) => (bundle: Loose) => {
  const view = bundle.explainer.views.find((v: Loose) => v.id === "view:dispatch");
  const template = view.steps[0];
  view.type = "flow";
  view.frames = [];
  if (scope) view.scope = { ...view.scope, ...scope };
  view.steps = steps(template);
};

test.use({ viewport: { width: 1440, height: 900 } });

test("a run of five choices (Vite's update or reload) opens whole, left to right in rows, at 11px text or more", async ({
  page,
}) => {
  const problems = watchProblems(page);
  const labels = [
    "No matched modules?",
    "Trace affected modules",
    "Dead end found?",
    "Circular invalidation?",
    "HTML template changed?",
    "Reload the page",
    "Any updates to send?",
    "Stop without an update",
    "Send targeted updates",
  ];
  const ways: Record<number, [number, number]> = {
    1: [6, 2],
    3: [6, 4],
    4: [6, 5],
    5: [6, 7],
    7: [9, 8],
  };
  await openVariant(
    page,
    asFlow((template) =>
      labels.map((label, i) => {
        const n = i + 1;
        const way = ways[n];
        return {
          ...structuredClone(template),
          id: `dispatch:${n}`,
          label,
          shape: way ? "decision" : [6, 8, 9].includes(n) ? "terminal" : "stage",
          next: way
            ? [
                { step: `dispatch:${way[0]}`, label: "yes" },
                { step: `dispatch:${way[1]}`, label: "no" },
              ]
            : n === 2
              ? [{ step: "dispatch:3" }]
              : [],
        };
      }),
    ),
    "?mode=explore&view=view:dispatch",
    { width: 1440, height: 900 },
  );
  const flow = page.getByTestId("process-flow");
  await expect(flow).toHaveAttribute("data-direction", "RIGHT");
  await expect(flow).toHaveAttribute("data-parts", "2");
  // (top to bottom, one column: steps 1-4 of 9 in view, and "Fit all" at 6-7px)
  await expect.poll(() => cut(page)).toEqual([]);
  expect(await smallestDiagramText(page)).toBeGreaterThanOrEqual(11);
  // the end that four choices lead to is drawn again near each; the copies are dashed and carry no number
  await expect(page.locator(".flow-stage.is-copy")).toHaveCount(3);
  await expect(page.locator(".flow-stage.is-copy .flow-step-number")).toHaveCount(0);
  expect(problems).toEqual([]);
});

test("a flow of states draws states as pills and moves as plain boxes, unnumbered, each still a link to its code", async ({
  page,
}) => {
  const problems = watchProblems(page);
  const owner = "sym:src/queue.ts#Queue";
  const mover = "sym:src/runner.ts#Runner.dispatch";
  const step = (template: Loose, id: string, from: string, label: string, next: string[]) => ({
    ...structuredClone(template),
    id,
    from,
    to: from,
    label,
    shape: "stage",
    next: next.map((s) => ({ step: s })),
  });
  await openVariant(
    page,
    (bundle) => {
      const view = bundle.explainer.views.find((v: Loose) => v.id === "view:dispatch");
      view.participants = [owner, mover];
      asFlow(
        (template) => [
          step(template, "dispatch:1", owner, "Waiting in the queue", ["dispatch:2"]),
          step(template, "dispatch:2", mover, "The runner takes it", ["dispatch:3"]),
          step(template, "dispatch:3", owner, "Out of the queue", []),
        ],
        { entryPoints: ["src/queue.ts#Queue"] },
      )(bundle);
    },
    "?mode=explore&view=view:dispatch",
    { width: 1440, height: 900 },
  );
  await expect(page.locator(".flow-stage.is-state")).toHaveCount(2);
  await expect(page.locator(".flow-stage.is-move")).toHaveCount(1);
  await expect(page.locator(".flow-stage .flow-step-number")).toHaveCount(0);
  const move = page.getByRole("button", { name: "Move: The runner takes it" });
  await expect(page.getByRole("button", { name: "State: Waiting in the queue" })).toBeVisible();
  // a pill: its corners are rounded by half its height
  const state = page.locator('.flow-stage.is-state[data-stage-id="dispatch:1"] > rect');
  const [rx, height] = await state.evaluate((r) => [
    Number(r.getAttribute("rx")),
    Number(r.getAttribute("height")),
  ]);
  expect(rx).toBe(height / 2);
  await move.click();
  await expect.poll(() => page.evaluate(() => window.__xpl!.selection())).toEqual(["dispatch:2"]);
  expect(problems).toEqual([]);
});
