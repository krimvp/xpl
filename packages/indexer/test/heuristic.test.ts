import { describe, expect, it } from "vitest";
import { indexFiles, refTriples } from "./helpers.js";

const src = (...lines: string[]): string => lines.join("\n") + "\n";

/** Index `files` (no git, heuristic only) and return every reference as `from -> to (kind)`. */
async function refs(
  files: Record<string, string>,
  kind?: Parameters<typeof refTriples>[1],
): Promise<string[]> {
  const { index } = await indexFiles(files);
  return refTriples(index, kind);
}

const queueTs = src(
  "export class Queue {", // 1
  "  push(x: number): void {}", // 2
  "  pop(): number { return 1; }", // 3
  "  requeue(x: number): void {}", // 4
  "  static create(): Queue { return undefined as any; }", // 5
  "}",
);

describe("imports", () => {
  it("named imports point at the imported symbol; type-only imports too, as type references", async () => {
    const r = await refs({
      "src/a.ts": src(
        "import { Foo, type Bar as Baz } from './b';",
        "import type { T } from './b';",
      ),
      "src/b.ts": src("export class Foo {}", "export interface Bar {}", "export type T = string;"),
    });
    expect(r).toEqual([
      "src/a.ts# -> src/b.ts#Foo (import)",
      "src/a.ts# -> src/b.ts#Bar (type-ref)",
      "src/a.ts# -> src/b.ts#T (type-ref)",
    ]);
  });

  it("type-only default, namespace and re-export forms are type references too; run-time ones stay imports", async () => {
    const r = await refs({
      "a.ts": src(
        "import type D from './d';",
        "import type * as ns from './n';",
        "import E from './e';",
        "import * as rt from './n';",
        "export type { T } from './t';",
        "export { type U, V } from './t';",
        "export type * from './star';",
        "export type * as sns from './star';",
        "export * from './star2';",
      ),
      "d.ts": "export default class D {}\n",
      "n.ts": "export const x = 1;\n",
      "e.ts": "export default class E {}\n",
      "t.ts": src("export type T = string;", "export type U = number;", "export const V = 1;"),
      "star.ts": "export const s = 1;\n",
      "star2.ts": "export const s2 = 1;\n",
    });
    expect(r).toEqual([
      "a.ts# -> d.ts#D (type-ref)",
      "a.ts# -> n.ts# (type-ref)",
      "a.ts# -> e.ts#E (import)",
      "a.ts# -> n.ts# (import)",
      "a.ts# -> t.ts#T (type-ref)",
      "a.ts# -> t.ts#U (type-ref)",
      "a.ts# -> t.ts#V (import)",
      "a.ts# -> star.ts# (type-ref)",
      "a.ts# -> star.ts# (type-ref)",
      "a.ts# -> star2.ts# (import)",
    ]);
  });

  it("namespace imports and side-effect imports point at the module scope", async () => {
    const r = await refs(
      {
        "a.ts": src(
          "import * as ns from './b';",
          "import './c';",
          "import('./d');",
          "const e = require('./e');",
        ),
        "b.ts": "export const x = 1;\n",
        "c.ts": "console.log(1);\n",
        "d.ts": "export {};\n",
        "e.ts": "export {};\n",
      },
      "import",
    );
    expect(r).toEqual([
      "a.ts# -> b.ts# (import)",
      "a.ts# -> c.ts# (import)",
      "a.ts# -> d.ts# (import)",
      "a.ts# -> e.ts# (import)",
    ]);
  });

  it("default imports resolve to the named default export, an anonymous `default` symbol, or the module", async () => {
    const r = await refs(
      {
        "a.ts": src(
          "import A from './named';",
          "import B from './anon';",
          "import C from './alias';",
          "import D from './plain';",
        ),
        "named.ts": "export default class Named {}\n",
        "anon.ts": "export default function () {}\n",
        "alias.ts": src("class Inner {}", "export default Inner;"),
        "plain.ts": "export const x = 1;\n",
      },
      "import",
    );
    expect(r).toEqual([
      "a.ts# -> named.ts#Named (import)",
      "a.ts# -> anon.ts#default (import)",
      "a.ts# -> alias.ts#Inner (import)",
      "a.ts# -> plain.ts# (import)",
    ]);
  });

  it("resolves .js specifiers to TypeScript sources, extensionless paths and directory indexes", async () => {
    const r = await refs(
      {
        "src/a.ts": src(
          "import { one } from './one.js';",
          "import { two } from './two';",
          "import { three } from './three';",
          "import { four } from './four.ts';",
          "import { ext } from 'external';",
        ),
        "src/one.ts": "export const one = 1;\n",
        "src/two.tsx": "export const two = 2;\n",
        "src/three/index.ts": "export const three = 3;\n",
        "src/four.ts": "export const four = 4;\n",
      },
      "import",
    );
    expect(r).toEqual([
      "src/a.ts# -> src/one.ts#one (import)",
      "src/a.ts# -> src/two.tsx#two (import)",
      "src/a.ts# -> src/three/index.ts#three (import)",
      "src/a.ts# -> src/four.ts#four (import)",
    ]);
  });

  it("an import of a name the module does not define falls back to the module scope", async () => {
    const r = await refs(
      { "a.ts": "import { missing } from './b';\n", "b.ts": "export const other = 1;\n" },
      "import",
    );
    expect(r).toEqual(["a.ts# -> b.ts# (import)"]);
  });

  it("follows barrel files: named and star re-exports, renames, namespaces, chains", async () => {
    const files = {
      "app.ts": src(
        "import { Queue, Renamed, ns, deep } from './lib';",
        "import { Worker } from './lib/index.js';",
      ),
      "lib/index.ts": src(
        "export { Queue } from './queue';",
        "export { Original as Renamed } from './queue';",
        "export * as ns from './queue';",
        "export * from './more';",
      ),
      "lib/queue.ts": src("export class Queue {}", "export class Original {}"),
      "lib/more.ts": src("export { Worker } from './worker';", "export const deep = 1;"),
      "lib/worker.ts": "export class Worker {}\n",
    };
    const r = await refs(files, "import");
    expect(r).toContain("app.ts# -> lib/queue.ts#Queue (import)");
    expect(r).toContain("app.ts# -> lib/queue.ts#Original (import)");
    expect(r).toContain("app.ts# -> lib/queue.ts# (import)"); // `ns`: export * as ns
    expect(r).toContain("app.ts# -> lib/more.ts#deep (import)"); // through `export *`
    expect(r).toContain("app.ts# -> lib/worker.ts#Worker (import)"); // two hops
    // the barrel itself imports what it re-exports
    expect(r).toContain("lib/index.ts# -> lib/queue.ts#Queue (import)");
    expect(r).toContain("lib/index.ts# -> lib/queue.ts#Original (import)");
    expect(r).toContain("lib/index.ts# -> lib/more.ts# (import)");
    expect(r).toContain("lib/more.ts# -> lib/worker.ts#Worker (import)");
  });

  it("re-exports through `import { X }; export { X }` and `export { X as default }`", async () => {
    const r = await refs(
      {
        "a.ts": src("import { X, D } from './mid';"),
        "mid.ts": src(
          "import { X } from './x';",
          "import Y from './y';",
          "export { X };",
          "export { Y as D };",
        ),
        "x.ts": "export class X {}\n",
        "y.ts": "export default class Why {}\n",
      },
      "import",
    );
    expect(r).toContain("a.ts# -> x.ts#X (import)");
    expect(r).toContain("a.ts# -> y.ts#Why (import)");
  });

  it("uses the import's own position: an import inside a function comes from that function", async () => {
    const r = await refs(
      {
        "a.ts": src("async function load() {", "  const m = await import('./b');", "}"),
        "b.ts": "export {};\n",
      },
      "import",
    );
    expect(r).toEqual(["a.ts#load -> b.ts# (import)"]);
  });
});

describe("calls: scope chain and same-file symbols", () => {
  it("resolves plain calls to functions and classes of the same file", async () => {
    const r = await refs(
      {
        "a.ts": src(
          "function helper() {}", // 1
          "class K {}", // 2
          "export function main() {", // 3
          "  helper();", // 4
          "  new K();", // 5
          "  unknown();", // 6
          "}", // 7
        ),
      },
      "call",
    );
    expect(r).toEqual(["a.ts#main -> a.ts#helper (call)", "a.ts#main -> a.ts#K (call)"]);
  });

  it("prefers nested functions over top-level ones, through the whole scope chain", async () => {
    const r = await refs(
      {
        "a.ts": src(
          "function helper() {}", // 1
          "function outer() {", // 2
          "  function helper() {}", // 3
          "  function inner() {", // 4
          "    helper();", // 5  -> outer.helper
          "    sibling();", // 6  -> outer.sibling
          "  }", // 7
          "  function sibling() {}", // 8
          "  helper();", // 9   -> outer.helper
          "}", // 10
          "function other() {", // 11
          "  helper();", // 12 -> top-level helper
          "}", // 13
        ),
      },
      "call",
    );
    expect(r).toEqual([
      "a.ts#outer.inner -> a.ts#outer.helper (call)",
      "a.ts#outer.inner -> a.ts#outer.sibling (call)",
      "a.ts#outer -> a.ts#outer.helper (call)",
      "a.ts#other -> a.ts#helper (call)",
    ]);
  });

  it("does not let a method see sibling methods or class members by bare name", async () => {
    const r = await refs(
      { "a.ts": src("class C {", "  helper() {}", "  run() { helper(); }", "}") },
      "call",
    );
    expect(r).toEqual([]);
  });

  it("resolves calls to imported functions and classes, following the alias", async () => {
    const r = await refs(
      {
        "a.ts": src(
          "import { make as build, Queue } from './b';",
          "function f() { build(); new Queue(); }",
        ),
        "b.ts": src("export function make() {}", "export class Queue {}"),
      },
      "call",
    );
    expect(r).toEqual(["a.ts#f -> b.ts#make (call)", "a.ts#f -> b.ts#Queue (call)"]);
  });

  it("calls from top-level code come from the module scope", async () => {
    const r = await refs({ "a.ts": src("function main() {}", "main();") }, "call");
    expect(r).toEqual(["a.ts# -> a.ts#main (call)"]);
  });

  it("drops self-references (recursion) but keeps calls between different symbols", async () => {
    const r = await refs(
      {
        "a.ts": src(
          "function fact(n: number): number { return n * fact(n - 1); }",
          "function other() { fact(3); }",
        ),
      },
      "call",
    );
    expect(r).toEqual(["a.ts#other -> a.ts#fact (call)"]);
  });

  it("resolves calls to overloaded functions to the implementation", async () => {
    const r = await refs(
      {
        "a.ts": src(
          "export function over(a: string): void;",
          "export function over(a: number): void;",
          "export function over(a: any): void {}",
          "function use() { over(1); }",
        ),
      },
      "call",
    );
    expect(r).toEqual(["a.ts#use -> a.ts#over (call)"]);
  });

  it("uses the duplicate that fits the site kind (interface + function of the same name)", async () => {
    const r = await refs({
      "a.ts": src(
        "interface Thing {}",
        "function Thing() {}",
        "function use(x: Thing) { Thing(); }",
      ),
    });
    // The interface is `Thing`, the function `Thing~2`: a call needs the function, a type reference the interface.
    expect(r).toContain("a.ts#use -> a.ts#Thing~2 (call)");
    expect(r).toContain("a.ts#use -> a.ts#Thing (type-ref)");
    expect(r).not.toContain("a.ts#use -> a.ts#Thing (call)");
    expect(r).not.toContain("a.ts#use -> a.ts#Thing~2 (type-ref)");
  });
});

describe("member calls: this, fields, locals, parameters, statics", () => {
  it("this.m() resolves to a method of the enclosing class, and to inherited methods", async () => {
    const r = await refs(
      {
        "a.ts": src(
          "class Base { shared() {} }", // 1
          "class A extends Base {", // 2
          "  own() {}", // 3
          "  run() { this.own(); this.shared(); this.missing(); }", // 4
          "}", // 5
          "class Deep extends A { go() { this.shared(); this.own(); } }", // 6
        ),
      },
      "call",
    );
    expect(r).toEqual([
      "a.ts#A.run -> a.ts#A.own (call)",
      "a.ts#A.run -> a.ts#Base.shared (call)",
      "a.ts#Deep.go -> a.ts#Base.shared (call)",
      "a.ts#Deep.go -> a.ts#A.own (call)",
    ]);
  });

  it("super.m() and super() resolve against the base class, including imported ones", async () => {
    const r = await refs(
      {
        "a.ts": src(
          "import { Queue } from './queue';",
          "class Recording extends Queue {",
          "  push(x: number) { super.push(x); }",
          "  constructor() { super(); }",
          "}",
        ),
        "queue.ts": src("export class Queue {", "  constructor() {}", "  push(x: number) {}", "}"),
      },
      "call",
    );
    expect(r).toEqual([
      "a.ts#Recording.push -> queue.ts#Queue.push (call)",
      "a.ts#Recording.constructor -> queue.ts#Queue.constructor (call)",
    ]);
  });

  it("this.f.m() resolves through the declared field type, across files", async () => {
    const r = await refs(
      {
        "queue.ts": queueTs,
        "runner.ts": src(
          "import type { Queue } from './queue';",
          "export class Runner {",
          "  private queue: Queue;",
          "  run() { this.queue.pop(); this.queue.nope(); }",
          "}",
        ),
      },
      "call",
    );
    expect(r).toEqual(["runner.ts#Runner.run -> queue.ts#Queue.pop (call)"]);
  });

  it("this.f.m() through constructor parameter properties and constructor assignments (untyped JS)", async () => {
    const r = await refs(
      {
        "queue.ts": queueTs,
        "a.ts": src(
          "import { Queue } from './queue';",
          "class A {",
          "  constructor(private readonly q: Queue) {}",
          "  run() { this.q.pop(); }",
          "}",
        ),
        "b.js": src(
          "import { Queue } from './queue';",
          "class B {",
          "  constructor() { this.jobs = new Queue(); }",
          "  run() { this.jobs.pop(); }",
          "}",
        ),
      },
      "call",
    );
    expect(r).toContain("a.ts#A.run -> queue.ts#Queue.pop (call)");
    expect(r).toContain("b.js#B.run -> queue.ts#Queue.pop (call)");
  });

  it("a local initialised with `new` resolves member calls", async () => {
    const r = await refs(
      {
        "queue.ts": queueTs,
        "a.ts": src(
          "import { Queue } from './queue';",
          "function f() {",
          "  const q = new Queue();",
          "  q.push(1);",
          "  q.nothing();",
          "}",
        ),
      },
      "call",
    );
    expect(r).toEqual(["a.ts#f -> queue.ts#Queue (call)", "a.ts#f -> queue.ts#Queue.push (call)"]);
  });

  it("a local initialised by an awaited method resolves through the callee's declared return type", async () => {
    const r = await refs(
      {
        "worker.ts": src(
          "export class Worker { run(job: string) {} }",
          "export class WorkerPool {",
          "  lease(): Promise<Worker> { throw new Error(); }",
          "}",
        ),
        "runner.ts": src(
          "import type { WorkerPool } from './worker';",
          "export class Runner {",
          "  private pool: WorkerPool;",
          "  async dispatch() {",
          "    const worker = await this.pool.lease();",
          "    await worker.run('job');",
          "  }",
          "}",
        ),
      },
      "call",
    );
    expect(r).toEqual([
      "runner.ts#Runner.dispatch -> worker.ts#WorkerPool.lease (call)",
      "runner.ts#Runner.dispatch -> worker.ts#Worker.run (call)",
    ]);
  });

  it("a local initialised by a function call uses the function's return type", async () => {
    const r = await refs(
      {
        "a.ts": src(
          "import { makeQueue } from './b';",
          "function f() { const q = makeQueue(); q.pop(); }",
          "function g() { makeQueue().push(1); }",
        ),
        "b.ts": src(
          "import { Queue } from './queue';",
          "export function makeQueue(): Queue { return new Queue(); }",
        ),
        "queue.ts": queueTs,
      },
      "call",
    );
    expect(r).toContain("a.ts#f -> queue.ts#Queue.pop (call)");
    expect(r).toContain("a.ts#g -> queue.ts#Queue.push (call)");
    expect(r).toContain("a.ts#f -> b.ts#makeQueue (call)");
  });

  it("parameters and typed locals resolve through their annotation, `T | undefined` and Promise unwrapping", async () => {
    const r = await refs(
      {
        "queue.ts": queueTs,
        "a.ts": src(
          "import { Queue } from './queue';",
          "function f(q: Queue, maybe: Queue | undefined, later: Promise<Queue>) {",
          "  q.push(1);",
          "  maybe.pop();",
          "  const typed: Queue = getIt();",
          "  typed.requeue(1);",
          "}",
        ),
      },
      "call",
    );
    expect(r).toContain("a.ts#f -> queue.ts#Queue.push (call)");
    expect(r).toContain("a.ts#f -> queue.ts#Queue.pop (call)");
    expect(r).toContain("a.ts#f -> queue.ts#Queue.requeue (call)");
  });

  it("chains: this.a.b.c(), calls on call results, module-level variables", async () => {
    const r = await refs(
      {
        "a.ts": src(
          "class Leaf { go() {} }", // 1
          "class Mid { leaf: Leaf; getLeaf(): Leaf { return this.leaf; } }", // 2
          "class Top {", // 3
          "  mid: Mid;", // 4
          "  run() {", // 5
          "    this.mid.leaf.go();", // 6
          "    this.mid.getLeaf().go();", // 7
          "  }", // 8
          "}", // 9
          "const shared = new Mid();", // 10
          "function use() { shared.leaf.go(); shared.getLeaf().go(); }", // 11
        ),
      },
      "call",
    );
    expect(r).toContain("a.ts#Top.run -> a.ts#Leaf.go (call)");
    expect(r).toContain("a.ts#Top.run -> a.ts#Mid.getLeaf (call)");
    expect(r).toContain("a.ts#use -> a.ts#Leaf.go (call)");
    expect(r).toContain("a.ts#use -> a.ts#Mid.getLeaf (call)");
    expect(r.filter((x) => x.endsWith("Leaf.go (call)"))).toHaveLength(4);
  });

  it("aliases of properties, fields and `this` keep the type: const q = this.queue; const self = this", async () => {
    const r = await refs(
      {
        "queue.ts": queueTs,
        "a.ts": src(
          "import { Queue } from './queue';", // 1
          "class Model { index: Queue; }", // 2
          "class Runner {", // 3
          "  private queue: Queue;", // 4
          "  model: Model;", // 5
          "  run() {", // 6
          "    const q = this.queue;", // 7
          "    q.pop();", // 8
          "    const index = this.model.index;", // 9
          "    index.push(1);", // 10
          "    const self = this;", // 11
          "    self.helper();", // 12
          "    const again = q;", // 13
          "    again.requeue(1);", // 14
          "  }", // 15
          "  helper() {}", // 16
          "}", // 17
        ),
      },
      "call",
    );
    expect(r).toContain("a.ts#Runner.run -> queue.ts#Queue.pop (call)");
    expect(r).toContain("a.ts#Runner.run -> queue.ts#Queue.push (call)");
    expect(r).toContain("a.ts#Runner.run -> a.ts#Runner.helper (call)");
    expect(r).toContain("a.ts#Runner.run -> queue.ts#Queue.requeue (call)");
  });

  it("functions without a return annotation return what their return statements show", async () => {
    const r = await refs(
      {
        "queue.ts": queueTs,
        "a.ts": src(
          "import { Queue } from './queue';", // 1
          "function makeQueue() { return new Queue(); }", // 2
          "const viaArrow = () => new Queue();", // 3
          "class Holder {", // 4
          "  private queue: Queue;", // 5
          "  getQueue() { return this.queue; }", // 6
          "  get current() { return this.getQueue(); }", // 7
          "  build() { const inner = () => new Object(); return new Queue(); }", // 8
          "}", // 9
          "function use(h: Holder) {", // 10
          "  makeQueue().pop();", // 11
          "  viaArrow().push(1);", // 12
          "  h.getQueue().requeue(1);", // 13
          "  h.current.pop();", // 14
          "  h.build().push(2);", // 15
          "}", // 16
        ),
      },
      "call",
    );
    const lines = (target: string) =>
      r.filter((x) => x.startsWith("a.ts#use") && x.includes(target)).length;
    expect(lines("Queue.pop")).toBe(2); // makeQueue().pop() and h.current.pop()
    expect(lines("Queue.push")).toBe(2); // viaArrow().push() and h.build().push()
    expect(lines("Queue.requeue")).toBe(1);
  });

  it("static members, namespace imports and nested namespaces", async () => {
    const r = await refs(
      {
        "queue.ts": queueTs,
        "util.ts": src(
          "export function helper() {}",
          "export class Tools { static run() {} }",
          "export namespace Deep { export function f() {} }",
        ),
        "a.ts": src(
          "import { Queue } from './queue';",
          "import * as util from './util';",
          "function f() {",
          "  Queue.create();",
          "  util.helper();",
          "  util.Tools.run();",
          "  util.Deep.f();",
          "}",
        ),
      },
      "call",
    );
    expect(r).toEqual([
      "a.ts#f -> queue.ts#Queue.create (call)",
      "a.ts#f -> util.ts#helper (call)",
      "a.ts#f -> util.ts#Tools.run (call)",
      "a.ts#f -> util.ts#Deep.f (call)",
    ]);
  });

  it("methods of object literals and calls on them", async () => {
    const r = await refs(
      {
        "a.ts": src(
          "export const api = {", // 1
          "  fetch() { return this.parse(); },", // 2
          "  parse() {},", // 3
          "};", // 4
          "function use() { api.fetch(); }", // 5
        ),
      },
      "call",
    );
    expect(r).toEqual([
      "a.ts#api.fetch -> a.ts#api.parse (call)",
      "a.ts#use -> a.ts#api.fetch (call)",
    ]);
  });

  it("interface-typed fields resolve to interface members", async () => {
    const r = await refs(
      {
        "a.ts": src(
          "interface Logger { log(msg: string): void }",
          "class S { constructor(private logger: Logger) {} run() { this.logger.log('x'); } }",
        ),
      },
      "call",
    );
    expect(r).toEqual(["a.ts#S.run -> a.ts#Logger.log (call)"]);
  });

  it("callbacks and blocks that declare the same name do not mix their types", async () => {
    const { index } = await indexFiles({
      "queue.ts": queueTs,
      "worker.ts": "export class Worker { run() {} }\n",
      "a.ts": src(
        "import { Queue } from './queue';", // 1
        "import { Worker } from './worker';", // 2
        "it('one', () => { const x = new Queue(); x.pop(); });", // 3
        "it('two', () => { const x = new Worker(); x.run(); });", // 4
        "each((x: Queue) => x.push(1));", // 5
        "each((x: Worker) => x.run());", // 6
        "function f() {", // 7
        "  { const q = new Queue(); q.pop(); }", // 8
        "  { const q = new Worker(); q.run(); }", // 9
        "  const outer = new Queue();", // 10
        "  each((outer: Worker) => outer.run());", // 11 (the parameter shadows the local)
        "  outer.requeue(1);", // 12
        "}", // 13
      ),
    });
    const calls = index.refs
      .filter((x) => x.kind === "call" && x.from.startsWith("a.ts"))
      .map((x) => `${x.site.startLine} ${x.to}`);
    for (const expected of [
      "3 queue.ts#Queue.pop",
      "4 worker.ts#Worker.run",
      "5 queue.ts#Queue.push",
      "6 worker.ts#Worker.run",
      "8 queue.ts#Queue.pop",
      "9 worker.ts#Worker.run",
      "11 worker.ts#Worker.run",
      "12 queue.ts#Queue.requeue",
    ]) {
      expect(calls, expected).toContain(expected);
    }
    // nothing crossed over: Queue has no `run`, Worker has no `pop`/`push`/`requeue`
    expect(
      calls.filter(
        (x) => x.includes("Queue.run") || x.includes("Worker.pop") || x.includes("Worker.push"),
      ),
    ).toEqual([]);
  });

  it("a local or parameter shadows an import of the same name", async () => {
    const r = await refs(
      {
        "q.ts": "export const queue = { pop() {} };\n",
        "queue.ts": queueTs,
        "a.ts": src(
          "import { queue } from './q';",
          "import { Queue } from './queue';",
          "function f(queue: Queue) { queue.push(1); }",
          "function g() { queue.pop(); }",
        ),
      },
      "call",
    );
    expect(r).toContain("a.ts#f -> queue.ts#Queue.push (call)");
    expect(r).toContain("a.ts#g -> q.ts#queue.pop (call)");
  });
});

describe("qualifier-name fallback and unresolved sites", () => {
  it("queue.pop() with an untyped receiver resolves to the class named like it, case-insensitively", async () => {
    const r = await refs(
      {
        "queue.ts": queueTs,
        "a.js": src(
          "function drain(queue) { return queue.pop(); }",
          "function other(jobQueue) { jobQueue.pop(); }",
        ),
        "b.js": "class X { run() { this.queue.pop(); } }\n",
      },
      "call",
    );
    expect(r).toContain("a.js#drain -> queue.ts#Queue.pop (call)");
    expect(r).toContain("b.js#X.run -> queue.ts#Queue.pop (call)");
    // `jobQueue` is not `queue`
    expect(r.some((x) => x.startsWith("a.js#other"))).toBe(false);
  });

  it("the fallback needs the member: a class without `pop` is not a match", async () => {
    const r = await refs(
      {
        "q.ts": "export class Queue { push() {} }\n",
        "a.js": "function f(queue) { queue.pop(); }\n",
      },
      "call",
    );
    expect(r).toEqual([]);
  });

  it("ambiguous fallback matches are dropped; an imported or same-file class wins", async () => {
    const files = {
      "one/queue.ts": "export class Queue { pop() {} }\n",
      "two/queue.ts": "export class Queue { pop() {} }\n",
      "amb/ambiguous.js": "function f(queue) { queue.pop(); }\n",
      "imp/imports.js": src(
        "import { Queue } from '../one/queue';",
        "function f(queue) { queue.pop(); }",
      ),
      "loc/local.js": src("class Queue { pop() {} }", "function f(queue) { queue.pop(); }"),
      // same directory as one of the candidates: the closer class wins
      "one/user.js": "function f(queue) { queue.pop(); }\n",
    };
    const r = await refs(files, "call");
    expect(r.filter((x) => x.startsWith("amb/"))).toEqual([]);
    expect(r).toContain("imp/imports.js#f -> one/queue.ts#Queue.pop (call)");
    expect(r).toContain("loc/local.js#f -> loc/local.js#Queue.pop (call)");
    expect(r).toContain("one/user.js#f -> one/queue.ts#Queue.pop (call)");
  });

  it("never guesses when the receiver's type is known to be external", async () => {
    const r = await refs(
      {
        "queue.ts": queueTs,
        "a.ts": src(
          "import { Thing } from 'external';",
          "class A {",
          "  private queue: Map<string, number>;", // typed, but not a repository type
          "  private jobs: Array<number>;",
          "  run(queue: Set<string>, thing: Thing) {",
          "    this.queue.push(1);", // Map has no push, but must not match Queue.push either
          "    queue.pop();",
          "    thing.pop();",
          "    this.jobs.pop();",
          "  }",
          "}",
        ),
      },
      "call",
    );
    expect(r).toEqual([]);
  });

  it("drops calls to unknown functions, globals and external imports", async () => {
    const r = await refs(
      {
        "a.ts": src(
          "import fs from 'node:fs';",
          "import { debounce } from 'lodash';",
          "function f() {",
          "  fs.readFileSync('x');",
          "  debounce(f);",
          "  console.log(1);",
          "  Math.max(1, 2);",
          "  JSON.parse('{}');",
          "  Promise.resolve(1).then(f);",
          "  setTimeout(f, 1);",
          "  notDefinedAnywhere();",
          "  a.b.c.d();",
          "}",
        ),
      },
      "call",
    );
    expect(r).toEqual([]);
  });
});

describe("type-ref, extends, implements", () => {
  it("resolves type positions, heritage clauses and qualified type names through imports", async () => {
    const r = await refs({
      "types.ts": src(
        "export interface Job {}",
        "export class Base {}",
        "export interface Iface {}",
        "export type Alias = string;",
      ),
      "a.ts": src(
        "import { Job, Base, Iface } from './types';", // 1
        "import * as t from './types';", // 2
        "class A extends Base implements Iface {", // 3
        "  field: Job;", // 4
        "  m(x: t.Alias): t.Job { return x as any; }", // 5
        "}", // 6
      ),
    });
    expect(r).toContain("a.ts#A -> types.ts#Base (extends)");
    expect(r).toContain("a.ts#A -> types.ts#Iface (implements)");
    expect(r).toContain("a.ts#A.field -> types.ts#Job (type-ref)");
    expect(r).toContain("a.ts#A.m -> types.ts#Alias (type-ref)");
    expect(r).toContain("a.ts#A.m -> types.ts#Job (type-ref)");
  });

  it("interface extends and same-file types; type parameters and unknown types are dropped", async () => {
    const r = await refs({
      "a.ts": src(
        "interface Base {}", // 1
        "interface Sub extends Base {}", // 2
        "function f<T>(x: T, y: Unknown, z: Base): Promise<Sub> {}", // 3
      ),
    });
    expect(r).toContain("a.ts#Sub -> a.ts#Base (extends)");
    expect(r).toContain("a.ts#f -> a.ts#Base (type-ref)");
    expect(r).toContain("a.ts#f -> a.ts#Sub (type-ref)");
    expect(r.filter((x) => x.includes("(type-ref)"))).toHaveLength(2);
  });

  it("a class whose own name appears in its members is a reference from the member, not from itself", async () => {
    const r = await refs({
      "a.ts": src("class Node {", "  next: Node;", "  self(): Node { return this; }", "}"),
    });
    expect(r).toEqual([
      "a.ts#Node.next -> a.ts#Node (type-ref)",
      "a.ts#Node.self -> a.ts#Node (type-ref)",
    ]);
  });

  it("enum members in type positions point at the enum", async () => {
    const r = await refs({
      "a.ts": src(
        "enum Color { Red, Green }",
        "let x: Color.Red;",
        "function f(c: Color.Green) {}",
      ),
    });
    expect(r).toEqual(["a.ts#x -> a.ts#Color (type-ref)", "a.ts#f -> a.ts#Color (type-ref)"]);
  });

  it("type-ref never falls back to name matching", async () => {
    const r = await refs({ "a.ts": "class Queue {}\nlet x: ns.Queue;\nlet y: other.Queue;\n" });
    expect(r).toEqual([]);
  });
});

describe("write references", () => {
  it("assignments to fields and module variables", async () => {
    const r = await refs(
      {
        "a.ts": src(
          "let counter = 0;", // 1
          "class A {", // 2
          "  count = 0;", // 3
          "  bump() { this.count += 1; counter++; this.missing = 1; }", // 4
          "}", // 5
          "function reset(a: A) { a.count = 0; counter = 0; }", // 6
        ),
      },
      "write",
    );
    expect(r).toEqual([
      "a.ts#A.bump -> a.ts#A.count (write)",
      "a.ts#A.bump -> a.ts#counter (write)",
      "a.ts#reset -> a.ts#A.count (write)",
      "a.ts#reset -> a.ts#counter (write)",
    ]);
  });

  it("does not turn writes into references to types", async () => {
    const r = await refs(
      { "a.ts": src("class Foo {}", "function f() { Foo = 1 as any; }") },
      "write",
    );
    expect(r).toEqual([]);
  });
});

describe("JSX components", () => {
  it("<Component /> is a call of the component function or class", async () => {
    const r = await refs(
      {
        "ui.tsx": src(
          "export function Header() { return <h1 />; }",
          "export class Legacy { render() { return <p />; } }",
        ),
        "app.tsx": src(
          "import { Header, Legacy } from './ui';",
          "import * as ui from './ui';",
          "export const App = () => (",
          "  <div>",
          "    <Header />",
          "    <Legacy />",
          "    <ui.Header />",
          "    <span />",
          "  </div>",
          ");",
        ),
      },
      "call",
    );
    expect(r).toEqual([
      "app.tsx#App -> ui.tsx#Header (call)",
      "app.tsx#App -> ui.tsx#Legacy (call)",
      "app.tsx#App -> ui.tsx#Header (call)",
    ]);
  });
});

describe("references carry positions and provenance", () => {
  it("every reference is heuristic, has a site with columns, and from/to are symbol ids or module scopes", async () => {
    const { index } = await indexFiles({
      "queue.ts": queueTs,
      "a.ts": src(
        "import { Queue } from './queue';",
        "export function f(q: Queue) {",
        "  q.pop();",
        "}",
      ),
    });
    expect(index.refs.length).toBeGreaterThan(0);
    for (const ref of index.refs) {
      expect(ref.resolution).toBe("heuristic");
      expect(ref.site.startCol).toBeGreaterThanOrEqual(1);
      expect(ref.site.endCol).toBeGreaterThanOrEqual(1);
      expect(ref.from).toMatch(/^[^#]+#/);
      expect(ref.to).toMatch(/^[^#]+#/);
      const symbolIds = new Set(index.symbols.map((s) => s.id));
      for (const id of [ref.from, ref.to]) {
        const [file, path] = [id.slice(0, id.indexOf("#")), id.slice(id.indexOf("#") + 1)];
        expect(index.files.some((f) => f.path === file)).toBe(true);
        if (path !== "") expect(symbolIds.has(id)).toBe(true);
      }
    }
    const call = index.refs.find((r) => r.kind === "call")!;
    expect(call).toEqual({
      from: "a.ts#f",
      to: "queue.ts#Queue.pop",
      kind: "call",
      site: { startLine: 3, endLine: 3, startCol: 3, endCol: 9 },
      resolution: "heuristic",
    });
  });

  it("refs are sorted by file and position, and duplicated sites are reported once", async () => {
    const { index } = await indexFiles({
      "z.ts": "import { a } from './a';\nexport const z = a();\n",
      "a.ts": "export function a() {}\nexport function b() { a(); a(); }\n",
    });
    const positions = index.refs.map(
      (r) => `${r.from.split("#")[0]}:${r.site.startLine}:${r.site.startCol}`,
    );
    expect(positions).toEqual([...positions].sort());
    const calls = index.refs.filter((r) => r.from === "a.ts#b");
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((c) => c.site.startCol)).size).toBe(2);
  });
});
