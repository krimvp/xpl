import { validateExplainer } from "@xpl/core";
import type { CommandSpec } from "../command.js";
import { issueSummary, renderIssues } from "../format.js";
import { loadExplainer, openWorkspace } from "../repo.js";

export const validateCommand: CommandSpec = {
  name: "validate",
  usage: "xpl validate <explainer> [--lenient]",
  summary: "Check an explainer against the index",
  details: [
    "Checks ids, references, anchors (they must still resolve: ok or moved) and the evidence rule for",
    "llm edges against the index and the working-tree text. Strict by default; --lenient (use it after",
    "`xpl resolve --write`) turns drifted and missing anchors into warnings.",
    "Exit codes: 0 no errors (warnings allowed), 1 errors.",
  ],
  options: {
    lenient: {
      type: "boolean",
      desc: "Drifted and missing anchors, and vanished ids, are warnings instead of errors",
    },
  },
  positionals: [{ name: "explainer" }],
  async run(ctx, args) {
    const loaded = loadExplainer(ctx, args.positionals[0]!);
    const ws = await openWorkspace(ctx, { explainer: loaded });
    const mode = args.flag("lenient") ? "lenient" : "strict";
    const issues = validateExplainer(loaded.explainer, ws.model, ws.texts, { mode });
    const errors = issues.filter((issue) => issue.severity === "error").length;
    if (ctx.json) {
      ctx.emit({
        ok: errors === 0,
        path: loaded.rel,
        mode,
        index: ws.indexRel,
        errors,
        warnings: issues.length - errors,
        issues,
      });
      return errors === 0 ? 0 : 1;
    }
    if (issues.length === 0) {
      ctx.out(
        `ok: ${loaded.rel} is valid (${mode}, index ${ws.index.commit}); no errors, no warnings`,
      );
      return 0;
    }
    ctx.out(
      [
        `${loaded.rel} (${mode}, index ${ws.index.commit}): ${issueSummary(issues)}`,
        ...renderIssues(issues),
      ].join("\n"),
    );
    return errors === 0 ? 0 : 1;
  },
};
