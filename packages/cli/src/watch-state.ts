/** A small publication record. The index is written first, then this pointer is replaced atomically. */
import { readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { CliError } from "./errors.js";
import { parseJson, withRepositoryLock, atomicWrite, jsonFile } from "./fsutil.js";
import { createHash } from "node:crypto";
import type { SymbolIndex } from "@xpl/core";

export function indexDigest(index: SymbolIndex): string {
  return createHash("sha256").update(JSON.stringify(index)).digest("hex");
}

export interface WatchState {
  schema: "xpl-watch@1";
  root: string;
  instanceId: string;
  state: "pending" | "building" | "current" | "failed" | "paused" | "stopped";
  stale: boolean;
  generation: number;
  index: { path: string; commit: string } | null;
  indexDigest: string;
  fingerprint: string | null;
  scip: string | null;
  /** Absent in older records: freshness must refuse until the watcher is restarted. */
  precise?: "off" | "auto" | "require";
  error: string | null;
}

export function readWatchState(root: string): WatchState | undefined {
  const abs = join(root, ".explainer/service/watch.json");
  let text: string;
  try {
    if (!realpathSync(abs).startsWith(realpathSync(root) + sep))
      throw new CliError("watch state path leaves its repository");
    text = readFileSync(abs, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const value = parseJson(text, abs) as Partial<WatchState> | null;
  if (
    !value ||
    value.schema !== "xpl-watch@1" ||
    value.root !== realpathSync(root) ||
    typeof value.instanceId !== "string" ||
    !["pending", "building", "current", "failed", "paused", "stopped"].includes(
      value.state ?? "",
    ) ||
    typeof value.stale !== "boolean" ||
    typeof value.indexDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.indexDigest) ||
    !Number.isSafeInteger(value.generation) ||
    Number(value.generation) < 0 ||
    !(value.fingerprint === null || typeof value.fingerprint === "string") ||
    !(value.scip === null || typeof value.scip === "string") ||
    !(value.precise === undefined || ["off", "auto", "require"].includes(value.precise)) ||
    !(value.error === null || typeof value.error === "string") ||
    !(
      value.index === null ||
      (value.index &&
        /^\.explainer\/index-[A-Za-z0-9._-]+\.json$/.test(value.index.path) &&
        typeof value.index.commit === "string")
    )
  )
    throw new CliError(`invalid watch state ${abs}; inspect it before recovery`);
  return value as WatchState;
}

/** Once service ownership is retired, its old pointer cannot select indexes for the next owner. */
export async function retireWatchState(root: string): Promise<void> {
  const path = join(root, ".explainer/service/watch.json");
  await withRepositoryLock(root, path, async () => {
    const previous = readWatchState(root);
    if (previous && previous.state !== "stopped")
      await atomicWrite(path, jsonFile({ ...previous, state: "stopped", stale: true }));
  });
}
