import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const output = join(root, "_site");
const cli = join(root, "packages/cli/dist/xpl.mjs");

execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
await rm(output, { recursive: true, force: true });
await cp(join(root, "site"), output, { recursive: true });
await mkdir(join(output, "demo"), { recursive: true });

const fixture = await mkdtemp(join(tmpdir(), "xpl-site-"));
try {
  await cp(join(root, "fixtures/ts-jobrunner"), fixture, { recursive: true });
  execFileSync(process.execPath, [cli, "index", "--precise", "off"], {
    cwd: fixture,
    stdio: "inherit",
  });
  // The committed example predates required summaries. Add only reader text to its temporary copy.
  execFileSync(
    process.execPath,
    [cli, "apply", "jobrunner", join(root, "scripts/site-demo.patch.json")],
    {
      cwd: fixture,
      stdio: "inherit",
    },
  );
  execFileSync(
    process.execPath,
    [cli, "bundle", "jobrunner", "-o", join(output, "demo/index.html")],
    {
      cwd: fixture,
      stdio: "inherit",
    },
  );
  // A static viewer never reads the index's disk root. Do not publish the build machine's path.
  const demoPath = join(output, "demo/index.html");
  const html = await readFile(demoPath, "utf8");
  await writeFile(demoPath, html.replace(JSON.stringify(fixture), JSON.stringify(".")));
} finally {
  await rm(fixture, { recursive: true, force: true });
}

// The hand-written page uses quoted URLs and one URL per srcset. Check CSS assets too.
for (const name of ["index.html", "style.css"]) {
  const path = join(output, name);
  const source = await readFile(path, "utf8");
  const references = source.matchAll(
    /(?:\b(?:href|src|srcset)=["']([^"']+)["']|url\(["']?([^\s)'"]+)["']?\))/g,
  );
  for (const match of references) {
    const reference = match[1] ?? match[2];
    if (/^(?:https?:|mailto:|data:)/.test(reference)) continue;
    const target = new URL(reference, pathToFileURL(path));
    const targetPath = fileURLToPath(target);
    if (!(await stat(targetPath)).isFile()) throw new Error(`Missing site asset: ${reference}`);
    if (target.hash && targetPath === join(output, "index.html")) {
      const id = decodeURIComponent(target.hash.slice(1));
      if (!source.includes(`id="${id}"`)) throw new Error(`Missing site section: ${reference}`);
    }
  }
}
const demo = await readFile(join(output, "demo/index.html"), "utf8");
if (!demo.includes('id="xpl-data"')) throw new Error("Demo bundle has no embedded explainer");
console.log("Built _site: page, assets and self-contained demo checked.");
