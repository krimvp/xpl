import type { WatchAttention, Job, JobReviewAction, RevisionReview } from "@xpl/core";
/**
 * Where the viewer's data comes from (ARCHITECTURE.md section 5, "Bundle payload"):
 *
 * - always from `<script id="xpl-data" type="application/json">` (`BUNDLE_SCRIPT_ID`), parsed with
 *   core's `parseBundle`;
 * - when `bundle.server?.api` is set the viewer runs under `xpl view` and talks to that API:
 *     GET  {api}/file?path=<file>     source text of a file missing from `bundle.files`
 *                                     (plain text; JSON `"..."` or `{ "text": "..." }` also works)
 *     GET  {api}/base-file?path=<file> the code before the change of a changed file missing from
 *                                     `bundle.baseFiles` (plain text, like `/file`)
 *     PUT  {api}/edits                bounded user edits with inspected artifact version and field preconditions
 *     PUT  {api}/review               persist/remove author review; rejects changed inspected fingerprint
 *     PUT  {api}/views/<view id>      persist a view edit: JSON `{ "type": <view type>, ...changed fields }`
 *     PUT  {api}/tours/<tour id>      persist a tour edit: JSON `{ "title": ..., "steps": [...] }` (the whole tour;
 *                                     a new tour is created the same way)
 *     GET  {api}/bundle               current index, explainer, referenced source and freshness warning
 *     GET  {api}/export               current complete export snapshot with its readiness report
 *     GET  {api}/explainer            the explainer as it is on disk now, with an ETag (304 while unchanged):
 *                                     polled, so what Claude applies shows up without a reload
 *     POST {api}/requests             save a validated FeedbackRequest with stable ID and original snapshot context
 * - without `server` every edit stays in memory (the header offers "Download explainer JSON").
 */
import {
  BUNDLE_SCRIPT_ID,
  parseBundle,
  parseFeedbackRequest,
  type GuideDescriptor,
  type Range,
  type Explainer,
  type ExplainerPatch,
  type ArtifactIdentity,
  type UserEdit,
  type ViewerBundle,
  type FeedbackRequest,
} from "@xpl/core";

import { selectGuide } from "./library.js";

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
    const bundle = selectGuide(
      parseBundle(element.textContent ?? ""),
      new URLSearchParams(doc.location?.search ?? "").get("guide"),
    );
    const snapshot = new URLSearchParams(doc.location?.search ?? "").get("snapshot");
    if (snapshot && snapshot !== bundle.index.commit)
      throw new Error(
        `Source snapshot "${snapshot}" is unavailable; this guide supplies "${bundle.index.commit}". Reopen search in the available guide.`,
      );
    // A source link is a fixed snapshot: polling and lazy API reads could replace its text.
    if (snapshot) {
      const file = new URLSearchParams(doc.location?.search ?? "").get("file");
      if (file && !(file in bundle.files))
        throw new Error(
          `Source file "${file}" is not included in snapshot "${snapshot}". It may have been loaded only in the previous page. Reopen the live guide to load and search it again.`,
        );
      delete bundle.server;
    }
    const version = new URLSearchParams(doc.location?.search ?? "").get("version");
    if (version && version !== bundle.publication?.current.version)
      throw new Error(
        `This page does not contain version "${version}". Open its immutable version link.`,
      );
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

export type ExplainRequest = FeedbackRequest;

/** The fields the reader needs from the existing answer-job API. Frozen input stays server-owned. */
export interface AnswerAttempt {
  id: string;
  selectedRequestIds: string[];
  state: "queued" | "running" | "completed" | "failed" | "cancelled" | "superseded" | "interrupted";
  attempt: number;
  progress: { at: string; message: string }[];
  error: string | null;
  contextReason: string | null;
}
export interface AnswerHistory {
  available: boolean;
  reason: string | null;
  jobs: AnswerAttempt[];
}

/** The local `xpl view` API. Every method rejects with an Error whose message is fit to show. */
export class ServerApi {
  async answers(): Promise<AnswerHistory> {
    const response = await this.check(await this.request("/answers", { cache: "no-store" }));
    return response.json();
  }

  async startAnswer(id: string, requestId: string): Promise<void> {
    await this.check(
      await this.request("/answers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, requestId }),
      }),
    );
  }

  async controlAnswer(job: AnswerAttempt, action: "retry" | "cancel"): Promise<void> {
    await this.check(
      await this.request(`/answers/${encodeURIComponent(job.id)}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action === "retry" ? { expectedAttempt: job.attempt } : {}),
      }),
    );
  }
  /** Current workspace export snapshot: complete referenced source and a forced freshness check. */
  async exportBundle(): Promise<ViewerBundle> {
    const response = await this.check(await this.request("/export", { cache: "no-store" }));
    return this.attachedBundle(await response.text());
  }

  /** Current index and referenced source, refreshed after the workspace ETag changes. */
  async bundle(): Promise<ViewerBundle> {
    const response = await this.check(await this.request("/bundle", { cache: "no-store" }));
    return this.attachedBundle(await response.text());
  }
  async guides(): Promise<{
    guides: (GuideDescriptor | { id: string; metadataError: string })[];
    errors: { id: string; error: string }[];
  }> {
    const response = await this.check(await this.request("/guides", { cache: "no-store" }));
    return response.json();
  }

  async attention(): Promise<WatchAttention | undefined> {
    const response = await this.request("/watch", { cache: "no-store" });
    // Older managed services have no attention endpoint; keep their reader unchanged.
    if (response.status === 404) return undefined;
    await this.check(response);
    return (await response.json()) as WatchAttention;
  }

  async controlWatch(
    action: "pause" | "resume" | "stop",
    instanceId: string,
  ): Promise<WatchAttention | undefined> {
    const response = await this.check(
      await this.request("/watch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, instanceId }),
        signal: AbortSignal.timeout(120000),
      }),
    );
    if (action === "stop") return undefined;
    return (await response.json()) as WatchAttention;
  }

  async jobs(): Promise<{ available: boolean; reason: string | null; jobs: Job[] } | undefined> {
    const response = await this.request("/jobs", { cache: "no-store" });
    if (response.status === 404) return undefined;
    await this.check(response);
    return response.json();
  }
  async submitJob(id: string, selectedRequestIds: string[]): Promise<Job> {
    const response = await this.check(
      await this.request("/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, selectedRequestIds }),
        signal: AbortSignal.timeout(120000),
      }),
    );
    return (await response.json()).job;
  }
  async controlJob(job: Job, action: "cancel" | "retry"): Promise<Job> {
    const response = await this.check(
      await this.request(`/jobs/${encodeURIComponent(job.id)}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "retry" ? { expectedAttempt: job.attempt } : {}),
        signal: AbortSignal.timeout(120000),
      }),
    );
    return (await response.json()).job;
  }
  async reviewJob(id: string, action: JobReviewAction): Promise<RevisionReview> {
    const response = await this.check(
      await this.request(`/jobs/${encodeURIComponent(id)}/${action.accept ? "accept" : "review"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attemptId: action.attemptId,
          ...(action.accept ? { reviewToken: action.reviewToken } : {}),
          ...(action.decisions ? { decisions: action.decisions } : {}),
        }),
        signal: AbortSignal.timeout(120000),
      }),
    );
    return (await response.json()).review;
  }

  constructor(
    readonly base: string,
    readonly attachment?: NonNullable<ViewerBundle["server"]>["attachment"],
  ) {}

  private request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.attachment) {
      const { root, guide } = this.attachment;
      headers.set("X-Xpl-Attachment", encodeURIComponent(JSON.stringify({ root, guide })));
    }
    return fetch(this.url(path), {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(5000),
    });
  }

  private attachedBundle(text: string): ViewerBundle {
    const bundle = parseBundle(text);
    const actual = bundle.server?.attachment;
    if (
      this.attachment &&
      (actual?.root !== this.attachment.root || actual?.guide !== this.attachment.guide)
    )
      throw new Error("409: This address serves a different repository or guide.");
    return bundle;
  }

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
      await this.request(`/file?path=${encodeURIComponent(path)}`, { cache: "no-store" }),
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

  /** The code before the change of a changed file (`ChangedFile.path`), like `file`. */
  async baseFile(path: string): Promise<string> {
    const response = await this.check(
      await this.request(`/base-file?path=${encodeURIComponent(path)}`),
    );
    return response.text();
  }

  /** Bounded author fields with an inspected version; the response includes the conditional inverse. */
  async putEdits(
    version: ArtifactIdentity,
    edits: UserEdit[],
  ): Promise<{ explainer: Explainer; inverse: UserEdit[] }> {
    if (!this.attachment)
      throw new Error(
        "This page has no live repository or guide identity. Reopen it before saving.",
      );
    const response = await this.check(
      await this.request("/edits", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version, edits }),
      }),
    );
    return response.json();
  }

  /** Author-only metadata; the server applies this bounded patch as actor user. */
  async putReview(review: ExplainerPatch["review"]): Promise<void> {
    await this.check(
      await this.request("/review", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ review }),
      }),
    );
  }

  /** Persists changed view fields; `fields` always carries the view's `type`. */
  async putView(viewId: string, fields: Record<string, unknown>): Promise<void> {
    // View ids are slugs plus a "view:" prefix; keep the colon readable in the URL.
    const id = encodeURIComponent(viewId).replace(/%3A/gi, ":");
    await this.check(
      await this.request(`/views/${id}`, {
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
      await this.request(`/tours/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: tour.title, steps: tour.steps }),
      }),
    );
  }

  /**
   * The explainer on disk, or undefined while it still has the ETag `etag` (a 304). Rejects when the
   * server cannot serve it (an older `xpl view` answers 404).
   */
  async getExplainer(
    etag: string | undefined,
  ): Promise<{ explainer: Explainer; etag: string | undefined } | undefined> {
    const response = await this.request("/explainer", {
      headers: etag !== undefined ? { "if-none-match": etag } : {},
      cache: "no-store",
    });
    if (response.status === 304) return undefined;
    await this.check(response);
    return {
      explainer: (await response.json()) as Explainer,
      etag: response.headers.get("etag") ?? undefined,
    };
  }

  async requests(): Promise<FeedbackRequest[]> {
    const response = await this.check(await this.request("/requests", { cache: "no-store" }));
    const data = (await response.json()) as { requests: unknown[] };
    return data.requests.map(parseFeedbackRequest);
  }

  async postRequest(request: ExplainRequest): Promise<void> {
    await this.check(
      await this.request("/requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      }),
    );
  }
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
  perspective?: "guide" | "map" | "flow" | "code" | "explore";
  focus?: string[];
  file?: string;
  range?: Range;
  stepId?: string;
  side?: "head" | "base";
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
  const perspective = params.get("perspective");
  if (
    perspective === "guide" ||
    perspective === "map" ||
    perspective === "flow" ||
    perspective === "code" ||
    perspective === "explore"
  )
    out.perspective = perspective;
  if (params.has("focus")) out.focus = params.getAll("focus");
  if (params.has("step-id")) out.stepId = params.get("step-id")!;
  const file = params.get("file");
  if (file) out.file = file;
  const side = params.get("side");
  const range = /^(\d+)(?::(\d+))?-(\d+)(?::(\d+))?$/.exec(params.get("range") ?? "");
  if (file && range && (side === null || side === "head" || side === "base")) {
    const [startLine, startCol, endLine, endCol] = [range[1], range[2], range[3], range[4]].map(
      (n) => (n === undefined ? undefined : Number(n)),
    );
    if (
      startLine &&
      endLine &&
      endLine >= startLine &&
      !!startCol === !!endCol &&
      (startCol === undefined ||
        (startCol > 0 && endCol! > 0 && (endLine > startLine || endCol! >= startCol)))
    ) {
      out.file = file;
      out.range = { startLine, endLine, ...(startCol !== undefined ? { startCol, endCol } : {}) };
      if (side) out.side = side;
    }
  }
  return out;
}
