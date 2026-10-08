/**
 * These source-selection examples omit story text; HTML uses explicit draft preview.
 * `xpl change`, base anchors through the CLI (`apply`, `anchors`, `validate`, `show --at base`), `baseFiles` in
 * `xpl bundle`, and `GET /api/base-file`: against a small git repository with two commits.
 */
import { copyFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parseBundle, type ChangeRecord, type Explainer, type ExplainerPatch } from "@xpl/core";
import { linesList, parseRange } from "../src/commands/change.js";
import { parseNameStatus, parsePatch, unquotePath } from "../src/git.js";
import { startViewServer } from "../src/server.js";
import {
  cloneDir,
  git,
  invoke,
  makeTempDir,
  readFile,
  readJson,
  STUB_VIEWER_HTML,
  writeFile,
  writeViewerStub,
  xpl,
  xplJson,
} from "./helpers.js";

const APP_V1 = `class App:
    def __init__(self, name):
        self.name = name

    def __call__(self, scope):
        return self.handle(scope)

    def handle(self, scope):
        return "old"


def make_app():
    return App("demo")
`;

const APP_V2 = `import os


class App:
    def __init__(self, name):
        self.name = name

    def __call__(self, scope):
        return self.handle(scope)

    def handle(self, scope):
        if scope:
            return helper(scope)
        return "new"


def helper(scope):
    return os.fspath(scope)


def make_app():
    return App("demo")
`;

const SERVER = `from app import App, make_app


def serve():
    app = make_app()
    return app({})


def build():
    return App("x")
`;

const TEST_V1 = `from app import App


def test_app():
    assert App("t")({}) == "old"
`;

const TEST_V2 = `from app import App, helper


def test_app():
    assert App("t")({}) == "new"


def test_helper():
    assert helper("p") == "p"
`;

let repo: string;
let base: string;
let head: string;

/** A git repo: commit 1 (base), commit 2 (head: app.py edited, old.py deleted, util.py renamed to tools.py, new.py added). */
async function makeRepo(): Promise<string> {
  const dir = makeTempDir("xpl-change-");
  writeFile(dir, "app.py", APP_V1);
  writeFile(dir, "server.py", SERVER);
  writeFile(dir, "old.py", "def gone():\n    return 1\n");
  writeFile(dir, "util.py", "def tool():\n    return 'tool'\n\n\ndef other():\n    return 2\n");
  writeFile(dir, "tests/test_app.py", TEST_V1);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  writeFile(dir, "app.py", APP_V2);
  writeFile(dir, "tests/test_app.py", TEST_V2);
  rmSync(join(dir, "old.py"));
  renameSync(join(dir, "util.py"), join(dir, "tools.py"));
  writeFile(dir, "new.py", "def fresh():\n    return 3\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "head");
  const indexed = await xpl(dir, "index", "--precise", "off");
  if (indexed.code !== 0) throw new Error(indexed.err);
  const created = await xpl(dir, "new", "demo");
  if (created.code !== 0) throw new Error(created.err);
  return dir;
}

beforeAll(async () => {
  repo = await makeRepo();
  base = git(repo, "rev-parse", "HEAD~1");
  head = git(repo, "rev-parse", "HEAD");
});

describe("git parsing", () => {
  it("reads name-status entries, renames and copies included", () => {
    expect(
      parseNameStatus("M\0a.py\0R091\0old.py\0new.py\0D\0x.py\0A\0y.py\0C075\0s.py\0t.py\0"),
    ).toEqual([
      { status: "modified", path: "a.py" },
      { status: "renamed", path: "new.py", oldPath: "old.py" },
      { status: "deleted", path: "x.py" },
      { status: "added", path: "y.py" },
      { status: "added", path: "t.py" },
    ]);
  });

  it("reads -U0 hunks, with the one-line short form, and does not take a removed line for a header", () => {
    const patch = [
      "diff --git a/a.py b/a.py",
      "index 1..2 100644",
      "--- a/a.py",
      "+++ b/a.py",
      "@@ -3 +3,2 @@ def f():",
      "-x",
      "--- not a header",
      "+y",
      "+z",
      "@@ -10,2 +11,0 @@",
      '-"a"',
      "-b",
    ].join("\n");
    expect(parsePatch(patch)).toEqual([
      {
        oldPath: "a.py",
        newPath: "a.py",
        hunks: [
          { oldStart: 3, oldLines: 1, newStart: 3, newLines: 2 },
          { oldStart: 10, oldLines: 2, newStart: 11, newLines: 0 },
        ],
      },
    ]);
    expect(unquotePath('"a/sp\\303\\251cial \\"q\\".py"')).toBe('a/spécial "q".py');
  });

  it("parses ranges and prints line lists", () => {
    expect(parseRange("main..HEAD")).toEqual({ base: "main", head: "HEAD", mergeBase: false });
    expect(parseRange("main...topic")).toEqual({ base: "main", head: "topic", mergeBase: true });
    expect(parseRange("abc^")).toEqual({ base: "abc^", mergeBase: false });
    expect(parseRange("abc..")).toEqual({ base: "abc", mergeBase: false });
    expect(() => parseRange("..HEAD")).toThrow("<base>..<head>");
    expect(linesList([5, 3, 4, 9, 11, 10])).toBe("3-5, 9-11");
  });
});

describe("xpl change", () => {
  it("labels a changed integration test separately from symbol-name matches", async () => {
    const dir = makeTempDir("xpl-change-integration-");
    writeFile(dir, "src/engine.py", "def normalize(value):\n    return value\n");
    writeFile(
      dir,
      "src/service.py",
      "from engine import normalize\n\ndef handle(request):\n    return normalize(request['value'])\n",
    );
    writeFile(
      dir,
      "tests/test_service.py",
      "from service import handle\n\ndef test_request():\n    assert handle({'value': 'old'}) == 'old'\n",
    );
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    writeFile(dir, "src/engine.py", "def normalize(value):\n    return value.upper()\n");
    writeFile(
      dir,
      "tests/test_service.py",
      "from service import handle\n\ndef test_request():\n    assert handle({'value': 'new'}) == 'NEW'\n",
    );
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "head");
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
    expect((await xpl(dir, "new", "demo")).code).toBe(0);

    const change = await xpl(dir, "change", "demo", "HEAD~1..HEAD");
    expect(change.code).toBe(0);
    expect(change.out).toContain("tests: no indexed test matches this symbol by name");
    expect(change.out).toContain(
      "No indexed test matched 1 changed symbol by name: sym:src/engine.py#normalize",
    );
    expect(change.out).toContain("test files the change touches (1):\n  tests/test_service.py");
    const structured = await xplJson<{
      analysis: {
        untested: string[];
        files: { path: string; test: boolean }[];
        testSymbols: { id: string }[];
      };
    }>(dir, "change", "demo");
    expect(structured.json.analysis.untested).toEqual(["sym:src/engine.py#normalize"]);
    expect(structured.json.analysis.files.find((file) => file.test)?.path).toBe(
      "tests/test_service.py",
    );
    expect(structured.json.analysis.testSymbols.map((symbol) => symbol.id)).toEqual([
      "sym:tests/test_service.py#test_request",
    ]);

    const help = await invoke(["change", "--help"]);
    expect(help.out).toContain("a missing match does not mean the behavior has no test");
    expect(help.out).toContain("changed test files are listed separately");

    const drafted = await xplJson<{ patch: ExplainerPatch }>(dir, "draft", "change", "demo");
    expect(drafted.code).toBe(0);
    const patch = drafted.json.patch;
    const testStep = patch.tours![0]!.steps!.find((step) => step.note?.includes("indexed test"));
    expect(testStep?.note).toContain("No indexed test matched `normalize` by name");
    expect(testStep?.note).toContain("whether the new branches are tested");
    expect(patch.tours![0]!.summary).toContain("no indexed test matched 1 changed symbol by name");
  });

  it("records the change with full SHAs, statuses and hunks, and prints the analysis", async () => {
    const dir = cloneDir(repo);
    const r = await xpl(dir, "change", "demo", "HEAD~1..HEAD");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const change = readJson<Explainer>(dir, ".explainer/demo.explainer.json").change!;
    expect(change.base).toBe(base);
    expect(change.head).toBe(head);
    expect(change.files).toEqual([
      {
        path: "app.py",
        status: "modified",
        hunks: [
          { oldStart: 0, oldLines: 0, newStart: 1, newLines: 3 },
          { oldStart: 9, oldLines: 1, newStart: 12, newLines: 7 },
        ],
      },
      {
        path: "new.py",
        status: "added",
        hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2 }],
      },
      {
        path: "old.py",
        status: "deleted",
        hunks: [{ oldStart: 1, oldLines: 2, newStart: 0, newLines: 0 }],
      },
      {
        path: "tests/test_app.py",
        status: "modified",
        hunks: [
          { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 },
          { oldStart: 5, oldLines: 1, newStart: 5, newLines: 5 },
        ],
      },
      { path: "tools.py", status: "renamed", oldPath: "util.py", hunks: [] },
    ]);
    // the change sits next to the index binding in the file
    expect(Object.keys(readJson(dir, ".explainer/demo.explainer.json")).slice(0, 5)).toEqual([
      "schema",
      "title",
      "repo",
      "index",
      "change",
    ]);
    expect(r.out).toContain(`change demo: ${base.slice(0, 7)}..${head.slice(0, 7)} (5 files`);
    expect(r.out).toContain("M  app.py");
    expect(r.out).toContain("R  tools.py <- util.py");
    expect(r.out).toContain("sym:app.py#helper  (function, lines 17-18)  changed");
    expect(r.out).toContain("sym:app.py#App.handle  (method, lines 11-14)  changed at 12-14");
    expect(r.out).toContain("sym:tests/test_app.py#test_app  (changed, uses its class)");
    expect(r.out).toContain("No indexed test matched 1 changed symbol by name: sym:new.py#fresh");
    expect(r.out).toContain(
      "changed lines outside any symbol (imports, module-level code):\n  app.py: 1",
    );
    expect(r.out).toContain(
      "app.py#App.__call__ --[9, heuristic]--> app.py#App.handle --[13, heuristic]--> app.py#helper",
    );
    expect(r.out).toContain(
      "dynamic callbacks, runtime middleware wiring and instance guesses are not followed",
    );
    expect(r.out).toContain("Not checked:\n  old.py: removed from the head");
  });

  it("--json gives the record and the analysis: callers, tests, callers via instance", async () => {
    const dir = cloneDir(repo);
    const { json, code } = await xplJson<{
      written: boolean;
      change: ChangeRecord;
      omissions: string[];
      analysis: { symbols: any[]; untested: string[]; testSymbols: any[] };
    }>(dir, "change", "demo", `${base}..${head}`);
    expect(code).toBe(0);
    expect(json.written).toBe(true);
    expect(json.omissions).toContainEqual(expect.stringContaining("old.py: removed from the head"));
    const helper = json.analysis.symbols.find((s) => s.id === "sym:app.py#helper");
    expect(helper.callers.map((c: any) => c.id)).toEqual(["sym:app.py#App.handle"]);
    expect(helper.callers[0].changed).toBe("changed");
    expect(helper.tests.map((t: any) => t.id)).toEqual(["sym:tests/test_app.py#test_helper"]);
    expect(json.analysis.testSymbols.map((s: any) => [s.id, s.status])).toEqual([
      ["sym:tests/test_app.py#test_app", "changed"],
      ["sym:tests/test_app.py#test_helper", "changed"],
    ]);
    // handle is reached through the instance: the code that builds App is a guess, test files that build it count
    const handle = json.analysis.symbols.find((s) => s.id === "sym:app.py#App.handle");
    expect(handle.callers).toEqual([expect.objectContaining({ id: "sym:app.py#App.__call__" })]);
    expect(handle.viaInstance.map((c: any) => [c.id, c.via])).toEqual([
      ["sym:app.py#make_app", "instance"],
      ["sym:server.py#build", "instance"],
    ]);
    expect(handle.tests.map((t: any) => [t.id, t.via])).toEqual([
      ["sym:tests/test_app.py#test_app", "instance"],
    ]);
  });

  it("without a range re-prints the recorded change; the same range twice writes nothing", async () => {
    const dir = cloneDir(repo);
    const none = await xpl(dir, "change", "demo");
    expect(none.code).toBe(1);
    expect(none.err).toContain("has no change recorded yet");
    expect((await xpl(dir, "change", "demo", "HEAD~1")).code).toBe(0); // head: the index commit
    const again = await xpl(dir, "change", "demo", "HEAD~1..HEAD");
    expect(again.out).toContain(
      "unchanged: .explainer/demo.explainer.json already records this change",
    );
    const shown = await xpl(dir, "change", "demo");
    expect(shown.code).toBe(0);
    expect(shown.out).toContain("recorded in .explainer/demo.explainer.json");
    expect(shown.out).toContain("sym:app.py#helper");
    const shownJson = await xplJson<{ omissions: string[] }>(dir, "change", "demo");
    expect(shownJson.json.omissions).toContainEqual(
      expect.stringContaining("old.py: removed from the head"),
    );
  });

  it("marks omissions from a reused index as observations about that index", async () => {
    const dir = cloneDir(repo);
    expect((await xpl(dir, "change", "demo", "HEAD~1..HEAD")).code).toBe(0);
    const file = ".explainer/demo.explainer.json";
    const ex = readJson<Explainer>(dir, file);
    ex.change!.head = base;
    writeFile(dir, file, JSON.stringify(ex));
    const shown = await xplJson<{ omissions: string[] }>(dir, "change", "demo");
    expect(shown.code).toBe(0);
    expect(shown.json.omissions[0]).toContain("Loaded index");
    expect(shown.json.omissions[0]).toContain("differs from change head");
  });

  it("refuses a head that is not the index commit, unknown revisions, and empty ranges", async () => {
    const dir = cloneDir(repo);
    const wrongHead = await xpl(dir, "change", "demo", "HEAD~1..HEAD~1");
    expect(wrongHead.code).toBe(1);
    expect(wrongHead.err).toContain("is not the commit the index was built from");
    expect(wrongHead.err).toContain("run `xpl index`");
    const unknown = await xpl(dir, "change", "demo", "nope..HEAD");
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('"nope" is not a commit of this repository');
    const same = await xpl(dir, "change", "demo", "HEAD..HEAD");
    expect(same.err).toContain("there is no change");
    const usage = await xpl(dir, "change", "demo", "..HEAD");
    expect(usage.code).toBe(2);
    expect(readJson<Explainer>(dir, ".explainer/demo.explainer.json").change).toBeUndefined();
  });

  it("works for a root below the git top level (its index is named wt-...): head is HEAD when nothing changed", async () => {
    const top = makeTempDir("xpl-change-sub-");
    writeFile(top, "README.md", "top\n");
    writeFile(top, "pkg/app.py", APP_V1);
    git(top, "init", "-q", "-b", "main");
    git(top, "add", "-A");
    git(top, "commit", "-q", "-m", "base");
    writeFile(top, "pkg/app.py", APP_V2);
    git(top, "commit", "-qam", "head");
    const pkg = join(top, "pkg");
    expect((await xpl(pkg, "index", "--precise", "off")).code).toBe(0);
    expect((await xpl(pkg, "new", "demo")).code).toBe(0);
    const r = await xplJson<{ change: ChangeRecord }>(pkg, "change", "demo", "HEAD~1..HEAD");
    expect(r.code).toBe(0);
    expect(r.json.change.files.map((f) => f.path)).toEqual(["app.py"]); // relative to the root
    const shown = await xpl(pkg, "show", "--at", "base", "app.py", "--lines", "9-9");
    expect(shown.out).toContain('9 8│-        return "old"');
    expect((await xpl(pkg, "validate", "demo")).out).toContain("no errors, no warnings");
  });

  it("needs git: a plain directory gets a clear error", async () => {
    const dir = cloneDir(repo);
    rmSync(join(dir, ".git"), { recursive: true, force: true });
    const r = await xpl(dir, "change", "demo", "HEAD~1..HEAD");
    expect(r.code).toBe(1);
    expect(r.err).toContain("xpl change needs git");
  });
});

describe("base anchors through the CLI", () => {
  let dir: string;
  beforeAll(async () => {
    dir = cloneDir(repo);
    expect((await xpl(dir, "change", "demo", "HEAD~1..HEAD")).code).toBe(0);
  });

  it("xpl show --at base prints the base file with offsets and the lines the change rewrites", async () => {
    const r = await xpl(dir, "show", "--at", "base", "app.py", "--lines", "8-9");
    expect(r.code).toBe(0);
    expect(r.out.split("\n")).toEqual([
      `app.py before the change ${base.slice(0, 7)}..${head.slice(0, 7)} (modified, base ${base.slice(0, 7)}): lines 1-13; spans count from line 1`,
      "8 7│     def handle(self, scope):",
      '9 8│-        return "old"',
      "(- marks lines the change removes or rewrites)",
    ]);
    const renamed = await xpl(dir, "show", "--at", "base", "util.py", "--lines", "1-1");
    expect(renamed.out).toContain("tools.py (was util.py) before the change");
    const added = await xpl(dir, "show", "--at", "base", "new.py");
    expect(added.code).toBe(1);
    expect(added.err).toContain("was added by the change");
  });

  it("xpl show --at base selects the discovered change guide despite a colliding root JSON file", async () => {
    const copy = cloneDir(repo);
    expect((await xpl(copy, "new", "retry.json", "--title", "Retry change")).code).toBe(0);
    expect((await xpl(copy, "change", "retry.json", "HEAD~1..HEAD")).code).toBe(0);
    expect((await xpl(copy, "new", "decoy", "--title", "Root JSON decoy")).code).toBe(0);
    copyFileSync(join(copy, ".explainer/decoy.explainer.json"), join(copy, "retry.json"));
    rmSync(join(copy, ".explainer/decoy.explainer.json"));

    const shown = await xpl(copy, "show", "--at", "base", "app.py", "--lines", "8-9");
    expect(shown.code, shown.err).toBe(0);
    expect(shown.out.split("\n")).toEqual([
      `app.py before the change ${base.slice(0, 7)}..${head.slice(0, 7)} (modified, base ${base.slice(0, 7)}): lines 1-13; spans count from line 1`,
      "8 7│     def handle(self, scope):",
      '9 8│-        return "old"',
      "(- marks lines the change removes or rewrites)",
    ]);
  });

  it("apply builds a base anchor; anchors prints the base code; validate checks it", async () => {
    const patch = {
      concepts: [
        {
          id: "concept:before",
          label: "Before",
          anchors: [
            { file: "app.py", at: "base", find: 'return "old"', role: "usage" },
            { file: "util.py", at: "base", span: { from: 0, to: 1 }, role: "definition" },
            { file: "app.py", symbol: "App.handle", role: "definition" },
          ],
        },
      ],
    };
    writeFile(dir, ".explainer/p.json", JSON.stringify(patch));
    const applied = await xpl(dir, "apply", "demo", ".explainer/p.json");
    expect(applied.out).toContain("applied");
    expect(applied.code).toBe(0);
    const stored = readJson<Explainer>(dir, ".explainer/demo.explainer.json").concepts[0]!.anchors;
    expect(stored[0]).toMatchObject({
      file: "app.py",
      at: "base",
      span: { from: 8, to: 8 },
      resolved: { commit: base, range: { startLine: 9, endLine: 9 }, status: "ok" },
    });
    expect(stored[1]!.file).toBe("tools.py"); // the renamed file's new path

    const anchors = await xpl(dir, "anchors", "demo", "concept:before");
    expect(anchors.out).toContain(
      "1. usage  app.py@base +8..8  ok  lines 9-9  [before the change]",
    );
    expect(anchors.out).toContain('9 8│         return "old"');
    expect(anchors.out).toContain(
      "2. definition  tools.py@base +0..1  ok  lines 1-2  [before the change]",
    );
    expect(anchors.out).toContain("1 0│ def tool():");
    expect((await xpl(dir, "validate", "demo")).out).toContain("no errors, no warnings");
  });

  it("rejects a base anchor with a symbol, or without a change record", async () => {
    const other = cloneDir(repo); // no change recorded
    const patch = JSON.stringify({
      concepts: [
        {
          id: "concept:x",
          label: "X",
          anchors: [{ file: "app.py", at: "base", find: 'return "old"', role: "usage" }],
        },
      ],
    });
    writeFile(other, ".explainer/p.json", patch);
    const r = await xpl(other, "apply", "demo", ".explainer/p.json");
    expect(r.code).toBe(1);
    expect(r.out).toContain("no change record");
    writeFile(
      dir,
      ".explainer/q.json",
      JSON.stringify({
        concepts: [
          {
            id: "concept:y",
            label: "Y",
            anchors: [{ file: "app.py", at: "base", symbol: "App.handle", role: "usage" }],
          },
        ],
      }),
    );
    const symbol = await xpl(dir, "apply", "demo", ".explainer/q.json");
    expect(symbol.code).toBe(1);
    expect(symbol.out).toContain("a base anchor cannot name a symbol");
  });

  it("validate warns when the recorded head is not the index commit", async () => {
    const other = cloneDir(dir);
    const file = ".explainer/demo.explainer.json";
    const ex = readJson<Explainer>(other, file);
    ex.change!.head = base;
    writeFile(other, file, JSON.stringify(ex));
    const r = await xpl(other, "validate", "demo");
    expect(r.code).toBe(0);
    expect(r.out).toContain("warning");
    expect(r.out).toContain(`the change ends at ${base.slice(0, 7)}`);
  });
});

describe("bundle and server with a change", () => {
  let dir: string;
  // The viewer stub, so these tests never depend on the viewer build (CI runs them before any build).
  let env: { XPL_VIEWER_HTML: string };
  const runBundle = (...argv: string[]) =>
    invoke(["bundle", "--draft", ...argv], { cwd: dir, env });
  beforeAll(async () => {
    dir = cloneDir(repo);
    expect((await xpl(dir, "change", "demo", "HEAD~1..HEAD")).code).toBe(0);
    env = { XPL_VIEWER_HTML: writeViewerStub() };
  });

  const bundleOf = (path: string) => {
    const html = readFile(dir, path);
    const match = /<script id="xpl-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
    return parseBundle(match![1]!);
  };

  for (const files of ["referenced", "boundary"] as const) {
    it(`--files ${files}: every changed head file and the base of modified, renamed and deleted ones`, async () => {
      const r = await runBundle("demo", "-o", `${files}.html`, "--files", files, "--root", dir);
      expect(r.code).toBe(0);
      expect(r.out).toContain(
        `change ${base.slice(0, 7)}..${head.slice(0, 7)}: 4 changed files in (4 added to the selection`,
      );
      expect(r.out).toContain("code before the change of 4 files");
      const bundle = bundleOf(`${files}.html`);
      for (const path of ["app.py", "new.py", "tests/test_app.py", "tools.py"]) {
        expect(Object.keys(bundle.files)).toContain(path);
      }
      expect(bundle.baseFiles).toEqual({
        "app.py": APP_V1,
        "old.py": "def gone():\n    return 1\n",
        "tests/test_app.py": TEST_V1,
        "tools.py": "def tool():\n    return 'tool'\n\n\ndef other():\n    return 2\n",
      });
    }, 60_000);
  }

  it("--json reports the change part", async () => {
    const r = await runBundle("demo", "-o", "j.html", "--json");
    const json = JSON.parse(r.out) as { change: Record<string, unknown> };
    expect(json.change).toMatchObject({
      base,
      head,
      changedFiles: 4,
      baseFiles: ["app.py", "old.py", "tests/test_app.py", "tools.py"],
    });
  }, 60_000);

  it("GET /api/base-file serves only the changed files' base text", async () => {
    const server = await startViewServer({
      env: {
        root: dir,
        cwd: dir,
        env: {},
        indexOption: undefined,
        warn: () => undefined,
      },
      explainerPath: join(dir, ".explainer", "demo.explainer.json"),
      host: "127.0.0.1",
      port: 0,
      viewerHtml: () => STUB_VIEWER_HTML,
    });
    try {
      const get = (path: string) =>
        fetch(`${server.url}api/base-file?path=${encodeURIComponent(path)}`);
      const ok = await get("app.py");
      expect(ok.status).toBe(200);
      expect(await ok.text()).toBe(APP_V1);
      expect(await (await get("tools.py")).text()).toContain("def tool()");
      expect((await get("old.py")).status).toBe(200);
      expect((await get("util.py")).status).toBe(404); // the old path is not the key
      expect((await get("new.py")).status).toBe(404); // added: no base
      expect((await get("server.py")).status).toBe(404); // not changed
      expect((await get("../etc/passwd")).status).toBe(400);
      const bundle = (await (await fetch(`${server.url}api/bundle`)).json()) as {
        baseFiles: Record<string, string>;
      };
      expect(Object.keys(bundle.baseFiles)).toEqual([
        "app.py",
        "old.py",
        "tests/test_app.py",
        "tools.py",
      ]);
    } finally {
      await server.close();
    }
  });
});
