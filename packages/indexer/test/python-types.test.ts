import { describe, expect, it } from "vitest";
import type { TypeFact } from "../src/index.js";
import { extract, hasRef, indexFiles } from "./helpers.js";

const src = (...lines: string[]): string => lines.join("\n") + "\n";

async function factsOf(source: string, kind?: TypeFact["kind"]): Promise<TypeFact[]> {
  const { facts } = await extract("a.py", source);
  return facts.typeFacts.filter((f) => !kind || f.kind === kind);
}

/** `scopePath.name: <type>` in one line: the type name, `= callee()` for an initCall, `= a.b` for an initChain. */
function show(f: TypeFact): string {
  const what = f.typeName
    ? f.typeName
    : f.initCall
      ? `= ${[...f.initCall.qualifier, f.initCall.name].join(".")}()`
      : `= ${f.initChain!.join(".")}`;
  return `${f.kind} ${f.scopePath}.${f.name}: ${what}`;
}

describe("Python type facts: parameters", () => {
  it("annotated parameters; the receiver, *args and **kwargs are not typed", async () => {
    const source = src(
      "class R:",
      "    def m(self, queue: Queue, n: int = 3, *args: int, **kw: str) -> None: ...",
      "    @classmethod",
      "    def c(cls, x: Job): ...",
      "def f(a: Job, b, /, c: 'Worker', *, d: mod.Type = None): ...",
    );
    expect((await factsOf(source, "param")).map(show)).toEqual([
      "param R.m.queue: Queue",
      "param R.m.n: int",
      "param R.c.x: Job",
      "param f.a: Job",
      "param f.c: Worker",
      "param f.d: mod.Type",
    ]);
  });

  it("unwraps Optional, `X | None`, Union[X, None], Annotated and ClassVar; keeps the base of generics", async () => {
    const source = src(
      "def f(",
      "    a: Optional[Job], b: Job | None, c: None | Job, d: Union[Job, None], e: Annotated[Job, 'x'],",
      "    g: list[Job], h: dict[str, Job], i: typing.Optional[mod.Job], j: Callable[[A], B],",
      "): ...",
    );
    expect((await factsOf(source, "param")).map(show)).toEqual([
      "param f.a: Job",
      "param f.b: Job",
      "param f.c: Job",
      "param f.d: Job",
      "param f.e: Job",
      "param f.g: list",
      "param f.h: dict",
      "param f.i: mod.Job",
      "param f.j: Callable",
    ]);
  });

  it("says nothing for unions of several types, Any and bare special forms", async () => {
    const source = src(
      "def f(a: A | B, b: Any, c: Union[A, B], d: Final, e: 'A | B', g: typing.Any): ...",
    );
    expect(await factsOf(source, "param")).toEqual([]);
  });

  it("without an annotation, an evident default gives the type", async () => {
    const source = src("def f(a=0, b='x', c=Queue(), d=None, e=[], g=self_like): ...");
    expect((await factsOf(source, "param")).map(show)).toEqual([
      "param f.a: int",
      "param f.b: str",
      "param f.c: Queue",
      "param f.e: list",
      "param f.g: = self_like",
    ]);
  });

  it("parameters of nested functions belong to the nested function", async () => {
    const source = src("def outer(a: A):", "    def inner(b: B): ...");
    expect((await factsOf(source, "param")).map(show)).toEqual([
      "param outer.a: A",
      "param outer.inner.b: B",
    ]);
  });
});

describe("Python type facts: return types", () => {
  it("unwraps Optional, `T | None`, Awaitable, Coroutine, Iterator and AsyncIterator; `async def` returns its annotation", async () => {
    const source = src(
      "class P:",
      "    async def lease(self) -> Worker: ...",
      "    def a(self) -> Optional[Worker]: ...",
      "    def b(self) -> Worker | None: ...",
      "    def c(self) -> Awaitable[Worker]: ...",
      "    def d(self) -> Coroutine[Any, Any, Worker]: ...",
      "    def e(self) -> Iterator[Worker]: ...",
      "    def f(self) -> AsyncIterator[Worker]: ...",
      "    def g(self) -> Generator[Worker, None, None]: ...",
      "    def h(self) -> typing.Optional[Awaitable[mod.Worker]]: ...",
      "    async def i(self) -> Optional[Worker]: ...",
      "    def j(self) -> 'Worker': ...",
      "    def k(self) -> list[Worker]: ...",
    );
    expect((await factsOf(source, "return")).map(show)).toEqual([
      "return P.lease.lease: Worker",
      "return P.a.a: Worker",
      "return P.b.b: Worker",
      "return P.c.c: Worker",
      "return P.d.d: Worker",
      "return P.e.e: Worker",
      "return P.f.f: Worker",
      "return P.g.g: Worker",
      "return P.h.h: mod.Worker",
      "return P.i.i: Worker",
      "return P.j.j: Worker",
      "return P.k.k: list",
    ]);
  });

  it("`-> None`, `-> Any`, unions of several types and `__init__` have no return fact", async () => {
    const source = src(
      "class P:",
      "    def __init__(self) -> P: ...",
      "    def a(self) -> None: ...",
      "    def b(self) -> Any: ...",
      "    def c(self) -> A | B: ...",
      "    def d(self): ...",
    );
    expect(await factsOf(source, "return")).toEqual([]);
  });

  it("`-> Self` and classmethods returning `cls(...)` mean the receiver's own type", async () => {
    const source = src(
      "class P:",
      "    def a(self) -> Self: ...",
      "    def b(self):",
      "        return self",
      "    @classmethod",
      "    def make(cls):",
      "        return cls(1)",
    );
    expect((await factsOf(source, "return")).map(show)).toEqual([
      "return P.a.a: this",
      "return P.b.b: this",
      "return P.make.make: this",
    ]);
  });

  it("without an annotation the first evident `return` gives the type (not of nested functions)", async () => {
    const source = src(
      "class P:",
      "    def a(self):",
      "        return Widget()",
      "    def b(self):",
      "        return self.queue",
      "    def c(self):",
      "        def inner():",
      "            return Other()",
      "        return None",
      "    def d(self):",
      "        if x:",
      "            return",
      "        return mod.make(1)",
      "    def e(self):",
      "        return 1 + 2",
    );
    expect((await factsOf(source, "return")).map(show)).toEqual([
      "return P.a.a: Widget",
      "return P.b.b: = this.queue",
      "return P.c.inner.inner: Other",
      "return P.d.d: = mod.make()",
    ]);
  });

  it("module functions", async () => {
    const source = src("def make() -> Queue: ...", "async def amake() -> Optional[Queue]: ...");
    expect((await factsOf(source, "return")).map(show)).toEqual([
      "return make.make: Queue",
      "return amake.amake: Queue",
    ]);
  });
});

describe("Python type facts: fields", () => {
  it("class-level fields: annotated (dataclass) and initialised", async () => {
    const source = src(
      "@dataclass",
      "class Job:",
      "    id: str",
      "    queue: 'Queue'",
      "    tags: list[str] = field(default_factory=list)",
      "    pool = WorkerPool()",
      "    limit = 3",
      "    unknown = compute",
    );
    expect((await factsOf(source, "field")).map(show)).toEqual([
      "field Job.id: str",
      "field Job.queue: Queue",
      "field Job.tags: list",
      "field Job.pool: WorkerPool",
      "field Job.limit: int",
      "field Job.unknown: = compute",
    ]);
  });

  it("`self.x: T = ...`, `self.x = T(...)` and `self.x = param` (a typed parameter) in methods", async () => {
    const source = src(
      "class Runner:",
      "    def __init__(self, queue: Queue, pool: Optional[WorkerPool], cfg, n=3) -> None:",
      "        self.stats: RunnerStats = RunnerStats()",
      "        self.queue = queue",
      "        self.pool = pool",
      "        self.cfg = cfg",
      "        self.n = n",
      "        self.buf = Buffer()",
      "        self.helper = self.make()",
      "        self.me = self",
      "        self.items = []",
      "        self.cache = cache_factory(cfg)",
      "        self.other = pool.lease()",
      "        self.nothing = None",
      "        self.q, self.r = 1, 2",
    );
    expect((await factsOf(source, "field")).map(show)).toEqual([
      "field Runner.stats: RunnerStats",
      "field Runner.queue: Queue",
      "field Runner.pool: WorkerPool",
      "field Runner.n: int",
      "field Runner.buf: Buffer",
      "field Runner.helper: = this.make()",
      "field Runner.me: this",
      "field Runner.items: list",
      "field Runner.cache: = cache_factory()",
    ]);
  });

  it("fields are also learned from other methods, and from nested functions of a method", async () => {
    const source = src(
      "class Test:",
      "    def setUp(self):",
      "        self.queue = Queue()",
      "    def start(self):",
      "        def cb():",
      "            self.task = make_task()",
    );
    expect((await factsOf(source, "field")).map(show)).toEqual([
      "field Test.queue: Queue",
      "field Test.task: = make_task()",
    ]);
  });

  it("a declared field type wins over what assignments show", async () => {
    const source = src(
      "class A:",
      "    def setUp(self):",
      "        self.queue = OtherQueue()",
      "        self.pool = Pool()",
      "    queue: Queue",
      "    def __init__(self):",
      "        self.pool: Pool2 = make()",
    );
    expect((await factsOf(source, "field")).map(show)).toEqual([
      "field A.queue: Queue",
      "field A.pool: Pool2",
    ]);
  });

  it("an initialiser that starts from a parameter says nothing about the field", async () => {
    const source = src(
      "class A:",
      "    def __init__(self, factory, cfg: Config):",
      "        self.a = factory()",
      "        self.b = cfg.sub",
      "        self.c = cfg",
    );
    expect((await factsOf(source, "field")).map(show)).toEqual(["field A.c: Config"]);
  });

  it("`self.x = q or Queue()` and `x if c else Y()` offer their evident alternative", async () => {
    const source = src(
      "class A:",
      "    def __init__(self, queue: Optional[Queue] = None, pool=None, plain=None, flag=False):",
      "        self.queue = queue or Queue()",
      "        self.pool = pool or make_pool()",
      "        self.plain = plain or other",
      "        self.pick = Fast() if flag else Slow()",
      "        self.cfg = queue.cfg or Config()",
    );
    expect((await factsOf(source, "field")).map(show)).toEqual([
      "field A.queue: Queue", // the typed parameter comes first
      "field A.pool: = make_pool()",
      "field A.pick: Fast",
      "field A.cfg: Config", // the first alternative starts from a parameter: only Config() is left
    ]);
  });

  it("static methods have no receiver: `self.x = ...` there is not a field", async () => {
    const source = src(
      "class A:",
      "    @staticmethod",
      "    def f(self):",
      "        self.x = Queue()",
    );
    expect(await factsOf(source, "field")).toEqual([]);
  });
});

describe("Python type facts: locals and module variables", () => {
  it("`x = T(...)`, `x = await self.pool.lease()`, aliases and literals", async () => {
    const source = src(
      "class Runner:",
      "    async def dispatch(self, other):",
      "        worker = await self.pool.lease()",
      "        queue = self.queue",
      "        job = Job(1)",
      "        made = mod.Job.create()",
      "        again = other",
      "        text = 'x'",
      "        items = [1, 2]",
      "        pairs = {}",
      "        flag = True",
      "        me = self",
      "        chained = self.pool.lease().run()",
      "        x = a or b",
      "        y, z = 1, 2",
      "        for i in range(3):",
      "            pass",
      "        with open(p) as f:",
      "            pass",
    );
    expect((await factsOf(source, "local")).map(show)).toEqual([
      "local Runner.dispatch.worker: = this.pool.lease()",
      "local Runner.dispatch.queue: = this.queue",
      "local Runner.dispatch.job: Job",
      "local Runner.dispatch.made: = mod.Job.create()",
      "local Runner.dispatch.again: = other",
      "local Runner.dispatch.text: str",
      "local Runner.dispatch.items: list",
      "local Runner.dispatch.pairs: dict",
      "local Runner.dispatch.flag: bool",
      "local Runner.dispatch.me: this",
      "local Runner.dispatch.chained: = this.pool.lease().run()",
    ]);
  });

  it("a capitalised callee is an instantiation (typeName); other calls are `initCall`s for the resolver to follow", async () => {
    const source = src(
      "import pkg.sub",
      "class A:",
      "    def m(self):",
      "        a = Queue()",
      "        b = mod.Queue()",
      "        c = Outer.Inner()",
      "        d = ValueError('x')",
      "        e = make_queue()",
      "        f = mod.make()",
      "        g = Queue.create()",
      "        h = self.Inner()",
      "        i = Foo().build()",
      "        j = pkg.sub.Thing()",
      "        k = super().Base()",
    );
    expect((await factsOf(source, "local")).map(show)).toEqual([
      "local A.m.a: Queue",
      "local A.m.b: mod.Queue",
      "local A.m.c: Outer.Inner",
      "local A.m.d: ValueError",
      "local A.m.e: = make_queue()",
      "local A.m.f: = mod.make()",
      "local A.m.g: = Queue.create()",
      "local A.m.h: = this.Inner()", // `this` and call results are not module or class names
      "local A.m.i: = Foo().build()",
      "local A.m.j: = pkg.sub.Thing()", // the root of `import pkg.sub` is one segment "pkg.sub"
      "local A.m.k: = super.Base()",
    ]);
  });

  it("annotated locals use the annotation, even without a value", async () => {
    const source = src(
      "def f():",
      "    a: Job = make()",
      "    b: Optional[Job] = None",
      "    c: Job",
      "    d: A | B = A()",
    );
    expect((await factsOf(source, "local")).map(show)).toEqual([
      "local f.a: Job",
      "local f.b: Job",
      "local f.c: Job",
      "local f.d: A",
    ]);
  });

  it('module variables have the scope path `""`; locals of nested functions their own', async () => {
    const source = src(
      "queue = Queue()",
      "conf: Config = load()",
      "def outer():",
      "    a = A()",
      "    def inner():",
      "        b = B()",
    );
    const facts = await factsOf(source, "local");
    expect(facts.map((f) => [f.scopePath, f.name])).toEqual([
      ["", "queue"],
      ["", "conf"],
      ["outer", "a"],
      ["outer.inner", "b"],
    ]);
  });

  it("builtins called without an import give builtin types, so a class named alike is not guessed", async () => {
    const source = src(
      "def f(xs, p):",
      "    items = list()",
      "    pairs = dict(a=1)",
      "    seen = set()",
      "    ordered = sorted(xs)",
      "    handle = open(p)",
      "    text = str(3)",
      "    mine = mod.list()",
      "    other = custom()",
    );
    expect((await factsOf(source, "local")).map(show)).toEqual([
      "local f.items: list",
      "local f.pairs: dict",
      "local f.seen: set",
      "local f.ordered: list",
      "local f.handle: TextIOWrapper",
      "local f.text: str",
      "local f.mine: = mod.list()",
      "local f.other: = custom()",
    ]);
  });

  it("`x = a or B()` and `A() if c else B()` take the first evident alternative; two aliases say nothing", async () => {
    const source = src(
      "def f(a, c):",
      "    x = a or B()",
      "    y = A() if c else B()",
      "    z = a or c",
      "    w = (await a.get()) or Q()",
    );
    expect((await factsOf(source, "local")).map(show)).toEqual([
      "local f.x: B",
      "local f.y: A",
      "local f.w: = a.get()",
    ]);
  });

  it("identical facts are emitted once", async () => {
    const source = src("def f():", "    x = A()", "    x = A()", "    x = B()");
    expect((await factsOf(source, "local")).map(show)).toEqual(["local f.x: A", "local f.x: B"]);
  });

  it("class-level statements are fields, never locals", async () => {
    const source = src("class A:", "    x = B()", "    def m(self):", "        y = C()");
    expect((await factsOf(source)).map(show)).toEqual(["local A.m.y: C", "field A.x: B"]);
  });
});

describe("Python type facts drive the heuristic resolver", () => {
  const files = {
    "pool.py": src(
      "class Worker:",
      "    async def run(self, job) -> None: ...",
      "class WorkerPool:",
      "    async def lease(self) -> Worker: ...",
      "    def maybe(self) -> Optional[Worker]: ...",
      "    def later(self) -> Awaitable[Worker]: ...",
      "    def workers(self) -> Iterator[Worker]: ...",
      "class Queue:",
      "    async def pop(self) -> 'Job | None': ...",
      "    def push(self, job) -> Self: ...",
      "    @classmethod",
      "    def make(cls):",
      "        return cls()",
      "class Cache: ...",
      "class Registry:",
      "    def get_cache(self):",
      "        return Cache()",
    ),
    "run.py": src(
      "from pool import Queue, WorkerPool, Worker, Registry", // 1
      "", // 2
      "class Runner:", // 3
      "    queue: Queue", // 4
      "    def __init__(self, pool: WorkerPool, reg: Registry) -> None:", // 5
      "        self.pool = pool", // 6
      "        self.fresh = Queue()", // 7
      "        self.reg = reg", // 8
      "", // 9
      "    async def go(self, other: Worker):", // 10
      "        w = await self.pool.lease()", // 11
      "        await w.run(1)", // 12
      "        self.pool.maybe().run(2)", // 13
      "        self.pool.later().run(3)", // 14
      "        self.fresh.push(1).push(2)", // 15
      "        self.queue.push(3)", // 16
      "        other.run(4)", // 17
      "        q = Queue.make()", // 18
      "        q.push(5)", // 19
      "        c = self.reg.get_cache()", // 20
      "        c.missing()", // 21
    ),
  };

  it("resolves calls through parameter, field, local and return types", async () => {
    const { index } = await indexFiles(files);
    const calls = (to: string) =>
      index.refs
        .filter((r) => r.from === "run.py#Runner.go" && r.to === to && r.kind === "call")
        .map((r) => r.site.startLine);
    expect(calls("pool.py#WorkerPool.lease")).toEqual([11]);
    expect(calls("pool.py#Worker.run")).toEqual([12, 13, 14, 17]);
    expect(calls("pool.py#WorkerPool.maybe")).toEqual([13]);
    expect(calls("pool.py#WorkerPool.later")).toEqual([14]);
    expect(calls("pool.py#Queue.push")).toEqual([15, 15, 16, 19]); // push(1).push(2) is Self-typed
    expect(calls("pool.py#Queue.make")).toEqual([18]);
    expect(calls("pool.py#Registry.get_cache")).toEqual([20]);
  });

  it("`self.queue = queue or Queue()` types the field, and a builtin-typed local is not guessed from its name", async () => {
    const { index } = await indexFiles({
      "q.py": src(
        "class Queue:",
        "    def pop(self): ...",
        "class Stack:",
        "    def append(self, x): ...",
      ),
      "use.py": src(
        "from q import Queue, Stack",
        "class Runner:",
        "    def __init__(self, queue: Queue | None = None):",
        "        self.queue = queue or Queue()",
        "    def go(self):",
        "        self.queue.pop()",
        "        stack = list()",
        "        stack.append(1)",
      ),
    });
    expect(hasRef(index, "use.py#Runner.go", "q.py#Queue.pop", "call")).toBe(true);
    // without the builtin type, `stack.append` would be guessed to be `Stack.append`
    expect(hasRef(index, "use.py#Runner.go", "q.py#Stack.append", "call")).toBe(false);
  });

  it("a dataclass-style field and an unannotated `self.x = param` both give the receiver's type", async () => {
    const { index } = await indexFiles(files);
    expect(hasRef(index, "run.py#Runner.go", "pool.py#Queue.push", "call")).toBe(true);
  });
});
