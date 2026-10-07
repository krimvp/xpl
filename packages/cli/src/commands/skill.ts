import { resolve } from "node:path";
import type { CommandSpec } from "../command.js";
import { UsageError } from "../errors.js";
import { defaultSkillDir, installSkill, type SkillAgent } from "../setup.js";

export const skillCommand: CommandSpec = {
  name: "skill",
  usage: "xpl skill install [--agent claude|codex|pi|droid|devin] [--dir <path>]",
  summary: "Install or update the bundled code-explainer skill and its CLI launcher",
  details: [
    "Installs to the selected harness's native skill directory. Claude is the default; Codex, Pi and Droid use ~/.agents/skills/code-explainer. Devin uses <repo>/.agents/skills/code-explainer.",
    "Rerun after updating the CLI. The launcher records this installed CLI's absolute path; no source checkout is needed.",
    "Refuses symlinks, unmanaged directories and locally edited skill files. Move them aside before reinstalling.",
    "Installation does not start an agent. Invoke the installed skill explicitly in your harness to author explanations.",
  ],
  options: {
    agent: {
      type: "string",
      arg: "claude|codex|pi|droid|devin",
      desc: "Target harness (default: claude)",
    },
    dir: { type: "string", arg: "<path>", desc: "Destination skill directory" },
  },
  positionals: [{ name: "operation" }],
  async run(ctx, args) {
    if (args.positionals[0] !== "install") throw new UsageError("skill operation must be install");
    const agent = args.str("agent") ?? "claude";
    if (!["claude", "codex", "pi", "droid", "devin"].includes(agent))
      throw new UsageError("--agent must be claude, codex, pi, droid, or devin");
    if (args.str("dir")?.trim() === "") throw new UsageError("--dir must not be empty");
    const selectedAgent = agent as SkillAgent;
    const target = resolve(
      ctx.cwd,
      args.str("dir") ?? defaultSkillDir(ctx.env, selectedAgent, ctx.root),
    );
    await installSkill(target);
    if (ctx.json) ctx.emit({ path: target });
    else
      ctx.out(
        `installed code-explainer for ${selectedAgent} at ${target}\nlauncher: ${target}/bin/xpl\nnext: xpl doctor --agent ${selectedAgent} --skill-dir ${JSON.stringify(target)}`,
      );
    return 0;
  },
};
