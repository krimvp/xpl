import { describe, expect, it } from "vitest";
import { applyPatch, applyUserEdits, createExplainer, makeUserEdit } from "../src/index.js";
import { makeWorld } from "./helpers.js";

const world = () => makeWorld({ files: [{ path: "a.ts", text: "function run() {}" }] });

describe("bounded user edits", () => {
  it("undoes only edited fields, keeps unrelated edits, and keeps user protection", () => {
    const w = world();
    const initial = createExplainer({
      title: "Demo",
      repoName: "Demo",
      indexPath: ".explainer/index-c1.json",
      index: w.index,
    });
    const edit = makeUserEdit(initial, w.model, "nodes", "file:a.ts", { summary: "Runs work." });
    const saved = applyUserEdits(initial, [edit], w.model, w.getText);
    expect(saved.explainer.nodes.find((n) => n.id === "file:a.ts")).toMatchObject({
      summary: "Runs work.",
      provenance: { origin: "user" },
    });
    const other = applyPatch(
      saved.explainer,
      { nodes: [{ id: "file:a.ts", detail: "Someone else's detail." }] },
      w.model,
      w.getText,
      { actor: "user" },
    );
    expect(other.ok).toBe(true);
    if (!other.ok) throw new Error("fixture failed");
    const undone = applyUserEdits(other.explainer, saved.inverse, w.model, w.getText);
    expect(undone.explainer.nodes.find((n) => n.id === "file:a.ts")).toMatchObject({
      detail: "Someone else's detail.",
    });
    expect(undone.explainer.nodes.find((n) => n.id === "file:a.ts")?.summary).toBeUndefined();
    const redone = applyUserEdits(undone.explainer, undone.inverse, w.model, w.getText);
    expect(redone.explainer.nodes.find((n) => n.id === "file:a.ts")?.summary).toBe("Runs work.");
    const llm = applyPatch(
      redone.explainer,
      { nodes: [{ id: "file:a.ts", summary: "Generated replacement." }] },
      w.model,
      w.getText,
      { actor: "llm" },
    );
    expect(llm.ok).toBe(true);
    if (llm.ok)
      expect(llm.explainer.nodes.find((n) => n.id === "file:a.ts")?.summary).toBe("Runs work.");
  });
});

it("refuses conflicting fields and unsupported payloads without changing the artifact", () => {
  const w = world();
  const initial = createExplainer({
    title: "Demo",
    repoName: "Demo",
    indexPath: ".explainer/index-c1.json",
    index: w.index,
  });
  const edit = makeUserEdit(initial, w.model, "nodes", "file:a.ts", { summary: "My summary." });
  const saved = applyUserEdits(initial, [edit], w.model, w.getText);
  const newer = applyUserEdits(
    saved.explainer,
    [
      makeUserEdit(saved.explainer, w.model, "nodes", "file:a.ts", {
        summary: "Someone else's summary.",
      }),
    ],
    w.model,
    w.getText,
  );
  expect(() => applyUserEdits(newer.explainer, saved.inverse, w.model, w.getText)).toThrow(
    "summary changed since this edit",
  );
  expect(newer.explainer.nodes.find((n) => n.id === "file:a.ts")?.summary).toBe(
    "Someone else's summary.",
  );
  for (const after of [{ anchors: [] }, { provenance: { origin: "llm" } }, { summary: 42 }]) {
    expect(() => applyUserEdits(initial, [{ ...edit, after }], w.model, w.getText)).toThrow(
      "Invalid or unsupported edit field",
    );
  }
});
