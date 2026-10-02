/**
 * Git for `xpl change` and base anchors: resolving revisions to full SHAs, the files and hunks of a diff between two
 * commits (`git diff --name-status -M` and `git diff -U0`), and reading a file at a commit (`git show <sha>:<path>`).
 * Every path is relative to the xpl root (`--relative`, `./<path>`), so a root below the git top level works.
 * Read-only: never writes to the repository.
 */
import { execFile, execFileSync } from "node:child_process";
import type { ChangedFile, ChangeHunk, ChangeRecord } from "@xpl/core";
import { CliError } from "./errors.js";

const MAX_BUFFER = 512 * 1024 * 1024;

/** Never write git's index lock just to answer a read-only question; never ask for credentials. */
function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
}

/** Runs git in `cwd`: stdout, or a `CliError` with git's own message. */
function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      { cwd, maxBuffer: MAX_BUFFER, encoding: "utf8", env: gitEnv() },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        const message = String(stderr ?? "").trim() || error.message;
        reject(new CliError(`git ${args[0] ?? ""} failed: ${message.split("\n")[0]}`));
      },
    );
  });
}

/** True when `root` is inside a git work tree. */
export async function isGitWorkTree(root: string): Promise<boolean> {
  try {
    return (await runGit(root, ["rev-parse", "--is-inside-work-tree"])).trim() === "true";
  } catch {
    return false;
  }
}

/** A full commit SHA (SHA-1 or SHA-256). */
export const FULL_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** The full SHA of a revision (`main`, `HEAD~2`, `2284ff0^`), or undefined when it names no commit. */
export async function resolveCommit(root: string, rev: string): Promise<string | undefined> {
  if (rev === "" || rev.startsWith("-")) return undefined;
  try {
    const out = (
      await runGit(root, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`])
    ).trim();
    return FULL_SHA.test(out) ? out : undefined;
  } catch {
    return undefined;
  }
}

/** The best common ancestor of two commits (`git merge-base`), for a `<a>...<b>` range. */
export async function mergeBase(root: string, a: string, b: string): Promise<string | undefined> {
  try {
    const out = (await runGit(root, ["merge-base", a, b])).trim();
    return FULL_SHA.test(out) ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Text of `path` (relative to `root`) at `commit`, or undefined when it cannot be read (no git, no such file at that
 * commit). Synchronous, because anchors resolve synchronously; `TextCache` memoises it. Only full SHAs are accepted:
 * the commit comes from an explainer file, and anything else could be read by git as an option.
 */
export function gitShowReader(root: string): (commit: string, path: string) => string | undefined {
  return (commit, path) => {
    if (!FULL_SHA.test(commit)) return undefined;
    if (
      path === "" ||
      path.includes("\0") ||
      path.startsWith("/") ||
      path.split("/").includes("..")
    ) {
      return undefined;
    }
    try {
      return execFileSync("git", ["show", `${commit}:./${path}`], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER,
        stdio: ["ignore", "pipe", "ignore"],
        env: gitEnv(),
      });
    } catch {
      return undefined;
    }
  };
}

// ─── Diffs ──────────────────────────────────────────────────────────────────────────────────────

/** Options every diff here uses: renames found, plain output whatever the user's git config says. */
const DIFF_OPTIONS = [
  "-c",
  "core.quotepath=off",
  "diff",
  "-M",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--relative",
];

/** One entry of `git diff --name-status -z`: status letter and paths. */
interface NameStatus {
  status: ChangedFile["status"];
  path: string;
  oldPath?: string;
}

/** Parses `git diff --name-status -z` output: `M\0path\0`, `R087\0old\0new\0`, ... */
export function parseNameStatus(out: string): NameStatus[] {
  const parts = out.split("\0");
  const entries: NameStatus[] = [];
  for (let i = 0; i < parts.length;) {
    const code = parts[i++] ?? "";
    if (code === "") continue;
    const letter = code[0];
    if (letter === "R" || letter === "C") {
      const oldPath = parts[i++] ?? "";
      const path = parts[i++] ?? "";
      // a copy leaves its source in place: for the change it is a new file
      entries.push(
        letter === "R" ? { status: "renamed", path, oldPath } : { status: "added", path },
      );
      continue;
    }
    const path = parts[i++] ?? "";
    const status: ChangedFile["status"] =
      letter === "A" ? "added" : letter === "D" ? "deleted" : "modified";
    entries.push({ status, path });
  }
  return entries;
}

/** A C-style quoted path from a diff header (`"a/sp\303\251cial"`), unquoted; unquoted paths pass through. */
export function unquotePath(text: string): string {
  if (!text.startsWith('"') || !text.endsWith('"') || text.length < 2) return text;
  const body = text.slice(1, -1);
  const bytes: number[] = [];
  const escapes: Record<string, number> = { n: 10, t: 9, r: 13, b: 8, f: 12, v: 11, a: 7 };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const next = body[i + 1] ?? "";
    if (/[0-7]/.test(next)) {
      const octal = body.slice(i + 1, i + 4);
      bytes.push(parseInt(octal, 8));
      i += octal.length;
    } else {
      bytes.push(escapes[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** One file of a `git diff -U0` patch: the paths its headers name, and its hunks. */
interface PatchSection {
  oldPath?: string;
  newPath?: string;
  hunks: ChangeHunk[];
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parses the output of `git diff -U0 --src-prefix=a/ --dst-prefix=b/` into one section per file, in order. */
export function parsePatch(out: string): PatchSection[] {
  const sections: PatchSection[] = [];
  let current: PatchSection | undefined;
  let inHunks = false;
  const strip = (raw: string, prefix: string): string | undefined => {
    const path = unquotePath(raw.trim());
    if (path === "/dev/null") return undefined;
    return path.startsWith(prefix) ? path.slice(prefix.length) : path;
  };
  for (const line of out.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = { hunks: [] };
      sections.push(current);
      inHunks = false;
      continue;
    }
    if (!current) continue;
    const hunk = HUNK.exec(line);
    if (hunk) {
      inHunks = true;
      current.hunks.push({
        oldStart: Number(hunk[1]),
        oldLines: hunk[2] === undefined ? 1 : Number(hunk[2]),
        newStart: Number(hunk[3]),
        newLines: hunk[4] === undefined ? 1 : Number(hunk[4]),
      });
      continue;
    }
    if (inHunks) continue; // content lines; a removed "-- x" line reads "--- x" and is not a header
    if (line.startsWith("--- ")) {
      const path = strip(line.slice(4), "a/");
      if (path !== undefined) current.oldPath = path;
    } else if (line.startsWith("+++ ")) {
      const path = strip(line.slice(4), "b/");
      if (path !== undefined) current.newPath = path;
    } else if (line.startsWith("rename from ")) {
      current.oldPath = unquotePath(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) {
      current.newPath = unquotePath(line.slice("rename to ".length));
    }
  }
  return sections;
}

/** Joins the name-status entries with the hunks of their patch sections (by path, else by position). */
export function joinDiff(
  entries: readonly NameStatus[],
  sections: readonly PatchSection[],
): ChangedFile[] {
  const used = new Set<number>();
  const matches = (section: PatchSection, entry: NameStatus): boolean =>
    entry.status === "deleted"
      ? section.oldPath === entry.path
      : section.newPath === entry.path ||
        (section.newPath === undefined && section.oldPath === (entry.oldPath ?? entry.path));
  return entries.map((entry, i) => {
    let at = sections.findIndex((section, j) => !used.has(j) && matches(section, entry));
    if (at === -1) {
      // a binary file or a mode change has no path headers: the sections come in the same order as the entries
      const same = sections[i];
      if (same && !used.has(i) && same.newPath === undefined && same.oldPath === undefined) at = i;
    }
    if (at !== -1) used.add(at);
    const hunks = at === -1 ? [] : sections[at]!.hunks;
    return {
      path: entry.path,
      status: entry.status,
      ...(entry.oldPath !== undefined ? { oldPath: entry.oldPath } : {}),
      hunks: hunks.map((h) => ({ ...h })),
    };
  });
}

/** The change between two commits (full SHAs), as `Explainer.change` stores it. */
export async function computeChange(
  root: string,
  base: string,
  head: string,
): Promise<ChangeRecord> {
  const [names, patch] = await Promise.all([
    runGit(root, [...DIFF_OPTIONS, "--name-status", "-z", base, head]),
    runGit(root, [...DIFF_OPTIONS, "-U0", "--src-prefix=a/", "--dst-prefix=b/", base, head]),
  ]);
  return { base, head, files: joinDiff(parseNameStatus(names), parsePatch(patch)) };
}
