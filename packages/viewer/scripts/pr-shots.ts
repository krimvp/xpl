/**
 * Before/after screenshots for a pull request (see .claude/skills/pr-screenshots/SKILL.md).
 * scripts/pr-screenshots.sh at the repo root runs `shoot` on the base and the head, then `compare`.
 *
 *   npx tsx scripts/pr-shots.ts shoot <outDir> [--viewer-dir <dir>] [--build] [--set ux]
 *                                     [--shot <name>=<bundle>[?query]]... [--scheme light|dark]
 *                                     [--size 1440x900]
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
    },
  });
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

  const [width, height] = values.size.split("x").map(Number);
  const colorScheme = values.scheme === "dark" ? "dark" : "light";
  const browser = await chromium.launch();
  try {
    for (const spec of values.shot) {
      const eq = spec.indexOf("=");
      if (eq < 1) throw new Error(`--shot ${spec}: expected <name>=<bundle>[?query]`);
      const name = spec.slice(0, eq);
      const [bundle, query = ""] = spec.slice(eq + 1).split(/(?=\?)/);
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
      await page.goto(pathToFileURL(file).href + query);
      await page.waitForFunction(() => !!window.__xpl);
      await page.waitForTimeout(400);
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
  if (!outArg) throw new Error("usage: compare <beforeDir> <afterDir> <outDir>");
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
