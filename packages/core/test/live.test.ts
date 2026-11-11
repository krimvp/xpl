import { describe, expect, it } from "vitest";
import {
  boxChangeWords,
  ExplainerModel,
  liftChange,
  liveSummary,
  removedBoxes,
  type ChangeRecord,
  type GraphView,
  type Node,
} from "../src/index.js";
import { emptyExplainer, graphView, group, LLM, makeWorld, textWith } from "./helpers.js";

/**
 * A live guide in small: the system map holds the service, which opens the map of its parts (a folder and a
 * file), and the folder opens the map of its files. The change edits `store/memory.ts` inside a function, adds
 * `store/disk.ts`, deletes `store/legacy.ts` and the whole folder `src/old`, and edits a test.
 */
const world = makeWorld({
  commit: "wt-1",
  files: [
    { path: "src/main.ts", lines: 10 },
    { path: "src/store/memory.ts", text: textWith(12) },
    { path: "src/store/disk.ts", lines: 5 },
    { path: "src/fresh/a.ts", lines: 3 },
    { path: "test/main.test.ts", lines: 10 },
  ],
  symbols: [
    { id: "src/store/memory.ts#MemoryStore", kind: "class", start: 1, end: 6 },
    { id: "src/store/memory.ts#evict", kind: "function", start: 8, end: 12 },
    { id: "src/store/disk.ts#DiskStore", kind: "class", start: 1, end: 5 },
  ],
});

const CHANGE: ChangeRecord = {
  base: "a".repeat(40),
  head: "wt-1",
  worktree: true,
  files: [
    {
      path: "src/store/memory.ts",
      status: "modified",
      hunks: [{ oldStart: 7, oldLines: 0, newStart: 8, newLines: 5 }],
    },
    {
      path: "src/store/disk.ts",
      status: "added",
      hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 5 }],
    },
    {
      path: "src/fresh/a.ts",
      status: "added",
      hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 3 }],
    },
    {
      path: "src/store/legacy.ts",
      status: "deleted",
      hunks: [{ oldStart: 1, oldLines: 4, newStart: 0, newLines: 0 }],
    },
    {
      path: "src/old/one.ts",
      status: "deleted",
      hunks: [{ oldStart: 1, oldLines: 2, newStart: 0, newLines: 0 }],
    },
    {
      path: "src/old/two.ts",
      status: "deleted",
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0 }],
    },
    {
      path: "test/main.test.ts",
      status: "modified",
      hunks: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 }],
    },
  ],
};

const dir = (path: string, over: Partial<Node> = {}): Node => ({
  id: `dir:${path}`,
  kind: "dir",
  label: `TODO: 1-3 plain words for this part (now: ${path.split("/").pop()})`,
  parent: "dir:src",
  anchors: [],
  provenance: LLM,
  ...over,
});

function model(over: { tour?: boolean } = {}): ExplainerModel {
  const views: GraphView[] = [
    graphView("view:system", ["grp:app"]),
    graphView("view:overview", ["dir:src/store", "dir:src/fresh", "file:src/main.ts"]),
    graphView("view:map-src-store", ["file:src/store/memory.ts", "file:src/store/disk.ts"]),
  ];
  return new ExplainerModel(
    emptyExplainer({
      index: { path: ".explainer/index-wt-1.json", commit: "wt-1" },
      change: CHANGE,
      nodes: [
        group("grp:app", ["dir:src/store", "dir:src/fresh", "file:src/main.ts"], {
          opens: "view:overview",
          role: "service",
        }),
        dir("src/store", { opens: "view:map-src-store" }),
        dir("src/fresh"),
      ],
      views,
      tours: over.tour
        ? [
            {
              id: "tour:live",
              title: "Jobs survive a restart",
              summary: "A disk store keeps jobs.",
              steps: [
                {
                  id: "part-src-store",
                  view: "view:map-src-store",
                  focus: ["file:src/store/disk.ts"],
                  note: "### Jobs go to disk\n\nBefore: memory only. Now: a disk store.",
                },
              ],
            },
          ]
        : [],
    }),
    world.index,
  );
}

describe("liftChange: a change deep in a file lights every level above it", () => {
  it("marks the file, its part and the service, each with what it holds", () => {
    const lifted = liftChange(model(), CHANGE, [
      "grp:app",
      "dir:src/store",
      "dir:src/fresh",
      "file:src/store/memory.ts",
      "file:src/store/disk.ts",
      "file:src/main.ts",
      "sym:src/store/memory.ts#evict",
      "sym:src/store/memory.ts#MemoryStore",
    ]);
    const words = Object.fromEntries([...lifted].map(([id, c]) => [id, boxChangeWords(c)]));
    expect(words).toEqual({
      // the service holds its parts' changes, deleted files of a part included; the test is in no part
      "grp:app": "1 changed · 2 new · 3 removed",
      "dir:src/store": "1 changed · 1 new · 1 removed",
      // a folder all of whose files are new is new itself, not a container of changes
      "dir:src/fresh": "New",
      "file:src/store/memory.ts": "Changed",
      "file:src/store/disk.ts": "New",
      "sym:src/store/memory.ts#evict": "New",
    });
    expect(lifted.get("dir:src/store")!.status).toBe("inside");
    expect(lifted.get("grp:app")!.lines).toEqual({ added: 13, removed: 7 });
  });

  it("marks nothing without a change in the box's code", () => {
    const lifted = liftChange(model(), { ...CHANGE, files: [] }, ["grp:app", "dir:src/store"]);
    expect(lifted.size).toBe(0);
  });
});

describe("removedBoxes: deleted files on the map of their folder", () => {
  it("draws a deleted file on its folder's map, and a deleted folder on its parent's", () => {
    const m = model();
    const boxes = (id: string) =>
      removedBoxes(m, CHANGE, m.view(id) as GraphView).map((b) => [b.id, b.kind, b.label]);
    expect(boxes("view:map-src-store")).toEqual([
      ["removed:src/store/legacy.ts", "file", "legacy.ts"],
    ]);
    // legacy.ts counts on the store box that is drawn there; the gone folder is a box of its own
    expect(boxes("view:overview")).toEqual([["removed:src/old", "dir", "old"]]);
    expect(boxes("view:system")).toEqual([]);
  });
});

describe("liveSummary: the changed parts, with their files", () => {
  it("lists each changed part with its files, symbols and where each box is", () => {
    const summary = liveSummary(model(), CHANGE);
    expect(summary.totals).toEqual({ files: 7, added: 14, removed: 8 });
    expect(
      summary.parts.map((p) => [
        p.id,
        p.label,
        boxChangeWords(p.change),
        p.files.map((f) => f.path),
      ]),
    ).toEqual([
      [
        "dir:src/store",
        "TODO: 1-3 plain words for this part (now: store)",
        "1 changed · 1 new · 1 removed",
        ["src/store/memory.ts", "src/store/disk.ts", "src/store/legacy.ts"],
      ],
      [
        "dir:src/fresh",
        "TODO: 1-3 plain words for this part (now: fresh)",
        "New",
        ["src/fresh/a.ts"],
      ],
      ["removed:src/old", "old", "Removed", ["src/old/one.ts", "src/old/two.ts"]],
    ]);
    const store = summary.parts[0]!.files;
    expect(store.map((f) => [f.path, f.box, f.symbols])).toEqual([
      [
        "src/store/memory.ts",
        { id: "file:src/store/memory.ts", view: "view:map-src-store" },
        [{ name: "evict", status: "new" }],
      ],
      [
        "src/store/disk.ts",
        { id: "file:src/store/disk.ts", view: "view:map-src-store" },
        [{ name: "DiskStore", status: "new" }],
      ],
      [
        "src/store/legacy.ts",
        { id: "removed:src/store/legacy.ts", view: "view:map-src-store" },
        [],
      ],
    ]);
    expect(summary.elsewhere.map((f) => f.path)).toEqual(["test/main.test.ts"]);
  });

  it("takes a part's explanation from its tour:live step", () => {
    const m = model({ tour: true });
    const summary = liveSummary(m, CHANGE, m.tour("tour:live"));
    expect(summary.parts[0]!.note).toContain("Before: memory only.");
    expect(summary.parts[0]!.stepId).toBe("part-src-store");
    expect(summary.parts[1]!.note).toBeUndefined();
  });
});
