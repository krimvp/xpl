import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Args } from "../args.js";
import type { CommandSpec } from "../command.js";
import { CliError, UsageError } from "../errors.js";
import { plural } from "../format.js";
import { indexCommand } from "./build-index.js";
import { changeCommand } from "./change.js";
import { draftCommand } from "./draft.js";
import { resolveCommand } from "./resolve.js";

const PRECISE = ["auto", "off", "require"] as const;

/**
 * `xpl update`: the bookkeeping after work on the code, for a map guide, in one run: `xpl index`, `xpl resolve
 * --write`, `xpl change <since>..HEAD` (with `--since`), and `xpl draft map`. It applies nothing.
 */
export const updateCommand: CommandSpec = {
  name: "update",
  usage: "xpl update <explainer> [--since <rev>] [-o <file>] [--precise auto|off|require]",
  summary: "After work on the code: index, move the guide, record the change, draft the map again",
  details: [
    "Runs, in order: `xpl index`, `xpl resolve <explainer> --write`, `xpl change <explainer> <rev>..HEAD` when",
    "--since is given (the work must be committed: the head is the commit the index is built from), and",
    "`xpl draft map <explainer>`. The draft holds only what changed: boxes for new files, the removal of boxes",
    "whose code is gone (a moved file keeps its text), and, with the change recorded, a tour of the changed",
    "files. Nothing is applied: write the TODOs, then `xpl lint <explainer> --patch <file>` and `xpl apply`.",
    "Without -o the draft is saved to a new folder outside the repository; the path is printed.",
    "A step that fails stops the run with its own message; the steps before it stay done.",
  ],
  options: {
    since: { type: "string", arg: "<rev>", desc: "Record the change from this revision to HEAD" },
    out: { type: "string", short: "o", arg: "<file>", desc: "Write the draft patch to a file" },
    precise: {
      type: "string",
      arg: "auto|off|require",
      desc: "Reference resolution of the index (default auto)",
    },
  },
  positionals: [{ name: "explainer" }],
  async run(ctx, args) {
    const name = args.positionals[0]!;
    const since = args.str("since")?.trim();
    if (since === "") throw new UsageError("--since must name a revision (e.g. HEAD~1 or main)");
    const precise = args.choice("precise", PRECISE) ?? "auto";
    if (ctx.indexOption) throw new UsageError("xpl update builds its own index; omit --index");

    const said: string[] = [];
    const quiet = { ...ctx, json: false, out: (text: string) => said.push(text), emit: () => {} };
    const step = async (what: string, run: () => Promise<number>) => {
      said.length = 0;
      const code = await run();
      if (code !== 0) throw new CliError(`${what} failed:\n${said.join("\n")}`.trim(), code);
    };

    await step("xpl index", () => indexCommand.run(quiet, new Args({ precise }, [])));
    let resolved: Record<string, unknown> = {};
    await step("xpl resolve --write", () =>
      resolveCommand.run(
        { ...quiet, json: true, emit: (data) => (resolved = data) },
        new Args({ write: true }, [name]),
      ),
    );
    let change: Record<string, unknown> | undefined;
    if (since) {
      await step(`xpl change ${since}..HEAD`, () =>
        changeCommand.run(
          { ...quiet, json: true, emit: (data) => (change = data) },
          new Args({}, [name, `${since}..HEAD`]),
        ),
      );
    }
    const out = args.str("out")
      ? resolve(ctx.cwd, args.str("out")!)
      : join(await mkdtemp(join(tmpdir(), "xpl-update-")), "map.patch.json");
    let draft: Record<string, unknown> = {};
    await step("xpl draft map", () =>
      draftCommand.run(
        { ...quiet, json: true, emit: (data) => (draft = data) },
        new Args({ out }, ["map", name]),
      ),
    );

    const counts = (draft.counts ?? {}) as Record<string, number>;
    const notes = Array.isArray(draft.notes) ? (draft.notes as string[]) : [];
    const record = change?.change as { base?: string; head?: string } | undefined;
    const totals = (change?.analysis as { totals?: { files?: number } } | undefined)?.totals;
    if (ctx.json) {
      ctx.emit({ resolved, change: change ?? null, draft: { out, counts, notes } });
      return 0;
    }
    const anchors = (resolved.counts ?? {}) as Record<string, number>;
    ctx.out(
      [
        `index: built; ${name} moved to it` +
          (anchors.drifted || anchors.missing
            ? ` (${plural(anchors.drifted ?? 0, "drifted anchor")}, ${plural(anchors.missing ?? 0, "missing anchor")}: \`xpl status ${name}\`)`
            : ""),
        record?.base && record.head
          ? `change: ${record.head.slice(0, 7)} since ${record.base.slice(0, 7)}, ${plural(totals?.files ?? 0, "file")}`
          : "change: none recorded (pass --since <rev> to record one)",
        `draft: ${out}`,
        `  ${plural(counts.overlays ?? 0, "new box", "new boxes")}, ${plural(counts.tourSteps ?? 0, "tour step")}, ${plural(counts.todos ?? 0, "TODO")} to write`,
        ...notes.map((note) => `note: ${note}`),
        `next: write each TODO, then \`xpl lint ${name} --patch ${out}\` and \`xpl apply ${name} ${out}\``,
      ].join("\n"),
    );
    return 0;
  },
};
