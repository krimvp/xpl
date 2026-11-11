import { resolve } from "node:path";
import type { CommandSpec } from "../command.js";
import { claudeLiveAgent } from "../claude-runner.js";
import { UsageError } from "../errors.js";
import { AGENT_QUIET_SECONDS, openLive } from "../live.js";
import { readViewerHtml } from "../viewer-html.js";
import { listen, openBrowser, untilStopped } from "./view.js";

const PRECISE = ["auto", "off", "require"] as const;

/**
 * `xpl live`: one foreground process next to an AI coding session. It keeps a guide in step with the working tree
 * (`live.ts`) and serves it, with its status at `/api/live`.
 */
export const liveCommand: CommandSpec = {
  name: "live",
  usage:
    "xpl live [explainer] [--since <rev>] [--port <port>] [--no-open] [--backend none|claude] [--agent-quiet <seconds>] [--skill-dir <folder>] [--once] [--precise auto|off|require]",
  summary:
    "Keep a guide of the architecture and of what changed in step with your edits, and serve it",
  details: [
    "After every edit: indexes, moves the guide, records the change since the base, drafts the maps again.",
    "The guide is .explainer/live.explainer.json by default; one that xpl live creates is git-ignored.",
    "The base: --since, else the merge base with the default branch, else HEAD at the first start.",
    "Maps go top-down: the system, its parts, the files of a part, the code. Written text is never overwritten.",
    "--backend claude runs Claude Code once the code is quiet: it writes the TODOs, the tour tour:live and, for a change across parts, its design level.",
    "With none (the default), ask your own agent to follow the skill's reference/live.md after each task.",
    "--once runs one cycle (and one agent run with claude) and exits without serving. Stop with Ctrl+C.",
  ],
  options: {
    since: {
      type: "string",
      arg: "<rev>",
      desc: "Measure the change from this revision (remembered)",
    },
    port: {
      type: "string",
      arg: "<port>",
      desc: "Port (default 4747, else any free port; 0 = any)",
    },
    "no-open": { type: "boolean", desc: "Do not open the browser" },
    backend: {
      type: "string",
      arg: "none|claude",
      desc: "Who writes the explanations: nobody (default) or Claude Code",
    },
    "agent-quiet": {
      type: "string",
      arg: "<seconds>",
      desc: `Quiet time before the agent runs (default ${AGENT_QUIET_SECONDS})`,
    },
    "skill-dir": {
      type: "string",
      arg: "<folder>",
      desc: "The installed code-explainer skill (default: Claude's skills folder)",
    },
    once: { type: "boolean", desc: "Run one cycle and exit, without serving" },
    precise: {
      type: "string",
      arg: "auto|off|require",
      desc: "Reference resolution of the index (default auto)",
    },
  },
  positionals: [{ name: "explainer", required: false }],
  async run(ctx, args) {
    const name = (args.positionals[0] ?? "live").replace(/\.explainer\.json$/, "");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
      throw new UsageError("guide name must use letters, digits, periods, underscores or hyphens");
    if (ctx.indexOption) throw new UsageError("xpl live builds its own index; omit --index");
    const since = args.str("since")?.trim();
    if (since === "") throw new UsageError("--since must name a revision (e.g. main or HEAD~3)");
    const precise = args.choice("precise", PRECISE) ?? "auto";
    const backend = args.choice("backend", ["none", "claude"] as const) ?? "none";
    const port = args.int("port", { max: 65535 });
    const quiet = args.int("agent-quiet", { max: 86_400 }) ?? AGENT_QUIET_SECONDS;
    const once = args.flag("once");
    const skillDir = args.str("skill-dir");
    if (backend === "none" && (skillDir !== undefined || args.str("agent-quiet") !== undefined))
      throw new UsageError("--skill-dir and --agent-quiet need --backend claude");
    if (!once) readViewerHtml(ctx.env); // fail early, with the "run npm run build" hint

    const abort = new AbortController();
    const live = await openLive(ctx, {
      name,
      ...(since !== undefined ? { since } : {}),
      precise,
      backend,
      ...(backend === "claude"
        ? {
            agent: claudeLiveAgent(ctx, skillDir ? { skillDir: resolve(ctx.cwd, skillDir) } : {}),
          }
        : {}),
      agentQuietMs: quiet * 1000,
      signal: abort.signal,
    });
    await live.cycle();
    if (once) {
      if (backend === "claude") await live.explain(true);
      const status = live.status();
      if (ctx.json) ctx.emit({ live: status });
      return status.explanation.state === "failed" ? 1 : 0;
    }

    const server = await listen(ctx, live.guidePath, "127.0.0.1", port, undefined, live.status);
    if (ctx.json) ctx.emit({ url: server.url, port: server.port, guide: live.status().guide });
    else ctx.out(`serving ${name} at ${server.url}  (Ctrl+C to stop)`);
    if (!args.flag("no-open")) openBrowser(server.url);
    ctx.io.onServer?.(server);
    const stopped = untilStopped(ctx.io.signal).then(() => abort.abort());
    await live.watch();
    await stopped;
    await server.close();
    return 0;
  },
};
