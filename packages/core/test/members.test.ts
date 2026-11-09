/**
 * `GraphView.boxText: "members"`: a data-model view. A type box draws its included fields as rows, each row
 * names the type its declaration line gives, and arrows start at the rows, not at the code inside the type's
 * methods.
 */
import { describe, expect, it } from "vitest";
import { deriveGraph, ExplainerModel, type GraphView } from "../src/index.js";
import { emptyExplainer, makeWorld } from "./helpers.js";

const w = makeWorld({
  files: [
    {
      path: "src/models.ts",
      text: [
        "export interface Job {",
        "  id: string;",
        "  attempts: number; // failed so far",
        "}",
        "export interface DeadJob {",
        "  job: Job;",
        "  error: string;",
        "}",
        "export class Queue {",
        "  private readonly dead: DeadJob[] = [];",
        "  push(job: Job): void {",
        "    this.dead.length;",
        "  }",
        "}",
      ].join("\n"),
    },
    {
      path: "app/models.py",
      language: "python",
      text: [
        "@dataclass",
        "class Job:",
        "    payload: dict[str, Any] = field(default_factory=dict)",
        "    priority: int = 0  # higher first",
        '    name = "x"',
      ].join("\n"),
    },
    {
      path: "queue/models.go",
      language: "go",
      text: [
        "type Job struct {",
        "\tReady    []*Job // waiting",
        '\tTag      string `json:"tag"`',
        "}",
      ].join("\n"),
    },
  ],
  symbols: [
    { id: "src/models.ts#Job", kind: "interface", start: 1, end: 4 },
    { id: "src/models.ts#Job.id", kind: "variable", start: 2, end: 2 },
    { id: "src/models.ts#Job.attempts", kind: "variable", start: 3, end: 3 },
    { id: "src/models.ts#DeadJob", kind: "interface", start: 5, end: 8 },
    { id: "src/models.ts#DeadJob.job", kind: "variable", start: 6, end: 6 },
    { id: "src/models.ts#DeadJob.error", kind: "variable", start: 7, end: 7 },
    { id: "src/models.ts#Queue", kind: "class", start: 9, end: 14 },
    { id: "src/models.ts#Queue.dead", kind: "variable", start: 10, end: 10 },
    { id: "src/models.ts#Queue.push", kind: "method", start: 11, end: 13 },
    { id: "app/models.py#Job", kind: "class", start: 1, end: 5 },
    { id: "app/models.py#Job.payload", kind: "variable", start: 3, end: 3 },
    { id: "app/models.py#Job.priority", kind: "variable", start: 4, end: 4 },
    { id: "app/models.py#Job.name", kind: "variable", start: 5, end: 5 },
    { id: "queue/models.go#Job", kind: "class", start: 1, end: 4 },
    { id: "queue/models.go#Job.Ready", kind: "variable", start: 2, end: 2 },
    { id: "queue/models.go#Job.Tag", kind: "variable", start: 3, end: 3 },
  ],
  refs: [
    { from: "src/models.ts#DeadJob.job", to: "src/models.ts#Job", kind: "type-ref", line: 6 },
    { from: "src/models.ts#Queue.dead", to: "src/models.ts#DeadJob", kind: "type-ref", line: 10 },
    // a use inside a method: behaviour, not data the type holds
    { from: "src/models.ts#Queue.push", to: "src/models.ts#Job", kind: "type-ref", line: 11 },
  ],
});

const sym = (id: string) => `sym:${id}`;
const TS_INCLUDE = [
  "src/models.ts#Job",
  "src/models.ts#Job.id",
  "src/models.ts#Job.attempts",
  "src/models.ts#DeadJob",
  "src/models.ts#DeadJob.job",
  "src/models.ts#DeadJob.error",
  "src/models.ts#Queue",
  "src/models.ts#Queue.dead",
].map(sym);

function derive(include: string[], boxText?: GraphView["boxText"]) {
  const view: GraphView = {
    id: "view:data",
    type: "graph",
    title: "Data",
    scope: { root: "repo", depth: 1 },
    provenance: { origin: "llm" },
    include,
    edgeKinds: ["references"],
    stubs: { mode: "none" },
    ...(boxText ? { boxText } : {}),
  };
  return deriveGraph(view, new ExplainerModel(emptyExplainer(), w.model), { text: w.getText });
}

describe('boxText: "members"', () => {
  it("draws arrows from the field rows and leaves out the uses inside methods", () => {
    expect(derive(TS_INCLUDE, "members").edges.map((e) => e.id)).toEqual([
      "edge:references:sym:src/models.ts#DeadJob.job->sym:src/models.ts#Job",
      "edge:references:sym:src/models.ts#Queue.dead->sym:src/models.ts#DeadJob",
    ]);
    // the same boxes on an ordinary map: the method's use of Job lifts to Queue
    expect(derive(TS_INCLUDE).edges.map((e) => e.id)).toContain(
      "edge:references:sym:src/models.ts#Queue->sym:src/models.ts#Job",
    );
  });

  // "references ×1" on every arrow of a data map said nothing; the arrow means the row's field
  // holds a value of the type it points at.
  it('names an arrow from a row "holds", and leaves the arrows of an ordinary map as they are', () => {
    expect(derive(TS_INCLUDE, "members").edges.map((e) => e.label)).toEqual(["holds", "holds"]);
    expect(derive(TS_INCLUDE).edges.map((e) => e.label)).toEqual([undefined, undefined, undefined]);
  });

  // folding a table (its rows left out) took its arrows away with its rows
  it("draws a folded table's arrows from the table, still named holds; never a method's uses", () => {
    const folded = TS_INCLUDE.filter((id) => !id.includes("DeadJob."));
    expect(derive(folded, "members").edges.map((e) => [e.id, e.label])).toEqual([
      ["edge:references:sym:src/models.ts#DeadJob->sym:src/models.ts#Job", "holds"],
      ["edge:references:sym:src/models.ts#Queue.dead->sym:src/models.ts#DeadJob", "holds"],
    ]);
    // Queue folded too: its field's arrow stays, the use of Job inside push() does not join it
    const both = folded.filter((id) => !id.includes("Queue."));
    expect(derive(both, "members").edges.map((e) => e.id)).toEqual([
      "edge:references:sym:src/models.ts#DeadJob->sym:src/models.ts#Job",
      "edge:references:sym:src/models.ts#Queue->sym:src/models.ts#DeadJob",
    ]);
  });

  it("makes each type with rows a table, rows in code order, each with the type its line names", () => {
    const nodes = derive(TS_INCLUDE, "members").nodes;
    expect(nodes.filter((n) => n.rows).map((n) => n.id)).toEqual(
      ["src/models.ts#DeadJob", "src/models.ts#Job", "src/models.ts#Queue"].map(sym),
    );
    expect(nodes.filter((n) => n.parent).map((n) => [n.id, n.row, n.memberType])).toEqual([
      [sym("src/models.ts#DeadJob.error"), 1, "string"],
      [sym("src/models.ts#DeadJob.job"), 0, "Job"],
      [sym("src/models.ts#Job.attempts"), 1, "number"],
      [sym("src/models.ts#Job.id"), 0, "string"],
      [sym("src/models.ts#Queue.dead"), 0, "DeadJob[]"],
    ]);
    // an ordinary map has containers, not tables
    expect(derive(TS_INCLUDE).nodes.filter((n) => n.rows || n.row !== undefined)).toEqual([]);
  });

  it("reads the type of a Python and a Go field, and none from a plain assignment", () => {
    const types = (include: string[]) =>
      derive(include.map(sym), "members")
        .nodes.filter((n) => n.parent)
        .map((n) => [n.id.split("#")[1], n.memberType]);
    expect(
      types([
        "app/models.py#Job",
        "app/models.py#Job.payload",
        "app/models.py#Job.priority",
        "app/models.py#Job.name",
      ]),
    ).toEqual([
      ["Job.name", undefined],
      ["Job.payload", "dict[str, Any]"],
      ["Job.priority", "int"],
    ]);
    expect(
      types(["queue/models.go#Job", "queue/models.go#Job.Ready", "queue/models.go#Job.Tag"]),
    ).toEqual([
      ["Job.Ready", "[]*Job"],
      ["Job.Tag", "string"],
    ]);
  });

  // a Go struct is indexed as "class"; the reader reads the language's own word on every box.
  it('gives a Go struct the word "struct" and a field of any type the word "field"', () => {
    const words = (include: string[]) =>
      derive(include.map(sym), "members").nodes.map((n) => [n.id.split("#")[1], n.kindWord]);
    expect(words(["queue/models.go#Job", "queue/models.go#Job.Ready"])).toEqual([
      ["Job", "struct"],
      ["Job.Ready", "field"],
    ]);
    // a TypeScript class keeps its word; its field and an interface's field are fields
    expect(
      words([
        "src/models.ts#Queue",
        "src/models.ts#Queue.dead",
        "src/models.ts#Job",
        "src/models.ts#Job.id",
      ]),
    ).toEqual([
      ["Job", undefined],
      ["Job.id", "field"],
      ["Queue", undefined],
      ["Queue.dead", "field"],
    ]);
  });
});

// the Text view and a row's name cut a long type ("Array<(worker: Worker) => v…"); only the drawing may
describe("a row's long type", () => {
  it("is given whole", () => {
    const world = makeWorld({
      files: [
        {
          path: "src/pool.ts",
          text: [
            "export class WorkerPool {",
            "  waiting: Array<(worker: Worker) => void> = [];",
            "}",
          ].join("\n"),
        },
      ],
      symbols: [
        { id: "src/pool.ts#WorkerPool", kind: "class", start: 1, end: 3 },
        { id: "src/pool.ts#WorkerPool.waiting", kind: "variable", start: 2, end: 2 },
      ],
      refs: [],
    });
    const view: GraphView = {
      id: "view:pool",
      type: "graph",
      title: "Pool",
      scope: { root: "repo", depth: 1 },
      provenance: { origin: "llm" },
      include: [sym("src/pool.ts#WorkerPool"), sym("src/pool.ts#WorkerPool.waiting")],
      boxText: "members",
    };
    const nodes = deriveGraph(view, new ExplainerModel(emptyExplainer(), world.model), {
      text: world.getText,
    }).nodes;
    expect(nodes.find((n) => n.row !== undefined)!.memberType).toBe(
      "Array<(worker: Worker) => void>",
    );
  });
});

// "WorkerPool.waiting holds Worker" for an array of callbacks that take a Worker: it holds functions
describe("a field whose type names a type only as a function's parameter", () => {
  const world = makeWorld({
    files: [
      {
        path: "src/pool.ts",
        text: [
          "export class Worker {}",
          "export class WorkerPool {",
          "  idle: Worker[] = [];",
          "  waiting: Array<(worker: Worker) => void> = [];",
          "}",
          "type Pool struct {",
          "\tnotify func(w *Worker) error",
          "}",
          "class Pool:",
          "    on_free: Callable[[Worker], None]",
        ].join("\n"),
      },
    ],
    symbols: [
      { id: "src/pool.ts#Worker", kind: "class", start: 1, end: 1 },
      { id: "src/pool.ts#WorkerPool", kind: "class", start: 2, end: 5 },
      { id: "src/pool.ts#WorkerPool.idle", kind: "variable", start: 3, end: 3 },
      { id: "src/pool.ts#WorkerPool.waiting", kind: "variable", start: 4, end: 4 },
      { id: "src/pool.ts#Pool", kind: "class", start: 6, end: 8 },
      { id: "src/pool.ts#Pool.notify", kind: "variable", start: 7, end: 7 },
      { id: "src/pool.ts#PyPool", kind: "class", start: 9, end: 10 },
      { id: "src/pool.ts#PyPool.on_free", kind: "variable", start: 10, end: 10 },
    ],
    refs: ["WorkerPool.idle", "WorkerPool.waiting", "Pool.notify", "PyPool.on_free"].map(
      (from, i) => ({
        from: `src/pool.ts#${from}`,
        to: "src/pool.ts#Worker",
        kind: "type-ref" as const,
        line: [3, 4, 7, 10][i]!,
      }),
    ),
  });
  it("draws no holds arrow for it; a field that holds the type keeps its arrow", () => {
    const ids = [
      "Worker",
      "WorkerPool",
      "WorkerPool.idle",
      "WorkerPool.waiting",
      "Pool",
      "Pool.notify",
      "PyPool",
      "PyPool.on_free",
    ];
    const view: GraphView = {
      id: "view:pool",
      type: "graph",
      title: "Pool",
      scope: { root: "repo", depth: 1 },
      provenance: { origin: "llm" },
      include: ids.map((id) => sym(`src/pool.ts#${id}`)),
      edgeKinds: ["references"],
      boxText: "members",
    };
    const graph = deriveGraph(view, new ExplainerModel(emptyExplainer(), world.model), {
      text: world.getText,
    });
    expect(graph.edges.map((e) => e.id)).toEqual([
      "edge:references:sym:src/pool.ts#WorkerPool.idle->sym:src/pool.ts#Worker",
    ]);
  });
});

// `export const applyCommand = {…}` was a "variable" on its box; the code says it is a constant
describe("the word on a top-level value's box", () => {
  const world = makeWorld({
    files: [
      {
        path: "src/cmd.ts",
        text: ["export const applyCommand = {", "};", "let count = 0;", "const LIMIT = 3;"].join(
          "\n",
        ),
      },
    ],
    symbols: [
      { id: "src/cmd.ts#applyCommand", kind: "variable", start: 1, end: 2 },
      { id: "src/cmd.ts#count", kind: "variable", start: 3, end: 3 },
      { id: "src/cmd.ts#LIMIT", kind: "variable", start: 4, end: 4 },
    ],
    refs: [],
  });
  it('is "constant" for a const declaration and stays "variable" for a let', () => {
    const view: GraphView = {
      id: "view:cmd",
      type: "graph",
      title: "Commands",
      scope: { root: "repo", depth: 1 },
      provenance: { origin: "llm" },
      include: ["applyCommand", "count", "LIMIT"].map((name) => sym(`src/cmd.ts#${name}`)),
    };
    const nodes = deriveGraph(view, new ExplainerModel(emptyExplainer(), world.model), {
      text: world.getText,
    }).nodes;
    expect(nodes.map((n) => [n.label, n.kindWord])).toEqual([
      ["LIMIT", "constant"],
      ["applyCommand", "constant"],
      ["count", undefined],
    ]);
  });
});
