/**
 * The same regeneration flow on the Python and Go fixtures, in small: one llm patch with a symbol-relative
 * span inside `Runner.dispatch` (`find` on the requeue call), a whole-symbol anchor on the queue's requeue
 * method (both in one sequence step, like the handoff example's `dispatch:3`) and a `symbol: "retry"` anchor on
 * the YAML config. Then edits that give moved / drifted / missing, on their own and together, and the
 * report, `status`, a re-explain and `validate` after each.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  EXPLAINER_PATH,
  NAME,
  anchorsOf,
  applyOk,
  applyPatch,
  buildRepo,
  checkResolvedCache,
  patchPath,
  regenerate,
  replaceOnce,
  statusCounts,
  statusesOf,
} from "./fixtures/regeneration/kit.js";
import { cloneDir, readJson, xpl, xplJson } from "./helpers.js";

interface Lang {
  name: string;
  fixture: string;
  patch: string;
  runnerFile: string;
  queueFile: string;
  /** Symbol paths (`Runner.dispatch`, `Queue.requeue`) and the name the requeue method gets. */
  dispatch: string;
  requeue: string;
  renamed: string;
  /** The requeue call as anchored (`find`), where it is, and where the queue's requeue method is. */
  call: string;
  callLine: number;
  span: number;
  requeueRange: { startLine: number; endLine: number };
  /** Lines the "method above dispatch" edit adds. */
  inserted: number;
  edits: {
    /** A new method directly above `dispatch` (and above its doc comment). */
    methodAboveDispatch(dir: string): void;
    /** The requeue method is renamed; its call in dispatch is left alone. */
    renameDefinition(dir: string): void;
    /** The call in dispatch is renamed to follow the method. */
    renameCall(dir: string): void;
  };
}

const python: Lang = {
  name: "python",
  fixture: "py-jobrunner",
  patch: "py.patch.json",
  runnerFile: "jobrunner/runner.py",
  queueFile: "jobrunner/queue.py",
  dispatch: "Runner.dispatch",
  requeue: "Queue.requeue",
  renamed: "Queue.requeue_later",
  call: "await self._queue.requeue(job, backoff)",
  callLine: 90,
  span: 29,
  requeueRange: { startLine: 72, endLine: 79 },
  inserted: 5,
  edits: {
    methodAboveDispatch: (dir) =>
      replaceOnce(
        dir,
        "jobrunner/runner.py",
        "    async def dispatch(self) -> None:\n",
        '    @property\n    def running(self) -> bool:\n        """Whether the loop has been asked to keep going."""\n        return self._running\n\n    async def dispatch(self) -> None:\n',
      ),
    renameDefinition: (dir) =>
      replaceOnce(
        dir,
        "jobrunner/queue.py",
        "    async def requeue(self, job: Job, delay_ms: int) -> None:",
        "    async def requeue_later(self, job: Job, delay_ms: int) -> None:",
      ),
    renameCall: (dir) =>
      replaceOnce(
        dir,
        "jobrunner/runner.py",
        "await self._queue.requeue(job, backoff)",
        "await self._queue.requeue_later(job, backoff)",
      ),
  },
};

const go: Lang = {
  name: "go",
  fixture: "go-jobrunner",
  patch: "go.patch.json",
  runnerFile: "internal/runner/runner.go",
  queueFile: "internal/queue/queue.go",
  dispatch: "Runner.Dispatch",
  requeue: "Queue.Requeue",
  renamed: "Queue.RequeueLater",
  call: "r.queue.Requeue(job, backoff)",
  callLine: 112,
  span: 37,
  requeueRange: { startLine: 112, endLine: 124 },
  inserted: 3,
  edits: {
    methodAboveDispatch: (dir) =>
      replaceOnce(
        dir,
        "internal/runner/runner.go",
        "// Dispatch runs the loop until ctx is cancelled",
        "// Running reports whether the runner has been configured with a timeout.\nfunc (r *Runner) Running() bool { return r.cfg.Timeout > 0 }\n\n// Dispatch runs the loop until ctx is cancelled",
      ),
    renameDefinition: (dir) =>
      replaceOnce(
        dir,
        "internal/queue/queue.go",
        "func (q *Queue) Requeue(job *Job, delay time.Duration) error {",
        "func (q *Queue) RequeueLater(job *Job, delay time.Duration) error {",
      ),
    renameCall: (dir) =>
      replaceOnce(
        dir,
        "internal/runner/runner.go",
        "r.queue.Requeue(job, backoff)",
        "r.queue.RequeueLater(job, backoff)",
      ),
  },
};

/** The retry mapping of `config/default.yaml` is lines 13-16 in every fixture. */
const RETRY = { startLine: 13, endLine: 16 };
const changeMaxRetries = (dir: string) =>
  replaceOnce(dir, "config/default.yaml", "  maxRetries: 3\n", "  maxRetries: 5\n");
const addKeyAboveRetry = (dir: string) =>
  replaceOnce(dir, "config/default.yaml", "\nretry:\n", "  shutdownGraceMs: 5000\n\nretry:\n");

describe.each([python, go])("regeneration on the $name fixture", (lang) => {
  const symbol = (file: string, path: string) => `sym:${file}#${path}`;
  let base: string;

  beforeAll(async () => {
    base = await buildRepo(lang.fixture, [{ patch: patchPath(lang.patch), actor: "llm" }]);
  });

  it("starts with three anchors that resolve ok: a span in dispatch, a queue method, a YAML key", () => {
    const explainer = readJson(base, EXPLAINER_PATH);
    expect(anchorsOf(explainer, "requeue:1")).toMatchObject([
      {
        file: lang.runnerFile,
        symbol: lang.dispatch,
        span: { from: lang.span, to: lang.span },
        role: "call-site",
        resolved: { status: "ok", range: { startLine: lang.callLine, endLine: lang.callLine } },
      },
      {
        file: lang.queueFile,
        symbol: lang.requeue,
        role: "definition",
        resolved: { status: "ok", range: lang.requeueRange },
      },
    ]);
    expect(anchorsOf(explainer, "concept:retry-config")[0]).toMatchObject({
      file: "config/default.yaml",
      symbol: "retry",
      role: "config",
      resolved: { status: "ok", range: RETRY },
    });
    expect(statusCounts(explainer)).toEqual({ ok: 3, moved: 0, drifted: 0, missing: 0 });
    checkResolvedCache(base, explainer);
  });

  describe("on their own", () => {
    it("a method added above dispatch: the span moves with it, spans and text unchanged", async () => {
      const r = await regenerate(base, [lang.edits.methodAboveDispatch]);
      const before = readJson(base, EXPLAINER_PATH);
      const now = anchorsOf(r.explainer, "requeue:1")[0]!;
      expect(now.resolved).toEqual({
        commit: r.commit,
        status: "moved",
        range: {
          startLine: lang.callLine + lang.inserted,
          endLine: lang.callLine + lang.inserted,
        },
      });
      expect(now.span).toEqual({ from: lang.span, to: lang.span });
      expect(now.hash).toBe(anchorsOf(before, "requeue:1")[0]!.hash);
      expect(statusesOf(r.explainer, "requeue:1")).toEqual(["moved", "ok"]);
      expect(statusesOf(r.explainer, "concept:retry-config")).toEqual(["ok"]);
      expect(r.resolve.counts).toEqual({ ok: 2, moved: 1, drifted: 0, missing: 0 });
      expect(r.resolve).toMatchObject({ drifted: [], driftedOther: [], missing: [] });
      checkResolvedCache(r.dir, r.explainer);
      expect((await xpl(r.dir, "validate", NAME)).code).toBe(0);
    });

    it("maxRetries changed in the YAML: the retry key drifts, exactly and only that", async () => {
      const r = await regenerate(base, [changeMaxRetries]);
      expect(anchorsOf(r.explainer, "concept:retry-config")[0]!.resolved).toEqual({
        commit: r.commit,
        status: "drifted",
        range: RETRY, // a whole-symbol anchor: the range is exact
      });
      expect(statusesOf(r.explainer, "requeue:1")).toEqual(["ok", "ok"]);
      expect(r.resolve.counts).toEqual({ ok: 2, moved: 0, drifted: 1, missing: 0 });
      expect(r.resolve.drifted).toHaveLength(1);
      expect(r.resolve.drifted[0]).toMatchObject({
        elementId: "concept:retry-config",
        owner: "concept",
        userFields: [],
        anchors: [
          {
            path: "concepts[0].anchors[0]",
            anchor: { file: "config/default.yaml", symbol: "retry", role: "config" },
            range: RETRY,
          },
        ],
      });
      expect(r.resolve.drifted[0].anchors[0]).not.toHaveProperty("approximate");
      expect(r.resolve.drifted[0].anchors[0].reason).toContain(
        "text of config/default.yaml#retry changed",
      );
      expect(r.resolve.missing).toEqual([]);
      // no span, so the report does not call the lines approximate
      const text = await xpl(r.dir, "resolve", NAME);
      expect(text.out).toContain("config/default.yaml#retry [config]  now at lines 13-16\n");
      expect(text.out).not.toContain("approximate");
      checkResolvedCache(r.dir, r.explainer);
    });

    it("a key added above `retry:` moves the YAML symbol, unchanged", async () => {
      const r = await regenerate(base, [addKeyAboveRetry]);
      expect(anchorsOf(r.explainer, "concept:retry-config")[0]!.resolved).toEqual({
        commit: r.commit,
        status: "moved",
        range: { startLine: RETRY.startLine + 1, endLine: RETRY.endLine + 1 },
      });
      expect(r.resolve.counts).toEqual({ ok: 2, moved: 1, drifted: 0, missing: 0 });
      checkResolvedCache(r.dir, r.explainer);
    });

    it("the requeue method renamed: its anchor is missing and listed; the step is not drift", async () => {
      const r = await regenerate(base, [lang.edits.renameDefinition]);
      expect(statusesOf(r.explainer, "requeue:1")).toEqual(["ok", "missing"]);
      expect(r.resolve.counts).toEqual({ ok: 2, moved: 0, drifted: 0, missing: 1 });
      expect(r.resolve.drifted).toEqual([]);
      expect(r.resolve.missing).toHaveLength(1);
      expect(r.resolve.missing[0]).toMatchObject({
        elementId: "requeue:1",
        owner: "step",
        origin: "llm",
        path: "views[0].steps[0].anchors[1]",
        anchor: { file: lang.queueFile, symbol: lang.requeue, role: "definition" },
      });
      expect(r.resolve.missing[0].reason).toContain(
        `symbol ${lang.requeue} is not in ${lang.queueFile}`,
      );
      // nothing dropped: the anchor keeps its symbol, hash and last range
      expect(anchorsOf(r.explainer, "requeue:1")[1]).toMatchObject({
        file: lang.queueFile,
        symbol: lang.requeue,
        resolved: { status: "missing", range: lang.requeueRange },
      });
      const text = await xpl(r.dir, "resolve", NAME);
      expect(text.out).toContain("missing anchors (1): fix or drop them explicitly");
      expect(text.out).toContain(
        `  requeue:1  views[0].steps[0].anchors[1]  ${lang.queueFile}#${lang.requeue} [definition]`,
      );
    });

    it("the method and its call renamed together: the call site drifts, the definition is missing", async () => {
      const r = await regenerate(base, [lang.edits.renameDefinition, lang.edits.renameCall]);
      expect(statusesOf(r.explainer, "requeue:1")).toEqual(["drifted", "missing"]);
      expect(r.resolve.counts).toEqual({ ok: 1, moved: 0, drifted: 1, missing: 1 });
      // once in each list: the step is re-explained (its call site changed) and its missing anchor is surfaced
      expect(r.resolve.drifted.map((d: any) => d.elementId)).toEqual(["requeue:1"]);
      expect(r.resolve.drifted[0].anchors.map((a: any) => a.path)).toEqual([
        "views[0].steps[0].anchors[0]",
      ]);
      expect(r.resolve.missing.map((m: any) => m.elementId)).toEqual(["requeue:1"]);
      checkResolvedCache(r.dir, r.explainer);
    });
  });

  describe("all three in one second commit", () => {
    let after: Awaited<ReturnType<typeof regenerate>>;

    beforeAll(async () => {
      after = await regenerate(
        base,
        [lang.edits.methodAboveDispatch, changeMaxRetries, lang.edits.renameDefinition],
        "second commit",
      );
    });

    it("gives moved, drifted and missing, one anchor each", () => {
      expect(statusesOf(after.explainer, "requeue:1")).toEqual(["moved", "missing"]);
      expect(statusesOf(after.explainer, "concept:retry-config")).toEqual(["drifted"]);
      expect(after.resolve.counts).toEqual({ ok: 0, moved: 1, drifted: 1, missing: 1 });
      expect(after.resolve.total).toBe(3);
      expect(after.resolve.index).toMatchObject({ commit: after.commit });
      expect(after.explainer.index.commit).toBe(after.commit);
      checkResolvedCache(after.dir, after.explainer);
    });

    it("reports the drifted llm element and the missing anchor, and status lists the same", async () => {
      expect(after.resolve.drifted.map((d: any) => d.elementId)).toEqual(["concept:retry-config"]);
      expect(after.resolve.missing.map((m: any) => m.elementId)).toEqual(["requeue:1"]);
      const { json } = await xplJson<any>(after.dir, "status", NAME);
      expect(json.drifted.map((d: any) => d.elementId)).toEqual(["concept:retry-config"]);
      expect(json.missing.map((m: any) => m.elementId)).toEqual(["requeue:1"]);
      // the participant and the step end that pointed at the vanished symbol are broken references too
      expect(json.todo).toMatchObject({ drifted: 1, missing: 1, requests: 0, broken: 2 });
      expect(json.broken.map((i: any) => i.path)).toEqual([
        "views[0].participants[1]",
        "views[0].steps[0].to",
      ]);
      const text = await xpl(after.dir, "status", NAME);
      expect(text.out).toMatch(
        /^to do: \d+ unexplained, 1 drifted, 1 missing anchors, 0 requests, 2 broken references$/m,
      );
      expect(text.out).toContain("broken references (2): ids that no longer exist in the index");
      expect(text.out).toContain("drifted llm elements to re-explain (1):");
      expect(text.out).toContain("  concept:retry-config  (concept)");
    });

    it("Claude re-explains the drifted concept; the missing anchor stays until the view is repaired", async () => {
      const dir = cloneDir(after.dir);
      const explained = await applyOk(
        dir,
        {
          concepts: [
            {
              id: "concept:retry-config",
              summary: "maxRetries is now 5: a failed job is retried up to five times.",
              anchors: [{ file: "config/default.yaml", symbol: "retry", role: "config" }],
            },
          ],
        },
        "llm",
      );
      expect(explained.json.changed).toEqual(["concept:retry-config"]);
      expect(statusesOf(readJson(dir, EXPLAINER_PATH), "concept:retry-config")).toEqual(["ok"]);
      const { json } = await xplJson<any>(dir, "status", NAME);
      expect(json.drifted).toEqual([]);
      expect(json.missing.map((m: any) => m.elementId)).toEqual(["requeue:1"]);

      // strict validate: the missing anchor, and the view's participant and step end, which name the old symbol
      const strict = await xplJson<any>(dir, "validate", NAME);
      expect(strict.code).toBe(1);
      const errors = strict.json.issues.filter((i: any) => i.severity === "error");
      expect(errors.map((i: any) => i.code)).toEqual([
        "unknown-id", // participants[1]
        "unknown-id", // steps[0].to
        "anchor-missing",
      ]);
      expect(errors[2].message).toContain(`anchor ${lang.queueFile}#${lang.requeue} is missing`);
      expect(errors[2].message).toContain("Re-anchor it to where the code went, or drop it");

      // the view repaired against the renamed method (participants and step end included): validate is clean
      const [renamedFile, renamedPath] = [lang.queueFile, lang.renamed];
      const dispatch = symbol(lang.runnerFile, lang.dispatch);
      const renamedId = symbol(renamedFile, renamedPath);
      const repaired = await applyOk(
        dir,
        {
          views: [
            {
              id: "view:requeue",
              type: "sequence",
              participants: [dispatch, renamedId],
              steps: [
                {
                  id: "requeue:1",
                  from: dispatch,
                  to: renamedId,
                  label: "requeue(job, backoff)",
                  kind: "call",
                  summary: "A failed job goes back on the queue after the computed backoff.",
                  anchors: [
                    {
                      file: lang.runnerFile,
                      symbol: lang.dispatch,
                      find: lang.call,
                      role: "call-site",
                    },
                    { file: renamedFile, symbol: renamedPath, role: "definition" },
                  ],
                },
              ],
            },
          ],
        },
        "llm",
      );
      expect(repaired.json.changed).toEqual(["view:requeue"]);
      const validated = await xpl(dir, "validate", NAME);
      expect(validated.code, validated.out).toBe(0);
      const after2 = readJson(dir, EXPLAINER_PATH);
      expect(statusCounts(after2)).toMatchObject({ drifted: 0, missing: 0 });
      checkResolvedCache(dir, after2);
      const done = await xplJson<any>(dir, "resolve", NAME);
      expect(done.json).toMatchObject({ drifted: [], missing: [] });
    });

    it("an llm patch that keeps the missing anchor is refused when it touches that view", async () => {
      const dir = cloneDir(after.dir);
      const steps = structuredClone(readJson(dir, EXPLAINER_PATH).views[0].steps) as any[];
      steps[0].summary = "Requeued after a delay.";
      const refused = await applyPatch(
        dir,
        { views: [{ id: "view:requeue", type: "sequence", steps }] },
        "llm",
      );
      expect(refused.code).toBe(1);
      expect(refused.json.applied).toBe(false);
      expect(
        refused.json.issues.filter((i) => i.severity === "error").map((i) => i.code),
      ).toContain("anchor-invalid");
    });
  });
});
