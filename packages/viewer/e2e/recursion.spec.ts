/**
 * Shapes of an in-function algorithm (review 2026-10-03, A6 and the senior engineer's §5): recurse and return links
 * in a flow, a loop on one stage, an arrow "via" code that has no box, and the code-first layout of a flow whose
 * steps are all in one file.
 */
import { expect, test, type Page } from "@playwright/test";
import { readEmbeddedBundle, stateOf, watchProblems, withBundle } from "./helpers.js";

interface Step {
  id: string;
  shape?: string;
  anchors: { file: string }[];
  next?: { step?: string; label?: string; kind?: string }[];
}
interface Explainer {
  views: { id: string; type: string; layout?: string; steps?: Step[]; include?: string[] }[];
  edges: Record<string, unknown>[];
}

/** The fixture with its sequence made a recursive flow whose steps' code is all in src/runner.ts. */
function recursiveBundle(layout?: string) {
  const { html, bundle } = readEmbeddedBundle();
  const explainer = bundle.explainer as Explainer;
  const flow = explainer.views.find((view) => view.type === "sequence")!;
  flow.type = "flow";
  if (layout) flow.layout = layout;
  const [first, second, third] = flow.steps!;
  for (const step of flow.steps!)
    step.anchors = step.anchors.filter((anchor) => anchor.file === "src/runner.ts");
  first!.shape = "decision";
  first!.next = [
    { step: second!.id, label: "a job" },
    { step: first!.id, label: "next one" },
  ];
  second!.next = [{ step: first!.id, kind: "recurse", label: "again" }];
  third!.shape = "terminal";
  third!.next = [{ step: second!.id, kind: "return", label: "done" }];
  return { html, bundle, flow };
}

async function open(page: Page, html: string, bundle: Record<string, unknown>, query: string) {
  await page.route("http://xpl.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: withBundle(html, bundle) }),
  );
  await page.goto(`http://xpl.test/${query}`);
}

test("a flow draws recurse and return links dashed, with their way, a tooltip and a key", async ({
  page,
}) => {
  const problems = watchProblems(page);
  const { html, bundle } = recursiveBundle("diagram");
  await open(page, html, bundle, "?perspective=flow");
  const recurse = page.locator('.flow-transition[data-transition-kind="recurse"]');
  await expect(recurse.locator("polyline")).toHaveCount(1);
  await expect(recurse.locator("title")).toContainText("run again, one level down");
  // a label wraps into lines (tspans): read it as words
  const words = (kind: string) =>
    page
      .locator(`.flow-transition.is-${kind} text`)
      .evaluate((text) => [...text.querySelectorAll("tspan")].map((t) => t.textContent).join(" "));
  expect(await words("recurse")).toBe("again (one level down)");
  expect(await words("return")).toBe("done (up one level)");
  // dashed, not the solid line of an ordinary transition
  const dash = await recurse
    .locator("polyline")
    .evaluate((line) => getComputedStyle(line).strokeDasharray);
  expect(dash).not.toBe("none");
  // a stage's link to itself is drawn: a loop with its label
  await expect(page.locator(".flow-transition text", { hasText: "next one" })).toBeVisible();
  await page.getByRole("button", { name: "Key" }).click();
  await expect(page.getByText("One level down: the function calls itself")).toBeVisible();
  await expect(page.getByText("Up one level: the call returns")).toBeVisible();
  expect(problems).toEqual([]);
});

test("a return without a step is an arrow out of its box, back to whoever made the call", async ({
  page,
}) => {
  const problems = watchProblems(page);
  const { html, bundle, flow } = recursiveBundle("diagram");
  flow.steps![2]!.next = [{ kind: "return", label: "done" }];
  await open(page, html, bundle, "?perspective=flow");
  const back = page.locator('.flow-transition[data-transition-kind="return"]');
  await expect(back.locator("polyline")).toHaveCount(1);
  await expect(back.locator("title")).toContainText("to whoever made the call");
  const words = await page
    .locator(".flow-transition.is-return text")
    .evaluate((text) => [...text.querySelectorAll("tspan")].map((t) => t.textContent).join(" "));
  expect(words).toBe("done (up one level)");
  // it leaves the box and ends above it, on no other box
  const box = (await page
    .locator(`.flow-stage[data-stage-id="${flow.steps![2]!.id}"]`)
    .boundingBox())!;
  const line = (await back.locator("polyline").boundingBox())!;
  expect(line.x).toBeGreaterThan(box.x + box.width / 2);
  expect(line.y).toBeLessThan(box.y);
  expect(problems).toEqual([]);
});

test("a flow of one file reads code first: the code is the main pane, the flow an outline that follows the caret", async ({
  page,
}) => {
  const problems = watchProblems(page);
  const { html, bundle, flow } = recursiveBundle();
  await open(page, html, bundle, "?perspective=flow");
  await expect(page.locator(".workspace.is-code-first")).toBeVisible();
  await expect(page.locator(".workspace-source .code-area")).toBeVisible();
  await expect(page.locator(".flow-diagram.is-outline")).toBeVisible();
  await expect(page.getByRole("button", { name: "Show source" })).toHaveCount(0);
  const outline = (await page.locator(".workspace-primary").boundingBox())!;
  const source = (await page.locator(".workspace-source").boundingBox())!;
  expect(outline.width).toBeLessThan(source.width / 2);
  // the caret in the third step's code: the outline marks that step and keeps it in sight
  const third = flow.steps![2]!;
  await page.evaluate(() => window.__xpl!.setCursor("src/runner.ts", 77));
  const stage = page.locator(`.flow-stage[data-stage-id="${third.id}"]`);
  await expect(stage).toHaveClass(/is-matched/);
  await expect
    .poll(async () => {
      const box = (await stage.boundingBox())!;
      return (
        box.x >= outline.x - 1 &&
        box.y >= outline.y &&
        box.y + box.height <= outline.y + outline.height
      );
    })
    .toBe(true);
  // another perspective is laid out as before
  await page.getByTestId("perspective-map").click();
  await expect(page.locator(".workspace.is-code-first")).toHaveCount(0);
  expect((await stateOf(page)).perspective).toBe("map");
  expect(problems).toEqual([]);
});

test("the code-first outline: a bar resizes it (mouse or keys, kept per flow); the picked step's neighbours in words", async ({
  page,
}) => {
  const problems = watchProblems(page);
  const { html, bundle, flow } = recursiveBundle();
  await open(page, html, bundle, "?perspective=flow");
  const width = async () => (await page.locator(".workspace-primary").boundingBox())!.width;
  const start = await width();
  const bar = page.getByRole("separator", { name: "Resize the flow and the code" });
  await bar.focus();
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(width).toBeGreaterThan(start + 100);
  await expect(bar).toHaveAttribute("aria-valuenow", String(Math.round(await width())));
  const box = (await bar.boundingBox())!;
  await page.mouse.move(box.x + 4, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x - 96, box.y + 200, { steps: 4 });
  await page.mouse.up();
  const dragged = await width();
  expect(dragged).toBeLessThan(start + 100);
  // kept for this flow
  await page.reload();
  await expect(page.locator(".flow-diagram.is-outline")).toBeVisible();
  await expect.poll(width).toBe(dragged);

  // the second step: where it comes from, and its recurse link, in words; a click picks that step
  const [first, second, third] = flow.steps!;
  await page.evaluate((id) => window.__xpl!.select([id]), second!.id);
  const around = page.getByTestId("step-neighbours");
  await expect(around).toContainText("This step");
  // the step's code is "this step" to a reader, not a call site
  await expect(page.locator(".workspace-source .pane-roles .role").first()).toHaveText("this step");
  await expect(around.locator(".flow-around-link.is-recurse")).toContainText(
    "again, one level down",
  );
  await expect(around.locator(".flow-around-link.is-return")).toContainText("done, up one level");
  await around.locator(".flow-around-link.is-recurse").click();
  expect((await stateOf(page)).selection).toEqual([first!.id]);
  expect(third).toBeDefined();
  expect(problems).toEqual([]);
});

test("Explore gives a code-first flow a narrow diagram column; layout: diagram turns it off", async ({
  page,
}) => {
  const problems = watchProblems(page);
  const { html, bundle } = recursiveBundle();
  await open(page, html, bundle, "?perspective=explore&view=view:dispatch");
  await expect(page.locator(".explore.is-code-first")).toBeVisible();
  const left = (await page.locator(".explore > .left").boundingBox())!;
  const right = (await page.locator(".explore > .right").boundingBox())!;
  expect(left.width).toBeLessThan(right.width / 1.5);
  await expect(page.locator(".flow-diagram.is-outline")).toBeVisible();
  expect(problems).toEqual([]);

  const plain = recursiveBundle("diagram");
  const other = await page.context().newPage();
  await open(other, plain.html, plain.bundle, "?perspective=explore&view=view:dispatch");
  await expect(other.locator(".explore")).toBeVisible();
  await expect(other.locator(".explore.is-code-first")).toHaveCount(0);
  await expect(other.locator(".flow-diagram.is-outline")).toHaveCount(0);
});

test("a map draws an edge via code without a box as one arrow named after it", async ({ page }) => {
  const problems = watchProblems(page);
  const { html, bundle } = readEmbeddedBundle();
  const explainer = bundle.explainer as Explainer;
  explainer.edges.push({
    id: "edge:reports-through-worker",
    from: "grp:scheduling",
    to: "file:src/metrics.ts",
    kind: "calls",
    label: "reports jobs",
    via: ["sym:src/runner.ts#Runner.dispatch"],
    anchors: [],
    provenance: { origin: "user" },
  });
  await open(page, html, bundle, "?perspective=explore&view=view:overview");
  const edge = page.locator('[data-element-id="edge:reports-through-worker"]');
  await expect(edge).toHaveCount(1);
  await expect(edge.locator("title")).toContainText("which this map does not draw as a box");
  await expect(page.locator(".edge-label text", { hasText: "reports jobs (via" })).toBeVisible();
  // picked, its details name what it passes through
  await page.evaluate(() => window.__xpl!.select(["edge:reports-through-worker"]));
  await expect(page.locator("dl.facts dt", { hasText: "Through" })).toBeVisible();
  expect(problems).toEqual([]);
});
