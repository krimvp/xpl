import { describe, expect, it } from "vitest";
import { ViewerStore } from "../src/store.js";
import { makeBundle } from "./world.js";
import { readLaunchParams } from "../src/data.js";
import { searchFor } from "../src/url.js";

describe("explanation workspace", () => {
  it("starts with the guide but preserves explicit explore and present launches", () => {
    expect(new ViewerStore(makeBundle()).getState().perspective).toBe("guide");
    expect(new ViewerStore(makeBundle(), { mode: "explore" }).getState().perspective).toBe(
      "explore",
    );
    expect(new ViewerStore(makeBundle(), { mode: "present" }).getState().mode).toBe("present");
  });

  it("keeps the selected topic and code override when changing perspectives", () => {
    const store = new ViewerStore(makeBundle());
    store.previewStep("tour:demo", 1);
    const before = store.getState();
    store.setPerspective("map");
    store.setPerspective("flow");
    store.setPerspective("code");
    expect(store.getState()).toMatchObject({
      perspective: "code",
      viewId: before.viewId,
      selection: before.selection,
      applied: before.applied,
    });
  });

  it("restores topics, perspectives, file positions and tour context through history", () => {
    const store = new ViewerStore(makeBundle());
    store.previewStep("tour:demo", 1);
    store.setPerspective("code");
    store.openFile("config/c.yaml", 3);
    store.select(["flow:2"]);
    store.back();
    expect(store.getState()).toMatchObject({
      perspective: "code",
      selection: ["flow:1", "concept:retry"],
      openedFile: "config/c.yaml",
      cursor: { file: "config/c.yaml", fromLine: 3, toLine: 3 },
    });
    store.back();
    expect(store.getState().openedFile).toBeUndefined();
    store.back();
    expect(store.getState().perspective).toBe("guide");
    expect(store.getState().applied?.stepId).toBe("t2");
    store.forward();
    expect(store.getState().perspective).toBe("code");
    store.select(["concept:retry"]);
    expect(store.getState().canGoForward).toBe(false);
  });

  it("round-trips perspective, guide context and selected topic in shared links", () => {
    const bundle = makeBundle();
    const store = new ViewerStore(bundle);
    store.previewStep("tour:demo", 1);
    store.setPerspective("flow");
    const next = new ViewerStore(
      bundle,
      readLaunchParams(searchFor(store.getState(), "", undefined)),
    );
    expect(next.getState()).toMatchObject({
      perspective: "flow",
      selection: store.getState().selection,
      applied: { stepId: "t2" },
    });
  });

  it("finds a guide section for a selected implementation", () => {
    const store = new ViewerStore(makeBundle());
    store.select(["flow:1"]);
    expect(store.readExplanation()).toBe(true);
    expect(store.getState()).toMatchObject({ perspective: "guide", applied: { stepId: "t2" } });
  });
});
