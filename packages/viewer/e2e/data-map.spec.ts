/**
 * The words and the shape of a data map (`GraphView.boxText: "members"`): an arrow from a field's row is
 * named "holds" on the map, its key line, its text view and its matrix; the matrix has one row and column per
 * table; on a phone the tables are laid out top to bottom when that draws them larger. (What a table draws
 * and its two-way code link: data-model.spec.ts.)
 */
import { expect, test, type Page } from "@playwright/test";
import {
  byId,
  GO_BUNDLE,
  readEmbeddedBundle,
  selectionOf,
  watchProblems,
  withBundle,
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

const JOB = "sym:src/queue.ts#Job";
const DEAD = "sym:src/queue.ts#DeadJob";
const QUEUE = "sym:src/queue.ts#Queue";
const HOLDS = `edge:references:${DEAD}.job->${JOB}`;

async function openDataMap(
  page: Page,
  query = "mode=explore",
  over: Loose = {},
  tourFocus?: string[],
): Promise<void> {
  const { html, bundle } = readEmbeddedBundle();
  if (tourFocus)
    (bundle as Loose).explainer.tours.unshift({
      id: "tour:data",
      title: "What the queue keeps",
      steps: [{ id: "t1", view: "view:data", focus: tourFocus, note: "### Kept\n\nWhat is kept." }],
    });
  (bundle as Loose).explainer.views.push({
    id: "view:data",
    type: "graph",
    title: "What the queue keeps",
    scope: { root: "file:src/queue.ts", depth: 1 },
    provenance: { origin: "llm" },
    include: [
      JOB,
      `${JOB}.id`,
      `${JOB}.attempts`,
      DEAD,
      `${DEAD}.job`,
      `${DEAD}.error`,
      QUEUE,
      `${QUEUE}.dead`,
      `${QUEUE}.ready`,
    ],
    edgeKinds: ["references"],
    boxText: "members",
    stubs: { mode: "none" },
    ...over,
  } satisfies Loose);
  await page.route("http://xpl.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: withBundle(html, bundle) }),
  );
  await page.goto(`http://xpl.test/?${query}&view=view:data`);
  await page.waitForFunction(() => window.__xpl !== undefined);
}

test('a field\'s arrow is named "holds" on the map, its key line and its text view', async ({
  page,
}) => {
  await openDataMap(page);
  // three arrows from rows, each named "holds" (not "references ×1")
  await expect(page.locator(".edge-label text", { hasText: /^holds$/ })).toHaveCount(3);
  await expect(page.locator(".edge-label text", { hasText: /references/ })).toHaveCount(0);
  await expect(page.locator('[data-key-item="kind-holds"]')).toHaveText("a field holds this type");
  await page.getByRole("button", { name: "Text view" }).click();
  const text = page.getByRole("region", { name: "Diagram as text" });
  await expect(text.getByRole("list", { name: "Arrows" })).toContainText("DeadJob.job holds Job");
  // a table's fields under it, in the order the code declares them, with their types
  const boxes = await text
    .getByRole("list", { name: "Boxes" })
    .getByRole("button")
    .allTextContents();
  const dead = boxes.indexOf("DeadJob");
  expect(boxes.slice(dead, dead + 3)).toEqual(["DeadJob", "job: Job", "error: string"]);
});

test("the matrix of a data map has a row per table, and a cell names the fields", async ({
  page,
}) => {
  // (three tables are too few for the reader's switch: the view opens as a matrix)
  await openDataMap(page, "mode=explore", { render: "matrix" });
  await expect(page.getByRole("rowheader")).toHaveText(["1Queue", "2DeadJob", "3Job"]);
  // the fields, not a count of references (V5-04)
  await expect(byId(page, HOLDS)).toHaveAccessibleName(
    "DeadJob → Job: holds (job). heuristic (matched by name)",
  );
});

// V5-04: "holds" in every place a field's arrow is named, each time with the table that owns the field
test('a field\'s arrow is "holds" in its details, its name and the parts list, with the owning type', async ({
  page,
}) => {
  await openDataMap(page, "perspective=map");
  // the parts list says the map's verb, and names a field with its table
  const parts = page.getByTestId("parts-panel");
  await expect(parts.locator(`[data-part-id="${DEAD}.job"] .parts-links`)).toHaveText("holds Job");
  await expect(parts.locator(`[data-part-id="${DEAD}"] .parts-links`)).toHaveText(
    "held by Queue.dead",
  );
  await expect(parts.locator(`[data-part-id="${JOB}"] .parts-links`)).toHaveText(
    "held by DeadJob.job and Queue.ready",
  );
  await expect(page.locator(`.edge-key[data-key-for="${HOLDS}"]`)).toHaveAccessibleName(
    "DeadJob.job holds Job",
  );
  // the arrow's details: the badge, the title and the ends say "holds", with the owning type, and no count
  await openDataMap(page);
  await page.evaluate((id) => window.__xpl!.select([id]), HOLDS);
  const details = page.getByRole("region", { name: "Details" });
  await expect(details.locator(".kind-pill")).toHaveText("holds");
  await expect(details.locator(".details-title")).toHaveText("DeadJob.job holds Job");
  // (no "References 1": the arrow is one field)
  await expect(details.locator(".facts dt")).toHaveText(["From", "To", "Resolution", "Origin"]);
  await expect(details.locator(".facts dd").first()).toHaveText("DeadJob.job");
});

// R5-7: every row was its own Tab stop, and the first stop was whichever table the layout put first
test("Tab stops once per table, starting at the tour's first table; arrow keys walk its rows", async ({
  page,
}) => {
  await openDataMap(page, "mode=explore&tour=tour:data", {}, [DEAD]);
  // Tab from the diagram's last tool into the drawing
  await expect(byId(page, DEAD)).toBeVisible();
  await page.locator(".diagram .pz-toolbar button").last().focus();
  // one stop per table, the tour's first one first, then the include list's order; then the three arrows
  for (const stop of [
    byId(page, DEAD),
    byId(page, JOB),
    byId(page, QUEUE),
    ...[
      HOLDS,
      `edge:references:${QUEUE}.dead->${DEAD}`,
      `edge:references:${QUEUE}.ready->${JOB}`,
    ].map((id) => page.locator(`.edge-key[data-key-for="${id}"]`)),
  ]) {
    await page.keyboard.press("Tab");
    await expect(stop).toBeFocused();
  }
  // inside a table, Down goes to its first row, then on through the rows
  await byId(page, DEAD).focus();
  await page.keyboard.press("ArrowDown");
  await expect(byId(page, `${DEAD}.job`)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(byId(page, `${DEAD}.error`)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => selectionOf(page)).toEqual([`${DEAD}.error`]);
});

test("a focused table folds with minus and shows its rows again with plus, as the keyboard hint says", async ({
  page,
}) => {
  await openDataMap(page, "mode=explore&tour=tour:data", {}, [DEAD]);
  await expect(page.locator(".pz-keyboard-hint")).toContainText(
    "On a table: Down goes into its rows, minus folds it to one box, plus shows its rows again.",
  );
  await byId(page, DEAD).focus();
  await page.keyboard.press("-");
  await expect(byId(page, `${DEAD}.job`)).toHaveCount(0);
  await expect(byId(page, DEAD)).not.toHaveClass(/is-table/);
  await byId(page, DEAD).focus();
  await page.keyboard.press("+");
  await expect(byId(page, DEAD)).toHaveClass(/is-table/);
  await expect(byId(page, `${DEAD}.job`)).toBeVisible();
  await expect(byId(page, `${DEAD}.error`)).toBeVisible();
});

// D8/V5-03: Go structs were "class" on the chip, the icon and the Key
test('a Go struct is a "struct" on its box, its icon and the Key; its fields are fields', async ({
  page,
}) => {
  const { html, bundle } = readEmbeddedBundle(GO_BUNDLE);
  const runner = "sym:internal/runner/runner.go#Runner";
  const queue = "sym:internal/runner/runner.go#JobQueue";
  (bundle as Loose).explainer.views.push({
    id: "view:data",
    type: "graph",
    title: "What the runner keeps",
    scope: { root: "repo", depth: 1 },
    provenance: { origin: "llm" },
    include: [runner, `${runner}.queue`, `${runner}.cfg`, queue],
    edgeKinds: ["references"],
    boxText: "members",
    stubs: { mode: "none" },
  } satisfies Loose);
  await page.route("http://xpl.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: withBundle(html, bundle) }),
  );
  await page.goto("http://xpl.test/?mode=explore&view=view:data");
  await page.waitForFunction(() => window.__xpl !== undefined);
  await expect(byId(page, runner)).toHaveAccessibleName("Runner, struct");
  await expect(byId(page, runner).locator(".badge text")).toHaveText("struct");
  await expect(byId(page, runner).locator(".box-icon")).toHaveAttribute("data-icon", "struct");
  await page.getByRole("button", { name: "Key" }).click();
  await expect(page.getByTestId("legend-icons")).toContainText("a struct");
  await expect(page.getByTestId("legend-icons")).not.toContainText("a class");
  await page.keyboard.press("Escape");
  await page.evaluate((id) => window.__xpl!.select([id]), `${runner}.queue`);
  await expect(page.getByRole("region", { name: "Details" }).locator(".kind-pill")).toHaveText(
    "field",
  );
});

test("on a phone the tables are laid out top to bottom, larger than side by side", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openDataMap(page, "perspective=map");
  await expect(page.locator(".workspace-diagram .graph")).toHaveAttribute("data-direction", "DOWN");
  const queue = (await byId(page, QUEUE).boundingBox())!;
  const job = (await byId(page, JOB).boundingBox())!;
  expect(job.y).toBeGreaterThan(queue.y + queue.height);
});

test("a data map too big to read whole opens on the box its tour starts on, all of it in sight", async ({
  page,
}) => {
  // every type of the job runner with its fields: too big to fit at a readable size in 1024 x 768
  const types: Record<string, string[]> = {
    "src/bus.ts#JobCompleted": ["jobId", "type", "durationMs"],
    "src/bus.ts#EventBus": ["listeners"],
    "src/config.ts#RetryConfig": ["maxRetries", "baseDelayMs", "maxDelayMs"],
    "src/config.ts#Config": ["queue", "workers", "retry", "metrics"],
    "src/config.ts#RunnerConfig": ["idleDelayMs", "timeoutMs", "retry"],
    "src/metrics.ts#Metrics": ["prefix", "completed", "totalDurationMs", "completedByType"],
    "src/queue.ts#Job": [
      "id",
      "type",
      "payload",
      "priority",
      "attempts",
      "enqueuedAt",
      "availableAt",
    ],
    "src/queue.ts#DeadJob": ["job", "error", "deadAt"],
    "src/queue.ts#Queue": ["dead", "acked", "ready", "inflight", "maxPending", "nextId"],
    "src/runner.ts#Runner": ["stats", "queue", "pool", "config", "logger", "running", "stopped"],
    "src/runner.ts#RunnerStats": ["processed", "deadLettered", "msByType"],
    "src/worker.ts#Worker": ["id", "current", "handlers", "bus"],
    "src/worker.ts#WorkerPool": ["idle", "waiting"],
  };
  const include = Object.entries(types).flatMap(([type, fields]) => [
    `sym:${type}`,
    ...fields.map((field) => `sym:${type}.${field}`),
  ]);
  const { html, bundle } = readEmbeddedBundle();
  const explainer = (bundle as Loose).explainer;
  explainer.tours.unshift({
    id: "tour:data",
    title: "What the runner keeps",
    steps: [{ id: "t1", view: "view:data", focus: [JOB], note: "### A job\n\nThe unit of work." }],
  });
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.route("http://xpl.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: withBundle(html, bundle) }),
  );
  explainer.views.push({
    id: "view:data",
    type: "graph",
    title: "What the runner keeps",
    scope: { root: "repo", depth: 1 },
    provenance: { origin: "llm" },
    include,
    edgeKinds: ["references"],
    boxText: "members",
    stubs: { mode: "none" },
  } satisfies Loose);
  await page.goto("http://xpl.test/?perspective=map&view=view:data");
  await page.waitForFunction(() => window.__xpl !== undefined);
  // the map is framed, not fitted (the reader is told part of it is out of sight) ...
  await expect(page.getByRole("button", { name: /Fit all \(\d+ out of sight\)/ })).toBeVisible();
  // ... and the frame holds the whole of the tour's first box (the include list starts elsewhere)
  const pane = (await page.locator(".workspace-diagram svg.pz-svg").boundingBox())!;
  const job = (await byId(page, JOB).boundingBox())!;
  expect(job.x).toBeGreaterThanOrEqual(pane.x - 1);
  expect(job.y).toBeGreaterThanOrEqual(pane.y - 1);
  expect(job.x + job.width).toBeLessThanOrEqual(pane.x + pane.width + 1);
  expect(job.y + job.height).toBeLessThanOrEqual(pane.y + pane.height + 1);
});
