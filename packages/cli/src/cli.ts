import { statSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { GRAMMAR_IDS, createParser, getWasmDir, initParser, type GrammarId } from "@xpl/indexer";
import pkg from "../package.json" with { type: "json" };
import { editDistance, GLOBAL_OPTIONS, parseCommandArgs, type OptionDefs } from "./args.js";
import type { CommandSpec } from "./command.js";
import { anchorsCommand } from "./commands/anchors.js";
import { applyCommand } from "./commands/apply.js";
import { indexCommand } from "./commands/build-index.js";
import { bundleCommand } from "./commands/bundle.js";
import { stageCommand } from "./commands/stage.js";
import { changeCommand } from "./commands/change.js";
import { prCommand } from "./commands/pr.js";
import { draftCommand } from "./commands/draft.js";
import { feedbackCommand } from "./commands/feedback.js";
import { doctorCommand } from "./commands/doctor.js";
import { skillCommand } from "./commands/skill.js";
import { completionCommand } from "./commands/completion.js";
import { lintCommand } from "./commands/lint.js";
import { newCommand } from "./commands/new.js";
import { outlineCommand } from "./commands/outline.js";
import { readyCommand } from "./commands/ready.js";
import { reviseCommand } from "./commands/revise.js";
import { refsCommand } from "./commands/refs.js";
import { resolveCommand } from "./commands/resolve.js";
import { searchCommand } from "./commands/search.js";
import { guidesCommand } from "./commands/guides.js";
import { healthCommand } from "./commands/health.js";
import { showCommand } from "./commands/show.js";
import { statusCommand } from "./commands/status.js";
import { startCommand } from "./commands/start.js";
import { updateCommand } from "./commands/update.js";
import { validateCommand } from "./commands/validate.js";
import { viewCommand } from "./commands/view.js";
import { serviceCommand } from "./commands/service.js";
import { createCtx, type Io } from "./context.js";
import { CliError, UsageError, errorMessage } from "./errors.js";

export type { CommandSpec } from "./command.js";
export type { Io } from "./context.js";

/** The commands of ARCHITECTURE.md §5, in the order of its table (`lint`, `health`, `change` and `draft` added after `status`). */
export const COMMANDS: readonly CommandSpec[] = [
  indexCommand,
  outlineCommand,
  showCommand,
  refsCommand,
  searchCommand,
  guidesCommand,
  startCommand,
  updateCommand,
  newCommand,
  applyCommand,
  validateCommand,
  anchorsCommand,
  resolveCommand,
  statusCommand,
  feedbackCommand,
  reviseCommand,
  lintCommand,
  readyCommand,
  healthCommand,
  changeCommand,
  prCommand,
  draftCommand,
  viewCommand,
  serviceCommand,
  bundleCommand,
  stageCommand,
  doctorCommand,
  skillCommand,
  completionCommand(() => COMMANDS),
];

const defaultIo: Io = {
  isTTY: process.stderr.isTTY === true,
  out: (text) => process.stdout.write(text + "\n"),
  err: (text) => process.stderr.write(text + "\n"),
};

// ─── Help ───────────────────────────────────────────────────────────────────────────────────────

const DOCS_URL = "https://krimvp.github.io/xpl/docs/reference/";
const DOCS_REFERENCE = `Docs: ${DOCS_URL}`;

const HELP_WIDTH = 110;

/**
 * Wraps one help line at HELP_WIDTH columns. A continuation lines up under the text it continues: the
 * second column of a table row (`  --flag <x>  text`, `  name  text`), the text of a `- ` bullet, or the
 * line's own indent.
 */
function wrapHelpLine(line: string, hang?: number): string[] {
  if (line.length <= HELP_WIDTH) return [line];
  const table = /^ *\S(?:\S| (?! ))* {2,}/.exec(line)?.[0].length;
  const column = table !== undefined && table <= 60 ? table : undefined;
  const bullet = /^( *- )/.exec(line)?.[1]!.length;
  const indent = " ".repeat(hang ?? column ?? bullet ?? /^ */.exec(line)![0].length);
  const lines: string[] = [];
  let rest = line;
  while (rest.length > HELP_WIDTH) {
    const cut = rest.lastIndexOf(" ", HELP_WIDTH);
    if (cut <= indent.length) break;
    lines.push(rest.slice(0, cut).trimEnd());
    rest = indent + rest.slice(cut + 1).trimStart();
  }
  return [...lines, rest];
}

/**
 * Wraps hand-wrapped help paragraphs: what does not fit on a line moves to the start of the next line when
 * that one continues the same text (same indent, not an option, a bullet or a table row), so a paragraph
 * reflows instead of leaving one word on a line of its own.
 */
function wrapHelp(lines: readonly string[]): string[] {
  const out: string[] = [];
  const todo = [...lines];
  const indentOf = (line: string) => /^ */.exec(line)![0].length;
  const continuation = (line: string | undefined): line is string =>
    line !== undefined &&
    /^ *(?:[^\s-]|--?\w)/.test(line) &&
    !/^ *(?:Exit codes?:|xpl |\$ )/.test(line) &&
    !/^ *\S(?:\S| (?! ))* {2,}/.test(line);
  for (let i = 0; i < todo.length; i++) {
    let line = todo[i]!;
    // a line that stops inside a sentence takes the rest of its paragraph, so the paragraph wraps as a whole
    // (no short line in the middle, no word left alone on a line)
    while (
      /[^.:;!?]$/.test(line) &&
      !/^ *(?:xpl |\$ )/.test(line) &&
      continuation(todo[i + 1]) &&
      indentOf(todo[i + 1]!) === indentOf(line) &&
      (/^ *- /.test(line) ? false : true)
    ) {
      line = `${line} ${todo[i + 1]!.trimStart()}`;
      todo.splice(i + 1, 1);
    }
    const next = todo[i + 1];
    // `Head: text` over indented lines that continue it: wrap the head under that indent too.
    const hang = continuation(next) && indentOf(next) > indentOf(line) ? indentOf(next) : undefined;
    const pieces = wrapHelpLine(line, hang);
    const last = pieces[pieces.length - 1]!;
    // the end of a wrapped line moves onto the next line of its paragraph when it ends inside a sentence, or when
    // it is too short to stand alone; a full sentence ending keeps its own line
    const continues =
      pieces.length > 1 &&
      continuation(next) &&
      indentOf(next) === indentOf(last) &&
      (/[^.:;!?]$/.test(last) || last.trim().length < 40);
    if (continues) {
      todo[i + 1] = `${last} ${next.trimStart()}`;
      pieces.pop();
    }
    out.push(...pieces);
  }
  return out;
}

/**
 * `Usage: xpl x ...`, one alternative (`a | xpl x b`) per line, each wrapped under its arguments and
 * never inside a `[...]` or `<...>` group.
 */
function usageLines(usage: string): string[] {
  return usage.split(" | xpl ").flatMap((form, i) => {
    const words: string[] = [];
    let depth = 0;
    for (const part of (i === 0 ? form : `xpl ${form}`).split(" ")) {
      if (depth > 0) words[words.length - 1] += ` ${part}`;
      else words.push(part);
      depth += (part.match(/[[<]/g)?.length ?? 0) - (part.match(/[\]>]/g)?.length ?? 0);
    }
    const head = i === 0 ? "Usage:" : "      ";
    // Continuations line up under the first argument: after `xpl <command> `.
    const hang = " ".repeat(head.length + words[0]!.length + (words[1]?.length ?? 0) + 3);
    const lines = [`${head} ${words.shift()} ${words.shift() ?? ""}`.trimEnd()];
    for (const word of words) {
      const line = `${lines[lines.length - 1]} ${word}`;
      if (line.length <= HELP_WIDTH) lines[lines.length - 1] = line;
      else lines.push(hang + word);
    }
    return lines;
  });
}

function optionRows(options: OptionDefs): string[] {
  const rows = Object.entries(options).map(([name, def]) => {
    const flag = `${def.short ? `-${def.short}, ` : ""}--${name}${def.arg ? ` ${def.arg}` : ""}`;
    return { flag, desc: def.desc };
  });
  const width = Math.max(0, ...rows.map((row) => row.flag.length));
  return wrapHelp(rows.map((row) => `  ${row.flag.padEnd(width)}  ${row.desc}`));
}

function helpText(): string {
  const width = Math.max(...COMMANDS.map((command) => command.name.length));
  const rows = wrapHelp(
    COMMANDS.map((command) => `  ${command.name.padEnd(width)}  ${command.summary}`),
  );
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
    "<explainer> arguments name a guide: <name> for the file .explainer/<name>.explainer.json.",
    "Environment: XPL_VIEWER_HTML=<file> sets the viewer page. XPL_SKIP_STALE_CHECK=1 skips the check of the",
    "index against the working tree. The CLI reference describes the other XPL_ variables.",
    "Setup: xpl skill install; xpl doctor --agent claude. Offline indexing: xpl index --precise off.",
    "First guide: xpl start <name> --question <question> --audience <reader>; then xpl view <name>.",
    "Repeat use: xpl index; xpl outline; xpl show <id> --refs; xpl new <name>; xpl apply <name> patch.json;",
    "xpl lint <name>; xpl view <name>. Exit codes: 0 ok, 1 rejected or failed, 2 usage error.",
    DOCS_REFERENCE,
    'Run "xpl <command> --help" for a command\'s options.',
  ].join("\n");
}

/**
 * The details of one kind of a command whose first argument is a choice (`xpl draft path --help`): the lines
 * before the table of kinds, the row of that kind, and the lines after the table. Undefined for any other topic.
 */
function topicDetails(command: CommandSpec, topic: string | undefined): string[] | undefined {
  const choices = command.positionals[0]?.name.split("|") ?? [];
  if (topic === undefined || choices.length < 2 || !choices.includes(topic) || !command.details)
    return undefined;
  const lines = command.details;
  const rowOf = (line: string) => /^ {2}([a-z]+)\b/.exec(line)?.[1];
  const isRow = (line: string) => choices.includes(rowOf(line) ?? "");
  const first = lines.findIndex(isRow);
  if (first === -1) return undefined;
  let last = first;
  for (let i = first; i < lines.length && /^ {2}/.test(lines[i]!); i++) last = i;
  const out = lines.slice(0, first);
  let inRow = false;
  for (const line of lines.slice(first, last + 1)) {
    if (isRow(line)) inRow = rowOf(line) === topic;
    if (inRow) out.push(line);
  }
  return [...lines.slice(0, first), "", ...out.slice(first), "", ...lines.slice(last + 1)];
}

function commandHelp(command: CommandSpec, topic?: string): string {
  const details = topicDetails(command, topic) ?? command.details;
  return [
    ...usageLines(command.usage),
    "",
    ...wrapHelpLine(command.summary),
    ...(details ? ["", ...wrapHelp(details)] : []),
    ...(Object.keys(command.options).length > 0
      ? ["", "Options:", ...optionRows(command.options)]
      : []),
    "",
    "Global options:",
    ...optionRows(GLOBAL_OPTIONS),
    `More: the skill's reference/cli.md ("xpl ${command.name}"), or ${DOCS_URL}`,
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
    ruby: { source: "class Runner; end\n", root: "program" },
    php: { source: "<?php class Runner {}\n", root: "program" },
    go: { source: "package main\n", root: "source_file" },
    java: { source: "class Main {}\n", root: "program" },
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

function unknownCommand(name: string): UsageError {
  const near = COMMANDS.filter(
    (c) => c.name.startsWith(name) || name.startsWith(c.name) || editDistance(c.name, name) <= 2,
  );
  const mean = near.map((c) => c.name).join(", ");
  return new UsageError(
    `unknown command "${name}".` +
      (near.length > 0 ? ` Did you mean: ${mean}?` : "") +
      ` Run "xpl --help" for the list of commands.`,
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
    io.out(commandHelp(command, first.positionals[1]));
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
        // wrapped like the Usage of --help
        io.err(
          usageLines(error.usage)
            .join("\n")
            .replace(/^Usage:/, "usage:"),
        );
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
