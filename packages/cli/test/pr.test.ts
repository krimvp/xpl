import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { git, invoke, makeTempDir, readJson, writeFile, xplJson } from "./helpers.js";

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

describe("PR input", () => {
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
