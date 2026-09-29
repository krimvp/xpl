import { parseArgs } from "node:util";
import { GRAMMAR_IDS, createParser, getWasmDir, initParser, type GrammarId } from "@xpl/indexer";
import pkg from "../package.json" with { type: "json" };

/** One row of the command table in ARCHITECTURE.md §5. */
export interface CommandSpec {
  name: string;
  usage: string;
  summary: string;
}

/** The commands of ARCHITECTURE.md §5. Every one is a stub until its phase lands. */
export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "index",
    usage: "xpl index [--precise auto|off|require] [--commit c]",
    summary: "Build and write the symbol index; print a per-language summary",
  },
  {
    name: "outline",
    usage: "xpl outline [--under <id>] [--depth n]",
    summary: "Dir/file/symbol tree with kind, lines, fan-in/fan-out",
  },
  {
    name: "show",
    usage: "xpl show <id> [--refs]",
    summary: "Code with 0-based offsets relative to the symbol (what spans use), plus refs",
  },
  {
    name: "refs",
    usage: "xpl refs <id> [--in|--out] [--kind k] [--depth n]",
    summary: "Call/reference hierarchy with sites",
  },
  {
    name: "search",
    usage: "xpl search <pattern> [--regex]",
    summary: "Text hits with enclosing symbol id and offset",
  },
  {
    name: "new",
    usage: "xpl new <name> [--title t]",
    summary: "Create .explainer/<name>.explainer.json bound to the index",
  },
  {
    name: "apply",
    usage: "xpl apply <explainer> <patch.json|-> [--actor llm|user] [--dry-run]",
    summary: "Validate and apply a patch; print issues; exit 1 on error",
  },
  {
    name: "validate",
    usage: "xpl validate <explainer> [--lenient]",
    summary: "Check an explainer against the index",
  },
  {
    name: "resolve",
    usage: "xpl resolve <explainer> [--write]",
    summary: "Re-resolve anchors; report drifted llm elements and missing anchors",
  },
  {
    name: "status",
    usage: "xpl status <explainer>",
    summary: "To-do list: unexplained elements, drifted, missing, queued requests",
  },
  {
    name: "view",
    usage: "xpl view <explainer> [--port p] [--no-open]",
    summary: "Serve the viewer locally with live repo access",
  },
  {
    name: "bundle",
    usage: "xpl bundle <explainer> -o out.html [--mode explore|present] [--tour id]",
    summary: "Write one self-contained HTML file",
  },
];

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

const defaultIo: Io = {
  out: (text) => process.stdout.write(text + "\n"),
  err: (text) => process.stderr.write(text + "\n"),
};

function helpText(): string {
  const width = Math.max(...COMMANDS.map((command) => command.name.length));
  const rows = COMMANDS.map(
    (command) => `  ${command.name.padEnd(width)}  ${command.summary}  (not implemented yet)`,
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
    "  --root <dir>     Repository root (default: current directory)",
    "  --json           Machine-readable output",
    "  --index <path>   Symbol index to use (default: the index of the current commit id,",
    "                   else the newest .explainer/index-*.json)",
    "  -h, --help       Show this help (or a command's usage: xpl <command> --help)",
    "  -v, --version    Show the version",
    "",
    "<id> arguments accept sym:..., file:..., dir:..., src/a.ts#A.b and src/a.ts.",
    "See docs/ARCHITECTURE.md section 5.",
  ].join("\n");
}

/**
 * Hidden `xpl __smoke`: load every tree-sitter grammar (from `dist/wasm` when running the bundle)
 * and parse a tiny snippet with each. Proves the bundle and its wasm files work.
 */
async function smoke(io: Io): Promise<number> {
  const samples: Record<GrammarId, { source: string; root: string }> = {
    typescript: { source: "export const a = 1;\n", root: "program" },
    tsx: { source: "const el = <div />;\n", root: "program" },
    python: { source: "x = 1\n", root: "module" },
    go: { source: "package main\n", root: "source_file" },
    yaml: { source: "a: 1\n", root: "stream" },
    json: { source: '{"a": 1}\n', root: "document" },
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

/** Run the CLI; resolves to the process exit code. */
export async function run(argv: string[], io: Io = defaultIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false, // per-command options are declared by each command as it is implemented
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      root: { type: "string" },
      json: { type: "boolean" },
      index: { type: "string" },
    },
  });
  const [name] = positionals;
  const command = COMMANDS.find((candidate) => candidate.name === name);

  if (values.version) {
    io.out(pkg.version);
    return 0;
  }
  if (values.help) {
    io.out(
      command ? `${command.usage}\n\n${command.summary}\n\n(not implemented yet)` : helpText(),
    );
    return 0;
  }
  if (name === undefined) {
    io.err(helpText());
    return 2;
  }
  if (name === "__smoke") return smoke(io);
  if (!command) {
    io.err(`xpl: unknown command "${name}". Run "xpl --help" for the list of commands.`);
    return 2;
  }
  io.err(`xpl ${command.name}: not implemented yet`);
  return 1;
}
