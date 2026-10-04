import { describe, expect, it, vi } from "vitest";
import type { FeedbackRequest } from "@xpl/core";
import { importRequests, readRequests, recordOutcomes } from "../src/requests.js";
import { makeTempDir } from "./helpers.js";
import { existsSync, readFileSync, readdirSync, promises as filesystem } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

const context = { explainerHash: "explanation-1", sourceHash: "source-1" };
function request(id: string): FeedbackRequest {
  return {
    id,
    elementId: "file:src/runner.ts",
    kind: "correct",
    note: "It retries twice.",
    at: "2026-10-04T12:00:00.000Z",
    explainer: "demo",
    context,
    range: { file: "src/runner.ts", fromLine: 4, toLine: 8, side: "head" },
    outcome: {
      revision: 0,
      status: "pending",
      reason: "Awaiting an explicit revision pass.",
      at: "2026-10-04T12:00:00.000Z",
    },
  };
}

describe("durable feedback", () => {
  it("deduplicates imports without overwriting a recorded outcome or original context", async () => {
    const root = makeTempDir();
    const original = request("request-a");
    await importRequests(root, [original]);
    await recordOutcomes(root, [
      { id: original.id, context, status: "unresolved", reason: "Needs a runtime trace." },
    ]);
    await importRequests(root, [original]);
    expect(readRequests(root).requests).toEqual([
      {
        ...original,
        outcome: {
          revision: 1,
          status: "unresolved",
          reason: "Needs a runtime trace.",
          at: expect.any(String),
        },
      },
    ]);
  });

  it("merges selected outcomes against concurrent appends and leaves unselected requests intact", async () => {
    const root = makeTempDir();
    const selected = request("selected");
    const unselected = request("unselected");
    await importRequests(root, [selected, unselected]);
    await Promise.all([
      recordOutcomes(root, [
        { id: selected.id, context, status: "addressed", reason: "Corrected the retry count." },
      ]),
      ...Array.from({ length: 8 }, (_, i) => importRequests(root, [request(`new-${i}`)])),
    ]);
    const saved = readRequests(root).requests;
    expect(saved.find((r) => r.id === "selected")?.outcome).toMatchObject({
      status: "addressed",
      reason: "Corrected the retry count.",
    });
    expect(saved.find((r) => r.id === "unselected")).toEqual(unselected);
    expect(
      saved
        .filter((r) => r.id.startsWith("new-"))
        .map((r) => r.id)
        .sort(),
    ).toEqual(["new-0", "new-1", "new-2", "new-3", "new-4", "new-5", "new-6", "new-7"]);
  });

  it("rejects conflicting IDs and failed selected batches without writing partial outcomes", async () => {
    const root = makeTempDir();
    const original = request("a");
    await importRequests(root, [original]);
    await expect(
      importRequests(root, [{ ...original, context: { ...context, sourceHash: "changed" } }]),
    ).rejects.toThrow("conflicts");
    await expect(
      recordOutcomes(root, [
        { id: "a", context, status: "addressed", reason: "Done." },
        { id: "missing", context, status: "rejected", reason: "Declined." },
      ]),
    ).rejects.toThrow("unknown request");
    expect(readRequests(root).requests).toEqual([original]);
  });

  it("keeps IDs, ranges and reasons after a filesystem write failure and retry", async () => {
    const root = makeTempDir();
    const original = request("retry");
    await importRequests(root, [original]);
    const directory = join(root, ".explainer");
    const path = join(directory, "requests.json");
    const before = readFileSync(path);
    // Refuse publication only after the real lock, read, merge and temporary-file write succeed.
    const rename = vi.spyOn(filesystem, "rename").mockImplementationOnce(async (from, to) => {
      expect(existsSync(join(directory, "requests.json.lock"))).toBe(true);
      expect(to).toBe(path);
      expect(JSON.parse(readFileSync(String(from), "utf8"))[0].outcome).toMatchObject({
        revision: 1,
        status: "unresolved",
        reason: "Run failed.",
      });
      throw Object.assign(new Error("Publication failed"), { code: "EIO", syscall: "rename" });
    });
    syncBuiltinESMExports();
    try {
      await expect(
        recordOutcomes(root, [
          { id: "retry", context, status: "unresolved", reason: "Run failed." },
        ]),
      ).rejects.toMatchObject({ code: "EIO", syscall: "rename" });
      expect(rename).toHaveBeenCalledTimes(1);
      expect(readFileSync(path)).toEqual(before);
      expect(readdirSync(directory)).toEqual(["requests.json"]);
    } finally {
      rename.mockRestore();
      syncBuiltinESMExports();
    }
    await recordOutcomes(root, [
      { id: "retry", context, status: "unresolved", reason: "Run failed; retry available." },
    ]);
    expect(readRequests(root).requests).toEqual([
      {
        ...original,
        outcome: {
          revision: 1,
          status: "unresolved",
          reason: "Run failed; retry available.",
          at: expect.any(String),
        },
      },
    ]);
  });
});
