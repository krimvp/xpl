import { resolve } from "node:path";
import type { CommandSpec } from "../command.js";
import { apiConfig, apiLiveAgent } from "../api-agent.js";
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
    "xpl live [explainer] [--since <rev>] [--port <port>] [--no-open] [--backend none|claude|api] [--model <model>] [--base-url <url>] [--agent-quiet <seconds>] [--skill-dir <folder>] [--once] [--precise auto|off|require]",
  summary:
    "Keep a guide of the architecture and of what changed in step with your edits, and serve it",
  details: [
    "After every edit: indexes, moves the guide, records the change since the base, drafts the maps again.",
    "The guide is .explainer/live.explainer.json by default; one that xpl live creates is git-ignored.",
    "The base: --since, else the merge base with the default branch, else HEAD at the first start.",
    "Once the code is quiet, a backend writes the TODOs, tour:live and the design level. none (default): you ask.",
    "claude: Claude Code. api: a model at an OpenAI-compatible endpoint, which gets the guide and source code.",
    "api reads XPL_LLM_BASE_URL, XPL_LLM_MODEL, and XPL_LLM_API_KEY (only from the environment) if it needs a key.",
    "--once runs one cycle (and one agent run with a backend) and exits without serving. Stop with Ctrl+C.",
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
      arg: "none|claude|api",
      desc: "Who writes the explanations: nobody (default), Claude Code, or a model API",
    },
    model: {
      type: "string",
      arg: "<model>",
      desc: "The model of --backend api (default: XPL_LLM_MODEL)",
    },
    "base-url": {
      type: "string",
      arg: "<url>",
      desc: "The OpenAI-compatible endpoint of --backend api (default: XPL_LLM_BASE_URL)",
    },
    "agent-quiet": {
      type: "string",
      arg: "<seconds>",
      desc: `Quiet time before the agent runs (default ${AGENT_QUIET_SECONDS})`,
    },
    "skill-dir": {
      type: "string",
      arg: "<folder>",
      desc: "The code-explainer skill (claude: Claude's skills folder; api: the bundled one)",
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
    const backend = args.choice("backend", ["none", "claude", "api"] as const) ?? "none";
    const port = args.int("port", { max: 65535 });
    const quiet = args.int("agent-quiet", { max: 86_400 }) ?? AGENT_QUIET_SECONDS;
    const once = args.flag("once");
    const skillDir = args.str("skill-dir");
    if (backend === "none" && (skillDir !== undefined || args.str("agent-quiet") !== undefined))
      throw new UsageError("--skill-dir and --agent-quiet need --backend claude or api");
    const flags = { baseUrl: args.str("base-url"), model: args.str("model") };
    if (backend !== "api" && (flags.baseUrl !== undefined || flags.model !== undefined))
      throw new UsageError("--model and --base-url need --backend api");
    const api = backend === "api" ? apiConfig(ctx.env, flags) : undefined;
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
      ...(api
        ? { agent: apiLiveAgent(api, skillDir ? { skillDir: resolve(ctx.cwd, skillDir) } : {}) }
        : {}),
      agentQuietMs: quiet * 1000,
      signal: abort.signal,
    });
    if (api && !ctx.json)
      ctx.out(
        `live: --backend api sends the guide and the source code it explains to ${api.baseUrl} (model ${api.model})`,
      );
    await live.cycle();
    if (once) {
      if (backend !== "none") await live.explain(true);
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
