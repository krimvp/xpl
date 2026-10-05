/** Durable feedback in .explainer/requests.json. Every mutation locks, rereads and atomically merges. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  hashText,
  parseFeedbackRequest,
  sameFeedbackContext,
  mergeFeedbackRequests,
  type ArtifactIdentity,
  type FeedbackRequest,
  type FeedbackStatus,
  type FeedbackAnswer,
  sameFeedbackContent,
} from "@xpl/core";
import { CliError, errorMessage } from "./errors.js";
import { atomicWrite, withRepositoryLock, jsonFile } from "./fsutil.js";
import { EXPLAINER_DIR } from "./repo.js";

export const REQUESTS_FILE = "requests.json";
export type QueuedRequest = FeedbackRequest;
export function requestsPath(root: string): string {
  return join(root, EXPLAINER_DIR, REQUESTS_FILE);
}

function storedRequest(value: unknown, position: number): FeedbackRequest {
  if (value && typeof value === "object" && !("id" in value) && "elementId" in value) {
    const legacy = value as Record<string, unknown>;
    const at = typeof legacy.at === "string" ? legacy.at : "1970-01-01T00:00:00.000Z";
    return parseFeedbackRequest({
      ...legacy,
      id: `legacy-${hashText(JSON.stringify(value))}-${position}`,
      kind: ["correct", "explain", "expand"].includes(String(legacy.kind)) ? legacy.kind : "expand",
      at,
      context: null,
      outcome: {
        revision: 0,
        status: "outdated",
        reason: "Original snapshot was not recorded. Explicit reconciliation is required.",
        at,
      },
    });
  }
  return parseFeedbackRequest(value);
}

function parseStore(data: unknown): FeedbackRequest[] {
  if (!Array.isArray(data)) throw new Error("expected a JSON array");
  const requests = data.map(storedRequest);
  if (new Set(requests.map((r) => r.id)).size !== requests.length)
    throw new Error("duplicate request IDs in store");
  return mergeFeedbackRequests(requests);
}

export function readRequests(root: string): { requests: FeedbackRequest[]; error?: string } {
  const path = requestsPath(root);
  if (!existsSync(path)) return { requests: [] };
  try {
    const data: unknown = JSON.parse(readFileSync(path, "utf8"));
    return { requests: parseStore(data) };
  } catch (error) {
    return { requests: [], error: `${path} is not a valid request queue: ${errorMessage(error)}` };
  }
}

async function mutate<T>(
  root: string,
  merge: (requests: FeedbackRequest[]) => T | Promise<T>,
  beforePublish?: () => Promise<void>,
): Promise<T> {
  return withRepositoryLock(root, requestsPath(root), async () => {
    const { requests, error } = readRequests(root);
    if (error) throw new CliError(error);
    const result = await merge(requests);
    const checked = parseStore(mergeFeedbackRequests(requests));
    await beforePublish?.();
    await atomicWrite(requestsPath(root), jsonFile(checked));
    return result;
  });
}

/** Portable results advance by revision; duplicate or older imports keep the current outcome. */
export async function importRequests(
  root: string,
  incoming: readonly FeedbackRequest[],
): Promise<{ imported: number; total: number }> {
  const checked = incoming.map(parseFeedbackRequest);
  return mutate(root, (requests) => {
    const merged = mergeFeedbackRequests([...requests, ...checked]);
    const imported = merged.length - requests.length;
    requests.splice(0, requests.length, ...merged);
    return { imported, total: merged.length };
  });
}

export async function appendRequest(
  root: string,
  request: Omit<FeedbackRequest, "id" | "at" | "outcome"> & { id?: string; at?: string },
  checkStore?: () => void,
): Promise<{ request: FeedbackRequest; pending: number }> {
  const at = request.at ?? new Date().toISOString();
  const entry = parseFeedbackRequest({
    ...request,
    id: request.id ?? randomUUID(),
    at,
    outcome:
      request.context === null
        ? {
            revision: 0,
            status: "outdated",
            reason: "Original snapshot was not recorded. Explicit reconciliation is required.",
            at,
          }
        : { revision: 0, status: "pending", reason: "Awaiting an explicit revision pass.", at },
  });
  await importRequests(root, [entry]);
  checkStore?.();
  const saved = readRequests(root).requests;
  return {
    request: saved.find((r) => r.id === entry.id)!,
    pending: saved.filter((r) => r.outcome.status === "pending").length,
  };
}

export interface RequestOutcomeUpdate {
  id: string;
  context: ArtifactIdentity | null;
  status: FeedbackStatus;
  reason: string;
  /** A journaled decision retries against this baseline without incrementing its result twice. */
  expectedRevision?: number;
}

/** Only selected IDs change. A failed merge or write leaves every previous result retryable. */
export async function recordOutcomes(
  root: string,
  updates: readonly RequestOutcomeUpdate[],
  /** Called under the outcome lock, after validation, before outcomes become visible. */
  commitDecision?: () => Promise<void>,
): Promise<void> {
  await mutate(
    root,
    (requests) => {
      if (new Set(updates.map((u) => u.id)).size !== updates.length)
        throw new CliError("duplicate selected request IDs");
      for (const update of updates) {
        const i = requests.findIndex((r) => r.id === update.id);
        if (i === -1) throw new CliError(`unknown request ID ${update.id}`);
        const original = requests[i]!;
        if (
          !(original.context === null && update.context === null) &&
          !sameFeedbackContext(original.context, update.context)
        )
          throw new CliError(`original context does not match request ${update.id}`);
        if (update.expectedRevision !== undefined) {
          if (!Number.isSafeInteger(update.expectedRevision) || update.expectedRevision < 0)
            throw new CliError("expectedRevision must be a non-negative safe integer");
          if (
            original.outcome.revision === update.expectedRevision + 1 &&
            original.outcome.status === update.status &&
            original.outcome.reason === update.reason
          )
            continue;
          if (original.outcome.revision !== update.expectedRevision)
            throw new CliError(
              `outcome changed since selection for request ${update.id}; reconcile before retrying`,
            );
        }
        const recorded = parseFeedbackRequest({
          ...original,
          outcome: {
            revision: original.outcome.revision + 1,
            status: update.status,
            reason: update.reason,
            at: new Date().toISOString(),
          },
        });
        requests[i] = mergeFeedbackRequests([original, recorded])[0]!;
      }
    },
    commitDecision,
  );
}

/** The completed job is the publication receipt. Replays union immutable answers without changing outcomes. */
export async function recordAnswer(
  root: string,
  original: FeedbackRequest,
  answer: FeedbackAnswer,
  /** Commit the job receipt after whole-store validation, before the history write. */
  commitReceipt?: () => Promise<void>,
): Promise<void> {
  const stored = readRequests(root);
  if (stored.error) throw new CliError(stored.error);
  const existing = stored.requests.find((r) => r.id === original.id);
  if (
    !commitReceipt &&
    existing &&
    sameFeedbackContent(existing, original) &&
    existing.answers?.some(
      (a) => a.id === answer.id && JSON.stringify(a) === JSON.stringify(answer),
    )
  )
    return;
  await mutate(
    root,
    (requests) => {
      const index = requests.findIndex((r) => r.id === original.id);
      if (index < 0) throw new CliError(`unknown question request ${original.id}`);
      const incoming = parseFeedbackRequest({ ...original, answers: [answer] });
      requests.push(incoming);
    },
    commitReceipt,
  );
}
