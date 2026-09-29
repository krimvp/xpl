import { describe, expect, it } from "vitest";
import { pythonPack } from "../src/index.js";
import type { ImportBinding, RepoView, Span } from "../src/index.js";
import { extract, hasRef, indexFiles, refTriples } from "./helpers.js";

const src = (...lines: string[]): string => lines.join("\n") + "\n";

/** The bindings of `source` without their sites, plus the text each site covers. */
async function bindingsOf(
  source: string,
): Promise<Array<Omit<ImportBinding, "site"> & { at: string }>> {
  const { facts } = await extract("a.py", source);
  const lines = source.split("\n");
  const text = (s: Span): string =>
    lines[s.startLine - 1]!.slice(s.startCol - 1, s.startLine === s.endLine ? s.endCol : undefined);
  return facts.imports.map(({ site, ...binding }) => ({ ...binding, at: text(site) }));
}

describe("Python import bindings", () => {
  it("`import a.b.c` binds the dotted name; `import a.b as x` binds x to the module a.b", async () => {
    expect(
      await bindingsOf(src("import a", "import a.b.c", "import a.b as x", "import d, e as f")),
    ).toEqual([
      { localName: "a", module: "a", at: "a" },
      { localName: "a.b.c", module: "a.b.c", at: "a.b.c" },
      { localName: "x", module: "a.b", at: "a.b as x" },
      { localName: "d", module: "d", at: "d" },
      { localName: "f", module: "e", at: "e as f" },
    ]);
  });

  it("`from a.b import c, d as e` binds names of the module; the site is the imported name", async () => {
    expect(await bindingsOf(src("from a.b import c, d as e"))).toEqual([
      { localName: "c", module: "a.b", importedName: "c", at: "c" },
      { localName: "e", module: "a.b", importedName: "d", at: "d as e" },
    ]);
  });

  it("relative imports keep their dots in the module specifier; `from . import x` binds the sibling module .x", async () => {
    expect(
      await bindingsOf(
        src(
          "from . import x",
          "from .. import y as z",
          "from ..pkg import w",
          "from .m.n import v",
        ),
      ),
    ).toEqual([
      { localName: "x", module: ".x", at: "x" }, // a module path of only dots names a package: x is a module in it
      { localName: "z", module: "..y", at: "y as z" },
      { localName: "w", module: "..pkg", importedName: "w", at: "w" },
      { localName: "v", module: ".m.n", importedName: "v", at: "v" },
    ]);
  });

  it("parenthesised and multi-line import lists", async () => {
    const source = src("from a import (", "    b,", "    c as d,", ")");
    expect(await bindingsOf(source)).toEqual([
      { localName: "b", module: "a", importedName: "b", at: "b" },
      { localName: "d", module: "a", importedName: "c", at: "c as d" },
    ]);
  });

  it("imports anywhere in the file are bindings: in functions, `if TYPE_CHECKING`, `try`", async () => {
    const source = src(
      "if TYPE_CHECKING:",
      "    from .queue import Queue",
      "try:",
      "    import fast",
      "except ImportError:",
      "    fast = None",
      "def f():",
      "    from .late import thing",
    );
    expect((await bindingsOf(source)).map((b) => b.localName)).toEqual(["Queue", "fast", "thing"]);
  });

  it("`from x import *` is an export of `*` (and binds nothing); `from __future__` binds nothing", async () => {
    const source = src("from __future__ import annotations", "from x import *", "from .y import *");
    const { facts } = await extract("a.py", source);
    expect(facts.imports).toEqual([]);
    expect(facts.exports).toEqual([
      { name: "*", module: "x", site: { startLine: 2, startCol: 1, endLine: 2, endCol: 15 } },
      { name: "*", module: ".y", site: { startLine: 3, startCol: 1, endLine: 3, endCol: 16 } },
    ]);
  });
});

describe("Python package `__init__`: submodules it imports from are attributes of the package", () => {
  it("`from .sub import x` declares `sub` a re-export of the module .sub (once, not for ..sub or a.b)", async () => {
    const source = src(
      "from .queue import Queue",
      "from .queue import Job",
      "from .runner.core import Runner",
      "from . import worker",
      "from ..up import x",
      "from pkg.abs import y",
      "import plain",
    );
    const { facts } = await extract("pkg/__init__.py", source);
    expect(facts.exports).toEqual([
      { name: "queue", module: ".queue" },
      { name: "runner", module: ".runner" },
    ]);
    // ordinary modules have no such attributes to declare
    expect((await extract("pkg/other.py", source)).facts.exports).toEqual([]);
    expect((await extract("pkg/__init__.pyi", source)).facts.exports).toHaveLength(2);
  });

  it("but not when the file binds, defines or star-imports that name", async () => {
    const source = src(
      "from .config import config",
      "from .settings import *",
      "from .helpers import go",
      "helpers = 1",
      "from .models import Model",
      "def models(): ...",
      "from .free import Free",
    );
    const { facts } = await extract("pkg/__init__.py", source);
    expect((facts.exports ?? []).filter((e) => e.name !== "*")).toEqual([
      { name: "free", module: ".free" },
    ]);
  });
});

/** A `RepoView` over `paths` (no file contents). */
function repoOf(...paths: string[]): RepoView {
  const files = new Set(paths);
  return {
    root: "/repo",
    files,
    filesInDir: (dir) =>
      [...files]
        .filter((p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "") === dir)
        .sort(),
    readText: () => undefined,
  };
}

const resolve = (spec: string, from: string, repo: RepoView): string[] =>
  pythonPack.resolveModule(spec, from, repo);

describe("Python resolveModule: absolute dotted modules", () => {
  const repo = repoOf(
    "jobrunner/__init__.py",
    "jobrunner/queue.py",
    "jobrunner/sub/__init__.py",
    "jobrunner/sub/deep.py",
    "tests/test_a.py",
  );

  it("resolves modules and packages against the repository root", () => {
    expect(resolve("jobrunner.queue", "tests/test_a.py", repo)).toEqual(["jobrunner/queue.py"]);
    expect(resolve("jobrunner", "tests/test_a.py", repo)).toEqual(["jobrunner/__init__.py"]);
    expect(resolve("jobrunner.sub", "tests/test_a.py", repo)).toEqual([
      "jobrunner/sub/__init__.py",
    ]);
    expect(resolve("jobrunner.sub.deep", "tests/test_a.py", repo)).toEqual([
      "jobrunner/sub/deep.py",
    ]);
  });

  it("standard library, third-party and unknown modules resolve to nothing", () => {
    for (const spec of [
      "os",
      "os.path",
      "asyncio",
      "numpy.linalg",
      "jobrunner.missing",
      "jobrunner.queue.Queue",
    ])
      expect(resolve(spec, "tests/test_a.py", repo), spec).toEqual([]);
  });

  it("malformed specifiers resolve to nothing", () => {
    for (const spec of ["", " ", "a..b", "a-b", "1a", "a.", "..."])
      expect(resolve(spec, "tests/test_a.py", repo), JSON.stringify(spec)).toEqual([]);
  });

  it("prefers a package to a module of the same name, and lists stubs after their source", () => {
    const both = repoOf("a.py", "a.pyi", "b/__init__.py", "b.py", "only/stub.pyi");
    expect(resolve("a", "x.py", both)).toEqual(["a.py", "a.pyi"]);
    expect(resolve("b", "x.py", both)).toEqual(["b/__init__.py", "b.py"]);
    expect(resolve("only.stub", "x.py", both)).toEqual(["only/stub.pyi"]);
  });

  it("only returns files that are in the repository", () => {
    expect(resolve("jobrunner.queue", "x.py", repoOf("jobrunner/__init__.py"))).toEqual([]);
  });
});

describe("Python resolveModule: source roots", () => {
  it("src layout: `app.core` is src/app/core.py, from anywhere", () => {
    const repo = repoOf(
      "src/app/__init__.py",
      "src/app/core.py",
      "tests/test_core.py",
      "src/app/sub/x.py",
    );
    expect(resolve("app.core", "tests/test_core.py", repo)).toEqual(["src/app/core.py"]);
    expect(resolve("app", "tests/test_core.py", repo)).toEqual(["src/app/__init__.py"]);
    expect(resolve("app.core", "src/app/sub/x.py", repo)).toEqual(["src/app/core.py"]);
    expect(resolve("app.sub.x", "tests/test_core.py", repo)).toEqual(["src/app/sub/x.py"]);
  });

  it("namespace packages need no __init__.py", () => {
    const repo = repoOf("ns/mod.py", "ns/sub/deep.py", "main.py");
    expect(resolve("ns.mod", "main.py", repo)).toEqual(["ns/mod.py"]);
    expect(resolve("ns.sub.deep", "main.py", repo)).toEqual(["ns/sub/deep.py"]);
    expect(resolve("ns", "main.py", repo)).toEqual([]); // a namespace has no file of its own
  });

  it("a script or test can import the modules in its own directory; a package module cannot import its siblings", () => {
    const repo = repoOf(
      "tests/test_a.py",
      "tests/helpers.py",
      "pkg/__init__.py",
      "pkg/a.py",
      "pkg/queue.py",
      "pkg/sub/inner.py",
    );
    expect(resolve("helpers", "tests/test_a.py", repo)).toEqual(["tests/helpers.py"]);
    // `import queue` inside a package is the standard library, not the module next to it
    expect(resolve("queue", "pkg/a.py", repo)).toEqual([]);
    expect(resolve("pkg.queue", "pkg/a.py", repo)).toEqual(["pkg/queue.py"]);
    // a directory of a package that has no __init__ of its own is a script directory again
    expect(resolve("inner", "pkg/sub/other.py", repo)).toEqual(["pkg/sub/inner.py"]);
  });

  it("monorepos: a package under any directory is found, nearest project first", () => {
    const repo = repoOf(
      "libs/common/common/__init__.py",
      "libs/common/common/util.py",
      "services/web/web/__init__.py",
      "services/web/web/app.py",
      "a/lib/dup/__init__.py",
      "b/lib/dup/__init__.py",
      "b/main.py",
      "a/main.py",
    );
    expect(resolve("common.util", "services/web/web/app.py", repo)).toEqual([
      "libs/common/common/util.py",
    ]);
    expect(resolve("common", "services/web/web/app.py", repo)).toEqual([
      "libs/common/common/__init__.py",
    ]);
    expect(resolve("dup", "b/main.py", repo)).toEqual(["b/lib/dup/__init__.py"]);
    expect(resolve("dup", "a/main.py", repo)).toEqual(["a/lib/dup/__init__.py"]);
  });

  it("the ancestors' src directories count: services/api/tests imports services/api/src/app", () => {
    const repo = repoOf("services/api/src/app/models.py", "services/api/tests/test_x.py");
    expect(resolve("app.models", "services/api/tests/test_x.py", repo)).toEqual([
      "services/api/src/app/models.py",
    ]);
  });

  it("namespace packages in any other directory are found by path suffix, nearest first", () => {
    const repo = repoOf(
      "libs/shared/shared/models.py",
      "libs/shared/shared/sub/deep.py",
      "svc/app/main.py",
      "a/ns/mod.py",
      "e/g/ns/mod.py",
      "e/f/x.py",
    );
    expect(resolve("shared.models", "svc/app/main.py", repo)).toEqual([
      "libs/shared/shared/models.py",
    ]);
    expect(resolve("shared.sub.deep", "svc/app/main.py", repo)).toEqual([
      "libs/shared/shared/sub/deep.py",
    ]);
    expect(resolve("ns.mod", "e/f/x.py", repo)).toEqual(["e/g/ns/mod.py"]); // shares `e` with the importer
    expect(resolve("ns.mod", "svc/app/main.py", repo)).toEqual(["a/ns/mod.py"]); // shortest path among equals
  });

  it("path-suffix resolution needs two parts and never applies to standard library names", () => {
    const repo = repoOf(
      "myapp/__init__.py",
      "myapp/logging/__init__.py",
      "myapp/logging/handlers.py",
      "libs/x/helpers.py",
      "svc/main.py",
    );
    expect(resolve("logging.handlers", "svc/main.py", repo)).toEqual([]); // the standard library's
    expect(resolve("myapp.logging.handlers", "svc/main.py", repo)).toEqual([
      "myapp/logging/handlers.py",
    ]);
    expect(resolve("helpers", "svc/main.py", repo)).toEqual([]); // a single name needs a source root
    expect(resolve("x.helpers", "svc/main.py", repo)).toEqual(["libs/x/helpers.py"]);
  });

  it("the repository root wins over deeper roots", () => {
    const repo = repoOf("util.py", "scripts/util.py", "scripts/run.py");
    expect(resolve("util", "scripts/run.py", repo)).toEqual(["util.py"]);
  });
});

describe("Python resolveModule: relative imports", () => {
  const repo = repoOf(
    "pkg/__init__.py",
    "pkg/a.py",
    "pkg/x.py",
    "pkg/sub/__init__.py",
    "pkg/sub/b.py",
    "pkg/sub/mod.py",
    "pkg/other.py",
    "top.py",
    "helper.py",
  );

  it("`.x` is a sibling, `.` is the package itself", () => {
    expect(resolve(".x", "pkg/a.py", repo)).toEqual(["pkg/x.py"]);
    expect(resolve(".", "pkg/a.py", repo)).toEqual(["pkg/__init__.py"]);
    expect(resolve(".sub", "pkg/a.py", repo)).toEqual(["pkg/sub/__init__.py"]);
    expect(resolve(".sub.mod", "pkg/a.py", repo)).toEqual(["pkg/sub/mod.py"]);
  });

  it("relative imports from an __init__.py start in that package", () => {
    expect(resolve(".x", "pkg/__init__.py", repo)).toEqual(["pkg/x.py"]);
    expect(resolve(".b", "pkg/sub/__init__.py", repo)).toEqual(["pkg/sub/b.py"]);
  });

  it("every extra dot goes up one directory", () => {
    expect(resolve("..other", "pkg/sub/b.py", repo)).toEqual(["pkg/other.py"]);
    expect(resolve("..", "pkg/sub/b.py", repo)).toEqual(["pkg/__init__.py"]);
    expect(resolve("..sub.mod", "pkg/sub/b.py", repo)).toEqual(["pkg/sub/mod.py"]);
    expect(resolve("...top", "pkg/sub/b.py", repo)).toEqual(["top.py"]);
    expect(resolve("...helper", "pkg/sub/b.py", repo)).toEqual(["helper.py"]);
  });

  it("imports that leave the repository, or name nothing, resolve to nothing", () => {
    expect(resolve("....x", "pkg/sub/b.py", repo)).toEqual([]);
    expect(resolve("...x", "pkg/a.py", repo)).toEqual([]);
    expect(resolve(".missing", "pkg/a.py", repo)).toEqual([]);
    expect(resolve(".", "top.py", repo)).toEqual([]); // the root is not a package here
    expect(resolve(".a-b", "pkg/a.py", repo)).toEqual([]);
  });
});

describe("Python resolveModule: a module never resolves to the importing file itself", () => {
  it("`from abc import ABC` in an `abc.py` at the root, `from dbm import ndbm` in dbm/__init__.py, `.a` in a.py", () => {
    const repo = repoOf("abc.py", "dbm/__init__.py", "dbm/ndbm.py", "pkg/__init__.py", "pkg/a.py");
    expect(resolve("abc", "abc.py", repo)).toEqual([]);
    expect(resolve("dbm", "dbm/__init__.py", repo)).toEqual([]);
    expect(resolve("dbm.ndbm", "dbm/__init__.py", repo)).toEqual(["dbm/ndbm.py"]);
    expect(resolve(".a", "pkg/a.py", repo)).toEqual([]);
    expect(resolve("pkg.a", "pkg/a.py", repo)).toEqual([]);
    expect(resolve(".", "pkg/__init__.py", repo)).toEqual([]);
    // other files see them
    expect(resolve("abc", "pkg/a.py", repo)).toEqual(["abc.py"]);
    expect(resolve("dbm", "pkg/a.py", repo)).toEqual(["dbm/__init__.py"]);
  });

  it("indexes modules that import themselves, or that a package star-imports and that import the package back, without looping", async () => {
    const { index } = await indexFiles({
      "dbm/__init__.py": src(
        "try:",
        "    from dbm import ndbm",
        "except ImportError:",
        "    ndbm = None",
        "def open(f):",
        "    return ndbm.open(f)",
      ),
      "dbm/ndbm.py": "def open(f): ...\n",
      "abc.py": src("from abc import ABC", "class Mine(ABC): ..."),
      // the shape of asyncio: `__init__` star-imports modules that do `from . import sibling`
      "pkg/__init__.py": src("from .base import *", "from .tasks import *"),
      "pkg/base.py": src(
        "from . import events",
        "class Loop:",
        "    def run(self):",
        "        events.dispatch()",
      ),
      "pkg/events.py": "def dispatch(): ...\n",
      "pkg/tasks.py": src("from . import events", "def task():", "    events.dispatch()"),
    });
    expect(hasRef(index, "pkg/base.py#Loop.run", "pkg/events.py#dispatch", "call")).toBe(true);
    expect(hasRef(index, "pkg/tasks.py#task", "pkg/events.py#dispatch", "call")).toBe(true);
    expect(hasRef(index, "pkg/base.py#", "pkg/events.py#", "import")).toBe(true);
    expect(index.symbols.some((s) => s.id === "dbm/__init__.py#open")).toBe(true);
  });
});

// `Resolver.bindingEntity` used to start every lookup through a `from x import name` binding with a fresh
// `visited` set, so a cycle of bindings and star imports never ended (RangeError, the whole build aborted).
describe("Python import cycles do not loop (bindings share the lookup's visited set)", () => {
  it("a package that star-imports a module which does `from pkg import submodule`", async () => {
    const { index } = await indexFiles({
      "pkg/__init__.py": "from .b import *\n",
      "pkg/b.py": src("from pkg import helper", "def f():", "    helper.go()"),
      "pkg/helper.py": "def go(): ...\n",
    });
    // the cycle pkg -> b -> pkg is cut; `helper` is then the submodule pkg.helper
    expect(hasRef(index, "pkg/b.py#", "pkg/helper.py#", "import")).toBe(true);
    expect(hasRef(index, "pkg/b.py#f", "pkg/helper.py#go", "call")).toBe(true);
  });

  it("two modules that import each other's name", async () => {
    const { index } = await indexFiles({
      "a.py": "from b import X\n",
      "b.py": "from a import X\n",
      "c.py": src("from a import X", "X()"),
    });
    // X is defined nowhere: the imports end at the modules
    expect(refTriples(index)).toEqual([
      "a.py# -> b.py# (import)",
      "b.py# -> a.py# (import)",
      "c.py# -> a.py# (import)",
    ]);
  });
});

describe("Python submodule imports: `from pkg import sub` may import the module pkg.sub", () => {
  it("submoduleSpec spells the submodule: dotted after a name, appended after dots", () => {
    const spec = (module: string, name: string) => pythonPack.submoduleSpec?.(module, name);
    expect(spec("pkg", "sub")).toBe("pkg.sub");
    expect(spec("a.b", "c")).toBe("a.b.c");
    expect(spec(".", "x")).toBe(".x");
    expect(spec("..", "x")).toBe("..x");
    expect(spec("..pkg", "y")).toBe("..pkg.y");
    expect(spec("pkg", "a.b")).toBeUndefined();
    expect(spec("pkg", "")).toBeUndefined();
  });

  it("modules and subpackages, absolute and relative, with or without an alias", async () => {
    const { index } = await indexFiles({
      "pkg/__init__.py": "",
      "pkg/mod.py": "def m(): ...\n",
      "pkg/sub/__init__.py": "def s(): ...\n",
      "pkg/inner/__init__.py": "",
      "pkg/inner/deep.py": "def d(): ...\n",
      "pkg/user.py": src(
        "from pkg import mod, sub as subpkg",
        "from . import inner",
        "from .inner import deep",
        "def f():",
        "    mod.m()",
        "    subpkg.s()",
        "    deep.d()",
      ),
      "pkg/inner/other.py": src(
        "from .. import mod",
        "from ..sub import s",
        "def g():",
        "    mod.m()",
      ),
    });
    const calls = (from: string, to: string) => hasRef(index, from, to, "call");
    expect(calls("pkg/user.py#f", "pkg/mod.py#m")).toBe(true);
    expect(calls("pkg/user.py#f", "pkg/sub/__init__.py#s")).toBe(true);
    expect(calls("pkg/user.py#f", "pkg/inner/deep.py#d")).toBe(true);
    expect(calls("pkg/inner/other.py#g", "pkg/mod.py#m")).toBe(true);
    // the imports end at the modules, not at the package's __init__.py
    expect(hasRef(index, "pkg/user.py#", "pkg/mod.py#", "import")).toBe(true);
    expect(hasRef(index, "pkg/user.py#", "pkg/inner/deep.py#", "import")).toBe(true);
    expect(hasRef(index, "pkg/user.py#", "pkg/__init__.py#", "import")).toBe(false);
    expect(hasRef(index, "pkg/inner/other.py#", "pkg/sub/__init__.py#s", "import")).toBe(true);
  });

  it("a name the package defines wins over a submodule of the same name; a name that is neither stays unresolved", async () => {
    const { index } = await indexFiles({
      "pkg/__init__.py": src("def tool():", "    return 1"),
      "pkg/tool.py": "def inner(): ...\n",
      "app.py": src("from pkg import tool, missing", "def f():", "    tool()", "    missing.go()"),
    });
    expect(hasRef(index, "app.py#f", "pkg/__init__.py#tool", "call")).toBe(true);
    expect(hasRef(index, "app.py#", "pkg/__init__.py#tool", "import")).toBe(true);
    // `missing` is nothing in the package: the import ends at the package, the call is not guessed
    expect(hasRef(index, "app.py#", "pkg/__init__.py#", "import")).toBe(true);
    expect(index.refs.filter((r) => r.kind === "call" && r.from === "app.py#f")).toHaveLength(1);
  });
});

describe("Python heuristic resolution end to end", () => {
  const project = {
    "src/app/__init__.py": src("from .core import Engine", "from .util import *"),
    "src/app/core.py": src(
      "from __future__ import annotations", // 1
      "from typing import Optional", // 2
      "from .base import Base", // 3
      "import app.util", // 4
      "import app.deep.mod as deepmod", // 5
      "import app.deep.mod", // 6
      "", // 7
      "class Engine(Base):", // 8
      "    def __init__(self, cfg: Config, queue: Optional[Queue] = None) -> None:", // 9
      "        super().__init__(cfg)", // 10
      "        self.buf = Buffer()", // 11
      "        self.stats: Stats = Stats()", // 12
      "", // 13
      "    def run(self):", // 14
      "        self.buf.push(1)", // 15
      "        self.stats.count += 1", // 16
      "        app.util.log('x')", // 17
      "        app.deep.mod.go()", // 18
      "        deepmod.go()", // 19
      "        return self.helper()", // 20
      "", // 21
      "    def helper(self) -> Engine:", // 22
      "        return self", // 23
      "", // 24
      "class Buffer:", // 25
      "    def push(self, x): ...", // 26
      "class Stats:", // 27
      "    count: int = 0", // 28
      "class Config: ...", // 29
      "class Queue: ...", // 30
    ),
    "src/app/base.py": src(
      "class Base:",
      "    def __init__(self, cfg): ...",
      "    def shared(self): ...",
    ),
    "src/app/util.py": src("def log(msg): ...", "def fmt(msg): ..."),
    "src/app/deep/__init__.py": "",
    "src/app/deep/mod.py": "def go(): ...\n",
    "tests/test_core.py": src(
      "from app import Engine, fmt", // 1
      "from app.core import Buffer", // 2
      "import app.core", // 3
      "", // 4
      "class T(Engine):", // 5
      "    def test(self):", // 6
      "        self.run()", // 7
      "        self.shared()", // 8
      "        fmt('x')", // 9
      "        app.core.Buffer().push(2)", // 10
      "        b = Buffer()", // 11
      "        b.push(3)", // 12
    ),
  };

  it("links imports to the imported symbols, through `__init__` re-exports and star imports", async () => {
    const { index, warnings } = await indexFiles(project);
    expect(warnings).toEqual([]);
    expect(hasRef(index, "src/app/__init__.py#", "src/app/core.py#Engine", "import")).toBe(true);
    expect(hasRef(index, "src/app/core.py#", "src/app/base.py#Base", "import")).toBe(true);
    // `from x import *` is an import of the module
    expect(hasRef(index, "src/app/__init__.py#", "src/app/util.py#", "import")).toBe(true);
    // `import a.b.c` and `import a.b as x` are imports of the module a.b.c
    expect(hasRef(index, "src/app/core.py#", "src/app/util.py#", "import")).toBe(true);
    expect(hasRef(index, "src/app/core.py#", "src/app/deep/mod.py#", "import")).toBe(true);
    // the tests import from the package (src layout) and through its __init__
    expect(hasRef(index, "tests/test_core.py#", "src/app/core.py#Engine", "import")).toBe(true);
    expect(hasRef(index, "tests/test_core.py#", "src/app/util.py#fmt", "import")).toBe(true);
    expect(hasRef(index, "tests/test_core.py#", "src/app/core.py#Buffer", "import")).toBe(true);
    expect(hasRef(index, "tests/test_core.py#", "src/app/core.py#", "import")).toBe(true);
  });

  it("follows dotted module attributes, aliases, super(), inherited methods and star-imported names", async () => {
    const { index } = await indexFiles(project);
    const from = (id: string) => (to: string) => hasRef(index, id, to, "call");
    const run = from("src/app/core.py#Engine.run");
    expect(run("src/app/core.py#Buffer.push")).toBe(true); // self.buf = Buffer()
    expect(run("src/app/util.py#log")).toBe(true); // app.util.log()
    expect(run("src/app/deep/mod.py#go")).toBe(true); // app.deep.mod.go() and deepmod.go()
    expect(run("src/app/core.py#Engine.helper")).toBe(true);
    expect(
      hasRef(index, "src/app/core.py#Engine.run", "src/app/core.py#Stats.count", "write"),
    ).toBe(true);
    expect(
      hasRef(index, "src/app/core.py#Engine.__init__", "src/app/base.py#Base.__init__", "call"),
    ).toBe(true);
    expect(hasRef(index, "src/app/core.py#Engine", "src/app/base.py#Base", "extends")).toBe(true);
    // both spellings of app.deep.mod.go() are calls at lines 18 and 19
    expect(
      index.refs
        .filter((r) => r.to === "src/app/deep/mod.py#go" && r.kind === "call")
        .map((r) => r.site.startLine),
    ).toEqual([18, 19]);

    const test = from("tests/test_core.py#T.test");
    expect(test("src/app/core.py#Engine.run")).toBe(true); // through Engine, imported via `from app import`
    expect(test("src/app/base.py#Base.shared")).toBe(true); // a base of the base
    expect(test("src/app/util.py#fmt")).toBe(true); // star-imported by app/__init__.py
    expect(test("src/app/core.py#Buffer")).toBe(true);
    expect(test("src/app/core.py#Buffer.push")).toBe(true); // b = Buffer(); b.push() and app.core.Buffer().push()
  });

  it("`from pkg import submodule` resolves the module, whether or not the package imports it itself", async () => {
    const { index } = await indexFiles({
      "pkg/__init__.py": src(
        "from .queue import Queue",
        "from .config import config",
        "from .settings import *",
      ),
      "pkg/queue.py": src("class Queue: ...", "def helper(): ..."),
      "pkg/config.py": "def config(): ...\n",
      "pkg/settings.py": "settings = 1\n",
      "pkg/other.py": "def far(): ...\n",
      "app.py": src(
        "from pkg import queue, other, config, settings",
        "from pkg import queue as q",
        "def f():",
        "    queue.helper()",
        "    q.helper()",
        "    other.far()",
        "    config()",
      ),
    });
    expect(hasRef(index, "app.py#", "pkg/queue.py#", "import")).toBe(true);
    expect(
      index.refs.filter((r) => r.from === "app.py#f" && r.to === "pkg/queue.py#helper"),
    ).toHaveLength(2);
    // the function `config` (from .config import config) wins over the module of the same name
    expect(hasRef(index, "app.py#f", "pkg/config.py#config", "call")).toBe(true);
    // a submodule the package never imports is found by the pack's `submoduleSpec`
    expect(hasRef(index, "app.py#", "pkg/other.py#", "import")).toBe(true);
    expect(hasRef(index, "app.py#f", "pkg/other.py#far", "call")).toBe(true);
  });

  it("standard library and third-party imports produce no references", async () => {
    const { index } = await indexFiles({
      "a.py": src(
        "import os",
        "import numpy as np",
        "from typing import Optional",
        "def f():",
        "    os.getcwd()",
        "    np.zeros(3)",
      ),
    });
    expect(refTriples(index)).toEqual([]);
  });
});
