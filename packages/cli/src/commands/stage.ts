import type { CommandSpec } from "../command.js";
import { UsageError } from "../errors.js";
import { outsideSourceDirectory } from "../pr-checkout.js";
import { stagePreview, stageVersion } from "../stage.js";

export const stageCommand: CommandSpec = {
  name: "stage",
  usage:
    "xpl stage <explainer> --dir <outside-folder> [--preview] [--files referenced|boundary|all] [--note <reason>] [--require-review] [--pr-result <result.json>]",
  summary:
    "Save a finished guide as a fixed version on this machine (--preview lists the code it holds)",
  details: [
    "Saves a ready guide as a version folder with index.html and manifest.json, under --dir.",
    "--dir must be outside the source checkout. --preview lists the files it would hold and writes nothing.",
    "It checks readiness and the code again, then points `current` at the new version. Old versions stay.",
    "Open <dir>/current/index.html. Nothing is uploaded; `xpl pr link` points a PR at a served folder.",
    "A PR guide needs --pr-result from `xpl pr finish`. A guide with readiness errors is never staged.",
  ],
  options: {
    dir: {
      type: "string",
      arg: "<outside-folder>",
      desc: "Local version storage outside the source checkout (required)",
    },
    preview: { type: "boolean", desc: "Show readiness and included files without writing" },
    files: {
      type: "string",
      arg: "referenced|boundary|all",
      desc: "Source selection (default referenced; PR results keep their selection)",
    },
    note: {
      type: "string",
      arg: "<reason>",
      desc: "Record an author decision about warnings or omissions",
    },
    "require-review": {
      type: "boolean",
      desc: "Require a current author review of all stored content",
    },
    "pr-result": {
      type: "string",
      arg: "<result.json>",
      desc: "Matching immutable ready result from xpl pr finish",
    },
  },
  positionals: [{ name: "explainer" }],
  async run(ctx, args) {
    const dir = args.str("dir");
    if (!dir) throw new UsageError("missing --dir <outside-folder>");
    if (args.str("pr-result") && (args.str("files") || args.str("note")))
      throw new UsageError(
        "--pr-result keeps its recorded files and note; do not pass --files or --note",
      );
    const destination = await outsideSourceDirectory(ctx, dir);
    const options = {
      files: args.choice("files", ["referenced", "boundary", "all"] as const),
      note: args.str("note"),
      requireReview: args.flag("require-review"),
      prResult: args.str("pr-result"),
    };
    const preview = await stagePreview(ctx, args.positionals[0]!, options);
    if (preview.report.findings.length)
      ctx.warn(`${preview.report.warnings} reader warnings; inspect xpl ready for details.`);
    if (!ctx.json)
      ctx.out(
        [
          "Included source (what will be staged):",
          ...preview.includedSource.head.map((file) => `  head: ${file}`),
          ...preview.includedSource.base.map((file) => `  base: ${file}`),
        ].join("\n"),
      );
    if (args.flag("preview")) {
      if (ctx.json)
        ctx.emit({
          preview: true,
          destination,
          readiness: preview.report,
          includedSource: preview.includedSource,
        });
      return 0;
    }
    const result = await stageVersion(ctx, args.positionals[0]!, destination, options, preview);
    if (ctx.json) ctx.emit({ ...result, includedSource: preview.includedSource });
    else ctx.out(`Current: ${result.current}\nVersion retained: ${result.directory}`);
    return 0;
  },
};
