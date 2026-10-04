/**
 * SCIP -> references (src/scip/map.ts). The SCIP indexes are synthetic (built with the encoder in
 * ./scip-encode.ts and decoded again), the repository is real: `buildIndex` builds the symbols and hands
 * the mapper the same `PreciseInput` a real run would get, with the real language packs classifying sites.
 */
import { describe, expect, it } from "vitest";
import type { FileLanguage, Reference, SymbolIndex } from "@xpl/core";
import { buildIndex } from "../src/index.js";
import type { PreciseInput, PreciseResolver } from "../src/index.js";
import { documentPath, mapScip, toUtf16Offset } from "../src/scip/map.js";
import type { ColumnEncoding, MapResult, ScipSource } from "../src/scip/map.js";
import { PositionEncoding, SymbolRole } from "../src/scip/proto.js";
import type { DocumentSpec, RelationshipSpec } from "./scip-encode.js";
import { DEF, marked, moduleDef, occs, source, ts } from "./scip-dsl.js";
import type { Marked } from "./scip-dsl.js";
import { makeDir } from "./helpers.js";

const TS_LANGUAGES: FileLanguage[] = ["typescript", "tsx", "javascript"];

interface Run {
  index: SymbolIndex;
  refs: Reference[];
  result: MapResult;
  warnings: string[];
}

/** Build the repository, run the mapper as a precise resolver would, return what ends up in the index. */
async function run(
  files: Record<string, string>,
  sources: ScipSource[],
  languages: FileLanguage[] = TS_LANGUAGES,
  tweak: (input: PreciseInput) => PreciseInput = (input) => input,
): Promise<Run> {
  const dir = makeDir(files);
  let result: MapResult | undefined;
  const resolver: PreciseResolver = {
    id: "fake-scip",
    languages,
    async resolve(input) {
      result = await mapScip({ ...tweak(input), sources });
      return { refs: result.refs, tool: "fake-scip@0" };
    },
  };
  const { index, warnings } = await buildIndex({
    root: dir,
    precise: "auto",
    resolvers: [resolver],
  });
  if (!result) throw new Error("the resolver did not run");
  return { index, refs: index.refs, result, warnings };
}

/** `kind from -> to` lines, sorted, for readable assertions. */
function triples(refs: readonly Reference[]): string[] {
  return refs.map((r) => `${r.kind} ${r.from} -> ${r.to}`).sort();
}

// ─── The main scenario: calls, imports, types, constructors ───────────────────────────────────────

const queueSrc = marked(`export class ⟦Queue⟧ {
  ⟦constructor⟧(readonly ⟦max⟧: number) {}
  async ⟦requeue⟧(job: ⟦Job⟧, delayMs: number): Promise<void> {}
}
export interface ⟦Job⟧ {
  id: string;
}
export function ⟦helper⟧(x: number): number {
  return x;
}
`);

const runnerSrc = marked(`import { ⟦Queue⟧, ⟦helper⟧ } from ⟦"./queue.ts"⟧;
import type { ⟦Job⟧ } from ⟦"./queue.ts"⟧;
import * as ⟦q⟧ from ⟦"./queue.ts"⟧;
import ⟦"./side.ts"⟧;

export class ⟦Runner⟧ {
  private ⟦queue⟧: ⟦Queue⟧ = new ⟦Queue⟧(3);
  async dispatch(job: ⟦Job⟧): Promise<void> {
    await this.⟦queue⟧.⟦requeue⟧(
      job,
      ⟦helper⟧(5),
    );
  }
}
`);

const sideSrc = marked("export const side = 1;\n");

const Q = {
  cls: ts("src/queue.ts", "Queue#"),
  ctor: ts("src/queue.ts", "Queue#`<constructor>`()."),
  max: ts("src/queue.ts", "Queue#max."),
  requeue: ts("src/queue.ts", "Queue#requeue()."),
  job: ts("src/queue.ts", "Job#"),
  helper: ts("src/queue.ts", "helper()."),
};
const R = { runner: ts("src/runner.ts", "Runner#"), queue: ts("src/runner.ts", "Runner#queue.") };

function mainScenario(): { files: Record<string, string>; sources: ScipSource[] } {
  const files = {
    "src/queue.ts": queueSrc.text,
    "src/runner.ts": runnerSrc.text,
    "src/side.ts": sideSrc.text,
  };
  const sources = [
    source([
      {
        path: "src/queue.ts",
        occurrences: [
          moduleDef("src/queue.ts"),
          ...occs(queueSrc, [
            [0, Q.cls, DEF],
            [1, Q.ctor, DEF],
            [2, Q.max, DEF],
            [3, Q.requeue, DEF],
            [4, Q.job],
            [5, Q.job, DEF],
            [6, Q.helper, DEF],
          ]),
        ],
      },
      {
        path: "src/runner.ts",
        occurrences: [
          moduleDef("src/runner.ts"),
          ...occs(runnerSrc, [
            [0, Q.cls],
            [1, Q.helper],
            [2, ts("src/queue.ts")],
            [3, Q.job],
            [4, ts("src/queue.ts")],
            [5, "local 0", DEF],
            [6, ts("src/queue.ts")],
            [7, ts("src/side.ts")],
            [8, R.runner, DEF],
            [9, R.queue, DEF],
            [10, Q.cls],
            [11, Q.ctor],
            [12, Q.job],
            [13, R.queue],
            [14, Q.requeue],
            [15, Q.helper],
          ]),
        ],
      },
      { path: "src/side.ts", occurrences: [moduleDef("src/side.ts")] },
    ]),
  ];
  return { files, sources };
}

describe("mapScip: references from occurrences", () => {
  it("maps calls, imports and type references with innermost from/to symbols", async () => {
    const { files, sources } = mainScenario();
    const { refs, warnings } = await run(files, sources);
    expect(warnings).toEqual([]);
    expect(triples(refs)).toEqual(
      [
        // imports of names: from module scope to the symbol; `import type` is a type reference
        "import src/runner.ts# -> src/queue.ts#Queue",
        "import src/runner.ts# -> src/queue.ts#helper",
        "type-ref src/runner.ts# -> src/queue.ts#Job",
        // `import * as q from` and `import "./side.ts"` have no bindings: the module specifier stands for them
        "import src/runner.ts# -> src/queue.ts#",
        "import src/runner.ts# -> src/side.ts#",
        // `new Queue(3)` calls the class (the constructor symbol is folded into it)
        "call src/runner.ts#Runner.queue -> src/queue.ts#Queue",
        "type-ref src/runner.ts#Runner.queue -> src/queue.ts#Queue",
        "type-ref src/runner.ts#Runner.dispatch -> src/queue.ts#Job",
        // `this.queue.requeue(...)` reads the field `queue`
        "read src/runner.ts#Runner.dispatch -> src/runner.ts#Runner.queue",
        "call src/runner.ts#Runner.dispatch -> src/queue.ts#Queue.requeue",
        "call src/runner.ts#Runner.dispatch -> src/queue.ts#helper",
        "type-ref src/queue.ts#Queue.requeue -> src/queue.ts#Job",
      ].sort(),
    );
    expect(refs.every((r) => r.resolution === "precise")).toBe(true);
  });

  it("classifies imports by the syntax of the statement: `import type` and `{ type X }` are type references", async () => {
    const runner = marked(`import type { ⟦Job⟧ } from ⟦"./queue.ts"⟧;
import { type ⟦Queue⟧, ⟦helper⟧ } from ⟦"./queue.ts"⟧;
import type * as ⟦q⟧ from ⟦"./queue.ts"⟧;
import * as ⟦r⟧ from ⟦"./queue.ts"⟧;
`);
    const files = { ...mainScenario().files, "src/runner.ts": runner.text };
    const sources = [
      source([
        {
          path: "src/queue.ts",
          occurrences: [
            moduleDef("src/queue.ts"),
            ...occs(queueSrc, [
              [0, Q.cls, DEF],
              [1, Q.ctor, DEF],
              [2, Q.max, DEF],
              [3, Q.requeue, DEF],
              [4, Q.job],
              [5, Q.job, DEF],
              [6, Q.helper, DEF],
            ]),
          ],
        },
        {
          path: "src/runner.ts",
          occurrences: [
            moduleDef("src/runner.ts"),
            ...occs(runner, [
              [0, Q.job],
              [1, ts("src/queue.ts")],
              [2, Q.cls],
              [3, Q.helper],
              [4, ts("src/queue.ts")],
              [5, "local 0", DEF],
              [6, ts("src/queue.ts")],
              [7, "local 1", DEF],
              [8, ts("src/queue.ts")],
            ]),
          ],
        },
        { path: "src/side.ts", occurrences: [moduleDef("src/side.ts")] },
      ]),
    ];
    const { refs } = await run(files, sources);
    expect(triples(refs)).toEqual(
      [
        "type-ref src/runner.ts# -> src/queue.ts#Job",
        "type-ref src/runner.ts# -> src/queue.ts#Queue",
        "import src/runner.ts# -> src/queue.ts#helper",
        // `import type * as q` names nothing, so its quoted module stands for it (as a type reference)
        "type-ref src/runner.ts# -> src/queue.ts#",
        "import src/runner.ts# -> src/queue.ts#",
        "type-ref src/queue.ts#Queue.requeue -> src/queue.ts#Job",
      ].sort(),
    );
    const namespace = refs.find((r) => r.kind === "type-ref" && r.to === "src/queue.ts#")!;
    expect(namespace.site).toEqual({ startLine: 3, startCol: 25, endLine: 3, endCol: 36 });
  });

  it("takes kind and site from the language pack (the whole multi-line call expression)", async () => {
    const { files, sources } = mainScenario();
    const { refs } = await run(files, sources);
    const requeue = refs.find((r) => r.to === "src/queue.ts#Queue.requeue")!;
    expect(requeue).toMatchObject({
      kind: "call",
      from: "src/runner.ts#Runner.dispatch",
      site: { startLine: 9, endLine: 12 },
    });
    const namedImport = refs.find((r) => r.kind === "import" && r.to === "src/queue.ts#helper")!;
    expect(namedImport.site).toEqual({ startLine: 1, endLine: 1, startCol: 17, endCol: 22 });
  });

  it("keeps plain reads of fields as `read` references, at the member expression, but no parameter property", async () => {
    const { files, sources } = mainScenario();
    const { refs } = await run(files, sources);
    // `this.queue` is a read of the field `queue`; the site is the whole `this.queue`
    const read = refs.filter((r) => r.to === "src/runner.ts#Runner.queue" && r.kind === "read");
    expect(read).toEqual([
      {
        kind: "read",
        from: "src/runner.ts#Runner.dispatch",
        to: "src/runner.ts#Runner.queue",
        site: { startLine: 9, startCol: 11, endLine: 9, endCol: 20 },
        resolution: "precise",
      },
    ]);
    // the parameter property `max` is not a symbol of ours, nothing points at it
    expect(refs.some((r) => r.to.includes("max"))).toBe(false);
  });

  it("returns the references sorted, deduplicated and self-free", async () => {
    const { files, sources } = mainScenario();
    // every occurrence twice: still one reference each
    const doc = sources[0]!.index.documents[1]!;
    doc.occurrences.push(...doc.occurrences.map((o) => ({ ...o })));
    const { refs } = await run(files, sources);
    const keys = refs.map(
      (r) => `${r.from}|${r.to}|${r.kind}|${r.site.startLine}:${r.site.startCol}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
    expect(refs.every((r) => r.from !== r.to)).toBe(true);
    const files_ = refs.map((r) => r.from.slice(0, r.from.indexOf("#")));
    expect(files_).toEqual([...files_].sort());
    const lines = refs
      .filter((r) => r.from.startsWith("src/runner.ts"))
      .map((r) => r.site.startLine);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
  });

  it("reports the stats and the files no document described", async () => {
    const { files, sources } = mainScenario();
    sources[0]!.index.documents.pop(); // side.ts is no longer described
    const { result } = await run(files, sources);
    expect(result.uncovered).toEqual(["src/side.ts"]);
    expect(result.stats).toMatchObject({
      documents: 2,
      foreignDocuments: 0,
      outOfRange: 0,
      malformed: 0,
    });
  });
});

// ─── Which definitions count as our symbols ───────────────────────────────────────────────────────

describe("mapScip: a language pack that fails", () => {
  it("falls back to the kinds the roles and symbols give when classifySite throws", async () => {
    const { files, sources } = mainScenario();
    const { refs, result } = await run(files, sources, TS_LANGUAGES, (input) => ({
      ...input,
      withFile: (path, fn) =>
        input.withFile(path, (ctx, pack) =>
          fn(ctx, {
            ...pack,
            classifySite: () => {
              throw new Error("pack bug");
            },
          }),
        ),
    }));
    // no calls or imports of names without the pack; type-like symbols are still type references and
    // quoted module specifiers still import their module
    expect(new Set(refs.map((r) => r.kind))).toEqual(new Set(["type-ref", "import"]));
    expect(refs.filter((r) => r.kind === "import").every((r) => r.to.endsWith("#"))).toBe(true);
    expect(result.stats.classifyErrors).toBeGreaterThan(0);
  });

  it("warns and keeps the fallback kinds of a file the pack cannot parse, without losing the others", async () => {
    const { files, sources } = mainScenario();
    const { refs, warnings } = await run(files, sources, TS_LANGUAGES, (input) => ({
      ...input,
      withFile: (path, fn) => {
        if (path === "src/runner.ts") return Promise.reject(new Error("parse failed"));
        return input.withFile(path, fn);
      },
    }));
    expect(warnings).toEqual([
      "src/runner.ts: sites could not be classified (parse failed); using fallback kinds",
    ]);
    // the other files are classified as usual, the failing one keeps what needs no pack
    expect(refs.some((r) => r.kind === "type-ref" && r.from === "src/queue.ts#Queue.requeue")).toBe(
      true,
    );
    expect(refs.some((r) => r.kind === "call" && r.from.startsWith("src/runner.ts"))).toBe(false);
    expect(refs.some((r) => r.from.startsWith("src/runner.ts"))).toBe(true);
  });
});

describe("mapScip: targets", () => {
  it("skips symbols defined outside the repository", async () => {
    const src = marked(`import { ⟦readFile⟧ } from ⟦"node:fs/promises"⟧;
export function ⟦load⟧(): void {
  ⟦readFile⟧("x");
}
`);
    const external = "scip-typescript npm @types/node 22.0.0 fs/`promises.d.ts`/readFile().";
    const { refs } = await run({ "a.ts": src.text }, [
      source([
        {
          path: "a.ts",
          occurrences: [
            moduleDef("a.ts"),
            ...occs(src, [
              [0, external],
              [1, "scip-typescript npm @types/node 22.0.0 `fs/promises`/"],
              [2, ts("a.ts", "load()."), DEF],
              [3, external],
            ]),
          ],
        },
      ]),
    ]);
    expect(refs).toEqual([]);
  });

  it("resolves local symbols only when they are symbols of ours (nested functions), not variables or parameters", async () => {
    const src = marked(`export function ⟦outer⟧(⟦param⟧: number): number {
  function ⟦inner⟧(): number {
    return ⟦param⟧;
  }
  function ⟦sibling⟧(): number {
    return ⟦inner⟧() + ⟦param⟧;
  }
  const ⟦value⟧ = ⟦sibling⟧();
  return ⟦value⟧ + ⟦outer⟧(0);
}
`);
    const { index, refs } = await run({ "a.ts": src.text }, [
      source([
        {
          path: "a.ts",
          occurrences: [
            moduleDef("a.ts"),
            ...occs(src, [
              [0, ts("a.ts", "outer()."), DEF],
              [1, ts("a.ts", "outer().(param)"), DEF],
              [2, "local 0", DEF], // function inner
              [3, ts("a.ts", "outer().(param)")],
              [4, "local 1", DEF], // function sibling
              [5, "local 0"], // call of inner from sibling
              [6, ts("a.ts", "outer().(param)")],
              [7, "local 2", DEF], // const value
              [8, "local 1"], // call of sibling from outer
              [9, "local 2"],
              [10, ts("a.ts", "outer().")], // recursion
            ]),
          ],
        },
      ]),
    ]);
    expect(index.symbols.map((s) => s.id)).toEqual(
      expect.arrayContaining(["a.ts#outer", "a.ts#outer.inner", "a.ts#outer.sibling"]),
    );
    // sibling calls inner, outer calls sibling and itself (recursion); parameters and the local `value` are not
    // references
    expect(triples(refs)).toEqual([
      "call a.ts#outer -> a.ts#outer",
      "call a.ts#outer -> a.ts#outer.sibling",
      "call a.ts#outer.sibling -> a.ts#outer.inner",
    ]);
  });

  it("reports a file whose positions do not fit it as misplaced, and calls of what it defines as blind", async () => {
    const use = marked(`import { ⟦scan⟧ } from ⟦"./gen.ts"⟧;
export function ⟦lex⟧(): number {
  return ⟦scan⟧();
}
`);
    const { result } = await run(
      { "gen.ts": "export function scan(): number {\n  return 1;\n}\n", "use.ts": use.text },
      [
        source([
          // generated code whose positions point into the file it was generated from
          {
            path: "gen.ts",
            occurrences: [{ range: [40, 16, 20], symbol: ts("gen.ts", "scan()."), roles: DEF }],
          },
          {
            path: "use.ts",
            occurrences: [
              moduleDef("use.ts"),
              ...occs(use, [
                [0, ts("gen.ts", "scan().")],
                [1, ts("gen.ts", "")],
                [2, ts("use.ts", "lex()."), DEF],
                [3, ts("gen.ts", "scan().")],
              ]),
            ],
          },
        ]),
      ],
    );
    expect(result.misplaced).toEqual(["gen.ts"]);
    expect(result.blind).toEqual([
      { file: "use.ts", line: 1, col: 10 },
      { file: "use.ts", line: 3, col: 10 },
    ]);
  });

  it("a local declared in a function with the function's own name is not the function: no invented recursion", async () => {
    const src = marked(`export function ⟦walk⟧(⟦node⟧: unknown): number {
  const ⟦walk⟧ = (n: unknown) => 1;
  return ⟦walk⟧(⟦node⟧);
}
export function ⟦fact⟧(n: number): number {
  return n ? ⟦fact⟧(n - 1) : 1;
}
`);
    const { refs } = await run({ "a.ts": src.text }, [
      source([
        {
          path: "a.ts",
          occurrences: [
            moduleDef("a.ts"),
            ...occs(src, [
              [0, ts("a.ts", "walk()."), DEF],
              [1, ts("a.ts", "walk().(node)"), DEF],
              [2, "local 0", DEF], // the local `walk`, same name as its function
              [3, "local 0"], // a call of the local
              [4, ts("a.ts", "walk().(node)")],
              [5, ts("a.ts", "fact()."), DEF],
              [6, ts("a.ts", "fact().")], // real recursion
            ]),
          ],
        },
      ]),
    ]);
    // the local `walk` is a nested function of ours (`walk.walk`): a call of it, not of `walk` itself
    expect(triples(refs)).toEqual([
      "call a.ts#fact -> a.ts#fact",
      "call a.ts#walk -> a.ts#walk.walk",
    ]);
  });

  it("does not attribute definitions nested in another symbol to that symbol (Python-style instance attributes)", async () => {
    // `self.count = 0` in __init__ defines the attribute `Counter#count.`; the index has no symbol for it
    const py = marked(`class ⟦Counter⟧:
    def ⟦__init__⟧(self):
        self.⟦count⟧ = 0

    def ⟦bump⟧(self):
        self.⟦count⟧ += 1
        self.⟦label⟧()
`);
    const sym = (d: string): string => `scip-python python p 0.0.0 \`pkg.a\`/${d}`;
    const { refs } = await run(
      { "pkg/a.py": py.text },
      [
        source([
          {
            path: "pkg/a.py",
            occurrences: [
              { range: [0, 0, 0], symbol: sym("__init__:"), roles: DEF },
              ...occs(py, [
                [0, sym("Counter#"), DEF],
                [1, sym("Counter#__init__()."), DEF],
                [2, sym("Counter#count."), DEF], // defined inside __init__
                [3, sym("Counter#bump()."), DEF],
                [4, sym("Counter#count.")],
                [5, sym("Counter#label().")], // no definition anywhere: skipped
              ]),
            ],
          },
        ]),
      ],
      ["python"],
    );
    // `count` is defined inside `Counter.__init__`, but it is not that method: no `write` to `__init__`
    expect(triples(refs)).toEqual([]);
  });

  it("Python: a call `x.Name()` whose target is named otherwise is left to the heuristic resolver; of a symbol defined twice, the one nested around the call, else the one at its own path", async () => {
    const py = marked(`class ⟦AutoField⟧:
    pass
class ⟦DateTimeField⟧:
    pass
class ⟦Parser⟧:
    def ⟦parse_tuple⟧(self):
        def ⟦parse⟧():
            return 1
        return ⟦parse⟧()
    def ⟦parse⟧(self):
        return 2
def ⟦use⟧(models, p):
    models.⟦AutoField⟧()
    models.⟦DateTimeField⟧()
    return p.⟦parse⟧()
`);
    const sym = (d: string): string => `scip-python python p 0.0.0 \`pkg.a\`/${d}`;
    const { refs, result } = await run(
      { "pkg/a.py": py.text },
      [
        source([
          {
            path: "pkg/a.py",
            occurrences: [
              { range: [0, 0, 0], symbol: sym("__init__:"), roles: DEF },
              ...occs(py, [
                [0, sym("AutoField#"), DEF],
                [1, sym("DateTimeField#"), DEF],
                [2, sym("Parser#"), DEF],
                [3, sym("Parser#parse_tuple()."), DEF],
                [4, sym("Parser#parse()."), DEF], // the nested def gets the method's symbol
                [5, sym("Parser#parse().")],
                [6, sym("Parser#parse()."), DEF],
                [7, sym("use()."), DEF],
                [8, sym("DateTimeField#")], // scip-python's wrong target for a re-exported name
                [9, sym("DateTimeField#")],
                [10, sym("Parser#parse().")],
              ]),
            ],
          },
        ]),
      ],
      ["python"],
    );
    expect(triples(refs)).toEqual([
      "call pkg/a.py#Parser.parse_tuple -> pkg/a.py#Parser.parse_tuple.parse",
      "call pkg/a.py#use -> pkg/a.py#DateTimeField",
      "call pkg/a.py#use -> pkg/a.py#Parser.parse",
    ]);
    expect(result.blind).toEqual([{ file: "pkg/a.py", line: 13, col: 12 }]);
  });

  it("Python: a dunder the indexer defines at the class name (`__doc__`) is not the class", async () => {
    const py = marked(`class ⟦Model⟧:
    def ⟦__init__⟧(self):
        pass
def ⟦setup⟧(cls):
    cls.⟦__doc__⟧ = "x"
    return ⟦Model⟧()
`);
    const sym = (d: string): string => `scip-python python p 0.0.0 \`pkg.a\`/${d}`;
    const { refs } = await run(
      { "pkg/a.py": py.text },
      [
        source([
          {
            path: "pkg/a.py",
            occurrences: [
              { range: [0, 0, 0], symbol: sym("__init__:"), roles: DEF },
              ...occs(py, [
                [0, sym("Model#"), DEF],
                [0, sym("Model#__doc__."), DEF], // synthesized at the class name
                [1, sym("Model#__init__()."), DEF],
                [2, sym("setup()."), DEF],
                [3, sym("Model#__doc__."), SymbolRole.WriteAccess],
                [4, sym("Model#")],
              ]),
            ],
          },
        ]),
      ],
      ["python"],
    );
    expect(triples(refs)).toEqual(["call pkg/a.py#setup -> pkg/a.py#Model"]);
  });

  it("finds the implementation of overloaded functions (several definitions of one symbol, or one per signature)", async () => {
    const src = marked(`export function ⟦pick⟧(x: string): string;
export function ⟦pick⟧(x: number): number;
export function ⟦pick⟧(x: any): any {
  return x;
}
export function ⟦use⟧(): void {
  ⟦pick⟧("a");
  ⟦pick⟧(1);
}
`);
    // scip-typescript gives every overload the same symbol (three definitions); the pack only indexes the
    // implementation, so only the last definition lies in a symbol of ours
    const shared = await run({ "a.ts": src.text }, [
      source([
        {
          path: "a.ts",
          occurrences: [
            moduleDef("a.ts"),
            ...occs(src, [
              [0, ts("a.ts", "pick()."), DEF],
              [1, ts("a.ts", "pick()."), DEF],
              [2, ts("a.ts", "pick()."), DEF],
              [3, ts("a.ts", "use()."), DEF],
              [4, ts("a.ts", "pick().")],
              [5, ts("a.ts", "pick().")],
            ]),
          ],
        },
      ]),
    ]);
    expect(shared.index.symbols.filter((s) => s.path.startsWith("pick")).map((s) => s.id)).toEqual([
      "a.ts#pick",
    ]);
    expect(triples(shared.refs)).toEqual([
      "call a.ts#use -> a.ts#pick",
      "call a.ts#use -> a.ts#pick",
    ]);

    // an indexer that numbers the overloads (`pick(+1).`) defines the first one only at its signature, which
    // no symbol of ours covers: the path spelled by the descriptors finds `pick`
    const numbered = await run({ "a.ts": src.text }, [
      source([
        {
          path: "a.ts",
          occurrences: [
            moduleDef("a.ts"),
            ...occs(src, [
              [0, ts("a.ts", "pick(+1)."), DEF],
              [3, ts("a.ts", "use()."), DEF],
              [4, ts("a.ts", "pick(+1).")],
            ]),
          ],
        },
      ]),
    ]);
    expect(triples(numbered.refs)).toEqual(["call a.ts#use -> a.ts#pick"]);
  });

  it("folds a constructor into its class and prefers no other target", async () => {
    const { files, sources } = mainScenario();
    const { refs } = await run(files, sources);
    expect(refs.some((r) => r.to.endsWith("constructor"))).toBe(false);
  });

  it("uses the first defining file for a module defined in several files (Go packages)", async () => {
    const files = {
      "go.mod": "module example.com/m\n\ngo 1.22\n",
      "internal/queue/deadletter.go": "package queue\n\nfunc Dead() {}\n",
      "internal/queue/queue.go": "package queue\n\nfunc New() {}\n",
      "cmd/main.go":
        'package main\n\nimport (\n\t"example.com/m/internal/queue"\n)\n\nfunc main() { queue.New() }\n',
    };
    const pkg = "scip-go gomod example.com/m . `example.com/m/internal/queue`/";
    const { refs } = await run(
      files,
      [
        source(
          [
            {
              path: "internal/queue/deadletter.go",
              occurrences: [{ range: [0, 8, 13], symbol: pkg, roles: DEF }],
            },
            {
              path: "internal/queue/queue.go",
              occurrences: [{ range: [0, 8, 13], symbol: pkg, roles: DEF }],
            },
            {
              path: "cmd/main.go",
              // the import path without its quotes, as scip-go reports it
              occurrences: [{ range: [3, 2, 30], symbol: pkg, roles: SymbolRole.ReadAccess }],
            },
          ],
          { defaultEncoding: "utf8" },
        ),
      ],
      ["go"],
    );
    // the pack's own module resolution ranks `queue/queue.go` (named like the directory) before deadletter.go
    expect(triples(refs)).toEqual(["import cmd/main.go# -> internal/queue/queue.go#"]);
  });

  it("drops references to module symbols that are not import specifiers", async () => {
    const files = {
      "go.mod": "module example.com/m\n\ngo 1.22\n",
      "queue/queue.go": "package queue\n\nfunc New() {}\n",
      "main.go": "package main\n\nfunc main() { queue.New() }\n",
    };
    const pkg = "scip-go gomod example.com/m . `example.com/m/queue`/";
    const { refs } = await run(
      files,
      [
        source(
          [
            {
              path: "queue/queue.go",
              occurrences: [{ range: [0, 8, 13], symbol: pkg, roles: DEF }],
            },
            // the qualifier `queue` in `queue.New()` is an occurrence of the package symbol, not an import
            { path: "main.go", occurrences: [{ range: [2, 14, 19], symbol: pkg, roles: 8 }] },
          ],
          { defaultEncoding: "utf8" },
        ),
      ],
      ["go"],
    );
    expect(refs).toEqual([]);
  });
});

// ─── Imports of whole modules ─────────────────────────────────────────────────────────────────────

describe("mapScip: module imports", () => {
  it("re-exports (`export * from`) and side-effect imports become imports of the module scope", async () => {
    const barrel = marked(`export * from ⟦"./a.ts"⟧;
export { ⟦b⟧ } from ⟦"./b.ts"⟧;
import(⟦"./c.ts"⟧);
`);
    const files = {
      "index.ts": barrel.text,
      "a.ts": "export const a = 1;\n",
      "b.ts": "export const b = 1;\n",
      "c.ts": "export const c = 1;\n",
    };
    const { refs } = await run(files, [
      source([
        {
          path: "index.ts",
          occurrences: [
            moduleDef("index.ts"),
            ...occs(barrel, [
              [0, ts("a.ts")],
              [1, ts("b.ts", "b.")],
              [2, ts("b.ts")],
              [3, ts("c.ts")],
            ]),
          ],
        },
        { path: "a.ts", occurrences: [moduleDef("a.ts")] },
        {
          path: "b.ts",
          occurrences: [
            moduleDef("b.ts"),
            { range: [0, 13, 14], symbol: ts("b.ts", "b."), roles: DEF },
          ],
        },
        { path: "c.ts", occurrences: [moduleDef("c.ts")] },
      ]),
    ]);
    expect(triples(refs)).toEqual([
      "import index.ts# -> a.ts#",
      // `export { b } from "./b.ts"` imports the name; the specifier is not a second reference
      "import index.ts# -> b.ts#b",
      "import index.ts# -> c.ts#",
    ]);
  });

  it("a reference to a module that is not a quoted specifier is an import only when the indexer says so", async () => {
    const src = marked("export const ⟦a⟧ = ⟦mod⟧;\nexport const ⟦b⟧ = ⟦mod⟧;\n");
    const doc = (roles: number): ScipSource =>
      source([
        {
          path: "a.ts",
          occurrences: [
            moduleDef("a.ts"),
            ...occs(src, [
              [0, ts("a.ts", "a."), DEF],
              [1, ts("b.ts"), roles],
              [2, ts("a.ts", "b."), DEF],
              [3, ts("b.ts")],
            ]),
          ],
        },
        { path: "b.ts", occurrences: [moduleDef("b.ts")] },
      ]);
    const files = { "a.ts": src.text, "b.ts": "export const x = 1;\n" };
    const withRole = await run(files, [doc(SymbolRole.Import)]);
    expect(triples(withRole.refs)).toEqual(["import a.ts#a -> b.ts#"]);
  });

  it("`from . import cli` (scip-python names the module relative to the importer) reaches its sibling", async () => {
    const app = marked(
      "from . import ⟦cli⟧\nfrom . import ⟦util⟧\n\n\ndef ⟦run⟧():\n    ⟦cli⟧.main()\n",
    );
    const sym = (module: string, rest = ""): string =>
      `scip-python python p 0.0.0 \`${module}\`/${rest}`;
    const files = {
      "pkg/__init__.py": "",
      "pkg/app.py": app.text,
      "pkg/cli.py": "def main():\n    pass\n",
      "pkg/util.py": "X = 1\n",
      "other/util.py": "Y = 1\n",
    };
    const def = (module: string): { range: number[]; symbol: string; roles: number } => ({
      range: [0, 0, 0],
      symbol: sym(module, "__init__:"),
      roles: DEF,
    });
    const { refs } = await run(
      files,
      [
        source([
          { path: "pkg/__init__.py", occurrences: [def("pkg")] },
          {
            path: "pkg/app.py",
            occurrences: [
              def("pkg.app"),
              // the reference names the module `cli/__init__:`, the definition `pkg.cli/__init__:`
              ...occs(app, [
                [0, "scip-python python p 0.0.0 cli/__init__:"],
                [1, "scip-python python p 0.0.0 util/__init__:"], // ambiguous with other/util, sibling wins
                [3, "scip-python python p 0.0.0 cli/__init__:"], // the qualifier of `cli.main()`: not an import
              ]),
            ],
          },
          { path: "pkg/cli.py", occurrences: [def("pkg.cli")] },
          { path: "pkg/util.py", occurrences: [def("pkg.util")] },
          { path: "other/util.py", occurrences: [def("other.util")] },
        ]),
      ],
      ["python"],
    );
    expect(triples(refs)).toEqual([
      "import pkg/app.py# -> pkg/cli.py#",
      "import pkg/app.py# -> pkg/util.py#",
    ]);
  });

  it("a module scope never references itself", async () => {
    const src = marked(`export const ⟦x⟧ = 1;\nimport ⟦"./a.ts"⟧;\n`);
    const { refs } = await run({ "a.ts": src.text }, [
      source([
        {
          path: "a.ts",
          occurrences: [
            moduleDef("a.ts"),
            ...occs(src, [
              [0, ts("a.ts", "x."), DEF],
              [1, ts("a.ts")],
            ]),
          ],
        },
      ]),
    ]);
    expect(refs).toEqual([]);
  });
});

// ─── The fallback when the pack does not classify an occurrence ───────────────────────────────────

describe("mapScip: fallback kinds", () => {
  const src = marked(`export class ⟦Target⟧ {}
export function ⟦other⟧(): void {}
export let ⟦counter⟧ = 0;
export function ⟦use⟧(): number {
  const a = ⟦Target⟧;
  ⟦other⟧;
  ⟦counter⟧;
  ⟦other⟧;
  ⟦counter⟧;
  ⟦use⟧;
  return 1;
}
`);
  // Reading a class, a function or a variable in an expression is not a call, import, heritage clause, type
  // position or assignment for the TypeScript pack: `classifySite` says undefined and the roles and the
  // kind of symbol decide.
  const doc = (occ: readonly (readonly [number, string, number?])[]): ScipSource =>
    source([
      {
        path: "a.ts",
        occurrences: [
          moduleDef("a.ts"),
          ...occs(src, [
            [0, ts("a.ts", "Target#"), DEF],
            [1, ts("a.ts", "other()."), DEF],
            [2, ts("a.ts", "counter."), DEF],
            [3, ts("a.ts", "use()."), DEF],
            ...occ,
          ]),
        ],
      },
    ]);

  it("type-like symbols in value positions become type-refs, at the occurrence", async () => {
    const { refs } = await run({ "a.ts": src.text }, [doc([[4, ts("a.ts", "Target#")]])]);
    expect(triples(refs)).toEqual(["type-ref a.ts#use -> a.ts#Target"]);
    expect(refs[0]!.site).toEqual({ startLine: 5, endLine: 5, startCol: 13, endCol: 18 });
  });

  it("role Import gives an import, role WriteAccess a write", async () => {
    const { refs } = await run({ "a.ts": src.text }, [
      doc([
        [7, ts("a.ts", "other()."), SymbolRole.Import],
        [8, ts("a.ts", "counter."), SymbolRole.WriteAccess],
      ]),
    ]);
    expect(triples(refs)).toEqual([
      "import a.ts#use -> a.ts#other",
      "write a.ts#use -> a.ts#counter",
    ]);
  });

  it("a function read as a value is a call (it runs when the value is called), of itself too", async () => {
    const { refs } = await run({ "a.ts": src.text }, [
      doc([
        [5, ts("a.ts", "other().")],
        [9, ts("a.ts", "use().")],
      ]),
    ]);
    expect(triples(refs)).toEqual(["call a.ts#use -> a.ts#other", "call a.ts#use -> a.ts#use"]);
  });

  it("a plain read of a variable is a `read` (the pack says it is one, the symbol says it is a variable)", async () => {
    const { refs } = await run({ "a.ts": src.text }, [
      doc([
        [5, ts("a.ts", "other().")],
        [6, ts("a.ts", "counter.")],
        [8, ts("a.ts", "counter.")],
      ]),
    ]);
    // one reference per site; `other` read as a value is a call
    expect(triples(refs)).toEqual([
      "call a.ts#use -> a.ts#other",
      "read a.ts#use -> a.ts#counter",
      "read a.ts#use -> a.ts#counter",
    ]);
    expect(refs.filter((r) => r.kind === "read").map((r) => r.site.startLine)).toEqual([7, 9]);
  });
});

// ─── Implementations ──────────────────────────────────────────────────────────────────────────────

describe("mapScip: is_implementation relationships", () => {
  const src = marked(`export interface ⟦Store⟧ {
  ⟦get⟧(): number;
}
export class ⟦Memory⟧ implements ⟦Store⟧ {
  ⟦get⟧(): number { return 1; }
}
export class ⟦Base⟧ {
  ⟦run⟧(): void {}
}
export class ⟦Child⟧ extends ⟦Base⟧ {
  ⟦run⟧(): void {}
}
export class ⟦Implicit⟧ {
  ⟦get⟧(): number { return 2; }
}
`);
  const S = {
    store: ts("a.ts", "Store#"),
    storeGet: ts("a.ts", "Store#get()."),
    memory: ts("a.ts", "Memory#"),
    memoryGet: ts("a.ts", "Memory#get()."),
    base: ts("a.ts", "Base#"),
    baseRun: ts("a.ts", "Base#run()."),
    child: ts("a.ts", "Child#"),
    childRun: ts("a.ts", "Child#run()."),
    implicit: ts("a.ts", "Implicit#"),
    implicitGet: ts("a.ts", "Implicit#get()."),
  };
  const impl = (symbol: string, extra: Partial<RelationshipSpec> = {}): RelationshipSpec => ({
    symbol,
    isImplementation: true,
    ...extra,
  });

  const scenario = (): ScipSource =>
    source([
      {
        path: "a.ts",
        occurrences: [
          moduleDef("a.ts"),
          ...occs(src, [
            [0, S.store, DEF],
            [1, S.storeGet, DEF],
            [2, S.memory, DEF],
            [3, S.store], // `implements Store`
            [4, S.memoryGet, DEF],
            [5, S.base, DEF],
            [6, S.baseRun, DEF],
            [7, S.child, DEF],
            [8, S.base], // `extends Base`
            [9, S.childRun, DEF],
            [10, S.implicit, DEF],
            [11, S.implicitGet, DEF],
          ]),
        ],
        symbols: [
          { symbol: S.memory, relationships: [impl(S.store)] },
          { symbol: S.memoryGet, relationships: [impl(S.storeGet, { isReference: true })] },
          { symbol: S.child, relationships: [impl(S.base)] },
          { symbol: S.childRun, relationships: [impl(S.baseRun, { isReference: true })] },
          // satisfied without saying so (Go-style): the relationship is all there is
          { symbol: S.implicit, relationships: [impl(S.store)] },
          {
            symbol: S.implicitGet,
            relationships: [
              impl(S.storeGet),
              impl("scip-typescript npm lib 1.0.0 lib/`x.d.ts`/External#"), // not in the repository
              { symbol: S.baseRun, isReference: true }, // not an implementation
              impl("local 3"),
            ],
          },
        ],
      },
    ]);

  it("turns relationships into implements references from the implementer's definition", async () => {
    const { refs } = await run({ "a.ts": src.text }, [scenario()]);
    expect(triples(refs.filter((r) => r.kind === "implements"))).toEqual(
      [
        // from `implements Store` (an occurrence): the relationship adds nothing at class level
        "implements a.ts#Memory -> a.ts#Store",
        // members of a class that implements an interface
        "implements a.ts#Memory.get -> a.ts#Store.get",
        // relationship only
        "implements a.ts#Implicit -> a.ts#Store",
        "implements a.ts#Implicit.get -> a.ts#Store.get",
      ].sort(),
    );
    const implicit = refs.find((r) => r.from === "a.ts#Implicit" && r.kind === "implements")!;
    // the site is the implementer's name at its definition
    expect(implicit.site).toEqual({ startLine: 13, endLine: 13, startCol: 14, endCol: 21 });
    expect(implicit.resolution).toBe("precise");
  });

  it("does not add implements next to extends, nor for overrides", async () => {
    const { refs } = await run({ "a.ts": src.text }, [scenario()]);
    expect(triples(refs.filter((r) => r.from.startsWith("a.ts#Child")))).toEqual([
      "extends a.ts#Child -> a.ts#Base",
    ]);
    expect(refs.some((r) => r.from === "a.ts#Child.run")).toBe(false);
  });

  it("works for Go, where interfaces are satisfied implicitly and only the relationship says so", async () => {
    const files = {
      "go.mod": "module example.com/m\n\ngo 1.22\n",
      "runner/runner.go": "package runner\n\ntype JobQueue interface {\n\tPop() int\n}\n",
      "queue/queue.go":
        "package queue\n\ntype Queue struct{}\n\nfunc (q *Queue) Pop() int { return 1 }\n",
    };
    const pkg = (p: string): string => `scip-go gomod example.com/m . \`example.com/m/${p}\`/`;
    const { refs } = await run(
      files,
      [
        source(
          [
            {
              path: "runner/runner.go",
              occurrences: [
                { range: [2, 5, 13], symbol: `${pkg("runner")}JobQueue#`, roles: DEF },
                { range: [3, 1, 4], symbol: `${pkg("runner")}JobQueue#Pop.`, roles: DEF },
              ],
            },
            {
              path: "queue/queue.go",
              occurrences: [
                { range: [2, 5, 10], symbol: `${pkg("queue")}Queue#`, roles: DEF },
                { range: [4, 16, 19], symbol: `${pkg("queue")}Queue#Pop().`, roles: DEF },
              ],
              symbols: [
                {
                  symbol: `${pkg("queue")}Queue#`,
                  kind: 49,
                  relationships: [impl(`${pkg("runner")}JobQueue#`)],
                },
                {
                  symbol: `${pkg("queue")}Queue#Pop().`,
                  kind: 26,
                  relationships: [impl(`${pkg("runner")}JobQueue#Pop.`)],
                },
              ],
            },
          ],
          { defaultEncoding: "utf8" },
        ),
      ],
      ["go"],
    );
    expect(triples(refs)).toEqual([
      "implements queue/queue.go#Queue -> runner/runner.go#JobQueue",
      "implements queue/queue.go#Queue.Pop -> runner/runner.go#JobQueue.Pop",
    ]);
  });
});

// ─── Columns ──────────────────────────────────────────────────────────────────────────────────────

describe("toUtf16Offset", () => {
  const line = "aé🚀日b"; // a=1 byte, é=2, 🚀=4, 日=3, b=1
  it("is the identity for UTF-16", () => {
    expect(toUtf16Offset(line, 3, "utf16")).toBe(3);
    expect(toUtf16Offset(line, 99, "utf16")).toBe(line.length);
  });

  it("converts UTF-8 byte offsets", () => {
    expect(toUtf16Offset(line, 0, "utf8")).toBe(0);
    expect(toUtf16Offset(line, 1, "utf8")).toBe(1); // after a
    expect(toUtf16Offset(line, 3, "utf8")).toBe(2); // after é
    expect(toUtf16Offset(line, 7, "utf8")).toBe(4); // after 🚀 (two UTF-16 units)
    expect(toUtf16Offset(line, 10, "utf8")).toBe(5); // after 日
    expect(toUtf16Offset(line, 11, "utf8")).toBe(6); // end
    expect(toUtf16Offset(line, 99, "utf8")).toBe(6); // clamped
    expect(toUtf16Offset(line, 2, "utf8")).toBe(2); // inside é: rounded up to its end
  });

  it("converts UTF-32 code point offsets", () => {
    expect(toUtf16Offset(line, 1, "utf32")).toBe(1);
    expect(toUtf16Offset(line, 2, "utf32")).toBe(2);
    expect(toUtf16Offset(line, 3, "utf32")).toBe(4); // after 🚀
    expect(toUtf16Offset(line, 5, "utf32")).toBe(6);
  });

  it("has a fast path for ASCII lines", () => {
    expect(toUtf16Offset("plain ascii", 5, "utf8")).toBe(5);
    expect(toUtf16Offset("plain ascii", 5, "utf32")).toBe(5);
  });
});

describe("mapScip: position encodings", () => {
  // two symbols on one line, non-ASCII text before the reference: only correct columns find the right `from`
  const src = marked(`export class ⟦Target⟧ {}
export const label = "héllo 🚀 日本"; export const ⟦same⟧ = value instanceof ⟦Target⟧;
`);
  const files = { "a.ts": src.text };
  const definitions = [
    [0, ts("a.ts", "Target#"), DEF],
    [1, ts("a.ts", "same."), DEF],
  ] as const;

  const expected = (): Reference => ({
    from: "a.ts#same",
    to: "a.ts#Target",
    kind: "type-ref",
    // 1-based inclusive UTF-16 columns of `Target` on line 2, wherever the indexer counted from
    site: (() => {
      const line = src.lines[1]!;
      const startCol = line.indexOf("Target") + 1;
      return { startLine: 2, endLine: 2, startCol, endCol: startCol + "Target".length - 1 };
    })(),
    resolution: "precise",
  });

  const doc = (encoding: ColumnEncoding, positionEncoding?: number): DocumentSpec => ({
    path: "a.ts",
    positionEncoding,
    occurrences: [
      moduleDef("a.ts"),
      ...occs(src, [...definitions, [2, ts("a.ts", "Target#")]], encoding),
    ],
  });

  it.each([
    ["UTF-16 by default", "utf16", "utf16", undefined],
    ["UTF-8 bytes by the source's default", "utf8", "utf8", undefined],
    ["UTF-8 stated by the document beats the default", "utf16", "utf8", PositionEncoding.Utf8],
    ["UTF-16 stated by the document beats the default", "utf8", "utf16", PositionEncoding.Utf16],
    ["UTF-32 code points stated by the document", "utf16", "utf32", PositionEncoding.Utf32],
  ] as const)("%s", async (_name, defaultEncoding, written, stated) => {
    const { refs } = await run(files, [source([doc(written, stated)], { defaultEncoding })]);
    expect(refs).toEqual([expected()]);
  });

  it("would misplace the reference if the columns were misread (sanity check of the scenario)", async () => {
    const { refs } = await run(files, [source([doc("utf8")], { defaultEncoding: "utf16" })]);
    expect(refs).not.toEqual([expected()]);
  });

  it("does not count a byte order mark the indexer did not see (scip-typescript), and counts one it did", async () => {
    const m = marked(`\uFEFFexport const ⟦x⟧ = v instanceof ⟦Target⟧; export class ⟦Target⟧ {}\n`);
    const specs = [
      [0, ts("a.ts", "x."), DEF],
      [1, ts("a.ts", "Target#")],
      [2, ts("a.ts", "Target#"), DEF],
    ] as const;
    const line = m.lines[0]!;
    const startCol = line.indexOf("Target") + 1; // 1-based, the BOM counted like any character
    const expectedSite = { startLine: 1, endLine: 1, startCol, endCol: startCol + 5 };
    // scip-typescript never saw the BOM: its columns on line 1 are one less than ours
    const seenWithoutBom = source(
      [{ path: "a.ts", occurrences: [moduleDef("a.ts"), ...occs(m, specs, "utf16", -1)] }],
      { excludesBom: true },
    );
    const a = await run({ "a.ts": m.text }, [seenWithoutBom]);
    expect(triples(a.refs)).toEqual(["type-ref a.ts#x -> a.ts#Target"]);
    expect(a.refs[0]!.site).toEqual(expectedSite);
    // scip-python and scip-go count it: nothing to correct
    const seenWithBom = source([
      { path: "a.ts", occurrences: [moduleDef("a.ts"), ...occs(m, specs)] },
    ]);
    const b = await run({ "a.ts": m.text }, [seenWithBom]);
    expect(b.refs[0]!.site).toEqual(expectedSite);
  });

  it("ignores occurrences that do not fit the file (it changed since it was indexed) and malformed ranges", async () => {
    const { refs, result } = await run({ "a.ts": "export class A {}\n" }, [
      source([
        {
          path: "a.ts",
          occurrences: [
            { range: [0, 13, 14], symbol: ts("a.ts", "A#"), roles: DEF },
            { range: [40, 0, 1], symbol: ts("a.ts", "A#") },
            { range: [0, 1], symbol: ts("a.ts", "A#") },
            { range: [3, 7, 2], symbol: ts("a.ts", "A#") },
          ],
        },
      ]),
    ]);
    expect(refs).toEqual([]);
    expect(result.stats.outOfRange).toBe(1);
    expect(result.stats.malformed).toBe(2);
  });
});

// ─── Documents and paths ──────────────────────────────────────────────────────────────────────────

describe("documentPath", () => {
  it("joins the prefix and normalises", () => {
    expect(documentPath("", "src/a.ts")).toBe("src/a.ts");
    expect(documentPath("services/api", "internal/x.go")).toBe("services/api/internal/x.go");
    expect(documentPath("", "./src//a.ts")).toBe("src/a.ts");
    expect(documentPath("svc", "a/../b.go")).toBe("svc/b.go");
    expect(documentPath("", "src\\a.ts")).toBe("src/a.ts");
  });

  it("rejects paths that leave the root", () => {
    expect(documentPath("", "../x.go")).toBeUndefined();
    expect(documentPath("", "../../../root/.cache/go-build/49/abc-d")).toBeUndefined();
    expect(documentPath("svc", "../../x")).toBeUndefined();
    expect(documentPath("", "")).toBeUndefined();
    expect(documentPath("", "/etc/passwd")).toBeUndefined();
    expect(documentPath("svc", "/etc/passwd")).toBeUndefined();
    expect(documentPath("", "C:\\Users\\x.go")).toBeUndefined();
  });
});

describe("mapScip: documents", () => {
  it("prefixes document paths with the module directory and ignores documents of files we did not index", async () => {
    const src = marked(`export class ⟦A⟧ {}\nexport function f(): A { return new ⟦A⟧(); }\n`);
    const { refs, result } = await run({ "svc/a.ts": src.text }, [
      source(
        [
          {
            path: "a.ts",
            occurrences: [
              moduleDef("a.ts"),
              ...occs(src, [
                [0, ts("a.ts", "A#"), DEF],
                [1, ts("a.ts", "A#")],
              ]),
            ],
          },
          { path: "ghost.ts", occurrences: [] }, // not in the repository
          { path: "../outside.ts", occurrences: [] }, // outside the root
        ],
        { pathPrefix: "svc" },
      ),
    ]);
    expect(triples(refs)).toEqual(["call svc/a.ts#f -> svc/a.ts#A"]);
    expect(result.stats).toMatchObject({ documents: 1, foreignDocuments: 2 });
  });

  it("combines several indexes: definitions in one, references in another", async () => {
    const a = marked("export class ⟦A⟧ {}\n");
    const b = marked(`import { ⟦A⟧ } from "./a.ts";\nexport function f(): void { new ⟦A⟧(); }\n`);
    const { refs } = await run({ "a.ts": a.text, "b.ts": b.text }, [
      source([
        {
          path: "a.ts",
          occurrences: [moduleDef("a.ts"), ...occs(a, [[0, ts("a.ts", "A#"), DEF]])],
        },
      ]),
      source([
        {
          path: "b.ts",
          occurrences: [
            moduleDef("b.ts"),
            ...occs(b, [
              [0, ts("a.ts", "A#")],
              [1, ts("a.ts", "A#")],
            ]),
          ],
        },
      ]),
    ]);
    expect(triples(refs)).toEqual(["call b.ts#f -> a.ts#A", "import b.ts# -> a.ts#A"]);
  });

  it("matches symbols across indexes whatever package version each index gives them (Go modules)", async () => {
    const files = {
      "a/go.mod": "module example.com/a\n\ngo 1.22\n",
      "a/a.go": "package a\n\nfunc A() {}\n",
      "b/go.mod": "module example.com/b\n\ngo 1.22\n",
      "b/b.go": 'package b\n\nimport "example.com/a"\n\nfunc B() { a.A() }\n',
    };
    const pkg = (module: string, version: string): string =>
      `scip-go gomod ${module} ${version} \`${module}\`/`;
    const { refs } = await run(
      files,
      [
        source(
          [
            {
              path: "a.go",
              occurrences: [
                { range: [2, 5, 6], symbol: `${pkg("example.com/a", "9067a86")}A().`, roles: DEF },
              ],
            },
          ],
          { pathPrefix: "a", defaultEncoding: "utf8" },
        ),
        source(
          [
            {
              path: "b.go",
              occurrences: [
                { range: [4, 5, 6], symbol: `${pkg("example.com/b", "9067a86")}B().`, roles: DEF },
                // module a as module b sees it: no version
                { range: [4, 13, 14], symbol: `${pkg("example.com/a", ".")}A().`, roles: 8 },
              ],
            },
          ],
          { pathPrefix: "b", defaultEncoding: "utf8" },
        ),
      ],
      ["go"],
    );
    expect(triples(refs)).toEqual(["call b/b.go#B -> a/a.go#A"]);
  });

  it("finds an interface method that one module defines as a term and another refers to as a method (scip-go)", async () => {
    const a = marked("package a\n\ntype ⟦Store⟧ interface {\n\t⟦Get⟧() int\n}\n");
    const b = marked(
      'package b\n\nimport "example.com/a"\n\nfunc ⟦B⟧(s a.Store) int { return s.⟦Get⟧() }\n',
    );
    const pkg = (m: string): string => `scip-go gomod example.com/${m} . \`example.com/${m}\`/`;
    const { refs } = await run(
      {
        "a/go.mod": "module example.com/a\n\ngo 1.22\n",
        "a/a.go": a.text,
        "b/go.mod": "module example.com/b\n\ngo 1.22\n",
        "b/b.go": b.text,
      },
      [
        source(
          [
            {
              path: "a.go",
              occurrences: occs(a, [
                [0, `${pkg("a")}Store#`, DEF],
                [1, `${pkg("a")}Store#Get.`, DEF], // a term where it is declared ...
              ]),
            },
          ],
          { pathPrefix: "a", defaultEncoding: "utf8" },
        ),
        source(
          [
            {
              path: "b.go",
              occurrences: occs(b, [
                [0, `${pkg("b")}B().`, DEF],
                [1, `${pkg("a")}Store#Get().`], // ... a method where another module calls it
              ]),
            },
          ],
          { pathPrefix: "b", defaultEncoding: "utf8" },
        ),
      ],
      ["go"],
    );
    expect(triples(refs)).toEqual(["call b/b.go#B -> a/a.go#Store.Get"]);
  });

  it("only produces references from files of the covered languages", async () => {
    const files = {
      "a.ts": "export class A {}\n",
      "b.py": "class B:\n    pass\n",
    };
    const { refs } = await run(files, [
      source([
        {
          path: "a.ts",
          occurrences: [{ range: [0, 13, 14], symbol: ts("a.ts", "A#"), roles: DEF }],
        },
        {
          path: "b.py",
          occurrences: [
            { range: [0, 6, 7], symbol: ts("b.py", "B#"), roles: DEF },
            { range: [1, 4, 8], symbol: ts("a.ts", "A#") }, // a Python file referencing a TS symbol
          ],
        },
      ]),
    ]);
    expect(refs).toEqual([]);
  });
});
