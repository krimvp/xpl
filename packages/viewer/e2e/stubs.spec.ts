/**
 * A crowded view: how the diagram keeps where it stops readable (ARCHITECTURE.md sections 4.4 and 6).
 * Ghost boxes that stand for many elements ("rest of <file>", "N more") open a menu of them, the caption
 * has a Stubs control (top / all / none), and both are view edits like the edge-kind toggles.
 *
 * The page is the viewer with a synthetic repo instead of the fixture: `src/hub.ts` (a class with `run` and
 * ten other methods) is shown in part, only `Hub.run`; `src/app.ts#main` calls a function in each of twelve
 * other files, `fNN` NN+1 times; `fn00` calls `Hub.run` back; `Hub.run` calls its ten siblings once each.
 * Default policy: rest of hub.ts (10) and the 7 most called files stay, the other five files fold into
 * "+5 more" (out) and the one that calls in into "+1 more" (in).
 */
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import {
  byId,
  downloadJson,
  fitAll,
  openEditMenu,
  readEmbeddedBundle,
  screenshotPath,
  selectionOf,
  stateOf,
  viewToggle,
  watchProblems,
  withBundle,
} from "./helpers.js";

const FILES = 12;
const pad = (n: number) => String(n).padStart(2, "0");
const RUN = "sym:src/hub.ts#Hub.run";
const MAIN = "sym:src/app.ts#main";

interface Sym {
  file: string;
  path: string;
  kind: string;
  start: number;
  end: number;
  parent?: string;
}

function crowdedBundle(view: Record<string, unknown> = {}) {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `// line ${i + 1}`).join("\n");
  const sizes: Record<string, number> = { "src/hub.ts": 300, "src/app.ts": 40 };
  for (let i = 0; i < FILES; i++) sizes[`src/f${pad(i)}.ts`] = 10;
  const symbols: Sym[] = [
    { file: "src/hub.ts", path: "Hub", kind: "class", start: 1, end: 290 },
    {
      file: "src/hub.ts",
      path: "Hub.run",
      kind: "method",
      start: 5,
      end: 20,
      parent: "src/hub.ts#Hub",
    },
    ...Array.from({ length: 10 }, (_, i) => ({
      file: "src/hub.ts",
      path: `Hub.m${i}`,
      kind: "method",
      start: 21 + i * 20,
      end: 40 + i * 20,
      parent: "src/hub.ts#Hub",
    })),
    { file: "src/app.ts", path: "main", kind: "function", start: 1, end: 30 },
    ...Array.from({ length: FILES }, (_, i) => ({
      file: `src/f${pad(i)}.ts`,
      path: `fn${pad(i)}`,
      kind: "function",
      start: 1,
      end: 9,
    })),
  ];
  const ref = (from: string, to: string, line: number) => ({
    from,
    to,
    kind: "call",
    site: { startLine: line, endLine: line, startCol: 3, endCol: 20 },
    resolution: "precise",
  });
  const refs = [
    ...Array.from({ length: 10 }, (_, i) =>
      ref("src/hub.ts#Hub.run", `src/hub.ts#Hub.m${i}`, 6 + i),
    ),
    ...Array.from({ length: FILES }, (_, i) =>
      Array.from({ length: i + 1 }, (_, k) =>
        ref("src/app.ts#main", `src/f${pad(i)}.ts#fn${pad(i)}`, 2 + k),
      ),
    ).flat(),
    ref("src/f00.ts#fn00", "src/hub.ts#Hub.run", 3),
  ];
  const index = {
    schema: "code-explainer/index@0",
    commit: "crowd",
    tool: "e2e",
    languages: {},
    files: Object.entries(sizes).map(([path, n]) => ({
      path,
      language: "typescript",
      hash: `sha256:${path}`,
      lines: n,
    })),
    symbols: symbols.map((s) => ({
      id: `${s.file}#${s.path}`,
      file: s.file,
      path: s.path,
      kind: s.kind,
      range: { startLine: s.start, endLine: s.end },
      hash: `sha256:${s.file}#${s.path}`,
      ...(s.parent ? { parent: s.parent } : {}),
    })),
    refs,
  };
  const explainer = {
    schema: "code-explainer@0",
    title: "Crowded",
    repo: { name: "acme/crowded", commit: "crowd" },
    index: { path: ".explainer/index-crowd.json", commit: "crowd" },
    nodes: [],
    edges: [],
    concepts: [],
    views: [
      {
        id: "view:crowd",
        type: "graph",
        title: "Around Hub.run",
        scope: { root: "repo", depth: 1, question: "What does Hub.run touch?" },
        include: [RUN, MAIN],
        provenance: { origin: "llm", commit: "crowd" },
        ...view,
      },
    ],
    tours: [
      {
        id: "tour:crowd",
        title: "Crowd",
        steps: [
          { id: "t1", view: "view:crowd", focus: [RUN], note: "Hub.run and everything around it." },
        ],
      },
    ],
  };
  const files = Object.fromEntries(Object.entries(sizes).map(([path, n]) => [path, lines(n)]));
  return { schema: "code-explainer/bundle@0", explainer, index, files };
}

async function openCrowded(page: Page, view: Record<string, unknown> = {}) {
  const { html } = readEmbeddedBundle();
  await page.route("http://xpl.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: withBundle(html, crowdedBundle(view)) }),
  );
  await page.goto("http://xpl.test/?mode=explore");
  await page.waitForFunction(() => window.__xpl !== undefined);
  await expect(byId(page, RUN)).toBeVisible();
}

const ghostBoxes = (page: Page) => page.locator(".node.ghost");
const menu = (page: Page) => page.getByTestId("ghost-menu");
const menuTargets = (page: Page) =>
  menu(page).evaluate((el) =>
    [...el.querySelectorAll("[data-ghost-target]")].map((b) => b.getAttribute("data-ghost-target")),
  );

test.describe("the default policy", () => {
  test("draws at most 8 ghosts plus one overflow ghost per direction, and folds the rest of a partly shown file", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await openCrowded(page);
    // 7 files, the rest of hub.ts, "+5 more" (out) and "+1 more" (in)
    await expect(ghostBoxes(page)).toHaveCount(10);
    const state = await stateOf(page);
    expect(state.stubs).toEqual({ mode: "top", max: 8 });
    expect(state.graph!.ghosts).toEqual([
      "ghost:file:src/f05.ts",
      "ghost:file:src/f06.ts",
      "ghost:file:src/f07.ts",
      "ghost:file:src/f08.ts",
      "ghost:file:src/f09.ts",
      "ghost:file:src/f10.ts",
      "ghost:file:src/f11.ts",
      "ghost:more:in",
      "ghost:more:out",
      "ghost:rest:file:src/hub.ts",
    ]);
    await expect(byId(page, "ghost:rest:file:src/hub.ts")).toContainText("rest of hub.ts");
    await expect(byId(page, "ghost:rest:file:src/hub.ts")).toContainText("calls ×10");
    await expect(byId(page, "ghost:more:out")).toContainText("+5 more");
    await expect(byId(page, "ghost:more:in")).toContainText("+1 more");
    // folded ghosts say so: they open a list instead of adding something
    await expect(byId(page, "ghost:more:out")).toHaveAttribute("aria-haspopup", "menu");
    await expect(byId(page, "ghost:file:src/f11.ts")).not.toHaveAttribute("aria-haspopup", "menu");
    // the Edit menu says which mode it is
    await expect(await viewToggle(page, '[data-stub-mode="top"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator('[data-stub-mode="all"]')).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.press("Escape");
    await page.locator(".diagram").screenshot({ path: screenshotPath("crowded-top") });
    expect(problems).toEqual([]);
  });

  test("a view can ask for a smaller or larger top", async ({ page }) => {
    await openCrowded(page, { stubs: { max: 3 } });
    await expect(ghostBoxes(page)).toHaveCount(5); // f09, f10, f11, "+n more" both ways
    expect((await stateOf(page)).stubs).toEqual({ mode: "top", max: 3 });
  });
});

test.describe("the ghost menu", () => {
  test("a click on 'rest of' opens the folded elements with their counts; picking one adds it", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await openCrowded(page);
    await byId(page, "ghost:rest:file:src/hub.ts").click();
    await expect(menu(page)).toBeVisible();
    await expect(menu(page)).toHaveAttribute("data-ghost-id", "ghost:rest:file:src/hub.ts");
    await expect(menu(page)).toContainText("rest of hub.ts");
    // the whole file first, then the ten methods; a click did not add anything
    expect(await menuTargets(page)).toEqual([
      "file:src/hub.ts",
      ...Array.from({ length: 10 }, (_, i) => `sym:src/hub.ts#Hub.m${i}`),
    ]);
    expect((await stateOf(page)).include).toEqual([RUN, MAIN]);
    await expect(menu(page).locator('[data-ghost-target="sym:src/hub.ts#Hub.m3"]')).toContainText(
      "Hub.m3",
    );
    await expect(menu(page).locator('[data-ghost-target="sym:src/hub.ts#Hub.m3"]')).toContainText(
      "calls ×1",
    );
    await page.locator(".diagram").screenshot({ path: screenshotPath("crowded-menu") });

    await menu(page).locator('[data-ghost-target="sym:src/hub.ts#Hub.m3"]').click();
    await expect(menu(page)).toHaveCount(0);
    await expect(byId(page, "sym:src/hub.ts#Hub.m3")).toBeVisible();
    expect((await stateOf(page)).include).toEqual([RUN, MAIN, "sym:src/hub.ts#Hub.m3"]);
    // Hub.run's call to m3 is an edge now, and the rest of hub.ts lost one element
    await expect(byId(page, `edge:calls:${RUN}->sym:src/hub.ts#Hub.m3`)).toBeVisible();
    await byId(page, "ghost:rest:file:src/hub.ts").click();
    expect(await menuTargets(page)).not.toContain("sym:src/hub.ts#Hub.m3");
    await expect(page.locator(".save-status")).toHaveText("Unsaved");
    expect(problems).toEqual([]);
  });

  test("a long menu scrolls with the wheel; a turn of the wheel over the diagram puts it away", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 700 });
    await openCrowded(page);
    await byId(page, "ghost:rest:file:src/hub.ts").click();
    const box = (await menu(page).boundingBox())!;
    expect(await menu(page).evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 250);
    await expect.poll(() => menu(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await expect(menu(page)).toBeVisible();
    const canvas = (await page.locator(".panzoom").boundingBox())!;
    await page.mouse.move(canvas.x + 20, canvas.y + 20);
    await page.mouse.wheel(0, -120);
    await expect(menu(page)).toHaveCount(0);
  });

  test("'the whole file' wraps what is shown in the file and leaves nothing of it outside", async ({
    page,
  }) => {
    await openCrowded(page);
    await byId(page, "ghost:rest:file:src/hub.ts").click();
    await menu(page).locator('[data-ghost-target="file:src/hub.ts"]').click();
    await expect(byId(page, "file:src/hub.ts")).toHaveClass(/is-container/);
    await expect(byId(page, "file:src/hub.ts").locator(`[data-element-id="${RUN}"]`)).toBeVisible();
    await expect(byId(page, "ghost:rest:file:src/hub.ts")).toHaveCount(0);
  });

  test("the overflow ghost lists every element it stands for, most referenced first", async ({
    page,
  }) => {
    await openCrowded(page);
    await byId(page, "ghost:more:out").click();
    await expect(menu(page)).toContainText("+5 more");
    expect(await menuTargets(page)).toEqual([
      "file:src/f04.ts",
      "file:src/f03.ts",
      "file:src/f02.ts",
      "file:src/f01.ts",
      "file:src/f00.ts",
    ]);
    await expect(menu(page).locator('[data-ghost-target="file:src/f04.ts"]')).toContainText("×5");
    await menu(page).locator('[data-ghost-target="file:src/f04.ts"]').click();
    // f04 is a box now; the ghosts are recounted: the four left are still folded
    await expect(byId(page, "file:src/f04.ts")).toBeVisible();
    await expect(byId(page, "ghost:more:out")).toContainText("+4 more");
    await expect(byId(page, `edge:calls:${MAIN}->file:src/f04.ts`)).toBeVisible();
  });

  test("Escape, a click elsewhere, the same ghost again and another ghost close or replace it", async ({
    page,
  }) => {
    await openCrowded(page);
    await byId(page, MAIN).click();
    await byId(page, "ghost:more:out").click();
    await expect(menu(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu(page)).toHaveCount(0);
    // Escape closed the menu only: the selection is still there (a second Escape would clear it)
    expect(await selectionOf(page)).toEqual([MAIN]);
    expect((await stateOf(page)).include).toEqual([RUN, MAIN]);

    await byId(page, "ghost:more:out").click();
    await expect(menu(page)).toBeVisible();
    await byId(page, "ghost:more:out").click(); // toggles
    await expect(menu(page)).toHaveCount(0);

    await byId(page, "ghost:more:out").click();
    await byId(page, "ghost:rest:file:src/hub.ts").click(); // another folded ghost takes over
    await expect(menu(page)).toHaveCount(1);
    await expect(menu(page)).toHaveAttribute("data-ghost-id", "ghost:rest:file:src/hub.ts");

    const canvas = (await page.locator(".panzoom").boundingBox())!;
    await page.mouse.click(canvas.x + 6, canvas.y + canvas.height - 6); // empty canvas
    await expect(menu(page)).toHaveCount(0);
  });

  test("keyboard: Enter opens the menu on the first element, arrows move, Escape returns to the ghost", async ({
    page,
  }) => {
    await openCrowded(page);
    await byId(page, "ghost:more:out").focus();
    await page.keyboard.press("Enter");
    await expect(menu(page)).toBeVisible();
    await expect(menu(page).locator("button").first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu(page).locator("button").nth(1)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp"); // wraps
    await expect(menu(page).locator("button").last()).toBeFocused();
    await page.keyboard.press("Home");
    await page.keyboard.press("Enter"); // adds the first element
    await expect(byId(page, "file:src/f04.ts")).toBeVisible();
    await expect(menu(page)).toHaveCount(0);

    await byId(page, "ghost:more:out").focus();
    await page.keyboard.press("Space");
    await expect(menu(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu(page)).toHaveCount(0);
    await expect(byId(page, "ghost:more:out")).toBeFocused();
  });

  test("a plain ghost still adds its element with one click", async ({ page }) => {
    await openCrowded(page);
    await byId(page, "ghost:file:src/f11.ts").click();
    await expect(menu(page)).toHaveCount(0);
    expect((await stateOf(page)).include).toEqual([RUN, MAIN, "file:src/f11.ts"]);
    await expect(byId(page, "file:src/f11.ts")).toBeVisible();
    await expect(byId(page, "ghost:file:src/f11.ts")).toHaveCount(0);
  });

  test("a talk does not open it: a ghost is a picture in Present", async ({ page }) => {
    await openCrowded(page);
    expect(await page.evaluate(() => window.__xpl!.present("tour:crowd", 1))).toBe(true);
    await expect(page.getByTestId("present")).toBeVisible();
    await byId(page, "ghost:more:out").click();
    await byId(page, "ghost:rest:file:src/hub.ts").click();
    await expect(menu(page)).toHaveCount(0);
    expect((await stateOf(page)).include).toEqual([RUN, MAIN]);
    // and nothing on screen, not even the Edit menu, edits the view
    await expect(page.getByTestId("stubs-control")).toHaveCount(0);
    await openEditMenu(page);
    await expect(page.getByTestId("stubs-control")).toHaveCount(0);
  });
});

test.describe("the Stubs control", () => {
  test("top, all and none change how many ghosts are drawn, and are recorded on the view", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await openCrowded(page);
    // (in the Edit menu, which stays open while the toggles are flipped)
    await openEditMenu(page);
    const mode = (m: string) => page.locator(`[data-stub-mode="${m}"]`);

    await mode("all").click();
    await expect(mode("all")).toHaveAttribute("aria-pressed", "true");
    await expect(mode("top")).toHaveAttribute("aria-pressed", "false");
    // one ghost for each of the ten methods and each of the twelve files, none folded
    await expect(ghostBoxes(page)).toHaveCount(10 + FILES);
    await expect(byId(page, "ghost:sym:src/hub.ts#Hub.m3")).toBeVisible();
    await expect(page.locator('[data-element-id^="ghost:rest:"]')).toHaveCount(0);
    await expect(page.locator('[data-element-id^="ghost:more:"]')).toHaveCount(0);
    expect((await stateOf(page)).stubs).toEqual({ mode: "all", max: 8 });
    await page.locator(".diagram").screenshot({ path: screenshotPath("crowded-all") });

    await mode("none").click();
    await expect(ghostBoxes(page)).toHaveCount(0);
    await expect(page.locator("[data-stub-id]")).toHaveCount(0);
    expect((await stateOf(page)).graph!.stubs).toEqual([]);
    await expect(byId(page, RUN)).toBeVisible(); // the boxes are still there

    await mode("top").click();
    await expect(ghostBoxes(page)).toHaveCount(10);
    expect((await stateOf(page)).stubs).toEqual({ mode: "top", max: 8 });

    // an edit like the others: unsaved without a server, exported with the view, marked as the user's
    await expect(page.locator(".save-status")).toHaveText("Unsaved");
    const download = await downloadJson(page);
    const saved = JSON.parse(readFileSync((await download.path())!, "utf8")) as {
      views: { id: string; stubs?: unknown; provenance: { userFields?: string[] } }[];
    };
    const view = saved.views.find((v) => v.id === "view:crowd")!;
    expect(view.stubs).toEqual({ mode: "top" });
    expect(view.provenance.userFields).toEqual(["stubs"]);
    expect(problems).toEqual([]);
  });

  test("the choice survives an edit of the view: expanding a ghost keeps the mode", async ({
    page,
  }) => {
    await openCrowded(page);
    await (await viewToggle(page, '[data-stub-mode="all"]')).click();
    await page.keyboard.press("Escape");
    // all ghosts make a big diagram, which starts zoomed in: fit it to reach the last one
    await fitAll(page);
    await byId(page, "ghost:file:src/f11.ts").click();
    await expect(byId(page, "file:src/f11.ts")).toBeVisible();
    expect((await stateOf(page)).stubs).toEqual({ mode: "all", max: 8 });
    await expect(ghostBoxes(page)).toHaveCount(10 + FILES - 1);
  });

  test("the control is for graph views only", async ({ page }) => {
    await page.goto(
      new URL("../dist/bundles/ts-jobrunner.html", import.meta.url).href + "?mode=explore",
    );
    await page.waitForFunction(() => window.__xpl !== undefined);
    await openEditMenu(page);
    await expect(page.getByTestId("stubs-control")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.__xpl!.setView("view:dispatch"));
    await expect(page.locator(".diagram[data-view-id='view:dispatch']")).toBeVisible();
    await openEditMenu(page);
    await expect(page.getByTestId("stubs-control")).toHaveCount(0);
  });
});

test.describe("stubs in the details panel", () => {
  test("a stub to a folded ghost lists its elements to pick from; the ghost itself is not selectable", async ({
    page,
  }) => {
    await openCrowded(page);
    const stub = `stub:out:${MAIN}->ghost:more:out`;
    await page.locator(`[data-stub-id="${stub}"]`).click();
    expect(await selectionOf(page)).toEqual([stub]);
    const details = page.locator(".details");
    await expect(details).toContainText("+5 more (5 elements not in this view)");
    const list = details.getByTestId("ghost-targets");
    await expect(list.locator("[data-ghost-target]")).toHaveCount(5);
    // the code behind the stub: main's calls to the five files and their definitions
    const focus = await page.evaluate(() => window.__xpl!.focus());
    expect(focus.filter((f) => f.role === "call-site").every((f) => f.file === "src/app.ts")).toBe(
      true,
    );
    expect(
      focus
        .filter((f) => f.role === "definition")
        .map((f) => f.file)
        .sort(),
    ).toEqual(["src/f00.ts", "src/f01.ts", "src/f02.ts", "src/f03.ts", "src/f04.ts"]);
    await list.locator('[data-ghost-target="file:src/f02.ts"]').click();
    await expect(byId(page, "file:src/f02.ts")).toBeVisible();
    expect((await stateOf(page)).include).toEqual([RUN, MAIN, "file:src/f02.ts"]);
  });

  test("a stub to a plain ghost keeps its single 'Add ... to the view' button", async ({
    page,
  }) => {
    await openCrowded(page);
    await page.locator(`[data-stub-id="stub:out:${MAIN}->ghost:file:src/f11.ts"]`).click();
    await expect(page.locator(".details").getByTestId("ghost-targets")).toHaveCount(0);
    await page.locator(".details").getByRole("button", { name: "Add f11.ts to the view" }).click();
    await expect(byId(page, "file:src/f11.ts")).toBeVisible();
  });
});
