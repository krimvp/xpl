import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { GRAMMAR_IDS, loadLanguage } from "@xpl/indexer";
import pkg from "../../package.json" with { type: "json" };
import type { CommandSpec } from "../command.js";
import { UsageError, errorMessage } from "../errors.js";
import { artifactDir, defaultSkillDir, verifyArtifact, verifySkill } from "../setup.js";

const execute = promisify(execFile);

export const doctorCommand: CommandSpec = {
  name: "doctor",
  usage: "xpl doctor [--agent none|claude] [--skill-dir <path>]",
  summary: "Diagnose local setup without downloading tools or starting authoring",
  details: [
    "Checks Node >=22.12, bundled file hashes and grammar loading. Required failures exit 1.",
    "Skill and Claude Code are required only with --agent claude; the default none checks reader/index/export setup.",
    "Optional git, npx and Go checks run --version locally. Availability does not prove a precise indexer can run.",
    "Use xpl index --precise off offline. Auto precise mode may download tools/dependencies; require fails if unavailable.",
    "Claude Code authoring needs its own installation, authentication and provider access. Generation is user-invoked.",
  ],
  options: {
    agent: { type: "string", arg: "none|claude", desc: "Chosen authoring agent (default: none)" },
    "skill-dir": {
      type: "string",
      arg: "<path>",
      desc: "Installed skill to check (default: ~/.claude/skills/code-explainer)",
    },
  },
  positionals: [],
  async run(ctx, args) {
    const agent = args.str("agent") ?? "none";
    if (agent !== "none" && agent !== "claude")
      throw new UsageError("--agent must be none or claude");
    const checks: {
      id: string;
      required: boolean;
      status: "ok" | "missing";
      detail: string;
      recovery: string;
    }[] = [];
    async function check(
      id: string,
      required: boolean,
      recovery: string,
      probe: () => string | Promise<string>,
    ): Promise<void> {
      try {
        checks.push({ id, required, status: "ok", detail: await probe(), recovery });
      } catch (error) {
        checks.push({ id, required, status: "missing", detail: errorMessage(error), recovery });
      }
    }
    await check(
      "node",
      true,
      "Install Node 22.12 or newer, then reinstall the local xpl tarball.",
      () => {
        const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
        if (major < 22 || (major === 22 && minor < 12))
          throw new Error(`Node ${process.versions.node} is too old`);
        return process.versions.node;
      },
    );
    await check(
      "artifact",
      true,
      "Reinstall the local xpl tarball. For source development, run npm run build.",
      () => {
        const data = verifyArtifact();
        return `${data.version}: ${Object.keys(data.files).length} files verified in ${artifactDir}`;
      },
    );
    await check(
      "grammars",
      true,
      "Reinstall the tarball; unset XPL_WASM_DIR if it overrides the bundled grammars.",
      async () => {
        for (const id of GRAMMAR_IDS) await loadLanguage(id);
        return `${GRAMMAR_IDS.length} grammars loaded`;
      },
    );
    const skill = resolve(ctx.cwd, args.str("skill-dir") ?? defaultSkillDir(ctx.env));
    await check(
      "skill",
      agent === "claude",
      `Run xpl skill install --dir ${JSON.stringify(skill)}; rerun after CLI updates. Move local edits aside first.`,
      async () => {
        const data = verifySkill(skill);
        if (data.version !== pkg.version)
          throw new Error(
            `skill version ${data.version} differs from CLI ${pkg.version}; rerun xpl skill install`,
          );
        const result = await execute(process.execPath, [join(skill, "bin/xpl"), "--version"], {
          env: ctx.env,
          timeout: 5000,
        });
        if (result.stdout.trim() !== data.version)
          throw new Error("skill launcher version differs from the installed skill");
        return `${skill} (CLI ${data.version})`;
      },
    );
    for (const [id, recovery] of [
      [
        "git",
        "Install git for local git-range explanations. Reading, fast indexing and export also work outside git.",
      ],
      [
        "npx",
        "Install npm (with npx) for optional TS/Python precise tool bootstrap. It may need network access; use xpl index --precise off offline.",
      ],
      [
        "go",
        "Install Go for optional scip-go bootstrap (Go >=1.25; older versions may download it). Modules/tools may need network access; use xpl index --precise off offline.",
      ],
    ] as const) {
      await check(id, false, recovery, async () => {
        const result = await execute(id, [id === "go" ? "version" : "--version"], {
          env: ctx.env,
          timeout: 5000,
        });
        return result.stdout.trim();
      });
    }
    if (agent === "claude") {
      await check(
        "agent",
        true,
        "Install Claude Code, authenticate it and configure provider access separately. Invoke /code-explainer explicitly; xpl does not run a resident authoring worker.",
        async () => {
          const result = await execute("claude", ["--version"], { env: ctx.env, timeout: 5000 });
          return `${result.stdout.trim()}; authentication/provider access not checked`;
        },
      );
    }
    const ok = !checks.some((item) => item.required && item.status !== "ok");
    const network =
      "Local reading, --precise off indexing and HTML export use bundled assets without hosted xpl infrastructure. Precise bootstrap/dependencies and Claude Code provider access can need network separately.";
    if (ctx.json)
      ctx.out(
        JSON.stringify(
          { ok, platform: `${process.platform} ${process.arch}`, agent, checks, network },
          null,
          2,
        ),
      );
    else {
      ctx.out(
        `setup: ${ok ? "ready" : "needs repair"} (${process.platform} ${process.arch}; agent ${agent})`,
      );
      for (const item of checks) {
        ctx.out(
          `${item.status} ${item.required ? "required" : "optional"} ${item.id}: ${item.detail}`,
        );
        if (item.status !== "ok") ctx.out(`  recovery: ${item.recovery}`);
      }
      ctx.out(network);
    }
    return ok ? 0 : 1;
  },
};
