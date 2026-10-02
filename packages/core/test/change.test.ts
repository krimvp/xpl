import { describe, expect, it } from "vitest";
import {
  analyzeChange,
  applyPatch,
  baseAnchorFocus,
  baseFileOf,
  changeShapeIssues,
  codeFocus,
  ExplainerModel,
  headPathsOf,
  makeAnchor,
  reresolveExplainer,
  resolveWith,
  TextCache,
  validateExplainer,
  type Anchor,
  type ChangeRecord,
  type Explainer,
} from "../src/index.js";
import { concept, emptyExplainer, makeWorld, textWith, type World } from "./helpers.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

/**
 * A tiny change: `src/app.ts` gets a new helper (lines 10-12) and an edited `serve` (line 5), `src/old.ts` is
 * deleted, `src/moved.ts` was `src/before.ts`, `src/added.ts` is new, and the test file gains a test.
 */
const APP = textWith(20, {
  1: "export class App {",
  3: "  serve() {",
  5: "    return this.helper();",
  7: "  }",
  9: "  // a new helper",
  10: "  helper() {",
  11: "    return 1;",
  12: "  }",
  14: "  __call__() {",
  16: "  }",
  17: "}",
  19: "export const LIMIT = 3;",
  20: "start();",
});
const APP_BASE = textWith(17, {
  1: "export class App {",
  3: "  serve() {",
  5: "    return 0;",
  7: "  }",
  11: "  __call__() {",
  13: "  }",
  14: "}",
  16: "export const LIMIT = 3;",
});

function world(): World {
  return makeWorld({
    commit: "bbbbbbb",
    files: [
      { path: "src/app.ts", text: APP },
      { path: "src/main.ts", lines: 10 },
      { path: "src/moved.ts", lines: 5 },
      { path: "src/added.ts", lines: 5 },
      { path: "test/app.test.ts", lines: 30 },
    ],
    symbols: [
      { id: "src/app.ts#App", kind: "class", start: 1, end: 17 },
      { id: "src/app.ts#App.serve", start: 3, end: 7 },
      { id: "src/app.ts#App.helper", start: 10, end: 12 },
      { id: "src/app.ts#App.__call__", start: 14, end: 16 },
      { id: "src/app.ts#LIMIT", kind: "variable", start: 19, end: 19 },
      { id: "src/main.ts#main", kind: "function", start: 1, end: 9 },
      { id: "test/app.test.ts#serves", kind: "function", start: 2, end: 10 },
      { id: "test/app.test.ts#helps", kind: "function", start: 12, end: 20 },
      { id: "test/app.test.ts#helps.inner", kind: "function", start: 14, end: 16 },
    ],
    refs: [
      { from: "src/app.ts#App.serve", to: "src/app.ts#App.helper", line: 5 },
      { from: "src/main.ts#main", to: "src/app.ts#App.serve", line: 3 },
      { from: "src/main.ts#main", to: "src/app.ts#App", line: 2 },
      { from: "src/main.ts#main", to: "src/app.ts#LIMIT", kind: "read", line: 4 },
      { from: "test/app.test.ts#serves", to: "src/app.ts#App.serve", line: 4 },
      { from: "test/app.test.ts#serves", to: "src/app.ts#App", line: 3 },
      { from: "test/app.test.ts#", to: "src/app.ts#App", kind: "import", line: 1 },
    ],
  });
}

const CHANGE: ChangeRecord = {
  base: BASE,
  head: HEAD,
  files: [
    {
      path: "src/app.ts",
      status: "modified",
      hunks: [
        { oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 },
        { oldStart: 8, oldLines: 0, newStart: 9, newLines: 4 },
      ],
    },
    {
      path: "src/added.ts",
      status: "added",
      hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 5 }],
    },
    { path: "src/moved.ts", status: "renamed", oldPath: "src/before.ts", hunks: [] },
    {
      path: "src/old.ts",
      status: "deleted",
      hunks: [{ oldStart: 1, oldLines: 3, newStart: 0, newLines: 0 }],
    },
    {
      path: "test/app.test.ts",
      status: "modified",
      hunks: [{ oldStart: 11, oldLines: 0, newStart: 12, newLines: 9 }],
    },
  ],
};

const BASE_TEXTS: Record<string, string> = {
  "src/app.ts": APP_BASE,
  "src/before.ts": "one\ntwo\nthree\n",
  "src/old.ts": "gone\nfor\ngood\n",
  "test/app.test.ts": textWith(21),
};

function texts(w: World): TextCache {
  return new TextCache(w.getText, (commit, path) =>
    commit === BASE ? BASE_TEXTS[path] : undefined,
  );
}

function withChange(over: Partial<Explainer> = {}): Explainer {
  return emptyExplainer({
    index: { path: ".explainer/index-bbbbbbb.json", commit: "bbbbbbb" },
    change: JSON.parse(JSON.stringify(CHANGE)),
    ...over,
  });
}

// ─── The record ─────────────────────────────────────────────────────────────────────────────────

describe("change record", () => {
  it("finds files by path or old path; only modified, renamed and deleted files have a base", () => {
    expect(baseFileOf(CHANGE, "src/app.ts")?.status).toBe("modified");
    expect(baseFileOf(CHANGE, "src/before.ts")?.path).toBe("src/moved.ts");
    expect(baseFileOf(CHANGE, "src/old.ts")?.status).toBe("deleted");
    expect(baseFileOf(CHANGE, "src/added.ts")).toBeUndefined();
    expect(baseFileOf(CHANGE, "src/main.ts")).toBeUndefined();
    expect(headPathsOf(CHANGE)).toEqual([
      "src/app.ts",
      "src/added.ts",
      "src/moved.ts",
      "test/app.test.ts",
    ]);
  });

  it("checks the shape: full SHAs, statuses, oldPath only for renames, whole-number hunks", () => {
    expect(changeShapeIssues(CHANGE)).toEqual([]);
    const bad = changeShapeIssues({
      base: "abc",
      head: HEAD,
      files: [
        { path: "a", status: "moved", hunks: [] },
        { path: "a", status: "renamed", hunks: [{ oldStart: 1 }] },
        { path: "b", status: "added", oldPath: "c", hunks: "x" },
      ],
    });
    expect(bad.map((i) => i.path)).toEqual([
      "change.base",
      "change.files[0].status",
      "change.files[1].path",
      "change.files[1].oldPath",
      "change.files[1].hunks[0]",
      "change.files[2].oldPath",
      "change.files[2].hunks",
    ]);
    expect(changeShapeIssues("x")[0]!.message).toContain("xpl change");
  });
});

// ─── Analysis ───────────────────────────────────────────────────────────────────────────────────

describe("analyzeChange", () => {
  const w = world();
  const analysis = analyzeChange(CHANGE, w.model, w.getText);

  it("lists the files with their line counts", () => {
    expect(analysis.files.map((f) => [f.path, f.status, f.added, f.removed, f.test])).toEqual([
      ["src/app.ts", "modified", 5, 1, false],
      ["src/added.ts", "added", 5, 0, false],
      ["src/moved.ts", "renamed", 0, 0, false],
      ["src/old.ts", "deleted", 0, 3, false],
      ["test/app.test.ts", "modified", 9, 0, true],
    ]);
    expect(analysis.totals).toEqual({ files: 5, added: 19, removed: 4 });
  });

  it("finds the changed symbols: new when every line was added; a comment between methods counts for nothing", () => {
    expect(analysis.symbols.map((s) => [s.id, s.status, s.lines])).toEqual([
      ["sym:src/app.ts#App.serve", "changed", [5]],
      ["sym:src/app.ts#App.helper", "new", [10, 11, 12]],
    ]);
  });

  it("gives direct callers outside tests, and the tests that reference a symbol", () => {
    const serve = analysis.symbols[0]!;
    expect(serve.callers.map((c) => [c.id, c.lines])).toEqual([["sym:src/main.ts#main", [3]]]);
    expect(serve.tests.map((t) => t.id)).toEqual(["sym:test/app.test.ts#serves"]);
    const helper = analysis.symbols[1]!;
    // the caller is part of the change itself
    expect(helper.callers).toEqual([
      expect.objectContaining({ id: "sym:src/app.ts#App.serve", changed: "changed" }),
    ]);
    expect(helper.tests).toEqual([]);
    expect(analysis.untested).toEqual(["sym:src/app.ts#App.helper"]);
  });

  it("lists the tests the change touches, not the helpers nested in them", () => {
    expect(analysis.testSymbols.map((s) => [s.id, s.status])).toEqual([
      ["sym:test/app.test.ts#helps", "new"],
    ]);
  });

  it("a method run through an instance gets the code that builds its class, as a guess", () => {
    const change: ChangeRecord = {
      base: BASE,
      head: HEAD,
      files: [
        {
          path: "src/app.ts",
          status: "modified",
          hunks: [{ oldStart: 12, oldLines: 1, newStart: 15, newLines: 1 }],
        },
      ],
    };
    const [call] = analyzeChange(change, w.model, w.getText).symbols;
    expect(call!.id).toBe("sym:src/app.ts#App.__call__");
    expect(call!.callers).toEqual([]);
    expect(call!.viaInstance).toEqual([
      expect.objectContaining({ id: "sym:src/main.ts#main", via: "instance", lines: [2] }),
    ]);
    // a test that builds the class counts (the import of the whole file does not add a second entry)
    expect(call!.tests).toEqual([
      expect.objectContaining({ id: "sym:test/app.test.ts#serves", via: "instance" }),
    ]);
  });

  it("a variable's users are its readers; module-level lines are reported apart", () => {
    const change: ChangeRecord = {
      base: BASE,
      head: HEAD,
      files: [
        {
          path: "src/app.ts",
          status: "modified",
          hunks: [
            { oldStart: 16, oldLines: 1, newStart: 19, newLines: 1 },
            { oldStart: 17, oldLines: 0, newStart: 20, newLines: 1 },
          ],
        },
      ],
    };
    const result = analyzeChange(change, w.model, w.getText);
    expect(result.symbols.map((s) => s.id)).toEqual(["sym:src/app.ts#LIMIT"]);
    expect(result.symbols[0]!.callers).toEqual([
      expect.objectContaining({ id: "sym:src/main.ts#main", kinds: ["read"] }),
    ]);
    expect(result.files[0]!.outside).toEqual([20]);
  });
});

// ─── Base anchors ───────────────────────────────────────────────────────────────────────────────

describe("base anchors", () => {
  const w = world();

  it("are made from find or a span in the base file, store the base lines and commit", () => {
    const made = makeAnchor(
      { file: "src/app.ts", at: "base", find: "return 0;", role: "usage" },
      w.index,
      texts(w),
      { change: CHANGE },
    );
    expect(made).toMatchObject({
      ok: true,
      anchor: {
        file: "src/app.ts",
        at: "base",
        span: { from: 4, to: 4 },
        role: "usage",
        resolved: { commit: BASE, range: { startLine: 5, endLine: 5 }, status: "ok" },
      },
    });
    // a renamed file may be named by its old path; it is stored under its new one
    const renamed = makeAnchor(
      { file: "src/before.ts", at: "base", span: { from: 1, to: 2 }, role: "definition" },
      w.index,
      texts(w),
      { change: CHANGE },
    );
    expect(renamed.ok && renamed.anchor.file).toBe("src/moved.ts");
    // a deleted file has a base too, but no head
    expect(
      makeAnchor(
        { file: "src/old.ts", at: "base", find: "gone", role: "usage" },
        w.index,
        texts(w),
        {
          change: CHANGE,
        },
      ).ok,
    ).toBe(true);
  });

  it("are rejected with a plain reason: no record, a symbol, an added or unchanged file, a miss", () => {
    const err = (input: object, change: ChangeRecord | null = CHANGE) => {
      const made = makeAnchor(
        { role: "usage", at: "base", ...input } as never,
        w.index,
        texts(w),
        change ? { change } : {},
      );
      return made.ok ? "" : made.error;
    };
    expect(err({ file: "src/app.ts", find: "return 0;" }, null)).toContain("no change record");
    expect(err({ file: "src/app.ts", symbol: "App.serve" })).toContain("cannot name a symbol");
    expect(err({ file: "src/added.ts", span: { from: 0, to: 0 } })).toContain("was added");
    expect(err({ file: "src/main.ts", span: { from: 0, to: 0 } })).toContain(
      'anchor it without "at"',
    );
    expect(err({ file: "src/app.ts", find: "helper()" })).toContain("xpl show --at base");
    expect(err({ file: "src/app.ts", span: { from: 30, to: 31 } })).toContain("offsets 0..16");
    expect(
      makeAnchor({ file: "src/app.ts", at: "head", role: "usage" } as never, w.index, texts(w)),
    ).toMatchObject({ ok: false, error: expect.stringContaining('anchor.at must be "base"') });
  });

  it("resolve against the record: ok, moved after a new base, missing without a record", () => {
    const made = makeAnchor(
      { file: "src/app.ts", at: "base", find: "return 0;", role: "usage" },
      w.index,
      texts(w),
      { change: CHANGE },
    );
    if (!made.ok) throw new Error(made.error);
    const anchor = made.anchor;
    expect(resolveWith(anchor, w.model, texts(w), CHANGE).status).toBe("ok");
    expect(resolveWith(anchor, w.model, texts(w)).status).toBe("missing");
    // another base, where the same line sits two lines lower
    const other = "c".repeat(40);
    const shifted = new TextCache(w.getText, (commit, path) =>
      commit === other && path === "src/app.ts" ? "x\ny\n" + APP_BASE : undefined,
    );
    const moved = resolveWith(anchor, w.model, shifted, { ...CHANGE, base: other });
    expect(moved).toMatchObject({ status: "moved", span: { from: 6, to: 6 } });
    // gone from the base: drifted
    const gone = new TextCache(w.getText, () => textWith(17));
    expect(resolveWith(anchor, w.model, gone, CHANGE).status).toBe("drifted");
  });

  it("are left out of the head focus, and given as base ranges apart", () => {
    const base = makeAnchor(
      { file: "src/app.ts", at: "base", find: "return 0;", role: "usage" },
      w.index,
      texts(w),
      { change: CHANGE },
    );
    const head = makeAnchor(
      { file: "src/app.ts", symbol: "App.serve", role: "definition" },
      w.index,
      texts(w),
    );
    if (!base.ok || !head.ok) throw new Error("anchor");
    const ex = withChange({ concepts: [concept("concept:x", [base.anchor, head.anchor])] });
    const model = new ExplainerModel(ex, w.model);
    expect(codeFocus(["concept:x"], model).map((f) => f.range)).toEqual([
      { startLine: 3, endLine: 7 },
    ]);
    expect(baseAnchorFocus([base.anchor, head.anchor], "concept:x")).toEqual([
      expect.objectContaining({ file: "src/app.ts", range: { startLine: 5, endLine: 5 } }),
    ]);
  });

  it("go through applyPatch and validate, and re-resolve with the base commit", () => {
    const ex = withChange();
    const patch = {
      concepts: [
        {
          id: "concept:before",
          label: "Before",
          anchors: [
            { file: "src/app.ts", at: "base" as const, find: "return 0;", role: "usage" as const },
          ],
        },
      ],
    };
    const r = applyPatch(ex, patch, w.index, texts(w), { actor: "llm" });
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
    expect(validateExplainer(r.explainer, w.index, texts(w))).toEqual([]);
    const { explainer, report } = reresolveExplainer(r.explainer, w.index, texts(w));
    expect(report.counts.ok).toBe(1);
    expect((explainer.concepts[0]!.anchors[0] as Anchor).resolved?.commit).toBe(BASE);

    // without a change record the same patch is an error, and so is a stored base anchor
    const without = applyPatch(emptyExplainer(), patch, w.index, texts(w), { actor: "llm" });
    expect(without.ok).toBe(false);
    expect(without.issues[0]!.message).toContain("no change record");
    const stored = { ...r.explainer };
    delete stored.change;
    expect(validateExplainer(stored, w.index, texts(w), { mode: "lenient" })).toEqual([
      expect.objectContaining({ severity: "error", code: "anchor-invalid" }),
    ]);
  });
});

// ─── Validation of the record ───────────────────────────────────────────────────────────────────

describe("validate: change", () => {
  const w = world();

  it("a head that is not the index commit is a warning with a plain fix", () => {
    const ex = withChange({ change: { ...CHANGE, head: "c".repeat(40) } });
    const issues = validateExplainer(ex, w.index, texts(w));
    expect(issues).toEqual([
      expect.objectContaining({ severity: "warning", code: "change", path: "change.head" }),
    ]);
    expect(issues[0]!.message).toContain("run `xpl index`");
    expect(validateExplainer(withChange(), w.index, texts(w))).toEqual([]);
  });

  it("a malformed record is an error; patches cannot carry one", () => {
    const ex = withChange({ change: { base: "x" } as never });
    expect(validateExplainer(ex, w.index, texts(w)).map((i) => [i.code, i.path])).toEqual([
      ["change", "change.base"],
      ["change", "change.head"],
      ["change", "change.files"],
    ]);
    const r = applyPatch(withChange(), { change: CHANGE } as never, w.index, texts(w), {
      actor: "user",
    });
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatchObject({ path: "change" });
    expect(r.issues[0]!.message).toContain("xpl change");
  });
});
