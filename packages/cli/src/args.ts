/**
 * Command-line parsing on top of `node:util` `parseArgs`. Every command declares its options; the
 * global ones (`--root`, `--json`, `--index`, `-h`, `-v`) are added to all of them, so they may appear
 * before or after the command name.
 */
import { parseArgs } from "node:util";
import { UsageError } from "./errors.js";

export interface OptionDef {
  type: "boolean" | "string";
  short?: string;
  multiple?: boolean;
  /** Placeholder shown in help for options with a value, e.g. `<n>`. */
  arg?: string;
  desc: string;
}
export type OptionDefs = Record<string, OptionDef>;

export const GLOBAL_OPTIONS: OptionDefs = {
  root: { type: "string", arg: "<dir>", desc: "Repository root (default: current directory)" },
  json: { type: "boolean", desc: "Machine-readable JSON output" },
  index: {
    type: "string",
    arg: "<path>",
    desc: "Symbol index to use (default: the index of the current commit id, else the newest)",
  },
  help: { type: "boolean", short: "h", desc: "Show help" },
  version: { type: "boolean", short: "v", desc: "Show the version" },
};

type Value = string | boolean | (string | boolean)[] | undefined;

/** Parsed options and positionals of one command, with typed accessors that raise usage errors. */
export class Args {
  constructor(
    private readonly values: Record<string, Value>,
    readonly positionals: string[],
  ) {}

  flag(name: string): boolean {
    return this.values[name] === true;
  }

  str(name: string): string | undefined {
    const value = this.values[name];
    return typeof value === "string" ? value : undefined;
  }

  /** Every occurrence of a repeatable option; each value may itself be comma-separated. */
  list(name: string): string[] {
    const value = this.values[name];
    const raw = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
    return raw
      .filter((v): v is string => typeof v === "string")
      .flatMap((v) => v.split(","))
      .map((v) => v.trim())
      .filter((v) => v !== "");
  }

  /** A non-negative integer option, or undefined when not given. */
  int(name: string, bounds: { min?: number; max?: number } = {}): number | undefined {
    const raw = this.str(name);
    if (raw === undefined) return undefined;
    const value = /^\d+$/.test(raw.trim()) ? Number(raw) : Number.NaN;
    const min = bounds.min ?? 0;
    const max = bounds.max ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isInteger(value) || value < min || value > max) {
      const need =
        max === Number.MAX_SAFE_INTEGER
          ? min === 0
            ? "a non-negative integer"
            : `an integer >= ${min}`
          : `an integer between ${min} and ${max}`;
      throw new UsageError(`--${name} must be ${need} (got "${raw}")`);
    }
    return value;
  }

  choice<T extends string>(name: string, allowed: readonly T[]): T | undefined {
    const raw = this.str(name);
    if (raw === undefined) return undefined;
    if (!(allowed as readonly string[]).includes(raw)) {
      throw new UsageError(`--${name} must be one of ${allowed.join(", ")} (got "${raw}")`);
    }
    return raw as T;
  }
}

export interface PositionalSpec {
  name: string;
  required?: boolean;
  /** Absorbs every remaining positional. */
  rest?: boolean;
}

/** Parses `argv` (the command name already removed) against a command's option table. */
export function parseCommandArgs(
  argv: readonly string[],
  options: OptionDefs,
  positionals: readonly PositionalSpec[],
): Args {
  const all: OptionDefs = { ...GLOBAL_OPTIONS, ...options };
  const config: Record<string, { type: "boolean" | "string"; short?: string; multiple?: boolean }> =
    {};
  for (const [name, def] of Object.entries(all)) {
    config[name] = {
      type: def.type,
      ...(def.short !== undefined ? { short: def.short } : {}),
      ...(def.multiple ? { multiple: true } : {}),
    };
  }
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options: config, allowPositionals: true, strict: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const unknown = /Unknown option '([^']+)'/.exec(message);
    throw new UsageError(
      unknown
        ? `unknown option ${unknown[1]} (a value that starts with "-" must come after "--")`
        : message.replace(/\. To specify a positional argument.*$/s, ""),
    );
  }
  const given = parsed.positionals;
  const required = positionals.filter((p) => p.required !== false && !p.rest);
  if (given.length < required.length) {
    const missing = required[given.length]!;
    throw new UsageError(`missing <${missing.name}>`);
  }
  const hasRest = positionals.some((p) => p.rest);
  if (!hasRest && given.length > positionals.length) {
    throw new UsageError(`unexpected argument "${given[positionals.length]}"`);
  }
  return new Args(parsed.values as Record<string, Value>, given);
}
