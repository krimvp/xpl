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
    "xpl revise <explainer> --select <id,id> [--include <id,id>] [-o <file>] | xpl revise <explainer> --run <id> [--proposal <file> | --decisions <file> | --accept] [-o <file>]",
  summary:
    "Pick reader requests, review the changes your agent proposes, and accept the ones you want",
  details: [
    "--select starts a run with feedback ids. Your agent writes a proposal: [{id, patch}] of normal patches.",
    "Each patch may change only its request's element and the ids you --include.",
    "--proposal shows each change before and after. --decisions takes your choice per request.",
    "--accept checks the code and the guide again, then applies the accepted patches in one write.",
    "Run the same --accept again after a crash: nothing is applied twice.",
    "-o writes the review outside the source tree; --json prints it. No agent or service runs.",
  ],
  options: {
    select: {
      type: "string",
      arg: "<id,id>",
      desc: "Start a review of these feedback requests",
    },
    include: {
      type: "string",
      arg: "<id,id>",
      desc: "More ids the run may change; name a step as <view-or-tour-id>/<step-id>",
    },
    run: { type: "string", arg: "<id>", desc: "Show or continue a run that already exists" },
    proposal: {
      type: "string",
      arg: "<file>",
      desc: "Show each proposed change before and after; write nothing",
    },
    decisions: {
      type: "string",
      arg: "<file>",
      desc: "Show the result of the changes you chose; write nothing",
    },
    accept: {
      type: "boolean",
      desc: "Apply the changes you accepted (safe to run again after a crash)",
    },
    out: {
      type: "string",
      short: "o",
      arg: "<file>",
      desc: "Write the review to this JSON file (outside the repo)",
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
    if (ctx.json) ctx.emit({ ...packet });
    else
      ctx.out(
        [
          `Revision ${packet.runId}: ${packet.state}. Previous artifact: ${packet.previousArtifact}`,
          ...packet.requests.flatMap((r) => [
            `${r.id}: ${r.contextReason ?? "current context"}`,
            ...(r.note ? [`  ${JSON.stringify(r.note)}`] : []),
          ]),
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
