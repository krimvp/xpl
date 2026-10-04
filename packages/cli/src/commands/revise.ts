import { resolve } from "node:path";
import type { CommandSpec } from "../command.js";
import { CliError } from "../errors.js";
import { renderIssues } from "../format.js";
import { atomicWrite, jsonFile } from "../fsutil.js";
import { describeReadiness } from "../readiness.js";
import { selectRevision, continueRevision } from "../revision.js";

export const reviseCommand: CommandSpec = {
  name: "revise",
  usage:
    "xpl revise <explainer> --select <id,id> [--include <id,id>] [-o review.json] | --run <id> [--proposal file | --decisions file | --accept]",
  summary: "Select feedback, inspect bounded proposals and accept a recoverable next revision",
  details: [
    "Select immutable feedback IDs after xpl index. The guide is preserved; anchors are resolved in memory.",
    "A chosen agent supplies --proposal JSON: [{id, patch}], with ordinary xpl apply patches, actor llm.",
    "Each patch is limited to its request's selected element and explicit --include IDs (including new IDs).",
    "Feedback's view is reading context; whole-view edits require selecting or explicitly including the view.",
    "Selected steps allow only their stepsUpdate through the enclosing view/tour.",
    "Qualify step IDs with their container: use --include view:flow/flow:1 or tour:reader/step-id.",
    "Raw flow/sequence feedback IDs resolve to their owning view; a matching tour-local ID grants no scope.",
    "Guide title/audience and user-owned fields stay protected. Reviews show before/after, source, warnings and readiness findings.",
    "--decisions reads [{id, status, reason, reconciliation?, missing?}]: one per selected request.",
    "Status is addressed, rejected, unresolved or outdated. Only addressed patches enter the candidate.",
    'Outdated accepted context needs an author reconciliation reason. missing is [{id, action: "reanchor"|"remove"}],',
    "an explicit decision for each repaired/removed missing-anchor owner. Moves need no prose change: use an empty patch.",
    "Inspect the exact decision review before --accept. Acceptance rechecks identity, live source freshness",
    "(even with XPL_SKIP_STALE_CHECK) and shared readiness before publishing the candidate atomically.",
    "The journal retains previous.json. Outcomes are recorded only after commit, only for selected IDs.",
    "Retry the same --run --accept after interruption: a published candidate is never applied twice and",
    "outcome revisions are never incremented twice. Failed reviews/acceptance leave requests retryable.",
    "Killed writers can leave locks; remove only the reported lock directories after verifying they stopped.",
    "-o writes the review packet outside the source tree; --json prints it. No model, watcher or service runs.",
  ],
  options: {
    select: {
      type: "string",
      arg: "id,id",
      desc: "Start a durable run with these immutable feedback IDs",
    },
    include: {
      type: "string",
      arg: "id,id",
      desc: "Extra IDs; qualify local steps as <view-or-tour-id>/<step-id>",
    },
    run: { type: "string", arg: "id", desc: "Inspect or continue an existing revision run" },
    proposal: {
      type: "string",
      arg: "file",
      desc: "Review recorded ordinary patches; changes no artifact",
    },
    decisions: {
      type: "string",
      arg: "file",
      desc: "Review the exact author-selected candidate; commit nothing",
    },
    accept: {
      type: "boolean",
      desc: "Commit reviewed decisions and recover selected outcomes on retry",
    },
    out: {
      type: "string",
      short: "o",
      arg: "file",
      desc: "Write explanation/source review JSON outside the repo",
    },
  },
  positionals: [{ name: "explainer" }],
  async run(ctx, args) {
    const select = args.str("select");
    const run = args.str("run");
    const proposal = args.str("proposal");
    const decisions = args.str("decisions");
    const accept = args.flag("accept");
    if (Boolean(select) === Boolean(run)) throw new CliError("choose --select or --run");
    if (
      [proposal, decisions, accept].filter(Boolean).length > 1 ||
      (select && (proposal || decisions || accept)) ||
      (run && args.str("include"))
    )
      throw new CliError(
        "select first, then use one of --proposal, --decisions or --accept with --run",
      );
    const packet = select
      ? await selectRevision(
          ctx,
          args.positionals[0]!,
          select.split(","),
          args.str("include")?.split(",") ?? [],
        )
      : await continueRevision(ctx, args.positionals[0]!, run!, { proposal, decisions, accept });
    if (args.str("out")) await atomicWrite(resolve(ctx.cwd, args.str("out")!), jsonFile(packet));
    if (ctx.json) ctx.emit(packet);
    else
      ctx.out(
        [
          `Revision ${packet.runId}: ${packet.state}. Previous artifact: ${packet.previousArtifact}`,
          ...packet.requests.map((r) => `${r.id}: ${r.contextReason ?? "current context"}`),
          ...packet.changes.map(
            (c) => `${c.id}\nBEFORE\n${jsonFile(c.before)}AFTER\n${jsonFile(c.after)}`,
          ),
          ...packet.source.map((s) => `SOURCE ${s.file}@${s.side}\n${s.text ?? "missing source"}`),
          ...renderIssues(packet.issues),
          ...("readiness" in packet && packet.readiness
            ? [describeReadiness(packet.readiness)]
            : []),
          packet.state === "done"
            ? "Committed decisions; selected outcomes recorded."
            : "Inspect this review. The artifact and outcomes change only with --run <id> --accept.",
        ].join("\n"),
      );
    return 0;
  },
};
