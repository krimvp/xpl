/**
 * The "explain this" queue (`.explainer/requests.json`): the viewer in `xpl view` appends requests, the
 * skill reads them with `xpl status` and clears the file once it has handled them. The file is a JSON
 * array of `{ elementId, note?, kind?, view?, label?, at, explainer? }`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CliError, errorMessage } from "./errors.js";
import { atomicWrite, withFileLock, jsonFile } from "./fsutil.js";
import { EXPLAINER_DIR } from "./repo.js";

export const REQUESTS_FILE = "requests.json";

export interface QueuedRequest {
  elementId: string;
  note?: string;
  /** What is asked, e.g. "expand" (the viewer's "Explain this"). */
  kind?: string;
  /** The view the user was looking at. */
  view?: string;
  /** Display label of the element, for humans reading the queue. */
  label?: string;
  /** ISO timestamp. */
  at: string;
  /** Name of the explainer being viewed when the request was made. */
  explainer?: string;
}

export function requestsPath(root: string): string {
  return join(root, EXPLAINER_DIR, REQUESTS_FILE);
}

/** The queued requests; a missing file is an empty queue, an unreadable one is reported as `error`. */
export function readRequests(root: string): { requests: QueuedRequest[]; error?: string } {
  const path = requestsPath(root);
  if (!existsSync(path)) return { requests: [] };
  try {
    const data: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(data)) throw new Error("expected a JSON array");
    return {
      requests: data.filter(
        (item): item is QueuedRequest =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as QueuedRequest).elementId === "string",
      ),
    };
  } catch (error) {
    return { requests: [], error: `${path} is not a valid request queue: ${errorMessage(error)}` };
  }
}

let writeChain: Promise<unknown> = Promise.resolve();

/** Appends a request (writes are serialised, so concurrent POSTs do not lose each other). */
export function appendRequest(
  root: string,
  request: Omit<QueuedRequest, "at"> & { at?: string },
): Promise<{ request: QueuedRequest; pending: number }> {
  const run = () =>
    withFileLock(requestsPath(root), async () => {
      const { requests, error } = readRequests(root);
      if (error) throw new CliError(error);
      const entry: QueuedRequest = {
        elementId: request.elementId,
        ...(request.note !== undefined && request.note !== "" ? { note: request.note } : {}),
        ...(request.kind !== undefined ? { kind: request.kind } : {}),
        ...(request.view !== undefined ? { view: request.view } : {}),
        ...(request.label !== undefined ? { label: request.label } : {}),
        at: request.at ?? new Date().toISOString(),
        ...(request.explainer !== undefined ? { explainer: request.explainer } : {}),
      };
      requests.push(entry);
      await atomicWrite(requestsPath(root), jsonFile(requests));
      return { request: entry, pending: requests.length };
    });
  const next = writeChain.then(run, run);
  writeChain = next.catch(() => undefined);
  return next;
}
