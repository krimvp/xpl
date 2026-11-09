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
    "To act on the requests, start the code-explainer skill in your agent.",
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
  expect(changed.json.requests[0].contextReason).toMatch(/changed after the reader asked|stale/);
});

it("says when there is nothing, and what it wrote", async () => {
  const root = cloneDir(demo);
  const empty = await xpl(root, "feedback", "demo");
  expect(empty.out).toBe("no reader requests for demo");
  const out = makeTempDir() + "/none.json";
  const exported = await xpl(root, "feedback", "demo", "--export", out);
  expect(exported.out).toBe(`wrote ${out} (0 requests)`);
});

it("a request without its outcome names the request and the field", async () => {
  const root = cloneDir(demo);
  const request = {
    id: "r2",
    elementId: "file:src/runner.ts",
    kind: "explain",
    at: "2026-10-04T12:00:00.000Z",
    context: null,
  };
  const input = writeFile(
    makeTempDir(),
    "bad.json",
    JSON.stringify({ schema: FEEDBACK_SCHEMA, requests: [request] }),
  );
  const rejected = await xpl(root, "feedback", "demo", "--import", input);
  expect(rejected.code).toBe(1);
  expect(rejected.err).toContain(
    "request 1 (id r2): outcome must be an object {revision, status, reason, at}",
  );
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

it("lists each request with the reader's note, keeps one of two equal saves, and says nothing to do once all are answered", async () => {
  const root = cloneDir(demo);
  const scratch = makeTempDir();
  const context = artifactIdentity(
    readJson<Explainer>(root, ".explainer/demo.explainer.json"),
    fullIndex(root),
  );
  const at = "2026-10-04T12:00:00.000Z";
  const question = (id: string, note = "Does a timeout count as a failed attempt?") => ({
    id,
    elementId: "file:src/worker.ts",
    kind: "explain",
    note,
    at,
    context,
    outcome: { revision: 0, status: "pending", reason: "Awaiting an explicit revision pass.", at },
  });
  const input = writeFile(
    scratch,
    "feedback.json",
    JSON.stringify({
      schema: FEEDBACK_SCHEMA,
      // q3 asks another question about the same element: it is not a duplicate of q1
      requests: [question("q1"), question("q2"), question("q3", "Who retries it?")],
    }),
  );
  const imported = await xpl(root, "feedback", "demo", "--import", input);
  expect(imported.code).toBe(0);
  expect(imported.out.split("\n")).toEqual([
    "imported 2 requests; 2 are stored for demo",
    "q1  pending  question file:src/worker.ts",
    '  "Does a timeout count as a failed attempt?"',
    "q3  pending  question file:src/worker.ts",
    '  "Who retries it?"',
    "To act on the requests, start the code-explainer skill in your agent. Saving feedback starts nothing.",
  ]);
  const outcomes = writeFile(
    scratch,
    "outcomes.json",
    JSON.stringify([
      { id: "q1", context, status: "addressed", reason: "Step 4 answers it." },
      { id: "q3", context, status: "addressed", reason: "Step 5 answers it." },
    ]),
  );
  expect((await xpl(root, "feedback", "demo", "--outcomes", outcomes)).code).toBe(0);
  // the guide changes when the author answers: an answered request has no context left to reconcile
  editFile(root, ".explainer/demo.explainer.json", (text) =>
    text.replace('"title": "', '"title": "Changed '),
  );
  const listed = await xpl(root, "feedback", "demo");
  expect(listed.out.split("\n")).toEqual([
    "q1  addressed  question file:src/worker.ts",
    '  "Does a timeout count as a failed attempt?"',
    "  Step 4 answers it.",
    "q3  addressed  question file:src/worker.ts",
    '  "Who retries it?"',
    "  Step 5 answers it.",
  ]);
  // the same question asked again after the author answered it is a new request
  const again = writeFile(
    scratch,
    "again.json",
    JSON.stringify({ schema: FEEDBACK_SCHEMA, requests: [question("q4")] }),
  );
  const reasked = await xplJson(root, "feedback", "demo", "--import", again);
  expect(reasked.json.imported).toBe(1);
  expect(reasked.json.requests.map((r: { id: string }) => r.id)).toEqual(["q1", "q3", "q4"]);
});
