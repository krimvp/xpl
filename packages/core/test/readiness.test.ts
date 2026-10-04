import { describe, expect, it } from "vitest";
import { artifactIdentity, checkReadiness, type Explainer } from "../src/index.js";
import { anchor, emptyExplainer, graphView, LLM, makeWorld } from "./helpers.js";

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
