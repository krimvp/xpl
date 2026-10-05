/**
 * Commit id of an index (ARCHITECTURE.md §3, "Commit id").
 *
 * 1. An explicit `--commit` wins.
 * 2. Otherwise, if the indexed root is the git top-level and the work tree is clean: the first 7 characters
 *    of HEAD.
 * 3. Otherwise `wt-` + the first 10 hex characters of sha256 over the sorted `path\0hash\n` lines of the
 *    indexed files (`hash` = `IndexedFile.hash`). Deterministic, so fixtures living inside a bigger
 *    repository get a stable id.
 *
 * "Clean" uses discovery's path/content filters. Writing generated indexes, guides, patches or exports
 * must not turn a clean tree dirty, or the next watch poll would rebuild solely for its own output.
 */
import { createHash } from "node:crypto";
import type { GitInfo, GitOptions } from "./files.js";
import { join } from "node:path";
import { lstat } from "node:fs/promises";
import { runGit, isIndexInputPath, isIndexInputFile } from "./files.js";

/** Characters a commit id may contain: it becomes part of a file name (`index-<commit>.json`). */
const COMMIT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function validateCommitId(commit: string): string {
  if (!COMMIT_ID.test(commit)) {
    throw new Error(
      `invalid commit id "${commit}": use letters, digits, ".", "_" and "-" only (it is part of the index file name)`,
    );
  }
  return commit;
}

/** `wt-` + first 10 hex of sha256 over the sorted `path\0hash\n` list. */
export function workingTreeId(files: readonly { path: string; hash: string }[]): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hash = createHash("sha256");
  for (const file of sorted) hash.update(`${file.path}\0${file.hash}\n`);
  return "wt-" + hash.digest("hex").slice(0, 10);
}

/** Short (7 char) HEAD of the work tree at `cwd`, or undefined (no git, no commits). */
export async function shortHead(cwd: string, options?: GitOptions): Promise<string | undefined> {
  const out = await runGit(cwd, ["rev-parse", "HEAD"], options);
  const head = out?.trim();
  return head && /^[0-9a-f]{7,}$/i.test(head) ? head.slice(0, 7).toLowerCase() : undefined;
}

/** Poll-owned eligibility cache: reuse content filters until a file's metadata changes. */
export type StatusFileCache = Map<string, { version: string; eligible: boolean | undefined }>;

async function statusInput(path: string, cache?: StatusFileCache): Promise<boolean | undefined> {
  if (!cache) return isIndexInputFile(path);
  let version = "missing";
  try {
    const s = await lstat(path, { bigint: true });
    version = `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const previous = cache.get(path);
  if (previous?.version === version) return previous.eligible;
  const eligible = await isIndexInputFile(path);
  cache.set(path, { version, eligible });
  return eligible;
}

/** The exact discovery/staging cleanliness input used by resolveCommitId. */
export async function workTreeStatus(
  cwd: string,
  options?: GitOptions,
  cache?: StatusFileCache,
): Promise<string | undefined> {
  const output = await runGit(
    cwd,
    [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=all",
      "--",
      ".",
      ":(exclude).explainer",
    ],
    options,
  );
  if (output === undefined) return undefined;
  const records = output.split("\0");
  const kept: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (!record) continue;
    const paths = [record.slice(3)];
    // In -z output a rename/copy's destination precedes its original path.
    if (/[RC]/.test(record.slice(0, 2))) paths.push(records[++i]!);
    for (const path of paths) {
      if (isIndexInputPath(path) && (await statusInput(join(cwd, path), cache)) !== false) {
        kept.push(record, ...paths.slice(1));
        break;
      }
    }
  }
  return kept.join("\0");
}

/** True when no discovery-eligible files differ from HEAD (no modified, staged or untracked files). */
export async function isWorkTreeClean(cwd: string, options?: GitOptions): Promise<boolean> {
  const out = await workTreeStatus(cwd, options);
  return out !== undefined && out.trim() === "";
}

export interface CommitIdOptions {
  /** Explicit id (`--commit`). */
  commit?: string;
  /** Result of `detectGit(root)` (undefined: not in a work tree). */
  git?: GitInfo | undefined;
  /** The indexed files, for the working-tree hash. */
  files: readonly { path: string; hash: string }[];
  /** Root directory of the index. */
  root: string;
  gitOptions?: GitOptions;
}

export async function resolveCommitId(options: CommitIdOptions): Promise<string> {
  if (options.commit !== undefined && options.commit !== "")
    return validateCommitId(options.commit);
  const git = options.git;
  if (git?.atToplevel && (await isWorkTreeClean(options.root, options.gitOptions))) {
    const head = await shortHead(options.root, options.gitOptions);
    if (head) return head;
  }
  return workingTreeId(options.files);
}
