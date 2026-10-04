import { afterEach, expect, it, vi } from "vitest";
import { type FeedbackOutcome, type FeedbackRequest, FEEDBACK_SCHEMA } from "@xpl/core";
import { ViewerStore } from "../src/store.js";
import { makeBundle } from "./world.js";
import { importRequests, readRequests, recordOutcomes } from "../../cli/src/requests.js";
import { makeTempDir } from "../../cli/test/helpers.js";

afterEach(() => vi.unstubAllGlobals());

it("outcomes never regress through seeded interleavings of recording, import, refresh and portable reload", async () => {
  for (const seed of [28, 52, 1194]) {
    const root = makeTempDir();
    const entries = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      get length() {
        return entries.size;
      },
      key: (i: number) => [...entries.keys()][i] ?? null,
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
    });
    let served: FeedbackRequest[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") await importRequests(root, [JSON.parse(String(init.body))]);
      return new Response(JSON.stringify({ requests: served }));
    });
    const bundle = makeBundle({ server: { api: "/api" } });
    let store = new ViewerStore(bundle);
    await store.requestExplain("concept:retry", "Keep the outcome history.");
    const initial = readRequests(root).requests[0]!;
    const history = [initial];
    let observed: FeedbackOutcome = initial.outcome;
    let disk = initial.outcome;
    let random = seed;
    const next = () => {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      return random;
    };
    // Always exercise an old response after two recordings, then vary the interleaving.
    const prefix = [0, 0, 1, 4];
    for (let step = 0; step < 80; step++) {
      const operation = prefix[step] ?? next() % 5;
      const candidate = history[next() % history.length]!;
      if (operation === 0) {
        await recordOutcomes(root, [
          {
            id: initial.id,
            context: initial.context,
            status: "unresolved",
            reason: `Pass ${seed}/${step}.`,
          },
        ]);
        const recorded = readRequests(root).requests[0]!;
        expect(recorded.outcome.revision).toBe(disk.revision + 1);
        history.push(recorded);
      } else if (operation === 1 || operation === 4) {
        served = operation === 4 ? [initial] : readRequests(root).requests;
        if (served[0]!.outcome.revision > observed.revision) observed = served[0]!.outcome;
        await store.refreshFeedback();
      } else if (operation === 2) {
        // Conflicting equal revisions keep the already stored result, independent of timestamps.
        const incoming = {
          ...candidate,
          outcome: { ...candidate.outcome, reason: "Portable tie." },
        };
        await importRequests(root, [incoming]);
        expect(readRequests(root).requests[0]!.outcome).toEqual(disk);
      } else {
        if (candidate.outcome.revision > observed.revision) observed = candidate.outcome;
        store = new ViewerStore({
          ...bundle,
          feedback: { schema: FEEDBACK_SCHEMA, requests: [candidate] },
        });
      }
      const current = readRequests(root).requests[0]!.outcome;
      expect(
        current.revision,
        `seed ${seed}, step ${step}, operation ${operation}: disk`,
      ).toBeGreaterThanOrEqual(disk.revision);
      disk = current;
      expect(
        store.getState().feedback[0]!.outcome,
        `seed ${seed}, step ${step}, operation ${operation}: viewer`,
      ).toEqual(observed);
      expect(JSON.parse(store.feedbackJson()).requests[0].outcome).toEqual(observed);
      // Reopening an older saved page must retain every revision this browser has already observed.
      const reopened = new ViewerStore({
        ...bundle,
        feedback: { schema: FEEDBACK_SCHEMA, requests: [initial] },
      });
      expect(reopened.getState().feedback[0]!.outcome).toEqual(observed);
    }
    vi.unstubAllGlobals();
  }
});
