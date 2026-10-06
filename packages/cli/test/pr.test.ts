import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/cli.js";
import {
  git,
  invoke,
  makeTempDir,
  readJson,
  writeFile,
  writeViewerStub,
  bundleOf,
  xplJson,
} from "./helpers.js";

const stagedDirectories: string[] = [];
afterEach(() => {
  for (const directory of stagedDirectories.splice(0))
    for (const name of readdirSync(directory))
      if (name.startsWith("version-")) chmodSync(join(directory, name), 0o700);
});

function fixture() {
  const root = makeTempDir();
  writeFile(root, "app.ts", "export function app() { return 1; }\n");
  writeFile(
    root,
    "caller.ts",
    "import { app } from './app.js';\nexport function call() { return app(); }\n",
  );
  writeFile(root, "gone.ts", "export const gone = 1;\n");
  writeFile(root, "old.ts", "export function renamed() { return 'same'; }\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  const base = git(root, "rev-parse", "HEAD");
  writeFile(root, "app.ts", "export function app() { return 2; }\n");
  writeFile(root, "new.ts", "export const fresh = 3;\n");
  rmSync(join(root, "gone.ts"));
  renameSync(join(root, "old.ts"), join(root, "renamed.ts"));
  git(root, "add", ".");
  git(root, "commit", "-qm", "head");
  const head = git(root, "rev-parse", "HEAD");
  const tools = makeTempDir();
  const gh = writeFile(
    tools,
    "gh",
    `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync(process.env.GH_ARGS, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(fs.readFileSync(process.env.GH_DATA));\n`,
  );
  chmodSync(gh, 0o755);
  const response = {
    number: 7,
    base: { sha: base, ref: "main", repo: { full_name: "team/project" } },
    head: { sha: head, ref: "feature", repo: { full_name: "team/project" } },
  };
  const data = writeFile(tools, "response.json", JSON.stringify(response));
  const config = writeFile(
    tools,
    "gitconfig",
    `[url "file://${root}"]\n\tinsteadOf = https://github.com/team/project.git\n`,
  );
  const cache = makeTempDir();
  const env = {
    PATH: `${tools}:${process.env.PATH}`,
    GH_DATA: data,
    GH_ARGS: join(tools, "args.json"),
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  return { root, base, head, tools, response, cache, env };
}

// A managed installed launcher imports the real source CLI, so this contract runs without build artifacts.
function installedSkill() {
  const dir = makeTempDir();
  const skill = join(dir, "skill");
  cpSync(resolve("skill/code-explainer"), skill, { recursive: true });
  const cli = writeFile(
    dir,
    "xpl.mjs",
    `import { tsImport } from ${JSON.stringify(resolve("node_modules/tsx/dist/esm/api/index.mjs"))};\nawait tsImport(${JSON.stringify(resolve("packages/cli/src/main.ts"))}, import.meta.url);\n`,
  );
  const files = Object.fromEntries(
    ["SKILL.md", "bin/xpl", "reference/create.md"].map((file) => [
      file,
      createHash("sha256")
        .update(readFileSync(join(skill, file)))
        .digest("hex"),
    ]),
  );
  writeFile(skill, "xpl-install.json", JSON.stringify({ version: "0.0.0", cli, files }));
  return { skill, cli, viewer: writeViewerStub() };
}

async function creation() {
  const f = fixture();
  const installed = installedSkill();
  const env = { ...f.env, XPL_VIEWER_HTML: installed.viewer };
  const created = await invoke(
    [
      "pr",
      "create",
      "team/project#7",
      "--name",
      "review-change",
      "--audience",
      "reviewers",
      "--question",
      "What changes for app callers?",
      "--skill-dir",
      installed.skill,
      "--cache-dir",
      f.cache,
      "--json",
    ],
    { cwd: f.root, env },
  );
  expect(created.code, created.out).toBe(0);
  const output = JSON.parse(created.out);
  const handoff = readJson(output.directory, "handoff.json");
  const runInstalled = (...args: string[]) => {
    try {
      return execFileSync(handoff.command[0], [...handoff.command.slice(1), ...args, "--json"], {
        cwd: f.root,
        encoding: "utf8",
        env: {
          ...process.env,
          ...env,
          GIT_DIR: join(f.root, ".git"),
          GIT_WORK_TREE: f.root,
          GIT_INDEX_FILE: join(f.root, ".git/index"),
          XPL_CLI: "/invalid-inherited-cli",
        },
      });
    } catch (error) {
      throw new Error(String((error as { stdout?: unknown }).stdout ?? error));
    }
  };
  // Recorded authoring response, independent of draft prose; the installed skill supplies the workflow.
  const recorded = JSON.stringify({
    scope: { audience: "reviewers" },
    nodes: [
      {
        id: "file:app.ts",
        summary: "Changed: app returns two for every call.",
        anchors: [{ file: "app.ts", symbol: "app", role: "definition" }],
      },
      {
        id: "file:new.ts",
        summary: "New: fresh exports the value three.",
        anchors: [{ file: "new.ts", symbol: "fresh", role: "definition" }],
      },
      {
        id: "file:renamed.ts",
        summary: "Unchanged: renamed returns the same string from its new path.",
        anchors: [{ file: "renamed.ts", symbol: "renamed", role: "definition" }],
      },
    ],
    concepts: [
      {
        id: "concept:removed-source",
        label: "Removed export",
        summary: "The gone export is deleted from head.",
        anchors: [
          { file: "gone.ts", at: "base", find: "export const gone = 1;", role: "definition" },
        ],
      },
    ],
    views: [
      {
        id: "view:recorded-change",
        type: "graph",
        title: "Changed exports",
        include: ["file:app.ts", "file:new.ts", "file:renamed.ts"],
        stubs: { mode: "none" },
      },
    ],
    tours: [
      {
        id: "tour:recorded-change",
        title: "Review the changed exports",
        summary:
          "The return value changes, one export is added, one is removed and a function moves to a new file. External importers may fail after the deletion; this fixture contains no tests.",
        steps: [
          {
            id: "app",
            view: "view:recorded-change",
            focus: ["file:app.ts"],
            note: "### Callers receive a different value\nThe caller still invokes app without arguments. Before: the result was one. Now: the result is two.",
            code: [
              {
                file: "app.ts",
                at: "base",
                find: "export function app() { return 1; }",
                role: "definition",
              },
              { file: "app.ts", symbol: "app", role: "definition" },
            ],
          },
          {
            id: "new",
            view: "view:recorded-change",
            focus: ["file:new.ts"],
            note: "### A new exported constant\nConsumers can import fresh. No caller of this constant appears in the head snapshot.",
            code: [{ file: "new.ts", symbol: "fresh", role: "definition" }],
          },
          {
            id: "renamed",
            view: "view:recorded-change",
            focus: ["file:renamed.ts"],
            note: "### The function moves without changing its body\nThe rename preserves the returned string. Compare old.ts with renamed.ts.",
            code: [
              {
                file: "old.ts",
                at: "base",
                find: "export function renamed() { return 'same'; }",
                role: "definition",
              },
              { file: "renamed.ts", symbol: "renamed", role: "definition" },
            ],
          },
          {
            id: "removed",
            focus: ["concept:removed-source"],
            view: "view:recorded-change",
            note: "### The removed export may break external consumers\nHead has no gone.ts. This fixture has no tests and cannot establish behavior for external importers.",
            code: [
              { file: "gone.ts", at: "base", find: "export const gone = 1;", role: "definition" },
            ],
          },
        ],
      },
    ],
  });
  writeFile(output.directory, "recorded-patch.json", recorded);
  runInstalled("lint", "review-change", "--patch", join(output.directory, "recorded-patch.json"));
  runInstalled("apply", "review-change", join(output.directory, "recorded-patch.json"));
  return { ...f, ...installed, env, ...output, runInstalled };
}

describe("PR input", () => {
  it("hands exact PR input to the installed creation skill without starting a model", async () => {
    const f = fixture();
    const installed = installedSkill();
    const result = await invoke(
      [
        "pr",
        "create",
        "team/project#7",
        "--name",
        "review-change",
        "--audience",
        "reviewers",
        "--question",
        "What changes for app callers?",
        "--skill-dir",
        installed.skill,
        "--cache-dir",
        f.cache,
        "--json",
      ],
      { cwd: f.root, env: f.env },
    );
    expect(result.code, result.out).toBe(0);
    const output = JSON.parse(result.out);
    const handoff = readJson(output.directory, "handoff.json");
    expect(handoff.kind).toBe("github-pr-creation");
    expect(handoff.skill.cli).toBe(installed.cli);
    expect(handoff.skill.launcher).toBe(join(installed.skill, "bin/xpl"));
    expect(handoff.invocation).toContain(`/code-explainer explain change ${f.base}..${f.head}`);
    expect(handoff.invocation).toContain(output.repository);
    expect(handoff.invocation).toContain("Existing guide: review-change");
    expect(handoff.invocation).toContain("What changes for app callers?");
    expect(readJson(output.repository, ".explainer/review-change.explainer.json").change).toEqual(
      readJson(output.directory, "input.json").change,
    );
    expect(readFileSync(join(output.directory, "draft.json"), "utf8")).toContain("TODO");
    expect(readdirSync(output.directory).filter((path) => path.startsWith("result-"))).toEqual([]);
  });

  it("finishes and stages an exact ready PR snapshot without changing developer work", async () => {
    const f = await creation();
    writeFile(f.root, "app.ts", "staged developer work\n");
    git(f.root, "add", "app.ts");
    writeFile(f.root, "app.ts", "unstaged developer work\n");
    writeFile(f.root, "notes.txt", "untracked developer notes\n");
    const developerIndex = readFileSync(join(f.root, ".git/index"));
    const developerBranch = git(f.root, "symbolic-ref", "HEAD");
    const developerRefs = git(f.root, "show-ref");

    const result = await invoke(["pr", "finish", f.directory, "--cache-dir", f.cache, "--json"], {
      cwd: f.root,
      env: {
        ...f.env,
        GIT_DIR: join(f.root, ".git"),
        GIT_WORK_TREE: f.root,
        GIT_INDEX_FILE: join(f.root, ".git/index"),
        XPL_CLI: "/invalid-inherited-cli",
      },
    });
    expect(result.code, result.out).toBe(0);
    const output = JSON.parse(result.out);
    const manifest = readJson(output.directory, "result.json");
    expect(manifest).toMatchObject({
      kind: "github-pr-result",
      schemaVersion: 1,
      status: "ready",
      pr: { base: { sha: f.base }, head: { sha: f.head } },
      observed: { base: { sha: f.base }, head: { sha: f.head } },
      readiness: { ready: true, errors: 0 },
    });
    expect(manifest.includedSource).toEqual({
      head: ["app.ts", "caller.ts", "new.ts", "renamed.ts"],
      base: ["app.ts", "gone.ts", "renamed.ts"],
    });
    for (const file of [manifest.input, ...Object.values(manifest.artifacts)] as {
      path: string;
      sha256: string;
    }[]) {
      expect(
        createHash("sha256")
          .update(readFileSync(join(output.directory, file.path)))
          .digest("hex"),
      ).toBe(file.sha256);
    }
    const html = bundleOf(
      readFileSync(join(output.directory, manifest.artifacts.html.path), "utf8"),
    );
    expect(html.files["app.ts"]).toBe("export function app() { return 2; }\n");
    expect(html.baseFiles?.["app.ts"]).toBe("export function app() { return 1; }\n");
    expect(html.baseFiles?.["gone.ts"]).toBe("export const gone = 1;\n");
    expect(html.exportInfo?.report.identity).toEqual(manifest.readiness.identity);
    expect(statSync(output.manifestPath).mode & 0o222).toBe(0);

    const destination = makeTempDir();
    stagedDirectories.push(destination);
    const missingResult = await invoke(
      ["stage", "review-change", "--root", f.repository, "--dir", destination, "--json"],
      { cwd: f.root, env: f.env },
    );
    expect(missingResult.code, missingResult.out).toBe(1);
    expect(JSON.parse(missingResult.out).error).toContain("require --pr-result");
    expect(readdirSync(destination)).toEqual([]);
    for (const invalid of ["superseded", "input", "html", "explainer", "index", "scope"] as const) {
      const changed = structuredClone(manifest);
      if (invalid === "superseded") changed.status = "superseded";
      else if (invalid === "scope") changed.includedSource.head = [];
      else
        (invalid === "input" ? changed.input : changed.artifacts[invalid]).sha256 = "a".repeat(64);
      const invalidPath = writeFile(
        output.directory,
        "invalid-result.json",
        JSON.stringify(changed),
      );
      const rejected = await invoke(
        [
          "stage",
          "review-change",
          "--root",
          f.repository,
          "--pr-result",
          invalidPath,
          "--dir",
          destination,
          "--json",
        ],
        { cwd: f.root, env: f.env },
      );
      expect(rejected.code, rejected.out).toBe(1);
      expect(JSON.parse(rejected.out).error).toContain(
        invalid === "superseded"
          ? "requires a ready"
          : invalid === "scope"
            ? "do not describe"
            : "hash changed",
      );
      expect(readdirSync(destination)).toEqual([]);
    }
    const stage = await invoke(
      [
        "stage",
        "review-change",
        "--root",
        f.repository,
        "--pr-result",
        output.manifestPath,
        "--dir",
        destination,
        "--json",
      ],
      { cwd: f.root, env: f.env },
    );
    expect(stage.code, stage.out).toBe(0);
    const version = readJson(destination, "current/manifest.json");
    expect(version.prResult.manifest).toEqual(manifest);
    expect(version.prResult.sha256).toBe(
      createHash("sha256").update(readFileSync(output.manifestPath)).digest("hex"),
    );
    expect(version.commits).toEqual({ index: f.head, base: f.base, head: f.head });
    expect(version.includedSource).toEqual(manifest.includedSource);
    const stagedBundle = bundleOf(readFileSync(join(destination, "current/index.html"), "utf8"));
    const readyBundle = bundleOf(readFileSync(join(output.directory, "guide.html"), "utf8"));
    expect(stagedBundle.publication?.current.identity).toEqual(manifest.readiness.identity);
    const { publication: _publication, ...content } = stagedBundle;
    expect(content).toEqual(readyBundle);
    expect(version.artifacts.html.sha256).toBe(
      createHash("sha256")
        .update(readFileSync(join(destination, "current/index.html")))
        .digest("hex"),
    );

    expect(readFileSync(join(f.root, ".git/index"))).toEqual(developerIndex);
    expect(git(f.root, "symbolic-ref", "HEAD")).toBe(developerBranch);
    expect(git(f.root, "show-ref")).toBe(developerRefs);
    expect(readFileSync(join(f.root, "app.ts"), "utf8")).toBe("unstaged developer work\n");
    expect(readFileSync(join(f.root, "notes.txt"), "utf8")).toBe("untracked developer notes\n");
    const saved = readFileSync(output.manifestPath);
    const repeat = await invoke(["pr", "finish", f.directory, "--cache-dir", f.cache, "--json"], {
      cwd: f.root,
      env: f.env,
    });
    expect(repeat.code, repeat.out).toBe(0);
    expect(JSON.parse(repeat.out).directory).not.toBe(output.directory);
    expect(readFileSync(output.manifestPath)).toEqual(saved);
  });

  it.each(["head", "base", "unavailable", "source-during-check"] as const)(
    "keeps the previous local version when PR %s changes at promotion",
    async (failure) => {
      const f = await creation();
      const finish = await invoke(["pr", "finish", f.directory, "--cache-dir", f.cache, "--json"], {
        cwd: f.root,
        env: f.env,
      });
      expect(finish.code, finish.out).toBe(0);
      const ready = JSON.parse(finish.out);
      const destination = makeTempDir();
      stagedDirectories.push(destination);
      const args = [
        "stage",
        "review-change",
        "--root",
        f.repository,
        "--pr-result",
        ready.manifestPath,
        "--dir",
        destination,
      ];
      const first = await invoke(args, { cwd: f.root, env: f.env });
      expect(first.code, first.err).toBe(0);
      const oldHtml = readFileSync(join(destination, "current/index.html"));
      const oldManifest = readFileSync(join(destination, "current/manifest.json"));
      const oldVersions = readdirSync(destination).sort();
      const errors: string[] = [];
      let staged = false;
      const code = await run(args, {
        cwd: f.root,
        env: { ...process.env, ...f.env },
        err: (text) => errors.push(text),
        out: (text) => {
          if (!text.startsWith("Staged ")) return;
          staged = true;
          if (failure === "head" || failure === "base") {
            f.response[failure].sha = "a".repeat(40);
            writeFile(f.tools, "response.json", JSON.stringify(f.response));
          } else if (failure === "unavailable") {
            writeFile(
              f.tools,
              "gh",
              `#!${process.execPath}\nprocess.stderr.write('access unavailable');process.exit(1);\n`,
            );
          } else {
            writeFile(
              f.tools,
              "gh",
              `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(join(f.repository, "app.ts"))}, 'export function app() { return 99; }\\n');process.stdout.write(fs.readFileSync(process.env.GH_DATA));\n`,
            );
          }
        },
      });
      expect(staged).toBe(true);
      expect(code, errors.join("\n")).toBe(1);
      expect(errors.join("\n")).toContain("previous current version retained");
      expect(errors.join("\n")).toContain(
        failure === "unavailable"
          ? "access unavailable"
          : failure === "source-during-check"
            ? "differs from the raw head blob"
            : "superseded",
      );
      expect(readFileSync(join(destination, "current/index.html"))).toEqual(oldHtml);
      expect(readFileSync(join(destination, "current/manifest.json"))).toEqual(oldManifest);
      expect(readdirSync(destination).sort()).toEqual(oldVersions);
    },
  );

  it.each(["head", "base"] as const)(
    "rechecks an updated %s after export, retains historical output and binds the next creation",
    async (side) => {
      const f = await creation();
      const previousResponse = JSON.stringify(f.response);
      // The API returns updated commits only after local export exists. A pre-export-only check is stale.
      writeFile(
        f.tools,
        "gh",
        `#!${process.execPath}\nconst fs=require('node:fs');const path=require('node:path');const exported=fs.readdirSync(process.env.PR_INPUT).filter(name=>name.startsWith('result-')).some(name=>fs.existsSync(path.join(process.env.PR_INPUT,name,'guide.html')));process.stdout.write(exported?fs.readFileSync(process.env.GH_DATA):process.env.PR_OLD_RESPONSE);\n`,
      );
      Object.assign(f.env, { PR_INPUT: f.directory, PR_OLD_RESPONSE: previousResponse });

      writeFile(f.root, "app.ts", "export function app() { return 4; }\n");
      git(f.root, "add", ".");
      git(f.root, "commit", "-qm", "updated PR");
      const updated = git(f.root, "rev-parse", "HEAD");
      f.response[side].sha = updated;
      writeFile(f.tools, "response.json", JSON.stringify(f.response));
      const result = await invoke(["pr", "finish", f.directory, "--cache-dir", f.cache, "--json"], {
        cwd: f.root,
        env: f.env,
      });
      expect(result.code, result.out).toBe(1);
      const output = JSON.parse(result.out);
      expect(output.ok).toBe(false);
      expect(output.status).toBe("superseded");
      expect(readJson(output.directory, "result.json").observed[side].sha).toBe(updated);
      expect(readJson(output.directory, "result.json").pr[side].sha).toBe(
        side === "head" ? f.head : f.base,
      );
      expect(existsSync(join(f.directory, "current.json"))).toBe(false);
      const next = await invoke(
        [
          "pr",
          "create",
          "team/project#7",
          "--name",
          "updated-change",
          "--audience",
          "reviewers",
          "--question",
          "What changed?",
          "--skill-dir",
          f.skill,
          "--cache-dir",
          f.cache,
          "--json",
        ],
        { cwd: f.root, env: f.env },
      );
      expect(next.code, next.out).toBe(0);
      const current = JSON.parse(next.out);
      expect(current.directory).not.toBe(f.directory);
      expect(readJson(current.directory, "input.json").pr[side].sha).toBe(updated);
      expect(
        readJson(current.repository, ".explainer/updated-change.explainer.json").change[side],
      ).toBe(updated);
    },
  );

  it("fails closed on unavailable API access and readiness errors while retaining input and authored work", async () => {
    const f = await creation();
    writeFile(f.tools, "response.json", "not JSON");
    const inaccessible = await invoke(
      ["pr", "finish", f.directory, "--cache-dir", f.cache, "--json"],
      { cwd: f.root, env: f.env },
    );
    expect(inaccessible.code, inaccessible.out).toBe(1);
    expect(inaccessible.out).toContain("cannot resolve");
    expect(readdirSync(f.directory).filter((path) => path.startsWith("result-"))).toEqual([]);
    writeFile(f.tools, "response.json", JSON.stringify(f.response));
    const patch = writeFile(
      f.directory,
      "unfinished.json",
      JSON.stringify({
        views: [{ id: "view:unfinished", type: "graph", title: "TODO", include: ["file:app.ts"] }],
      }),
    );
    f.runInstalled("apply", "review-change", patch);
    const unfinished = await invoke(
      ["pr", "finish", f.directory, "--cache-dir", f.cache, "--json"],
      { cwd: f.root, env: f.env },
    );
    expect(unfinished.code, unfinished.out).toBe(1);
    expect(unfinished.out).toContain("TODO");
    expect(readdirSync(f.directory).filter((path) => path.startsWith("result-"))).toEqual([]);
    expect(existsSync(join(f.directory, "input.json"))).toBe(true);
    expect(
      readJson(f.repository, ".explainer/review-change.explainer.json").views.find(
        (v: { id: string }) => v.id === "view:unfinished",
      ).title,
    ).toBe("TODO");
  });

  it("refuses source bytes changed after creation even when normalized index hashes still match", async () => {
    const f = await creation();
    writeFile(f.repository, "app.ts", "export function app() { return 2; }\r\n");
    const result = await invoke(["pr", "finish", f.directory, "--cache-dir", f.cache, "--json"], {
      cwd: f.root,
      env: f.env,
    });
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain("app.ts differs from the raw head blob");
    expect(readdirSync(f.directory).filter((path) => path.startsWith("result-"))).toEqual([]);
  });

  it("refuses changed installation bindings and tampered input indexes without publishing results", async () => {
    const f = await creation();
    const binding = readJson(f.skill, "xpl-install.json");
    writeFile(
      f.skill,
      "xpl-install.json",
      JSON.stringify({ ...binding, cli: "/missing-installed-cli" }),
    );
    const changed = await invoke(["pr", "finish", f.directory, "--cache-dir", f.cache, "--json"], {
      cwd: f.root,
      env: f.env,
    });
    expect(changed.code, changed.out).toBe(1);
    expect(changed.out).toContain("installed PR creation skill is unavailable");
    expect(readdirSync(f.directory).filter((path) => path.startsWith("result-"))).toEqual([]);
    writeFile(f.skill, "xpl-install.json", JSON.stringify(binding));
    const input = readJson(f.directory, "input.json");
    writeFile(
      f.directory,
      input.index.path,
      readFileSync(join(f.directory, input.index.path), "utf8") + " ",
    );
    const tampered = await invoke(["pr", "finish", f.directory, "--cache-dir", f.cache, "--json"], {
      cwd: f.root,
      env: f.env,
    });
    expect(tampered.code, tampered.out).toBe(1);
    expect(tampered.out).toContain("PR input index changed");
    expect(readdirSync(f.directory).filter((path) => path.startsWith("result-"))).toEqual([]);
  });

  it("ignores inherited developer git overrides for indexing, changes and source reads", async () => {
    const f = fixture();
    const developer = makeTempDir();
    writeFile(developer, "developer.ts", "export const developer = 99;\n");
    git(developer, "init", "-q", "-b", "developer");
    git(developer, "add", ".");
    git(developer, "commit", "-qm", "unrelated developer repository");
    writeFile(developer, "developer.ts", "dirty developer work\n");
    const index = readFileSync(join(developer, ".git/index"));
    vi.stubEnv("GIT_DIR", join(developer, ".git"));
    vi.stubEnv("GIT_WORK_TREE", developer);
    vi.stubEnv("GIT_INDEX_FILE", join(developer, ".git/index"));
    let result;
    try {
      result = await invoke(["pr", "prepare", "team/project#7", "--cache-dir", f.cache, "--json"], {
        cwd: developer,
        env: f.env,
      });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(result.code, result.out).toBe(0);
    const output = JSON.parse(result.out);
    const manifest = readJson(output.directory, "input.json");
    expect(manifest.change.files.map((file: { path: string }) => file.path)).toEqual([
      "app.ts",
      "gone.ts",
      "new.ts",
      "renamed.ts",
    ]);
    expect(manifest.sources.find((file: { path: string }) => file.path === "new.ts").after).toEqual(
      { state: "text", text: "export const fresh = 3;\n" },
    );
    const indexData = readJson(output.directory, manifest.index.path);
    expect(indexData.files.map((file: { path: string }) => file.path)).toEqual([
      "app.ts",
      "caller.ts",
      "new.ts",
      "renamed.ts",
    ]);
    expect(indexData.commit).toBe(f.head);
    expect(git(output.repository, "rev-parse", "HEAD")).toBe(f.head);
    expect(readFileSync(join(developer, ".git/index"))).toEqual(index);
    expect(readFileSync(join(developer, "developer.ts"), "utf8")).toBe("dirty developer work\n");
    expect(git(developer, "symbolic-ref", "HEAD")).toBe("refs/heads/developer");
  });

  it("refuses smudge-transformed checkout bytes before indexing or publishing input", async () => {
    const f = fixture();
    writeFile(f.root, ".gitattributes", "new.ts filter=transform\n");
    git(f.root, "add", ".gitattributes");
    git(f.root, "commit", "-qm", "select a configured smudge filter");
    f.response.head.sha = git(f.root, "rev-parse", "HEAD");
    writeFile(f.tools, "response.json", JSON.stringify(f.response));
    writeFile(
      f.tools,
      "gitconfig",
      readFileSync(f.env.GIT_CONFIG_GLOBAL, "utf8") +
        '[filter "transform"]\n\tsmudge = sed s/fresh/transformed/g\n\tclean = cat\n\trequired = true\n',
    );
    const result = await invoke(
      ["pr", "prepare", "team/project#7", "--cache-dir", f.cache, "--json"],
      { cwd: f.root, env: f.env },
    );
    expect(result.code, result.out).toBe(1);
    expect(JSON.parse(result.out).error).toContain("new.ts differs from the raw head blob");
    expect(readdirSync(f.cache)).toEqual([]);
    expect(git(f.root, "show", `${f.response.head.sha}:new.ts`)).toBe("export const fresh = 3;");
  });

  it("rejects non-GitHub and ambiguous inputs before fetching", async () => {
    const root = makeTempDir();
    for (const input of [
      "https://example.com/a/b/pull/1",
      "https://github.com/a/b/issues/1",
      "a/b#0",
      "a/b#1/extra",
    ]) {
      const result = await xplJson(root, "pr", "prepare", input);
      expect(result.code).toBe(2);
      expect(result.json.error).toContain("GitHub PR");
    }
  });

  it("prepares exact commits, head analysis and changed source without touching a dirty checkout", async () => {
    const f = fixture();
    writeFile(f.root, "app.ts", "staged work\n");
    git(f.root, "add", "app.ts");
    writeFile(f.root, "app.ts", "unstaged work\n");
    writeFile(f.root, "untracked.txt", "local work\n");
    const branch = git(f.root, "symbolic-ref", "HEAD");
    const refs = git(f.root, "show-ref");
    const index = readFileSync(join(f.root, ".git/index"));
    const status = git(f.root, "status", "--porcelain=v1");
    const result = await invoke(
      ["pr", "prepare", "team/project", "7", "--cache-dir", f.cache, "--json"],
      { cwd: f.root, env: f.env },
    );
    expect(result.code, result.err || result.out).toBe(0);
    const output = JSON.parse(result.out);
    const manifest = readJson(output.directory, "input.json");
    expect(manifest.kind).toBe("github-pr-input");
    expect(manifest.pr.base.sha).toBe(f.base);
    expect(manifest.pr.head.sha).toBe(f.head);
    expect(git(output.repository, "rev-parse", "HEAD")).toBe(f.head);
    expect(git(output.repository, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
    expect(
      manifest.change.files.map((file: { path: string; status: string }) => [
        file.path,
        file.status,
      ]),
    ).toEqual([
      ["app.ts", "modified"],
      ["gone.ts", "deleted"],
      ["new.ts", "added"],
      ["renamed.ts", "renamed"],
    ]);
    expect(
      manifest.sources.map((file: { before: unknown; after: unknown }) => [
        file.before,
        file.after,
      ]),
    ).toEqual([
      [
        { state: "text", text: "export function app() { return 1; }\n" },
        { state: "text", text: "export function app() { return 2; }\n" },
      ],
      [{ state: "text", text: "export const gone = 1;\n" }, { state: "absent" }],
      [{ state: "absent" }, { state: "text", text: "export const fresh = 3;\n" }],
      [
        { state: "text", text: "export function renamed() { return 'same'; }\n" },
        { state: "text", text: "export function renamed() { return 'same'; }\n" },
      ],
    ]);
    const savedIndex = readJson(output.directory, manifest.index.path);
    expect(savedIndex.commit).toBe(f.head);
    expect(savedIndex.languages.typescript.refs).toBe("heuristic");
    expect(
      manifest.analysis.symbols.find((s: { id: string }) => s.id === "sym:app.ts#app").callers[0]
        .resolution,
    ).toBe("heuristic");
    expect(readJson(f.tools, "args.json")).toEqual([
      "api",
      "--hostname",
      "github.com",
      "repos/team/project/pulls/7",
    ]);
    expect(git(f.root, "symbolic-ref", "HEAD")).toBe(branch);
    expect(git(f.root, "show-ref")).toBe(refs);
    expect(readFileSync(join(f.root, ".git/index"))).toEqual(index);
    expect(git(f.root, "status", "--porcelain=v1")).toBe(status);
    expect(readFileSync(join(f.root, "app.ts"), "utf8")).toBe("unstaged work\n");
    expect(readFileSync(join(f.root, "untracked.txt"), "utf8")).toBe("local work\n");
    expect(readdirSync(output.repository).filter((name) => name === "input.json")).toEqual([]);
  });

  it("refuses index output through a PR-supplied symlink and removes failed staging", async () => {
    const f = fixture();
    const victim = writeFile(f.tools, "victim", "keep this file\n");
    mkdirSync(join(f.root, ".explainer"));
    symlinkSync(victim, join(f.root, ".explainer/.gitignore"));
    git(f.root, "add", ".explainer/.gitignore");
    git(f.root, "commit", "-qm", "unsafe index output");
    f.response.head.sha = git(f.root, "rev-parse", "HEAD");
    writeFile(f.tools, "response.json", JSON.stringify(f.response));
    const result = await invoke(
      ["pr", "prepare", "team/project#7", "--cache-dir", f.cache, "--json"],
      { cwd: f.root, env: f.env },
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out).error).toContain("symlink");
    expect(readFileSync(victim, "utf8")).toBe("keep this file\n");
    expect(readdirSync(f.cache)).toEqual([]);
  });

  it("rejects misbound API identities and reports unavailable gh access without staging", async () => {
    const f = fixture();
    for (const response of [
      { ...f.response, number: 8 },
      { ...f.response, base: { ...f.response.base, repo: { full_name: "other/project" } } },
      { ...f.response, head: { ...f.response.head, sha: "1234567" } },
    ]) {
      writeFile(f.tools, "response.json", JSON.stringify(response));
      const result = await invoke(
        [
          "pr",
          "prepare",
          "https://github.com/team/project/pull/7",
          "--cache-dir",
          f.cache,
          "--json",
        ],
        { cwd: f.root, env: f.env },
      );
      expect(result.code).toBe(1);
      expect(JSON.parse(result.out).error).toContain("GitHub PR response");
      expect(readdirSync(f.cache)).toEqual([]);
    }
    writeFile(
      f.tools,
      "gh",
      `#!${process.execPath}\nprocess.stderr.write('repository access denied'); process.exit(1);\n`,
    );
    const denied = await invoke(
      ["pr", "prepare", "team/project#7", "--cache-dir", f.cache, "--json"],
      { cwd: f.root, env: f.env },
    );
    expect(denied.code).toBe(1);
    expect(JSON.parse(denied.out).error).toContain("Check existing gh access");
    expect(JSON.parse(denied.out).error).toContain("repository access denied");
    expect(readdirSync(f.cache)).toEqual([]);
  });

  it("fetches an inaccessible fork via its PR ref, but refuses a ref that moved past the resolved head", async () => {
    const f = fixture();
    git(f.root, "update-ref", "refs/pull/7/head", f.head);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const wrapper = writeFile(
      f.tools,
      "git",
      `#!${process.execPath}\nconst args = process.argv.slice(2);\nif (args.includes('fetch') && args.at(-1) === process.env.DENIED_HEAD) { process.stderr.write('simulated inaccessible fork SHA'); process.exit(1); }\nconst r = require('node:child_process').spawnSync(${JSON.stringify(realGit)}, args, { env: process.env, stdio: 'inherit' }); process.exit(r.status ?? 1);\n`,
    );
    chmodSync(wrapper, 0o755);
    const response = { ...f.response, head: { ...f.response.head, repo: null } };
    writeFile(f.tools, "response.json", JSON.stringify(response));
    const env = { ...f.env, DENIED_HEAD: f.head };
    const good = await invoke(
      ["pr", "prepare", "team/project#7", "--cache-dir", f.cache, "--json"],
      { cwd: f.root, env },
    );
    expect(good.code, good.out).toBe(0);
    expect(readJson(JSON.parse(good.out).directory, "input.json").pr.head.repository).toBeNull();
    expect(git(JSON.parse(good.out).repository, "rev-parse", "HEAD")).toBe(f.head);
    const retained = readdirSync(f.cache);
    // The only advertised PR ref now names the base; the old resolved head cannot be fetched.
    git(f.root, "update-ref", "refs/pull/7/head", f.base);
    const bad = await invoke(
      ["pr", "prepare", "team/project#7", "--cache-dir", f.cache, "--json"],
      { cwd: f.root, env },
    );
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.out).error).toContain(`cannot fetch exact head ${f.head}`);
    expect(JSON.parse(bad.out).error).toContain("Owned input removed; no ready output was written");
    expect(readdirSync(f.cache)).toEqual(retained);
  });

  it("retains immutable old inputs when a new head is prepared and cleans only owned storage", async () => {
    const f = fixture();
    const prepare = () =>
      invoke(["pr", "prepare", "team/project#7", "--cache-dir", f.cache, "--json"], {
        cwd: f.root,
        env: f.env,
      });
    const first = await prepare();
    expect(first.code, first.out).toBe(0);
    const old = JSON.parse(first.out);
    const original = readFileSync(old.manifestPath);
    const manifest = JSON.parse(original.toString());
    expect(statSync(old.manifestPath).mode & 0o222).toBe(0);
    expect(manifest.index.sha256).toBe(
      createHash("sha256")
        .update(readFileSync(join(old.directory, manifest.index.path)))
        .digest("hex"),
    );
    writeFile(f.root, "app.ts", "export function app() { return 4; }\n");
    git(f.root, "add", ".");
    git(f.root, "commit", "-qm", "new head");
    const newHead = git(f.root, "rev-parse", "HEAD");
    f.response.head.sha = newHead;
    writeFile(f.tools, "response.json", JSON.stringify(f.response));
    const second = await prepare();
    expect(second.code, second.out).toBe(0);
    const next = JSON.parse(second.out);
    expect(next.directory).not.toBe(old.directory);
    expect(readJson(next.directory, "input.json").pr.head.sha).toBe(newHead);
    expect(readFileSync(old.manifestPath)).toEqual(original);
    const unowned = join(f.cache, "input-unowned");
    mkdirSync(unowned);
    writeFile(unowned, "keep.txt", "keep\n");
    const refused = await invoke(["pr", "cleanup", unowned, "--cache-dir", f.cache, "--json"], {
      cwd: f.root,
    });
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.out).error).toContain("ownership marker");
    expect(readFileSync(join(unowned, "keep.txt"), "utf8")).toBe("keep\n");
    const alias = join(f.cache, "input-alias");
    symlinkSync(old.directory, alias);
    const symlink = await invoke(["pr", "cleanup", alias, "--cache-dir", f.cache, "--json"], {
      cwd: f.root,
    });
    expect(symlink.code).toBe(1);
    expect(JSON.parse(symlink.out).error).toContain("symlinks are refused");
    const cleaned = await invoke(
      ["pr", "cleanup", old.directory, "--cache-dir", f.cache, "--json"],
      { cwd: f.root },
    );
    expect(cleaned.code, cleaned.out).toBe(0);
    expect(readdirSync(f.cache).sort()).toEqual(
      ["input-alias", "input-unowned", next.directory.split("/").at(-1)].sort(),
    );
    expect(readJson(next.directory, "input.json").pr.head.sha).toBe(newHead);
  });

  it("rejects storage inside the developer tree, including symlink aliases from outside it", async () => {
    const f = fixture();
    symlinkSync(f.root, join(f.tools, "alias"));
    for (const cache of [join(f.root, "owned"), join(f.tools, "alias", "owned")]) {
      const result = await invoke(
        ["pr", "prepare", "team/project#7", "--cache-dir", cache, "--json"],
        { cwd: f.root, env: f.env },
      );
      expect(result.code).toBe(1);
      expect(JSON.parse(result.out).error).toContain("inside the developer checkout");
    }
    expect(git(f.root, "status", "--porcelain=v1")).toBe("");
    expect(readdirSync(f.tools).sort()).toEqual(["alias", "gh", "gitconfig", "response.json"]);
  });

  it("removes failed base fetch and required-index staging, with no input manifest published", async () => {
    const f = fixture();
    writeFile(
      f.tools,
      "response.json",
      JSON.stringify({ ...f.response, base: { ...f.response.base, sha: "a".repeat(40) } }),
    );
    const baseFailure = await invoke(
      ["pr", "prepare", "team/project#7", "--cache-dir", f.cache, "--json"],
      { cwd: f.root, env: f.env },
    );
    expect(baseFailure.code).toBe(1);
    expect(JSON.parse(baseFailure.out).error).toContain("fetch");
    expect(readdirSync(f.cache)).toEqual([]);
    for (const name of ["app.ts", "caller.ts", "new.ts", "renamed.ts"]) rmSync(join(f.root, name));
    writeFile(f.root, "main.rs", "fn main() {}\n");
    git(f.root, "add", ".");
    git(f.root, "commit", "-qm", "Rust-only head");
    f.response.head.sha = git(f.root, "rev-parse", "HEAD");
    writeFile(f.tools, "response.json", JSON.stringify(f.response));
    const indexFailure = await invoke(
      ["pr", "prepare", "team/project#7", "--cache-dir", f.cache, "--precise", "require", "--json"],
      { cwd: f.root, env: f.env },
    );
    expect(indexFailure.code).toBe(1);
    expect(JSON.parse(indexFailure.out).error).toContain("rust");
    expect(JSON.parse(indexFailure.out).error).toContain("no ready output was written");
    expect(readdirSync(f.cache)).toEqual([]);
  });
});
