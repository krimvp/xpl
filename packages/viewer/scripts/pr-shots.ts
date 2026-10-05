/**
 * Before/after screenshots for a pull request (see .claude/skills/pr-screenshots/SKILL.md).
 * scripts/pr-screenshots.sh at the repo root runs `shoot` on the base and the head, then `compare`.
 *
 *   npx tsx scripts/pr-shots.ts shoot <outDir> [--viewer-dir <dir>] [--build] [--set ux]
 *                                     [--shot <name>=<bundle>[?query]]... [--scheme light|dark]
 *                                     [--size 1440x900] [--service connected|disconnected|unmanaged]
 *   npx tsx scripts/pr-shots.ts compare <beforeDir> <afterDir> <outDir>
 *
 * shoot:
 * - `--viewer-dir` is the packages/viewer directory of the tree to photograph (default: this one), so the
 *   head's script can photograph a base checkout that predates it.
 * - `--build` builds that viewer (`vite build`) and its fixture bundles (its e2e global setup) first.
 * - `--set ux` takes the standard set of scripts/ux-shots.ts (every reading tab, Explore, Present, a
 *   selection, dark mode, narrow widths, the change and architecture bundles).
 * - `--shot` takes one more: `<bundle>` is a name in <viewer-dir>/dist/bundles (`ts-jobrunner`,
 *   `py-architecture`, `ts-change`, `self` when the shell script made one) or a path to an .html file; the
 *   query is passed on (`?perspective=map&view=view:overview`, `?mode=present&tour=tour:intro&step=2`,
 *   `?perspective=explore&focus=edge:job-completed`). Without `--set` or `--shot`, `--set ux` is assumed.
 *
 * - `--evidence-editor` opens the retry concept evidence editor, where available, with runner line 75.
 * - `--graph-authoring` groups worker/metrics and hides their stored arrow, where available.
 * - `--service` intercepts a loopback API; unmanaged omits attachment metadata for plain-view shots.
 * - `--attention affected|paused` adds watch/guide evidence; `--attention-open` opens its repair offer.
 * - `--text-draft` opens and edits the TS fixture retry concept without saving.
 *
 * compare: pairs the files of both directories by name and writes `<name>.png`, Before left and After right,
 * for each pair whose bytes differ, plus `index.md` listing changed, added, removed and unchanged shots.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));

function run(cmd: string, args: string[], cwd: string): void {
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed in ${cwd}`);
}

async function shoot(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "viewer-dir": { type: "string", default: resolve(here, "..") },
      build: { type: "boolean", default: false },
      set: { type: "string" },
      shot: { type: "string", multiple: true, default: [] },
      scheme: { type: "string", default: "light" },
      size: { type: "string", default: "1440x900" },
      service: { type: "string" },
      attention: { type: "string" },
      "attention-open": { type: "boolean", default: false },
      "text-draft": { type: "boolean", default: false },
      "evidence-editor": { type: "boolean", default: false },
      "graph-authoring": { type: "boolean", default: false },
    },
  });
  if (values.service && !["connected", "disconnected", "unmanaged"].includes(values.service))
    throw new Error("--service must be connected, disconnected or unmanaged");
  if (values.attention && !["affected", "paused"].includes(values.attention))
    throw new Error("--attention must be affected or paused");
  const out = resolve(positionals[0] ?? "pr-shots");
  const viewerDir = resolve(values["viewer-dir"]);
  mkdirSync(out, { recursive: true });

  if (values.build) {
    run("npx", ["vite", "build"], viewerDir);
    const setup = await import(pathToFileURL(resolve(viewerDir, "e2e/global-setup.ts")).href);
    await setup.default();
  }

  const set = values.set ?? (values.shot.length === 0 ? "ux" : undefined);
  if (set === "ux") run("npx", ["tsx", resolve(here, "ux-shots.ts"), out], viewerDir);
  else if (set !== undefined) throw new Error(`unknown --set ${set} (only "ux")`);
  if (values.shot.length === 0) return;

  const [width = NaN, height = NaN] = values.size.split("x").map(Number);
  if (!(width > 0 && height > 0))
    throw new Error(`--size ${values.size}: expected <width>x<height>`);
  const colorScheme = values.scheme === "dark" ? "dark" : "light";
  const browser = await chromium.launch();
  try {
    for (const spec of values.shot) {
      const eq = spec.indexOf("=");
      if (eq < 1) throw new Error(`--shot ${spec}: expected <name>=<bundle>[?query]`);
      const name = spec.slice(0, eq);
      const [bundle = "", query = ""] = spec.slice(eq + 1).split(/(?=\?)/);
      const file = bundle.endsWith(".html")
        ? isAbsolute(bundle)
          ? bundle
          : resolve(bundle)
        : resolve(viewerDir, "dist/bundles", `${bundle}.html`);
      if (!existsSync(file)) {
        // The base may not have this bundle (a new fixture, a new view): no Before shot, said so in compare.
        console.warn(`skip ${name}: ${file} does not exist`);
        continue;
      }
      const page = await browser.newPage({ viewport: { width, height }, colorScheme });
      if (values.service) {
        const html = readFileSync(file, "utf8");
        const script = /(<script id="xpl-data" type="application\/json">)([\s\S]*?)(<\/script>)/;
        const data = JSON.parse(script.exec(html)![2]!);
        data.server = {
          api: "/api",
          ...(values.service === "unmanaged"
            ? {}
            : {
                attachment: {
                  root: "/tmp/xpl-demo/jobrunner",
                  guide: ".explainer/jobrunner.explainer.json",
                  instanceId: "demo-instance",
                  backend: "claude",
                  backendAvailable: false,
                },
              }),
        };
        const body = html.replace(
          script,
          (_all, start, _data, end) => start + JSON.stringify(data).replace(/</g, "\\u003c") + end,
        );
        await page.route("http://127.0.0.1:4747/**", (route) => {
          const path = new URL(route.request().url()).pathname;
          if (path === "/") return route.fulfill({ contentType: "text/html", body });
          if (path === "/favicon.ico") return route.fulfill({ status: 204 });
          if (values.service === "disconnected") return route.abort("connectionrefused");
          if (path === "/api/watch" && values.attention)
            return route.fulfill({
              json: {
                enabled: true,
                instanceId: "demo-instance",
                watch: {
                  state: values.attention === "paused" ? "paused" : "current",
                  stale: values.attention === "paused",
                  generation: 2,
                  index: { path: ".explainer/index-demo.json", commit: "demo" },
                  error: null,
                },
                guides: [
                  {
                    name: "jobrunner",
                    path: ".explainer/jobrunner.explainer.json",
                    title: "Job runner",
                    counts: { moved: 1, drifted: 1, missing: 1 },
                    errors: [],
                    elements: [
                      { id: "file:src/queue.ts", file: "src/queue.ts", status: "moved" },
                      {
                        id: "sym:src/runner.ts#Runner.dispatch",
                        file: "src/runner.ts",
                        status: "drifted",
                      },
                      { id: "file:src/worker.ts", file: "src/worker.ts", status: "missing" },
                    ],
                    resolveCommand:
                      "xpl resolve --root '/repos/jobrunner' '/repos/jobrunner/.explainer/jobrunner.explainer.json' --write",
                    revisionCommand:
                      "xpl revise --root '/tmp/xpl-demo/jobrunner' '/tmp/xpl-demo/jobrunner/.explainer/jobrunner.explainer.json' --select '<request-id>'",
                  },
                ],
              },
            });
          if (path === "/api/explainer") return route.fulfill({ status: 304 });
          if (path === "/api/requests") return route.fulfill({ json: { requests: [] } });
          return route.fulfill({ status: 404 });
        });
        await page.goto("http://127.0.0.1:4747/" + query);
        await page.waitForFunction(() => !!window.__xpl);
        // The base viewer has no status strip; allow its first normal poll too.
        await page.waitForTimeout(2200);
        if (values["attention-open"]) {
          const attention = page.locator(".attention-status > details").first();
          if (await attention.count()) {
            await attention.locator(":scope > summary").click();
            await page.locator(".revision-offer > summary").click();
            // Keep the top of a bounded attention disclosure in the photograph.
            await page.locator(".attention-list > .service-disclosure").evaluateAll((elements) => {
              for (const element of elements) element.scrollTop = 0;
            });
          }
        } else if (!values.attention) {
          const details = page.locator(".connection-status details");
          if (await details.count()) await details.locator("summary").click();
        }
      } else await page.goto(pathToFileURL(file).href + query);
      await page.waitForFunction(() => !!window.__xpl);
      if (values["text-draft"]) {
        await page.evaluate(() => window.__xpl!.select(["concept:retry-policy"]));
        await page.getByTestId("text-edit").click();
        await page
          .getByLabel("Summary", { exact: true })
          .fill("Inspect changed evidence before revising.");
        await page.locator(".save-status").filter({ hasText: "Unsaved draft" }).waitFor();
        await page.evaluate(() => window.scrollTo(0, 0));
      }
      await page.waitForTimeout(400);
      if (values["graph-authoring"]) {
        await page.evaluate(() =>
          window.__xpl!.select(["file:src/worker.ts", "file:src/metrics.ts"]),
        );
        const author = page.getByTestId("graph-author");
        if (await author.count()) {
          await author.locator("summary").click();
          await author.getByLabel("Group name").fill("Execution");
          await author.getByRole("button", { name: "Group selected boxes" }).click();
          await page.waitForFunction(() =>
            window.__xpl!.state().graph?.nodes.includes("grp:execution"),
          );
          await page.evaluate(() => window.__xpl!.select(["edge:job-completed"]));
          await author.getByRole("button", { name: "Hide selected items" }).click();
          await page.waitForFunction(
            () => !window.__xpl!.state().graph?.edges.includes("edge:job-completed"),
          );
          await author.locator("summary").click();
          await page.evaluate(() => window.__xpl!.select(["grp:execution"]));
          await page.getByRole("button", { name: "Fit to view" }).click();
        }
      }
      if (values["evidence-editor"]) {
        const divider = page.getByRole("separator", {
          name: "Resize the diagram and the panels below it",
        });
        await divider.focus();
        for (let i = 0; i < 4; i++) await divider.press("Shift+ArrowUp");
        const edit = page.getByTestId("evidence-edit");
        const available = (await edit.count()) > 0;
        if (available) await edit.click();
        await page.evaluate(() => window.__xpl!.setCursor("src/runner.ts", 75));
        if (available)
          await page
            .locator(".evidence-edit")
            .evaluate((form) => form.scrollIntoView({ block: "start" }));
      }
      await page.screenshot({ path: `${out}/${name}.png` });
      console.log(name);
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

async function compare(argv: string[]): Promise<void> {
  const [beforeDir, afterDir, outArg] = argv.map((p) => resolve(p));
  if (!beforeDir || !afterDir || !outArg)
    throw new Error("usage: compare <beforeDir> <afterDir> <outDir>");
  mkdirSync(outArg, { recursive: true });
  const pngs = (dir: string) =>
    existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".png")) : [];
  const before = new Set(pngs(beforeDir));
  const after = new Set(pngs(afterDir));
  const changed: string[] = [];
  const unchanged: string[] = [];
  for (const name of [...after].filter((n) => before.has(n)).sort()) {
    const a = readFileSync(`${beforeDir}/${name}`);
    const b = readFileSync(`${afterDir}/${name}`);
    (a.equals(b) ? unchanged : changed).push(name);
  }
  const added = [...after].filter((n) => !before.has(n)).sort();
  const removed = [...before].filter((n) => !after.has(n)).sort();

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 2000, height: 800 } });
    for (const name of changed) {
      const src = (dir: string) =>
        `data:image/png;base64,${readFileSync(`${dir}/${name}`).toString("base64")}`;
      await page.setContent(`<!doctype html><style>
        body { margin: 0; font: 600 20px system-ui, sans-serif; background: #fff; display: flex; gap: 16px; padding: 16px; width: max-content; }
        figure { margin: 0; } figcaption { padding: 0 0 8px; } img { border: 1px solid #999; width: 960px; display: block; }
        </style>
        <figure><figcaption>Before</figcaption><img src="${src(beforeDir)}"></figure>
        <figure><figcaption>After</figcaption><img src="${src(afterDir)}"></figure>`);
      await page.waitForFunction(() => [...document.images].every((img) => img.complete));
      await page.locator("body").screenshot({ path: `${outArg}/${name}` });
    }
  } finally {
    await browser.close();
  }

  const list = (title: string, names: string[]) =>
    `## ${title} (${names.length})\n\n${names.map((n) => `- ${n}`).join("\n") || "- none"}\n`;
  const index = [
    `# Screenshots: ${changed.length} changed, ${added.length} added, ${removed.length} removed\n`,
    `Before: ${beforeDir}\nAfter: ${afterDir}\nSide by side (changed only): ${outArg}\n`,
    list("Changed", changed),
    list("Added (After only)", added),
    list("Removed (Before only)", removed),
    list("Unchanged", unchanged),
  ].join("\n");
  writeFileSync(`${outArg}/index.md`, index);
  console.log(index);
}

const [command, ...rest] = process.argv.slice(2);
if (command === "shoot") await shoot(rest);
else if (command === "compare") await compare(rest);
else {
  console.error("usage: pr-shots.ts shoot <outDir> [options] | compare <before> <after> <outDir>");
  process.exit(2);
}
