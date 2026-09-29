import { describe, expect, it } from "vitest";
import { applyPatch, validateExplainer } from "../src/index.js";
import { emptyExplainer, graphView, jobrunner } from "./helpers.js";

const w = jobrunner();
describe("follow-up: stubs in a patch and folded ghost ids in hidden", () => {
  const base = emptyExplainer({ views: [graphView("view:v", ["file:src/runner.ts"])] });
  const apply = (view: object) =>
    applyPatch(
      base,
      { views: [{ id: "view:v", type: "graph", ...view }] } as never,
      w.index,
      w.getText,
      { actor: "user" },
    );

  it("accepts and clears stubs", () => {
    const r = apply({ stubs: { mode: "all", max: 3 } });
    expect(r.ok, JSON.stringify(r.issues)).toBe(true);
    expect((r.explainer.views[0] as any).stubs).toEqual({ mode: "all", max: 3 });
    const cleared = applyPatch(
      r.explainer,
      { views: [{ id: "view:v", type: "graph", stubs: null }] } as never,
      w.index,
      w.getText,
      { actor: "user" },
    );
    expect("stubs" in cleared.explainer.views[0]!).toBe(false);
  });
  it("creates a view with stubs", () => {
    const r = applyPatch(
      emptyExplainer(),
      {
        views: [
          {
            id: "view:n",
            type: "graph",
            title: "N",
            include: ["file:src/runner.ts"],
            stubs: { mode: "none" },
          },
        ],
      } as never,
      w.index,
      w.getText,
      { actor: "llm" },
    );
    expect(r.ok, JSON.stringify(r.issues)).toBe(true);
    expect((r.explainer.views[0] as any).stubs).toEqual({ mode: "none" });
  });
  it("rejects a bad stubs value", () => {
    expect(apply({ stubs: { mode: "loud" } }).ok).toBe(false);
    expect(apply({ stubs: { max: -1 } }).ok).toBe(false);
    expect(apply({ stubs: { max: 2.5 } }).ok).toBe(false);
    expect(apply({ stubs: "top" }).ok).toBe(false);
    const warned = apply({ stubs: { mode: "top", extra: 1 } });
    expect(warned.ok).toBe(true);
    expect(warned.issues.map((i) => i.severity)).toEqual(["warning"]);
  });
  it("hidden takes folded ghost and stub ids", () => {
    const hidden = [
      "ghost:rest:file:src/queue.ts",
      "ghost:more:out",
      "ghost:more:in",
      "stub:out:file:src/runner.ts->ghost:more:out",
      "stub:out:file:src/runner.ts->ghost:rest:file:src/queue.ts",
    ];
    const ex = emptyExplainer({ views: [graphView("view:v", ["file:src/runner.ts"], { hidden })] });
    expect(
      validateExplainer(ex, w.index, w.getText, { mode: "strict" }).filter(
        (i) => i.severity === "error",
      ),
    ).toEqual([]);
    const bad = emptyExplainer({
      views: [
        graphView("view:v", ["file:src/runner.ts"], { hidden: ["ghost:rest:file:src/nope.ts"] }),
      ],
    });
    expect(
      validateExplainer(bad, w.index, w.getText, { mode: "strict" }).some(
        (i) => i.code === "unknown-id",
      ),
    ).toBe(true);
  });
});
