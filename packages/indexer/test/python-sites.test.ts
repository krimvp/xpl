import { describe, expect, it } from "vitest";
import type { SiteDraft, Span } from "../src/index.js";
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

async function sitesOf(source: string, kinds?: string[], path = "a.py"): Promise<string[]> {
  const { facts } = await extract(path, source);
  return facts.sites.filter((s) => !kinds || kinds.includes(s.kind)).map((s) => show(source, s));
}

describe("Python call sites", () => {
  it("plain, member, chained, static and constructor calls; the whole call expression is the site", async () => {
    const source = src(
      "def f():",
      "    foo()",
      "    a.b.c(1)",
      "    Queue(10)",
      "    ns.Klass.create()",
      "    await task()",
      "    print(f'{x.y()!r}')",
    );
    expect(await sitesOf(source, ["call"])).toEqual([
      "call foo «foo()»",
      "call a.b.c «a.b.c(1)»",
      "call Queue «Queue(10)»",
      "call ns.Klass.create «ns.Klass.create()»",
      "call task «task()»",
      "call print «print(f'{x.y()!r}')»",
      "call x.y «x.y()»",
    ]);
  });

  it("gives exact line and column ranges (1-based, inclusive)", async () => {
    const { facts } = await extract("a.py", src("def f():", "    foo(1)"));
    expect(facts.sites[0]!.site).toEqual({ startLine: 2, startCol: 5, endLine: 2, endCol: 10 });
  });

  it("spells calls on call results and awaited values as a receiver chain, `x()` = the result of calling x", async () => {
    const source = src(
      "def f(self):",
      "    self.pool.lease().run()",
      "    Foo().bar()",
      "    (await self.pool.lease()).run()",
      "    a.b().c().d()",
      "    get_runner().start()",
    );
    const { facts } = await extract("a.py", source);
    const calls = facts.sites.filter((s) => s.kind === "call");
    const chains = calls.map((s) => [...s.qualifier, s.name]);
    expect(chains).toEqual([
      ["self", "pool", "lease()", "run"], // `self` is only special in a method
      ["self", "pool", "lease"],
      ["Foo()", "bar"],
      ["Foo"],
      ["self", "pool", "lease()", "run"],
      ["self", "pool", "lease"],
      ["a", "b()", "c()", "d"],
      ["a", "b()", "c"],
      ["a", "b"],
      ["get_runner()", "start"],
      ["get_runner"],
    ]);
  });

  it("emits no site for a receiver it cannot spell", async () => {
    const source = src(
      "def f(arr, handlers, kind):",
      "    arr[0].run()",
      "    handlers[kind](1)",
      "    'x,y'.split(',')",
      "    {}.get(1)",
      "    (a or b).run()",
      "    f()()",
      "    (lambda: 1)()",
      "    arr[0].q.run()",
    );
    // only the call `f()` inside `f()()` has a name we can write down
    expect(await sitesOf(source, ["call"])).toEqual(["call f «f()»"]);
  });

  it("reports only the callee when a call spans more than 10 lines", async () => {
    const args = Array.from({ length: 12 }, (_, i) => `        ${i},`);
    const source = src("def f(self):", "    self.queue.requeue(", ...args, "    )");
    expect(await sitesOf(source, ["call"])).toEqual([
      "call self.queue.requeue «self.queue.requeue»",
    ]);
  });

  it("keeps the whole call when it spans exactly 10 lines, drops to the callee at 11", async () => {
    const ten = src("run(", ...Array.from({ length: 8 }, (_, i) => `    ${i},`), ")");
    expect(await sitesOf(ten, ["call"])).toEqual([
      "call run «run(⏎    0,⏎    1,⏎    2,⏎    3,⏎    4,⏎    5,⏎    6,⏎    7,⏎)»",
    ]);
    const eleven = src("run(", ...Array.from({ length: 9 }, (_, i) => `    ${i},`), ")");
    expect(await sitesOf(eleven, ["call"])).toEqual(["call run «run»"]);
  });

  it("uses only the attribute name for a callee that itself spans many lines", async () => {
    const args = Array.from({ length: 12 }, (_, i) => `    ${i},`);
    const source = src("(build(", ...args, ")", "    .finish())");
    const { facts } = await extract("a.py", source);
    const finish = facts.sites.find((s) => s.name === "finish")!;
    expect(covered(source, finish.site)).toBe("finish");
  });

  it("decorators apply a function: bare ones are calls, decorator calls are calls", async () => {
    const source = src(
      "@retry",
      "@app.route",
      "@retry(3)",
      "@a.b(1)",
      "def f(): ...",
      "@staticmethod",
      "class C: ...",
    );
    expect(await sitesOf(source, ["call"])).toEqual([
      "call retry «retry»",
      "call app.route «app.route»",
      "call retry «retry(3)»",
      "call a.b «a.b(1)»",
      "call staticmethod «staticmethod»",
    ]);
  });

  it("calls at class level and in module scope are sites too", async () => {
    const source = src("x = make()", "class C:", "    y = field(default_factory=list)");
    expect(await sitesOf(source, ["call"])).toEqual([
      "call make «make()»",
      "call field «field(default_factory=list)»",
    ]);
  });
});

describe("Python receivers: `self` and `cls` become `this`", () => {
  it("is the first parameter of a method, whatever it is called", async () => {
    const source = src(
      "class A(B):", // 1
      "    def m(self, x):", // 2
      "        self.run()", // 3
      "        self.queue.pop()", // 4
      "        super().m()", // 5
      "        x.go()", // 6
      "    def n(this):", // 7
      "        this.run()", // 8
      "    async def o(me, job):", // 9
      "        await me.q.push(job)", // 10
      "    def p(*args):", // 11
      "        args.count()", // 12
    );
    const { facts } = await extract("a.py", source);
    expect(facts.sites.map((s) => [...s.qualifier, s.name])).toEqual([
      ["B"], // the extends site
      ["this", "run"],
      ["this", "queue", "pop"],
      ["super", "m"],
      ["x", "go"],
      ["this", "run"],
      ["this", "q", "push"],
      ["args", "count"], // `*args` is not a receiver
    ]);
  });

  it("is `cls` in a classmethod, but nothing in a staticmethod or a plain function", async () => {
    const source = src(
      "class A:", // 1
      "    @classmethod", // 2
      "    def c(klass):", // 3
      "        klass.create()", // 4
      "    @staticmethod", // 5
      "    def s(self):", // 6
      "        self.run()", // 7
      "    def free():", // 8
      "        other.run()", // 9
      "def plain(self):", // 10
      "    self.run()", // 11
    );
    expect(await sitesOf(source, ["call"])).toEqual([
      "call classmethod «classmethod»",
      "call this.create «klass.create()»",
      "call staticmethod «staticmethod»",
      "call self.run «self.run()»",
      "call other.run «other.run()»",
      "call self.run «self.run()»",
    ]);
  });

  it("nested functions and lambdas see the receiver unless they shadow it; class bodies do not", async () => {
    const source = src(
      "class A:", // 1
      "    x = compute(self)", // 2
      "    def m(self):", // 3
      "        def helper():", // 4
      "            self.a()", // 5
      "        f = lambda: self.b()", // 6
      "        g = lambda self: self.c()", // 7
      "        def shadow(self):", // 8
      "            self.d()", // 9
      "        class Inner:", // 10
      "            def m2(me):", // 11
      "                me.e()", // 12
    );
    const { facts } = await extract("a.py", source);
    const calls = facts.sites
      .filter((s) => s.kind === "call" && s.name !== "compute")
      .map((s) => [...s.qualifier, s.name].join("."));
    expect(calls).toEqual(["this.a", "this.b", "self.c", "self.d", "this.e"]);
  });

  it("normalises the receiver of writes, type facts' initialisers and return values too", async () => {
    const source = src(
      "class A:",
      "    def m(this, q: Queue):",
      "        this.count += 1",
      "        this.x = this.make()",
    );
    const { facts } = await extract("a.py", source);
    expect(
      facts.sites.filter((s) => s.kind === "write").map((s) => [...s.qualifier, s.name]),
    ).toEqual([
      ["this", "count"],
      ["this", "x"],
    ]);
    expect(facts.typeFacts.find((f) => f.kind === "field" && f.name === "x")).toMatchObject({
      initCall: { qualifier: ["this"], name: "make" },
    });
  });
});

describe("Python super()", () => {
  it("`super().m()` and `super(Cls, self).m()` have the qualifier `super`; `super(...)` itself is no site", async () => {
    const source = src(
      "class A(B):",
      "    def m(self):",
      "        super().m()",
      "        super(A, self).m(1)",
      "        super().__init__()",
      "        x = super()",
    );
    const { facts } = await extract("a.py", source);
    expect(
      facts.sites.filter((s) => s.kind === "call").map((s) => [...s.qualifier, s.name]),
    ).toEqual([
      ["super", "m"],
      ["super", "m"],
      ["super", "__init__"],
    ]);
  });
});

describe("Python imports without bindings (dynamic imports)", () => {
  it("importlib.import_module and __import__ with a literal module name are `import` sites", async () => {
    const source = src(
      "import importlib",
      "mod = importlib.import_module('pkg.mod')",
      'other = __import__("a.b")',
      "dyn = importlib.import_module(name)",
      "rel = importlib.import_module('.x', package='p')",
    );
    expect(await sitesOf(source, ["import", "call"])).toEqual([
      "import pkg.mod «importlib.import_module('pkg.mod')»",
      'import a.b «__import__("a.b")»',
      "call importlib.import_module «importlib.import_module(name)»",
      "call importlib.import_module «importlib.import_module('.x', package='p')»",
    ]);
  });
});

describe("Python class bases: `extends`", () => {
  it("every positional base, qualified and generic ones included; keyword arguments are not bases", async () => {
    const source = src(
      "class A(B, mod.C, D[int], pkg.E[Job], metaclass=Meta, flag=True):",
      "    pass",
      "class Plain: ...",
      "class Empty(): ...",
      "class Fn(namedtuple('Fn', 'x y')): ...",
    );
    expect(await sitesOf(source, ["extends"])).toEqual([
      "extends B «B»",
      "extends mod.C «mod.C»",
      "extends D «D»",
      "extends pkg.E «pkg.E»",
    ]);
    // the type arguments of generic bases are type references
    expect(await sitesOf(source, ["type-ref"])).toEqual([
      "type-ref int «int»",
      "type-ref Job «Job»",
    ]);
  });
});

describe("Python type references (annotations)", () => {
  it("parameters, returns and variables, inside Optional, list, unions and Callable", async () => {
    const source = src(
      "def f(a: Job, b: Optional[Job], c: list[Job], d: Job | None, e: Callable[[A], B]) -> mod.Result:", // 1
      "    x: Local = 1", // 2
      "    self.y: Other = 2", // 3
    );
    expect(await sitesOf(source, ["type-ref"])).toEqual([
      "type-ref Job «Job»",
      "type-ref Optional «Optional»",
      "type-ref Job «Job»",
      "type-ref list «list»",
      "type-ref Job «Job»",
      "type-ref Job «Job»",
      "type-ref Callable «Callable»",
      "type-ref A «A»",
      "type-ref B «B»",
      "type-ref mod.Result «mod.Result»",
      "type-ref Local «Local»",
      "type-ref Other «Other»",
    ]);
  });

  it("qualified names keep their qualifier; subscripted qualified names too", async () => {
    const source = src("def f(a: typing.Optional[mod.Job], b: mod.Box[pkg.mod.Item]): ...");
    const { facts } = await extract("a.py", source);
    expect(
      facts.sites.filter((s) => s.kind === "type-ref").map((s) => [s.qualifier, s.name]),
    ).toEqual([
      [["typing"], "Optional"],
      [["mod"], "Job"],
      [["mod"], "Box"],
      [["pkg", "mod"], "Item"],
    ]);
  });

  it("`X | Y | None` unions, in both shapes the grammar produces", async () => {
    const source = src("def f(a: A | B | None, b: mod.A | None, c: None | A): ...");
    expect(await sitesOf(source, ["type-ref"])).toEqual([
      "type-ref A «A»",
      "type-ref B «B»",
      "type-ref mod.A «mod.A»",
      "type-ref A «A»",
    ]);
  });

  it("class-level annotations (dataclass fields) and annotations without a value", async () => {
    const source = src(
      "@dataclass",
      "class Job:",
      "    id: str",
      "    queue: 'Queue'",
      "    n: int = 0",
    );
    expect(await sitesOf(source, ["type-ref"])).toEqual([
      "type-ref str «str»",
      "type-ref Queue «Queue»",
      "type-ref int «int»",
    ]);
  });

  it("string annotations that are plain names count; longer expressions are ignored", async () => {
    const source = src(
      "def f(a: 'Job', b: \"mod.Job\", c: 'list[Job]', d: Optional['Job'], e: 'A | B') -> 'Result': ...",
    );
    const { facts } = await extract("a.py", source);
    const refs = facts.sites.filter((s) => s.kind === "type-ref");
    expect(refs.map((s) => show(source, s))).toEqual([
      "type-ref Job «Job»",
      "type-ref mod.Job «mod.Job»",
      "type-ref Optional «Optional»",
      "type-ref Job «Job»",
      "type-ref Result «Result»",
    ]);
    // the site is the name inside the quotes
    expect(refs[0]!.site).toEqual({ startLine: 1, startCol: 11, endLine: 1, endCol: 13 });
  });

  it("Literal arguments and Annotated metadata are values, not types", async () => {
    const source = src(
      "def f(a: Literal['A', 'B'], b: Annotated[Job, Field(gt=limit), 'meta'], c: typing.Literal['x']): ...",
    );
    expect(await sitesOf(source, ["type-ref"])).toEqual([
      "type-ref Literal «Literal»",
      "type-ref Annotated «Annotated»",
      "type-ref Job «Job»",
      "type-ref typing.Literal «typing.Literal»",
    ]);
  });

  it("type parameters (PEP 695) are declarations, their uses are references", async () => {
    const source = src(
      "class Box[T](Base[T]):",
      "    items: list[T]",
      "def first[T](xs: list[T]) -> T: ...",
    );
    expect(await sitesOf(source, ["type-ref"])).toEqual([
      "type-ref T «T»",
      "type-ref list «list»",
      "type-ref T «T»",
      "type-ref list «list»",
      "type-ref T «T»",
      "type-ref T «T»",
    ]);
  });

  it("names in default values and bodies are not annotations", async () => {
    const source = src("def f(a: A = B, *, c=D):", "    return E(F)");
    expect(await sitesOf(source, ["type-ref"])).toEqual(["type-ref A «A»"]);
  });
});

describe("Python writes", () => {
  it("attribute targets, augmented assignments and annotated ones; the site is the assignment", async () => {
    const source = src(
      "class A:",
      "    def m(self, o):",
      "        self.x = 1",
      "        self.count += 1",
      "        self.y: int = 2",
      "        o.stats.total -= 1",
      "        self.a = self.b = 0",
    );
    expect(await sitesOf(source, ["write"])).toEqual([
      "write this.x «self.x = 1»",
      "write this.count «self.count += 1»",
      "write this.y «self.y: int = 2»",
      "write o.stats.total «o.stats.total -= 1»",
      "write this.a «self.a = self.b = 0»",
      "write this.b «self.b = 0»",
    ]);
  });

  it("tuple targets write every attribute; subscripts and local names are not writes", async () => {
    const source = src(
      "def f(self, d):",
      "    self.a, (self.b, *self.c) = 1, (2, 3)",
      "    d[0] = 1",
      "    d.items[1] = 2",
      "    local = 3",
      "    local += 1",
      "    a, b = 1, 2",
    );
    expect(await sitesOf(source, ["write"])).toEqual([
      "write self.a «self.a, (self.b, *self.c) = 1, (2, 3)»",
      "write self.b «self.a, (self.b, *self.c) = 1, (2, 3)»",
      "write self.c «self.a, (self.b, *self.c) = 1, (2, 3)»",
    ]);
  });

  it("module variables: `global` in a function, augmented assignment at module level; a plain module assignment is the definition", async () => {
    const source = src(
      "counter = 0", // 1
      "counter += 1", // 2
      "for i in range(3):", // 3
      "    total = i", // 4
      "    counter += i", // 5
      "def bump():", // 6
      "    global counter, other", // 7
      "    counter += 1", // 8
      "    other = 2", // 9
      "    mine = 3", // 10
      "    mine += 1", // 11
      "def clean():", // 12
      "    counter = 1", // 13
      "    def inner():", // 14
      "        counter += 1", // 15
      "class C:", // 16
      "    n = 1", // 17
      "    n += 1", // 18
    );
    expect(await sitesOf(source, ["write"])).toEqual([
      "write counter «counter += 1»",
      "write counter «counter += i»",
      "write counter «counter += 1»",
      "write other «other = 2»",
    ]);
  });

  it("a write spanning more than 10 lines is reported by its target only", async () => {
    const items = Array.from({ length: 12 }, (_, i) => `    ${i},`);
    const source = src("def f(self):", "    self.items = [", ...items, "    ]");
    expect(await sitesOf(source, ["write"])).toEqual(["write self.items «self.items»"]);
  });
});

describe("Python qualifiers and `import a.b.c`", () => {
  it("`import a.b.c` binds the dotted name: qualifiers starting with it use it as one root segment", async () => {
    const source = src(
      "import pkg.sub",
      "import pkg.sub.deep",
      "import other",
      "def f():",
      "    pkg.sub.helper()",
      "    pkg.sub.deep.go()",
      "    pkg.sub.deep.Klass().run()",
      "    pkg.top()",
      "    other.sub.x()",
      "    local.pkg.sub.y()",
      "    x: pkg.sub.Thing = 1",
    );
    const { facts } = await extract("a.py", source);
    expect(
      facts.sites
        .filter((s) => s.kind === "call" || s.kind === "type-ref")
        .map((s) => [s.kind, s.qualifier, s.name]),
    ).toEqual([
      ["call", ["pkg.sub"], "helper"],
      ["call", ["pkg.sub.deep"], "go"],
      ["call", ["pkg.sub.deep", "Klass()"], "run"],
      ["call", ["pkg.sub.deep"], "Klass"],
      ["call", ["pkg"], "top"],
      ["call", ["other", "sub"], "x"],
      ["call", ["local", "pkg", "sub"], "y"],
      ["type-ref", ["pkg.sub"], "Thing"],
    ]);
  });
});
