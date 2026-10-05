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
import { atomicWrite, jsonFile, parseJson, toPosix, withRepositoryLock } from "../fsutil.js";
import { chooseIndexFile, loadExplainer, openWorkspace, WorkingTree } from "../repo.js";
import type { ViewServer } from "../server.js";
import { readViewerHtml } from "../viewer-html.js";
import { claudeRunner, claudeAnswerRunner } from "../claude-runner.js";
import { openJobs } from "../jobs.js";
import { listen, untilStopped } from "./view.js";
import { watchControl } from "../watch-control.js";
import { readWatchState, retireWatchState } from "../watch-state.js";

type Backend = "none" | "claude";
interface ServiceContext {
  schema: "xpl-service-context@1";
  root: string;
  guide: string;
  backend: Backend;
  port: number;
  index: string | null;
  skillDir?: string;
  jobTimeout?: number;
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
    !(data.index === null || typeof data.index === "string") ||
    !(
      data.skillDir === undefined ||
      (typeof data.skillDir === "string" && isAbsolute(data.skillDir))
    ) ||
    !(
      data.jobTimeout === undefined ||
      (Number.isInteger(data.jobTimeout) &&
        Number(data.jobTimeout) >= 1 &&
        Number(data.jobTimeout) <= 3600)
    )
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
    watch: readWatchState(p.root) ?? null,
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
      `service ${result.state}: ${result.instanceId ?? "no instance"}\nrepository: ${result.root}\nguide: ${result.guide ?? "none"}\nbackend: ${result.backend} (${result.backend === "claude" ? "runner configured" : "jobs unavailable"})\naddress: ${result.url ?? "none"}\npid: ${result.pid ?? "none"}`,
    );
    if (result.recovery) ctx.out(result.recovery);
    if (result.watch)
      ctx.out(
        `watch ${result.watch.state}: ${result.watch.stale ? "out of date" : "checked snapshot"}; index ${result.watch.index?.commit ?? "none"}${result.watch.error ? ` (${result.watch.error})` : ""}`,
      );
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
    "xpl service <start|pause|resume|stop|status> [explainer] [--background] [--port p] [--backend none|claude] [--skill-dir folder] [--job-timeout seconds] [--recover] [--watch]",
  summary: "Control a repository's optional local viewer service and source watch",
  details: [
    "--watch opts this start into metadata polling (500 ms, then a quiet interval). It builds a full",
    "index from source, resolver inputs and enabled provider configuration, discards superseded builds and publishes atomically.",
    "Failures keep the last snapshot marked out of date. xpl status --all inventories guides; no prose or feedback is saved.",
    "Watching defaults to --precise off. --precise auto|require enables semantic tools; --scip watches a supplied",
    "artifact/manifest pair. --index cannot pin a watched service. These options must be selected on each start.",
    "Unchanged polls read no source bytes. Git staging changes are observed; recovery retires the prior watch pointer.",
    "Pause drains the watch and retains a stale snapshot; resume checks again. Jobs and the service stay running.",
    "The managed viewer reports moved/drifted/missing evidence and offers an explicit xpl revise command.",
    "Stop drains the service and jobs. No watch control accepts revisions or clears feedback.",
    "Start runs in the foreground (Ctrl-C to stop); --background detaches the installed CLI and logs to",
    ".explainer/service/service.log. The listener is always 127.0.0.1; no external address is accepted.",
    "The selected guide, port and backend label persist under the canonical repository root. A later start",
    "without a guide reuses that context. Stop the service before selecting another guide; use --root to",
    "attach another repository's separate service. One owner per canonical root is allowed.",
    "--index resolves from the working directory, then the repository root, as for view; its resolved",
    "repository-local path is saved for restart.",
    "Status reports instance UUID, PID, address, root, guide and backend. Stop verifies a secret ownership",
    "token over loopback, never signals a PID. A dead owner is interrupted; --recover explicitly archives",
    "its record and starts another instance. A live unverified PID or crashed writer lock needs inspection.",
    "Managed viewer bookmarks retain root/guide and reconnect after restart. After stop, choose Use loaded",
    "snapshot offline for manual edits and HTML export; Retry connection resumes this attachment.",
    "--backend none (default) disables execution; claude runs the installed, already-authenticated Claude Code CLI.",
    "--skill-dir selects the installed code-explainer skill; --job-timeout bounds each invocation (300 seconds by default).",
    "Both settings persist for restart. Configuration means enabled, not authenticated; job failures report setup/provider errors.",
    "Durable job history lives in .explainer/service/jobs.json. Restart marks running attempts interrupted;",
    "cancelled/superseded proposals stay fenced. Claude reads source and writes only an owned proposal file.",
    "Headless /api/answers jobs answer saved explain requests against frozen guide/source snapshots.",
    "Every returned quote is checked against recorded head/base lines; answers remain in portable feedback history.",
    "Source changes mark answer context outdated. Answers never finalize outcomes or accept guide patches.",
    "Service-owned proposals await explicit review and guarded job acceptance; no job applies a patch.",
    "Local serving requires no network or agent credentials. A later Claude job requires its own configured",
    "authentication and provider network access. Manual commands and offline HTML work with the service stopped.",
  ],
  options: {
    watch: {
      type: "boolean",
      desc: "Opt into coherent full indexing of source/configuration edits",
    },
    precise: {
      type: "string",
      arg: "<off|auto|require>",
      desc: "With --watch: reference resolution (default off)",
    },
    scip: {
      type: "string",
      arg: "<artifact|manifest.json>",
      desc: "With --watch: observe a supplied SCIP input",
    },
    background: { type: "boolean", desc: "Start a detached installed CLI process" },
    port: {
      type: "string",
      arg: "<p>",
      desc: "Port (saved port, else 4747 with fallback; 0 = any free port)",
    },
    backend: {
      type: "string",
      arg: "<none|claude>",
      desc: "Select none or the installed Claude Code proposal runner",
    },
    "skill-dir": {
      type: "string",
      arg: "<folder>",
      desc: "Installed code-explainer skill (saved folder, else ~/.claude/skills/code-explainer)",
    },
    "job-timeout": {
      type: "string",
      arg: "<seconds>",
      desc: "Claude timeout in seconds (saved value, else 300; maximum 3600)",
    },
    recover: {
      type: "boolean",
      desc: "Explicitly recover ownership after its recorded PID has exited",
    },
  },
  positionals: [{ name: "action" }, { name: "explainer", required: false }],
  async run(ctx, args) {
    const action = args.positionals[0]!;
    if (!["start", "pause", "resume", "stop", "status"].includes(action))
      throw new UsageError("service action must be start, pause, resume, stop or status");
    if (
      action !== "start" &&
      (args.positionals[1] ||
        args.flag("background") ||
        args.flag("recover") ||
        args.str("port") ||
        args.str("backend") ||
        args.str("skill-dir") ||
        args.str("job-timeout") ||
        ctx.indexOption)
    )
      throw new UsageError(
        "guide, --background, --recover, --port, --backend, --skill-dir, --job-timeout and --index apply only to service start",
      );
    const watch = args.flag("watch");
    if ((watch || args.str("precise") || args.str("scip")) && action !== "start")
      throw new UsageError("--watch, --precise and --scip apply only to service start");
    if (!watch && (args.str("precise") || args.str("scip")))
      throw new UsageError("--precise and --scip require --watch");
    if (watch && ctx.indexOption)
      throw new UsageError("--watch cannot be combined with a pinned --index");
    const precise =
      args.choice("precise", ["off", "auto", "require"] as const) ??
      (args.str("scip") ? "auto" : "off");
    if (args.str("scip") && precise === "off")
      throw new UsageError("--scip requires --precise auto or require");
    const scip = args.str("scip") ? resolve(ctx.cwd, args.str("scip")!) : null;
    const p = paths(ctx);
    ctx = { ...ctx, root: p.root };
    if (action === "status") {
      report(ctx, await status(ctx));
      return 0;
    }
    if (action === "pause" || action === "resume") {
      const instance = readInstance(p.instance, p.root);
      if (!instance || !(await contact(instance)))
        throw new CliError("cannot verify service ownership; inspect xpl service status");
      const response = await fetch(new URL("/api/watch", instance.url!), {
        method: "POST",
        headers: { Authorization: `Bearer ${instance.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
        redirect: "error",
        signal: AbortSignal.timeout(120000),
      });
      if (!response.ok) {
        const body = (await response.json()) as { error: string };
        throw new CliError(body.error);
      }
      report(ctx, await status(ctx));
      return 0;
    }
    if (action === "stop") {
      const instance = readInstance(p.instance, p.root);
      if (!instance || instance.state === "stopped") {
        await retireWatchState(p.root);
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
      ? localPath(p.root, await chooseIndexFile(ctx, new WorkingTree(p.root)))
      : watch
        ? null
        : (saved?.index ?? null);
    if (index) localPath(p.root, index);
    ctx = { ...ctx, indexOption: index ?? undefined };
    const port = args.int("port", { max: 65535 }) ?? saved?.port;
    const skillDir = args.str("skill-dir")
      ? resolve(ctx.cwd, args.str("skill-dir")!)
      : saved?.skillDir;
    const jobTimeout = args.int("job-timeout", { max: 3600 }) ?? saved?.jobTimeout ?? 300;
    if (jobTimeout < 1) throw new UsageError("--job-timeout must be at least 1 second");
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
          ...(skillDir ? ["--skill-dir", skillDir] : []),
          "--job-timeout",
          String(jobTimeout),
          ...(args.flag("recover") ? ["--recover"] : []),
          ...(watch ? ["--watch", "--precise", precise] : []),
          ...(scip ? ["--scip", scip] : []),
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
    await withRepositoryLock(p.root, p.instance, async () => {
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
      await retireWatchState(p.root);
      await atomicWrite(p.instance, jsonFile(instance));
    });
    const abort = new AbortController();
    const stopped = untilStopped(
      ctx.io.signal ? AbortSignal.any([ctx.io.signal, abort.signal]) : abort.signal,
    );
    let server: ViewServer | undefined;
    const watching = watch
      ? watchControl(
          ctx,
          {
            instanceId: instance.instanceId,
            precise,
            scip,
          },
          abort.signal,
          () => abort.abort(),
        )
      : undefined;
    let jobs: Awaited<ReturnType<typeof openJobs>> | undefined;
    try {
      jobs = await openJobs(
        ctx,
        instance.instanceId,
        backend === "claude"
          ? claudeRunner(ctx, { skillDir, timeoutMs: jobTimeout * 1000 })
          : undefined,
        backend === "claude"
          ? claudeAnswerRunner(ctx, { skillDir, timeoutMs: jobTimeout * 1000 })
          : undefined,
      );
      server = await listen(ctx, loaded.abs, "127.0.0.1", port, {
        token: instance.token,
        instanceId: instance.instanceId,
        root: p.root,
        backend,
        jobs,
        watch: watching,
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
        ...(skillDir ? { skillDir } : {}),
        jobTimeout,
      };
      await withRepositoryLock(p.root, p.instance, async () => {
        await atomicWrite(p.context, jsonFile(context));
        await atomicWrite(p.instance, jsonFile(instance));
      });
      report(ctx, await status(ctx));
      ctx.io.onServer?.(server);
      await watching?.change("resume");
      if (process.send && process.connected) process.send({ type: "xpl-service-ready" });
      await stopped;
    } finally {
      abort.abort();
      const watchResult = await Promise.allSettled(watching ? [watching.close()] : []);
      await server?.close();
      await jobs?.close();
      await withRepositoryLock(p.root, p.instance, async () => {
        if (readInstance(p.instance, p.root)?.instanceId === instance.instanceId) {
          await retireWatchState(p.root);
          instance.state = "stopped";
          await atomicWrite(p.instance, jsonFile(instance));
        }
      });
      const failure = watchResult[0];
      if (failure?.status === "rejected") throw failure.reason;
    }
    return 0;
  },
};
