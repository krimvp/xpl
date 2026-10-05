/** Source and local configuration captured for a watched build. Recheck revision before publishing. */
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { discoverFiles, detectGit, runGit, WALK_SKIP_DIRS } from "./files.js";
import type { GitOptions } from "./files.js";
import type { ProviderSource } from "./providers.js";

export interface IndexInputs {
  root: string;
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
}): Promise<IndexInputs> {
  const root = resolve(options.root);
  const git = await detectGit(root, options.gitOptions);
  const discovery = await discoverFiles(root, { git, gitOptions: options.gitOptions });
  if (discovery.warnings.length) throw new Error(discovery.warnings.join("; "));
  const paths = new Map<string, string | undefined>(discovery.files.map((f) => [f.abs, f.path]));
  // Ignored configuration can still affect resolution. Capture JSON too: tsconfig extends may use any name.
  async function configPaths(dir: string, rel: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!WALK_SKIP_DIRS.has(entry.name)) await configPaths(join(dir, entry.name), path);
      } else if (
        entry.isFile() &&
        /(?:\.(?:json|ya?ml|toml|ini|cfg|lock)|(?:^|\/)(?:\.gitignore|\.gitattributes|\.npmrc|go\.(?:mod|sum|work)|requirements[^/]*\.txt))$/i.test(
          path,
        ) &&
        !/\.(?:explainer|patch)\.json$/i.test(path)
      )
        paths.set(join(dir, entry.name), path);
    }
  }
  await configPaths(root, "");
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
  const content = createHash("sha256");
  const revision = createHash("sha256");
  const discovered = JSON.stringify(discovery.files.map((f) => [f.path, f.language]));
  content.update(discovered);
  revision.update(discovered);
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
    content.update(`${abs}\0${digest}\n`);
    revision.update(`${abs}\0${digest}\0${version}\n`);
  }
  const head = git ? await runGit(root, ["rev-parse", "HEAD"], options.gitOptions) : "no-git";
  const config = git
    ? await runGit(root, ["config", "--list", "--show-origin", "-z"], options.gitOptions)
    : "";
  content.update(`${head ?? "unborn"}\0${config ?? ""}`);
  revision.update(`${head ?? "unborn"}\0${config ?? ""}`);
  const sources = discovery.files.map((f) => ({
    path: f.path,
    language: f.language,
    text: texts.get(f.path)!,
  }));
  return {
    root,
    sources,
    texts,
    fingerprint: content.digest("hex"),
    revision: revision.digest("hex"),
  };
}
