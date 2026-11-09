/**
 * Accessibility and small-screen round (review 2026-10-03, M9-M15): a Key that covers what is on screen, the
 * page's audience line, readable dimmed code, keyboard focus and names on the map, and short or narrow
 * screens.
 */
import { expect, test } from "@playwright/test";
import {
  ARCHITECTURE_BUNDLE,
  openBundle,
  openEditMenu,
  openVariant,
  readEmbeddedBundle,
  stateOf,
  TS_BUNDLE,
  withBundle,
} from "./helpers.js";

/** True when the focus is on the last visible control of the dialog `selector` (focusTrap.ts FOCUSABLE). */
function lastControlFocused(selector: string): boolean {
  const root = document.querySelector(selector)!;
  const controls = [
    ...root.querySelectorAll<HTMLElement>(
      "input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), a[href], summary",
    ),
  ].filter((el) => el.getClientRects().length > 0);
  return controls.length > 1 && document.activeElement === controls.at(-1);
}

test.describe("who the page is for", () => {
  test("the author's audience line shows under the guide's title", async ({ page }) => {
    const { html, bundle } = readEmbeddedBundle();
    (bundle.explainer as { scope?: unknown }).scope = {
      audience: "Deep dive, for engineers working on the job runner",
    };
    await page.route("http://xpl.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: withBundle(html, bundle) }),
    );
    await page.goto("http://xpl.test/");
    await expect(page.getByTestId("audience")).toHaveText(
      "Deep dive, for engineers working on the job runner",
    );
    await expect(page.locator(".header .title")).toHaveAttribute("title", /Deep dive/);
  });

  test("without one, nothing is shown", async ({ page }) => {
    await page.goto(TS_BUNDLE.href);
    await expect(page.getByTestId("guide")).toBeVisible();
    await expect(page.getByTestId("audience")).toHaveCount(0);
  });
});

test.describe("the Key covers what is on screen", () => {
  test("a system map: outside systems, stores, icons and the see-inside button", async ({
    page,
  }) => {
    await openBundle(page, "view:system", ARCHITECTURE_BUNDLE);
    await page.getByTestId("legend-button").click();
    const key = page.getByTestId("legend");
    await expect(key).toContainText("Something outside this code");
    await expect(key).toContainText("Where data is kept");
    await expect(key).toContainText("Open its own map");
    await expect(key.getByTestId("legend-icons")).toContainText("a person");
    await expect(key.getByTestId("legend-icons")).toContainText("a program");
    // nothing on this map was added or edited by a change
    await expect(key).not.toContainText("What the change did");
  });

  test("the flow has a Key too", async ({ page }) => {
    await openVariant(
      page,
      (bundle) => {
        bundle.explainer.views.find((view: { id: string }) => view.id === "view:dispatch").type =
          "flow";
      },
      "?perspective=flow",
    );
    await expect(page.getByTestId("process-flow")).toBeVisible();
    await page.getByTestId("process-flow").getByTestId("legend-button").click();
    const key = page.getByTestId("legend");
    await expect(key).toContainText("One step");
    await expect(key).toContainText("Then: what runs next");
    await page.keyboard.press("Escape");
    await expect(key).toHaveCount(0);
  });
});

test.describe("the keyboard on a map", () => {
  test("boxes: named label first, no button inside a button, Tab in reading order", async ({
    page,
  }) => {
    await openBundle(page, "view:system", ARCHITECTURE_BUNDLE);
    const names = await page
      .locator('.diagram .nodes .node[role="button"]')
      .evaluateAll((boxes) =>
        boxes.map(
          (box) =>
            [
              box.getAttribute("aria-label") ?? "",
              box.querySelector(":scope > .label")?.textContent ?? "",
            ] as const,
        ),
      );
    expect(names.length).toBeGreaterThan(2);
    for (const [name, label] of names) expect(name.startsWith(label)).toBe(true);
    await expect(page.locator('.diagram [role="button"] [role="button"]')).toHaveCount(0);

    // Tab from the canvas: the boxes come top-down, then left to right
    await page.locator(".diagram .panzoom").focus();
    const order: { top: number; left: number }[] = [];
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      const at = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el?.matches(".node")) return null;
        const box = el.querySelector(":scope > .box")!.getBoundingClientRect();
        return { top: box.top, left: box.left };
      });
      if (at) order.push(at);
    }
    expect(order.length).toBe(names.length);
    for (let i = 1; i < order.length; i++) {
      const [a, b] = [order[i - 1]!, order[i]!];
      expect(a.top < b.top - 4 || (Math.abs(a.top - b.top) <= 8 && a.left <= b.left)).toBe(true);
    }
  });

  test("keyboard focus has its own ring, apart from the selection outline", async ({ page }) => {
    await openBundle(page, "view:system", ARCHITECTURE_BUNDLE);
    const service = page.locator('.diagram [data-element-id="grp:job-runner"]');
    await page.locator('.diagram [data-element-id="grp:operator"]').click();
    await page.locator(".diagram .panzoom").focus();
    // Tab past the zoom buttons (they come first) to the service box (the operator is picked, the service
    // has the focus)
    for (let i = 0; i < 16; i++) {
      await page.keyboard.press("Tab");
      if (await service.evaluate((el) => el === document.activeElement)) break;
    }
    await expect(service).toBeFocused();
    const ring = (id: string) =>
      page
        .locator(`.diagram [data-element-id="${id}"] > .focus-ring`)
        .evaluate((el) => getComputedStyle(el).stroke);
    expect(await ring("grp:job-runner")).not.toBe("none");
    expect(await ring("grp:operator")).toBe("none");
    // the focused box keeps its own outline: focus is not drawn like a picked box
    await expect(service).not.toHaveClass(/is-selected/);
  });

  test("each step's buttons and lists say which step they belong to", async ({ page }) => {
    await page.goto(TS_BUNDLE.href);
    await expect(page.getByTestId("guide")).toBeVisible();
    const names = await page
      .locator(".guide-section .section-actions .btn, [data-testid=snapshot-open]")
      .evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute("aria-label") ?? button.textContent),
      );
    expect(names.length).toBeGreaterThan(2);
    expect(new Set(names).size).toBe(names.length);
    expect(names[0]).toMatch(/^(Open in Map|Open in Flow|Show code), step 1: /);
  });
});

test("dimmed code is mixed toward the background, not faded with opacity", async ({ page }) => {
  await openBundle(page, "view:overview");
  await page.evaluate(() => window.__xpl!.select(["sym:src/runner.ts#Runner.dispatch"]));
  const dim = page.locator(".cm-line.xpl-dim").first();
  await expect(dim).toBeVisible();
  const style = await dim.evaluate((el) => {
    const css = getComputedStyle(el);
    const probe = document.createElement("span");
    probe.style.color = "var(--code-fg-dim)";
    el.appendChild(probe);
    const expected = getComputedStyle(probe).color;
    probe.remove();
    return { opacity: css.opacity, color: css.color, expected };
  });
  expect(style.opacity).toBe("1");
  expect(style.color).toBe(style.expected);
});

test.describe("short and narrow screens", () => {
  test("200% zoom (720×450): the map gets the height, its bottom on screen", async ({ page }) => {
    await page.setViewportSize({ width: 720, height: 450 });
    await page.goto(TS_BUNDLE.href + "?perspective=map");
    const canvas = page.locator(".workspace-diagram .panzoom");
    await expect(canvas).toBeVisible();
    const box = (await canvas.boundingBox())!;
    expect(box.height).toBeGreaterThan(250);
    expect(box.y + box.height).toBeLessThanOrEqual(450);
    await expect(page.locator(".workspace-caption .eyebrow")).toBeHidden();
    // the location bar is one row: the topic's name gives way to the buttons
    expect((await page.locator(".workspace-location").boundingBox())!.height).toBeLessThan(48);
  });

  test("200% zoom (720×450) with a step on screen: the header is one row, the diagram half the height", async ({
    page,
  }) => {
    await openVariant(
      page,
      (bundle) => {
        bundle.explainer.title = "How the job runner hands out jobs and retries them";
        // (a question would take a second caption row)
        bundle.explainer.views[0].scope.question = "Which part hands a job to a worker?";
      },
      "",
      { width: 720, height: 450 },
    );
    await expect.poll(async () => (await stateOf(page)).stepId).toBe("t1");
    await page.getByTestId("perspective-map").click();
    await expect(page.getByTestId("topic-summary")).toBeVisible();
    // (a second header row took 40px of the 450)
    expect((await page.locator(".header").boundingBox())!.height).toBeLessThan(48);
    await expect(page.locator(".workspace-caption .view-question")).toBeHidden();
    const diagram = (await page.locator(".workspace-diagram").boundingBox())!;
    expect(diagram.height).toBeGreaterThanOrEqual(225);
    expect(diagram.y + diagram.height).toBeLessThanOrEqual(450);
  });

  test("a phone: a step picker instead of the pinned list, a tour picker inside the screen", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { html, bundle } = readEmbeddedBundle();
    const explainer = bundle.explainer as { tours: { id: string; title: string }[] };
    explainer.tours.push({
      ...structuredClone(explainer.tours[0]!),
      id: "tour:second",
      title: "A second tour with a long title that does not fit on a phone screen at all",
    });
    await page.route("http://xpl.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: withBundle(html, bundle) }),
    );
    await page.goto("http://xpl.test/");
    await expect(page.getByTestId("guide")).toBeVisible();
    await expect(page.locator(".guide-contents")).toBeHidden();
    const picker = page.getByTestId("guide-step-picker");
    await expect(picker).toBeVisible();
    await expect(picker.locator("option").first()).toHaveText(/^Step 1 of 2: /);
    await picker.selectOption("1");
    await expect.poll(async () => (await stateOf(page)).stepId).toBe("t2");
    for (const el of [
      page.getByTestId("guide-tour-picker"),
      page.locator(".guide-tours-count"),
      picker,
    ]) {
      const at = (await el.boundingBox())!;
      expect(at.x + at.width).toBeLessThanOrEqual(390);
    }
  });

  test("a tablet (768): Edit stays on the header's row", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto(TS_BUNDLE.href + "?perspective=map");
    const present = (await page.getByTestId("mode-present").boundingBox())!;
    const edit = (await page.getByTestId("edit-button").boundingBox())!;
    expect(Math.abs(present.y - edit.y)).toBeLessThan(4);
  });
});

test.describe("finding the way between maps and topics", () => {
  test("a map names the maps its boxes open, as links", async ({ page }) => {
    await page.goto(ARCHITECTURE_BUNDLE.href + "?perspective=map&view=view:system");
    const insides = page.getByTestId("caption-insides");
    await expect(insides).toBeVisible();
    await insides
      .getByRole("button", { name: /^Inside .+ →$/ })
      .first()
      .click();
    await expect.poll(async () => (await stateOf(page)).viewId).toBe("view:overview");
  });

  test("the topic panel follows the diagram on screen", async ({ page }) => {
    await page.goto(TS_BUNDLE.href + "?perspective=map");
    await page.locator('.workspace-diagram [data-element-id="file:src/metrics.ts"]').click();
    await expect(page.getByTestId("topic-summary")).toContainText("metrics");
    await page.getByTestId("perspective-flow").click();
    // the flow does not show what was picked on the map: the panel names the flow and says so
    await expect(page.getByTestId("topic-off-view")).toContainText("is not in this flow");
    await page.getByTestId("perspective-map").click();
    await expect(page.getByTestId("topic-off-view")).toHaveCount(0);
  });
});

test("every code pane can be reached with the keyboard (its code is a tab stop, named after the file)", async ({
  page,
}) => {
  await page.goto(TS_BUNDLE.href);
  await page.getByTestId("perspective-code").click();
  const content = page.locator(".workspace-source .cm-content").first();
  await expect(content).toBeVisible();
  for (const each of await page.locator(".cm-content").all()) {
    await expect(each).toHaveAttribute("tabindex", "0");
    await expect(each).toHaveAttribute("aria-label", /source code/);
  }
});

test.describe("dialogs give the keyboard back where it was", () => {
  test("Feedback keeps Tab inside while open, and Escape returns to its button", async ({
    page,
  }) => {
    await page.goto(TS_BUNDLE.href);
    const opener = page.getByRole("button", { name: /^Feedback/ });
    await opener.click();
    const panel = page.getByRole("dialog", { name: "Reader feedback" });
    await expect(panel).toBeFocused();
    const inside = () => page.evaluate(() => !!document.activeElement?.closest(".feedback-panel"));
    // Shift+Tab from the panel itself goes round to its last control, never to the page behind it
    await page.keyboard.press("Shift+Tab");
    await expect.poll(() => page.evaluate(lastControlFocused, ".feedback-panel")).toBe(true);
    // Tab from the panel's last control comes back to its first
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press("Tab");
      expect(await inside()).toBe(true);
    }
    await page.keyboard.press("Shift+Tab");
    expect(await inside()).toBe(true);
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  test("Search keeps Tab inside both ways while open", async ({ page }) => {
    await page.goto(TS_BUNDLE.href);
    await page.getByRole("button", { name: "Search and guides" }).click();
    const panel = page.getByRole("dialog", { name: "Search and guides" });
    await expect(panel.getByRole("searchbox")).toBeFocused();
    // Shift+Tab from the first control (Close) goes round to the last, and Tab back to the first
    const close = panel.getByRole("button", { name: "Close search" });
    await page.keyboard.press("Shift+Tab");
    await expect(close).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect.poll(() => page.evaluate(lastControlFocused, ".search-library")).toBe(true);
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
  });

  for (const [item, name] of [
    ["edit-review", "Mark as reviewed"],
    ["edit-save-html", "Save as HTML"],
  ] as const)
    test(`${name}: Escape gives the focus back to the Edit button`, async ({ page }) => {
      await page.goto(TS_BUNDLE.href);
      await (await openEditMenu(page)).getByTestId(item).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId("edit-button")).toBeFocused();
    });
});

test("a Tour picture says in words what it shows and what it lights up", async ({ page }) => {
  await page.goto(TS_BUNDLE.href);
  const picture = page.getByTestId("guide-snapshot").first();
  await expect(picture).toHaveAttribute("aria-label", /^Diagram: /);
  // (the drawing itself is hidden from screen readers: these words stand in for it)
  await expect(picture).toHaveAccessibleDescription(/^Shows \d+ boxes: .+\. Lit: Scheduling\.$/);
});

test("Enter on a map box shows its code, as the diagram's keyboard hint says", async ({ page }) => {
  await page.goto(TS_BUNDLE.href + "?perspective=map");
  const canvas = page.locator(".workspace-diagram .panzoom");
  await expect(canvas).toHaveAccessibleDescription(/Enter: show its code\./);
  await expect(page.locator(".workspace-source")).toHaveCount(0);
  const box = page.locator('.workspace-diagram [data-element-id="file:src/worker.ts"]');
  await box.focus();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await stateOf(page)).selection).toEqual(["file:src/worker.ts"]);
  await expect(page.locator(".workspace-source .cm-editor").first()).toBeVisible();
});
