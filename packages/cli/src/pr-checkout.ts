/** Owned PR staging. Only this repository is fetched or checked out; input.json is published last. */
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  analyzeChange,
  IndexModel,
  type ChangeAnalysis,
  type ChangeRecord,
  type SymbolIndex,
} from "@xpl/core";
import { buildIndex, createScipProviders, indexProviders, writeIndex } from "@xpl/indexer";
import type { Ctx } from "./context.js";
import { CliError, errorMessage } from "./errors.js";
import { atomicWrite, jsonFile, toPosix, workingTreeReader } from "./fsutil.js";
import { computeChange, gitShowReader } from "./git.js";
import { prGitOptions, prProcess, type ResolvedPr } from "./pr.js";

type Source =
  { state: "absent" } | { state: "text"; text: string } | { state: "unavailable"; reason: string };

/** CLI-only input contract for later creation and version sharing. Prepared is never a ready result. */
export interface PrInputManifest {
  schemaVersion: 1;
  kind: "github-pr-input";
  preparedAt: string;
  pr: ResolvedPr;
  change: ChangeRecord;
  index: {
    path: string;
    commit: string;
    sha256: string;
    files: { path: string; hash: string }[];
    languages: SymbolIndex["languages"];
  };
  sources: { path: string; oldPath?: string; before: Source; after: Source }[];
  analysis: ChangeAnalysis;
  warnings: string[];
}

const MARKER = ".xpl-pr-owned.json";

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** Resolve existing ancestors before creating anything, so a symlink cannot bypass the outside-tree guard. */
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonical(parent), basename(path));
  }
}

async function outsideDeveloperTree(ctx: Ctx, path: string): Promise<void> {
  for (const root of new Set([ctx.root, ctx.cwd])) {
    const protectedRoot = await realpath(root);
    let gitRoot: string | undefined;
    try {
      gitRoot = (await prProcess("git", ["rev-parse", "--show-toplevel"], root, ctx.env)).trim();
    } catch {
      /* A non-git directory still needs protection. */
    }
    if (within(protectedRoot, path) || (gitRoot && within(await realpath(gitRoot), path))) {
      throw new CliError(
        `storage ${path} is inside the developer checkout. Choose a directory outside it; no source or git state was changed.`,
      );
    }
  }
}

export async function prCacheDirectory(ctx: Ctx, option: string | undefined): Promise<string> {
  return outsideSourceDirectory(
    ctx,
    option ?? join(ctx.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "xpl", "pr"),
  );
}

/** Shared by PR inputs and ready-version storage; checks ancestors before any directory is created. */
export async function outsideSourceDirectory(ctx: Ctx, option: string): Promise<string> {
  const path = await canonical(resolve(ctx.cwd, option));
  await outsideDeveloperTree(ctx, path);
  return path;
}

/** Compare tracked source bytes with raw Git objects; authoring may update only .explainer outputs. */
export async function verifyPrCheckout(
  ctx: Ctx,
  repository: string,
  head: string,
  authoring = false,
) {
  const options = prGitOptions(ctx.env, repository);
  const git = (args: string[]) =>
    prProcess("git", args, repository, options.env, ctx.io.signal, options);
  // Status/diff would run clean filters again and can hide a smudge or line-ending transformation.
  // Compare raw blob IDs instead, before any transformed bytes enter an index claiming this head.
  const tree = (await git(["ls-tree", "-r", "-z", head])).split("\0").filter(Boolean);
  for (const entry of tree) {
    const tab = entry.indexOf("\t");
    const [mode, type, blob] = entry.slice(0, tab).split(" ");
    if (type !== "blob") continue; // Submodules are not materialized or indexed.
    const path = entry.slice(tab + 1);
    if (authoring && (path === ".explainer" || path.startsWith(".explainer/"))) continue;
    const absolute = join(repository, path);
    const bytes =
      mode === "120000"
        ? await readlink(absolute, { encoding: "buffer" })
        : await readFile(absolute);
    const actual = createHash(head.length === 40 ? "sha1" : "sha256")
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex");
    if (actual !== blob)
      throw new CliError(
        `${path} differs from the raw head blob; checkout filters or line-ending conversion changed the snapshot. Disable that conversion for PR preparation and retry.`,
      );
  }
}

export async function preparePr(
  ctx: Ctx,
  pr: ResolvedPr,
  cache: string,
  precise: "auto" | "off" | "require",
) {
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(join(cache, "input-"));
  const repository = join(directory, "repository");
  const gitOptions = prGitOptions(ctx.env, repository);
  const git = (args: string[]) =>
    prProcess("git", args, repository, gitOptions.env, ctx.io.signal, gitOptions);
  try {
    await writeFile(
      join(directory, MARKER),
      jsonFile({ kind: "xpl-pr-owned", schemaVersion: 1, directory, cache }),
      { flag: "wx", mode: 0o600 },
    );
    await mkdir(repository);
    await git(["init", "--quiet", "--template="]);
    const remote = `https://github.com/${pr.base.repository}.git`;
    const fetch = (url: string, ref: string) =>
      git(["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--depth=1", url, ref]);
    await fetch(remote, pr.base.sha);
    // GitHub's PR ref can remain available after a fork is deleted or is inaccessible directly.
    const attempts: [string, string][] = [
      [remote, pr.head.sha],
      [remote, `refs/pull/${pr.number}/head`],
    ];
    if (pr.head.repository && pr.head.repository !== pr.base.repository)
      attempts.push([`https://github.com/${pr.head.repository}.git`, pr.head.sha]);
    const failures: string[] = [];
    let found = false;
    for (const [url, ref] of attempts) {
      try {
        await fetch(url, ref);
        const actual = (await git(["rev-parse", "--verify", `${pr.head.sha}^{commit}`])).trim();
        if (actual !== pr.head.sha)
          throw new CliError("fetched commit does not match the resolved head");
        found = true;
        break;
      } catch (error) {
        failures.push(errorMessage(error));
        ctx.io.signal?.throwIfAborted();
      }
    }
    if (!found)
      throw new CliError(
        `cannot fetch exact head ${pr.head.sha}; the PR ref may have moved or fork access may be unavailable. ${failures.join("; ")}. Resolve the PR again or check existing git access.`,
      );
    await git(["-c", "submodule.recurse=false", "checkout", "--quiet", "--detach", pr.head.sha]);
    await verifyPrCheckout(ctx, repository, pr.head.sha);
    // Index writes must not follow a repository-supplied .explainer symlink out of owned storage.
    const explainerDir = await lstat(join(repository, ".explainer")).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      },
    );
    if (explainerDir && !explainerDir.isDirectory())
      throw new CliError(
        "PR head .explainer is not a regular directory; refusing index writes through it",
      );
    if (
      explainerDir &&
      (
        await readdir(join(repository, ".explainer"), { recursive: true, withFileTypes: true })
      ).some((entry) => entry.isSymbolicLink())
    ) {
      throw new CliError("PR head .explainer contains a symlink; refusing index writes through it");
    }
    // Fresh inputs cannot reuse repository-supplied generated facts.
    const result = await buildIndex({
      root: repository,
      precise,
      commit: pr.head.sha,
      cache: false,
      gitOptions,
      providers: [
        ...indexProviders().filter((provider) => provider.mode === "syntax"),
        ...createScipProviders({ env: gitOptions.env }),
      ],
    });
    const indexPath = await writeIndex(repository, result.index);
    const change = await computeChange(repository, pr.base.sha, pr.head.sha, gitOptions);
    const read = gitShowReader(repository, gitOptions);
    const source = (sha: string, path: string): Source => {
      const text = read(sha, path);
      if (text === undefined)
        return {
          state: "unavailable",
          reason: "git could not read this entry as a file (for example, a submodule)",
        };
      if (text.includes("\0"))
        return { state: "unavailable", reason: "binary source is not embedded" };
      return { state: "text", text };
    };
    const sources = change.files.map((file) => ({
      path: file.path,
      ...(file.oldPath ? { oldPath: file.oldPath } : {}),
      before:
        file.status === "added"
          ? { state: "absent" as const }
          : source(pr.base.sha, file.oldPath ?? file.path),
      after:
        file.status === "deleted" ? { state: "absent" as const } : source(pr.head.sha, file.path),
    }));
    const warnings = [...result.warnings];
    for (const file of sources)
      for (const side of ["before", "after"] as const)
        if (file[side].state === "unavailable")
          warnings.push(`${file.path} ${side}: ${file[side].reason}`);
    const manifest: PrInputManifest = {
      schemaVersion: 1,
      kind: "github-pr-input",
      preparedAt: new Date().toISOString(),
      pr,
      change,
      index: {
        path: toPosix(relative(directory, indexPath)),
        commit: result.index.commit,
        sha256: createHash("sha256")
          .update(await readFile(indexPath))
          .digest("hex"),
        files: result.index.files.map(({ path, hash }) => ({ path, hash })),
        languages: result.index.languages,
      },
      sources,
      analysis: analyzeChange(change, new IndexModel(result.index), workingTreeReader(repository)),
      warnings,
    };
    ctx.io.signal?.throwIfAborted();
    const manifestPath = join(directory, "input.json");
    await atomicWrite(manifestPath, jsonFile(manifest));
    await chmod(manifestPath, 0o444);
    return { directory, repository, manifestPath, manifest };
  } catch (error) {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (cleanup) {
      throw new CliError(
        `PR preparation failed: ${errorMessage(error)}. Cleanup also failed: ${errorMessage(cleanup)}. Remove owned input with xpl pr cleanup ${directory} --cache-dir ${cache}.`,
      );
    }
    throw new CliError(
      `PR preparation failed: ${errorMessage(error)}. Owned input removed; no ready output was written. Retry after fixing access, fetch or indexing.`,
    );
  }
}

/** Validate ownership without removing an input; creation and cleanup share the same boundary. */
export async function ownedPrDirectory(
  ctx: Ctx,
  directory: string,
  cache: string,
): Promise<string> {
  directory = resolve(ctx.cwd, directory);
  if (
    dirname(directory) !== cache ||
    !/^input-[A-Za-z0-9]+$/.test(basename(directory)) ||
    (await lstat(directory)).isSymbolicLink() ||
    (await realpath(directory)) !== directory
  )
    throw new CliError(
      "cleanup needs an owned input directory directly under --cache-dir; symlinks are refused",
    );
  await outsideDeveloperTree(ctx, directory);
  let marker: unknown;
  try {
    marker = JSON.parse(await readFile(join(directory, MARKER), "utf8"));
  } catch {
    throw new CliError("cleanup refused: the xpl PR ownership marker is missing or invalid");
  }
  if (
    !marker ||
    typeof marker !== "object" ||
    !("kind" in marker) ||
    marker.kind !== "xpl-pr-owned" ||
    !("schemaVersion" in marker) ||
    marker.schemaVersion !== 1 ||
    !("directory" in marker) ||
    marker.directory !== directory ||
    !("cache" in marker) ||
    marker.cache !== cache
  )
    throw new CliError("cleanup refused: directory does not match its xpl PR ownership marker");
  return directory;
}

export async function cleanupPr(ctx: Ctx, directory: string, cache: string): Promise<void> {
  await rm(await ownedPrDirectory(ctx, directory, cache), { recursive: true });
}
