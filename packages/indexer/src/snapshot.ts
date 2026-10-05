/** Source and local configuration captured for a watched build. Recheck revision before publishing. */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { workTreeStatus } from "./commit.js";
import { buildIndex } from "./build.js";
import { homedir } from "node:os";
import { discoverFiles, detectGit, runGit } from "./files.js";
import type { GitOptions } from "./files.js";
import { indexProviders, type IndexProvider, type ProviderSource } from "./providers.js";
import { SourceRepoView } from "./repo.js";

export interface IndexInputs {
  root: string;
  /** Captured clean HEAD label; absent means derive the id from captured files, never live staging. */
  cleanHead?: string;
  sources: ProviderSource[];
  /** Includes ignored local configuration; missing paths read as undefined. */
  texts: ReadonlyMap<string, string>;
  /** Content/discovery/HEAD identity: touching a file alone does not start a build. */
  fingerprint: string;
  /** Includes ctime/mtime/inode, so a changed-and-restored input supersedes a running build. */
  revision: string;
}

export async function captureIndexInputs(options: {
  root: string;
  gitOptions?: GitOptions;
  /** Supplied provider artifact and manifest paths, including ignored or external files. */
  inputPaths?: readonly string[];
  /** Match the subsequent build's selection, but run only pure configuration readers. */
  precise?: "off" | "auto" | "require";
  providers?: readonly IndexProvider[];
}): Promise<IndexInputs> {
  const root = resolve(options.root);
  const git = await detectGit(root, options.gitOptions);
  const discovery = await discoverFiles(root, { git, gitOptions: options.gitOptions });
  if (discovery.warnings.length) throw new Error(discovery.warnings.join("; "));
  const paths = new Map<string, string | undefined>(discovery.files.map((f) => [f.abs, f.path]));
  // Parent ignore rules and git's local/global exclusions affect discovery without being indexed.
  if (git) {
    let dir = root;
    while (true) {
      paths.set(join(dir, ".gitignore"), dir === root ? ".gitignore" : undefined);
      if (dirname(dir) === dir) break;
      dir = dirname(dir);
    }
    const exclude = await runGit(
      root,
      ["rev-parse", "--git-path", "info/exclude"],
      options.gitOptions,
    );
    if (exclude) paths.set(resolve(root, exclude.trim()), undefined);
    const globalExclude = await runGit(
      root,
      ["config", "--path", "--get", "core.excludesFile"],
      options.gitOptions,
    );
    paths.set(
      globalExclude
        ? resolve(root, globalExclude.trim())
        : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "git", "ignore"),
      undefined,
    );
  }
  for (const path of options.inputPaths ?? []) {
    const abs = resolve(path);
    if (!paths.has(abs)) paths.set(abs, undefined);
  }
  const values = new Map<string, { digest: string; version: string }>();
  const texts = new Map<string, string>();
  for (const [abs, rel] of [...paths].sort(([a], [b]) => a.localeCompare(b))) {
    let bytes: Buffer | undefined;
    let version = "missing";
    try {
      const before = await stat(abs, { bigint: true });
      if (!before.isFile()) throw new Error(`index input is not a file: ${abs}`);
      bytes = await readFile(abs);
      const after = await stat(abs, { bigint: true });
      const signature = (s: typeof before) =>
        `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
      if (signature(before) !== signature(after))
        throw new Error(`index input changed during capture: ${abs}`);
      version = signature(after);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (discovery.files.some((f) => f.abs === abs))
        throw new Error(`source disappeared during capture: ${abs}`);
    }
    if (bytes && rel !== undefined) texts.set(rel, bytes.toString("utf8"));
    const digest = bytes ? createHash("sha256").update(bytes).digest("hex") : "missing";
    values.set(abs, { digest, version });
  }
  const sources = discovery.files.map((f) => ({
    path: f.path,
    language: f.language,
    text: texts.get(f.path)!,
  }));
  // Run the real resolver with a recording reader. Capture successful and missing reads alike,
  // so config chains of any filename and future pack readers have the same frozen view as a clean build.
  const read = texts.get.bind(texts);
  const attempted = new Set<string>();
  let configurationError: unknown;
  const getText = (path: string) => {
    if (texts.has(path) || attempted.has(path)) return read(path);
    attempted.add(path);
    const abs = resolve(root, path);
    let bytes: Buffer | undefined;
    let version = "missing";
    try {
      const before = statSync(abs, { bigint: true });
      if (!before.isFile()) return undefined;
      bytes = readFileSync(abs);
      const after = statSync(abs, { bigint: true });
      const signature = (s: typeof before) =>
        `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
      if (signature(before) !== signature(after))
        throw new Error(`configuration changed during capture: ${abs}`);
      version = signature(after);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") configurationError = error;
    }
    paths.set(abs, path);
    values.set(abs, {
      digest: bytes ? createHash("sha256").update(bytes).digest("hex") : "missing",
      version,
    });
    if (bytes) texts.set(path, bytes.toString("utf8"));
    return read(path);
  };
  await buildIndex({
    root,
    precise: "off",
    cache: false,
    gitOptions: options.gitOptions,
    getText,
    snapshot: { root, sources, texts, fingerprint: "", revision: "" },
  });
  const repo = new SourceRepoView(
    root,
    sources.map((s) => s.path),
    getText,
  );
  for (const provider of options.providers ?? indexProviders()) {
    if (provider.mode !== "syntax" && (options.precise ?? "off") === "off") continue;
    for (const source of sources)
      if (provider.languages.includes(source.language))
        provider.readConfiguration?.(source.path, repo);
  }
  if (configurationError) throw configurationError;
  const content = createHash("sha256");
  const revision = createHash("sha256");
  const discovered = JSON.stringify(discovery.files.map((f) => [f.path, f.language]));
  content.update(discovered);
  revision.update(discovered);
  for (const [abs, { digest, version }] of [...values].sort(([a], [b]) => a.localeCompare(b))) {
    content.update(`${abs}\0${digest}\n`);
    revision.update(`${abs}\0${digest}\0${version}\n`);
  }
  const observation = await observeInputs(root, [...values.keys()], options.gitOptions);
  for (const [abs, value] of values)
    if (observation.versions.get(abs) !== value.version)
      throw new Error(`index input changed during capture: ${abs}`);
  content.update(observation.gitState);
  revision.update(observation.gitState);
  const snapshot: IndexInputs = {
    root,
    ...(git?.atToplevel && observation.clean && observation.head
      ? { cleanHead: observation.head.slice(0, 7).toLowerCase() }
      : {}),
    sources,
    texts,
    fingerprint: content.digest("hex"),
    revision: revision.digest("hex"),
  };
  observations.set(snapshot, {
    root,
    paths: [...values.keys()],
    gitOptions: options.gitOptions,
    signature: observation.signature,
  });
  return snapshot;
}

const observations = new WeakMap<
  IndexInputs,
  { root: string; paths: string[]; gitOptions: GitOptions | undefined; signature: string }
>();

/** Metadata only: no source/configuration bytes are read on an unchanged idle poll. */
export async function indexInputsChanged(snapshot: IndexInputs): Promise<boolean> {
  const previous = observations.get(snapshot);
  if (!previous) return true;
  return (
    (await observeInputs(previous.root, previous.paths, previous.gitOptions)).signature !==
    previous.signature
  );
}

async function observeInputs(
  root: string,
  dependencies: readonly string[],
  gitOptions?: GitOptions,
) {
  const git = await detectGit(root, gitOptions);
  const discovery = await discoverFiles(root, { git, gitOptions, content: false });
  if (discovery.warnings.length) throw new Error(discovery.warnings.join("; "));
  const paths = [...new Set([...discovery.files.map((f) => f.abs), ...dependencies])].sort();
  const versions = new Map<string, string>();
  for (const path of paths) {
    let version = "missing";
    try {
      const s = statSync(path, { bigint: true });
      version = `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    versions.set(path, version);
  }
  const [head, config, status] = git
    ? await Promise.all([
        runGit(root, ["rev-parse", "HEAD"], gitOptions),
        runGit(root, ["config", "--list", "--show-origin", "-z"], gitOptions),
        workTreeStatus(root, gitOptions),
      ])
    : ["no-git", "", ""];
  const cleanliness =
    status === undefined ? "unavailable" : status.trim() === "" ? "clean" : "dirty";
  const gitState = `${head ?? "unborn"}\0${config ?? ""}\0${cleanliness}`;
  const hash = createHash("sha256").update(gitState);
  for (const path of paths) hash.update(`${path}\0${versions.get(path)}\n`);
  const clean = status !== undefined && status.trim() === "";
  const parsedHead = head?.trim();
  return {
    versions,
    gitState,
    signature: hash.digest("hex"),
    clean,
    head: parsedHead && /^[0-9a-f]{7,}$/i.test(parsedHead) ? parsedHead : undefined,
  };
}
