/**
 * The name an explainer gives the repository (`Explainer.repo.name`, the label of the repo node) when
 * `xpl new` is not told with `--repo`. In this order:
 *
 *   1. `name` in package.json
 *   2. the last element of the module path in go.mod (`example.com/jobrunner/v2` -> `jobrunner`)
 *   3. `name` under `[project]` in pyproject.toml
 *   4. the base name of the git remote (`origin`, else the first one), without `.git`
 *   5. the name of the directory
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

export interface RepoName {
  name: string;
  /** Where it came from: `package.json`, `go.mod`, `pyproject.toml`, `git remote origin`, `directory name`. */
  source: string;
}

function read(root: string, file: string): string | undefined {
  try {
    return readFileSync(join(root, file), "utf8");
  } catch {
    return undefined;
  }
}

/** `name` of a package.json, when it has a non-empty one. */
function fromPackageJson(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  try {
    const data: unknown = JSON.parse(text);
    const name =
      typeof data === "object" && data !== null ? (data as { name?: unknown }).name : undefined;
    return typeof name === "string" && name.trim() !== "" ? name.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Last element of the `module` path of a go.mod, skipping a major-version suffix (`/v2`). */
function fromGoMod(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*module\s+(?:"([^"]+)"|`([^`]+)`|(\S+))/.exec(line);
    if (!match) continue;
    const path = (match[1] ?? match[2] ?? match[3] ?? "").replace(/\/+$/, "");
    const parts = path.split("/").filter((part) => part !== "");
    const last = parts[parts.length - 1];
    if (last !== undefined && /^v\d+$/.test(last) && parts.length > 1)
      return parts[parts.length - 2];
    return last;
  }
  return undefined;
}

/** `name = "..."` in the `[project]` table of a pyproject.toml (a small reader: no other TOML is needed). */
function fromPyproject(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  let table = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[\s*([^\]]+?)\s*\]\s*(?:#.*)?$/.exec(line);
    if (header) {
      table = header[1]!;
      continue;
    }
    if (table !== "project") continue;
    const name = /^name\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(line);
    if (name) {
      const value = (name[1] ?? name[2] ?? "").trim();
      return value === "" ? undefined : value;
    }
  }
  return undefined;
}

function git(root: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        cwd: root,
        encoding: "utf8",
        timeout: 5000,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      },
      (error, stdout) => resolve(error ? undefined : stdout.trim()),
    );
  });
}

/** `https://host/acme/widget.git`, `git@host:acme/widget.git`, `/srv/git/widget/` -> `widget`. */
export function remoteBaseName(url: string): string | undefined {
  const cleaned = url
    .trim()
    .replace(/[/\\]+$/, "")
    .replace(/\.git$/, "");
  const last = cleaned.split(/[/:\\]/).pop();
  return last === undefined || last === "" ? undefined : last;
}

async function fromGitRemote(root: string): Promise<string | undefined> {
  let url = await git(root, ["remote", "get-url", "origin"]);
  if (!url) {
    const first = (await git(root, ["remote"]))?.split(/\s+/)[0];
    if (first) url = await git(root, ["remote", "get-url", first]);
  }
  return url ? remoteBaseName(url) : undefined;
}

/** The repository name for `root` (see the file header for the order of the sources). */
export async function detectRepoName(root: string): Promise<RepoName> {
  const fromFiles: [string, string | undefined][] = [
    ["package.json", fromPackageJson(read(root, "package.json"))],
    ["go.mod", fromGoMod(read(root, "go.mod"))],
    ["pyproject.toml", fromPyproject(read(root, "pyproject.toml"))],
  ];
  for (const [source, name] of fromFiles) if (name) return { name, source };
  const remote = await fromGitRemote(root);
  if (remote) return { name: remote, source: "git remote" };
  return { name: basename(root) || "repo", source: "directory name" };
}
