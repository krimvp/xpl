import { describe, expect, it } from "vitest";
import { hashText, sliceLines, splitLines } from "@xpl/core";
import { extract, indexFiles, symbol, symbolLines } from "./helpers.js";

const src = (...lines: string[]): string => lines.join("\n") + "\n";

async function symbolsOf(source: string, file = "a.go"): Promise<string[]> {
  const { index } = await indexFiles({ [file]: source });
  return symbolLines(index, file);
}

describe("Go symbols: kinds and paths (ARCHITECTURE.md §3 table)", () => {
  it("covers funcs, methods, types, fields, interface methods, var and const specs", async () => {
    const source = src(
      "package sample", // 1
      "", // 2
      'import "fmt"', // 3
      "", // 4
      "// Version is documented.", // 5
      'const Version = "1"', // 6
      "", // 7
      "const (", // 8
      "\t// A is first.", // 9
      "\tA Kind = iota", // 10
      "\tB", // 11
      "\tC, D = 3, 4", // 12
      ")", // 13
      "", // 14
      "var (", // 15
      "\t// ErrOne is an error.", // 16
      '\tErrOne = fmt.Errorf("one")', // 17
      "\tx, y   int", // 18
      ")", // 19
      "", // 20
      "var single = 1", // 21
      "", // 22
      "// Kind is a kind.", // 23
      "type Kind int", // 24
      "", // 25
      "// Runner runs.", // 26
      "type Runner struct {", // 27
      "\tname  string", // 28
      "\tqueue Queue", // 29
      "\t*Base", // 30
      "\ta, b  int", // 31
      "\topts  struct{ retries int }", // 32
      "}", // 33
      "", // 34
      "// Queue is an interface.", // 35
      "type Queue interface {", // 36
      "\tPop() (*Job, error)", // 37
      "\tLen() int", // 38
      "\tfmt.Stringer", // 39
      "}", // 40
      "", // 41
      "type (", // 42
      "\tID    string", // 43
      "\tAlias = Runner", // 44
      "\tSet[T comparable] map[T]struct{}", // 45
      ")", // 46
      "", // 47
      "// New creates a runner.", // 48
      "func New(name string) *Runner {", // 49
      "\treturn &Runner{name: name}", // 50
      "}", // 51
      "", // 52
      "// Run runs.", // 53
      "func (r *Runner) Run() {}", // 54
      "", // 55
      "func (r Runner) Name() string { return r.name }", // 56
      "func (Runner) Anon()          {}", // 57
      "func (_ *Runner) Blank()      {}", // 58
    );
    expect(await symbolsOf(source)).toEqual([
      "variable Version 6-6",
      "variable A 10-10",
      "variable B 11-11",
      "variable C 12-12",
      "variable D 12-12",
      "variable ErrOne 17-17",
      "variable x 18-18",
      "variable y 18-18",
      "variable single 21-21",
      "type Kind 24-24",
      "class Runner 27-33",
      "variable Runner.name 28-28",
      "variable Runner.queue 29-29",
      "variable Runner.a 31-31",
      "variable Runner.b 31-31",
      "variable Runner.opts 32-32",
      "variable Runner.opts.retries 32-32",
      "interface Queue 36-40",
      "method Queue.Pop 37-37",
      "method Queue.Len 38-38",
      "type ID 43-43",
      "type Alias 44-44",
      "type Set 45-45",
      "function New 49-51",
      "method Runner.Run 54-54",
      "method Runner.Name 56-56",
      "method Runner.Anon 57-57",
      "method Runner.Blank 58-58",
    ]);
  });

  it("struct -> class, interface -> interface, everything else (aliases, func and map types) -> type", async () => {
    const source = src(
      "package p",
      "type S struct{}",
      "type I interface{}",
      "type F func(int) string",
      "type M map[string]int",
      "type A = S",
      "type L []S",
      "type Q = struct{ x int }",
    );
    const { index } = await indexFiles({ "a.go": source });
    const kinds = Object.fromEntries(
      index.symbols.filter((s) => !s.path.includes(".")).map((s) => [s.path, s.kind]),
    );
    expect(kinds).toEqual({
      S: "class",
      I: "interface",
      F: "type",
      M: "type",
      A: "type",
      L: "type",
      Q: "class",
    });
  });

  it("methods: pointer and value receivers, unnamed and blank receivers, type parameters stripped", async () => {
    const source = src(
      "package p",
      "type Queue[T any] struct{}",
      "func (q *Queue[T]) Pop() T { var zero T; return zero }",
      "func (q Queue[T]) Len() int { return 0 }",
      "func (Queue[_]) Anon() {}",
      "func (_ *Queue[T]) Blank() {}",
      "type Pair[K comparable, V any] struct{}",
      "func (p *Pair[K, V]) Key() K { var k K; return k }",
    );
    expect(await symbolsOf(source)).toEqual([
      "class Queue 2-2",
      "method Queue.Pop 3-3",
      "method Queue.Len 4-4",
      "method Queue.Anon 5-5",
      "method Queue.Blank 6-6",
      "class Pair 7-7",
      "method Pair.Key 8-8",
    ]);
  });

  it("grouped const and var blocks give one symbol per name, spec by spec; the blank identifier declares nothing", async () => {
    const source = src(
      "package p",
      "const (", // 2
      "\tA = iota", // 3
      "\tB", // 4
      "\t_", // 5
      "\tC", // 6
      ")", // 7
      "const X, Y = 1, 2", // 8
      "var _ = check()", // 9
      "var (", // 10
      "\tone, two = 1, 2", // 11
      "\t_ int", // 12
      ")", // 13
    );
    expect(await symbolsOf(source)).toEqual([
      "variable A 3-3",
      "variable B 4-4",
      "variable C 6-6",
      "variable X 8-8",
      "variable Y 8-8",
      "variable one 11-11",
      "variable two 11-11",
    ]);
  });

  it("a plain (ungrouped) var or const declaration spans its whole statement", async () => {
    const source = src(
      "package p",
      "var big = map[string]int{", // 2
      '\t"a": 1,', // 3
      "}", // 4
      "const c = 1", // 5
    );
    expect(await symbolsOf(source)).toEqual(["variable big 2-4", "variable c 5-5"]);
  });

  it("struct fields: `Type.field`, several names per declaration, nested anonymous structs, embedded fields are no symbols", async () => {
    const source = src(
      "package p",
      "type T struct {", // 2
      "\tsync.Mutex", // 3
      "\t*Base", // 4
      "\tname, alias string", // 5
      "\tinner struct {", // 6
      "\t\ta int", // 7
      "\t\tdeep struct{ z int }", // 8
      "\t}", // 9
      "\tfn func(x int) (y string)", // 10
      '\ttagged int `json:"t"`', // 11
      "\t_ int", // 12
      "}", // 13
    );
    expect(await symbolsOf(source)).toEqual([
      "class T 2-13",
      "variable T.name 5-5",
      "variable T.alias 5-5",
      "variable T.inner 6-9",
      "variable T.inner.a 7-7",
      "variable T.inner.deep 8-8",
      "variable T.inner.deep.z 8-8",
      "variable T.fn 10-10",
      "variable T.tagged 11-11",
    ]);
  });

  it("interface methods are `Iface.Method`; embedded interfaces and type sets are no symbols", async () => {
    const source = src(
      "package p",
      "type I interface {", // 2
      "\tio.Reader", // 3
      "\tError() string", // 4
      "\tDo(ctx context.Context, n int) (out []byte, err error)", // 5
      "}", // 6
      "type Number interface{ ~int | ~float64 }", // 7
    );
    expect(await symbolsOf(source)).toEqual([
      "interface I 2-6",
      "method I.Error 4-4",
      "method I.Do 5-5",
      "interface Number 7-7",
    ]);
  });

  it("duplicate names get ~2, ~3 in source order (init functions)", async () => {
    const source = src(
      "package p",
      "func init() {}",
      "func init() {}",
      "func _() {}",
      "func init() {}",
    );
    const { index } = await indexFiles({ "a.go": source });
    expect(index.symbols.map((s) => s.id)).toEqual(["a.go#init", "a.go#init~2", "a.go#init~3"]);
  });

  it("no symbols for local types, closures or imports", async () => {
    const source = src(
      "package p",
      'import "fmt"',
      "func f() {",
      "\ttype local struct{ x int }",
      "\tg := func() { fmt.Println() }",
      "\tg()",
      "}",
    );
    expect(await symbolsOf(source)).toEqual(["function f 3-7"]);
  });
});

describe("Go symbols: parents", () => {
  it("a method is a child of its receiver type only when the type is declared in the same file", async () => {
    const { index } = await indexFiles({
      "q/queue.go": src(
        "package q",
        "type Queue struct{ n int }",
        "func (q *Queue) Len() int { return q.n }",
      ),
      "q/extra.go": src(
        "package q",
        "func (q *Queue) Reset() {}",
        "func (q Queue) Empty() bool { return true }",
      ),
    });
    expect(symbol(index, "q/queue.go", "Queue.Len")!.parent).toBe("q/queue.go#Queue");
    // the receiver type lives in another file: the path is the same, the method is top-level in its file
    expect(symbol(index, "q/extra.go", "Queue.Reset")).toMatchObject({
      id: "q/extra.go#Queue.Reset",
      kind: "method",
    });
    expect(symbol(index, "q/extra.go", "Queue.Reset")!.parent).toBeUndefined();
    expect(symbol(index, "q/extra.go", "Queue.Empty")!.parent).toBeUndefined();
  });

  it("fields and interface methods are children of their type; nested struct fields of the nested field", async () => {
    const { index } = await indexFiles({
      "a.go": src(
        "package p",
        "type T struct {",
        "\tf int",
        "\tin struct{ g int }",
        "}",
        "type I interface{ M() }",
      ),
    });
    expect(symbol(index, "a.go", "T")!.parent).toBeUndefined();
    expect(symbol(index, "a.go", "T.f")!.parent).toBe("a.go#T");
    expect(symbol(index, "a.go", "T.in")!.parent).toBe("a.go#T");
    expect(symbol(index, "a.go", "T.in.g")!.parent).toBe("a.go#T.in");
    expect(symbol(index, "a.go", "I.M")!.parent).toBe("a.go#I");
  });
});

describe("Go symbols: ranges", () => {
  it("exclude doc comments (line and block), directives and blank lines before the declaration", async () => {
    const source = src(
      "package p", // 1
      "", // 2
      "// Old is deprecated.", // 3
      "//", // 4
      "// Deprecated: use New.", // 5
      "//go:noinline", // 6
      "func Old() {}", // 7
      "", // 8
      "/*", // 9
      " * Block doc.", // 10
      " */", // 11
      "type T struct{}", // 12
      "", // 13
      "// M does it.", // 14
      "func (T) M() {", // 15
      "\t// inner comment", // 16
      "}", // 17
      "", // 18
      "// V is a variable.", // 19
      "var V = 1 // trailing", // 20
    );
    expect(await symbolsOf(source)).toEqual([
      "function Old 7-7",
      "class T 12-12",
      "method T.M 15-17",
      "variable V 20-20",
    ]);
  });

  it("start at the func keyword and end at the closing brace, multi-line signatures included", async () => {
    const source = src(
      "package p",
      "func Long(", // 2
      "\ta int,", // 3
      "\tb string,", // 4
      ") (", // 5
      "\tint,", // 6
      "\terror,", // 7
      ") {", // 8
      "\treturn 0, nil", // 9
      "}", // 10
    );
    expect(await symbolsOf(source)).toEqual(["function Long 2-10"]);
  });

  it("every symbol hash is the hash of its own lines", async () => {
    const source = src(
      "package p",
      "// doc",
      "type T struct {",
      "\tx int",
      "}",
      "",
      "func (t T) Get() int {",
      "\treturn t.x",
      "}",
    );
    const { index } = await indexFiles({ "a.go": source });
    expect(index.symbols.length).toBe(3);
    for (const s of index.symbols) {
      expect(s.hash).toBe(hashText(sliceLines(source, s.range)));
    }
    expect(splitLines(source).length).toBeGreaterThan(8);
  });
});

describe("Go symbols: robustness", () => {
  it("does not throw on syntax errors and still finds the declarations it can", async () => {
    const source = src(
      "package p",
      "func good() {}",
      "func broken( {",
      "\tx := ",
      "}",
      "type T struct {",
      "\tf int",
      "}",
      "func (t T) alsoGood() {}",
    );
    const { facts } = await extract("a.go", source);
    const paths = facts.symbols.map((s) => s.path);
    expect(paths).toContain("good");
    expect(paths).toContain("T");
    expect(paths).toContain("T.alsoGood");
    expect(facts.symbols.every((s) => s.path !== "" && s.path !== ",")).toBe(true);
  });

  it("an empty file and a file with only a package clause have no facts", async () => {
    for (const source of ["", "package p\n", "﻿package p\r\n"]) {
      const { facts } = await extract("a.go", source);
      expect(facts).toMatchObject({ symbols: [], sites: [], imports: [], typeFacts: [] });
    }
  });

  it("handles CRLF line endings and a BOM without shifting ranges", async () => {
    const source = "﻿package p\r\n\r\n// doc\r\nfunc F() {\r\n\tG()\r\n}\r\n\r\nfunc G() {}\r\n";
    expect(await symbolsOf(source)).toEqual(["function F 4-6", "function G 8-8"]);
  });
});
