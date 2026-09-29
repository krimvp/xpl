import type { CommandSpec } from "../command.js";
import { plural } from "../format.js";
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
    "Interfaces are transparent. Under a call (or type use) of an interface or one of its methods, --out lists",
    "the implementations as `impl  <id>  (<file>:<lines>, <resolution>)` lines (from `implements` references:",
    "a TS `implements`, Go's implicit interface satisfaction, precise member-level relations; same-named",
    "methods of the implementing types), and with --depth n they are expanded in place of the bodiless",
    "declaration. Implementations in test files (test doubles) are left out unless --tests, or the call is in",
    "a test file itself. In --in, a method that implements an interface method also lists that method as",
    "`impl`, with the interface method's callers below it. Python base classes and TS abstract classes are",
    "`extends`, not `implements`: not hopped.",
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
    tests: {
      type: "boolean",
      desc: "Also list implementations in test files (test doubles are hidden by default)",
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
        tests: args.flag("tests"),
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
        hiddenTestImplementations: trees.reduce((sum, { tree }) => sum + tree.hiddenTests, 0),
      });
      return 0;
    }

    const lines = [describeTarget(target)];
    for (const { direction, tree } of trees) {
      if (tree.nodes.length === 0) {
        lines.push(`${direction}: none${kinds ? ` (kind ${[...kinds].join(", ")})` : ""}`);
        continue;
      }
      const via = tree.hops > 0 ? `, plus ${tree.hops} via interface` : "";
      lines.push(
        `${direction} (${tree.total}${via}${tree.truncated && tree.total > tree.nodes.length ? `, first ${tree.nodes.length} shown` : ""}):`,
        ...renderRefTree(tree.nodes, direction, target.id),
      );
      if (tree.truncated) {
        lines.push(`  ... cut after ${limit} lines; use --limit 0, --kind, or a smaller --depth`);
      }
    }
    const hidden = trees.reduce((sum, { tree }) => sum + tree.hiddenTests, 0);
    if (hidden > 0) {
      lines.push(
        `(${plural(hidden, "implementation")} in test files left out: test doubles; --tests lists them)`,
      );
    }
    ctx.out(lines.join("\n"));
    return 0;
  },
};
