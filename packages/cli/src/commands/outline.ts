import type { CommandSpec } from "../command.js";
import { UsageError } from "../errors.js";
import { REPO_TARGET, resolveTarget } from "../target.js";
import {
  SYMBOL_KINDS,
  buildOutline,
  outlineJson,
  outlineNotes,
  renderOutline,
} from "../outline-tree.js";
import { openWorkspace } from "../repo.js";
import { detectRepoName } from "../repo-name.js";

/** Lines `xpl outline` prints before it cuts the tree (`--limit 0` prints everything). */
export const DEFAULT_OUTLINE_LINES = 400;

export const outlineCommand: CommandSpec = {
  name: "outline",
  usage: "xpl outline [--under <id>] [--depth n] [--kind k,...] [--keys]",
  summary: "Dir/file/symbol tree with kind, lines, fan-in/fan-out",
  details: [
    "One line per element: <id>  <kind>  <first>-<last line>  in=<fan-in> out=<fan-out>.",
    "Ids are exact: paste them into patches (sym:src/a.ts#A.b) or into other commands.",
    "in/out count the references into / out of the element's subtree (calls, imports, type uses, ...),",
    "not counting references that stay inside it. [+n] marks n children below the depth limit.",
    "Config keys (yaml/json/toml) are hidden unless --keys is given.",
    `--kind method,function,class lists only symbols of those kinds (${SYMBOL_KINDS.join(", ")}); the dirs, files`,
    "and parent symbols that contain a match are listed too, so each keeps its place. The repo line carries the",
    "name `xpl new` gives the repository (package.json, go.mod, pyproject.toml, git remote), not the directory's.",
  ],
  options: {
    under: {
      type: "string",
      arg: "<id>",
      desc: "Start at this dir, file or symbol (default: the repo)",
    },
    depth: { type: "string", arg: "<n>", desc: "Levels below the start to show (default 2)" },
    keys: { type: "boolean", desc: "Also show config keys (yaml/json/toml)" },
    kind: {
      type: "string",
      multiple: true,
      arg: "<k,...>",
      desc: `Only symbols of these kinds (repeat or comma-separate): ${SYMBOL_KINDS.join(", ")}`,
    },
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
    const kinds = parseKinds(args.list("kind"));
    const ws = await openWorkspace(ctx);
    const target = under !== undefined ? resolveTarget(ws.model, under) : REPO_TARGET;
    // Asking for the keys of a config key (or below), or for the kind `key`, is asking to see them.
    const rootIsKey = target.type === "symbol" && target.symbol.kind === "key";
    const keys = args.flag("keys") || rootIsKey || kinds?.has("key") === true;
    const tree = buildOutline(ws.model, target.id, {
      depth,
      keys,
      repoName: (await detectRepoName(ctx.root)).name,
      ...(kinds ? { kinds } : {}),
    });
    if (ctx.json) {
      ctx.emit({
        index: ws.indexRel,
        commit: ws.index.commit,
        depth,
        ...(kinds ? { kinds: [...kinds] } : {}),
        tree: outlineJson(tree),
      });
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
    if (kinds) {
      // the root may be the match itself (a method asked for by id)
      const matches =
        tree.children.length > 0 ||
        tree.more > 0 ||
        (tree.type === "symbol" && kinds.has(tree.kind));
      legend.push(
        matches
          ? `--kind ${[...kinds].join(",")}: only symbols of these kinds, plus the dirs, files and parent symbols that contain them`
          : `no symbol of kind ${[...kinds].join(", ")} under ${tree.id}`,
      );
    }
    ctx.out([...lines, ...(legend.length > 0 ? ["", ...legend] : [])].join("\n"));
    return 0;
  },
};

/** `--kind`: symbol kinds, repeated or comma-separated. */
function parseKinds(values: readonly string[]): Set<string> | undefined {
  if (values.length === 0) return undefined;
  const out = new Set<string>();
  for (const raw of values) {
    const kind = raw.toLowerCase();
    if (!SYMBOL_KINDS.includes(kind)) {
      throw new UsageError(`unknown symbol kind "${raw}" (expected: ${SYMBOL_KINDS.join(", ")})`);
    }
    out.add(kind);
  }
  return out;
}
