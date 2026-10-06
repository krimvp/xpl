import { afterEach, expect, it, vi } from "vitest";
import { FEEDBACK_SCHEMA, hashText, parseFeedbackRequest, validateFeedbackAnswer } from "@xpl/core";
import { ViewerStore } from "../src/store.js";
import { makeBundle } from "./world.js";

afterEach(() => vi.unstubAllGlobals());

it.each([false, true])(
  "refuses an oversized history union, including a stale tab (%s)",
  async (stale) => {
    const entries = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      get length() {
        return entries.size;
      },
      key: (i: number) => [...entries.keys()][i] ?? null,
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
    });
    const store = new ViewerStore(makeBundle());
    const staleTab = new ViewerStore(makeBundle());
    const at = "2026-10-05T12:00:00.000Z";
    const request = parseFeedbackRequest({
      id: "question",
      elementId: "concept:retry",
      kind: "explain",
      note: "Why retry?",
      at,
      context: { explainerHash: "guide", sourceHash: "source" },
      outcome: { revision: 0, status: "pending", reason: "Awaiting a pass.", at },
    });
    const answer = validateFeedbackAnswer(
      {
        text: "The call retries.",
        references: [{ file: "a.ts", side: "head", fromLine: 1, toLine: 1, quote: "retry();" }],
      },
      request,
      [{ file: "a.ts", side: "head", text: "retry();", hash: hashText("retry();") }],
      "answer",
      at,
    );
    const portable = (prefix: string) => ({
      schema: FEEDBACK_SCHEMA,
      requests: [
        {
          ...request,
          answers: Array.from({ length: 600 }, (_, i) => ({ ...answer, id: `${prefix}-${i}` })),
        },
      ],
    });
    await store.importFeedback(portable("first"));
    expect(store.feedbackFile().requests[0]?.answers).toHaveLength(600);
    const before = store.feedbackJson();
    const records = [...entries];
    const importing = stale ? staleTab : store;
    await expect(importing.importFeedback(portable("second"))).rejects.toThrow(
      "at most 1000 entries",
    );
    expect(importing.feedbackJson()).toBe(before);
    expect(store.feedbackJson()).toBe(before);
    expect([...entries]).toEqual(records);
    expect(new ViewerStore(makeBundle()).feedbackJson()).toBe(before);
  },
);
