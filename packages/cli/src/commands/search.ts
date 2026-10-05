import { matchesGlob, query, type SourceHit } from "@xpl/core";
import type { CommandSpec } from "../command.js";
import { UsageError } from "../errors.js";
import { plural, truncate } from "../format.js";
import { openWorkspace, type Workspace } from "../repo.js";
import { resolveTarget } from "../target.js";

const DEFAULT_LIMIT = 50;
const MAX_TEXT = 160;

/** Where hits may lie: which files are searched, and for a symbol scope which lines of them. */
interface Scope {
  hasFile(path: string): boolean;
  hasLine(path: string, line: number): boolean;
}

interface ScopeEntry {
  file: (path: string) => boolean;
  /** A symbol scope: only these lines of the file. */
  range?: { startLine: number; endLine: number };
}

/**
 * `--under`: a directory, a file or a symbol id (any form the other commands take), or a glob on repo paths
 * (`src/flask/**`, `tests/*.py`; a pattern without a slash matches file names at any depth). Several values
 * (repeated or comma-separated) widen the scope. An id the index does not know is an error with suggestions.
 */
function parseScope(ws: Workspace, values: readonly string[]): Scope | undefined {
  if (values.length === 0) return undefined;
  const entries: ScopeEntry[] = [];
  for (const raw of values) {
    const value = raw.replace(/^(?:\.?\/)+/, "");
    if (value === "") throw new UsageError("--under is empty: give a directory, a file or a glob");
    if (/[*?]/.test(value)) {
      entries.push({ file: (file) => matchesGlob(file, value) });
      continue;
    }
    const target = resolveTarget(ws.model, value);
    switch (target.type) {
      case "repo":
        entries.push({ file: () => true });
        break;
      case "dir":
        entries.push({ file: (file) => file.startsWith(`${target.path}/`) });
        break;
      case "file":
        entries.push({ file: (file) => file === target.path });
        break;
      case "symbol":
        entries.push({
          file: (file) => file === target.symbol.file,
          range: target.symbol.range,
        });
        break;
    }
  }
  return {
    hasFile: (path) => entries.some((entry) => entry.file(path)),
    hasLine: (path, line) =>
      entries.some(
        (entry) =>
          entry.file(path) &&
          (!entry.range || (line >= entry.range.startLine && line <= entry.range.endLine)),
      ),
  };
}

export const searchCommand: CommandSpec = {
  name: "search",
  usage: "xpl search <pattern> [--regex] [-i] [--limit n] [--under <dir|glob>] [--code]",
  summary: "Text hits with enclosing symbol id and offset",
  details: [
    "Searches the working-tree text of every indexed file, line by line (case-sensitive substring;",
    "--regex takes a JavaScript regular expression, -i (--ignore-case) ignores case). Each hit is",
    "  <file>:<line>  <enclosing symbol id> +<offset>  <line text>",
    "where +<offset> is the line's 0-based offset inside that symbol: the number a span or a",
    "call-site anchor uses. Hits outside every symbol name the file (offset = line - 1).",
    "Code files are searched first, then config (yaml, json, toml), then docs and other text, so the first",
    "hits (--limit) are the code. --code drops everything that is not code (docs, config, text).",
    "--under <dir|file|glob> keeps the search inside a directory, file or symbol id (dir:src/flask, src/flask/,",
    "file:src/app.py, sym:src/app.py#Flask) or a glob on repo paths (tests/**, src/*.py); repeat it or use",
    "commas for several. The total is counted inside the scope.",
    "Unavailable file text produces a warning. --json also records the index snapshot, searchable paths,",
    "retained/original symbol counts and original analysis coverage in scope; absent coverage is unknown.",
  ],
  options: {
    regex: { type: "boolean", desc: "Treat the pattern as a JavaScript regular expression" },
    "ignore-case": { type: "boolean", short: "i", desc: "Case-insensitive match" },
    limit: {
      type: "string",
      arg: "<n>",
      desc: `Show at most n hits (default ${DEFAULT_LIMIT}, 0 = all); the total is always counted`,
    },
    under: {
      type: "string",
      multiple: true,
      arg: "<dir|glob>",
      desc: "Only search here: a dir, file or symbol id (dir:src/flask, src/flask/) or a glob (tests/**)",
    },
    code: {
      type: "boolean",
      desc: "Only files in a code language (not docs, text or config); code comes first anyway",
    },
  },
  positionals: [{ name: "pattern" }],
  async run(ctx, args) {
    const pattern = args.positionals[0]!;
    if (pattern === "") throw new UsageError("the search pattern is empty");
    const ignoreCase = args.flag("ignore-case");
    const regex = args.flag("regex");
    const codeOnly = args.flag("code");
    const limit = args.int("limit") ?? DEFAULT_LIMIT;
    const under = args.list("under");

    // Syntax errors take precedence over a missing workspace, as in the other query commands.
    if (regex) {
      try {
        new RegExp(pattern, ignoreCase ? "i" : "");
      } catch (error) {
        throw new UsageError(
          `invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const ws = await openWorkspace(ctx);
    const scope = parseScope(ws, under);
    let result;
    try {
      result = query(ws.model, ws.texts, {
        pattern,
        regex,
        ignoreCase,
        codeOnly,
        limit,
        scope,
        kinds: ["source"],
        textOrigin: "working-tree",
      });
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message : String(error));
    }
    const hits = result.hits
      .filter((hit): hit is SourceHit => hit.kind === "source")
      .map(({ file, line, id, offset, text }) => ({ file, line, id, offset, text }));
    const total = result.total;
    const searched = result.scope.searchedFiles.length;
    const fileCount = result.matchedFiles;
    if (result.scope.unavailableFiles.length > 0) {
      ctx.warn(
        `source unavailable for ${plural(result.scope.unavailableFiles.length, "indexed file")}: ${result.scope.unavailableFiles.join(", ")}`,
      );
    }

    if (ctx.json) {
      ctx.emit({
        pattern,
        regex,
        ignoreCase,
        ...(under.length > 0 ? { under } : {}),
        ...(codeOnly ? { code: true } : {}),
        searched,
        total,
        files: fileCount,
        hits,
        scope: result.scope,
      });
      return 0;
    }
    if (total === 0) {
      const where = [
        ...(under.length > 0 ? [`under ${under.join(", ")}`] : []),
        ...(codeOnly ? ["code files only"] : []),
      ];
      ctx.out(
        `no matches for ${regex ? "/" : '"'}${pattern}${regex ? "/" : '"'} in ${plural(searched, "indexed file")}` +
          (where.length > 0 ? ` (${where.join(", ")})` : ""),
      );
      return 0;
    }
    const lines = hits.map(
      (hit) => `${hit.file}:${hit.line}  ${hit.id} +${hit.offset}  ${truncate(hit.text, MAX_TEXT)}`,
    );
    if (total > hits.length) {
      lines.push(
        `... ${total - hits.length} more matches (showing ${hits.length} of ${total} in ${plural(fileCount, "file")}); raise --limit or narrow the pattern${under.length === 0 ? " (--under <dir>, --code)" : ""}`,
      );
    }
    ctx.out(lines.join("\n"));
    return 0;
  },
};
