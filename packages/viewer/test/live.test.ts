/**
 * The live page (`ViewerBundle.mode: "live"`): where it opens, what the lenses draw, what a poll marks as new, and
 * the status words. The world is test/world.ts with a system map on top of its overview and a change record.
 */
import { describe, expect, it } from "vitest";
import type { ChangeRecord, Explainer, GraphView, LiveStatus } from "@xpl/core";
import { getDerived } from "../src/derive.js";
import { baseWords, explanationWords, freshFiles } from "../src/live.js";
import { ViewerStore } from "../src/store.js";
import { makeBundle } from "./world.js";

const CHANGE: ChangeRecord = {
  base: "a".repeat(40),
  head: "wt-1",
  worktree: true,
  files: [
    {
      path: "src/b.ts",
      status: "added",
      hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 20 }],
    },
    {
      path: "src/a.ts",
      status: "modified",
      hunks: [{ oldStart: 7, oldLines: 1, newStart: 7, newLines: 1 }],
    },
    {
      path: "config/old.yaml",
      status: "deleted",
      hunks: [{ oldStart: 1, oldLines: 3, newStart: 0, newLines: 0 }],
    },
  ],
};

/** The world's guide with a system map (after the overview in the file) and the change. */
function liveBundle(change: ChangeRecord | undefined = CHANGE) {
  const bundle = makeBundle({ mode: "live" });
  const explainer: Explainer = {
    ...bundle.explainer,
    ...(change ? { change } : {}),
    nodes: bundle.explainer.nodes.map((n) =>
      n.id === "grp:core" ? { ...n, opens: "view:overview" } : n,
    ),
    views: [
      // the overview draws the files themselves: the level a removed file belongs on
      ...bundle.explainer.views.map((v) =>
        v.id === "view:overview" && v.type === "graph"
          ? ({
              ...v,
              include: ["file:src/a.ts", "file:src/b.ts", "file:config/c.yaml"],
            } as GraphView)
          : v,
      ),
      {
        id: "view:system",
        type: "graph",
        title: "TODO: the big picture in plain words",
        scope: { root: "repo", depth: 1 },
        include: ["grp:core"],
        provenance: { origin: "llm" },
      } satisfies GraphView,
    ],
  };
  return { ...bundle, explainer, baseFiles: { "config/old.yaml": "a\nb\nc\n" } };
}

const drawn = (store: ViewerStore) =>
  getDerived(store.getState()).view.graph!.nodes.map((n) => n.id);

describe("a live page", () => {
  it("opens on the system map, whatever view comes first, unless the address names one", () => {
    expect(new ViewerStore(liveBundle()).getState().viewId).toBe("view:system");
    expect(new ViewerStore(liveBundle(), { view: "view:flow" }).getState().viewId).toBe(
      "view:flow",
    );
    // `?mode=explore` is the full Explore page of the same guide
    const explore = new ViewerStore(liveBundle(), { mode: "explore" }).getState();
    expect(explore.live).toBeUndefined();
  });

  it("draws removed boxes in Changes, hides new ones in Before, and draws the code as it is in Now", () => {
    const store = new ViewerStore(liveBundle());
    store.setView("view:overview");
    expect(drawn(store)).toEqual([
      "file:config/c.yaml",
      "file:src/a.ts",
      "file:src/b.ts",
      "removed:config/old.yaml",
    ]);
    store.setLens("before");
    expect(drawn(store)).toEqual([
      "file:config/c.yaml",
      "file:src/a.ts",
      "removed:config/old.yaml",
    ]);
    store.setLens("now");
    expect(drawn(store)).toEqual(["file:config/c.yaml", "file:src/a.ts", "file:src/b.ts"]);
  });

  it("shows the code before the change in Before, and nothing of a file the change added", () => {
    const store = new ViewerStore(liveBundle());
    store.click("grp:core");
    const panes = () => getDerived(store.getState()).panes.map((p) => [p.file, p.side ?? "head"]);
    expect(panes()).toEqual([
      ["src/a.ts", "head"],
      ["src/b.ts", "head"],
    ]);
    store.setLens("before");
    expect(panes()).toEqual([["src/a.ts", "base"]]);
  });

  it("opens a removed box's code from the base", () => {
    const store = new ViewerStore(liveBundle());
    store.setView("view:overview");
    store.click("removed:config/old.yaml");
    const state = store.getState();
    expect([state.openedFile, state.openedBase, state.selection]).toEqual([
      "config/old.yaml",
      true,
      [],
    ]);
  });

  it("marks what a poll brought as new to the reader until they look, and pulses it once", () => {
    const store = new ViewerStore(liveBundle());
    const fresh = () => [...freshFiles(store.getState().live!.seen, CHANGE_2)];
    const CHANGE_2: ChangeRecord = {
      ...CHANGE,
      files: [
        ...CHANGE.files.slice(1),
        {
          path: "src/b.ts",
          status: "added",
          hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 21 }],
        },
      ],
    };
    expect(fresh()).toEqual(["src/b.ts"]);
    store.adoptExplainer({ ...store.getState().explainer, change: CHANGE_2 });
    expect([...store.getState().live!.pulse.files]).toEqual(["src/b.ts"]);
    expect(store.getState().live!.pulse.seq).toBe(1);
    store.markSeen();
    expect(fresh()).toEqual([]);
  });

  it("shows the changed code of a big part in Changes, even past the first panes", () => {
    const bundle = liveBundle({
      ...CHANGE,
      files: [
        {
          path: "src/many/f12.ts",
          status: "modified",
          hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }],
        },
      ],
    });
    // a folder of twelve files, the last one changed: more than a part's code shows at once
    const many = Array.from(
      { length: 12 },
      (_, i) => `src/many/f${String(i + 1).padStart(2, "0")}.ts`,
    );
    const index = {
      ...bundle.index,
      files: [
        ...bundle.index.files,
        ...many.map((path) => ({ path, language: "typescript" as const, hash: "h", lines: 1 })),
      ],
    };
    const files = { ...bundle.files, ...Object.fromEntries(many.map((p) => [p, "x\n"])) };
    const store = new ViewerStore({ ...bundle, index, files });
    store.select(["dir:src/many"]);
    const panes = () => getDerived(store.getState()).panes.map((p) => p.file);
    expect(panes()).toEqual(["src/many/f12.ts"]);
    store.setLens("now");
    expect(panes()).toHaveLength(10);
  });
});

describe("the status words", () => {
  const status = (over: Partial<LiveStatus["explanation"]> = {}, change = true): LiveStatus => ({
    schema: "xpl-live@1",
    guide: "live",
    state: "watching",
    updatedAt: null,
    index: "wt-1",
    base: { rev: "origin/main", sha: "a".repeat(40), how: "merge-base" },
    change: change ? { files: 1, added: 1, removed: 0 } : null,
    explanation: {
      backend: "none",
      state: "off",
      explainedAt: null,
      stale: false,
      error: null,
      ...over,
    },
    error: null,
  });

  it("names the base the way the reader chose it", () => {
    expect(baseWords(status().base)).toBe("since origin/main");
    expect(baseWords({ rev: "HEAD", sha: "b".repeat(40), how: "start" })).toBe("since you started");
    expect(baseWords({ rev: "v1.2", sha: "b".repeat(40), how: "since" })).toBe("since v1.2");
    expect(baseWords({ rev: "HEAD", sha: "b".repeat(40), how: "since" })).toBe(
      "since your last commit",
    );
  });

  it("says where the explanation stands", () => {
    expect(explanationWords(status(), true)).toBeUndefined();
    expect(explanationWords(status({ stale: true }), true)?.text).toBe(
      "The explanation is from before your latest edits.",
    );
    expect(explanationWords(status({ state: "running" }), true)?.text).toBe(
      "Writing the explanation…",
    );
    expect(explanationWords(status({ state: "failed", error: "no key" }), false)?.text).toBe(
      "The explanation could not be written: no key",
    );
    expect(explanationWords(status(), false)?.command).toBe("xpl live --backend claude");
    // nothing to explain without a change
    expect(explanationWords(status({}, false), false)).toBeUndefined();
  });
});
