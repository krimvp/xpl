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
 * "Clean" ignores `.explainer/`: writing the index (and `.explainer/.gitignore`, and the explainers
 * themselves) must not turn a clean tree into a dirty one, or the id would change every time `xpl index`
 * runs.
 */
import { createHash } from "node:crypto";
import type { GitInfo, GitOptions } from "./files.js";
import { runGit } from "./files.js";

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

/** True when nothing but `.explainer/` differs from HEAD (no modified, staged or untracked files). */
export async function isWorkTreeClean(cwd: string, options?: GitOptions): Promise<boolean> {
  const out = await runGit(
    cwd,
    ["status", "--porcelain=v1", "--ignore-submodules=all", "--", ".", ":(exclude).explainer"],
    options,
  );
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
