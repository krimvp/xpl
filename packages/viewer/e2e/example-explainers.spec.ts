/**
 * The example explainers of the three fixtures (docs/handoff.md Appendix B, once per language):
 * what `scripts/<lang>-example.patch.json` (actor llm) and `scripts/<lang>-example.user.patch.json`
 * (actor user) build, which global-setup.ts puts into the bundles.
 *
 * - The committed fixtures/<lang>-jobrunner/.explainer/jobrunner.explainer.json is exactly that
 *   explainer (regenerate it after editing a patch or a fixture: see global-setup.ts).
 * - Provenance is Appendix B's: the concept is the user's (an llm patch cannot create one), the
 *   `Runner.dispatch` overlay is llm with the summary listed in `userFields` (only a user patch records
 *   that), everything else is llm.
 * - The ids and shapes the port keeps: group, overlay, `edge:job-completed` with evidence at both ends,
 *   the overview, the dispatch sequence with steps `dispatch:1..3` and `frame:retry`, `tour:intro`.
 */
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { GO_BUNDLE, PY_BUNDLE, readEmbeddedBundle, TS_BUNDLE } from "./helpers.js";

interface Example {
  lang: string;
  bundle: URL;
  runner: string;
  dispatch: string;
  queue: string;
  worker: string;
  metrics: string;
}

const EXAMPLES: Example[] = [
  {
    lang: "ts",
    bundle: TS_BUNDLE,
    runner: "src/runner.ts",
    dispatch: "Runner.dispatch",
    queue: "src/queue.ts",
    worker: "src/worker.ts",
    metrics: "src/metrics.ts",
  },
  {
    lang: "py",
    bundle: PY_BUNDLE,
    runner: "jobrunner/runner.py",
    dispatch: "Runner.dispatch",
    queue: "jobrunner/queue.py",
    worker: "jobrunner/worker.py",
    metrics: "jobrunner/metrics.py",
  },
  {
    lang: "go",
    bundle: GO_BUNDLE,
    runner: "internal/runner/runner.go",
    dispatch: "Runner.Dispatch",
    queue: "internal/queue/queue.go",
    worker: "internal/worker/worker.go",
    metrics: "internal/metrics/metrics.go",
  },
];

/** The slice of a stored explainer these checks read. */
interface StoredAnchor {
  file: string;
  role: string;
  resolved?: { status: string };
}
interface Stored {
  id: string;
  provenance?: { origin: string; userFields?: string[] };
  summary?: string;
  from?: string;
  to?: string;
  kind?: string;
  anchors?: StoredAnchor[];
  steps?: { id: string; from: string; to: string; anchors: StoredAnchor[] }[];
  frames?: { id: string; kind: string; fromStep: string; toStep: string }[];
  participants?: string[];
  focus?: string[];
}
interface StoredExplainer {
  nodes: Stored[];
  edges: Stored[];
  concepts: Stored[];
  views: Stored[];
  tours: { id: string; steps: (Stored & { view: string })[] }[];
}

const byId = <T extends { id: string }>(list: T[], id: string): T => {
  const found = list.find((item) => item.id === id);
  if (!found) throw new Error(`no ${id} in [${list.map((item) => item.id).join(", ")}]`);
  return found;
};

for (const example of EXAMPLES) {
  test.describe(`${example.lang} example explainer`, () => {
    const built = () => readEmbeddedBundle(example.bundle).bundle.explainer as StoredExplainer;
    const dispatchId = `sym:${example.runner}#${example.dispatch}`;

    test("the committed explainer is the one the patches build", () => {
      const committedFile = new URL(
        `../../../fixtures/${example.lang}-jobrunner/.explainer/jobrunner.explainer.json`,
        import.meta.url,
      );
      const committed = JSON.parse(readFileSync(committedFile, "utf8")) as unknown;
      const regenerate =
        `cd packages/viewer && npx tsx scripts/make-bundle.ts ../../fixtures/${example.lang}-jobrunner ` +
        `--name jobrunner --title "Job runner" --repo acme/jobrunner ` +
        `--patch scripts/${example.lang}-example.patch.json`;
      expect(
        built(),
        `${committedFile.pathname} is stale; regenerate it with: ${regenerate}`,
      ).toEqual(committed);
    });

    test("provenance: the concept is the user's, the summary of Runner.dispatch is a user edit of an llm element", () => {
      const explainer = built();
      expect(byId(explainer.concepts, "concept:retry-policy").provenance).toMatchObject({
        origin: "user",
      });
      expect(
        byId(explainer.concepts, "concept:retry-policy").provenance?.userFields,
      ).toBeUndefined();

      const dispatch = byId(explainer.nodes, dispatchId);
      expect(dispatch.provenance).toMatchObject({ origin: "llm", userFields: ["summary"] });
      expect(dispatch.summary).toBe("The hot loop: pop, lease a worker, run, ack or requeue.");

      const llm = [
        byId(explainer.nodes, "grp:scheduling"),
        byId(explainer.edges, "edge:job-completed"),
        byId(explainer.views, "view:overview"),
        byId(explainer.views, "view:dispatch"),
      ];
      for (const element of llm) {
        expect(element.provenance, element.id).toMatchObject({ origin: "llm" });
        expect(element.provenance?.userFields, element.id).toBeUndefined();
      }
    });

    test("ids and shapes: the edge has evidence at both ends, the steps anchor the call and the callee, the tour points at both", () => {
      const explainer = built();

      const edge = byId(explainer.edges, "edge:job-completed");
      expect([edge.from, edge.to, edge.kind]).toEqual([
        `file:${example.worker}`,
        `file:${example.metrics}`,
        "emits",
      ]);
      expect(edge.anchors?.map((a) => [a.file, a.role])).toEqual([
        [example.worker, "call-site"],
        [example.metrics, "definition"],
      ]);

      const sequence = byId(explainer.views, "view:dispatch");
      expect(sequence.participants).toEqual([
        dispatchId,
        `file:${example.queue}`,
        `file:${example.worker}`,
      ]);
      expect(sequence.steps?.map((step) => step.id)).toEqual([
        "dispatch:1",
        "dispatch:2",
        "dispatch:3",
      ]);
      const calleeFiles = [example.queue, example.worker, example.queue];
      sequence.steps!.forEach((step, i) => {
        expect(step.from, step.id).toBe(dispatchId);
        expect(
          step.anchors.map((a) => [a.file, a.role, a.resolved?.status]),
          step.id,
        ).toEqual([
          [example.runner, "call-site", "ok"],
          [calleeFiles[i], "definition", "ok"],
        ]);
      });
      expect(sequence.frames).toEqual([
        {
          id: "frame:retry",
          kind: "loop",
          label: "until success or maxRetries",
          fromStep: "dispatch:2",
          toStep: "dispatch:3",
        },
      ]);

      const concept = byId(explainer.concepts, "concept:retry-policy");
      expect(concept.anchors?.map((a) => [a.file, a.role])).toEqual([
        [example.runner, "definition"],
        ["config/default.yaml", "config"],
        [expect.stringMatching(/retry/), "test"],
      ]);

      const tour = byId(explainer.tours, "tour:intro");
      expect(tour.steps.map((step) => [step.id, step.view, step.focus])).toEqual([
        ["t1", "view:overview", ["grp:scheduling"]],
        ["t2", "view:dispatch", ["dispatch:3", "concept:retry-policy"]],
      ]);
      expect(byId(explainer.views, "view:overview")).toMatchObject({
        type: "graph",
        include: ["grp:scheduling", `file:${example.worker}`, `file:${example.metrics}`],
      });
    });
  });
}
