import { basename } from "node:path";
import type { CommandSpec } from "../command.js";
import { REPO_TARGET, resolveTarget } from "../target.js";
import { buildOutline, outlineJson, outlineNotes, renderOutline } from "../outline-tree.js";
import { openWorkspace } from "../repo.js";

/** Lines `xpl outline` prints before it cuts the tree (`--limit 0` prints everything). */
export const DEFAULT_OUTLINE_LINES = 400;

export const outlineCommand: CommandSpec = {
  name: "outline",
  usage: "xpl outline [--under <id>] [--depth n] [--keys]",
  summary: "Dir/file/symbol tree with kind, lines, fan-in/fan-out",
  details: [
    "One line per element: <id>  <kind>  <first>-<last line>  in=<fan-in> out=<fan-out>.",
    "Ids are exact: paste them into patches (sym:src/a.ts#A.b) or into other commands.",
    "in/out count the references into / out of the element's subtree (calls, imports, type uses, ...),",
    "not counting references that stay inside it. [+n] marks n children below the depth limit.",
    "Config keys (yaml/json) are hidden unless --keys is given.",
  ],
  options: {
    under: {
      type: "string",
      arg: "<id>",
      desc: "Start at this dir, file or symbol (default: the repo)",
    },
    depth: { type: "string", arg: "<n>", desc: "Levels below the start to show (default 2)" },
    keys: { type: "boolean", desc: "Also show config keys (yaml/json mapping keys)" },
    limit: {
      type: "string",
      arg: "<n>",
      desc: `Print at most n lines (default ${DEFAULT_OUTLINE_LINES}, 0 = no limit)`,
    },
  },
  positionals: [],
  async run(ctx, args) {
    const depth = args.int("depth") ?? 2;
    const limit = args.int("limit") ?? DEFAULT_OUTLINE_LINES;
    const under = args.str("under");
    const ws = await openWorkspace(ctx);
    const target = under !== undefined ? resolveTarget(ws.model, under) : REPO_TARGET;
    // Asking for the keys of a config key (or below) is asking to see them.
    const rootIsKey = target.type === "symbol" && target.symbol.kind === "key";
    const keys = args.flag("keys") || rootIsKey;
    const tree = buildOutline(ws.model, target.id, {
      depth,
      keys,
      repoName: basename(ctx.root) || "repo",
    });
    if (ctx.json) {
      ctx.emit({ index: ws.indexRel, commit: ws.index.commit, depth, tree: outlineJson(tree) });
      return 0;
    }
    const all = renderOutline(tree);
    const lines = limit > 0 ? all.slice(0, limit) : all;
    if (lines.length < all.length) {
      lines.push(
        `... ${all.length - lines.length} more lines; narrow it with --under <id> or a smaller --depth, or use --limit 0`,
      );
    }
    const notes = outlineNotes(tree);
    const legend: string[] = [];
    if (notes.cut) {
      legend.push(
        "[+n]: n children below the depth limit (raise --depth, or --under <id> to open one)",
      );
    }
    if (notes.hiddenKeys) {
      legend.push("[n keys hidden]: config keys are hidden, use --keys to list them");
    }
    ctx.out([...lines, ...(legend.length > 0 ? ["", ...legend] : [])].join("\n"));
    return 0;
  },
};
