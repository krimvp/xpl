/** Explicit import/export and selected-ID outcomes; generation is owned by the next invoked revision pass. */
import { resolve } from "node:path";
import {
  FEEDBACK_SCHEMA,
  artifactIdentity,
  feedbackContextReason,
  parseFeedbackFile,
  parseFeedbackRequest,
} from "@xpl/core";
import type { CommandSpec } from "../command.js";
import { CliError } from "../errors.js";
import { atomicWrite, jsonFile, parseJson, readTextFile } from "../fsutil.js";
import { importRequests, readRequests, recordOutcomes } from "../requests.js";
import { loadExplainer, openWorkspace } from "../repo.js";

export const feedbackCommand: CommandSpec = {
  name: "feedback",
  usage: "xpl feedback <explainer> [--import <file> | --export <file> | --outcomes <file>]",
  summary: "Import, inspect or export durable reader feedback; record selected outcomes",
  details: [
    "Offline pages export code-explainer/feedback@1 JSON. Import deduplicates by stable request ID",
    "and refuses conflicting original content. Higher outcome revisions update stored results;",
    "equal or older revisions keep the current result. Timestamps never order outcomes.",
    "Browser refreshes and exports use that same rule; held revisions never decrease.",
    "Import newer portable results into the author store before recording replacements.",
    "Optional answer history retains exact head/base evidence and merges by stable answer ID independently of outcomes.",
    "Conflicting answer IDs or invalid quotes are refused; older exports never erase answers.",
    "Answer IDs belong to one request. A merge over 1000 answers per request fails without changing the store.",
    "Feedback retains its original explanation/source hashes and optional inclusive source range.",
    "Changed context is reported as outdated and requires explicit reconciliation; it is never rebound.",
    "--outcomes reads a JSON array of {id, context, status, reason}; context must match the selected",
    "request's original {explainerHash, sourceHash}. Status: pending, addressed, unresolved, rejected,",
    "outdated. Only those IDs change and increment their outcome revision. Failed writes leave the",
    "prior store intact; new feedback survives. Missing revisions in older exports read as zero.",
    "Saving/importing never starts generation. Run /code-explainer feedback in your chosen agent",
    "for the next explicit pass. Never delete the feedback store after processing a batch.",
  ],
  options: {
    import: {
      type: "string",
      arg: "file",
      desc: "Import feedback by ID and merge outcomes by revision",
    },
    export: {
      type: "string",
      arg: "file",
      desc: "Export requests including original context and outcomes",
    },
    outcomes: {
      type: "string",
      arg: "file",
      desc: "Record outcomes only for selected request IDs",
    },
  },
  positionals: [{ name: "explainer" }],
  async run(ctx, args) {
    const actions = [args.str("import"), args.str("export"), args.str("outcomes")].filter(Boolean);
    if (actions.length > 1)
      throw new CliError("choose only one of --import, --export or --outcomes");
    const loaded = loadExplainer(ctx, args.positionals[0]!);
    const ws = await openWorkspace(ctx, {
      explainer: loaded,
      deferStaleWarning: true,
      skipExplainerIndex: true,
    });
    const current = artifactIdentity(loaded.explainer, ws.index);
    let imported: number | undefined;
    if (args.str("import")) {
      const path = resolve(ctx.cwd, args.str("import")!);
      const file = parseFeedbackFile(parseJson(readTextFile(path, "feedback"), path));
      if (file.requests.some((r) => r.explainer !== undefined && r.explainer !== loaded.name))
        throw new CliError(
          "feedback names a different explainer; import it with its original guide name",
        );
      imported = (await importRequests(ctx.root, file.requests)).imported;
    }
    const queue = readRequests(ctx.root);
    if (queue.error) throw new CliError(queue.error);
    let mine = queue.requests.filter(
      (r) => r.explainer === undefined || r.explainer === loaded.name,
    );
    if (args.str("outcomes")) {
      const path = resolve(ctx.cwd, args.str("outcomes")!);
      const data = parseJson(readTextFile(path, "outcomes"), path);
      if (!Array.isArray(data)) throw new CliError("outcomes must be a JSON array");
      const updates = data.map((value: unknown) => {
        if (!value || typeof value !== "object") throw new CliError("outcome must be an object");
        const update = value as Record<string, unknown>;
        const original = mine.find((r) => r.id === update.id);
        if (!original) throw new CliError(`unknown selected request ID ${String(update.id)}`);
        // Reuse the request boundary validator for status, reason and identity.
        const checked = parseFeedbackRequest({
          ...original,
          context: update.context,
          outcome: {
            revision: original.outcome.revision,
            status: update.status,
            reason: update.reason,
            at: new Date().toISOString(),
          },
        });
        return {
          id: checked.id,
          context: checked.context,
          status: checked.outcome.status,
          reason: checked.outcome.reason,
        };
      });
      await recordOutcomes(ctx.root, updates);
      mine = readRequests(ctx.root).requests.filter(
        (r) => r.explainer === undefined || r.explainer === loaded.name,
      );
    }
    const feedback = { schema: FEEDBACK_SCHEMA, requests: mine };
    if (args.str("export"))
      await atomicWrite(resolve(ctx.cwd, args.str("export")!), jsonFile(feedback));
    const requests = mine.map((r) => {
      const contextReason =
        feedbackContextReason(r, current) ?? (ws.stale ? ws.stale.message : undefined);
      return {
        ...r,
        contextStatus: contextReason ? "outdated" : "current",
        ...(contextReason ? { contextReason } : {}),
      };
    });
    if (ctx.json)
      ctx.emit({ ...feedback, requests, ...(imported !== undefined ? { imported } : {}) });
    else
      ctx.out(
        [
          ...(imported !== undefined
            ? [`Imported ${imported}; ${mine.length} stored request(s).`]
            : []),
          ...requests.map(
            (r) =>
              `${r.id}  ${r.outcome.status}${r.contextStatus === "outdated" ? " (outdated context)" : ""}  ${r.kind} ${r.elementId}\n  ${r.outcome.reason}${r.contextReason ? `\n  ${r.contextReason}` : ""}`,
          ),
          "Run /code-explainer feedback in your chosen agent for the next explicit pass. Saving feedback does not start generation.",
        ].join("\n"),
      );
    return 0;
  },
};
