/**
 * What every command gets: where to print, the repository root, and the global options.
 *
 * `Io` is the only thing that touches the process, so tests (and `xpl view` in tests) run commands
 * in-process: they pass their own `out`/`err`, a `cwd`, an `env`, an abort `signal` and a stdin reader.
 */
import type { ViewServer } from "./server.js";

export type Env = Record<string, string | undefined>;

export interface Io {
  out(text: string): void;
  err(text: string): void;
  /** Working directory (default `process.cwd()`). */
  cwd?: string;
  /** Environment (default `process.env`). Read: `XPL_VIEWER_HTML`. */
  env?: Env;
  /** `xpl view` stops serving and `xpl index` cancels when this aborts (default: on SIGINT / SIGTERM). */
  signal?: AbortSignal;
  /** Whether stderr is an interactive terminal (progress stays off otherwise). */
  isTTY?: boolean;
  /** Source of `xpl apply <explainer> -` (default: process.stdin). */
  readStdin?(): Promise<string>;
  /** Called by `xpl view` once the server is listening (tests use it to reach the server). */
  onServer?(server: ViewServer): void;
}

/** The part of the context the repository helpers (index selection, explainer lookup) need. */
export interface RepoEnv {
  /** Absolute repository root. */
  root: string;
  /** Absolute working directory (relative paths given on the command line resolve against it). */
  cwd: string;
  env: Env;
  /** `--index <path>` as typed, if any. */
  indexOption: string | undefined;
  /** Report something the user should know but that does not stop the command. */
  warn(message: string): void;
}

export interface Ctx extends RepoEnv {
  io: Io;
  json: boolean;
  /** Warnings collected so far (JSON mode puts them into the result object). */
  warnings: string[];
  /** Print human-readable text (one or more lines). */
  out(text: string): void;
  /** Print a JSON result: `{ ok: true, ...data, warnings? }`. */
  emit(data: Record<string, unknown>): void;
}

export function createCtx(
  io: Io,
  opts: { root: string; cwd: string; env: Env; json: boolean; indexOption: string | undefined },
): Ctx {
  const warnings: string[] = [];
  const ctx: Ctx = {
    io,
    root: opts.root,
    cwd: opts.cwd,
    env: opts.env,
    json: opts.json,
    indexOption: opts.indexOption,
    warnings,
    out: (text) => io.out(text),
    warn: (message) => {
      warnings.push(message);
      if (!opts.json) io.err(`warning: ${message}`);
    },
    emit: (data) => {
      io.out(
        JSON.stringify(
          { ok: true, ...data, ...(warnings.length > 0 ? { warnings } : {}) },
          null,
          2,
        ),
      );
    },
  };
  return ctx;
}
