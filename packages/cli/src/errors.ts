/**
 * Errors the commands throw. `run()` (cli.ts) turns them into a message on stderr (or a JSON object
 * with `--json`) and an exit code: 1 for failures (validation or apply rejected, unknown id, no index,
 * unreadable file), 2 for usage errors (unknown command or option, missing argument, bad value).
 */

export class CliError extends Error {
  readonly exitCode: number;
  /** Extra fields for the `--json` error object (candidates, issues, ...). */
  readonly extra: Record<string, unknown>;

  constructor(message: string, exitCode = 1, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.extra = extra;
  }
}

/** Wrong command line. `usage` is filled in by the dispatcher when the command did not set it. */
export class UsageError extends CliError {
  usage: string | undefined;

  constructor(message: string, usage?: string) {
    super(message, 2);
    this.name = "UsageError";
    this.usage = usage;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
