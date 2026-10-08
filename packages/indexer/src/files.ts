/**
 * File discovery (ARCHITECTURE.md §3, "Files").
 *
 * `git ls-files --cached --others --exclude-standard` when the root is inside a git work tree (restricted
 * to the root's subtree, paths made root-relative), otherwise a directory walk that skips well-known build
 * and dependency directories and dot-directories. Binary files, files over 1 MB and lockfiles are dropped.
 * Everything else is a file of the index; unknown extensions are language "text".
 *
 * Deliberate refinements of §3, all in the direction of "never index generated or foreign content":
 * `.explainer/` is excluded in git mode too (it holds our own index and explainers, which would otherwise
 * feed back into the working-tree commit id); `node_modules` is excluded in git mode (an untracked,
 * un-ignored one would swamp the index); `pnpm-lock.yaml` and `npm-shrinkwrap.json` count as lockfiles.
 */
import { execFile } from "node:child_process";
import { open, lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { FileLanguage, FilePath } from "@xpl/core";

/** Files larger than this are not indexed. */
export const MAX_FILE_BYTES = 1024 * 1024;
/** How much of a file is inspected for NUL bytes. */
export const BINARY_SNIFF_BYTES = 8192;

/** Directory names the non-git walk never enters (dot-directories are skipped as well). */
export const WALK_SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "vendor",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  ".explainer",
]);

/** Every value `IndexedFile.language` can take. */
export const FILE_LANGUAGES: readonly FileLanguage[] = [
  "typescript",
  "tsx",
  "javascript",
  "python",
  "go",
  "java",
  "rust",
  "yaml",
  "json",
  "toml",
  "text",
];

const EXTENSION_LANGUAGE: Readonly<Record<string, FileLanguage>> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".java": "java",
  ".rs": "rust",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".json": "json",
  ".toml": "toml",
};

/** Language of a file by extension (case-insensitive); anything unknown is "text". */
export function languageForPath(path: string): FileLanguage {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "text";
  return EXTENSION_LANGUAGE[base.slice(dot).toLowerCase()] ?? "text";
}

/** `*-lock.json`, `*.lock`, `go.sum` (+ `pnpm-lock.yaml`, `npm-shrinkwrap.json`). */
export function isLockfile(path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return (
    base.endsWith("-lock.json") ||
    base.endsWith(".lock") ||
    base === "go.sum" ||
    base === "pnpm-lock.yaml" ||
    base === "npm-shrinkwrap.json"
  );
}

/** Where `root` sits inside a git work tree. */
export interface GitInfo {
  /** Real path of the work tree's top-level directory. */
  toplevel: string;
  /** Real path of the indexed root. */
  root: string;
  /** True when the root is the top-level directory itself. */
  atToplevel: boolean;
}

/** Optional process context for git reads in a caller-owned repository. Defaults retain normal git discovery. */
export interface GitOptions {
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  /** Global git arguments, before the subcommand (for example --git-dir and --work-tree). */
  args?: readonly string[];
}

/** Run git in `cwd`; resolves to stdout, or undefined when git fails or is not installed. */
export function runGit(
  cwd: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      [...(options.args ?? []), ...args],
      {
        cwd,
        signal: options.signal,
        maxBuffer: 512 * 1024 * 1024,
        encoding: "utf8",
        // Never write the index lock just to answer a read-only question.
        env: { ...(options.env ?? process.env), GIT_OPTIONAL_LOCKS: "0" },
      },
      (error, stdout) => resolve(error ? undefined : stdout),
    );
  });
}

/** Detect whether `root` is inside a git work tree. */
export async function detectGit(root: string, options?: GitOptions): Promise<GitInfo | undefined> {
  const out = await runGit(
    root,
    ["rev-parse", "--is-inside-work-tree", "--show-toplevel"],
    options,
  );
  if (out === undefined) return undefined;
  const [inside, toplevel] = out.split("\n");
  if (inside?.trim() !== "true" || !toplevel) return undefined;
  try {
    const [realTop, realRoot] = await Promise.all([realpath(toplevel.trim()), realpath(root)]);
    return { toplevel: realTop, root: realRoot, atToplevel: realTop === realRoot };
  } catch {
    return undefined;
  }
}

/** A file that passed every filter. `abs` is where to read it. */
export interface DiscoveredFile {
  /** Root-relative POSIX path. */
  path: FilePath;
  abs: string;
  language: FileLanguage;
}

export interface DiscoverOptions {
  signal?: AbortSignal;
  /** False returns path candidates without reading/filtering content, for metadata polling. */
  content?: boolean;
  /** Only files of these languages are returned. */
  languages?: readonly FileLanguage[];
  /** Result of `detectGit(root)`; detected when omitted. */
  git?: GitInfo | undefined;
  gitOptions?: GitOptions;
}

export interface Discovery {
  files: DiscoveredFile[];
  /** True when the file list came from git. */
  usedGit: boolean;
  warnings: string[];
  exclusions: ExclusionReport;
}

export type ExclusionReason =
  "generated" | "dependency" | "lockfile" | "oversized" | "binary" | "non-file" | "unreadable";

/** Only enumerated candidates are counted; ignored files and skipped walk directories are unseen. */
export interface ExclusionReport {
  scope: "git candidates" | "walked files" | "snapshot unavailable";
  reasons: { reason: ExclusionReason; count: number; examples: string[] }[];
}

const EXCLUSION_REASONS: readonly ExclusionReason[] = [
  "generated",
  "dependency",
  "lockfile",
  "oversized",
  "binary",
  "non-file",
  "unreadable",
];

/** Paths git lists for `root` (tracked + untracked, minus ignored), relative to `root`. */
async function gitPaths(root: string, options?: GitOptions): Promise<string[] | undefined> {
  const out = await runGit(
    root,
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    options,
  );
  if (out === undefined) return undefined;
  return out.split("\0").filter((p) => p !== "");
}

/** Every file below `root`, root-relative, skipping `WALK_SKIP_DIRS` and dot-directories. */
async function walkPaths(
  root: string,
  warnings: string[],
  signal?: AbortSignal,
): Promise<string[]> {
  const out: string[] = [];
  async function visit(dirAbs: string, dirRel: string): Promise<void> {
    signal?.throwIfAborted();
    let entries;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch (error) {
      warnings.push(`cannot read directory ${dirRel || "."}: ${(error as Error).message}`);
      return;
    }
    for (const entry of entries) {
      signal?.throwIfAborted();
      const rel = dirRel === "" ? entry.name : `${dirRel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (WALK_SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        await visit(join(dirAbs, entry.name), rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  }
  await visit(root, "");
  return out;
}

/** Shared discovery and cleanliness exclusions; generated output cannot dirty an index. */
export function isIndexInputPath(path: string): boolean {
  return pathExclusion(path) === undefined;
}

function pathExclusion(path: string): ExclusionReason | undefined {
  const segments = path.split("/");
  if (segments.includes(".explainer")) return "generated";
  if (path.endsWith("/") || segments.includes("node_modules") || segments.includes(".git"))
    return "dependency";
  if (isLockfile(path)) return "lockfile";
  if (/\.(?:explainer|patch)\.json$/i.test(path)) return "generated";
  return undefined;
}

/** Content eligibility shared with Git cleanliness. Undefined retains unreadable/deleted changes. */
export async function isIndexInputFile(abs: string): Promise<boolean | undefined> {
  const reason = await contentExclusion(abs);
  return reason === undefined ? true : reason === "unreadable" ? undefined : false;
}

async function contentExclusion(abs: string): Promise<ExclusionReason | undefined> {
  const reason = await contentFilterExclusion(abs);
  if (reason || !/\.html?$/i.test(abs)) return reason;
  try {
    const text = await readFile(abs, "utf8");
    return text.includes(
      '<script id="xpl-data" type="application/json">{"schema":"code-explainer/bundle@0"',
    )
      ? "generated"
      : undefined;
  } catch {
    return "unreadable";
  }
}

/** Is `path` (relative to `root`) a text file within the limits? Cheap checks first, then a NUL sniff. */
async function contentFilterExclusion(abs: string): Promise<ExclusionReason | undefined> {
  let info;
  try {
    info = await lstat(abs);
  } catch {
    return "unreadable"; // deleted since git listed it, or unreadable
  }
  if (!info.isFile()) return "non-file";
  if (info.size > MAX_FILE_BYTES) return "oversized";
  if (info.size === 0) return undefined;
  let handle;
  try {
    handle = await open(abs, "r");
    const buffer = Buffer.alloc(Math.min(BINARY_SNIFF_BYTES, info.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0) ? "binary" : undefined;
  } catch {
    return "unreadable";
  } finally {
    await handle?.close();
  }
}

/**
 * The files of the index for `root`, sorted by path. Deleted-but-still-tracked files, directories
 * (submodules), symlinks, binaries, oversize files and lockfiles are excluded and reported.
 */
export async function discoverFiles(
  root: string,
  options: DiscoverOptions = {},
): Promise<Discovery> {
  options.signal?.throwIfAborted();
  const warnings: string[] = [];
  const git = "git" in options ? options.git : await detectGit(root, options.gitOptions);
  let candidates: string[] | undefined;
  if (git) candidates = await gitPaths(root, options.gitOptions);
  const usedGit = candidates !== undefined;
  options.signal?.throwIfAborted();
  candidates ??= await walkPaths(root, warnings, options.signal);
  const excluded = new Map<ExclusionReason, { count: number; examples: string[] }>();
  function record(reason: ExclusionReason, path: string): void {
    const entry = excluded.get(reason) ?? { count: 0, examples: [] };
    entry.count++;
    if (entry.examples.length < 3) entry.examples.push(path);
    excluded.set(reason, entry);
  }
  const exclusions = (): ExclusionReport => ({
    scope: usedGit ? "git candidates" : "walked files",
    reasons: EXCLUSION_REASONS.flatMap((reason) => {
      const entry = excluded.get(reason);
      return entry ? [{ reason, count: entry.count, examples: entry.examples }] : [];
    }),
  });

  const wanted = options.languages ? new Set<FileLanguage>(options.languages) : undefined;
  const selected: DiscoveredFile[] = [];
  for (const path of [...new Set(candidates)].sort()) {
    const language = languageForPath(path);
    if (wanted && !wanted.has(language)) continue;
    const reason = pathExclusion(path);
    if (reason) {
      record(reason, path);
      continue;
    }
    selected.push({ path, abs: join(root, ...path.split("/")), language });
  }

  if (options.content === false) {
    selected.sort((a, b) => a.path.localeCompare(b.path));
    return {
      files: selected.filter((f, i) => i === 0 || f.path !== selected[i - 1]!.path),
      usedGit,
      warnings,
      exclusions: exclusions(),
    };
  }

  // Content filters (stat + NUL sniff), a bounded number of files at a time.
  const kept: DiscoveredFile[] = [];
  const BATCH = 64;
  for (let i = 0; i < selected.length; i += BATCH) {
    options.signal?.throwIfAborted();
    const batch = selected.slice(i, i + BATCH);
    const verdicts = await Promise.all(
      batch.map(async (f) => {
        return await contentExclusion(f.abs);
      }),
    );
    batch.forEach((file, j) => {
      const reason = verdicts[j];
      if (reason) record(reason, file.path);
      else kept.push(file);
    });
  }
  kept.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // git can list the same path twice (merge conflicts); keep one.
  const files = kept.filter((f, i) => i === 0 || f.path !== kept[i - 1]!.path);
  return { files, usedGit, warnings, exclusions: exclusions() };
}

/** Read a discovered file as UTF-8 text (a leading BOM is kept: columns must match the file on disk). */
export async function readSource(file: DiscoveredFile): Promise<string> {
  return (await readFile(file.abs)).toString("utf8");
}
