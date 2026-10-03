/**
 * End-to-end: Go sources -> facts -> heuristic resolver -> references. Every repository here is a small
 * temp directory built through `buildIndex`, so module resolution (`go.mod`), package scope (directory) and the
 * type facts of the pack are exercised together.
 */
import { describe, expect, it } from "vitest";
import type { Reference, SymbolIndex } from "@xpl/core";
import { hasRef, indexFiles } from "./helpers.js";

const src = (...lines: string[]): string => lines.join("\n") + "\n";
const GO_MOD = "module example.com/app\n\ngo 1.22\n";

/** `from -> to (kind)` of every ref whose `from` starts with `prefix`, sorted. */
function refsFrom(index: SymbolIndex, prefix: string, kind?: Reference["kind"]): string[] {
  return index.refs
    .filter((r) => r.from.startsWith(prefix) && (!kind || r.kind === kind))
    .map((r) => `${r.from.slice(r.from.indexOf("#") + 1) || "(file)"} -> ${r.to} (${r.kind})`)
    .sort();
}

describe("same-directory files share a namespace", () => {
  it("functions, types and methods of the other files of the package resolve; other directories do not", async () => {
    const { index } = await indexFiles({
      "pkg/a.go": src(
        "package pkg",
        "func A() {", // 2
        "\tB()",
        "\tvar t T",
        "\tt.M()",
        "\t_ = C{}",
        "\tt.Later()",
        "}",
      ),
      "pkg/b.go": src(
        "package pkg",
        "func B() {}",
        "type T struct{}",
        "func (t *T) M() {}",
        "type C struct{}",
      ),
      "pkg/c.go": src("package pkg", "func (t *T) Later() {}"),
      "other/d.go": src("package other", "func D() { B() }"),
    });
    expect(refsFrom(index, "pkg/a.go#A")).toEqual([
      "A -> pkg/b.go#B (call)",
      "A -> pkg/b.go#C (call)",
      "A -> pkg/b.go#T (type-ref)",
      "A -> pkg/b.go#T.M (call)",
      "A -> pkg/c.go#T.Later (call)",
    ]);
    expect(refsFrom(index, "other/d.go")).toEqual([]);
  });

  it("the receiver of a method declared in another file than its type still reaches the type's fields and methods", async () => {
    const { index } = await indexFiles({
      "q/queue.go": src(
        "package q",
        "type Queue struct{ n int; peer *Queue }",
        "func (q *Queue) Len() int { return q.n }",
      ),
      "q/extra.go": src(
        "package q",
        "func (q *Queue) Bump() {", // 2
        "\tq.n++",
        "\tq.Len()",
        "\tq.peer.Len()",
        "}",
      ),
    });
    expect(refsFrom(index, "q/extra.go#Queue.Bump")).toEqual([
      "Queue.Bump -> q/queue.go#Queue (type-ref)",
      "Queue.Bump -> q/queue.go#Queue.Len (call)",
      "Queue.Bump -> q/queue.go#Queue.Len (call)",
      "Queue.Bump -> q/queue.go#Queue.n (write)",
      "Queue.Bump -> q/queue.go#Queue.peer (read)",
    ]);
  });
});

describe("package-qualified names through go.mod", () => {
  const files = {
    "go.mod": GO_MOD,
    "internal/queue/queue.go": src(
      "// Package queue holds jobs.",
      "package queue",
      "type Job struct{ ID string }",
      "type Queue struct{ jobs []Job }",
      "func New() *Queue { return &Queue{} }",
      "func (q *Queue) Push(j Job) {}",
      "func Helper() {}",
      "var Default = New()",
    ),
    "internal/queue/deadletter.go": src("package queue", "func (q *Queue) Dead() int { return 0 }"),
    "cmd/app/main.go": src(
      "package main",
      "",
      "import (",
      '\t"fmt"',
      '\t"example.com/app/internal/queue"',
      ")",
      "",
      "func main() {", // 8
      "\tq := queue.New()",
      '\tq.Push(queue.Job{ID: "a"})',
      "\tq.Dead()",
      "\tvar j queue.Job",
      "\tqueue.Helper()",
      "\tfmt.Println(j)",
      "}",
    ),
  };

  it("calls, composite literals, type names and results of package functions resolve through the import", async () => {
    const { index } = await indexFiles(files);
    expect(refsFrom(index, "cmd/app/main.go#main")).toEqual([
      "main -> internal/queue/deadletter.go#Queue.Dead (call)",
      "main -> internal/queue/queue.go#Helper (call)",
      "main -> internal/queue/queue.go#Job (call)",
      "main -> internal/queue/queue.go#Job (type-ref)",
      "main -> internal/queue/queue.go#New (call)",
      "main -> internal/queue/queue.go#Queue.Push (call)",
    ]);
  });

  it("an import is a reference from the file's module scope to the package's main file", async () => {
    const { index } = await indexFiles(files);
    expect(refsFrom(index, "cmd/app/main.go#", "import")).toEqual([
      "(file) -> internal/queue/queue.go# (import)",
    ]);
    const ref = index.refs.find((r) => r.kind === "import")!;
    expect(ref.site).toEqual({ startLine: 5, startCol: 2, endLine: 5, endCol: 33 });
    expect(ref.resolution).toBe("heuristic");
  });

  it("aliased, blank and dot imports are bindings too; a dot import makes the names visible unqualified", async () => {
    const { index } = await indexFiles({
      ...files,
      "cmd/alias/main.go": src(
        "package main",
        "import (",
        '\tq "example.com/app/internal/queue"',
        '\t_ "example.com/app/internal/queue"',
        '\t. "example.com/app/internal/queue"',
        ")",
        "func main() {",
        "\tq.Helper()",
        "\tNew()",
        "\tvar x Queue",
        "\t_ = x",
        "}",
      ),
    });
    const refs = refsFrom(index, "cmd/alias/main.go#");
    expect(refs).toContain("main -> internal/queue/queue.go#Helper (call)"); // through the alias
    expect(refs).toContain("main -> internal/queue/queue.go#New (call)"); // through the dot import
    expect(refs).toContain("main -> internal/queue/queue.go#Queue (type-ref)");
    // three specs, one package: the import refs of the same target at different sites
    expect(refs.filter((r) => r.endsWith("(import)")).length).toBe(3);
  });

  it("the standard library and external modules produce no references", async () => {
    const { index } = await indexFiles({
      "go.mod": GO_MOD,
      "a.go": src(
        "package main",
        'import (\n\t"fmt"\n\t"strings"\n\t"github.com/other/lib"\n)',
        "func main() {",
        '\tfmt.Println(strings.ToUpper("x"))',
        "\tlib.Do()",
        "\tvar b strings.Builder",
        "\t_ = b",
        "}",
      ),
    });
    expect(index.refs).toEqual([]);
  });

  it("without a go.mod, packages in other directories are unknown but the same directory still works", async () => {
    const { index } = await indexFiles({
      "a/a.go": src(
        "package a",
        'import "example.com/app/b"',
        "func F() { b.G(); H() }",
        "func H() {}",
      ),
      "b/b.go": src("package b", "func G() {}"),
    });
    expect(refsFrom(index, "a/a.go#F")).toEqual(["F -> a/a.go#H (call)"]);
  });

  it("a directory called v1 is package v1, a major version suffix belongs to the previous element", async () => {
    const { index } = await indexFiles({
      "go.mod": GO_MOD,
      "api/v1/types.go": src(
        "package v1",
        "type Pod struct{}",
        "func NewPod() *Pod { return nil }",
      ),
      "svc/svc.go": src(
        "package svc",
        'import "example.com/app/api/v1"',
        "func F() {",
        "\t_ = v1.Pod{}",
        "\tv1.NewPod()",
        "}",
      ),
    });
    expect(refsFrom(index, "svc/svc.go#F")).toEqual([
      "F -> api/v1/types.go#NewPod (call)",
      "F -> api/v1/types.go#Pod (call)",
    ]);
  });
});

describe("receivers, fields and locals", () => {
  it("r.field.M() through struct field types, including interface-typed fields; function-typed fields are called too", async () => {
    const { index } = await indexFiles({
      "runner.go": src(
        "package runner",
        "type Job struct{}",
        "func (j *Job) Do() {}",
        "type JobQueue interface {",
        "\tPop() (*Job, error)",
        "\tAck(j *Job) error",
        "}",
        "type Runner struct {",
        "\tqueue JobQueue",
        "\tlogf  func(string)",
        "}",
        "func (r *Runner) helper() {}",
        "func (r *Runner) Run() {", // 13
        "\tjob, err := r.queue.Pop()",
        "\tr.queue.Ack(job)",
        "\tr.helper()",
        '\tr.logf("x")',
        "\tjob.Do()",
        "\t_ = err",
        "}",
      ),
    });
    expect(refsFrom(index, "runner.go#Runner.Run", "call")).toEqual([
      "Runner.Run -> runner.go#Job.Do (call)",
      "Runner.Run -> runner.go#JobQueue.Ack (call)",
      "Runner.Run -> runner.go#JobQueue.Pop (call)",
      "Runner.Run -> runner.go#Runner.helper (call)",
      "Runner.Run -> runner.go#Runner.logf (call)",
    ]);
  });

  it("locals typed by `x := f()`, `x, err := pkg.New()`, `var x T`, `&T{}`, `T{}`, `new(T)`, conversions, assertions and aliases", async () => {
    const { index } = await indexFiles({
      "go.mod": GO_MOD,
      "w/w.go": src(
        "package w",
        "type Worker struct{}",
        "func (w *Worker) Run() {}",
        "func New(id string) (*Worker, error) { return &Worker{}, nil }",
      ),
      "app/app.go": src(
        "package app",
        'import "example.com/app/w"',
        "type Holder struct{ worker *w.Worker }",
        "func local() *w.Worker { return nil }",
        "func (h *Holder) Use(any interface{}) {", // 5
        '\ta, err := w.New("a")', // 6
        "\ta.Run()",
        "\t_ = err",
        "\tb := local()",
        "\tb.Run()",
        "\tvar c *w.Worker",
        "\tc.Run()",
        "\td := &w.Worker{}",
        "\td.Run()",
        "\te := w.Worker{}",
        "\te.Run()",
        "\tf := new(w.Worker)",
        "\tf.Run()",
        "\tg := (*w.Worker)(nil)",
        "\tg.Run()",
        "\ti := any.(*w.Worker)",
        "\ti.Run()",
        "\tj := h.worker",
        "\tj.Run()",
        "\tk := j",
        "\tk.Run()",
        "}",
      ),
    });
    const runs = index.refs
      .filter((r) => r.to === "w/w.go#Worker.Run" && r.kind === "call")
      .map((r) => r.site.startLine);
    // every one of the ten `x.Run()` lines resolves
    expect(runs).toEqual([7, 10, 12, 14, 16, 18, 20, 22, 24, 26]);
  });

  it("switch v := x.(type): in a single-type clause v has that type, in others it is unknown", async () => {
    const { index } = await indexFiles({
      "a.go": src(
        "package p",
        "type A struct{}",
        "func (A) Go() {}",
        "type B struct{}",
        "func (B) Go() {}",
        "func f(x any) {", // 6
        "\tswitch v := x.(type) {",
        "\tcase *A:",
        "\t\tv.Go()", // 9
        "\tcase B:",
        "\t\tv.Go()", // 11
        "\tcase A, B:",
        "\t\tv.Go()", // 13 (no single type)
        "\t}",
        "\tif b, ok := x.(B); ok {",
        "\t\tb.Go()", // 16
        "\t}",
        "}",
      ),
    });
    const calls = index.refs
      .filter((r) => r.kind === "call")
      .map((r) => `${r.site.startLine} -> ${r.to.split("#")[1]}`);
    expect(calls).toEqual(["9 -> A.Go", "11 -> B.Go", "16 -> B.Go"]);
  });

  it("method expressions and calls through results: (*T).M(x), pkg.New().M(), T{}.M()", async () => {
    const { index } = await indexFiles({
      "a.go": src(
        "package p",
        "type T struct{}",
        "func (t *T) M() {}",
        "func New() *T { return nil }",
        "func f(t *T) {", // 5
        "\t(*T).M(t)",
        "\tNew().M()",
        "\tT{}.M()",
        "}",
      ),
    });
    expect(refsFrom(index, "a.go#f", "call")).toEqual([
      "f -> a.go#New (call)",
      "f -> a.go#T (call)",
      "f -> a.go#T.M (call)",
      "f -> a.go#T.M (call)",
      "f -> a.go#T.M (call)",
    ]);
  });
});

describe("embedding", () => {
  const files = {
    "go.mod": GO_MOD,
    "q/q.go": src(
      "package q",
      "type Queue struct{ n int }",
      "func (q *Queue) Push() {}",
      "func (q *Queue) Pop() {}",
    ),
    "app/app.go": src(
      "package app",
      'import "example.com/app/q"',
      "type Recording struct {", // 3
      "\t*q.Queue",
      "\tcalls []string",
      "}",
      "func NewRecording() *Recording { return &Recording{Queue: &q.Queue{}} }",
      "func (r *Recording) Pop() {", // 7
      "\tr.Queue.Pop()", // 8: the embedded field by name
      "\tr.Push()", // 9: promoted
      "}",
      "func use() {", // 11
      "\tr := NewRecording()",
      "\tr.Push()", // 13: promoted through the embedded pointer
      "\tr.Pop()", // 14: the override
      "}",
    ),
  };

  it("an embedded field is an `extends` ref and its methods are promoted", async () => {
    const { index } = await indexFiles(files);
    expect(hasRef(index, "app/app.go#Recording", "q/q.go#Queue", "extends")).toBe(true);
    expect(refsFrom(index, "app/app.go#Recording.Pop", "call")).toEqual([
      "Recording.Pop -> q/q.go#Queue.Pop (call)", // r.Queue.Pop()
      "Recording.Pop -> q/q.go#Queue.Push (call)", // r.Push(), promoted
    ]);
    expect(refsFrom(index, "app/app.go#use", "call")).toEqual([
      "use -> app/app.go#NewRecording (call)",
      "use -> app/app.go#Recording.Pop (call)",
      "use -> q/q.go#Queue.Push (call)",
    ]);
  });

  it("embedded interfaces: their methods are found through the embedding interface", async () => {
    const { index } = await indexFiles({
      "a.go": src(
        "package p",
        "type Reader interface{ Read() }",
        "type ReadCloser interface {",
        "\tReader",
        "\tClose()",
        "}",
        "func f(rc ReadCloser) {", // 7
        "\trc.Read()",
        "\trc.Close()",
        "}",
      ),
    });
    expect(hasRef(index, "a.go#ReadCloser", "a.go#Reader", "extends")).toBe(true);
    expect(refsFrom(index, "a.go#f", "call")).toEqual([
      "f -> a.go#ReadCloser.Close (call)",
      "f -> a.go#Reader.Read (call)",
    ]);
  });
});

describe("shadowing", () => {
  it("a parameter named like the package it is typed by: the type resolves to the package, the calls to the parameter", async () => {
    const { index } = await indexFiles({
      "go.mod": GO_MOD,
      "queue/queue.go": src(
        "package queue",
        "type Queue struct{}",
        "func (q *Queue) Push() {}",
        "func Reset() {}",
      ),
      "app/app.go": src(
        "package app",
        'import "example.com/app/queue"',
        "func Use(queue *queue.Queue) {", // 3
        "\tqueue.Push()",
        "}",
        "func Other() {",
        "\tqueue.Reset()",
        "}",
      ),
    });
    expect(refsFrom(index, "app/app.go#Use")).toEqual([
      "Use -> queue/queue.go#Queue (type-ref)",
      "Use -> queue/queue.go#Queue.Push (call)",
    ]);
    // elsewhere in the file the name is the package again
    expect(refsFrom(index, "app/app.go#Other")).toEqual(["Other -> queue/queue.go#Reset (call)"]);
  });

  it("a local that hides an import is not the package: not even by name", async () => {
    const { index } = await indexFiles({
      "go.mod": GO_MOD,
      "queue/queue.go": src("package queue", "func Reset() {}"),
      "app/app.go": src(
        "package app",
        'import "example.com/app/queue"',
        "func f(get func() int) {", // 3
        "\tqueue := get()",
        "\tqueue.Reset()", // the local's method, not queue.Reset
        "}",
      ),
    });
    expect(refsFrom(index, "app/app.go#f", "call")).toEqual([]);
  });

  it("a closure parameter that hides the receiver is not the receiver", async () => {
    const { index } = await indexFiles({
      "a.go": src(
        "package p",
        "type App struct{}",
        "func (a *App) own() {}",
        "type Other struct{}",
        "func (o *Other) own() {}",
        "func (a *App) Run() {", // 6
        "\ta.own()",
        "\tf := func(a *Other) { a.own() }",
        "\tf(nil)",
        "\ta.own()",
        "}",
      ),
    });
    const owns = index.refs
      .filter((r) => r.from === "a.go#App.Run" && r.kind === "call")
      .map((r) => `${r.site.startLine}: ${r.to.split("#")[1]}`);
    expect(owns).toEqual(["7: App.own", "8: Other.own", "10: App.own"]);
  });

  it("assignments to and calls of locals are not references to same-named package-level symbols", async () => {
    const { index } = await indexFiles({
      "a.go": src(
        "package p",
        "var counter int",
        "func run() {}",
        "func f() {", // 4
        "\tcounter = 1", // a package variable
        "\tcounter := 2", // 6: a new local
        "\tcounter = 3", // the local
        "\trun := func() {}",
        "\trun()", // the local
        "\t_ = counter",
        "}",
        "func g() {",
        "\tcounter++",
        "\trun()",
        "}",
      ),
    });
    expect(refsFrom(index, "a.go#f")).toEqual(["f -> a.go#counter (write)"]);
    expect(refsFrom(index, "a.go#g")).toEqual([
      "g -> a.go#counter (write)",
      "g -> a.go#run (call)",
    ]);
  });
});

describe("writes", () => {
  it("fields of the receiver, of locals and of other packages' values; package variables across files", async () => {
    const { index } = await indexFiles({
      "go.mod": GO_MOD,
      "s/s.go": src("package s", "type Stats struct{ N int }", "var Total int"),
      "s/more.go": src("package s", "func Add() { Total += 1 }"),
      "app/app.go": src(
        "package app",
        'import "example.com/app/s"',
        "type App struct{ count int; stats s.Stats }",
        "func (a *App) Inc(st *s.Stats) {", // 4
        "\ta.count++",
        "\ta.stats.N = 1",
        "\tst.N = 2",
        "\ts.Total = 3",
        "\tvar local s.Stats",
        "\tlocal.N = 4",
        "}",
      ),
    });
    expect(refsFrom(index, "app/app.go#App.Inc", "write")).toEqual([
      "App.Inc -> app/app.go#App.count (write)",
      "App.Inc -> s/s.go#Stats.N (write)",
      "App.Inc -> s/s.go#Stats.N (write)",
      "App.Inc -> s/s.go#Stats.N (write)",
      "App.Inc -> s/s.go#Total (write)",
    ]);
    expect(refsFrom(index, "s/more.go#Add", "write")).toEqual(["Add -> s/s.go#Total (write)"]);
  });
});

describe("generics", () => {
  it("generic types, receivers and instantiated calls", async () => {
    const { index } = await indexFiles({
      "go.mod": GO_MOD,
      "q/q.go": src(
        "package q",
        "type Queue[T any] struct{ items []T }",
        "func New[T any]() *Queue[T] { return &Queue[T]{} }",
        "func (q *Queue[T]) Push(x T) { q.items = append(q.items, x) }",
        "func Map[A, B any](xs []A, f func(A) B) []B { return nil }",
      ),
      "app/app.go": src(
        "package app",
        'import "example.com/app/q"',
        "func F() {",
        "\tqueue := q.New[int]()",
        "\tqueue.Push(1)",
        "\tq.Map[int, string](nil, nil)",
        "\tvar typed *q.Queue[string]",
        '\ttyped.Push("a")',
        "}",
      ),
    });
    expect(refsFrom(index, "app/app.go#F")).toEqual([
      "F -> q/q.go#Map (call)",
      "F -> q/q.go#New (call)",
      "F -> q/q.go#Queue (type-ref)",
      "F -> q/q.go#Queue.Push (call)",
      "F -> q/q.go#Queue.Push (call)",
    ]);
    // T is a type parameter, not a type of the repository (even if the package had a type T)
    const withT = await indexFiles({
      "a.go": src("package p", "type T struct{}", "func Use[T any](x T) {}"),
    });
    expect(refsFrom(withT.index, "a.go#Use")).toEqual([]);
  });
});

describe("test files", () => {
  it("an in-package test file sees the package's symbols; importers do not see test-only symbols", async () => {
    const { index } = await indexFiles({
      "go.mod": GO_MOD,
      "p/p.go": src("package p", "func Do() int { return 1 }"),
      "p/p_test.go": src("package p", "func Helper() {}", "func TestDo() { Do(); Helper() }"),
      "app/app.go": src(
        "package app",
        'import "example.com/app/p"',
        "func F() { p.Do(); p.Helper() }",
      ),
    });
    expect(refsFrom(index, "p/p_test.go#TestDo")).toEqual([
      "TestDo -> p/p.go#Do (call)",
      "TestDo -> p/p_test.go#Helper (call)",
    ]);
    expect(refsFrom(index, "app/app.go#F")).toEqual(["F -> p/p.go#Do (call)"]);
  });

  it("an external test package sees the package under test, tests included", async () => {
    const { index } = await indexFiles({
      "go.mod": GO_MOD,
      "p/p.go": src("package p", "func Do() int { return 1 }"),
      "p/export_test.go": src("package p", "func Internal() int { return 2 }"),
      "p/p_ext_test.go": src(
        "package p_test",
        'import "example.com/app/p"',
        "func TestExt() { p.Do(); p.Internal() }",
      ),
    });
    expect(refsFrom(index, "p/p_ext_test.go#TestExt")).toEqual([
      "TestExt -> p/export_test.go#Internal (call)",
      "TestExt -> p/p.go#Do (call)",
    ]);
  });
});

describe("properties of the references", () => {
  it("are heuristic, self-references only for recursion, and their sites lie inside the file", async () => {
    const { index } = await indexFiles({
      "a.go": src(
        "package p",
        "type T struct{ n int }",
        "func (t *T) Rec() { t.Rec(); t.n++ }",
        "func F() { F(); G() }",
        "func G() {}",
      ),
    });
    expect(index.refs.length).toBeGreaterThan(0);
    for (const ref of index.refs) {
      expect(ref.resolution).toBe("heuristic");
      if (ref.from === ref.to) expect(ref.kind).toBe("call");
      expect(ref.site.startLine).toBeGreaterThanOrEqual(1);
      expect(ref.site.endLine).toBeLessThanOrEqual(5);
    }
    // recursion is a call of the symbol from inside itself (a receiver method too: chi's xn.findRoute)
    expect(hasRef(index, "a.go#F", "a.go#F", "call")).toBe(true);
    expect(hasRef(index, "a.go#T.Rec", "a.go#T.Rec", "call")).toBe(true);
    expect(hasRef(index, "a.go#T.Rec", "a.go#T.Rec", "read")).toBe(false);
    expect(hasRef(index, "a.go#F", "a.go#G", "call")).toBe(true);
  });

  it("index languages report heuristic references for Go", async () => {
    const { index } = await indexFiles({ "a.go": "package p\nfunc F() {}\n" });
    expect(index.languages.go).toMatchObject({ files: 1, symbols: 1, refs: "heuristic" });
    expect(index.tool).toContain("tree-sitter-go@");
  });
});

describe("files of other builds", () => {
  it("a name declared in several files of a package resolves to the file of a default build", async () => {
    const { index } = await indexFiles({
      "go.mod": GO_MOD,
      // sorted first, but only built with a custom tag, for another system or for another architecture
      "lab/a_dedupe.go": src(
        "//go:build dedupelabels",
        "",
        "package lab",
        "func Get() int { return 1 }",
      ),
      "lab/b_js.go": src("package lab", "func Map() int { return 1 }"),
      "lab/c_windows_arm64.go": src("package lab", "func Arch() int { return 1 }"),
      "lab/d_default.go": src(
        "//go:build !dedupelabels && (linux || darwin) && go1.21",
        "",
        "package lab",
        "func Get() int { return 2 }",
      ),
      "lab/e_linux_amd64.go": src(
        "package lab",
        "func Map() int { return 2 }",
        "func Arch() int { return 2 }",
      ),
      "lab/use.go": src("package lab", "func Use() int { return Get() + Map() + Arch() }"),
      "app/main.go": src(
        "package app",
        'import "example.com/app/lab"',
        "func Main() int { return lab.Get() }",
      ),
    });
    expect(refsFrom(index, "lab/use.go#", "call")).toEqual([
      "Use -> lab/d_default.go#Get (call)",
      "Use -> lab/e_linux_amd64.go#Arch (call)",
      "Use -> lab/e_linux_amd64.go#Map (call)",
    ]);
    expect(refsFrom(index, "app/main.go#", "call")).toEqual([
      "Main -> lab/d_default.go#Get (call)",
    ]);
  });
});

describe("the last-resort guess by receiver name", () => {
  it("prefers a type of the file's own package to one of a package it imports", async () => {
    const { index } = await indexFiles({
      "go.mod": GO_MOD,
      "root/body.go": src("package root", "type Body interface { Content() int }"),
      "syn/body.go": src(
        "package syn",
        "type Body struct{}",
        "func (b *Body) Content() int { return 1 }",
      ),
      "syn/use.go": src(
        "package syn",
        'import "example.com/app/root"',
        "var _ root.Body",
        "func Use(x any) int { body := x.(interface{ Content() int }); return body.Content() }",
      ),
    });
    expect(refsFrom(index, "syn/use.go#Use", "call")).toEqual([
      "Use -> syn/body.go#Body.Content (call)",
    ]);
  });
});
