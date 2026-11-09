import { expect, test } from "@playwright/test";
import { byId, linesWith, openBundle, watchProblems } from "./helpers.js";

const RUST_BUNDLE = new URL("../dist/bundles/rs-jobrunner.html", import.meta.url);

test("Rust symbol selection highlights source and reports bounded heuristic call coverage", async ({
  page,
}) => {
  const problems = watchProblems(page);
  await openBundle(page, "view:rust", RUST_BUNDLE);
  await byId(page, "sym:src/worker.rs#demo.handlers.echo").click();
  const pane = page.locator('.pane[data-file="src/worker.rs"]');
  await expect(pane).toBeVisible();
  await expect(pane.locator('.cm-line[data-line="106"]')).toContainText("pub fn echo");
  await expect.poll(() => linesWith(pane, ".xpl-hl")).toEqual([106, 107, 108]);
  await byId(page, "sym:src/queue.rs#JobQueue.pop").click();
  const traitPane = page.locator('.pane[data-file="src/queue.rs"]');
  await expect(traitPane).toBeVisible();
  await expect.poll(() => linesWith(traitPane, ".xpl-hl")).toEqual([22]);
  await expect(traitPane.locator('.cm-line[data-line="22"]')).toContainText(
    "fn pop(&mut self) -> Option<Job>;",
  );
  await expect(page.getByTestId("analysis-coverage").locator("summary")).toHaveText(
    "Some arrows may be missing: xpl could not analyze all the code in 3 files this guide links to.",
  );
  await expect(page.locator(".diagram .edge")).not.toHaveCount(0);
  // what xpl could read, one plain line per language: About this guide, on the reading page (the tools' own
  // report is for authors, with `xpl index --verbose`)
  await page.goto(RUST_BUNDLE.href);
  await page.getByTestId("explanation-info").locator(":scope > summary").click();
  const notice = page.getByTestId("analysis-details");
  await notice.locator("summary").click();
  await expect(notice.locator("summary")).toHaveText(
    "What xpl could read: 13 files. Some languages only in part.",
  );
  await expect(notice).toContainText(
    "Rust (9 files): names in part; calls and imports matched by name, so some can be missing; no inherits, implements, type uses, reads or writes.",
  );
  await expect(notice).not.toContainText("rust-analyzer");
  expect(problems).toEqual([]);
});
