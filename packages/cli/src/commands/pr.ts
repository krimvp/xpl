import type { CommandSpec } from "../command.js";
import { UsageError } from "../errors.js";
import { parsePr, resolvePr } from "../pr.js";
import { cleanupPr, prCacheDirectory, preparePr } from "../pr-checkout.js";
import { createPrHandoff, finishPr } from "../pr-creation.js";
import { checkPrLink, linkPr } from "../pr-link.js";

export const prCommand: CommandSpec = {
  name: "pr",
  usage:
    "xpl pr prepare|check-link <PR> [<number>] [--cache-dir <dir>] [--precise auto|off|require] | xpl pr create <PR> [<number>] --name <guide> --audience <reader> --question <question> [--skill-dir <folder>] [--cache-dir <dir>] [--precise auto|off|require] | xpl pr finish <input-directory> [--note <reason>] [--require-review] [--cache-dir <dir>] | xpl pr cleanup <input-directory> [--cache-dir <dir>] | xpl pr link <staged-dir> --url <base-url> --visibility team|public",
  summary: "Create a source-backed PR guide through the installed skill and check its result",
  details: [
    "<PR> is a pull request URL, owner/repo#number, or owner/repo and a number. Uses your gh and git access.",
    "prepare fetches base and head into a new checkout outside your tree and writes input.json.",
    "create also needs --name, --audience and --question, and prints the task for your agent.",
    "finish checks the guide's readiness and the PR's commits, then writes result.json.",
    "cleanup removes a marked input folder from the cache.",
    "link points one PR comment at a staged folder; check-link marks that comment outdated after new commits.",
    "Exit codes: 0 done, 1 superseded or failed, 2 invalid input or options.",
  ],
  options: {
    name: { type: "string", arg: "<guide>", desc: "New guide name for create" },
    audience: { type: "string", arg: "<reader>", desc: "Who the new guide is for" },
    question: { type: "string", arg: "<question>", desc: "The question the new guide answers" },
    "skill-dir": {
      type: "string",
      arg: "<folder>",
      desc: "The folder of the installed code-explainer skill",
    },
    note: {
      type: "string",
      arg: "<reason>",
      desc: "Finish: write why you keep a warning or leave something out",
    },
    "require-review": {
      type: "boolean",
      desc: "Finish: fail unless a person reviewed the current text",
    },
    "cache-dir": {
      type: "string",
      arg: "<dir>",
      desc: "Folder for checkouts and inputs, outside your checkout",
    },
    precise: {
      type: "string",
      arg: "auto|off|require",
      desc: "Reference analysis of the head (default off)",
    },
    url: {
      type: "string",
      arg: "<base-url>",
      desc: "Link: where the team serves the staged folder",
    },
    visibility: {
      type: "string",
      arg: "team|public",
      desc: "Link: who can read that destination (required)",
    },
  },
  positionals: [{ name: "action" }, { name: "input" }, { name: "number", required: false }],
  async run(ctx, args) {
    const action = args.positionals[0];
    const precise = args.choice("precise", ["off", "auto", "require"] as const) ?? "off";
    if (ctx.indexOption)
      throw new UsageError("xpl pr builds its own head index; --index is not accepted");
    if (action === "cleanup") {
      if (args.positionals[2] || args.str("precise"))
        throw new UsageError("cleanup takes one owned directory and no --precise option");
      const cache = await prCacheDirectory(ctx, args.str("cache-dir"));
      await cleanupPr(ctx, args.positionals[1]!, cache);
      if (ctx.json) ctx.emit({ cleaned: args.positionals[1] });
      else ctx.out(`removed owned PR input: ${args.positionals[1]}`);
      return 0;
    }
    if (action === "link") {
      const url = args.str("url");
      const visibility = args.choice("visibility", ["team", "public"] as const);
      if (!url || !visibility || args.positionals[2])
        throw new UsageError(
          "link takes one staged folder, --url <base-url> and --visibility team|public",
        );
      const result = await linkPr(ctx, args.positionals[1]!, url, visibility);
      if (ctx.json) ctx.emit(result);
      else
        ctx.out(
          `PR link ${result.action}: ${result.pr}\ncurrent: ${result.current}\nversion: ${result.version}`,
        );
      return 0;
    }
    if (action === "check-link") {
      const result = await checkPrLink(ctx, parsePr(args.positionals[1]!, args.positionals[2]));
      if (ctx.json) ctx.emit(result);
      else ctx.out(`PR link ${result.action}: ${result.pr}`);
      return 0;
    }
    if (action === "finish") {
      if (args.positionals[2] || args.str("precise"))
        throw new UsageError("finish takes one owned input directory and no --precise option");
      const cache = await prCacheDirectory(ctx, args.str("cache-dir"));
      const result = await finishPr(
        ctx,
        args.positionals[1]!,
        cache,
        args.str("note"),
        args.flag("require-review"),
      );
      if (ctx.json)
        ctx.emit({
          ok: result.status === "ready",
          directory: result.directory,
          manifestPath: result.manifestPath,
          status: result.status,
          pr: result.manifest.pr,
          observed: result.manifest.observed,
          readiness: result.manifest.readiness,
        });
      else
        ctx.out(
          `${result.status}: ${result.manifestPath}${result.status === "superseded" ? "\nPR base/head changed; this output is kept as history. Create the updated PR." : "\nLocal result only; publishing must recheck the PR before promoting current."}`,
        );
      return result.status === "ready" ? 0 : 1;
    }
    if (action !== "prepare" && action !== "create")
      throw new UsageError(
        "use xpl pr prepare/create for a GitHub PR, finish for an authored input, cleanup for an owned input, or link/check-link for its preview comment",
      );
    if (
      action === "create" &&
      (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(args.str("name") ?? "") ||
        !args.str("audience")?.trim() ||
        !args.str("question")?.trim())
    )
      throw new UsageError(
        "create requires --name <new-guide>, --audience <reader> and --question <intent>",
      );
    const input = parsePr(args.positionals[1]!, args.positionals[2]);
    const cache = await prCacheDirectory(ctx, args.str("cache-dir"));
    const pr = await resolvePr(input, ctx.cwd, ctx.env, ctx.io.signal);
    const prepared = await preparePr(ctx, pr, cache, precise);
    const handoff =
      action === "create"
        ? await createPrHandoff(
            ctx,
            prepared,
            args.str("name")!,
            args.str("audience")!,
            args.str("question")!,
            args.str("skill-dir"),
          )
        : undefined;
    for (const warning of prepared.manifest.warnings) ctx.warn(warning);
    if (ctx.json)
      ctx.emit({
        directory: prepared.directory,
        repository: prepared.repository,
        manifestPath: prepared.manifestPath,
        pr,
        ...(handoff ?? {}),
      });
    else
      ctx.out(
        `prepared ${pr.url}\nbase: ${pr.base.sha}\nhead: ${pr.head.sha}\nrepository: ${prepared.repository}\ninput manifest: ${prepared.manifestPath}\n${handoff ? `Start the installed skill:\n${handoff.invocation}` : "Input only; use pr create for installed skill handoff."}`,
      );
    return 0;
  },
};
