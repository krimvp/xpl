/**
 * The words and the shape of a data map (`GraphView.boxText: "members"`): an arrow from a field's row is
 * named "holds" on the map, its key line, its text view and its matrix; the matrix has one row and column per
 * table; on a phone the tables are laid out top to bottom when that draws them larger. (What a table draws
 * and its two-way code link: data-model.spec.ts.)
 */
import { expect, test, type Page } from "@playwright/test";
import { byId, readEmbeddedBundle, watchProblems, withBundle, type Loose } from "./helpers.js";

const JOB = "sym:src/queue.ts#Job";
const DEAD = "sym:src/queue.ts#DeadJob";
const QUEUE = "sym:src/queue.ts#Queue";
const HOLDS = `edge:references:${DEAD}.job->${JOB}`;

async function openDataMap(page: Page, query = "mode=explore", over: Loose = {}): Promise<void> {
  const { html, bundle } = readEmbeddedBundle();
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
  const problems = watchProblems(page);
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
  expect(problems).toEqual([]);
});

test("the matrix of a data map has a row per table, and a cell names the fields", async ({
  page,
}) => {
  // (three tables are too few for the reader's switch: the view opens as a matrix)
  await openDataMap(page, "mode=explore", { render: "matrix" });
  await expect(page.getByRole("rowheader")).toHaveText(["1Queue", "2DeadJob", "3Job"]);
  await expect(byId(page, HOLDS)).toHaveAccessibleName(/DeadJob → Job: holds \(job\)/);
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
