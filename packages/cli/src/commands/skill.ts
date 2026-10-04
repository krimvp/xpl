import { resolve } from "node:path";
import type { CommandSpec } from "../command.js";
import { UsageError } from "../errors.js";
import { defaultSkillDir, installSkill } from "../setup.js";

export const skillCommand: CommandSpec = {
  name: "skill",
  usage: "xpl skill install [--dir <path>]",
  summary: "Install or update the bundled code-explainer skill and its CLI launcher",
  details: [
    "Copies the skill to ~/.claude/skills/code-explainer by default; --dir selects a project or another agent's skill directory.",
    "Rerun after updating the CLI. The launcher records this installed CLI's absolute path; no source checkout is needed.",
    "Refuses symlinks, unmanaged directories and locally edited skill files. Move them aside before reinstalling.",
    "Installation does not start an agent. Invoke the skill explicitly in Claude Code to author explanations.",
  ],
  options: { dir: { type: "string", arg: "<path>", desc: "Destination skill directory" } },
  positionals: [{ name: "operation" }],
  async run(ctx, args) {
    if (args.positionals[0] !== "install") throw new UsageError("skill operation must be install");
    if (args.str("dir")?.trim() === "") throw new UsageError("--dir must not be empty");
    const target = resolve(ctx.cwd, args.str("dir") ?? defaultSkillDir(ctx.env));
    await installSkill(target);
    if (ctx.json) ctx.emit({ path: target });
    else
      ctx.out(
        `installed code-explainer at ${target}\nlauncher: ${target}/bin/xpl\nnext: xpl doctor --agent claude --skill-dir ${JSON.stringify(target)}`,
      );
    return 0;
  },
};
