import { describe, expect, it } from "vitest";
import {
  applyPatch,
  applyUserEdits,
  createExplainer,
  makeUserEdit,
  reresolveExplainer,
  IndexModel,
} from "../src/index.js";
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
  for (const after of [{ unsupported: [] }, { provenance: { origin: "llm" } }, { summary: 42 }]) {
    expect(() => applyUserEdits(initial, [{ ...edit, after }], w.model, w.getText)).toThrow(
      "Invalid or unsupported edit field",
    );
  }
});

it("saves checked evidence, builds conditional inverses and protects it from later LLM patches", () => {
  const w = makeWorld({ files: [{ path: "a.ts", text: "const first = 1;\nconst second = 2;" }] });
  const initial = createExplainer({
    title: "Demo",
    repoName: "Demo",
    indexPath: ".explainer/index-c1.json",
    index: w.index,
  });
  const setup = applyPatch(
    initial,
    {
      concepts: [
        {
          id: "concept:run",
          label: "Run",
          summary: "Old text.",
          anchors: [{ file: "a.ts", span: { from: 0, to: 0 }, role: "usage" }],
        },
      ],
    },
    w.model,
    w.getText,
    { actor: "llm" },
  );
  expect(setup.ok).toBe(true);
  if (!setup.ok) throw new Error("fixture failed");
  const saved = applyUserEdits(
    setup.explainer,
    [
      makeUserEdit(setup.explainer, w.model, "concepts", "concept:run", {
        summary: "Checked by the author.",
        anchors: [{ file: "a.ts", find: "const second = 2;", role: "definition" }],
      }),
    ],
    w.model,
    w.getText,
  );
  expect(saved.explainer.concepts[0]).toMatchObject({
    summary: "Checked by the author.",
    anchors: [
      { file: "a.ts", span: { from: 1, to: 1 }, role: "definition", resolved: { status: "ok" } },
    ],
    provenance: { origin: "llm", userFields: ["summary", "anchors"] },
  });
  expect(saved.inverse[0]!.before.anchors).toEqual([
    expect.objectContaining({ span: { from: 1, to: 1 } }),
  ]);
  const index = new IndexModel({ ...w.index, commit: "c2" });
  const fresh = reresolveExplainer(saved.explainer, index, w.getText).explainer;
  const undone = applyUserEdits(fresh, saved.inverse, index, w.getText);
  expect(undone.explainer.concepts[0]).toMatchObject({
    summary: "Old text.",
    anchors: [{ span: { from: 0, to: 0 } }],
  });
  const redone = applyUserEdits(undone.explainer, undone.inverse, index, w.getText);
  const revised = applyPatch(
    redone.explainer,
    {
      concepts: [
        {
          id: "concept:run",
          summary: "Generated replacement.",
          anchors: [{ file: "missing.ts", role: "usage" }],
          detail: "New generated detail.",
        },
      ],
    },
    index,
    w.getText,
    { actor: "llm" },
  );
  expect(revised.ok).toBe(true);
  if (!revised.ok) throw new Error("revision failed");
  expect(revised.explainer.concepts[0]).toMatchObject({
    summary: "Checked by the author.",
    detail: "New generated detail.",
    anchors: [{ file: "a.ts", span: { from: 1, to: 1 } }],
  });
});
