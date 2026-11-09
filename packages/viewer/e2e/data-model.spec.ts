/**
 * A data-model view (`GraphView.boxText: "members"`, drafted by `xpl draft data`): a table per type, a row per
 * field with the type its code names, and arrows from a field to the type it holds. Each row is linked both
 * ways: a click on it shows the field's line, and the caret in that line lights the row.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  byId,
  linesWith,
  matchesOf,
  readEmbeddedBundle,
  watchProblems,
  withBundle,
  type Loose,
} from "./helpers.js";

const JOB = "sym:src/queue.ts#Job";
const DEAD = "sym:src/queue.ts#DeadJob";
const FIELD = "sym:src/queue.ts#DeadJob.job";

async function openDataView(page: Page): Promise<void> {
  const { html, bundle } = readEmbeddedBundle();
  (bundle as Loose).explainer.views.push({
    id: "view:data",
    type: "graph",
    title: "What a job carries",
    scope: { root: "file:src/queue.ts", depth: 1 },
    provenance: { origin: "llm" },
    include: [
      JOB,
      `${JOB}.id`,
      `${JOB}.attempts`,
      DEAD,
      FIELD,
      `${DEAD}.error`,
      "sym:src/queue.ts#Queue",
      "sym:src/queue.ts#Queue.dead",
      "sym:src/queue.ts#Queue.ready",
    ],
    edgeKinds: ["references"],
    boxText: "members",
    stubs: { mode: "none" },
  } satisfies Loose);
  await page.route("http://xpl.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: withBundle(html, bundle) }),
  );
  await page.goto("http://xpl.test/?mode=explore&view=view:data");
  await page.waitForFunction(() => window.__xpl !== undefined);
}

// (which arrows a data view derives: core members.test.ts; where a row's arrow starts: graphLayout.test.ts)
test("a type is drawn as a table: one row per field, with the type its code names", async ({
  page,
}) => {
  const problems = watchProblems(page);
  await openDataView(page);
  const table = byId(page, DEAD);
  await expect(table).toHaveClass(/is-table/);
  // rows in the order the code declares them, each with the type its line names (read from the page's source)
  await expect(table.locator(".node.is-row .row-name")).toHaveText(["job", "error"]);
  await expect(table.locator(".node.is-row .row-type")).toHaveText(["Job", "string"]);
  await expect(byId(page, `edge:references:${FIELD}->${JOB}`)).toHaveCount(1);
  expect(problems).toEqual([]);
});

test("a click on a row shows the field's line, and the caret in that line lights the row", async ({
  page,
}) => {
  const problems = watchProblems(page);
  await openDataView(page);
  await byId(page, FIELD).click();
  await expect(byId(page, FIELD)).toHaveClass(/is-selected/);
  const queue = page.locator('[data-file="src/queue.ts"]');
  await expect.poll(() => linesWith(queue, ".xpl-hl")).toEqual([15]);
  // Details names it a field, not the index's "variable"
  await expect(page.locator(".details-head .kind-pill")).toHaveText("field");

  // the other way: the caret on the `error` field's line lights its row, and only that one
  await page.evaluate(() => window.__xpl!.setCursor("src/queue.ts", 16));
  await expect.poll(() => matchesOf(page)).toEqual([`${DEAD}.error`]);
  await expect(byId(page, `${DEAD}.error`)).toHaveClass(/is-match/);
  await expect(page.locator(".node.is-match")).toHaveCount(1);
  expect(problems).toEqual([]);
});
