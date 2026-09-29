import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Span } from "../src/index.js";
import { extract, indexFiles, symbol, symbolLines } from "./helpers.js";

const src = (...lines: string[]): string => lines.join("\n") + "\n";

async function symbolsOf(source: string, file = "a.py"): Promise<string[]> {
  const { index } = await indexFiles({ [file]: source });
  return symbolLines(index, file);
}

describe("Python symbols: kinds and paths (ARCHITECTURE.md §3 table)", () => {
  it("covers classes, functions, methods, module/class variables and nesting", async () => {
    const source = src(
      "import os", // 1
      "", // 2
      "MAX = 10", // 3
      'name: str = "x"', // 4
      "bare: int", // 5
      "", // 6
      "class Runner:", // 7
      '    """Docstring."""', // 8
      "    count = 0", // 9
      "    queue: Queue", // 10
      "    timeout: float = 1.5", // 11
      "", // 12
      "    def __init__(self, queue: Queue) -> None:", // 13
      "        self.queue = queue", // 14
      "", // 15
      "    async def dispatch(self) -> None:", // 16
      "        def inner():", // 17
      "            pass", // 18
      "        class Local:", // 19
      "            def run(self): ...", // 20
      "", // 21
      "    class Config:", // 22
      "        debug = False", // 23
      "", // 24
      "def helper(a: int) -> int:", // 25
      "    x = 1", // 26
      "    def nested():", // 27
      "        return a", // 28
      "    return nested()", // 29
      "", // 30
      "async def fetch(): ...", // 31
    );
    expect(await symbolsOf(source)).toEqual([
      "variable MAX 3-3",
      "variable name 4-4",
      "variable bare 5-5",
      "class Runner 7-23",
      "variable Runner.count 9-9",
      "variable Runner.queue 10-10",
      "variable Runner.timeout 11-11",
      "method Runner.__init__ 13-14",
      "method Runner.dispatch 16-20",
      "function Runner.dispatch.inner 17-18",
      "class Runner.dispatch.Local 19-20",
      "method Runner.dispatch.Local.run 20-20",
      "class Runner.Config 22-23",
      "variable Runner.Config.debug 23-23",
      "function helper 25-29",
      "function helper.nested 27-28",
      "function fetch 31-31",
    ]);
  });

  it("assigns parents to members and nested definitions; module-level symbols have none", async () => {
    const { index } = await indexFiles({
      "a.py": src("class A:", "    def m(self):", "        def inner(): ...", "", "def top(): ..."),
    });
    expect(symbol(index, "a.py", "A")!.parent).toBeUndefined();
    expect(symbol(index, "a.py", "A.m")!.parent).toBe("a.py#A");
    expect(symbol(index, "a.py", "A.m.inner")!.parent).toBe("a.py#A.m");
    expect(symbol(index, "a.py", "A.m.inner")!.id).toBe("a.py#A.m.inner");
    expect(symbol(index, "a.py", "top")!.parent).toBeUndefined();
  });

  it("class-level and module-level variables are simple single-name assignments only", async () => {
    const source = src(
      "a = 1", // 1
      "b: int = 2", // 2
      "c = d = 3", // 3
      "e, f = 1, 2", // 4
      "g.h = 5", // 5
      "i[0] = 6", // 6
      "j += 7", // 7
      "k = lambda x: x", // 8
      "l = (", // 9
      "    1 +", // 10
      "    2", // 11
      ")", // 12
      "for m in range(3):", // 13
      "    n = 1", // 14
      "class C:", // 15
      "    o = p = 1", // 16
      "    (q) = 2", // 17
    );
    expect(await symbolsOf(source)).toEqual([
      "variable a 1-1",
      "variable b 2-2",
      "variable c 3-3", // a chain defines a symbol for its first target
      "variable k 8-8", // a lambda is still a variable
      "variable l 9-12", // multi-line statements keep their whole extent
      "class C 15-17",
      "variable C.o 16-16",
    ]);
  });

  it("PEP 695 type aliases are `type` symbols", async () => {
    const source = src("type Pair = tuple[int, int]", "type Box[T] = list[T]", "X = 1");
    expect(await symbolsOf(source)).toEqual(["type Pair 1-1", "type Box 2-2", "variable X 3-3"]);
  });

  it("does not throw on syntax errors and keeps what it can read", async () => {
    const source = src(
      "class Ok:", // 1
      "    def m(self): ...", // 2
      "", // 3
      "def broken(:", // 4
      "    pass", // 5
      "", // 6
      "class Also(:", // 7
      "", // 8
      "def after(): ...", // 9
    );
    const { facts } = await extract("a.py", source);
    const paths = facts.symbols.map((s) => s.path);
    expect(paths).toContain("Ok");
    expect(paths).toContain("Ok.m");
    expect(paths).toContain("after");
  });
});

describe("Python symbols: ranges", () => {
  it("start at the first decorator and exclude leading comments", async () => {
    const source = src(
      "# leading comment", // 1
      "@decorator", // 2
      "@other(arg=1)  # trailing comment on a decorator", // 3
      "class A:", // 4
      "    # comment about m", // 5
      "    @staticmethod", // 6
      "    def m(): ...", // 7
      "", // 8
      "# comment before f", // 9
      "@a.b.c", // 10
      "# comment between decorator and def", // 11
      "def f():", // 12
      "    pass", // 13
      "", // 14
      "# comment before g", // 15
      "",
      "def g(): ...", // 17
    );
    expect(await symbolsOf(source)).toEqual([
      "class A 2-7",
      "method A.m 6-7",
      "function f 10-13",
      "function g 17-17",
    ]);
  });

  it("columns are kept internally: two statements on one line are told apart", async () => {
    const { facts } = await extract("a.py", "a = 1; b = 2\n");
    expect(facts.symbols.map((s) => [s.path, s.range.startCol, s.range.endCol])).toEqual([
      ["a", 1, 5],
      ["b", 8, 12],
    ]);
  });

  it("multi-line definitions end with their last statement", async () => {
    const source = src(
      "def f(", // 1
      "    a,", // 2
      "    b,", // 3
      ") -> int:", // 4
      "    return (", // 5
      "        a", // 6
      "    )", // 7
      "x = 1", // 8
    );
    expect(await symbolsOf(source)).toEqual(["function f 1-7", "variable x 8-8"]);
  });
});

describe("Python symbols: duplicate paths", () => {
  it("a property getter and its setter share a path; the framework numbers the second", async () => {
    const source = src(
      "class Queue:", // 1
      "    @property", // 2
      "    def size(self) -> int:", // 3
      "        return 1", // 4
      "", // 5
      "    @size.setter", // 6
      "    def size(self, value: int) -> None:", // 7
      "        pass", // 8
    );
    const { facts } = await extract("a.py", source);
    expect(facts.symbols.filter((s) => s.path === "Queue.size")).toHaveLength(2);
    expect(await symbolsOf(source)).toEqual([
      "class Queue 1-8",
      "method Queue.size 2-4",
      "method Queue.size~2 6-8",
    ]);
  });

  it("redefinitions are numbered in source order", async () => {
    const source = src("def f(): ...", "def f(): ...", "x = 1", "x = 2");
    expect(await symbolsOf(source)).toEqual([
      "function f 1-1",
      "function f~2 2-2",
      "variable x 3-3",
      "variable x~2 4-4",
    ]);
  });

  it("@overload stubs are not symbols when the implementation follows", async () => {
    const source = src(
      "@overload", // 1
      "def f(x: int) -> int: ...", // 2
      "@typing.overload", // 3
      "def f(x: str) -> str: ...", // 4
      "def f(x): ...", // 5
      "class A:", // 6
      "    @overload", // 7
      "    def m(self, x: int) -> int: ...", // 8
      "    def m(self, x): ...", // 9
    );
    expect(await symbolsOf(source)).toEqual(["function f 5-5", "class A 6-9", "method A.m 9-9"]);
  });

  it("stub files keep overloads that have no implementation", async () => {
    const source = src(
      "@overload",
      "def f(x: int) -> int: ...",
      "@overload",
      "def f(x: str) -> str: ...",
    );
    expect(await symbolsOf(source, "a.pyi")).toEqual(["function f 1-2", "function f~2 3-4"]);
  });
});

describe("Python symbols: blocks and the main guard", () => {
  it("skips `if __name__ == '__main__':` as a symbol scope, but its calls count from module scope", async () => {
    const source = src(
      "def main(): ...", // 1
      "", // 2
      'if __name__ == "__main__":', // 3
      "    parser = make_parser()", // 4
      "    def helper(): ...", // 5
      "    main()", // 6
      "", // 7
      "if '__main__' == __name__:", // 8
      "    x = 1", // 9
    );
    expect(await symbolsOf(source)).toEqual(["function main 1-1"]);
    const { facts } = await extract("a.py", source);
    expect(facts.sites.filter((s) => s.kind === "call").map((s) => s.name)).toEqual([
      "make_parser",
      "main",
    ]);
  });

  it("definitions in if/try/with/for/while/match blocks belong to the scope around them; assignments there do not", async () => {
    const source = src(
      "try:", // 1
      "    import fast", // 2
      "except ImportError:", // 3
      "    def slow(): ...", // 4
      "    fallback = None", // 5
      "else:", // 6
      "    def fine(): ...", // 7
      "finally:", // 8
      "    def last(): ...", // 9
      "if TYPE_CHECKING:", // 10
      "    class Only: ...", // 11
      "elif other:", // 12
      "    def in_elif(): ...", // 13
      "else:", // 14
      "    def in_else(): ...", // 15
      "with ctx():", // 16
      "    def in_with(): ...", // 17
      "for i in x:", // 18
      "    def in_for(): ...", // 19
      "while y:", // 20
      "    def in_while(): ...", // 21
      "match z:", // 22
      "    case 1:", // 23
      "        def in_case(): ...", // 24
      "class K:", // 25
      "    if sys.platform == 'win32':", // 26
      "        def win(self): ...", // 27
      "    else:", // 28
      "        def other(self): ...", // 29
    );
    expect(await symbolsOf(source)).toEqual([
      "function slow 4-4",
      "function fine 7-7",
      "function last 9-9",
      "class Only 11-11",
      "function in_elif 13-13",
      "function in_else 15-15",
      "function in_with 17-17",
      "function in_for 19-19",
      "function in_while 21-21",
      "function in_case 24-24",
      "class K 25-29",
      "method K.win 27-27",
      "method K.other 29-29",
    ]);
  });

  it("nested definitions inside blocks of a function are `outer.inner`", async () => {
    const source = src(
      "def outer(flag):",
      "    if flag:",
      "        def a(): ...",
      "    else:",
      "        def b(): ...",
      "    try:",
      "        class C: ...",
      "    finally:",
      "        pass",
    );
    expect(await symbolsOf(source)).toEqual([
      "function outer 1-9",
      "function outer.a 3-3",
      "function outer.b 5-5",
      "class outer.C 7-7",
    ]);
  });
});

describe("Python symbols: columns and encodings", () => {
  it("counts columns in UTF-16 code units (an astral character is two)", async () => {
    const { facts } = await extract("a.py", 'x = "😀"; foo()\n');
    const call = facts.sites.find((s) => s.name === "foo")!;
    // x = "😀"; foo()   ->  `foo` starts at code unit 11 (0-based 10 + 1... the emoji takes two units)
    expect(call.site).toEqual({ startLine: 1, startCol: 11, endLine: 1, endCol: 15 });
  });

  it("handles CRLF line endings and a leading BOM", async () => {
    const crlf = "class A:\r\n    def m(self):\r\n        return f(1)\r\n\r\nx = 1\r\n";
    expect(await symbolsOf(crlf)).toEqual(["class A 1-3", "method A.m 2-3", "variable x 5-5"]);
    const bom = "\uFEFFclass A:\n    def m(self): ...\n";
    expect(await symbolsOf(bom)).toEqual(["class A 1-2", "method A.m 2-2"]);
  });
});

describe("Python robustness: incomplete code, as an editor leaves it", () => {
  const fixture = resolve(import.meta.dirname, "../../../fixtures/py-jobrunner/jobrunner");
  const valid = (s: Span): boolean =>
    s.startLine >= 1 &&
    s.startCol >= 1 &&
    s.endLine >= s.startLine &&
    (s.endLine > s.startLine || s.endCol >= s.startCol);

  it("never throws and only emits well-formed facts for any truncation of real files", async () => {
    let checked = 0;
    for (const name of ["runner.py", "worker.py", "config.py"]) {
      const source = readFileSync(`${fixture}/${name}`, "utf8");
      for (let end = 5; end < source.length; end += 61) {
        const { facts, pack, withTree } = await extract(`x/${name}`, source.slice(0, end));
        for (const site of facts.sites) {
          expect(site.name, `${name}:${end}`).not.toBe("");
          expect(valid(site.site), `${name}:${end} ${site.name}`).toBe(true);
        }
        for (const symbol of facts.symbols) {
          expect(
            symbol.path.split(".").every((part) => part !== ""),
            `${name}:${end}`,
          ).toBe(true);
          expect(valid(symbol.range), `${name}:${end} ${symbol.path}`).toBe(true);
        }
        for (const binding of facts.imports) expect(valid(binding.site)).toBe(true);
        withTree((ctx) => {
          for (let line = 1; line <= ctx.lines.length; line += 3)
            for (let col = 1; col < 40; col += 7) pack.classifySite(ctx, line, col);
        });
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it("tolerates code that is not Python at all", async () => {
    for (const source of [
      "",
      "\n\n",
      "{{{{",
      "def",
      "class",
      "@",
      "x = ",
      "import",
      "from . import",
      "a.",
      "(((",
      "'unterminated",
      "\t\tdef f(): pass",
    ]) {
      const { facts } = await extract("a.py", source);
      expect(facts.sites.every((s) => s.name !== "")).toBe(true);
    }
  });
});
