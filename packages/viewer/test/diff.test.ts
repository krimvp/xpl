/**
 * The change view (iteration 2, task B): the diff of a changed file from its hunks, the map's "New" and
 * "Changed", the Guide's "Files in this change", and base anchors on their own "Before" panes.
 */
import {
  applyPatch,
  TextCache,
  type ChangedFile,
  type ChangeRecord,
  type Explainer,
  type ViewerBundle,
} from "@xpl/core";
import { describe, expect, it } from "vitest";
import { getDerived } from "../src/derive.js";
import {
  changeFiles,
  changeTreeWidth,
  changeOf,
  changeMarks,
  changeStatus,
  fileDiff,
  firstChangedLine,
  languageOfPath,
  needsBase,
  paneDiff,
} from "../src/diff.js";
import { ViewerStore } from "../src/store.js";
import { makeBundle, makeIndex, TEXTS } from "./world.js";

const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);

const modified = (hunks: ChangedFile["hunks"]): ChangedFile => ({
  path: "src/a.ts",
  status: "modified",
  hunks,
});

describe("the diff of a changed file", () => {
  it("marks rewritten lines as changed and puts the old ones above them", () => {
    // base 12-13 were rewritten as head 12-14
    const diff = fileDiff(modified([{ oldStart: 12, oldLines: 2, newStart: 12, newLines: 3 }]));
    expect([...diff.lines]).toEqual([
      [12, "changed"],
      [13, "changed"],
      [14, "changed"],
    ]);
    expect(diff.removed).toEqual([{ at: 12, place: "before", from: 12, to: 13 }]);
    expect([...diff.gone]).toEqual([12, 13]);
    expect([diff.added, diff.deleted]).toEqual([3, 2]);
  });

  it("marks inserted lines as added, with nothing removed", () => {
    // head 21-23 inserted after base line 19
    const diff = fileDiff(modified([{ oldStart: 19, oldLines: 0, newStart: 21, newLines: 3 }]));
    expect([...diff.lines.values()]).toEqual(["added", "added", "added"]);
    expect(diff.removed).toEqual([]);
    expect(diff.gone.size).toBe(0);
  });

  it("puts lines removed without a replacement below the head line they followed (git's start)", () => {
    // base line 7 removed; it came after head line 6
    const diff = fileDiff(modified([{ oldStart: 7, oldLines: 1, newStart: 6, newLines: 0 }]));
    expect(diff.lines.size).toBe(0);
    expect(diff.removed).toEqual([{ at: 6, place: "after", from: 7, to: 7 }]);
    // removed at the very top: above head line 1
    const top = fileDiff(modified([{ oldStart: 1, oldLines: 2, newStart: 0, newLines: 0 }]));
    expect(top.removed).toEqual([{ at: 1, place: "before", from: 1, to: 2 }]);
  });

  it("opens a changed file at its first change", () => {
    expect(
      firstChangedLine(
        modified([
          { oldStart: 40, oldLines: 1, newStart: 41, newLines: 1 },
          { oldStart: 7, oldLines: 1, newStart: 6, newLines: 0 },
        ]),
      ),
    ).toBe(6);
    expect(firstChangedLine({ path: "x.ts", status: "renamed", oldPath: "y.ts", hunks: [] })).toBe(
      1,
    );
  });

  it("gives the editor the removed text from the code before the change, or says it is missing", () => {
    const file = modified([{ oldStart: 2, oldLines: 2, newStart: 2, newLines: 1 }]);
    const base = ["one", "two", "three", "four"];
    expect(paneDiff(undefined, file, base, undefined)!.removed).toEqual([
      { at: 2, place: "before", from: 2, count: 2, text: ["two", "three"] },
    ]);
    expect(paneDiff(undefined, file, undefined, "not in this page")!.removed![0]).toMatchObject({
      count: 2,
      text: undefined,
      missing: "not in this page",
    });
    // a "Before" pane marks the base lines the change took out
    expect([...paneDiff("base", file, base, undefined)!.gone!]).toEqual([2, 3]);
    // an unchanged file has nothing to mark
    expect(paneDiff(undefined, undefined, undefined, undefined)).toBeNull();
  });

  it("locates changed words and whitespace in paired rewritten lines, even on long lines", () => {
    const file = modified([{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2 }]);
    const prefix = "x".repeat(4000);
    const before = [`${prefix} oldValue();`, "await   work();"];
    const after = [`${prefix} newValue();`, "await work();"];
    const head = paneDiff(undefined, file, before, undefined, after)!;
    const base = paneDiff("base", file, before, undefined, after)!;
    expect(after[0]!.slice(head.words!.get(1)!.from, head.words!.get(1)!.to)).toBe("newValue");
    expect(before[0]!.slice(base.words!.get(1)!.from, base.words!.get(1)!.to)).toBe("oldValue");
    expect(after[1]!.slice(head.words!.get(2)!.from, head.words!.get(2)!.to)).toBe(" ");
    expect(before[1]!.slice(base.words!.get(2)!.from, base.words!.get(2)!.to)).toBe("   ");
    expect([...head.lines!.keys()]).toEqual([1, 2]);
    expect(head.removed![0]).toMatchObject({ at: 1, from: 1, count: 2 });
  });
});

describe("the change on the map", () => {
  const index = makeIndex();
  // A.run is 5-20, A.stop 22-28, A 1-30, B.go 3-10 (world.ts)
  const change = (files: ChangedFile[]): ChangeRecord => ({ base: BASE, head: HEAD, files });
  const model = { symbol: (id: string) => index.symbols.find((s) => s.id === id) };

  it("a symbol is changed when touched or entirely replaced, new only for pure insertions", () => {
    const record = change([
      modified([
        { oldStart: 12, oldLines: 1, newStart: 12, newLines: 1 },
        { oldStart: 21, oldLines: 0, newStart: 22, newLines: 7 },
      ]),
    ]);
    expect(changeStatus("sym:src/a.ts#A.run", model, record)).toBe("changed");
    expect(changeStatus("sym:src/a.ts#A.stop", model, record)).toBe("new");
    expect(changeStatus("sym:src/a.ts#A", model, record)).toBe("changed");
    expect(changeStatus("file:src/a.ts", model, record)).toBe("changed");
    // untouched code and other kinds of box have none
    expect(changeStatus("sym:src/b.ts#B.go", model, record)).toBeUndefined();
    expect(changeStatus("file:src/b.ts", model, record)).toBeUndefined();
    expect(changeStatus("grp:core", model, record)).toBeUndefined();
    const replacement = change([
      modified([{ oldStart: 5, oldLines: 16, newStart: 5, newLines: 16 }]),
    ]);
    expect(changeStatus("sym:src/a.ts#A.run", model, replacement)).toBe("changed");
  });

  it("a group or directory is changed when a file it covers is; files and symbols keep their own status", () => {
    const record = change([modified([{ oldStart: 12, oldLines: 1, newStart: 12, newLines: 1 }])]);
    const files: Record<string, string[]> = {
      "grp:core": ["src/b.ts", "src/a.ts"],
      "grp:other": ["src/b.ts"],
      "dir:src": ["src/a.ts"],
    };
    const marks = changeMarks(
      ["grp:core", "grp:other", "dir:src", "sym:src/b.ts#B.go", "file:src/a.ts"],
      model,
      record,
      (id) => files[id] ?? ["src/a.ts"],
    );
    expect(Object.fromEntries(marks)).toEqual({
      "grp:core": "changed",
      "dir:src": "changed",
      "file:src/a.ts": "changed",
    });
    // without `filesOf`, as before: only files and symbols
    expect([...changeMarks(["grp:core"], model, record).keys()]).toEqual([]);
  });

  it("lines removed inside a symbol change it; an added file is new, with all it holds", () => {
    const removedInside = change([
      modified([{ oldStart: 9, oldLines: 2, newStart: 8, newLines: 0 }]),
    ]);
    expect(changeStatus("sym:src/a.ts#A.run", model, removedInside)).toBe("changed");
    expect(changeStatus("sym:src/a.ts#A.stop", model, removedInside)).toBeUndefined();
    const added = change([
      {
        path: "src/b.ts",
        status: "added",
        hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 20 }],
      },
    ]);
    expect(changeStatus("file:src/b.ts", model, added)).toBe("new");
    expect(changeStatus("sym:src/b.ts#B.go", model, added)).toBe("new");
  });
});

describe("the files in a change", () => {
  const record: ChangeRecord = {
    base: BASE,
    head: HEAD,
    files: [
      {
        path: "src/new.ts",
        status: "added",
        hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 9 }],
      },
      {
        path: "test/a.test.ts",
        status: "modified",
        hunks: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 4 }],
      },
      {
        path: "src/old.ts",
        status: "deleted",
        hunks: [{ oldStart: 1, oldLines: 5, newStart: 0, newLines: 0 }],
      },
      { path: "src/b.ts", status: "renamed", oldPath: "src/bee.ts", hunks: [] },
    ],
  };

  it("lists source files first, then tests, with what the change did and the line counts", () => {
    expect(changeFiles(record)).toEqual([
      { path: "src/new.ts", status: "added", added: 9, deleted: 0, test: false, line: 1 },
      { path: "src/old.ts", status: "deleted", added: 0, deleted: 5, test: false, line: 1 },
      {
        path: "src/b.ts",
        status: "renamed",
        oldPath: "src/bee.ts",
        added: 0,
        deleted: 0,
        test: false,
        line: 1,
      },
      { path: "test/a.test.ts", status: "modified", added: 4, deleted: 1, test: true, line: 3 },
    ]);
  });

  it("knows which files need the code before the change", () => {
    expect(needsBase(record, "test/a.test.ts")).toBe(true);
    expect(needsBase(record, "src/new.ts")).toBe(false);
    // a pure rename removes nothing
    expect(needsBase(record, "src/b.ts")).toBe(false);
    expect(languageOfPath("src/old.ts")).toBe("typescript");
    expect(languageOfPath("README")).toBe("text");
  });

  it("widens the tree to the longest changed name", () => {
    // "a.test.ts" two levels down: 8 + 2 * 14 + 9 * 7.2 + 36 = 136.8 (the CSS keeps the column at 160 or more)
    expect(changeTreeWidth(record)).toBe(137);
    const long: ChangeRecord = {
      ...record,
      files: [{ path: "test-d/a-really-long-file-name-for-a-test.ts", status: "added", hunks: [] }],
    };
    // at most 300
    expect(changeTreeWidth(long)).toBe(300);
    expect(changeTreeWidth(undefined)).toBeUndefined();
  });

  it("ignores a change record that validate would reject (a hand edit)", () => {
    expect(changeOf({ change: record })).toBe(record);
    expect(changeOf({ change: { base: "nope", head: HEAD, files: [] } as never })).toBeUndefined();
    expect(changeOf({})).toBeUndefined();
  });
});

describe("base anchors in the code", () => {
  // The base of src/a.ts: line 12 was "this.b.go(0);" and line 13 an extra call, rewritten as head line 12.
  const baseText = TEXTS["src/a.ts"]!.split("\n");
  baseText.splice(11, 1, "this.b.go(0);", "this.b.again();");
  const baseA = baseText.join("\n");
  const change: ChangeRecord = {
    base: BASE,
    head: HEAD,
    files: [modified([{ oldStart: 12, oldLines: 2, newStart: 12, newLines: 1 }])],
  };

  /** The world's bundle, as a change explainer: the base anchor on the concept, and one in tour step t3's code. */
  function changeBundle(): ViewerBundle {
    const bundle = makeBundle();
    const explainer: Explainer = { ...bundle.explainer, change };
    const texts = new TextCache(
      (file) => TEXTS[file],
      (commit, path) => (commit === BASE && path === "src/a.ts" ? baseA : undefined),
    );
    const result = applyPatch(
      explainer,
      {
        concepts: [
          {
            id: "concept:retry",
            anchors: [
              { file: "src/a.ts", symbol: "A.run", span: { from: 2, to: 4 }, role: "definition" },
              {
                file: "src/a.ts",
                at: "base",
                find: "this.b.go(0);\nthis.b.again();",
                role: "usage",
              },
              { file: "config/c.yaml", symbol: "retry", role: "config" },
            ],
          },
        ],
        tours: [
          {
            id: "tour:demo",
            stepsUpdate: [
              {
                id: "t3",
                code: [
                  { file: "src/a.ts", at: "base", find: "this.b.again();", role: "usage" },
                  { file: "src/a.ts", symbol: "A.run", span: { from: 7, to: 7 }, role: "usage" },
                ],
              },
            ],
          },
        ],
      },
      bundle.index,
      texts,
      { actor: "user" },
    );
    expect(result.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    return { ...bundle, explainer: result.explainer, baseFiles: { "src/a.ts": baseA } };
  }

  it("a selected element's base anchor gets a 'Before' pane of base lines; the head pane keeps head lines", () => {
    const store = new ViewerStore(changeBundle(), { view: "view:overview" });
    store.select(["concept:retry"]);
    const derived = getDerived(store.getState());
    expect(derived.selection.base.map((r) => [r.file, r.range.startLine, r.range.endLine])).toEqual(
      [["src/a.ts", 12, 13]],
    );
    // never drawn on the head file
    expect(
      derived.selection.focus.every((r) => r.range.startLine !== 13 || r.file !== "src/a.ts"),
    ).toBe(true);
    expect(derived.panes.map((p) => [p.file, p.side ?? "head"])).toEqual([
      ["src/a.ts", "head"],
      ["src/a.ts", "base"],
      ["config/c.yaml", "head"],
    ]);
    expect(store.getState().baseFiles["src/a.ts"]).toBe(baseA);
  });

  it("a tour step's code with a base anchor shows the base lines first when it names them first", () => {
    const store = new ViewerStore(changeBundle(), { view: "view:flow" });
    store.previewStep("tour:demo", 2);
    const derived = getDerived(store.getState());
    expect(derived.panes.map((p) => [p.file, p.side ?? "head", p.lead])).toEqual([
      ["src/a.ts", "base", 13],
      ["src/a.ts", "head", 12],
    ]);
    // the head pane's range is the head anchor only (the base line 13 is not drawn on the head file)
    expect(derived.panes[1]!.ranges.map((r) => [r.range.startLine, r.range.endLine])).toEqual([
      [12, 12],
    ]);
  });

  it("a static page without the code before the change says so; opening it from an anchor row goes there", async () => {
    const bundle = changeBundle();
    delete bundle.baseFiles;
    const store = new ViewerStore(bundle, { view: "view:overview" });
    await store.ensureBaseFile("src/a.ts");
    expect(store.getState().baseErrors["src/a.ts"]).toMatch(/not included in this page/);
    // a file the change did not touch has no "before"
    store.openFile("src/b.ts", 3, "base");
    expect(store.getState().openedFile).toBeUndefined();
    store.openFile("src/a.ts", 13, "base");
    const derived = getDerived(store.getState());
    expect(derived.panes[0]).toMatchObject({
      file: "src/a.ts",
      side: "base",
      opened: true,
      lead: 13,
    });
    expect(store.getState().cursor).toBeUndefined();
  });
});
