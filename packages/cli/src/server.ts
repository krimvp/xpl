/**
 * `xpl view`: a local HTTP server for the viewer (ARCHITECTURE.md §5).
 *
 *   GET  /                    the viewer HTML with the bundle injected (`server: { api: "/api" }`,
 *                             `files` = the files the explainer references; others are fetched lazily)
 *   GET  /api/bundle          the same bundle as JSON
 *   GET  /api/export          current complete export snapshot with its readiness report
 *   GET  /api/explainer       the explainer alone, with an ETag; 304 when If-None-Match still matches (the
 *                             viewer polls it, so changes made by `xpl apply` show up without a reload)

 *   GET  /api/file?path=      text of one indexed file (text/plain); 400 for a malformed path,
 *                             404 for anything that is not in the index
 *   GET  /api/base-file?path= the code before the change of one changed file (text/plain): only for the
 *                             modified, renamed and deleted files of the explainer's change record (`path` is
 *                             `ChangedFile.path`); 400 for a malformed path, 404 for anything else
 *   PUT  /api/review         { review: record | null }, applied as actor "user"; fingerprint checked at write.
 *   PUT  /api/views/<id>      a view patch, applied as actor "user", written to disk; 200 with the
 *                             updated view, 400 with { error, issues } when rejected
 *   PUT  /api/tours/<id>      the same for a tour: { title?, steps? } (both for a new tour), applied as
 *                             actor "user"; 200 with the updated tour
 *   GET  /api/requests        durable feedback, outcomes and context warnings for this explainer
 *   POST /api/requests        a snapshot-bound FeedbackRequest, merged by its stable request ID;
 *                             legacy element-only input is stored as outdated, without invented context
 *   GET/POST /api/jobs        managed-service history / snapshot-bound selection (runner required)
 *   GET /api/jobs/<UUID>      one job for this guide; results remain proposals
 *   POST /api/jobs/<UUID>/<cancel|supersede|retry>   durable fenced lifecycle actions; no acceptance
 *
 * Both the bundle and /api/explainer carry the explainer with its anchors re-resolved against the index and the
 * working tree (`freshAnchors`, as `xpl bundle` does), never the stale `resolved` cache of the file.
 *
 * The server keeps no explainer state: every request re-reads the explainer from disk, so edits made by
 * `xpl apply` while the viewer is open show up on the next fetch, and viewer edits never overwrite them.
 * It binds to 127.0.0.1 by default. Against DNS rebinding and cross-site writes it checks the Host
 * header (loopback binds), and requires an application/json body and a same-origin Origin for PUT/POST.
 */
import { artifactIdentity, feedbackContextReason, parseFeedbackRequest } from "@xpl/core";
import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  applyPatch,
  checkReadiness,
  baseFileOf,
  basePathOf,
  baseVersionFiles,
  injectBundle,
  type ExplainerPatch,
  type ViewerBundle,
} from "@xpl/core";
import { collectBaseFiles, collectFiles, freshAnchors, makeBundle } from "./bundle-data.js";
import type { RepoEnv } from "./context.js";
import { CliError, errorMessage } from "./errors.js";
import { atomicWrite, withFileLock, withRepositoryLock, displayPath, jsonFile } from "./fsutil.js";
import { importRequests, appendRequest, readRequests } from "./requests.js";
import type { openJobs, JobSubmission } from "./jobs.js";
import {
  WorkingTree,
  chooseIndexFile,
  explainerName,
  loadIndexFile,
  readExplainerFile,
  stalenessOf,
  type LoadedExplainer,
} from "./repo.js";

export interface ViewServerOptions {
  env: RepoEnv;
  /** Absolute path of the explainer being viewed. */
  explainerPath: string;
  host: string;
  /** 0 picks a free port. */
  port: number;
  /** Viewer HTML, read per request so a rebuilt viewer shows up on reload. */
  viewerHtml: () => string;
  /** Managed lifecycle control. The token and stop callback never enter a viewer bundle. */
  control?: {
    token: string;
    instanceId: string;
    root: string;
    backend: "none" | "claude";
    jobs?: Awaited<ReturnType<typeof openJobs>>;
    stop(): void;
  };
}

export interface ViewServer {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly explainerPath: string;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const API = "/api";

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

function send(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: string,
  type: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

function sendJson(req: IncomingMessage, res: ServerResponse, status: number, value: unknown): void {
  send(req, res, status, JSON.stringify(value), "application/json; charset=utf-8");
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = String(req.headers["content-type"] ?? "").toLowerCase();
  if (!type.startsWith("application/json")) {
    throw new HttpError(415, "send the body as application/json (Content-Type: application/json)");
  }
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${req.headers.host}`) {
    throw new HttpError(403, `refusing a cross-origin request from ${origin}`);
  }
  const text = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new HttpError(400, `the body is not valid JSON: ${errorMessage(error)}`);
  }
  if (!isRecord(body)) throw new HttpError(400, "the body must be a JSON object");
  return body;
}

/** A path from `?path=` that could only be a repo-relative POSIX path. */
function wellFormedPath(path: string): boolean {
  return (
    path !== "" &&
    path.length < 4096 &&
    !path.includes("\0") &&
    !path.includes("\\") &&
    !path.startsWith("/") &&
    !path.split("/").some((segment) => segment === ".." || segment === ".")
  );
}

export async function startViewServer(options: ViewServerOptions): Promise<ViewServer> {
  const { env, explainerPath, host } = options;
  let allowedHosts: Set<string> | undefined;
  const attachment = options.control
    ? {
        root: options.control.root,
        guide: displayPath(options.control.root, explainerPath),
        instanceId: options.control.instanceId,
        backend: options.control.backend,
        backendAvailable: options.control.jobs?.availability.available ?? false,
      }
    : undefined;

  function checkServicePaths(...paths: string[]) {
    if (!options.control) return;
    for (const path of paths) {
      if (!realpathSync(path).startsWith(options.control.root + sep)) {
        throw new HttpError(403, "service artifact path leaves its repository");
      }
    }
  }

  function checkRequestStore() {
    checkServicePaths(join(env.root, ".explainer"));

    const path = join(env.root, ".explainer", "requests.json");
    if (existsSync(path)) checkServicePaths(path);
  }

  /** Everything a request needs, read fresh: the explainer, its index, the working tree. */
  async function loadState() {
    checkServicePaths(explainerPath);
    const explainer = readExplainerFile(explainerPath);
    const loaded: LoadedExplainer = {
      abs: explainerPath,
      rel: displayPath(env.root, explainerPath),
      name: explainerName(explainerPath),
      explainer,
    };
    const tree = new WorkingTree(env.root);
    // A live workspace follows a newly generated index; an explicit --index still wins.
    const indexFile = await chooseIndexFile(env, tree, { skipExplainerIndex: true });
    checkServicePaths(indexFile);
    const { index, model } = loadIndexFile(indexFile);
    return { loaded, tree, indexFile, index, model };
  }

  /** The explainer with its anchors re-resolved against the index and the working tree, as `xpl bundle` does. */
  function freshExplainer(state: Awaited<ReturnType<typeof loadState>>) {
    return freshAnchors(state.loaded.explainer, state.model, state.tree.texts).explainer;
  }

  /** Cheap cache identity for indexed source and the index, even for files without stored anchors. */
  function sourceFingerprint(state: Awaited<ReturnType<typeof loadState>>): string {
    const hash = createHash("sha1");
    for (const path of [
      state.indexFile,
      env.root,
      ...state.model.directories.map((dir) => join(env.root, dir)),
      ...state.index.files.map((file) => join(env.root, file.path)),
    ]) {
      hash.update(path);
      try {
        const stat = statSync(path, { bigint: true });
        hash.update(`${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}:${stat.ino}`);
      } catch {
        hash.update("missing");
      }
      hash.update("\0");
    }
    return hash.digest("hex");
  }

  async function bundleOf(forExport = false) {
    const state = await loadState();
    const explainer = freshExplainer(state);
    const collected = collectFiles({
      root: env.root,
      index: state.model,
      texts: state.tree.texts,
      explainer,
      choice: "referenced",
      // the viewer fetches what is not here on demand, so what lies behind a stub can wait for its click
      measure: false,
      stubs: forExport,
    });
    // the code before the change: only the changed files, so it is small enough to send whole
    const base = collectBaseFiles(explainer, state.tree.texts);
    const stale = await stalenessOf(env, state.tree, state.index, state.indexFile, state.loaded);
    const bundle: ViewerBundle = {
      ...makeBundle({
        explainer,
        index: state.index,
        files: collected.files,
        ...(base !== undefined ? { baseFiles: base.files } : {}),
        mode: "explore",
        server: { api: API, ...(attachment ? { attachment } : {}) },
      }),
      ...(stale ? { sourceWarning: stale.message } : {}),
    };
    if (forExport) {
      const report = checkReadiness(explainer, state.index, state.tree.texts, {
        scope: "workspace",
        ...(stale ? { sourceWarning: stale.message } : {}),
      });
      bundle.exportInfo = { status: report.ready ? "ready" : "draft", report };
    }
    return bundle;
  }

  // View edits and request appends run one at a time: each is a read-modify-write of a file.
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(job: () => Promise<T>): Promise<T> {
    const next = queue.then(job, job);
    queue = next.catch(() => undefined);
    return next;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    if (allowedHosts && !allowedHosts.has(String(req.headers.host ?? "").toLowerCase())) {
      throw new HttpError(403, `unexpected Host header "${req.headers.host ?? ""}"`);
    }
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      throw new HttpError(400, "malformed request URL");
    }
    const { pathname } = url;
    const expected = req.headers["x-xpl-attachment"] ?? url.searchParams.get("attachment");
    if (expected !== undefined && expected !== null) {
      let context: { root?: unknown; guide?: unknown };
      try {
        context = JSON.parse(
          req.headers["x-xpl-attachment"] ? decodeURIComponent(String(expected)) : String(expected),
        );
      } catch {
        throw new HttpError(400, "Invalid service attachment.");
      }
      if (!attachment || context?.root !== attachment.root || context?.guide !== attachment.guide)
        throw new HttpError(
          409,
          "This address serves a different repository or guide. Open that service's own URL.",
        );
    }
    const allow = (...methods: string[]) => {
      if (!methods.includes(method)) {
        throw new HttpError(405, `${method} is not allowed here (use ${methods.join(", ")})`, {
          allow: methods.join(", "),
        });
      }
    };

    if (options.control && (pathname === `${API}/service` || pathname === `${API}/service/stop`)) {
      const control = options.control;
      if (req.headers.authorization !== `Bearer ${control.token}`)
        throw new HttpError(403, "service ownership token required");
      allow(pathname.endsWith("/stop") ? "POST" : "GET");
      if (method === "POST") {
        await readJsonBody(req);
        res.once("finish", control.stop);
      }
      sendJson(req, res, 200, { instanceId: control.instanceId, root: control.root });
      return;
    }

    checkServicePaths(join(env.root, ".explainer"));

    if (pathname === `${API}/jobs` || pathname.startsWith(`${API}/jobs/`)) {
      const jobs = options.control?.jobs;
      if (!jobs) throw new HttpError(404, "jobs require a managed repository service");
      const name = displayPath(env.root, explainerPath);
      const parts = pathname.slice(`${API}/jobs`.length).split("/").filter(Boolean);
      try {
        if (parts.length === 0) {
          allow("GET", "HEAD", "POST");
          if (method === "POST") {
            const body = await readJsonBody(req);
            if (Object.keys(body).some((k) => !["id", "selectedRequestIds", "include"].includes(k)))
              throw new HttpError(400, "Expected id, selectedRequestIds and optional include.");
            const job = await serial(() => jobs.submit(name, body as unknown as JobSubmission));
            sendJson(req, res, 200, { job });
          } else sendJson(req, res, 200, { ...jobs.availability, jobs: await jobs.list(name) });
        } else if (parts.length === 1) {
          allow("GET", "HEAD");
          sendJson(req, res, 200, { job: await jobs.get(name, parts[0]!) });
        } else if (parts.length === 2 && ["cancel", "supersede", "retry"].includes(parts[1]!)) {
          allow("POST");
          const body = await readJsonBody(req);
          if (Object.keys(body).some((k) => parts[1] !== "retry" || k !== "expectedAttempt"))
            throw new HttpError(
              400,
              "Retry expects only expectedAttempt; cancel/supersede expect an empty object.",
            );
          const job = await serial(() =>
            parts[1] === "retry"
              ? jobs.retry(name, parts[0]!, body.expectedAttempt)
              : jobs.fence(name, parts[0]!, parts[1] === "cancel" ? "cancelled" : "superseded"),
          );
          sendJson(req, res, 200, { job });
        } else throw new HttpError(404, "unknown job route");
      } catch (error) {
        if (error instanceof CliError)
          throw new HttpError(Number(error.extra.status ?? 400), error.message);
        throw error;
      }
      return;
    }
    if (pathname === "/" || pathname === "/index.html") {
      allow("GET", "HEAD");
      const html = injectBundle(options.viewerHtml(), await bundleOf());
      send(req, res, 200, html, "text/html; charset=utf-8");
      return;
    }
    if (pathname === `${API}/export`) {
      allow("GET", "HEAD");
      sendJson(req, res, 200, await bundleOf(true));
      return;
    }
    if (pathname === `${API}/bundle`) {
      allow("GET", "HEAD");
      sendJson(req, res, 200, await bundleOf());
      return;
    }
    if (pathname === `${API}/explainer`) {
      allow("GET", "HEAD");
      const state = await loadState();
      const fresh = freshExplainer(state);
      const text = JSON.stringify(fresh, null, 2);
      const etag = `"${createHash("sha1")
        .update(text)
        .update(sourceFingerprint(state))
        .update(attachment?.instanceId ?? "")
        .digest("hex")}"`;
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { ETag: etag, "Cache-Control": "no-store" });
        res.end();
        return;
      }
      // what the page shows: the anchors re-resolved, like the bundle (a stale cache would undo that)
      send(req, res, 200, text, "application/json; charset=utf-8", {
        ETag: etag,
      });
      return;
    }
    if (pathname === `${API}/file`) {
      allow("GET", "HEAD");
      const path = url.searchParams.get("path");
      if (path === null || !wellFormedPath(path)) {
        throw new HttpError(
          400,
          "need ?path=<repo-relative path of an indexed file> (no absolute paths, no .. segments)",
        );
      }
      const state = await loadState();
      if (!state.model.hasFile(path)) {
        throw new HttpError(404, `${path} is not in the index`, {
          suggestions: state.model.suggestFiles(path),
        });
      }
      const text = state.tree.texts.text(path);
      if (text === undefined)
        throw new HttpError(404, `${path} cannot be read from the working tree`);
      send(req, res, 200, text, "text/plain; charset=utf-8");
      return;
    }
    if (pathname === `${API}/base-file`) {
      allow("GET", "HEAD");
      const path = url.searchParams.get("path");
      if (path === null || !wellFormedPath(path)) {
        throw new HttpError(
          400,
          "need ?path=<repo-relative path of a changed file> (no absolute paths, no .. segments)",
        );
      }
      const state = await loadState();
      const change = state.loaded.explainer.change;
      if (change === undefined) {
        throw new HttpError(404, "the explainer records no change, so there is no code before it");
      }
      const changed = baseFileOf(change, path);
      if (!changed || changed.path !== path) {
        throw new HttpError(404, `${path} has no code before the change`, {
          files: baseVersionFiles(change).map((file) => file.path),
        });
      }
      const text = state.tree.texts.textAt(change.base, basePathOf(changed));
      if (text === undefined) {
        throw new HttpError(404, `${path} cannot be read at the base commit (git show failed)`);
      }
      send(req, res, 200, text, "text/plain; charset=utf-8");
      return;
    }
    // Only review metadata enters this route; core checks the inspected fingerprint as a user patch.
    if (pathname === `${API}/review`) {
      allow("PUT");
      const body = await readJsonBody(req);
      if (!Object.hasOwn(body, "review") || Object.keys(body).length !== 1)
        throw new HttpError(400, "Expected only a review field (record or null).");
      const saved = await serial(() =>
        withRepositoryLock(env.root, explainerPath, async () => {
          const state = await loadState();
          const result = applyPatch(
            state.loaded.explainer,
            body as unknown as ExplainerPatch,
            state.model,
            state.tree.texts,
            { actor: "user" },
          );
          if (!result.ok)
            throw new HttpError(
              400,
              `Review patch rejected: ${result.issues.find((i) => i.severity === "error")?.message ?? "invalid"}`,
              { issues: result.issues },
            );
          if (result.changed.length > 0)
            await atomicWrite(state.loaded.abs, jsonFile(result.explainer));
          return result.explainer;
        }),
      );
      sendJson(req, res, 200, saved);
      return;
    }

    // PUT /api/views/<id> and PUT /api/tours/<id>: a patch of one view / tour, applied as the user.
    const record = pathname.startsWith(`${API}/views/`)
      ? ({ kind: "view", collection: "views" } as const)
      : pathname.startsWith(`${API}/tours/`)
        ? ({ kind: "tour", collection: "tours" } as const)
        : undefined;
    if (record) {
      allow("PUT");
      let id: string;
      try {
        id = decodeURIComponent(pathname.slice(`${API}/${record.collection}/`.length));
      } catch {
        throw new HttpError(400, `malformed ${record.kind} id in the URL`);
      }
      if (id === "" || id.length > 200) {
        throw new HttpError(400, `missing or too long ${record.kind} id`);
      }
      const body = await readJsonBody(req);
      if (body.id !== undefined && body.id !== id) {
        throw new HttpError(400, `the id in the body (${String(body.id)}) does not match ${id}`);
      }
      const saved = await serial(() =>
        withFileLock(explainerPath, async () => {
          const state = await loadState();
          const patch = { [record.collection]: [{ ...body, id }] } as unknown as ExplainerPatch;
          const result = applyPatch(state.loaded.explainer, patch, state.model, state.tree.texts, {
            actor: "user",
          });
          if (!result.ok) {
            const errors = result.issues.filter((issue) => issue.severity === "error");
            throw new HttpError(
              400,
              `${record.kind} patch rejected: ${errors[0]?.message ?? "invalid"}`,
              { issues: result.issues },
            );
          }
          if (result.changed.length > 0) {
            await atomicWrite(state.loaded.abs, jsonFile(result.explainer));
          }
          return result.explainer[record.collection].find((item) => item.id === id);
        }),
      );
      sendJson(req, res, 200, saved);
      return;
    }
    if (pathname === `${API}/requests`) {
      allow("GET", "HEAD", "POST");
      const name = explainerName(explainerPath);
      if (method === "POST") {
        const body = await readJsonBody(req);
        if (body.context !== undefined || body.outcome !== undefined) {
          let request;
          try {
            request = parseFeedbackRequest(body);
          } catch (error) {
            throw new HttpError(400, errorMessage(error));
          }
          if (request.explainer !== undefined && request.explainer !== name)
            throw new HttpError(400, "feedback names a different explainer");
          await serial(() => importRequests(env.root, [request]));
          const state = await loadState();
          const contextReason =
            feedbackContextReason(request, artifactIdentity(freshExplainer(state), state.index)) ??
            (await stalenessOf(env, state.tree, state.index, state.indexFile, state.loaded))
              ?.message;
          checkRequestStore();
          sendJson(req, res, 201, {
            ok: true,
            request: readRequests(env.root).requests.find((r) => r.id === request.id),
            ...(contextReason
              ? { contextStatus: "outdated", contextReason }
              : { contextStatus: "current" }),
          });
          return;
        }
        // Older local viewers have no snapshot contract. Preserve them as unbound legacy feedback.
        // { elementId, note? } (ARCHITECTURE.md §5), or what the viewer sends: { kind, id, view?, label? }.
        const elementId = body.elementId ?? body.id;
        if (typeof elementId !== "string" || elementId === "" || elementId.length > 500) {
          throw new HttpError(
            400,
            "elementId (or id) must be a non-empty string of at most 500 characters",
          );
        }
        const text = (field: string, max: number): string | undefined => {
          const value = body[field];
          if (value === undefined || value === null) return undefined;
          if (typeof value !== "string" || value.length > max) {
            throw new HttpError(400, `${field} must be a string of at most ${max} characters`);
          }
          return value;
        };
        const note = text("note", 5000);
        const kind = text("kind", 40) ?? "expand";
        if (kind !== "expand" && kind !== "correct" && kind !== "explain")
          throw new HttpError(400, "unknown feedback kind");
        const view = text("view", 200);
        const label = text("label", 500);
        const saved = await serial(() =>
          appendRequest(
            env.root,
            {
              elementId,
              ...(note !== undefined ? { note } : {}),
              kind,
              ...(view !== undefined ? { view } : {}),
              ...(label !== undefined ? { label } : {}),
              explainer: name,
              context: null,
            },
            checkRequestStore,
          ),
        );
        sendJson(req, res, 201, { ok: true, ...saved });
        return;
      }
      checkRequestStore();
      const { requests, error } = readRequests(env.root);
      if (error) throw new HttpError(500, error);
      const mine = requests.filter((r) => r.explainer === undefined || r.explainer === name);
      const state = await loadState();
      const current = artifactIdentity(freshExplainer(state), state.index);
      const stale = await stalenessOf(env, state.tree, state.index, state.indexFile, state.loaded);
      sendJson(req, res, 200, {
        requests: mine.map((r) => {
          const contextReason = feedbackContextReason(r, current) ?? stale?.message;
          return {
            ...r,
            contextStatus: contextReason ? "outdated" : "current",
            ...(contextReason ? { contextReason } : {}),
          };
        }),
        pending: mine.filter((r) => r.outcome.status === "pending").length,
      });
      return;
    }
    if (pathname === "/favicon.ico") {
      res.writeHead(204, { "Cache-Control": "max-age=3600" });
      res.end();
      return;
    }
    throw new HttpError(404, `no such route: ${method} ${pathname}`);
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (error instanceof CliError && error.extra.code === "REPOSITORY_ESCAPE")
        error = new HttpError(403, error.message);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof HttpError) {
        const { allow, ...extra } = error.extra;
        const headers: Record<string, string> = typeof allow === "string" ? { Allow: allow } : {};
        const body = JSON.stringify({ error: error.message, ...extra });
        send(req, res, error.status, body, "application/json; charset=utf-8", {
          ...headers,
          ...(error.status === 413 ? { Connection: "close" } : {}),
        });
        return;
      }
      sendJson(req, res, 500, { error: errorMessage(error) });
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      reject(
        new CliError(
          error.code === "EADDRINUSE"
            ? `port ${options.port} on ${host} is already in use; pick another with --port (or --port 0 for any free port)`
            : `cannot listen on ${host}:${options.port}: ${error.message}`,
          1,
          { code: error.code },
        ),
      );
    };
    server.once("error", onError);
    server.listen(options.port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });

  const port = (server.address() as AddressInfo).port;
  const displayHost = host === "0.0.0.0" || host === "::" ? "localhost" : host;
  const bracketed = displayHost.includes(":") ? `[${displayHost}]` : displayHost;
  if (isLoopback(host)) {
    allowedHosts = new Set(
      [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `${bracketed}:${port}`].map((h) =>
        h.toLowerCase(),
      ),
    );
  }

  return {
    url: `http://${bracketed}:${port}/`,
    host,
    port,
    explainerPath,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
      await queue;
    },
  };
}
