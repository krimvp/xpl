import { describe, expect, it } from "vitest";
import type { RepoView } from "../src/index.js";
import { parseGoMod } from "../src/languages/go/modules.js";
import { extract } from "./helpers.js";

/** A repo view over `files` (path -> text; only `.go` and `go.mod` content matters). */
function repoOf(files: Record<string, string>): RepoView & { reads: string[] } {
  const paths = Object.keys(files).sort();
  const reads: string[] = [];
  return {
    root: "/repo",
    files: new Set(paths),
    filesInDir: (dir) =>
      paths.filter(
        (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "") === (dir === "." ? "" : dir),
      ),
    readText: (path) => {
      reads.push(path);
      return files[path];
    },
    reads,
  };
}

async function resolve(
  spec: string,
  from: string,
  files: Record<string, string>,
): Promise<string[]> {
  const { pack } = await extract("a.go", "package p\n");
  return pack.resolveModule(spec, from, repoOf(files));
}

const goMod = (module: string, extra = ""): string => `module ${module}\n\ngo 1.22\n${extra}`;

describe("resolveModule (Go)", () => {
  const repo = {
    "go.mod": goMod("example.com/app"),
    "cmd/app/main.go": "package main\n",
    "internal/queue/queue.go": "package queue\n",
    "internal/queue/deadletter.go": "package queue\n",
    "internal/queue/queue_test.go": "package queue\n",
    "internal/queue/doc.go": "package queue\n",
    "internal/runner/runner.go": "package runner\n",
    "internal/runner/retry_test.go": "package runner\n",
    "internal/empty/README.md": "# empty\n",
    "tools.go": "package tools\n",
  };

  it("maps module/path/x to the directory x below the go.mod and returns every .go file of the package", async () => {
    expect(await resolve("example.com/app/internal/runner", "cmd/app/main.go", repo)).toEqual([
      "internal/runner/runner.go",
    ]);
  });

  it("puts the file named like the directory first, doc.go last", async () => {
    expect(await resolve("example.com/app/internal/queue", "cmd/app/main.go", repo)).toEqual([
      "internal/queue/queue.go",
      "internal/queue/deadletter.go",
      "internal/queue/doc.go",
    ]);
  });

  it("excludes _test.go files unless the importer is a test", async () => {
    const fromTest = await resolve(
      "example.com/app/internal/queue",
      "internal/runner/retry_test.go",
      repo,
    );
    expect(fromTest).toEqual([
      "internal/queue/queue.go",
      "internal/queue/deadletter.go",
      "internal/queue/doc.go",
      "internal/queue/queue_test.go",
    ]);
  });

  it("the module path itself is the package in the module's root directory", async () => {
    expect(await resolve("example.com/app", "cmd/app/main.go", repo)).toEqual(["tools.go"]);
  });

  it("the standard library, external modules and unknown or empty directories resolve to nothing", async () => {
    for (const spec of [
      "fmt",
      "net/http",
      "github.com/other/lib/x",
      "example.com/app/internal/nothing",
      "example.com/app/internal/empty",
      "example.com/apple",
      "C",
      "",
    ]) {
      expect(await resolve(spec, "cmd/app/main.go", repo), spec).toEqual([]);
    }
  });

  it("without a go.mod nothing is a repository package", async () => {
    const { "go.mod": _, ...noMod } = repo;
    expect(await resolve("example.com/app/internal/runner", "cmd/app/main.go", noMod)).toEqual([]);
  });

  it("a go.mod in a subdirectory maps imports below its own module path", async () => {
    const files = {
      "svc/go.mod": goMod("example.com/svc"),
      "svc/api/api.go": "package api\n",
      "svc/cmd/main.go": "package main\n",
    };
    expect(await resolve("example.com/svc/api", "svc/cmd/main.go", files)).toEqual([
      "svc/api/api.go",
    ]);
  });

  it("several modules in one repository resolve each other; the longest module path wins", async () => {
    const files = {
      "go.mod": goMod("example.com/mono"),
      "app/main.go": "package main\n",
      "lib/util/util.go": "package decoy\n", // what the root module's path alone would name
      "libs/lib/go.mod": goMod("example.com/mono/lib"),
      "libs/lib/lib.go": "package lib\n",
      "libs/lib/util/util.go": "package util\n",
    };
    expect(await resolve("example.com/mono/lib/util", "app/main.go", files)).toEqual([
      "libs/lib/util/util.go",
    ]);
    expect(await resolve("example.com/mono/lib", "app/main.go", files)).toEqual([
      "libs/lib/lib.go",
    ]);
    expect(await resolve("example.com/mono/app", "libs/lib/lib.go", files)).toEqual([
      "app/main.go",
    ]);
  });

  it("follows local replace directives of the importer's module (single-line and block form)", async () => {
    const files = {
      "app/go.mod": goMod(
        "example.com/app",
        [
          "require example.com/dep v1.0.0",
          "replace example.com/dep => ../dep",
          "replace (",
          "\texample.com/other v1.2.3 => ../other/v2 // local copy",
          "\texample.com/remote => example.com/fork v1.0.0",
          ")",
        ].join("\n"),
      ),
      "app/main.go": "package main\n",
      "dep/go.mod": goMod("example.com/dep"),
      "dep/dep.go": "package dep\n",
      "dep/sub/sub.go": "package sub\n",
      "other/v2/other.go": "package other\n",
    };
    expect(await resolve("example.com/dep", "app/main.go", files)).toEqual(["dep/dep.go"]);
    expect(await resolve("example.com/dep/sub", "app/main.go", files)).toEqual(["dep/sub/sub.go"]);
    expect(await resolve("example.com/other/sub", "app/main.go", files)).toEqual([]);
    expect(await resolve("example.com/other", "app/main.go", files)).toEqual(["other/v2/other.go"]);
    // replacements by another module version are not repository directories
    expect(await resolve("example.com/remote", "app/main.go", files)).toEqual([]);
  });

  it("reads each go.mod once per repository view", async () => {
    const { pack } = await extract("a.go", "package p\n");
    const view = repoOf(repo);
    for (const spec of ["example.com/app/internal/queue", "example.com/app/internal/runner", "fmt"])
      pack.resolveModule(spec, "cmd/app/main.go", view);
    expect(view.reads).toEqual(["go.mod"]);
  });

  it("only returns files present in the repository", async () => {
    const files = {
      "go.mod": goMod("example.com/app"),
      "x/x.go": "package x\n",
      "x/data.json": "{}",
    };
    expect(await resolve("example.com/app/x", "main.go", files)).toEqual(["x/x.go"]);
  });
});

describe("parseGoMod", () => {
  it("reads the module path, ignoring comments, quotes and CRLF line endings", () => {
    expect(
      parseGoMod('// header\r\nmodule "example.com/quoted" // trailing\r\n\r\ngo 1.22\r\n', "sub"),
    ).toEqual({
      dir: "sub",
      module: "example.com/quoted",
      replaces: [],
    });
    expect(parseGoMod("go 1.22\n", "")).toBeUndefined();
  });

  it("collects local replace directives relative to the go.mod; remote ones are dropped", () => {
    const mod = parseGoMod(
      [
        "module example.com/app",
        "replace example.com/a => ./vendored/a",
        "replace example.com/b v1.0.0 => ../b",
        "replace (",
        "\texample.com/c => ./c",
        "\texample.com/d => example.com/d2 v2.0.0",
        ")",
      ].join("\n"),
      "svc",
    );
    expect(mod!.replaces).toEqual([
      { from: "example.com/a", dir: "svc/vendored/a" },
      { from: "example.com/b", dir: "b" },
      { from: "example.com/c", dir: "svc/c" },
    ]);
  });
});
