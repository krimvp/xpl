import type { CommandSpec } from "../command.js";
import { plural } from "../format.js";
import {
  DEFAULT_MAX_CHILDREN,
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
  usage: "xpl refs <id> [--in|--out] [--kind k] [--depth n] [--max-children n]",
  summary: "Call/reference hierarchy with sites",
  details: [
    "Lists the references that leave (--out, the default) or enter (--in) an element. Each line is",
    "  <kind>  <other id>  (<file>:<line>, <precise|heuristic>)  +<offset>",
    'in source order. +<offset> counts lines from the start of the referencing symbol (named after "in" when',
    "it is not the element itself: outgoing references of a file, directory or class), so a call-site",
    "anchor's span is +34..36 -> span {from: 34, to: 36}. Kinds: call, import, extends, implements,",
    "type-ref, read, write. heuristic references are hints, not proof.",
    "--depth n expands each other end in turn (a call hierarchy); an element is expanded once, repeats are marked",
    "(expanded above) or (cycle), so no subtree is printed twice (one met on the last levels first is expanded again,",
    "deeper, when it turns up nearer the top; an element with nothing below it is never marked). At most",
    "--max-children n (default 15, 0 = all) references are listed under a line, the rest are counted",
    "(`... +5 more`); in a hierarchy that includes the subject's own list, while the flat list of a plain `refs`",
    "(depth 1) is cut by --limit alone. For files and directories the references that stay inside them are left out.",
    "Interfaces are transparent. Under a call (or type use) of an interface or one of its methods, --out lists",
    "the implementations as `impl  <id>  (<file>:<lines>, <resolution>)` lines (from `implements` references:",
    "a TS `implements`, Go's implicit interface satisfaction, precise member-level relations; same-named",
    "methods of the implementing types), and with --depth n they are expanded in place of the bodiless",
    "declaration. Implementations in test files (test doubles) are left out unless --tests, or the call is in",
    "a test file itself. In --in, a method that implements an interface method also lists that method as",
    "`impl`, with the interface method's callers below it. Base classes (TS, JS, Python; not Go embedding) are",
    "hopped the same way as `override` lines: under a call, --out lists the subclass methods that override the",
    "callee (the call may run any of them); --in lists the base method a method overrides, with its callers below.",
    "Constructors are not hopped.",
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
    "max-children": {
      type: "string",
      arg: "<n>",
      desc: `List at most n references under each line of a hierarchy (default ${DEFAULT_MAX_CHILDREN}, 0 = all); with --depth 1 only --limit cuts the list`,
    },
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
    const maxChildren = args.int("max-children") ?? DEFAULT_MAX_CHILDREN;
    const ws = await openWorkspace(ctx);
    const target = resolveTarget(ws.model, args.positionals[0]!);

    const trees = directions.map((direction) => ({
      direction,
      tree: buildRefTree(ws.model, target, direction, {
        depth,
        limit,
        maxChildren,
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
        ...(trees.some(({ tree }) => tree.more > 0)
          ? {
              moreChildren: Object.fromEntries(
                trees
                  .filter(({ tree }) => tree.more > 0)
                  .map(({ direction, tree }) => [direction, tree.more]),
              ),
            }
          : {}),
        truncated: trees.some(({ tree }) => tree.truncated),
        hiddenTestImplementations: trees.reduce((sum, { tree }) => sum + tree.hiddenTests, 0),
        hiddenTestOverrides: trees.reduce((sum, { tree }) => sum + tree.hiddenTestOverrides, 0),
      });
      return 0;
    }

    const lines = [describeTarget(target)];
    for (const { direction, tree } of trees) {
      if (tree.nodes.length === 0) {
        lines.push(`${direction}: none${kinds ? ` (kind ${[...kinds].join(", ")})` : ""}`);
        continue;
      }
      const hopsOf = (kind: string) => tree.nodes.filter((n) => n.entry.kind === kind).length;
      const overrides = direction === "in" ? hopsOf("override") : 0;
      const viaInterface = tree.hops - overrides;
      const via =
        (viaInterface > 0 ? `, plus ${viaInterface} via interface` : "") +
        (overrides > 0 ? `, plus ${overrides} via base class` : "");
      lines.push(
        `${direction} (${tree.total}${via}${tree.truncated && tree.total > tree.nodes.length ? `, first ${tree.nodes.length} shown` : ""}):`,
      );
      renderRefTree(tree.nodes, direction, target.id, 1, tree.more, lines);
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
    const overrides = trees.reduce((sum, { tree }) => sum + tree.hiddenTestOverrides, 0);
    if (overrides > 0) {
      lines.push(
        `(${plural(overrides, "override")} in test files left out: test subclasses; --tests lists them)`,
      );
    }
    ctx.out(lines.join("\n"));
    return 0;
  },
};
