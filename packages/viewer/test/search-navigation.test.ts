import { expect, it } from "vitest";
import { BUNDLE_SCRIPT_ID, serializeBundle } from "@xpl/core";
import { loadBundle, readLaunchParams } from "../src/data.js";
import { ViewerStore } from "../src/store.js";
import { searchFor } from "../src/url.js";
import { makeBundle } from "./world.js";

it("opens inclusive source columns from a shared URL and ignores unavailable or malformed ranges", () => {
  const bundle = makeBundle();
  const launch = readLaunchParams("?file=src/a.ts&range=12:6-12:9");
  const state = new ViewerStore(bundle, launch).getState();
  expect(state.perspective).toBe("code");
  expect(state.openedFile).toBe("src/a.ts");
  expect(state.cursor).toEqual({
    file: "src/a.ts",
    fromLine: 12,
    toLine: 12,
    fromCol: 6,
    toCol: 9,
  });
  for (const params of [
    "?file=missing.ts&range=1:1-1:4",
    "?file=src/a.ts&range=12:50-12:90",
    "?file=src/a.ts&range=12:9-12:6",
    "?file=src/a.ts&range=NaN",
  ]) {
    expect(new ViewerStore(bundle, readLaunchParams(params)).getState().cursor).toBeUndefined();
  }
});

it("selects an embedded snapshot by stable key and retains the original guide for switching back", () => {
  const original = makeBundle();
  const other = {
    guideId: "retry.json",
    explainer: { ...original.explainer, title: "Retry guide" },
    index: { ...original.index, commit: "other" },
    files: { "src/a.ts": "other text" },
  };
  const library = { ...original, guideId: "repository", guides: [other] };
  const doc = {
    getElementById: (id: string) =>
      id === BUNDLE_SCRIPT_ID
        ? { textContent: serializeBundle(library, { packIndex: true }) }
        : null,
    location: { search: "?guide=retry.json" },
  } as unknown as Document;
  const loaded = loadBundle(doc);
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) throw new Error(loaded.error);
  expect(loaded.bundle.guideId).toBe("retry.json");
  expect(loaded.bundle.explainer.title).toBe("Retry guide");
  expect(loaded.bundle.files).toEqual(other.files);
  expect(loaded.bundle.index.commit).toBe("other");
  expect(loaded.bundle.server).toBeUndefined();
  expect(loaded.bundle.guides?.map((g) => g.guideId)).toEqual(["repository"]);
  Object.assign(doc.location, { search: "?guide=absent" });
  expect(loadBundle(doc)).toMatchObject({
    ok: false,
    error: expect.stringContaining("not included in this export"),
  });
});

it("prevents author changes in a read-only service preview", () => {
  const store = new ViewerStore({
    ...makeBundle(),
    readOnlyGuide: { command: "xpl service start guide" },
  });
  expect(() => store.captureEdit("concepts", "concept:retry", { summary: "Changed" })).toThrow(
    "read-only",
  );
  store.toggleEdgeKind("calls");
  expect(store.getState().dirty).toBe(false);
});

it("prefers the stable tour step ID over a numeric position after steps are reordered", () => {
  const bundle = makeBundle();
  const tour = bundle.explainer.tours[0]!;
  tour.steps = [tour.steps[1]!, tour.steps[0]!, tour.steps[2]!];
  const store = new ViewerStore(bundle, readLaunchParams("?tour=tour:demo&step=1&step-id=t1"));
  expect(store.getState().applied?.stepId).toBe("t1");
  expect(store.getState().tour?.step).toBe(1);
  expect(store.getState().selection).toEqual(["grp:core"]);
});

it("round-trips a base range in a deleted file and refuses an unknown side", () => {
  const bundle = makeBundle();
  bundle.explainer.change = {
    base: "a".repeat(40),
    head: "b".repeat(40),
    files: [{ path: "old.ts", status: "deleted", hunks: [] }],
  };
  bundle.baseFiles = { "old.ts": "old source\nsecond line" };
  const store = new ViewerStore(bundle, readLaunchParams("?file=old.ts&range=1:1-1:3&side=base"));
  expect(store.getState()).toMatchObject({
    perspective: "code",
    openedFile: "old.ts",
    openedBase: true,
    cursor: { file: "old.ts", fromLine: 1, toLine: 1, fromCol: 1, toCol: 3, side: "base" },
  });
  const reopened = new ViewerStore(
    bundle,
    readLaunchParams(searchFor(store.getState(), "", undefined)),
  );
  expect(reopened.getState().cursor).toEqual({
    file: "old.ts",
    fromLine: 1,
    toLine: 1,
    fromCol: 1,
    toCol: 3,
    side: "base",
  });
  expect(readLaunchParams("?file=src/a.ts&range=1-2&side=unknown").range).toBeUndefined();
});
