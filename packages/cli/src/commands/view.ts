import { spawn } from "node:child_process";
import { describeDrift, freshAnchors } from "../bundle-data.js";
import type { CommandSpec } from "../command.js";
import type { Ctx } from "../context.js";
import { CliError } from "../errors.js";
import { loadExplainer, openWorkspace } from "../repo.js";
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
function untilStopped(signal: AbortSignal | undefined): Promise<void> {
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

async function listen(ctx: Ctx, explainerPath: string, host: string, port: number | undefined) {
  const start = (p: number): Promise<ViewServer> =>
    startViewServer({
      env: ctx,
      explainerPath,
      host,
      port: p,
      viewerHtml: () => readViewerHtml(ctx.env),
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
  usage: "xpl view <explainer> [--port p] [--host 127.0.0.1] [--no-open]",
  summary: "Serve the viewer locally with live repo access",
  details: [
    `Serves the viewer on http://127.0.0.1:<port>/ (default port ${DEFAULT_PORT}, or a free one if taken) and`,
    "opens it in the browser (best effort; --no-open skips that). The page loads the explainer, the index and",
    "the referenced files; other files are fetched lazily from the working tree. Edits made in the viewer",
    '(layout, expanded nodes) are saved to the explainer as user edits; "explain this" clicks are queued in',
    ".explainer/requests.json (see `xpl status`). The explainer is re-read from disk on every request, so",
    "`xpl apply` while the viewer is open shows up after a reload. Stop with Ctrl-C.",
    "Anchors are re-resolved against the index and the working tree, as for `xpl bundle`. Unlike bundle, view",
    "does not refuse an explainer whose anchors drifted or are missing: it warns, and the page says which parts",
    "may be out of date.",
    "The server binds to 127.0.0.1 unless --host says otherwise: anything else exposes your source code.",
    "Needs the viewer build (`npm run build`), or XPL_VIEWER_HTML=<viewer html file>.",
  ],
  options: {
    port: {
      type: "string",
      arg: "<p>",
      desc: `Port (default ${DEFAULT_PORT}, else any free port; 0 = any)`,
    },
    host: { type: "string", arg: "<host>", desc: "Address to bind (default 127.0.0.1)" },
    "no-open": { type: "boolean", desc: "Do not open the browser" },
  },
  positionals: [{ name: "explainer" }],
  async run(ctx, args) {
    const port = args.int("port", { max: 65535 });
    const host = args.str("host") ?? "127.0.0.1";
    const loaded = loadExplainer(ctx, args.positionals[0]!);
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
      ctx.out(`serving ${loaded.rel} at ${server.url}  (Ctrl-C to stop)`);
    }
    if (!args.flag("no-open")) openBrowser(server.url);
    ctx.io.onServer?.(server);
    await untilStopped(ctx.io.signal);
    await server.close();
    return 0;
  },
};
