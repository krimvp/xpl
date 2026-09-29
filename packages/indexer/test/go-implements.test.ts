/**
 * Implicit interface satisfaction: `LanguagePack.inferRefs` of the Go pack. A named type T implements an
 * interface I when T's method set (methods on T or *T in any file of its package, plus promoted ones) has every
 * method name of I.
 */
import { describe, expect, it } from "vitest";
import type { Reference, SymbolIndex } from "@xpl/core";
import { buildIndex } from "../src/index.js";
import type { PreciseResolver } from "../src/index.js";
import { indexFiles, makeDir } from "./helpers.js";

const src = (...lines: string[]): string => lines.join("\n") + "\n";
const GO_MOD = "module example.com/app\n\ngo 1.22\n";

/** `T -> I` of every `implements` ref, sorted. */
function implementsOf(index: SymbolIndex): string[] {
  return index.refs
    .filter((r) => r.kind === "implements")
    .map((r) => `${r.from} -> ${r.to}`)
    .sort();
}

describe("implicit interfaces: the basic rule", () => {
  it("a type implements an interface when its method set has every method name, on T or *T", async () => {
    const { index } = await indexFiles({
      "a.go": src(
        "package p",
        "type Reader interface{ Read() string }",
        "type ReadWriter interface {",
        "\tRead() string",
        "\tWrite(s string)",
        "}",
        "type File struct{}",
        'func (f *File) Read() string { return "" }', // pointer receiver
        "func (f File) Write(s string) {}", // value receiver
        "type Half struct{}",
        'func (Half) Read() string { return "" }',
        "type None struct{}",
      ),
    });
    expect(implementsOf(index)).toEqual([
      "a.go#File -> a.go#ReadWriter",
      "a.go#File -> a.go#Reader",
      "a.go#Half -> a.go#Reader",
    ]);
  });

  it("methods in other files of the package count; so do types and interfaces of other packages", async () => {
    const { index } = await indexFiles({
      "go.mod": GO_MOD,
      "runner/runner.go": src(
        "package runner",
        'import "example.com/app/queue"',
        "type JobQueue interface {",
        "\tPop() (*queue.Job, error)",
        "\tAck(job *queue.Job) error",
        "}",
      ),
      "queue/queue.go": src(
        "package queue",
        "type Job struct{}",
        "type Queue struct{}",
        "func (q *Queue) Pop() (*Job, error) { return nil, nil }",
      ),
      "queue/ack.go": src("package queue", "func (q *Queue) Ack(job *Job) error { return nil }"),
      "queue/other.go": src(
        "package queue",
        "type Partial struct{}",
        "func (p *Partial) Pop() (*Job, error) { return nil, nil }",
      ),
    });
    expect(implementsOf(index)).toEqual(["queue/queue.go#Queue -> runner/runner.go#JobQueue"]);
  });

  it("the ref runs from the type's symbol to the interface's symbol; its site is the type's declaration name", async () => {
    const source = src(
      "package p",
      "",
      "// Stringer is implemented by Named.",
      "type Stringer interface{ String() string }",
      "",
      "// Named is documented.",
      "type Named struct{ name string }",
      "",
      "func (n Named) String() string { return n.name }",
      "",
      "type (",
      "\tGrouped int",
      ")",
      'func (g Grouped) String() string { return "" }',
    );
    const { index } = await indexFiles({ "a.go": source });
    const refs = index.refs.filter((r) => r.kind === "implements");
    // in source order (the index sorts references by file and site)
    expect(refs.map((r) => `${r.from} -> ${r.to}`)).toEqual([
      "a.go#Named -> a.go#Stringer",
      "a.go#Grouped -> a.go#Stringer",
    ]);
    const lines = source.split("\n");
    for (const ref of refs) {
      expect(ref.resolution).toBe("heuristic");
      expect(ref.site.startLine).toBe(ref.site.endLine);
      const name = lines[ref.site.startLine - 1]!.slice(ref.site.startCol! - 1, ref.site.endCol!);
      expect(name).toBe(ref.from.split("#")[1]);
      // the site lies inside the implementing type's symbol
      const from = index.symbols.find((s) => s.id === ref.from)!;
      expect(ref.site.startLine).toBeGreaterThanOrEqual(from.range.startLine);
      expect(ref.site.endLine).toBeLessThanOrEqual(from.range.endLine);
    }
    expect(refs[0]!.site).toEqual({ startLine: 7, startCol: 6, endLine: 7, endCol: 10 });
    expect(refs[1]!.site).toEqual({ startLine: 12, startCol: 2, endLine: 12, endCol: 8 });
  });

  it("works for every kind of named type: structs, function types, basic types", async () => {
    const { index } = await indexFiles({
      "a.go": src(
        "package p",
        "type Doer interface{ Do() }",
        "type S struct{}",
        "func (S) Do() {}",
        "type F func()",
        "func (F) Do() {}",
        "type N int",
        "func (N) Do() {}",
        "type Alias = S",
      ),
    });
    expect(implementsOf(index)).toEqual([
      "a.go#F -> a.go#Doer",
      "a.go#N -> a.go#Doer",
      "a.go#S -> a.go#Doer",
    ]);
  });

  it("interfaces do not implement interfaces; empty interfaces and type-set-only interfaces are skipped", async () => {
    const { index } = await indexFiles({
      "a.go": src(
        "package p",
        "type Empty interface{}",
        "type Any interface{ any }",
        "type Number interface{ ~int | ~float64 }",
        "type Small interface{ M() }",
        "type Big interface {",
        "\tM()",
        "\tN()",
        "}",
        "type T struct{}",
        "func (T) M() {}",
        "func (T) N() {}",
      ),
    });
    // T implements Small and Big; Big has all methods of Small but that is no `implements` between interfaces
    expect(implementsOf(index)).toEqual(["a.go#T -> a.go#Big", "a.go#T -> a.go#Small"]);
  });

  it("a method matches by name and by a coarse signature: counts and shapes of parameters and results", async () => {
    const { index } = await indexFiles({
      "go.mod": GO_MOD,
      "a/a.go": src(
        "package a",
        'import "context"',
        "type Getter interface {",
        "	Get(ctx context.Context, key string, opts ...Option) (*Item, error)",
        "}",
        "type Option func()",
        "type Item struct{}",
      ),
      "b/b.go": src(
        "package b",
        'import (\n\t"context"\n\t"example.com/app/a"\n)',
        // the same signature, spelled with other names and package qualifiers
        "type Cache struct{}",
        "func (Cache) Get(c context.Context, id string, o ...a.Option) (*a.Item, error) { return nil, nil }",
        // different parameter count
        "type Short struct{}",
        "func (Short) Get(key string) (*a.Item, error) { return nil, nil }",
        // different result count
        "type Single struct{}",
        "func (Single) Get(ctx context.Context, key string, opts ...a.Option) error { return nil }",
        // a parameter of another type
        "type Numeric struct{}",
        "func (Numeric) Get(ctx context.Context, key int, opts ...a.Option) (*a.Item, error) { return nil, nil }",
        // a value where the interface has a pointer
        "type ByValue struct{}",
        "func (ByValue) Get(ctx context.Context, key string, opts ...a.Option) (a.Item, error) { return a.Item{}, nil }",
        // a slice where the interface has a variadic
        "type Sliced struct{}",
        "func (Sliced) Get(ctx context.Context, key string, opts []a.Option) (*a.Item, error) { return nil, nil }",
      ),
    });
    expect(implementsOf(index)).toEqual(["b/b.go#Cache -> a/a.go#Getter"]);
  });

  it("type parameters and local aliases match anything; so does a method whose signature is not known", async () => {
    const { index } = await indexFiles({
      "a.go": src(
        "package p",
        "type ID = string",
        "type Repo[T any] interface {",
        "	Find(id string) (T, error)",
        "	Save(v T) error",
        "}",
        "type UserRepo struct{}",
        "func (UserRepo) Find(id string) (*User, error) { return nil, nil }",
        "func (UserRepo) Save(v *User) error { return nil }",
        "type User struct{}",
        "type Lookup interface{ Get(id string) int }",
        "type ByAlias struct{}",
        "func (ByAlias) Get(id ID) int { return 0 }",
        "type Wrong struct{}",
        "func (Wrong) Get(id float64) int { return 0 }",
      ),
    });
    expect(implementsOf(index)).toEqual([
      "a.go#ByAlias -> a.go#Lookup",
      "a.go#UserRepo -> a.go#Repo",
    ]);
  });

  it("promoted methods keep their signatures; `error` needs `Error() string`", async () => {
    const { index } = await indexFiles({
      "a.go": src(
        "package p",
        "type Namer interface{ Name() string }",
        "type Base struct{}",
        'func (Base) Name() string { return "" }',
        "type Good struct{ Base }",
        "type Other struct{}",
        "func (Other) Name() int { return 0 }",
        "type Bad struct{ Other }",
        "type Coded interface {",
        "\terror",
        "\tCode() int",
        "}",
        "type RealErr struct{}",
        'func (RealErr) Error() string { return "" }',
        "func (RealErr) Code() int { return 1 }",
        "type FakeErr struct{}",
        "func (FakeErr) Error() int { return 0 }",
        "func (FakeErr) Code() int { return 1 }",
      ),
    });
    expect(implementsOf(index)).toEqual([
      "a.go#Base -> a.go#Namer",
      "a.go#Good -> a.go#Namer",
      "a.go#RealErr -> a.go#Coded",
    ]);
  });

  it("fields are not methods", async () => {
    const { index } = await indexFiles({
      "a.go": src("package p", "type Runner interface{ Run() }", "type Fake struct{ Run func() }"),
    });
    expect(implementsOf(index)).toEqual([]);
  });
});

describe("implicit interfaces: embedding", () => {
  it("embedded interfaces are flattened when they can be resolved, in the same file, another file or another package", async () => {
    const { index } = await indexFiles({
      "go.mod": GO_MOD,
      "base/base.go": src("package base", "type Reader interface{ Read() }"),
      "top/top.go": src(
        "package top",
        'import "example.com/app/base"',
        "type Writer interface{ Write() }",
        "type ReadWriter interface {",
        "\tbase.Reader",
        "\tWriter",
        "}",
        "type Both struct{}",
        "func (Both) Read() {}",
        "func (Both) Write() {}",
        "type OnlyRead struct{}",
        "func (OnlyRead) Read() {}",
      ),
    });
    expect(implementsOf(index)).toEqual([
      "top/top.go#Both -> base/base.go#Reader",
      "top/top.go#Both -> top/top.go#ReadWriter",
      "top/top.go#Both -> top/top.go#Writer",
      "top/top.go#OnlyRead -> base/base.go#Reader",
    ]);
  });

  it("an interface with an embedded element that cannot be resolved has an unknown method set and is skipped; `error` is known", async () => {
    const { index } = await indexFiles({
      "a.go": src(
        "package p",
        'import "io"',
        "type ReadCloser interface {",
        "\tio.Reader",
        "\tClose() error",
        "}",
        "type Coded interface {",
        "\terror",
        "\tCode() int",
        "}",
        "type File struct{}",
        "func (File) Read() {}",
        "func (File) Close() error { return nil }",
        "type Err struct{}",
        'func (Err) Error() string { return "" }',
        "func (Err) Code() int { return 1 }",
        "type Plain struct{}",
        "func (Plain) Code() int { return 1 }",
      ),
    });
    expect(implementsOf(index)).toEqual(["a.go#Err -> a.go#Coded"]);
  });

  it("constraint interfaces (type sets), also when embedded, are not implemented", async () => {
    const { index } = await indexFiles({
      "a.go": src(
        "package p",
        "type Stringish interface {",
        "\t~string",
        "\tString() string",
        "}",
        "type Number interface{ ~int | ~float64 }",
        "type Both interface {",
        "\tNumber",
        "\tString() string",
        "}",
        "type Plain interface{ String() string }",
        "type S string",
        'func (S) String() string { return string("") }',
      ),
    });
    expect(implementsOf(index)).toEqual(["a.go#S -> a.go#Plain"]);
  });

  it("a struct promotes the methods of its embedded fields: pointers, other files, other packages, embedded interfaces", async () => {
    const { index } = await indexFiles({
      "go.mod": GO_MOD,
      "q/q.go": src("package q", "type Queue struct{}", "func (q *Queue) Pop() {}"),
      "app/app.go": src(
        "package app",
        'import "example.com/app/q"',
        "type JobQueue interface {",
        "\tPop()",
        "\tAck()",
        "}",
        "type Recording struct {",
        "\t*q.Queue",
        "}",
        "func (r *Recording) Ack() {}",
        "type Wrapper struct{ JobQueue }",
        "type Deep struct{ Recording }",
        "type Loose struct{ *q.Queue }",
      ),
    });
    expect(implementsOf(index)).toEqual([
      "app/app.go#Deep -> app/app.go#JobQueue",
      "app/app.go#Recording -> app/app.go#JobQueue",
      "app/app.go#Wrapper -> app/app.go#JobQueue",
    ]);
  });

  it("embedding cycles do not hang or produce edges", async () => {
    const { index } = await indexFiles({
      "a.go": src(
        "package p",
        "type A struct{ *B }",
        "type B struct{ *A }",
        "type Loop interface{ Loop }",
        "type Self struct{ *Self }",
        "func (Self) M() {}",
        "type I interface{ M() }",
      ),
    });
    expect(implementsOf(index)).toEqual(["a.go#Self -> a.go#I"]);
  });
});

describe("implicit interfaces: scope of method names", () => {
  it("an unexported method can only be satisfied inside its own package", async () => {
    const { index } = await indexFiles({
      "go.mod": GO_MOD,
      "a/a.go": src(
        "package a",
        "type Sealed interface{ seal() }",
        "type Mine struct{}",
        "func (Mine) seal() {}",
      ),
      "b/b.go": src("package b", "type Theirs struct{}", "func (Theirs) seal() {}"),
    });
    expect(implementsOf(index)).toEqual(["a/a.go#Mine -> a/a.go#Sealed"]);
  });

  it("types and interfaces of test files take part", async () => {
    const { index } = await indexFiles({
      "go.mod": GO_MOD,
      "p/p.go": src("package p", "type Doer interface{ Do() }"),
      "p/p_test.go": src("package p", "type fake struct{}", "func (fake) Do() {}"),
    });
    expect(implementsOf(index)).toEqual(["p/p_test.go#fake -> p/p.go#Doer"]);
  });
});

describe("implicit interfaces: the framework hook", () => {
  const files = {
    "a.go": src(
      "package p",
      "type Doer interface{ Do() }",
      "type A struct{}",
      "func (A) Do() {}",
      "type B struct{}",
      "func (B) Do() {}",
    ),
    "b.go": src("package p", "type C struct{}", "func (C) Do() {}"),
  };

  it("is deterministic: the same repository gives byte-identical references, sorted", async () => {
    const dir = makeDir(files);
    const first = await buildIndex({ root: dir, precise: "off", commit: "x" });
    const second = await buildIndex({ root: dir, precise: "off", commit: "x" });
    expect(JSON.stringify(second.index.refs)).toBe(JSON.stringify(first.index.refs));
    const implemented = first.index.refs.filter((r) => r.kind === "implements");
    expect(implemented.map((r) => r.from)).toEqual(["a.go#A", "a.go#B", "b.go#C"]);
    const keys = first.index.refs.map(
      (r) => `${r.from.split("#")[0]}:${r.site.startLine}:${r.site.startCol}`,
    );
    expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b, "en", { numeric: true })));
  });

  it("the inferred refs are heuristic refs: a precise resolver for Go replaces them", async () => {
    const dir = makeDir(files);
    const precise: Reference = {
      from: "a.go#A",
      to: "a.go#Doer",
      kind: "implements",
      site: { startLine: 3, endLine: 3 },
      resolution: "precise",
    };
    const fake: PreciseResolver = {
      id: "fake-go",
      languages: ["go"],
      resolve: async () => ({ refs: [precise], tool: "fake-go@1" }),
    };
    const { index } = await buildIndex({ root: dir, resolvers: [fake], commit: "x" });
    expect(index.refs).toEqual([precise]);
    expect(index.languages.go).toMatchObject({ refs: "precise", tool: "fake-go@1" });
  });

  it("does not touch other languages", async () => {
    const { index } = await indexFiles({
      ...files,
      "x.ts": "export interface Doer { do(): void }\nexport class A { do() {} }\n",
    });
    expect(
      index.refs
        .filter((r) => r.kind === "implements")
        .every((r) => r.from.endsWith(".go") || r.from.includes(".go#")),
    ).toBe(true);
    expect(index.refs.some((r) => r.from.startsWith("x.ts"))).toBe(false);
  });
});
