import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { GRAMMAR_IDS, loadLanguage } from "@xpl/indexer";
import pkg from "../../package.json" with { type: "json" };
import type { CommandSpec } from "../command.js";
import { UsageError, errorMessage } from "../errors.js";
import {
  artifactDir,
  defaultSkillDir,
  verifyArtifact,
  verifySkill,
  type SkillAgent,
} from "../setup.js";

const execute = promisify(execFile);
const REGISTRY_LATEST = "https://registry.npmjs.org/@krimvp%2Fxpl/latest";

class SkillVersionError extends Error {
  constructor(
    message: string,
    readonly status: "outdated" | "mismatch",
    readonly recovery: string,
  ) {
    super(message);
  }
}

function compareVersions(left: string, right: string): number | undefined {
  const parse = (value: string) =>
    /^\d+\.\d+\.\d+$/.test(value) ? value.split(".").map(Number) : undefined;
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return undefined;
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! - b[i]!;
  }
  return 0;
}

export const doctorCommand: CommandSpec = {
  name: "doctor",
  usage: "xpl doctor [--agent none|claude|codex|pi|droid|devin] [--skill-dir <path>]",
  summary: "Diagnose local setup without downloading tools or starting authoring",
  details: [
    "Checks Node >=22.12, bundled file hashes and grammar loading. Required failures exit 1.",
    "A selected skill and local agent command are checked for Claude, Codex, Pi and Droid. Devin checks the project skill files; its cloud session is not locally verifiable. The default none checks reader/index/export setup.",
    "Optional git, npx and Go checks report local versions. Availability does not prove a precise indexer can run.",
    "An older skill needs xpl skill install; a newer skill needs a matching CLI. Checks npm for a newer xpl version when reachable. Set XPL_NO_UPDATE_CHECK=1 to skip this network check.",
    "Go uses the installed toolchain with user configuration and telemetry disabled; Git tracing is disabled.",
    "Use xpl index --precise off offline. Auto precise mode may download tools/dependencies; require fails if unavailable.",
    "Agent authentication and provider access are not checked. Devin cloud skill loading is not locally verifiable. Generation is user-invoked.",
  ],
  options: {
    agent: {
      type: "string",
      arg: "none|claude|codex|pi|droid|devin",
      desc: "Chosen authoring agent (default: none)",
    },
    "skill-dir": {
      type: "string",
      arg: "<path>",
      desc: "Installed skill to check (default: ~/.claude/skills/code-explainer)",
    },
  },
  positionals: [],
  async run(ctx, args) {
    const agent = args.str("agent") ?? "none";
    if (!["none", "claude", "codex", "pi", "droid", "devin"].includes(agent))
      throw new UsageError("--agent must be none, claude, codex, pi, droid, or devin");
    const checks: {
      id: string;
      required: boolean;
      status: "ok" | "missing" | "outdated" | "mismatch";
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
        checks.push({
          id,
          required,
          status: error instanceof SkillVersionError ? error.status : "missing",
          detail: errorMessage(error),
          recovery: error instanceof SkillVersionError ? error.recovery : recovery,
        });
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
    const selectedAgent = agent === "none" ? "claude" : (agent as SkillAgent);
    const skill = resolve(
      ctx.cwd,
      args.str("skill-dir") ?? defaultSkillDir(ctx.env, selectedAgent, ctx.root),
    );
    const installCommand = `xpl skill install --agent ${selectedAgent} --dir ${JSON.stringify(skill)}`;
    await check(
      "skill",
      agent !== "none",
      `Run ${installCommand}; rerun after CLI updates. Move local edits aside first.`,
      async () => {
        const data = verifySkill(skill);
        if (data.version !== pkg.version) {
          const order = compareVersions(data.version, pkg.version);
          throw new SkillVersionError(
            `skill version ${data.version} ${order === undefined ? "differs from" : order < 0 ? "<" : ">"} CLI ${pkg.version}`,
            order !== undefined && order < 0 ? "outdated" : "mismatch",
            order !== undefined && order < 0
              ? `Run ${installCommand}; move local edits aside first.`
              : `Install CLI version ${data.version} or newer; this older CLI cannot repair the installed skill.`,
          );
        }
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
          env:
            id === "go"
              ? {
                  ...ctx.env,
                  GOTOOLCHAIN: "local",
                  GOENV: "off",
                  // Go 1.23+ opens telemetry before handling `version`. No user config directory
                  // leaves telemetry off, without writing a mode file or changing the user's settings.
                  HOME: "",
                  XDG_CONFIG_HOME: "",
                  APPDATA: "",
                  TEST_TELEMETRY_DIR: "",
                }
              : id === "git"
                ? {
                    ...ctx.env,
                    ...Object.fromEntries(
                      Object.keys(ctx.env)
                        .filter((key) => key.startsWith("GIT_TRACE"))
                        .map((key) => [key, "0"]),
                    ),
                    GIT_TRACE2: "0",
                    GIT_TRACE2_EVENT: "0",
                    GIT_TRACE2_PERF: "0",
                  }
                : ctx.env,
          timeout: 5000,
        });
        return result.stdout.trim();
      });
    }
    if (agent !== "none" && agent !== "devin") {
      const agentName = agent;
      const label =
        agentName === "claude"
          ? "Claude Code"
          : agentName === "droid"
            ? "Factory Droid"
            : agentName === "codex"
              ? "Codex"
              : "Pi";
      await check(
        "agent",
        true,
        `Install ${label}; authenticate it and configure provider access separately. xpl does not start an authoring worker.`,
        async () => {
          const result = await execute(agentName, ["--version"], { env: ctx.env, timeout: 5000 });
          return `${result.stdout.trim()}; authentication/provider access not checked`;
        },
      );
    }
    if (agent === "devin") {
      checks.push({
        id: "agent",
        required: false,
        status: "ok",
        detail: "Devin cloud skill loading and provider access are not locally verifiable.",
        recovery:
          "Check the skill in Devin's project settings and confirm it is available in the session.",
      });
    }
    if (ctx.env.XPL_NO_UPDATE_CHECK !== "1") {
      try {
        const response = await fetch(REGISTRY_LATEST, { signal: AbortSignal.timeout(1500) });
        if (response.ok) {
          const latest = (await response.json()) as { version?: unknown };
          const order =
            typeof latest.version === "string"
              ? compareVersions(pkg.version, latest.version)
              : undefined;
          if (order !== undefined && order < 0)
            checks.push({
              id: "update",
              required: false,
              status: "outdated",
              detail: `CLI ${pkg.version} < latest ${latest.version}`,
              recovery: "Run npm update -g @krimvp/xpl, then xpl skill install for your agent.",
            });
        }
      } catch {
        // Offline diagnosis keeps working without a registry response.
      }
    }
    const ok = !checks.some((item) => item.required && item.status !== "ok");
    const network =
      "Local reading, --precise off indexing and HTML export use bundled assets. Doctor alone checks the npm registry for updates unless XPL_NO_UPDATE_CHECK=1. Precise bootstrap/dependencies and selected agent provider access can need network separately.";
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
