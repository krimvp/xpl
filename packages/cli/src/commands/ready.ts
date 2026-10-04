import type { CommandSpec } from "../command.js";
import { loadExplainer } from "../repo.js";
import { describeReadiness, workspaceReadiness } from "../readiness.js";

export const readyCommand: CommandSpec = {
  name: "ready",
  usage: "xpl ready <explainer> [--note <reason>]",
  summary: "Check source links, required content and reader findings before export",
  details: [
    "Combines strict validation, working-tree/index freshness, required summaries/story text and reader lint.",
    "Errors block ready HTML; warnings invite author judgment. --note records intentional omissions or warning",
    "decisions in the report, without overriding errors. Add the same note to bundle to preserve it in HTML.",
    "Each finding names the element, field, code, message and repair hint. --json emits ReadinessReport.",
    "Source checks verify locations and freshness, not prose truth or every runtime path. Offline re-saves",
    "check only embedded source; this command checks the current workspace. No service or reviewer required.",
    "Exit codes: 0 ready (warnings allowed), 1 blockers or failure, 2 usage error. Nothing is written.",
  ],
  options: {
    note: {
      type: "string",
      arg: "<reason>",
      desc: "Record an author decision about warnings or omissions",
    },
  },
  positionals: [{ name: "explainer" }],
  async run(ctx, args) {
    const { report } = await workspaceReadiness(
      ctx,
      loadExplainer(ctx, args.positionals[0]!),
      args.str("note"),
    );
    if (ctx.json) ctx.emit({ ok: report.ready, ...report });
    else ctx.out(describeReadiness(report));
    return report.ready ? 0 : 1;
  },
};
