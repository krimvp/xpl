import { expect, it } from "vitest";
import {
  FEEDBACK_SCHEMA,
  hashText,
  mergeFeedbackRequests,
  parseFeedbackFile,
  parseFeedbackRequest,
  validateFeedbackAnswer,
} from "../src/index.js";

const at = "2026-10-05T12:00:00.000Z";
const request = parseFeedbackRequest({
  id: "question-1",
  elementId: "file:src/a.ts",
  kind: "explain",
  note: "What changed?",
  at,
  context: { explainerHash: "guide-1", sourceHash: "source-1" },
  outcome: { status: "pending", revision: 0, reason: "Awaiting an explicit pass.", at },
});
const sources = [
  { file: "src/a.ts", side: "head" as const, text: "new();\n", hash: hashText("new();\n") },
  { file: "src/a.ts", side: "base" as const, text: "old();\n", hash: hashText("old();\n") },
];
const output = {
  text: "The call changed.",
  references: [
    { file: "src/a.ts", side: "base", fromLine: 1, toLine: 1, quote: "old();" },
    { file: "src/a.ts", side: "head", fromLine: 1, toLine: 1, quote: "new();" },
  ],
};

it("ports exact head/base evidence and unions answer history independently of outcomes", () => {
  const answer = validateFeedbackAnswer(output, request, sources, "job-1", at);
  const answered = parseFeedbackRequest({ ...request, answers: [answer] });
  const imported = parseFeedbackFile({ schema: FEEDBACK_SCHEMA, requests: [answered] }).requests;
  const newer = parseFeedbackRequest({
    ...request,
    outcome: {
      ...request.outcome,
      revision: 1,
      status: "unresolved",
      reason: "Needs a guide revision.",
    },
  });
  const merged = mergeFeedbackRequests([newer, ...imported, answered, request]);
  expect(merged).toEqual([{ ...newer, answers: [answer] }]);
  expect(answer.references).toEqual(output.references);
  expect(answer.context).toEqual(request.context);
  expect(answer.sources).toEqual(sources);
});

it.each([
  [{ references: [{ ...output.references[0], quote: "new();" }] }, "quote does not match"],
  [{ references: [{ ...output.references[0], toLine: 3 }] }, "outside recorded"],
  [{ references: [{ ...output.references[0], file: "src/missing.ts" }] }, "no recorded source"],
  [{ references: [{ ...output.references[0], file: "../a.ts" }] }, "repository-relative"],
  [{ references: [] }, "requires 1 to 100"],
  [{ patch: {} }, "only text and references"],
])("refuses invalid model evidence %j", (change, error) => {
  expect(() =>
    validateFeedbackAnswer({ ...output, ...change }, request, sources, "job-1", at),
  ).toThrow(error as string);
});

it("rejects corrupted portable evidence, mismatched context and conflicting answer identities", () => {
  const answer = validateFeedbackAnswer(output, request, sources, "job-1", at);
  expect(() =>
    parseFeedbackRequest({
      ...request,
      answers: [{ ...answer, sources: [{ ...sources[0], text: "forged();" }, sources[1]] }],
    }),
  ).toThrow("source hash does not match");
  expect(() =>
    parseFeedbackRequest({
      ...request,
      answers: [{ ...answer, context: { ...answer.context, sourceHash: "other" } }],
    }),
  ).toThrow("original request context");
  expect(() =>
    mergeFeedbackRequests([
      { ...request, answers: [answer] },
      { ...request, answers: [{ ...answer, text: "Changed answer" }] },
    ]),
  ).toThrow("answer ID job-1 conflicts");
});

it("refuses reusing one portable answer ID for another request", () => {
  const answer = validateFeedbackAnswer(output, request, sources, "job-1", at);
  const other = { ...request, id: "question-2" };
  expect(() =>
    mergeFeedbackRequests([
      { ...request, answers: [answer] },
      { ...other, answers: [{ ...answer, requestId: other.id }] },
    ]),
  ).toThrow("answer ID job-1 belongs to another request");
});
