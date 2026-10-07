/**
 * Running the SCIP indexers (ARCHITECTURE.md §3, "Precise resolution").
 *
 *   TypeScript/JavaScript  npx --yes @sourcegraph/scip-typescript@0.4.0 index --output <tmp>/x.scip <projects>
 *   Python                 npx --yes @sourcegraph/scip-python@0.6.6 index --project-name <n> --output ...
 *   Go                     go run github.com/scip-code/scip-go/cmd/scip-go@v0.2.7 index --output ...  (per go.mod)
 *
 * Every tool runs with a timeout (default 10 minutes), writes its index to a temp directory that is removed
 * afterwards, and has its output captured: failures become an error carrying the tail of the output, and
 * warning lines of successful runs are handed to the caller.
 *
 * Gotchas found while building this (all verified against the pinned versions):
 *
 *  - scip-go 0.2.x moved to `github.com/scip-code/scip-go` (the old `github.com/sourcegraph/scip-go` path stops
 *    at v0.1.26), its CLI is `scip-go index [flags]`, and it needs Go >= 1.25 (an older `go` downloads the
 *    toolchain on first use, which needs network access).
 *  - scip-python crashes without a project version when the directory is not a git repository: we always pass
 *    `--project-version`. `--environment` with an empty package list skips its `pip` introspection.
 *  - scip-typescript `--infer-tsconfig` writes a `tsconfig.json` into the repository and leaves it there, and
 *    indexes only `.ts` files as soon as one exists. We never use it: files that no tsconfig covers get a
 *    synthetic tsconfig in the temp directory (a project can be given as a tsconfig file path).
 *  - Tools print their fatal errors to stdout as well as stderr, so both are captured; scip-python exits 1 but
 *    still leaves a (metadata-only) index behind when it crashes.
 *  - `GOFLAGS=-mod=mod` lets scip-go load modules whose go.sum is incomplete but may rewrite go.mod/go.sum:
 *    Go runs in a private source copy, so its module writes never reach the working tree. The go command rejects `-mod=mod` in workspace mode and it would
 *    bypass a vendor directory (which loads without network access), so a repository with a go.work, and a
 *    module with a vendor directory, are indexed without it.
 *  - A tsconfig that cannot be loaded (`extends` a package that is not installed in a fresh checkout) makes
 *    scip-typescript exit 1 with no index: the files are then indexed with the synthetic default config.
 *  - scip-python resolves `import flask` to `src/flask` only when `src` is on `PYTHONPATH` (pyright reads the
 *    interpreter's sys.path), so the package roots of the repository are put there.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  delimiter,
  isAbsolute,
  join,
  posix,
  relative,
  resolve as resolvePath,
  sep,
} from "node:path";
import type { FilePath, IndexedFile } from "@xpl/core";
import { documentPath } from "./map.js";
import type { ScipSource } from "./map.js";
import { decodeIndex } from "./proto.js";

export const SCIP_TYPESCRIPT_VERSION = "0.4.0";
export const SCIP_PYTHON_VERSION = "0.6.6";
export const SCIP_GO_PACKAGE = "github.com/scip-code/scip-go/cmd/scip-go";
export const SCIP_GO_VERSION = "v0.2.7";

/** Default per-tool timeout: 10 minutes. `XPL_SCIP_TIMEOUT_MS` overrides it. */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Most output kept per stream of a child process (the tail; progress bars can be chatty). */
const MAX_CAPTURE = 256 * 1024;
/** Lines of output quoted in an error message. */
const ERROR_TAIL_LINES = 12;
/** Warning lines reported per tool run. */
const MAX_WARNINGS = 5;

// ─── Processes ────────────────────────────────────────────────────────────────────────────────────

export interface CommandOptions {
  signal?: AbortSignal;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface CommandResult {
  /** Exit code; null when the process was killed by a signal. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** How commands are run; tests inject fakes. Rejects only when the process cannot be started. */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: CommandOptions,
) => Promise<CommandResult>;

/** Grace period between SIGTERM and SIGKILL when a tool times out. */
const KILL_GRACE_MS = 3000;

function killTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    // A negative pid signals the whole process group (npx -> node -> the tool).
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch {
    // already gone
  }
}

export const runCommand: CommandRunner = (command, args, options) =>
  new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(options.signal.reason);
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      // `npx.cmd` shims cannot be spawned without a shell on Windows.
      shell: process.platform === "win32",
    });
    let stdout = "";
    let stderr = "";
    const tail = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString("utf8");
      return next.length > MAX_CAPTURE ? next.slice(next.length - MAX_CAPTURE) : next;
    };
    child.stdout.on("data", (chunk: Buffer) => (stdout = tail(stdout, chunk)));
    child.stderr.on("data", (chunk: Buffer) => (stderr = tail(stderr, chunk)));
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    let closed = false;
    let exitCode: number | null = null;
    const finish = () => {
      options.signal?.removeEventListener("abort", abort);
      if (options.signal?.aborted) reject(options.signal.reason);
      else resolve({ code: exitCode, stdout, stderr, timedOut });
    };
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      killTree(child.pid, "SIGTERM");
      killTimer = setTimeout(() => {
        // The group may outlive its leader and close all pipes. Finish escalation before returning.
        killTree(child.pid, "SIGKILL");
        killTimer = undefined;
        if (closed) finish();
      }, KILL_GRACE_MS);
    };
    const abort = () => {
      clearTimeout(timer);
      stop();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      closed = true;
      exitCode = code;
      if (killTimer) {
        try {
          // A closed leader can leave descendants alive; keep escalation only while its group exists.
          process.kill(process.platform === "win32" ? child.pid! : -child.pid!, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") {
            clearTimeout(killTimer);
            killTimer = undefined;
          }
        }
      }
      if (!killTimer) finish();
    });
  });

/** A tool could not produce an index. */
export class ScipRunError extends Error {
  constructor(
    message: string,
    /**
     * `"exit"`: the tool ran and failed (another attempt with other inputs may work); `"environment"`: it could
     * not be started or timed out (it would fail again); `"output"`: it left no usable index.
     */
    readonly kind: "exit" | "environment" | "output" = "exit",
  ) {
    super(message);
    this.name = "ScipRunError";
  }
}

/** The last lines of a tool's combined output, for error messages. */
export function outputTail(result: Pick<CommandResult, "stdout" | "stderr">): string {
  const lines = `${result.stderr}\n${result.stdout}`
    .split(/\r?\n|\r/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  return lines.slice(-ERROR_TAIL_LINES).join("\n");
}

/** An error's message on one line: its headline and the first line of the tool output it quotes. */
function summary(error: unknown): string {
  const lines = (error instanceof Error ? error.message : String(error)).split("\n");
  return lines.length > 1 ? `${lines[0]} ${lines[1]}` : lines[0]!;
}

/** Lines that are warnings or errors of a tool run (a few, deduplicated). */
export function extractWarnings(label: string, ...outputs: string[]): string[] {
  const seen = new Set<string>();
  const found: string[] = [];
  const marker = /^(?:\(\d\d:\d\d:\d\d\)\s*)?(?:warn(?:ing)?|error|fatal|panic)\b[:\s]/i;
  for (const line of outputs.join("\n").split(/\r?\n|\r/)) {
    const text = line.trim();
    if (!marker.test(text) || seen.has(text)) continue;
    seen.add(text);
    found.push(`${label}: ${text.length > 300 ? `${text.slice(0, 300)}...` : text}`);
    if (found.length >= MAX_WARNINGS) break;
  }
  return found;
}

// ─── Configuration ────────────────────────────────────────────────────────────────────────────────

export interface ScipRunConfig {
  signal?: AbortSignal;
  /** Per-tool timeout in milliseconds. */
  timeoutMs: number;
  run: CommandRunner;
  /** Directory to create temp directories in (default: the OS temp directory). */
  tempRoot?: string;
  /** Base environment of the tools (default: `process.env`). */
  env?: NodeJS.ProcessEnv;
}

/** The timeout from `XPL_SCIP_TIMEOUT_MS`, else the 10 minute default. */
export function defaultTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.XPL_SCIP_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

export interface ScipRunOutput {
  sources: ScipSource[];
  /** Warning lines the tools printed. */
  warnings: string[];
}

/** Environment for `npx`-run tools: quiet, no prompts, room for big repositories. */
function nodeToolEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
    NO_COLOR: "1",
  };
  if (!/max-old-space-size/.test(env.NODE_OPTIONS ?? "")) {
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --max-old-space-size=4096`.trim();
  }
  return env;
}

function commandName(name: "npx" | "go"): string {
  return process.platform === "win32" && name === "npx" ? "npx.cmd" : name;
}

/** Run one tool and fail with a readable message unless it exited 0. */
async function runTool(
  label: string,
  command: "npx" | "go",
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  cfg: ScipRunConfig,
): Promise<CommandResult> {
  let result: CommandResult;
  try {
    cfg.signal?.throwIfAborted();
    result = await cfg.run(commandName(command), args, {
      cwd,
      env,
      timeoutMs: cfg.timeoutMs,
      signal: cfg.signal,
    });
    cfg.signal?.throwIfAborted();
  } catch (error) {
    cfg.signal?.throwIfAborted();
    const reason = error instanceof Error ? error.message : String(error);
    throw new ScipRunError(
      `${label} could not be started (is \`${command}\` installed and on PATH?): ${reason}`,
      "environment",
    );
  }
  if (result.timedOut) {
    throw new ScipRunError(
      `${label} timed out after ${Math.round(cfg.timeoutMs / 1000)}s (set XPL_SCIP_TIMEOUT_MS to allow more time)`,
      "environment",
    );
  }
  if (result.code !== 0) {
    const tail = outputTail(result);
    throw new ScipRunError(
      `${label} exited with code ${result.code ?? "?"}${tail === "" ? "" : `:\n${tail}`}`,
    );
  }
  return result;
}

async function readIndex(label: string, path: string) {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    throw new ScipRunError(`${label} did not write an index`, "output");
  }
  try {
    return decodeIndex(bytes);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ScipRunError(`${label} wrote an index that cannot be decoded: ${reason}`, "output");
  }
}

async function withTempDir<T>(cfg: ScipRunConfig, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(cfg.tempRoot ?? tmpdir(), "xpl-scip-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ─── TypeScript / JavaScript ──────────────────────────────────────────────────────────────────────

/** Path segments that never hold a project or module we should index. */
const SKIPPED_SEGMENTS = new Set(["node_modules", "vendor", "testdata"]);

/** Is the path inside `node_modules`, `vendor` or `testdata`? The tools do not index those. */
export function inSkippedDir(path: FilePath): boolean {
  return path.split("/").some((segment) => SKIPPED_SEGMENTS.has(segment));
}

function dirOf(path: FilePath): string {
  const dir = posix.dirname(path);
  return dir === "." ? "" : dir;
}

/**
 * The TypeScript projects of a repository, as paths relative to the root for scip-typescript: a directory
 * that holds a `tsconfig.json` (the root is ""), or the `jsconfig.json` of a directory that has no tsconfig.
 * Monorepos have several; a root config that only `references` others is handled by the tool itself.
 */
export function typescriptProjects(files: readonly Pick<IndexedFile, "path">[]): string[] {
  const tsconfigDirs = new Set<string>();
  const jsconfigs = new Map<string, string>();
  for (const { path } of files) {
    if (inSkippedDir(path)) continue;
    const name = posix.basename(path);
    if (name === "tsconfig.json") tsconfigDirs.add(dirOf(path));
    else if (name === "jsconfig.json") jsconfigs.set(dirOf(path), path);
  }
  const projects = [...tsconfigDirs];
  for (const [dir, path] of jsconfigs) if (!tsconfigDirs.has(dir)) projects.push(path);
  return projects.sort();
}

/**
 * Compiler options of the synthetic project for files no tsconfig covers (or repositories without one):
 * permissive module resolution, JavaScript included, no emit.
 */
const SYNTHETIC_COMPILER_OPTIONS = {
  allowJs: true,
  noEmit: true,
  skipLibCheck: true,
  target: "es2022",
  module: "esnext",
  moduleResolution: "bundler",
  jsx: "preserve",
  esModuleInterop: true,
  resolveJsonModule: true,
  allowImportingTsExtensions: true,
};

const TYPESCRIPT_LANGUAGES: ReadonlySet<string> = new Set(["typescript", "tsx", "javascript"]);

/**
 * Run scip-typescript over the projects of `root`. Files of the covered languages that no project includes
 * (all of them when there is no tsconfig at all; scripts, configs and tests outside `include`) get a second
 * pass with a synthetic tsconfig kept in the temp directory, so the repository is never modified and files
 * are not left without references (a resolver replaces the heuristic references of its whole language).
 */
export async function runScipTypescript(
  root: string,
  files: readonly Pick<IndexedFile, "path" | "language">[],
  cfg: ScipRunConfig,
): Promise<ScipRunOutput> {
  const label = `scip-typescript@${SCIP_TYPESCRIPT_VERSION}`;
  const projects = typescriptProjects(files);
  const env = nodeToolEnv(cfg.env ?? process.env);
  const sources: ScipSource[] = [];
  const warnings: string[] = [];

  return withTempDir(cfg, async (dir) => {
    const invoke = async (name: string, projectArgs: readonly string[]): Promise<void> => {
      const output = join(dir, `${name}.scip`);
      const args = [
        "--yes",
        `@sourcegraph/scip-typescript@${SCIP_TYPESCRIPT_VERSION}`,
        "index",
        "--cwd",
        root,
        "--no-progress-bar",
        "--output",
        output,
        ...projectArgs,
      ];
      const result = await runTool(label, "npx", args, root, env, cfg);
      const index = await readIndex(label, output);
      sources.push({ index, pathPrefix: "", defaultEncoding: "utf16", excludesBom: true });
      warnings.push(...extractWarnings(label, result.stderr, result.stdout));
    };

    const described = new Set<FilePath>();
    let projectsFailure: unknown;
    if (projects.length > 0) {
      try {
        await invoke(
          "projects",
          projects.map((project) => (project === "" ? root : join(root, project))),
        );
        for (const doc of sources[0]!.index.documents) {
          const path = documentPath("", doc.relativePath);
          if (path !== undefined) described.add(path);
        }
      } catch (error) {
        // A tsconfig that cannot be loaded (its `extends` package is not installed in a fresh checkout) fails
        // the whole run: index the files with default compiler options instead.
        if (!(error instanceof ScipRunError) || error.kind !== "exit") throw error;
        projectsFailure = error;
        warnings.push(
          `${label}: the tsconfig projects could not be indexed (${summary(error)}); indexing every file with default compiler options instead`,
        );
      }
    }

    const leftover = files
      .filter(
        (f) =>
          TYPESCRIPT_LANGUAGES.has(f.language) && !described.has(f.path) && !inSkippedDir(f.path),
      )
      .map((f) => f.path);
    if (leftover.length > 0) {
      const config = join(dir, "tsconfig.leftover.json");
      await writeFile(
        config,
        JSON.stringify({
          compilerOptions: SYNTHETIC_COMPILER_OPTIONS,
          files: leftover.map((path) => join(root, path)),
        }),
      );
      try {
        await invoke("leftover", [config]);
      } catch (error) {
        if (sources.length === 0) {
          if (projectsFailure === undefined) throw error;
          throw new ScipRunError(
            `${summary(projectsFailure)}; and with default compiler options: ${summary(error)}`,
            "exit",
          );
        }
        warnings.push(
          `${label} could not index the ${leftover.length} file(s) outside the tsconfig projects: ${summary(error)}`,
        );
      }
    }
    if (sources.length === 0) {
      throw (
        projectsFailure ??
        new ScipRunError(`${label} found no TypeScript or JavaScript files to index`, "output")
      );
    }
    return { sources, warnings };
  });
}

// ─── Python ───────────────────────────────────────────────────────────────────────────────────────

/** Package name for `--project-name`: pyproject.toml `[project] name`, setup.cfg `[metadata] name`, else the directory name. */
export function pythonProjectName(
  root: string,
  readText: (path: FilePath) => string | undefined,
): string {
  const fromSection = (text: string | undefined, section: string): string | undefined => {
    if (text === undefined) return undefined;
    const start = new RegExp(`^\\[${section}\\]\\s*$`, "m").exec(text);
    if (!start) return undefined;
    const rest = text.slice(start.index + start[0].length);
    const end = /^\[/m.exec(rest);
    const body = end ? rest.slice(0, end.index) : rest;
    return /^\s*name\s*[=:]\s*["']?([^"'\r\n#]+?)["']?\s*(?:#.*)?$/m.exec(body)?.[1];
  };
  const name =
    fromSection(readText("pyproject.toml"), "project") ??
    fromSection(readText("setup.cfg"), "metadata") ??
    basename(root);
  return (
    name
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project"
  );
}

/** Most source roots handed to scip-python (a repository of hundreds of packages should not build a huge PYTHONPATH). */
const MAX_SOURCE_ROOTS = 64;

/**
 * Directories (relative to the root) that hold top-level Python packages but are not the root itself:
 * `src` of a `src/` layout, `examples/tutorial` of a nested project. `import flask` in `tests/` only resolves
 * to `src/flask` when `src` is on the module search path, which pyright (scip-python) only knows through the
 * interpreter's `sys.path`, i.e. `PYTHONPATH`.
 */
export function pythonSourceRoots(
  files: readonly Pick<IndexedFile, "path" | "language">[],
): string[] {
  const python = files.filter((f) => f.language === "python" && !inSkippedDir(f.path));
  const packageDirs = new Set(
    python.filter((f) => posix.basename(f.path) === "__init__.py").map((f) => dirOf(f.path)),
  );
  const roots = new Set<string>();
  for (const dir of packageDirs) {
    let top = dir;
    while (top !== "" && packageDirs.has(dirOf(top))) top = dirOf(top);
    // `top` is the outermost package directory of this chain: its parent is the source root
    if (top !== "" && dirOf(top) !== "") roots.add(dirOf(top));
  }
  // `src` is a source root even when its packages are namespace packages (no __init__.py)
  if (python.some((f) => f.path.startsWith("src/"))) roots.add("src");
  return [...roots].sort().slice(0, MAX_SOURCE_ROOTS);
}

/** Run scip-python over `root`. */
export async function runScipPython(
  root: string,
  files: readonly Pick<IndexedFile, "path" | "language">[],
  readText: (path: FilePath) => string | undefined,
  cfg: ScipRunConfig,
): Promise<ScipRunOutput> {
  const label = `scip-python@${SCIP_PYTHON_VERSION}`;
  return withTempDir(cfg, async (dir) => {
    const output = join(dir, "index.scip");
    // An empty environment: no dependency on pip metadata (scip-python would otherwise shell out to pip).
    const environment = join(dir, "environment.json");
    await writeFile(environment, "[]\n");
    const args = [
      "--yes",
      `@sourcegraph/scip-python@${SCIP_PYTHON_VERSION}`,
      "index",
      "--cwd",
      root,
      "--project-name",
      pythonProjectName(root, readText),
      // Without a version scip-python crashes outside git repositories.
      "--project-version",
      "0.0.0",
      "--environment",
      environment,
      "--quiet",
      "--output",
      output,
    ];
    const env = nodeToolEnv(cfg.env ?? process.env);
    const roots = pythonSourceRoots(files).map((r) => join(root, r));
    if (roots.length > 0) {
      env.PYTHONPATH = [...roots, ...(env.PYTHONPATH ? [env.PYTHONPATH] : [])].join(delimiter);
    }
    const result = await runTool(label, "npx", args, root, env, cfg);
    const index = await readIndex(label, output);
    return {
      sources: [{ index, pathPrefix: "", defaultEncoding: "utf16" as const }],
      warnings: extractWarnings(label, result.stderr, result.stdout),
    };
  });
}

// ─── Go ───────────────────────────────────────────────────────────────────────────────────────────

/** Directories (relative to the root, "" = the root) with a `go.mod`, skipping vendored and test data copies. */
export function goModules(files: readonly Pick<IndexedFile, "path">[]): string[] {
  const dirs = new Set<string>();
  for (const file of files) {
    if (posix.basename(file.path) === "go.mod" && !inSkippedDir(file.path)) {
      dirs.add(dirOf(file.path));
    }
  }
  return [...dirs].sort();
}

/** Copy the source tree before allowing Go to update module/workspace metadata.
 * Dereference symlinks: a metadata symlink must not give Go a writable route back to the source.
 * Relative local replacements outside the root keep pointing at their original dependency location.
 */
async function copyGoTree(
  root: string,
  destination: string,
  temp: string,
  files: readonly Pick<IndexedFile, "path">[],
): Promise<void> {
  await cp(root, destination, {
    recursive: true,
    dereference: true,
    filter: (source) =>
      source !== temp && ![".git", ".explainer", "node_modules"].includes(basename(source)),
  });
  for (const file of files) {
    if (!["go.mod", "go.work"].includes(posix.basename(file.path)) || inSkippedDir(file.path))
      continue;
    const path = join(destination, file.path);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    // Go module paths cannot contain whitespace; quoted local replacement paths can.
    text = text.replace(
      /(=>\s*)("(?:[^"\\]|\\.)*"|[^\s]+)(?=\s|$)/g,
      (match, arrow: string, token: string) => {
        const target: string = token.startsWith('"') ? JSON.parse(token) : token;
        if (!isAbsolute(target) && !target.startsWith("./") && !target.startsWith("../"))
          return match;
        const absolute = resolvePath(root, posix.dirname(file.path), target);
        const within = relative(root, absolute);
        if (within !== ".." && !within.startsWith(".." + sep) && !isAbsolute(within)) {
          return isAbsolute(target) ? arrow + JSON.stringify(join(destination, within)) : match;
        }
        return arrow + JSON.stringify(absolute);
      },
    );
    if (posix.basename(file.path) === "go.work") {
      // Workspace members are main modules, which Go may edit. Never leave a use path pointing
      // back into the original tree or into a sibling checkout outside the private copy.
      const tokens = [
        ...text.matchAll(/"(?:[^"\\]|\\.)*"|`[^`]*`|\/\/[^\n]*|[()]|[^\s()]+/g),
      ].filter((t) => !t[0].startsWith("//"));
      const replacements: { start: number; end: number; text: string }[] = [];
      for (let i = 0; i < tokens.length; i++) {
        if (tokens[i]![0] !== "use") continue;
        const block = tokens[i + 1]?.[0] === "(";
        let next = i + (block ? 2 : 1);
        do {
          const token = tokens[next];
          if (!token || token[0] === ")") break;
          const value = token[0];
          const target: string = value.startsWith('"')
            ? JSON.parse(value)
            : value.startsWith("`")
              ? value.slice(1, -1)
              : value;
          const absolute = resolvePath(root, posix.dirname(file.path), target);
          const within = relative(root, absolute);
          if (within === ".." || within.startsWith(".." + sep) || isAbsolute(within)) {
            throw new ScipRunError(
              "go.work uses a module outside the indexed root: include the workspace in the root or set GOWORK=off",
              "environment",
            );
          }
          replacements.push({
            start: token.index,
            end: token.index + value.length,
            text: JSON.stringify(join(destination, within)),
          });
          next++;
        } while (block);
        i = next - 1;
      }
      for (const replacement of replacements.reverse()) {
        text = text.slice(0, replacement.start) + replacement.text + text.slice(replacement.end);
      }
    }
    await writeFile(path, text);
  }
}

/** Run scip-go once per Go module of the repository. Any module failing fails the whole run. */
export async function runScipGo(
  root: string,
  files: readonly Pick<IndexedFile, "path">[],
  cfg: ScipRunConfig,
): Promise<ScipRunOutput> {
  const label = `scip-go@${SCIP_GO_VERSION}`;
  const modules = goModules(files);
  if (modules.length === 0) {
    throw new ScipRunError("no go.mod found: scip-go indexes Go modules");
  }
  const base = cfg.env ?? process.env;
  // `-mod=mod` lets scip-go load modules whose go.sum lacks entries, but the go command refuses it in
  // workspace mode (a repository with a go.work keeps its workspace, which also resolves the modules'
  // references to each other) and it would bypass a vendor directory, which loads without network access.
  const workspace =
    base.GOWORK !== "off" &&
    files.some((f) => posix.basename(f.path) === "go.work" && !inSkippedDir(f.path));
  const envFor = (moduleDir: string): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...base, NO_COLOR: "1" };
    const vendored = existsSync(join(moduleDir, "vendor", "modules.txt"));
    if (!workspace && !vendored) {
      env.GOFLAGS = `${base.GOFLAGS ? `${base.GOFLAGS} ` : ""}-mod=mod`;
    }
    return env;
  };
  const sources: ScipSource[] = [];
  const warnings: string[] = [];
  await withTempDir(cfg, async (dir) => {
    const snapshot = join(dir, "source");
    await copyGoTree(
      root,
      snapshot,
      dir,
      base.GOWORK === "off" ? files.filter((f) => posix.basename(f.path) !== "go.work") : files,
    );
    const env = { ...base };
    if (base.GOWORK && base.GOWORK !== "off" && base.GOWORK !== "auto") {
      const work = relative(root, resolvePath(root, base.GOWORK));
      if (work === ".." || work.startsWith(".." + sep) || isAbsolute(work)) {
        throw new ScipRunError(
          "GOWORK points outside the indexed root: include the workspace in the root or set GOWORK=off",
          "environment",
        );
      }
      env.GOWORK = join(snapshot, work);
    }
    for (const [i, module] of modules.entries()) {
      const moduleDir = module === "" ? snapshot : join(snapshot, module);
      const output = join(dir, `module-${i}.scip`);
      const result = await runTool(
        module === "" ? label : `${label} (${module})`,
        "go",
        ["run", `${SCIP_GO_PACKAGE}@${SCIP_GO_VERSION}`, "index", "--output", output],
        moduleDir,
        { ...envFor(moduleDir), ...(env.GOWORK ? { GOWORK: env.GOWORK } : {}) },
        cfg,
      );
      const index = await readIndex(label, output);
      sources.push({ index, pathPrefix: module, defaultEncoding: "utf8" });
      warnings.push(...extractWarnings(label, result.stderr, result.stdout));
    }
  });
  return { sources, warnings };
}
