/**
 * The live page against a real `xpl live` (in-process, `cli.ts` `run`) on a temporary git copy of the TS fixture
 * with a folder `src/store` (so the parts map has a level of files below it) and a change in progress: a file
 * edited deep in that folder, one added, one deleted, and a top-level file edited.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { run } from "../../cli/src/cli.js";
import type { ViewServer } from "../../cli/src/server.js";
import { byId, readEmbeddedBundle, watchProblems, withBundle } from "./helpers.js";

interface Live {
  root: string;
  url: string;
  stop(): Promise<void>;
  cmd(...args: string[]): Promise<number>;
}

const git = (root: string, ...args: string[]) => {
  const result = spawnSync(
    "git",
    ["-c", "user.email=live@example.com", "-c", "user.name=live", ...args],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
};

/** A committed copy of the fixture with `src/store`, `edit` applied to its working tree, served by `xpl live`. */
async function startLive(edit: (root: string) => void): Promise<Live> {
  const root = mkdtempSync(join(tmpdir(), "xpl-live-e2e-"));
  cpSync(resolve("../../fixtures/ts-jobrunner"), root, {
    recursive: true,
    filter: (p) => !/[\\/](\.explainer|node_modules)([\\/]|$)/.test(p),
  });
  mkdirSync(join(root, "src/store"));
  writeFileSync(
    join(root, "src/store/memory.ts"),
    "/** Keeps jobs in memory, by id. */\nexport class MemoryStore<T> {\n  private readonly items = new Map<string, T>();\n\n  get(id: string): T | undefined {\n    return this.items.get(id);\n  }\n}\n",
  );
  writeFileSync(join(root, "src/store/index.ts"), 'export { MemoryStore } from "./memory.js";\n');
  writeFileSync(
    join(root, "src/store/legacy.ts"),
    "/** The old store. */\nexport function legacyStore(): Map<string, unknown> {\n  return new Map();\n}\n",
  );
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "start");
  edit(root);
  const abort = new AbortController();
  const errors: string[] = [];
  const io = {
    out() {},
    err: (s: string) => errors.push(s),
    cwd: root,
    env: {},
    signal: abort.signal,
  };
  let serving!: (server: ViewServer) => void;
  const listening = new Promise<ViewServer>((r) => (serving = r));
  const done = run(["live", "--no-open", "--port", "0", "--precise", "off"], {
    ...io,
    onServer: (server) => serving(server),
  });
  const server = await Promise.race([
    listening,
    done.then((code) => {
      throw new Error(`xpl live exited with ${code}: ${errors.join("\n")}`);
    }),
  ]);
  return {
    root,
    url: server.url,
    cmd: (...args) => run(args, { ...io, signal: undefined }),
    async stop() {
      abort.abort();
      await done;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The change of the tests: `memory.ts` gains a function, `disk.ts` is new, `legacy.ts` is gone, `queue.ts` edited. */
function changeTheStore(root: string): void {
  writeFileSync(
    join(root, "src/store/memory.ts"),
    readFileSync(join(root, "src/store/memory.ts"), "utf8") +
      "\n/** Drops a job from a store. */\nexport function evict(id: string): void {\n  void id;\n}\n",
  );
  writeFileSync(
    join(root, "src/store/disk.ts"),
    'import { MemoryStore } from "./memory.js";\n\n/** Keeps jobs on disk. */\nexport class DiskStore<T> extends MemoryStore<T> {}\n',
  );
  unlinkSync(join(root, "src/store/legacy.ts"));
  const queue = join(root, "src/queue.ts");
  writeFileSync(queue, readFileSync(queue, "utf8").replace("Higher runs first.", "Higher first."));
}

const pill = (page: Page, id: string) => byId(page, id).locator(".change-pill text").first();

async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.getByTestId("live-panel")).toBeVisible();
  await expect(page.getByTestId("live-status")).toContainText("Watching");
}

test.describe.serial("xpl live", () => {
  let live: Live;
  test.beforeAll(async () => {
    live = await startLive(changeTheStore);
  });
  test.afterAll(async () => {
    await live?.stop();
  });

  test("opens at the system map, and the change lights every level down to the file", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    // an address that names a view still opens there; one that does not opens at the top
    await open(page, live.url);
    await expect(page.locator(".diagram")).toHaveAttribute("data-view-id", "view:system");

    // level 1: the service holds the whole change
    await expect(pill(page, "grp:ts-jobrunner")).toHaveText("2 changed · 1 new · 1 removed");
    await expect(byId(page, "grp:ts-jobrunner")).toHaveClass(/live-inside/);
    await byId(page, "grp:ts-jobrunner").dblclick();

    // level 2: the part that holds the change, and the top-level file that is changed itself
    await expect(page.locator(".diagram")).toHaveAttribute("data-view-id", "view:overview");
    await expect(pill(page, "dir:src/store")).toHaveText("1 changed · 1 new · 1 removed");
    await expect(pill(page, "file:src/queue.ts")).toHaveText("Changed");
    await expect(byId(page, "file:src/queue.ts")).toHaveClass(/live-changed/);
    await expect(byId(page, "file:src/bus.ts").locator(".change-pill")).toHaveCount(0);
    // a guide without a design level has no Design | Folders and no Design section
    await expect(page.getByTestId("level-switch")).toHaveCount(0);
    await expect(page.getByTestId("live-design")).toHaveCount(0);
    await byId(page, "dir:src/store").dblclick();

    // level 3: the files, the removed one drawn as such
    await expect(page.locator(".diagram")).toHaveAttribute("data-view-id", "view:map-src-store");
    await expect(pill(page, "file:src/store/disk.ts")).toHaveText("New");
    await expect(byId(page, "file:src/store/disk.ts")).toHaveClass(/live-new/);
    await expect(pill(page, "file:src/store/memory.ts")).toHaveText("Changed");
    const removed = byId(page, "removed:src/store/legacy.ts");
    await expect(removed).toHaveClass(/live-removed/);
    await expect(pill(page, "removed:src/store/legacy.ts")).toHaveText("Removed");
    await expect(page.getByTestId("zoom-trail")).toContainText("The system");

    // a removed box opens its code before the change
    await removed.click();
    await expect(page.getByTestId("pane-before")).toBeVisible();
    await expect(page.locator(".live-code")).toContainText("export function legacyStore()");
    expect(problems).toEqual([]);

    await page.goto(`${live.url}?view=view:overview`);
    await expect(page.locator(".diagram")).toHaveAttribute("data-view-id", "view:overview");
  });

  test("Before hides what the change added and brings back what it removed; Now drops the marks", async ({
    page,
  }) => {
    await open(page, `${live.url}?view=view:map-src-store`);
    await page.locator('[data-lens="before"]').click();
    await expect(byId(page, "file:src/store/disk.ts")).toHaveCount(0);
    const legacy = byId(page, "removed:src/store/legacy.ts");
    await expect(legacy).toBeVisible();
    await expect(legacy).not.toHaveClass(/live-removed/);
    await expect(page.locator(".diagram .change-pill")).toHaveCount(0);
    await expect(page.getByTestId("lens-note")).toContainText(
      "Arrows come from the code as it is now",
    );
    // the code side shows the code before the change
    await byId(page, "file:src/store/memory.ts").click();
    await expect(page.locator(".live-code")).toContainText("Code before the change");
    await expect(page.locator(".live-code")).not.toContainText("evict");

    await page.locator('[data-lens="now"]').click();
    await expect(byId(page, "file:src/store/disk.ts")).toBeVisible();
    await expect(byId(page, "removed:src/store/legacy.ts")).toHaveCount(0);
    await expect(page.locator(".diagram .change-pill")).toHaveCount(0);

    await page.locator('[data-lens="changes"]').click();
    await expect(pill(page, "file:src/store/disk.ts")).toHaveText("New");
  });

  test("What changed lists the parts with their files, and a draft's text stays quiet", async ({
    page,
  }) => {
    await open(page, live.url);
    const panel = page.getByTestId("live-panel");
    await expect(page.getByTestId("live-totals")).toHaveText(
      /^4 files · \+\d+ −\d+ · since you started$/,
    );
    await expect(page.getByTestId("live-explanation")).toContainText("Not explained yet");
    await expect(page.getByTestId("live-explanation")).toContainText(
      "or start xpl live --backend claude or xpl live --backend api.",
    );
    const store = panel.locator('[data-part-id="dir:src/store"]');
    await expect(store.locator(".live-mark")).toHaveText("1 changed · 1 new · 1 removed");
    await expect(store.locator(".live-file .live-name")).toHaveText([
      "disk.ts",
      "legacy.ts",
      "memory.ts",
    ]);
    await expect(store.locator('[data-file="src/store/memory.ts"] .live-symbols')).toHaveText(
      "evict (new)",
    );
    // quiet drafts: the names the index found, no TODO, no draft banner
    await expect(byId(page, "grp:ts-jobrunner").locator(".label").first()).toHaveText(
      "ts-jobrunner",
    );
    await expect(page.locator(".app")).not.toContainText("TODO");
    await expect(page.getByTestId("draft-banner")).toHaveCount(0);

    // an entry goes to the level of its box and picks it; its +/- opens the diff
    await store.locator(".live-part-name").click();
    await expect(page.locator(".diagram")).toHaveAttribute("data-view-id", "view:overview");
    await expect(byId(page, "dir:src/store")).toHaveClass(/is-selected/);
    await expect(byId(page, "dir:src/store").locator(".label").first()).toHaveText("store");
    await store.locator('[data-file="src/store/memory.ts"] .live-diff').click();
    await expect(
      page.locator(".live-code .xpl-diff-gutter .xpl-diff-mark.is-added"),
    ).not.toHaveCount(0);
  });

  test("an edit shows up on the open page, and the explanation of tour:live with it", async ({
    page,
  }) => {
    await open(page, live.url);
    await page.evaluate(() => ((window as unknown as { marker: number }).marker = 1));

    // an explanation written by an agent (xpl apply), picked up without a reload
    const patch = join(live.root, "..", `live-patch-${Date.now()}.json`);
    writeFileSync(
      patch,
      JSON.stringify({
        tours: [
          {
            id: "tour:live",
            title: "Jobs can live on disk",
            summary: "A disk store joins the memory store, and the old store goes.",
            steps: [
              {
                id: "part-src-store",
                view: "view:map-src-store",
                focus: ["file:src/store/disk.ts"],
                note: "### A store on disk\n\nBefore: jobs lived in memory. Now: `DiskStore` keeps them.",
              },
            ],
          },
        ],
      }),
    );
    expect(await live.cmd("apply", "live", patch)).toBe(0);
    rmSync(patch);
    await expect(page.getByTestId("live-summary")).toContainText(
      "A disk store joins the memory store",
    );
    await expect(page.getByTestId("live-note")).toContainText("Before: jobs lived in memory.");
    await expect(page.getByTestId("live-explanation")).toHaveCount(0);

    // the agent edits another file: its part appears, marked as new to the reader, the service count moves
    writeFileSync(
      join(live.root, "src/bus.ts"),
      readFileSync(join(live.root, "src/bus.ts"), "utf8") + "\nexport const LIMIT = 10;\n",
    );
    const bus = page.locator('[data-part-id="file:src/bus.ts"]');
    await expect(bus).toBeVisible({ timeout: 30_000 });
    await expect(bus.locator(".live-fresh")).toHaveText("just changed");
    await expect(pill(page, "grp:ts-jobrunner")).toHaveText("3 changed · 1 new · 1 removed");
    await expect(page.getByTestId("live-explanation")).toHaveText(
      "The explanation is from before your latest edits.",
    );
    expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(1);
    // a click is a look: nothing is new to the reader any more
    await page.getByTestId("live-totals").click();
    await expect(bus.locator(".live-fresh")).toHaveCount(0);
  });

  test("a saved copy is a still snapshot of the same page", async ({ page }) => {
    const response = await page.request.get(`${live.url}api/bundle`);
    const bundle = (await response.json()) as Record<string, unknown>;
    delete bundle.server;
    expect(bundle.mode).toBe("live");
    const { html } = readEmbeddedBundle();
    await page.route("http://xpl.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: withBundle(html, bundle) }),
    );
    await page.goto("http://xpl.test/");
    await expect(page.getByTestId("live-status")).toHaveText("Snapshot · not updating");
    await expect(page.locator(".diagram")).toHaveAttribute("data-view-id", "view:system");
    await expect(pill(page, "grp:ts-jobrunner")).toContainText("changed");
    await expect(page.getByTestId("live-parts")).toBeVisible();
  });
});

/** The design level an agent writes for `changeTheStore` (reference/live.md, "The design level"). */
const DESIGN = {
  nodes: [
    {
      id: "grp:design-disk",
      label: "Disk storage",
      summary: "Keeps jobs on disk, so they outlive a restart.",
      members: ["file:src/store/disk.ts"],
    },
    {
      id: "grp:design-store",
      label: "Job storage",
      summary: "Keeps jobs in memory, by id.",
      members: ["file:src/store/memory.ts", "file:src/store/index.ts"],
      anchors: [{ file: "src/store/legacy.ts", at: "base", role: "definition" }],
    },
    {
      id: "grp:design-queue",
      label: "Job queue",
      summary: "Orders the jobs until a worker takes one.",
      members: ["file:src/queue.ts"],
    },
  ],
  views: [
    {
      id: "view:design",
      type: "graph",
      title: "The design of the change",
      include: ["grp:design-disk", "grp:design-store", "grp:design-queue"],
    },
  ],
  tours: [
    {
      id: "tour:live",
      title: "Jobs can live on disk",
      summary: "A disk store joins the memory store, and the old store goes. Risk: two stores.",
      steps: [
        {
          id: "design",
          view: "view:design",
          focus: ["grp:design-disk", "grp:design-store"],
          note: "### Storage gets a second home\n\nBefore: memory only. Now: memory or disk.\n\nRisk: two stores.",
        },
        {
          id: "design-disk",
          view: "view:design",
          focus: ["grp:design-disk"],
          note: "### A store on disk\n\nBefore: none. Now: `DiskStore` keeps jobs on disk.",
        },
        {
          id: "design-store",
          view: "view:design",
          focus: ["grp:design-store"],
          note: "### The old store goes\n\nBefore: `legacyStore`. Now: `MemoryStore` can evict.",
        },
      ],
    },
  ],
};

test.describe.serial("xpl live with a design level", () => {
  let live: Live;
  test.beforeAll(async () => {
    live = await startLive(changeTheStore);
    const patch = join(live.root, "..", `live-design-${Date.now()}.json`);
    writeFileSync(patch, JSON.stringify(DESIGN));
    expect(await live.cmd("apply", "live", patch)).toBe(0);
    rmSync(patch);
  });
  test.afterAll(async () => {
    await live?.stop();
  });

  test("What changed reads Design first, with marks and notes, then the folders folded", async ({
    page,
  }) => {
    await open(page, live.url);
    const design = page.getByTestId("live-design");
    await expect(design.locator(".live-part")).toHaveCount(3);
    const disk = design.locator('[data-part-id="grp:design-disk"]');
    await expect(disk.locator(".live-mark")).toHaveText("New");
    await expect(disk.getByTestId("live-note")).toContainText("Now: DiskStore keeps jobs");
    await expect(design.locator('[data-part-id="grp:design-store"] .live-mark')).toHaveText(
      "1 changed · 1 removed",
    );
    const folders = page.getByTestId("live-by-folder");
    await expect(folders).not.toHaveAttribute("open", "");
    // Design is above By folder
    const top = async (l: typeof design) => (await l.boundingBox())!.y;
    expect(await top(design)).toBeLessThan(await top(folders));
    await folders.locator("summary").click();
    await expect(folders.locator('[data-part-id="dir:src/store"]')).toBeVisible();
    // a design box goes to the design map and picks the box
    await disk.locator(".live-part-name").click();
    await expect(page.locator(".diagram")).toHaveAttribute("data-view-id", "view:design");
    await expect(byId(page, "grp:design-disk")).toHaveClass(/is-selected/);
  });

  test("Design | Folders switches the level under the system map, and zooming remembers it", async ({
    page,
  }) => {
    const problems = watchProblems(page);
    await open(page, live.url);
    await expect(page.locator(".diagram")).toHaveAttribute("data-view-id", "view:system");
    await expect(page.getByTestId("level-switch")).toHaveCount(0);
    await byId(page, "grp:ts-jobrunner").dblclick();
    await expect(page.locator(".diagram")).toHaveAttribute("data-view-id", "view:design");
    await expect(pill(page, "grp:design-disk")).toHaveText("New");
    const trail = page.getByTestId("zoom-trail");
    await expect(trail).toContainText("The system");
    const level = page.getByTestId("level-switch");
    await expect(level.locator('[aria-checked="true"]')).toHaveText("Design");

    await level.locator('[data-level="folders"]').click();
    await expect(page.locator(".diagram")).toHaveAttribute("data-view-id", "view:overview");
    await expect(level.locator('[aria-checked="true"]')).toHaveText("Folders");
    await trail.getByRole("button", { name: "The system" }).click();
    await expect(page.locator(".diagram")).toHaveAttribute("data-view-id", "view:system");
    await byId(page, "grp:ts-jobrunner").dblclick();
    await expect(page.locator(".diagram")).toHaveAttribute("data-view-id", "view:overview");
    await level.locator('[data-level="design"]').click();
    await expect(page.locator(".diagram")).toHaveAttribute("data-view-id", "view:design");
    expect(problems).toEqual([]);
  });

  test("Before hides a new design box", async ({ page }) => {
    await open(page, `${live.url}?view=view:design`);
    await expect(byId(page, "grp:design-disk")).toBeVisible();
    await page.locator('[data-lens="before"]').click();
    await expect(byId(page, "grp:design-disk")).toHaveCount(0);
    await expect(byId(page, "grp:design-store")).toBeVisible();
    await page.locator('[data-lens="changes"]').click();
    await expect(pill(page, "grp:design-store")).toHaveText("1 changed · 1 removed");
  });
});

test("with nothing changed, the page says so calmly", async ({ page }) => {
  const live = await startLive(() => undefined);
  try {
    await open(page, live.url);
    await expect(page.getByTestId("live-empty")).toContainText("No changes since you started.");
    await expect(page.locator(".diagram .change-pill")).toHaveCount(0);
  } finally {
    await live.stop();
  }
});
