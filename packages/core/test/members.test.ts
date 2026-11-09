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

  // V4-03/V4-05: "references ×1" on every arrow of a data map said nothing; the arrow means the row's field
  // holds a value of the type it points at.
  it('names an arrow from a row "holds", and leaves the arrows of an ordinary map as they are', () => {
    expect(derive(TS_INCLUDE, "members").edges.map((e) => e.label)).toEqual(["holds", "holds"]);
    expect(derive(TS_INCLUDE).edges.every((e) => e.label === undefined)).toBe(true);
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
    expect(derive(TS_INCLUDE).nodes.some((n) => n.rows || n.row !== undefined)).toBe(false);
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
});
