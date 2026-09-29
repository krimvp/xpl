/**
 * Test helpers: temp copies of the fixture repos, and `invoke`, which runs the CLI in-process with
 * captured output (the same `run()` the bin uses, so exit codes and messages are the real ones).
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";
import { run, type Io } from "../src/cli.js";
import type { ViewServer } from "../src/server.js";

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = resolve(here, "..", "..", "..", "fixtures");
export const PATCH_PATH = join(here, "fixtures", "ts-example.patch.json");

/** A minimal viewer page, so tests never depend on the viewer build. */
export const STUB_VIEWER_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>stub viewer</title></head><body><div id="root"></div></body></html>';

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export function makeTempDir(prefix = "xpl-cli-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** A fresh copy of a fixture repo (without `.explainer/` and `node_modules`). */
export function copyFixture(name = "ts-jobrunner"): string {
  const dir = makeTempDir(`xpl-cli-${name}-`);
  cpSync(join(FIXTURES_DIR, name), dir, {
    recursive: true,
    filter: (source) => !/[\\/](\.explainer|node_modules)([\\/]|$)/.test(source),
  });
  return dir;
}

/** A fresh copy of `dir` (an already indexed copy, say). */
export function cloneDir(dir: string): string {
  const copy = makeTempDir();
  cpSync(dir, copy, { recursive: true });
  return copy;
}

export function writeFile(root: string, path: string, text: string): string {
  const abs = join(root, ...path.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  return abs;
}

export function readFile(root: string, path: string): string {
  return readFileSync(join(root, ...path.split("/")), "utf8");
}

export function readJson<T = any>(root: string, path: string): T {
  return JSON.parse(readFile(root, path)) as T;
}

/** Replaces the text of a working-tree file (must contain `from` exactly once). */
export function editFile(root: string, path: string, edit: (text: string) => string): void {
  writeFile(root, path, edit(readFile(root, path)));
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  }).trim();
}

export interface Invocation {
  code: number;
  out: string;
  err: string;
}

export interface InvokeOptions {
  /** Working directory of the command (default: the temp root given via `--root`, else the repo). */
  cwd?: string;
  stdin?: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  onServer?: (server: ViewServer) => void;
}

/** Runs `xpl <argv>` in-process. `cwd` is where relative paths resolve; pass `--root` in `argv`. */
export async function invoke(argv: string[], opts: InvokeOptions = {}): Promise<Invocation> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, ...opts.env },
    ...(opts.stdin !== undefined ? { readStdin: async () => opts.stdin! } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.onServer ? { onServer: opts.onServer } : {}),
  };
  const code = await run(argv, io);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/** `xpl` run in `root` (as the working directory), like a person in a shell. */
export function xpl(root: string, ...argv: string[]): Promise<Invocation> {
  return invoke(argv, { cwd: root });
}

/** What every `--json` result carries besides the command's own fields. */
export interface JsonEnvelope {
  ok: boolean;
  warnings?: string[];
  error?: string;
}

/** Runs with `--json` and parses stdout. */
export async function xplJson<T = any>(
  root: string,
  ...argv: string[]
): Promise<Invocation & { json: T & JsonEnvelope }> {
  const result = await xpl(root, ...argv, "--json");
  return { ...result, json: JSON.parse(result.out) as T & JsonEnvelope };
}

/**
 * A fresh copy of the TS fixture with its index built: the starting point of most tests. Built once per
 * call site (indexing takes about a second), so tests that mutate should `cloneDir` it.
 */
export async function indexedFixture(name = "ts-jobrunner"): Promise<string> {
  const dir = copyFixture(name);
  const result = await xpl(dir, "index", "--precise", "off");
  if (result.code !== 0) throw new Error(`xpl index failed: ${result.err}\n${result.out}`);
  return dir;
}

/** The viewer stub as a file, for `XPL_VIEWER_HTML`. */
export function writeViewerStub(): string {
  const dir = makeTempDir("xpl-viewer-");
  return writeFile(dir, "viewer.html", STUB_VIEWER_HTML);
}
