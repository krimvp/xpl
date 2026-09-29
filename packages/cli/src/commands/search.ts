import type { CommandSpec } from "../command.js";
import { UsageError } from "../errors.js";
import { plural, truncate } from "../format.js";
import { openWorkspace } from "../repo.js";

const DEFAULT_LIMIT = 50;
const MAX_TEXT = 160;

interface Hit {
  file: string;
  line: number;
  /** Element id of the innermost enclosing symbol, else `file:<path>`. */
  id: string;
  /** Lines from the start of that symbol (from line 1 for a file). */
  offset: number;
  text: string;
}

export const searchCommand: CommandSpec = {
  name: "search",
  usage: "xpl search <pattern> [--regex] [--limit n]",
  summary: "Text hits with enclosing symbol id and offset",
  details: [
    "Searches the working-tree text of every indexed file, line by line (case-sensitive substring;",
    "--regex takes a JavaScript regular expression, -i ignores case). Each hit is",
    "  <file>:<line>  <enclosing symbol id> +<offset>  <line text>",
    "where +<offset> is the line's 0-based offset inside that symbol: the number a span or a",
    "call-site anchor uses. Hits outside every symbol name the file (offset = line - 1).",
  ],
  options: {
    regex: { type: "boolean", desc: "Treat the pattern as a JavaScript regular expression" },
    "ignore-case": { type: "boolean", short: "i", desc: "Case-insensitive match" },
    limit: {
      type: "string",
      arg: "<n>",
      desc: `Show at most n hits (default ${DEFAULT_LIMIT}, 0 = all); the total is always counted`,
    },
  },
  positionals: [{ name: "pattern" }],
  async run(ctx, args) {
    const pattern = args.positionals[0]!;
    if (pattern === "") throw new UsageError("the search pattern is empty");
    const ignoreCase = args.flag("ignore-case");
    const regex = args.flag("regex");
    const limit = args.int("limit") ?? DEFAULT_LIMIT;

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
    const hits: Hit[] = [];
    let total = 0;
    const fileCount = new Set<string>();
    for (const file of ws.model.files) {
      const lines = ws.texts.lines(file.path);
      if (!lines) continue;
      for (let i = 0; i < lines.length; i++) {
        const text = lines[i]!;
        if (!matches(text)) continue;
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
      ctx.emit({ pattern, regex, ignoreCase, total, files: fileCount.size, hits });
      return 0;
    }
    if (total === 0) {
      ctx.out(
        `no matches for ${regex ? "/" : '"'}${pattern}${regex ? "/" : '"'} in ${plural(ws.model.files.length, "indexed file")}`,
      );
      return 0;
    }
    const lines = hits.map(
      (hit) => `${hit.file}:${hit.line}  ${hit.id} +${hit.offset}  ${truncate(hit.text, MAX_TEXT)}`,
    );
    if (total > hits.length) {
      lines.push(
        `... ${total - hits.length} more matches (showing ${hits.length} of ${total} in ${plural(fileCount.size, "file")}); raise --limit or narrow the pattern`,
      );
    }
    ctx.out(lines.join("\n"));
    return 0;
  },
};
