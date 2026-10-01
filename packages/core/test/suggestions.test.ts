import { describe, expect, it } from "vitest";
import {
  applyPatch,
  describeSymbolCandidate,
  isTestFile,
  makeAnchor,
  normalizeElementId,
  reresolveExplainer,
  resolveAnchor,
  suggestIds,
  validateExplainer,
  type SymbolHint,
} from "../src/index.js";
import {
  anchor,
  concept,
  emptyExplainer,
  graphView,
  group,
  JOBRUNNER,
  jobrunner,
  makeWorld,
  RUNNER_TEXT,
  sequenceView,
  type WorldDecl,
} from "./helpers.js";

/** The job runner after `Runner.dispatch` was renamed to `Runner.run` (same lines, same body). */
function renamed(extra: Partial<WorldDecl> = {}) {
  return makeWorld({
    ...JOBRUNNER,
    files: JOBRUNNER.files.map((f) =>
      f.path === "src/runner.ts"
        ? { ...f, text: RUNNER_TEXT.replace("async dispatch()", "async run()") }
        : f,
    ),
    symbols: JOBRUNNER.symbols!.map((s) =>
      s.id === "src/runner.ts#Runner.dispatch" ? { ...s, id: "src/runner.ts#Runner.run" } : s,
    ),
    refs: [],
    ...extra,
  });
}

const ids = (list: { id: string }[]) => list.map((s) => s.id);

describe("describeSymbolCandidate", () => {
  it("spells the id, and for an anchor also the fields it takes", () => {
    const sym = { file: "src/runner.ts", path: "Runner.dispatch" };
    expect(describeSymbolCandidate(sym)).toBe("sym:src/runner.ts#Runner.dispatch");
    expect(describeSymbolCandidate(sym, { anchor: true })).toBe(
      'sym:src/runner.ts#Runner.dispatch (anchor: file: "src/runner.ts", symbol: "Runner.dispatch")',
    );
    expect(describeSymbolCandidate(sym, { anchor: true, extra: ", span: {from: 1, to: 2}" })).toBe(
      'sym:src/runner.ts#Runner.dispatch (anchor: file: "src/runner.ts", symbol: "Runner.dispatch", span: {from: 1, to: 2})',
    );
  });
});

describe("suggestSymbols", () => {
  const world = renamed();
  const suggest = (path: string, hint?: SymbolHint, file = "src/runner.ts", limit = 5) =>
    ids(world.model.suggestSymbols(file, path, limit, hint));

  it("finds a renamed method among its siblings by size when the old size is known", () => {
    // Runner.dispatch was 47 lines; Runner.run is 47 lines, start/stop/log are short
    expect(suggest("Runner.dispatch", { lines: 47 })[0]).toBe("src/runner.ts#Runner.run");
    expect(suggest("Runner.dispatch", { lines: 47, kind: "method" })[0]).toBe(
      "src/runner.ts#Runner.run",
    );
  });

  it("a typo finds its sibling by name, no hint needed", () => {
    const plain = jobrunner();
    expect(ids(plain.model.suggestSymbols("src/runner.ts", "Runner.dispach"))).toEqual([
      "src/runner.ts#Runner.dispatch",
    ]);
  });

  it("members that merely share the class are not candidates; a similar name is", () => {
    // nothing about Runner.dispatch fits any of Runner's other members: no candidates, not a guess list
    expect(suggest("Runner.dispatch")).toEqual([]);
    // a similar name does
    const plain = jobrunner();
    expect(ids(plain.model.suggestSymbols("src/runner.ts", "Runner.stpo"))).toEqual([
      "src/runner.ts#Runner.stop",
    ]);
    // top-level symbols say nothing about each other either
    expect(suggest("Zzz")).toEqual([]);
  });

  it("a size only stands in for a name when it points at one sibling", () => {
    const w = makeWorld({
      files: [{ path: "src/q.ts", lines: 60 }],
      symbols: [
        { id: "src/q.ts#Queue", kind: "class", start: 1, end: 59 },
        { id: "src/q.ts#Queue.requeue", start: 2, end: 5 }, // 4 lines
        { id: "src/q.ts#Queue.deadLetter", start: 7, end: 10 }, // 4 lines
        { id: "src/q.ts#Queue.acked", kind: "variable", start: 12, end: 12 },
        { id: "src/q.ts#Queue.drain", start: 14, end: 43 }, // 30 lines
      ],
    });
    const at = (path: string, lines: number) =>
      ids(w.model.suggestSymbols("src/q.ts", path, 5, { lines }));
    // a deleted four-line Queue.ack: two siblings have that size, so it says nothing; `acked` fits by name
    expect(at("Queue.ack", 4)).toEqual(["src/q.ts#Queue.acked"]);
    // a renamed 30-line method: exactly one sibling has that size
    expect(at("Queue.flush", 30)).toEqual(["src/q.ts#Queue.drain"]);
    // tiny symbols are never matched by size
    expect(at("Queue.ack", 1)).not.toContain("src/q.ts#Queue.requeue");
  });

  it("same kind first when the kind is known", () => {
    const w = makeWorld({
      files: [{ path: "src/a.ts", lines: 40 }],
      symbols: [
        { id: "src/a.ts#Box", kind: "class", start: 1, end: 39 },
        { id: "src/a.ts#Box.size", kind: "variable", start: 2, end: 2 },
        { id: "src/a.ts#Box.sizeOf", kind: "method", start: 4, end: 8 },
      ],
    });
    const at = (hint: SymbolHint) => ids(w.model.suggestSymbols("src/a.ts", "Box.sizes", 5, hint));
    expect(at({})[0]).toBe("src/a.ts#Box.size"); // the closer name
    expect(at({ kind: "method" })[0]).toBe("src/a.ts#Box.sizeOf");
    expect(at({ kind: "variable" })[0]).toBe("src/a.ts#Box.size");
  });

  it("then symbols with the same name elsewhere: same file first, then other files; tests last", () => {
    const w = makeWorld({
      files: [
        { path: "src/a.ts", lines: 60 },
        { path: "src/b.ts", lines: 30 },
        { path: "test/a.test.ts", lines: 30 },
      ],
      symbols: [
        { id: "src/a.ts#Old", kind: "class", start: 1, end: 20 },
        { id: "src/a.ts#Other", kind: "class", start: 22, end: 50 },
        { id: "src/a.ts#Other.go", start: 23, end: 30 },
        { id: "test/a.test.ts#Fake.go", start: 2, end: 8 },
        { id: "src/b.ts#Thing.go", start: 2, end: 8 },
      ],
    });
    const at = (path: string) => ids(w.model.suggestSymbols("src/a.ts", path));
    // Old.go is gone: same name under another parent in the file, then in other files, the test double last
    expect(at("Old.go")).toEqual([
      "src/a.ts#Other.go",
      "src/b.ts#Thing.go",
      "test/a.test.ts#Fake.go",
    ]);
    // ...but for an anchor in a test file, its own siblings are not pushed down
    const fromTest = ids(w.model.suggestSymbols("test/a.test.ts", "Fake.gone"));
    expect(fromTest[0]).toBe("test/a.test.ts#Fake.go");
  });

  it("a symbol with the identical text (a move) beats everything, unless the text is tiny", () => {
    const text = [
      "class A {",
      "  walk() {}",
      "}",
      "class B {",
      "  run() {",
      "    first();",
      "    second();",
      "    third();",
      "  }",
      "  other() {}",
      "}",
    ].join("\n");
    const w = makeWorld({
      files: [{ path: "src/a.ts", text }],
      symbols: [
        { id: "src/a.ts#A", kind: "class", start: 1, end: 3 },
        { id: "src/a.ts#A.walk", start: 2, end: 2 },
        { id: "src/a.ts#B", kind: "class", start: 4, end: 11 },
        { id: "src/a.ts#B.run", start: 5, end: 9 },
        { id: "src/a.ts#B.other", start: 10, end: 10 },
      ],
    });
    const hashOfRun = w.model.symbol("src/a.ts#B.run")!.hash;
    expect(ids(w.model.suggestSymbols("src/a.ts", "A.go", 3, { hash: hashOfRun }))[0]).toBe(
      "src/a.ts#B.run",
    );
    // a one-line body is not evidence
    const tiny = w.model.symbol("src/a.ts#B.other")!.hash;
    expect(ids(w.model.suggestSymbols("src/a.ts", "A.go", 3, { hash: tiny }))).not.toContain(
      "src/a.ts#B.other",
    );
  });

  it("isTestFile follows the shared test-file globs", () => {
    expect(isTestFile("internal/runner/retry_test.go")).toBe(true);
    expect(isTestFile("src/runner.ts")).toBe(false);
  });
});

describe("a stored anchor whose symbol was renamed", () => {
  const before = jobrunner();
  const after = renamed();

  it("whole-symbol anchors remember their size: the renamed symbol is the first candidate", () => {
    const stored = anchor(before, {
      file: "src/runner.ts",
      symbol: "Runner.dispatch",
      role: "definition",
    });
    const r = resolveAnchor(stored, after.index, after.getText);
    expect(r.status).toBe("missing");
    expect(r.reason).toMatch(
      /^symbol Runner\.dispatch is not in src\/runner\.ts; did you mean sym:src\/runner\.ts#Runner\.run \(anchor: file: "src\/runner\.ts", symbol: "Runner\.run"\)/,
    );
  });

  it("span anchors are found by their text: it now sits in Runner.run, at the same offsets", () => {
    const stored = anchor(before, {
      file: "src/runner.ts",
      symbol: "Runner.dispatch",
      span: { from: 34, to: 36 },
      role: "call-site",
    });
    const r = resolveAnchor(stored, after.index, after.getText);
    expect(r.status).toBe("missing");
    expect(r.reason).toContain(
      'the anchored lines now sit in sym:src/runner.ts#Runner.run (anchor: file: "src/runner.ts", symbol: "Runner.run", span: {from: 34, to: 36})',
    );
    // the candidates that follow do not repeat it
    expect(r.reason!.match(/Runner\.run"/g)).toHaveLength(1);
  });

  it("finds the text after the code moved to another symbol, at its new offsets", () => {
    const stored = anchor(before, {
      file: "src/runner.ts",
      symbol: "Runner.dispatch",
      span: { from: 34, to: 36 },
      role: "call-site",
    });
    // dispatch is gone; its requeue block now lives in Runner.stop (lines 30-40), at lines 33-35
    const lines = RUNNER_TEXT.split("\n");
    for (let n = 76; n <= 78; n++) lines[n - 1] = `// ${n}`;
    for (const [i, text] of RUNNER_TEXT.split("\n").slice(75, 78).entries()) {
      lines[33 + i - 1] = text;
    }
    const moved = makeWorld({
      ...JOBRUNNER,
      files: JOBRUNNER.files.map((f) =>
        f.path === "src/runner.ts" ? { ...f, text: lines.join("\n") } : f,
      ),
      symbols: JOBRUNNER.symbols!.filter((s) => !s.id.endsWith("Runner.dispatch")),
      refs: [],
    });
    const r = resolveAnchor(stored, moved.index, moved.getText);
    // the block is now at lines 33-35, inside Runner.stop (30-40): offsets 3..5
    expect(r.status).toBe("missing");
    expect(r.reason).toContain(
      'the anchored lines now sit in sym:src/runner.ts#Runner.stop (anchor: file: "src/runner.ts", symbol: "Runner.stop", span: {from: 3, to: 5})',
    );
  });

  it("no relocation when the text is gone too", () => {
    const stored = anchor(before, {
      file: "src/runner.ts",
      symbol: "Runner.dispatch",
      span: { from: 34, to: 36 },
      role: "call-site",
    });
    const edited = renamed({
      files: JOBRUNNER.files.map((f) =>
        f.path === "src/runner.ts"
          ? {
              ...f,
              text: RUNNER_TEXT.replace("async dispatch()", "async run()").replace(
                "await this.queue.requeue(",
                "await this.queue.requeueLater(",
              ),
            }
          : f,
      ),
    });
    const r = resolveAnchor(stored, edited.index, edited.getText);
    // a span says nothing about the size of the symbol it was in, and its text is gone: nothing to go by
    expect(r.reason).toBe("symbol Runner.dispatch is not in src/runner.ts");
  });

  it("validate and reresolve carry the message, and the view of a missing or drifted step", () => {
    const step = (id: string, span: { from: number; to: number }) => ({
      id,
      from: "sym:src/runner.ts#Runner.dispatch",
      to: "file:src/queue.ts",
      label: "requeue()",
      kind: "call" as const,
      anchors: [
        anchor(before, {
          file: "src/runner.ts",
          symbol: "Runner.dispatch",
          span,
          role: "call-site",
        }),
      ],
    });
    const ex = emptyExplainer({
      views: [
        sequenceView(
          "view:dispatch",
          ["sym:src/runner.ts#Runner.dispatch", "file:src/queue.ts"],
          [step("dispatch:1", { from: 34, to: 36 })],
        ),
      ],
    });
    const { report } = reresolveExplainer(ex, after.index, after.getText);
    expect(report.missing).toHaveLength(1);
    expect(report.missing[0]).toMatchObject({
      elementId: "dispatch:1",
      owner: "step",
      view: "view:dispatch",
    });
    expect(report.missing[0]!.reason).toContain("now sit in sym:src/runner.ts#Runner.run");
    const issues = validateExplainer(ex, after.index, after.getText, { mode: "lenient" });
    expect(issues.find((i) => i.code === "anchor-missing")!.message).toContain(
      'anchor: file: "src/runner.ts", symbol: "Runner.run", span: {from: 34, to: 36}',
    );

    // a drifted step names its view too
    const drifted = makeWorld({
      ...JOBRUNNER,
      files: JOBRUNNER.files.map((f) =>
        f.path === "src/runner.ts"
          ? {
              ...f,
              text: RUNNER_TEXT.replace("await this.queue.requeue(", "await this.queue.later("),
            }
          : f,
      ),
    });
    const again = reresolveExplainer(ex, drifted.index, drifted.getText).report;
    expect(again.drifted).toHaveLength(1);
    expect(again.drifted[0]).toMatchObject({
      elementId: "dispatch:1",
      owner: "step",
      view: "view:dispatch",
    });
  });
});

describe("makeAnchor and applyPatch suggest with what is known", () => {
  const before = jobrunner();
  const after = renamed();

  it("makeAnchor uses the symbolHint option and prints both forms", () => {
    const input = { file: "src/runner.ts", symbol: "Runner.dispatch", role: "definition" } as const;
    const bare = makeAnchor(input, after.index, after.getText);
    const hinted = makeAnchor(input, after.index, after.getText, {
      symbolHint: () => ({ lines: 47 }),
    });
    expect(bare.ok).toBe(false);
    expect(hinted.ok).toBe(false);
    if (!hinted.ok) {
      expect(hinted.error).toContain(
        'Did you mean: sym:src/runner.ts#Runner.run (anchor: file: "src/runner.ts", symbol: "Runner.run")',
      );
      // the size fits only Runner.run, so the siblings that merely share the class are left out
      expect(hinted.error).not.toContain("Runner.start");
    }
  });

  it("applyPatch takes the hint from the explainer's own whole-symbol anchors", () => {
    const stored = anchor(before, {
      file: "src/runner.ts",
      symbol: "Runner.dispatch",
      role: "definition",
    });
    const ex = emptyExplainer({
      concepts: [
        { id: "concept:loop", label: "Loop", anchors: [stored], provenance: { origin: "llm" } },
      ],
    });
    const result = applyPatch(
      ex,
      {
        concepts: [
          {
            id: "concept:loop",
            anchors: [{ file: "src/runner.ts", symbol: "Runner.dispatch", role: "definition" }],
          },
        ],
      },
      after.index,
      after.getText,
      { actor: "llm" },
    );
    expect(result.ok).toBe(false);
    const message = result.issues.find((i) => i.path === "concepts[0].anchors[0]")!.message;
    expect(message).toContain(
      'Did you mean: sym:src/runner.ts#Runner.run (anchor: file: "src/runner.ts", symbol: "Runner.run")',
    );
  });
});

describe("ids in an explainer that point at a renamed symbol", () => {
  it("validate finds it by the size its whole-symbol anchors remember", () => {
    const before = jobrunner();
    const after = renamed();
    const stored = anchor(before, {
      file: "src/runner.ts",
      symbol: "Runner.dispatch",
      role: "definition",
    });
    const ex = emptyExplainer({
      nodes: [
        {
          id: "sym:src/runner.ts#Runner.dispatch",
          kind: "symbol",
          parent: "sym:src/runner.ts#Runner",
          label: "Runner.dispatch",
          anchors: [stored],
          provenance: { origin: "llm" },
        },
      ],
      concepts: [
        {
          id: "concept:loop",
          label: "Loop",
          anchors: [],
          related: ["sym:src/runner.ts#Runner.dispatch"],
          provenance: { origin: "llm" },
        },
      ],
    });
    const issues = validateExplainer(ex, after.index, after.getText, { mode: "lenient" });
    const related = issues.find((i) => i.path === "concepts[0].related[0]")!;
    expect(related.message).toContain("Did you mean: sym:src/runner.ts#Runner.run?");
    // without any anchor to remember the size there is nothing to go by
    const bare = emptyExplainer({ concepts: [{ ...ex.concepts[0]!, anchors: [] }] });
    const noHint = validateExplainer(bare, after.index, after.getText, { mode: "lenient" });
    expect(noHint.find((i) => i.path === "concepts[0].related[0]")!.message).not.toContain(
      "Runner.run",
    );
  });
});

describe("normalizeElementId suggests ids", () => {
  it("prints the sym: form, so it can be pasted where an id goes", () => {
    const w = jobrunner();
    const r = normalizeElementId("src/queue.ts#Queue.pup", w.model);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("Did you mean: sym:src/queue.ts#Queue.pop");
      expect(r.candidates?.[0]).toBe("sym:src/queue.ts#Queue.pop");
    }
  });
});

describe("suggestIds", () => {
  const known = [
    "grp:scheduling",
    "grp:retry-engine",
    "concept:retry-policy",
    "concept:idempotency",
    "edge:job-completed",
    "view:overview",
    "view:dispatch",
    "tour:intro",
    "dispatch:1",
    "dispatch:2",
    "apply-flow:1",
    "apply-flow:4",
    "file:src/queue.ts",
  ];

  it("offers the same kind with a similar slug: a longer name, a typo, another case", () => {
    expect(suggestIds("concept:retry", known)).toEqual(["concept:retry-policy"]);
    expect(suggestIds("grp:sched", known)).toEqual(["grp:scheduling"]);
    expect(suggestIds("edge:job-complete", known)).toEqual(["edge:job-completed"]);
    expect(suggestIds("view:Overview", known)).toEqual(["view:overview"]);
    expect(suggestIds("tour:intro2", known)).toEqual(["tour:intro"]);
  });

  it("offers the right slug under another kind, after the same kind", () => {
    expect(suggestIds("grp:retry-policy", known)).toEqual(["concept:retry-policy"]);
    expect(suggestIds("concept:retry-engine", known)).toEqual(["grp:retry-engine"]);
    expect(suggestIds("grp:retry-policy", ["concept:retry-policy", "grp:retry-policies"])).toEqual([
      "grp:retry-policies",
      "concept:retry-policy",
    ]);
  });

  it("takes text without a known prefix as a slug of any kind", () => {
    expect(suggestIds("retry-policy", known)).toEqual(["concept:retry-policy"]);
    expect(suggestIds("group:scheduling", known)).toEqual(["grp:scheduling"]);
    expect(suggestIds("overview", known)).toEqual(["view:overview"]);
  });

  it("a step: the step with the same number in a view of a similar name", () => {
    expect(suggestIds("apply:4", known)).toEqual(["apply-flow:4"]);
    expect(suggestIds("dispach:2", known)).toEqual(["dispatch:2"]);
    // a number nobody has, and a view nobody has: nothing worth saying
    expect(suggestIds("dispatch:9", known)).toEqual([]);
    expect(suggestIds("zzz:1", known)).toEqual([]);
  });

  it("is quiet when nothing is close, never offers the id itself, and honours the limit", () => {
    expect(suggestIds("concept:zzz", known)).toEqual([]);
    expect(suggestIds("view:overview", known)).toEqual([]);
    expect(suggestIds("", known)).toEqual([]);
    const many = ["a1", "a2", "a3", "a4"].map((slug) => `grp:${slug}`);
    expect(suggestIds("grp:a", many)).toHaveLength(3);
    expect(suggestIds("grp:a", many, 2)).toHaveLength(2);
    // structural ids belong to the index (normalizeElementId): never offered here
    expect(suggestIds("file:src/queue", known)).toEqual([]);
  });
});

describe("an unknown id in an explainer says what was probably meant", () => {
  const w = jobrunner();
  const F = { queue: "file:src/queue.ts", runner: "file:src/runner.ts" };
  const DISPATCH = "sym:src/runner.ts#Runner.dispatch";
  const step = (id: string, label: string) => ({
    id,
    from: DISPATCH,
    to: F.queue,
    label,
    kind: "call" as const,
    anchors: [],
  });
  const explainer = () =>
    emptyExplainer({
      nodes: [group("grp:scheduling", [F.runner, F.queue])],
      concepts: [concept("concept:retry-policy")],
      views: [
        graphView("view:overview", ["grp:scheduling"]),
        sequenceView(
          "view:dispatch",
          [DISPATCH, F.queue],
          [step("dispatch:1", "a"), step("dispatch:2", "b")],
        ),
        sequenceView(
          "view:apply-flow",
          [DISPATCH, F.queue],
          [1, 2, 3, 4].map((n) => step(`apply-flow:${n}`, `s${n}`)),
        ),
      ],
      tours: [{ id: "tour:intro", title: "Intro", steps: [] }],
    });
  const messages = (patch: (ex: ReturnType<typeof explainer>) => void): string[] => {
    const ex = explainer();
    patch(ex);
    return validateExplainer(ex, w.index, w.getText, { mode: "strict" })
      .filter((i) => i.severity === "error")
      .map((i) => i.message);
  };
  const relatedOf =
    (...ids: string[]) =>
    (ex: ReturnType<typeof explainer>) => {
      ex.concepts[0]!.related = ids;
    };

  it("is valid to start with", () => {
    expect(validateExplainer(explainer(), w.index, w.getText, { mode: "strict" })).toEqual([]);
  });

  it("a step: `apply:4` when `apply-flow:4` exists", () => {
    expect(messages(relatedOf("apply:4"))).toEqual([
      "related: no step with id apply:4 in this explainer. Did you mean: apply-flow:4?",
    ]);
  });

  it("a step of a view that exists: names the view's steps", () => {
    expect(messages(relatedOf("dispatch:9"))).toEqual([
      "related: no step dispatch:9 in view:dispatch (its steps: dispatch:1, dispatch:2)",
    ]);
  });

  it("a concept, a group, an edge", () => {
    expect(messages(relatedOf("concept:retry"))).toEqual([
      "related: no concept with id concept:retry in this explainer. Did you mean: concept:retry-policy?",
    ]);
    expect(messages(relatedOf("edge:nope"))).toEqual([
      "related: no edge with id edge:nope in this explainer",
    ]);
    expect(
      messages((ex) => {
        ex.views[0] = graphView("view:overview", ["grp:sched", F.queue]);
      }),
    ).toEqual(["include: no group grp:sched in this explainer. Did you mean: grp:scheduling?"]);
    expect(
      messages((ex) => {
        ex.nodes[0]!.members = ["grp:schedulin"];
      }),
    ).toEqual(["member: no group grp:schedulin in this explainer. Did you mean: grp:scheduling?"]);
  });

  it("a text that is not an id at all: the id it looks like", () => {
    expect(messages(relatedOf("retry-policy"))).toEqual([
      'related: "retry-policy" is not an element id; did you mean concept:retry-policy?',
    ]);
    expect(messages(relatedOf("zzz"))[0]).toContain('"zzz" is not an element id (expected');
  });

  it("a tour step's view: the closest, else the views there are", () => {
    const tour = (view: string) => (ex: ReturnType<typeof explainer>) => {
      ex.tours[0]!.steps = [{ id: "t1", view, focus: [] }];
    };
    expect(messages(tour("view:overvew"))).toEqual([
      'tour step view "view:overvew" is not a view of this explainer. Did you mean: view:overview?',
    ]);
    expect(messages(tour("overview"))).toEqual([
      'tour step view "overview" is not a view of this explainer. Did you mean: view:overview?',
    ]);
    expect(messages(tour("view:zzz"))).toEqual([
      'tour step view "view:zzz" is not a view of this explainer (views: view:overview, view:dispatch, view:apply-flow)',
    ]);
  });

  it("a tour step's focus is checked the same way", () => {
    expect(
      messages((ex) => {
        ex.tours[0]!.steps = [
          { id: "t1", view: "view:dispatch", focus: ["dispatch:3", "apply:2"] },
        ];
      }),
    ).toEqual([
      "focus: no step dispatch:3 in view:dispatch (its steps: dispatch:1, dispatch:2)",
      "focus: no step with id apply:2 in this explainer. Did you mean: apply-flow:2?",
    ]);
  });

  it("applyPatch says the same for a removal that names nothing (a warning)", () => {
    const r = applyPatch(
      explainer(),
      { remove: ["tour:intr", "concept:retry", "dispatch:9", "view:zzz"] },
      w.index,
      w.getText,
      { actor: "llm" },
    );
    expect(r.ok).toBe(true);
    expect(r.issues.map((i) => i.message)).toEqual([
      "nothing to remove: no element, view, tour or step has the id tour:intr. Did you mean: tour:intro?",
      "nothing to remove: no element, view, tour or step has the id concept:retry. Did you mean: concept:retry-policy?",
      "nothing to remove: no element, view, tour or step has the id dispatch:9",
      "nothing to remove: no element, view, tour or step has the id view:zzz",
    ]);
  });
});
