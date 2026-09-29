/**
 * "Regeneration on a new commit", end to end on the TS fixture (handoff section 3 "Anchoring and change",
 * ARCHITECTURE.md 4.2 and 4.7): a real git repo, an explainer built through the CLI (llm patches plus a user
 * patch), then a second commit of edits, `xpl index`, `xpl resolve --write`, `xpl status`, a simulated
 * Claude re-explain (llm patch), `xpl validate` and the user's own fixes.
 *
 * Each of the five edits is proven on its own copy of the repo first (so one edit cannot hide another), then
 * all five go into a single second commit, which is the flow the skill actually meets.
 */
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  EXPLAINER_PATH,
  NAME,
  anchorInventory,
  anchorsOf,
  applyOk,
  applyPatch,
  buildRepo,
  checkResolvedCache,
  commit,
  patchPath,
  regenerate,
  replaceOnce,
  statusCounts,
  statusesOf,
} from "./fixtures/regeneration/kit.js";
import {
  PATCH_PATH,
  cloneDir,
  git,
  makeTempDir,
  readFile,
  readJson,
  writeFile,
  xpl,
  xplJson,
} from "./helpers.js";

const DISPATCH = "sym:src/runner.ts#Runner.dispatch";
const USER_SUMMARY = "Mine: the hot loop. Pop, lease, run, then ack, requeue or dead-letter.";

// ─── The five edits of the second commit ────────────────────────────────────────────────────────

const COMMENT_BLOCK = [
  "  // Runs the dispatch loop until stop() is called.",
  "  //",
  "  // Each pass handles at most one job. A failed job is retried with",
  "  // exponential backoff or dead-lettered; nothing escapes the loop,",
  "  // so start()'s promise only rejects if the loop itself crashes.",
  "",
].join("\n");

const README_NOTES = [
  "## Design notes",
  "",
  "The runner is deliberately small.",
  "Everything else hangs off the queue.",
  "",
  "## How it works",
  "",
].join("\n");

const edits = {
  /** 1. Five comment lines directly above `Runner.dispatch`. */
  commentAboveDispatch: (dir: string) =>
    replaceOnce(
      dir,
      "src/runner.ts",
      "  async dispatch(): Promise<void> {\n",
      `${COMMENT_BLOCK}  async dispatch(): Promise<void> {\n`,
    ),
  /** 2. A blank line inside the retry block, between `attempts` and the `if`. */
  blankLineInRetryBlock: (dir: string) =>
    replaceOnce(
      dir,
      "src/runner.ts",
      "      const attempts = job.attempts + 1;\n      if (",
      "      const attempts = job.attempts + 1;\n\n      if (",
    ),
  /** 2, variant: a blank line inside the dead-letter branch, away from the requeue call. */
  blankLineInDeadLetterBranch: (dir: string) =>
    replaceOnce(
      dir,
      "src/runner.ts",
      "        await this.queue.deadLetter(job, result.error);\n        this.stats",
      "        await this.queue.deadLetter(job, result.error);\n\n        this.stats",
    ),
  /** 3. `backoff` becomes `delay`, in the declaration and in the requeue call. */
  renameBackoff: (dir: string) =>
    replaceOnce(
      dir,
      "src/runner.ts",
      "        const backoff = backoffDelay(attempts, this.config.retry);\n        await this.queue.requeue(\n          job,\n          backoff);\n",
      "        const delay = backoffDelay(attempts, this.config.retry);\n        await this.queue.requeue(\n          job,\n          delay);\n",
    ),
  /** 4. `Queue.ack` and its call are deleted. */
  deleteAck: (dir: string) => {
    replaceOnce(
      dir,
      "src/queue.ts",
      "  /** Marks a job as done for good. */\n  async ack(job: Job): Promise<void> {\n    this.inflight.delete(job.id);\n    this.acked += 1;\n  }\n\n",
      "",
    );
    replaceOnce(
      dir,
      "src/runner.ts",
      "      if (result.ok) {\n        await this.queue.ack(job);\n        continue;\n",
      "      if (result.ok) {\n        continue;\n",
    );
  },
  /** 5. Five lines above the README paragraph that `concept:how-it-works` anchors. */
  moveReadmeParagraph: (dir: string) =>
    replaceOnce(dir, "README.md", "## How it works\n", README_NOTES),
};

// ─── The repo before the second commit ──────────────────────────────────────────────────────────

let base: string;

beforeAll(async () => {
  // the handoff example (llm), then the user's own concept and summary, then three more llm concepts
  base = await buildRepo("ts-jobrunner", [
    { patch: PATCH_PATH, actor: "llm" },
    { patch: patchPath("ts-user.patch.json"), actor: "user" },
    { patch: patchPath("ts-llm-extra.patch.json"), actor: "llm" },
  ]);
});

describe("the explainer before the second commit", () => {
  it("has llm, user and userFields-protected elements, and every anchor resolves ok", () => {
    const explainer = readJson(base, EXPLAINER_PATH);
    const provenance = (id: string) =>
      [...explainer.nodes, ...explainer.concepts].find((e: any) => e.id === id).provenance;
    expect(provenance(DISPATCH)).toMatchObject({ origin: "llm", userFields: ["summary"] });
    expect(provenance("concept:retry-policy").origin).toBe("llm");
    expect(provenance("concept:retry-tuning").origin).toBe("user");
    for (const id of ["concept:ack-semantics", "concept:how-it-works", "concept:dead-letter"]) {
      expect(provenance(id).origin, id).toBe("llm");
    }
    expect(statusCounts(explainer)).toEqual({ ok: 16, moved: 0, drifted: 0, missing: 0 });
    checkResolvedCache(base, explainer);
    // the anchors the five edits are aimed at
    expect(anchorsOf(explainer, "concept:ack-semantics")[0]).toMatchObject({
      file: "src/queue.ts",
      symbol: "Queue.ack",
      resolved: { range: { startLine: 93, endLine: 96 } },
    });
    expect(anchorsOf(explainer, "concept:how-it-works")[0]).toMatchObject({
      file: "README.md",
      span: { from: 21, to: 24 },
      resolved: { range: { startLine: 22, endLine: 25 } },
    });
    expect(anchorsOf(explainer, "dispatch:3")[0]).toMatchObject({
      span: { from: 34, to: 36 },
      resolved: { range: { startLine: 76, endLine: 78 } },
    });
  });

  it("validates strictly and has nothing to re-explain", async () => {
    const validated = await xpl(base, "validate", NAME);
    expect(validated.code).toBe(0);
    expect(validated.out).toMatch(/^ok: /);
    const { json } = await xplJson<any>(base, "status", NAME);
    expect(json.todo).toMatchObject({ drifted: 0, missing: 0 });
  });
});

// ─── Each edit on its own ───────────────────────────────────────────────────────────────────────

describe("1. five comment lines above Runner.dispatch", () => {
  let r: Awaited<ReturnType<typeof regenerate>>;
  beforeAll(async () => {
    r = await regenerate(base, [edits.commentAboveDispatch]);
  });

  it("moves every anchor inside dispatch by five lines; spans and text are unchanged", () => {
    const before = readJson(base, EXPLAINER_PATH);
    const inside: [string, number][] = [
      [DISPATCH, 0], // whole symbol
      ["dispatch:1", 0], // the pop() call site
      ["dispatch:2", 0], // the run(job) call site
      ["dispatch:3", 0], // the requeue call site
      ["concept:retry-policy", 0], // the retry block
      ["concept:retry-tuning", 0], // the user's concept on the same block
      ["concept:dead-letter", 0],
    ];
    for (const [id, at] of inside) {
      const was = anchorsOf(before, id)[at]!;
      const now = anchorsOf(r.explainer, id)[at]!;
      expect(now.resolved!.status, id).toBe("moved");
      expect(now.resolved!.range, id).toEqual({
        startLine: was.resolved!.range.startLine + 5,
        endLine: was.resolved!.range.endLine + 5,
      });
      expect(now.span, `${id}: symbol-relative span is unchanged`).toEqual(was.span);
      expect(now.hash, `${id}: same text`).toBe(was.hash);
    }
    expect(r.resolve.counts).toEqual({ ok: 9, moved: 7, drifted: 0, missing: 0 });
    checkResolvedCache(r.dir, r.explainer);
  });

  it("leaves nothing to re-explain, nothing missing, and validates strictly", async () => {
    expect(r.resolve).toMatchObject({ drifted: [], driftedOther: [], missing: [], written: true });
    expect(r.resolve.index.commit).toBe(r.commit);
    expect((await xpl(r.dir, "validate", NAME)).code).toBe(0);
    const { json } = await xplJson<any>(r.dir, "status", NAME);
    expect(json.todo).toMatchObject({ drifted: 0, missing: 0 });
  });

  it("settles: resolving again reports no move", async () => {
    const again = await xplJson<any>(r.dir, "resolve", NAME);
    expect(again.json.counts).toEqual({ ok: 16, moved: 0, drifted: 0, missing: 0 });
  });

  it("also holds for a doc comment directly above the method", async () => {
    const doc = await regenerate(base, [
      (dir) =>
        replaceOnce(
          dir,
          "src/runner.ts",
          "  async dispatch(): Promise<void> {\n",
          "  /**\n   * The dispatch loop.\n   *\n   * @returns once the loop has been stopped\n   */\n  async dispatch(): Promise<void> {\n",
        ),
    ]);
    expect(doc.resolve.counts).toEqual({ ok: 9, moved: 7, drifted: 0, missing: 0 });
    expect(statusesOf(doc.explainer, DISPATCH)).toEqual(["moved"]);
  });
});

describe("2. a blank line inside the retry block", () => {
  it("re-finds the block by content: moved with an updated span, not drifted", async () => {
    const r = await regenerate(base, [edits.blankLineInRetryBlock]);
    const before = readJson(base, EXPLAINER_PATH);
    const block = anchorsOf(r.explainer, "concept:retry-policy")[0]!;
    expect(block.resolved).toEqual({
      commit: r.commit,
      status: "moved",
      range: { startLine: 72, endLine: 84 },
    });
    expect(block.span, "the 12 lines of the block are 13 with the blank one").toEqual({
      from: 30,
      to: 42,
    });
    expect(block.hash, "blank lines do not count: same text").toBe(
      anchorsOf(before, "concept:retry-policy")[0]!.hash,
    );
    // the user's concept anchors the same block and moves the same way
    expect(anchorsOf(r.explainer, "concept:retry-tuning")[0]).toMatchObject({
      span: { from: 30, to: 42 },
      resolved: { status: "moved" },
    });
    // the requeue call and the dead-letter branch sit one line lower
    expect(anchorsOf(r.explainer, "dispatch:3")[0]).toMatchObject({
      span: { from: 35, to: 37 },
      resolved: { status: "moved", range: { startLine: 77, endLine: 79 } },
    });
    expect(anchorsOf(r.explainer, "concept:dead-letter")[0]).toMatchObject({
      span: { from: 38, to: 42 },
      resolved: { status: "moved", range: { startLine: 80, endLine: 84 } },
    });
    // above the blank line nothing moved
    expect(statusesOf(r.explainer, "dispatch:1")).toEqual(["ok", "ok"]);
    expect(statusesOf(r.explainer, "dispatch:2")).toEqual(["ok", "ok"]);
    expect(r.resolve.counts).toEqual({ ok: 11, moved: 5, drifted: 0, missing: 0 });
    expect(r.resolve).toMatchObject({ drifted: [], driftedOther: [], missing: [] });
    checkResolvedCache(r.dir, r.explainer);
    expect((await xpl(r.dir, "validate", NAME)).code).toBe(0);
  });

  it("does not hide a real change: when the block's text changes too, it drifts", async () => {
    // the blank line only moves what is unchanged: the rename inside the same block still drifts it
    const r = await regenerate(base, [edits.blankLineInRetryBlock, edits.renameBackoff]);
    expect(statusesOf(r.explainer, "concept:retry-policy")).toEqual(["drifted", "ok", "ok"]);
    expect(statusesOf(r.explainer, "dispatch:3")).toEqual(["drifted", "ok"]);
    // the dead-letter branch is after the renamed lines: same text, one line lower
    expect(anchorsOf(r.explainer, "concept:dead-letter")[0]).toMatchObject({
      span: { from: 38, to: 42 },
      resolved: { status: "moved" },
    });
    expect((r.resolve.drifted as any[]).map((d) => d.elementId)).toEqual([
      DISPATCH,
      "concept:retry-policy",
      "dispatch:3",
    ]);
    checkResolvedCache(r.dir, r.explainer);
  });

  it("inside a span that itself contains the blank line: the dead-letter branch grows by one line", async () => {
    const r = await regenerate(base, [edits.blankLineInDeadLetterBranch]);
    expect(anchorsOf(r.explainer, "concept:dead-letter")[0]).toMatchObject({
      span: { from: 37, to: 42 },
      resolved: { status: "moved", range: { startLine: 79, endLine: 84 } },
    });
    expect(anchorsOf(r.explainer, "concept:retry-policy")[0]).toMatchObject({
      span: { from: 30, to: 42 },
      resolved: { status: "moved" },
    });
    // the requeue call is above the blank line
    expect(statusesOf(r.explainer, "dispatch:3")).toEqual(["ok", "ok"]);
    expect(r.resolve.counts).toEqual({ ok: 12, moved: 4, drifted: 0, missing: 0 });
    checkResolvedCache(r.dir, r.explainer);
  });
});

describe("3. backoff is renamed to delay in the requeue call and its declaration", () => {
  let r: Awaited<ReturnType<typeof regenerate>>;
  beforeAll(async () => {
    r = await regenerate(base, [edits.renameBackoff]);
  });

  it("drifts dispatch:3's call site (and the other anchors that cover the lines), nothing else", () => {
    const before = readJson(base, EXPLAINER_PATH);
    const callSite = anchorsOf(r.explainer, "dispatch:3")[0]!;
    expect(callSite.resolved).toEqual({
      commit: r.commit,
      status: "drifted",
      range: { startLine: 76, endLine: 78 }, // nothing shifted, so the span still names the lines
    });
    expect(callSite.hash, "a drifted anchor keeps its hash until re-explained").toBe(
      anchorsOf(before, "dispatch:3")[0]!.hash,
    );
    expect(statusesOf(r.explainer, "dispatch:3")).toEqual(["drifted", "ok"]); // the definition is fine
    expect(statusesOf(r.explainer, "concept:retry-policy")).toEqual(["drifted", "ok", "ok"]);
    expect(statusesOf(r.explainer, DISPATCH)).toEqual(["drifted"]);
    expect(statusesOf(r.explainer, "concept:dead-letter")).toEqual(["ok"]); // after the renamed lines
    expect(r.resolve.counts).toEqual({ ok: 12, moved: 0, drifted: 4, missing: 0 });
    checkResolvedCache(r.dir, r.explainer);
  });

  it("lists dispatch:3 under the drifted llm elements; the user's concept is reported but not to re-explain", () => {
    const drifted = r.resolve.drifted as any[];
    expect(drifted.map((d) => [d.elementId, d.owner, d.userFields])).toEqual([
      [DISPATCH, "node", ["summary"]],
      ["concept:retry-policy", "concept", []],
      ["dispatch:3", "step", []],
    ]);
    const step = drifted.find((d) => d.elementId === "dispatch:3");
    expect(step.anchors).toHaveLength(1);
    expect(step.anchors[0]).toMatchObject({
      path: "views[1].steps[2].anchors[0]",
      anchor: {
        file: "src/runner.ts",
        symbol: "Runner.dispatch",
        span: { from: 34, to: 36 },
        role: "call-site",
      },
      range: { startLine: 76, endLine: 78 },
      approximate: true, // a drifted span: the lines are only where the span was
    });
    expect(step.anchors[0].reason).toContain("changed and was not found elsewhere");
    // a whole-symbol anchor is found by its path: its range is exact
    const overlay = drifted.find((d) => d.elementId === DISPATCH);
    expect(overlay.anchors[0].range).toEqual({ startLine: 42, endLine: 88 });
    expect(overlay.anchors[0]).not.toHaveProperty("approximate");
    expect(drifted.map((d) => d.elementId)).not.toContain("concept:retry-tuning");
    expect(r.resolve.driftedOther).toEqual([
      { elementId: "concept:retry-tuning", origin: "user", paths: ["concepts[1].anchors[0]"] },
    ]);
    expect(r.resolve.missing).toEqual([]);
  });

  it("prints both lists in the text report", async () => {
    const text = await xpl(r.dir, "resolve", NAME);
    expect(text.out).toContain("anchors: 16 (ok 12, moved 0, drifted 4, missing 0)");
    expect(text.out).toContain("drifted llm elements to re-explain (3):");
    expect(text.out).toContain(`  ${DISPATCH}  (node)  [keep userFields: summary]`);
    expect(text.out).toContain("  dispatch:3  (step in view:dispatch)");
    expect(text.out).toContain("drifted, but not llm-owned (left alone) (1):");
    expect(text.out).toContain("  concept:retry-tuning  (origin user)  concepts[1].anchors[0]");
  });

  it("flags the lines of a drifted span as approximate, and not the lines of a drifted symbol", async () => {
    const text = await xpl(r.dir, "resolve", NAME);
    const line = (needle: string) => text.out.split("\n").find((l) => l.includes(needle))!;
    expect(line("views[1].steps[2].anchors[0]")).toContain(
      "now at lines 76-78 (approximate: where the span was; the changed code may have shifted, so re-read it)",
    );
    expect(line("concepts[0].anchors[0]")).toContain(
      "+30..41 [definition]  now at lines 72-83 (approximate",
    );
    expect(line("nodes[1].anchors[0]")).toMatch(/now at lines 42-88$/); // the whole symbol: exact
  });

  it("strict validate says who can repair each drifted anchor: Claude for its own, the user for theirs", async () => {
    const strict = await xplJson<any>(r.dir, "validate", NAME);
    expect(strict.code).toBe(1);
    const messages = new Map<string, string>(
      strict.json.issues.map((i: any) => [i.elementId, i.message]),
    );
    expect([...messages.keys()]).toEqual([
      DISPATCH,
      "concept:retry-policy",
      "concept:retry-tuning",
      "dispatch:3",
    ]);
    for (const id of [DISPATCH, "concept:retry-policy", "dispatch:3"]) {
      expect(messages.get(id), id).toContain("Re-read the code and rewrite the anchor");
      expect(messages.get(id), id).not.toContain("--actor user");
    }
    expect(
      strict.json.issues.filter((i: any) => i.userLocked).map((i: any) => i.elementId),
      "only what the user owns is flagged as beyond an llm patch",
    ).toEqual(["concept:retry-tuning"]);
    const user = messages.get("concept:retry-tuning")!;
    expect(user).toContain("This element is user-authored, so an llm patch cannot change it");
    expect(user).toContain("tell the user, or fix it with `xpl apply --actor user`");
    expect(user).not.toContain("Re-read the code and rewrite the anchor");
  });

  it("re-sending the stored steps as they are is rejected as stale; rebuilding the one anchor is accepted", async () => {
    const dir = cloneDir(r.dir);
    const stored = readJson(dir, EXPLAINER_PATH).views.find((v: any) => v.id === "view:dispatch");

    // the skill's recipe (patch-format.md, "Repairing after code changes"): copy the steps out...
    const steps = structuredClone(stored.steps) as any[];
    steps[2].summary = "Failed job goes back on the queue after the computed delay.";
    // ...but the drifted anchor still carries its old hash: the draft is stale, the patch is refused
    const stale = await applyPatch(
      dir,
      { views: [{ id: "view:dispatch", type: "sequence", steps }] },
      "llm",
    );
    expect(stale.code).toBe(1);
    expect(stale.json.applied).toBe(false);
    const issue = stale.json.issues.find((i) => i.severity === "error")!;
    expect(issue).toMatchObject({
      path: "views[0].steps[2].anchors[0]",
      elementId: "dispatch:3",
      code: "anchor-invalid",
    });
    expect(issue.message).toContain("stale anchor for src/runner.ts#Runner.dispatch +34..36");
    expect(issue.message).toContain("re-read it and rebuild the anchor");
    expect(readJson(dir, EXPLAINER_PATH).views[1].steps[2].summary).toBeUndefined();

    // rebuilt from the text (find), the unchanged steps left as they were: accepted
    steps[2].anchors[0] = {
      file: "src/runner.ts",
      symbol: "Runner.dispatch",
      find: "await this.queue.requeue(\n          job,\n          delay);",
      role: "call-site",
    };
    const fixed = await applyOk(
      dir,
      { views: [{ id: "view:dispatch", type: "sequence", steps }] },
      "llm",
    );
    expect(fixed.json.changed).toEqual(["view:dispatch"]);
    const explainer = readJson(dir, EXPLAINER_PATH);
    expect(statusesOf(explainer, "dispatch:3")).toEqual(["ok", "ok"]);
    expect(anchorsOf(explainer, "dispatch:3")[0]).toMatchObject({
      span: { from: 34, to: 36 },
      resolved: { status: "ok", range: { startLine: 76, endLine: 78 } },
    });
    checkResolvedCache(dir, explainer);
    // the step is no longer to re-explain; the overlay and the retry concept still are
    const { json } = await xplJson<any>(dir, "resolve", NAME);
    expect(json.drifted.map((d: any) => d.elementId)).toEqual([DISPATCH, "concept:retry-policy"]);
  });
});

describe("4. Queue.ack and its call are deleted", () => {
  let r: Awaited<ReturnType<typeof regenerate>>;
  beforeAll(async () => {
    r = await regenerate(base, [edits.deleteAck]);
  });

  it("marks the Queue.ack concept's anchor missing and lists it with the reason", () => {
    expect(r.resolve.missing).toHaveLength(1);
    expect(r.resolve.missing[0]).toMatchObject({
      elementId: "concept:ack-semantics",
      owner: "concept",
      origin: "llm",
      path: "concepts[2].anchors[0]",
      anchor: { file: "src/queue.ts", symbol: "Queue.ack", role: "definition" },
    });
    expect(r.resolve.missing[0].reason).toContain("symbol Queue.ack is not in src/queue.ts");
    expect(statusesOf(r.explainer, "concept:ack-semantics")).toEqual(["missing"]);
  });

  it("drops nothing from the explainer file: the concept and its anchor stay, with the last known range", () => {
    const before = readJson(base, EXPLAINER_PATH);
    expect(anchorInventory(r.explainer)).toEqual(anchorInventory(before));
    expect(r.explainer.concepts.map((c: any) => c.id)).toEqual(
      before.concepts.map((c: any) => c.id),
    );
    const was = anchorsOf(before, "concept:ack-semantics")[0]!;
    expect(anchorsOf(r.explainer, "concept:ack-semantics")[0]).toMatchObject({
      file: "src/queue.ts",
      symbol: "Queue.ack",
      hash: was.hash,
      resolved: { status: "missing", range: was.resolved!.range },
    });
    // a missing anchor is not drift: it is never in the list of elements to re-explain
    expect((r.resolve.drifted as any[]).map((d) => d.elementId)).toEqual([DISPATCH]);
  });

  it("removing the call drifts the dispatch overlay and shifts what sits below it", () => {
    expect(statusesOf(r.explainer, DISPATCH)).toEqual(["drifted"]);
    expect(statusesOf(r.explainer, "dispatch:2")).toEqual(["ok", "ok"]);
    for (const id of ["dispatch:3", "concept:retry-policy", "concept:retry-tuning"]) {
      expect(statusesOf(r.explainer, id)[0], id).toBe("moved");
    }
    expect(anchorsOf(r.explainer, "dispatch:3")[0]).toMatchObject({
      span: { from: 33, to: 35 },
      resolved: { range: { startLine: 75, endLine: 77 } },
    });
    expect(r.resolve.counts).toEqual({ ok: 10, moved: 4, drifted: 1, missing: 1 });
    checkResolvedCache(r.dir, r.explainer);
  });

  it("stays reported until it is fixed; strict validate fails, lenient validate warns", async () => {
    const again = await xplJson<any>(r.dir, "resolve", NAME);
    expect(again.json.missing.map((m: any) => m.elementId)).toEqual(["concept:ack-semantics"]);
    const status = await xplJson<any>(r.dir, "status", NAME);
    expect(status.json.missing).toHaveLength(1);
    const strict = await xplJson<any>(r.dir, "validate", NAME);
    expect(strict.code).toBe(1);
    expect(
      strict.json.issues.filter((i: any) => i.code === "anchor-missing").map((i: any) => i.path),
    ).toEqual(["concepts[2].anchors[0]"]);
    const lenient = await xplJson<any>(r.dir, "validate", NAME, "--lenient");
    expect(lenient.code).toBe(0);
    expect(lenient.json.errors).toBe(0);
    // the message says what is gone, what it might be, and what to do about it
    const message = lenient.json.issues.find((i: any) => i.code === "anchor-missing").message;
    // (candidates are spelled as ids and as anchor fields; the test double comes last)
    expect(message).toBe(
      "anchor src/queue.ts#Queue.ack is missing: symbol Queue.ack is not in src/queue.ts; did you mean " +
        'sym:src/queue.ts#Queue.acked (anchor: file: "src/queue.ts", symbol: "Queue.acked"), ' +
        'sym:test/retry.test.ts#RecordingQueue.ack (anchor: file: "test/retry.test.ts", symbol: "RecordingQueue.ack")? ' +
        "Re-anchor it to where the code went, or drop it (resend the element without this anchor, or remove the element).",
    );
  });

  it("an llm patch can drop the anchor explicitly; nothing is missing afterwards", async () => {
    const dir = cloneDir(r.dir);
    const patched = await applyOk(
      dir,
      { concepts: [{ id: "concept:ack-semantics", anchors: [] }] },
      "llm",
    );
    expect(patched.json.changed).toEqual(["concept:ack-semantics"]);
    const { json } = await xplJson<any>(dir, "resolve", NAME);
    expect(json.missing).toEqual([]);
    expect(json.counts.missing).toBe(0);
  });
});

describe("5. the README paragraph moves down", () => {
  it("re-finds the file-relative span by content: moved, span updated, nothing to re-explain", async () => {
    const r = await regenerate(base, [edits.moveReadmeParagraph]);
    const anchor = anchorsOf(r.explainer, "concept:how-it-works")[0]!;
    expect(anchor.symbol).toBeUndefined();
    expect(anchor).toMatchObject({
      file: "README.md",
      span: { from: 26, to: 29 },
      resolved: { status: "moved", range: { startLine: 27, endLine: 30 } },
    });
    expect(anchor.hash).toBe(
      anchorsOf(readJson(base, EXPLAINER_PATH), "concept:how-it-works")[0]!.hash,
    );
    expect(r.resolve.counts).toEqual({ ok: 15, moved: 1, drifted: 0, missing: 0 });
    expect(r.resolve).toMatchObject({ drifted: [], driftedOther: [], missing: [] });
    checkResolvedCache(r.dir, r.explainer);
    expect((await xpl(r.dir, "validate", NAME)).code).toBe(0);
  });

  it("keeps following the paragraph over a second regeneration round", async () => {
    const first = await regenerate(base, [edits.moveReadmeParagraph]);
    // the explainer of round one is the base of round two
    const second = await regenerate(
      first.dir,
      [
        (dir) =>
          replaceOnce(dir, "README.md", "## Design notes\n", "Intro line.\n\n## Design notes\n"),
      ],
      "more readme",
    );
    expect(anchorsOf(second.explainer, "concept:how-it-works")[0]).toMatchObject({
      span: { from: 28, to: 31 },
      resolved: { status: "moved", range: { startLine: 29, endLine: 32 } },
    });
    const text = readFile(second.dir, "README.md").split("\n");
    expect(text[28]).toContain("`Runner.dispatch` loops");
    checkResolvedCache(second.dir, second.explainer);
  });
});

// ─── Other edits a regeneration meets ───────────────────────────────────────────────────────────

describe("other edits", () => {
  it("formatting only (CRLF, re-indenting, trailing spaces) changes nothing: not even a move", async () => {
    const r = await regenerate(base, [
      (dir) =>
        writeFile(dir, "src/runner.ts", readFile(dir, "src/runner.ts").replace(/\n/g, "\r\n")),
      (dir) =>
        writeFile(
          dir,
          "src/queue.ts",
          readFile(dir, "src/queue.ts")
            .split("\n")
            .map((line) => (line.trim() === "" ? line : `  ${line}`))
            .join("\n"),
        ),
      (dir) =>
        writeFile(
          dir,
          "README.md",
          readFile(dir, "README.md")
            .split("\n")
            .map((line) => (line.trim() === "" ? line : `${line}   `))
            .join("\n"),
        ),
    ]);
    expect(r.resolve.counts).toEqual({ ok: 16, moved: 0, drifted: 0, missing: 0 });
    expect(r.resolve).toMatchObject({ drifted: [], driftedOther: [], missing: [] });
    checkResolvedCache(r.dir, r.explainer);
  });

  it("reverting an edit heals the drift by itself: hashes are kept, so the old text is ok again", async () => {
    const edited = await regenerate(base, [edits.renameBackoff]);
    expect(edited.resolve.counts.drifted).toBe(4);
    const reverted = await regenerate(
      edited.dir,
      [
        (dir) =>
          replaceOnce(
            dir,
            "src/runner.ts",
            "        const delay = backoffDelay(attempts, this.config.retry);\n        await this.queue.requeue(\n          job,\n          delay);\n",
            "        const backoff = backoffDelay(attempts, this.config.retry);\n        await this.queue.requeue(\n          job,\n          backoff);\n",
          ),
      ],
      "revert",
    );
    expect(reverted.resolve.counts).toEqual({ ok: 16, moved: 0, drifted: 0, missing: 0 });
    expect(statusesOf(reverted.explainer, "dispatch:3")).toEqual(["ok", "ok"]);
    const { json } = await xplJson<any>(reverted.dir, "status", NAME);
    expect(json.todo).toMatchObject({ drifted: 0, missing: 0 });
  });

  it("in a fresh clone the old index is absent (it is gitignored): the flow is the same once indexed", async () => {
    const parent = makeTempDir("xpl-clone-");
    git(parent, "clone", "-q", base, "repo");
    const clone = join(parent, "repo");
    expect(existsSync(join(clone, readJson(clone, EXPLAINER_PATH).index.path))).toBe(false);
    const early = await xpl(clone, "status", NAME);
    expect(early.code).toBe(1);
    expect(early.err).toContain("no symbol index found");
    expect(early.err).toContain("Run `xpl index` first");

    const r = await regenerate(clone, [edits.renameBackoff]);
    expect(r.resolve.counts).toEqual({ ok: 12, moved: 0, drifted: 4, missing: 0 });
    expect((r.resolve.drifted as any[]).map((d) => d.elementId)).toEqual([
      DISPATCH,
      "concept:retry-policy",
      "dispatch:3",
    ]);
    expect(r.explainer.index.path).toBe(r.index.path);
    checkResolvedCache(r.dir, r.explainer);
  });

  it("a file that moved: its anchors are missing, and the reason names the new path", async () => {
    const r = await regenerate(base, [
      (dir) => {
        mkdirSync(join(dir, "src", "jobs"));
        renameSync(join(dir, "src", "queue.ts"), join(dir, "src", "jobs", "queue.ts"));
      },
    ]);
    const missing = r.resolve.missing as any[];
    expect(missing.map((m) => [m.elementId, m.anchor.symbol])).toEqual([
      ["concept:ack-semantics", "Queue.ack"],
      ["dispatch:1", "Queue.pop"],
      ["dispatch:3", "Queue.requeue"],
    ]);
    for (const m of missing) {
      expect(m.reason, m.elementId).toBe(
        "file src/queue.ts is not in the index; did you mean src/jobs/queue.ts?",
      );
    }
    expect(r.resolve.counts).toEqual({ ok: 13, moved: 0, drifted: 0, missing: 3 });
    // still there, still addressed to the old file: the anchors were not dropped or guessed at
    expect(anchorsOf(r.explainer, "dispatch:1")[1]).toMatchObject({
      file: "src/queue.ts",
      symbol: "Queue.pop",
      resolved: { status: "missing" },
    });
  });
});

// ─── Tours ──────────────────────────────────────────────────────────────────────────────────────

describe("a tour step with a code override", () => {
  const overrideStep = (find: string) => ({
    id: "t1",
    view: "view:dispatch",
    focus: ["dispatch:3"],
    note: "Where a failed job goes.",
    code: [{ file: "src/runner.ts", symbol: "Runner.dispatch", find, role: "call-site" }],
  });

  it("drifts like any llm anchor, is listed with its tour step id, and resending the tour repairs it", async () => {
    const dir = cloneDir(base);
    await applyOk(
      dir,
      {
        tours: [
          {
            id: "tour:retry",
            title: "Retries",
            steps: [overrideStep("await this.queue.requeue(\n          job,\n          backoff);")],
          },
        ],
      },
      "llm",
    );
    commit(dir, "a tour with a code override");
    const r = await regenerate(dir, [edits.renameBackoff]);

    const listed = (r.resolve.drifted as any[]).find((d) => d.elementId === "tour:retry/t1");
    expect(listed).toMatchObject({ owner: "tour-step", userFields: [] });
    expect(listed.anchors[0]).toMatchObject({
      path: "tours[1].steps[0].code[0]",
      approximate: true,
    });
    const { json } = await xplJson<any>(r.dir, "status", NAME);
    expect(json.drifted.map((d: any) => d.elementId)).toContain("tour:retry/t1");

    // the tour's steps are sent whole; the rebuilt anchor is ok again
    const repaired = await applyOk(
      r.dir,
      {
        tours: [
          {
            id: "tour:retry",
            steps: [overrideStep("await this.queue.requeue(\n          job,\n          delay);")],
          },
        ],
      },
      "llm",
    );
    expect(repaired.json.changed).toEqual(["tour:retry"]);
    const after = await xplJson<any>(r.dir, "resolve", NAME);
    expect(after.json.drifted.map((d: any) => d.elementId)).not.toContain("tour:retry/t1");
    expect(readJson(r.dir, EXPLAINER_PATH).tours[1].steps[0].code[0]).toMatchObject({
      resolved: { status: "ok", range: { startLine: 76, endLine: 78 } },
    });
  });
});

// ─── What the user edited on an llm element stays theirs ────────────────────────────────────────

describe("drift under fields the user edited (userFields)", () => {
  it("anchors: still to re-explain, but an llm patch keeps them, and validate says only the user can", async () => {
    const dir = cloneDir(base);
    // the user re-anchors the llm's retry concept by hand: `anchors` joins its userFields
    await applyOk(
      dir,
      {
        concepts: [
          {
            id: "concept:retry-policy",
            anchors: [
              {
                file: "src/runner.ts",
                symbol: "Runner.dispatch",
                span: { from: 30, to: 41 },
                role: "definition",
              },
            ],
          },
        ],
      },
      "user",
    );
    const concept = () =>
      readJson(dir, EXPLAINER_PATH).concepts.find((c: any) => c.id === "concept:retry-policy");
    expect(concept().provenance).toMatchObject({ origin: "llm", userFields: ["anchors"] });
    commit(dir, "the user edits the explainer");
    const r = await regenerate(dir, [edits.renameBackoff]);

    const listed = (r.resolve.drifted as any[]).find((d) => d.elementId === "concept:retry-policy");
    expect(listed.userFields).toEqual(["anchors"]);
    const strict = await xplJson<any>(r.dir, "validate", NAME);
    const message = strict.json.issues.find((i: any) => i.elementId === "concept:retry-policy")
      .message as string;
    expect(message).toContain(
      "This element has its anchors edited by the user, so an llm patch cannot change it",
    );

    // Claude may still re-explain the summary; its anchors are kept as they were, and it is told so
    const attempt = await applyOk(
      r.dir,
      {
        concepts: [
          {
            id: "concept:retry-policy",
            summary: "Requeued after the computed delay.",
            anchors: [
              {
                file: "src/runner.ts",
                symbol: "Runner.dispatch",
                span: { from: 33, to: 36 },
                role: "definition",
              },
            ],
          },
        ],
      },
      "llm",
    );
    expect(attempt.json.changed).toEqual(["concept:retry-policy"]);
    expect(
      attempt.json.issues.find((i) => i.code === "protected"),
      "the warning names the field it kept",
    ).toMatchObject({
      severity: "warning",
      path: "concepts[0].anchors",
      elementId: "concept:retry-policy",
    });
    // the drift it cannot repair is reported, as a warning: it must not block the re-explanation
    expect(attempt.json.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(attempt.json.issues.find((i) => i.code === "anchor-drifted")).toMatchObject({
      severity: "warning",
      path: "concepts[0].anchors[0]",
      elementId: "concept:retry-policy",
      userLocked: true,
    });
    expect(
      readJson(r.dir, EXPLAINER_PATH).concepts.find((c: any) => c.id === "concept:retry-policy")
        .summary,
    ).toBe("Requeued after the computed delay.");
    expect(statusesOf(readJson(r.dir, EXPLAINER_PATH), "concept:retry-policy")).toEqual([
      "drifted",
    ]);
    // the user repairs it themselves
    await applyOk(
      r.dir,
      {
        concepts: [
          {
            id: "concept:retry-policy",
            anchors: [
              {
                file: "src/runner.ts",
                symbol: "Runner.dispatch",
                span: { from: 30, to: 41 },
                role: "definition",
              },
            ],
          },
        ],
      },
      "user",
    );
    expect(statusesOf(readJson(r.dir, EXPLAINER_PATH), "concept:retry-policy")).toEqual(["ok"]);
  });

  it("steps: one edited step summary locks the whole view against llm re-anchoring", async () => {
    const dir = cloneDir(base);
    const steps = readJson(dir, EXPLAINER_PATH).views[1].steps as any[];
    steps[1].summary = "Mine: hand the job to the leased worker.";
    await applyOk(dir, { views: [{ id: "view:dispatch", type: "sequence", steps }] }, "user");
    expect(readJson(dir, EXPLAINER_PATH).views[1].provenance).toMatchObject({
      origin: "llm",
      userFields: ["steps"],
    });
    commit(dir, "the user edits a step");
    const r = await regenerate(dir, [edits.renameBackoff]);

    const step = (r.resolve.drifted as any[]).find((d) => d.elementId === "dispatch:3");
    expect(step.userFields, "the report says what to keep").toEqual(["steps"]);
    const strict = await xplJson<any>(r.dir, "validate", NAME);
    expect(strict.json.issues.find((i: any) => i.elementId === "dispatch:3").message).toContain(
      "This element has its steps edited by the user, so an llm patch cannot change it",
    );

    // resending the steps does nothing but warn: dispatch:3 stays drifted until the user acts. The patch
    // changes nothing because the user owns it, so apply says so with exit 1 instead of "applied"
    const fixed = structuredClone(readJson(r.dir, EXPLAINER_PATH).views[1].steps) as any[];
    fixed[2].anchors[0] = {
      file: "src/runner.ts",
      symbol: "Runner.dispatch",
      find: "await this.queue.requeue(\n          job,\n          delay);",
      role: "call-site",
    };
    const attempt = await applyPatch(
      r.dir,
      { views: [{ id: "view:dispatch", type: "sequence", steps: fixed }] },
      "llm",
    );
    expect(attempt.code).toBe(1);
    expect(attempt.json).toMatchObject({
      ok: false,
      applied: false,
      protectedIds: ["view:dispatch"],
    });
    expect(attempt.json.changed).toEqual([]);
    expect(attempt.json.issues.find((i) => i.code === "protected")).toMatchObject({
      path: "views[0].steps",
      elementId: "view:dispatch",
    });
    expect(statusesOf(readJson(r.dir, EXPLAINER_PATH), "dispatch:3")).toEqual(["drifted", "ok"]);
    await applyOk(
      r.dir,
      { views: [{ id: "view:dispatch", type: "sequence", steps: fixed }] },
      "user",
    );
    expect(statusesOf(readJson(r.dir, EXPLAINER_PATH), "dispatch:3")).toEqual(["ok", "ok"]);
  });
});

// ─── All five in one commit ─────────────────────────────────────────────────────────────────────

describe("all five edits in one second commit", () => {
  let dir: string;
  let after: Awaited<ReturnType<typeof regenerate>>;
  let before: any;

  beforeAll(async () => {
    before = readJson(base, EXPLAINER_PATH);
    // edit 2 goes into the dead-letter branch: edit 3 rewrites the lines of the requeue call, so the
    // whole retry block is legitimately drifted here; the branch is what the blank line can move
    after = await regenerate(
      base,
      [
        edits.commentAboveDispatch,
        edits.blankLineInDeadLetterBranch,
        edits.renameBackoff,
        edits.deleteAck,
        edits.moveReadmeParagraph,
      ],
      "second commit: five edits",
    );
    dir = after.dir;
  });

  it("xpl index says which explainer to move to the new index", () => {
    expect(after.index.explainersToResolve).toEqual([NAME]);
    expect(after.explainer.index).toEqual({
      path: after.index.path,
      commit: after.commit,
    });
    expect(after.explainer.repo.commit).toBe(after.commit);
    // the explainer is bound to the new index only once resolve --write ran
    expect(before.index.commit).not.toBe(after.commit);
  });

  it("1. the anchors of the comment-shifted dispatch are moved: spans unchanged, text unchanged", () => {
    for (const [id, span, range] of [
      ["dispatch:1", { from: 4, to: 4 }, { startLine: 51, endLine: 51 }],
      ["dispatch:2", { from: 18, to: 19 }, { startLine: 65, endLine: 66 }],
    ] as const) {
      const was = anchorsOf(before, id)[0]!;
      const now = anchorsOf(after.explainer, id)[0]!;
      expect(now.span, id).toEqual(span);
      expect(now.span, id).toEqual(was.span);
      expect(now.hash, id).toBe(was.hash);
      expect(now.resolved, id).toEqual({ commit: after.commit, status: "moved", range });
    }
  });

  it("2. the blank line moved the dead-letter branch (updated span), it did not drift it", () => {
    const now = anchorsOf(after.explainer, "concept:dead-letter")[0]!;
    // -1 for the deleted call above it, +1 line inside it
    expect(now.span).toEqual({ from: 36, to: 41 });
    expect(now.resolved).toEqual({
      commit: after.commit,
      status: "moved",
      range: { startLine: 83, endLine: 88 },
    });
    expect(now.hash).toBe(anchorsOf(before, "concept:dead-letter")[0]!.hash);
  });

  it("3. dispatch:3's call site drifted; the report lists it, the user's concept is not to re-explain", () => {
    expect(statusesOf(after.explainer, "dispatch:3")).toEqual(["drifted", "ok"]);
    const drifted = after.resolve.drifted as any[];
    expect(drifted.map((d) => d.elementId)).toEqual([
      DISPATCH,
      "concept:retry-policy",
      "dispatch:3",
    ]);
    expect(drifted.find((d) => d.elementId === DISPATCH).userFields).toEqual(["summary"]);
    expect(after.resolve.driftedOther).toEqual([
      { elementId: "concept:retry-tuning", origin: "user", paths: ["concepts[1].anchors[0]"] },
    ]);
    expect(statusesOf(after.explainer, "concept:retry-tuning")).toEqual(["drifted"]);
  });

  it("4. the Queue.ack anchor is missing and listed; nothing was dropped", () => {
    expect(statusesOf(after.explainer, "concept:ack-semantics")).toEqual(["missing"]);
    expect(after.resolve.missing).toHaveLength(1);
    expect(after.resolve.missing[0]).toMatchObject({
      elementId: "concept:ack-semantics",
      anchor: { file: "src/queue.ts", symbol: "Queue.ack" },
    });
    expect(anchorInventory(after.explainer)).toEqual(anchorInventory(before));
  });

  it("5. the README paragraph is moved (updated file-relative span)", () => {
    expect(anchorsOf(after.explainer, "concept:how-it-works")[0]).toMatchObject({
      span: { from: 26, to: 29 },
      resolved: { status: "moved", range: { startLine: 27, endLine: 30 } },
    });
  });

  it("counts every anchor once and every written cache agrees with the text", () => {
    expect(after.resolve.counts).toEqual({ ok: 7, moved: 4, drifted: 4, missing: 1 });
    expect(after.resolve.total).toBe(16);
    expect(statusCounts(after.explainer)).toEqual(after.resolve.counts);
    checkResolvedCache(dir, after.explainer);
  });

  it("xpl status lists exactly the drifted llm elements and the missing anchors", async () => {
    const { json } = await xplJson<any>(dir, "status", NAME);
    expect(json.drifted.map((d: any) => d.elementId)).toEqual([
      DISPATCH,
      "concept:retry-policy",
      "dispatch:3",
    ]);
    expect(json.missing.map((m: any) => m.elementId)).toEqual(["concept:ack-semantics"]);
    expect(json.driftedOther.map((d: any) => d.elementId)).toEqual(["concept:retry-tuning"]);
    // 3 llm elements to re-explain, plus the user's concept: counted, but apart (ask the user)
    expect(json.todo).toMatchObject({ drifted: 4, driftedUserOwned: 1, missing: 1, requests: 0 });
    expect(json.anchors.counts).toEqual({ ok: 11, moved: 0, drifted: 4, missing: 1 });

    const text = await xpl(dir, "status", NAME);
    expect(text.code).toBe(0);
    expect(text.out).toMatch(
      /^to do: \d+ unexplained, 4 drifted \(1 user-owned: ask the user\), 1 missing anchors, 0 requests$/m,
    );
    const section = (from: string, to?: string) => {
      const start = text.out.indexOf(from);
      expect(start, from).toBeGreaterThan(-1);
      const end = to === undefined ? text.out.length : text.out.indexOf(to, start);
      return text.out.slice(start, end);
    };
    const llm = section("drifted llm elements to re-explain (3):", "drifted, but not llm-owned");
    for (const id of [DISPATCH, "concept:retry-policy", "dispatch:3"]) expect(llm).toContain(id);
    expect(llm).not.toContain("concept:retry-tuning");
    expect(llm).not.toContain("concept:ack-semantics");
    const other = section("drifted, but not llm-owned (left alone) (1):", "missing anchors (1)");
    expect(other).toContain("concept:retry-tuning");
    const missing = section("missing anchors (1):");
    expect(missing).toContain("concept:ack-semantics");
    expect(missing).toContain("src/queue.ts#Queue.ack [definition]");
    expect(missing).toContain("symbol Queue.ack is not in src/queue.ts");
  });

  it("prints the drifted call site's lines as approximate: the deleted ack call moved the code up", async () => {
    const text = await xpl(dir, "resolve", NAME);
    const printed = /steps\[2\]\.anchors\[0\].* now at lines (\d+)-(\d+) \(approximate/.exec(
      text.out,
    );
    expect(printed, text.out).not.toBeNull();
    expect([printed![1], printed![2]]).toEqual(["81", "83"]);
    // the requeue call is really one line higher: that is why the lines are only a hint
    const lines = readFile(dir, "src/runner.ts").split("\n");
    expect(lines.findIndex((l) => l.includes("await this.queue.requeue(")) + 1).toBe(80);
  });

  it("Claude re-explains: dispatch:3 is ok again, the user's summary is kept, the user concept is skipped", async () => {
    const stored = readJson(dir, EXPLAINER_PATH);
    const userConcept = structuredClone(
      stored.concepts.find((c: any) => c.id === "concept:retry-tuning"),
    );
    const overlay = stored.nodes.find((n: any) => n.id === DISPATCH);
    expect(overlay.summary).toBe(USER_SUMMARY);

    // steps: copied out of the file, the drifted anchor rebuilt from the new text (find, not the old span:
    // the deleted ack call moved the requeue call one line up)
    const steps = structuredClone(
      stored.views.find((v: any) => v.id === "view:dispatch").steps,
    ) as any[];
    steps[2].label = "requeue(job, delay)";
    steps[2].summary = "A failed job goes back on the queue after the computed delay.";
    steps[2].anchors[0] = {
      file: "src/runner.ts",
      symbol: "Runner.dispatch",
      find: "await this.queue.requeue(\n          job,\n          delay);",
      role: "call-site",
    };
    const retryBlock = [
      "// Retry policy: exponential backoff up to maxRetries, then dead-letter.",
      "      const attempts = job.attempts + 1;",
      "      if (attempts <= this.config.retry.maxRetries) {",
      "        const delay = backoffDelay(attempts, this.config.retry);",
      "        await this.queue.requeue(",
      "          job,",
      "          delay);",
      "      } else {",
      "        await this.queue.deadLetter(job, result.error);",
      "",
      "        this.stats.deadLettered += 1;",
      "        this.log(`dead-lettered ${job.id} after ${attempts} attempts`);",
      "      }",
    ].join("\n");
    const patch = {
      nodes: [
        {
          id: DISPATCH,
          summary: "LLM: the hot loop; a successful job just continues, a failed one is retried.",
          anchors: [{ file: "src/runner.ts", symbol: "Runner.dispatch", role: "definition" }],
        },
      ],
      concepts: [
        {
          id: "concept:retry-policy",
          summary:
            "Failed jobs are requeued after an exponentially growing delay up to maxRetries, then dead-lettered.",
          anchors: [
            {
              file: "src/runner.ts",
              symbol: "Runner.dispatch",
              find: retryBlock,
              role: "definition",
            },
            ...stored.concepts.find((c: any) => c.id === "concept:retry-policy").anchors.slice(1),
          ],
        },
        { id: "concept:retry-tuning", summary: "LLM rewrite of the user's concept" },
      ],
      views: [{ id: "view:dispatch", type: "sequence", steps }],
    };

    const result = await applyOk(dir, patch, "llm");
    expect(result.json.applied).toBe(true);
    expect(result.json.changed).toEqual([DISPATCH, "concept:retry-policy", "view:dispatch"]);
    expect(result.json.issues.filter((i) => i.severity === "error")).toEqual([]);

    // the apply says what it kept and what it skipped
    const protectedIssues = result.json.issues.filter((i) => i.code === "protected");
    expect(protectedIssues).toHaveLength(2);
    expect(protectedIssues[0]).toMatchObject({
      severity: "warning",
      path: "nodes[0].summary",
      elementId: DISPATCH,
    });
    expect(protectedIssues[0]!.message).toContain("was edited by the user and is kept as it is");
    expect(protectedIssues[1]).toMatchObject({
      severity: "warning",
      path: "concepts[1]",
      elementId: "concept:retry-tuning",
    });
    expect(protectedIssues[1]!.message).toContain(
      "is user-authored; an llm patch cannot modify it (skipped)",
    );
    expect(
      result.json.issues.some((i) => i.path === "" && i.message.includes("2 existing validation")),
      "the two problems this patch cannot fix are summarised, not silently dropped",
    ).toBe(true);

    const explainer = readJson(dir, EXPLAINER_PATH);
    // the step: ok again, re-hashed from the current text, with its new summary
    expect(statusesOf(explainer, "dispatch:3")).toEqual(["ok", "ok"]);
    expect(anchorsOf(explainer, "dispatch:3")[0]).toMatchObject({
      span: { from: 33, to: 35 },
      resolved: { status: "ok", range: { startLine: 80, endLine: 82 } },
    });
    const step = explainer.views
      .find((v: any) => v.id === "view:dispatch")
      .steps.find((s: any) => s.id === "dispatch:3");
    expect(step.summary).toContain("computed delay");
    expect(step.label).toBe("requeue(job, delay)");
    // the overlay: anchored afresh, but its summary is still the user's and still listed in userFields
    const overlayNow = explainer.nodes.find((n: any) => n.id === DISPATCH);
    expect(overlayNow.summary).toBe(USER_SUMMARY);
    expect(overlayNow.provenance.userFields).toEqual(["summary"]);
    expect(overlayNow.provenance.commit).toBe(after.commit);
    expect(statusesOf(explainer, DISPATCH)).toEqual(["ok"]);
    // the llm's own concept was re-explained
    const retry = explainer.concepts.find((c: any) => c.id === "concept:retry-policy");
    expect(retry.summary).toContain("exponentially growing delay");
    expect(statusesOf(explainer, "concept:retry-policy")).toEqual(["ok", "ok", "ok"]);
    // the user's concept is exactly as it was, drift included
    expect(explainer.concepts.find((c: any) => c.id === "concept:retry-tuning")).toEqual(
      userConcept,
    );
    checkResolvedCache(dir, explainer);
  });

  it("afterwards status lists no llm element to re-explain; the missing anchor and the user's drift remain", async () => {
    const { json } = await xplJson<any>(dir, "status", NAME);
    expect(json.drifted).toEqual([]);
    expect(json.missing.map((m: any) => m.elementId)).toEqual(["concept:ack-semantics"]);
    expect(json.driftedOther.map((d: any) => d.elementId)).toEqual(["concept:retry-tuning"]);
    // nothing left for Claude; the user's own drifted concept is the one that waits
    expect(json.todo).toMatchObject({ drifted: 1, driftedUserOwned: 1, missing: 1 });
  });

  it("strict validate fails only on the missing anchor and on the user's own drifted anchor, with actionable messages", async () => {
    const strict = await xplJson<any>(dir, "validate", NAME);
    expect(strict.code).toBe(1);
    const errors = strict.json.issues.filter((i: any) => i.severity === "error");
    expect(errors.map((i: any) => [i.code, i.elementId, i.path])).toEqual([
      ["anchor-drifted", "concept:retry-tuning", "concepts[1].anchors[0]"],
      ["anchor-missing", "concept:ack-semantics", "concepts[2].anchors[0]"],
    ]);
    expect(strict.json.warnings).toBe(0);

    // the missing anchor: names the anchor, says what is gone, offers candidates, says how to fix it
    const missing = errors[1].message as string;
    expect(missing).toContain("anchor src/queue.ts#Queue.ack is missing");
    expect(missing).toContain("symbol Queue.ack is not in src/queue.ts");
    expect(missing).toMatch(/did you mean /);
    expect(missing).toContain("Re-anchor it to where the code went, or drop it");
    // the drifted anchor of a user-owned concept: an llm cannot repair it, and the message says so
    const drifted = errors[0].message as string;
    expect(drifted).toContain("anchor src/runner.ts#Runner.dispatch +30..41 drifted");
    expect(drifted).toMatch(/user-authored/);
    expect(drifted).toMatch(/--actor user/);

    const lenient = await xplJson<any>(dir, "validate", NAME, "--lenient");
    expect(lenient.code).toBe(0);
    expect(lenient.json).toMatchObject({ errors: 0, warnings: 2 });
  });

  it("the user re-anchors their concept, then drops the missing anchor: validate is clean", async () => {
    // the user has looked at the retry block again: their patch re-anchors it (span from `xpl show`)
    const shown = await xpl(dir, "show", "src/runner.ts#Runner.dispatch");
    expect(shown.code).toBe(0);
    const reanchored = await applyOk(
      dir,
      {
        concepts: [
          {
            id: "concept:retry-tuning",
            anchors: [
              {
                file: "src/runner.ts",
                symbol: "Runner.dispatch",
                find: "// Retry policy: exponential backoff up to maxRetries, then dead-letter.\n      const attempts = job.attempts + 1;",
                role: "definition",
              },
            ],
          },
        ],
      },
      "user",
    );
    expect(reanchored.json.changed).toEqual(["concept:retry-tuning"]);
    const stillFailing = await xplJson<any>(dir, "validate", NAME);
    expect(stillFailing.code).toBe(1);
    expect(stillFailing.json.errors).toBe(1);
    expect(stillFailing.json.issues[0]).toMatchObject({
      code: "anchor-missing",
      elementId: "concept:ack-semantics",
    });

    // the missing anchor is removed by a user patch (the anchors array is replaced)
    const dropped = await applyOk(
      dir,
      { concepts: [{ id: "concept:ack-semantics", anchors: [] }] },
      "user",
    );
    expect(dropped.json.changed).toEqual(["concept:ack-semantics"]);

    const validated = await xpl(dir, "validate", NAME);
    expect(validated.code, validated.out).toBe(0);
    expect(validated.out).toMatch(/^ok: .*\(strict, index /);
    const explainer = readJson(dir, EXPLAINER_PATH);
    // the concept stays (its text is the llm's), the anchors are now the user's call
    const ack = explainer.concepts.find((c: any) => c.id === "concept:ack-semantics");
    expect(ack.anchors).toEqual([]);
    expect(ack.provenance).toMatchObject({ origin: "llm", userFields: ["anchors"] });
    // and the regeneration loop is closed
    const { json } = await xplJson<any>(dir, "resolve", NAME);
    expect(json).toMatchObject({ drifted: [], driftedOther: [], missing: [] });
    expect(json.counts).toMatchObject({ drifted: 0, missing: 0 });
    const status = await xplJson<any>(dir, "status", NAME);
    expect(status.json.todo).toMatchObject({ drifted: 0, missing: 0 });
  });
});
