import { beforeAll, expect, it } from "vitest";
import { artifactIdentity, FEEDBACK_SCHEMA, type Explainer } from "@xpl/core";
import {
  cloneDir,
  editFile,
  fullIndex,
  indexedFixture,
  readJson,
  writeFile,
  makeTempDir,
  xpl,
  xplJson,
} from "./helpers.js";

let demo: string;
beforeAll(async () => {
  demo = await indexedFixture();
  expect((await xpl(demo, "new", "demo")).code).toBe(0);
});

it("imports, inspects, exports and records outcomes by ID while reporting outdated snapshots", async () => {
  const root = cloneDir(demo);
  const scratch = makeTempDir();
  const context = artifactIdentity(
    readJson<Explainer>(root, ".explainer/demo.explainer.json"),
    fullIndex(root),
  );
  const original = {
    id: "offline-request",
    elementId: "file:src/runner.ts",
    kind: "correct",
    at: "2026-10-04T12:00:00.000Z",
    context,
    range: { file: "src/runner.ts", fromLine: 4, toLine: 8, side: "head" },
    outcome: {
      revision: 0,
      status: "pending",
      reason: "Awaiting an explicit revision pass.",
      at: "2026-10-04T12:00:00.000Z",
    },
  };
  const exportFile = { schema: FEEDBACK_SCHEMA, requests: [original] };
  const input = writeFile(scratch, "feedback.json", JSON.stringify(exportFile));
  const first = await xplJson(root, "feedback", "demo", "--import", input);
  expect(first.code).toBe(0);
  expect(first.json.imported).toBe(1);
  expect(first.json.requests[0]).toMatchObject({ ...original, contextStatus: "current" });
  const again = await xplJson(root, "feedback", "demo", "--import", input);
  expect(again.json.imported).toBe(0);
  const outcomes = writeFile(
    scratch,
    "outcomes.json",
    JSON.stringify([
      { id: original.id, context, status: "unresolved", reason: "Run failed; retry available." },
    ]),
  );
  const recorded = await xpl(root, "feedback", "demo", "--outcomes", outcomes);
  expect(recorded.code).toBe(0);
  expect(recorded.out).toContain(
    "Invoke code-explainer in your harness for the next explicit feedback pass.",
  );
  expect((await xpl(root, "feedback", "demo", "--export", scratch + "/retry.json")).code).toBe(0);
  expect(readJson(scratch, "retry.json").requests[0]).toMatchObject({
    ...original,
    outcome: {
      revision: 1,
      status: "unresolved",
      reason: "Run failed; retry available.",
      at: expect.any(String),
    },
  });
  editFile(root, "src/runner.ts", (text) => text + "\n// New source snapshot.\n");
  expect((await xpl(root, "index", "--precise", "off")).code).toBe(0);
  const changed = await xplJson(root, "feedback", "demo", "--import", input);
  expect(changed.code).toBe(0);
  expect(changed.json.imported).toBe(0);
  expect(changed.json.requests[0]).toMatchObject({
    context,
    contextStatus: "outdated",
    outcome: { status: "unresolved", reason: "Run failed; retry available." },
  });
  expect(changed.json.requests[0].contextReason).toMatch(/snapshot changed|stale/);
});

it("refuses malformed imports without replacing existing disk feedback", async () => {
  const root = cloneDir(demo);
  const input = writeFile(
    makeTempDir(),
    "bad.json",
    JSON.stringify({ schema: FEEDBACK_SCHEMA, requests: [{ id: "broken" }] }),
  );
  const rejected = await xpl(root, "feedback", "demo", "--import", input);
  expect(rejected.code).toBe(1);
  expect(rejected.err).toContain("kind must be");
  expect((await xplJson(root, "feedback", "demo")).json.requests).toEqual([]);
});
