import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectGit,
  discoverFiles,
  isLockfile,
  languageForPath,
  MAX_FILE_BYTES,
} from "../src/index.js";
import { git, makeDir, makeRepo, writeFiles } from "./helpers.js";

const paths = async (root: string): Promise<string[]> =>
  (await discoverFiles(root)).files.map((f) => f.path);

describe("languageForPath", () => {
  it.each([
    ["src/a.ts", "typescript"],
    ["src/a.mts", "typescript"],
    ["src/a.cts", "typescript"],
    ["types/a.d.ts", "typescript"],
    ["src/App.tsx", "tsx"],
    ["a.js", "javascript"],
    ["a.mjs", "javascript"],
    ["a.cjs", "javascript"],
    ["a.jsx", "javascript"],
    ["app/main.py", "python"],
    ["app/stubs.pyi", "python"],
    ["cmd/main.go", "go"],
    ["config/default.yaml", "yaml"],
    ["ci.yml", "yaml"],
    ["package.json", "json"],
    ["pyproject.toml", "toml"],
    ["crates/core/Cargo.toml", "toml"],
    ["CONFIG.TOML", "toml"],
    ["README.md", "text"],
    ["Dockerfile", "text"],
    ["Makefile", "text"],
    [".gitignore", "text"],
    ["archive.tar.gz", "text"],
    ["UPPER.TS", "typescript"],
  ] as const)("%s -> %s", (path, language) => {
    expect(languageForPath(path)).toBe(language);
  });
});

describe("isLockfile", () => {
  it.each([
    "package-lock.json",
    "sub/dir/package-lock.json",
    "yarn.lock",
    "Cargo.lock",
    "go.sum",
    "pnpm-lock.yaml",
  ])("%s is a lockfile", (path) => expect(isLockfile(path)).toBe(true));
  it.each(["package.json", "lock.json", "locks.ts", "go.mod", "src/lockfile.ts"])(
    "%s is not",
    (path) => expect(isLockfile(path)).toBe(false),
  );
});

describe("discoverFiles in a git work tree", () => {
  it("lists tracked and untracked files, minus ignored ones, sorted and POSIX", async () => {
    const dir = makeRepo({
      ".gitignore": "ignored.ts\nbuild-output/\n",
      "src/b.ts": "export const b = 1;\n",
      "src/a.ts": "export const a = 1;\n",
      "README.md": "# hi\n",
    });
    writeFiles(dir, {
      "src/untracked.ts": "export const u = 1;\n",
      "ignored.ts": "x\n",
      "build-output/x.ts": "x\n",
    });
    const result = await discoverFiles(dir);
    expect(result.usedGit).toBe(true);
    expect(result.files.map((f) => f.path)).toEqual([
      ".gitignore",
      "README.md",
      "src/a.ts",
      "src/b.ts",
      "src/untracked.ts",
    ]);
    expect(result.files.find((f) => f.path === "src/a.ts")).toMatchObject({
      language: "typescript",
    });
    expect(result.files.find((f) => f.path === "README.md")).toMatchObject({ language: "text" });
  });

  it("is restricted to the subtree of the root and paths are root-relative", async () => {
    const dir = makeRepo({
      "top.ts": "export {};\n",
      "pkg/one.ts": "export {};\n",
      "pkg/nested/two.ts": "export {};\n",
      "other/three.ts": "export {};\n",
    });
    writeFiles(dir, { "pkg/untracked.ts": "export {};\n" });
    expect(await paths(join(dir, "pkg"))).toEqual(["nested/two.ts", "one.ts", "untracked.ts"]);
    const info = await detectGit(join(dir, "pkg"));
    expect(info?.atToplevel).toBe(false);
    expect((await detectGit(dir))?.atToplevel).toBe(true);
  });

  it("skips files deleted from the work tree but still tracked, and submodule-like directories", async () => {
    const dir = makeRepo({ "a.ts": "export {};\n", "gone.ts": "export {};\n" });
    const { rmSync } = await import("node:fs");
    rmSync(join(dir, "gone.ts"));
    // a nested repository is listed by git as a directory entry
    mkdirSync(join(dir, "nested"));
    git(join(dir, "nested"), "init", "-q");
    writeFileSync(join(dir, "nested", "x.ts"), "export {};\n");
    expect(await paths(dir)).toEqual(["a.ts"]);
  });

  it("applies the content filters: binary, oversize, lockfiles, symlinks", async () => {
    const dir = makeRepo({
      "ok.ts": "export {};\n",
      "package-lock.json": "{}\n",
      "yarn.lock": "x\n",
      "go.sum": "x\n",
      "image.bin": Buffer.from([1, 2, 0, 3, 4]),
      "big.txt": "x".repeat(MAX_FILE_BYTES + 1),
      "just-fits.txt": "y".repeat(MAX_FILE_BYTES),
      "empty.txt": "",
    });
    symlinkSync("ok.ts", join(dir, "link.ts"));
    expect(await paths(dir)).toEqual(["empty.txt", "just-fits.txt", "ok.ts"]);
  });

  it("only sniffs the first 8 KB for NUL bytes", async () => {
    const late = Buffer.concat([
      Buffer.alloc(9000, 0x61),
      Buffer.from([0]),
      Buffer.alloc(10, 0x61),
    ]);
    const early = Buffer.concat([
      Buffer.alloc(100, 0x61),
      Buffer.from([0]),
      Buffer.alloc(9000, 0x61),
    ]);
    const dir = makeRepo({ "late-nul.txt": late, "early-nul.txt": early });
    expect(await paths(dir)).toEqual(["late-nul.txt"]);
  });

  it("never indexes .explainer/ (our own output) or node_modules, even when tracked", async () => {
    const dir = makeRepo({
      "a.ts": "export {};\n",
      ".explainer/x.explainer.json": "{}\n",
      ".explainer/.gitignore": "index-*.json\n",
      "node_modules/pkg/index.js": "module.exports = 1;\n",
      "sub/.explainer/y.json": "{}\n",
    });
    expect(await paths(dir)).toEqual(["a.ts"]);
  });

  it("keeps dot-directories that git tracks (unlike the walk)", async () => {
    const dir = makeRepo({ ".github/workflows/ci.yml": "on: push\n", "a.ts": "export {};\n" });
    expect(await paths(dir)).toEqual([".github/workflows/ci.yml", "a.ts"]);
  });

  it("handles unusual file names (spaces, unicode, quotes) without quoting them", async () => {
    const dir = makeRepo({
      "with space.ts": "export {};\n",
      "h\u00e9llo.ts": "export {};\n",
      "\u65e5\u672c\u8a9e/\u30d5\u30a1\u30a4\u30eb.ts": "export {};\n",
      "quote'\"s.ts": "export {};\n",
    });
    const found = await paths(dir);
    expect(found).toContain("with space.ts");
    expect(found).toContain("h\u00e9llo.ts");
    expect(found).toContain("\u65e5\u672c\u8a9e/\u30d5\u30a1\u30a4\u30eb.ts");
    expect(found).toContain("quote'\"s.ts");
  });

  it("filters by language", async () => {
    const dir = makeRepo({
      "a.ts": "export {};\n",
      "b.py": "x = 1\n",
      "c.json": "{}\n",
      "d.md": "x\n",
    });
    const files = await discoverFiles(dir, { languages: ["python", "text"] });
    expect(files.files.map((f) => f.path)).toEqual(["b.py", "d.md"]);
  });

  it("finds TOML files as their own language", async () => {
    const dir = makeRepo({ "pyproject.toml": "[project]\n", "d.md": "x\n", "e.txt": "y\n" });
    const toml = await discoverFiles(dir, { languages: ["toml"] });
    expect(toml.files.map((f) => [f.path, f.language])).toEqual([["pyproject.toml", "toml"]]);
    const text = await discoverFiles(dir, { languages: ["text"] });
    expect(text.files.map((f) => f.path)).toEqual(["d.md", "e.txt"]);
  });
});

describe("discoverFiles without git (walk)", () => {
  it("walks the tree, skipping build/dependency directories and dot-directories", async () => {
    const dir = makeDir({
      "src/main.ts": "export {};\n",
      "src/nested/deep.ts": "export {};\n",
      "README.md": "x\n",
      ".hidden/secret.ts": "x\n",
      ".github/workflows/ci.yml": "x\n",
      "node_modules/pkg/index.js": "x\n",
      "dist/out.js": "x\n",
      "build/out.js": "x\n",
      "out/x.js": "x\n",
      "vendor/lib.go": "package v\n",
      "target/debug/x.rs": "x\n",
      "__pycache__/a.pyc": "x\n",
      ".venv/lib/x.py": "x\n",
      "venv/lib/x.py": "x\n",
      ".explainer/x.explainer.json": "{}\n",
      "src/dist/keep-me-not.ts": "x\n",
      ".eslintrc.json": "{}\n",
    });
    const result = await discoverFiles(dir);
    expect(result.usedGit).toBe(false);
    expect(result.files.map((f) => f.path)).toEqual([
      ".eslintrc.json",
      "README.md",
      "src/main.ts",
      "src/nested/deep.ts",
    ]);
  });

  it("applies the same content filters and sorts by path", async () => {
    const dir = makeDir({
      "z.ts": "export {};\n",
      "a.ts": "export {};\n",
      "package-lock.json": "{}\n",
      "bin.dat": Buffer.from([0, 1, 2]),
    });
    expect(await paths(dir)).toEqual(["a.ts", "z.ts"]);
  });

  it("returns an empty list for an empty directory", async () => {
    expect(await paths(makeDir())).toEqual([]);
  });

  it("can be forced with git: undefined even inside a work tree", async () => {
    const dir = makeRepo({ "a.ts": "export {};\n", ".hidden/b.ts": "x\n" });
    const forced = await discoverFiles(dir, { git: undefined });
    expect(forced.usedGit).toBe(false);
    expect(forced.files.map((f) => f.path)).toEqual(["a.ts"]);
  });
});
