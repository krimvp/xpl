/**
 * The repository a command works on: which symbol index to use (ARCHITECTURE.md §5, "Index
 * selection"), whether it is still current, the working-tree text `getText` reads, and explainer files.
 *
 * Index selection, in order:
 *   1. `--index <path>` (relative to the working directory, else to the root);
 *   2. for explainer commands: the explainer's own `index.path`, when that file exists (`xpl resolve`
 *      skips this step: it exists to move an explainer to a newer index);
 *   3. the index named after the current commit id (`index-<commit>.json`), see the indexer's
 *      `resolveCommitId`: short HEAD for a clean top-level git tree, else `wt-<hash>` of the file hashes;
 *   4. the newest `.explainer/index-*.json`.
 * A single candidate is used as it is. Whatever was chosen is compared with the working tree, and a
 * warning names the files that changed since it was built.
 */
import { readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  INDEX_SCHEMA,
  TextCache,
  asIndexModel,
  splitLines,
  type Explainer,
  type IndexModel,
  type SymbolIndex,
} from "@xpl/core";
import {
  FileHasher,
  detectGit,
  discoverFiles,
  isWorkTreeClean,
  readSource,
  resolveCommitId,
  shortHead,
  type GitInfo,
} from "@xpl/indexer";
import type { RepoEnv } from "./context.js";
import { CliError, errorMessage } from "./errors.js";
import { listText, plural } from "./format.js";
import { displayPath, parseJson, readTextFile, workingTreeReader } from "./fsutil.js";
import { gitShowReader } from "./git.js";

export const EXPLAINER_DIR = ".explainer";
export const EXPLAINER_SUFFIX = ".explainer.json";

// ─── The working tree ───────────────────────────────────────────────────────────────────────────

/** The files on disk: their text (cached) and, when needed, their hashes and commit id. */
export class WorkingTree {
  readonly texts: TextCache;
  private gitInfo: Promise<GitInfo | undefined> | undefined;
  private commitId: Promise<string> | undefined;
  private hashes: Promise<Map<string, string>> | undefined;

  constructor(readonly root: string) {
    // files at a commit come from git: base anchors read the base commit of a change record with it
    this.texts = new TextCache(workingTreeReader(root), gitShowReader(root));
  }

  private git(): Promise<GitInfo | undefined> {
    return (this.gitInfo ??= detectGit(this.root));
  }

  /** The commit id `xpl index` would give the tree right now (indexer rules, ARCHITECTURE.md §3). */
  commit(): Promise<string> {
    return (this.commitId ??= (async () => {
      const git = await this.git();
      if (git?.atToplevel && (await isWorkTreeClean(this.root))) {
        const head = await shortHead(this.root);
        if (head) return head;
      }
      const files = [...(await this.fileHashes())].map(([path, hash]) => ({ path, hash }));
      return resolveCommitId({ git, files, root: this.root });
    })());
  }

  /** `IndexedFile.hash` of every file the indexer would index now. */
  fileHashes(): Promise<Map<string, string>> {
    return (this.hashes ??= (async () => {
      const git = await this.git();
      const { files } = await discoverFiles(this.root, { git });
      const out = new Map<string, string>();
      const BATCH = 32;
      for (let i = 0; i < files.length; i += BATCH) {
        await Promise.all(
          files.slice(i, i + BATCH).map(async (file) => {
            try {
              out.set(file.path, new FileHasher(splitLines(await readSource(file))).hashFile());
            } catch {
              // vanished while listing: not part of the tree
            }
          }),
        );
      }
      return out;
    })());
  }
}

// ─── Index files ────────────────────────────────────────────────────────────────────────────────

export interface IndexFileInfo {
  name: string;
  abs: string;
  commit: string;
  mtimeMs: number;
}

/** `.explainer/index-*.json`, newest first. */
export function listIndexFiles(root: string): IndexFileInfo[] {
  const dir = join(root, EXPLAINER_DIR);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: IndexFileInfo[] = [];
  for (const name of names) {
    if (!/^index-.+\.json$/.test(name)) continue;
    const abs = join(dir, name);
    try {
      out.push({
        name,
        abs,
        commit: name.slice("index-".length, -".json".length),
        mtimeMs: statSync(abs).mtimeMs,
      });
    } catch {
      // removed meanwhile
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : -1));
}

const indexCache = new Map<string, { key: string; index: SymbolIndex; model: IndexModel }>();
const INDEX_CACHE_SIZE = 6;

/** Reads and validates an index file; unchanged files (same mtime, size, inode) come from a small cache. */
export function loadIndexFile(abs: string): { index: SymbolIndex; model: IndexModel } {
  let stat;
  try {
    stat = statSync(abs);
  } catch (error) {
    throw new CliError(`cannot read index ${abs}: ${errorMessage(error)}`);
  }
  const key = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
  const cached = indexCache.get(abs);
  if (cached?.key === key) return cached;
  const data = parseJson(readTextFile(abs, "index"), `index ${abs}`) as SymbolIndex;
  if (typeof data !== "object" || data === null || data.schema !== INDEX_SCHEMA) {
    throw new CliError(
      `${abs} is not an xpl symbol index (expected schema "${INDEX_SCHEMA}"). Build one with \`xpl index\`.`,
    );
  }
  const entry = { key, index: data, model: asIndexModel(data) };
  indexCache.delete(abs);
  indexCache.set(abs, entry);
  while (indexCache.size > INDEX_CACHE_SIZE) indexCache.delete(indexCache.keys().next().value!);
  return entry;
}

// ─── Workspace: the chosen index plus the working tree ──────────────────────────────────────────

export interface Workspace {
  env: RepoEnv;
  root: string;
  /** Absolute path of the chosen index file. */
  indexFile: string;
  /** Root-relative POSIX path of the index file (what `Explainer.index.path` holds). */
  indexRel: string;
  index: SymbolIndex;
  model: IndexModel;
  /** Working-tree text (cached). */
  texts: TextCache;
  tree: WorkingTree;
  /** How the index differs from the working tree; undefined when it matches (or the check was skipped). */
  stale: Staleness | undefined;
}

export interface OpenOptions {
  /** Strict validation/export must check even when XPL_SKIP_STALE_CHECK is set. */
  requireFreshIndex?: boolean;
  /** For explainer commands: prefer the explainer's own index. */
  explainer?: LoadedExplainer;
  /** `xpl resolve`: ignore the explainer's own index (it is the old one by definition). */
  skipExplainerIndex?: boolean;
  /** Skip the comparison with the working tree (default: check and warn). */
  skipFreshnessCheck?: boolean;
  /** Compare, but leave the warning to the caller (it decides between a warning and a refusal). */
  deferStaleWarning?: boolean;
  tree?: WorkingTree;
}

/** An environment switch: set and not "0" / "false". */
function envFlag(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function resolveOption(env: RepoEnv, option: string): string {
  const candidates = [resolve(env.cwd, option), resolve(env.root, option)];
  for (const candidate of candidates) {
    if (isFile(candidate)) return candidate;
  }
  throw new CliError(`index file "${option}" not found (looked in ${candidates.join(" and ")})`);
}

export async function chooseIndexFile(
  env: RepoEnv,
  tree: WorkingTree,
  opts: { explainer?: LoadedExplainer; skipExplainerIndex?: boolean } = {},
): Promise<string> {
  if (env.indexOption !== undefined) return resolveOption(env, env.indexOption);
  if (opts.explainer && !opts.skipExplainerIndex) {
    const path = opts.explainer.explainer.index?.path;
    if (typeof path === "string" && path !== "") {
      const abs = resolve(env.root, path);
      if (isFile(abs)) return abs;
    }
  }
  const candidates = listIndexFiles(env.root);
  if (candidates.length === 0) {
    throw new CliError(
      `no symbol index found in ${join(env.root, EXPLAINER_DIR)}. Run \`xpl index\` first (from the repository root, or pass --root <dir>).`,
    );
  }
  if (candidates.length === 1) return candidates[0]!.abs;
  const current = await tree.commit();
  return (candidates.find((c) => c.commit === current) ?? candidates[0]!).abs;
}

/** How an index differs from the working tree. */
export interface Staleness {
  /** `index X (path) does not match the working tree (Y): 2 changed (a, b)`. */
  head: string;
  /** The warning commands print: `head`, what it means and what to run. */
  message: string;
}

/** Why the index does not match the working tree, or undefined when it does. */
export async function stalenessWarning(
  env: RepoEnv,
  tree: WorkingTree,
  index: SymbolIndex,
  indexFile: string,
  explainer?: LoadedExplainer,
): Promise<string | undefined> {
  return (await stalenessOf(env, tree, index, indexFile, explainer))?.message;
}

export async function stalenessOf(
  env: RepoEnv,
  tree: WorkingTree,
  index: SymbolIndex,
  indexFile: string,
  explainer?: LoadedExplainer,
): Promise<Staleness | undefined> {
  const current = await tree.commit();
  // A commit label is not evidence of identical source or line positions (including legacy indexes).
  const hashes = await tree.fileHashes();
  const changed: string[] = [];
  const removed: string[] = [];
  const known = new Set<string>();
  for (const file of index.files ?? []) {
    known.add(file.path);
    const hash = hashes.get(file.path);
    if (hash === undefined) removed.push(file.path);
    else if (hash !== file.hash) changed.push(file.path);
  }
  const added = [...hashes.keys()].filter((path) => !known.has(path)).sort();
  if (changed.length + removed.length + added.length === 0) return undefined;

  const parts: string[] = [];
  if (changed.length > 0) parts.push(`${changed.length} changed (${listText(changed)})`);
  if (added.length > 0) parts.push(`${added.length} new (${listText(added)})`);
  if (removed.length > 0) parts.push(`${removed.length} deleted (${listText(removed)})`);
  const head =
    `index ${index.commit} (${displayPath(env.root, indexFile)}) does not match the working tree ` +
    `(${current}): ${parts.join(", ")}`;
  let message = `${head}. Line numbers and offsets may be off; run \`xpl index\``;
  const newer = listIndexFiles(env.root).find((c) => c.commit === current && c.abs !== indexFile);
  if (newer) {
    message += ` (an index for the current tree exists: ${displayPath(env.root, newer.abs)}${
      explainer ? `; run \`xpl resolve ${explainer.name} --write\` to move the explainer to it` : ""
    })`;
  } else if (explainer) {
    message += `, then \`xpl resolve ${explainer.name} --write\``;
  }
  return { head, message: `${message}.` };
}

export async function openWorkspace(env: RepoEnv, opts: OpenOptions = {}): Promise<Workspace> {
  const tree = opts.tree ?? new WorkingTree(env.root);
  const indexFile = await chooseIndexFile(env, tree, opts);
  const { index, model } = loadIndexFile(indexFile);
  // XPL_SKIP_STALE_CHECK=1: skip hashing the working tree (it costs about a second per 5000 files).
  let stale: Staleness | undefined;
  if (
    opts.requireFreshIndex ||
    (!opts.skipFreshnessCheck && !envFlag(env.env.XPL_SKIP_STALE_CHECK))
  ) {
    stale = await stalenessOf(env, tree, index, indexFile, opts.explainer);
    if (stale && !opts.deferStaleWarning) env.warn(stale.message);
  }
  return {
    env,
    root: env.root,
    indexFile,
    indexRel: displayPath(env.root, indexFile),
    index,
    model,
    texts: tree.texts,
    tree,
    stale,
  };
}

// ─── Explainer files ────────────────────────────────────────────────────────────────────────────

export interface LoadedExplainer {
  /** Absolute path of the file. */
  abs: string;
  /** Display path (root-relative when inside the root). */
  rel: string;
  /** File name without `.explainer.json`. */
  name: string;
  explainer: Explainer;
}

export function explainerName(path: string): string {
  const base = basename(path);
  return base.endsWith(EXPLAINER_SUFFIX)
    ? base.slice(0, -EXPLAINER_SUFFIX.length)
    : base.replace(/\.json$/, "");
}

export function listExplainerNames(root: string): string[] {
  try {
    return readdirSync(join(root, EXPLAINER_DIR))
      .filter((name) => name.endsWith(EXPLAINER_SUFFIX))
      .map((name) => name.slice(0, -EXPLAINER_SUFFIX.length))
      .sort();
  } catch {
    return [];
  }
}

/** `demo`, `demo.explainer.json`, `.explainer/demo.explainer.json` or any path to the file. */
export function resolveExplainerPath(env: RepoEnv, arg: string): string {
  const pathLike = arg.includes("/") || arg.includes("\\") || arg.endsWith(".json");
  const candidates: string[] = [];
  if (pathLike) candidates.push(resolve(env.cwd, arg), resolve(env.root, arg));
  const file = arg.endsWith(EXPLAINER_SUFFIX) ? arg : `${arg}${EXPLAINER_SUFFIX}`;
  if (!pathLike || !arg.includes("/")) candidates.push(join(env.root, EXPLAINER_DIR, file));
  for (const candidate of candidates) {
    if (isFile(candidate)) return candidate;
  }
  const existing = listExplainerNames(env.root);
  throw new CliError(
    `no explainer "${arg}" (looked for ${candidates.map((c) => displayPath(env.root, c)).join(", ")}). ` +
      (existing.length > 0
        ? `Existing explainers: ${existing.join(", ")}.`
        : `There are none yet; create one with \`xpl new ${arg}\`.`),
  );
}

export function readExplainerFile(abs: string): Explainer {
  const data = parseJson(readTextFile(abs, "explainer"), abs);
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new CliError(`${abs} does not contain a JSON object (expected an explainer)`);
  }
  return data as Explainer;
}

export function loadExplainer(env: RepoEnv, arg: string): LoadedExplainer {
  const abs = resolveExplainerPath(env, arg);
  return {
    abs,
    rel: displayPath(env.root, abs),
    name: explainerName(abs),
    explainer: readExplainerFile(abs),
  };
}
