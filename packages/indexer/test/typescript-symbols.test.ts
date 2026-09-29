import { describe, expect, it } from "vitest";
import { hashText, sliceLines } from "@xpl/core";
import { indexFiles, symbol, symbolLines } from "./helpers.js";

const src = (...lines: string[]): string => lines.join("\n") + "\n";

async function symbolsOf(source: string, file = "a.ts"): Promise<string[]> {
  const { index } = await indexFiles({ [file]: source });
  return symbolLines(index, file);
}

describe("TypeScript symbols: kinds and paths (ARCHITECTURE.md §3 table)", () => {
  it("covers class, interface, type, enum, functions, variables and their members", async () => {
    const source = src(
      "export class Runner {", // 1
      "  static count = 0;", // 2
      "  private queue: Queue;", // 3
      "  #secret = 1;", // 4
      "  constructor(queue: Queue) {", // 5
      "    this.queue = queue;", // 6
      "  }", // 7
      "  get size(): number {", // 8
      "    return 1;", // 9
      "  }", // 10
      "  async dispatch(): Promise<void> {}", // 11
      "  static create(): Runner {", // 12
      "    return new Runner();", // 13
      "  }", // 14
      "}", // 15
      "export interface Job {", // 16
      "  id: string;", // 17
      "  run(): void;", // 18
      "  readonly optional?: number;", // 19
      "}", // 20
      "export type Handler = (job: Job) => void;", // 21
      "export enum Color { Red, Green = 2 }", // 22
      "export function helper(a: number): number {", // 23
      "  function inner() {}", // 24
      "  return a;", // 25
      "}", // 26
      "export const arrow = (x: number) => x + 1;", // 27
      "const fnExpr = function () {};", // 28
      "let counter = 0;", // 29
      "var legacy;", // 30
    );
    expect(await symbolsOf(source)).toEqual([
      "class Runner 1-15",
      "variable Runner.count 2-2",
      "variable Runner.queue 3-3",
      "variable Runner.#secret 4-4",
      "method Runner.constructor 5-7",
      "method Runner.size 8-10",
      "method Runner.dispatch 11-11",
      "method Runner.create 12-14",
      "interface Job 16-20",
      "variable Job.id 17-17",
      "method Job.run 18-18",
      "variable Job.optional 19-19",
      "type Handler 21-21",
      "enum Color 22-22",
      "function helper 23-26",
      "function helper.inner 24-24",
      "function arrow 27-27",
      "function fnExpr 28-28",
      "variable counter 29-29",
      "variable legacy 30-30",
    ]);
  });

  it("assigns parents to members and nested functions", async () => {
    const { index } = await indexFiles({
      "a.ts": src("class A {", "  m() {", "    function inner() {}", "  }", "}"),
    });
    expect(symbol(index, "a.ts", "A")!.parent).toBeUndefined();
    expect(symbol(index, "a.ts", "A.m")!.parent).toBe("a.ts#A");
    expect(symbol(index, "a.ts", "A.m.inner")!.parent).toBe("a.ts#A.m");
    expect(symbol(index, "a.ts", "A.m.inner")!.id).toBe("a.ts#A.m.inner");
    expect(symbol(index, "a.ts", "A.m.inner")!.file).toBe("a.ts");
  });

  it("treats abstract classes, class expressions and generators", async () => {
    const source = src(
      "export abstract class Base {", // 1
      "  abstract run(): void;", // 2
      "  protected helper() {}", // 3
      "}", // 4
      "const Anon = class {", // 5
      "  m() {}", // 6
      "};", // 7
      "export function* gen() {}", // 8
      "export async function af() {}", // 9
      "export const agen = async function* () {};", // 10
    );
    expect(await symbolsOf(source)).toEqual([
      "class Base 1-4",
      "method Base.run 2-2",
      "method Base.helper 3-3",
      "class Anon 5-7",
      "method Anon.m 6-6",
      "function gen 8-8",
      "function af 9-9",
      "function agen 10-10",
    ]);
  });

  it("class fields initialised with a function are methods, other fields are variables", async () => {
    const source = src(
      "class C {", // 1
      "  handler = () => 1;", // 2
      "  other = function () {};", // 3
      "  data = 5;", // 4
      "  ref = someCall();", // 5
      "}", // 6
    );
    expect(await symbolsOf(source)).toEqual([
      "class C 1-6",
      "method C.handler 2-2",
      "method C.other 3-3",
      "variable C.data 4-4",
      "variable C.ref 5-5",
    ]);
  });

  it("interface members: method and property signatures, other signatures are skipped", async () => {
    const source = src(
      "interface I<T> extends J {", // 1
      "  m(a: T): void;", // 2
      "  p: string;", // 3
      "  q?: number;", // 4
      "  (x: number): string;", // 5
      "  new (x: number): I<T>;", // 6
      "  [k: string]: any;", // 7
      "  get g(): number;", // 8
      "  set g(v: number);", // 9
      "}", // 10
    );
    expect(await symbolsOf(source)).toEqual([
      "interface I 1-10",
      "method I.m 2-2",
      "variable I.p 3-3",
      "variable I.q 4-4",
      "method I.g 8-8",
      "method I.g~2 9-9",
    ]);
  });

  it("enum members are not symbols; const enum and export enum work", async () => {
    const source = src("const enum CE { A, B }", "export enum E2 {", "  X = 1,", "}");
    expect(await symbolsOf(source)).toEqual(["enum CE 1-1", "enum E2 2-4"]);
  });

  it("namespaces and modules are `other` with prefixed members", async () => {
    const source = src(
      "export namespace NS {", // 1
      "  export function inner() {}", // 2
      "  export class K {", // 3
      "    m() {}", // 4
      "  }", // 5
      "  const hidden = 1;", // 6
      "}", // 7
      "module Legacy { export const v = 1; }", // 8
      "namespace A.B { export type T = string; }", // 9
    );
    expect(await symbolsOf(source)).toEqual([
      "other NS 1-7",
      "function NS.inner 2-2",
      "class NS.K 3-5",
      "method NS.K.m 4-4",
      "variable NS.hidden 6-6",
      "other Legacy 8-8",
      "variable Legacy.v 8-8",
      "other A.B 9-9",
      "type A.B.T 9-9",
    ]);
  });

  it("ambient modules and `declare global` have no addressable name: their declarations are listed as top-level", async () => {
    const source = src(
      'declare module "ambient" {', // 1
      "  export function f(): void;", // 2
      "  export interface Options { debug: boolean }", // 3
      "}", // 4
      "declare global {", // 5
      "  interface Window { x: number }", // 6
      "  var globalThing: string;", // 7
      "}", // 8
      'declare module "*.svg" { const url: string; export default url; }', // 9
    );
    expect(await symbolsOf(source, "globals.d.ts")).toEqual([
      "function f 2-2",
      "interface Options 3-3",
      "variable Options.debug 3-3",
      "interface Window 6-6",
      "variable Window.x 6-6",
      "variable globalThing 7-7",
      "variable url 9-9",
    ]);
  });

  it("nested function declarations get `outer.inner` paths at any depth", async () => {
    const source = src(
      "function outer() {", // 1
      "  function inner() {", // 2
      "    function innermost() {}", // 3
      "  }", // 4
      "  const notASymbol = () => {};", // 5
      "  class AlsoNot {}", // 6
      "}", // 7
      "const arrow = () => {", // 8
      "  function viaArrow() {}", // 9
      "};", // 10
    );
    expect(await symbolsOf(source)).toEqual([
      "function outer 1-7",
      "function outer.inner 2-4",
      "function outer.inner.innermost 3-3",
      "function arrow 8-10",
      "function arrow.viaArrow 9-9",
    ]);
  });

  it("top-level object literals: methods and function-valued properties are members", async () => {
    const source = src(
      "export const handlers = {", // 1
      "  onStart() {},", // 2
      "  onStop: () => {},", // 3
      "  onFn: function () {},", // 4
      "  async onAsync() {},", // 5
      "  get value() { return 1; },", // 6
      "  plain: 1,", // 7
      "  nested: { deep() {} },", // 8
      "  ...spread,", // 9
      "  [computed]() {},", // 10
      "  'quoted-key'() {},", // 11
      "  [Symbol.iterator]() {},", // 12
      "};", // 13
    );
    expect(await symbolsOf(source)).toEqual([
      "variable handlers 1-13",
      "method handlers.onStart 2-2",
      "method handlers.onStop 3-3",
      "method handlers.onFn 4-4",
      "method handlers.onAsync 5-5",
      "method handlers.value 6-6",
      "method handlers.quoted-key 11-11",
      "method handlers.@@iterator 12-12",
    ]);
  });

  it("destructured and multiple declarators become one variable per name", async () => {
    const source = src(
      "export const { a, b: renamed, ...rest } = obj;", // 1
      "const [first, , third] = arr;", // 2
      "const x = 1,", // 3
      "  y = () => 2,", // 4
      "  z = 3;", // 5
    );
    expect(await symbolsOf(source)).toEqual([
      "variable a 1-1",
      "variable renamed 1-1",
      "variable rest 1-1",
      "variable first 2-2",
      "variable third 2-2",
      "variable x 3-3",
      "function y 4-4",
      "variable z 5-5",
    ]);
  });
});

describe("TypeScript symbols: immediately-invoked function expressions (legacy JS, UMD)", () => {
  it("definitions inside a top-level IIFE are module-level symbols", async () => {
    const source = src(
      "(function ($) {", // 1
      "  function helper() {}", // 2
      "  var counter = 0;", // 3
      "  $.fn.plugin = function () { helper(); };", // 4
      "})(jQuery);", // 5
      "!function () { function bang() {} }();", // 6
      "(async () => { async function inArrow() {} })();", // 7
      "(function () { var x = 1; }());", // 8
      "(function () {})", // 9  (not invoked)
    );
    expect(await symbolsOf(source, "legacy.js")).toEqual([
      "function helper 2-2",
      "variable counter 3-3",
      "function bang 6-6",
      "function inArrow 7-7",
      "variable x 8-8",
    ]);
  });
});

describe("TypeScript symbols: duplicates and overloads", () => {
  it("numbers duplicate paths ~2, ~3 in source order (getter/setter pairs, merged declarations)", async () => {
    const source = src(
      "class A {", // 1
      "  get size(): number { return 1; }", // 2
      "  set size(v: number) {}", // 3
      "}", // 4
      "interface Merge { a: string }", // 5
      "interface Merge { b: string }", // 6
      "interface Merge { c: string }", // 7
    );
    expect(await symbolsOf(source)).toEqual([
      "class A 1-4",
      "method A.size 2-2",
      "method A.size~2 3-3",
      "interface Merge 5-5",
      "variable Merge.a 5-5",
      "interface Merge~2 6-6",
      "variable Merge.b 6-6",
      "interface Merge~3 7-7",
      "variable Merge.c 7-7",
    ]);
  });

  it("parents of members of a numbered duplicate point at that duplicate", async () => {
    const source = src("interface Merge { a: string }", "interface Merge { b: string }");
    const { index } = await indexFiles({ "a.ts": source });
    expect(symbol(index, "a.ts", "Merge.a")!.parent).toBe("a.ts#Merge");
    expect(symbol(index, "a.ts", "Merge.b")!.parent).toBe("a.ts#Merge~2");
  });

  it("skips overload signatures when an implementation follows, functions and methods alike", async () => {
    const source = src(
      "export function over(a: string): void;", // 1
      "export function over(a: number): void;", // 2
      "export function over(a: any): void {}", // 3
      "class C {", // 4
      "  m(a: string): void;", // 5
      "  m(a: number): void;", // 6
      "  m(a: any): void {}", // 7
      "  static s(): void;", // 8
      "  static s(x?: number): void {}", // 9
      "}", // 10
    );
    expect(await symbolsOf(source)).toEqual([
      "function over 3-3",
      "class C 4-10",
      "method C.m 7-7",
      "method C.s 9-9",
    ]);
  });

  it("keeps ambient declarations without an implementation (.d.ts files)", async () => {
    const source = src(
      "declare function amb(x: number): void;", // 1
      "declare const amb2: number;", // 2
      "export declare class DC {", // 3
      "  m(): void;", // 4
      "  p: string;", // 5
      "}", // 6
      "export declare function two(a: string): void;", // 7
      "export declare function two(a: number): void;", // 8
    );
    expect(await symbolsOf(source, "types.d.ts")).toEqual([
      "function amb 1-1",
      "variable amb2 2-2",
      "class DC 3-6",
      "method DC.m 4-4",
      "variable DC.p 5-5",
      "function two 7-7",
      "function two~2 8-8",
    ]);
  });
});

describe("TypeScript symbols: default exports", () => {
  it.each([
    ["export default class {}", "class default 1-1"],
    ["export default function () {}", "function default 1-1"],
    ["export default async function () {}", "function default 1-1"],
    ["export default () => {};", "function default 1-1"],
    ["export default async (x: number) => x;", "function default 1-1"],
    ["export default { a: 1 };", "variable default 1-1"],
    ["export default 42;", "variable default 1-1"],
    ["export default defineConfig({ a: 1 });", "variable default 1-1"],
    ["export default class Named {}", "class Named 1-1"],
    ["export default function named() {}", "function named 1-1"],
    ["export default interface Shape {}", "interface Shape 1-1"],
  ])("%s -> %s", async (source, expected) => {
    expect(await symbolsOf(source + "\n")).toEqual([expected]);
  });

  it("gives an anonymous default class its members and an object literal its methods", async () => {
    const source = src("export default class {", "  run() {}", "}");
    expect(await symbolsOf(source)).toEqual(["class default 1-3", "method default.run 2-2"]);
    const obj = src("export default {", "  render() {},", "  data: () => 1,", "};");
    expect(await symbolsOf(obj)).toEqual([
      "variable default 1-4",
      "method default.render 2-2",
      "method default.data 3-3",
    ]);
  });

  it("`export default foo` and re-exports add no symbol", async () => {
    const source = src(
      "const foo = 1;",
      "export default foo;",
      "export { foo as bar };",
      'export * from "./x";',
    );
    expect(await symbolsOf(source)).toEqual(["variable foo 1-1"]);
  });
});

describe("TypeScript symbols: ranges exclude leading comments and include decorators/export", () => {
  it("excludes JSDoc and line comments, includes export and decorators", async () => {
    const source = src(
      "/** doc of A */", // 1
      "// another comment", // 2
      "@Component({ a: 1 })", // 3
      "export class A {", // 4
      "  /** doc of m */", // 5
      "  @Input()", // 6
      "  m() {}", // 7
      "", // 8
      "  // about field", // 9
      "  @Prop() name: string;", // 10
      "  @HostListener('click')", // 11
      "  @Other()", // 12
      "  onClick() {}", // 13
      "}", // 14
      "", // 15
      "/**", // 16
      " * doc of f", // 17
      " */", // 18
      "export function f() {}", // 19
      "", // 20
      "// leading", // 21
      "export const g = 1; // trailing", // 22
    );
    expect(await symbolsOf(source)).toEqual([
      "class A 3-14",
      "method A.m 6-7",
      "variable A.name 10-10",
      "method A.onClick 11-13",
      "function f 19-19",
      "variable g 22-22",
    ]);
  });

  it("includes decorators that precede the export keyword and declare/abstract/modifiers", async () => {
    const source = src(
      "@Injectable()", // 1
      "export class S {}", // 2
      "", // 3
      "/** x */", // 4
      "export declare const d: number;", // 5
      "class M {", // 6
      "  // c", // 7
      "  private static readonly x = 1;", // 8
      "  public async *gen() {}", // 9
      "}", // 10
    );
    expect(await symbolsOf(source)).toEqual([
      "class S 1-2",
      "variable d 5-5",
      "class M 6-10",
      "variable M.x 8-8",
      "method M.gen 9-9",
    ]);
  });

  it("splits a multi-declarator statement between its symbols", async () => {
    const source = src("export const first = 1,", "  second = 2;");
    expect(await symbolsOf(source)).toEqual(["variable first 1-1", "variable second 2-2"]);
    const { index } = await indexFiles({ "a.ts": source });
    // Each declarator covers its own lines: the first keeps `export const`, the last the trailing `;`.
    expect(symbol(index, "a.ts", "first")!.hash).toBe(hashText("export const first = 1,"));
    expect(symbol(index, "a.ts", "second")!.hash).toBe(hashText("second = 2;"));
  });

  it("multi-line symbols cover their braces; hashes are hashText of the full lines", async () => {
    const source = src("class A {", "  m() {", "    return 1;", "  }", "}");
    const { index } = await indexFiles({ "a.ts": source });
    const m = symbol(index, "a.ts", "A.m")!;
    expect(m.range).toEqual({ startLine: 2, endLine: 4 });
    expect(m.hash).toBe(hashText(sliceLines(source, m.range)));
    expect(symbol(index, "a.ts", "A")!.hash).toBe(hashText(source));
  });

  it("symbol ranges are whole lines (no columns), file hash covers the file", async () => {
    const source = src("export const a = 1;");
    const { index } = await indexFiles({ "a.ts": source });
    expect(symbol(index, "a.ts", "a")!.range).toEqual({ startLine: 1, endLine: 1 });
    expect(index.files.find((f) => f.path === "a.ts")).toMatchObject({
      language: "typescript",
      hash: hashText(source),
      lines: 2, // a trailing newline yields a final empty line (splitLines)
    });
  });
});

describe("JavaScript and TSX files", () => {
  it("parses .js/.mjs/.cjs/.jsx as javascript, including JSX", async () => {
    const files = {
      "a.js": src("export class A {", "  m() {}", "}"),
      "b.mjs": src("export function f() {}"),
      "c.cjs": src("function g() {}", "module.exports = { g };"),
      "d.jsx": src(
        "export const App = () => <div>hi</div>;",
        "export function Other() { return <App />; }",
      ),
    };
    const { index } = await indexFiles(files);
    expect(index.files.map((f) => `${f.path}:${f.language}`)).toEqual([
      "a.js:javascript",
      "b.mjs:javascript",
      "c.cjs:javascript",
      "d.jsx:javascript",
    ]);
    expect(symbolLines(index, "a.js")).toEqual(["class A 1-3", "method A.m 2-2"]);
    expect(symbolLines(index, "b.mjs")).toEqual(["function f 1-1"]);
    expect(symbolLines(index, "c.cjs")).toEqual(["function g 1-1"]);
    expect(symbolLines(index, "d.jsx")).toEqual(["function App 1-1", "function Other 2-2"]);
    expect(index.languages.javascript).toMatchObject({ files: 4, refs: "heuristic" });
  });

  it("TSX: function components, class components, generics and JSX in one file", async () => {
    const source = src(
      "import React from 'react';", // 1
      "type Props = { title: string };", // 2
      "export const Header = ({ title }: Props) => <h1>{title}</h1>;", // 3
      "export function Page(props: Props): JSX.Element {", // 4
      "  return (", // 5
      "    <div>", // 6
      "      <Header title={props.title} />", // 7
      "    </div>", // 8
      "  );", // 9
      "}", // 10
      "export default class Legacy extends React.Component<Props> {", // 11
      "  render() {", // 12
      "    return <Page title='x' />;", // 13
      "  }", // 14
      "}", // 15
      "const identity = <T,>(x: T) => x;", // 16
    );
    expect(await symbolsOf(source, "page.tsx")).toEqual([
      "type Props 2-2",
      "function Header 3-3",
      "function Page 4-10",
      "class Legacy 11-15",
      "method Legacy.render 12-14",
      "function identity 16-16",
    ]);
  });

  it("the tsx grammar is used for .tsx, the typescript grammar for .ts (angle-bracket assertions)", async () => {
    const ts = src("const x = <number>y;", "export function f() {}");
    expect(await symbolsOf(ts, "cast.ts")).toEqual(["variable x 1-1", "function f 2-2"]);
    const { index } = await indexFiles({ "cast.ts": ts });
    expect(index.languages.typescript).toMatchObject({ files: 1, symbols: 2 });
  });
});
