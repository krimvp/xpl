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

async function sitesOf(source: string, path = "a.ts", kinds?: string[]): Promise<string[]> {
  const { facts } = await extract(path, source);
  return facts.sites.filter((s) => !kinds || kinds.includes(s.kind)).map((s) => show(source, s));
}

describe("call sites", () => {
  it("plain, member, chained, static and constructor calls; the whole call expression is the site", async () => {
    const source = src(
      "function f() {",
      "  foo();",
      "  a.b.c(1);",
      "  new Queue(10);",
      "  ns.Klass.create();",
      "  new ns.Thing();",
      "}",
    );
    expect(await sitesOf(source, "a.ts", ["call"])).toEqual([
      "call foo «foo()»",
      "call a.b.c «a.b.c(1)»",
      "call Queue «new Queue(10)»",
      "call ns.Klass.create «ns.Klass.create()»",
      "call ns.Thing «new ns.Thing()»",
    ]);
  });

  it("gives exact line and column ranges (1-based, inclusive)", async () => {
    const { facts } = await extract("a.ts", src("function f() {", "  foo(1);", "}"));
    expect(facts.sites[0]!.site).toEqual({ startLine: 2, startCol: 3, endLine: 2, endCol: 8 });
  });

  it("normalises the receiver to `this` and keeps `super`", async () => {
    const source = src(
      "class A extends B {",
      "  m() {",
      "    this.run();",
      "    this.queue.pop();",
      "    super.m();",
      "    super();",
      "  }",
      "}",
    );
    expect(await sitesOf(source, "a.ts", ["call"])).toEqual([
      "call this.run «this.run()»",
      "call this.queue.pop «this.queue.pop()»",
      "call super.m «super.m()»",
      "call super.constructor «super()»",
    ]);
  });

  it("spells calls on call results, constructors, casts and non-null receivers", async () => {
    const source = src(
      "function f() {",
      "  this.pool.lease().run();",
      "  new Foo().bar();",
      "  (x as Foo).baz();",
      "  this.pool!.lease();",
      "  a?.b?.();",
      "  (await this.pool.lease()).run();",
      "  getRunner().start();",
      "}",
    );
    expect(await sitesOf(source, "a.ts", ["call"])).toEqual([
      "call this.pool.lease().run «this.pool.lease().run()»",
      "call this.pool.lease «this.pool.lease()»",
      "call Foo().bar «new Foo().bar()»", // the receiver of bar() is an instance: `Foo()`
      "call Foo «new Foo()»",
      "call :Foo.baz «(x as Foo).baz()»", // ":Foo" = a value of declared type Foo
      "call this.pool.lease «this.pool!.lease()»",
      "call a.b «a?.b?.()»",
      "call this.pool.lease().run «(await this.pool.lease()).run()»",
      "call this.pool.lease «this.pool.lease()»",
      "call getRunner().start «getRunner().start()»",
      "call getRunner «getRunner()»",
    ]);
  });

  it("reports only the callee when a call spans more than 10 lines", async () => {
    const args = Array.from({ length: 12 }, (_, i) => `    ${i},`);
    const source = src("function f() {", "  this.queue.requeue(", ...args, "  );", "}");
    expect(await sitesOf(source, "a.ts", ["call"])).toEqual([
      "call this.queue.requeue «this.queue.requeue»",
    ]);
  });

  it("keeps the whole call when it spans exactly 10 lines, drops to the callee at 11", async () => {
    const ten = src(
      "function f() {",
      "  run(",
      ...Array.from({ length: 8 }, (_, i) => `    ${i},`),
      "  );",
      "}",
    );
    expect(await sitesOf(ten, "a.ts", ["call"])).toEqual([
      "call run «run(⏎    0,⏎    1,⏎    2,⏎    3,⏎    4,⏎    5,⏎    6,⏎    7,⏎  )»",
    ]);
    const eleven = src(
      "function f() {",
      "  run(",
      ...Array.from({ length: 9 }, (_, i) => `    ${i},`),
      "  );",
      "}",
    );
    expect(await sitesOf(eleven, "a.ts", ["call"])).toEqual(["call run «run»"]);
  });

  it("uses only the last member for a callee that itself spans many lines (fluent chains)", async () => {
    const args = Array.from({ length: 12 }, (_, i) => `      ${i},`);
    const source = src("function f() {", "  build(", ...args, "  )", "    .finish();", "}");
    const { facts } = await extract("a.ts", source);
    const finish = facts.sites.find((s) => s.name === "finish")!;
    expect(covered(source, finish.site)).toBe("finish");
    expect(facts.sites.find((s) => s.name === "build")!.site.endLine).toBeLessThan(
      finish.site.startLine,
    );
  });

  it("emits JSX components (capitalised names and member tags) as calls, not intrinsic elements", async () => {
    const source = src(
      "const x = (",
      "  <div>",
      "    <Header title='a' />",
      "    <ns.Sub>text</ns.Sub>",
      "    <span />",
      "  </div>",
      ");",
    );
    expect(await sitesOf(source, "x.tsx", ["call"])).toEqual([
      "call Header «<Header title='a' />»",
      "call ns.Sub «<ns.Sub>»",
    ]);
  });

  it("skips calls whose receiver cannot be spelled", async () => {
    const source = src(
      "function f() {",
      "  arr[0].run();",
      "  fns[1]();",
      "  (a || b).c();",
      "  ok();",
      "}",
    );
    expect(await sitesOf(source, "a.ts", ["call"])).toEqual(["call ok «ok()»"]);
  });

  it("decorator calls are call sites", async () => {
    const source = src("@Injectable()", "class S {", "  @Input() name = '';", "}");
    expect(await sitesOf(source, "a.ts", ["call"])).toEqual([
      "call Injectable «Injectable()»",
      "call Input «Input()»",
    ]);
  });
});

describe("write sites", () => {
  it("assignments, compound assignments and updates to names and members", async () => {
    const source = src(
      "class A {",
      "  m() {",
      "    this.count = 1;",
      "    this.total += 2;",
      "    this.n++;",
      "    counter = 3;",
      "    obj.field = 4;",
      "    a.b.c -= 1;",
      "    [x, y] = [1, 2];",
      "    arr[0] = 1;",
      "  }",
      "}",
    );
    expect(await sitesOf(source, "a.ts", ["write"])).toEqual([
      "write this.count «this.count = 1»",
      "write this.total «this.total += 2»",
      "write this.n «this.n++»",
      "write counter «counter = 3»",
      "write obj.field «obj.field = 4»",
      "write a.b.c «a.b.c -= 1»",
    ]);
  });

  it("reports only the target when the assignment spans more than 10 lines", async () => {
    const body = Array.from({ length: 12 }, (_, i) => `    k${i}: ${i},`);
    const source = src("function f() {", "  this.config = {", ...body, "  };", "}");
    expect(await sitesOf(source, "a.ts", ["write"])).toEqual(["write this.config «this.config»"]);
  });
});

describe("heritage and type-ref sites", () => {
  it("extends / implements / interface extends, qualified and generic", async () => {
    const source = src(
      "class A extends Base {}",
      "class B extends ns.Base<T> implements I, ns.J, K<string> {}",
      "interface C extends D, E.F {}",
      "class D2 extends mixin(Base) {}",
    );
    expect(await sitesOf(source, "a.ts", ["extends", "implements"])).toEqual([
      "extends Base «Base»",
      "extends ns.Base «ns.Base»",
      "implements I «I»",
      "implements ns.J «ns.J»",
      "implements K «K»",
      "extends D «D»",
      "extends E.F «E.F»",
    ]);
  });

  it("type references in every position, but not declaration names, type parameters or heritage", async () => {
    const source = src(
      "class Box<T extends Base> implements Item {",
      "  private items: Item[] = [];",
      "  add(x: T, y: Other): Promise<Result> {",
      "    const z: Local = null as any;",
      "    return call<Generic>(x) as Cast;",
      "  }",
      "}",
      "type Alias<U> = Foo<U> | ns.Bar;",
      "function guard(x: unknown): x is Guarded {}",
      "let m: { [K in keyof Src]: Val };",
      "type Cond<V> = V extends Array<infer W> ? string : Never;",
    );
    expect(await sitesOf(source, "a.ts", ["type-ref"])).toEqual([
      "type-ref Base «Base»",
      "type-ref Item «Item»",
      "type-ref Other «Other»",
      "type-ref Promise «Promise»",
      "type-ref Result «Result»",
      "type-ref Local «Local»",
      "type-ref Generic «Generic»",
      "type-ref Cast «Cast»",
      "type-ref Foo «Foo»",
      "type-ref ns.Bar «ns.Bar»",
      "type-ref Guarded «Guarded»",
      "type-ref Src «Src»",
      "type-ref Val «Val»",
      "type-ref Array «Array»",
      "type-ref Never «Never»",
    ]);
  });
});

describe("imports", () => {
  it("bindings for default, named, aliased, namespace, type-only and require forms", async () => {
    const source = src(
      "import def, { a, b as c, type D, type E as F } from './mod';",
      "import * as ns from '../ns.js';",
      "import type { T } from './types';",
      "import type X from './x';",
      "import fs = require('fs');",
      "const req = require('./req');",
      "const { r1, r2: r3 } = require('./destructured');",
    );
    const { facts } = await extract("a.ts", source);
    expect(
      facts.imports.map(
        (i) =>
          `${i.localName} <- ${i.module} ${i.importedName ?? "(module)"} «${covered(source, i.site)}»`,
      ),
    ).toEqual([
      "def <- ./mod default «def»",
      "a <- ./mod a «a»",
      "c <- ./mod b «b as c»",
      "D <- ./mod D «type D»",
      "F <- ./mod E «type E as F»",
      "ns <- ../ns.js (module) «* as ns»",
      "T <- ./types T «T»",
      "X <- ./x default «X»",
      "fs <- fs (module) «fs = require('fs')»",
      "req <- ./req (module) «req = require('./req')»",
      "r1 <- ./destructured r1 «r1»",
      "r3 <- ./destructured r2 «r2: r3»",
    ]);
  });

  it("imports without bindings are `import` sites named by the specifier", async () => {
    const source = src(
      "import './side-effect';",
      "async function f() {",
      "  const m = await import('./dyn');",
      "  require('./bare');",
      "  const n = require(dynamicName);",
      "}",
    );
    expect(await sitesOf(source, "a.ts", ["import"])).toEqual([
      "import ./side-effect «import './side-effect';»",
      "import ./dyn «import('./dyn')»",
      "import ./bare «require('./bare')»",
    ]);
  });

  it("type-only bindings are flagged: `import type`, `{ type A }`, default and namespace forms", async () => {
    const source = src(
      "import type { A } from './a';",
      "import { type B, C, type D as E } from './b';",
      "import type F from './f';",
      "import type * as ns from './n';",
      "import type G, { H } from './g';",
      "import def, * as all from './all';",
    );
    const { facts } = await extract("a.ts", source);
    expect(facts.imports.map((i) => `${i.localName}${i.typeOnly ? " (type)" : ""}`)).toEqual([
      "A (type)",
      "B (type)",
      "C",
      "E (type)",
      "F (type)",
      "ns (type)",
      "G (type)",
      "H (type)",
      "def",
      "all",
    ]);
  });

  it("type-only re-exports are flagged too, including `export type *`, which the grammar reads as an ERROR", async () => {
    const source = src(
      "export type { A } from './a';",
      "export { type B, C } from './b';",
      "export type * from './star';",
      "export type * as ns from './ns';",
      "export * from './star2';",
      "export type { Local };",
    );
    const { facts } = await extract("a.ts", source);
    expect(
      facts.exports!.map((e) => `${e.name}${e.typeOnly ? " (type)" : ""} <- ${e.module ?? "-"}`),
    ).toEqual([
      "A (type) <- ./a",
      "B (type) <- ./b",
      "C <- ./b",
      "* (type) <- ./star",
      "ns (type) <- ./ns",
      "* <- ./star2",
      "Local (type) <- -",
    ]);
  });

  it("does not report a require binding twice", async () => {
    const { facts } = await extract("a.js", src("const x = require('./x');"));
    expect(facts.imports).toHaveLength(1);
    expect(facts.sites.filter((s) => s.kind === "import")).toHaveLength(0);
  });

  it("export facts: default aliases, renames and re-exports", async () => {
    const source = src(
      "export { a, c as d } from './re';",
      "export * from './star';",
      "export * as nsx from './nsx';",
      "export { local as default };",
      "export type { T };",
      "export { local1, local2 as renamed };",
      "export default class Foo {}",
    );
    const { facts } = await extract("a.ts", source);
    expect(
      facts
        .exports!.map((e) => ({ ...e, site: e.site ? covered(source, e.site) : undefined }))
        .map((e) => Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined))),
    ).toEqual([
      { name: "a", module: "./re", importedName: "a", site: "a" },
      { name: "d", module: "./re", importedName: "c", site: "c as d" },
      { name: "*", module: "./star", site: "export * from './star';" },
      { name: "nsx", module: "./nsx", site: "export * as nsx from './nsx';" },
      { name: "default", localName: "local" },
      { name: "T", localName: "T", typeOnly: true },
      { name: "local1", localName: "local1" },
      { name: "renamed", localName: "local2" },
      { name: "default", localName: "Foo" },
    ]);
    const identifier = await extract("b.ts", src("const foo = 1;", "export default foo;"));
    expect(identifier.facts.exports).toEqual([{ name: "default", localName: "foo" }]);
  });
});

describe("type facts", () => {
  const facts = async (source: string): Promise<string[]> => {
    const { facts } = await extract("a.ts", source);
    return facts.typeFacts
      .map(
        (f: TypeFact) =>
          `${f.kind} ${f.scopePath || "<module>"}.${f.name} : ${f.typeName ?? ""}${f.initCall ? `= ${[...f.initCall.qualifier, f.initCall.name].join(".")}()` : ""}`,
      )
      .sort();
  };

  it("fields, parameters, returns and locals (the examples of the spec)", async () => {
    const source = src(
      "class Runner {",
      "  private readonly queue: Queue;",
      "  async dispatch(job: Job): Promise<void> {",
      "    const worker = await this.pool.lease();",
      "    const q = new Queue(1);",
      "    const n: Config = load();",
      "  }",
      "}",
      "class WorkerPool {",
      "  lease(): Promise<Worker> { return p; }",
      "}",
    );
    expect(await facts(source)).toEqual(
      [
        "field Runner.queue : Queue", // field `Runner.queue: Queue`
        "return WorkerPool.lease.lease : Worker", // `WorkerPool.lease` returns Worker (Promise unwrapped)
        "param Runner.dispatch.job : Job",
        "local Runner.dispatch.worker : = this.pool.lease()", // initialised by `this.pool.lease()`
        "local Runner.dispatch.q : Queue", // `new Queue()`
        "local Runner.dispatch.n : Config", // an annotation beats the initialiser
      ].sort(),
    );
  });

  it("unwraps Promise for returns only, strips generics, reduces T | undefined", async () => {
    const source = src(
      "class A {",
      "  a(): Promise<Worker> { return x; }",
      "  b(): Worker[] { return x; }",
      "  c(): Awaited<Promise<Item>> { return x; }",
      "  d: Promise<Worker>;",
      "  e: Repo<User>;",
      "  f: Worker | undefined;",
      "  g: Worker | null | undefined;",
      "  h: Worker | Other;",
      "  i: ns.Deep.Type;",
      "  j?: string;",
      "  k: (a: number) => void;",
      "  l(): this { return this; }",
      "  m(): void {}",
      "}",
    );
    const { facts: f } = await extract("a.ts", source);
    const byKey = Object.fromEntries(
      f.typeFacts.map((t) => [`${t.kind}:${t.scopePath}.${t.name}`, t.typeName]),
    );
    expect(byKey).toMatchObject({
      "return:A.a.a": "Worker",
      "return:A.b.b": "Array",
      "return:A.c.c": "Item",
      "field:A.d": "Promise",
      "field:A.e": "Repo",
      "field:A.f": "Worker",
      "field:A.g": "Worker",
      "field:A.i": "ns.Deep.Type",
      "field:A.j": "string",
      "return:A.l.l": "this",
    });
    expect(byKey["field:A.h"]).toBeUndefined();
    expect(byKey["field:A.k"]).toBeUndefined();
    expect(byKey["return:A.m.m"]).toBeUndefined(); // void carries no information
  });

  it("parameter properties are fields of the class; constructor assignments infer field types", async () => {
    const source = src(
      "class Svc {",
      "  declared: Declared;",
      "  constructor(private readonly pool: WorkerPool, public config: Config, plain: Plain) {",
      "    this.a = new Alpha();",
      "    this.b = plain;",
      "    this.declared = new Other();",
      "    this.c = makeC();",
      "  }",
      "}",
    );
    const { facts: f } = await extract("a.ts", source);
    const fields = f.typeFacts
      .filter((t) => t.kind === "field")
      .map((t) => `${t.name}:${t.typeName ?? ""}${t.initCall ? "=" + t.initCall.name + "()" : ""}`);
    expect(fields.sort()).toEqual([
      "a:Alpha",
      "b:Plain",
      "c:=makeC()",
      "config:Config",
      "declared:Declared",
      "pool:WorkerPool",
    ]);
    const params = f.typeFacts
      .filter((t) => t.kind === "param")
      .map((t) => `${t.scopePath}.${t.name}`);
    expect(params.sort()).toEqual([
      "Svc.constructor.config",
      "Svc.constructor.plain",
      "Svc.constructor.pool",
    ]);
  });

  it("module-level variables are locals of the module scope", async () => {
    const source = src(
      "const queue: Queue = create();",
      "export const runner = new Runner();",
      "const n = getN();",
    );
    expect(await facts(source)).toEqual(
      [
        "local <module>.queue : Queue",
        "local <module>.runner : Runner",
        "local <module>.n : = getN()",
      ].sort(),
    );
  });

  it("locals and parameters of functions declared as consts are scoped to that function", async () => {
    const source = src(
      "const run = (job: Job) => {",
      "  const w = new Worker();",
      "  w.go();",
      "};",
    );
    expect(await facts(source)).toEqual(["local run.w : Worker", "param run.job : Job"]);
  });

  it("does not attribute parameters of function types or overload signatures to anyone", async () => {
    const source = src(
      "type Fn = (message: string) => void;",
      "function over(a: string): void;",
      "function over(a: number): void;",
      "function over(a: any): void {}",
      "interface I { m(x: Foo): void }",
    );
    // `a: any` has no usable type; only the interface method's parameter belongs to a symbol.
    expect(await facts(source)).toEqual(["param I.m.x : Foo"]);
  });

  it("literals and casts give evident local types; type parameters give none", async () => {
    const source = src(
      "function f<T>(x: T, y: string) {",
      "  const s = 'text';",
      "  const n = 5;",
      "  const list = [1];",
      "  const c = thing as Widget;",
      "  const t: T = x;",
      "}",
    );
    expect(await facts(source)).toEqual(
      [
        "param f.y : string",
        "local f.s : string",
        "local f.n : number",
        "local f.list : Array",
        "local f.c : Widget",
      ].sort(),
    );
  });

  it("aliases (property reads, identifiers, this) become receiver chains", async () => {
    const source = src(
      "class A {",
      "  m(p: Param) {",
      "    const q = this.queue;",
      "    const i = this.model.index;",
      "    const s = this;",
      "    const again = q;",
      "    const called = this.pool.lease();",
      "  }",
      "}",
    );
    const { facts: f } = await extract("a.ts", source);
    const local = (name: string) => f.typeFacts.find((t) => t.kind === "local" && t.name === name)!;
    expect(local("q").initChain).toEqual(["this", "queue"]);
    expect(local("i").initChain).toEqual(["this", "model", "index"]);
    expect(local("s").initChain).toEqual(["this"]);
    expect(local("again").initChain).toEqual(["q"]);
    expect(local("called").initCall).toEqual({ qualifier: ["this", "pool"], name: "lease" });
    expect(local("called").initChain).toBeUndefined();
  });

  it("returns of arrow functions with an expression body are inferred from `new` and calls", async () => {
    const source = src("const make = () => new Widget();", "const load = () => fetchThing();");
    const { facts: f } = await extract("a.ts", source);
    expect(f.typeFacts).toEqual([
      { scopePath: "make", name: "make", kind: "return", typeName: "Widget" },
      {
        scopePath: "load",
        name: "load",
        kind: "return",
        initCall: { qualifier: [], name: "fetchThing" },
      },
    ]);
  });
});

describe("classifySite agrees with the sites `extract` emits", () => {
  const source = src(
    "import { Queue, type Job } from './queue';", // 1
    "import * as ns from './ns';", // 2
    "import def from './def';", // 3
    "export { Queue as Q2 } from './queue';", // 4
    "class Runner extends Base implements Iface {", // 5
    "  private queue: Queue;", // 6
    "  private map: Map<string, Job> = new Map();", // 7
    "  constructor(queue: Queue) {", // 8
    "    super();", // 9
    "    this.queue = queue;", // 10
    "  }", // 11
    "  async run(job: Job): Promise<void> {", // 12
    "    const w = await this.pool.lease();", // 13
    "    w.run(job);", // 14
    "    this.count++;", // 15
    "    counter = 1;", // 16
    "    ns.helper(new ns.Thing(), def);", // 17
    "    const x = <Widget prop={1}>text</Widget>;", // 18
    "    this.queue.requeue(", // 19
    "      job,", // 20
    "    );", // 21
    "  }", // 22
    "}", // 23
    "interface Sub extends Parent {}", // 24
    "let v: ns.Type = undefined as unknown as Other;", // 25
  );

  it("every emitted call / extends / implements / type-ref / write site is found by classifySite", async () => {
    const ex = await extract("a.tsx", source);
    const key = (kind: string, s: Span) =>
      `${kind} ${s.startLine}:${s.startCol}-${s.endLine}:${s.endCol}`;
    const classified = ex.withTree((ctx) => {
      const found = new Set<string>();
      const identifiers = ctx.tree.rootNode.descendantsOfType([
        "identifier",
        "property_identifier",
        "type_identifier",
        "private_property_identifier",
        "shorthand_property_identifier",
        "super",
      ]);
      for (const node of identifiers) {
        const r = ex.pack.classifySite(
          ctx,
          node.startPosition.row + 1,
          node.startPosition.column + 1,
        );
        if (r) found.add(key(r.kind, r.site));
      }
      return found;
    });
    const missing = ex.facts.sites
      .filter((s) => s.kind !== "import")
      .filter((s) => !classified.has(key(s.kind, s.site)))
      .map((s) => show(source, s));
    expect(missing).toEqual([]);
    expect(ex.facts.sites.length).toBeGreaterThan(20);
  });

  it("classifies import specifiers, including re-exports, with the binding's span", async () => {
    const ex = await extract("a.ts", source);
    const at = (line: number, col: number) =>
      ex.withTree((ctx) => ex.pack.classifySite(ctx, line, col));
    /** Position of the identifier a SCIP occurrence would point at: the imported (else local) name in the site. */
    const identifierPosition = (b: { localName: string; importedName?: string; site: Span }) => {
      const text = covered(source, b.site);
      const name = b.importedName && b.importedName !== "default" ? b.importedName : b.localName;
      return {
        line: b.site.startLine,
        col: b.site.startCol + text.search(new RegExp(`\\b${name}\\b`)),
      };
    };
    for (const b of ex.facts.imports) {
      const { line, col } = identifierPosition(b);
      // `import { type Job }` is a type reference, like `import type`: the kind follows the statement's syntax
      expect(at(line, col), b.localName).toEqual({
        kind: b.typeOnly ? "type-ref" : "import",
        site: b.site,
      });
    }
    expect(ex.facts.imports.filter((b) => b.typeOnly).map((b) => b.localName)).toEqual(["Job"]);
    const reexport = ex.facts.exports!.find((e) => e.module)!;
    expect(at(reexport.site!.startLine, reexport.site!.startCol)).toEqual({
      kind: "import",
      site: reexport.site,
    });
  });

  it("classifies the specifiers of type-only imports and re-exports as type references, run-time ones as imports", async () => {
    const text = src(
      "import type { A } from './a';", // 1
      "import { type B, C } from './b';", // 2
      "import type * as ns from './n';", // 3
      "export type { D } from './d';", // 4
      "export { type E, F } from './e';", // 5
      "import { G } from './g';", // 6
    );
    const ex = await extract("a.ts", text);
    const at = (line: number, col: number) =>
      ex.withTree((ctx) => ex.pack.classifySite(ctx, line, col));
    const kindAt = (line: number, needle: string) =>
      at(line, text.split("\n")[line - 1]!.indexOf(needle) + 1)?.kind;
    expect(kindAt(1, "A")).toBe("type-ref");
    expect(kindAt(2, "B")).toBe("type-ref");
    expect(kindAt(2, "C")).toBe("import");
    expect(kindAt(4, "D")).toBe("type-ref");
    expect(kindAt(5, "E")).toBe("type-ref");
    expect(kindAt(5, "F")).toBe("import");
    expect(kindAt(6, "G")).toBe("import");
    // The quoted module of a type-only statement is a type reference (the mapper drops it when names are
    // imported); a run-time statement's is not classified (the mapper makes it an import).
    expect(kindAt(3, "'./n'")).toBe("type-ref");
    expect(kindAt(1, "'./a'")).toBe("type-ref");
    expect(kindAt(6, "'./g'")).toBeUndefined();
    expect(at(3, text.split("\n")[2]!.indexOf("'./n'") + 1)?.site).toEqual({
      startLine: 3,
      startCol: 26,
      endLine: 3,
      endCol: 30,
    });
  });

  it("reads are classified (bare names flagged); declarations, punctuation and positions outside the file are nothing", async () => {
    const ex = await extract(
      "a.ts",
      src(
        "class A {",
        "  m(job: Job) {",
        "    const w = job;",
        "    w.run(job, other);",
        "  }",
        "}",
        "const o = { other };",
      ),
    );
    const at = (line: number, col: number) =>
      ex.withTree((ctx) => ex.pack.classifySite(ctx, line, col));
    expect(at(1, 7)).toBeUndefined(); // class name (declaration)
    expect(at(2, 3)).toBeUndefined(); // method name (declaration)
    expect(at(2, 5)).toBeUndefined(); // parameter name (declaration)
    expect(at(3, 11)).toBeUndefined(); // `w` (declaration)
    expect(at(3, 15)).toEqual({
      kind: "read",
      site: { startLine: 3, startCol: 15, endLine: 3, endCol: 17 },
      bare: true,
    }); // `job`: a name in a value position; SCIP says it is a parameter, and the mapper drops it
    expect(at(4, 5)).toMatchObject({ kind: "read", bare: true }); // receiver `w`
    expect(at(4, 7)).toMatchObject({ kind: "call" }); // `run`
    expect(at(4, 11)).toMatchObject({ kind: "read", bare: true }); // argument `job`
    expect(at(4, 16)).toMatchObject({ kind: "read", bare: true }); // argument `other`
    expect(at(7, 13)).toMatchObject({ kind: "read", bare: true }); // shorthand `{ other }`
    expect(at(4, 6)).toBeUndefined(); // the `.` punctuation
    expect(at(99, 1)).toBeUndefined(); // outside the file
  });

  it("classifies the specific kinds", async () => {
    const ex = await extract("a.tsx", source);
    const at = (line: number, col: number) =>
      ex.withTree((ctx) => ex.pack.classifySite(ctx, line, col));
    expect(at(5, 22)).toEqual({
      kind: "extends",
      site: { startLine: 5, startCol: 22, endLine: 5, endCol: 25 },
    });
    expect(at(5, 40)).toMatchObject({ kind: "implements" });
    expect(at(24, 23)).toMatchObject({ kind: "extends" });
    expect(at(6, 19)).toMatchObject({ kind: "type-ref" });
    expect(at(10, 10)).toMatchObject({ kind: "write" }); // this.queue = queue
    expect(at(15, 10)).toMatchObject({ kind: "write" }); // this.count++
    expect(at(16, 5)).toMatchObject({ kind: "write" }); // counter = 1
    expect(at(17, 8)).toMatchObject({ kind: "call" }); // ns.helper(...)
    expect(at(18, 16)).toMatchObject({ kind: "call" }); // <Widget ...>
    expect(at(9, 5)).toMatchObject({ kind: "call" }); // super()
    // A multi-line call is classified with the same site as `extract` (the whole call, 3 lines)
    expect(at(19, 17)).toEqual({
      kind: "call",
      site: { startLine: 19, startCol: 5, endLine: 21, endCol: 5 },
    });
  });
});

describe("resolveModule (TypeScript)", () => {
  const repo = (paths: string[]) => ({
    root: "/x",
    files: new Set(paths),
    filesInDir: () => [],
    readText: () => undefined,
  });
  const resolve = async (spec: string, from: string, paths: string[]) => {
    const { pack } = await extract("a.ts", "export {};\n");
    return pack.resolveModule(spec, from, repo(paths));
  };

  it("resolves relative specifiers with extension probing", async () => {
    const files = [
      "src/a.ts",
      "src/b.ts",
      "src/c.tsx",
      "src/d.d.ts",
      "src/e.js",
      "src/f.json",
      "lib/x.ts",
    ];
    expect(await resolve("./b", "src/a.ts", files)).toEqual(["src/b.ts"]);
    expect(await resolve("./c", "src/a.ts", files)).toEqual(["src/c.tsx"]);
    expect(await resolve("./d", "src/a.ts", files)).toEqual(["src/d.d.ts"]);
    expect(await resolve("./e", "src/a.ts", files)).toEqual(["src/e.js"]);
    expect(await resolve("./f.json", "src/a.ts", files)).toEqual(["src/f.json"]);
    expect(await resolve("../lib/x", "src/a.ts", files)).toEqual(["lib/x.ts"]);
    expect(await resolve("./b.ts", "src/a.ts", files)).toEqual(["src/b.ts"]);
    expect(await resolve("./missing", "src/a.ts", files)).toEqual([]);
  });

  it("rewrites .js/.jsx/.mjs/.cjs specifiers to their TypeScript sources", async () => {
    const files = [
      "src/a.ts",
      "src/b.ts",
      "src/c.tsx",
      "src/m.mts",
      "src/k.cts",
      "src/both.js",
      "src/both.ts",
    ];
    expect(await resolve("./b.js", "src/a.ts", files)).toEqual(["src/b.ts"]);
    expect(await resolve("./c.js", "src/a.ts", files)).toEqual(["src/c.tsx"]);
    expect(await resolve("./c.jsx", "src/a.ts", files)).toEqual(["src/c.tsx"]);
    expect(await resolve("./m.mjs", "src/a.ts", files)).toEqual(["src/m.mts"]);
    expect(await resolve("./k.cjs", "src/a.ts", files)).toEqual(["src/k.cts"]);
    // an existing .js file wins over the TypeScript source with the same stem; both are candidates
    expect(await resolve("./both.js", "src/a.ts", files)).toEqual(["src/both.js", "src/both.ts"]);
  });

  it("probes directory indexes, `.` and `..`; a file beats a directory of the same name", async () => {
    const files = [
      "src/a.ts",
      "src/util/index.ts",
      "src/pkg/index.tsx",
      "index.ts",
      "src/lib.ts",
      "src/lib/index.ts",
    ];
    expect(await resolve("./util", "src/a.ts", files)).toEqual(["src/util/index.ts"]);
    expect(await resolve("./util/", "src/a.ts", files)).toEqual(["src/util/index.ts"]);
    expect(await resolve("./pkg", "src/a.ts", files)).toEqual(["src/pkg/index.tsx"]);
    expect(await resolve("..", "src/a.ts", files)).toEqual(["index.ts"]);
    expect(await resolve(".", "src/a.ts", files)).toEqual([]); // src/index.* does not exist
    expect(await resolve("./lib", "src/a.ts", files)).toEqual(["src/lib.ts"]);
    expect(await resolve("./lib/", "src/a.ts", files)).toEqual(["src/lib/index.ts"]);
  });

  it("treats bare specifiers, node builtins and paths leaving the repository as external", async () => {
    const files = ["src/a.ts", "react.ts", "node_modules/x/index.ts"];
    expect(await resolve("react", "src/a.ts", files)).toEqual([]);
    expect(await resolve("node:fs", "src/a.ts", files)).toEqual([]);
    expect(await resolve("@scope/pkg", "src/a.ts", files)).toEqual([]);
    expect(await resolve("/abs/path", "src/a.ts", files)).toEqual([]);
    expect(await resolve("../../outside", "src/a.ts", files)).toEqual([]);
    expect(await resolve("~/alias", "src/a.ts", files)).toEqual([]);
  });

  it("finds assets and dotted names, ignoring query strings and hashes", async () => {
    const files = ["src/a.ts", "src/style.css", "src/foo.service.ts"];
    expect(await resolve("./style.css?inline", "src/a.ts", files)).toEqual(["src/style.css"]);
    expect(await resolve("./style.css#x", "src/a.ts", files)).toEqual(["src/style.css"]);
    expect(await resolve("./foo.service", "src/a.ts", files)).toEqual(["src/foo.service.ts"]);
  });
});
