import { describe, expect, it } from "vitest";
import {
  applyPatch,
  artifactIdentity,
  checkReview,
  reviewFingerprint,
  reresolveExplainer,
  validateExplainer,
  BUNDLE_SCHEMA,
  parseBundle,
  serializeBundle,
  TextCache,
  type ExplainerPatch,
  type ReviewScope,
} from "../src/index.js";
import { anchor, concept, emptyExplainer, makeWorld } from "./helpers.js";

function example() {
  const world = makeWorld({
    files: [
      { path: "a.ts", text: "const a = 1;\nconst other = 2;" },
      { path: "b.ts", text: "const b = 3;" },
    ],
  });
  const explainer = emptyExplainer({
    concepts: [
      concept(
        "concept:value",
        [anchor(world, { file: "a.ts", role: "definition", span: { from: 0, to: 0 } })],
        { summary: "Stores the starting value." },
      ),
      concept("concept:other", [], { summary: "Stores another value." }),
    ],
  });
  const scope: ReviewScope = { content: ["concept:value"], source: "anchored" };
  const review = {
    reviewer: "Alex (self-reported)",
    reviewedAt: "2026-10-04T12:00:00.000Z",
    scope,
    omissions: ["Runtime initialization is outside this review."],
    fingerprint: reviewFingerprint(explainer, world.index, world.getText, scope),
  };
  const apply = (patch: ExplainerPatch, actor: "llm" | "user" = "user", input = explainer) =>
    applyPatch(input, patch, world.index, world.getText, { actor });
  return { world, explainer, scope, review, apply };
}

describe("scoped author reviews", () => {
  it("records a user-reviewed snapshot, defaults legacy guides to unchecked, and permits explicit user removal", () => {
    const { world, explainer, review, apply } = example();
    expect(checkReview(explainer, world.index, world.getText)).toEqual({ status: "unchecked" });
    const result = apply({ review });
    expect(result.ok).toBe(true);
    expect(result.changed).toEqual(["review"]);
    expect(result.explainer.review).toEqual({ ...review, sourceCommit: "c1" });
    expect(checkReview(result.explainer, world.index, world.getText)).toEqual({
      status: "reviewed",
    });
    expect(validateExplainer(result.explainer, world.index, world.getText)).toEqual([]);
    expect(apply({ review: null }, "user", result.explainer).explainer.review).toBeUndefined();
    expect(explainer.review).toBeUndefined();
  });

  it.each(["create", "overwrite", "remove"])("rejects LLM review %s atomically", (operation) => {
    const { review, apply, explainer } = example();
    const reviewed = apply({ review }).explainer;
    const input = operation === "create" ? explainer : reviewed;
    const result = apply(
      {
        title: "Forged edit",
        review: operation === "remove" ? null : { ...review, reviewer: "LLM" },
      },
      "llm",
      input,
    );
    expect(result.ok).toBe(false);
    expect(result.explainer).toBe(input);
    expect(result.changed).toEqual([]);
    expect(result.issues).toEqual([
      {
        severity: "error",
        code: "protected",
        path: "review",
        message: "Only user patches can record or remove a review.",
      },
    ]);
  });

  it("preserves the record through ordinary generated patches and invalidates selected prose and anchor changes", () => {
    const { world, review, apply } = example();
    const reviewed = apply({ review }).explainer;
    const unrelated = apply(
      { concepts: [{ id: "concept:other", summary: "Describes an unrelated value." }] },
      "llm",
      reviewed,
    );
    expect(unrelated.ok).toBe(true);
    expect(unrelated.explainer.review).toEqual(reviewed.review);
    expect(checkReview(unrelated.explainer, world.index, world.getText)).toEqual({
      status: "reviewed",
    });
    const edited = apply(
      { concepts: [{ id: "concept:value", summary: "Stores a revised value." }] },
      "llm",
      reviewed,
    );
    expect(edited.ok).toBe(true);
    expect(checkReview(edited.explainer, world.index, world.getText)).toEqual({
      status: "out-of-date",
    });
    const retargeted = apply(
      { concepts: [{ id: "concept:value", anchors: [{ file: "b.ts", role: "definition" }] }] },
      "llm",
      reviewed,
    );
    expect(retargeted.ok).toBe(true);
    expect(checkReview(retargeted.explainer, world.index, world.getText)).toEqual({
      status: "out-of-date",
    });
    const removed = apply({ remove: ["concept:value"] }, "llm", reviewed);
    expect(removed.ok).toBe(true);
    expect(validateExplainer(removed.explainer, world.index, world.getText)).toEqual([]);
    expect(checkReview(removed.explainer, world.index, world.getText)).toEqual({
      status: "out-of-date",
    });
  });

  it("ignores unrelated source, provenance and moved locations but detects changed or unavailable anchored evidence", () => {
    const { world, review, apply } = example();
    const reviewed = apply({ review }).explainer;
    world.texts["b.ts"] = "const b = 4;";
    world.texts["a.ts"] = "// moved\nconst a = 1;\nconst other = 9;";
    const movedWorld = makeWorld({
      commit: "c2",
      files: Object.entries(world.texts).map(([path, text]) => ({ path, text })),
    });
    const moved = reresolveExplainer(reviewed, movedWorld.index, movedWorld.getText).explainer;
    expect(moved.concepts[0]!.anchors[0]!.span).toEqual({ from: 1, to: 1 });
    expect(checkReview(moved, movedWorld.index, movedWorld.getText)).toEqual({
      status: "reviewed",
    });
    moved.concepts[0]!.provenance = { origin: "user", commit: "c2" };
    expect(checkReview(moved, movedWorld.index, movedWorld.getText)).toEqual({
      status: "reviewed",
    });
    movedWorld.texts["a.ts"] = "// moved\nconst a = 8;\nconst other = 9;";
    expect(checkReview(moved, movedWorld.index, movedWorld.getText)).toEqual({
      status: "out-of-date",
    });
    expect(checkReview(reviewed, world.index, () => undefined)).toEqual({ status: "out-of-date" });
  });

  it.each(["files", "repository"])("invalidates explicitly widened %s source scope", (kind) => {
    const { world, explainer, review, apply } = example();
    const scope: ReviewScope =
      kind === "files"
        ? { ...review.scope, files: ["b.ts"] }
        : { ...review.scope, source: "repository" };
    const result = apply({
      review: {
        ...review,
        scope,
        fingerprint: reviewFingerprint(explainer, world.index, world.getText, scope),
      },
    });
    expect(result.ok).toBe(true);
    expect(checkReview(result.explainer, world.index, world.getText)).toEqual({
      status: "reviewed",
    });
    world.texts["b.ts"] = "const b = 99;";
    expect(checkReview(result.explainer, world.index, world.getText)).toEqual({
      status: "out-of-date",
    });
  });

  it("rejects a stale reviewed fingerprint, including edits in the same patch", () => {
    const { world, review, apply, explainer } = example();
    expect(apply({ review }).ok).toBe(true);
    const result = apply({
      concepts: [{ id: "concept:value", summary: "Changed before recording." }],
      review,
    });
    expect(result.ok).toBe(false);
    expect(result.explainer).toBe(explainer);
    expect(result.issues).toEqual([
      {
        severity: "error",
        code: "review",
        path: "review.fingerprint",
        message:
          "Reviewed content or evidence changed; inspect the current scope before recording a review.",
      },
    ]);
    world.texts["a.ts"] = "const a = 8;\nconst other = 2;";
    expect(apply({ review }).ok).toBe(false);
  });

  it("excludes the review record from its fingerprint while keeping ordinary artifact identity unchanged", () => {
    const { world, scope, review, apply, explainer } = example();
    const before = artifactIdentity(explainer, world.index);
    const reviewed = apply({ review }).explainer;
    expect(reviewFingerprint(reviewed, world.index, world.getText, scope)).toEqual(
      review.fingerprint,
    );
    expect(artifactIdentity(reviewed, world.index).explainerHash).not.toBe(before.explainerHash);
    reviewed.review!.reviewer = "Another self-reported name";
    reviewed.review!.omissions.push("No authentication is claimed.");
    expect(checkReview(reviewed, world.index, world.getText)).toEqual({ status: "reviewed" });
  });

  it("reviews all stored content when requested and retains the record in a packed portable snapshot", () => {
    const { world, explainer, review, apply } = example();
    const scope: ReviewScope = { content: "all", source: "anchored" };
    const result = apply({
      review: {
        ...review,
        scope,
        fingerprint: reviewFingerprint(explainer, world.index, world.getText, scope),
      },
    });
    expect(result.ok).toBe(true);
    const reopened = parseBundle(
      serializeBundle(
        {
          schema: BUNDLE_SCHEMA,
          explainer: result.explainer,
          index: world.index,
          files: world.texts,
        },
        { packIndex: true },
      ),
    );
    expect(reopened.explainer.review).toEqual(result.explainer.review);
    expect(checkReview(reopened.explainer, reopened.index, (path) => reopened.files[path])).toEqual(
      { status: "reviewed" },
    );
    const renamed = apply({ title: "Another explanation" }, "llm", result.explainer);
    expect(renamed.ok).toBe(true);
    expect(checkReview(renamed.explainer, world.index, world.getText)).toEqual({
      status: "out-of-date",
    });
  });

  it.each([
    ["reviewer", { reviewer: " " }],
    ["reviewedAt", { reviewedAt: "2026-02-30T12:00:00Z" }],
    ["omissions", { omissions: [""] }],
    ["scope.content", { scope: { content: [], source: "anchored" } }],
    [
      "scope.content",
      { scope: { content: ["concept:value", "concept:value"], source: "anchored" } },
    ],
    ["scope.source", { scope: { content: "all", source: "unknown" } }],
    ["scope.files", { scope: { content: "all", source: "anchored", files: ["../a.ts"] } }],
    ["scope.files", { scope: { content: "all", source: "anchored", files: ["/a.ts"] } }],
    [
      "fingerprint",
      { fingerprint: { version: "unknown", contentHash: "fake", evidenceHash: "fake" } },
    ],
    ["sourceCommit", { sourceCommit: "forged" }],
    ["origin", { origin: "user" }],
  ])("rejects malformed user review field %s at the patch boundary", (field, overrides) => {
    const { review, apply, explainer } = example();
    expect(apply({ review }).ok).toBe(true);
    const result = apply({ review: { ...review, ...overrides } } as ExplainerPatch);
    expect(result.ok).toBe(false);
    expect(result.explainer).toBe(explainer);
    expect(result.issues.map(({ path, code, severity }) => ({ path, code, severity }))).toEqual([
      { path: `review.${field}`, code: "review", severity: "error" },
    ]);
  });

  it("reports malformed stored reviews while retaining historical scopes whose content was removed", () => {
    const { world, review, apply } = example();
    const reviewed = apply({ review }).explainer;
    reviewed.review!.sourceCommit = "";
    expect(
      validateExplainer(reviewed, world.index, world.getText).map(({ path, code }) => ({
        path,
        code,
      })),
    ).toEqual([{ path: "review.sourceCommit", code: "review" }]);
    expect(checkReview(reviewed, world.index, world.getText)).toEqual({ status: "out-of-date" });
  });

  it("binds base evidence through the supplied before-source reader and detects its absence", () => {
    const { world, explainer, review } = example();
    const change = {
      base: "a".repeat(40),
      head: "b".repeat(40),
      files: [{ path: "a.ts", status: "modified" as const, hunks: [] }],
    };
    explainer.change = change;
    const texts = new TextCache(world.getText, () => "const a = 0;");
    const result = applyPatch(
      explainer,
      {
        concepts: [
          { id: "concept:value", anchors: [{ file: "a.ts", at: "base", role: "definition" }] },
        ],
      },
      world.index,
      texts,
      { actor: "user" },
    );
    expect(result.ok).toBe(true);
    const fingerprint = reviewFingerprint(result.explainer, world.index, texts, review.scope);
    const recorded = applyPatch(
      result.explainer,
      { review: { ...review, fingerprint } },
      world.index,
      texts,
      { actor: "user" },
    );
    expect(recorded.ok).toBe(true);
    expect(checkReview(recorded.explainer, world.index, texts)).toEqual({ status: "reviewed" });
    expect(checkReview(recorded.explainer, world.index, world.getText)).toEqual({
      status: "out-of-date",
    });
    expect(
      checkReview(
        recorded.explainer,
        world.index,
        new TextCache(world.getText, () => "const a = 9;"),
      ),
    ).toEqual({ status: "out-of-date" });
  });
});
