/** Everything else section 6 asks for: selection, tree, pan/zoom, view edits, details, keyboard. */
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import {
  byId,
  downloadJson,
  fitAll,
  linesWith,
  matchesOf,
  openBundle,
  openEditMenu,
  readEmbeddedBundle,
  screenshotPath,
  selectionOf,
  stateOf,
  TS_BUNDLE,
  viewToggle,
  watchProblems,
  withBundle,
} from "./helpers.js";

const DISPATCH = "sym:src/runner.ts#Runner.dispatch";

test.describe("selection", () => {
  test("shift-click adds, a plain click replaces, Escape clears", async ({ page }) => {
    await openBundle(page, "view:dispatch");
    await byId(page, "dispatch:1").click();
    await byId(page, "dispatch:2").click({ modifiers: ["Shift"] });
    expect(await selectionOf(page)).toEqual(["dispatch:1", "dispatch:2"]);
    await expect(byId(page, "dispatch:1")).toHaveClass(/is-selected/);
    await expect(byId(page, "dispatch:2")).toHaveClass(/is-selected/);
    // Both calls' code: runner.ts once, with the queue and worker definitions after it.
    const files = await page
      .locator("[data-file]")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-file")));
    expect(files).toEqual(["src/runner.ts", "src/queue.ts", "src/worker.ts"]);
    // Shift-click again removes it.
    await byId(page, "dispatch:1").click({ modifiers: ["Shift"] });
    expect(await selectionOf(page)).toEqual(["dispatch:2"]);

    await byId(page, "concept:retry-policy").click();
    expect(await selectionOf(page)).toEqual(["concept:retry-policy"]);
    await expect(byId(page, "dispatch:2")).not.toHaveClass(/is-selected/);

    await page.keyboard.press("Escape");
    expect(await selectionOf(page)).toEqual([]);
    await expect(page.locator("[data-file]")).toHaveCount(0);
    await expect(byId(page, "concept:retry-policy")).not.toHaveClass(/is-selected/);
    await expect(page.locator(".tree-row.is-dimmed")).toHaveCount(0);
  });

  test("a click on empty canvas clears the selection, a drag does not", async ({ page }) => {
    await openBundle(page, "view:dispatch");
    await byId(page, "dispatch:2").click();
    const canvas = page.locator(".panzoom");
    const box = (await canvas.boundingBox())!;
    // drag on empty canvas
    await page.mouse.move(box.x + box.width - 40, box.y + box.height - 40);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 80, box.y + box.height - 70, { steps: 4 });
    await page.mouse.up();
    expect(await selectionOf(page)).toEqual(["dispatch:2"]);
    // plain click on empty canvas
    await page.mouse.click(box.x + box.width - 40, box.y + box.height - 40);
    expect(await selectionOf(page)).toEqual([]);
  });

  test("elements are keyboard accessible: Tab to a step, Enter selects it", async ({ page }) => {
    await openBundle(page, "view:dispatch");
    const step = byId(page, "dispatch:1");
    await step.focus();
    await expect(step).toBeFocused();
    await page.keyboard.press("Enter");
    expect(await selectionOf(page)).toEqual(["dispatch:1"]);
    await expect(step).toHaveClass(/is-selected/);
  });
});

test.describe("file tree and editor stack", () => {
  test("with no selection a clicked file is shown alone and nothing is dimmed", async ({
    page,
  }) => {
    await openBundle(page);
    await expect(page.locator("[data-file]")).toHaveCount(0);
    await page.locator('[data-path="src/queue.ts"]').click();
    await expect(page.locator("[data-file]")).toHaveCount(1);
    const pane = page.locator('[data-file="src/queue.ts"]');
    await expect(pane.locator(".cm-editor")).toBeVisible();
    await expect(pane.locator(".cm-line").first()).toBeVisible();
    await expect(pane.locator(".cm-line.xpl-dim")).toHaveCount(0);
    await expect(pane.locator(".cm-line.xpl-hl")).toHaveCount(0);
    await expect(page.locator(".tree-row.is-dimmed")).toHaveCount(0);
    // Another file replaces it.
    await page.locator('[data-path="config/default.yaml"]').click();
    await expect(page.locator("[data-file]")).toHaveCount(1);
    await expect(page.locator('[data-file="config/default.yaml"] .cm-editor')).toBeVisible();
    // The pane's file header names the file.
    await expect(page.locator('[data-file="config/default.yaml"] .pane-header')).toContainText(
      "default.yaml",
    );
  });

  test("with a selection, a file outside the focus opens on top without dimming; closing removes it", async ({
    page,
  }) => {
    await openBundle(page, "view:dispatch");
    await byId(page, "dispatch:3").click();
    await page.locator('[data-path="src/bus.ts"]').click();
    const files = await page
      .locator("[data-file]")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-file")));
    expect(files).toEqual(["src/bus.ts", "src/runner.ts", "src/queue.ts"]);
    await expect(page.locator('[data-file="src/bus.ts"] .cm-line.xpl-dim')).toHaveCount(0);
    await page.getByRole("button", { name: "Close src/bus.ts" }).click();
    await expect(page.locator('[data-file="src/bus.ts"]')).toHaveCount(0);
    await expect(page.locator("[data-file]")).toHaveCount(2);
  });

  test("YAML and TypeScript panes are highlighted by language", async ({ page }) => {
    await openBundle(page);
    await page.locator('[data-path="src/queue.ts"]').click();
    // CodeMirror wraps highlighted tokens in classed spans.
    await expect(
      page.locator('[data-file="src/queue.ts"] .cm-line span[class]').first(),
    ).toBeVisible();
    await page.locator('[data-path="config/default.yaml"]').click();
    await expect(
      page.locator('[data-file="config/default.yaml"] .cm-line span[class]').first(),
    ).toBeVisible();
  });

  test("the file tree collapses and directories fold", async ({ page }) => {
    await openBundle(page);
    await expect(page.locator('[data-path="src/queue.ts"]')).toBeVisible();
    await page.locator('.tree-row.is-dir[data-path="src"]').click();
    await expect(page.locator('[data-path="src/queue.ts"]')).toHaveCount(0);
    await page.locator('.tree-row.is-dir[data-path="src"]').click();
    await expect(page.locator('[data-path="src/queue.ts"]')).toBeVisible();
    await page.getByRole("button", { name: "Collapse the file tree" }).click();
    await expect(page.locator(".tree")).toHaveCount(0);
    await page.getByRole("button", { name: "Expand the file tree" }).click();
    await expect(page.locator(".tree")).toBeVisible();
  });

  test("selecting a range of code looks up every line it covers", async ({ page }) => {
    await openBundle(page, "view:dispatch");
    await byId(page, "dispatch:3").click();
    const runner = page.locator('[data-file="src/runner.ts"]');
    await expect.poll(() => linesWith(runner, ".xpl-hl")).toEqual([76, 77, 78]);
    // Drag from line 74 to line 77: the lifeline at 74 (the concept 72-83 on top) and the step (76-78).
    const from = await runner.locator('.cm-line[data-line="74"]').boundingBox();
    const to = await runner.locator('.cm-line[data-line="77"]').boundingBox();
    await page.mouse.move(from!.x + 90, from!.y + 9);
    await page.mouse.down();
    await page.mouse.move(to!.x + 120, to!.y + 9, { steps: 6 });
    await page.mouse.up();
    await expect
      .poll(() => matchesOf(page))
      .toEqual(["concept:retry-policy", "dispatch:3", "sym:src/runner.ts#Runner.dispatch"]);
  });
});

test.describe("graph view", () => {
  test("double-click drills into a node, the collapse button takes it back; edits are unsaved without a server", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await openBundle(page);
    const group = byId(page, "grp:scheduling");
    await expect(group).not.toHaveClass(/is-container/);
    await group.dblclick();
    // The group opens into its members: it is a container now, with the two files inside.
    await expect(group).toHaveClass(/is-container/);
    await expect(group.locator('[data-element-id="file:src/runner.ts"]')).toBeVisible();
    await expect(group.locator('[data-element-id="file:src/queue.ts"]')).toBeVisible();
    const state = await stateOf(page);
    expect(state.include).toEqual([
      "grp:scheduling",
      "file:src/worker.ts",
      "file:src/metrics.ts",
      "file:src/runner.ts",
      "file:src/queue.ts",
    ]);
    // A click on a child selects the child only, not the container around it.
    await byId(page, "file:src/queue.ts").click();
    expect(await selectionOf(page)).toEqual(["file:src/queue.ts"]);
    // Nested drill: the file opens into its symbols.
    await byId(page, "file:src/queue.ts").dblclick();
    await expect(byId(page, "sym:src/queue.ts#Queue")).toBeVisible();
    await page.locator(".diagram").screenshot({ path: screenshotPath("overview-drilled-in") });

    // Not persisted anywhere: the header says so and offers the download.
    await expect(page.locator(".save-status")).toHaveText("Unsaved");
    // ... without the header growing a second row.
    expect((await page.locator(".header").boundingBox())!.height).toBeLessThan(60);

    // Collapse the group again.
    await group.locator(':scope > [data-collapse-id="grp:scheduling"]').click();
    await expect(group).not.toHaveClass(/is-container/);
    await expect(byId(page, "file:src/runner.ts")).toHaveCount(0);
    expect((await stateOf(page)).include).toEqual([
      "grp:scheduling",
      "file:src/worker.ts",
      "file:src/metrics.ts",
    ]);
    expect(problems).toEqual([]);
  });

  test("the edge kind toggles change which derived edges are drawn (and are recorded on the view)", async ({
    page,
  }) => {
    await openBundle(page);
    // runner.ts only has `import type` from queue.ts, which the indexer records as type references
    // (a runtime `imports` edge would be wrong), so toggle the `references` kind.
    // (the toggles are in the Edit menu, under "This view"; the menu stays open while they are flipped)
    await expect(await viewToggle(page, '[data-edge-kind="references"]')).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-element-id^="edge:references:"]')).toHaveCount(0);
    await page.evaluate(() => window.__xpl!.select([]));
    await byId(page, "grp:scheduling").dblclick();
    const references = await viewToggle(page, '[data-edge-kind="references"]');
    await references.click();
    await expect(references).toHaveAttribute("aria-checked", "true");
    const state = await stateOf(page);
    expect(state.edgeKinds).toEqual(expect.arrayContaining(["calls", "references"]));
    expect(state.edgeKinds).not.toContain("imports");
    // Elements that reference each other's types now show `references ×n`: on the one arrow between
    // the two boxes, with the calls (a map draws one arrow per pair, its label names each kind).
    const pair = page.locator('[data-element-id$=":file:src/runner.ts->file:src/queue.ts"]');
    await expect(pair).toHaveCount(1);
    await expect(pair).toBeVisible();
    await expect(pair.locator("title")).toContainText(/references ×\d/);
    await references.click();
    await expect(page.locator('[data-element-id^="edge:references:"]')).toHaveCount(0);
    await expect(pair.locator("title")).not.toContainText("references");
  });

  test("the pan/zoom canvas: wheel zooms about the pointer, dragging pans, Fit restores", async ({
    page,
  }) => {
    await openBundle(page);
    const canvas = page.locator(".panzoom");
    const zoom = async () => Number(await canvas.getAttribute("data-zoom"));
    const group = byId(page, "grp:scheduling").locator("> rect.box");
    await expect(group).toBeVisible();
    const fitZoom = await zoom();
    const fitBox = (await group.boundingBox())!;

    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -300);
    await expect.poll(zoom).toBeGreaterThan(fitZoom * 1.2);
    const zoomed = (await group.boundingBox())!;
    expect(zoomed.width).toBeGreaterThan(fitBox.width * 1.2);

    // Drag the background: the content moves by the drag distance.
    const before = (await group.boundingBox())!;
    await page.mouse.move(box.x + box.width - 30, box.y + box.height - 30);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 90, box.y + box.height - 60, { steps: 5 });
    await page.mouse.up();
    const after = (await group.boundingBox())!;
    expect(Math.round(before.x - after.x)).toBe(60);
    expect(Math.round(before.y - after.y)).toBe(30);

    await page.getByRole("button", { name: "Fit to view" }).click();
    await expect.poll(zoom).toBeCloseTo(fitZoom, 2);
    // Buttons and keys.
    await page.getByRole("button", { name: "Zoom in" }).click();
    await expect.poll(zoom).toBeGreaterThan(fitZoom * 1.2);
    await canvas.focus();
    await page.keyboard.press("0");
    await expect.poll(zoom).toBeCloseTo(fitZoom, 2);
  });
});

test.describe("details panel", () => {
  test("shows label, kind, summary, provenance and anchors with their status", async ({ page }) => {
    await openBundle(page, "view:dispatch");
    await byId(page, DISPATCH).click();
    const details = page.locator(".details");
    await expect(details).toContainText("Runner.dispatch");
    await expect(details.locator(".kind-pill")).toHaveText("method");
    await expect(details).toContainText("The hot loop: pop, lease a worker, run, ack or requeue.");
    // Origin llm, with the summary marked as edited by the user.
    const badge = details.locator(".badge.origin-llm");
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute("title", /edited by you: summary/);
    await expect(details.locator(".facts")).toContainText(
      /Origin\s*llm, commit wt-[0-9a-f]+; edited by you: summary/,
    );
    // The stored definition anchor, resolved to lines 42-88.
    const anchor = details.locator(".anchor-row").first();
    await expect(anchor).toContainText("src/runner.ts#Runner.dispatch");
    await expect(anchor).toContainText("L42–88");
    await expect(anchor.locator(".badge")).toHaveText("ok");
    // Clicking an anchor opens its file at that line.
    await anchor.click();
    await expect
      .poll(async () => (await stateOf(page)).cursor)
      .toMatchObject({
        file: "src/runner.ts",
        fromLine: 42,
      });
  });

  test("Explain this shows the skill command when there is no server", async ({ page }) => {
    await openBundle(page, "view:dispatch");
    await byId(page, "concept:retry-policy").click();
    await page.getByRole("button", { name: "Explain this" }).click();
    await expect(page.getByTestId("explain-command")).toHaveText(
      "/code-explainer expand concept:retry-policy",
    );
  });

  test("markdown detail is rendered and its HTML is neutralised", async ({ page }) => {
    await page.addInitScript(() => {
      // Nothing may run: the fixture's detail below contains a script tag and an inline handler.
      (window as unknown as { __pwned?: boolean }).__pwned = false;
    });
    const { html, bundle } = readEmbeddedBundle();
    const explainer = bundle.explainer as { concepts: { detail?: string }[] };
    explainer.concepts[0]!.detail =
      "Uses **exponential** backoff.\n\n<script>window.__pwned = true</script>\n\n" +
      '<img src=x onerror="window.__pwned = true">\n\n[bad](javascript:alert(1)) and [good](https://example.com)';
    await page.route("http://xpl.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: withBundle(html, bundle) }),
    );
    await page.goto("http://xpl.test/?mode=explore");
    await page.waitForFunction(() => window.__xpl !== undefined);
    await byId(page, "concept:retry-policy").click();
    const markdown = page.locator(".details .markdown");
    await expect(markdown.locator("strong")).toHaveText("exponential");
    await expect(markdown).toContainText("<script>window.__pwned = true</script>");
    await expect(markdown.locator("script, img")).toHaveCount(0);
    await expect(markdown.locator("a[href^='javascript']")).toHaveCount(0);
    await expect(markdown.locator("a[href='https://example.com']")).toHaveCount(1);
    expect(await page.evaluate(() => (window as unknown as { __pwned: boolean }).__pwned)).toBe(
      false,
    );
  });
});

test.describe("header", () => {
  test("?view=<id> opens that view", async ({ page }) => {
    await page.goto(`${TS_BUNDLE.href}?view=view:dispatch`);
    await page.waitForFunction(() => window.__xpl !== undefined);
    await expect(page.locator(".diagram")).toHaveAttribute("data-view-id", "view:dispatch");
    await expect(page.locator('.tab[data-view-id="view:dispatch"]')).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  test("view switcher, Present and Exit, and the explainer download", async ({ page }) => {
    await openBundle(page);
    await expect(page.locator("h1.title")).toHaveText("Job runner");
    await expect(page.locator('.tab[data-view-id="view:overview"]')).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.locator('.tab[data-view-id="view:dispatch"]').click();
    await expect(page.locator(".diagram")).toHaveAttribute("data-view-id", "view:dispatch");
    expect((await stateOf(page)).viewType).toBe("sequence");
    // The edge kind toggles are for graph views only.
    await openEditMenu(page);
    await expect(page.locator(".edge-kinds")).toHaveCount(0);
    await page.keyboard.press("Escape");
    // The explainer has a tour, so Present is on offer (tours.spec.ts plays it); Explore is the start.
    await expect(page.locator(".header")).toHaveAttribute("data-mode", "explore");
    await expect(page.getByRole("button", { name: "Present" })).toBeEnabled();
    await page.getByRole("button", { name: "Present" }).click();
    await expect(page.locator(".header")).toHaveAttribute("data-mode", "present");
    await expect(page.locator(".tab")).toHaveCount(0);
    await page.getByRole("button", { name: "Exit" }).click();
    await expect(page.locator(".tab")).toHaveCount(2);

    // Download: the explainer including this session's view edits.
    await page.locator('.tab[data-view-id="view:overview"]').click();
    await byId(page, "ghost:file:src/bus.ts").click();
    const download = await downloadJson(page);
    expect(download.suggestedFilename()).toBe("jobrunner.explainer.json");
    const saved = JSON.parse(readFileSync((await download.path())!, "utf8")) as {
      title: string;
      views: { id: string; include?: string[]; provenance: { userFields?: string[] } }[];
    };
    expect(saved.title).toBe("Job runner");
    const overview = saved.views.find((v) => v.id === "view:overview")!;
    expect(overview.include).toContain("file:src/bus.ts");
    expect(overview.provenance.userFields).toEqual(["include"]);
  });
});

test.describe("hit targets", () => {
  /**
   * Every `data-element-id` element must take a click where automation and users aim: the centre of its
   * bounding box (for an SVG group: of everything in it). Edges are thin routes with things drawn over
   * parts of them, so their groups are built around an anchor on the route (see GraphView).
   */
  async function everyElementTakesAClick(page: import("@playwright/test").Page) {
    // a big diagram starts zoomed in, with part of it out of sight: fit it, so that every element is on screen
    await fitAll(page);
    const ids = await page
      .locator("[data-element-id]")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-element-id")!));
    expect(ids.length).toBeGreaterThan(3);
    for (const id of ids) {
      const target = byId(page, id);
      await target.click({ trial: true, timeout: 5000 });
      await page.evaluate(() => window.__xpl!.select([]));
      await target.click({ timeout: 5000 });
      const selection = await selectionOf(page);
      if (id.startsWith("ghost:")) {
        expect(selection, `clicking ${id} must not select anything`).toEqual([]);
        break; // a click on a ghost changes the view, which re-renders the list
      }
      expect(selection, `clicking ${id}`).toEqual([id]);
    }
  }

  test("graph elements: nodes, edges, stubs and ghosts", async ({ page }) => {
    await openBundle(page);
    await expect(byId(page, "edge:job-completed")).toBeVisible();
    await everyElementTakesAClick(page);
  });

  test("graph elements with nested containers", async ({ page }) => {
    await openBundle(page);
    await byId(page, "grp:scheduling").dblclick();
    await byId(page, "file:src/queue.ts").dblclick();
    await expect(byId(page, "sym:src/queue.ts#Queue")).toBeVisible();
    await page.evaluate(() => window.__xpl!.select([]));
    await everyElementTakesAClick(page);
  });

  test("sequence elements: lifelines and steps", async ({ page }) => {
    await openBundle(page, "view:dispatch");
    await everyElementTakesAClick(page);
  });

  test("concept list items", async ({ page }) => {
    await openBundle(page);
    await byId(page, "concept:retry-policy").click({ trial: true });
    await byId(page, "concept:retry-policy").click();
    expect(await selectionOf(page)).toEqual(["concept:retry-policy"]);
  });
});
