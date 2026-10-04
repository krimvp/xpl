/**
 * `read` sites of the TypeScript / JavaScript pack: what is a read, which bare names are local, which member
 * accesses can be resolved, and how the resolver turns them into references (variables and fields only).
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
async function reads(source: string, path = "a.ts"): Promise<string[]> {
  const { facts } = await extract(path, source);
  return facts.sites
    .filter((s: SiteDraft) => s.kind === "read")
    .map(
      (s) =>
        `${s.site.startLine}: read ${[...s.qualifier, s.name].join(".")} «${covered(source, s.site)}»`,
    );
}

describe("read sites: names, members, and what is left out", () => {
  it("bare module variables, imports, this.f, typed receivers, statics and chains; not calls, writes, declarations or locals", async () => {
    const source = src(
      'import { CONFIG, helper } from "./config";',
      'import * as ns from "./ns";',
      "const LIMIT = 10;",
      "let counter = 0;",
      "const table = { a: 1 };",
      "class Box {",
      "  size = 0;",
      "  #secret = 1;",
      '  static kind = "box";',
      "  inc(other: Box): number {",
      "    this.size += 1;",
      "    this.size++;",
      "    this.size = this.size + LIMIT;",
      "    counter++;",
      "    const local = this.size + other.size;",
      "    const { size } = this;",
      "    helper(this.#secret, Box.kind, ns.VALUE, CONFIG.retries);",
      "    return local + size + counter + table.a;",
      "  }",
      "}",
      "function f(LIMIT: number, cb = counter) {",
      "  return LIMIT + cb;",
      "}",
      "function g() {",
      "  const counter = 1;",
      "  { let table = 2; use(table); }",
      "  for (const LIMIT of [1]) use(LIMIT);",
      "  try { boom(); } catch (CONFIG) { use(CONFIG); }",
      "  return counter + LIMIT;",
      "}",
      "const h = (LIMIT) => LIMIT + counter;",
      "const o = { LIMIT, counter, [table.a]: 1, key: LIMIT };",
      "export default LIMIT;",
      "type T = typeof LIMIT;",
      "label: for (;;) { break label; }",
      "use(`${LIMIT}`, ...[counter], <div a={LIMIT}>{counter}</div>);",
    );
    expect(await reads(source, "a.tsx")).toEqual([
      "13: read this.size «this.size»",
      "13: read LIMIT «LIMIT»",
      "15: read this.size «this.size»",
      "15: read other.size «other.size»",
      "17: read this.#secret «this.#secret»",
      "17: read Box «Box»", // the class used as a namespace: a type reference once resolved
      "17: read Box.kind «Box.kind»",
      "17: read ns «ns»",
      "17: read ns.VALUE «ns.VALUE»",
      "17: read CONFIG «CONFIG»",
      "17: read CONFIG.retries «CONFIG.retries»",
      "18: read counter «counter»",
      "18: read table «table»",
      "18: read table.a «table.a»",
      "21: read counter «counter»",
      "29: read LIMIT «LIMIT»",
      "31: read counter «counter»",
      "32: read LIMIT «LIMIT»",
      "32: read counter «counter»",
      "32: read table «table»",
      "32: read table.a «table.a»",
      "32: read LIMIT «LIMIT»",
      "33: read LIMIT «LIMIT»",
      "36: read LIMIT «LIMIT»",
      "36: read counter «counter»",
      "36: read LIMIT «LIMIT»",
      "36: read counter «counter»",
    ]);
  });

  it("scopes: parameters, block and loop variables, catch bindings, hoisted vars and destructuring hide a module variable; namespaces and IIFEs do not", async () => {
    const source = src(
      "const A = 1, B = 2, C = 3, D = 4, E = 5, F = 6;",
      "namespace NS {",
      "  export const inner = A;",
      "  function useIt() { return inner + A; }",
      "}",
      "(function () {",
      "  var iife = B;",
      "  function inside() { return iife + B; }",
      "})();",
      "function hoist() {",
      "  if (true) { var A = 1; }",
      "  return A + B;",
      "}",
      "function destruct({ C, x: [D], ...rest }, [E = F]) {",
      "  return C + D + E + F + rest;",
      "}",
      "function blockFn() {",
      "  { function B() {} }",
      "  return B;",
      "}",
      "class K {",
      "  field = A;",
      "  other = this.field + B;",
      "  m() {",
      "    delete this.field;",
      "    const t = typeof C, u = this.other as number, v = this.other!;",
      "    const w = this?.field ?? D;",
      "    return [t, u, v, w, this.other?.x.y];",
      "  }",
      "  static s = K.s2;",
      "  static s2 = E;",
      "}",
      "function param(a = A, { b = B } = {}) { return [a, b]; }",
      "const arrow = async (A) => A + B;",
      "switch (C) { case D: { const E = 1; break; } default: E; }",
      "for (const [i, j] of [[1, 2]]) { i + j + F; }",
      "for (var A2 = 0; A2 < B; A2++) {}",
      "x = C;",
    );
    expect(await reads(source)).toEqual([
      "3: read A «A»",
      "4: read inner «inner»",
      "4: read A «A»",
      "7: read B «B»",
      "8: read iife «iife»",
      "8: read B «B»",
      "12: read B «B»",
      "14: read F «F»",
      "15: read F «F»",
      "19: read B «B»",
      "22: read A «A»",
      "23: read this.field «this.field»",
      "23: read B «B»",
      "25: read this.field «this.field»",
      "26: read C «C»",
      "26: read this.other «this.other»",
      "26: read this.other «this.other»",
      "27: read this.field «this?.field»",
      "27: read D «D»",
      "28: read this.other «this.other»",
      "28: read this.other.x «this.other?.x»",
      "28: read this.other.x.y «this.other?.x.y»",
      "30: read K «K»",
      "30: read K.s2 «K.s2»",
      "31: read E «E»",
      "33: read A «A»",
      "33: read B «B»",
      "34: read B «B»",
      "35: read C «C»",
      "35: read D «D»",
      "35: read E «E»",
      "36: read F «F»",
      "37: read B «B»",
      "38: read C «C»",
    ]);
  });

  it("a member access is a candidate when its receiver is this, super, a call, a cast, a name of the file or a typed local", async () => {
    const source = src(
      "import { cfg } from './cfg';",
      "const own = { a: 1 };",
      "class Base { x = 1; }",
      "function getOwn(): Own { return new Own(); }",
      "class K extends Base {",
      "  m(typed: Own, untyped, inferred = new Own()) {",
      "    super.x;", // super
      "    typed.p;", // typed parameter
      "    untyped.q;", // parameter without a type: nothing to resolve
      "    inferred.r;", // default value `new Own()` gives it a type
      "    const made = new Own();",
      "    made.s;", // local of an evident type
      "    const bare = one + two;",
      "    bare.t;", // local without a type fact
      "    (this.x as Own).u;", // cast
      "    getOwn().v;", // call result
      "    cfg.w;", // import
      "    own.a;", // name of the file
      "    unknown.z;", // not declared, imported or local: a global
      "  }",
      "}",
    );
    expect(await reads(source)).toEqual([
      "7: read super.x «super.x»",
      "8: read typed.p «typed.p»",
      "10: read inferred.r «inferred.r»",
      "12: read made.s «made.s»",
      "15: read this.x «this.x»",
      "15: read :Own.u «(this.x as Own).u»",
      "16: read getOwn().v «getOwn().v»",
      "17: read cfg «cfg»",
      "17: read cfg.w «cfg.w»",
      "18: read own «own»",
      "18: read own.a «own.a»",
    ]);
  });

  it("a member access spanning more than 10 lines is reported by its property only", async () => {
    const source = src(
      "class A {",
      "  m() {",
      "    return this",
      ...Array.from({ length: 12 }, (_, i) => `      .step${i}`),
      "      .last;",
      "  }",
      "}",
    );
    const found = (await reads(source)).filter((r) => r.includes("«last»"));
    expect(found).toEqual([
      "16: read this.step0.step1.step2.step3.step4.step5.step6.step7.step8.step9.step10.step11.last «last»",
    ]);
  });

  it("does not read object keys, member names, labels, imports, exports of names, heritage or JSX tag names", async () => {
    const source = src(
      "import { a as b } from './x';",
      "export { c as d };",
      "const c = 1, a = 2, b2 = 3;",
      "const o = { a: 1, [c]: 2, method() {}, get g() { return 1; } };",
      "class X extends a implements b2 { a = 1; }",
      "enum E { c, d = c }",
      "const el = <a.b c={1}><c /></a.b>;",
      "interface I { a: number; c(): void; }",
      "type T = typeof a;",
      "declare const declared: number;",
      "outer: for (;;) { break outer; }",
    );
    // `[c]: 2` and `d = c` read c; `<a.b>` reads a (a value, twice: opening and closing tag), `<c />` is an
    // intrinsic element
    expect(await reads(source, "a.tsx")).toEqual([
      "4: read c «c»",
      "6: read c «c»",
      "7: read a «a»",
      "7: read a «a»",
    ]);
  });

  it("the parts of a type query or a module path are not member reads, however long the path", async () => {
    const source = src(
      "import * as a from './a';",
      "type T = typeof a.b.c.d.e.f;",
      "type U = typeof a.b<string>;",
      "declare namespace a.b.c.d.e { const q: number; }",
      "import x = a.b.c.d.e;",
      "export const w = a.b.c.d;",
    );
    expect(await reads(source)).toEqual([
      "2: read a «a»",
      "3: read a «a»",
      "4: read a «a»",
      "5: read a «a»",
      "6: read a «a»",
      "6: read a.b «a.b»",
      "6: read a.b.c «a.b.c»",
      "6: read a.b.c.d «a.b.c.d»",
    ]);
  });

  it("what a scope binds is asked once per scope but answered per use: siblings, nesting and later blocks differ", async () => {
    const source = src(
      "const A = 1;",
      "function f(A) { { use(A); } return A; }", // parameter: both uses are bound
      "function g() { { use(A); } return A; }", // nothing binds it: two reads
      "function h() { const A = 2; { use(A); } return A; }", // bound in the function block
      "function i() { { const A = 3; } use(A); return A; }", // the block's own: two reads after it
      "function j() { for (const A of []) { use(A); } return A; }", // loop variable: one read after the loop
      "function k() { try { use(A); } catch (A) { use(A); } return A; }", // catch parameter: two reads
      "const m = () => { use(A); return (A) => A; };", // the arrow's own parameter hides it only inside
      "use(A);",
    );
    expect(await reads(source)).toEqual([
      "3: read A «A»",
      "3: read A «A»",
      "5: read A «A»",
      "5: read A «A»",
      "6: read A «A»",
      "7: read A «A»",
      "7: read A «A»",
      "8: read A «A»",
      "9: read A «A»",
    ]);
  });

  it("a local of a known type is a candidate only where that local is visible", async () => {
    const source = src(
      "import { Foo } from './foo';",
      "const c = { x: 1 };",
      "function f() { const c: Foo = make(); return c.x; }", // typed local
      "function g() { const c = 1 + 2; return c.x; }", // a local without a type fact
      "function h(c) { return c.x; }", // an untyped parameter
      "function k(c: Foo) { { return c.x; } }", // typed parameter, used in a block
      "function m() { return c.x; }", // the module's `c`
    );
    expect(await reads(source)).toEqual([
      "3: read c.x «c.x»",
      "6: read c.x «c.x»",
      "7: read c «c»",
      "7: read c.x «c.x»",
    ]);
  });
});

describe("read sites: classifySite agrees with extract", () => {
  it("classifies every read `extract` emits, at the same site, and flags bare names", async () => {
    const source = src(
      "const LIMIT = 1;",
      "class A {",
      "  n = 0;",
      "  m(o: A) {",
      "    return this.n + o.n + LIMIT;",
      "  }",
      "}",
      "const x = { LIMIT };",
    );
    const ex = await extract("a.ts", source);
    /** Classify the identifier `offset` characters into the first `needle` of the line. */
    const at = (line: number, needle: string, offset = 0) => {
      const col = source.split("\n")[line - 1]!.indexOf(needle) + offset;
      return ex.withTree((ctx) => ex.pack.classifySite(ctx, line, col + 1));
    };
    expect(at(5, "this.n", 5)).toEqual({
      kind: "read",
      site: { startLine: 5, startCol: 12, endLine: 5, endCol: 17 },
    });
    expect(at(5, "o.n", 2)).toMatchObject({ kind: "read" });
    expect(at(5, "LIMIT")).toEqual({
      kind: "read",
      site: { startLine: 5, startCol: 27, endLine: 5, endCol: 31 },
      bare: true,
    });
    expect(at(8, "LIMIT")).toMatchObject({ kind: "read", bare: true }); // shorthand
    expect(at(5, "this")).toBeUndefined();
    const emitted = ex.facts.sites.filter((s) => s.kind === "read");
    expect(emitted.length).toBeGreaterThan(3);
    for (const s of emitted) {
      // the identifier a SCIP occurrence would sit on: the last one of the site
      const text = covered(source, s.site);
      const col = s.site.startCol - 1 + text.lastIndexOf(s.name);
      const found = ex.withTree((ctx) => ex.pack.classifySite(ctx, s.site.startLine, col + 1));
      expect(found, text).toMatchObject({ kind: "read", site: s.site });
    }
  });

  it("calls, writes and declarations are not reads", async () => {
    const ex = await extract(
      "a.ts",
      src(
        "class A {",
        "  n = 0;",
        "  m() {",
        "    this.n = 1;",
        "    this.n++;",
        "    this.m();",
        "  }",
        "}",
      ),
    );
    const kinds = ex.withTree((ctx) =>
      [
        [2, 3], // n = 0 (declaration)
        [4, 10], // this.n = 1
        [5, 10], // this.n++
        [6, 10], // this.m()
      ].map(([line, col]) => ex.pack.classifySite(ctx, line!, col!)?.kind),
    );
    expect(kinds).toEqual([undefined, "write", "write", "call"]);
  });
});

describe("read references: heuristic resolution", () => {
  const refs = async (files: Record<string, string>): Promise<string[]> => {
    const { index } = await indexFiles(files);
    return refTriples(index, "read");
  };

  it("module variables: same file, imported, through a namespace import and a re-export; from the module scope at the top level", async () => {
    expect(
      await refs({
        "config.ts": src(
          "export const LIMIT = 3;",
          "export let counter = 0;",
          "export function fn() {}",
        ),
        "index.ts": "export * from './config';\n",
        "a.ts": src(
          "import { LIMIT, fn } from './config';",
          "import * as cfg from './index';",
          "const local = LIMIT;",
          "export function f() {",
          "  fn;",
          "  return LIMIT + cfg.counter + local;",
          "}",
        ),
      }),
    ).toEqual([
      "a.ts#local -> config.ts#LIMIT (read)", // the initialiser of a variable is inside its symbol
      "a.ts#f -> config.ts#fn (read)",
      "a.ts#f -> config.ts#LIMIT (read)",
      "a.ts#f -> config.ts#counter (read)",
      "a.ts#f -> a.ts#local (read)",
    ]);
  });

  it("fields and properties: this.f, this.f.g through declared types, typed parameters and locals, statics, interface properties", async () => {
    expect(
      await refs({
        "types.ts": src(
          "export interface Options { retries: number; nested: { depth: number }; inner: Inner }",
          "export interface Inner { depth: number }",
          "export class Pool { size = 0; static shared = 1; }",
        ),
        "a.ts": src(
          "import { Pool, Options } from './types';",
          "export class Runner {",
          "  private pool: Pool = new Pool();",
          "  opts: Options;",
          "  run(o: Options) {",
          "    const p = new Pool();",
          "    return this.pool.size + this.opts.inner.depth + o.retries + p.size + Pool.shared;",
          "  }",
          "}",
        ),
      }),
    ).toEqual([
      "a.ts#Runner.run -> a.ts#Runner.pool (read)",
      "a.ts#Runner.run -> types.ts#Pool.size (read)",
      "a.ts#Runner.run -> a.ts#Runner.opts (read)",
      "a.ts#Runner.run -> types.ts#Options.inner (read)",
      "a.ts#Runner.run -> types.ts#Inner.depth (read)",
      "a.ts#Runner.run -> types.ts#Options.retries (read)",
      "a.ts#Runner.run -> types.ts#Pool.size (read)",
      "a.ts#Runner.run -> types.ts#Pool.shared (read)",
    ]);
  });

  it("function and method values are reads; classes and enums remain type references; unknown members are not guessed", async () => {
    expect(
      await refs({
        "a.ts": src(
          "function helper() {}",
          "class Klass { method() {} field = 1; handler = () => {}; }",
          "enum Color { Red }",
          "const value = 1;",
          "export function f(k: Klass, unknown) {",
          "  const cb = helper;",
          "  const m = k.method;",
          "  const h = k.handler;",
          "  const c = Klass;",
          "  const r = Color.Red;",
          "  unknown.field;",
          "  return [value, k.field];",
          "}",
        ),
      }),
    ).toEqual([
      "a.ts#f -> a.ts#helper (read)",
      "a.ts#f -> a.ts#Klass.method (read)",
      "a.ts#f -> a.ts#Klass.handler (read)",
      "a.ts#f -> a.ts#value (read)",
      "a.ts#f -> a.ts#Klass.field (read)",
    ]);
  });

  it("re-exported function values and variables are reads; classes remain type references", async () => {
    expect(
      await refs({
        "lib/index.ts": src(
          "export { LIMIT } from './consts';",
          "export { Klass } from './klass';",
          "export { helper as aid } from './fn';",
        ),
        "lib/consts.ts": "export const LIMIT = 1;\n",
        "lib/klass.ts": "export class Klass { static shared = 1; }\n",
        "lib/fn.ts": "export function helper() {}\n",
        "use.ts": src(
          "import * as lib from './lib/index';",
          "import { Klass, aid, LIMIT } from './lib/index';",
          "export const all = [lib.LIMIT, lib.Klass, lib.aid, Klass.shared, Klass, aid, LIMIT];",
        ),
      }),
    ).toEqual([
      "use.ts#all -> lib/consts.ts#LIMIT (read)",
      "use.ts#all -> lib/fn.ts#helper (read)",
      "use.ts#all -> lib/klass.ts#Klass.shared (read)",
      "use.ts#all -> lib/fn.ts#helper (read)",
      "use.ts#all -> lib/consts.ts#LIMIT (read)",
    ]);
  });

  it("locals, parameters and shadowed names are not reads of the module variable of the same name", async () => {
    expect(
      await refs({
        "a.ts": src(
          "const limit = 1;",
          "export function byParam(limit: number) { return limit; }",
          "export function byLocal() { const limit = 2; return limit; }",
          "export function byLoop() { for (const limit of [1]) use(limit); }",
          "export function shared() { return limit; }",
        ),
      }),
    ).toEqual(["a.ts#shared -> a.ts#limit (read)"]);
  });

  it("a read is not a write, a call or the recursion of its own symbol; the initialiser of a variable reads from it", async () => {
    expect(
      await refs({
        "a.ts": src(
          "let total = 0;",
          "const base = 10;",
          "const derived = base * 2;",
          "export function f() { total += base; total = 1; total++; return total; }",
        ),
      }),
    ).toEqual([
      "a.ts#derived -> a.ts#base (read)",
      "a.ts#f -> a.ts#base (read)",
      "a.ts#f -> a.ts#total (read)",
    ]);
  });

  it("test blocks read like any function: from the test, to the variables of the code under test", async () => {
    expect(
      await refs({
        "src.ts": "export const LIMIT = 1;\nexport class Q { size = 0; }\n",
        "src.test.ts": src(
          "import { LIMIT, Q } from './src';",
          "describe('Q', () => {",
          "  it('has a size', () => {",
          "    const q = new Q();",
          "    expect(q.size).toBe(LIMIT);",
          "  });",
          "});",
        ),
      }),
    ).toEqual([
      "src.test.ts#Q.has a size -> src.ts#Q.size (read)",
      "src.test.ts#Q.has a size -> src.ts#LIMIT (read)",
    ]);
  });
});
