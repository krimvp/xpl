import { statSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { GRAMMAR_IDS, createParser, getWasmDir, initParser, type GrammarId } from "@xpl/indexer";
import pkg from "../package.json" with { type: "json" };
import { GLOBAL_OPTIONS, parseCommandArgs, type OptionDefs } from "./args.js";
import type { CommandSpec } from "./command.js";
import { anchorsCommand } from "./commands/anchors.js";
import { applyCommand } from "./commands/apply.js";
import { indexCommand } from "./commands/build-index.js";
import { bundleCommand } from "./commands/bundle.js";
import { changeCommand } from "./commands/change.js";
import { draftCommand } from "./commands/draft.js";
import { feedbackCommand } from "./commands/feedback.js";
import { lintCommand } from "./commands/lint.js";
import { newCommand } from "./commands/new.js";
import { outlineCommand } from "./commands/outline.js";
import { refsCommand } from "./commands/refs.js";
import { resolveCommand } from "./commands/resolve.js";
import { searchCommand } from "./commands/search.js";
import { showCommand } from "./commands/show.js";
import { statusCommand } from "./commands/status.js";
import { validateCommand } from "./commands/validate.js";
import { viewCommand } from "./commands/view.js";
import { createCtx, type Io } from "./context.js";
import { CliError, UsageError, errorMessage } from "./errors.js";

export type { CommandSpec } from "./command.js";
export type { Io } from "./context.js";

/** The commands of ARCHITECTURE.md §5, in the order of its table (`lint`, `change` and `draft` added after `status`). */
export const COMMANDS: readonly CommandSpec[] = [
  indexCommand,
  outlineCommand,
  showCommand,
  refsCommand,
  searchCommand,
  newCommand,
  applyCommand,
  validateCommand,
  anchorsCommand,
  resolveCommand,
  statusCommand,
  feedbackCommand,
  lintCommand,
  changeCommand,
  draftCommand,
  viewCommand,
  bundleCommand,
];

const defaultIo: Io = {
  out: (text) => process.stdout.write(text + "\n"),
  err: (text) => process.stderr.write(text + "\n"),
};

// ─── Help ───────────────────────────────────────────────────────────────────────────────────────

function optionRows(options: OptionDefs): string[] {
  const rows = Object.entries(options).map(([name, def]) => {
    const flag = `${def.short ? `-${def.short}, ` : ""}--${name}${def.arg ? ` ${def.arg}` : ""}`;
    return { flag, desc: def.desc };
  });
  const width = Math.max(0, ...rows.map((row) => row.flag.length));
  return rows.map((row) => `  ${row.flag.padEnd(width)}  ${row.desc}`);
}

function helpText(): string {
  const width = Math.max(...COMMANDS.map((command) => command.name.length));
  const rows = COMMANDS.map((command) => `  ${command.name.padEnd(width)}  ${command.summary}`);
  return [
    `xpl ${pkg.version} - code explainer`,
    "",
    "Usage: xpl <command> [options]",
    "",
    "Commands:",
    ...rows,
    "",
    "Global options:",
    ...optionRows(GLOBAL_OPTIONS),
    "",
    "<id> arguments accept sym:..., file:..., dir:..., src/a.ts#A.b and src/a.ts.",
    "Environment: XPL_VIEWER_HTML=<file> overrides the viewer page (view, bundle); XPL_SKIP_STALE_CHECK=1 skips",
    "the comparison of the index with the working tree (about a second per 5000 files); XPL_WASM_DIR, XPL_DEBUG.",
    "Typical use: xpl index; xpl outline; xpl show <id> --refs; xpl new <name>; xpl apply <name> patch.json;",
    "xpl lint <name>; xpl view <name>. Exit codes: 0 ok, 1 rejected or failed, 2 usage error.",
    "See docs/ARCHITECTURE.md section 5.",
    'Run "xpl <command> --help" for a command\'s options.',
  ].join("\n");
}

function commandHelp(command: CommandSpec): string {
  return [
    `Usage: ${command.usage}`,
    "",
    command.summary,
    ...(command.details ? ["", ...command.details] : []),
    ...(Object.keys(command.options).length > 0
      ? ["", "Options:", ...optionRows(command.options)]
      : []),
    "",
    "Global options:",
    ...optionRows(GLOBAL_OPTIONS),
  ].join("\n");
}

// ─── Hidden smoke test ──────────────────────────────────────────────────────────────────────────

/**
 * Hidden `xpl __smoke`: load every tree-sitter grammar (from `dist/wasm` when running the bundle)
 * and parse a tiny snippet with each. Proves the bundle and its wasm files work.
 */
async function smoke(io: Io): Promise<number> {
  const samples: Record<GrammarId, { source: string; root: string }> = {
    typescript: { source: "export const a = 1;\n", root: "program" },
    tsx: { source: "const el = <div />;\n", root: "program" },
    python: { source: "x = 1\n", root: "module" },
    rust: { source: "fn main() {}\n", root: "source_file" },
    go: { source: "package main\n", root: "source_file" },
    yaml: { source: "a: 1\n", root: "stream" },
    json: { source: '{"a": 1}\n', root: "document" },
    toml: { source: "a = 1\n", root: "document" },
  };
  io.out(`wasm dir: ${getWasmDir() ?? "(node_modules)"}`);
  await initParser();
  let failures = 0;
  for (const id of GRAMMAR_IDS) {
    const { source, root } = samples[id];
    const parser = await createParser(id);
    const tree = parser.parse(source);
    const actual = tree?.rootNode.type;
    const ok = actual === root && tree?.rootNode.hasError === false;
    io.out(`${ok ? "ok  " : "FAIL"} ${id.padEnd(10)} root=${actual ?? "(no tree)"}`);
    if (!ok) failures++;
    tree?.delete();
    parser.delete();
  }
  return failures === 0 ? 0 : 1;
}

// ─── Dispatch ───────────────────────────────────────────────────────────────────────────────────

/** Is `--json` among the arguments (before a `--` terminator)? Errors need it before parsing worked. */
function wantsJson(argv: readonly string[]): boolean {
  const end = argv.indexOf("--");
  return (end === -1 ? argv : argv.slice(0, end)).includes("--json");
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row.push(
        Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)),
      );
    }
    prev = row;
  }
  return prev[b.length]!;
}

function unknownCommand(name: string): UsageError {
  const near = COMMANDS.filter(
    (c) => c.name.startsWith(name) || name.startsWith(c.name) || editDistance(c.name, name) <= 2,
  );
  return new UsageError(
    `unknown command "${name}"` +
      (near.length > 0 ? `. Did you mean: ${near.map((c) => c.name).join(", ")}?` : "") +
      `. Run "xpl --help" for the list of commands.`,
  );
}

async function dispatch(argv: string[], io: Io): Promise<number> {
  // Pass 1: only the global options, to find the command name and the help/version flags.
  const globalConfig = Object.fromEntries(
    Object.entries(GLOBAL_OPTIONS).map(([name, def]) => [
      name,
      { type: def.type, ...(def.short ? { short: def.short } : {}) },
    ]),
  );
  const first = parseArgs({
    args: argv,
    options: globalConfig,
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const nameToken = first.tokens?.find((token) => token.kind === "positional");
  const name = nameToken?.kind === "positional" ? nameToken.value : undefined;

  if (first.values.version === true) {
    io.out(pkg.version);
    return 0;
  }
  if (name === undefined) {
    if (first.values.help === true) {
      io.out(helpText());
      return 0;
    }
    io.err(helpText());
    return 2;
  }
  if (name === "help") {
    const topic = first.positionals[1];
    const command = topic === undefined ? undefined : COMMANDS.find((c) => c.name === topic);
    if (topic !== undefined && !command) throw unknownCommand(topic);
    io.out(command ? commandHelp(command) : helpText());
    return 0;
  }
  if (name === "__smoke") return smoke(io);
  const command = COMMANDS.find((candidate) => candidate.name === name);
  if (!command) throw unknownCommand(name);
  if (first.values.help === true) {
    io.out(commandHelp(command));
    return 0;
  }

  // Pass 2: the command's own options, strictly.
  const rest = argv.filter((_, i) => i !== nameToken!.index);
  let args;
  try {
    args = parseCommandArgs(rest, command.options, command.positionals);
  } catch (error) {
    if (error instanceof UsageError) error.usage ??= command.usage;
    throw error;
  }

  const cwd = resolve(io.cwd ?? process.cwd());
  const rootOption = args.str("root");
  const root = resolve(cwd, rootOption ?? ".");
  try {
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new UsageError(`--root ${rootOption ?? "."}: ${root} is not a directory`, command.usage);
  }
  const ctx = createCtx(io, {
    root,
    cwd,
    env: io.env ?? process.env,
    json: args.flag("json"),
    indexOption: args.str("index"),
  });
  try {
    return await command.run(ctx, args);
  } catch (error) {
    if (error instanceof UsageError) error.usage ??= command.usage;
    throw error;
  }
}

function reportError(io: Io, json: boolean, error: unknown): number {
  if (error instanceof CliError) {
    if (json) {
      io.out(
        JSON.stringify(
          {
            ok: false,
            error: error.message,
            ...(error instanceof UsageError && error.usage ? { usage: error.usage } : {}),
            ...error.extra,
          },
          null,
          2,
        ),
      );
    } else {
      io.err(`error: ${error.message}`);
      if (error instanceof UsageError && error.usage) {
        io.err(`usage: ${error.usage}`);
        io.err(`Run "xpl ${error.usage.split(/\s+/)[1] ?? ""} --help" for details.`);
      }
    }
    return error.exitCode;
  }
  const message = errorMessage(error);
  if (json) io.out(JSON.stringify({ ok: false, error: message }, null, 2));
  else {
    io.err(`error: ${message}`);
    if (process.env.XPL_DEBUG && error instanceof Error) io.err(error.stack ?? "");
  }
  return 1;
}

/** Run the CLI; resolves to the process exit code. */
export async function run(argv: string[], io: Io = defaultIo): Promise<number> {
  try {
    return await dispatch(argv, io);
  } catch (error) {
    return reportError(io, wantsJson(argv), error);
  }
}
