import { describe, expect, it } from "vitest";
import { implementationsOf, implementedBy } from "../src/index.js";
import { makeWorld } from "./helpers.js";

/**
 * A Go-shaped repository: an interface with three methods in runner/, an implementation in queue/ whose
 * `Ack` sits in another file of the package, and a test double next to the interface.
 */
const go = makeWorld({
  files: [
    { path: "runner/runner.go", lines: 10, language: "go" },
    { path: "runner/retry_test.go", lines: 20, language: "go" },
    { path: "queue/queue.go", lines: 30, language: "go" },
    { path: "queue/extra.go", lines: 10, language: "go" },
    { path: "other/other.go", lines: 10, language: "go" },
  ],
  symbols: [
    { id: "runner/runner.go#JobQueue", kind: "interface", start: 1, end: 5 },
    { id: "runner/runner.go#JobQueue.Pop", kind: "method", start: 2, end: 2 },
    { id: "runner/runner.go#JobQueue.Requeue", kind: "method", start: 3, end: 3 },
    { id: "runner/runner.go#JobQueue.Ack", kind: "method", start: 4, end: 4 },
    { id: "queue/queue.go#Queue", kind: "class", start: 1, end: 4 },
    {
      id: "queue/queue.go#Queue.Pop",
      kind: "method",
      start: 6,
      end: 12,
      parent: "queue/queue.go#Queue",
    },
    { id: "queue/queue.go#Queue.Requeue", kind: "method", start: 14, end: 20 },
    { id: "queue/extra.go#Queue.Ack", kind: "method", start: 1, end: 5 },
    { id: "runner/retry_test.go#recordingQueue", kind: "class", start: 1, end: 3 },
    { id: "runner/retry_test.go#recordingQueue.Requeue", kind: "method", start: 5, end: 8 },
    { id: "other/other.go#Thing", kind: "class", start: 1, end: 3 },
    { id: "other/other.go#Thing.Pop", kind: "method", start: 5, end: 8 },
  ],
  refs: [
    { from: "queue/queue.go#Queue", to: "runner/runner.go#JobQueue", kind: "implements", line: 1 },
    {
      from: "runner/retry_test.go#recordingQueue",
      to: "runner/runner.go#JobQueue",
      kind: "implements",
      line: 1,
      resolution: "heuristic",
    },
  ],
});

const ids = (list: { id: string }[]) => list.map((i) => i.id);

describe("implementationsOf", () => {
  it("an interface: the types that implement it", () => {
    // sorted by file
    expect(implementationsOf(go.model, "runner/runner.go#JobQueue")).toEqual([
      { id: "queue/queue.go#Queue", resolution: "precise" },
      { id: "runner/retry_test.go#recordingQueue", resolution: "heuristic" },
    ]);
  });

  it("an interface method: the same-named methods of the implementing types", () => {
    expect(ids(implementationsOf(go.model, "runner/runner.go#JobQueue.Requeue"))).toEqual([
      "queue/queue.go#Queue.Requeue",
      "runner/retry_test.go#recordingQueue.Requeue",
    ]);
    expect(ids(implementationsOf(go.model, "runner/runner.go#JobQueue.Pop"))).toEqual([
      "queue/queue.go#Queue.Pop",
    ]);
  });

  it("finds a method declared in another file of the package, but not in another package", () => {
    expect(ids(implementationsOf(go.model, "runner/runner.go#JobQueue.Ack"))).toEqual([
      "queue/extra.go#Queue.Ack",
    ]);
    // Thing.Pop has the same name and lives elsewhere, but Thing implements nothing
    expect(ids(implementationsOf(go.model, "runner/runner.go#JobQueue.Pop"))).not.toContain(
      "other/other.go#Thing.Pop",
    );
  });

  it("carries the resolution of the implements reference the answer rests on", () => {
    const requeue = implementationsOf(go.model, "runner/runner.go#JobQueue.Requeue");
    expect(requeue.map((i) => i.resolution)).toEqual(["precise", "heuristic"]);
  });

  it("nothing implements a concrete method, a function, or an unknown id", () => {
    expect(implementationsOf(go.model, "queue/queue.go#Queue.Pop")).toEqual([]);
    expect(implementationsOf(go.model, "queue/queue.go#Queue")).toEqual([]);
    expect(implementationsOf(go.model, "queue/queue.go#nope")).toEqual([]);
  });

  it("uses member-level implements references (precise indexes) as they are", () => {
    const ts = makeWorld({
      files: [
        { path: "src/base.ts", lines: 10 },
        { path: "src/impl.ts", lines: 10 },
      ],
      symbols: [
        { id: "src/base.ts#Base", kind: "class", start: 1, end: 5 },
        { id: "src/base.ts#Base.run", kind: "method", start: 2, end: 2 },
        { id: "src/impl.ts#Impl", kind: "class", start: 1, end: 8 },
        { id: "src/impl.ts#Impl.exec", kind: "method", start: 2, end: 4 },
      ],
      // no type-level reference, and a different name: only the member-level one links them
      refs: [
        { from: "src/impl.ts#Impl.exec", to: "src/base.ts#Base.run", kind: "implements", line: 2 },
      ],
    });
    expect(implementationsOf(ts.model, "src/base.ts#Base.run")).toEqual([
      { id: "src/impl.ts#Impl.exec", resolution: "precise" },
    ]);
    expect(implementedBy(ts.model, "src/impl.ts#Impl.exec")).toEqual([
      { id: "src/base.ts#Base.run", resolution: "precise" },
    ]);
  });

  it("an interface that extends another passes its implementers on, and cycles end", () => {
    const io = makeWorld({
      files: [{ path: "io.go", lines: 40, language: "go" }],
      symbols: [
        { id: "io.go#Reader", kind: "interface", start: 1, end: 3 },
        { id: "io.go#Reader.Read", kind: "method", start: 2, end: 2 },
        { id: "io.go#ReadCloser", kind: "interface", start: 5, end: 8 },
        { id: "io.go#ReadCloser.Close", kind: "method", start: 7, end: 7 },
        { id: "io.go#File", kind: "class", start: 10, end: 12 },
        { id: "io.go#File.Read", kind: "method", start: 14, end: 18 },
        { id: "io.go#File.Close", kind: "method", start: 20, end: 24 },
      ],
      refs: [
        { from: "io.go#ReadCloser", to: "io.go#Reader", kind: "extends", line: 6 },
        { from: "io.go#File", to: "io.go#ReadCloser", kind: "implements", line: 10 },
        // a nonsense cycle must not hang
        { from: "io.go#Reader", to: "io.go#ReadCloser", kind: "extends", line: 1 },
      ],
    });
    expect(ids(implementationsOf(io.model, "io.go#Reader"))).toEqual(["io.go#File"]);
    expect(ids(implementationsOf(io.model, "io.go#Reader.Read"))).toEqual(["io.go#File.Read"]);
    expect(ids(implementationsOf(io.model, "io.go#ReadCloser.Close"))).toEqual([
      "io.go#File.Close",
    ]);
    // the interface that extends is not an implementation of its parent
    expect(ids(implementationsOf(io.model, "io.go#Reader"))).not.toContain("io.go#ReadCloser");
    // and the way back: File.Read implements Reader.Read (through the interface File implements)
    expect(ids(implementedBy(io.model, "io.go#File.Read"))).toEqual(["io.go#Reader.Read"]);
    expect(ids(implementedBy(io.model, "io.go#File.Close"))).toEqual(["io.go#ReadCloser.Close"]);
  });
});

describe("implementedBy", () => {
  it("a method: the interface methods it implements", () => {
    expect(implementedBy(go.model, "queue/queue.go#Queue.Requeue")).toEqual([
      { id: "runner/runner.go#JobQueue.Requeue", resolution: "precise" },
    ]);
    expect(ids(implementedBy(go.model, "queue/queue.go#Queue.Pop"))).toEqual([
      "runner/runner.go#JobQueue.Pop",
    ]);
  });

  it("finds the owner of a method that sits in another file than its type", () => {
    expect(ids(implementedBy(go.model, "queue/extra.go#Queue.Ack"))).toEqual([
      "runner/runner.go#JobQueue.Ack",
    ]);
  });

  it("a type: the interfaces it implements; nothing for what implements nothing", () => {
    expect(ids(implementedBy(go.model, "queue/queue.go#Queue"))).toEqual([
      "runner/runner.go#JobQueue",
    ]);
    expect(implementedBy(go.model, "other/other.go#Thing.Pop")).toEqual([]);
    expect(implementedBy(go.model, "runner/runner.go#JobQueue.Pop")).toEqual([]);
    expect(implementedBy(go.model, "nope#x")).toEqual([]);
  });

  it("does not list an interface method the type has no counterpart for", () => {
    // recordingQueue has no Pop or Ack: only its Requeue implements something
    expect(ids(implementedBy(go.model, "runner/retry_test.go#recordingQueue.Requeue"))).toEqual([
      "runner/runner.go#JobQueue.Requeue",
    ]);
  });
});
