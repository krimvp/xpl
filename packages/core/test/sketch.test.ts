/**
 * Sketch boxes (`Node.sketch`): the big picture before, or beside, the code. A sketch box is an idea from a
 * description or from reading, linked to no code, so it needs no anchors and may hold none: nothing on a map
 * can pass for checked code without being checked. An arrow needs evidence only at the ends that are code.
 */
import { describe, expect, it } from "vitest";
import {
  applyPatch,
  deriveGraph,
  ExplainerModel,
  validateExplainer,
  type ExplainerPatch,
  type GraphView,
} from "../src/index.js";
import { emptyExplainer, jobrunner } from "./helpers.js";

const w = jobrunner();

const SKETCH: ExplainerPatch = {
  nodes: [
    { id: "grp:client", label: "Client", role: "person", sketch: true, summary: "Sends jobs." },
    { id: "grp:runner", label: "Job runner", role: "service", sketch: true },
  ],
  edges: [
    {
      id: "edge:submits",
      from: "grp:client",
      to: "grp:runner",
      kind: "custom",
      label: "submits jobs",
    },
  ],
  views: [
    {
      id: "view:idea",
      type: "graph",
      title: "The idea",
      include: ["grp:client", "grp:runner"],
      stubs: { mode: "none" },
    },
  ],
};

const apply = (patch: ExplainerPatch, base = emptyExplainer()) =>
  applyPatch(base, patch, w.index, w.getText, { actor: "llm" });

describe("sketch boxes", () => {
  it("need no code, and neither does an arrow between two of them; the map marks them", () => {
    const r = apply(SKETCH);
    expect(r.issues).toEqual([]);
    expect(validateExplainer(r.explainer, w.index, w.getText)).toEqual([]);
    const model = new ExplainerModel(r.explainer, w.model);
    const graph = deriveGraph(r.explainer.views[0] as GraphView, model);
    expect(graph.nodes.map((n) => [n.id, n.sketch])).toEqual([
      ["grp:client", true],
      ["grp:runner", true],
    ]);
    expect(graph.edges.map((e) => [e.id, e.resolution])).toEqual([["edge:submits", "llm"]]);
  });

  it("hold no members or anchors: a box that is code is not a sketch", () => {
    const r = apply({
      nodes: [
        {
          id: "grp:half",
          label: "Half",
          sketch: true,
          members: ["file:src/queue.ts"],
          anchors: [{ file: "src/queue.ts", symbol: "Queue", role: "definition" }],
        },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.issues.filter((i) => i.severity === "error").map((i) => i.message)).toEqual([
      "grp:half is a sketch (an idea, linked to no code): it cannot have members; drop sketch to make it a box of code",
      "grp:half is a sketch (an idea, linked to no code): it cannot have anchors; drop sketch to make it a box of code",
    ]);
  });

  it("are groups only", () => {
    const r = apply({ nodes: [{ id: "file:src/queue.ts", sketch: true }] });
    expect(r.issues.map((i) => i.message)).toContain(
      "only a group (grp:) can be a sketch: file:src/queue.ts is code",
    );
  });

  it("an arrow from a sketch box to code still needs evidence at the code end", () => {
    const r = apply({
      ...SKETCH,
      edges: [
        {
          id: "edge:uses",
          from: "grp:runner",
          to: "file:src/queue.ts",
          kind: "custom",
          label: "queues jobs",
        },
      ],
    });
    expect(
      r.issues.filter((i) => i.severity === "error").map((i) => [i.code, i.message.split(" (")[0]]),
    ).toEqual([["evidence", "llm edge edge:uses needs an anchor at its end"]]);
  });
});
