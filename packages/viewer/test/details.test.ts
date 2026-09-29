import { describe, expect, it } from "vitest";
import { getDerived } from "../src/derive.js";
import { describeElement } from "../src/details.js";
import { ViewerStore } from "../src/store.js";
import { makeBundle } from "./world.js";

function overview(over: Record<string, unknown> = {}) {
  const bundle = makeBundle();
  const view = bundle.explainer.views.find((v) => v.id === "view:overview")!;
  if (view.type === "graph") Object.assign(view, { include: ["sym:src/a.ts#A.run"] }, over);
  const store = new ViewerStore(bundle);
  const state = store.getState();
  return { store, model: state.model, vd: getDerived(state).view };
}

describe("details of a stub", () => {
  it("a stub to one element: the box to click, and no list", () => {
    const { model, vd } = overview();
    const info = describeElement("stub:out:sym:src/a.ts#A.run->ghost:file:src/b.ts", model, vd);
    expect(info).toMatchObject({ type: "stub", kind: "stub", title: "calls ×1" });
    expect(info.summary).toBe(
      "A.run reaches b.ts, which is not in this view. Click the dashed box to add it.",
    );
    expect(info.targets).toBeUndefined();
    expect(info.facts.map((f) => f.label)).toEqual([
      "Inside",
      "Outside",
      "Direction",
      "References",
    ]);
  });

  it("a stub to a folded ghost lists what it folds, to pick from", () => {
    const { model, vd } = overview();
    const info = describeElement("stub:in:sym:src/a.ts#A.run->ghost:rest:file:src/a.ts", model, vd);
    expect(info.summary).toBe(
      "rest of a.ts (1 element not in this view) reaches A.run. Pick one below to add it, or click the dashed box to choose there.",
    );
    expect(info.targets?.map((t) => [t.target, t.label, t.count])).toEqual([
      ["sym:src/a.ts#A.stop", "A.stop", 1],
    ]);
    expect(info.facts).toContainEqual({ label: "Elements", value: "1" });
    expect(info.facts).toContainEqual({ label: "Outside", value: "rest of a.ts" });
    expect(info.stub?.ghost).toBe("rest:file:src/a.ts");
  });

  it("the overflow stub counts its elements", () => {
    const { model, vd } = overview({ stubs: { max: 0 } });
    const out = describeElement("stub:out:sym:src/a.ts#A.run->ghost:more:out", model, vd);
    expect(out.targets?.map((t) => t.target)).toEqual(["file:src/b.ts"]);
    expect(out.facts).toContainEqual({ label: "Outside", value: "+1 more" });
  });
});
