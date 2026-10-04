import type { CommandSpec } from "../command.js";
import { UsageError } from "../errors.js";
import { parsePr, resolvePr } from "../pr.js";
import { cleanupPr, prCacheDirectory, preparePr } from "../pr-checkout.js";

export const prCommand: CommandSpec = {
  name: "pr",
  usage:
    "xpl pr prepare <url|owner/repo#number|owner/repo> [number] [--cache-dir dir] [--precise off|auto|require] | xpl pr cleanup <directory> [--cache-dir dir]",
  summary: "Prepare exact GitHub PR commits outside the developer checkout",
  details: [
    "Uses existing gh and git access to GitHub. Never prompts for credentials or writes to GitHub.",
    "Resolves full API base/head commits and fetches them into a new detached repository outside the developer tree.",
    "Inherited git-directory/work-tree/index overrides are excluded from all owned source reads and indexing.",
    "Checks checkout bytes against raw head blobs before indexing; filter or line-ending changes refuse input.",
    "Defaults to --precise off; auto/require opt into optional analysis tools and their network/toolchain needs.",
    "Writes immutable input.json last, with PR identity, change, before/after source and head index hashes/labels.",
    "This prepares input only: no agent is invoked, no explanation or ready result is produced, and head freshness",
    "is not rechecked. Creation and current-version promotion are a later step. Each run retains a separate input.",
    "Default cache: $XDG_CACHE_HOME/xpl/pr or ~/.cache/xpl/pr. Custom cache must be outside the developer tree.",
    "Failed preparation removes its owned input. Interrupted processes may leave a marked directory; cleanup",
    "removes only a marked input directly under the selected cache. Stop consumers before explicit cleanup.",
    "Exit codes: 0 prepared/cleaned, 1 access/fetch/index/cleanup failed, 2 invalid input or options.",
  ],
  options: {
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
    if (action !== "prepare")
      throw new UsageError(
        "use xpl pr prepare for a GitHub PR or xpl pr cleanup for an owned input",
      );
    const input = parsePr(args.positionals[1]!, args.positionals[2]);
    const cache = await prCacheDirectory(ctx, args.str("cache-dir"));
    const pr = await resolvePr(input, ctx.cwd, ctx.env, ctx.io.signal);
    const prepared = await preparePr(ctx, pr, cache, precise);
    for (const warning of prepared.manifest.warnings) ctx.warn(warning);
    if (ctx.json)
      ctx.emit({
        directory: prepared.directory,
        repository: prepared.repository,
        manifestPath: prepared.manifestPath,
        pr,
      });
    else
      ctx.out(
        `prepared ${pr.url}\nbase: ${pr.base.sha}\nhead: ${pr.head.sha}\nrepository: ${prepared.repository}\ninput manifest: ${prepared.manifestPath}\nInput only; creation and ready checks remain.`,
      );
    return 0;
  },
};
