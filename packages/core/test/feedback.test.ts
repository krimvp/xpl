import { expect, it } from "vitest";
import { FEEDBACK_SCHEMA, parseFeedbackFile } from "../src/index.js";

const request = {
  id: "offline-1",
  elementId: "file:src/a.ts",
  kind: "explain",
  at: "2026-10-04T12:00:00.000Z",
  context: { explainerHash: "explanation-1", sourceHash: "source-1" },
  range: { file: "src/a.ts", fromLine: 1, toLine: 5, side: "head" },
  outcome: {
    status: "pending",
    reason: "Awaiting a revision pass.",
    at: "2026-10-04T12:00:00.000Z",
  },
};

it.each([
  [{ range: { ...request.range, file: "../outside.ts" } }, "repository-relative"],
  [{ range: { ...request.range, fromLine: 6 } }, "inclusive line numbers"],
  [{ outcome: { ...request.outcome, reason: "" } }, "reason must be"],
  [{ outcome: { ...request.outcome, status: "approved" } }, "unknown feedback status"],
  [{ context: null }, "unbound legacy feedback must be outdated"],
  [{ kind: "generate" }, "unknown feedback kind"],
])("rejects malformed imported request %j before storage", (change, error) => {
  expect(() =>
    parseFeedbackFile({ schema: FEEDBACK_SCHEMA, requests: [{ ...request, ...change }] }),
  ).toThrow(error as string);
});
