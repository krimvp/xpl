import { validateExplainer } from "@xpl/core";
import type { CommandSpec } from "../command.js";
import { issueSummary, renderIssues } from "../format.js";
import { loadReadExplainer, openWorkspace } from "../repo.js";

export const validateCommand: CommandSpec = {
  name: "validate",
  usage: "xpl validate [explainer] [--lenient]",
  summary: "Check a guide against the index",
  details: [
    "Checks the guide's ids, references and code links against the index and the files. A code link must",
    "still resolve (ok or moved), and an arrow your agent added must have one. The index must match the",
    "working tree: run `xpl index` and `xpl resolve <explainer> --write` after you change code. --lenient",
    "makes drifted or missing code links and a stale index warnings. With one guide in the repository,",
    "leave out its name.",
    "Exit codes: 0 no errors (warnings allowed), 1 errors, 2 usage error.",
  ],
  options: {
    lenient: {
      type: "boolean",
      desc: "Drifted and missing code links, and gone ids, are warnings, not errors",
    },
  },
  positionals: [{ name: "explainer", required: false }],
  async run(ctx, args) {
    const loaded = loadReadExplainer(ctx, args.positionals[0], "validate");
    const mode = args.flag("lenient") ? "lenient" : "strict";
    const ws = await openWorkspace(ctx, {
      explainer: loaded,
      deferStaleWarning: true,
      requireFreshIndex: mode === "strict",
    });
    const issues = validateExplainer(loaded.explainer, ws.model, ws.texts, { mode });
    if (ws.stale) {
      issues.unshift({
        severity: mode === "strict" ? "error" : "warning",
        path: "index",
        code: "commit",
        message: ws.stale.message,
      });
    }
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
        ...renderIssues(issues, loaded.name),
      ].join("\n"),
    );
    return errors === 0 ? 0 : 1;
  },
};
