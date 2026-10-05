/** Reader feedback stays separate from explanation content. Context never changes on import or retry. */
import { hashText, sliceLines, splitLines } from "./text.js";
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
  /** Immutable source-linked answers; independent of author revision outcomes. */
  answers?: FeedbackAnswer[];
}

export interface RecordedAnswerSource {
  file: string;
  side: "head" | "base";
  text: string;
  hash: string;
}

export type AnswerReference = NonNullable<FeedbackRequest["range"]> & { quote: string };
export interface FeedbackAnswer {
  id: string;
  requestId: string;
  context: ArtifactIdentity;
  at: string;
  text: string;
  references: AnswerReference[];
  sources: RecordedAnswerSource[];
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

/** Repository-relative, positive inclusive source selection. */
function parseFeedbackRange(value: unknown): NonNullable<FeedbackRequest["range"]> {
  const selected = object(value);
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
  return { file, fromLine, toLine, side };
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
  const range = data.range === undefined ? undefined : parseFeedbackRange(data.range);
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
    ...(data.answers === undefined
      ? {}
      : { answers: parseAnswers(data.answers, data.id, context) }),
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

/** Request content is immutable; answers and revision outcomes are separate append/merge data. */
export function sameFeedbackContent(a: FeedbackRequest, b: FeedbackRequest): boolean {
  const { outcome: _a, answers: _aa, ...originalA } = a;
  const { outcome: _b, answers: _ba, ...originalB } = b;
  return JSON.stringify(originalA) === JSON.stringify(originalB);
}

/** Revisions never decrease. Equal revisions keep the first result; original content never changes. */
export function mergeFeedbackRequests(requests: readonly FeedbackRequest[]): FeedbackRequest[] {
  const merged = new Map<string, FeedbackRequest>();
  const answerOwners = new Map<string, string>();
  for (const request of requests) {
    const original = merged.get(request.id);
    if (original && !sameFeedbackContent(original, request))
      throw new Error(`request ID ${request.id} conflicts with its original content`);
    const chosen =
      !original || request.outcome.revision > original.outcome.revision ? request : original;
    const answers = new Map<string, FeedbackAnswer>();
    for (const answer of [...(original?.answers ?? []), ...(request.answers ?? [])]) {
      const owner = answerOwners.get(answer.id);
      if (owner !== undefined && owner !== request.id)
        throw new Error(`answer ID ${answer.id} belongs to another request`);
      answerOwners.set(answer.id, request.id);
      const previous = answers.get(answer.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(answer))
        throw new Error(`answer ID ${answer.id} conflicts with its original content`);
      answers.set(answer.id, answer);
    }
    merged.set(request.id, answers.size ? { ...chosen, answers: [...answers.values()] } : chosen);
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

/** Parse and hash recorded evidence before using it as an answer's validation source. */
export function parseAnswerSources(value: unknown): RecordedAnswerSource[] {
  if (!Array.isArray(value) || value.length > 10000)
    throw new Error("answer sources must be an array of at most 10000 files");
  const seen = new Set<string>();
  return value.map((entry) => {
    const data = object(entry);
    const { file, side } = parseFeedbackRange({ ...data, fromLine: 1, toLine: 1 });
    if (
      typeof data.text !== "string" ||
      data.text.length > 5_000_000 ||
      data.hash !== hashText(data.text)
    )
      throw new Error("recorded answer source hash does not match its text");
    const key = `${side}:${file}`;
    if (seen.has(key)) throw new Error("duplicate recorded answer source");
    seen.add(key);
    return { file, side, text: data.text, hash: text(data.hash, "source.hash", 200) };
  });
}

/** Untrusted model output has text and exact source excerpts, never an applied guide patch. */
export function validateFeedbackAnswer(
  value: unknown,
  request: Pick<FeedbackRequest, "id" | "context">,
  recorded: readonly RecordedAnswerSource[],
  id: string,
  at: string,
): FeedbackAnswer {
  if (request.context === null) throw new Error("answers require recorded request context");
  const data = object(value);
  if (Object.keys(data).some((key) => key !== "text" && key !== "references"))
    throw new Error(
      "answer output allows only text and references; guide patches require explicit revision review",
    );
  if (!Array.isArray(data.references) || !data.references.length || data.references.length > 100)
    throw new Error("answer requires 1 to 100 source references");
  const sources = parseAnswerSources(recorded);
  const references = data.references.map((entry) => {
    const ref = object(entry);
    const range = parseFeedbackRange(ref);
    const source = sources.find((s) => s.file === range.file && s.side === range.side);
    if (!source)
      throw new Error(`answer reference ${range.side}:${range.file} has no recorded source`);
    if (range.toLine > splitLines(source.text).length)
      throw new Error("answer reference is outside recorded source lines");
    const quote = text(ref.quote, "reference.quote", 100000);
    if (quote !== sliceLines(source.text, { startLine: range.fromLine, endLine: range.toLine }))
      throw new Error("answer quote does not match recorded source range");
    return { ...range, quote };
  });
  return {
    id: text(id, "answer.id", 200),
    requestId: request.id,
    context: { ...request.context },
    at: timestamp(at),
    text: text(data.text, "answer.text", 100000),
    references,
    sources: sources.filter((s) => references.some((r) => r.file === s.file && r.side === s.side)),
  };
}

function parseAnswers(
  value: unknown,
  requestId: unknown,
  context: ArtifactIdentity | null,
): FeedbackAnswer[] {
  if (!Array.isArray(value) || value.length > 1000)
    throw new Error("answers must be an array of at most 1000 entries");
  const ids = new Set<string>();
  return value.map((entry) => {
    const data = object(entry);
    const identity = object(data.context);
    const original = {
      explainerHash: text(identity.explainerHash, "answer.explainerHash", 200),
      sourceHash: text(identity.sourceHash, "answer.sourceHash", 200),
    };
    if (data.requestId !== requestId || !sameFeedbackContext(original, context))
      throw new Error("answer does not match original request context or ID");
    const answer = validateFeedbackAnswer(
      { text: data.text, references: data.references },
      { id: text(requestId, "requestId", 200), context },
      parseAnswerSources(data.sources),
      text(data.id, "answer.id", 200),
      timestamp(data.at),
    );
    if (ids.has(answer.id)) throw new Error("duplicate answer IDs");
    ids.add(answer.id);
    return answer;
  });
}
