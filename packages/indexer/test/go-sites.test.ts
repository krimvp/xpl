import { describe, expect, it } from "vitest";
import type { SiteDraft, Span, TypeFact } from "../src/index.js";
import { extract } from "./helpers.js";

const src = (...lines: string[]): string => lines.join("\n") + "\n";

/** The source text a span covers (1-based inclusive lines and columns); newlines are shown as ⏎. */
function covered(source: string, s: Span): string {
  const lines = source.split("\n");
  const out: string[] = [];
  for (let line = s.startLine; line <= s.endLine; line++) {
    const text = lines[line - 1] ?? "";
    const from = line === s.startLine ? s.startCol - 1 : 0;
    const to = line === s.endLine ? s.endCol : text.length;
    out.push(text.slice(from, to));
  }
  return out.join("⏎");
}

/** `kind qualifier.name «covered text»` */
const show = (source: string, s: SiteDraft): string =>
  `${s.kind} ${[...s.qualifier, s.name].join(".")} «${covered(source, s.site)}»`;

async function sitesOf(source: string, kinds?: string[]): Promise<string[]> {
  const { facts } = await extract("a.go", source);
  return facts.sites.filter((s) => !kinds || kinds.includes(s.kind)).map((s) => show(source, s));
}

/** `kind scope::name type=… init=… chain=…` of a type fact. */
const fact = (f: TypeFact): string =>
  `${f.kind} ${f.scopePath}::${f.name}` +
  (f.typeName !== undefined ? ` type=${f.typeName}` : "") +
  (f.initCall ? ` init=${[...f.initCall.qualifier, f.initCall.name].join(".")}()` : "") +
  (f.initChain ? ` chain=${f.initChain.join(".")}` : "");

async function factsOf(source: string, kinds?: string[]): Promise<string[]> {
  const { facts } = await extract("a.go", source);
  return facts.typeFacts.filter((f) => !kinds || kinds.includes(f.kind)).map(fact);
}

describe("Go call sites", () => {
  it("functions, package functions, methods, field chains and method expressions; the whole call is the site", async () => {
    const source = src(
      "package p",
      "func f() {",
      "\thelper(job)", // 3
      "\tpkg.F(1)", // 4
      "\tx.M()", // 5
      "\tr.field.M()", // 6
      "\ta.b.c.M()", // 7
      "\tNewQueue().Pop()", // 8
      "\tpkg.New().Run()", // 9
      "\t(*Queue).Pop(q)", // 10
      "\tdefer x.mu.Unlock()", // 11
      "}",
    );
    expect(await sitesOf(source, ["call"])).toEqual([
      "call helper «helper(job)»",
      "call pkg.F «pkg.F(1)»",
      "call x.M «x.M()»",
      "call r.field.M «r.field.M()»",
      "call a.b.c.M «a.b.c.M()»",
      "call NewQueue().Pop «NewQueue().Pop()»",
      "call NewQueue «NewQueue()»",
      "call pkg.New().Run «pkg.New().Run()»",
      "call pkg.New «pkg.New()»",
      "call Queue.Pop «(*Queue).Pop(q)»",
      "call x.mu.Unlock «x.mu.Unlock()»",
    ]);
  });

  it("gives exact line and column ranges (1-based, inclusive)", async () => {
    const { facts } = await extract("a.go", src("package p", "func f() {", "\tfoo(1)", "}"));
    expect(facts.sites[0]!.site).toEqual({ startLine: 3, startCol: 2, endLine: 3, endCol: 7 });
  });

  it("generic instantiation is a call of the function, with one argument or several", async () => {
    const source = src(
      "package p",
      "func f() {",
      "\tf1[int](x)",
      '\tbus.Subscribe[Event](b, "x", fn)',
      "\tMap[int, string](xs, g)",
      "\tpkg.G[T](x)",
      "}",
    );
    expect(await sitesOf(source, ["call"])).toEqual([
      "call f1 «f1[int](x)»",
      'call bus.Subscribe «bus.Subscribe[Event](b, "x", fn)»',
      "call Map «Map[int, string](xs, g)»",
      "call pkg.G «pkg.G[T](x)»",
    ]);
  });

  it("spells receivers that are calls, conversions, assertions, dereferences and composite literals", async () => {
    const source = src(
      "package p",
      "func f() {",
      "\ta.b().c()", // 3
      "\tFoo(1).Bar()", // 4
      "\tFoo{}.Bar()", // 5
      "\tpkg.Foo{}.Bar()", // 6
      "\tx.(Foo).Bar()", // 7
      "\t(&x).Baz()", // 8
      "\t(*p).Baz()", // 9
      "}",
    );
    expect(await sitesOf(source, ["call"])).toEqual([
      "call a.b().c «a.b().c()»",
      "call a.b «a.b()»",
      "call Foo().Bar «Foo(1).Bar()»",
      "call Foo «Foo(1)»",
      "call Foo().Bar «Foo{}.Bar()»",
      "call Foo «Foo{}»",
      "call pkg.Foo().Bar «pkg.Foo{}.Bar()»",
      "call pkg.Foo «pkg.Foo{}»",
      "call :Foo.Bar «x.(Foo).Bar()»",
      "call x.Baz «(&x).Baz()»",
      "call p.Baz «(*p).Baz()»",
    ]);
  });

  it("skips calls whose receiver cannot be spelled and calls of function literals", async () => {
    const source = src(
      "package p",
      "func f() {",
      "\thandlers[k].Run()", // 3
      "\t(a || b).c()", // 4
      "\tgo func() {}()", // 5
      "\tdefer func() { recover() }()", // 6
      "\tok()", // 7
      "}",
    );
    expect(await sitesOf(source, ["call"])).toEqual(["call ok «ok()»"]);
  });

  it("names of the language are not sites: builtin functions, conversions to predeclared types, predeclared types", async () => {
    const source = src(
      "package p",
      "func f(a []byte, s string) (int, error) {",
      "\tn := len(a) + cap(a)",
      "\tb := append(a, 1)",
      "\tm := make(map[string]int)",
      "\tp := new(int)",
      "\tx := float64(n) + float64(len(s))",
      "\tt := string(b)",
      "\tpanic(t)",
      "\treturn int(x), nil",
      "}",
    );
    expect(await sitesOf(source)).toEqual([]);
  });

  it("but not the ones code commonly redefines (min, max, clear) nor names the file declares itself", async () => {
    const source = src(
      "package p",
      "type any = interface{}",
      "func len(x []int) int { return 0 }",
      "func f(v any) int {",
      "\treturn max(min(1, 2), len(nil))",
      "}",
    );
    expect(await sitesOf(source)).toEqual([
      "type-ref any «any»", // `type any` is declared in this file
      "call max «max(min(1, 2), len(nil))»",
      "call min «min(1, 2)»",
      "call len «len(nil)»", // and so is `len`
    ]);
  });

  it("reports only the callee when a call spans more than 10 lines", async () => {
    const args = Array.from({ length: 12 }, (_, i) => `\t\t${i},`);
    const source = src("package p", "func f() {", "\tr.queue.Requeue(", ...args, "\t)", "}");
    expect(await sitesOf(source, ["call"])).toEqual(["call r.queue.Requeue «r.queue.Requeue»"]);
  });

  it("keeps the whole call at exactly 10 lines, drops to the callee at 11", async () => {
    const ten = src(
      "package p",
      "func f() {",
      "\trun(",
      ...Array.from({ length: 8 }, (_, i) => `\t\t${i},`),
      "\t)",
      "}",
    );
    expect(await sitesOf(ten, ["call"])).toEqual([
      "call run «run(⏎\t\t0,⏎\t\t1,⏎\t\t2,⏎\t\t3,⏎\t\t4,⏎\t\t5,⏎\t\t6,⏎\t\t7,⏎\t)»",
    ]);
    const eleven = src(
      "package p",
      "func f() {",
      "\trun(",
      ...Array.from({ length: 9 }, (_, i) => `\t\t${i},`),
      "\t)",
      "}",
    );
    expect(await sitesOf(eleven, ["call"])).toEqual(["call run «run»"]);
  });
});

describe("Go receiver normalisation", () => {
  it("the receiver variable of each method is the qualifier root `this`, whatever it is called", async () => {
    const source = src(
      "package p",
      "func (q *Queue) Pop() {", // 2
      "\tq.mu.Lock()", // 3
      "\tq.helper()", // 4
      "\tq.count++", // 5
      "\tgo func() { q.async() }()", // 6
      "}",
      "func (worker Worker) Run() {", // 8
      "\tworker.pool.Lease()", // 9
      "}",
      "func (Worker) Anon() {", // 11
      "\tq.notReceiver()", // 12
      "}",
      "func (_ Worker) Blank() {", // 14
      "\t_.x()", // 15
      "}",
    );
    expect(await sitesOf(source, ["call", "write"])).toEqual([
      "call this.mu.Lock «q.mu.Lock()»",
      "call this.helper «q.helper()»",
      "write this.count «q.count++»",
      "call this.async «q.async()»",
      "call this.pool.Lease «worker.pool.Lease()»",
      "call q.notReceiver «q.notReceiver()»",
      "call _.x «_.x()»",
    ]);
  });

  it("a local that hides the receiver name (closure parameter, :=) is not the receiver", async () => {
    const source = src(
      "package p",
      "func (a *App) Run(other *Other) {", // 2
      "\ta.own()", // 3
      "\tf := func(a *Other) { a.x(); a.y = 1 }", // 4
      "\ta.again()", // 5
      "\tif a := other.next(); a != nil {", // 6
      "\t\ta.inner()", // 7
      "\t}", // 8
      "\ta.last()", // 9
      "}",
    );
    expect(await sitesOf(source, ["call", "write"])).toEqual([
      "call this.own «a.own()»",
      "call a.x «a.x()»",
      "write a.y «a.y = 1»",
      "call this.again «a.again()»",
      "call other.next «other.next()»",
      "call a.inner «a.inner()»",
      "call this.last «a.last()»",
    ]);
  });
});

describe("Go composite literals", () => {
  it("`T{...}`, `&T{...}`, `pkg.T{...}` and generic literals are calls of the type; nested literals with a type too", async () => {
    const source = src(
      "package p",
      "func f() {",
      '\ta := Job{ID: "x"}', // 3
      "\tb := &pkg.Job{}", // 4
      "\tg := Box[int]{v: 1}", // 5
      "\th := Outer{Inner: Inner{N: 1}}", // 6
      "}",
    );
    expect(await sitesOf(source, ["call"])).toEqual([
      'call Job «Job{ID: "x"}»',
      "call pkg.Job «pkg.Job{}»",
      "call Box «Box[int]{v: 1}»",
      "call Outer «Outer{Inner: Inner{N: 1}}»",
      "call Inner «Inner{N: 1}»",
    ]);
  });

  it("literals of slice, map, array and anonymous struct types only reference their element types", async () => {
    const source = src(
      "package p",
      "func f() {",
      '\ta := []Job{{ID: "y"}}', // 3
      "\tb := map[string]*pkg.Job{}", // 4
      "\tc := [2]Job{}", // 5
      "\td := struct{ x Job }{}", // 6
      "}",
    );
    expect(await sitesOf(source)).toEqual([
      "type-ref Job «Job»",
      "type-ref pkg.Job «pkg.Job»",
      "type-ref Job «Job»",
      "type-ref Job «Job»",
    ]);
  });

  it("a literal spanning more than 10 lines is reported by its type only", async () => {
    const fields = Array.from({ length: 10 }, (_, i) => `\t\tF${i}: ${i},`);
    const source = src("package p", "func f() {", "\th := &Big{", ...fields, "\t}", "}");
    expect(await sitesOf(source, ["call"])).toEqual(["call Big «Big»"]);
  });
});

describe("Go type-ref sites", () => {
  it("parameters, results, fields, var types, receivers, type assertions, conversions and generics", async () => {
    const source = src(
      "package p",
      "type Runner struct {", // 2
      "\tqueue JobQueue", // 3
      "\tpool  *worker.Pool", // 4
      "\titems []Item", // 5
      "\tby    map[string]*Other", // 6
      "\tfn    func(Arg) Res", // 7
      "}",
      "func (r *Runner) Do(ctx context.Context, j *queue.Job) (out Result, err error) {", // 9
      "\tvar local Local", // 10
      "\tv := x.(Asserted)", // 11
      "\tp := (*Conv)(nil)", // 12
      "\tn := new(Made)", // 13
      "\t_ = Generic[Arg2]{}", // 14
      "\treturn", // 15
      "}",
      "var pkgVar pkg.Type", // 17
      "type Alias = pkg.Other2", // 18
    );
    expect(await sitesOf(source, ["type-ref"])).toEqual([
      "type-ref JobQueue «JobQueue»",
      "type-ref worker.Pool «worker.Pool»",
      "type-ref Item «Item»",
      "type-ref Other «Other»",
      "type-ref Arg «Arg»",
      "type-ref Res «Res»",
      "type-ref Runner «Runner»",
      "type-ref context.Context «context.Context»",
      "type-ref queue.Job «queue.Job»",
      "type-ref Result «Result»",
      "type-ref Local «Local»",
      "type-ref Asserted «Asserted»",
      "type-ref Conv «Conv»",
      "type-ref Made «Made»",
      "type-ref Arg2 «Arg2»",
      "type-ref pkg.Type «pkg.Type»",
      "type-ref pkg.Other2 «pkg.Other2»",
    ]);
  });

  it("not declaration names, not type parameters, not the language's own types", async () => {
    const source = src(
      "package p",
      "type Box[T any, K comparable] struct {", // 2
      "\tv    T",
      "\tkeys []K",
      "\tn    int",
      "}",
      "func (b *Box[T, K]) Get(k K) (T, error) {", // 6
      "\tvar zero T",
      "\treturn zero, nil",
      "}",
      "func Map[A, B any](xs []A, f func(A) B) []B {", // 10
      "\treturn nil",
      "}",
      "type Number interface{ ~int | ~float64 }",
      "func Sum[N Number](xs []N) N { return 0 }", // 13
    );
    expect(await sitesOf(source, ["type-ref"])).toEqual([
      "type-ref Box «Box»", // the receiver type
      "type-ref Number «Number»", // the constraint of N
    ]);
  });

  it("a type name shadowed by a type parameter refers to the parameter", async () => {
    const source = src(
      "package p",
      "type T struct{}",
      "func Use[T any](x T) T { return x }",
      "func Plain(x T) {}",
    );
    expect(await sitesOf(source, ["type-ref"])).toEqual(["type-ref T «T»"]);
  });

  it("the conversion `(*T)(x)` is a type-ref, `T(x)` is a call", async () => {
    const source = src(
      "package p",
      "var _ Iface = (*Impl)(nil)", // 2
      "var _ = (*pkg.Impl2)(nil)", // 3
      "var _ = Conv(x)", // 4
    );
    expect(await sitesOf(source)).toEqual([
      "type-ref Iface «Iface»",
      "type-ref Impl «Impl»",
      "type-ref pkg.Impl2 «pkg.Impl2»",
      "call Conv «Conv(x)»",
    ]);
  });
});

describe("Go extends sites (embedding)", () => {
  it("embedded struct fields and embedded interface elements; not fields, methods, unions or `~T`", async () => {
    const source = src(
      "package p",
      "type T struct {", // 2
      "\tBase", // 3
      "\t*Ptr", // 4
      "\tpkg.Qualified", // 5
      "\tGen[int]", // 6
      '\tsync.Mutex `json:"m"`', // 7
      "\tnamed Other", // 8
      "}",
      "type I interface {", // 10
      "\tReader", // 11
      "\tio.Writer", // 12
      "\terror", // 13
      "\tDo()", // 14
      "\tNumber", // 15
      "}",
      "type C interface{ ~int | ~string }", // 17
    );
    expect(await sitesOf(source, ["extends"])).toEqual([
      "extends Base «Base»",
      "extends Ptr «Ptr»",
      "extends pkg.Qualified «pkg.Qualified»",
      "extends Gen «Gen»",
      "extends sync.Mutex «sync.Mutex»",
      "extends Reader «Reader»",
      "extends io.Writer «io.Writer»",
      "extends error «error»",
      "extends Number «Number»",
    ]);
  });
});

describe("Go write sites", () => {
  it("assignments, compound assignments, ++/--, element writes; several targets give several sites", async () => {
    const source = src(
      "package p",
      "var counter int",
      "func (r *Runner) M() {", // 3
      "\tr.count = 1", // 4
      "\tr.total += 2", // 5
      "\tr.n++", // 6
      "\tr.m--", // 7
      "\tcounter = 3", // 8
      "\tobj.field = 4", // 9
      "\ta.b.c -= 1", // 10
      "\tx, r.y = 1, 2", // 11
      "\tarr[0] = 1", // 12
      "\tr.items[i] = 1", // 13
      "\t(r).z = 1", // 14
      "}",
    );
    expect(await sitesOf(source, ["write"])).toEqual([
      "write this.count «r.count = 1»",
      "write this.total «r.total += 2»",
      "write this.n «r.n++»",
      "write this.m «r.m--»",
      "write counter «counter = 3»",
      "write obj.field «obj.field = 4»",
      "write a.b.c «a.b.c -= 1»",
      "write x «x, r.y = 1, 2»",
      "write this.y «x, r.y = 1, 2»",
      "write arr «arr[0] = 1»",
      "write this.items «r.items[i] = 1»",
      "write this.z «(r).z = 1»",
    ]);
  });

  it("not: the blank identifier, dereferences, element fields, short declarations, locals", async () => {
    const source = src(
      "package p",
      "var shared int",
      "func f(param int) {", // 3
      "\t_ = shared", // 4
      "\t*p = 1", // 5
      "\tr.items[i].v = 1", // 6
      "\tlocal := 0", // 7
      "\tlocal = 1", // 8
      "\tlocal++", // 9
      "\tparam = 2", // 10
      "\tshared = 3", // 11
      "\tif shared := 4; shared > 0 {", // 12
      "\t\tshared = 5", // 13
      "\t}", // 14
      "\tshared = 6", // 15
      "\tfor i := 0; i < 3; i++ {", // 16
      "\t}", // 17
      "}",
    );
    expect(await sitesOf(source, ["write"])).toEqual([
      "write shared «shared = 3»",
      "write shared «shared = 6»",
    ]);
  });

  it("the swap idiom writes to the slice once", async () => {
    const source = src(
      "package p",
      "func (s *Sorter) Swap(i, j int) {",
      "\ts.items[i], s.items[j] = s.items[j], s.items[i]",
      "}",
    );
    expect(await sitesOf(source, ["write"])).toEqual([
      "write this.items «s.items[i], s.items[j] = s.items[j], s.items[i]»",
    ]);
  });

  it("reports only the target when the assignment spans more than 10 lines", async () => {
    const body = Array.from({ length: 12 }, (_, i) => `\t\t"k${i}": ${i},`);
    const source = src(
      "package p",
      "func f() {",
      "\tr.config = map[string]int{",
      ...body,
      "\t}",
      "}",
    );
    expect(await sitesOf(source, ["write"])).toEqual(["write r.config «r.config»"]);
  });

  it("bare calls of locals are not calls of same-named package functions", async () => {
    const source = src(
      "package p",
      "func run() {}",
      "func f(cb func()) {", // 3
      "\trun()", // 4
      "\tcb()", // 5
      "\trun := func() {}", // 6
      "\trun()", // 7
      "\tfn := run", // 8
      "\tfn()", // 9
      "}",
    );
    expect(await sitesOf(source, ["call"])).toEqual(["call run «run()»"]);
  });
});

describe("Go imports", () => {
  it("one binding per import spec: plain, aliased, blank, dot, single and grouped, raw strings", async () => {
    const source = src(
      "package p", // 1
      'import "errors"', // 2
      "import (", // 3
      '\t"fmt"', // 4
      '\tstr "strings"', // 5
      '\t_ "embed"', // 6
      '\t. "os"', // 7
      '\t"example.com/m/internal/queue"', // 8
      "\t`example.com/m/raw`", // 9
      ")", // 10
    );
    const { facts } = await extract("a.go", source);
    expect(
      facts.imports.map((i) => `${i.localName} <- ${i.module} «${covered(source, i.site)}»`),
    ).toEqual([
      'errors <- errors «"errors"»',
      'fmt <- fmt «"fmt"»',
      'str <- strings «str "strings"»',
      '_ <- embed «_ "embed"»',
      '. <- os «. "os"»',
      'queue <- example.com/m/internal/queue «"example.com/m/internal/queue"»',
      "raw <- example.com/m/raw «`example.com/m/raw`»",
    ]);
    // a package is a namespace: no importedName
    expect(facts.imports.every((i) => i.importedName === undefined)).toBe(true);
    // a dot import makes the package's names visible: a star export, like `from x import *`
    expect(facts.exports).toEqual([
      { name: "*", module: "os", site: { startLine: 7, startCol: 2, endLine: 7, endCol: 7 } },
    ]);
  });

  it("the assumed package name skips versions, `go-` prefixes and dots, like goimports", async () => {
    const source = src(
      "package p",
      "import (",
      '\t"gopkg.in/yaml.v3"',
      '\t"github.com/go-redis/redis/v9"',
      '\t"github.com/foo/go-bar"',
      '\t"example.com/x/mypkg-go"',
      '\t"example.com/x/api/v1"',
      '\t"example.com/x/v1alpha1"',
      ")",
    );
    const { facts } = await extract("a.go", source);
    expect(facts.imports.map((i) => `${i.localName} <- ${i.module}`)).toEqual([
      "yaml <- gopkg.in/yaml.v3",
      "redis <- github.com/go-redis/redis/v9",
      // a last element `vN` is ambiguous (a major version, or a directory called v9): both names
      "v9 <- github.com/go-redis/redis/v9",
      "bar <- github.com/foo/go-bar",
      "mypkg <- example.com/x/mypkg-go",
      "api <- example.com/x/api/v1",
      "v1 <- example.com/x/api/v1",
      "v1alpha1 <- example.com/x/v1alpha1",
    ]);
  });
});

describe("Go type facts", () => {
  it("struct fields (embedded ones under their type's name), pointers and generics stripped", async () => {
    const source = src(
      "package p",
      "type Runner struct {",
      "\tq    JobQueue",
      "\tpool *worker.Pool",
      "\t*Base",
      "\tqueue.Other",
      "\tsync.Mutex",
      "\tn      int",
      "\titems  []Job",
      "\tlogf   func(string)",
      "\tby     map[string]Job",
      "\tgen    Box[int]",
      "\ta, b   Pair",
      "\tinner  struct{ z int }",
      "}",
    );
    expect(await factsOf(source, ["field"])).toEqual([
      "field Runner::q type=JobQueue",
      "field Runner::pool type=worker.Pool",
      "field Runner::Base type=Base",
      "field Runner::Other type=queue.Other",
      "field Runner::Mutex type=sync.Mutex",
      "field Runner::n type=int",
      "field Runner::gen type=Box",
      "field Runner::a type=Pair",
      "field Runner::b type=Pair",
    ]);
  });

  it("result types: the first result unless it is `error`; slices, funcs and type parameters say nothing", async () => {
    const source = src(
      "package p",
      "func New() (*Runner, error) { return nil, nil }",
      "func Load() (Config, error) { return Config{}, nil }",
      "func Err() error { return nil }",
      "func Names() ([]string, error) { return nil, nil }",
      "func Generic[T any]() T { var z T; return z }",
      'func Both() (int, string) { return 0, "" }',
      "func Ptr() *pkg.Thing { return nil }",
      "func Fn() func() int { return nil }",
      "func Multi() (a, b Thing) { return }",
      "func None() {}",
      "func (r *Runner) Run() (res Result, err error) { return }",
      "type Iface interface {",
      "\tGet() (*Item, error)",
      "\tName() string",
      "\tNothing()",
      "}",
    );
    expect(await factsOf(source, ["return"])).toEqual([
      "return New::New type=Runner",
      "return Load::Load type=Config",
      "return Both::Both type=int",
      "return Ptr::Ptr type=pkg.Thing",
      "return Multi::Multi type=Thing",
      "return Runner.Run::Run type=Result",
      "return Iface.Get::Get type=Item",
      "return Iface.Name::Name type=string",
    ]);
  });

  it("parameters and named results, scoped to the function body; variadic and type-parameter ones only shadow", async () => {
    const source = src(
      "package p",
      "func (r *Runner) Run(ctx context.Context, job *queue.Job, n int, rest ...string) (res Result, err error) {", // 2
      "\treturn",
      "}",
      "func Map[A any](x A, f func(A) A) {}", // 5
    );
    const { facts } = await extract("a.go", source);
    const params = facts.typeFacts.filter((f) => f.kind === "param");
    expect(params.map(fact)).toEqual([
      "param Runner.Run::ctx type=context.Context",
      "param Runner.Run::job type=queue.Job",
      "param Runner.Run::n type=int",
      "param Runner.Run::rest",
      "param Runner.Run::res type=Result",
      "param Runner.Run::err type=error",
      "param Map::x", // its type is a type parameter: it only shadows
      "param Map::f", // a function type
    ]);
    // in scope in the body (line 2 col 108 is the opening brace), not in the signature
    const body = params[0]!.visibleIn!;
    expect(body.startLine).toBe(2);
    expect(body.endLine).toBe(4);
    expect(source.split("\n")[1]!.slice(body.startCol - 1, body.startCol)).toBe("{");
    expect(
      params.slice(0, 6).every((p) => p.visibleIn && p.visibleIn.startCol === body.startCol),
    ).toBe(true);
    // parameters of function declarations without a body have no scope, and none at all in function types
    const { facts: noBody } = await extract(
      "b.go",
      src(
        "package p",
        "func ext(a int)",
        "type F func(x int) string",
        "type I interface{ M(y int) }",
      ),
    );
    expect(noBody.typeFacts.filter((f) => f.kind === "param")).toEqual([]);
  });

  it("locals: what `:=`, `var`, `new`, conversions and assertions evidently give", async () => {
    const source = src(
      "package p",
      "func (r *Runner) Run(job *Job) {", // 2
      "\tq := NewQueue()", // 3
      "\tw, err := r.pool.Lease(ctx)", // 4
      "\tx := &Job{}", // 5
      "\ty := Job{}", // 6
      "\tz := new(Queue)", // 7
      "\tc := queue.Config(x)", // 8
      "\td := (*Queue)(nil)", // 9
      "\tv, ok := any(x).(Foo)", // 10
      "\talias := r.q", // 11
      "\tlocal := job", // 12
      "\tself := r", // 13
      "\tvar declared *worker.Worker", // 14
      "\tvar inferred = queue.New()", // 15
      "\tvar a, b = f(), g()", // 16
      "\ttuple, second := f2()", // 17
      "\tunknown := x + 1", // 18
      "}",
    );
    expect(await factsOf(source, ["local"])).toEqual([
      "local Runner.Run::q init=NewQueue()",
      "local Runner.Run::w init=this.pool.Lease()",
      "local Runner.Run::err",
      "local Runner.Run::x type=Job",
      "local Runner.Run::y type=Job",
      "local Runner.Run::z type=Queue",
      "local Runner.Run::c init=queue.Config()",
      "local Runner.Run::d type=Queue",
      "local Runner.Run::v type=Foo",
      "local Runner.Run::ok",
      "local Runner.Run::alias chain=this.q",
      "local Runner.Run::local chain=job",
      "local Runner.Run::self chain=this",
      "local Runner.Run::declared type=worker.Worker",
      "local Runner.Run::inferred init=queue.New()",
      "local Runner.Run::a init=f()",
      "local Runner.Run::b init=g()",
      "local Runner.Run::tuple init=f2()",
      "local Runner.Run::second",
      "local Runner.Run::unknown",
    ]);
  });

  it('package-level variables: scope "", no visibleIn', async () => {
    const source = src(
      "package p",
      "var pkgQueue = queue.New()",
      "var typed *queue.Queue",
      "var multi, other = NewA(), NewB()",
      "var _ = ignored()",
      "var (",
      "\tgrouped Thing",
      ")",
    );
    const { facts } = await extract("a.go", source);
    expect(facts.typeFacts.map(fact)).toEqual([
      "local ::pkgQueue init=queue.New()",
      "local ::typed type=queue.Queue",
      "local ::multi init=NewA()",
      "local ::other init=NewB()",
      "local ::grouped type=Thing",
    ]);
    expect(facts.typeFacts.every((f) => f.visibleIn === undefined)).toBe(true);
  });

  it("locals are scoped like Go scopes them: from the end of the declaration to the end of the block, statement or clause", async () => {
    const source = src(
      "package p",
      "func f() {", // 2
      "\tx := 1", // 3
      "\tif y := g(); y > 0 {", // 4
      "\t\tz := 2", // 5
      "\t\t_ = z", // 6
      "\t}", // 7
      "\tfor i := 0; i < 3; i++ {", // 8
      "\t}", // 9
      "\tfor _, item := range xs {", // 10
      "\t}", // 11
      "\tswitch v := any(x).(type) {", // 12
      "\tcase *A:", // 13
      "\t\t_ = v", // 14
      "\tcase B, C:", // 15
      "\tdefault:", // 16
      "\t}", // 17
      "}", // 18
    );
    const { facts } = await extract("a.go", source);
    /** The text each scope of `name` covers. */
    const scope = (name: string): string[] =>
      facts.typeFacts
        .filter((f) => f.name === name && f.visibleIn)
        .map((f) => covered(source, f.visibleIn!) + (f.typeName ? ` <${f.typeName}>` : ""));
    // after `x := 1` (the scope starts where the declaration ends), to the end of the function body
    expect(scope("x")).toEqual([
      [
        "",
        "\tif y := g(); y > 0 {",
        "\t\tz := 2",
        "\t\t_ = z",
        "\t}",
        "\tfor i := 0; i < 3; i++ {",
        "\t}",
        "\tfor _, item := range xs {",
        "\t}",
        "\tswitch v := any(x).(type) {",
        "\tcase *A:",
        "\t\t_ = v",
        "\tcase B, C:",
        "\tdefault:",
        "\t}",
        "}",
      ].join("⏎"),
    ]);
    // the whole if statement: condition, block and any else
    expect(scope("y")).toEqual(["; y > 0 {⏎\t\tz := 2⏎\t\t_ = z⏎\t}"]);
    // to the end of the block it is declared in
    expect(scope("z")).toEqual(["⏎\t\t_ = z⏎\t}"]);
    // the for statement
    expect(scope("i")).toEqual(["; i < 3; i++ {⏎\t}"]);
    // the body of a range loop: the range expression itself is outside the scope
    expect(scope("item")).toEqual(["{⏎\t}"]);
    // one fact per clause; a single-type clause types the variable
    expect(scope("v")).toEqual(["case *A:⏎\t\t_ = v <A>", "case B, C:", "default:"]);
  });

  it("`:=` that assigns an existing variable of the same scope declares nothing new", async () => {
    const source = src(
      "package p",
      "func f() (err error) {", // 2
      "\ta, err := g()", // 3
      "\tb, err := h()", // 4
      "\tif c, err := k(); err != nil {", // 5
      "\t}", // 6
      "\t_, _, _ = a, b, err", // 7
      "\treturn", // 8
      "}",
    );
    const { facts } = await extract("a.go", source);
    const errs = facts.typeFacts.filter((f) => f.name === "err");
    // the named result, and the `err` of the if statement (a new variable in a new scope)
    expect(errs.map((f) => `${f.kind} ${f.visibleIn!.startLine}`)).toEqual(["param 2", "local 5"]);
  });
});

describe("Go extraction never throws", () => {
  it("survives garbage, truncated files and unusual syntax", async () => {
    for (const source of [
      "func",
      "package",
      "package p\nfunc f( {",
      "package p\ntype T struct {\n",
      "package p\nvar x = \n",
      "package p\nfunc f() { x := ; y.() }",
      "package p\nimport (\n",
      "}}}}",
      "package p\nfunc f() { for range { } }",
    ]) {
      const { facts } = await extract("a.go", source);
      expect(Array.isArray(facts.symbols)).toBe(true);
    }
  });
});
