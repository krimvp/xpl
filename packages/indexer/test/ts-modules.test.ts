import { describe, expect, it } from "vitest";
import { parseJsonc, probeModule } from "../src/languages/ts-modules.js";
import type { RepoView } from "../src/index.js";
import { typescriptPack } from "../src/index.js";
import { indexFiles, refTriples } from "./helpers.js";

const src = (...lines: string[]): string => lines.join("\n") + "\n";

/** A repository view over an in-memory file map. */
function repoOf(files: Record<string, string>): RepoView {
  return {
    root: "/repo",
    files: new Set(Object.keys(files)),
    filesInDir: () => [],
    readText: (path) => files[path],
  };
}

const resolve = (files: Record<string, string>, spec: string, from: string): string[] =>
  typescriptPack.resolveModule(spec, from, repoOf(files));

describe("parseJsonc", () => {
  it("accepts comments, trailing commas and a BOM, keeps comment-like text in strings", () => {
    expect(
      parseJsonc(
        '﻿{\n  // line\n  "a": 1, /* block */\n  "url": "http://x//y",\n  "list": [1, 2,],\n}\n',
      ),
    ).toEqual({ a: 1, url: "http://x//y", list: [1, 2] });
    expect(parseJsonc('{"s": "quote \\" // still string"}')).toEqual({
      s: 'quote " // still string',
    });
  });
  it("returns undefined for invalid input", () => {
    expect(parseJsonc("{ nope")).toBeUndefined();
    expect(parseJsonc("")).toBeUndefined();
  });
});

describe("probeModule", () => {
  const repo = repoOf({ "a/b.ts": "", "a/c/index.tsx": "", "a/d.js": "", "a/d.ts": "" });
  it("probes extensions, then directory indexes", () => {
    expect(probeModule("a/b", repo)).toEqual(["a/b.ts"]);
    expect(probeModule("a/c", repo)).toEqual(["a/c/index.tsx"]);
    expect(probeModule("a/d.js", repo)).toEqual(["a/d.js", "a/d.ts"]);
    expect(probeModule("a/c", repo, true)).toEqual(["a/c/index.tsx"]);
    expect(probeModule("a/b", repo, true)).toEqual([]);
    expect(probeModule("nothing", repo)).toEqual([]);
  });
});

describe("tsconfig paths and baseUrl", () => {
  const files = {
    "tsconfig.json": `{
      // comments and trailing commas are fine
      "compilerOptions": {
        "baseUrl": ".",
        "paths": {
          "@/*": ["src/*"],
          "@lib/*": ["packages/lib/src/*", "packages/lib-fallback/*"],
          "config": ["src/config/index.ts"],
          "~utils": ["src/utils.ts"],
        },
      },
    }`,
    "src/app.ts": "",
    "src/features/thing.ts": "",
    "src/utils.ts": "",
    "src/config/index.ts": "",
    "packages/lib/src/queue.ts": "",
    "packages/lib-fallback/other.ts": "",
    "tools/helper.ts": "",
  };

  it("maps wildcard patterns, exact keys and several targets", () => {
    expect(resolve(files, "@/features/thing", "src/app.ts")).toEqual(["src/features/thing.ts"]);
    expect(resolve(files, "@lib/queue", "src/app.ts")).toEqual(["packages/lib/src/queue.ts"]);
    expect(resolve(files, "@lib/other", "src/app.ts")).toEqual(["packages/lib-fallback/other.ts"]);
    expect(resolve(files, "config", "src/app.ts")).toEqual(["src/config/index.ts"]);
    expect(resolve(files, "~utils", "src/app.ts")).toEqual(["src/utils.ts"]);
    expect(resolve(files, "@/missing", "src/app.ts")).toEqual([]);
  });

  it("falls back to baseUrl for bare specifiers, but never for node: or unknown packages", () => {
    expect(resolve(files, "tools/helper", "src/app.ts")).toEqual(["tools/helper.ts"]);
    expect(resolve(files, "src/utils", "src/app.ts")).toEqual(["src/utils.ts"]);
    expect(resolve(files, "react", "src/app.ts")).toEqual([]);
    expect(resolve(files, "node:fs", "src/app.ts")).toEqual([]);
  });

  it("the longest matching prefix wins", () => {
    const more = {
      ...files,
      "tsconfig.json": `{"compilerOptions": {"paths": {"@/*": ["a/*"], "@/deep/*": ["b/*"]}}}`,
      "a/x.ts": "",
      "a/deep/x.ts": "",
      "b/x.ts": "",
    };
    expect(resolve(more, "@/deep/x", "src/app.ts")).toEqual(["b/x.ts"]);
    expect(resolve(more, "@/x", "src/app.ts")).toEqual(["a/x.ts"]);
  });

  it("without baseUrl, targets are relative to the config file", () => {
    const nested = {
      "pkg/tsconfig.json": `{"compilerOptions": {"paths": {"@/*": ["./src/*"]}}}`,
      "pkg/src/a.ts": "",
      "pkg/src/b.ts": "",
    };
    expect(resolve(nested, "@/b", "pkg/src/a.ts")).toEqual(["pkg/src/b.ts"]);
  });

  it("uses the nearest tsconfig and follows relative `extends`", () => {
    const monorepo = {
      "tsconfig.base.json": `{"compilerOptions": {"baseUrl": ".", "paths": {"@shared/*": ["shared/src/*"]}}}`,
      "apps/web/tsconfig.json": `{"extends": "../../tsconfig.base", "compilerOptions": {"strict": true}}`,
      "apps/api/tsconfig.json": `{"extends": ["../../tsconfig.base.json"], "compilerOptions": {"baseUrl": ".", "paths": {"@api/*": ["./src/*"]}}}`,
      "apps/cli/tsconfig.json": `{"extends": "../../tsconfig.base.json", "compilerOptions": {"paths": {"@cli/*": ["./src/*"]}}}`,
      "apps/cli/src/main.ts": "",
      "src/run.ts": "",
      "shared/src/util.ts": "",
      "apps/web/src/main.ts": "",
      "apps/api/src/main.ts": "",
      "apps/api/src/routes.ts": "",
    };
    expect(resolve(monorepo, "@shared/util", "apps/web/src/main.ts")).toEqual([
      "shared/src/util.ts",
    ]);
    // the child's `paths` replaces the parent's (as in TypeScript); its own baseUrl is what targets resolve against
    expect(resolve(monorepo, "@api/routes", "apps/api/src/main.ts")).toEqual([
      "apps/api/src/routes.ts",
    ]);
    expect(resolve(monorepo, "@shared/util", "apps/api/src/main.ts")).toEqual([]);
    // an inherited baseUrl (the root) is what `paths` targets resolve against when the child sets none
    expect(resolve(monorepo, "@cli/run", "apps/cli/src/main.ts")).toEqual(["src/run.ts"]);
  });

  it("reads jsconfig.json and ignores broken or missing configs", () => {
    expect(
      resolve(
        {
          "jsconfig.json": `{"compilerOptions": {"baseUrl": "src"}}`,
          "src/lib/x.js": "",
          "src/a.js": "",
        },
        "lib/x",
        "src/a.js",
      ),
    ).toEqual(["src/lib/x.js"]);
    expect(resolve({ "tsconfig.json": "{ broken", "a.ts": "" }, "anything", "a.ts")).toEqual([]);
    expect(resolve({ "a.ts": "" }, "anything", "a.ts")).toEqual([]);
  });
});

describe("workspace packages", () => {
  const files = {
    "package.json": `{"name": "root", "private": true, "workspaces": ["packages/*"]}`,
    "packages/core/package.json": `{"name": "@acme/core", "exports": {".": "./src/index.ts", "./util": "./src/util.ts", "./feature/*": "./src/features/*.ts"}}`,
    "packages/core/src/index.ts": "",
    "packages/core/src/util.ts": "",
    "packages/core/src/features/a.ts": "",
    "packages/ui/package.json": `{"name": "@acme/ui", "main": "./dist/index.js", "types": "./dist/index.d.ts"}`,
    "packages/ui/src/index.ts": "",
    "packages/ui/src/button.tsx": "",
    "packages/cond/package.json": `{"name": "cond", "exports": {".": {"import": "./esm/index.js", "require": "./cjs/index.js", "types": "./types/index.d.ts"}}}`,
    "packages/cond/src/index.ts": "",
    "packages/plain/package.json": `{"name": "plain"}`,
    "packages/plain/index.ts": "",
    "packages/plain/lib/x.ts": "",
    "packages/app/src/main.ts": "",
  };

  it("resolves the package root through `exports`, subpaths and patterns", () => {
    expect(resolve(files, "@acme/core", "packages/app/src/main.ts")).toEqual([
      "packages/core/src/index.ts",
    ]);
    expect(resolve(files, "@acme/core/util", "packages/app/src/main.ts")).toEqual([
      "packages/core/src/util.ts",
    ]);
    expect(resolve(files, "@acme/core/feature/a", "packages/app/src/main.ts")).toEqual([
      "packages/core/src/features/a.ts",
    ]);
    expect(resolve(files, "@acme/core/nope", "packages/app/src/main.ts")).toEqual([]);
  });

  it("maps build output (dist/, esm/, cjs/, types/) back to sources, and reads main/types/index", () => {
    expect(resolve(files, "@acme/ui", "packages/app/src/main.ts")).toEqual([
      "packages/ui/src/index.ts",
    ]);
    expect(resolve(files, "@acme/ui/button", "packages/app/src/main.ts")).toEqual([
      "packages/ui/src/button.tsx",
    ]);
    expect(resolve(files, "cond", "packages/app/src/main.ts")).toEqual([
      "packages/cond/src/index.ts",
    ]);
    expect(resolve(files, "plain", "packages/app/src/main.ts")).toEqual([
      "packages/plain/index.ts",
    ]);
    expect(resolve(files, "plain/lib/x", "packages/app/src/main.ts")).toEqual([
      "packages/plain/lib/x.ts",
    ]);
  });

  it("leaves packages that are not in the repository external", () => {
    expect(resolve(files, "react", "packages/app/src/main.ts")).toEqual([]);
    expect(resolve(files, "@acme/other", "packages/app/src/main.ts")).toEqual([]);
    expect(resolve(files, "@acme/core-extras", "packages/app/src/main.ts")).toEqual([]);
  });

  it("prefers tsconfig paths over a package of the same name", () => {
    const both = {
      ...files,
      "tsconfig.json": `{"compilerOptions": {"paths": {"@acme/core": ["./override.ts"]}}}`,
      "override.ts": "",
    };
    expect(resolve(both, "@acme/core", "packages/app/src/main.ts")).toEqual(["override.ts"]);
  });

  it("package.json `imports` (#specifiers) resolve from the nearest manifest", () => {
    const withImports = {
      "packages/app/package.json": `{"name": "app", "imports": {"#internal/*": "./src/internal/*.ts", "#cfg": {"default": "./src/cfg.ts"}}}`,
      "packages/app/src/internal/a.ts": "",
      "packages/app/src/cfg.ts": "",
      "packages/app/src/main.ts": "",
    };
    expect(resolve(withImports, "#internal/a", "packages/app/src/main.ts")).toEqual([
      "packages/app/src/internal/a.ts",
    ]);
    expect(resolve(withImports, "#cfg", "packages/app/src/main.ts")).toEqual([
      "packages/app/src/cfg.ts",
    ]);
    expect(resolve(withImports, "#missing", "packages/app/src/main.ts")).toEqual([]);
  });
});

describe("cross-package references", () => {
  it("imports, calls and types resolve through tsconfig paths and workspace packages", async () => {
    const { index } = await indexFiles({
      "tsconfig.json": `{"compilerOptions": {"paths": {"@/*": ["./app/src/*"]}}}`,
      "package.json": `{"name": "mono", "private": true}`,
      "packages/core/package.json": `{"name": "@acme/core", "exports": {".": "./src/index.ts"}}`,
      "packages/core/src/index.ts": src(
        "export { Queue } from './queue';",
        "export function version(): string { return '1'; }",
      ),
      "packages/core/src/queue.ts": src(
        "export class Queue {",
        "  pop(): number { return 1; }",
        "}",
      ),
      "app/src/util.ts": src("export function helper() {}"),
      "app/src/main.ts": src(
        "import { Queue, version } from '@acme/core';",
        "import { helper } from '@/util';",
        "import { readFileSync } from 'node:fs';",
        "export function main(q: Queue) {",
        "  helper();",
        "  version();",
        "  q.pop();",
        "  readFileSync('x');",
        "}",
      ),
    });
    const refs = refTriples(index);
    expect(refs).toContain("app/src/main.ts# -> packages/core/src/queue.ts#Queue (import)");
    expect(refs).toContain("app/src/main.ts# -> packages/core/src/index.ts#version (import)");
    expect(refs).toContain("app/src/main.ts# -> app/src/util.ts#helper (import)");
    expect(refs).toContain("app/src/main.ts#main -> app/src/util.ts#helper (call)");
    expect(refs).toContain("app/src/main.ts#main -> packages/core/src/index.ts#version (call)");
    expect(refs).toContain("app/src/main.ts#main -> packages/core/src/queue.ts#Queue.pop (call)");
    expect(refs).toContain("app/src/main.ts#main -> packages/core/src/queue.ts#Queue (type-ref)");
    // the barrel re-exports Queue from queue.ts
    expect(refs).toContain(
      "packages/core/src/index.ts# -> packages/core/src/queue.ts#Queue (import)",
    );
    expect(refs.some((r) => r.includes("readFileSync"))).toBe(false);
  });
});
