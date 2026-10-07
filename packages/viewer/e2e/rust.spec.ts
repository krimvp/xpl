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
  const notice = page.getByTestId("analysis-coverage");
  await notice.locator("summary").click();
  await expect(notice).toContainText(
    "rust (rust-tags): named symbols, full declaration ranges, nesting partial (9/9 files analyzed)",
  );
  await expect(notice).toContainText("rust (rust-tags): calls partial (9/9 files analyzed)");
  await expect(notice).toContainText(
    "Heuristic calls cover only bare names between unambiguous root-level functions in the same file.",
  );
  await expect(notice).toContainText(
    "rust (rust-tags): imports, inheritance, implementations, type references, reads, writes unsupported (0/9 files analyzed)",
  );
  await expect(notice).toContainText("Syntax tags omit macro-generated declarations");
  await expect(notice).not.toContainText("rust-analyzer");
  await expect(page.locator(".diagram .edge")).toHaveCount(0);
  expect(problems).toEqual([]);
});
