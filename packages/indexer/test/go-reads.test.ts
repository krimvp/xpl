/**
 * `read` sites of the Go pack: names and selector fields in value positions, minus callees, assignment
 * targets, declarations, literal keys, packages and the locals of every function and block.
 */
import { describe, expect, it } from "vitest";
import type { SiteDraft, Span } from "../src/index.js";
import { extract, indexFiles, refTriples } from "./helpers.js";

const src = (...lines: string[]): string => lines.join("\n") + "\n";

/** The source text a span covers (1-based inclusive lines and columns); newlines are shown as ⏎. */
function covered(source: string, s: Span): string {
  const lines = source.split("\n");
  const out: string[] = [];
  for (let line = s.startLine; line <= s.endLine; line++) {
    const text = lines[line - 1] ?? "";
    out.push(
      text.slice(
        line === s.startLine ? s.startCol - 1 : 0,
        line === s.endLine ? s.endCol : text.length,
      ),
    );
  }
  return out.join("⏎");
}

/** `line: read qualifier.name «covered text»` for every read site of `source`. */
async function reads(source: string, path: string): Promise<string[]> {
  const { facts } = await extract(path, source);
  return facts.sites
    .filter((s: SiteDraft) => s.kind === "read")
    .map(
      (s) =>
        `${s.site.startLine}: read ${[...s.qualifier, s.name].join(".")} «${covered(source, s.site)}»`,
    );
}

describe("Go read sites", () => {
  it("package variables, receiver and typed fields, chains; not calls, writes, keys, packages, the receiver or locals", async () => {
    const source = src(
      "package p",
      "",
      "import (",
      '\t"fmt"',
      '\tstr "strings"',
      ")",
      "",
      "const Limit = 10",
      "",
      "var Counter = 0",
      'var Table = map[string]int{"a": 1}',
      "",
      "type Opts struct {",
      "\tRetries int",
      "\tName    string",
      "}",
      "",
      "type Box struct {",
      "\tSize int",
      "\topts Opts",
      "\tData []int",
      "}",
      "",
      "func (b *Box) Inc(o *Box, n int) int {",
      "\tb.Size += 1",
      "\tb.Size = b.Size + Limit",
      "\tCounter++",
      "\tCounter = Counter + n",
      "\tlocal := b.Size + o.Size",
      '\tfmt.Println(local, Table["a"], b.opts.Retries, len(b.Data), str.ToUpper("x"))',
      "\tfor i, e := range b.Data {",
      "\t\t_ = i + e + Limit",
      "\t}",
      '\tt := Opts{Retries: Limit, Name: "x"}',
      '\tm := map[string]int{"k": Limit, "j": Counter}',
      "\tsl := []int{Limit, n}",
      "\tvar w int = Limit",
      "\tif ok := check(Limit); ok {",
      "\t\treturn Counter",
      "\t}",
      "\tf := func(Limit int) int { return Limit }",
      "\t_, _, _, _, _ = t, m, sl, w, f",
      "\tb.Data[0] = Counter",
      "\tx := b",
      "\tx.Size = 3",
      "\treturn b.Size + o.Size + Box{}.Size",
      "}",
      "",
      "func Shadow(Limit int) int {",
      "\tCounter := 1",
      "\treturn Limit + Counter",
      "}",
      "",
      "func check(int) bool { return Limit > 1 }",
    );
    expect(await reads(source, "a.go")).toEqual([
      "26: read this.Size «b.Size»",
      "26: read Limit «Limit»",
      "28: read Counter «Counter»",
      "29: read this.Size «b.Size»",
      "29: read o.Size «o.Size»",
      "30: read Table «Table»",
      "30: read this.opts «b.opts»",
      "30: read this.opts.Retries «b.opts.Retries»",
      "30: read this.Data «b.Data»",
      "31: read this.Data «b.Data»",
      "32: read Limit «Limit»",
      "34: read Limit «Limit»",
      "35: read Limit «Limit»",
      "35: read Counter «Counter»",
      "36: read Limit «Limit»",
      "37: read Limit «Limit»",
      "38: read Limit «Limit»",
      "39: read Counter «Counter»",
      "43: read Counter «Counter»",
      "46: read this.Size «b.Size»",
      "46: read o.Size «o.Size»",
      "46: read Box().Size «Box{}.Size»",
      "54: read Limit «Limit»",
    ]);
  });

  it("a package-level name of another file of the package is a candidate too", async () => {
    // extraction cannot know which names the package declares: every bare non-local name is offered
    expect(
      await reads(src("package p", "func f() int {", "	return Elsewhere + len(x)", "}"), "a.go"),
    ).toEqual(["3: read Elsewhere «Elsewhere»", "3: read x «x»"]);
  });

  it("a name that is a local in many functions is still a package variable where no local is in scope yet", async () => {
    const funcs = Array.from({ length: 12 }, (_, i) => `func f${i}() { count := ${i}; _ = count }`);
    const source = src(
      "package p",
      "",
      "var count = 1",
      "",
      "func use() int { return count }",
      "func late() int {",
      "	x := count",
      "	count := 2",
      "	return x + count",
      "}",
      "func inner() int {",
      "	if true {",
      "		count := 3",
      "		_ = count",
      "	}",
      "	return count",
      "}",
      ...funcs,
    );
    expect(await reads(source, "a.go")).toEqual([
      "5: read count «count»",
      "7: read count «count»",
      "16: read count «count»",
    ]);
  });

  it("the names of the language are not variables to read", async () => {
    expect(
      await reads(
        src(
          "package p",
          "func f() (int, error) {",
          "	var e error",
          "	_ = true",
          "	return iota, nil",
          "}",
        ),
        "a.go",
      ),
    ).toEqual([]);
  });
});

describe("Go read sites: classifySite agrees with extract", () => {
  const source = src(
    "package p",
    "const Limit = 1",
    "type Box struct{ N int }",
    "func (b *Box) M(o *Box) int {",
    "	b.N = 2",
    "	b.M(o)",
    "	return b.N + o.N + Limit",
    "}",
  );

  it("classifies selector fields and bare names as reads, flags bare names, and leaves writes, calls and declarations", async () => {
    const ex = await extract("a.go", source);
    const at = (line: number, needle: string, offset = 0) => {
      const col = source.split("\n")[line - 1]!.indexOf(needle) + offset;
      return ex.withTree((ctx) => ex.pack.classifySite(ctx, line, col + 1));
    };
    expect(at(7, "b.N", 2)).toEqual({
      kind: "read",
      site: { startLine: 7, startCol: 9, endLine: 7, endCol: 11 },
    });
    expect(at(7, "o.N", 2)).toMatchObject({ kind: "read" });
    expect(at(7, "Limit")).toMatchObject({ kind: "read", bare: true });
    expect(at(5, "b.N", 2)).toMatchObject({ kind: "write" });
    expect(at(6, "b.M", 2)).toMatchObject({ kind: "call" });
    expect(at(2, "Limit")).toBeUndefined(); // the declaration
    expect(at(3, "N")).toBeUndefined(); // the field declaration
  });

  it("every read `extract` emits is classified at the same site", async () => {
    const ex = await extract("a.go", source);
    const emitted = ex.facts.sites.filter((s) => s.kind === "read");
    expect(emitted.length).toBe(3);
    for (const s of emitted) {
      const text = covered(source, s.site);
      const col = s.site.startCol - 1 + text.lastIndexOf(s.name);
      const found = ex.withTree((ctx) => ex.pack.classifySite(ctx, s.site.startLine, col + 1));
      expect(found, text).toMatchObject({ kind: "read", site: s.site });
    }
  });
});

describe("Go read references: heuristic resolution", () => {
  const refs = async (files: Record<string, string>): Promise<string[]> => {
    const { index } = await indexFiles({ "go.mod": "module example.com/m\n\ngo 1.21\n", ...files });
    return refTriples(index, "read");
  };

  it("package variables of the package's other files and of imported packages; receiver, typed and chained fields", async () => {
    expect(
      await refs({
        "box/box.go": src(
          "package box",
          "const Limit = 10",
          "var Counter = 0",
          "type Opts struct{ Retries int }",
          "type Box struct {",
          "	Size int",
          "	opts Opts",
          "}",
          "func New() *Box { return &Box{} }",
        ),
        "box/more.go": src(
          "package box",
          "func (b *Box) Grow() int {",
          "	return b.Size + b.opts.Retries + Limit + Counter",
          "}",
        ),
        "main.go": src(
          "package main",
          'import "example.com/m/box"',
          "func main() {",
          "	b := box.New()",
          "	println(box.Limit, box.Counter, b.Size)",
          "	o := box.Opts{Retries: 1}",
          "	o.Retries = o.Retries + 1",
          "}",
        ),
      }),
    ).toEqual([
      "box/more.go#Box.Grow -> box/box.go#Box.Size (read)",
      "box/more.go#Box.Grow -> box/box.go#Box.opts (read)",
      "box/more.go#Box.Grow -> box/box.go#Opts.Retries (read)",
      "box/more.go#Box.Grow -> box/box.go#Limit (read)",
      "box/more.go#Box.Grow -> box/box.go#Counter (read)",
      "main.go#main -> box/box.go#Limit (read)",
      "main.go#main -> box/box.go#Counter (read)",
      "main.go#main -> box/box.go#Box.Size (read)",
      "main.go#main -> box/box.go#Opts.Retries (read)",
    ]);
  });

  it("function and method values are reads; types and packages are not; locals shadow package variables", async () => {
    expect(
      await refs({
        "a.go": src(
          "package p",
          "var Global = 1",
          "type T struct{ Field int }",
          "func (t T) Method() {}",
          "func helper() {}",
          "func f(t T, Global int) int {",
          "	h := helper",
          "	m := t.Method",
          "	return Global + t.Field",
          "}",
          "func g(t T) int {",
          "	Other := 1",
          "	return Global + Other + t.Field",
          "}",
        ),
      }),
    ).toEqual([
      "a.go#f -> a.go#helper (read)",
      "a.go#f -> a.go#T.Method (read)",
      "a.go#f -> a.go#T.Field (read)",
      "a.go#g -> a.go#Global (read)",
      "a.go#g -> a.go#T.Field (read)",
    ]);
  });

  it("test functions read like any other function", async () => {
    expect(
      await refs({
        "a.go": "package p\n\nvar Limit = 1\n",
        "a_test.go": src(
          "package p",
          'import "testing"',
          "func TestLimit(t *testing.T) {",
          "	if Limit != 1 {",
          '		t.Fatal("limit")',
          "	}",
          "}",
        ),
      }),
    ).toEqual(["a_test.go#TestLimit -> a.go#Limit (read)"]);
  });
});
