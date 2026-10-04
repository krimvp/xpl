/**
 * `xpl draft`: the drafts of the three fixtures and of a change in a small git repository apply as they are
 * (`xpl apply`), leave a valid explainer (`xpl validate`), and `xpl lint` reports nothing but `todo-left` on them.
 * The change draft anchors every changed file. And the `todo-left` lint rule itself.
 */
import { readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { IndexModel, type Explainer, type ExplainerPatch, type SymbolIndex } from "@xpl/core";
import { patchAnchors } from "../src/commands/draft.js";
import { DRAFT_LIMITS, draftProblems } from "../src/draft.js";
import { lintExplainer, type LintFinding } from "../src/lint.js";
import {
  cloneDir,
  git,
  indexedFixture,
  makeTempDir,
  readJson,
  writeFile,
  xpl,
  xplJson,
} from "./helpers.js";

interface DraftJson {
  kind: string;
  counts: Record<string, number>;
  notes: string[];
  patch: ExplainerPatch;
}

interface LintJson {
  total: number;
  counts: Record<string, number>;
  findings: LintFinding[];
}

describe("draft audience and question", () => {
  it("records the reader and question in the patch without writing the explainer", async () => {
    const dir = await indexedFixture();
    await xpl(dir, "new", "focused");
    const before = readJson(dir, ".explainer/focused.explainer.json");
    const result = await xplJson<DraftJson>(
      dir,
      "draft",
      "repo",
      "focused",
      "--audience",
      "New maintainers",
      "--question",
      "How are jobs retried?",
    );
    expect(result.code).toBe(0);
    expect(result.json.patch.scope).toEqual({ audience: "New maintainers" });
    expect(
      result.json.patch.views!.every((v) => v.scope?.question === "How are jobs retried?"),
    ).toBe(true);
    expect(result.json.patch.tours![0]!.summary).toContain("How are jobs retried?");
    expect(readJson(dir, ".explainer/focused.explainer.json")).toEqual(before);
  });
});

/** Runs a draft into a file, applies it, validates, and lints; returns the patch and the lint result. */
async function draftApplyCheck(
  dir: string,
  name: string,
  args: string[],
): Promise<{ patch: ExplainerPatch; lint: LintJson; notes: string[] }> {
  const out = join(makeTempDir("xpl-draft-out-"), "draft.json");
  const drafted = await xpl(dir, "draft", ...args, "-o", out);
  expect(drafted.code, drafted.err + drafted.out).toBe(0);
  expect(drafted.out).toMatch(/^wrote /);
  const json = await xplJson<DraftJson>(dir, "draft", ...args);
  expect(json.code).toBe(0);
  const patch = JSON.parse(readFileSync(out, "utf8")) as ExplainerPatch;
  expect(json.json.patch).toEqual(patch);

  const before = await xplJson<LintJson>(dir, "lint", name, "--patch", out);
  // a draft is full of TODOs: errors, so lint exits 1 (also with --warn-only)
  expect(before.code).toBe(1);
  const applied = await xpl(dir, "apply", name, out);
  expect(applied.code, applied.out).toBe(0);
  expect(applied.out).toMatch(/^applied to /);
  expect(applied.out, "no warnings from apply").not.toContain("warning");
  const validated = await xpl(dir, "validate", name);
  expect(validated.code, validated.out).toBe(0);
  expect(validated.out).toMatch(/no errors, no warnings$/);
  const anchors = await xpl(dir, "anchors", name);
  expect(anchors.out).toMatch(/drifted 0, missing 0$/);
  const lint = await xplJson<LintJson>(dir, "lint", name);
  expect(lint.code).toBe(1);
  expect(Object.keys(lint.json.counts)).toEqual(["todo-left"]);
  expect(lint.json.findings.every((f) => f.severity === "error")).toBe(true);
  expect(lint.json.total).toBe(before.json.total);
  return { patch, lint: lint.json, notes: json.json.notes };
}

/** The skill's shape rules every draft keeps. */
function checkShape(patch: ExplainerPatch): void {
  const tour = patch.tours![0]!;
  expect(tour.title).toMatch(/^TODO: /);
  expect(tour.summary).toMatch(/^TODO: /);
  for (const step of tour.steps!) {
    expect(step.note).toMatch(/^### TODO: .+\n\n.*TODO: /);
    expect((step.code ?? []).length).toBeLessThanOrEqual(DRAFT_LIMITS.codeRanges);
    expect((step.code ?? []).length).toBeGreaterThan(0);
    expect(step.focus.length).toBeGreaterThan(0);
  }
  for (const view of patch.views ?? []) {
    if (view.type === "graph") {
      expect(view.stubs).toEqual({ mode: "none" });
      expect(view.include!.length).toBeLessThanOrEqual(DRAFT_LIMITS.mapBoxes);
    } else {
      expect(view.participants!.length).toBeLessThanOrEqual(DRAFT_LIMITS.participants);
    }
  }
  for (const node of patch.nodes ?? []) expect(node.summary).toContain("TODO");
}

const ENTRIES: Record<string, string> = {
  "ts-jobrunner": "sym:src/runner.ts#Runner.dispatch",
  "py-jobrunner": "sym:jobrunner/runner.py#Runner.dispatch",
  "go-jobrunner": "sym:internal/runner/runner.go#Runner.Dispatch",
};

describe.each(Object.keys(ENTRIES))("xpl draft on %s", (fixture) => {
  let dir: string;
  beforeAll(async () => {
    dir = await indexedFixture(fixture);
    expect((await xpl(dir, "new", "d")).code).toBe(0);
  });

  it("draft repo: a system map, then the inside of the service: 4-8 boxes, every box visited by the tour", async () => {
    const copy = cloneDir(dir);
    const { patch } = await draftApplyCheck(copy, "d", ["repo", "d"]);
    checkShape(patch);
    // level 1: the project as one service box, which opens the map of its parts
    const system = patch.views![0]!;
    expect(system.id).toBe("view:system");
    if (system.type !== "graph") throw new Error("the system map is a graph");
    const service = patch.nodes!.find((n) => n.role === "service")!;
    expect(service.id).toMatch(/^grp:[a-z-]+$/);
    expect(system.include).toContain(service.id);
    expect(service.opens).toBe("view:overview");
    expect(patch.tours![0]!.steps![0]!.view).toBe("view:system");
    expect(patch.tours![0]!.steps![0]!.focus).toEqual([service.id]);
    // level 2: the parts
    const view = patch.views!.find((v) => v.id === "view:overview")!;
    expect(view.type).toBe("graph");
    if (view.type !== "graph") return;
    expect(service.members).toEqual(view.include!.filter((id) => !id.startsWith("grp:")));
    expect(view.include!.length).toBeGreaterThanOrEqual(4);
    expect(view.excludeFiles).toContain("**/tests/**");
    // no test, doc or config box
    expect(view.include!.every((id) => !/test|README|\.ya?ml/.test(id))).toBe(true);
    const focused = patch.tours![0]!.steps!.flatMap((s) => s.focus);
    for (const box of view.include!) expect(focused).toContain(box);
    // the first step shows what the project is: the README
    expect(patch.tours![0]!.steps![0]!.code![0]!.file).toBe("README.md");
  });

  it("draft path: the calls of the entry in source order, one tour step each after the big picture", async () => {
    const copy = cloneDir(dir);
    const { patch } = await draftApplyCheck(copy, "d", ["path", "d", ENTRIES[fixture]!]);
    checkShape(patch);
    const view = patch.views![0]!;
    expect(view.type).toBe("sequence");
    if (view.type === "graph") return;
    expect(view.participants![0]).toBe(ENTRIES[fixture]);
    const steps = view.steps!;
    expect(steps.length).toBeGreaterThanOrEqual(5);
    expect(steps.length).toBeLessThanOrEqual(DRAFT_LIMITS.pathCalls);
    // source order: the call sites go down the entry
    const offsets = steps.map((s) => s.anchors![0]!.span!.from);
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
    for (const step of steps) {
      expect(step.from).toBe(ENTRIES[fixture]);
      expect(step.anchors![0]!.role).toBe("call-site");
      expect(step.anchors![1]!.role).toBe("definition");
      expect(step.label).toMatch(/\(|\{/);
    }
    // the queue's requeue is on the path of every fixture
    expect(steps.map((s) => s.label.toLowerCase())).toContainEqual(
      expect.stringMatching(/^requeue\(/),
    );
    const tour = patch.tours![0]!.steps!;
    expect(tour[0]!.focus).toEqual([ENTRIES[fixture]]);
    expect(tour.length).toBeLessThanOrEqual(DRAFT_LIMITS.pathSteps + 1);
    for (const step of tour.slice(1)) {
      expect(steps.map((s) => s.id)).toContain(step.focus[0]);
    }
  });
});

describe("xpl draft: refusals and reuse", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await indexedFixture("ts-jobrunner");
    expect((await xpl(dir, "new", "d")).code).toBe(0);
  });

  it("draft change without a change record names xpl change", async () => {
    const r = await xpl(dir, "draft", "change", "d");
    expect(r.code).toBe(1);
    expect(r.err).toContain("no change recorded");
    expect(r.err).toContain("xpl change d <base>..<head>");
  });

  it("usage errors: an unknown kind, a missing or extra entry, an entry that is not a symbol", async () => {
    expect((await xpl(dir, "draft", "tour", "d")).code).toBe(2);
    expect((await xpl(dir, "draft", "path", "d")).code).toBe(2);
    expect((await xpl(dir, "draft", "repo", "d", "sym:src/runner.ts#Runner")).code).toBe(2);
    const notSymbol = await xpl(dir, "draft", "path", "d", "file:src/runner.ts");
    expect(notSymbol.code).toBe(1);
    expect(notSymbol.err).toContain("the entry must be a symbol");
    const unknown = await xpl(dir, "draft", "path", "d", "sym:src/runner.ts#Runner.dispatchh");
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("Runner.dispatch");
  });

  it("prints the patch on stdout and the summary on stderr", async () => {
    const r = await xpl(dir, "draft", "path", "d", "src/runner.ts#Runner.dispatch");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).views[0].id).toBe("view:runner-dispatch");
    expect(r.err).toMatch(/^draft path for d: a sequence of \d+ calls between \d+ participants/);
    expect(r.err).toContain("next: save the patch to a file outside the repo (or use -o)");
    expect(r.err).toContain("called more than once, drawn once at the first call");
  });

  it("a second draft takes new ids and leaves what the explainer explains alone", async () => {
    const copy = cloneDir(dir);
    const first = await draftApplyCheck(copy, "d", ["repo", "d"]);
    const second = await xplJson<DraftJson>(copy, "draft", "repo", "d");
    expect(second.json.patch.views![0]!.id).toBe("view:system-2");
    expect(second.json.patch.views![1]!.id).toBe("view:overview-2");
    expect(second.json.patch.tours![0]!.id).toBe("tour:overview-2");
    // the boxes already have summaries: no new overlay for them
    expect(second.json.patch.nodes).toEqual([]);
    expect(first.patch.nodes!.length).toBeGreaterThan(0);
  });
});

// ─── draft change on a git repository ────────────────────────────────────────────────────────────

const RUNNER_V1 = `from helpers import fmt


def backoff(attempt, base):
    return base * 2 ** (attempt - 1)


class Runner:
    def __init__(self, queue):
        self.queue = queue

    def dispatch(self, job):
        delay = backoff(job.attempts, 100)
        self.queue.requeue(job, delay)
        return fmt(job)
`;

const RUNNER_V2 = `from helpers import fmt, clamp

LIMIT = 5000


def backoff(attempt, base):
    if attempt < 1:
        raise ValueError("attempt starts at 1")
    return clamp(base * 2 ** (attempt - 1), 0, LIMIT)


def jitter(delay):
    return delay + delay // 10


class Runner:
    def __init__(self, queue):
        self.queue = queue

    def dispatch(self, job):
        delay = jitter(backoff(job.attempts, 100))
        self.queue.requeue(job, delay)
        return fmt(job)
`;

const HELPERS_V1 = `def fmt(job):
    return str(job)
`;

const HELPERS_V2 = `def fmt(job):
    return str(job)


def clamp(value, low, high):
    return max(low, min(value, high))
`;

const MAIN = `from runner import Runner


def main(queue, job):
    runner = Runner(queue)
    return runner.dispatch(job)
`;

const TEST_V1 = `from runner import backoff


def test_backoff():
    assert backoff(1, 100) == 100
`;

const TEST_V2 = `from runner import backoff, jitter


def test_backoff():
    assert backoff(1, 100) == 100


def test_jitter():
    assert jitter(100) == 110
`;

/** Base: runner, helpers, main, a test and an old module. Head: edits, a new function, a deleted and a renamed file. */
async function changeRepo(): Promise<string> {
  const dir = makeTempDir("xpl-draft-change-");
  writeFile(dir, "runner.py", RUNNER_V1);
  writeFile(dir, "helpers.py", HELPERS_V1);
  writeFile(dir, "main.py", MAIN);
  writeFile(dir, "old.py", "def gone():\n    return 1\n");
  writeFile(dir, "names.py", "def first():\n    return 'a'\n\n\ndef second():\n    return 'b'\n");
  writeFile(dir, "tests/test_runner.py", TEST_V1);
  writeFile(
    dir,
    "tests/test_old.py",
    "from old import gone\n\n\ndef test_gone():\n    assert gone() == 1\n",
  );
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  writeFile(dir, "runner.py", RUNNER_V2);
  writeFile(dir, "helpers.py", HELPERS_V2);
  writeFile(dir, "tests/test_runner.py", TEST_V2);
  rmSync(join(dir, "old.py"));
  rmSync(join(dir, "tests/test_old.py"));
  renameSync(join(dir, "names.py"), join(dir, "labels.py"));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "head");
  const indexed = await xpl(dir, "index", "--precise", "off");
  if (indexed.code !== 0) throw new Error(indexed.err);
  expect((await xpl(dir, "new", "pr")).code).toBe(0);
  return dir;
}

describe("xpl draft change", () => {
  let repo: string;
  beforeAll(async () => {
    repo = await changeRepo();
    const recorded = await xpl(repo, "change", "pr", "HEAD~1..HEAD");
    expect(recorded.code, recorded.err).toBe(0);
  });

  it("applies as it is, validates, lints only todo-left, and anchors every changed file", async () => {
    const dir = cloneDir(repo);
    const { patch, notes } = await draftApplyCheck(dir, "pr", ["change", "pr"]);
    checkShape(patch);
    const explainer = readJson<Explainer>(dir, ".explainer/pr.explainer.json");
    const changed = explainer.change!.files.map((f) => f.path).sort();
    expect(changed).toEqual(
      [
        "helpers.py",
        "labels.py",
        "old.py",
        "runner.py",
        "tests/test_old.py",
        "tests/test_runner.py",
      ].sort(),
    );
    const anchored = new Set(patchAnchors(patch).map((a) => a.file));
    for (const file of changed) expect(anchored, file).toContain(file);
    // the deleted files are anchored in the code before the change
    const base = patchAnchors(patch).filter((a) => a.at === "base");
    expect([...new Set(base.map((a) => a.file))].sort()).toEqual(["old.py", "tests/test_old.py"]);
    expect(notes.filter((n) => n.startsWith("no anchor"))).toEqual([]);
    // `xpl anchors --json` agrees: every changed file has an anchor in the stored explainer
    const listed = await xplJson<{ elements: { anchors: { file: string }[] }[] }>(
      dir,
      "anchors",
      "pr",
    );
    const stored = new Set(listed.json.elements.flatMap((e) => e.anchors.map((a) => a.file)));
    for (const file of changed) expect(stored, file).toContain(file);
  });

  it("the map: changed symbols, their caller outside tests, one box for the tests", async () => {
    const { json } = await xplJson<DraftJson>(repo, "draft", "change", "pr");
    const patch = json.patch;
    const view = patch.views![0]!;
    expect(view).toMatchObject({ id: "view:change-map", type: "graph", stubs: { mode: "none" } });
    if (view.type !== "graph") return;
    expect(view.include).toEqual(
      expect.arrayContaining([
        "sym:runner.py#backoff",
        "sym:runner.py#jitter",
        "sym:runner.py#Runner.dispatch",
        "sym:helpers.py#clamp",
        "sym:main.py#main",
        "grp:change-tests",
      ]),
    );
    const byId = new Map(patch.nodes!.map((n) => [n.id, n]));
    // A mixed replacement hunk cannot prove a declaration was absent at base.
    expect(byId.get("sym:runner.py#jitter")!.summary).toMatch(/^Changed: TODO: /);
    expect(byId.get("sym:runner.py#backoff")!.summary).toMatch(/^Changed: TODO: /);
    expect(byId.get("sym:main.py#main")!.summary).toMatch(/^Unchanged: TODO: /);
    expect(byId.get("sym:main.py#main")!.summary).toContain("calls `Runner.dispatch`");
    expect(byId.get("grp:change-tests")).toMatchObject({
      label: "Tests of this change",
      members: ["sym:tests/test_runner.py#test_jitter"],
    });
    // a changed symbol's anchor is its changed lines, not the whole function
    expect(byId.get("sym:runner.py#backoff")!.anchors![0]).toEqual({
      file: "runner.py",
      symbol: "backoff",
      span: { from: 1, to: 3 },
      role: "definition",
    });
  });

  it("the tour in review order: users, entry, pieces in call order, other files, tests, risks", async () => {
    const { json } = await xplJson<DraftJson>(repo, "draft", "change", "pr");
    const steps = json.patch.tours![0]!.steps!;
    const titles = steps.map((s) => s.note!.split("\n")[0]);
    expect(titles[0]).toContain("what changes for users");
    expect(titles[1]).toContain("where the change enters");
    expect(steps[1]!.focus).toEqual(["sym:main.py#main"]);
    // ids leave room for the steps Claude inserts (t15 between t10 and t20)
    expect(steps.map((s) => s.id)).toEqual(steps.map((_, i) => `t${(i + 1) * 10}`));
    expect(titles.at(-2)).toContain("what the tests cover");
    expect(titles.at(-1)).toContain("the worst realistic failure");
    expect(steps.length).toBeLessThanOrEqual(DRAFT_LIMITS.changeSteps);
    // the pieces follow the calls from the entry: dispatch, then what it calls
    const pieces = steps
      .filter((s) => /what this piece does|what the new code does/.test(s.note!))
      .map((s) => s.focus[0]);
    expect(pieces.indexOf("sym:runner.py#Runner.dispatch")).toBe(0);
    expect(pieces.indexOf("sym:runner.py#backoff")).toBeLessThan(
      pieces.indexOf("sym:helpers.py#clamp"),
    );
    // the tests step names the changed symbols no test references
    const tests = steps.at(-2)!.note!;
    expect(tests).toContain("No test found for");
    expect(tests).toContain("`clamp`");
    // the steps cite changed lines: no step shows more than 2 ranges
    for (const step of steps) expect(step.code!.length).toBeLessThanOrEqual(2);
  });
});

describe("xpl draft change: small changes to methods of one class", () => {
  it("share one group box and one tour step", async () => {
    const dir = makeTempDir("xpl-draft-siblings-");
    const v1 = [
      "class Sender:",
      "    def simple(self, send):",
      "        return send(open('a'))",
      "",
      "    def ranged(self, send):",
      "        return send(open('b'))",
      "",
      "    def multi(self, send):",
      "        return send(open('c'))",
      "",
    ].join("\n");
    writeFile(dir, "sender.py", v1);
    writeFile(
      dir,
      "app.py",
      "from sender import Sender\n\n\ndef serve(send):\n    return Sender().simple(send)\n",
    );
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    writeFile(dir, "sender.py", v1.replace(/open\('(\w)'\)/g, "self._open('$1')"));
    git(dir, "commit", "-q", "-am", "head");
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
    expect((await xpl(dir, "new", "pr")).code).toBe(0);
    expect((await xpl(dir, "change", "pr", "HEAD~1..HEAD")).code).toBe(0);
    const { patch } = await draftApplyCheck(dir, "pr", ["change", "pr"]);
    const group = patch.nodes!.find((n) => n.id === "grp:sender-changes")!;
    expect(group.members).toEqual([
      "sym:sender.py#Sender.simple",
      "sym:sender.py#Sender.ranged",
      "sym:sender.py#Sender.multi",
    ]);
    expect(group.label).toMatch(/^TODO: /);
    const view = patch.views![0]!;
    if (view.type !== "graph") throw new Error("a map");
    expect(view.include).toContain("grp:sender-changes");
    expect(view.include).toContain("sym:app.py#serve");
    const steps = patch.tours![0]!.steps!;
    // the group is the main box (the first and the last step focus it) and gets one step of its own
    const pieces = steps.filter((s) => s.note!.includes("what this piece does differently"));
    expect(pieces.map((s) => s.focus[0])).toEqual(["grp:sender-changes"]);
    const piece = pieces[0]!;
    expect(piece.note).toContain(
      "`Sender.simple`, `Sender.ranged` and `Sender.multi` change in a few lines each",
    );
    expect(piece.code).toHaveLength(2);
  });
});

describe("xpl draft change: no caller outside tests", () => {
  it("the entry step shows the changed public method and asks who calls it", async () => {
    const dir = makeTempDir("xpl-draft-entry-");
    const v1 = [
      "class Transport:",
      "    @staticmethod",
      "    def make():",
      "        return Transport()",
      "",
      "    def handle_request(self, request):",
      "        return request",
      "",
    ].join("\n");
    const v2 = v1.replace(
      "        return request\n",
      [
        "        self._log(request)",
        "        return request",
        "",
        "    def _log(self, request):",
        "        print(request)",
        "",
      ].join("\n"),
    );
    writeFile(dir, "transport.py", v1);
    writeFile(
      dir,
      "tests/test_transport.py",
      "from transport import Transport\n\n\ndef test_send():\n    assert Transport().handle_request(1) == 1\n",
    );
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    writeFile(dir, "transport.py", v2);
    git(dir, "commit", "-q", "-am", "head");
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
    expect((await xpl(dir, "new", "pr")).code).toBe(0);
    expect((await xpl(dir, "change", "pr", "HEAD~1..HEAD")).code).toBe(0);
    const { patch } = await draftApplyCheck(dir, "pr", ["change", "pr"]);
    checkShape(patch);
    const steps = patch.tours![0]!.steps!;
    expect(steps[0]!.note).toContain("what changes for users");
    const entry = steps[1]!;
    expect(entry.id).toBe("t20");
    expect(entry.note).toContain("where the change enters");
    expect(entry.note).toContain("no caller of `Transport.handle_request` outside tests");
    expect(entry.focus).toEqual(["sym:transport.py#Transport.handle_request"]);
    // its code is the line with the name, not the whole method
    expect(entry.code).toEqual([
      {
        file: "transport.py",
        symbol: "Transport.handle_request",
        span: { from: 0, to: 0 },
        role: "definition",
      },
    ]);
  });
});

describe("xpl draft change: type tests and type references", () => {
  it("a type test is a test, and code that only names a type is no caller", async () => {
    const dir = makeTempDir("xpl-draft-typetests-");
    writeFile(dir, "package.json", '{ "name": "client" }\n');
    writeFile(dir, "src/options.ts", "export interface Options {\n  limit?: number;\n}\n");
    const client = [
      'import type { Options } from "./options.js";',
      "",
      "export function send(url: string, options: Options = {}) {",
      "  return url.length + (options.limit ?? 0);",
      "}",
      "",
    ].join("\n");
    writeFile(dir, "src/client.ts", client);
    writeFile(
      dir,
      "src/index.ts",
      'import { send } from "./client.js";\n\nexport function get(url: string) {\n  return send(url);\n}\n',
    );
    writeFile(
      dir,
      "src/defaults.ts",
      'import type { Options } from "./options.js";\n\nexport const defaults: Options = {};\n',
    );
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    writeFile(
      dir,
      "src/options.ts",
      "export interface Options {\n  limit?: number;\n  max?: number;\n}\n",
    );
    writeFile(
      dir,
      "src/client.ts",
      client.replace("(options.limit ?? 0)", "Math.min(options.limit ?? 0, options.max ?? 10)"),
    );
    writeFile(
      dir,
      "test-d/send.ts",
      'import { send } from "../src/client.js";\n\nexport const sent: number = send("a", { max: 1 });\n',
    );
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "head");
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
    expect((await xpl(dir, "new", "pr")).code).toBe(0);
    const recorded = await xpl(dir, "change", "pr", "HEAD~1..HEAD");
    expect(recorded.out).toMatch(/A {2}test-d\/send\.ts .*\(test\)/);
    const { patch, notes } = await draftApplyCheck(dir, "pr", ["change", "pr"]);
    checkShape(patch);
    const view = patch.views![0]!;
    if (view.type !== "graph") throw new Error("a map");
    // the type test sits in the tests box, never on the map as changed code or as the way in
    expect(view.include!.some((id) => id.includes("test-d"))).toBe(false);
    const tests = patch.nodes!.find((n) => n.id === "grp:change-tests")!;
    expect(JSON.stringify(tests.members)).toContain("test-d/send.ts");
    const steps = patch.tours![0]!.steps!;
    expect(steps[1]!.note).toContain("where the change enters");
    expect(steps[1]!.focus).toEqual(["sym:src/index.ts#get"]);
    // `defaults` only names the type: no box, no "who else" step
    expect(view.include).not.toContain("sym:src/defaults.ts#defaults");
    expect(JSON.stringify(patch)).not.toContain("defaults");
    expect(notes.join("\n")).not.toContain("defaults");
    // every focus is a box of the map
    for (const step of steps) for (const id of step.focus) expect(view.include).toContain(id);
  });
});

describe("draftProblems", () => {
  it("finds ids named nowhere and a focus off its view", () => {
    const model = new IndexModel({
      schema: "code-explainer/index@0",
      commit: "abc1234",
      files: [{ path: "a.ts", language: "typescript", hash: "x", lines: 3 }],
      symbols: [
        {
          id: "a.ts#run",
          file: "a.ts",
          path: "run",
          kind: "function",
          range: { startLine: 1, endLine: 3 },
        },
      ],
      refs: [],
    } as unknown as SymbolIndex);
    const explainer = { nodes: [], views: [], tours: [] } as unknown as Explainer;
    const patch: ExplainerPatch = {
      nodes: [{ id: "grp:real", label: "Real", summary: "TODO: x", members: ["sym:a.ts#run"] }],
      views: [{ id: "view:map", type: "graph", title: "Map", include: ["grp:real"] }],
      tours: [
        {
          id: "tour:t",
          title: "T",
          summary: "S",
          steps: [
            { id: "t1", view: "view:map", focus: ["grp:real"], note: "Uses `sym:a.ts#run`." },
            { id: "t2", view: "view:map", focus: ["file:a.ts"], note: "Also grp:gone." },
          ],
        },
      ],
    };
    const problems = draftProblems(
      { kind: "change", patch, notes: ["left off: grp:phantom, sym:a.ts#run"] },
      explainer,
      model,
    );
    expect(problems.sort()).toEqual(
      [
        "grp:gone is named but exists nowhere",
        "grp:phantom is named but exists nowhere",
        "tour:t step t2: focus file:a.ts is not on view:map",
      ].sort(),
    );
  });
});

// ─── lint: todo-left ─────────────────────────────────────────────────────────────────────────────

describe("lint todo-left", () => {
  const base = {
    schema: "code-explainer@0",
    title: "Job runner",
    repo: { name: "demo", commit: "c" },
    index: { path: ".explainer/index-c.json", commit: "c" },
    edges: [],
    concepts: [],
  };

  it("an error-level finding per field with a TODO, code spans and names left out", () => {
    const { findings } = lintExplainer({
      ...base,
      nodes: [
        { id: "sym:a#x", summary: "TODO: one line: what this does." },
        { id: "sym:a#y", summary: "Reads `TODO` markers from the file and the `TODO_LIST` key." },
        { id: "sym:a#z", summary: "Collects TODOs and todo items." },
      ],
      views: [
        {
          id: "view:m",
          type: "graph",
          title: "TODO: what the map shows",
          scope: { root: "repo", depth: 1, question: "TODO: the question" },
          include: [],
        },
      ],
      tours: [
        {
          id: "tour:t",
          title: "How a job runs",
          summary: "A job goes from the queue to a worker. TODO: the risk.",
          steps: [
            {
              id: "t1",
              view: "view:m",
              focus: [],
              note: "### TODO: a title\n\nTODO: the body. TODO: more.",
            },
          ],
        },
      ],
    } as unknown as Explainer);
    const todo = findings.filter((f) => f.rule === "todo-left");
    expect(todo.map((f) => [f.elementId, f.field])).toEqual([
      ["tour:t", "summary"],
      ["tour:t/t1", "note heading"],
      ["tour:t/t1", "note"],
      ["view:m", "title"],
      ["view:m", "question"],
      ["sym:a#x", "summary"],
    ]);
    expect(todo.every((f) => f.severity === "error")).toBe(true);
    expect(todo[2]!.message).toBe("2 TODO placeholders left: text nobody has written yet");
    expect(todo[0]!.quote).toContain("TODO: the risk.");
    // the other rules stay warnings (no severity)
    expect(findings.filter((f) => f.rule !== "todo-left").every((f) => !f.severity)).toBe(true);
  });

  it("xpl lint: todo-left is an error in the output, exit 1 even with --warn-only", async () => {
    const dir = await indexedFixture("ts-jobrunner");
    expect((await xpl(dir, "new", "d")).code).toBe(0);
    const out = join(makeTempDir("xpl-draft-out-"), "repo.json");
    expect((await xpl(dir, "draft", "repo", "d", "-o", out)).code).toBe(0);
    const r = await xpl(dir, "lint", "d", "--patch", out);
    expect(r.code).toBe(1);
    expect(r.out).toContain("  summary  error todo-left: 1 TODO placeholder left");
    expect(r.out.split("\n").at(-1)).toMatch(
      /^\d+ findings in \d+ elements \(todo-left \d+\); \d+ errors \(todo-left\)$/,
    );
    const warnOnly = await xpl(dir, "lint", "d", "--patch", out, "--warn-only");
    expect(warnOnly.code).toBe(1);
    expect(warnOnly.out.split("\n").at(-1)).toMatch(
      /errors \(todo-left\): exit 1 even with --warn-only$/,
    );
  });
});
