/**
 * The resolver's handling of import bindings across files (src/resolve/heuristic.ts), end to end through
 * `buildIndex` with the real language packs:
 *
 * - cycles of bindings and star imports must end (the lookups used to restart with a fresh `visited` set at
 *   every binding: RangeError, and the whole build aborted);
 * - only packs that declare `submoduleSpec` retry a missing imported name as a submodule;
 * - a module-level variable used as a receiver in another file has the type its own file's facts give it.
 */
import { describe, expect, it } from "vitest";
import { hasRef, indexFiles, refTriples } from "./helpers.js";

const src = (...lines: string[]): string => lines.join("\n") + "\n";
const GO_MOD = "module example.com/app\n\ngo 1.22\n";

describe("import cycles end (regression: RangeError in Resolver.exported / bindingEntity)", () => {
  it("TypeScript barrel: `export *` of a module that imports from the barrel again", async () => {
    const { index } = await indexFiles({
      "src/index.ts": src("export * from './b';", "export * from './c';"),
      "src/b.ts": src("import { thing } from './index';", "export function f() { thing(); }"),
      "src/c.ts": "export function thing() {}\n",
    });
    // the cycle index -> b -> index is cut and the lookup goes on to `export * from './c'`
    expect(hasRef(index, "src/b.ts#f", "src/c.ts#thing", "call")).toBe(true);
    expect(hasRef(index, "src/b.ts#", "src/c.ts#thing", "import")).toBe(true);
  });

  it("TypeScript: a barrel whose only source is the module that imports from it", async () => {
    const { index } = await indexFiles({
      "src/index.ts": "export * from './b';\n",
      "src/b.ts": src("import { thing } from './index';", "export function f() { thing(); }"),
    });
    expect(refTriples(index)).toEqual([
      "src/b.ts# -> src/index.ts# (import)",
      "src/index.ts# -> src/b.ts# (import)",
    ]);
  });

  it("TypeScript: two modules that re-export each other's name", async () => {
    const { index } = await indexFiles({
      "src/a.ts": src("import { X } from './b';", "export { X };"),
      "src/b.ts": src("import { X } from './a';", "export { X };"),
      "src/c.ts": src("import { X } from './a';", "export function g() { X(); }"),
    });
    // X is defined nowhere: the imports end at the modules and nothing loops
    expect(refTriples(index)).toEqual([
      "src/a.ts# -> src/b.ts# (import)",
      "src/b.ts# -> src/a.ts# (import)",
      "src/c.ts# -> src/a.ts# (import)",
    ]);
  });

  it("TypeScript: the same cycle with the definition reachable through a star export", async () => {
    const { index } = await indexFiles({
      "src/a.ts": src("import { X } from './b';", "export { X };"),
      "src/b.ts": src("import { X } from './a';", "export { X };"),
      "src/d.ts": "export function X() {}\n",
      "src/e.ts": src("export * from './a';", "export * from './d';"),
      "src/c.ts": src("import { X } from './e';", "export function g() { X(); }"),
    });
    expect(hasRef(index, "src/c.ts#g", "src/d.ts#X", "call")).toBe(true);
    expect(hasRef(index, "src/c.ts#", "src/d.ts#X", "import")).toBe(true);
  });

  it("TypeScript: star exports of each other", async () => {
    const { index } = await indexFiles({
      "src/a.ts": src("export * from './b';", "export function fa() {}"),
      "src/b.ts": src("export * from './a';", "export function fb() {}"),
      "src/c.ts": src("import { fa, fb } from './a';", "export function g() { fa(); fb(); }"),
    });
    expect(hasRef(index, "src/c.ts#g", "src/a.ts#fa", "call")).toBe(true);
    expect(hasRef(index, "src/c.ts#g", "src/b.ts#fb", "call")).toBe(true);
  });
});

describe("`submoduleSpec`: a missing imported name is a submodule only where the pack says so", () => {
  it("Python: `from pkg import sub` is the module pkg.sub", async () => {
    const { index } = await indexFiles({
      "pkg/__init__.py": "",
      "pkg/sub.py": "def go(): ...\n",
      "app.py": src("from pkg import sub", "def f():", "    sub.go()"),
    });
    expect(hasRef(index, "app.py#", "pkg/sub.py#", "import")).toBe(true);
    expect(hasRef(index, "app.py#f", "pkg/sub.py#go", "call")).toBe(true);
  });

  it("TypeScript does not: `import { model } from './user'` is not `./user.model`", async () => {
    const { index } = await indexFiles({
      "src/user.ts": "export const other = 1;\n",
      "src/user.model.ts": "export function make() {}\n",
      "src/use.ts": src("import { model } from './user';", "export function f() { model.make(); }"),
    });
    expect(index.refs.some((r) => r.to.startsWith("src/user.model.ts"))).toBe(false);
    // the import ends at the module the specifier names
    expect(hasRef(index, "src/use.ts#", "src/user.ts#", "import")).toBe(true);
  });

  it("Go does not: `import x` names the package, whatever files a directory holds", async () => {
    const { index } = await indexFiles({
      "go.mod": GO_MOD,
      "internal/q/q.go": src("package q", "func Push() {}"),
      "cmd/main.go": src(
        "package main",
        'import "example.com/app/internal/q"',
        "func main() { q.Push(); q.Pop() }",
      ),
    });
    expect(hasRef(index, "cmd/main.go#main", "internal/q/q.go#Push", "call")).toBe(true);
    expect(index.refs.filter((r) => r.kind === "call")).toHaveLength(1);
  });
});

/** The start lines of the call references `from -> to`, in site order. */
const callLines = (
  index: Awaited<ReturnType<typeof indexFiles>>["index"],
  from: string,
  to: string,
): number[] =>
  index.refs
    .filter((r) => r.from === from && r.to === to && r.kind === "call")
    .map((r) => r.site.startLine);

describe("a module-level variable used in another file has the type its own file's facts give it", () => {
  it("TypeScript: `export const bus = new EventBus()`, then `bus.emit()`", async () => {
    const { index } = await indexFiles({
      "src/bus.ts": src(
        "export class EventBus {",
        "  emit(topic: string): void {}",
        "  on(topic: string): void {}",
        "}",
        "export const bus = new EventBus();",
        "export const made = makeBus();",
        "function makeBus(): EventBus { return new EventBus(); }",
      ),
      "src/use.ts": src(
        "import { bus, made } from './bus';",
        "import * as ns from './bus';",
        "export function f() {", // 3
        "  bus.emit('a');", // 4
        "  made.on('b');", // 5
        "  ns.bus.emit('c');", // 6
        "}",
      ),
    });
    expect(callLines(index, "src/use.ts#f", "src/bus.ts#EventBus.emit")).toEqual([4, 6]);
    expect(callLines(index, "src/use.ts#f", "src/bus.ts#EventBus.on")).toEqual([5]);
  });

  it("Python: a module-level `shared = Registry()`, then `shared.add()`", async () => {
    const { index } = await indexFiles({
      "pkg/__init__.py": "",
      "pkg/reg.py": src(
        "class Registry:",
        "    def add(self, x): ...",
        "    def get(self, x): ...",
        "shared = Registry()",
        "default = make()",
        "def make() -> Registry: ...",
      ),
      "app.py": src(
        "from pkg.reg import shared, default", // 1
        "from pkg import reg", // 2
        "def f():", // 3
        "    shared.add(1)", // 4
        "    default.get(2)", // 5
        "    reg.shared.add(3)", // 6
      ),
    });
    expect(callLines(index, "app.py#f", "pkg/reg.py#Registry.add")).toEqual([4, 6]);
    expect(callLines(index, "app.py#f", "pkg/reg.py#Registry.get")).toEqual([5]);
  });

  it("Go: a package-level `var CommandLine = NewFlagSet()`, used by its package's other files and by importers", async () => {
    const { index } = await indexFiles({
      "go.mod": GO_MOD,
      "flags/flags.go": src(
        "package flags",
        "type FlagSet struct{ name string }",
        "func NewFlagSet(name string) *FlagSet { return &FlagSet{name: name} }",
        "func (f *FlagSet) VarP(name string) {}",
        'var CommandLine = NewFlagSet("cli")',
        "var Typed *FlagSet",
      ),
      "flags/extra.go": src("package flags", 'func Helper() { CommandLine.VarP("h") }'),
      "cmd/main.go": src(
        "package main",
        'import "example.com/app/flags"',
        "func main() {", // 3
        '\tflags.CommandLine.VarP("x")', // 4
        '\tflags.Typed.VarP("y")', // 5
        "}",
      ),
    });
    expect(callLines(index, "cmd/main.go#main", "flags/flags.go#FlagSet.VarP")).toEqual([4, 5]);
    expect(callLines(index, "flags/extra.go#Helper", "flags/flags.go#FlagSet.VarP")).toEqual([2]);
  });

  it("a variable typed by an external class is opaque, not guessed from its name", async () => {
    const { index } = await indexFiles({
      "src/bus.ts": src("import { Emitter } from 'events';", "export const bus = new Emitter();"),
      "src/decoy.ts": "export class Bus { emit(x: string): void {} }\n",
      "src/use.ts": src("import { bus } from './bus';", "export function f() { bus.emit('a'); }"),
    });
    expect(index.refs.some((r) => r.to === "src/decoy.ts#Bus.emit")).toBe(false);
  });
});
