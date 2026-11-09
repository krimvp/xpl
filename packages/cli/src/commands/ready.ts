import type { CommandSpec } from "../command.js";
import { loadReadExplainer } from "../repo.js";
import { describeReadiness, workspaceReadiness } from "../readiness.js";

export const readyCommand: CommandSpec = {
  name: "ready",
  usage: "xpl ready [explainer] [--note <reason>] [--require-review]",
  summary: "Check source links, required content and reader findings before export",
  details: [
    "Checks a guide before you export it: the code links, the index, the text it needs, and lint.",
    "Errors block ready HTML. Warnings ask for your judgment.",
    "--note records why you keep a warning or leave something out. It does not override an error.",
    "--require-review also asks for a current author review of everything stored.",
    "It checks where the code is, not whether the text is true. Nothing is written.",
    "Exit codes: 0 ready (warnings allowed), 1 errors or failure, 2 usage error.",
  ],
  options: {
    "require-review": {
      type: "boolean",
      desc: "Team policy: require a current author review of all stored content",
    },
    note: {
      type: "string",
      arg: "<reason>",
      desc: "Record an author decision about warnings or omissions",
    },
  },
  positionals: [{ name: "explainer", required: false }],
  async run(ctx, args) {
    const { report } = await workspaceReadiness(
      ctx,
      loadReadExplainer(ctx, args.positionals[0], "ready"),
      args.str("note"),
      args.flag("require-review"),
    );
    if (ctx.json) ctx.emit({ ok: report.ready, ...report });
    else ctx.out(describeReadiness(report));
    return report.ready ? 0 : 1;
  },
};
