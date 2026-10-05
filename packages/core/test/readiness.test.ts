import { describe, expect, it } from "vitest";
import {
  artifactIdentity,
  checkReadiness,
  reviewFingerprint,
  type Explainer,
} from "../src/index.js";
import { anchor, emptyExplainer, graphView, sequenceView, LLM, makeWorld } from "./helpers.js";

function example() {
  const world = makeWorld({
    files: [
      { path: "a.ts", text: "export const a = 1;" },
      { path: "b.ts", text: "export const b = 2;" },
    ],
  });
  const explainer: Explainer = emptyExplainer({
    nodes: [
      {
        id: "file:a.ts",
        kind: "file",
        parent: "repo",
        label: "Starting value",
        summary: "Stores the starting value.",
        anchors: [anchor(world, { file: "a.ts", role: "definition", span: { from: 0, to: 0 } })],
        provenance: LLM,
      },
    ],
    views: [
      graphView("view:values", ["file:a.ts", "file:b.ts"], {
        title: "Values",
        hidden: ["file:b.ts"],
        stubs: { mode: "none" },
      }),
    ],
  });
  return { world, explainer };
}

describe("ready export rules", () => {
  it("reports review state without changing ordinary readiness; explicit policy requires all current content", () => {
    const { world, explainer } = example();
    const check = (requireReview = false) =>
      checkReadiness(explainer, world.index, world.getText, { scope: "workspace", requireReview });
    expect(check()).toMatchObject({
      ready: true,
      errors: 0,
      review: { status: "unchecked", required: false },
    });
    expect(check(true)).toMatchObject({
      ready: false,
      errors: 1,
      review: { status: "unchecked", required: true },
      findings: [{ code: "review-required" }],
    });
    const record = (content: "all" | string[]) => {
      const scope = { content, source: "anchored" as const };
      explainer.review = {
        reviewer: "Ada",
        reviewedAt: "2026-10-04T12:00:00Z",
        scope,
        omissions: ["Runtime behavior was not exercised."],
        sourceCommit: world.index.commit,
        fingerprint: reviewFingerprint(explainer, world.index, world.getText, scope),
      };
    };
    record(["file:a.ts"]);
    expect(check()).toMatchObject({ ready: true, review: { status: "reviewed", required: false } });
    expect(check(true)).toMatchObject({
      ready: false,
      errors: 1,
      findings: [{ code: "review-required" }],
    });
    record("all");
    expect(check(true)).toMatchObject({
      ready: true,
      errors: 0,
      review: { status: "reviewed", required: true },
    });
    explainer.nodes[0]!.summary = "Stores another starting value.";
    expect(check()).toMatchObject({
      ready: true,
      errors: 0,
      review: { status: "out-of-date", required: false },
    });
    expect(check(true)).toMatchObject({
      ready: false,
      errors: 1,
      review: { status: "out-of-date", required: true },
    });
  });

  it("leaves repository identities, IDs and code references out of authored text checks", () => {
    const world = makeWorld({ files: [{ path: "TODO.ts", text: "export const TODO = 1;" }] });
    const explainer = emptyExplainer({
      repo: { name: "TODO", commit: "c1" },
      nodes: [
        {
          id: "file:TODO.ts",
          kind: "file",
          parent: "repo",
          label: "Tasks",
          summary: "Stores the `TODO` marker.",
          anchors: [
            anchor(world, { file: "TODO.ts", role: "definition", span: { from: 0, to: 0 } }),
          ],
          provenance: LLM,
        },
      ],
      views: [
        graphView("view:tasks", ["file:TODO.ts"], { title: "Tasks", stubs: { mode: "none" } }),
      ],
    });
    expect(
      checkReadiness(explainer, world.index, world.getText, { scope: "embedded-snapshot" }),
    ).toMatchObject({ ready: true, errors: 0, findings: [] });
  });

  it.each(["frame", "transition", "audience", "technology"])(
    "rejects a TODO in %s text on an otherwise-ready explanation",
    (field) => {
      const { world, explainer } = example();
      const view = sequenceView(
        "view:retry",
        ["file:a.ts"],
        [
          {
            id: "retry:1",
            from: "file:a.ts",
            to: "file:a.ts",
            label: "Try again",
            kind: "call",
            summary: "Reads the starting value.",
            anchors: [],
            next: [{ step: "retry:1", label: "Try again", kind: "recurse" }],
          },
        ],
        {
          type: field === "frame" ? "sequence" : "flow",
          title: "Retry",
          frames: [
            {
              id: "frame:retry",
              kind: "loop",
              label: "Retry loop",
              fromStep: "retry:1",
              toStep: "retry:1",
            },
          ],
        },
      );
      if (field === "frame") delete view.steps[0]!.next;
      explainer.views.push(view);
      explainer.scope = { audience: "For maintainers" };
      explainer.nodes[0]!.tech = "TypeScript";
      const check = () =>
        checkReadiness(explainer, world.index, world.getText, { scope: "embedded-snapshot" });
      expect(check().findings.filter((f) => f.severity === "error")).toEqual([]);
      expect(check().ready).toBe(true);
      let elementId: string;
      let expectedField: string;
      if (field === "frame") {
        view.frames![0]!.label = "TODO: explain retry loop";
        elementId = "frame:retry";
        expectedField = "label";
      } else if (field === "transition") {
        view.steps[0]!.next![0]!.label = "TODO: explain condition";
        elementId = "retry:1";
        expectedField = "next[0].label";
      } else if (field === "audience") {
        explainer.scope.audience = "TODO: name the audience";
        elementId = "(explainer)";
        expectedField = "scope.audience";
      } else {
        explainer.nodes[0]!.tech = "TODO: name the technology";
        elementId = "file:a.ts";
        expectedField = "tech";
      }
      const report = check();
      expect(report).toMatchObject({ ready: false, errors: 1 });
      expect(report.findings.filter((finding) => finding.severity === "error")).toEqual([
        {
          severity: "error",
          code: "todo-left",
          elementId,
          field: expectedField,
          message: "1 TODO placeholder left: text nobody has written yet",
          hint: "write what the TODO asks for, check it against the code, and remove the TODO",
        },
      ]);
    },
  );

  it("requires visible content, leaving hidden nodes optional", () => {
    const { world, explainer } = example();
    const ready = checkReadiness(explainer, world.index, world.getText, {
      scope: "embedded-snapshot",
    });
    expect(ready).toMatchObject({ ready: true, errors: 0, findings: [] });
    explainer.nodes[0]!.summary = "";
    const missing = checkReadiness(explainer, world.index, world.getText, {
      scope: "embedded-snapshot",
      decisionNote: "The empty box is intentional.",
    });
    expect(missing).toMatchObject({
      ready: false,
      errors: 1,
      findings: [{ code: "required-content", elementId: "file:a.ts", field: "summary" }],
      decisionNote: "The empty box is intentional.",
    });
  });

  it("does not accept cached evidence when embedded source is missing", () => {
    const { world, explainer } = example();
    expect(
      checkReadiness(explainer, world.index, world.getText, { scope: "embedded-snapshot" }).ready,
    ).toBe(true);
    const result = checkReadiness(explainer, world.index, () => undefined, {
      scope: "embedded-snapshot",
    });
    expect(result.ready).toBe(false);
    expect(result.findings).toMatchObject([{ code: "source-unavailable", elementId: "file:a.ts" }]);
  });

  it("reports source mismatch even when an unchanged anchor still resolves", () => {
    const { world, explainer } = example();
    world.texts["b.ts"] = "export const b = 3;";
    const report = checkReadiness(explainer, world.index, world.getText, {
      scope: "embedded-snapshot",
    });
    expect(report).toMatchObject({
      ready: false,
      errors: 1,
      findings: [{ code: "source-mismatch", elementId: "file:b.ts", field: "source" }],
    });
  });

  it("separates reader warnings from blockers and records author decisions", () => {
    const { world, explainer } = example();
    explainer.title = "run()";
    const report = checkReadiness(explainer, world.index, world.getText, {
      scope: "workspace",
      decisionNote: "The title quotes the operation.",
    });
    expect(report).toMatchObject({
      ready: true,
      errors: 0,
      warnings: 1,
      findings: [{ severity: "warning", code: "code-title" }],
      decisionNote: "The title quotes the operation.",
    });
  });

  it("binds explanation edits and source manifests independently, regardless of object key order or index pruning", () => {
    const { world, explainer } = example();
    const initial = artifactIdentity(explainer, world.index);
    const reordered = Object.fromEntries(
      Object.entries(explainer).reverse(),
    ) as unknown as Explainer;
    expect(
      artifactIdentity(reordered, {
        ...world.index,
        files: [...world.index.files].reverse(),
        symbols: [],
        refs: [],
        pruned: { files: 2, symbols: 0, refs: 0 },
      }),
    ).toEqual(initial);
    explainer.nodes[0]!.summary = "Stores the initial value.";
    const edited = artifactIdentity(explainer, world.index);
    expect(edited.explainerHash).not.toBe(initial.explainerHash);
    expect(edited.sourceHash).toBe(initial.sourceHash);
    world.index.files[0]!.hash = "sha256-v2:different";
    const changed = artifactIdentity(explainer, world.index);
    expect(changed.explainerHash).toBe(edited.explainerHash);
    expect(changed.sourceHash).not.toBe(initial.sourceHash);
  });
});
