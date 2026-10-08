// Exercise the packed CLI and offline HTML on a fresh native npm prefix.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const base = resolve(process.argv[2] ?? tmpdir());
assert(!base.startsWith(repo + sep), "scratch must be outside the source checkout");
mkdirSync(base, { recursive: true });
const scratch = mkdtempSync(join(base, "platform-install-"));
const cache = join(scratch, "npm-cache");
const npm = process.env.npm_execpath;
assert(npm, "run this script through npm run test:install:platform");
function npmCommand(args) {
  return command(process.execPath, [npm, ...args]);
}
function command(file, args, cwd = scratch) {
  return execFileSync(file, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
const packed = JSON.parse(
  npmCommand([
    "pack",
    join(repo, "packages/cli/dist"),
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    scratch,
    "--cache",
    cache,
  ]),
);
const tarball = join(scratch, packed[0].filename);
const prefix = join(scratch, "installed");
npmCommand([
  "install",
  "--global",
  "--offline",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  "--prefix",
  prefix,
  "--cache",
  cache,
  tarball,
]);
const windows = process.platform === "win32";
const pkg = windows
  ? join(prefix, "node_modules/@krimvp/xpl")
  : join(prefix, "lib/node_modules/@krimvp/xpl");
const launcher = windows ? join(prefix, "xpl.cmd") : join(prefix, "bin/xpl");
assert(existsSync(launcher), `npm launcher missing: ${launcher}`);
const metadata = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
assert.equal(metadata.name, "@krimvp/xpl");
assert.equal(metadata.dependencies, undefined);
const cli = join(pkg, "xpl.mjs");
function xpl(args, cwd = scratch) {
  return command(process.execPath, [cli, ...args], cwd);
}
function installedXpl(args, cwd = scratch) {
  return execFileSync(launcher, args, { cwd, encoding: "utf8", shell: windows });
}
assert.equal(installedXpl(["--version"]).trim(), metadata.version);
assert.equal(xpl(["--version"]).trim(), metadata.version);
assert.match(xpl(["__smoke"]), /ok\s+toml/);
const skill = join(scratch, "code-explainer");
xpl(["skill", "install", "--agent", "codex", "--dir", skill]);
assert.equal(
  command(process.execPath, [join(skill, "bin/xpl"), "--version"]).trim(),
  metadata.version,
);
const fixture = join(scratch, "ts jobrunner");
cpSync(join(repo, "fixtures/ts-jobrunner"), fixture, {
  recursive: true,
  filter: (path) => !/[\\/](\.explainer|node_modules)([\\/]|$)/.test(path),
});
const index = JSON.parse(installedXpl(["index", "--precise", "off", "--json"], fixture));
assert.equal(index.ok, true);
const saved = JSON.parse(
  readFileSync(
    join(
      fixture,
      ".explainer",
      readdirSync(join(fixture, ".explainer")).find((name) => /^index-.*\.json$/.test(name)),
    ),
    "utf8",
  ),
);
assert(saved.refs.length > 0);
assert(saved.refs.every((ref) => ref.resolution === "heuristic"));
xpl(["new", "demo", "--title", "Platform install demo"], fixture);
const patch = join(scratch, "ready.patch.json");
writeFileSync(
  patch,
  JSON.stringify({
    nodes: [
      {
        id: "file:src/runner.ts",
        kind: "file",
        parent: "dir:src",
        label: "Job dispatch",
        summary: "The runner sends queued jobs to workers and schedules retries after failures.",
        anchors: [{ file: "src/runner.ts", role: "definition" }],
      },
    ],
    views: [
      {
        id: "view:dispatch",
        type: "graph",
        title: "Job dispatch",
        scope: { root: "repo", depth: 1 },
        include: ["file:src/runner.ts"],
        stubs: { mode: "none" },
      },
    ],
  }),
);
xpl(["apply", "demo", patch], fixture);
assert.equal(JSON.parse(xpl(["ready", "demo", "--json"], fixture)).ready, true);
const service = JSON.parse(
  xpl(
    ["service", "start", "demo", "--background", "--backend", "none", "--port", "0", "--json"],
    fixture,
  ),
);
try {
  assert.equal(service.state, "running");
  assert.equal((await fetch(service.url)).status, 200);
} finally {
  assert.equal(JSON.parse(xpl(["service", "stop", "--json"], fixture)).state, "stopped");
}
const output = join(scratch, "ready.html");
assert.equal(
  JSON.parse(xpl(["bundle", "demo", "-o", output, "--json"], fixture)).exportStatus,
  "ready",
);
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(/^https?:/, (route) => route.abort());
  await page.goto(pathToFileURL(output).href + "?perspective=code");
  await expect(page.locator("#root")).toContainText("Platform install demo");
  await page.locator('.tree-row[data-path="src/runner.ts"]').click();
  await expect(page.locator('[data-file="src/runner.ts"] .cm-content')).toContainText("Runner");
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
console.log(
  JSON.stringify(
    {
      platform: `${process.platform} ${process.arch}`,
      node: process.versions.node,
      tarball,
      launcher,
      result:
        "packed CLI install, skill launcher, index, apply, service, ready export and offline Chromium view passed",
    },
    null,
    2,
  ),
);
