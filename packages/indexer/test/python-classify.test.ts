/**
 * `classifySite` must classify an identifier exactly like `extract` emits sites: same kind, same span. The
 * SCIP importer relies on that to turn occurrences into references.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { FileContext, Span } from "../src/index.js";
import { extract } from "./helpers.js";

const src = (...lines: string[]): string => lines.join("\n") + "\n";
const spanKey = (kind: string, s: Span): string =>
  `${kind} ${s.startLine}:${s.startCol}-${s.endLine}:${s.endCol}`;

/**
 * Compare the classification of every identifier of `source` with the sites and import bindings `extract`
 * emits. Returns what `extract` emitted but no identifier classifies to (`missing`), and what an identifier
 * classifies to that `extract` did not emit (`extra`).
 */
async function compare(
  source: string,
  path = "a.py",
): Promise<{ missing: string[]; extra: string[]; extraText: string[]; emitted: number }> {
  const { facts, pack, withTree } = await extract(path, source);
  const emitted = new Set<string>([
    ...facts.sites.map((s) => spanKey(s.kind, s.site)),
    ...facts.imports.map((b) => spanKey("import", b.site)),
  ]);
  const classified = new Set<string>();
  withTree((ctx: FileContext) => {
    for (const node of ctx.tree.rootNode.descendantsOfType(["identifier", "string_content"])) {
      const c = pack.classifySite(ctx, node.startPosition.row + 1, node.startPosition.column + 1);
      if (c) classified.add(spanKey(c.kind, c.site));
    }
  });
  const extra = [...classified].filter((k) => !emitted.has(k));
  return {
    missing: [...emitted].filter((k) => !classified.has(k)),
    extra,
    extraText: extra.map((k) => textAt(source, k)),
    emitted: emitted.size,
  };
}

/** The source text of a `spanKey` (`kind l:c-l:c`), newlines shown as ⏎. */
function textAt(source: string, key: string): string {
  const [, sl, sc, el, ec] = /^\w[\w-]* (\d+):(\d+)-(\d+):(\d+)$/
    .exec(key)!
    .map(Number) as number[];
  const lines = source.split(/\r?\n/);
  const out: string[] = [];
  for (let line = sl!; line <= el!; line++) {
    const text = lines[line - 1] ?? "";
    out.push(text.slice(line === sl ? sc! - 1 : 0, line === el ? ec : undefined));
  }
  return out.join("⏎");
}

describe("classifySite agrees with extract", () => {
  it("on a snippet with every kind of site", async () => {
    const source = src(
      "from __future__ import annotations", // 1
      "import os.path", // 2
      "import a.b as ab", // 3
      "from pkg.mod import Thing, other as alias", // 4
      "from . import sibling", // 5
      "from x import *", // 6
      "import importlib", // 7
      "", // 8
      "counter = 0", // 9
      "counter += 1", // 10
      "lazy = importlib.import_module('pkg.lazy')", // 11
      "", // 12
      "@decorate", // 13
      "@app.route('/x')", // 14
      "class Job(Base, mod.Other, Generic[T], metaclass=Meta):", // 15
      "    id: str", // 16
      "    queue: 'Queue'", // 17
      "    tags: Optional[list[Tag]] = None", // 18
      "", // 19
      "    def __init__(self, q: Queue | None = None, *, cb: Callable[[Job], Result] = noop) -> None:", // 20
      "        super().__init__()", // 21
      "        self.q = q or Queue()", // 22
      "        self.count += 1", // 23
      "        self.a, (self.b, *rest) = 1, (2, 3)", // 24
      "        self.q.pop().run(1)", // 25
      "", // 26
      "    async def go(self) -> Awaitable[Job]:", // 27
      "        w = await self.pool.lease()", // 28
      "        [x.go() for x in items if check(x)]", // 29
      "        f = lambda k: k.now()", // 30
      "        print(f'{w.name()} {other()!r}')", // 31
      "        global counter", // 32
      "        counter = counter + helper(", // 33
      "            1,", // 34
      "        )", // 35
      "        return Job.make()", // 36
      "", // 37
      "def free(a: A, b: mod.B[C]) -> Optional[D]:", // 38
      "    x: E = 1", // 39
      "    y: Literal['s'] = 's'", // 40
      "    return Thing(alias(sibling.go()))", // 41
      "", // 42
      "type Alias = dict[str, Job]", // 43
    );
    const result = await compare(source);
    expect(result.emitted).toBeGreaterThan(50);
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual([]);
  });

  it("on every file of the Python fixture", async () => {
    const root = resolve(import.meta.dirname, "../../../fixtures/py-jobrunner");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name));
        else if (entry.name.endsWith(".py")) files.push(join(dir, entry.name));
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThanOrEqual(9);
    const extras: string[] = [];
    for (const file of files) {
      const result = await compare(readFileSync(file, "utf8"), relative(root, file));
      expect(result.missing, file).toEqual([]);
      extras.push(...result.extraText.map((t) => `${relative(root, file)}: ${t}`));
    }
    // classified but not emitted: calls on a receiver `extract` cannot spell (a literal, a subscript)
    expect(extras).toEqual([
      'jobrunner/__main__.py: "\\n".join(format_metrics(metrics))',
      "jobrunner/bus.py: self._listeners[topic].append(listener)",
      "jobrunner/config.py: line[0].isspace()",
    ]);
  });

  it("on the fixture's kind of code with unusual layout: multi-line calls, CRLF, non-ASCII", async () => {
    const source = src(
      "def f(self):",
      "    résumé = naïve(  # 😀",
      "        self.queue.requeue(",
      ...Array.from({ length: 12 }, (_, i) => `            ${i},`),
      "        ),",
      "    )",
      "    return 'é'.join(x) + other()",
    ).replace(/\n/g, "\r\n");
    const result = await compare(source);
    expect(result.missing).toEqual([]);
    // `'é'.join(x)` has a receiver `extract` cannot spell: classified, not emitted
    expect(result.extra).toHaveLength(1);
  });
});

describe("classifySite: single identifiers", () => {
  const source = src(
    "import a.b as ab", // 1
    "from m.n import c as d", // 2
    "class K(Base):", // 3
    "    field: Thing = None", // 4
    "    def m(self, arg: Other, key=1):", // 5
    "        value = self.helper(arg, key=2)", // 6
    "        self.attr = value", // 7
    "        return value.attr", // 8
    "def plain(): ...", // 9
  );

  async function at(line: number, col: number) {
    const { pack, withTree } = await extract("a.py", source);
    return withTree((ctx) => pack.classifySite(ctx, line, col));
  }

  it("imports: the imported name and the alias, not the module path", async () => {
    expect(await at(1, 8)).toEqual({
      kind: "import",
      site: { startLine: 1, startCol: 8, endLine: 1, endCol: 16 },
    }); // `a` of a.b
    expect(await at(1, 10)).toMatchObject({ kind: "import" }); // `b`
    expect(await at(1, 16)).toMatchObject({ kind: "import" }); // `ab`
    expect(await at(2, 6)).toBeUndefined(); // `m` of the module path
    expect(await at(2, 8)).toBeUndefined(); // `n`
    expect(await at(2, 17)).toEqual({
      kind: "import",
      site: { startLine: 2, startCol: 17, endLine: 2, endCol: 22 },
    }); // `c` of `c as d`
    expect(await at(2, 22)).toMatchObject({ kind: "import" }); // `d`
  });

  it("class bases are `extends`; the class name itself is a declaration", async () => {
    expect(await at(3, 9)).toEqual({
      kind: "extends",
      site: { startLine: 3, startCol: 9, endLine: 3, endCol: 12 },
    });
    expect(await at(3, 7)).toBeUndefined();
  });

  it("annotations are `type-ref`, names and defaults are not", async () => {
    expect(await at(4, 12)).toEqual({
      kind: "type-ref",
      site: { startLine: 4, startCol: 12, endLine: 4, endCol: 16 },
    });
    expect(await at(4, 5)).toBeUndefined(); // the annotated name is a declaration
    expect(await at(5, 24)).toMatchObject({ kind: "type-ref" }); // `Other`
    expect(await at(5, 18)).toBeUndefined(); // `arg`
    expect(await at(5, 35)).toBeUndefined(); // `key`
  });

  it("calls: the callee name, not the receiver, the arguments or keyword names", async () => {
    const call = { kind: "call", site: { startLine: 6, startCol: 17, endLine: 6, endCol: 39 } };
    expect(await at(6, 22)).toEqual(call); // `helper`
    expect(await at(6, 17)).toBeUndefined(); // `self`
    expect(await at(6, 29)).toBeUndefined(); // `arg` (argument)
    expect(await at(6, 34)).toBeUndefined(); // `key=` keyword name
    expect(await at(6, 9)).toBeUndefined(); // `value` target: a plain local
  });

  it("writes: the attribute name of an assignment target; reads are nothing", async () => {
    expect(await at(7, 14)).toEqual({
      kind: "write",
      site: { startLine: 7, startCol: 9, endLine: 7, endCol: 25 },
    }); // `attr`
    expect(await at(7, 9)).toBeUndefined(); // `self`
    expect(await at(7, 21)).toBeUndefined(); // `value` on the right
    expect(await at(8, 22)).toBeUndefined(); // `value.attr` read
  });

  it("positions that are not identifiers, or outside the file, are nothing", async () => {
    expect(await at(9, 1)).toBeUndefined(); // `def`
    expect(await at(9, 11)).toBeUndefined(); // `(`
    expect(await at(1, 200)).toBeUndefined();
    expect(await at(99, 1)).toBeUndefined();
  });
});

describe("classifySite: a receiver `extract` cannot spell is still a call/write", () => {
  it("`arr[0].run()`, `'x'.join(...)` and `d[k].x = 1` classify (their site spans agree with the TS pack's rules)", async () => {
    const source = src(
      "def f(arr, d):",
      "    arr[0].run(1)",
      "    'x'.join(arr)",
      "    d[0].x = 1",
    );
    const { facts, pack, withTree } = await extract("a.py", source);
    expect(facts.sites).toEqual([]);
    const kinds = withTree((ctx) => [
      pack.classifySite(ctx, 2, 12),
      pack.classifySite(ctx, 3, 9),
      pack.classifySite(ctx, 4, 10),
    ]);
    expect(kinds).toEqual([
      { kind: "call", site: { startLine: 2, startCol: 5, endLine: 2, endCol: 17 } },
      { kind: "call", site: { startLine: 3, startCol: 5, endLine: 3, endCol: 17 } },
      { kind: "write", site: { startLine: 4, startCol: 5, endLine: 4, endCol: 14 } },
    ]);
  });
});

describe("classifySite: forward references, decorators, dynamic imports", () => {
  it("a plain name inside a string annotation is a type-ref (site = the name inside the quotes)", async () => {
    const source = src("def f(a: 'Job', b: Optional['mod.Job'], c: 'list[Job]'): ...");
    const { pack, withTree } = await extract("a.py", source);
    const found = withTree((ctx) => [
      pack.classifySite(ctx, 1, 11), // J of 'Job'
      pack.classifySite(ctx, 1, 35), // inside 'mod.Job'
      pack.classifySite(ctx, 1, 50), // inside 'list[Job]'
    ]);
    expect(found[0]).toEqual({
      kind: "type-ref",
      site: { startLine: 1, startCol: 11, endLine: 1, endCol: 13 },
    });
    expect(found[1]).toMatchObject({ kind: "type-ref" });
    expect(found[2]).toBeUndefined();
  });

  it("bare decorators are calls; dynamic imports are imports", async () => {
    const source = src(
      "import importlib",
      "@retry",
      "@app.route",
      "def f(): ...",
      "m = importlib.import_module('a.b')",
    );
    const { pack, withTree } = await extract("a.py", source);
    const found = withTree((ctx) => [
      pack.classifySite(ctx, 2, 3),
      pack.classifySite(ctx, 3, 8),
      pack.classifySite(ctx, 5, 20),
    ]);
    expect(found).toEqual([
      { kind: "call", site: { startLine: 2, startCol: 2, endLine: 2, endCol: 6 } },
      { kind: "call", site: { startLine: 3, startCol: 2, endLine: 3, endCol: 10 } },
      { kind: "import", site: { startLine: 5, startCol: 5, endLine: 5, endCol: 34 } },
    ]);
  });

  it("module variables written under `global` are writes; plain locals are not", async () => {
    const source = src("n = 0", "def f():", "    global n", "    n = 1", "def g():", "    n = 2");
    const { pack, withTree } = await extract("a.py", source);
    const found = withTree((ctx) => [pack.classifySite(ctx, 4, 5), pack.classifySite(ctx, 6, 5)]);
    expect(found).toEqual([
      { kind: "write", site: { startLine: 4, startCol: 5, endLine: 4, endCol: 9 } },
      undefined,
    ]);
  });
});
