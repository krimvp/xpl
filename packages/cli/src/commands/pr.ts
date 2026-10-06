import type { CommandSpec } from "../command.js";
import { UsageError } from "../errors.js";
import { parsePr, resolvePr } from "../pr.js";
import { cleanupPr, prCacheDirectory, preparePr } from "../pr-checkout.js";
import { createPrHandoff, finishPr } from "../pr-creation.js";
import { checkPrLink, linkPr } from "../pr-link.js";

export const prCommand: CommandSpec = {
  name: "pr",
  usage:
    "xpl pr prepare|create|check-link <url|owner/repo#number|owner/repo> [number] [--cache-dir dir] [--precise off|auto|require] | xpl pr finish|cleanup <directory> [--cache-dir dir] | xpl pr link <staged-dir> --url <base-url> --visibility team|public",
  summary: "Create a source-backed PR guide through the installed skill and check its result",
  details: [
    "Uses existing gh and git access to GitHub. Never prompts for credentials. Only link and check-link write: one PR comment.",
    "Resolves full API base/head commits and fetches them into a new detached repository outside the developer tree.",
    "Inherited git-directory/work-tree/index overrides are excluded from all owned source reads and indexing.",
    "Checks checkout bytes against raw head blobs before indexing; filter or line-ending changes refuse input.",
    "Defaults to --precise off; auto/require opt into optional analysis tools and their network/toolchain needs.",
    "Writes immutable input.json last, with PR identity, change, before/after source and head index hashes/labels.",
    "prepare writes input only. create also needs --name, --audience and --question; --skill-dir selects the installed skill.",
    "create runs its bound launcher new/change/draft, then prints an explicit /code-explainer invocation. No model is started.",
    "Use the handoff command prefix for authoring: it pins installed CLI and owned Git paths and excludes inherited overrides.",
    "finish reuses the installed bundle readiness check and compares both current GitHub base/head before writing result.json.",
    "Matching results are ready; changed commits retain a superseded historical result and exit 1. API/export failures",
    "write no result. Every finish retains a separate result directory, with source inventory, artifact hashes and readiness.",
    "Ready attests the API check time, not future freshness. No current pointer or publication is created; publishers recheck.",
    "Default cache: $XDG_CACHE_HOME/xpl/pr or ~/.cache/xpl/pr. Custom cache must be outside the developer tree.",
    "Failed preparation removes its owned input. Interrupted processes may leave a marked directory; cleanup",
    "removes only a marked input directly under the selected cache. Stop consumers before explicit cleanup.",
    "link points one PR comment at <base-url>/current and the current version of a folder staged with --pr-result.",
    "The team serves that folder at --url; --visibility records who can read it (team is required for a private repository).",
    "link rechecks GitHub base/head first and edits its existing comment in place. It needs gh access that can comment.",
    "check-link, for a PR workflow on new commits, marks that comment outdated when base/head moved; old versions stay linked.",
    "Exit codes: 0 prepared/handed off/ready/cleaned/linked, 1 superseded or failure, 2 invalid input or options.",
  ],
  options: {
    name: { type: "string", arg: "<guide>", desc: "New guide name for create" },
    audience: { type: "string", arg: "<reader>", desc: "Creation audience" },
    question: { type: "string", arg: "<question>", desc: "Creation intent" },
    "skill-dir": {
      type: "string",
      arg: "<folder>",
      desc: "Installed code-explainer skill directory",
    },
    note: { type: "string", arg: "<reason>", desc: "Finish: record warning or omission decisions" },
    "require-review": {
      type: "boolean",
      desc: "Finish: require a current author review of all content",
    },
    "cache-dir": {
      type: "string",
      arg: "<dir>",
      desc: "Owned storage outside the developer checkout",
    },
    precise: {
      type: "string",
      arg: "off|auto|require",
      desc: "Head reference analysis (default off)",
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
          `${result.status}: ${result.manifestPath}${result.status === "superseded" ? "\nPR base/head changed; retained as historical output. Explicitly create the updated PR." : "\nLocal result only; publishing must recheck the PR before promoting current."}`,
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
        `prepared ${pr.url}\nbase: ${pr.base.sha}\nhead: ${pr.head.sha}\nrepository: ${prepared.repository}\ninput manifest: ${prepared.manifestPath}\n${handoff ? `Invoke the installed skill explicitly:\n${handoff.invocation}` : "Input only; use pr create for installed skill handoff."}`,
      );
    return 0;
  },
};
