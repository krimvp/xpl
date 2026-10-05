/**
 * Module resolution for the TypeScript/JavaScript pack.
 *
 * - `probeModule`: a repository path (`src/util`, `src/util.js`) -> the files it may denote (extension
 *   probing, `.js` -> `.ts` rewriting, directory `index`).
 * - Relative specifiers are probed directly (see typescript.ts).
 * - Bare specifiers are external, *except* when the repository itself defines them: `tsconfig.json` /
 *   `jsconfig.json` `paths` and `baseUrl` (with relative `extends`), and workspace packages whose
 *   `package.json` `name` matches (entry via `exports`, `types`, `module`, `main`; build output such as
 *   `dist/index.js` is mapped back to its source). Packages that live only in `node_modules` stay external.
 */
import { posix } from "node:path";
import type { RepoView } from "./types.js";

/** Extensions a specifier may carry although the file on disk is the TypeScript source. */
const JS_TO_SOURCE: Readonly<Record<string, readonly string[]>> = {
  ".js": [".ts", ".tsx", ".d.ts"],
  ".jsx": [".tsx", ".ts"],
  ".mjs": [".mts", ".d.mts"],
  ".cjs": [".cts", ".d.cts"],
};
/** Probe order for an extension-less specifier. */
const PROBE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".d.ts",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
  ".json",
];

/** Normalise a repo-relative path; undefined if it leaves the repository. */
export function repoPath(path: string): string | undefined {
  const normalized = posix.normalize(path);
  if (normalized === ".." || normalized.startsWith("../") || posix.isAbsolute(normalized))
    return undefined;
  return normalized === "." ? "" : normalized.replace(/\/$/, "");
}

/** Files that `base` (a repo-relative path without or with extension) may denote, best first. */
export function probeModule(base: string, repo: RepoView, directoryOnly = false): string[] {
  const out: string[] = [];
  const add = (path: string): void => {
    if (path !== "" && repo.files.has(path) && !out.includes(path)) out.push(path);
  };
  if (!directoryOnly) {
    const ext = posix.extname(base);
    if (ext) {
      // An exact file (also non-code assets such as `./style.css`), then the TypeScript source a `.js` names.
      add(base);
      const stem = base.slice(0, -ext.length);
      for (const source of JS_TO_SOURCE[ext] ?? []) add(stem + source);
    }
    // `./foo` and `./foo.service`: append an extension.
    if (out.length === 0) for (const probe of PROBE_EXTENSIONS) add(base + probe);
  }
  if (out.length === 0) {
    for (const probe of PROBE_EXTENSIONS)
      add(base === "" ? `index${probe}` : `${base}/index${probe}`);
  }
  return out;
}

// ─── JSONC ────────────────────────────────────────────────────────────────────────────────────────

/** Parse JSON with comments and trailing commas (tsconfig style). Undefined if it is not valid. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1").replace(/^﻿/, ""));
  } catch {
    return undefined;
  }
}

/** scip-typescript@0.4.0 src/main.ts delegates these local probes to TypeScript's config loader. */
export function readProjectConfiguration(
  repo: RepoView,
  path: string,
  seen = new Set<string>(),
): boolean {
  if (seen.has(path)) return true;
  const text = repo.readText(path);
  if (text === undefined) return false;
  seen.add(path);
  const config = parseJsonc(text);
  if (!isRecord(config)) return true;
  // TypeScript 5.9.3 lib/typescript.js getExtendsConfigPath: exact local path, then .json;
  // a local extends is never a directory's tsconfig. Package extends are external dependencies.
  const extended = Array.isArray(config.extends) ? config.extends : [config.extends];
  for (const entry of extended) {
    if (
      typeof entry !== "string" ||
      !(entry.startsWith("./") || entry.startsWith("../") || posix.isAbsolute(entry))
    )
      continue;
    const target = posix.isAbsolute(entry)
      ? posix.relative(repo.root, entry)
      : posix.normalize(posix.join(posix.dirname(path), entry));
    if (!readProjectConfiguration(repo, target, seen) && !target.endsWith(".json"))
      readProjectConfiguration(repo, `${target}.json`, seen);
  }
  // src/main.ts indexSingleProject: reference directories select tsconfig.json;
  // a reference naming a JSON file selects that file, without probing a sibling <dir>.json.
  for (const ref of Array.isArray(config.references) ? config.references : []) {
    if (!isRecord(ref) || typeof ref.path !== "string") continue;
    const target = posix.isAbsolute(ref.path)
      ? posix.relative(repo.root, ref.path)
      : posix.normalize(posix.join(posix.dirname(path), ref.path));
    readProjectConfiguration(
      repo,
      target.endsWith(".json") ? target : `${target}/tsconfig.json`,
      seen,
    );
  }
  return true;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// ─── tsconfig paths / baseUrl ─────────────────────────────────────────────────────────────────────

interface PathsConfig {
  /** Directory (repo-relative) `baseUrl` points at, if the config sets one. */
  baseUrlDir?: string;
  paths?: Record<string, string[]>;
  /** Directory of the config that declared `paths` (targets resolve against `baseUrl`, else this). */
  pathsDir?: string;
}

const configCache = new WeakMap<RepoView, Map<string, PathsConfig | null>>();

function readPathsConfig(repo: RepoView, path: string, depth = 0): PathsConfig | undefined {
  const text = repo.readText(path);
  if (text === undefined || depth > 6) return undefined;
  const json = parseJsonc(text);
  if (!isRecord(json)) return undefined;
  const dir = posix.dirname(path) === "." ? "" : posix.dirname(path);
  let result: PathsConfig = {};
  const extended =
    typeof json.extends === "string"
      ? [json.extends]
      : Array.isArray(json.extends)
        ? json.extends
        : [];
  for (const entry of extended) {
    if (typeof entry !== "string" || !entry.startsWith(".")) continue; // packages (@tsconfig/...) are external
    const target = repoPath(posix.join(dir, entry));
    if (target === undefined) continue;
    const parent =
      readPathsConfig(repo, target, depth + 1) ??
      readPathsConfig(repo, `${target}.json`, depth + 1) ??
      readPathsConfig(repo, `${target}/tsconfig.json`, depth + 1);
    if (parent) result = { ...result, ...parent };
  }
  const options = json.compilerOptions;
  if (isRecord(options)) {
    if (typeof options.baseUrl === "string") {
      const base = repoPath(posix.join(dir, options.baseUrl));
      if (base !== undefined) result.baseUrlDir = base;
    }
    if (isRecord(options.paths)) {
      const paths: Record<string, string[]> = {};
      for (const [key, value] of Object.entries(options.paths)) {
        if (Array.isArray(value))
          paths[key] = value.filter((v): v is string => typeof v === "string");
      }
      result.paths = paths;
      result.pathsDir = dir;
    }
  }
  return result;
}

/** The paths/baseUrl configuration that applies to `fromFile` (nearest tsconfig.json / jsconfig.json). */
export function pathsConfigFor(repo: RepoView, fromFile: string): PathsConfig | undefined {
  let cache = configCache.get(repo);
  if (!cache) {
    cache = new Map();
    configCache.set(repo, cache);
  }
  let dir = posix.dirname(fromFile) === "." ? "" : posix.dirname(fromFile);
  const visited: string[] = [];
  for (;;) {
    const cached = cache.get(dir);
    if (cached !== undefined) {
      for (const d of visited) cache.set(d, cached);
      return cached ?? undefined;
    }
    visited.push(dir);
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const path = dir === "" ? name : `${dir}/${name}`;
      const config = readPathsConfig(repo, path);
      if (config) {
        for (const d of visited) cache.set(d, config);
        return config;
      }
    }
    if (dir === "") break;
    dir = posix.dirname(dir) === "." ? "" : posix.dirname(dir);
  }
  for (const d of visited) cache.set(d, null);
  return undefined;
}

function resolveWithPaths(spec: string, config: PathsConfig, repo: RepoView): string[] {
  const out: string[] = [];
  const push = (files: string[]): void => {
    for (const f of files) if (!out.includes(f)) out.push(f);
  };
  if (config.paths) {
    let best: { key: string; capture: string; prefix: number } | undefined;
    for (const key of Object.keys(config.paths)) {
      const star = key.indexOf("*");
      if (star < 0) {
        if (key === spec && (!best || key.length > best.prefix))
          best = { key, capture: "", prefix: key.length };
        continue;
      }
      const prefix = key.slice(0, star);
      const suffix = key.slice(star + 1);
      if (
        spec.length >= prefix.length + suffix.length &&
        spec.startsWith(prefix) &&
        spec.endsWith(suffix)
      ) {
        if (!best || prefix.length > best.prefix) {
          best = {
            key,
            capture: spec.slice(prefix.length, spec.length - suffix.length),
            prefix: prefix.length,
          };
        }
      }
    }
    if (best) {
      const root = config.baseUrlDir ?? config.pathsDir ?? "";
      for (const target of config.paths[best.key] ?? []) {
        const path = repoPath(posix.join(root, target.replace("*", best.capture)));
        if (path !== undefined) push(probeModule(path, repo));
      }
    }
  }
  if (out.length === 0 && config.baseUrlDir !== undefined) {
    const path = repoPath(posix.join(config.baseUrlDir, spec));
    if (path !== undefined) push(probeModule(path, repo));
  }
  return out;
}

// ─── workspace packages ───────────────────────────────────────────────────────────────────────────

interface WorkspacePackage {
  name: string;
  dir: string;
  json: Record<string, unknown>;
}

const packageCache = new WeakMap<RepoView, Map<string, WorkspacePackage>>();

function workspacePackages(repo: RepoView): Map<string, WorkspacePackage> {
  let packages = packageCache.get(repo);
  if (packages) return packages;
  packages = new Map();
  const manifests = [...repo.files]
    .filter((f) => f === "package.json" || f.endsWith("/package.json"))
    .sort();
  for (const path of manifests) {
    if (path.split("/").includes("node_modules")) continue;
    const text = repo.readText(path);
    if (text === undefined) continue;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      continue;
    }
    if (!isRecord(json) || typeof json.name !== "string" || packages.has(json.name)) continue;
    packages.set(json.name, {
      name: json.name,
      dir: posix.dirname(path) === "." ? "" : posix.dirname(path),
      json,
    });
  }
  packageCache.set(repo, packages);
  return packages;
}

/** Condition names, in the order we prefer them (types first: we index sources, not output). */
const CONDITIONS = ["types", "import", "module", "node", "default", "require"];

/** Every string an `exports`/`imports` target can stand for, most preferred first. */
function targetStrings(target: unknown, capture: string, depth = 0): string[] {
  if (depth > 6) return [];
  if (typeof target === "string") return [target.replace("*", capture)];
  if (Array.isArray(target)) return target.flatMap((t) => targetStrings(t, capture, depth + 1));
  if (!isRecord(target)) return [];
  const keys = Object.keys(target);
  const ordered = [
    ...CONDITIONS.filter((c) => keys.includes(c)),
    ...keys.filter((k) => !CONDITIONS.includes(k)),
  ];
  return ordered.flatMap((k) => targetStrings(target[k], capture, depth + 1));
}

/** The `exports` (or `imports`) entry for `key` (`.`, `./x`, `#x`), honouring `*` patterns. */
function subpathTargets(map: unknown, key: string): string[] {
  if (!isRecord(map)) return [];
  if (key in map) return targetStrings(map[key], "");
  let best: { pattern: string; capture: string } | undefined;
  for (const pattern of Object.keys(map)) {
    const star = pattern.indexOf("*");
    if (star < 0) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (
      key.length >= prefix.length + suffix.length &&
      key.startsWith(prefix) &&
      key.endsWith(suffix)
    ) {
      if (!best || prefix.length > best.pattern.indexOf("*")) {
        best = { pattern, capture: key.slice(prefix.length, key.length - suffix.length) };
      }
    }
  }
  return best ? targetStrings(map[best.pattern], best.capture) : [];
}

/** Build-output directories mapped back to source directories. */
const OUTPUT_DIRS = ["dist", "lib", "build", "out", "esm", "cjs"];

/** The source file(s) a package-relative target (`./dist/index.js`, `./src/index.ts`) stands for. */
function targetToSources(pkgDir: string, target: string, repo: RepoView): string[] {
  const path = repoPath(posix.join(pkgDir, target));
  if (path === undefined) return [];
  const direct = probeModule(path, repo);
  if (direct.length > 0) return direct;
  const rel = repoPath(posix.join(".", target));
  if (rel === undefined) return [];
  const [first, ...rest] = rel.split("/");
  if (first !== undefined && OUTPUT_DIRS.includes(first)) {
    for (const source of ["src", "source", ""]) {
      const mapped = repoPath(posix.join(pkgDir, source, ...rest));
      if (mapped === undefined) continue;
      const files = probeModule(mapped.replace(/\.d\.ts$/, ""), repo);
      if (files.length > 0) return files;
    }
  }
  return [];
}

function resolveWorkspace(spec: string, repo: RepoView): string[] {
  const packages = workspacePackages(repo);
  if (packages.size === 0) return [];
  // The longest package name that is the specifier or a prefix of it (`@scope/pkg/sub`).
  let match: WorkspacePackage | undefined;
  for (const pkg of packages.values()) {
    if (
      (spec === pkg.name || spec.startsWith(`${pkg.name}/`)) &&
      (!match || pkg.name.length > match.name.length)
    )
      match = pkg;
  }
  if (!match) return [];
  const sub = spec.slice(match.name.length); // "" or "/x/y"
  const out: string[] = [];
  const push = (files: string[]): void => {
    for (const f of files) if (!out.includes(f)) out.push(f);
  };
  const { json, dir } = match;
  if (json.exports !== undefined) {
    const key = sub === "" ? "." : `.${sub}`;
    const map =
      isRecord(json.exports) && Object.keys(json.exports).some((k) => k.startsWith("."))
        ? json.exports
        : sub === ""
          ? { ".": json.exports }
          : {};
    for (const target of subpathTargets(map, key)) push(targetToSources(dir, target, repo));
    if (out.length > 0) return out;
  }
  if (sub === "") {
    for (const field of ["types", "typings", "module", "main"]) {
      const value = json[field];
      if (typeof value === "string") push(targetToSources(dir, value, repo));
    }
    for (const entry of ["src/index", "index"])
      push(probeModule(repoPath(posix.join(dir, entry)) ?? "", repo));
  } else {
    for (const root of ["", "src"]) {
      const path = repoPath(posix.join(dir, root, sub));
      if (path !== undefined) push(probeModule(path, repo));
    }
  }
  return out;
}

/** `package.json` `imports` (`#internal/x`) of the nearest package.json above `fromFile`. */
function resolveSubpathImport(spec: string, fromFile: string, repo: RepoView): string[] {
  let dir = posix.dirname(fromFile) === "." ? "" : posix.dirname(fromFile);
  for (;;) {
    const text = repo.readText(dir === "" ? "package.json" : `${dir}/package.json`);
    if (text !== undefined) {
      try {
        const json: unknown = JSON.parse(text);
        if (isRecord(json) && json.imports !== undefined) {
          const out: string[] = [];
          for (const target of subpathTargets(json.imports, spec)) {
            for (const f of targetToSources(dir, target, repo)) if (!out.includes(f)) out.push(f);
          }
          return out;
        }
      } catch {
        // an unreadable manifest: keep looking upwards
      }
    }
    if (dir === "") return [];
    dir = posix.dirname(dir) === "." ? "" : posix.dirname(dir);
  }
}

/** Repository files a bare specifier stands for (tsconfig `paths`/`baseUrl`, workspace packages, `#imports`). */
export function resolveBareSpecifier(spec: string, fromFile: string, repo: RepoView): string[] {
  if (spec.startsWith("#")) return resolveSubpathImport(spec, fromFile, repo);
  const config = pathsConfigFor(repo, fromFile);
  if (config) {
    const viaPaths = resolveWithPaths(spec, config, repo);
    if (viaPaths.length > 0) return viaPaths;
  }
  return resolveWorkspace(spec, repo);
}
