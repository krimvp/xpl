import { spawn } from "node:child_process";
import { describeDrift, freshAnchors } from "../bundle-data.js";
import type { CommandSpec } from "../command.js";
import type { Ctx } from "../context.js";
import { CliError } from "../errors.js";
import { loadReadExplainer, openWorkspace } from "../repo.js";
import { startViewServer, type ViewServer } from "../server.js";
import { readViewerHtml } from "../viewer-html.js";

/** Tried first when `--port` is not given; a free port is used when it is taken. */
export const DEFAULT_PORT = 4747;

/** Best effort: failures (no desktop, no xdg-open) are ignored, the URL is printed anyway. */
export function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command!, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // ignored on purpose
  }
}

/** Resolves when the abort signal fires or the process gets SIGINT / SIGTERM. */
export function untilStopped(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      signal?.removeEventListener("abort", stop);
      resolve();
    };
    if (signal?.aborted) return stop();
    signal?.addEventListener("abort", stop, { once: true });
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

export async function listen(
  ctx: Ctx,
  explainerPath: string,
  host: string,
  port: number | undefined,
  control?: Parameters<typeof startViewServer>[0]["control"],
  live?: Parameters<typeof startViewServer>[0]["live"],
) {
  const start = (p: number): Promise<ViewServer> =>
    startViewServer({
      env: ctx,
      explainerPath,
      host,
      port: p,
      viewerHtml: () => readViewerHtml(ctx.env),
      ...(control ? { control } : {}),
      ...(live ? { live } : {}),
    });
  if (port !== undefined) return start(port);
  try {
    return await start(DEFAULT_PORT);
  } catch (error) {
    if (error instanceof CliError && error.extra.code === "EADDRINUSE") return start(0);
    throw error;
  }
}

export const viewCommand: CommandSpec = {
  name: "view",
  usage: "xpl view [explainer] [--port <port>] [--host <host>] [--no-open]",
  summary: "Serve the viewer locally with live repo access",
  details: [
    "Serves the viewer on http://127.0.0.1:<port>/ (port 4747, else a free one) and opens the browser.",
    "The page loads the guide, the index and the code, and refreshes them when they change.",
    "Edits in the viewer are saved to the guide as your edits. `Explain this` requests go to .explainer/.",
    "Unlike bundle, view shows a guide whose code links drifted, and says which parts may be out of date.",
    "Use --host only when you mean it: any address other than 127.0.0.1 exposes your code. Stop with Ctrl+C.",
    "From source, run npm run build first. XPL_VIEWER_HTML overrides the page.",
  ],
  options: {
    port: {
      type: "string",
      arg: "<port>",
      desc: `Port (default ${DEFAULT_PORT}, else any free port; 0 = any)`,
    },
    host: { type: "string", arg: "<host>", desc: "Address to bind (default 127.0.0.1)" },
    "no-open": { type: "boolean", desc: "Do not open the browser" },
  },
  positionals: [{ name: "explainer", required: false }],
  async run(ctx, args) {
    const port = args.int("port", { max: 65535 });
    const host = args.str("host") ?? "127.0.0.1";
    const loaded = loadReadExplainer(ctx, args.positionals[0], "view");
    readViewerHtml(ctx.env); // fail early, with the "run npm run build" hint
    const ws = await openWorkspace(ctx, { explainer: loaded }); // fail early when there is no index; warns if stale
    // The page re-resolves the anchors as `xpl bundle` does. It is a tool for fixing drift, so it does not refuse;
    // it says so here and on the page.
    const stale = describeDrift(freshAnchors(loaded.explainer, ws.model, ws.texts).drift);
    if (stale !== "") {
      ctx.warn(
        `${stale}: the page says so; to fix it, run \`xpl resolve ${loaded.name} --write\` and fix what it lists`,
      );
    }
    const server = await listen(ctx, loaded.abs, host, port);
    if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
      ctx.warn(
        `serving on ${host}: everyone who can reach it can read your source and edit ${loaded.rel}`,
      );
    }
    if (ctx.json) {
      ctx.emit({ url: server.url, host: server.host, port: server.port, explainer: loaded.rel });
    } else {
      ctx.out(`serving ${loaded.rel} at ${server.url}  (Ctrl+C to stop)`);
    }
    if (!args.flag("no-open")) openBrowser(server.url);
    ctx.io.onServer?.(server);
    await untilStopped(ctx.io.signal);
    await server.close();
    return 0;
  },
};
