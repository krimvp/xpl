import { expect, test } from "@playwright/test";
import { byId, openVariant } from "./helpers.js";

test("mixed arrows name their uncertainty and explain the hints in details", async ({ page }) => {
  await openVariant(
    page,
    (bundle) => {
      const refs = bundle.index.refs.filter(
        (ref: { from: string; to: string; kind: string }) =>
          ref.from.startsWith("src/runner.ts#") &&
          ref.to.startsWith("src/queue.ts#") &&
          ref.kind === "call",
      );
      refs[0].resolution = "precise";
      bundle.explainer.views.find((view: { id: string }) => view.id === "view:overview").include = [
        "file:src/runner.ts",
        "file:src/queue.ts",
      ];
    },
    "?mode=explore&view=view:overview",
  );
  const arrow = byId(page, "edge:calls:file:src/runner.ts->file:src/queue.ts");
  await expect(arrow).toHaveClass(/res-mixed/);
  await expect(arrow.locator("title")).toContainText("mixed confidence");
  await arrow.click();
  await expect(page.getByRole("region", { name: "Details", exact: true })).toContainText(
    "some references are hints",
  );
});
