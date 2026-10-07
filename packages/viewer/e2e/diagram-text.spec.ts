import { expect, test } from "@playwright/test";
import { focusOf, linesWith, openBundle, openVariant, selectionOf, viewToggle } from "./helpers.js";

const from = "sym:src/runner.ts#Runner.dispatch";
const to = "sym:src/queue.ts#Queue.pop";

test("map text lists only active nodes and filtered relationships with trust and checked source", async ({
  page,
}) => {
  await openVariant(
    page,
    (bundle) => {
      Object.assign(
        bundle.explainer.views.find((v: { id: string }) => v.id === "view:overview"),
        {
          include: [from, to],
          edgeKinds: ["calls"],
          stubs: { mode: "none" },
        },
      );
    },
    "?mode=explore&view=view:overview",
  );
  const toggle = page.getByRole("button", { name: "Text view", exact: true });
  await toggle.focus();
  await page.keyboard.press("Enter");
  const text = page.getByRole("region", { name: "Diagram as text" });
  await expect(text.getByRole("list", { name: "Nodes" }).getByRole("button")).toHaveText([
    "Queue.pop",
    "Runner.dispatch",
  ]);
  const links = text.getByRole("list", { name: "Relationships" });
  const call = links.getByRole("button", { name: "Runner.dispatch to Queue.pop: calls ×1" });
  await expect(call).toHaveAccessibleDescription("heuristic");
  await page.keyboard.press("Tab");
  await expect(text.getByRole("button", { name: "Queue.pop", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(call).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => selectionOf(page)).toEqual([`edge:calls:${from}->${to}`]);
  await expect
    .poll(() => linesWith(page.locator('[data-file="src/runner.ts"]'), ".xpl-hl"))
    .toEqual([46]);
  await (await viewToggle(page, '[data-edge-kind="calls"]')).click();
  await page.keyboard.press("Escape");
  await expect(links.getByRole("button")).toHaveCount(0);
  await expect(text).not.toContainText("Worker.run");
});

for (const type of ["sequence", "flow"] as const) {
  test(`${type} text selects a checked step using native buttons`, async ({ page }) => {
    if (type === "sequence") await openBundle(page, "view:dispatch");
    else
      await openVariant(
        page,
        (bundle) => {
          bundle.explainer.views.find((v: { id: string }) => v.id === "view:dispatch").type =
            "flow";
        },
        "?mode=explore&view=view:dispatch",
      );
    await page.getByRole("button", { name: "Text view", exact: true }).click();
    const text = page.getByRole("region", { name: "Diagram as text" });
    await expect(text.getByRole("list", { name: "Relationships" })).toContainText("to");
    const button = text.getByRole("button", { name: /requeue\(job, backoff\)/ }).first();
    await button.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => selectionOf(page)).toEqual(["dispatch:3"]);
    await expect
      .poll(() => linesWith(page.locator('[data-file="src/runner.ts"]'), ".xpl-hl"))
      .toEqual([76, 77, 78]);
    await expect(text).toContainText("authored");
    if (type === "flow") {
      await text
        .getByRole("list", { name: "Relationships" })
        .getByRole("button", { name: "run(job) to requeue(job, backoff)", exact: true })
        .click();
      await expect.poll(() => selectionOf(page)).toEqual(["dispatch:2->dispatch:3:0"]);
      await expect
        .poll(() => linesWith(page.locator('[data-file="src/runner.ts"]'), ".xpl-hl"))
        .toEqual([60, 61, 76, 77, 78]);
    }
  });
}

test("flow text distinguishes outgoing relationships and endpoint source", async ({ page }) => {
  await openVariant(
    page,
    (bundle) => {
      const view = bundle.explainer.views.find((v: { id: string }) => v.id === "view:dispatch");
      view.type = "flow";
      view.steps[0].next = [
        { step: "dispatch:2", label: "run" },
        { step: "dispatch:3", label: "retry" },
      ];
    },
    "?mode=explore&view=view:dispatch",
  );
  await page.getByRole("button", { name: "Text view", exact: true }).click();
  const links = page.getByRole("list", { name: "Relationships" });
  const run = links.getByRole("button", { name: "pop() to run(job): run", exact: true });
  const retry = links.getByRole("button", {
    name: "pop() to requeue(job, backoff): retry",
    exact: true,
  });
  await run.click();
  await expect.poll(() => selectionOf(page)).toEqual(["dispatch:1->dispatch:2:0"]);
  await expect(run).toHaveAttribute("aria-pressed", "true");
  await expect(retry).toHaveAttribute("aria-pressed", "false");
  await expect
    .poll(() => linesWith(page.locator('[data-file="src/runner.ts"]'), ".xpl-hl"))
    .toEqual([46, 60, 61]);
  await retry.click();
  await expect.poll(() => selectionOf(page)).toEqual(["dispatch:1->dispatch:3:1"]);
  await expect(run).toHaveAttribute("aria-pressed", "false");
  await expect(retry).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(async () =>
      (await focusOf(page))
        .filter((range) => range.file === "src/runner.ts")
        .map((range) => [range.range.startLine, range.range.endLine]),
    )
    .toEqual([
      [46, 46],
      [76, 78],
    ]);
  await expect(page.locator('[data-file="src/runner.ts"] .xpl-hl').first()).toBeVisible();
  await page.getByRole("button", { name: "Text view", exact: true }).click();
  await expect(page.locator('[data-element-id="dispatch:1->dispatch:3:1"]')).toHaveClass(
    /is-selected/,
  );
});
