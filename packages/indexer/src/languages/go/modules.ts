/**
 * Go modules: import path -> package directory (ARCHITECTURE.md §3, "Go module path from `go.mod` -> package
 * dir").
 *
 * Every `go.mod` of the repository is read (and cached per repository view): its `module` path maps
 * `module/path/x` to the directory `x` next to the go.mod, and local `replace` directives (`replace a/b =>
 * ../b`) map their target. A repository with several modules (a workspace, a monorepo) resolves imports
 * between them. The standard library and external modules resolve to nothing.
 */
import { posix } from "node:path";
import type { FilePath } from "@xpl/core";
import type { RepoView } from "../types.js";

/** `go-redis` -> `redis`, `yaml.v3` -> `yaml`, `mypkg-go` -> `mypkg`: what goimports takes for a package name. */
function identifierBase(element: string): string {
  const base = element.startsWith("go-") ? element.slice(3) : element;
  const cut = base.search(/[^\p{L}\p{N}_]/u);
  const name = cut >= 0 ? base.slice(0, cut) : base;
  return name === "" ? element : name;
}

/**
 * The package name(s) an import without an alias is assumed to have, derived from the import path like
 * goimports does (the `package` clause of the target is not consulted: `extract` cannot see other files): the
 * last path element, minus a `go-` prefix and anything from the first character that cannot be part of an
 * identifier (`gopkg.in/yaml.v3` -> `yaml`). A last element `vN` is ambiguous: `example.com/x/redis/v9` is the
 * major version of package `redis`, while a directory called `v1` (`example.com/x/api/v1`) is package `v1`.
 * Both names are returned for it, the version-suffix reading first.
 */
export function assumedPackageNames(importPath: string): string[] {
  const parts = importPath.split("/");
  const last = parts[parts.length - 1] ?? importPath;
  if (/^v\d+$/.test(last) && parts.length > 1)
    return [identifierBase(parts[parts.length - 2]!), last];
  return [identifierBase(last)];
}

interface Replace {
  /** Module path being replaced. */
  from: string;
  /** Repository directory it is replaced by. */
  dir: string;
}

/** What one `go.mod` says that matters here. */
export interface GoMod {
  /** Repository-relative directory of the go.mod (`""` = the root). */
  dir: string;
  module: string;
  replaces: Replace[];
}

const unquote = (s: string): string => s.replace(/^["`]|["`]$/g, "");

/** `dir` joined with `path`, in repository form (`""` for the root). */
function joinDir(dir: string, path: string): string {
  const joined = posix.normalize(posix.join(dir, path));
  return joined === "." ? "" : joined;
}

/** `old [version] => new [version]`, local targets only. */
function parseReplace(spec: string, dir: string): Replace | undefined {
  const arrow = spec.indexOf("=>");
  if (arrow < 0) return undefined;
  const from = unquote(spec.slice(0, arrow).trim().split(/\s+/)[0] ?? "");
  const to = unquote(
    spec
      .slice(arrow + 2)
      .trim()
      .split(/\s+/)[0] ?? "",
  );
  if (from === "" || !(to === "." || to === ".." || to.startsWith("./") || to.startsWith("../")))
    return undefined;
  return { from, dir: joinDir(dir, to) };
}

/** Parse a `go.mod` located in repository directory `dir`; undefined when it has no `module` line. */
export function parseGoMod(text: string, dir: string): GoMod | undefined {
  let module: string | undefined;
  const replaces: Replace[] = [];
  let inReplaceBlock = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (line === "") continue;
    if (inReplaceBlock) {
      if (line.startsWith(")")) inReplaceBlock = false;
      else {
        const replace = parseReplace(line, dir);
        if (replace) replaces.push(replace);
      }
      continue;
    }
    const moduleLine = /^module\s+(\S+)/.exec(line);
    if (moduleLine) {
      module ??= unquote(moduleLine[1]!);
      continue;
    }
    if (/^replace\s*\(\s*$/.test(line)) {
      inReplaceBlock = true;
      continue;
    }
    const replaceLine = /^replace\s+(.+)$/.exec(line);
    if (replaceLine) {
      const replace = parseReplace(replaceLine[1]!, dir);
      if (replace) replaces.push(replace);
    }
  }
  return module === undefined ? undefined : { dir, module, replaces };
}

/** The part of `spec` below `base` (`""` when equal), or undefined when `spec` is not `base` or inside it. */
function below(spec: string, base: string): string | undefined {
  if (spec === base) return "";
  return spec.startsWith(`${base}/`) ? spec.slice(base.length + 1) : undefined;
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** Number of leading path segments two directories share. */
function sharedSegments(a: string, b: string): number {
  const as = a === "" ? [] : a.split("/");
  const bs = b === "" ? [] : b.split("/");
  let n = 0;
  while (n < as.length && n < bs.length && as[n] === bs[n]) n++;
  return n;
}

/** All go.mod files of a repository view. */
class GoModules {
  private readonly mods: GoMod[] = [];

  constructor(repo: RepoView) {
    for (const path of repo.files) {
      if (path !== "go.mod" && !path.endsWith("/go.mod")) continue;
      const text = repo.readText(path);
      const mod = text === undefined ? undefined : parseGoMod(text, dirOf(path));
      if (mod) this.mods.push(mod);
    }
    this.mods.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  }

  get size(): number {
    return this.mods.length;
  }

  /** The go.mod that governs files of `dir`: the one in the closest ancestor directory. */
  private nearest(dir: string): GoMod | undefined {
    let best: GoMod | undefined;
    for (const mod of this.mods) {
      const covers = mod.dir === "" || dir === mod.dir || dir.startsWith(`${mod.dir}/`);
      if (covers && (!best || mod.dir.length > best.dir.length)) best = mod;
    }
    return best;
  }

  /** Repository directories the import path `spec` (used in a file of `fromDir`) may name, best first. */
  dirsFor(spec: string, fromDir: string): string[] {
    const out: string[] = [];
    // A local `replace` of the importer's module wins.
    for (const replace of this.nearest(fromDir)?.replaces ?? []) {
      const rest = below(spec, replace.from);
      if (rest !== undefined) out.push(joinDir(replace.dir, rest));
    }
    // Then the module whose path is the longest prefix of the import path (the closest one on a tie).
    const matches: { mod: GoMod; rest: string }[] = [];
    for (const mod of this.mods) {
      const rest = below(spec, mod.module);
      if (rest !== undefined) matches.push({ mod, rest });
    }
    matches.sort(
      (a, b) =>
        b.mod.module.length - a.mod.module.length ||
        sharedSegments(b.mod.dir, fromDir) - sharedSegments(a.mod.dir, fromDir),
    );
    for (const { mod, rest } of matches) out.push(joinDir(mod.dir, rest));
    return [...new Set(out)];
  }
}

const cache = new WeakMap<RepoView, GoModules>();

function modulesOf(repo: RepoView): GoModules {
  let modules = cache.get(repo);
  if (!modules) {
    modules = new GoModules(repo);
    cache.set(repo, modules);
  }
  return modules;
}

/**
 * The `.go` files of a package directory, best import target first: the file named like the directory
 * (`queue/queue.go`), then the other files, `doc.go` last. Test files only when the importer is a test.
 */
function packageFiles(repo: RepoView, dir: string, includeTests: boolean): FilePath[] {
  const all = repo.filesInDir(dir).filter((f) => f.endsWith(".go"));
  const namesake = `${dir === "" ? "" : posix.basename(dir)}.go`;
  const rank = (file: string): number => {
    const base = posix.basename(file);
    return base === namesake ? 0 : base === "doc.go" ? 2 : 1;
  };
  const production = all
    .filter((f) => !f.endsWith("_test.go"))
    .map((file, i) => ({ file, i }))
    .sort((a, b) => rank(a.file) - rank(b.file) || a.i - b.i)
    .map((x) => x.file);
  return includeTests ? [...production, ...all.filter((f) => f.endsWith("_test.go"))] : production;
}

/**
 * The repository files of the package an import path names, as seen from `fromFile`: every `.go` file of the
 * package directory (test files only for test importers), or `[]` for the standard library and external modules.
 */
export function resolveGoModule(spec: string, fromFile: FilePath, repo: RepoView): FilePath[] {
  const modules = modulesOf(repo);
  if (modules.size === 0 || spec === "") return [];
  const includeTests = fromFile.endsWith("_test.go");
  for (const dir of modules.dirsFor(spec, dirOf(fromFile))) {
    const files = packageFiles(repo, dir, includeTests);
    if (files.length > 0) return files;
  }
  return [];
}
