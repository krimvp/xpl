/**
 * The heuristic resolver is language-agnostic. These tests drive it with hand-written facts and fake
 * packs shaped like the Go pack (directory-scoped packages, receivers, methods declared away from their
 * struct) and the Python pack (dotted imports, `__init__` re-exports, star imports), which is what the
 * real packs will feed it.
 */
import { describe, expect, it } from "vitest";
import { splitLines } from "@xpl/core";
import { SymbolLookup, assembleSymbols, resolveHeuristic } from "../src/index.js";
import type {
  ExportFact,
  ImportBinding,
  LanguagePack,
  RepoView,
  ResolverFile,
  SiteDraft,
  Span,
  SymbolDraft,
  TypeFact,
} from "../src/index.js";

interface FileSpec {
  /** Number of lines the file has (positions of sites must lie inside symbols' line ranges). */
  lines?: number;
  symbols?: Array<
    [
      path: string,
      kind: SymbolDraft["kind"],
      startLine: number,
      endLine: number,
      parentPath?: string,
    ]
  >;
  sites?: Array<[kind: SiteDraft["kind"], qualifier: string, name: string, line: number]>;
  imports?: Array<
    [localName: string, module: string, importedName: string | undefined, line: number]
  >;
  typeFacts?: TypeFact[];
  exports?: ExportFact[];
}

const sp = (line: number): Span => ({ startLine: line, startCol: 1, endLine: line, endCol: 10 });

function run(files: Record<string, FileSpec>, packFor: (path: string) => LanguagePack): string[] {
  const resolverFiles: ResolverFile[] = [];
  const entries = [];
  for (const [path, spec] of Object.entries(files)) {
    const drafts: SymbolDraft[] = (spec.symbols ?? []).map(([p, kind, start, end, parent]) => ({
      path: p,
      kind,
      range: { startLine: start, startCol: 1, endLine: end, endCol: 2 },
      ...(parent !== undefined ? { parentPath: parent } : {}),
    }));
    const lines = splitLines("x\n".repeat(spec.lines ?? 30));
    entries.push(...assembleSymbols(path, lines, drafts).entries);
    resolverFiles.push({
      path,
      language: "go",
      pack: packFor(path),
      sites: (spec.sites ?? []).map(([kind, qualifier, name, line]) => ({
        kind,
        qualifier: qualifier === "" ? [] : qualifier.split("."),
        name,
        site: sp(line),
      })),
      imports: (spec.imports ?? []).map(
        ([localName, module, importedName, line]): ImportBinding => ({
          localName,
          module,
          ...(importedName !== undefined ? { importedName } : {}),
          site: sp(line),
        }),
      ),
      typeFacts: spec.typeFacts ?? [],
      exports: spec.exports ?? [],
    });
  }
  const paths = Object.keys(files);
  const repo: RepoView = {
    root: "/repo",
    files: new Set(paths),
    filesInDir: (dir) =>
      paths.filter((p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "") === dir).sort(),
    readText: () => undefined,
  };
  const refs = resolveHeuristic({
    files: resolverFiles,
    entries,
    lookup: new SymbolLookup(entries),
    repo,
  });
  return refs.map((r) => `${r.from} -> ${r.to} (${r.kind})`);
}

/** A pack shaped like the Go one: a package is a directory, an import path maps to it. */
const goLike: LanguagePack = {
  id: "go-like",
  languages: ["go"],
  grammarFor: () => "go",
  packageScope: "directory",
  refs: "heuristic",
  extract: () => ({ symbols: [], sites: [], imports: [], typeFacts: [] }),
  classifySite: () => undefined,
  resolveModule: (spec, _from, repo) =>
    spec.startsWith("example.com/app/")
      ? repo
          .filesInDir(spec.slice("example.com/app/".length))
          .filter((f) => f.endsWith(".go") && !f.endsWith("_test.go"))
      : [],
};

/** A pack shaped like the Python one: dotted modules, packages with `__init__.py`. */
const pyLike: LanguagePack = {
  id: "py-like",
  languages: ["python"],
  grammarFor: () => "python",
  packageScope: "file",
  importsReexport: true,
  refs: "heuristic",
  extract: () => ({ symbols: [], sites: [], imports: [], typeFacts: [] }),
  classifySite: () => undefined,
  resolveModule: (spec, from, repo) => {
    let base: string;
    if (spec.startsWith(".")) {
      const dots = spec.match(/^\.+/)![0].length;
      let dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
      for (let i = 1; i < dots; i++)
        dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
      const rest = spec.slice(dots).replace(/\./g, "/");
      base = [dir, rest].filter(Boolean).join("/");
    } else {
      base = spec.replace(/\./g, "/");
    }
    return [`${base}.py`, `${base}/__init__.py`].filter((p) => repo.files.has(p));
  },
};

describe("directory-scoped languages (Go-like)", () => {
  const files: Record<string, FileSpec> = {
    "internal/queue/queue.go": {
      symbols: [
        ["Queue", "class", 1, 3],
        ["Queue.Pop", "method", 5, 9, "Queue"],
        ["New", "function", 11, 13],
      ],
      sites: [
        ["call", "this", "Len", 6], // q.Len() inside Pop, receiver normalised to `this`
        ["call", "", "helper", 7], // same-package function in another file
        ["call", "", "Queue", 12], // composite-literal style construction inside New
      ],
      typeFacts: [{ scopePath: "New", name: "New", kind: "return", typeName: "Queue" }],
    },
    "internal/queue/extra.go": {
      symbols: [
        ["Queue.Len", "method", 1, 3, "Queue"], // the struct lives in queue.go: no parent in this file
        ["helper", "function", 5, 7],
      ],
    },
    "cmd/main.go": {
      symbols: [["main", "function", 1, 10]],
      imports: [["queue", "example.com/app/internal/queue", undefined, 1]],
      sites: [
        ["call", "queue", "New", 3],
        ["call", "q", "Pop", 4],
        ["call", "q", "Len", 5],
        ["type-ref", "queue", "Queue", 6],
        ["call", "r.q", "Pop", 7],
      ],
      typeFacts: [
        {
          scopePath: "main",
          name: "q",
          kind: "local",
          initCall: { qualifier: ["queue"], name: "New" },
        },
        { scopePath: "main", name: "r", kind: "local", typeName: "Runner" },
      ],
    },
    "cmd/runner.go": {
      symbols: [
        ["Runner", "class", 1, 4],
        ["Runner.Run", "method", 6, 10, "Runner"],
      ],
      imports: [["queue", "example.com/app/internal/queue", undefined, 1]],
      sites: [["call", "this.q", "Pop", 8]],
      typeFacts: [{ scopePath: "Runner", name: "q", kind: "field", typeName: "queue.Queue" }],
    },
  };
  const refs = run(files, () => goLike);

  it("resolves package-qualified calls through the import to any file of the package", () => {
    expect(refs).toContain("cmd/main.go#main -> internal/queue/queue.go#New (call)");
  });

  it("uses a call's return type for a local and finds methods declared in another file of the package", () => {
    expect(refs).toContain("cmd/main.go#main -> internal/queue/queue.go#Queue.Pop (call)");
    expect(refs).toContain("cmd/main.go#main -> internal/queue/extra.go#Queue.Len (call)");
  });

  it("the receiver `this` finds the struct in the same package and its methods and helpers across files", () => {
    expect(refs).toContain(
      "internal/queue/queue.go#Queue.Pop -> internal/queue/extra.go#Queue.Len (call)",
    );
    expect(refs).toContain(
      "internal/queue/queue.go#Queue.Pop -> internal/queue/extra.go#helper (call)",
    );
    expect(refs).toContain("internal/queue/queue.go#New -> internal/queue/queue.go#Queue (call)");
  });

  it("qualified type names resolve through the package import", () => {
    expect(refs).toContain("cmd/main.go#main -> internal/queue/queue.go#Queue (type-ref)");
  });

  it("field types written as pkg.Type resolve, both from the same file and via another struct's local", () => {
    expect(refs).toContain("cmd/runner.go#Runner.Run -> internal/queue/queue.go#Queue.Pop (call)");
  });

  it("a method of a struct declared in another file has no parent, one in the same file has", () => {
    const entries = assembleSymbols("x.go", splitLines("x\n".repeat(20)), [
      { path: "S", kind: "class", range: { startLine: 1, startCol: 1, endLine: 2, endCol: 2 } },
      {
        path: "S.M",
        kind: "method",
        range: { startLine: 4, startCol: 1, endLine: 6, endCol: 2 },
        parentPath: "S",
      },
      {
        path: "T.M",
        kind: "method",
        range: { startLine: 8, startCol: 1, endLine: 9, endCol: 2 },
        parentPath: "T",
      },
    ]).entries;
    expect(entries.map((e) => e.symbol.parent)).toEqual([undefined, "x.go#S", undefined]);
  });

  it("symbols of other directories are not visible without an import", () => {
    const local = run(
      {
        "a/a.go": { symbols: [["f", "function", 1, 5]], sites: [["call", "", "g", 2]] },
        "b/b.go": { symbols: [["g", "function", 1, 5]] },
      },
      () => goLike,
    );
    expect(local).toEqual([]);
  });
});

describe("file-scoped languages with re-exports and star imports (Python-like)", () => {
  it("follows `from .x import Y` in `__init__.py` when importing from the package", () => {
    const refs = run(
      {
        "pkg/__init__.py": { imports: [["Queue", ".queue", "Queue", 1]] },
        "pkg/queue.py": {
          symbols: [
            ["Queue", "class", 1, 10],
            ["Queue.pop", "method", 2, 4, "Queue"],
          ],
        },
        "app.py": {
          symbols: [["main", "function", 3, 10]],
          imports: [["Queue", "pkg", "Queue", 1]],
          sites: [["call", "", "Queue", 4]],
        },
      },
      () => pyLike,
    );
    expect(refs).toContain("app.py# -> pkg/queue.py#Queue (import)");
    expect(refs).toContain("app.py#main -> pkg/queue.py#Queue (call)");
    expect(refs).toContain("pkg/__init__.py# -> pkg/queue.py#Queue (import)");
  });

  it("dotted namespace imports: `import pkg.queue as q; q.Queue()`", () => {
    const refs = run(
      {
        "pkg/queue.py": { symbols: [["Queue", "class", 1, 10]] },
        "app.py": {
          symbols: [["main", "function", 3, 10]],
          imports: [["q", "pkg.queue", undefined, 1]],
          sites: [["call", "q", "Queue", 4]],
        },
      },
      () => pyLike,
    );
    expect(refs).toContain("app.py# -> pkg/queue.py# (import)");
    expect(refs).toContain("app.py#main -> pkg/queue.py#Queue (call)");
  });

  it("star imports make the target's names visible (`from x import *`)", () => {
    const refs = run(
      {
        "x.py": { symbols: [["helper", "function", 1, 3]] },
        "app.py": {
          symbols: [["main", "function", 3, 10]],
          exports: [{ name: "*", module: "x", site: sp(1) }],
          sites: [["call", "", "helper", 4]],
        },
      },
      () => pyLike,
    );
    expect(refs).toContain("app.py#main -> x.py#helper (call)");
    expect(refs).toContain("app.py# -> x.py# (import)");
  });

  it("`self` (normalised to this) reaches methods and base-class methods; extends sites give the bases", () => {
    const refs = run(
      {
        "base.py": {
          symbols: [
            ["Base", "class", 1, 6],
            ["Base.shared", "method", 2, 3, "Base"],
          ],
        },
        "child.py": {
          symbols: [
            ["Child", "class", 1, 10, undefined],
            ["Child.run", "method", 3, 8, "Child"],
          ],
          imports: [["Base", "base", "Base", 1]],
          sites: [
            ["extends", "", "Base", 1],
            ["call", "this", "shared", 5],
          ],
        },
      },
      () => pyLike,
    );
    expect(refs).toContain("child.py#Child -> base.py#Base (extends)");
    expect(refs).toContain("child.py#Child.run -> base.py#Base.shared (call)");
  });

  it("type facts written as annotations drive `self.f.m()` in file-scoped languages too", () => {
    const refs = run(
      {
        "queue.py": {
          symbols: [
            ["Queue", "class", 1, 10],
            ["Queue.pop", "method", 2, 4, "Queue"],
          ],
        },
        "runner.py": {
          symbols: [
            ["Runner", "class", 1, 10],
            ["Runner.run", "method", 3, 8, "Runner"],
          ],
          imports: [["Queue", "queue", "Queue", 1]],
          sites: [["call", "this.queue", "pop", 5]],
          typeFacts: [{ scopePath: "Runner", name: "queue", kind: "field", typeName: "Queue" }],
        },
      },
      () => pyLike,
    );
    expect(refs).toContain("runner.py#Runner.run -> queue.py#Queue.pop (call)");
  });
});
