/**
 * `xpl view`: a local HTTP server for the viewer (ARCHITECTURE.md §5).
 *
 *   GET  /                    the viewer HTML with the bundle injected (`server: { api: "/api" }`,
 *                             `files` = the files the explainer references; others are fetched lazily)
 *   GET  /api/bundle          the same bundle as JSON
 *   GET  /api/file?path=      text of one indexed file (text/plain); 400 for a malformed path,
 *                             404 for anything that is not in the index
 *   PUT  /api/views/<id>      a view patch, applied as actor "user", written to disk; 200 with the
 *                             updated view, 400 with { error, issues } when rejected
 *   GET  /api/requests        queued "explain this" requests
 *   POST /api/requests        { elementId, note? } appended to .explainer/requests.json (the viewer's
 *                             { kind, id, view?, label? } is accepted too: id is the elementId)
 *
 * The server keeps no explainer state: every request re-reads the explainer from disk, so edits made by
 * `xpl apply` while the viewer is open show up on the next fetch, and viewer edits never overwrite them.
 * It binds to 127.0.0.1 by default. Against DNS rebinding and cross-site writes it checks the Host
 * header (loopback binds), and requires an application/json body and a same-origin Origin for PUT/POST.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { applyPatch, injectBundle, type ExplainerPatch } from "@xpl/core";
import { collectFiles, makeBundle } from "./bundle-data.js";
import type { RepoEnv } from "./context.js";
import { CliError, errorMessage } from "./errors.js";
import { atomicWrite, displayPath, jsonFile } from "./fsutil.js";
import { appendRequest, readRequests } from "./requests.js";
import {
  WorkingTree,
  chooseIndexFile,
  explainerName,
  loadIndexFile,
  readExplainerFile,
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

  /** Everything a request needs, read fresh: the explainer, its index, the working tree. */
  async function loadState() {
    const explainer = readExplainerFile(explainerPath);
    const loaded: LoadedExplainer = {
      abs: explainerPath,
      rel: displayPath(env.root, explainerPath),
      name: explainerName(explainerPath),
      explainer,
    };
    const tree = new WorkingTree(env.root);
    const indexFile = await chooseIndexFile(env, tree, { explainer: loaded });
    const { index, model } = loadIndexFile(indexFile);
    return { loaded, tree, index, model };
  }

  async function bundleOf() {
    const state = await loadState();
    const collected = collectFiles({
      root: env.root,
      index: state.model,
      texts: state.tree.texts,
      explainer: state.loaded.explainer,
      choice: "referenced",
    });
    return makeBundle({
      explainer: state.loaded.explainer,
      index: state.index,
      files: collected.files,
      mode: "explore",
      server: { api: API },
    });
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
    const allow = (...methods: string[]) => {
      if (!methods.includes(method)) {
        throw new HttpError(405, `${method} is not allowed here (use ${methods.join(", ")})`, {
          allow: methods.join(", "),
        });
      }
    };

    if (pathname === "/" || pathname === "/index.html") {
      allow("GET", "HEAD");
      const html = injectBundle(options.viewerHtml(), await bundleOf());
      send(req, res, 200, html, "text/html; charset=utf-8");
      return;
    }
    if (pathname === `${API}/bundle`) {
      allow("GET", "HEAD");
      sendJson(req, res, 200, await bundleOf());
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
    if (pathname.startsWith(`${API}/views/`)) {
      allow("PUT");
      let viewId: string;
      try {
        viewId = decodeURIComponent(pathname.slice(`${API}/views/`.length));
      } catch {
        throw new HttpError(400, "malformed view id in the URL");
      }
      if (viewId === "" || viewId.length > 200)
        throw new HttpError(400, "missing or too long view id");
      const body = await readJsonBody(req);
      if (body.id !== undefined && body.id !== viewId) {
        throw new HttpError(
          400,
          `the id in the body (${String(body.id)}) does not match ${viewId}`,
        );
      }
      const view = await serial(async () => {
        const state = await loadState();
        const patch = { views: [{ ...body, id: viewId }] } as unknown as ExplainerPatch;
        const result = applyPatch(state.loaded.explainer, patch, state.model, state.tree.texts, {
          actor: "user",
        });
        if (!result.ok) {
          const errors = result.issues.filter((issue) => issue.severity === "error");
          throw new HttpError(400, `view patch rejected: ${errors[0]?.message ?? "invalid"}`, {
            issues: result.issues,
          });
        }
        if (result.changed.length > 0) {
          await atomicWrite(state.loaded.abs, jsonFile(result.explainer));
        }
        return result.explainer.views.find((v) => v.id === viewId);
      });
      sendJson(req, res, 200, view);
      return;
    }
    if (pathname === `${API}/requests`) {
      allow("GET", "HEAD", "POST");
      const name = explainerName(explainerPath);
      if (method === "POST") {
        const body = await readJsonBody(req);
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
        const kind = text("kind", 40);
        const view = text("view", 200);
        const label = text("label", 500);
        const saved = await appendRequest(env.root, {
          elementId,
          ...(note !== undefined ? { note } : {}),
          ...(kind !== undefined ? { kind } : {}),
          ...(view !== undefined ? { view } : {}),
          ...(label !== undefined ? { label } : {}),
          explainer: name,
        });
        sendJson(req, res, 201, { ok: true, ...saved });
        return;
      }
      const { requests, error } = readRequests(env.root);
      if (error) throw new HttpError(500, error);
      const mine = requests.filter((r) => r.explainer === undefined || r.explainer === name);
      sendJson(req, res, 200, { requests: mine, pending: mine.length });
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
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
