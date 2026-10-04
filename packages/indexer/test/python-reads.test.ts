/**
 * `read` sites of the Python pack: names and attributes in value positions, minus targets, callees,
 * annotations, imports, bases and everything a function, lambda, comprehension or class binds locally.
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

describe("Python read sites", () => {
  it("module variables, imports, self.x and module attributes; not calls, writes, annotations, bases or locals", async () => {
    const source = src(
      "import os",
      "import mod.sub as ms",
      "from lib import CONST, helper",
      "LIMIT = 10",
      "counter = 0",
      'TABLE = {"a": 1}',
      "",
      "",
      "def plain(a, b: int = LIMIT, *args, c=CONST, **kw):",
      "    x = LIMIT + a",
      "    (p, q), r = TABLE, counter",
      "    for i, j in TABLE:",
      "        pass",
      "    with open(LIMIT) as fh, ctx() as (u, v):",
      "        pass",
      "    try:",
      "        pass",
      "    except OSError as e:",
      "        print(e)",
      "    y: int = 1",
      "    z: LIMIT",
      "    w = [k for k in TABLE if k > LIMIT]",
      "    if (n := helper(LIMIT)) > 1:",
      "        pass",
      "    global counter",
      "    counter += LIMIT",
      "    return lambda m, n=CONST: m + n + LIMIT + x + y",
      "",
      "",
      "class C(Base, ms.Other, metaclass=Meta):",
      "    attr = LIMIT",
      "    other = attr + 1",
      "",
      "    def m(self, cls_arg):",
      "        self.q = self.r + CONST",
      '        print(f"{LIMIT!r} {self.q:>{CONST}}")',
      "        call(kw=LIMIT, other=self.x.y)",
      "        os.path.join(ms.VALUE, mod.sub.X)",
      "        return self.attr, C.attr, os.sep",
      "",
      "    @property",
      "    def prop(self):",
      '        return LIMIT if self.attr else TABLE["a"]',
      "",
      "",
      "def shadow(LIMIT):",
      "    return LIMIT",
      "",
      "",
      "def local_assign():",
      "    counter = 1",
      "    return counter + LIMIT",
      "",
      "",
      "def default_uses_outer(LIMIT=LIMIT):",
      "    return LIMIT",
      "",
      "",
      "match TABLE:",
      '    case {"a": LIMIT}:',
      "        pass",
      'if __name__ == "__main__":',
      "    print(LIMIT, counter)",
    );
    expect(await reads(source, "a.py")).toEqual([
      "9: read LIMIT «LIMIT»",
      "9: read CONST «CONST»",
      "10: read LIMIT «LIMIT»",
      "11: read TABLE «TABLE»",
      "11: read counter «counter»",
      "12: read TABLE «TABLE»",
      "14: read LIMIT «LIMIT»",
      "22: read TABLE «TABLE»",
      "22: read LIMIT «LIMIT»",
      "23: read LIMIT «LIMIT»",
      "26: read LIMIT «LIMIT»",
      "27: read CONST «CONST»",
      "27: read LIMIT «LIMIT»",
      "31: read LIMIT «LIMIT»",
      "35: read this.r «self.r»",
      "35: read CONST «CONST»",
      "36: read LIMIT «LIMIT»",
      "36: read this.q «self.q»",
      "36: read CONST «CONST»",
      "37: read LIMIT «LIMIT»",
      "37: read this.x «self.x»",
      "37: read this.x.y «self.x.y»",
      "38: read os «os»",
      "38: read os.path «os.path»",
      "38: read ms «ms»",
      "38: read ms.VALUE «ms.VALUE»",
      "39: read this.attr «self.attr»",
      "39: read C «C»", // the class itself, used as a namespace: a type reference once resolved
      "39: read C.attr «C.attr»",
      "39: read os «os»",
      "39: read os.sep «os.sep»",
      "43: read LIMIT «LIMIT»",
      "43: read this.attr «self.attr»",
      "43: read TABLE «TABLE»",
      "52: read LIMIT «LIMIT»",
      "55: read LIMIT «LIMIT»",
      "59: read TABLE «TABLE»",
      "63: read LIMIT «LIMIT»",
      "63: read counter «counter»",
    ]);
  });

  it("annotations, the bases and the metaclass of a class are not reads, its other keyword arguments and default values are", async () => {
    const source = src(
      "from lib import Alias, Base, Meta",
      "X = 1",
      "",
      "",
      "class C(Base, metaclass=Meta, flag=X):",
      "    field: Alias = X",
      "",
      "    def m(self, a: Alias, b: X = X) -> Alias:",
      "        c: list[Alias] = [X]",
      "        return c",
      "",
      "",
      "class D(C[X]):",
      "    pass",
    );
    // (`metaclass=Meta` is a type reference)
    expect(await reads(source, "a.py")).toEqual([
      "5: read X «X»",
      "6: read X «X»",
      "8: read X «X»",
      "9: read X «X»",
    ]);
  });

  it("a name assigned anywhere in a function is local in all of it, `global` undoes that, default values run outside", async () => {
    const source = src(
      "LIMIT = 1",
      "def before():",
      "    print(LIMIT)",
      "    LIMIT = 2",
      "def declared():",
      "    global LIMIT",
      "    print(LIMIT)",
      "    LIMIT = 3",
      "def loop():",
      "    for LIMIT in range(3):",
      "        pass",
      "    return LIMIT",
      "def nested():",
      "    LIMIT = 1",
      "    def inner():",
      "        return LIMIT",
      "    return inner",
      "def walrus():",
      "    if (LIMIT := 5):",
      "        return LIMIT",
      "def plain():",
      "    return LIMIT",
    );
    // only `declared` (global) and `plain` see the module variable
    expect(await reads(source, "a.py")).toEqual([
      "7: read LIMIT «LIMIT»",
      "22: read LIMIT «LIMIT»",
    ]);
  });

  it("class bodies: a name bound in the body is local to it, but not inside its methods; the receiver's members are reads", async () => {
    const source = src(
      "SHARED = 1",
      "class A:",
      "    SHARED = 2",
      "    own = SHARED",
      "    def m(self):",
      "        return SHARED, self.own",
      "class B:",
      "    other = SHARED",
    );
    expect(await reads(source, "a.py")).toEqual([
      "6: read SHARED «SHARED»",
      "6: read this.own «self.own»",
      "8: read SHARED «SHARED»",
    ]);
  });

  it("`from x import *` may bring any name in: bare names are candidates then", async () => {
    expect(await reads(src("from x import *", "def f():", "    return WHATEVER"), "a.py")).toEqual([
      "3: read WHATEVER «WHATEVER»",
    ]);
    expect(await reads(src("def f():", "    return WHATEVER"), "a.py")).toEqual([]);
  });

  it("a member of a local is a candidate only when the local has a type fact (annotation, evident initialiser, alias)", async () => {
    const source = src(
      "class Own:",
      "    p = 1",
      "def f(typed: Own, untyped, made=Own()):",
      "    a = Own()",
      "    b = untyped.x",
      "    c = one + two",
      "    return typed.p, untyped.q, made.r, a.s, b.t, c.u",
    );
    // `untyped` and `c` have nothing to resolve members with; `b` is an alias of `untyped.x`, which is a fact
    expect(await reads(source, "a.py")).toEqual([
      "7: read typed.p «typed.p»",
      "7: read made.r «made.r»",
      "7: read a.s «a.s»",
      "7: read b.t «b.t»",
    ]);
  });
});

describe("Python read sites: classifySite agrees with extract", () => {
  const source = src(
    "LIMIT = 1",
    "class A:",
    "    n = 0",
    "    def m(self, o: 'A'):",
    "        return self.n + o.n + LIMIT",
    "    def f(self):",
    "        self.n = 1",
    "        self.m(LIMIT)",
  );

  it("classifies the attribute and the bare name of a read, flags bare names, and leaves writes, calls and targets", async () => {
    const ex = await extract("a.py", source);
    const at = (line: number, needle: string, offset = 0) => {
      const col = source.split("\n")[line - 1]!.indexOf(needle) + offset;
      return ex.withTree((ctx) => ex.pack.classifySite(ctx, line, col + 1));
    };
    expect(at(5, "self.n", 5)).toEqual({
      kind: "read",
      site: { startLine: 5, startCol: 16, endLine: 5, endCol: 21 },
    });
    expect(at(5, "o.n", 2)).toMatchObject({ kind: "read" });
    expect(at(5, "LIMIT")).toMatchObject({ kind: "read", bare: true });
    expect(at(7, "self.n", 5)).toMatchObject({ kind: "write" });
    expect(at(8, "self.m", 5)).toMatchObject({ kind: "call" });
    expect(at(8, "LIMIT")).toMatchObject({ kind: "read", bare: true });
    expect(at(3, "n")).toBeUndefined(); // the declaration `n = 0`
    expect(at(5, "self")).toMatchObject({ kind: "read", bare: true }); // an identifier read; SCIP resolves it to a parameter, dropped by the mapper
  });

  it("every read `extract` emits is classified at the same site", async () => {
    const ex = await extract("a.py", source);
    const emitted = ex.facts.sites.filter((s) => s.kind === "read");
    expect(emitted.length).toBeGreaterThan(2);
    for (const s of emitted) {
      const text = covered(source, s.site);
      const col = s.site.startCol - 1 + text.lastIndexOf(s.name);
      const found = ex.withTree((ctx) => ex.pack.classifySite(ctx, s.site.startLine, col + 1));
      expect(found, text).toMatchObject({ kind: "read", site: s.site });
    }
  });
});

describe("Python read references: heuristic resolution", () => {
  const refs = async (files: Record<string, string>): Promise<string[]> => {
    const { index } = await indexFiles(files);
    return refTriples(index, "read");
  };

  it("module variables (same file, imported, through a module), class attributes, and typed receivers", async () => {
    expect(
      await refs({
        "pkg/__init__.py": "",
        "pkg/config.py": src("LIMIT = 3", "counter = 0", "def fn(): pass"),
        "pkg/model.py": src(
          "class Opts:",
          "    retries: int = 3",
          "    name = 'x'",
          "class Pool:",
          "    size = 0",
          "    shared = 1",
        ),
        "pkg/run.py": src(
          "from . import config",
          "from .config import LIMIT, fn",
          "from .model import Opts, Pool",
          "LOCAL = LIMIT",
          "class Runner:",
          "    pool: Pool",
          "    def run(self, o: Opts):",
          "        fn",
          "        p = Pool()",
          "        return LIMIT + config.counter + o.retries + self.pool.size + p.size + Pool.shared",
        ),
      }),
    ).toEqual([
      "pkg/run.py#LOCAL -> pkg/config.py#LIMIT (read)",
      "pkg/run.py#Runner.run -> pkg/config.py#LIMIT (read)",
      "pkg/run.py#Runner.run -> pkg/config.py#counter (read)",
      "pkg/run.py#Runner.run -> pkg/model.py#Opts.retries (read)",
      "pkg/run.py#Runner.run -> pkg/run.py#Runner.pool (read)",
      "pkg/run.py#Runner.run -> pkg/model.py#Pool.size (read)",
      "pkg/run.py#Runner.run -> pkg/model.py#Pool.size (read)",
      "pkg/run.py#Runner.run -> pkg/model.py#Pool.shared (read)",
    ]);
  });

  it("instance attributes assigned only in methods are not symbols: reading them links nothing", async () => {
    expect(
      await refs({
        "a.py": src(
          "class A:",
          "    declared: int = 0",
          "    def __init__(self):",
          "        self.dynamic = 1",
          "    def m(self):",
          "        return self.dynamic + self.declared",
        ),
      }),
    ).toEqual(["a.py#A.m -> a.py#A.declared (read)"]);
  });

  it("functions, classes and methods used as values are not reads", async () => {
    expect(
      await refs({
        "a.py": src(
          "def helper(): pass",
          "class K:",
          "    def method(self): pass",
          "    value = 1",
          "VALUE = 2",
          "def f(k: K):",
          "    return [helper, K, k.method, VALUE, k.value]",
        ),
      }),
    ).toEqual(["a.py#f -> a.py#VALUE (read)", "a.py#f -> a.py#K.value (read)"]);
  });

  it("the nearest member of a name decides: a property overriding a base class's attribute is not a variable", async () => {
    expect(
      await refs({
        "a.py": src(
          "class Base:",
          "    name: str",
          "    kind: str = 'base'",
          "class Child(Base):",
          "    @property",
          "    def name(self):",
          "        return 'child'",
          "    def show(self):",
          "        return self.name, self.kind",
        ),
      }),
    ).toEqual(["a.py#Child.show -> a.py#Base.kind (read)"]);
  });

  it("names re-exported by a package: variables are read, a re-exported class or function used as a value is not", async () => {
    expect(
      await refs({
        "pkg/__init__.py": src(
          "from .globals import request as request",
          "from .app import App as App",
          "from .helpers import url_for as url_for",
        ),
        "pkg/globals.py": "request = object()\n",
        "pkg/app.py": "class App:\n    default_config = {}\n",
        "pkg/helpers.py": "def url_for(): pass\n",
        "use.py": src(
          "import pkg",
          "from pkg import App, request",
          "def f():",
          "    return [pkg.request, pkg.App, pkg.url_for, App.default_config, request, App]",
        ),
      }),
    ).toEqual([
      "use.py#f -> pkg/globals.py#request (read)",
      "use.py#f -> pkg/app.py#App.default_config (read)",
      "use.py#f -> pkg/globals.py#request (read)",
    ]);
  });

  it("test functions and classes read like any other symbol", async () => {
    expect(
      await refs({
        "src.py": "LIMIT = 1\n",
        "test_src.py": src(
          "import unittest",
          "from src import LIMIT",
          "class T(unittest.TestCase):",
          "    def test_limit(self):",
          "        self.assertEqual(LIMIT, 1)",
        ),
      }),
    ).toEqual(["test_src.py#T.test_limit -> src.py#LIMIT (read)"]);
  });
});
