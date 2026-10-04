/** Repository-scoped ownership around the existing viewer server. No PID is ever signalled. */
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, openSync, closeSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandSpec } from "../command.js";
import type { Ctx } from "../context.js";
import { CliError, UsageError } from "../errors.js";
import { atomicWrite, jsonFile, parseJson, toPosix, withFileLock } from "../fsutil.js";
import { loadExplainer, openWorkspace } from "../repo.js";
import type { ViewServer } from "../server.js";
import { readViewerHtml } from "../viewer-html.js";
import { listen, untilStopped } from "./view.js";

type Backend = "none" | "claude";
interface ServiceContext {
  schema: "xpl-service-context@1";
  root: string;
  guide: string;
  backend: Backend;
  port: number;
  index: string | null;
}
interface Instance {
  schema: "xpl-service-instance@1";
  root: string;
  instanceId: string;
  pid: number;
  token: string;
  state: "starting" | "running" | "stopped";
  url: string | null;
  startedAt: string;
}

function localPath(root: string, path: string): string {
  const real = realpathSync(path);
  if (!real.startsWith(root + sep))
    throw new CliError(`service path ${path} must stay inside repository ${root}`);
  return real;
}

function paths(ctx: Ctx) {
  const root = realpathSync(ctx.root);
  const dir = join(root, ".explainer", "service");
  // Check ancestors too: creating a service directory must not follow an escaping .explainer symlink.
  for (const path of [dirname(dir), dir]) if (existsSync(path)) localPath(root, path);
  return { root, dir, context: join(dir, "context.json"), instance: join(dir, "instance.json") };
}

function readRecord(path: string, root: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    localPath(root, path);
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const data = parseJson(text, path);
  if (
    typeof data !== "object" ||
    data === null ||
    Array.isArray(data) ||
    (data as Record<string, unknown>).root !== root
  )
    throw new CliError(`invalid service record ${path}; inspect it before recovery`);
  return data as Record<string, unknown>;
}

function readContext(path: string, root: string): ServiceContext | undefined {
  const data = readRecord(path, root);
  if (!data) return undefined;
  if (
    data.schema !== "xpl-service-context@1" ||
    typeof data.guide !== "string" ||
    isAbsolute(data.guide) ||
    data.guide.includes("\\") ||
    data.guide.split("/").includes("..") ||
    !["none", "claude"].includes(String(data.backend)) ||
    !Number.isInteger(data.port) ||
    Number(data.port) < 0 ||
    Number(data.port) > 65535 ||
    !(data.index === null || typeof data.index === "string")
  )
    throw new CliError(`invalid service context ${path}; inspect it before recovery`);
  return data as unknown as ServiceContext;
}

function readInstance(path: string, root: string): Instance | undefined {
  const data = readRecord(path, root);
  if (!data) return undefined;
  if (
    data.schema !== "xpl-service-instance@1" ||
    typeof data.instanceId !== "string" ||
    !/^[a-f0-9-]{36}$/.test(data.instanceId) ||
    typeof data.token !== "string" ||
    !/^[a-f0-9]{64}$/.test(data.token) ||
    !Number.isSafeInteger(data.pid) ||
    Number(data.pid) < 1 ||
    !["starting", "running", "stopped"].includes(String(data.state)) ||
    typeof data.startedAt !== "string" ||
    !(
      data.url === null ||
      (typeof data.url === "string" && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(data.url))
    )
  )
    throw new CliError(`invalid service instance ${path}; inspect it before recovery`);
  return data as unknown as Instance;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function contact(instance: Instance, stop = false): Promise<boolean> {
  if (!instance.url) return false;
  try {
    const response = await fetch(
      new URL(stop ? "/api/service/stop" : "/api/service", instance.url),
      {
        method: stop ? "POST" : "GET",
        headers: { Authorization: `Bearer ${instance.token}`, "Content-Type": "application/json" },
        ...(stop ? { body: "{}" } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(1500),
      },
    );
    const body = (await response.json()) as Record<string, unknown>;
    return response.ok && body.instanceId === instance.instanceId && body.root === instance.root;
  } catch {
    return false;
  }
}

async function status(ctx: Ctx) {
  const p = paths(ctx);
  const context = readContext(p.context, p.root);
  const instance = readInstance(p.instance, p.root);
  const state =
    !instance || instance.state === "stopped"
      ? "stopped"
      : (await contact(instance))
        ? "running"
        : !alive(instance.pid)
          ? "interrupted"
          : instance.state === "starting"
            ? "starting"
            : "unavailable";
  return {
    state,
    root: p.root,
    guide: context?.guide ?? null,
    backend: context?.backend ?? "none",
    instanceId: instance?.instanceId ?? null,
    pid: instance?.pid ?? null,
    url: instance?.url ?? null,
    ownershipLock: existsSync(`${p.instance}.lock`),
    ...(state === "interrupted"
      ? {
          recovery:
            "Owner exited unexpectedly; inspect artifacts, then use xpl service start --recover. Writer locks require explicit inspection/removal.",
        }
      : {}),
    ...(state === "unavailable"
      ? {
          recovery:
            "Owner PID is alive but its identity cannot be verified; no signal or automatic recovery is allowed.",
        }
      : {}),
  };
}

function report(ctx: Ctx, result: Awaited<ReturnType<typeof status>>) {
  if (ctx.json) ctx.emit(result);
  else {
    ctx.out(
      `service ${result.state}: ${result.instanceId ?? "no instance"}\nrepository: ${result.root}\nguide: ${result.guide ?? "none"}\nbackend: ${result.backend} (jobs unavailable)\naddress: ${result.url ?? "none"}\npid: ${result.pid ?? "none"}`,
    );
    if (result.recovery) ctx.out(result.recovery);
    if (result.ownershipLock)
      ctx.out("Ownership transaction lock remains; inspect its writer before removing it.");
  }
}

async function background(ctx: Ctx, argv: string[], dir: string): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const entry = [join(here, "xpl.mjs"), join(here, "..", "..", "dist", "xpl.mjs")].find(existsSync);
  if (!entry)
    throw new CliError(
      "background service requires installed CLI assets; run npm run build in the xpl source repository",
    );
  const logPath = join(dir, "service.log");
  if (existsSync(logPath)) localPath(ctx.root, logPath);
  const log = openSync(logPath, "a", 0o600);
  let child;
  try {
    child = spawn(process.execPath, [entry, ...argv, "--json"], {
      cwd: ctx.root,
      env: ctx.env,
      detached: true,
      stdio: ["ignore", log, log, "ipc"],
    });
  } finally {
    closeSync(log);
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new CliError(
              `service startup not confirmed; inspect ${logPath} and xpl service status before retrying`,
            ),
          ),
        15_000,
      );
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new CliError(`service failed to start (exit ${code}); inspect ${logPath}`));
      });
      child.once("message", (message) => {
        clearTimeout(timer);
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "xpl-service-ready"
        )
          resolve();
        else reject(new CliError(`unexpected startup reply; inspect ${logPath}`));
      });
    });
  } finally {
    if (child.connected) child.disconnect();
    child.unref();
  }
}

export const serviceCommand: CommandSpec = {
  name: "service",
  usage:
    "xpl service <start|stop|status> [explainer] [--background] [--port p] [--backend none|claude] [--recover]",
  summary: "Start, stop or inspect a repository's optional local viewer service",
  details: [
    "Start runs in the foreground (Ctrl-C to stop); --background detaches the installed CLI and logs to",
    ".explainer/service/service.log. The listener is always 127.0.0.1; no external address is accepted.",
    "The selected guide, port and backend label persist under the canonical repository root. A later start",
    "without a guide reuses that context. Stop the service before selecting another guide; use --root to",
    "attach another repository's separate service. One owner per canonical root is allowed.",
    "Status reports instance UUID, PID, address, root, guide and backend. Stop verifies a secret ownership",
    "token over loopback, never signals a PID. A dead owner is interrupted; --recover explicitly archives",
    "its record and starts another instance. A live unverified PID or crashed writer lock needs inspection.",
    "--backend records none (default) or claude as a future selection; no agent or job runs in this command.",
    "Local serving requires no network or agent credentials. A later Claude job requires its own configured",
    "authentication and provider network access. Manual commands and offline HTML work with the service stopped.",
  ],
  options: {
    background: { type: "boolean", desc: "Start a detached installed CLI process" },
    port: {
      type: "string",
      arg: "<p>",
      desc: "Port (saved port, else 4747 with fallback; 0 = any free port)",
    },
    backend: {
      type: "string",
      arg: "<none|claude>",
      desc: "Persist backend selection only; jobs remain unavailable",
    },
    recover: {
      type: "boolean",
      desc: "Explicitly recover ownership after its recorded PID has exited",
    },
  },
  positionals: [{ name: "action" }, { name: "explainer", required: false }],
  async run(ctx, args) {
    const action = args.positionals[0]!;
    if (!["start", "stop", "status"].includes(action))
      throw new UsageError("service action must be start, stop or status");
    if (
      action !== "start" &&
      (args.positionals[1] ||
        args.flag("background") ||
        args.flag("recover") ||
        args.str("port") ||
        args.str("backend") ||
        ctx.indexOption)
    )
      throw new UsageError(
        "guide, --background, --recover, --port, --backend and --index apply only to service start",
      );
    const p = paths(ctx);
    ctx = { ...ctx, root: p.root };
    if (action === "status") {
      report(ctx, await status(ctx));
      return 0;
    }
    if (action === "stop") {
      const instance = readInstance(p.instance, p.root);
      if (!instance || instance.state === "stopped") {
        report(ctx, await status(ctx));
        return 0;
      }
      if (!(await contact(instance)))
        throw new CliError(
          "cannot verify service ownership; inspect xpl service status. No process was signalled.",
        );
      if (!(await contact(instance, true)))
        throw new CliError("service stop was not confirmed; inspect xpl service status");
      const deadline = Date.now() + 10_000;
      while (readInstance(p.instance, p.root)?.state !== "stopped") {
        if (Date.now() >= deadline)
          throw new CliError(
            "service is still stopping; inspect xpl service status before restarting",
          );
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      report(ctx, await status(ctx));
      return 0;
    }
    const saved = readContext(p.context, p.root);
    const guide = args.positionals[1] ?? (saved ? join(p.root, saved.guide) : undefined);
    if (!guide)
      throw new UsageError(
        "first service start needs an explainer; use xpl service start <explainer>",
      );
    const loaded = loadExplainer(ctx, guide);
    loaded.abs = localPath(p.root, loaded.abs);
    const index = ctx.indexOption
      ? localPath(p.root, resolve(ctx.cwd, ctx.indexOption))
      : (saved?.index ?? null);
    if (index) localPath(p.root, index);
    ctx = { ...ctx, indexOption: index ?? undefined };
    const port = args.int("port", { max: 65535 }) ?? saved?.port;
    const backend = args.choice("backend", ["none", "claude"] as const) ?? saved?.backend ?? "none";
    readViewerHtml(ctx.env);
    await openWorkspace(ctx, { explainer: loaded });
    await mkdir(p.dir, { recursive: true, mode: 0o700 });
    localPath(p.root, p.dir);
    await chmod(p.dir, 0o700);
    if (args.flag("background")) {
      await background(
        ctx,
        [
          "service",
          "start",
          loaded.abs,
          "--root",
          p.root,
          "--backend",
          backend,
          ...(port !== undefined ? ["--port", String(port)] : []),
          ...(index ? ["--index", index] : []),
          ...(args.flag("recover") ? ["--recover"] : []),
        ],
        p.dir,
      );
      report(ctx, await status(ctx));
      return 0;
    }
    const instance: Instance = {
      schema: "xpl-service-instance@1",
      root: p.root,
      instanceId: randomUUID(),
      pid: process.pid,
      token: randomBytes(32).toString("hex"),
      state: "starting",
      url: null,
      startedAt: new Date().toISOString(),
    };
    await withFileLock(p.instance, async () => {
      const previous = readInstance(p.instance, p.root);
      if (previous && previous.state !== "stopped") {
        if (await contact(previous))
          throw new CliError(
            `service already running at ${previous.url}; use xpl service status or stop before changing context`,
          );
        if (alive(previous.pid))
          throw new CliError(
            "service owner PID is alive but unavailable or starting; inspect status. Refusing to replace ownership.",
          );
        if (!args.flag("recover"))
          throw new CliError(
            "service was interrupted; inspect artifacts, then start with --recover",
          );
        await atomicWrite(
          join(p.dir, `interrupted-${previous.instanceId}.json`),
          jsonFile(previous),
        );
      }
      await atomicWrite(p.instance, jsonFile(instance));
    });
    const abort = new AbortController();
    const stopped = untilStopped(
      ctx.io.signal ? AbortSignal.any([ctx.io.signal, abort.signal]) : abort.signal,
    );
    let server: ViewServer | undefined;
    try {
      server = await listen(ctx, loaded.abs, "127.0.0.1", port, {
        token: instance.token,
        instanceId: instance.instanceId,
        root: p.root,
        stop: () => abort.abort(),
      });
      instance.state = "running";
      instance.url = server.url;
      const context: ServiceContext = {
        schema: "xpl-service-context@1",
        root: p.root,
        guide: toPosix(relative(p.root, loaded.abs)),
        backend,
        port: server.port,
        index,
      };
      await withFileLock(p.instance, async () => {
        await atomicWrite(p.context, jsonFile(context));
        await atomicWrite(p.instance, jsonFile(instance));
      });
      report(ctx, await status(ctx));
      ctx.io.onServer?.(server);
      if (process.send && process.connected) process.send({ type: "xpl-service-ready" });
      await stopped;
    } finally {
      abort.abort();
      await server?.close();
      await withFileLock(p.instance, async () => {
        if (readInstance(p.instance, p.root)?.instanceId === instance.instanceId) {
          instance.state = "stopped";
          await atomicWrite(p.instance, jsonFile(instance));
        }
      });
    }
    return 0;
  },
};
