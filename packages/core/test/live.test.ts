import { describe, expect, it } from "vitest";
import {
  boxChangeWords,
  DESIGN_VIEW_ID,
  designFiles,
  designLevel,
  designStepId,
  ExplainerModel,
  liveTrail,
  liftChange,
  lintExplainer,
  liveSummary,
  removedBoxes,
  validateExplainer,
  type ChangeRecord,
  type Explainer,
  type TourStep,
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

/** A base anchor on the whole of a file the change deleted: code a design box held before the change. */
const baseFile = (file: string) =>
  ({
    file,
    at: "base",
    role: "definition",
    hash: "sha256-v2:x",
    resolved: { commit: CHANGE.base, range: { startLine: 1, endLine: 2 }, status: "ok" },
  }) as const;

/**
 * The same guide with a design level: boxes of the change's design concepts that cut across folders, on
 * `view:design`. The store box holds the store folder and the deleted `src/old/one.ts` (moved without git mv);
 * the old box held only deleted code; the idea is a sketch.
 */
function designModel(): ExplainerModel {
  const base = model({ tour: true });
  const ex = base.explainer;
  return new ExplainerModel(
    {
      ...ex,
      nodes: [
        ...ex.nodes,
        group("grp:design-store", ["dir:src/store"], {
          label: "Job storage",
          anchors: [baseFile("src/old/one.ts")],
        }),
        group("grp:design-fresh", ["dir:src/fresh"], { label: "Fresh start" }),
        group("grp:design-old", [], { label: "Old path", anchors: [baseFile("src/old/two.ts")] }),
        group("grp:design-idea", [], { label: "Later idea", sketch: true, role: "component" }),
        group("grp:design-main", ["file:src/main.ts"], { label: "Entry" }),
      ],
      views: [
        ...ex.views,
        graphView("view:design", [
          "grp:design-store",
          "grp:design-fresh",
          "grp:design-old",
          "grp:design-idea",
          "grp:design-main",
        ]),
      ],
      tours: [
        {
          ...ex.tours[0]!,
          steps: [
            ...ex.tours[0]!.steps,
            {
              id: "design-store",
              view: "view:design",
              focus: ["grp:design-store"],
              note: "### Storage moves to disk\n\nBefore: memory. Now: disk.",
            },
          ],
        },
      ],
    },
    world.index,
  );
}

describe("the design level of a live guide", () => {
  it("counts code a design box held before the change as removed, and a box of only deleted code as removed", () => {
    const lifted = liftChange(designModel(), CHANGE, [
      "grp:design-store",
      "grp:design-fresh",
      "grp:design-old",
      "grp:design-idea",
      "grp:design-main",
    ]);
    expect(Object.fromEntries([...lifted].map(([id, c]) => [id, boxChangeWords(c)]))).toEqual({
      "grp:design-store": "1 changed · 1 new · 2 removed",
      "grp:design-fresh": "New",
      "grp:design-old": "Removed",
    });
    expect(lifted.get("grp:design-old")!.status).toBe("removed");
  });

  it("takes a box of only code the change deleted as pointing at code, not as a box without members", () => {
    const ex = designModel().explainer;
    const empty = group("grp:design-empty", [], { label: "Nothing" });
    const warned = validateExplainer(
      { ...ex, nodes: [...ex.nodes, empty] },
      world.index,
      world.getText,
    )
      .filter((i) => i.message.endsWith("has no members"))
      .map((i) => i.elementId);
    expect(warned).toEqual(["grp:design-empty"]);
  });

  it("is a lens of the parts' level, under the system map on the trail", () => {
    const m = designModel();
    const level = designLevel(m)!;
    expect([level.view.id, level.of.id]).toEqual([DESIGN_VIEW_ID, "view:overview"]);
    const trail = (id: string) => liveTrail(m, id).map((l) => [l.view.id, l.box]);
    expect(trail(DESIGN_VIEW_ID)).toEqual([["view:system", "grp:app"]]);
    expect(trail("view:map-src-store")).toEqual([
      ["view:system", "grp:app"],
      ["view:overview", "dir:src/store"],
    ]);
    expect(designLevel(model())).toBeUndefined();
    expect(designStepId("grp:design-store")).toBe("design-store");
    expect([...designFiles(m, "grp:design-store")]).toEqual([
      "src/store/disk.ts",
      "src/store/memory.ts",
    ]);
  });

  it("is a lens of the system map when the project has several programs", () => {
    const ex = designModel().explainer;
    // two programs on the system map, each opening the map of its inside
    const two = new ExplainerModel(
      {
        ...ex,
        nodes: ex.nodes.map((n) =>
          n.id === "dir:src/fresh" ? { ...n, opens: "view:fresh-inside" } : n,
        ),
        views: [
          ...ex.views.map((v) =>
            v.id === "view:system"
              ? graphView("view:system", ["dir:src/store", "dir:src/fresh"])
              : v,
          ),
          graphView("view:fresh-inside", ["file:src/fresh/a.ts"]),
        ],
      },
      world.index,
    );
    expect(designLevel(two)?.of.id).toBe("view:system");
    expect(liveTrail(two, DESIGN_VIEW_ID)).toEqual([]);
  });

  it("lists the changed design boxes first in What changed, with their notes and files", () => {
    const m = designModel();
    const summary = liveSummary(m, CHANGE, m.tour("tour:live"));
    expect(
      summary.design?.boxes.map((b) => [
        b.id,
        b.label,
        boxChangeWords(b.change),
        b.stepId ?? null,
        b.files.map((f) => f.path),
      ]),
    ).toEqual([
      [
        "grp:design-store",
        "Job storage",
        "1 changed · 1 new · 2 removed",
        "design-store",
        ["src/store/memory.ts", "src/store/disk.ts", "src/store/legacy.ts", "src/old/one.ts"],
      ],
      ["grp:design-fresh", "Fresh start", "New", null, ["src/fresh/a.ts"]],
      ["grp:design-old", "Old path", "Removed", null, ["src/old/two.ts"]],
    ]);
    expect(summary.design?.boxes[0]!.note).toContain("Before: memory.");
    expect(summary.design?.view).toBe("view:design");
    expect(summary.design?.outside.map((f) => f.path)).toEqual(["test/main.test.ts"]);
    // the folder list stays as it is
    expect(summary.parts.map((p) => p.id)).toEqual([
      "dir:src/store",
      "dir:src/fresh",
      "removed:src/old",
    ]);
    expect(liveSummary(model(), CHANGE).design).toBeUndefined();
  });
});

describe("lint of the design level", () => {
  /** The design guide with `edit` applied to its explainer; its design findings as [element, message]. */
  function designFindings(edit: (ex: Explainer) => Explainer, from = designModel()) {
    const ex = edit(from.explainer);
    return lintExplainer(ex, new ExplainerModel(ex, world.index))
      .findings.filter((f) => f.rule.startsWith("design-"))
      .map((f) => [f.rule, f.elementId, f.message]);
  }
  const withNodes = (ex: Explainer, over: Record<string, Partial<Node>>): Explainer => ({
    ...ex,
    nodes: ex.nodes.map((n) => (over[n.id] ? { ...n, ...over[n.id] } : n)),
  });
  const withSteps = (ex: Explainer, steps: TourStep[]): Explainer => ({
    ...ex,
    tours: ex.tours.map((t) => ({ ...t, steps: [...t.steps, ...steps] })),
  });
  const designStep = (note: string): TourStep => ({
    id: "design",
    view: "view:design",
    focus: ["grp:design-store"],
    note,
  });

  it("checks what is on the design map, the members, and the steps that walk it", () => {
    const found = designFindings((ex) => {
      const edited = withNodes(ex, {
        "grp:design-fresh": {
          members: ["dir:src/fresh", "file:src/store/disk.ts", "sym:src/store/memory.ts#evict"],
        },
      });
      return withSteps(
        {
          ...edited,
          views: edited.views.map((v) =>
            v.id === "view:design" && v.type === "graph"
              ? { ...v, include: [...v.include, "dir:src/store"] }
              : v,
          ),
        },
        [designStep("### Jobs move to disk\n\nBefore: memory. Now: disk.")],
      );
    });
    expect(found).toEqual([
      [
        "design-level",
        "view:design",
        "dir:src/store is on view:design but is not a design box (grp:design-<slug>), a sketch or an outside box",
      ],
      [
        "design-level",
        "grp:design-fresh",
        "member sym:src/store/memory.ts#evict of grp:design-fresh is not a file: or dir: id",
      ],
      [
        "design-level",
        "grp:design-fresh",
        "src/store/disk.ts is in two design boxes (grp:design-store, grp:design-fresh): give it to the one whose job it serves",
      ],
      ["design-level", "tour:live/design", 'the design step names no risk: end it with "Risk: …"'],
      [
        "design-level",
        "tour:live",
        "design box grp:design-fresh changed but tour:live has no step design-fresh",
      ],
      [
        "design-level",
        "tour:live",
        "design box grp:design-old changed but tour:live has no step design-old",
      ],
    ]);
  });

  it("asks for a design level once a change spans two parts, and none on other guides", () => {
    const m = model({ tour: true });
    const findings = (mm: ExplainerModel) =>
      lintExplainer(mm.explainer, mm)
        .findings.filter((f) => f.rule.startsWith("design-"))
        .map((f) => [f.elementId, f.message]);
    expect(findings(m)).toEqual([
      ["tour:live", "the change touches 3 parts but the guide has no design level"],
    ]);
    expect(findings(model())).toEqual([]);
  });

  it("keeps code out of the top text, and lists added files in no design box", () => {
    const found = designFindings((ex) =>
      withSteps(
        {
          ...withNodes(ex, {
            "grp:design-store": { label: "Store box", summary: "Moves `MemoryStore` to disk." },
            "grp:design-fresh": {
              members: [],
              summary: "Starts over in src/fresh/ with a clean slate.",
            },
            "grp:design-main": { summary: "Calls runJob first." },
            // plain words that are also code literals in some language pass
            "grp:design-old": { summary: "Keeps the old path true to the code, or null." },
          }),
          tours: ex.tours.map((t) => ({ ...t, title: "Jobs in disk.ts" })),
        },
        [
          designStep(
            "### Storage moves to disk\n\nBefore: memory. Now: disk.\n\nRisk: jobs written twice.",
          ),
          ...["design-fresh", "design-old"].map((id) => ({
            id,
            view: "view:design",
            focus: [`grp:${id}`],
            note: "### A box\n\nBefore: none. Now: one.",
          })),
        ],
      ),
    );
    expect(found).toEqual([
      [
        "design-words",
        "tour:live",
        '"disk.ts" names code (a path, a code span or an identifier) in the top text of the design level',
      ],
      [
        "design-words",
        "grp:design-store",
        '"MemoryStore" names code (a path, a code span or an identifier) in the top text of the design level',
      ],
      [
        "design-words",
        "grp:design-fresh",
        '"src/fresh/" names code (a path, a code span or an identifier) in the top text of the design level',
      ],
      [
        "design-words",
        "grp:design-main",
        '"runJob" names code (a path, a code span or an identifier) in the top text of the design level',
      ],
      ["design-unassigned", "view:design", "1 added file is in no design box: src/fresh/a.ts"],
    ]);
  });
});
