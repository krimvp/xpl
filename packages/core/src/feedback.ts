/** Reader feedback stays separate from explanation content. Context never changes on import or retry. */
import type { ArtifactIdentity } from "./readiness.js";

export const FEEDBACK_SCHEMA = "code-explainer/feedback@1";
export type FeedbackKind = "correct" | "explain" | "expand";
export type FeedbackStatus = "pending" | "addressed" | "unresolved" | "rejected" | "outdated";

export interface FeedbackOutcome {
  /** Starts at zero; only an author's locked outcome recording increments this counter. */
  revision: number;
  status: FeedbackStatus;
  reason: string;
  at: string;
}

export interface FeedbackRequest {
  id: string;
  elementId: string;
  kind: FeedbackKind;
  note?: string;
  /** Freshness warning on the original viewed snapshot; requires explicit reconciliation. */
  sourceWarning?: string;
  view?: string;
  label?: string;
  explainer?: string;
  at: string;
  /** Null only for migrated legacy requests whose original snapshot was never recorded. */
  context: ArtifactIdentity | null;
  range?: { file: string; fromLine: number; toLine: number; side: "head" | "base" };
  outcome: FeedbackOutcome;
}

export interface FeedbackFile {
  schema: typeof FEEDBACK_SCHEMA;
  requests: FeedbackRequest[];
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("expected an object");
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`${field} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function timestamp(value: unknown): string {
  const at = text(value, "at", 40);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(at) ||
    !Number.isFinite(Date.parse(at))
  )
    throw new Error("at must be an ISO timestamp");
  return at;
}

/** Validate imported JSON and HTTP input before any store mutation. */
export function parseFeedbackRequest(value: unknown): FeedbackRequest {
  const data = object(value);
  const kind = text(data.kind, "kind", 20);
  if (!["correct", "explain", "expand"].includes(kind)) throw new Error("unknown feedback kind");
  const result = object(data.outcome);
  // Existing v1 exports predate counters. Their times cannot establish an ordering.
  const revision = result.revision === undefined ? 0 : result.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)
    throw new Error("outcome.revision must be a non-negative safe integer");
  const status = text(result.status, "status", 20);
  if (!["pending", "addressed", "unresolved", "rejected", "outdated"].includes(status)) {
    throw new Error("unknown feedback status");
  }
  let context: ArtifactIdentity | null = null;
  if (data.context !== null) {
    const identity = object(data.context);
    context = {
      explainerHash: text(identity.explainerHash, "explainerHash", 200),
      sourceHash: text(identity.sourceHash, "sourceHash", 200),
    };
  } else if (status !== "outdated") {
    throw new Error("unbound legacy feedback must be outdated");
  }
  let range: FeedbackRequest["range"];
  if (data.range !== undefined) {
    const selected = object(data.range);
    const file = text(selected.file, "range.file", 2000);
    if (
      file.startsWith("/") ||
      file.includes("\\") ||
      file.includes("\0") ||
      file.split("/").some((p) => p === ".." || p === "." || p === "")
    ) {
      throw new Error("range.file must be a repository-relative path");
    }
    const { fromLine, toLine, side } = selected;
    if (
      typeof fromLine !== "number" ||
      !Number.isInteger(fromLine) ||
      fromLine < 1 ||
      typeof toLine !== "number" ||
      !Number.isInteger(toLine) ||
      toLine < fromLine
    ) {
      throw new Error("range must have positive inclusive line numbers");
    }
    if (side !== "head" && side !== "base") throw new Error("range.side must be head or base");
    range = { file, fromLine, toLine, side };
  }
  const optional: Pick<FeedbackRequest, "note" | "view" | "label" | "explainer" | "sourceWarning"> =
    {};
  for (const [field, max] of [
    ["sourceWarning", 5000],
    ["note", 5000],
    ["view", 200],
    ["label", 500],
    ["explainer", 200],
  ] as const) {
    if (data[field] !== undefined) optional[field] = text(data[field], field, max);
  }
  return {
    id: text(data.id, "id", 200),
    elementId: text(data.elementId, "elementId", 500),
    kind: kind as FeedbackKind,
    ...optional,
    at: timestamp(data.at),
    context,
    ...(range ? { range } : {}),
    outcome: {
      revision,
      status: status as FeedbackStatus,
      reason: text(result.reason, "reason", 5000),
      at: timestamp(result.at),
    },
  };
}

export function parseFeedbackFile(value: unknown): FeedbackFile {
  const data = object(value);
  if (data.schema !== FEEDBACK_SCHEMA || !Array.isArray(data.requests))
    throw new Error(`expected ${FEEDBACK_SCHEMA} with a requests array`);
  return { schema: FEEDBACK_SCHEMA, requests: data.requests.map(parseFeedbackRequest) };
}

export function sameFeedbackContext(
  a: ArtifactIdentity | null,
  b: ArtifactIdentity | null,
): boolean {
  return (
    a !== null && b !== null && a.explainerHash === b.explainerHash && a.sourceHash === b.sourceHash
  );
}

/** Request content is immutable; only the result can change when a pass records an outcome. */
export function sameFeedbackContent(a: FeedbackRequest, b: FeedbackRequest): boolean {
  const { outcome: _a, ...originalA } = a;
  const { outcome: _b, ...originalB } = b;
  return JSON.stringify(originalA) === JSON.stringify(originalB);
}

/** Revisions never decrease. Equal revisions keep the first result; original content never changes. */
export function mergeFeedbackRequests(requests: readonly FeedbackRequest[]): FeedbackRequest[] {
  const merged = new Map<string, FeedbackRequest>();
  for (const request of requests) {
    const original = merged.get(request.id);
    if (original && !sameFeedbackContent(original, request))
      throw new Error(`request ID ${request.id} conflicts with its original content`);
    if (!original || request.outcome.revision > original.outcome.revision)
      merged.set(request.id, request);
  }
  return [...merged.values()];
}

/** Outdated context is reported separately, so importing an old result never discards its reason. */
export function feedbackContextReason(
  request: FeedbackRequest,
  current: ArtifactIdentity,
): string | undefined {
  if (request.sourceWarning) return `Original source snapshot was stale: ${request.sourceWarning}`;
  return sameFeedbackContext(request.context, current)
    ? undefined
    : request.context === null
      ? "Original snapshot was not recorded. Explicit reconciliation is required."
      : "Explanation or source snapshot changed. Explicit reconciliation is required.";
}
