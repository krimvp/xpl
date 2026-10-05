// Exercise the packed artifact. CLI subprocesses cannot read the source checkout.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const base = resolve(process.argv[2] ?? tmpdir());
assert(!base.startsWith(repo + "/"), "scratch must be outside the source checkout");
mkdirSync(base, { recursive: true });
const scratch = mkdtempSync(join(base, "install-"));
const cache = resolve(process.env.npm_config_cache ?? join(base, "npm-cache"));
const packed = JSON.parse(
  execFileSync(
    "npm",
    [
      "pack",
      join(repo, "packages/cli/dist"),
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      scratch,
      "--cache",
      cache,
    ],
    { cwd: scratch, encoding: "utf8" },
  ),
);
const tarball = join(scratch, packed[0].filename);
const prefix = join(scratch, "installed");
function install(dir) {
  execFileSync(
    "npm",
    [
      "install",
      "--global",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      dir,
      "--cache",
      cache,
      tarball,
    ],
    { cwd: scratch, stdio: "pipe" },
  );
}
install(prefix);
let pkg = join(prefix, "lib/node_modules/@xpl/cli");
const metadata = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
assert.match(metadata.version, /^\d+\.\d+\.\d+/);
assert.equal(metadata.dependencies, undefined);
const tools = join(scratch, "tools");
mkdirSync(tools);
symlinkSync(process.execPath, join(tools, "node"));
symlinkSync(execFileSync("which", ["git"], { encoding: "utf8" }).trim(), join(tools, "git"));
const env = {
  PATH: tools,
  HOME: scratch,
  NODE_OPTIONS: [
    "--permission",
    `--allow-fs-read=${scratch}`,
    `--allow-fs-write=${scratch}`,
    "--allow-child-process",
  ]
    .map((flag) => JSON.stringify(flag))
    .join(" "),
  XPL_SCIP_TIMEOUT_MS: "1000",
};
let cli = join(prefix, "bin/xpl");
function run(args, cwd = scratch, command = cli) {
  return execFileSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function rejected(args, cwd = scratch) {
  try {
    run(args, cwd);
    assert.fail("command should have failed");
  } catch (error) {
    assert.equal(error.status, 1, error.stderr?.toString());
    return JSON.parse(error.stdout.toString());
  }
}
assert.equal(
  execFileSync(
    process.execPath,
    [
      "-e",
      `try { require('node:fs').readFileSync(${JSON.stringify(join(repo, "package.json"))}); process.exit(1); } catch (e) { if (e.code !== 'ERR_ACCESS_DENIED') throw e; console.log('checkout denied'); }`,
    ],
    { cwd: scratch, env, encoding: "utf8" },
  ).trim(),
  "checkout denied",
);
assert.equal(run(["--version"]).trim(), metadata.version);
assert.match(run(["__smoke"]), /ok\s+toml/);
const skill = join(scratch, ".claude/skills/code-explainer");
run(["skill", "install"]);
assert.equal(run(["--version"], scratch, join(skill, "bin/xpl")).trim(), metadata.version);
const doctor = JSON.parse(run(["doctor", "--json"]));
assert.equal(doctor.ok, true);
assert.equal(doctor.checks.find((check) => check.id === "npx").status, "missing");
const authoring = rejected(["doctor", "--agent", "claude", "--json"]);
assert.equal(authoring.checks.find((check) => check.id === "agent").required, true);
assert.equal(authoring.checks.find((check) => check.id === "skill").status, "ok");
const unmanaged = join(scratch, "unmanaged-skill");
mkdirSync(unmanaged);
writeFileSync(join(unmanaged, "notes.txt"), "Keep this skill");
assert.match(
  rejected(["skill", "install", "--dir", unmanaged, "--json"]).error,
  /Will not replace/,
);
assert.equal(readFileSync(join(unmanaged, "notes.txt"), "utf8"), "Keep this skill");
const linked = join(scratch, "linked-skill");
symlinkSync(skill, linked);
assert.match(rejected(["skill", "install", "--dir", linked, "--json"]).error, /Will not replace/);
assert.equal(run(["--version"], scratch, join(linked, "bin/xpl")).trim(), metadata.version);

// Rebind after an install in a different prefix, including a removed old CLI.
const updated = join(scratch, "updated");
install(updated);
rmSync(join(pkg, "xpl.mjs"));
const updatedCli = join(updated, "bin/xpl");
run(["skill", "install"], scratch, updatedCli);
assert.equal(
  JSON.parse(readFileSync(join(skill, "xpl-install.json"), "utf8")).cli,
  join(updated, "lib/node_modules/@xpl/cli/xpl.mjs"),
);
assert.equal(run(["--version"], scratch, join(skill, "bin/xpl")).trim(), metadata.version);
cli = updatedCli;
pkg = join(updated, "lib/node_modules/@xpl/cli");
const originalSkill = readFileSync(join(skill, "SKILL.md"), "utf8");
writeFileSync(join(skill, "SKILL.md"), originalSkill + "\nLocal edit\n");
assert.match(rejected(["skill", "install", "--json"]).error, /Will not replace/);
assert.match(readFileSync(join(skill, "SKILL.md"), "utf8"), /Local edit/);
writeFileSync(join(skill, "SKILL.md"), originalSkill);
const corrupt = join(pkg, "wasm/tree-sitter-go.wasm");
const grammar = readFileSync(corrupt);
writeFileSync(corrupt, "corrupt");
const damaged = rejected(["doctor", "--json"]);
assert.equal(damaged.checks.find((check) => check.id === "artifact").status, "missing");
assert.equal(damaged.checks.find((check) => check.id === "grammars").status, "missing");
writeFileSync(corrupt, grammar);

const browser = await chromium.launch();
const results = [];
try {
  for (const language of ["ts", "py", "go"]) {
    const fixture = join(scratch, `${language}-jobrunner`);
    cpSync(join(repo, `fixtures/${language}-jobrunner`), fixture, {
      recursive: true,
      filter: (path) => !/[\\/](\.explainer|node_modules)([\\/]|$)/.test(path),
    });
    const patch = join(scratch, `${language}.patch.json`);
    cpSync(
      language === "ts"
        ? join(repo, "packages/viewer/scripts/ts-example.patch.json")
        : join(
            pkg,
            `skill/code-explainer/reference/examples/${language === "py" ? "py-overview" : "go-retry"}.patch.json`,
          ),
      patch,
    );
    const index = JSON.parse(run(["index", "--precise", "off", "--json"], fixture));
    assert.equal(index.ok, true);
    const savedIndex = JSON.parse(
      readFileSync(
        join(
          fixture,
          ".explainer",
          readdirSync(join(fixture, ".explainer")).find((name) => /^index-.*\.json$/.test(name)),
        ),
        "utf8",
      ),
    );
    assert(savedIndex.refs.length > 0);
    assert(savedIndex.refs.every((ref) => ref.resolution === "heuristic"));
    run(["new", "demo", "--title", "Local install demo"], fixture);
    run(["apply", "demo", patch], fixture);
    run(["validate", "demo"], fixture);
    const output = join(scratch, `${language}.html`);
    // The TS structural example leaves reader text unfinished. Installed export must gate it too.
    if (language === "ts") {
      const blocked = rejected(["bundle", "demo", "-o", output, "--json"], fixture);
      assert.equal(blocked.readiness.ready, false);
      assert.equal(blocked.readiness.errors, 7);
      assert.equal(existsSync(output), false);
    }
    const preview = JSON.parse(run(["bundle", "demo", "-o", output, "--draft", "--json"], fixture));
    assert.equal(preview.exportStatus, "draft");
    const page = await browser.newPage();
    const problems = [];
    page.on("pageerror", (error) => problems.push(error.message));
    await page.route(/^https?:/, (route) => route.abort());
    await page.goto(pathToFileURL(output).href + "?perspective=map");
    await expect(page.locator("#root")).toContainText("Local install demo");
    await expect(page.locator(".workspace-diagram svg").first()).toBeVisible();
    await expect(page.getByTestId("draft-banner")).toContainText("Draft preview");
    await page.close();
    assert.deepEqual(problems, []);

    // A complete one-file explanation checks the positive ready path without filling the examples mechanically.
    const file = {
      ts: "src/runner.ts",
      py: "jobrunner/runner.py",
      go: "internal/runner/runner.go",
    }[language];
    const readyPatch = join(scratch, `${language}.ready.patch.json`);
    writeFileSync(
      readyPatch,
      JSON.stringify({
        nodes: [
          {
            id: `file:${file}`,
            kind: "file",
            parent: `dir:${dirname(file)}`,
            label: "Job dispatch",
            summary:
              "The runner sends queued jobs to workers and schedules retries after failures.",
            anchors: [{ file, role: "definition" }],
          },
        ],
        views: [
          {
            id: "view:dispatch",
            type: "graph",
            title: "Job dispatch",
            scope: { root: "repo", depth: 1 },
            include: [`file:${file}`],
            stubs: { mode: "none" },
          },
        ],
      }),
    );
    run(["new", "ready-demo", "--title", "Ready install demo"], fixture);
    run(["apply", "ready-demo", readyPatch], fixture);
    assert.equal(JSON.parse(run(["ready", "ready-demo", "--json"], fixture)).ready, true);
    const readyOutput = join(scratch, `${language}.ready.html`);
    const exported = JSON.parse(
      run(["bundle", "ready-demo", "-o", readyOutput, "--json"], fixture),
    );
    assert.equal(exported.exportStatus, "ready");
    assert.equal(exported.readiness.ready, true);
    if (language === "ts") {
      const artifactPath = join(fixture, ".explainer/ready-demo.explainer.json");
      const beforeArtifact = readFileSync(artifactPath, "utf8");
      const service = JSON.parse(
        run(
          [
            "service",
            "start",
            "ready-demo",
            "--background",
            "--port",
            "0",
            "--backend",
            "claude",
            "--json",
          ],
          fixture,
        ),
      );
      const attached = await browser.newPage();
      try {
        await attached.goto(service.url + "?perspective=code");
        const connection = attached.getByTestId("connection-status");
        await expect(connection).toHaveAttribute("data-status", "connected");
        assert.deepEqual(JSON.parse(new URL(attached.url()).searchParams.get("attachment")), {
          root: fixture,
          guide: service.guide,
        });
        await connection.getByText("Repository and backend").click();
        await expect(connection).toContainText(service.instanceId);
        await expect(connection).toContainText(
          "Agent backend unavailable (Claude selected). No agent is configured.",
        );
        await attached.locator(`.tree-row[data-path="${file}"]`).click();
        await expect(attached.locator(`[data-file="${file}"] .cm-content`)).toContainText("Runner");
        await attached.evaluate((id) => window.__xpl.select([id]), `file:${file}`);
        const bookmarked = attached.url();
        assert.equal(service.state, "running");
        assert.equal(service.root, fixture);
        assert.equal(service.guide, ".explainer/ready-demo.explainer.json");
        assert.equal(service.backend, "claude");
        assert.match(service.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
        assert.equal((await fetch(service.url)).status, 200);
        assert.match(
          rejected(["service", "start", "ready-demo", "--json"], fixture).error,
          /already running/,
        );
        assert.equal(JSON.parse(run(["service", "stop", "--json"], fixture)).state, "stopped");
        await expect(connection).toHaveAttribute("data-status", "disconnected");
        // Export from the stopped page: no workspace claims or live dependency remain.
        await connection.getByRole("button", { name: "Use loaded snapshot offline" }).click();
        await expect(connection).toHaveAttribute("data-status", "offline");
        await attached.getByRole("button", { name: "Edit", exact: true }).click();
        await attached.getByRole("menuitem", { name: "Save as HTML" }).click();
        await expect(attached.getByTestId("save-html-ready")).toBeEnabled();
        const downloadPromise = attached.waitForEvent("download");
        await attached.getByTestId("save-html-ready").click();
        const download = await downloadPromise;
        const stoppedOutput = join(scratch, "ts.stopped-snapshot.html");
        await download.saveAs(stoppedOutput);
        const stoppedData = JSON.parse(
          /<script id="xpl-data" type="application\/json">([\s\S]*?)<\/script>/.exec(
            readFileSync(stoppedOutput, "utf8"),
          )[1],
        );
        assert.equal(stoppedData.server, undefined);
        assert.equal(stoppedData.exportInfo.report.scope, "embedded-snapshot");
        const saved = await browser.newPage();
        try {
          await saved.route(/^https?:/, (route) => route.abort());
          await saved.goto(pathToFileURL(stoppedOutput).href + "?perspective=code");
          await expect
            .poll(() => saved.evaluate(() => window.__xpl?.state().serverMode))
            .toBe(false);
          await saved.locator(`.tree-row[data-path="${file}"]`).click();
          await expect(saved.locator(`[data-file="${file}"] .cm-content`)).toContainText("Runner");
        } finally {
          await saved.close();
        }
        const restarted = JSON.parse(run(["service", "start", "--background", "--json"], fixture));
        assert.equal(restarted.url, service.url);
        assert.equal(restarted.guide, service.guide);
        assert.equal(restarted.backend, "claude");
        assert.notEqual(restarted.instanceId, service.instanceId);
        await connection.getByRole("button", { name: "Retry connection" }).click();
        await expect(connection).toHaveAttribute("data-status", "connected");
        await expect(connection).toContainText(restarted.instanceId);
        await expect
          .poll(() => attached.evaluate(() => window.__xpl.selection()))
          .toEqual([`file:${file}`]);
        await attached.goto(bookmarked);
        await expect(connection).toHaveAttribute("data-status", "connected");
        await expect(connection).toContainText(restarted.instanceId);
      } finally {
        await attached.close();
        run(["service", "stop", "--json"], fixture);
      }

      // Own this child directly so its exit is reaped before testing explicit crash recovery.
      const crashed = spawn(cli, ["service", "start", "--port", "0", "--json"], {
        cwd: fixture,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let startup = "";
      let crashErrors = "";
      crashed.stderr.on("data", (chunk) => {
        crashErrors += chunk;
      });
      try {
        await new Promise((resolveReady, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`service did not start: ${crashErrors}`)),
            15000,
          );
          crashed.once("exit", () => {
            clearTimeout(timer);
            reject(new Error(`service exited: ${crashErrors}`));
          });
          crashed.stdout.on("data", (chunk) => {
            startup += chunk;
            try {
              JSON.parse(startup);
              clearTimeout(timer);
              resolveReady();
            } catch {
              /* wait for complete JSON */
            }
          });
        });
      } finally {
        const exited = once(crashed, "exit");
        crashed.kill("SIGKILL");
        await exited;
      }
      const interrupted = JSON.parse(run(["service", "status", "--json"], fixture));
      assert.equal(interrupted.state, "interrupted");
      assert.match(
        rejected(["service", "start", "--json"], fixture).error,
        /interrupted.*--recover/,
      );
      const recovered = JSON.parse(
        run(["service", "start", "--recover", "--background", "--json"], fixture),
      );
      try {
        assert.equal(recovered.state, "running");
        assert.equal(recovered.guide, service.guide);
        assert(
          existsSync(
            join(fixture, `.explainer/service/interrupted-${interrupted.instanceId}.json`),
          ),
        );
        assert.equal(readFileSync(artifactPath, "utf8"), beforeArtifact);
      } finally {
        run(["service", "stop", "--json"], fixture);
      }
      // Manual export and the offline reader below run after stopping the optional service.
      assert.equal(
        JSON.parse(run(["bundle", "ready-demo", "-o", readyOutput, "--json"], fixture))
          .exportStatus,
        "ready",
      );
      run(["validate", "ready-demo"], fixture);
      results.push(
        "ts: packed start/stop/restart, same-page and bookmarked guide reconnect, unavailable backend, stopped-page snapshot save with blocked-network reading, saved context, duplicate refusal, crash/recovery and manual export after stop passed",
      );
    }
    const offline = await browser.newPage();
    await offline.route(/^https?:/, (route) => route.abort());
    await offline.goto(pathToFileURL(readyOutput).href + "?perspective=code");
    await expect(offline.locator("#root")).toContainText("Ready install demo");
    await expect(offline.getByTestId("draft-banner")).toHaveCount(0);
    await offline.locator(`.tree-row[data-path="${file}"]`).click();
    await expect(offline.locator(`[data-file="${file}"] .cm-content`)).toContainText("Runner");
    await offline.close();

    const server = spawn(cli, ["view", "demo", "--no-open", "--port", "0", "--json"], {
      cwd: fixture,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let outputText = "";
    let errors = "";
    server.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    const ready = new Promise((resolveReady, reject) => {
      server.stdout.on("data", (chunk) => {
        outputText += chunk;
        try {
          resolveReady(JSON.parse(outputText));
        } catch {
          /* wait for the complete JSON */
        }
      });
      server.once("exit", (code) => reject(new Error(`view exited ${code}: ${errors}`)));
    });
    try {
      const address = await Promise.race([
        ready,
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error("viewer did not start")), 15000);
          timer.unref();
        }),
      ]);
      const local = await browser.newPage();
      await local.route(/^https?:/, (route) =>
        route.request().url().startsWith(address.url) ? route.continue() : route.abort(),
      );
      await local.goto(address.url + "?perspective=map");
      await expect(local.locator("#root")).toContainText("Local install demo");
      await expect(local.locator(".workspace-diagram svg").first()).toBeVisible();
      await local.close();
    } finally {
      const stopped = once(server, "exit");
      server.kill("SIGTERM");
      await stopped;
    }
    results.push(
      `${language}: bundled grammars, heuristic index, new/apply/validate, ready export gate, explicit draft, local viewer and disconnected ready HTML passed`,
    );
  }
} finally {
  await browser.close();
}
const evidence = {
  platform: `${process.platform} ${process.arch}`,
  node: process.versions.node,
  scratch,
  tarball,
  checkoutReads: "denied by Node permissions",
  results,
  notChecked: [
    "Other platforms",
    "Precise tool bootstrap",
    "Claude Code authentication or generation",
  ],
};
writeFileSync(join(scratch, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify(evidence, null, 2));
