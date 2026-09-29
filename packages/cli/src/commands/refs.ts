import type { CommandSpec } from "../command.js";
import {
  buildRefTree,
  parseKinds,
  refTreeJson,
  renderRefTree,
  type RefDirection,
} from "../ref-data.js";
import { openWorkspace } from "../repo.js";
import { describeTarget, resolveTarget } from "../target.js";

/** Entries printed by `xpl refs` before it cuts the tree (`--limit 0` prints everything). */
export const DEFAULT_REF_LIMIT = 200;

export const refsCommand: CommandSpec = {
  name: "refs",
  usage: "xpl refs <id> [--in|--out] [--kind k] [--depth n]",
  summary: "Call/reference hierarchy with sites",
  details: [
    "Lists the references that leave (--out, the default) or enter (--in) an element. Each line is",
    "  <kind>  <other id>  (<file>:<line>, <precise|heuristic>)  +<offset>",
    'in source order. +<offset> counts lines from the start of the referencing symbol (named after "in" when',
    "it is not the element itself: outgoing references of a file, directory or class), so a call-site",
    "anchor's span is +34..36 -> span {from: 34, to: 36}. Kinds: call, import, extends, implements,",
    "type-ref, read, write. heuristic references are hints, not proof.",
    "--depth n expands each other end in turn (a call hierarchy); an element is expanded once,",
    "repeats are marked (expanded above) or (cycle). For files and directories the references that stay",
    "inside them are left out.",
  ],
  options: {
    in: { type: "boolean", desc: "References into the element (who uses it)" },
    out: { type: "boolean", desc: "References out of the element (what it uses); the default" },
    kind: {
      type: "string",
      multiple: true,
      arg: "<k>",
      desc: "Only these kinds (repeat or comma-separate): call, import, extends, implements, type-ref, read, write",
    },
    depth: { type: "string", arg: "<n>", desc: "Levels to expand (default 1)" },
    limit: {
      type: "string",
      arg: "<n>",
      desc: `Cut the tree after n lines (default ${DEFAULT_REF_LIMIT}, 0 = no limit)`,
    },
  },
  positionals: [{ name: "id" }],
  async run(ctx, args) {
    const wantIn = args.flag("in");
    const wantOut = args.flag("out");
    const directions: RefDirection[] =
      wantIn && wantOut ? ["out", "in"] : wantIn ? ["in"] : ["out"];
    const kinds = parseKinds(args.list("kind"));
    const depth = args.int("depth", { min: 1 }) ?? 1;
    const limit = args.int("limit") ?? DEFAULT_REF_LIMIT;
    const ws = await openWorkspace(ctx);
    const target = resolveTarget(ws.model, args.positionals[0]!);

    const trees = directions.map((direction) => ({
      direction,
      tree: buildRefTree(ws.model, target, direction, {
        depth,
        limit,
        ...(kinds ? { kinds } : {}),
      }),
    }));

    if (ctx.json) {
      ctx.emit({
        id: target.id,
        depth,
        ...(kinds ? { kinds: [...kinds] } : {}),
        ...Object.fromEntries(
          trees.map(({ direction, tree }) => [direction, refTreeJson(tree.nodes)]),
        ),
        totals: Object.fromEntries(trees.map(({ direction, tree }) => [direction, tree.total])),
        truncated: trees.some(({ tree }) => tree.truncated),
      });
      return 0;
    }

    const lines = [describeTarget(target)];
    for (const { direction, tree } of trees) {
      if (tree.nodes.length === 0) {
        lines.push(`${direction}: none${kinds ? ` (kind ${[...kinds].join(", ")})` : ""}`);
        continue;
      }
      lines.push(
        `${direction} (${tree.total}${tree.truncated && tree.total > tree.nodes.length ? `, first ${tree.nodes.length} shown` : ""}):`,
        ...renderRefTree(tree.nodes, direction, target.id),
      );
      if (tree.truncated) {
        lines.push(`  ... cut after ${limit} lines; use --limit 0, --kind, or a smaller --depth`);
      }
    }
    ctx.out(lines.join("\n"));
    return 0;
  },
};
