/**
 * Where the viewer's data comes from (ARCHITECTURE.md section 5, "Bundle payload"):
 *
 * - always from `<script id="xpl-data" type="application/json">` (`BUNDLE_SCRIPT_ID`), parsed with
 *   core's `parseBundle`;
 * - when `bundle.server?.api` is set the viewer runs under `xpl view` and talks to that API:
 *     GET  {api}/file?path=<file>     source text of a file missing from `bundle.files`
 *                                     (plain text; JSON `"..."` or `{ "text": "..." }` also works)
 *     PUT  {api}/views/<view id>      persist a view edit: JSON `{ "type": <view type>, ...changed fields }`
 *     PUT  {api}/tours/<tour id>      persist a tour edit: JSON `{ "title": ..., "steps": [...] }` (the whole tour;
 *                                     a new tour is created the same way)
 *     POST {api}/requests             queue an "explain this" request: JSON `{ kind, id, view?, label? }`
 * - without `server` every edit stays in memory (the header offers "Download explainer JSON").
 */
import { BUNDLE_SCRIPT_ID, parseBundle, type ViewerBundle } from "@xpl/core";

export type LoadedBundle = { ok: true; bundle: ViewerBundle } | { ok: false; error: string };

/** Reads and parses the embedded bundle; never throws. */
export function loadBundle(doc: Document = document): LoadedBundle {
  const element = doc.getElementById(BUNDLE_SCRIPT_ID);
  if (!element) {
    return {
      ok: false,
      error: `This page has no data: there is no <script id="${BUNDLE_SCRIPT_ID}"> element.`,
    };
  }
  try {
    const bundle = parseBundle(element.textContent ?? "");
    if (!bundle.explainer || !bundle.index) throw new Error("the bundle has no explainer or index");
    bundle.files = bundle.files ?? {};
    return { ok: true, bundle };
  } catch (error) {
    return { ok: false, error: `The embedded data could not be read: ${messageOf(error)}` };
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Body of `POST {api}/requests`. `kind: "expand"` is what `/code-explainer expand <id>` does. */
export interface ExplainRequest {
  kind: "expand";
  /** The element to explain (a node, edge, concept or sequence step id). */
  id: string;
  /** The view the user was looking at. */
  view?: string;
  /** Display label of the element, for humans reading the queue. */
  label?: string;
}

/** The local `xpl view` API. Every method rejects with an Error whose message is fit to show. */
export class ServerApi {
  constructor(readonly base: string) {}

  private url(path: string): string {
    return `${this.base.replace(/\/+$/, "")}${path}`;
  }

  private async check(response: Response): Promise<Response> {
    if (response.ok) return response;
    let detail = "";
    try {
      const text = await response.text();
      try {
        const json = JSON.parse(text) as { error?: unknown; message?: unknown };
        detail = String(json.error ?? json.message ?? text);
      } catch {
        detail = text;
      }
    } catch {
      /* no body */
    }
    throw new Error(
      `${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`.trim(),
    );
  }

  /** Source text of a file. Accepts plain text, or JSON: a string, or an object with `text` / `content`. */
  async file(path: string): Promise<string> {
    const response = await this.check(
      await fetch(this.url(`/file?path=${encodeURIComponent(path)}`)),
    );
    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("application/json")) return response.text();
    const json = (await response.json()) as unknown;
    const text =
      typeof json === "string"
        ? json
        : ((json as { text?: unknown; content?: unknown } | null)?.text ??
          (json as { content?: unknown } | null)?.content);
    if (typeof text !== "string") throw new Error(`no text in the response for ${path}`);
    return text;
  }

  /** Persists changed view fields; `fields` always carries the view's `type`. */
  async putView(viewId: string, fields: Record<string, unknown>): Promise<void> {
    // View ids are slugs plus a "view:" prefix; keep the colon readable in the URL.
    const id = encodeURIComponent(viewId).replace(/%3A/gi, ":");
    await this.check(
      await fetch(this.url(`/views/${id}`), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(fields),
      }),
    );
  }

  /** Persists a tour: its title and all of its steps (a tour is small; steps are replaced wholesale). */
  async putTour(tourId: string, tour: { title: string; steps: readonly unknown[] }): Promise<void> {
    const id = encodeURIComponent(tourId).replace(/%3A/gi, ":");
    await this.check(
      await fetch(this.url(`/tours/${id}`), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: tour.title, steps: tour.steps }),
      }),
    );
  }

  async postRequest(request: ExplainRequest): Promise<void> {
    await this.check(
      await fetch(this.url("/requests"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      }),
    );
  }
}

/** The command that does what "Explain this" queues, for people without a server. */
export function explainCommand(id: string): string {
  return `/code-explainer expand ${id}`;
}

/**
 * Launch parameters (`?mode=present&tour=<id>&step=<n>&view=<id>`). `step` counts from 1, like the
 * "2 / 5" counter; the store turns it into an index.
 */
export interface LaunchParams {
  mode?: "explore" | "present";
  tour?: string;
  /** 1-based. */
  step?: number;
  view?: string;
}

export function readLaunchParams(search: string = location.search): LaunchParams {
  const params = new URLSearchParams(search);
  const out: LaunchParams = {};
  const mode = params.get("mode");
  if (mode === "explore" || mode === "present") out.mode = mode;
  const tour = params.get("tour");
  if (tour) out.tour = tour;
  const step = Number(params.get("step"));
  if (params.has("step") && Number.isInteger(step) && step >= 1) out.step = step;
  const view = params.get("view");
  if (view) out.view = view;
  return out;
}
