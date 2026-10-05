import type { CommandSpec } from "../command.js";
import { UsageError } from "../errors.js";
import { outsideSourceDirectory } from "../pr-checkout.js";
import { stagePreview, stageVersion } from "../stage.js";

export const stageCommand: CommandSpec = {
  name: "stage",
  usage:
    "xpl stage <explainer> --dir <outside-folder> [--preview] [--files referenced|boundary|all] [--note reason] [--require-review] [--pr-result result.json]",
  summary: "Preview included source and stage a local immutable ready version",
  details: [
    "--dir is required and must be outside the source checkout, including through symlink ancestors.",
    "--preview checks readiness and lists included head/base files without creating storage or HTML.",
    "Otherwise the included files are printed before writing. Versions contain index.html and manifest.json",
    "with commits, artifactIdentity, input/HTML hashes, readiness, source scope and author review state.",
    "Rechecks readiness and source freshness before atomically replacing the relative current symlink under",
    "a lock. Prior immutable version folders remain available. Failures retain the previous current version.",
    "Open <dir>/current/index.html or <dir>/<version>/index.html locally; no server, upload or destination is configured.",
    "PR guides require --pr-result from xpl pr finish and --root pointing to the prepared checkout. Stages the",
    "validated ready HTML with version metadata and its original result manifest; rechecks GitHub base/head before promotion.",
    "--files and --note cannot change a PR result: select files and record decisions when creating that result.",
    "Current opens its immutable version URL. About this explanation links prior versions and the reading state.",
    "Saved HTML restores navigation; explicit URL targets override it. Keep the staged tree for prior-version links.",
    "Names in author review records are self-reported. --require-review explicitly requires all-content review.",
    "No draft or drift override: a guide with readiness errors cannot be staged, even with XPL_SKIP_STALE_CHECK.",
    "A crashed writer's current.lock requires explicit removal after verifying the writer stopped; locks are never stolen.",
    "If lock release fails after promotion, the command succeeds with a cleanup warning; current already changed.",
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
