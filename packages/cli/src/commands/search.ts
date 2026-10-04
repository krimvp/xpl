import { CODE_LANGUAGES, matchesGlob } from "@xpl/core";
import type { CommandSpec } from "../command.js";
import { UsageError } from "../errors.js";
import { plural, truncate } from "../format.js";
import { openWorkspace, type Workspace } from "../repo.js";
import { resolveTarget } from "../target.js";

const DEFAULT_LIMIT = 50;
const MAX_TEXT = 160;

/** Config files (their symbols are keys): after code, before docs. */
const CONFIG_LANGUAGES: ReadonlySet<string> = new Set(["yaml", "json", "toml"]);

/** Search order of a file: code (0), config (1), docs and other text (2). */
function rank(language: string): number {
  return CODE_LANGUAGES.has(language) ? 0 : CONFIG_LANGUAGES.has(language) ? 1 : 2;
}

interface Hit {
  file: string;
  line: number;
  /** Element id of the innermost enclosing symbol, else `file:<path>`. */
  id: string;
  /** Lines from the start of that symbol (from line 1 for a file). */
  offset: number;
  text: string;
}

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

    let matches: (line: string) => boolean;
    if (regex) {
      let re: RegExp;
      try {
        re = new RegExp(pattern, ignoreCase ? "i" : "");
      } catch (error) {
        throw new UsageError(
          `invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      matches = (line) => re.test(line);
    } else {
      const needle = ignoreCase ? pattern.toLowerCase() : pattern;
      matches = ignoreCase
        ? (line) => line.toLowerCase().includes(needle)
        : (line) => line.includes(needle);
    }

    const ws = await openWorkspace(ctx);
    const scope = parseScope(ws, under);
    // code first, then config, then docs; by path inside each (the index lists files by path)
    const files = ws.model.files
      .filter((file) => !codeOnly || CODE_LANGUAGES.has(file.language))
      .map((file, order) => ({ file, order }))
      .sort((a, b) => rank(a.file.language) - rank(b.file.language) || a.order - b.order)
      .map((entry) => entry.file);
    const hits: Hit[] = [];
    let total = 0;
    let searched = 0;
    const fileCount = new Set<string>();
    for (const file of files) {
      const lines = ws.texts.lines(file.path);
      if (!lines) continue;
      if (scope && !scope.hasFile(file.path)) continue;
      searched++;
      for (let i = 0; i < lines.length; i++) {
        const text = lines[i]!;
        if (!matches(text)) continue;
        if (scope && !scope.hasLine(file.path, i + 1)) continue;
        total++;
        fileCount.add(file.path);
        if (limit > 0 && hits.length >= limit) continue;
        const line = i + 1;
        const symbol = ws.model.innermostSymbolAt(file.path, line);
        hits.push({
          file: file.path,
          line,
          id: symbol ? `sym:${symbol.id}` : `file:${file.path}`,
          offset: symbol ? line - symbol.range.startLine : line - 1,
          text: text.trim(),
        });
      }
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
        files: fileCount.size,
        hits,
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
        `... ${total - hits.length} more matches (showing ${hits.length} of ${total} in ${plural(fileCount.size, "file")}); raise --limit or narrow the pattern${under.length === 0 ? " (--under <dir>, --code)" : ""}`,
      );
    }
    ctx.out(lines.join("\n"));
    return 0;
  },
};
