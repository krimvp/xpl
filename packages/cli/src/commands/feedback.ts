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
import { plural } from "../format.js";
import { atomicWrite, jsonFile, parseJson, readTextFile } from "../fsutil.js";
import {
  importRequests,
  isOpenRequest,
  readRequests,
  recordOutcomes,
  requestLines,
} from "../requests.js";
import { loadExplainer, openWorkspace } from "../repo.js";

export const feedbackCommand: CommandSpec = {
  name: "feedback",
  usage: "xpl feedback <explainer> [--import <file> | --export <file> | --outcomes <file>]",
  summary: "Import, list or export reader requests, and record what was done with each",
  details: [
    "Reader requests come from the viewer (`Explain this`) or from a page as code-explainer/feedback@1 JSON.",
    "--import merges a file by request id; --export writes the requests with their context and outcomes.",
    "--outcomes reads [{id, context, status, reason}]: pending, addressed, unresolved, rejected or outdated.",
    "A newer outcome revision replaces an older one. A request whose code changed is outdated, never rebound.",
    "This command starts no agent. Ask your agent for the next feedback pass.",
  ],
  options: {
    import: {
      type: "string",
      arg: "<file>",
      desc: "Merge the requests of this file into the guide's feedback",
    },
    export: {
      type: "string",
      arg: "<file>",
      desc: "Write the requests, with their context and outcomes",
    },
    outcomes: {
      type: "string",
      arg: "<file>",
      desc: "Record what was done with these requests",
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
        throw new CliError("feedback names a different guide; import it with that guide's name");
      imported = (await importRequests(ctx.root, file.requests, { dropDuplicates: true })).imported;
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
    const exportTo = args.str("export");
    if (exportTo) await atomicWrite(resolve(ctx.cwd, exportTo), jsonFile(feedback));
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
          ...(exportTo ? [`wrote ${exportTo} (${plural(mine.length, "request")})`] : []),
          ...(imported !== undefined
            ? [
                `imported ${plural(imported, "request")}; ${mine.length} ${mine.length === 1 ? "is" : "are"} stored for ${loaded.name}`,
              ]
            : []),
          ...(requests.length === 0 ? [`no reader requests for ${loaded.name}`] : []),
          ...requests.flatMap((r) => requestLines(r, r.contextReason)),
          ...(requests.some(isOpenRequest)
            ? [
                "To act on the requests, start the code-explainer skill in your agent. Saving feedback starts nothing.",
              ]
            : []),
        ].join("\n"),
      );
    return 0;
  },
};
